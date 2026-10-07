/**
 * 习惯打卡的统计口径 —— 纯函数。
 *
 * 打卡记录只有一张 (habit_id, day) 表；「连续多少天」「最近完成率」都是**推出来的**，
 * 不落库。落库就多一份要跟记录对账的状态：补打卡、跨天、改系统时区，任一处漏改就永久对不上，
 * 而推导一遍的成本只是几十行数据。
 */

export interface Habit {
  id: number
  name: string
  /** 图标名（渲染层的图标表），空 = 用默认勾 */
  icon: string
  /** 颜色（CSS 颜色串），空 = 跟主题强调色 */
  color: string
  archived_at: string | null
  sort_key: number
  created_at: string
}

export interface HabitLog {
  habit_id: number
  /** YYYY-MM-DD */
  day: string
}

export interface HabitView extends Habit {
  doneToday: boolean
  /** 从今天（今天没打卡就从昨天）往回数的连续天数 */
  streak: number
  /** 近 7 天是否打卡，index 0 = 6 天前、6 = 今天（周条从左到右读） */
  week: boolean[]
  /** 近 30 天完成率 0–1 */
  rate: number
}

/** 默认统计窗口：一个月的完成率 */
export const HABIT_WINDOW_DAYS = 30

/** 日期串（YYYY-MM-DD）加减天数。走本地时区 —— 打卡记的是「用户的今天」，不是 UTC 的今天。 */
export function shiftDay(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return day
  d.setDate(d.getDate() + delta)
  return d.toLocaleDateString('sv-SE')
}

export function todayKey(now: Date = new Date()): string {
  return now.toLocaleDateString('sv-SE')
}

/**
 * 连续天数：从今天往回数，中间断一天就停。
 *
 * 今天还没打卡**不算断**：早上起来看到「连续 5 天」变成 0，会让人以为记录丢了 ——
 * 从昨天往回数，今天补上就接上。
 */
export function computeStreak(done: ReadonlySet<string>, today: string): number {
  let cursor = done.has(today) ? today : shiftDay(today, -1)
  let streak = 0
  // 上限 10 年：脏数据（未来日期、自环）不该把界面卡住
  for (let i = 0; i < 3650; i++) {
    if (!done.has(cursor)) break
    streak += 1
    cursor = shiftDay(cursor, -1)
  }
  return streak
}

/**
 * 把习惯与打卡记录拼成界面要的形状。
 *
 * 完成率的分母取 min(窗口天数, 创建以来的天数)：昨天刚建的习惯不该显示 3% ——
 * 那看起来像「我没坚持」，实际只是「它才存在两天」。
 */
export function buildHabitViews(
  habits: Habit[],
  logs: HabitLog[],
  today: string,
  windowDays: number = HABIT_WINDOW_DAYS
): HabitView[] {
  const byHabit = new Map<number, Set<string>>()
  for (const l of logs) {
    if (!l.day) continue
    const set = byHabit.get(l.habit_id)
    if (set) set.add(l.day)
    else byHabit.set(l.habit_id, new Set([l.day]))
  }
  return habits
    .map((h) => {
      const done = byHabit.get(h.id) ?? new Set<string>()
      const week: boolean[] = []
      for (let i = 6; i >= 0; i--) week.push(done.has(shiftDay(today, -i)))
      const created = (h.created_at ?? '').slice(0, 10)
      // 创建当天也算一天：当天建、当天打卡，完成率就是 100%
      const spanDays = created ? Math.max(1, dayDiff(created, today) + 1) : windowDays
      const denom = Math.max(1, Math.min(windowDays, spanDays))
      let hit = 0
      for (let i = 0; i < denom; i++) if (done.has(shiftDay(today, -i))) hit += 1
      return {
        ...h,
        doneToday: done.has(today),
        streak: computeStreak(done, today),
        week,
        rate: hit / denom,
      }
    })
    .sort((a, b) => {
      // 归档的沉到底部；其余按 sort_key，再按 id 兜底（sort_key 相等时顺序要稳定）
      const arch = Number(Boolean(a.archived_at)) - Number(Boolean(b.archived_at))
      if (arch !== 0) return arch
      return a.sort_key - b.sort_key || a.id - b.id
    })
}

/** 两个日期串相差几天（b - a），按本地日历日算 */
export function dayDiff(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00')
  const db = new Date(b + 'T00:00:00')
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return 0
  return Math.round((db.getTime() - da.getTime()) / 86400000)
}
