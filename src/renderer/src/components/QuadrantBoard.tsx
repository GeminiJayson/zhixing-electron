import { useState } from 'react'
import { priorityColor, priorityLabel, isImportant } from '@shared/priority'
import { isTerminal } from '@shared/task'
import type { Task } from '@shared/types'
import { dueLabel } from '../lib/date'

export type QuadrantKey = 'q1' | 'q2' | 'q3' | 'q4'

const BOXES: { key: QuadrantKey; label: string }[] = [
  { key: 'q1', label: '重要且紧急' },
  { key: 'q2', label: '重要不紧急' },
  { key: 'q3', label: '紧急不重要' },
  { key: 'q4', label: '不重要不紧急' },
]

/** 换象限时写入的 priority + due_date。 */
export function quadrantAssignment(key: QuadrantKey, today: string): {
  priority: number
  due_date: string | null
} {
  switch (key) {
    case 'q1':
      return { priority: 8, due_date: today }
    case 'q2':
      return { priority: 8, due_date: null }
    case 'q3':
      return { priority: 2, due_date: today }
    default:
      return { priority: 2, due_date: null }
  }
}

interface Props {
  tasks: Task[]
  effective: Map<number, boolean>
  expanded: Set<number>
  onToggle: (id: number) => void
  onOpen: (id: number) => void
  onToggleSubtree: (id: number) => void
  onChangeQuadrant: (id: number, key: QuadrantKey) => void
}

/**
 * 重要 × 紧急四象限。只有根任务归格；父行可展开出**未完成的直接子任务**，
 * 子任务自身的优先级/日期不参与归格。
 */
export function QuadrantBoard({
  tasks,
  effective,
  expanded,
  onToggle,
  onOpen,
  onToggleSubtree,
  onChangeQuadrant,
}: Props) {
  const [dragId, setDragId] = useState<number | null>(null)
  const [hover, setHover] = useState<QuadrantKey | null>(null)
  const today = new Date().toLocaleDateString('sv-SE')

  const isDone = (t: Task): boolean => effective.get(t.id) ?? isTerminal(t.status)

  const byId = new Map(tasks.map((t) => [t.id, t]))
  const childrenOf = (id: number): Task[] =>
    tasks.filter((t) => t.parent_id === id && !isDone(t))

  const bucket = (t: Task): QuadrantKey => {
    const important = isImportant(t.priority)
    const urgent = t.due_date !== null && t.due_date <= today
    if (important && urgent) return 'q1'
    if (important) return 'q2'
    if (urgent) return 'q3'
    return 'q4'
  }

  const roots = tasks.filter((t) => t.parent_id === null && !isDone(t))

  const renderRow = (t: Task, depth: number): React.ReactNode => {
    const kids = childrenOf(t.id)
    const isOpen = expanded.has(t.id)
    const due = dueLabel(t.due_date)
    return (
      <div key={t.id}>
        <div
          className="qrow"
          style={{ paddingLeft: 6 + depth * 16 }}
          draggable
          onDragStart={(e) => {
            setDragId(t.id)
            e.dataTransfer.setData('text/plain', String(t.id))
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragEnd={() => setDragId(null)}
        >
          <button
            className={`check${isDone(t) ? ' check--done' : ''}`}
            onClick={() => onToggle(t.id)}
            aria-label={isDone(t) ? `取消完成：${t.title}` : `完成任务：${t.title}`}
          />
          <span className="prio" style={{ background: priorityColor(t.priority) }} title={priorityLabel(t.priority)} />
          <button className="qrow__title" onClick={() => onOpen(t.id)} title={t.title}>
            {t.title}
          </button>
          {kids.length > 0 && (
            <button
              className="chip chip--sub"
              onClick={() => onToggleSubtree(t.id)}
              aria-expanded={isOpen}
              title={isOpen ? '收起子任务' : '展开子任务'}
            >
              {kids.length} 子
            </button>
          )}
          {due.text && <span className={`chip${due.tone === 'overdue' ? ' chip--danger' : ''}`}>{due.text}</span>}
        </div>
        {isOpen && kids.map((k) => renderRow(k, depth + 1))}
      </div>
    )
  }

  return (
    <div className="quad-grid">
      {BOXES.map((box) => {
        const items = roots.filter((t) => bucket(t) === box.key)
        return (
          <section
            key={box.key}
            className={`quad-box${hover === box.key ? ' quad-box--drop' : ''}`}
            onDragOver={(e) => {
              if (dragId === null) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setHover(box.key)
            }}
            onDragLeave={() => setHover((h) => (h === box.key ? null : h))}
            onDrop={(e) => {
              e.preventDefault()
              const raw = e.dataTransfer.getData('text/plain')
              const id = Number(raw || dragId)
              setHover(null)
              setDragId(null)
              if (Number.isFinite(id) && id > 0) onChangeQuadrant(id, box.key)
            }}
          >
            <header className="quad-box__head">
              {box.label}
              <span className="u-aux">{items.length}</span>
            </header>
            <div className="quad-box__body">
              {items.length === 0 ? (
                <p className="u-aux quad-box__empty">拖任务到这里</p>
              ) : (
                items.map((t) => renderRow(t, 0))
              )}
            </div>
          </section>
        )
      })}
      {/* byId 仅用于类型收敛，避免未使用告警 */}
      <span hidden>{byId.size}</span>
    </div>
  )
}
