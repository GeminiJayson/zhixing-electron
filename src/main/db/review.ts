import { effectiveDoneMap as effectiveDoneMapMain } from '../../shared/task'
import type {
  Task,
  ReviewStats,
} from '../../shared/types'
import { conn, nowStamp, TASK_COLUMNS } from './connection'

// ---------------------------------------------------------------- 回顾统计

export const dayOf = (value: string | null): string | null => (value ? value.slice(0, 10) : null)

/**
 * completed_at 落在 [start, end) 的完成时间串（对齐 TaskRepository.completed_between）。
 *
 * 关键口径：该查询**不过滤 deleted_at、也不看 status**，只看完成时间是否落在区间内。
 * 周趋势 / 热力图 / 连续天数都直接使用它，与 Python 侧逐值一致。
 */
function completedBetween(start: string, end: string): string[] {
  const rows = conn()
    .prepare(
      'SELECT completed_at FROM task WHERE completed_at IS NOT NULL AND completed_at >= ? AND completed_at < ?'
    )
    .all(start, end) as { completed_at: string }[]
  return rows.map((r) => r.completed_at)
}

/** 某天 00:00:00 的时间戳串（对齐 datetime.combine(day, datetime.min.time())）。 */
const dayStartStamp = (day: string): string => day + ' 00:00:00'

/**
 * 今日待办根集合（对齐 task_rules.today_roots）：
 * 顶层 + 有效未完成 + 未逾期（无截止 或 截止 >= 今天）。
 */
export function todayRoots(tasks: Task[], effective: Map<number, boolean>, today: string): Task[] {
  return tasks.filter((t) => {
    if (t.parent_id !== null) return false
    if (effective.get(t.id) ?? (t.status === 'done' || t.status === 'abandoned')) return false
    return t.due_date === null || t.due_date >= today
  })
}

export function reviewStats(weeks = 12, days = 7): ReviewStats {
  const c = conn()
  const today = new Date().toLocaleDateString('sv-SE')
  const tasks = c
    .prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE deleted_at IS NULL`)
    .all() as Task[]
  const effective = effectiveDoneMapMain(tasks)

  const isEffectiveDone = (t: Task): boolean =>
    effective.get(t.id) ?? (t.status === 'done' || t.status === 'abandoned')

  const todayDue = todayRoots(tasks, effective, today).length
  const doneToday = tasks.filter(
    (t) => isEffectiveDone(t) && dayOf(t.completed_at) === today
  ).length
  const overdue = tasks.filter(
    (t) => t.due_date !== null && t.due_date < today && !isEffectiveDone(t)
  ).length
  const inbox = tasks.length
  // 闪念计数 = 全部未删除闪念（含 archived）。对齐 review_service.today_counts 的
  // `len(self.flashes.list(s))`——那里 status=None，不过滤状态。
  const flash = (
    c.prepare('SELECT COUNT(*) AS c FROM flash WHERE deleted_at IS NULL').get() as { c: number }
  ).c

  // 近 N 天：完成数 / 番茄分钟 / 新建笔记
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  const labelOf = (d: Date): string =>
    `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const labels: string[] = []
  const completed = new Array<number>(days).fill(0)
  const pomodoro = new Array<number>(days).fill(0)
  const notes = new Array<number>(days).fill(0)
  for (let i = 0; i < days; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    labels.push(labelOf(d))
  }
  const idxOf = (day: string): number => {
    const startKey = start.toLocaleDateString('sv-SE')
    const diff = Math.round((new Date(`${day}T00:00:00Z`).getTime() - new Date(`${startKey}T00:00:00Z`).getTime()) / 86400000)
    return diff >= 0 && diff < days ? diff : -1
  }
  // 完成数取 completed_between（不按 deleted_at / status 过滤），与 Python 周趋势同口径
  for (const stamp of completedBetween(dayStartStamp(start.toLocaleDateString('sv-SE')), nowStamp())) {
    const i = idxOf(dayOf(stamp) ?? '')
    if (i >= 0) completed[i] += 1
  }
  const pomoRows = c
    .prepare(
      `SELECT substr(started_at, 1, 10) AS day, SUM(minutes) AS m FROM pomodoro_session
        WHERE completed = 1 AND started_at IS NOT NULL GROUP BY substr(started_at, 1, 10)`
    )
    .all() as { day: string; m: number }[]
  for (const r of pomoRows) {
    const i = idxOf(r.day)
    if (i >= 0) pomodoro[i] = Number(r.m) || 0
  }
  const noteRows = c
    .prepare('SELECT substr(created_at, 1, 10) AS day FROM note WHERE deleted_at IS NULL')
    .all() as { day: string }[]
  for (const r of noteRows) {
    const i = idxOf(r.day)
    if (i >= 0) notes[i] += 1
  }

  // 热力图：近 weeks 周，[weeks][7]；start 对齐到周一列（与 Python 的 offset 一致）
  const todayDate = new Date(`${today}T00:00:00Z`)
  const weekday0 = (todayDate.getUTCDay() + 6) % 7 // 周一=0
  const gridStart = new Date(todayDate)
  gridStart.setUTCDate(todayDate.getUTCDate() - (weeks * 7 - 1 - (6 - weekday0)))
  // 热力计数同样走 completed_between：[gridStart, today+1) 区间，不过滤 deleted_at/status
  const heatEnd = new Date(todayDate)
  heatEnd.setUTCDate(todayDate.getUTCDate() + 1)
  const counts = new Map<string, number>()
  for (const stamp of completedBetween(
    dayStartStamp(gridStart.toISOString().slice(0, 10)),
    dayStartStamp(heatEnd.toISOString().slice(0, 10))
  )) {
    const day = dayOf(stamp)
    if (day) counts.set(day, (counts.get(day) ?? 0) + 1)
  }
  const heatmap: number[][] = []
  for (let w = 0; w < weeks; w++) {
    const col: number[] = []
    for (let d = 0; d < 7; d++) {
      const day = new Date(gridStart)
      day.setUTCDate(gridStart.getUTCDate() + w * 7 + d)
      const key = day.toISOString().slice(0, 10)
      col.push(key > today ? -1 : (counts.get(key) ?? 0))
    }
    heatmap.push(col)
  }

  // 连续完成天数（今日或昨天为止）
  // 连续天数：自 2000-01-01 起的所有完成时间（completed_between，无 deleted_at/status 过滤）
  const doneDays = new Set<string>()
  for (const stamp of completedBetween(dayStartStamp('2000-01-01'), nowStamp())) {
    const day = dayOf(stamp)
    if (day) doneDays.add(day)
  }
  let streak = 0
  const cursor = new Date(todayDate)
  if (!doneDays.has(cursor.toISOString().slice(0, 10))) cursor.setUTCDate(cursor.getUTCDate() - 1)
  while (doneDays.has(cursor.toISOString().slice(0, 10))) {
    streak += 1
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }

  const doneTotal = tasks.filter((t) => t.status === 'done' || t.status === 'abandoned').length
  const noteCount = (
    c.prepare('SELECT COUNT(*) AS c FROM note WHERE deleted_at IS NULL').get() as { c: number }
  ).c
  const linkCount = (c.prepare('SELECT COUNT(*) AS c FROM note_link').get() as { c: number }).c
  const achievements = [
    { name: '初试锋芒', desc: '完成第一个任务', unlocked: doneTotal >= 1 },
    { name: '持之以恒', desc: '连续完成 7 天', unlocked: streak >= 7 },
    { name: '三十而立', desc: '连续完成 30 天', unlocked: streak >= 30 },
    { name: '任务收割机', desc: '累计完成 100 项任务', unlocked: doneTotal >= 100 },
    { name: '笔耕不辍', desc: '创建 10 篇笔记', unlocked: noteCount >= 10 },
    { name: '织网者', desc: '建立 5 条双向链接', unlocked: linkCount >= 5 },
  ]

  // 标签分布：任务标签 + 笔记标签合并计数（对齐 TagRepository.distribution）
  const dist = new Map<string, { color: string; count: number }>()
  const tagRows = c
    .prepare(
      `SELECT t.name AS name, t.color AS color, COUNT(*) AS c
         FROM task_tag tt JOIN tag t ON t.id = tt.tag_id GROUP BY t.id`
    )
    .all() as { name: string; color: string; c: number }[]
  for (const r of tagRows) dist.set(r.name, { color: r.color, count: r.c })
  const noteTagRows = c
    .prepare(
      `SELECT t.name AS name, t.color AS color, COUNT(*) AS c
         FROM note_tag nt JOIN tag t ON t.id = nt.tag_id GROUP BY t.id`
    )
    .all() as { name: string; color: string; c: number }[]
  for (const r of noteTagRows) {
    const prev = dist.get(r.name)
    dist.set(r.name, { color: r.color, count: (prev?.count ?? 0) + r.c })
  }
  const tagDistribution = [...dist.entries()]
    .map(([name, v]) => ({ name, color: v.color, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  return {
    todayCounts: { todayDue, doneToday, overdue, inbox, flash },
    week: { completed, pomodoro, notes, labels },
    heatmap,
    streak,
    achievements,
    tagDistribution,
  }
}
