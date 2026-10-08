import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArchiveRestore,
  Archive,
  FileText,
  FolderInput,
  ListPlus,
  Pencil,
  Plus,
  Tag as TagIcon,
  Trash2,
  Undo2,
} from '@renderer/lib/icons'
import { buildTaskTree, effectiveDoneMap, type TaskNode } from '@shared/task'
import type { Flash, NoteFolder, Task } from '@shared/types'
import { subscribeDomain } from '@shared/events'
import { Toolbar } from '../components/Toolbar'
import { Select } from '../components/Select'
import { useDialog } from '../components/Dialogs'
import { useCompleteTask } from '../lib/complete-task'
import { TaskRow } from '../components/TaskRow'
import { TargetSelector } from '../components/TargetSelector'
import { extractSourceUrl, readClipboard } from '../components/CapturePanel'

interface Props {
  onNotice: (message: string) => void
  onChanged: () => Promise<void>
}

type Tab = 'tasks' | 'flash'

/**
 * 给剪藏来的 HTML 包一层最小样式再交给沙箱 iframe。
 *
 * **只加样式，不动内容** —— 任何"顺手清理一下标签"的做法都会让保格式这件事打折扣，
 * 而隔离已经由 sandbox="" 保证了（脚本不执行），不需要再靠改内容来求安全。
 *
 * 高度用 CSS 控制（见 .flash-card__html），文档本身不设高度，让它自然撑开由 iframe 滚动。
 */
function wrapClippedHtml(html: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    /* 横向不许溢出的两层：html/body 兜住整体，宽元素各自滚自己的。
       只写 img/table 的 max-width 不够 —— 一个超宽 pre 或长 URL 就能
       在 iframe 里顶出一条横向滚动条（第一版就是这样）。 */
    'html,body{margin:0;padding:0;max-width:100%;overflow-x:hidden}',
    'body{font:14px/1.7 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2937;overflow-wrap:break-word;word-break:break-word}',
    'img{max-width:100%;height:auto}',
    'pre{overflow-x:auto;max-width:100%;padding:8px;background:#f3f4f6;border-radius:6px}',
    'code{background:#f3f4f6;padding:1px 4px;border-radius:3px}',
    'table{border-collapse:collapse;max-width:100%;display:block;overflow-x:auto}',
    'a{overflow-wrap:anywhere}',
    'th,td{border:1px solid #d1d5db;padding:4px 8px}',
    'blockquote{margin:0;padding-left:12px;border-left:3px solid #d1d5db;color:#4b5563}',
    'a{color:#0e7490}',
    'h1,h2,h3{line-height:1.3}',
    '</style></head><body>',
    html,
    '</body></html>',
  ].join('')
}

/** 收件箱：任务收件箱 | 闪念 两个 Tab，含整理闭环（转任务 / 转笔记 / 归档）。 */
export function InboxPage({ onNotice, onChanged }: Props) {
  const dialog = useDialog()
  /** 完成任务：有关联笔记时会先问「要不要总结」 */
  const completeTask = useCompleteTask(onNotice)
  const [tab, setTab] = useState<Tab>('tasks')
  /** 首次数据到位后只自动跳一次 tab（用户之后手动切换不再干预） */
  const [initialTabSettled, setInitialTabSettled] = useState(false)
  /** 闪念多选（合并用） */
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [tasks, setTasks] = useState<Task[]>([])
  const [flashes, setFlashes] = useState<Flash[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [draft, setDraft] = useState('')
  /**
   * 粘贴进来的富文本。非空时提交走 html 分支，并存成 content_format='html' 的闪念。
   * 用 state 而不是 ref：输入框的 placeholder 要跟着变，得触发重渲染。
   */
  const [pendingHtml, setPendingHtml] = useState('')
  const [selectedTask, setSelectedTask] = useState<number | null>(null)
  const [collapsed] = useState<Set<number>>(new Set())
  /** 「转子任务」正在选父任务的闪念 id */
  const [subtaskFor, setSubtaskFor] = useState<number | null>(null)
  /** 「转笔记」正在选目录的闪念 id */
  const [folderFor, setFolderFor] = useState<number | null>(null)
  const [noteFolders, setNoteFolders] = useState<NoteFolder[]>([])
  /** 删除闪念后的页内撤销槽 */
  const [undoFlash, setUndoFlash] = useState<{ id: number; label: string } | null>(null)
  /** 闪念深链目标：切到闪念 Tab 后定位/高亮该条，2.6s 后自动取消高亮 */
  const [flashFocus, setFlashFocus] = useState<number | null>(null)

  const loadTasks = useCallback(async () => {
    setTasks(await window.zhixing.db.inboxTasks())
  }, [])

  const loadFlashes = useCallback(async () => {
    setFlashes(await window.zhixing.db.flashes(showArchived ? 'archived' : 'inbox'))
  }, [showArchived])

  useEffect(() => {
    void loadTasks()
  }, [loadTasks])
  useEffect(() => {
    void loadFlashes()
  }, [loadFlashes])

  /**
   * 订阅数据变更：**人就在这一页时也要刷新**。
   *
   * 此前只在挂载时拉一次 —— 剪藏一条新闪念（走 HTTP 端点落库）之后页面纹丝不动，
   * 得切走再切回来才看得见（用户反馈）。两个域都要：闪念看 flash，
   * 任务收件箱看 task（任务可能被别处改）。
   */
  useEffect(
    () =>
      subscribeDomain(['flash', 'task'], () => {
        void loadFlashes()
        void loadTasks()
      }),
    [loadFlashes, loadTasks]
  )

  // 有闪念、而任务收件箱是空的时，默认落到「闪念」——
  // 否则闪念躺在另一个 tab 里，用户会以为丢掉了一条。
  useEffect(() => {
    if (initialTabSettled) return
    if (flashes.length === 0 && tasks.length === 0) return
    setInitialTabSettled(true)
    if (flashes.length > 0 && tasks.length === 0) setTab('flash')
  }, [flashes, tasks, initialTabSettled])

  // 转笔记的目录候选
  useEffect(() => {
    void (async () => setNoteFolders(await window.zhixing.db.noteFolders()))()
  }, [])

  // 闪念深链（托盘「记闪念」/ 图谱双击闪念）——切到闪念 Tab 并登记待定位 id
  useEffect(() => {
    const onOpenFlash = (e: Event): void => {
      const id = Number((e as CustomEvent<{ id?: number }>).detail?.id)
      if (!Number.isFinite(id) || id <= 0) return
      setTab('flash')
      setFlashFocus(id)
    }
    window.addEventListener('zhixing:open-flash', onOpenFlash)
    return () => window.removeEventListener('zhixing:open-flash', onOpenFlash)
  }, [])

  // 目标可能落在另一个状态桶（归档 / 收件箱）：查全部闪念判断它属于哪一桶，再切过去
  useEffect(() => {
    if (flashFocus == null) return
    if (flashes.some((f) => f.id === flashFocus)) return
    void window.zhixing.db.flashes(null).then((all) => {
      const hit = all.find((f) => f.id === flashFocus)
      if (hit) setShowArchived(hit.status === 'archived')
    })
  }, [flashFocus, flashes])

  // 目标进入当前列表后滚入视野，高亮一段时间后消除（与任务/文件夹深链一致）
  useEffect(() => {
    if (flashFocus == null || tab !== 'flash') return
    if (!flashes.some((f) => f.id === flashFocus)) return
    document
      .querySelector<HTMLElement>(`.flash-card[data-flash-id="${flashFocus}"]`)
      ?.scrollIntoView({ block: 'center' })
    const timer = window.setTimeout(() => setFlashFocus(null), 2600)
    return () => window.clearTimeout(timer)
  }, [flashFocus, flashes, tab])

  /**
   * 收件箱里**已完成的行不再列出**。
   *
   * 与任务页清单视图同一条规矩：完成（或放弃）的任务从当前清单收走，统一进「已完成」入口。
   * 收件箱此前是唯一的例外 —— 于是收件箱里堆着几十行做完的事（实测 41 行里 30 行已完成），
   * 用户的第一反应就是"这些为什么还在这儿"。
   *
   * 过滤后不会留下孤儿子任务：父任务有效完成 ⟺ 它所有后代都有效完成，
   * 所以被隐藏的父任务，其子任务也一定在同一批里。
   */
  const hiddenDone = useMemo(() => {
    const effective = effectiveDoneMap(tasks)
    return tasks.filter((t) => effective.get(t.id)).length
  }, [tasks])

  const tree = useMemo(() => {
    const effective = effectiveDoneMap(tasks)
    const live = tasks.filter((t) => !effective.get(t.id))
    return buildTaskTree(live, effectiveDoneMap(live), new Map(), new Map())
  }, [tasks])

  /**
   * 计数**含子任务**：与任务页清单树的「收件箱」、侧栏徽标同一口径 ——
   * 该清单下所有未有效完成的任务都算一项（一个父任务带两个子任务 = 3）。
   * 树里已经只剩未完成的行，所以就是它的节点总数。
   */
  const undone = useMemo(() => {
    const count = (nodes: TaskNode[]): number =>
      nodes.reduce((n, node) => n + 1 + count(node.children), 0)
    return count(tree)
  }, [tree])

  const refresh = useCallback(async () => {
    await loadTasks()
    await loadFlashes()
    await onChanged()
  }, [loadTasks, loadFlashes, onChanged])

  const handleToggleTask = async (id: number): Promise<void> => {
    await completeTask(id, () => refresh())
    window.dispatchEvent(
      new CustomEvent('zhixing:undoable', { detail: { ids: [id], label: '任务状态已切换' } })
    )
    await refresh()
  }

  const handleAddFlash = async (): Promise<void> => {
    const text = draft.trim()
    const html = pendingHtml
    // 富文本优先：粘贴来的 HTML 才是内容本体，draft 里只是给它看的占位说明
    if (!html && !text) return
    setDraft('')
    setPendingHtml('')
    // 内容是从剪贴板粘进来的就顺带记下来源 URL（与划词捕获同一套解析，
    // 只传剪贴板里**确实包含这段文字**的情形，避免给手打的闪念误挂无关链接）。
    let sourceUrl = ''
    try {
      const { text: clip, html } = await readClipboard()
      if (clip && clip.includes(text)) sourceUrl = extractSourceUrl(html, clip)
    } catch {
      sourceUrl = ''
    }
    // 富文本闪念存 HTML（列表会用沙箱 iframe 渲染），纯文本闪念照旧
    await window.zhixing.db.addFlash(html || text, '', '', sourceUrl, html ? 'html' : 'text')
    await refresh()
  }

  const handleToTask = async (f: Flash): Promise<void> => {
    const id = await window.zhixing.db.flashToTask(f.id)
    if (id == null) return
    onNotice(`已转为任务 #${id}`)
    await refresh()
  }

  /** 打开目录选择。 */
  const handleToNote = (f: Flash): void => {
    setSubtaskFor(null)
    setFolderFor(f.id)
  }

  /** 转笔记到指定目录；`null` = 不指定（落到默认目录，与原来一致）。 */
  const handleToNoteInto = async (f: Flash, folderId: number | null): Promise<void> => {
    const id = await window.zhixing.db.flashToNote(f.id, folderId)
    setFolderFor(null)
    if (id == null) return
    onNotice(`已转为笔记 #${id}`)
    await refresh()
  }

  /** 转子任务：挂到所选父任务下。 */
  const handleToSubtask = async (f: Flash, parentId: number, parentName: string): Promise<void> => {
    const id = await window.zhixing.db.flashToSubtask(f.id, parentId)
    setSubtaskFor(null)
    if (id == null) return
    onNotice(`已加为「${parentName}」的子任务`)
    await refresh()
  }

  const handleArchive = async (f: Flash): Promise<void> => {
    if (showArchived) await window.zhixing.db.unarchiveFlash(f.id)
    else await window.zhixing.db.archiveFlash(f.id)
    await refresh()
  }

  /** 改备注。 */
  const handleRemark = async (f: Flash): Promise<void> => {
    const next = await dialog.prompt({
      title: '备注',
      label: '备注（最长 200 字）',
      defaultValue: f.remark ?? '',
    })
    if (next == null) return
    await window.zhixing.db.updateFlashRemark(f.id, next)
    await refresh()
  }

  /** 打标签。 */
  const handleTag = async (f: Flash): Promise<void> => {
    const raw = await dialog.prompt({ title: '打标签', label: '标签（逗号分隔）', defaultValue: '' })
    if (raw == null) return
    const tags = raw
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
    await window.zhixing.db.tagFlash(f.id, tags)
    onNotice(tags.length ? `已打标签：${tags.join('、')}` : '已清空标签')
    await refresh()
  }

  /** 合并选中：正文拼接、标签取并集、原条进回收站。 */
  const handleMerge = async (): Promise<void> => {
    const ids = [...picked]
    if (ids.length < 2) {
      onNotice('至少选中两条闪念才能合并')
      return
    }
    const merged = await window.zhixing.db.mergeFlashes(ids)
    setPicked(new Set())
    onNotice(merged == null ? '合并失败' : `已合并 ${ids.length} 条`)
    await refresh()
  }

  const handleDeleteFlash = async (f: Flash): Promise<void> => {
    const confirmed = await dialog.confirm({
      title: '删除闪念',
      message: '删除这条闪念？软删除，可在回收站恢复。',
      icon: <Trash2 size={15} />,
      danger: true,
      confirmText: '删除',
    })
    if (!confirmed) return
    await window.zhixing.db.deleteFlash(f.id)
    // 删除后给撤销槽；
    // 之前只有 confirm + 软删，没有任何回退路径。
    setUndoFlash({ id: f.id, label: (f.content || '').split('\n')[0].slice(0, 30) })
    await refresh()
  }

  /** 撤销删除：从回收站恢复这条闪念。 */
  const handleUndoDeleteFlash = async (): Promise<void> => {
    if (!undoFlash) return
    await window.zhixing.db.restoreTrash('flash', undoFlash.id)
    setUndoFlash(null)
    onNotice('已撤销删除')
    await refresh()
  }

  const renderNodes = (nodes: TaskNode[], depth = 0): React.ReactNode =>
    nodes.map((node) => (
      <div key={node.id}>
        <TaskRow
          node={node}
          depth={depth}
          selected={selectedTask === node.id}
          collapsed={collapsed.has(node.id)}
          onToggle={handleToggleTask}
          onToggleCollapse={() => undefined}
          onSelect={setSelectedTask}
          onDragStart={() => undefined}
          onDragOverRow={() => undefined}
          onDropRow={() => undefined}
          onDragEnd={() => undefined}
          dropHint={null}
          onOpenTags={() => onNotice('在任务页点击标签 chip 可增删')}
          onContextMenu={() => onNotice('右键菜单在任务页可用')}
          onOpenPriority={() => onNotice('优先级请在任务页的旗子上修改')}
          onOpenStatus={() => onNotice('状态请在任务页修改')}
          onTitleCommit={async (id, title) => {
            await window.zhixing.db.setTitle(id, title)
            await refresh()
          }}
          onFocus={(id, title) =>
            // 直接开那个独立小窗（不再派发本地事件）：浮窗与主窗口都能用同一条路，
            // 而在浮窗里派发的 window 事件主窗口根本收不到 —— 那条路径此前是哑的。
            void window.zhixing.pomodoro.open({ taskId: id, title })
          }
          onAddSubtask={async (id) => {
            await window.zhixing.db.createTask('新子任务', id)
            await refresh()
          }}
          onEdit={() => onNotice('编辑请在任务页双击任务打开')}
          onDelete={async (id) => {
            const confirmed = await dialog.confirm({
      title: '删除任务',
      message: '删除该任务及其子任务？软删除，可在回收站恢复。',
      icon: <Trash2 size={15} />,
      danger: true,
      confirmText: '删除',
    })
    if (!confirmed) return
            await window.zhixing.db.deleteTask(id)
            await refresh()
          }}
        />
        {renderNodes(node.children, depth + 1)}
      </div>
    ))

  return (
    <div className="page page--inbox">
      <div className="page__body">

      <Toolbar
        title={'收件箱'}
        subtitle={'待整理的闪念'}
        nav={(
          <div className="seg" role="tablist" aria-label="收件箱分区">
            <button role="tab" aria-selected={tab === 'tasks'} onClick={() => setTab('tasks')}>
              任务收件箱 · {undone}
            </button>
            <button role="tab" aria-selected={tab === 'flash'} onClick={() => setTab('flash')}>
              闪念 · {flashes.length}
            </button>
          </div>
        )}
        search={
          tab === 'flash' ? (
            <input
              className="field field--compact"
              value={draft}
              placeholder={pendingHtml ? '已捕获富文本，回车收进收件箱' : '记一条闪念，回车收进收件箱'}
              aria-label="新建闪念"
              onChange={(e) => setDraft(e.target.value)}
              onPaste={(e) => {
                /**
                 * 粘贴网页内容时**直接收成富文本闪念**，而不是把 HTML 源码
                 * 变成一坨文字塞进输入框 —— 那样用户看到的是一堆标签。
                 *
                 * 这里没有像最初设想的那样"展开成一个富文本编辑器"：
                 * 闪念的定位是**先收下、之后再处理**，展开编辑器反而拖慢了它；
                 * 而收件箱列表本来就能渲染 HTML（沙箱 iframe），收下之后立刻看得见。
                 */
                const html = e.clipboardData.getData('text/html')
                if (!html || !/<(table|img|p|h[1-6]|ul|ol|blockquote)\b/i.test(html)) return
                e.preventDefault()
                setPendingHtml(html)
                const t = e.clipboardData.getData('text/plain').trim()
                setDraft(t || '（来自网页的富文本）')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAddFlash()
              }}
            />
          ) : undefined
        }
        primary={
          tab === 'flash' ? (
            <button className="text-btn text-btn--accent" onClick={() => void handleAddFlash()}>
              <Plus size={14} /> 收进收件箱
            </button>
          ) : undefined
        }
        secondary={
          tab === 'flash'
            ? [
                <button
                  key="arch"
                  className="text-btn"
                  aria-pressed={showArchived}
                  onClick={() => setShowArchived((v) => !v)}
                >
                  {showArchived ? '看收件箱' : '看归档'}
                </button>,
                <button key="merge" className="text-btn" onClick={() => void handleMerge()} disabled={picked.size < 2}>
                  合并选中{picked.size > 0 ? ` · ${picked.size}` : ''}
                </button>,
                ...(picked.size > 0
                  ? [
                      <button key="clear" className="text-btn" onClick={() => setPicked(new Set())}>
                        清空选择
                      </button>,
                    ]
                  : []),
                ...(undoFlash
                  ? [
                      <span key="undo" className="u-aux">
                        已删除闪念「{undoFlash.label}」
                        <button className="text-btn" onClick={() => void handleUndoDeleteFlash()}>
                          <Undo2 size={13} /> 撤销
                        </button>
                      </span>,
                    ]
                  : []),
              ]
            : []
        }
      />

      {tab === 'tasks' ? (
        <section className="inbox-panel" aria-label="任务收件箱">
          {tree.length === 0 ? (
            <p className="empty-hint">
              {hiddenDone > 0
                ? `收件箱里没有待办的任务了（${hiddenDone} 项已完成，已收进任务页的「已完成」）。`
                : '没有未归类的任务。归到列表里的任务不会出现在这里。'}
            </p>
          ) : (
            <div className="task-tree">{renderNodes(tree)}</div>
          )}
        </section>
      ) : (
        <section className="inbox-panel" aria-label="闪念">
          {flashes.length === 0 ? (
            <p className="empty-hint">
              {showArchived ? '还没有归档的闪念。' : '收件箱是空的。划词捕获或在这里输入都会进收件箱。'}
            </p>
          ) : (
            <ul className="flash-list">
              {flashes.map((f, i) => (
                // 交错入场：前 8 行按 --dur-stagger 递进，第 9 行往后都只等第 8 行的延迟
                <li
                  key={f.id}
                  className={
                    'flash-card' +
                    (picked.has(f.id) ? ' flash-card--picked' : '') +
                    (flashFocus === f.id ? ' flash-card--focus' : '')
                  }
                  data-flash-id={f.id}
                  style={{ animationDelay: `calc(var(--dur-stagger) * ${Math.min(i, 7)})` }}
                >
                  <label className="flash-card__pick" title="选中以合并">
                    <input
                      type="checkbox"
                      checked={picked.has(f.id)}
                      onChange={(e) => {
                        setPicked((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(f.id)
                          else next.delete(f.id)
                          return next
                        })
                      }}
                      aria-label="选中这条闪念"
                    />
                  </label>
                  {/*
                    网页剪藏存的是 HTML，**必须用沙箱 iframe 渲染**。

                    理由不是"这样更方便"，而是安全性：那段 HTML 来自不受信任的外部网页，
                    直接插进 DOM 就等于把它的脚本、表单、iframe 一起放进来。
                    这里用 sandbox=""（最严：连 allow-same-origin 都不给），
                    脚本不执行、表单不能提交、也拿不到宿主页面的任何东西，
                    而样式与结构照常显示 —— 保格式与隔离可以同时成立。

                    纯文本的闪念仍然走原来的 <p>，不去套一层 iframe 增加开销。
                  */}
                  {f.content_format === 'html' ? (
                    <iframe
                      className="flash-card__html"
                      sandbox=""
                      title={f.remark || '剪藏的网页内容'}
                      srcDoc={wrapClippedHtml(f.content)}
                    />
                  ) : (
                    <p className="flash-card__content">{f.content}</p>
                  )}
                  {f.remark && <p className="flash-card__remark">└ {f.remark}</p>}
                  <div className="flash-card__meta">
                    <span className="u-aux">{f.created_at.slice(0, 16)}</span>
                    {/* 来源应用/URL（显示「来自 X」；source_url 在捕获时写入） */}
                    <span className="u-aux">来自 {f.source_app || '未知'}</span>
                    {f.source_url && <span className="u-aux">{f.source_url}</span>}
                    {f.status === 'converted' && (
                      <span className="chip">
                        已转为
                        {f.converted_type === 'task'
                          ? '任务'
                          : f.converted_type === 'subtask'
                            ? '子任务'
                            : '笔记'}{' '}
                        #{f.converted_id}
                      </span>
                    )}
                  </div>
                  {subtaskFor === f.id && (
                    <TargetSelector
                      mode="subtask"
                      onCancel={() => setSubtaskFor(null)}
                      onPick={(id, name) => void handleToSubtask(f, id, name)}
                    />
                  )}
                  {folderFor === f.id && (
                    <div className="flash-card__actions">
                      {/* 原来是 defaultValue="" 的非受控 select（选完就执行、不保留选中态）；
                          换成受控的 Select 后固定显示 value=""，行为不变。 */}
                      <Select
                        className="field field--mini"
                        ariaLabel="目标笔记目录"
                        value=""
                        onChange={(v) => void handleToNoteInto(f, v ? Number(v) : null)}
                        options={[
                          { value: '', label: '（默认目录）' },
                          ...noteFolders.map((nf) => ({ value: String(nf.id), label: nf.name })),
                        ]}
                      />
                      <button className="text-btn" onClick={() => setFolderFor(null)}>
                        取消
                      </button>
                    </div>
                  )}
                  <div className="flash-card__actions">
                    <button className="text-btn" onClick={() => void handleToTask(f)} disabled={f.status === 'converted'}>
                      <ListPlus size={13} /> 转任务
                    </button>
                    <button className="text-btn" onClick={() => setSubtaskFor(f.id)} disabled={f.status === 'converted'}>
                      <FolderInput size={13} /> 转子任务
                    </button>
                    <button className="text-btn" onClick={() => handleToNote(f)} disabled={f.status === 'converted'}>
                      <FileText size={13} /> 转笔记
                    </button>
                    <button className="text-btn" onClick={() => void handleRemark(f)}>
                      <Pencil size={13} /> 备注
                    </button>
                    <button className="text-btn" onClick={() => void handleTag(f)}>
                      <TagIcon size={13} /> 标签
                    </button>
                    <button className="text-btn" onClick={() => void handleArchive(f)}>
                      {showArchived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
                      {showArchived ? '取消归档' : '归档'}
                    </button>
                    <button className="text-btn text-btn--danger" onClick={() => void handleDeleteFlash(f)}>
                      <Trash2 size={13} /> 删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      </div>
    </div>
  )
}
