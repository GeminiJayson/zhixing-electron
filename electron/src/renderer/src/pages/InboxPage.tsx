import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArchiveRestore, Archive, FileText, ListPlus, Pencil, Plus, Tag as TagIcon, Trash2 } from 'lucide-react'
import { buildTaskTree, effectiveDoneMap, type TaskNode } from '@shared/task'
import type { Flash, Task } from '@shared/types'
import { t } from '../i18n'
import { useDialog } from '../components/Dialogs'
import { TaskRow } from '../components/TaskRow'

interface Props {
  onNotice: (message: string) => void
  onChanged: () => Promise<void>
}

type Tab = 'tasks' | 'flash'

/** 收件箱：任务收件箱 | 闪念 两个 Tab，含整理闭环（转任务 / 转笔记 / 归档）。 */
export function InboxPage({ onNotice, onChanged }: Props) {
  const dialog = useDialog()
  const [tab, setTab] = useState<Tab>('tasks')
  /** 闪念多选（合并用） */
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [tasks, setTasks] = useState<Task[]>([])
  const [flashes, setFlashes] = useState<Flash[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [draft, setDraft] = useState('')
  const [selectedTask, setSelectedTask] = useState<number | null>(null)
  const [collapsed] = useState<Set<number>>(new Set())

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

  const tree = useMemo(() => {
    const effective = effectiveDoneMap(tasks)
    return buildTaskTree(tasks, effective, new Map(), new Map())
  }, [tasks])

  /** 未完成计数含子任务（对齐 inbox_page._count_undone 的 walk）。 */
  const undone = useMemo(() => {
    const count = (nodes: TaskNode[]): number =>
      nodes.reduce((n, node) => n + (node.effectiveDone ? 0 : 1) + count(node.children), 0)
    return count(tree)
  }, [tree])

  const refresh = useCallback(async () => {
    await loadTasks()
    await loadFlashes()
    await onChanged()
  }, [loadTasks, loadFlashes, onChanged])

  const handleToggleTask = async (id: number): Promise<void> => {
    await window.zhixing.db.toggleTask(id)
    window.dispatchEvent(
      new CustomEvent('zhixing:undoable', { detail: { ids: [id], label: '任务状态已切换' } })
    )
    await refresh()
  }

  const handleAddFlash = async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    await window.zhixing.db.addFlash(text)
    await refresh()
  }

  const handleToTask = async (f: Flash): Promise<void> => {
    const id = await window.zhixing.db.flashToTask(f.id)
    if (id == null) return
    onNotice(`已转为任务 #${id}`)
    await refresh()
  }

  const handleToNote = async (f: Flash): Promise<void> => {
    const id = await window.zhixing.db.flashToNote(f.id)
    if (id == null) return
    onNotice(`已转为笔记 #${id}`)
    await refresh()
  }

  const handleArchive = async (f: Flash): Promise<void> => {
    if (showArchived) await window.zhixing.db.unarchiveFlash(f.id)
    else await window.zhixing.db.archiveFlash(f.id)
    await refresh()
  }

  /** 改备注（对齐 update_remark）。 */
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

  /** 打标签（对齐 tag：按名 ensure 后整体覆盖）。 */
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

  /** 合并选中（对齐 merge）：正文拼接、标签取并集、原条进回收站。 */
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
    if (!window.confirm('删除这条闪念？')) return
    await window.zhixing.db.deleteFlash(f.id)
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
          onTitleCommit={async (id, title) => {
            await window.zhixing.db.setTitle(id, title)
            await refresh()
          }}
          onFocus={(id, title) =>
            window.dispatchEvent(
              new CustomEvent('zhixing:pomodoro', { detail: { taskId: id, title } })
            )
          }
          onAddSubtask={async (id) => {
            await window.zhixing.db.createTask('新子任务', id)
            await refresh()
          }}
          onEdit={() => onNotice('编辑请在任务页双击任务打开')}
          onDelete={async (id) => {
            if (!window.confirm('删除该任务及其子任务？')) return
            await window.zhixing.db.deleteTask(id)
            await refresh()
          }}
        />
        {renderNodes(node.children, depth + 1)}
      </div>
    ))

  return (
    <div className="page page--inbox">
      <div className="page__head">
        <h1 className="page__title">{t('page.inbox')}</h1>
        <p className="page__subtitle">{t('page.inbox.sub')}</p>
      </div>
      <div className="page__body">

      <div className="seg inbox-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'tasks'} onClick={() => setTab('tasks')}>
          任务收件箱 · {undone}
        </button>
        <button role="tab" aria-selected={tab === 'flash'} onClick={() => setTab('flash')}>
          闪念 · {flashes.length}
        </button>
      </div>

      {tab === 'tasks' ? (
        <section className="inbox-panel" aria-label="任务收件箱">
          {tree.length === 0 ? (
            <p className="empty-hint">没有未归类的任务。归到列表里的任务不会出现在这里。</p>
          ) : (
            <div className="task-tree">{renderNodes(tree)}</div>
          )}
        </section>
      ) : (
        <section className="inbox-panel" aria-label="闪念">
          <div className="flash-new">
            <input
              className="field"
              value={draft}
              placeholder="记一条闪念，回车收进收件箱"
              aria-label="新建闪念"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAddFlash()
              }}
            />
            <button className="text-btn text-btn--accent" onClick={() => void handleAddFlash()}>
              <Plus size={14} /> 收进收件箱
            </button>
            <button className="text-btn" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? '看收件箱' : '看归档'}
            </button>
          </div>

          <div className="flash-toolbar">
            <button className="text-btn" onClick={() => void handleMerge()} disabled={picked.size < 2}>
              合并选中{picked.size > 0 ? ` · ${picked.size}` : ''}
            </button>
            {picked.size > 0 && (
              <button className="text-btn" onClick={() => setPicked(new Set())}>
                清空选择
              </button>
            )}
          </div>
          {flashes.length === 0 ? (
            <p className="empty-hint">
              {showArchived ? '还没有归档的闪念。' : '收件箱是空的。划词捕获或在这里输入都会进收件箱。'}
            </p>
          ) : (
            <ul className="flash-list">
              {flashes.map((f) => (
                <li key={f.id} className="flash-card">
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
                  <p className="flash-card__content">{f.content}</p>
                  {f.remark && <p className="flash-card__remark">└ {f.remark}</p>}
                  <div className="flash-card__meta">
                    <span className="u-aux">{f.created_at.slice(0, 16)}</span>
                    {f.status === 'converted' && (
                      <span className="chip">已转为{f.converted_type === 'task' ? '任务' : '笔记'} #{f.converted_id}</span>
                    )}
                  </div>
                  <div className="flash-card__actions">
                    <button className="text-btn" onClick={() => void handleToTask(f)} disabled={f.status === 'converted'}>
                      <ListPlus size={13} /> 转任务
                    </button>
                    <button className="text-btn" onClick={() => void handleToNote(f)} disabled={f.status === 'converted'}>
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
