import type { Task } from './types'

/**
 * 日历的**展开口径** —— 三者合起来决定"哪一天格子里出现哪些任务"。
 *
 * 为什么做成可配置：同一批任务在日历上有两种合理的读法 ——
 * 「按区间铺开」看的是**排期占用**（这周有多满），「只落在截止日」看的是**交付节点**。
 * 此前写死了前者，于是想按截止日看的人只能自己脑补。
 */
export type CalendarSpanMode = 'range' | 'due' | 'start'
export type CalendarNoDate = 'today' | 'hide'
export type WeekStart = 'mon' | 'sun'

export interface CalendarOptions {
  /** 有开始+截止时怎么落格 */
  spanMode: CalendarSpanMode
  /** 两个日期都没有的任务 */
  noDate: CalendarNoDate
}

export const CALENDAR_SPAN_MODES: { value: CalendarSpanMode; label: string; hint: string }[] = [
  { value: 'range', label: '区间逐日展开', hint: '开始～截止之间每一天都出现（看排期占用）' },
  { value: 'due', label: '只按截止日', hint: '只在截止那天出现（看交付节点）' },
  { value: 'start', label: '只按开始日', hint: '只在开始那天出现（看什么时候动手）' },
]

export const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 日期串加减天数（UTC，避免本地时区把"某月 1 号"挪到前一天）。 */
export function addDays(day: string, n: number): string {
  const d = new Date(day + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** 区间展开的防御性上限：约 10 年，防止手滑填出跨世纪的区间把日历撑爆。 */
export const MAX_SPAN_DAYS = 3660

/**
 * 任务按日期归类。
 *
 * 口径（见 CalendarOptions）：
 * - `range`：开始+截止 → 区间内每一天都显示（含两端）；仅一端 → 落那一端；
 * - `due`：落在截止日；没有截止就退回开始日；
 * - `start`：落在开始日；没有开始就退回截止日；
 * - 两个日期都没有 → `today` 归今日 / `hide` 不出现。
 * 每日内按 (-priority, sort_key, id) 升序 —— 有测试守着。
 */
export function groupTasksByDate(
  tasks: Task[],
  today: string,
  opts: CalendarOptions = { spanMode: 'range', noDate: 'today' }
): Map<string, Task[]> {
  const out = new Map<string, Task[]>()
  const push = (day: string, t: Task): void => {
    const list = out.get(day) ?? []
    list.push(t)
    out.set(day, list)
  }
  for (const t of tasks) {
    if (!t.start_date && !t.due_date) {
      if (opts.noDate === 'today') push(today, t)
      continue
    }
    if (opts.spanMode === 'due') {
      push(t.due_date ?? t.start_date!, t)
      continue
    }
    if (opts.spanMode === 'start') {
      push(t.start_date ?? t.due_date!, t)
      continue
    }
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
    } else {
      push((t.due_date ?? t.start_date)!, t)
    }
  }
  for (const list of out.values()) {
    list.sort((a, b) => b.priority - a.priority || a.sort_key - b.sort_key || a.id - b.id)
  }
  return out
}

/** 表头：周一或周日打头（跟着 monthGrid 的列序走，两处不能各说各的）。 */
export function weekdayLabels(weekStart: WeekStart, labels = ['一', '二', '三', '四', '五', '六', '日']): string[] {
  return weekStart === 'sun' ? [labels[6], ...labels.slice(0, 6)] : labels
}
