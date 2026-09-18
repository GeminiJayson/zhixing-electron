import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { STATUS_LABELS, buildTaskTree, effectiveDoneMap, type TaskNode } from '@shared/task'
import { priorityLabel } from '@shared/priority'
import type { ListFolder, Task, TaskStatus } from '@shared/types'
import { t } from '../i18n'
import { useDialog } from '../components/Dialogs'
import { PopMenu, type PopMenuItem } from '../components/PopMenu'
import { VirtualList } from '../components/VirtualList'
import { PriorityMenu } from '../components/PriorityMenu'
import { CalendarBoard } from '../components/CalendarBoard'
import { KanbanBoard } from '../components/KanbanBoard'
import { QuadrantBoard, quadrantAssignment, type QuadrantKey } from '../components/QuadrantBoard'
import { TaskEditor } from '../components/TaskEditor'
import { TaskRow } from '../components/TaskRow'
import { dueLabel } from '../lib/date'

interface Props {
  onChanged: () => Promise<void>
  onNotice: (message: string) => void
  /** 今日页概览卡带过来的聚焦清单 */
  focus?: 'today' | 'done' | 'overdue' | null
  onClearFocus?: () => void
}

type ViewKey = 'list' | 'quadrant' | 'calendar' | 'kanban'

const VIEWS: { key: ViewKey; label: string }[] = [
  { key: 'list', label: '列表' },
  { key: 'quadrant', label: '四象限' },
  { key: 'calendar', label: '日历' },
  { key: 'kanban', label: '看板' },
]

type Tag = { id: number; name: string; color: string }

/** 过滤规则与 Python 的 TaskFilterProxy 一致：自身命中或任一后代命中即保留。 */
function filterTree(nodes: TaskNode[], query: string): TaskNode[] {
  if (!query.trim()) return nodes
  const q = query.trim().toLowerCase()
  const walk = (list: TaskNode[]): TaskNode[] =>
    list
      .map((n) => ({ ...n, children: walk(n.children) }))
      .filter((n) => n.title.toLowerCase().includes(q) || n.children.length > 0)
  return walk(nodes)
}

export function TasksPage({ onChanged, onNotice, focus = null, onClearFocus }: Props) {
  const dialog = useDialog()
  const [tasks, setTasks] = useState<Task[]>([])
  const [counts, setCounts] = useState<Map<number, number>>(new Map())
  const [tags, setTags] = useState<Map<number, Tag[]>>(new Map())
  const [view, setView] = useState<ViewKey>('list')
  const [filter, setFilter] = useState('')
  const [folders, setFolders] = useState<ListFolder[]>([])
  /** 清单筛选：'' = 全部；'none' = 收件箱（list_id 为空）；其它 = 清单 id */
  const [listKey, setListKey] = useState('')
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  /** 四象限/日历/看板共享的「展开子任务」集合（与列表的 collapsed 语义相反） */
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [selected, setSelected] = useState<number | null>(null)
  /** 多选集合（Ctrl/Cmd 点击切换、Shift 点击选范围），批量操作的输入 */
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [batchMenu, setBatchMenu] = useState<{ x: number; y: number } | null>(null)
  /** 列表视图的行高（与 --row-h 同源，虚拟列表要求固定行高） */
  const [rowH, setRowH] = useState(40)
  // 行高取自 --row-h（虚拟列表要求固定行高，不能用内容撑开）
  useEffect(() => {
    const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row-h'), 10)
    if (Number.isFinite(v) && v > 0) setRowH(v)
  }, [])

  const [dragId, setDragId] = useState<number | null>(null)
  const [dropHint, setDropHint] = useState<{ id: number; pos: 'before' | 'after' | 'child' } | null>(null)
  const [inspector, setInspector] = useState(false)
  const [menu, setMenu] = useState<{ id: number; anchor: HTMLElement } | null>(null)
  const [allTags, setAllTags] = useState<{ id: number; name: string; color: string }[]>([])
  const [tagMenu, setTagMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  const [adding, setAdding] = useState<{ parentId: number | null } | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const addRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    // 选中清单时走 list_tree 的语义（根 + 后代闭包）；收件箱对应 list_id 为空
    const scoped: number | null | 'all' =
      listKey === '' ? 'all' : listKey === 'none' ? null : Number(listKey)
    const [rows, nc, tt, tg, fs] = await Promise.all([
      scoped === 'all' ? window.zhixing.db.tasks() : window.zhixing.db.tasksByList(scoped),
      window.zhixing.db.noteCounts(),
      window.zhixing.db.taskTags(),
      window.zhixing.db.tags(),
      window.zhixing.db.listFolders(),
    ])
    setAllTags(tg)
    setFolders(fs as ListFolder[])
    const countMap = new Map<number, number>()
    for (const r of nc) countMap.set(r.task_id, r.c)
    const tagMap = new Map<number, Tag[]>()
    for (const r of tt) {
      const list = tagMap.get(r.task_id) ?? []
      list.push({ id: r.id, name: r.name, color: r.color })
      tagMap.set(r.task_id, list)
    }
    setTasks(rows as Task[])
    setCounts(countMap)
    setTags(tagMap)
  }, [listKey])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (adding) addRef.current?.focus()
  }, [adding])

  const effective = useMemo(() => effectiveDoneMap(tasks), [tasks])

  /** 聚焦过滤：只筛根任务，子树仍由 buildTaskTree 自然挂回（与今日待办同口径）。 */
  const scopedTasks = useMemo(() => {
    if (!focus) return tasks
    const day = new Date().toLocaleDateString('sv-SE')
    const isDone = (t: Task): boolean =>
      effective.get(t.id) ?? (t.status === 'done' || t.status === 'abandoned')
    const match = (t: Task): boolean => {
      if (t.parent_id !== null) return true
      if (focus === 'today') return !isDone(t) && (t.due_date === null || t.due_date >= day)
      if (focus === 'done') return isDone(t) && (t.completed_at ?? '').slice(0, 10) === day
      return t.due_date !== null && t.due_date < day && !isDone(t)
    }
    return tasks.filter(match)
  }, [tasks, focus, effective])

  const tree = useMemo(
    () => buildTaskTree(scopedTasks, effective, counts, tags),
    [scopedTasks, effective, counts, tags]
  )

  const visible = useMemo(() => filterTree(tree, filter), [tree, filter])

  /**
   * 树展平结果：[{node, depth}]，node 为 null 表示正在输入的「添加行」。
   *
   * 添加行必须计入行数：虚拟列表是按 count × rowHeight 做绝对定位的，
   * 漏算会让顶层新建压根不渲染（表现为「点新建任务没反应」），
   * 也会让子任务的添加行把后续行挤错位。
   */
  const flatRows = useMemo(() => {
    const rows: { node: TaskNode | null; depth: number }[] = []
    // 顶层新建：没有父任务时，添加行排在列表最前
    if (adding && adding.parentId === null) rows.push({ node: null, depth: 0 })
    const walk = (nodes: TaskNode[], depth: number): void => {
      for (const n of nodes) {
        rows.push({ node: n, depth })
        // 子任务添加行紧跟它的父任务
        if (adding?.parentId === n.id) rows.push({ node: null, depth: depth + 1 })
        if (!collapsed.has(n.id)) walk(n.children, depth + 1)
      }
    }
    walk(visible, 0)
    return rows
  }, [visible, collapsed, adding])

  const selectedNode = useMemo(() => {
    if (selected == null) return null
    const find = (list: TaskNode[]): TaskNode | null => {
      for (const n of list) {
        if (n.id === selected) return n
        const hit = find(n.children)
        if (hit) return hit
      }
      return null
    }
    return find(tree)
  }, [tree, selected])

  const refresh = useCallback(async () => {
    await load()
    await onChanged()
  }, [load, onChanged])


  /** 列表视图的可见顺序，供 Shift 连选使用。 */
  const flatOrder = useMemo(() => {
    const out: number[] = []
    const walk = (nodes: TaskNode[]): void => {
      for (const n of nodes) {
        out.push(n.id)
        if (!collapsed.has(n.id)) walk(n.children)
      }
    }
    walk(visible)
    return out
  }, [visible, collapsed])

  /** 点击选择：默认单选；Ctrl/Cmd 切换；Shift 从主选中连选一片。 */
  const handleSelect = (id: number, e: React.MouseEvent): void => {
    if (e.shiftKey && selected != null) {
      const a = flatOrder.indexOf(selected)
      const b = flatOrder.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a <= b ? [a, b] : [b, a]
        setSelectedIds(new Set(flatOrder.slice(lo, hi + 1)))
        setSelected(id)
        return
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      setSelected(id)
      return
    }
    setSelectedIds(new Set([id]))
    setSelected(id)
  }

  const runBatch = async (
    action: 'complete' | 'due' | 'clearDue' | 'delete'
  ): Promise<void> => {
    const ids = [...selectedIds]
    if (!ids.length) return
    if (action === 'complete') {
      const n = await window.zhixing.db.batchComplete(ids)
      window.dispatchEvent(
        new CustomEvent('zhixing:undoable', { detail: { ids, label: `已批量完成 ${n} 项` } })
      )
    } else if (action === 'due') {
      const day = new Date().toLocaleDateString('sv-SE')
      const n = await window.zhixing.db.batchSetDue(ids, day)
      onNotice(`已把 ${n} 项截止设为今天`)
    } else if (action === 'clearDue') {
      const n = await window.zhixing.db.batchSetDue(ids, null)
      onNotice(`已清除 ${n} 项的截止日期`)
    } else {
      if (!window.confirm(`删除选中的 ${ids.length} 项及其子任务？`)) return
      for (const id of ids) await window.zhixing.db.deleteTask(id)
      // 删除也可撤销（对齐 app_controller 的 delete→undo 链路；此前只有回收站一条退路）
      window.dispatchEvent(
        new CustomEvent('zhixing:undoable', {
          detail: { ids, label: `已删除 ${ids.length} 项`, action: 'restore' },
        })
      )
    }
    setSelectedIds(new Set())
    await refresh()
  }

  /** 拖拽落点：上/下=排序，中间=改挂为该行的子任务（对齐 task_page._on_tree_drop）。 */
  const handleDropRow = async (
    targetId: number,
    pos: 'before' | 'after' | 'child'
  ): Promise<void> => {
    const src = dragId
    setDragId(null)
    setDropHint(null)
    if (src == null || src === targetId) return
    if (pos === 'child') await window.zhixing.db.reparentTask(src, targetId)
    else await window.zhixing.db.reorderTask(src, targetId, pos === 'after')
    await refresh()
  }

  const handleToggle = async (id: number): Promise<void> => {
    await window.zhixing.db.toggleTask(id)
    window.dispatchEvent(
      new CustomEvent('zhixing:undoable', { detail: { ids: [id], label: '任务状态已切换' } })
    )
    await refresh()
  }

  const handlePriority = async (priority: number): Promise<void> => {
    if (!menu) return
    await window.zhixing.db.setPriority(menu.id, priority)
    setMenu(null)
    await refresh()
  }

  const handleTitle = async (id: number, title: string): Promise<void> => {
    await window.zhixing.db.setTitle(id, title)
    await refresh()
  }

  const handleDelete = async (id: number): Promise<void> => {
    const node = tasks.find((t) => t.id === id)
    if (!node) return
    const ok = window.confirm(`删除任务「${node.title}」及其子任务？\n（软删除，可在回收站恢复）`)
    if (!ok) return
    const n = await window.zhixing.db.deleteTask(id)
    window.dispatchEvent(
      new CustomEvent('zhixing:undoable', {
        detail: { ids: [id], label: `已删除 ${n} 项`, action: 'restore' },
      })
    )
    if (selected === id) setSelected(null)
    await refresh()
  }

  /** 同级上移/下移（Ctrl+↑/↓，对齐 move_relative）。 */
  const handleMoveRelative = async (id: number, delta: number): Promise<void> => {
    await window.zhixing.db.moveTaskRelative(id, delta)
    await refresh()
  }

  /** 标签增删：点击行内 chip 弹出，勾选即切换（覆盖式写回）。 */
  const handleToggleTag = async (taskId: number, tagName: string): Promise<void> => {
    const current = (tags.get(taskId) ?? []).map((t) => t.name)
    const next = current.includes(tagName)
      ? current.filter((n) => n !== tagName)
      : [...current, tagName]
    await window.zhixing.db.setTaskTags(taskId, next)
    await refresh()
  }

  const handleCreateTag = async (taskId: number): Promise<void> => {
    const name = await dialog.prompt({
      title: '新建标签',
      label: '标签名称（可逗号分隔多个）',
    })
    if (!name?.trim()) return
    const added = name
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const current = (tags.get(taskId) ?? []).map((t) => t.name)
    await window.zhixing.db.setTaskTags(taskId, [...current, ...added])
    await refresh()
  }

  // 键盘快捷键：Space 完成 / F2 编辑 / Ctrl+↑↓ 同级移动 / ←→ 折叠展开
  // （仅在列表视图、且焦点不在输入框内时生效，与 task_page.py 的作用域一致）
  const keyCtx = useRef({ view, selected, toggle: handleToggle, move: handleMoveRelative, refresh })
  keyCtx.current = { view, selected, toggle: handleToggle, move: handleMoveRelative, refresh }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const ctx = keyCtx.current
      if (ctx.view !== 'list' || ctx.selected == null) return
      const id = ctx.selected
      const mod = e.ctrlKey || e.metaKey
      if (e.key === ' ' && !mod) {
        e.preventDefault()
        void ctx.toggle(id)
      } else if (e.key === 'F2') {
        e.preventDefault()
        setEditingId(id)
      } else if (mod && e.key === 'ArrowUp') {
        e.preventDefault()
        void ctx.move(id, -1)
      } else if (mod && e.key === 'ArrowDown') {
        e.preventDefault()
        void ctx.move(id, 1)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setCollapsed((prev) => new Set(prev).add(id))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setCollapsed((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const handleQuadrant = async (id: number, key: QuadrantKey): Promise<void> => {
    const today = new Date().toLocaleDateString('sv-SE')
    await window.zhixing.db.updateTask(id, quadrantAssignment(key, today))
    await refresh()
  }

  const handleReschedule = async (id: number, day: string): Promise<void> => {
    await window.zhixing.db.setDueDate(id, day)
    await refresh()
  }

  const handleStatus = async (id: number, status: TaskStatus): Promise<void> => {
    await window.zhixing.db.setStatus(id, status)
    await refresh()
  }

  /** 看板各列的「+ 添加」：建一个待办任务后立刻把它挪到该列。 */
  const handleKanbanAdd = async (status: TaskStatus): Promise<void> => {
    const created = await window.zhixing.db.createTask('新任务', null, null)
    if (!created) return
    if (status !== 'todo') await window.zhixing.db.setStatus(created.id, status)
    setEditingId(created.id)
    await refresh()
  }

  const commitAdd = async (): Promise<void> => {
    const title = draftTitle.trim()
    const parentId = adding?.parentId ?? null
    setAdding(null)
    setDraftTitle('')
    if (!title) return
    const created = await window.zhixing.db.createTask(title, parentId)
    if (created) setSelected(created.id)
    await refresh()
  }

  /** 单行渲染：虚拟列表逐行调用，递归渲染也复用它。 */
  const renderRow = (node: TaskNode, depth: number): React.ReactNode => (
    <>
      <TaskRow
          node={node}
          depth={depth}
          selected={selectedIds.has(node.id)}
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
          onSelect={handleSelect}
          onOpenPriority={(id, anchor) => setMenu({ id, anchor })}
          onDragStart={(id) => setDragId(id)}
          onDragOverRow={(id, pos) =>
            setDropHint((prev) => (prev?.id === id && prev.pos === pos ? prev : { id, pos }))
          }
          onDropRow={(id, pos) => void handleDropRow(id, pos)}
          onDragEnd={() => {
            setDragId(null)
            setDropHint(null)
          }}
          dropHint={dropHint?.id === node.id ? dropHint.pos : null}
          onOpenTags={(id, anchor) => {
            const r = anchor.getBoundingClientRect()
            setTagMenu({ id, x: r.left, y: r.bottom + 4 })
          }}
          onContextMenu={(id, x, y) => setCtxMenu({ id, x, y })}
          onTitleCommit={handleTitle}
          onFocus={(id, title) =>
            window.dispatchEvent(
              new CustomEvent('zhixing:pomodoro', { detail: { taskId: id, title } })
            )
          }
          onAddSubtask={(id) => setAdding({ parentId: id })}
          onEdit={setEditingId}
          onDelete={handleDelete}
        />
    </>
  )

  const renderNodes = (nodes: TaskNode[], depth = 0): React.ReactNode =>
    nodes.map((node) => (
      <div key={node.id}>
        {renderRow(node, depth)}
        {!collapsed.has(node.id) && renderNodes(node.children, depth + 1)}
      </div>
    ))

  const renderAddRow = (depth: number): React.ReactNode => (
    <div className="trow trow--adding" style={{ paddingLeft: 12 + depth * 20 }} key="add">
      <span className="trow__caret trow__caret--empty" />
      <span className="check" aria-hidden />
      <input
        ref={addRef}
        className="trow__input"
        placeholder={
          adding?.parentId === null ? '新任务标题，回车创建，Esc 取消' : '新子任务标题，回车创建，Esc 取消'
        }
        value={draftTitle}
        onChange={(e) => setDraftTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commitAdd()
          if (e.key === 'Escape') {
            setAdding(null)
            setDraftTitle('')
          }
        }}
        onBlur={() => {
          if (!draftTitle.trim()) setAdding(null)
        }}
      />
    </div>
  )

  return (
    <div className="page page--tasks">
      <div className="page__head">
        <h1 className="page__title">{t('page.tasks')}</h1>
        <p className="page__subtitle">{t('page.tasks.sub')}</p>
      </div>
      <div className="page__body">

      <div className="tasks-toolbar">
        <div className="seg" role="group" aria-label="视图切换">
          {VIEWS.map((v) => (
            <button key={v.key} aria-pressed={view === v.key} onClick={() => setView(v.key)}>
              {v.label}
            </button>
          ))}
        </div>
        <span className="u-aux">
          共 {tree.length} 项
          {focus ? ` · 聚焦「${focus === 'today' ? '今日待办' : focus === 'done' ? '今日已完成' : '已逾期'}」` : ''}
        </span>
        {focus && onClearFocus && (
          <button className="text-btn" onClick={onClearFocus}>
            清除聚焦
          </button>
        )}
        <div className="tasks-toolbar__right">
          <select
            className="field field--compact"
            value={listKey}
            onChange={(e) => setListKey(e.target.value)}
            aria-label="按清单筛选"
          >
            <option value="">全部清单</option>
            <option value="none">收件箱（未归属）</option>
            {folders
              .filter((f) => f.kind === 'list')
              .map((f) => (
                <option key={f.id} value={String(f.id)}>
                  {f.name}
                </option>
              ))}
          </select>
          <button
            className="text-btn"
            onClick={async () => {
              const name = await dialog.prompt({ title: '新建清单', label: '清单名称' })
              if (!name?.trim()) return
              await window.zhixing.db.createListFolder(name.trim(), 'list', null)
              await load()
              onNotice(`已新建清单「${name.trim()}」`)
            }}
          >
            新建清单
          </button>
          <input
            className="field field--compact"
            placeholder="过滤当前视图…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="过滤任务"
          />
          <button
            className="text-btn"
            disabled={selectedIds.size === 0}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setBatchMenu({ x: r.left, y: r.bottom + 4 })
            }}
          >
            批量{selectedIds.size > 0 ? ` · ${selectedIds.size}` : ''}
          </button>
          <button className="text-btn" aria-pressed={inspector} onClick={() => setInspector((v) => !v)}>
            速览
          </button>
          <button
            className="text-btn text-btn--accent"
            onClick={() => {
              setAdding({ parentId: null })
              setDraftTitle('')
            }}
          >
            <Plus size={14} /> 新建任务
          </button>
        </div>
      </div>

      <div className="tasks-work">
        <div className="tasks-main">
          {view === 'quadrant' ? (
            <QuadrantBoard
              tasks={tasks}
              effective={effective}
              expanded={expanded}
              onToggle={handleToggle}
              onOpen={setEditingId}
              onToggleSubtree={(id) =>
                setExpanded((prev) => {
                  const next = new Set(prev)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
              onChangeQuadrant={(id, key: QuadrantKey) => void handleQuadrant(id, key)}
            />
          ) : view === 'calendar' ? (
            <CalendarBoard
              tasks={tasks}
              effective={effective}
              onOpen={setEditingId}
              onToggle={handleToggle}
              onReschedule={(id, day) => void handleReschedule(id, day)}
            />
          ) : view === 'kanban' ? (
            <KanbanBoard
              tasks={tasks}
              effective={effective}
              expanded={expanded}
              onOpen={setEditingId}
              onToggleSubtree={(id) =>
                setExpanded((prev) => {
                  const next = new Set(prev)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
              onDropStatus={(id, status) => void handleStatus(id, status)}
              onAdd={(status) => void handleKanbanAdd(status)}
            />
          ) : visible.length === 0 && !adding ? (
            <p className="empty-hint">还没有任务，点右上角「+ 新建任务」快速添加。</p>
          ) : (
            <VirtualList
              className="task-vlist"
              count={flatRows.length}
              rowHeight={rowH}
              renderRow={(i) => {
                const row = flatRows[i]
                if (!row) return null
                return row.node === null ? renderAddRow(row.depth) : renderRow(row.node, row.depth)
              }}
            />
          )}
        </div>

        {inspector && (
          <aside className="inspector" aria-label="任务速览">
            {selectedNode ? (
              <>
                <section className="inspector__card">
                  <header className="inspector__head">任务速览 · #{selectedNode.id}</header>
                  <dl className="kv">
                    <dt>标题</dt>
                    <dd>{selectedNode.title}</dd>
                    <dt>状态</dt>
                    <dd>{STATUS_LABELS[selectedNode.status]}</dd>
                    <dt>优先级</dt>
                    <dd>{priorityLabel(selectedNode.priority)}</dd>
                    <dt>截止</dt>
                    <dd>{dueLabel(selectedNode.due_date).text || '—'}</dd>
                    {selectedNode.status === 'waiting' && (
                      <>
                        <dt>等待至</dt>
                        <dd>{(selectedNode as Task & { resume_at?: string }).resume_at ?? '—'}</dd>
                      </>
                    )}
                  </dl>
                </section>
                <section className="inspector__card">
                  <header className="inspector__head">标签</header>
                  {selectedNode.tags.length ? (
                    <div className="chip-row">
                      {selectedNode.tags.map((t) => (
                        <span key={t.id} className="chip chip--tag" style={{ color: t.color, borderColor: t.color }}>
                          {t.name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="u-aux">无标签</p>
                  )}
                </section>
              </>
            ) : (
              <p className="u-aux">选中一个任务查看速览。</p>
            )}
          </aside>
        )}
      </div>

      {editingId != null &&
        (() => {
          const task = tasks.find((t) => t.id === editingId)
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
                await handleDelete(id)
              }}
              onClose={() => setEditingId(null)}
            />
          )
        })()}

      {batchMenu && (
        <PopMenu
          x={batchMenu.x}
          y={batchMenu.y}
          onClose={() => setBatchMenu(null)}
          items={[
            { key: 'done', label: '批量完成', onPick: () => void runBatch('complete') },
            { key: 'due', label: '截止设为今天', onPick: () => void runBatch('due') },
            { key: 'cleardue', label: '清除截止日期', onPick: () => void runBatch('clearDue') },
            { key: 'del', label: '批量删除', danger: true, onPick: () => void runBatch('delete') },
          ]}
        />
      )}

      {tagMenu && (
        <PopMenu
          x={tagMenu.x}
          y={tagMenu.y}
          onClose={() => setTagMenu(null)}
          items={[
            ...allTags.map((t) => ({
              key: `tag-${t.id}`,
              label: t.name,
              checked: (tags.get(tagMenu.id) ?? []).some((x) => x.id === t.id),
              onPick: () => void handleToggleTag(tagMenu.id, t.name),
            })),
            { key: 'tag-new', label: '＋ 新建标签…', onPick: () => void handleCreateTag(tagMenu.id) },
          ]}
        />
      )}

      {ctxMenu && (
        <PopMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={
            [
              { key: 'toggle', label: '完成 / 取消完成', onPick: () => void handleToggle(ctxMenu.id) },
              { key: 'edit', label: '编辑…', onPick: () => setEditingId(ctxMenu.id) },
              { key: 'sub', label: '加子任务', onPick: () => setAdding({ parentId: ctxMenu.id }) },
              { key: 'up', label: '上移一级', onPick: () => void handleMoveRelative(ctxMenu.id, -1) },
              { key: 'down', label: '下移一级', onPick: () => void handleMoveRelative(ctxMenu.id, 1) },
              {
                key: 'tag',
                label: '编辑标签…',
                onPick: () => setTagMenu({ id: ctxMenu.id, x: ctxMenu.x, y: ctxMenu.y }),
              },
              { key: 'del', label: '删除', danger: true, onPick: () => void handleDelete(ctxMenu.id) },
            ] satisfies PopMenuItem[]
          }
        />
      )}

      {menu && (
        <PriorityMenu anchor={menu.anchor} current={tasks.find((t) => t.id === menu.id)?.priority ?? 0} onPick={handlePriority} onClose={() => setMenu(null)} />
      )}
      </div>
    </div>
  )
}
