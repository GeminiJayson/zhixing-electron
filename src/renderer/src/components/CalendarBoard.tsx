import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from '@renderer/lib/icons'
import { priorityColor } from '@shared/priority'
import { isTerminal } from '@shared/task'
import type { Task } from '@shared/types'
import { dueLabel, monthGrid, pad2 } from '../lib/date'

interface Props {
  tasks: Task[]
  effective: Map<number, boolean>
  onOpen: (id: number) => void
  onToggle: (id: number) => void
  onReschedule: (id: number, day: string) => void
  /** 日历是否显示已完成任务（settings.calendar_show_done，默认 false） */
  showDone: boolean
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
const MAX_PILLS = 3

const pad = pad2

/**
 * 任务按日期归类：
 * - 开始+截止：区间内每一天都显示（含两端，逐日展开，防御性上限约 10 年）；
 * - 仅截止：截止当天；仅开始：开始当天；无日期：归入「今日」；
 * - 每日内按 (-priority, sort_key, id) 升序。
 */
export function groupTasksByDate(tasks: Task[], today: string): Map<string, Task[]> {
  const out = new Map<string, Task[]>()
  const push = (day: string, t: Task): void => {
    const list = out.get(day) ?? []
    list.push(t)
    out.set(day, list)
  }
  const addDays = (day: string, n: number): string => {
    const d = new Date(day + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + n)
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  }
  const MAX_SPAN_DAYS = 3660
  for (const t of tasks) {
    if (t.start_date && t.due_date) {
      let lo = t.start_date
      let hi = t.due_date
      if (lo > hi) [lo, hi] = [hi, lo]
      const span = Math.round((Date.parse(hi) - Date.parse(lo)) / 86_400_000)
      if (span > MAX_SPAN_DAYS) hi = addDays(lo, MAX_SPAN_DAYS)
      let cur = lo
      while (cur <= hi) {
        push(cur, t)
        cur = addDays(cur, 1)
      }
    } else if (t.due_date) {
      push(t.due_date, t)
    } else if (t.start_date) {
      push(t.start_date, t)
    } else {
      push(today, t)
    }
  }
  for (const list of out.values()) {
    list.sort((a, b) => b.priority - a.priority || a.sort_key - b.sort_key || a.id - b.id)
  }
  return out
}

/** 月历 + 右侧当日任务清单；任务胶囊可拖到另一天改期。 */
export function CalendarBoard({ tasks, effective, onOpen, onToggle, onReschedule, showDone }: Props) {
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
  const byDay = useMemo(() => groupTasksByDate(visible, today), [visible, today])

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
