import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { priorityColor } from '@shared/priority'
import type { Task } from '@shared/types'
import { dueLabel } from '../lib/date'

interface Props {
  tasks: Task[]
  effective: Map<number, boolean>
  onOpen: (id: number) => void
  onToggle: (id: number) => void
  onReschedule: (id: number, day: string) => void
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
const MAX_PILLS = 3

const pad = (n: number): string => String(n).padStart(2, '0')

/** 生成 6×7 的月份网格（周一为第一列，与 QCalendarWidget 的周首一致）。 */
function monthGrid(year: number, month0: number): { day: string; inMonth: boolean }[] {
  const first = new Date(Date.UTC(year, month0, 1))
  const offset = (first.getUTCDay() + 6) % 7 // 周一=0
  const cells: { day: string; inMonth: boolean }[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(Date.UTC(year, month0, 1 - offset + i))
    cells.push({
      day: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
      inMonth: d.getUTCMonth() === month0,
    })
  }
  return cells
}

/** 月历 + 右侧当日任务清单；任务胶囊可拖到另一天改期（对齐 CalendarTaskView）。 */
export function CalendarBoard({ tasks, effective, onOpen, onToggle, onReschedule }: Props) {
  const today = new Date().toLocaleDateString('sv-SE')
  const [cursor, setCursor] = useState(() => {
    const d = new Date()
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() }
  })
  const [selected, setSelected] = useState(today)
  const [dragId, setDragId] = useState<number | null>(null)
  const [dropDay, setDropDay] = useState<string | null>(null)

  const isDone = (t: Task): boolean =>
    effective.get(t.id) ?? (t.status === 'done' || t.status === 'abandoned')

  const byDay = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const t of tasks) {
      if (!t.due_date || isDone(t)) continue
      const list = map.get(t.due_date) ?? []
      list.push(t)
      map.set(t.due_date, list)
    }
    return map
  }, [tasks, effective])

  const cells = useMemo(() => monthGrid(cursor.y, cursor.m), [cursor])
  const dayTasks = byDay.get(selected) ?? []

  const shift = (delta: number): void => {
    const d = new Date(Date.UTC(cursor.y, cursor.m + delta, 1))
    setCursor({ y: d.getUTCFullYear(), m: d.getUTCMonth() })
  }

  const pill = (t: Task): React.ReactNode => (
    <button
      key={t.id}
      className="cal-pill"
      draggable
      onDragStart={(e) => {
        setDragId(t.id)
        e.dataTransfer.setData('text/plain', String(t.id))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => setDragId(null)}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(t.id)
      }}
      title={`${t.title} · P${t.priority}`}
    >
      <span className="cal-pill__dot" style={{ background: priorityColor(t.priority) }} />
      <span className="cal-pill__text">{t.title}</span>
    </button>
  )

  return (
    <div className="cal-wrap">
      <div className="cal">
        <header className="cal__head">
          <button className="icon-btn" onClick={() => shift(-1)} aria-label="上个月">
            <ChevronLeft size={16} />
          </button>
          <span className="cal__title">
            {cursor.y} 年 {cursor.m + 1} 月
          </span>
          <button className="icon-btn" onClick={() => shift(1)} aria-label="下个月">
            <ChevronRight size={16} />
          </button>
          <button
            className="text-btn"
            onClick={() => {
              const d = new Date()
              setCursor({ y: d.getUTCFullYear(), m: d.getUTCMonth() })
              setSelected(today)
            }}
          >
            今天
          </button>
        </header>

        <div className="cal__weekdays">
          {WEEKDAYS.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>

        <div className="cal__grid">
          {cells.map((c) => {
            const items = byDay.get(c.day) ?? []
            const shown = items.slice(0, MAX_PILLS)
            return (
              <div
                key={c.day}
                className={[
                  'cal__cell',
                  c.inMonth ? '' : 'cal__cell--out',
                  c.day === today ? 'cal__cell--today' : '',
                  c.day === selected ? 'cal__cell--selected' : '',
                  dropDay === c.day ? 'cal__cell--drop' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => setSelected(c.day)}
                onDragOver={(e) => {
                  if (dragId === null) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setDropDay(c.day)
                }}
                onDragLeave={() => setDropDay((d) => (d === c.day ? null : d))}
                onDrop={(e) => {
                  e.preventDefault()
                  const id = Number(e.dataTransfer.getData('text/plain') || dragId)
                  setDropDay(null)
                  setDragId(null)
                  if (Number.isFinite(id) && id > 0) onReschedule(id, c.day)
                }}
              >
                <span className="cal__daynum">{Number(c.day.slice(-2))}</span>
                <div className="cal__pills">
                  {shown.map(pill)}
                  {items.length > MAX_PILLS && (
                    <span className="cal__more">+{items.length - MAX_PILLS}</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <aside className="cal-side" aria-label="当日任务">
        <header className="cal-side__head">
          {selected}
          <span className="u-aux">{dayTasks.length} 项</span>
        </header>
        {dayTasks.length === 0 ? (
          <p className="u-aux">这一天没有任务。拖一个任务胶囊到日期格即可改期。</p>
        ) : (
          <ul className="cal-side__list">
            {dayTasks.map((t) => (
              <li key={t.id} className="cal-side__row">
                <button
                  className={`check${isDone(t) ? ' check--done' : ''}`}
                  onClick={() => onToggle(t.id)}
                  aria-label={`完成任务：${t.title}`}
                />
                <span className="prio" style={{ background: priorityColor(t.priority) }} />
                <button className="cal-side__title" onClick={() => onOpen(t.id)}>
                  {t.title}
                </button>
                <span className="u-aux">{dueLabel(t.due_date).text}</span>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  )
}
