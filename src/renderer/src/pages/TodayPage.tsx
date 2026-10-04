import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarClock, CheckCircle2, CircleAlert, NotebookPen, Sparkles, Trash2 } from '@renderer/lib/icons'
import { isMotionFull } from '../lib/presence'
import { useDialog } from '../components/Dialogs'
import { buildTaskTree, effectiveDoneMap, type TaskNode } from '@shared/task'
import type { Note, Overview, TodayTasks } from '@shared/types'
import { PriorityMenu } from '../components/PriorityMenu'
import { StatusMenu } from '../components/StatusMenu'
import { TaskRow } from '../components/TaskRow'
import { TaskEditor } from '../components/TaskEditor'
import { readTokenMs } from '../lib/motion-tokens'

interface Props {
  overview: Overview | null
  onChanged: () => Promise<void>
  onNotice: (message: string) => void
  onOpenNote: (id: number) => void
  onFocusTasks: (kind: 'today' | 'done' | 'overdue') => void
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 把 --ease-panel 解成 0→1 的进度函数：与 CSS 那条贝塞尔同源（解不开就退化成线性）。 */
function readPanelEase(): (p: number) => number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--ease-panel')
  const m = /\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/.exec(raw)
  if (!m) return (p) => p
  const x1 = Number(m[1])
  const y1 = Number(m[2])
  const x2 = Number(m[3])
  const y2 = Number(m[4])
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const rx = (t: number): number => ((ax * t + bx) * t + cx) * t
  const ry = (t: number): number => ((ay * t + by) * t + cy) * t
  const dx = (t: number): number => (3 * ax * t + 2 * bx) * t + cx
  return (p) => {
    let t = p
    for (let i = 0; i < 8; i += 1) {
      const err = rx(t) - p
      if (Math.abs(err) < 0.0005) break
      const d = dx(t)
      if (Math.abs(d) < 0.000001) break
      t -= err / d
    }
    return ry(Math.min(1, Math.max(0, t)))
  }
}

/**
 * 概览数字滚动（C3）。
 * - 首次进入：0 → 终值，时长 --dur-slow，缓动手感与 --ease-panel 同源；
 * - 之后数值变化（完成一条 2→1）：从**当前值**过渡到新值，时长 --dur-fast，绝不重头再来一遍；
 * - 非 full 档（isMotionFull() 为假）或时长读成 0：直接显示终值。
 * 实现用 requestAnimationFrame 逐帧写 state；数字是 tabular-nums，宽度不会抖。
 */
function useRollNumber(target: number): number {
  const [shown, setShown] = useState(() => (isMotionFull() ? 0 : target))
  const shownRef = useRef(shown)
  const rafRef = useRef<number | null>(null)
  /** 是否还没播过「首次入场滚数」 */
  const firstRef = useRef(true)

  useEffect(() => {
    const cancel = (): void => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
    const settle = (v: number): void => {
      shownRef.current = v
      setShown(v)
    }
    cancel()
    const first = firstRef.current
    const from = first ? 0 : shownRef.current
    const to = target
    // 数值没动（概览还没到位时四张卡都还是 0）：不消费「首次」，等真正的第一个终值再滚
    if (from === to) {
      settle(to)
      return cancel
    }
    const ms = readTokenMs(first ? '--dur-slow' : '--dur-fast')
    if (ms <= 0 || !isMotionFull()) {
      firstRef.current = false
      settle(to)
      return cancel
    }
    const ease = readPanelEase()
    let start = 0
    const step = (now: number): void => {
      if (start === 0) start = now
      const p = Math.min(1, (now - start) / ms)
      if (p < 1) {
        const v = Math.round(from + (to - from) * ease(p))
        shownRef.current = v
        setShown(v)
        rafRef.current = window.requestAnimationFrame(step)
        return
      }
      rafRef.current = null
      // 只有真的滚完才消费「首次」：中途被打断（开发期 StrictMode 重放、
      // 目标值又变了）不该把下一次也降级成「非首次」
      firstRef.current = false
      settle(to)
    }
    rafRef.current = window.requestAnimationFrame(step)
    return cancel
  }, [target])

  // 外观是 App 的 effect 铺的，本页挂载比它早：启动时若本来就是「关闭 / 仅必要」档，
  // 光靠挂载那一刻读令牌会漏判。收到档位广播就立刻落到终值。
  useEffect(() => {
    const onMotion = (): void => {
      if (isMotionFull()) return
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      shownRef.current = target
      setShown(target)
    }
    window.addEventListener('zhixing:motion', onMotion)
    return () => window.removeEventListener('zhixing:motion', onMotion)
  }, [target])

  return shown
}

/** 概览卡上的数字。每张卡各持一条 rAF，互不干扰。 */
function StatValue({ value }: { value: number }): React.ReactElement {
  const shown = useRollNumber(value)
  return <span className="stat-card__value">{shown}</span>
}

/** 今日页：日期问候 + 概览四卡 + 今日待办（含完整子树）+ 最近笔记。 */
export function TodayPage({ overview, onChanged, onNotice, onOpenNote, onFocusTasks }: Props) {
  const dialog = useDialog()
  const [today, setToday] = useState<TodayTasks | null>(null)
  const [recent, setRecent] = useState<Note[]>([])
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [selected, setSelected] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ id: number; anchor: HTMLElement } | null>(null)
  const [statusMenu, setStatusMenu] = useState<{ id: number; anchor: HTMLElement } | null>(null)
  const [draft, setDraft] = useState('')
  // 今日页直接编辑：与任务页共用同一个 TaskEditor
  const [editingId, setEditingId] = useState<number | null>(null)

  const load = useCallback(async () => {
    const [t, r] = await Promise.all([
      window.zhixing.db.todayTasks(),
      window.zhixing.db.recentNotes(5),
    ])
    setToday(t)
    setRecent(r)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCallback(async () => {
    await load()
    await onChanged()
  }, [load, onChanged])

  const tree = useMemo(() => {
    if (!today) return []
    return buildTaskTree(today.subtree, effectiveDoneMap(today.subtree), new Map(), new Map())
  }, [today])

  const greeting = useMemo(() => {
    const d = new Date()
    return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]} · 今日概览`
  }, [])

  // 与手册一致：前三张卡点击跳到任务页对应清单，闪念卡跳收件箱
  const cards = [
    {
      key: 'today',
      label: '今日待办',
      value: overview?.today ?? 0,
      icon: CalendarClock,
      tone: 'accent',
      focus: 'today' as const,
    },
    {
      key: 'done',
      label: '已完成',
      value: overview?.doneToday ?? 0,
      icon: CheckCircle2,
      tone: 'success',
      focus: 'done' as const,
    },
    {
      key: 'overdue',
      label: '已逾期',
      value: overview?.overdue ?? 0,
      icon: CircleAlert,
      tone: 'danger',
      focus: 'overdue' as const,
    },
    {
      key: 'flash',
      label: '闪念收件箱',
      value: overview?.inbox ?? 0,
      icon: Sparkles,
      tone: 'warm',
      focus: null,
    },
  ]

  /** 快速添加：解析语法糖后建任务（无日期词则截止=今天）。 */
  const handleQuickAdd = async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    const created = await window.zhixing.db.quickAdd(text)
    if (!created) {
      onNotice('没解析出可用的标题')
      return
    }
    onNotice(`已添加「${created.title}」`)
    await refresh()
  }

  const handleToggle = async (id: number): Promise<void> => {
    await window.zhixing.db.toggleTask(id)
    window.dispatchEvent(
      new CustomEvent('zhixing:undoable', { detail: { ids: [id], label: '任务状态已切换' } })
    )
    await refresh()
  }

  const renderNodes = (nodes: TaskNode[], depth = 0): React.ReactNode =>
    nodes.map((node) => (
      <div key={node.id}>
        <TaskRow
          node={node}
          depth={depth}
          selected={selected === node.id}
          collapsed={collapsed.has(node.id)}
          onToggle={handleToggle}
          onToggleCollapse={(id) =>
            setCollapsed((prev) => {
              const next = new Set(prev)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })
          }
          onSelect={setSelected}
          onDragStart={() => undefined}
          onDragOverRow={() => undefined}
          onDropRow={() => undefined}
          onDragEnd={() => undefined}
          dropHint={null}
          onOpenTags={() => onNotice('在任务页点击标签 chip 可增删')}
          onContextMenu={() => onNotice('右键菜单在任务页可用')}
          onOpenPriority={(id, anchor) => setMenu({ id, anchor })}
          onOpenStatus={(id, anchor) => setStatusMenu({ id, anchor })}
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
          onEdit={(id) => setEditingId(id)}
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
        {!collapsed.has(node.id) && renderNodes(node.children, depth + 1)}
      </div>
    ))

  return (
    <div className="page today-page">
      <div className="page__head">
        <h1 className="page__title">{'今日'}</h1>
        <p className="page__subtitle">{greeting}</p>
      </div>
      <div className="page__body">

        {/* 快速添加不是「工具」而是「表单行」：独立于工具栏，输入框才能撑满整行。
            塞进工具栏时它会被工具栏的内边距与折叠逻辑挤在中间。 */}
        <div className="quick-add">
          <input
            className="field"
            value={draft}
            placeholder="快速添加今日任务，回车确认（支持 !2 @列表 #标签 明天）"
            aria-label="快速添加任务"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleQuickAdd()
            }}
          />
          <button className="text-btn text-btn--accent" onClick={() => void handleQuickAdd()}>
            添加
          </button>
        </div>

        {/* 原来是 .stat-grid（固定 4 列）。改用布局原语 .u-grid--4 —— 
            它与 .stat-grid 算出来的是同一套列，但间距与列数由令牌与调用点给，
            不必再为每种"几列"造一个类名。 */}
        {/*
          带 .section 是必需的：它提供块与块之间的下边距。
          原先只写了布局原语 .u-grid--4，于是概览区没有任何 margin，
          与「今日待办」紧贴在一起 —— 这一页三块的间距应当一致。
        */}
        <section className="u-grid u-grid--4 section" aria-label="概览">
          {cards.map((c) => {
            const Icon = c.icon
            return (
              <button
                key={c.key}
                className={`stat-card stat-card--${c.tone} stat-card--clickable`}
                onClick={() => {
                  if (c.focus) onFocusTasks(c.focus)
                  else {
                    const el = document.querySelector<HTMLElement>('[data-nav-item="inbox"]')
                    el?.click()
                  }
                }}
                title={c.focus ? `跳到任务页的「${c.label}」` : '跳到收件箱的闪念页'}
              >
                <Icon size={16} strokeWidth={2} aria-hidden />
                <StatValue value={c.value} />
                <span className="stat-card__label">{c.label}</span>
              </button>
            )
          })}
        </section>

        <section className="section section--grow section--today-todo" aria-label="今日待办">
          <header className="section__head">
            <h2>今日待办</h2>
            <span className="u-aux">{today?.roots.length ?? 0} 项 · 未逾期</span>
          </header>
          {/* 滚动只在这一块内发生：标题与概览卡始终可见 */}
          <div className="section__scroll">
            {tree.length === 0 ? (
              <p className="empty-hint">今天没有待办。逾期的任务在任务页的「已逾期」里。</p>
            ) : (
              <div className="task-tree">{renderNodes(tree)}</div>
            )}
          </div>
        </section>

        <section className="section section--grow" aria-label="最近笔记">
          <header className="section__head">
            <h2>最近笔记</h2>
            <span className="u-aux">{recent.length} 篇</span>
          </header>
          <div className="section__scroll">
            {recent.length === 0 ? (
              <p className="empty-hint">还没有笔记。</p>
            ) : (
              <ul className="recent-notes">
                {recent.map((n) => (
                  <li key={n.id}>
                    <button className="recent-notes__row" onClick={() => onOpenNote(n.id)}>
                      <NotebookPen size={14} aria-hidden />
                      <span className="recent-notes__title">{n.title}</span>
                      <span className="u-aux">{n.updated_at.slice(5, 16)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* 今日页可编辑：与任务页共用 TaskEditor，字段与保存路径完全一致 */}
      {editingId != null &&
        (() => {
          const task = today?.subtree.find((x) => x.id === editingId)
          if (!task) return null
          return (
            <TaskEditor
              task={task}
              onSave={async (id, fields) => {
                await window.zhixing.db.updateTask(id, fields)
                await refresh()
              }}
              onDelete={async (id) => {
                setEditingId(null)
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
              onClose={() => setEditingId(null)}
            />
          )
        })()}

      {statusMenu && (
        <StatusMenu
          anchor={statusMenu.anchor}
          current={today?.subtree.find((t) => t.id === statusMenu.id)?.status ?? 'todo'}
          onPick={async (s) => {
            await window.zhixing.db.setStatus(statusMenu.id, s)
            setStatusMenu(null)
            await refresh()
          }}
          onClose={() => setStatusMenu(null)}
        />
      )}

      {menu && (
        <PriorityMenu
          anchor={menu.anchor}
          current={today?.subtree.find((t) => t.id === menu.id)?.priority ?? 0}
          onPick={async (p) => {
            await window.zhixing.db.setPriority(menu.id, p)
            setMenu(null)
            await refresh()
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
