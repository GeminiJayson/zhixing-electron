import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppWindow, Plus, Trash2, Undo2 } from '@renderer/lib/icons'
import { buildTaskTree, effectiveDoneMap, type TaskNode } from '@shared/task'
import { bindHostEvents, subscribeDomain } from '@shared/events'
import { parseSettings } from '@shared/settings'
import { BLOUB_DEFAULT_SHAPE } from '@shared/bloub'
import type { TaskNoteContext, TaskStatus } from '@shared/types'
import { applyAppearance } from './theme'
import { TaskRow } from './components/TaskRow'
import { WidgetBall } from './components/WidgetBall'
import { PriorityMenu } from './components/PriorityMenu'
import { StatusMenu } from './components/StatusMenu'
import { PopMenu, type PopMenuItem } from './components/PopMenu'
import { useDialog } from './components/Dialogs'

/**
 * 边缘缩放命中带。取 4px 与 .widget 的 padding 等宽：
 * 卡片（.widget__card）带 -webkit-app-region: drag，落在卡片上的 mousedown 会被
 * 窗口拖拽吞掉；只有这圈透明外边距上的按下才会作为普通事件到达这里。
 */
const RESIZE_MARGIN = 4

/**
 * 桌面浮窗视图（主窗口以外的第二个窗口，用 ?widget=1 区分）：
 * 顶部快速输入 + 今日待办（含子树）+ 底部「打开主程序」。
 * 与主窗口共用同一份数据层，勾选/新增都直接落库。
 *
 * 浮窗能力：边缘缩放、优先级 / 标签
 * 就地编辑、删除可撤销、hover 展示关联段落 snippet。
 */
export function WidgetApp() {
  const dialog = useDialog()
  const [tasks, setTasks] = useState<Awaited<ReturnType<typeof window.zhixing.db.todayTasks>> | null>(null)
  const [draft, setDraft] = useState('')
  /**
   * 浮窗形态：'full' 完整卡片 / 'ball' 贴边收缩后的悬浮球。
   * 形态由主进程裁决（贴着屏幕边缘就收成球），渲染层只负责画。
   */
  const [mode, setMode] = useState<'full' | 'ball'>('full')
  /** 悬浮球体型（bloub 的形状 id）：主进程右键菜单改它，这里只负责转发给球 */
  const [ballShape, setBallShape] = useState(BLOUB_DEFAULT_SHAPE)
  /**
   * 待处理的提醒条数（主进程推 widget:notice）。
   * 提醒气泡就挂在球旁边，球本身也该有反应 —— >0 时停在 notify 表情。
   * 名字避开浮窗自有的 notice（那是一条提示文案），两者不是一回事。
   */
  const [reminderCount, setReminderCount] = useState(0)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [notice, setNotice] = useState('')
  const [priorityMenu, setPriorityMenu] = useState<{ id: number; anchor: HTMLElement } | null>(null)
  const [statusMenu, setStatusMenu] = useState<{ id: number; anchor: HTMLElement } | null>(null)
  const [tagMenu, setTagMenu] = useState<{ id: number; anchor: HTMLElement } | null>(null)
  /** 任务 → 标签名（标签菜单用） */
  const [tagNames, setTagNames] = useState<Map<number, string[]>>(new Map())
  /** hover 展示的关联段落 snippet */
  const [snippet, setSnippet] = useState<{ id: number; text: string } | null>(null)
  /** 浮窗内的删除撤销 */
  const [undo, setUndo] = useState<{ id: number; title: string } | null>(null)

  const load = useCallback(async () => {
    const [today, tgs] = await Promise.all([
      window.zhixing.db.todayTasks(),
      window.zhixing.db.taskTags(),
    ])
    setTasks(today)
    const names = new Map<number, string[]>()
    for (const r of tgs) {
      const list = names.get(r.task_id) ?? []
      list.push(r.name)
      names.set(r.task_id, list)
    }
    setTagNames(names)
  }, [])

  useEffect(() => {
    // 球形态不查库：球不展示任务，展开回完整卡片时再拉一次最新数据
    if (mode === 'ball') return
    void load()
    // 主窗口改了数据后，浮窗下一次轮询即同步（跨窗口没有共享状态，靠轮询最省心）；
    // 主窗隐藏时主进程会推一次 widget-refresh，避免先看到过期列表
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [load, mode])

  /**
   * 形态订阅：主进程在贴边收缩 / 展开时推 'widget:mode'，挂载时也主动问一次 ——
   * 启动就停在屏幕边缘时，推送可能早于渲染层挂载。
   */
  useEffect(() => {
    void window.zhixing.widget.getMode().then(setMode)
    return window.zhixing.widget.onMode(setMode)
  }, [])

  /**
   * 体型订阅：与形态同一套路 —— 挂载时主动问一次，之后由主进程在右键菜单选形状时推。
   * 启动就停在球形态时，推送可能早于渲染层挂载，所以「问一次」不能省。
   */
  useEffect(() => {
    void window.zhixing.widget.ballShape().then(setBallShape)
    return window.zhixing.widget.onBallShape(setBallShape)
  }, [])

  /**
   * 提醒条数订阅：与形态 / 体型同一套路，主进程在派发提醒时推。
   * 不主动「问一次」也可以 —— 挂载时主进程随后就会推，而且这条只影响表情。
   */
  useEffect(() => window.zhixing.widget.onNotice(setReminderCount), [])

  /**
   * 浮窗透明度（百分比）：主进程只推值，真正画的是根上的 --widget-opacity（见 widget.css）。
   * 挂载时主动问一次 —— 与形态 / 体型同一套路，推送可能早于渲染层挂载。
   */
  const [opacityPct, setOpacityPct] = useState(100)
  useEffect(() => {
    void window.zhixing.widget.opacity().then(setOpacityPct)
    return window.zhixing.widget.onOpacity(setOpacityPct)
  }, [])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--widget-opacity',
      String(Math.max(0.3, Math.min(1, opacityPct / 100)))
    )
  }, [opacityPct])

  // 主进程的显隐联动会推 widget-refresh
  // 依赖是 [load]，load 一变就会重注册 —— 不接住取消函数就会持续叠层
  useEffect(
    () =>
      window.zhixing.app.onAction((action) => {
        if (action === 'widget-refresh') void load()
      }),
    [load]
  )

  // 贴边交互：球形态由 WidgetBall 自己处理点击展开，这里只管双击与右键。
  // 刻意不再监听 mouseenter —— 球就贴在屏幕边缘，鼠标每次掠过都展开会非常烦人。
  useEffect(() => {
    const onDouble = (): void => void window.zhixing.widget.undock()
    const onContext = (e: MouseEvent): void => {
      e.preventDefault()
      void window.zhixing.widget.contextMenu()
    }
    document.body.addEventListener('dblclick', onDouble)
    document.body.addEventListener('contextmenu', onContext)
    return () => {
      document.body.removeEventListener('dblclick', onDouble)
      document.body.removeEventListener('contextmenu', onContext)
    }
  }, [])

  /**
   * 边缘缩放：命中四边 4px 内时切换光标样式，按下后交给主进程按屏幕光标
   * 位移重算尺寸。
   * 用捕获阶段监听，确保先于卡片内部的交互拿到事件。
   */
  useEffect(() => {
    // 球形态不参与缩放：球上没有「边缘」这个概念
    if (mode === 'ball') return
    const edgesAt = (e: MouseEvent): string => {
      const w = window.innerWidth
      const h = window.innerHeight
      let edges = ''
      if (e.clientY <= RESIZE_MARGIN) edges += 'n'
      if (e.clientY >= h - RESIZE_MARGIN) edges += 's'
      if (e.clientX <= RESIZE_MARGIN) edges += 'w'
      if (e.clientX >= w - RESIZE_MARGIN) edges += 'e'
      return edges
    }
    const cursorFor = (edges: string): string => {
      if (!edges) return ''
      if (edges === 'n' || edges === 's') return 'ns-resize'
      if (edges === 'e' || edges === 'w') return 'ew-resize'
      if (edges === 'ne' || edges === 'sw') return 'nesw-resize'
      return 'nwse-resize'
    }
    let active = ''
    const onMove = (e: MouseEvent): void => {
      if (active) {
        void window.zhixing.widget.resizeTo()
        return
      }
      document.body.style.cursor = cursorFor(edgesAt(e))
    }
    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0 || active) return
      const edges = edgesAt(e)
      if (!edges) return
      active = edges
      e.preventDefault()
      e.stopPropagation()
      void window.zhixing.widget.resizeStart(edges)
    }
    const onUp = (): void => {
      if (!active) return
      active = ''
      void window.zhixing.widget.resizeEnd()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('mouseup', onUp)
    }
  }, [mode])

  /**
   * 外观：浮窗是独立渲染进程，主窗口换主题 / 主题包只写 settings 表，
   * 靠主进程按 'settings' 域广播到这里，再整体重铺一遍（明暗 + 主题包 + 强调色 + 字号）。
   */
  useEffect(() => {
    bindHostEvents(window.zhixing.db)
    const syncAppearance = async (): Promise<void> => {
      applyAppearance(parseSettings(await window.zhixing.db.settings()))
    }
    void syncAppearance()
    return subscribeDomain(['settings'], () => void syncAppearance())
  }, [])

  const tree = useMemo(() => {
    if (!tasks) return []
    return buildTaskTree(tasks.subtree, effectiveDoneMap(tasks.subtree), new Map(), new Map())
  }, [tasks])

  const flash = (msg: string): void => {
    setNotice(msg)
    window.setTimeout(() => setNotice(''), 1600)
  }

  const quickAdd = async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    const created = await window.zhixing.db.quickAdd(text)
    if (!created) {
      flash('没解析出可用的标题')
      return
    }
    flash(`已添加「${created.title}」`)
    await load()
  }

  /** 「改优先级」就地生效 */
  const pickPriority = async (id: number, value: number): Promise<void> => {
    await window.zhixing.db.setPriority(id, value)
    await load()
  }

  /** 状态胶囊的快捷菜单：与优先级菜单同一条路子 */
  const pickStatus = async (id: number, value: TaskStatus): Promise<void> => {
    await window.zhixing.db.setStatus(id, value)
    await load()
  }

  /** 标签菜单项：移除已有标签 / 添加新标签 */
  const tagItems = (id: number): PopMenuItem[] => {
    const current = tagNames.get(id) ?? []
    const items: PopMenuItem[] = current.map((name) => ({
      key: 'rm-' + name,
      label: `移除 #${name}`,
      onPick: () => {
        void window.zhixing.db
          .setTaskTags(id, current.filter((n) => n !== name))
          .then(load)
      },
    }))
    items.push({
      key: 'add',
      label: '添加标签…',
      onPick: () => {
        const raw = window.prompt('标签名（逗号分隔多个）：') ?? ''
        const names = raw
          .replace(/，/g, ',')
          .split(',')
          .map((s) => s.trim().replace(/^#/, ''))
          .filter(Boolean)
        if (!names.length) return
        const merged = [...current, ...names.filter((n) => !current.includes(n))]
        void window.zhixing.db.setTaskTags(id, merged).then(load)
      },
    })
    return items
  }

  /** 删除走浮窗内撤销 */
  const removeTask = async (id: number, title: string): Promise<void> => {
    const confirmed = await dialog.confirm({
      title: '删除任务',
      message: '删除该任务及其子任务？删除后 8 秒内可撤销。',
      icon: <Trash2 size={15} />,
      danger: true,
      confirmText: '删除',
    })
    if (!confirmed) return
    await window.zhixing.db.deleteTask(id)
    setUndo({ id, title })
    window.setTimeout(() => setUndo((u) => (u?.id === id ? null : u)), 8000)
    await load()
  }

  const undoRemove = async (id: number): Promise<void> => {
    setUndo(null)
    await window.zhixing.db.restoreTrash('task', id)
    await load()
  }

  /**
   * hover 展示关联段落 snippet：
   * 取该任务第一条 task_note_context 的引文，折叠空白后截断。
   */
  const showSnippet = async (id: number): Promise<void> => {
    try {
      const ctxs = (await window.zhixing.db.linkedContexts(id)) as TaskNoteContext[]
      const text = (ctxs[0]?.snippet ?? '').replace(/\s+/g, ' ').trim()
      if (!text) {
        setSnippet((cur) => (cur?.id === id ? null : cur))
        return
      }
      setSnippet({ id, text: text.length > 60 ? `${text.slice(0, 60)}…` : text })
    } catch {
      // 段落上下文不可用（库只读等）时不打扰用户
    }
  }

  const renderNodes = (nodes: TaskNode[], depth = 0): React.ReactNode =>
    nodes.map((node) => (
      <div
        key={node.id}
        onMouseEnter={() => void showSnippet(node.id)}
        onMouseLeave={() => setSnippet((cur) => (cur?.id === node.id ? null : cur))}
      >
        <TaskRow
          node={node}
          depth={depth}
          selected={false}
          collapsed={collapsed.has(node.id)}
          onToggle={async (id) => {
            await window.zhixing.db.toggleTask(id)
            await load()
          }}
          onToggleCollapse={(id) =>
            setCollapsed((prev) => {
              const next = new Set(prev)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })
          }
          onSelect={() => undefined}
          onOpenPriority={(id, anchor) => setPriorityMenu({ id, anchor })}
          onOpenStatus={(id, anchor) => setStatusMenu({ id, anchor })}
          onOpenTags={(id, anchor) => setTagMenu({ id, anchor })}
          onContextMenu={() => void window.zhixing.widget.contextMenu()}
          onTitleCommit={async (id, title) => {
            await window.zhixing.db.setTitle(id, title)
            await load()
          }}
          onAddSubtask={async (id) => {
            await window.zhixing.db.createTask('新子任务', id)
            await load()
          }}
          onFocus={(id, title) =>
            // 直接开那个独立小窗（不再派发本地事件）：浮窗与主窗口都能用同一条路，
            // 而在浮窗里派发的 window 事件主窗口根本收不到 —— 那条路径此前是哑的。
            void window.zhixing.pomodoro.open({ taskId: id, title })
          }
          onEdit={() => {
            // 完整编辑面板在主窗（浮窗行内标题已可直接改）
            flash('编辑请到主窗口')
            void window.zhixing.widget.openMain()
          }}
          onDelete={(id) => void removeTask(id, node.title)}
          onDragStart={() => undefined}
          onDragOverRow={() => undefined}
          onDropRow={() => undefined}
          onDragEnd={() => undefined}
          dropHint={null}
        />
        {!collapsed.has(node.id) && renderNodes(node.children, depth + 1)}
      </div>
    ))

  // 贴边收缩态：整个窗口交给悬浮球（点击球自身即展开）
  if (mode === 'ball') {
    return (
      <WidgetBall
        shape={ballShape}
        notice={reminderCount}
        onRestore={() => void window.zhixing.widget.undock()}
      />
    )
  }

  return (
    <div className="widget">
      <div className="widget__card drag-region">
        <div className="widget__head no-drag">
          <span className="widget__title">今日待办</span>
          <span className="u-aux">{tasks?.roots.length ?? 0} 项</span>
        </div>
        <div className="widget__input no-drag">
          <input
            className="field"
            value={draft}
            placeholder="快速输入…回车即建"
            aria-label="快速添加任务"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void quickAdd()
            }}
          />
          <button className="icon-btn" aria-label="添加" title="添加" onClick={() => void quickAdd()}>
            <Plus size={15} />
          </button>
        </div>
        <div className="widget__list no-drag">
          {tree.length === 0 ? (
            <p className="u-aux widget__empty">今天没有任务</p>
          ) : (
            renderNodes(tree)
          )}
        </div>
        <div className="widget__foot no-drag">
          <button className="text-btn" onClick={() => void window.zhixing.widget.openMain()}>
            <AppWindow size={13} /> 打开主程序
          </button>
          <span className="modal__spacer" />
          <button className="text-btn" onClick={() => void window.zhixing.widget.close()}>
            隐藏
          </button>
        </div>
        {snippet && (
          <div
            style={{
              position: 'absolute',
              left: 'var(--space-3)',
              right: 'var(--space-3)',
              bottom: 'calc(var(--space-3) + 30px)',
              padding: '4px 8px',
              borderRadius: 'var(--radius-ctl)',
              background: 'var(--bg-hover)',
              color: 'var(--fg-secondary)',
              fontSize: 'var(--text-aux)',
            }}
          >
            {snippet.text}
          </div>
        )}
        {undo && (
          <div
            style={{
              position: 'absolute',
              left: 'var(--space-3)',
              right: 'var(--space-3)',
              bottom: 'var(--space-3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-2)',
              padding: '4px 8px',
              borderRadius: 'var(--radius-ctl)',
              background: 'var(--bg-hover)',
            }}
          >
            <span className="u-aux">已删除「{undo.title}」</span>
            <button className="text-btn" onClick={() => void undoRemove(undo.id)}>
              <Undo2 size={12} /> 撤销
            </button>
          </div>
        )}
        {notice && <div className="widget__toast">{notice}</div>}
      </div>
      {statusMenu && tasks && (
        <StatusMenu
          anchor={statusMenu.anchor}
          current={tasks.subtree.find((t) => t.id === statusMenu.id)?.status ?? 'todo'}
          onPick={(value) => void pickStatus(statusMenu.id, value)}
          onClose={() => setStatusMenu(null)}
        />
      )}
      {priorityMenu && tasks && (
        <PriorityMenu
          anchor={priorityMenu.anchor}
          current={tasks.subtree.find((t) => t.id === priorityMenu.id)?.priority ?? 0}
          onPick={(value) => void pickPriority(priorityMenu.id, value)}
          onClose={() => setPriorityMenu(null)}
        />
      )}
      {tagMenu && (
        <PopMenu
          x={tagMenu.anchor.getBoundingClientRect().left}
          y={tagMenu.anchor.getBoundingClientRect().bottom + 4}
          items={tagItems(tagMenu.id)}
          onClose={() => setTagMenu(null)}
        />
      )}
    </div>
  )
}
