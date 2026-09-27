import { useState } from 'react'
import { isMotionFull } from '../lib/presence'
import { Plus } from '@renderer/lib/icons'
import { priorityColor, priorityLabel } from '@shared/priority'
import { STATUS_CHOICES, isTerminal } from '@shared/task'
import type { Task, TaskStatus } from '@shared/types'
import { dueLabel } from '../lib/date'

interface Props {
  tasks: Task[]
  effective: Map<number, boolean>
  expanded: Set<number>
  onOpen: (id: number) => void
  onToggleSubtree: (id: number) => void
  onDropStatus: (id: number, status: TaskStatus) => void
  onAdd: (status: TaskStatus) => void
}

/**
 * 看板：列 = 状态，卡片 = **根任务**（列头计数也只算根任务）。
 * 展开的父任务把未完成子任务以缩进卡片列在其下方，仅作展示、不做状态级联。
 */
export function KanbanBoard({ tasks, effective, expanded, onOpen, onToggleSubtree, onDropStatus, onAdd }: Props) {
  const [dragId, setDragId] = useState<number | null>(null)
  const [hoverCol, setHoverCol] = useState<TaskStatus | null>(null)
  /** 刚落位的卡片：播一次回弹，animationend 时摘掉（不排定时器） */
  const [landedId, setLandedId] = useState<number | null>(null)

  const isDone = (t: Task): boolean =>
    effective.get(t.id) ?? isTerminal(t.status)

  const childrenOf = (id: number): Task[] => tasks.filter((t) => t.parent_id === id && !isDone(t))
  const roots = tasks.filter((t) => t.parent_id === null)

  const renderCard = (t: Task, depth: number): React.ReactNode => {
    const kids = childrenOf(t.id)
    const isOpen = expanded.has(t.id)
    const due = dueLabel(t.due_date)
    return (
      <div key={t.id}>
        <div
          className={
            'kcard' +
            (dragId === t.id ? ' kcard--dragging' : '') +
            (landedId === t.id ? ' kcard--landed' : '')
          }
          style={{ marginLeft: depth * 14 }}
          draggable
          onDragStart={(e) => {
            setDragId(t.id)
            e.dataTransfer.setData('text/plain', String(t.id))
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragEnd={() => setDragId(null)}
          // 回弹播完就摘类：动效关掉时不会走到这里（那时压根不挂类）
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) setLandedId((v) => (v === t.id ? null : v))
          }}
          onDoubleClick={() => onOpen(t.id)}
        >
          <div className="kcard__top">
            <span className="prio" style={{ background: priorityColor(t.priority) }} title={priorityLabel(t.priority)} />
            <span className={`kcard__title` + (isDone(t) ? ' kcard__title--done' : '')}>{t.title}</span>
            {kids.length > 0 && (
              <button
                className="chip chip--sub"
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleSubtree(t.id)
                }}
                aria-expanded={isOpen}
              >
                {kids.length} 子
              </button>
            )}
          </div>
          {due.text && (
            <div className="kcard__meta">
              <span className={'chip' + (due.tone === 'overdue' ? ' chip--danger' : '')}>{due.text}</span>
            </div>
          )}
        </div>
        {isOpen && kids.map((k) => renderCard(k, depth + 1))}
      </div>
    )
  }

  return (
    <div className="kboard">
      {STATUS_CHOICES.map((col) => {
        const colRoots = roots.filter((t) => t.status === col.value)
        return (
          <section
            key={col.value}
            className={'kcol' + (hoverCol === col.value ? ' kcol--drop' : '')}
            onDragOver={(e) => {
              if (dragId === null) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setHoverCol(col.value)
            }}
            onDragLeave={() => setHoverCol((c) => (c === col.value ? null : c))}
            onDrop={(e) => {
              e.preventDefault()
              const id = Number(e.dataTransfer.getData('text/plain') || dragId)
              setHoverCol(null)
              setDragId(null)
              if (Number.isFinite(id) && id > 0) {
                // 落位回弹：动效档位用 presence.ts 的判据（full 档的 data-motion 是空串）
                if (isMotionFull()) setLandedId(id)
                onDropStatus(id, col.value)
              }
            }}
          >
            <header className="kcol__head">
              {col.label}
              <span className="u-aux">{colRoots.length}</span>
            </header>
            <div className="kcol__body">
              {colRoots.length === 0 && <p className="u-aux kcol__empty">拖卡片到这里</p>}
              {colRoots.map((t) => renderCard(t, 0))}
            </div>
            <button className="kcol__add" onClick={() => onAdd(col.value)}>
              <Plus size={13} /> 添加
            </button>
          </section>
        )
      })}
    </div>
  )
}
