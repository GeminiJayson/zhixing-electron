/** 截止日期的展示语义，今日页与任务页共用。 */

export interface DueLabel {
  text: string
  tone: 'overdue' | 'today' | 'soon' | 'none'
}

export function dueLabel(due: string | null): DueLabel {
  if (!due) return { text: '', tone: 'none' }
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const target = new Date(`${due}T00:00:00`)
  if (Number.isNaN(target.getTime())) return { text: due, tone: 'none' }
  const days = Math.round((target.getTime() - start.getTime()) / 86_400_000)
  // 数据里存在哨兵日期（如 1753-09-14），原版直接显示该日期；换算成天数会产生荒谬值
  if (Math.abs(days) > 3650) return { text: due, tone: 'soon' }
  if (days < 0) return { text: `逾期 ${-days} 天`, tone: 'overdue' }
  if (days === 0) return { text: '今天', tone: 'today' }
  if (days === 1) return { text: '明天', tone: 'soon' }
  return { text: `${target.getMonth() + 1} 月 ${target.getDate()} 日`, tone: 'soon' }
}

export const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * 生成 6×7 的月份网格（**周一为第一列**，与 QCalendarWidget 的周首一致）。
 *
 * 从 CalendarBoard 提取到这里：日历视图与新的日期选择器要的是同一个月历，
 * 两份实现迟早会在补位、闰月这些地方分叉。全程用 UTC 造日期，避免本地时区
 * 把 "某月 1 号" 挪到前一天去。
 */
export function monthGrid(year: number, month0: number): { day: string; inMonth: boolean }[] {
  const first = new Date(Date.UTC(year, month0, 1))
  const offset = (first.getUTCDay() + 6) % 7 // 周一=0
  const cells: { day: string; inMonth: boolean }[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(Date.UTC(year, month0, 1 - offset + i))
    cells.push({
      day: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
      inMonth: d.getUTCMonth() === month0,
    })
  }
  return cells
}

/** 本地「今天」的 YYYY-MM-DD。 */
export function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/**
 * 任务的时间进度与紧迫度色阶。
 *
 * 只有一头（缺开始或缺截止）时返回 null —— 没有起点就没有「进度」可言，
 * 硬算只会得到一个假数字。截止时刻留空时按**当天结束**算：用户写「截止 9 月 30 日」
 * 的意思是那天之内都来得及，而不是 9 月 30 日 00:00 就过期。
 */
export type ProgressTone = 'idle' | 'calm' | 'soon' | 'overdue' | 'done'

export interface TaskProgress {
  /** 0~1；大于 1 表示已经超出截止 */
  ratio: number
  tone: ProgressTone
  /** 一句人话，给 title / 悬浮提示用 */
  label: string
}

/** 把「日期 + 可选时刻」拼成一个 Date；时刻留空时按当天起点或终点算。 */
function atClock(date: string, time: string | null, endOfDay: boolean): Date {
  const ok = time != null && /^\d{1,2}:\d{2}$/.test(time)
  const [h, m] = (ok ? (time as string) : endOfDay ? '23:59' : '00:00').split(':').map(Number)
  const d = new Date(`${date}T00:00:00`)
  d.setHours(h, m, 0, 0)
  return d
}

/** 毫秒差 → 人话（分钟 / 小时 / 天）。 */
function humanGap(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return `${min} 分钟`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} 小时`
  return `${Math.round(h / 24)} 天`
}

/**
 * 进度 = 已经过去的时间 / 总时长。色阶分三档（绿 → 橙 → 红）：
 * 剩下三成以上算从容，进入最后三成转橙，过点转红。
 */
export function taskProgress(
  startDate: string | null,
  startTime: string | null,
  dueDate: string | null,
  dueTime: string | null,
  done = false,
  now: Date = new Date()
): TaskProgress | null {
  if (!startDate || !dueDate) return null
  const from = atClock(startDate, startTime, false)
  const to = atClock(dueDate, dueTime, true)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null
  const span = to.getTime() - from.getTime()
  if (span <= 0) return null
  if (done) return { ratio: 1, tone: 'done', label: '已完成' }
  const ratio = (now.getTime() - from.getTime()) / span
  if (ratio > 1) return { ratio, tone: 'overdue', label: `已超时 ${humanGap(now.getTime() - to.getTime())}` }
  const left = `剩 ${humanGap(to.getTime() - now.getTime())}`
  if (ratio >= 0.7) return { ratio, tone: 'soon', label: left }
  if (ratio > 0) return { ratio, tone: 'calm', label: left }
  return { ratio: 0, tone: 'idle', label: `未开始 · ${left}` }
}

/** 「开始 ~ 截止」区间 chip 文案（对齐手册 §5.2 的时间范围 chip） */
export function rangeLabel(start: string | null, due: string | null): string {
  if (start && due) return start === due ? due : `${start} ~ ${due}`
  if (due) return due
  if (start) return `${start} 起`
  return ''
}
