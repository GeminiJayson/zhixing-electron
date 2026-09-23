import { useEffect, useRef, useState } from 'react'
import { Morph, IconData, Pencil, Play, Plus, Trash2 } from '@renderer/lib/icons'
import { priorityColor, priorityLabel } from '@shared/priority'
import type { TaskNode } from '@shared/task'
import { STATUS_LABELS, STATUS_TONES } from '@shared/task'
import { inkOn } from '@shared/color'
import { dueLabel, rangeLabel, taskProgress } from '../lib/date'

interface Props {
  node: TaskNode
  depth: number
  selected: boolean
  collapsed: boolean
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
      className={`trow${selected ? ' trow--selected' : ''}${node.effectiveDone ? ' trow--done' : ''}${props.dropHint ? ` trow--drop-${props.dropHint}` : ''}`}
      // --row-indent 供进度条定位用：它要跟内容一起缩进（见 tasks.css 的 .trow__progress）
      style={{ paddingLeft: 12 + depth * 20, '--row-indent': `${12 + depth * 20}px` } as React.CSSProperties}
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

      <button
        className={`check${node.effectiveDone ? ' check--done' : ''}`}
        onClick={() => props.onToggle(node.id)}
        aria-label={node.effectiveDone ? `取消完成：${node.title}` : `完成任务：${node.title}`}
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
          {node.title}
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
            style={{ background: tag.color, borderColor: tag.color, color: inkOn(tag.color) }}
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
