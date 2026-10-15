import type { Task } from './types'
import { addDays, pad2, type WeekStart } from './calendar'

/**
 * 甘特图的时间粒度：每列一天 / 一周 / 一月。
 *
 * 这三档不是"缩放比例"，而是**三种读法**：日看这一阵谁在做什么，周看这一季的排期分布，
 * 月看这一年的交付节奏。所以三档的视窗长度也跟着变（见 GANTT_COLUMNS），
 * 而不是同一段日期换刻度。
 */
export type GanttScale = 'day' | 'week' | 'month'

export const GANTT_SCALES: { value: GanttScale; label: string; hint: string }[] = [
  { value: 'day', label: '日', hint: '每列一天，视窗两周' },
  { value: 'week', label: '周', hint: '每列一周，视窗一季度' },
  { value: 'month', label: '月', hint: '每列一月，视窗一年' },
]

/** 各档的列数：两周 / 十二周 / 十二月。 */
export const GANTT_COLUMNS: Record<GanttScale, number> = { day: 14, week: 12, month: 12 }

/** 一列的起止（含两端），以及表头两行标签。 */
export interface GanttCell {
  /** 列起始日 YYYY-MM-DD */
  start: string
  /** 列结束日（含当天） */
  end: string
  /** 这一列有几天（月档 28~31 不等，表头按它分配宽度） */
  days: number
  /** 表头主标签 */
  label: string
  /** 表头副标签（日档给周几），没有就是空串 */
  sub: string
  /** 今天落在这一列里 */
  today: boolean
}

export interface GanttWindow {
  scale: GanttScale
  /** 视窗第一天（= 第一列的起始日，已按粒度对齐） */
  start: string
  /** 视窗最后一天（含） */
  end: string
  /** 视窗总天数 —— 任务条的定位分母 */
  days: number
  cells: GanttCell[]
}

const DAY_MS = 86_400_000
/** 表头日档的周几（周一起手，与日历的默认列序同一套） */
const WEEKDAY_CN = ['一', '二', '三', '四', '五', '六', '日']

/** 日期串 → 自 epoch 起的天数（UTC）。非法日期返回 null。 */
export function dayNo(day: string | null | undefined): number | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const t = Date.parse(day + 'T00:00:00Z')
  return Number.isFinite(t) ? Math.round(t / DAY_MS) : null
}

/** 天数 → 日期串（dayNo 的逆运算）。 */
function dayStr(no: number): string {
  const d = new Date(no * DAY_MS)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** 所在月的最后一天。 */
function monthEnd(day: string): string {
  const d = new Date(day + 'T00:00:00Z')
  return dayStr(Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0) / DAY_MS))
}

/**
 * 把任意一天对齐到粒度边界：日 = 当天；周 = 该周首日（跟随周起始设置）；月 = 当月 1 号。
 *
 * 对齐是为了让翻页可预期 —— 窗口总落在周一 / 月初上，"上一页/下一页"才走得整齐，
 * 不会因为起点是周三就一路错位下去。
 */
export function ganttAlign(scale: GanttScale, day: string, weekStart: WeekStart = 'mon'): string {
  if (scale === 'day') return day
  if (scale === 'week') {
    const d = new Date(day + 'T00:00:00Z')
    const dow = weekStart === 'sun' ? d.getUTCDay() : (d.getUTCDay() + 6) % 7
    return addDays(day, -dow)
  }
  return day.slice(0, 8) + '01'
}

/**
 * 视图窗口：以 anchor 所在的那一档为起点，往后铺 GANTT_COLUMNS 列。
 *
 * 返回的 cells 里带上表头要的两行文字与"今天在不在这列"，组件只负责画 ——
 * "哪一天属于哪一列"这类规则最容易在组件里被写散（日历的 groupTasksByDate 同理，
 * 所以它们都住在 shared）。
 */
export function ganttWindow(
  scale: GanttScale,
  anchor: string,
  today: string,
  weekStart: WeekStart = 'mon'
): GanttWindow {
  const base = dayNo(anchor) ?? dayNo(today) ?? 0
  const start = ganttAlign(scale, dayStr(base), weekStart)
  const cells: GanttCell[] = []
  let cur = start
  for (let i = 0; i < GANTT_COLUMNS[scale]; i++) {
    const end = scale === 'day' ? cur : scale === 'week' ? addDays(cur, 6) : monthEnd(cur)
    const d = new Date(cur + 'T00:00:00Z')
    const dow = (d.getUTCDay() + 6) % 7
    cells.push({
      start: cur,
      end,
      days: (dayNo(end) ?? 0) - (dayNo(cur) ?? 0) + 1,
      label:
        scale === 'day'
          ? String(d.getUTCDate())
          : scale === 'week'
            ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
            : d.getUTCMonth() === 0
              ? `${String(d.getUTCFullYear()).slice(2)}年1月`
              : `${d.getUTCMonth() + 1}月`,
      sub: scale === 'day' ? WEEKDAY_CN[dow] : '',
      today: today >= cur && today <= end,
    })
    cur = addDays(end, 1)
  }
  const first = dayNo(start) ?? 0
  const after = dayNo(cur) ?? first
  return {
    scale,
    start,
    end: cells[cells.length - 1].end,
    days: Math.max(1, after - first),
    cells,
  }
}

/** 某一天在视窗里的位置（0 = 起点，1 = 终点之后）。 */
export function ganttPct(win: GanttWindow, day: string): number | null {
  const n = dayNo(day)
  const base = dayNo(win.start)
  if (n === null || base === null) return null
  return (n - base) / win.days
}

/** 单端任务的标记宽度：一列。没有起点就没有区间，"进度"无从画起。 */
export type GanttBarKind = 'range' | 'due' | 'start'

export interface GanttBar {
  /** 左端位置（0~100，已按视窗裁剪） */
  left: number
  /** 宽度（0~100） */
  width: number
  kind: GanttBarKind
  /** 左/右端被视窗切掉了 —— 那一头还有内容，渲染时给个切口 */
  clipStart: boolean
  clipEnd: boolean
}

/**
 * 任务条：把 start_date ~ due_date 映射成时间轴上的左右端。
 *
 * 口径（与日历的"区间逐日展开"同一套）：
 * - 两端都有 → 从开始日铺到截止日**当天结束**（含两端），所以右端取"截止日的下一天"；
 * - 只有截止（或只有开始）→ 一格宽的标记，用 kind 区分"这是截止"还是"这是开始"；
 * - 都没有、或整条落在视窗外 → 不画（返回 null）。
 *
 * 视窗外的部分裁掉并在那一端标 clip*，让"还有更多"看得见，而不是画成一条顶到边的假区间。
 */
export function ganttBar(
  task: Pick<Task, 'start_date' | 'due_date'>,
  win: GanttWindow
): GanttBar | null {
  const s = task.start_date
  const due = task.due_date
  if (!s && !due) return null
  let from = s ?? due!
  let to = due ?? s!
  if (from > to) [from, to] = [to, from]
  const a = dayNo(from)
  const b = dayNo(to)
  const base = dayNo(win.start)
  if (a === null || b === null || base === null) return null
  let lo = a - base
  let hi = b - base + 1
  if (hi <= 0 || lo >= win.days) return null
  const clipStart = lo < 0
  const clipEnd = hi > win.days
  lo = Math.max(0, lo)
  hi = Math.min(win.days, hi)
  return {
    left: (lo / win.days) * 100,
    width: ((hi - lo) / win.days) * 100,
    kind: s && due ? 'range' : due ? 'due' : 'start',
    clipStart,
    clipEnd,
  }
}
