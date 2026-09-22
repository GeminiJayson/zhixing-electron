/**
 * 循环任务递推。
 *
 * 日期一律按 'YYYY-MM-DD' 处理并用 UTC 运算，避免本地时区把日期前后挪一天。
 */

export type RepeatPeriod = 'none' | 'daily' | 'weekly' | 'monthly' | 'custom'
type Freq = 'daily' | 'weekly' | 'monthly'

const FREQ_VALUES: Record<string, Freq> = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' }

export interface RRule {
  freq: Freq
  interval: number
  count: number | null
  until: string | null
}

const parseDay = (s: string): Date => new Date(`${s}T00:00:00Z`)
const fmtDay = (d: Date): string => d.toISOString().slice(0, 10)

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate()
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000)
}

/** 解析 RRULE 子集（FREQ/INTERVAL/COUNT/UNTIL）；空串或非法输入返回 null。 */
export function parseRRule(rule: string | null): RRule | null {
  if (!rule || !rule.trim()) return null
  const info: RRule = { freq: 'daily', interval: 1, count: null, until: null }
  for (const raw of rule.trim().split(';')) {
    const part = raw.trim()
    if (!part || !part.includes('=')) continue
    const idx = part.indexOf('=')
    const key = part.slice(0, idx).trim().toUpperCase()
    const value = part.slice(idx + 1).trim()
    if (key === 'FREQ') {
      info.freq = FREQ_VALUES[value.toUpperCase()] ?? 'daily'
    } else if (key === 'INTERVAL') {
      const n = Number.parseInt(value, 10)
      if (Number.isFinite(n)) info.interval = Math.max(1, n)
    } else if (key === 'COUNT') {
      const n = Number.parseInt(value, 10)
      if (Number.isFinite(n)) info.count = Math.max(0, n)
    } else if (key === 'UNTIL') {
      const parsed = parseUntil(value)
      if (parsed) info.until = parsed
    }
  }
  return info
}

function parseUntil(value: string): string | null {
  let v = value.toUpperCase().trim()
  if (v.includes('T')) v = v.split('T')[0]
  v = v.replace(/Z$/, '')
  if (/^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  return null
}

/** 按 freq + interval 推进（interval >= 1）；月度按月末裁剪。 */
export function step(d: Date, freq: Freq, interval: number): Date {
  if (freq === 'daily') return addDays(d, interval)
  if (freq === 'weekly') return addDays(d, 7 * interval)
  const y = d.getUTCFullYear()
  const total = d.getUTCMonth() + interval
  const y2 = y + Math.floor(total / 12)
  const m2 = ((total % 12) + 12) % 12
  return new Date(Date.UTC(y2, m2, Math.min(d.getUTCDate(), daysInMonth(y2, m2))))
}

/** 推进一个周期；custom 规则下 until 超限返回 null。 */
export function nextDue(day: string, period: RepeatPeriod, rule: string | null): string | null {
  const d = parseDay(day)
  if (period === 'custom') {
    const info = parseRRule(rule)
    if (!info) return day
    const nd = step(d, info.freq, info.interval)
    if (info.until && fmtDay(nd) > info.until) return null
    return fmtDay(nd)
  }
  if (period === 'daily') return fmtDay(addDays(d, 1))
  if (period === 'weekly') return fmtDay(addDays(d, 7))
  if (period === 'monthly') return fmtDay(step(d, 'monthly', 1))
  return day
}

/** 克隆时 COUNT 递减：无 COUNT 原样返回；COUNT<=1 返回 null（终止）。 */
export function nextCountRule(rule: string | null): string | null {
  const info = parseRRule(rule)
  if (!info || info.count === null) return rule
  if (info.count <= 1) return null
  return String(rule ?? '')
    .split(';')
    .map((part) =>
      part.trim().toUpperCase().startsWith('COUNT=') ? `COUNT=${info.count! - 1}` : part
    )
    .join(';')
}

export interface RecurrenceSource {
  repeat_period: RepeatPeriod
  repeat_rule: string | null
  due_date: string | null
}

/**
 * 克隆推进：返回 [下一截止日, 克隆应携带的 repeat_rule]。
 * until 超限或 COUNT 耗尽时返回 [null, null]（循环终止）。
 */
export function nextRecurrence(task: RecurrenceSource, today: string): [string | null, string | null] {
  if (task.repeat_period === 'none') return [null, null]
  const base = task.due_date ?? today
  const nd = nextDue(base, task.repeat_period, task.repeat_rule)
  if (nd === null) return [null, null]
  if (task.repeat_period === 'custom') {
    const rule = nextCountRule(task.repeat_rule)
    if (rule === null) return [null, null]
    return [nd, rule]
  }
  return [nd, task.repeat_rule]
}
