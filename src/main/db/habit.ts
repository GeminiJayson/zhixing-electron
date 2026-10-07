/**
 * 习惯打卡的数据层。
 *
 * 只做"存与取"：「连续几天」「完成率」全部由 shared/habit.ts 推导（那边有单测）。
 * 这里唯一值得留意的是 day —— 一律按调用方给的本地日期串走，
 * 不在这里 new Date()：打卡记的是用户所在时区的今天，服务端时间不是判据。
 */
import { conn, nowStamp } from './connection'
import { buildHabitViews, todayKey, type Habit, type HabitView } from '../../shared/habit'

export interface HabitInput {
  /** 有 id 是改，没有是新建 */
  id?: number
  name: string
  icon?: string
  color?: string
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 日期串合法性：坏值写进去会让连续天数算出莫名其妙的数，宁可不写 */
function safeDay(day: string): string | null {
  const d = String(day ?? '').trim()
  return DAY_RE.test(d) ? d : null
}

/**
 * 全部习惯 + 各自的打卡记录 → 界面视图。
 *
 * habit_log 全量读：习惯是个位数量，一天一行，十年的记录也就几万行 ——
 * 为它加时间窗反而会让"连续 500 天"这类真实数据被截断。
 */
export function listHabits(today: string = todayKey()): HabitView[] {
  const c = conn()
  const habits = c
    .prepare(
      "SELECT id, name, COALESCE(icon, '') AS icon, COALESCE(color, '') AS color, " +
        "archived_at, COALESCE(sort_key, 0) AS sort_key, created_at FROM habit"
    )
    .all() as Habit[]
  const logs = c.prepare('SELECT habit_id, day FROM habit_log').all() as {
    habit_id: number
    day: string
  }[]
  return buildHabitViews(habits, logs, today)
}

/** 新建或改名/换图标颜色。新习惯排在最后（sort_key = 当前最大值 + 1）。 */
export function saveHabit(input: HabitInput): number {
  const c = conn()
  const name = String(input.name ?? '').trim()
  if (!name) return 0
  const icon = String(input.icon ?? '')
  const color = String(input.color ?? '')
  const stamp = nowStamp()
  const id = Math.floor(Number(input.id) || 0)
  if (id > 0) {
    const changes = c
      .prepare('UPDATE habit SET name = ?, icon = ?, color = ? WHERE id = ?')
      .run(name, icon, color, id).changes
    return changes > 0 ? id : 0
  }
  const next = c.prepare('SELECT COALESCE(MAX(sort_key), 0) + 1 AS k FROM habit').get() as { k: number }
  const res = c
    .prepare('INSERT INTO habit (name, icon, color, sort_key, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, icon, color, next.k, stamp)
  return Number(res.lastInsertRowid)
}

/** 归档 / 取消归档。归档不删记录：哪天想恢复，连续天数还得接得上。 */
export function archiveHabit(id: number, archived: boolean): boolean {
  const changes = conn()
    .prepare('UPDATE habit SET archived_at = ? WHERE id = ?')
    .run(archived ? nowStamp() : null, Math.floor(Number(id))).changes
  return changes > 0
}

export function deleteHabit(id: number): boolean {
  // habit_log 走外键级联（foreign_keys=ON），不用手删
  return conn().prepare('DELETE FROM habit WHERE id = ?').run(Math.floor(Number(id))).changes > 0
}

/** 打卡 / 取消打卡，返回操作后这一天是否已打卡。 */
export function setHabitDay(id: number, day: string, done: boolean): boolean {
  const habitId = Math.floor(Number(id))
  const d = safeDay(day)
  if (!habitId || !d) return false
  const c = conn()
  if (done) {
    c.prepare('INSERT OR IGNORE INTO habit_log (habit_id, day, created_at) VALUES (?, ?, ?)').run(
      habitId,
      d,
      nowStamp()
    )
    return true
  }
  c.prepare('DELETE FROM habit_log WHERE habit_id = ? AND day = ?').run(habitId, d)
  return false
}

/** 切换某天（今天那颗按钮走这条），返回切换后的状态。 */
export function toggleHabitDay(id: number, day: string): boolean {
  const habitId = Math.floor(Number(id))
  const d = safeDay(day)
  if (!habitId || !d) return false
  const has = conn()
    .prepare('SELECT 1 AS x FROM habit_log WHERE habit_id = ? AND day = ?')
    .get(habitId, d)
  return setHabitDay(habitId, d, !has)
}
