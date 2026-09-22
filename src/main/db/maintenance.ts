import { listSettings } from './settings'
import type { AppSettings } from '../../shared/settings'
import { nextDue } from '../../shared/recurrence'
import { decideReminder, reminderBaseAt, type ReminderPolicy } from '../../shared/reminder'
import { parseSettings } from '../../shared/settings'
import type {
  Task,
} from '../../shared/types'
import { conn, open, nowStamp, today, getTask, TASK_COLUMNS, dbReadonlyReason } from './connection'
import { createListFolder } from './lists'
import { createTask, setPriority } from './tasks'
import { createNote } from './notes'

// ---------------------------------------------------------------- 跨天维护

export const shiftDay = (day: string, delta: number): string =>
  new Date(new Date(`${day}T00:00:00Z`).getTime() + delta * 86_400_000).toISOString().slice(0, 10)

/**
 * 循环子任务打卡重置（启动 / 跨天调用）：
 * 只在重置前**已勾选完成**的才累加 streak，避免跳过周期也算连续。
 * 返回被重置的任务数。
 */
export function rollRecurringToday(): number {
  const c = conn()
  const day = today()
  const recurring = c
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM task
        WHERE deleted_at IS NULL AND parent_id IS NOT NULL AND repeat_period != 'none'`
    )
    .all() as Task[]
  const doneBefore = new Set(
    recurring.filter((t) => t.status === 'done' || t.status === 'abandoned').map((t) => t.id)
  )
  const stamp = nowStamp()
  const resetIds: number[] = []
  const stmt = c.prepare(
    'UPDATE task SET status = ?, last_reset_date = ?, due_date = ?, streak = ?, updated_at = ? WHERE id = ?'
  )
  const tx = c.transaction(() => {
    for (const t of recurring) {
      if (t.last_reset_date && t.last_reset_date >= day) continue
      const base = t.last_reset_date ?? t.due_date ?? shiftDay(day, -1)
      const due =
        t.repeat_period === 'daily'
          ? shiftDay(base, 1)
          : nextDue(base, t.repeat_period, t.repeat_rule)
      if (!due || due > day) continue
      const streak = doneBefore.has(t.id) ? (t.streak ?? 0) + 1 : (t.streak ?? 0)
      stmt.run('todo', day, day, streak, stamp, t.id)
      resetIds.push(t.id)
    }
  })
  tx()
  return resetIds.length
}

/**
 * 等待中任务到期恢复为待办：
 * resume_at 到期的自动回到 todo 并清掉恢复日期。
 */
export function resumeDueToday(): number {
  return conn()
    .prepare(
      "UPDATE task SET status = 'todo', resume_at = NULL, updated_at = ? WHERE deleted_at IS NULL AND status = 'waiting' AND resume_at IS NOT NULL AND resume_at <= ?"
    )
    .run(nowStamp(), today()).changes
}

// ---------------------------------------------------------------- 番茄钟 / 到点提醒

/**
 * 记录一次番茄钟。
 *
 * reason 允许为 null：未中断的会话存 NULL，只有手动中断
 * 才写入原因字符串。整列口径要一致，否则导出/统计里同一件事两种形态。
 */
export function recordPomodoro(
  taskId: number | null,
  minutes: number,
  completed: boolean,
  reason: string | null = null
): number {
  const m = Math.round(minutes)
  // 不足 1 分钟不落库
  if (!(m >= 1)) return 0
  const clean = reason && reason.trim() ? reason.trim() : null
  const info = conn()
    .prepare(
      'INSERT INTO pomodoro_session (task_id, started_at, minutes, completed, reason) VALUES (?, ?, ?, ?, ?)'
    )
    .run(taskId, nowStamp(), m, completed ? 1 : 0, clean)
  return Number(info.lastInsertRowid)
}

/** 今日番茄统计（用于番茄钟浮条与回顾页）。 */
export function pomodoroToday(): { minutes: number; sessions: number } {
  const row = conn()
    .prepare(
      "SELECT COALESCE(SUM(minutes), 0) AS m, COUNT(*) AS c FROM pomodoro_session WHERE completed = 1 AND substr(started_at, 1, 10) = ?"
    )
    .get(today()) as { m: number; c: number }
  return { minutes: Number(row?.m ?? 0), sessions: Number(row?.c ?? 0) }
}

/** 当前提醒策略（提前量 / 自动规则 / 重复次数），来自设置。 */
export function reminderPolicy(): ReminderPolicy {
  const s = currentSettings()
  return {
    leadMinutes: s.reminder_lead_minutes,
    forTimed: s.reminder_rule_due_time,
    forUntimed: s.reminder_rule_due_date,
    dayClock: s.reminder_day_clock,
    priorityMin: s.reminder_rule_priority_min,
    repeatCount: s.reminder_repeat_count,
    repeatIntervalMinutes: s.reminder_repeat_interval_minutes,
  }
}

/**
 * 到点提醒：按策略判定此刻该提醒哪些任务。
 *
 * 判据收在 shared/reminder.ts（纯函数，有单测）：基准时刻 = 手动设的提醒时刻，
 * 或由截止时间/日期推出的时刻；再按「提前量 + 已提醒次数 × 间隔」算触发点。
 * 这里只负责挑候选并过滤 —— 单条任务的全部判定都在那个纯函数里。
 */
export function dueReminders(now: Date = new Date()): Task[] {
  const policy = reminderPolicy()
  // 候选：非终态，且「有显式提醒时刻」或「有截止」（自动规则的来源）
  const rows = conn()
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM task
        WHERE deleted_at IS NULL
          AND status NOT IN ('done', 'abandoned', 'waiting')
          AND (reminder_at IS NOT NULL OR due_date IS NOT NULL)
        ORDER BY reminder_at ASC, due_date ASC`
    )
    .all() as Task[]
  return rows.filter((t) => decideReminder(t, policy, now).fire)
}

/**
 * 记一次提醒：写回已提醒次数与基准；次数用完就把**显式**的 reminder_at 清掉（一次性语义不变）。
 * 自动提醒（没有 reminder_at）靠次数停下，不需要清任何字段。
 */
export function recordReminderFire(id: number, fired: number, base: string, done: boolean): void {
  const c = conn()
  const row = c.prepare('SELECT reminder_at FROM task WHERE id = ?').get(id) as
    | { reminder_at: string | null }
    | undefined
  const clear = done && !!row?.reminder_at
  c.prepare(
    `UPDATE task SET reminder_fired = ?, reminder_base = ?, reminder_at = ?, updated_at = ? WHERE id = ?`
  ).run(fired, base, clear ? null : (row?.reminder_at ?? null), nowStamp(), id)
}

/**
 * 用户处理过了（知道了 / 查看）：清掉显式提醒时刻，并把计数推到「已用完」。
 *
 * 那个计数不能省：自动提醒（没有 reminder_at）没有字段可清，若不记「已处理」，
 * 下一轮会按剩余次数继续弹 —— 用户明明已经看过了。
 */
export function dismissReminder(taskId: number): Task | null {
  const t = getTask(taskId)
  if (!t) return null
  const policy = reminderPolicy()
  conn()
    .prepare(
      'UPDATE task SET reminder_at = NULL, reminder_fired = ?, reminder_base = ?, updated_at = ? WHERE id = ?'
    )
    .run(Math.max(1, policy.repeatCount), reminderBaseAt(t, policy), nowStamp(), taskId)
  return getTask(taskId)
}

/** 稍后提醒：从「现在或原定时刻」起顺延 N 分钟。 */
export function snoozeReminder(taskId: number, minutes: number): Task | null {
  const t = getTask(taskId)
  if (!t) return null
  const now = new Date()
  const original = t.reminder_at ? new Date(t.reminder_at.replace(' ', 'T')) : null
  const base = original && original.getTime() > now.getTime() ? original : now
  const next = new Date(base.getTime() + Math.max(1, Math.round(minutes)) * 60_000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())} ` +
    `${pad(next.getHours())}:${pad(next.getMinutes())}:${pad(next.getSeconds())}.000000`
  conn().prepare('UPDATE task SET reminder_at = ?, updated_at = ? WHERE id = ?').run(stamp, nowStamp(), taskId)
  return getTask(taskId)
}

/** 浮窗几何写入 ui_state.widget_geometry。 */
export function saveWidgetGeometry(x: number, y: number, w: number, h: number): void {
  try {
    if (!open()) return
    const c = conn()
    const row = c.prepare("SELECT value FROM settings WHERE key = 'ui_state'").get() as
      | { value: string }
      | undefined
    let state: Record<string, unknown> = {}
    try {
      state = JSON.parse(row?.value ?? '{}') as Record<string, unknown>
    } catch {
      state = {}
    }
    state.widget_geometry = [Math.round(x), Math.round(y), Math.round(w), Math.round(h)]
    c.prepare(
      "INSERT INTO settings (key, value) VALUES ('ui_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(JSON.stringify(state))
  } catch (err) {
    console.warn('[widget] 保存几何失败', err)
  }
}

/**
 * 悬浮球状态写入 ui_state.widget_ball：位置 / 球体边长 / 上次展开尺寸 / 当前是否球形态。
 * 与 widget_geometry 分开存 —— 收成球时不能覆盖展开几何，否则展开就还原不回去了。
 */
export function saveWidgetBall(ball: {
  x: number
  y: number
  size: number
  /** 悬浮球体型（bloub 的形状 id） */
  shape: string
  active: boolean
  expandedWidth: number
  expandedHeight: number
}): void {
  try {
    if (!open()) return
    const c = conn()
    const row = c.prepare("SELECT value FROM settings WHERE key = 'ui_state'").get() as
      | { value: string }
      | undefined
    let state: Record<string, unknown> = {}
    try {
      state = JSON.parse(row?.value ?? '{}') as Record<string, unknown>
    } catch {
      state = {}
    }
    state.widget_ball = ball
    c.prepare(
      "INSERT INTO settings (key, value) VALUES ('ui_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(JSON.stringify(state))
  } catch (err) {
    console.warn('[widget] 保存悬浮球状态失败', err)
  }
}


// ---------------------------------------------------------------- 首次启动种子数据

/** 欢迎笔记正文。 */
const WELCOME_NOTE = [
  '# 开始使用「知行」',
  '',
  '**任务与知识，一体两面。**',
  '',
  '- 输入 \`[[\` 可以链接到其他笔记，比如 [[开始使用「知行」]]',
  '- 按 \`Ctrl+K\` 打开命令面板，搜索一切',
  '- 按 \`Ctrl+Alt+N\` 快速捕获任务（支持 \`!2 @我的清单 #标签 明天\` 语法糖）',
  '- 按 \`Ctrl+Shift+S\` 在任何应用里划词捕获闪念',
  '- 打开「图谱」看你的知识网络生长',
  '',
  '> 数据全部保存在本机，随时可在设置中备份导出。',
  '',
].join('\n')

/**
 * 首次启动写入欢迎内容：
 * 任务表为空时建「工作 / 生活」两个分组 + 「我的清单」+ 2 条欢迎任务
 * （第一条为 P5 中等优先级）；笔记表为空时建一篇欢迎笔记。
 * 已有任意任务/笔记就不动，重复调用安全。只读模式不写。
 */
export function seedIfEmpty(): boolean {
  // 只读模式下不写盘
  if (dbReadonlyReason()) return false
  const c = conn()
  const count = (table: string): number =>
    (c.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  const hasTasks = count('task') > 0
  const hasNotes = count('note') > 0
  if (hasTasks && hasNotes) return false
  if (!hasTasks) {
    createListFolder('工作', 'group', null)
    createListFolder('生活', 'group', null)
    const list = createListFolder('我的清单', 'list', null)
    const first = createTask('欢迎使用知行：试试 Ctrl+Alt+N 快速添加任务', null, list.id)
    // 第一条欢迎任务用中等优先级 P5
    if (first) setPriority(first.id, 5)
    createTask('在笔记里输入 [[ 会弹出链接补全', null, list.id)
  }
  if (!hasNotes) createNote('开始使用「知行」', null, WELCOME_NOTE)
  return true
}

/** 供主进程读取配置（不经 IPC）；返回类型化设置，避免各处再各自转字符串。 */
export function currentSettings(): AppSettings {
  try {
    return open() ? parseSettings(listSettings()) : parseSettings()
  } catch {
    return parseSettings()
  }
}
