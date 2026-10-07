import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from '@renderer/lib/icons'
import { priorityColor } from '@shared/priority'
import { isTerminal } from '@shared/task'
import type { Task } from '@shared/types'
import { dueLabel, monthGrid } from '../lib/date'
import {
  groupTasksByDate,
  weekdayLabels,
  type CalendarNoDate,
  type CalendarSpanMode,
  type WeekStart,
} from '@shared/calendar'

interface Props {
  tasks: Task[]
  effective: Map<number, boolean>
  onOpen: (id: number) => void
  onToggle: (id: number) => void
  onReschedule: (id: number, day: string) => void
  /** 日历是否显示已完成任务（settings.calendar_show_done，默认 false） */
  showDone: boolean
  /** 展开口径：区间 / 只按截止 / 只按开始（settings.calendar_span_mode） */
  spanMode: CalendarSpanMode
  /** 两个日期都没有的任务：归今日 / 不显示（settings.calendar_no_date） */
  noDate: CalendarNoDate
  /** 周起始日（settings.calendar_week_start） */
  weekStart: WeekStart
}

/** 表头跟随周起始（weekdayLabels 与 monthGrid 的列序是同一份约定） */
const WEEKDAYS = (weekStart: WeekStart): string[] => weekdayLabels(weekStart)
const MAX_PILLS = 3


/** 月历 + 右侧当日任务清单；任务胶囊可拖到另一天改期。 */
export function CalendarBoard({
  tasks,
  effective,
  onOpen,
  onToggle,
  onReschedule,
  showDone,
  spanMode,
  noDate,
  weekStart,
}: Props) {
  const today = new Date().toLocaleDateString('sv-SE')
  const [cursor, setCursor] = useState(() => {
    const d = new Date()
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() }
  })
  const [selected, setSelected] = useState(today)
  const [dragId, setDragId] = useState<number | null>(null)
  const [dropDay, setDropDay] = useState<string | null>(null)

  const isDone = (t: Task): boolean =>
    effective.get(t.id) ?? isTerminal(t.status)

  // 已完成过滤：开关关（默认 false）才隐去有效完成
  const visible = useMemo(
    () => (showDone ? tasks : tasks.filter((t) => !isDone(t))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, showDone, effective]
  )
  const byDay = useMemo(
    () => groupTasksByDate(visible, today, { spanMode, noDate }),
    [visible, today, spanMode, noDate]
  )

  const cells = useMemo(() => monthGrid(cursor.y, cursor.m, weekStart), [cursor, weekStart])
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
          {WEEKDAYS(weekStart).map((w) => (
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
