import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarClock, CheckCircle2, CircleAlert, NotebookPen, Sparkles } from 'lucide-react'
import { buildTaskTree, effectiveDoneMap, type TaskNode } from '@shared/task'
import type { Note, Overview, TodayTasks } from '@shared/types'
import { t } from '../i18n'
import { Toolbar } from '../components/Toolbar'
import { PriorityMenu } from '../components/PriorityMenu'
import { TaskRow } from '../components/TaskRow'
import { TaskEditor } from '../components/TaskEditor'

interface Props {
  overview: Overview | null
  onChanged: () => Promise<void>
  onNotice: (message: string) => void
  onOpenNote: (id: number) => void
  onFocusTasks: (kind: 'today' | 'done' | 'overdue') => void
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 今日页：日期问候 + 概览四卡 + 今日待办（含完整子树）+ 最近笔记。 */
export function TodayPage({ overview, onChanged, onNotice, onOpenNote, onFocusTasks }: Props) {
  const [today, setToday] = useState<TodayTasks | null>(null)
  const [recent, setRecent] = useState<Note[]>([])
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [selected, setSelected] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ id: number; anchor: HTMLElement } | null>(null)
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

  // 与手册 §4.1 一致：前三张卡点击跳到任务页对应清单，闪念卡跳收件箱
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
          onEdit={(id) => setEditingId(id)}
          onDelete={async (id) => {
            if (!window.confirm('删除该任务及其子任务？')) return
            await window.zhixing.db.deleteTask(id)
            await refresh()
          }}
        />
        {!collapsed.has(node.id) && renderNodes(node.children, depth + 1)}
      </div>
    ))

  return (
    <div className="page today-page">
      <div className="page__body">

        <Toolbar
          title={t('page.today')}
          subtitle={greeting}
          search={
            <input
              className="field field--compact"
              value={draft}
              placeholder="快速添加今日任务，回车确认（支持 !2 @列表 #标签 明天）"
              aria-label="快速添加任务"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleQuickAdd()
              }}
            />
          }
          primary={
            <button className="text-btn text-btn--accent" onClick={() => void handleQuickAdd()}>
              添加
            </button>
          }
        />

        <section className="stat-grid" aria-label="概览">
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
                <span className="stat-card__value">{c.value}</span>
                <span className="stat-card__label">{c.label}</span>
              </button>
            )
          })}
        </section>

        <section className="section section--grow" aria-label="今日待办">
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
                if (!window.confirm('删除该任务及其子任务？')) return
                await window.zhixing.db.deleteTask(id)
                await refresh()
              }}
              onClose={() => setEditingId(null)}
            />
          )
        })()}

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
