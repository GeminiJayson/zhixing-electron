import { useEffect, useRef, useState } from 'react'
import { Morph, IconData, Pencil, Play, Plus, Trash2 } from '@renderer/lib/icons'
import { priorityColor, priorityLabel } from '@shared/priority'
import type { TaskNode } from '@shared/task'
import { STATUS_LABELS, STATUS_TONES } from '@shared/task'
import { doneAtLabel, dueLabel, rangeLabel, taskProgress } from '../lib/date'

interface Props {
  node: TaskNode
  depth: number
  selected: boolean
  collapsed: boolean
  /**
   * 「本次新建」的行：挂 .trow--enter 播一次入场动画。
   * 滚动进视口的行永远不传这个 —— 那是滚动，不是新增。
   */
  entering?: boolean
  /** 同批新增行在展平顺序里的交错序号，映射到行内 --i（由 CSS 算成 animation-delay） */
  enterIndex?: number
  /**
   * 共享元素过渡（试点）：这一行是本次「行 → 编辑弹窗」的源，
   * 挂 .trow--vt-source 拿到 view-transition-name（见 tasks.css）。
   * 同一时刻最多只能有一行带它 —— 重名会让浏览器直接跳过整条过渡。
   */
  vtSource?: boolean
  onToggle: (id: number) => void
  onToggleCollapse: (id: number) => void
  onSelect: (id: number, e: React.MouseEvent) => void
  onOpenPriority: (id: number, anchor: HTMLElement) => void
  onOpenStatus: (id: number, anchor: HTMLElement) => void
  onOpenTags: (id: number, anchor: HTMLElement) => void
  onContextMenu: (id: number, x: number, y: number) => void
  /** 拖拽排序 / 改挂父子（列表视图） */
  onDragStart: (id: number) => void
  onDragOverRow: (id: number, pos: 'before' | 'after' | 'child') => void
  onDropRow: (id: number, pos: 'before' | 'after' | 'child') => void
  onDragEnd: () => void
  dropHint: 'before' | 'after' | 'child' | null
  onTitleCommit: (id: number, title: string) => void
  /**
   * 所属清单名。只在「已完成 / 已放弃」这类跨清单视图里传 ——
   * 终态任务被收归之后，用户仍要能看出它原来属于哪个清单。
   */
  listName?: string
  /**
   * 是否处于「已完成」视图。「已完成」是按 roll-up 收归的：父任务可能自身还是
   * todo，但子任务全完成了 —— 此时状态胶囊若仍读自身 status，已完成清单里就会
   * 写着一排「待办」。这个开关让胶囊在这一个视图里统一读有效完成态。
   */
  doneView?: boolean
  onAddSubtask: (id: number) => void
  onFocus: (id: number, title: string) => void
  onEdit: (id: number) => void
  onDelete: (id: number) => void
}

/** 任务树的一行：展开箭头 · 勾选圆圈 · 优先级旗 · 标题 · chips · 悬浮操作。 */
export function TaskRow(props: Props) {
  const { node, depth, selected, collapsed } = props
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  useEffect(() => {
    setDraft(node.title)
  }, [node.title])

  const hasChildren = node.children.length > 0
  // 「已完成」视图里的行必然是有效完成：胶囊跟着它走，字与勾选圈就不会互相打架
  const statusLabel = props.doneView && node.effectiveDone ? '已完成' : STATUS_LABELS[node.status]
  const statusTone = props.doneView && node.effectiveDone ? 'success' : STATUS_TONES[node.status]
  const due = dueLabel(node.due_date)
  const range = rangeLabel(node.start_date, node.due_date)
  // 时间进度：缺了开始或截止就没有「进度」可言（见 taskProgress 的注释）
  const progress = taskProgress(
    node.start_date,
    node.start_time,
    node.due_date,
    node.due_time,
    node.effectiveDone
  )

  const commit = (): void => {
    setEditing(false)
    if (draft.trim() && draft !== node.title) props.onTitleCommit(node.id, draft)
    else setDraft(node.title)
  }

  return (
    <div
      className={`trow${selected ? ' trow--selected' : ''}${node.effectiveDone ? ' trow--done' : ''}${
        // 逾期：标题跟着那枚日期胶囊一起变红（同一个 --danger）。已完成的行不染。
        due.tone === 'overdue' && !node.effectiveDone ? ' trow--overdue' : ''
      }${props.dropHint ? ` trow--drop-${props.dropHint}` : ''}${props.entering ? ' trow--enter' : ''}${props.vtSource ? ' trow--vt-source' : ''}`}
      // --row-indent 供进度条定位用：它要跟内容一起缩进（见 tasks.css 的 .trow__progress）
      // --i：交错入场的序号，只给正在入场的行写（见 tasks.css 的 .trow--enter）
      style={
        {
          paddingLeft: 12 + depth * 20,
          '--row-indent': `${12 + depth * 20}px`,
          ...(props.entering ? { '--i': props.enterIndex ?? 0 } : {}),
        } as React.CSSProperties
      }
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(node.id))
        e.dataTransfer.effectAllowed = 'move'
        props.onDragStart(node.id)
      }}
      onDragEnd={() => props.onDragEnd()}
      onDragOver={(e) => {
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        const ratio = (e.clientY - r.top) / r.height
        // 上下边缘 25% 作为排序落点，中间作为「成为子任务」
        props.onDragOverRow(node.id, ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'child')
      }}
      onDrop={(e) => {
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        const ratio = (e.clientY - r.top) / r.height
        props.onDropRow(node.id, ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'child')
      }}
      onMouseDown={(e) => props.onSelect(node.id, e)}
      onContextMenu={(e) => {
        e.preventDefault()
        // 右键不改变多选集合，只把它设为右键目标（未选中时单选到它）
        if (!selected) props.onSelect(node.id, e)
        props.onContextMenu(node.id, e.clientX, e.clientY)
      }}
    >
      <button
        className={`trow__caret${hasChildren ? '' : ' trow__caret--empty'}`}
        onClick={() => hasChildren && props.onToggleCollapse(node.id)}
        aria-label={collapsed ? '展开子任务' : '折叠子任务'}
        aria-expanded={hasChildren ? !collapsed : undefined}
        tabIndex={hasChildren ? 0 : -1}
      >
        {hasChildren && (
          <Morph icon={collapsed ? IconData.ChevronRight : IconData.ChevronDown} size={14} />
        )}
      </button>

      {/* 已放弃单独一档：它的底色与行上那枚「已放弃」胶囊同色（都是 --danger）。
          此前只有"完成 / 未完成"两态，放弃的任务顶着和完成一样的强调色勾选框，
          与胶囊的颜色对不上。 */}
      <button
        className={`check${node.effectiveDone ? ' check--done' : ''}${node.status === 'abandoned' ? ' check--abandoned' : ''}`}
        onClick={() => props.onToggle(node.id)}
        aria-label={
          node.status === 'abandoned'
            ? `取消放弃：${node.title}`
            : node.effectiveDone
              ? `取消完成：${node.title}`
              : `完成任务：${node.title}`
        }
      />

      <button
        className="flag"
        style={{ color: priorityColor(node.priority) }}
        onClick={(e) => props.onOpenPriority(node.id, e.currentTarget)}
        title={`优先级：${priorityLabel(node.priority)}`}
        aria-label={`优先级 ${priorityLabel(node.priority)}，点击修改`}
      >
        <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden>
          <path
            d="M1.5 1v12"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
          <path d="M1.5 1.6h8.2l-1.9 2.6 1.9 2.6H1.5z" fill="currentColor" />
        </svg>
      </button>

      {editing ? (
        <input
          ref={inputRef}
          className="trow__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setDraft(node.title)
              setEditing(false)
            }
          }}
        />
      ) : (
        <span
          className="trow__title"
          onDoubleClick={() => setEditing(true)}
          title={node.notes_md ? node.notes_md.slice(0, 60) : node.title}
        >
          {/* 删除线的载体：伪元素挂在行内元素上时，containing block 是这行文字的
              包围盒，线宽才等于文字宽度（挂在外层弹性盒上会横跨整行）。 */}
          <span className="trow__title-text">{node.title}</span>
        </span>
      )}

      {/* 胶囊统一包在一个容器里：悬浮时按钮组浮现，容器整体左移让位（见 tasks.css） */}
      <span className="trow__chips">
        {/* 状态胶囊放最前：它是这一行最该先看到的信息。点它直接改状态，不必开编辑弹窗 */}
        <button
          type="button"
          className={`chip chip--status chip--status-${statusTone}`}
          title={`状态：${statusLabel}（点击修改）`}
          onClick={(e) => {
            e.stopPropagation()
            props.onOpenStatus(node.id, e.currentTarget)
          }}
        >
          {statusLabel}
        </button>
        {node.repeat_period !== 'none' && (
          <span className="chip" title={`循环：${node.repeat_period}`}>
            {node.repeat_period === 'daily' ? '每日' : node.repeat_period === 'weekly' ? '每周' : node.repeat_period === 'monthly' ? '每月' : '自定义'}
          </span>
        )}
        {node.streak > 0 && <span className="chip chip--streak">🔥{node.streak}</span>}
        {/*
          完成时间：只在终态行上出现。
          循环任务每天勾选一次、一天攒好几条，光看「已完成」分不出先后 ——
          时刻是这里最有用的线索，所以标题里给完整的日期时间，胶囊上给短标记。
        */}
        {node.effectiveDone && node.completed_at && (
          <span className="chip chip--done-at" title={`完成于 ${node.completed_at}`}>
            {doneAtLabel(node.completed_at)}
          </span>
        )}
        {range && <span className={`chip${due.tone === 'overdue' ? ' chip--danger' : ''}`}>{range}</span>}
        {props.listName && (
          <span className="chip chip--list" title={`所属清单：${props.listName}`}>
            {props.listName}
          </span>
        )}
        {node.tags.map((tag) => (
          <button
            key={tag.id}
            className="chip chip--tag"
            // 实心胶囊 + 明暗翻转的文字色：标签颜色由用户自定，浅色与深色都要看得见
            style={{ '--tag-color': tag.color } as React.CSSProperties}
            title="点击增删标签或改颜色"
            onClick={(e) => {
              e.stopPropagation()
              props.onOpenTags(node.id, e.currentTarget)
            }}
          >
            {tag.name}
          </button>
        ))}
        {node.noteCount > 0 && <span className="chip">⇄{node.noteCount}</span>}
      </span>

      <span className="trow__actions">
        <button
          className="icon-btn"
          onClick={() => props.onFocus(node.id, node.title)}
          title="开始专注"
          aria-label="开始专注"
        >
          <Play size={14} />
        </button>
        <button className="icon-btn" onClick={() => props.onAddSubtask(node.id)} title="加子任务" aria-label="加子任务">
          <Plus size={14} />
        </button>
        <button className="icon-btn" onClick={() => props.onEdit(node.id)} title="编辑" aria-label="编辑任务">
          <Pencil size={14} />
        </button>
        <button
          className="icon-btn icon-btn--danger"
          onClick={() => props.onDelete(node.id)}
          title="删除"
          aria-label="删除任务"
        >
          <Trash2 size={14} />
        </button>
      </span>

      {/* 时间进度条：贴在行底的一道细线，颜色就是紧迫度的色阶（从容绿 → 临近橙 → 过点红）。
          已完成的不画 —— 那一行本身已经灰掉了，再叠一条满格进度只是噪音。 */}
      {progress && !node.effectiveDone && (
        <span
          className={`trow__progress trow__progress--${progress.tone}`}
          title={`${progress.label} · ${Math.round(progress.ratio * 100)}%`}
          aria-hidden
        >
          <i style={{ width: `${Math.min(100, Math.max(0, progress.ratio * 100))}%` }} />
        </span>
      )}
    </div>
  )
}
