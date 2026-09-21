/**
 * 提醒策略：提前量 / 自动提醒规则 / 重复次数。
 *
 * 纯函数，不碰数据库 —— 主进程的派发引擎与设置页说明共用同一套判定。
 *
 * 三条语义：
 *   ① 提前量只对「没手动设提醒时刻」的任务生效（手动设过的以手动为准）；
 *   ② 规则决定哪些任务会自动生成提醒；
 *   ③ 次数 + 间隔决定同一条任务提醒几轮、每轮隔多久。
 */

export interface ReminderPolicy {
  /** 提前量（分钟） */
  leadMinutes: number
  /** 有截止时刻的任务自动提醒 */
  forTimed: boolean
  /** 只有截止日期的任务，在当天 dayClock 提醒 */
  forUntimed: boolean
  /** forUntimed 用的时刻（HH:MM） */
  dayClock: string
  /** 只自动提醒优先级 ≥ 此值的任务（0 = 不限） */
  priorityMin: number
  /** 最多提醒几次（≥1；1 = 只提醒一次） */
  repeatCount: number
  /** 重复间隔（分钟） */
  repeatIntervalMinutes: number
}

export interface ReminderTask {
  status: string | null
  priority: number | null
  due_date: string | null
  due_time: string | null
  reminder_at: string | null
  /** 已提醒次数 */
  reminder_fired: number | null
  /** 计数所依据的基准时刻（基准变了就重新计数） */
  reminder_base: string | null
}

export interface ReminderDecision {
  /** 此刻该不该提醒 */
  fire: boolean
  /** 应当落库的已提醒次数 */
  fired: number
  /** 本次计算所用的基准时刻（'' = 这条任务不会有提醒） */
  base: string
  /** 次数是否已经用完（引擎据此清掉显式的 reminder_at） */
  done: boolean
}

/** 这三种状态不打扰：完成 / 放弃 / 等待中（等待中是「先搁着」，不该催）。 */
const SILENT = new Set(['done', 'abandoned', 'waiting'])

/** 日期 + 时刻拼成 `YYYY-MM-DD HH:MM:00`；缺一不可。 */
const stamp = (date: string | null, clock: string | null): string => {
  if (!date) return ''
  const parts = (clock ?? '').split(':')
  const [h, m] = parts
  if (!/^\d{2}$/.test(h ?? '') || !/^\d{2}$/.test(m ?? '')) return ''
  return `${date} ${h}:${m}:00`
}

/** 归一成同一格式：库里 reminder_at 带微秒（`...:00.000000`），比较与落库都要一致。 */
const normalize = (v: string): string => v.replace('T', ' ').slice(0, 19)

/**
 * 这条任务的**基准时刻**；空串表示它不会有提醒。
 *
 * 基准是「按什么时刻算提醒」：手动设的提醒时刻，或者由截止时间/日期推出的时刻。
 */
export function reminderBaseAt(task: ReminderTask, policy: ReminderPolicy): string {
  // 手动设过就以它为准 —— 提前量与优先级下限都不参与（那是用户显式要求的时刻）
  if (task.reminder_at) return normalize(task.reminder_at)
  if (policy.priorityMin > 0 && (task.priority ?? 0) < policy.priorityMin) return ''
  if (task.due_time && policy.forTimed) return stamp(task.due_date, task.due_time)
  // 「只有截止日期」这条规则**只对有日期、没有时刻**的任务生效：
  // 有时刻的任务归上一条管，否则关掉时刻提醒反而会在 dayClock 提醒，那是个意外行为。
  if (task.due_date && !task.due_time && policy.forUntimed) return stamp(task.due_date, policy.dayClock)
  return ''
}

const parseLocal = (s: string): number => new Date(s.replace(' ', 'T')).getTime()

/**
 * 判定此刻该不该提醒，以及提醒后应当记成第几次。
 *
 * 第 N 次（从 0 起）的触发时刻 = 基准 − 提前量 + N × 间隔。
 */
export function decideReminder(
  task: ReminderTask,
  policy: ReminderPolicy,
  now: Date
): ReminderDecision {
  const base = reminderBaseAt(task, policy)
  if (!base || SILENT.has(task.status ?? 'todo')) {
    return { fire: false, fired: 0, base, done: false }
  }
  // 基准变了就等于重新计数 —— 改了截止日期不该被旧计数卡住
  const fired = task.reminder_base === base ? (task.reminder_fired ?? 0) : 0
  const count = Math.max(1, policy.repeatCount)
  const interval = Math.max(1, policy.repeatIntervalMinutes)
  const first = parseLocal(base) - policy.leadMinutes * 60_000
  const next = first + fired * interval * 60_000
  const due = now.getTime() >= next && fired < count
  const after = due ? fired + 1 : fired
  // done 必须按**递增之后**的次数判：用递增前的值会让「只提醒一次」的任务
  // 永远达不到 done，于是 reminder_at 永不清空、下一轮又提醒一次
  return { fire: due, fired: after, base, done: after >= count }
}
