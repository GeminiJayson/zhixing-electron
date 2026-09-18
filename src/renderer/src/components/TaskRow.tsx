import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { priorityColor, priorityLabel } from '@shared/priority'
import type { TaskNode } from '@shared/task'
import { dueLabel, rangeLabel } from '../lib/date'

interface Props {
  node: TaskNode
  depth: number
  selected: boolean
  collapsed: boolean
  onToggle: (id: number) => void
  onToggleCollapse: (id: number) => void
  onSelect: (id: number, e: React.MouseEvent) => void
  onOpenPriority: (id: number, anchor: HTMLElement) => void
  onOpenTags: (id: number, anchor: HTMLElement) => void
  onContextMenu: (id: number, x: number, y: number) => void
  /** 拖拽排序 / 改挂父子（列表视图） */
  onDragStart: (id: number) => void
  onDragOverRow: (id: number, pos: 'before' | 'after' | 'child') => void
  onDropRow: (id: number, pos: 'before' | 'after' | 'child') => void
  onDragEnd: () => void
  dropHint: 'before' | 'after' | 'child' | null
  onTitleCommit: (id: number, title: string) => void
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
  const due = dueLabel(node.due_date)
  const range = rangeLabel(node.start_date, node.due_date)

  const commit = (): void => {
    setEditing(false)
    if (draft.trim() && draft !== node.title) props.onTitleCommit(node.id, draft)
    else setDraft(node.title)
  }

  return (
    <div
      className={`trow${selected ? ' trow--selected' : ''}${node.effectiveDone ? ' trow--done' : ''}${props.dropHint ? ` trow--drop-${props.dropHint}` : ''}`}
      style={{ paddingLeft: 12 + depth * 20 }}
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
        {hasChildren && <ChevronRight size={14} className={collapsed ? '' : 'trow__caret--open'} />}
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

      {node.repeat_period !== 'none' && (
        <span className="chip" title={`循环：${node.repeat_period}`}>
          {node.repeat_period === 'daily' ? '每日' : node.repeat_period === 'weekly' ? '每周' : node.repeat_period === 'monthly' ? '每月' : '自定义'}
        </span>
      )}
      {node.streak > 0 && <span className="chip chip--streak">🔥{node.streak}</span>}
      {range && <span className={`chip${due.tone === 'overdue' ? ' chip--danger' : ''}`}>{range}</span>}
      {node.tags.map((tag) => (
        <button
          key={tag.id}
          className="chip chip--tag"
          style={{ color: tag.color, borderColor: tag.color }}
          title="点击增删标签"
          onClick={(e) => {
            e.stopPropagation()
            props.onOpenTags(node.id, e.currentTarget)
          }}
        >
          {tag.name}
        </button>
      ))}
      {node.noteCount > 0 && <span className="chip">⇄{node.noteCount}</span>}

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
    </div>
  )
}
