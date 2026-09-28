/**
 * 工作流的「什么时候自己跑起来」：定时计划 + 触发条件。
 *
 * 两者都存 JSON 字符串在 workflow_template 上（模板级，不是实例级）——
 * 实例是"跑起来的那一次"，而"每天九点跑"描述的是模板本身。
 *
 * 与条件节点（工作流**内部**的关卡）分开：那是流程走到某一步时的判断，
 * 这是流程根本还没开始时的入口。两件事分开放，才不至于让一个字段身兼两职。
 */

/** 定时计划：手动 / 每隔 N 分钟 / 每天某时刻。 */
export interface WorkflowSchedule {
  kind: 'manual' | 'interval' | 'daily'
  /** interval：每多少分钟跑一次（最小 1） */
  everyMin?: number
  /** daily：HH:MM，24 小时制 */
  at?: string
}

/** 触发条件：任务进入某状态 / 外部 HTTP 调用。 */
export interface WorkflowTrigger {
  kind: 'task_status' | 'http'
  /** task_status：盯哪个任务 */
  taskId?: number
  /** task_status：它进入哪个状态时触发 */
  status?: string
  /** http：这个触发源的令牌（URL 里带着它，用来防误触发） */
  token?: string
}

export const DEFAULT_SCHEDULE: WorkflowSchedule = { kind: 'manual' }

/** 一天里的分钟数，用于 daily 的比较 */
const toMinutes = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

export function parseSchedule(raw: string | null | undefined): WorkflowSchedule {
  if (!raw) return { ...DEFAULT_SCHEDULE }
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object') return { ...DEFAULT_SCHEDULE }
    const o = v as Record<string, unknown>
    const kind = o.kind === 'interval' || o.kind === 'daily' ? o.kind : 'manual'
    if (kind === 'interval') {
      const n = Math.floor(Number(o.everyMin))
      // 小于 1 分钟的计划没有意义，还会把调度器变成忙等
      if (!Number.isFinite(n) || n < 1) return { ...DEFAULT_SCHEDULE }
      return { kind, everyMin: Math.min(n, 24 * 60) }
    }
    if (kind === 'daily') {
      const at = String(o.at ?? '')
      if (toMinutes(at) === null) return { ...DEFAULT_SCHEDULE }
      return { kind, at }
    }
    return { ...DEFAULT_SCHEDULE }
  } catch {
    return { ...DEFAULT_SCHEDULE }
  }
}

export function serializeSchedule(s: WorkflowSchedule): string {
  if (s.kind === 'manual') return ''
  if (s.kind === 'interval') {
    const n = Math.floor(Number(s.everyMin))
    if (!Number.isFinite(n) || n < 1) return ''
    return JSON.stringify({ kind: 'interval', everyMin: Math.min(n, 24 * 60) })
  }
  if (toMinutes(s.at ?? '') === null) return ''
  return JSON.stringify({ kind: 'daily', at: s.at })
}

export function describeSchedule(s: WorkflowSchedule): string {
  if (s.kind === 'interval') return `每 ${s.everyMin} 分钟`
  if (s.kind === 'daily') return `每天 ${s.at}`
  return '手动'
}

export function parseTriggers(raw: string | null | undefined): WorkflowTrigger[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v
      .map((x): WorkflowTrigger | null => {
        if (!x || typeof x !== 'object') return null
        const o = x as Record<string, unknown>
        if (o.kind === 'task_status') {
          const taskId = Math.floor(Number(o.taskId))
          if (!Number.isFinite(taskId) || taskId <= 0) return null
          return { kind: 'task_status', taskId, status: String(o.status ?? 'done') }
        }
        if (o.kind === 'http') {
          const token = String(o.token ?? '').trim()
          // 没有令牌的 HTTP 触发等于"谁都能启动我的流程"，直接丢掉
          if (!token) return null
          return { kind: 'http', token }
        }
        return null
      })
      .filter((t): t is WorkflowTrigger => t !== null)
  } catch {
    return []
  }
}

export function serializeTriggers(list: WorkflowTrigger[]): string {
  const clean = parseTriggers(JSON.stringify(list))
  return clean.length ? JSON.stringify(clean) : ''
}

export function describeTriggers(list: WorkflowTrigger[]): string {
  if (!list.length) return ''
  return list
    .map((t) => (t.kind === 'task_status' ? `任务 #${t.taskId} 变成「${t.status}」` : '外部 HTTP 调用'))
    .join(' · ')
}

/**
 * 这一刻该不该按 interval 计划触发。
 *
 * 纯函数：只做"距上次触发够不够久"的判断，不碰数据库也不碰时钟之外的东西。
 * lastAt 为 null（从没跑过）时立即触发 —— 新建的计划不该等一个周期才开始生效。
 */
export function dueByInterval(s: WorkflowSchedule, lastAt: number | null, now: number): boolean {
  if (s.kind !== 'interval' || !s.everyMin) return false
  if (lastAt === null) return true
  return now - lastAt >= s.everyMin * 60_000
}

/**
 * 这一刻该不该按 daily 计划触发。
 *
 * 判断"今天该跑的那一分钟是否已经过去、且今天还没跑过"——
 * 应用可能不是整点启动的，错过那一分钟（比如 09:00 时应用没开、09:30 才打开）
 * 就不该再补跑：用户要的是"每天九点"，不是"开机就补一次"。
 */
export function dueByDaily(s: WorkflowSchedule, lastAt: number | null, now: Date): boolean {
  if (s.kind !== 'daily' || !s.at) return false
  const target = toMinutes(s.at)
  if (target === null) return false
  const nowMin = now.getHours() * 60 + now.getMinutes()
  // 只认「当前这一分钟正好到点」：调度器每分钟扫一次，误差不超过一分钟
  if (nowMin !== target) return false
  if (lastAt === null) return true
  const last = new Date(lastAt)
  const sameDay =
    last.getFullYear() === now.getFullYear() &&
    last.getMonth() === now.getMonth() &&
    last.getDate() === now.getDate()
  return !sameDay
}

/** 生成一个 HTTP 触发用的令牌（够长、URL 安全） */
export function makeTriggerToken(): string {
  const bytes = new Uint8Array(16)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}
