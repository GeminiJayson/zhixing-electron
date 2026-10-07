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

/**
 * 触发条件：任务进入某状态 / 目录里出现文件 / 剪贴板出现匹配文本 / 外部 HTTP 调用。
 *
 * 四种触发都存同一张数组里（workflow_template.triggers），谁先命中都启动同一个流程 ——
 * 「怎么被拉起来」不影响流程怎么跑，只影响实例上的 trigger_kind 记账。
 */
export interface WorkflowTrigger {
  kind: 'task_status' | 'http' | 'folder' | 'clipboard'
  /** task_status：盯哪个任务 */
  taskId?: number
  /** task_status：它进入哪个状态时触发 */
  status?: string
  /** http：这个触发源的令牌（URL 里带着它，用来防误触发） */
  token?: string
  /** folder：盯哪个目录（绝对路径） */
  path?: string
  /** folder：文件名通配（如 *.md），留空 = 任何文件；clipboard：要匹配的文本 */
  pattern?: string
  /** clipboard：pattern 怎么解释，默认 contains（包含即触发） */
  mode?: 'contains' | 'regex'
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
        if (o.kind === 'folder') {
          const path = String(o.path ?? '').trim()
          // 没选目录的文件夹触发什么都不盯 —— 留着一个永远不响的条件比丢掉更糟
          if (!path) return null
          // 通配串只用来比文件名，限个长度免得把一整篇文本误当模式贴进来
          const pattern = String(o.pattern ?? '').trim().slice(0, 120)
          return { kind: 'folder', path, pattern }
        }
        if (o.kind === 'clipboard') {
          const pattern = String(o.pattern ?? '').trim()
          // 空模式的剪贴板触发意味着"复制任何东西都启动流程"，直接丢掉
          if (!pattern) return null
          // 上限 200 字符：再长的模式只可能是误贴，而每复制一次都要跑一遍它
          if (pattern.length > 200) return null
          const mode = o.mode === 'regex' ? 'regex' : 'contains'
          // 正则模式在这里先编译一次：写坏了就在保存时丢掉，
          // 而不是等用户复制东西时每次都静默失败（那种失败没人看得见）
          if (mode === 'regex') {
            try {
              new RegExp(pattern)
            } catch {
              return null
            }
          }
          return { kind: 'clipboard', pattern, mode }
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
  return list.map(describeTrigger).join(' · ')
}

export function describeTrigger(t: WorkflowTrigger): string {
  if (t.kind === 'task_status') return `任务 #${t.taskId} 变成「${t.status}」`
  if (t.kind === 'http') return '外部 HTTP 调用'
  if (t.kind === 'folder') return `目录 ${t.path} 出现 ${t.pattern || '任何文件'}`
  return `剪贴板${t.mode === 'regex' ? '匹配正则' : '包含'}「${t.pattern}」`
}

/**
 * 文件名通配：只支持 `*` 与 `?`，大小写不敏感。
 *
 * 不直接收正则：这个框是给"我要盯 *.md"用的，让用户为正则转义头疼没有收益；
 * 真要复杂匹配，剪贴板触发那条给了正则模式。
 */
export function matchFileName(name: string, pattern: string): boolean {
  const p = pattern.trim()
  if (!p) return true
  const rx = new RegExp(
    '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    'i'
  )
  return rx.test(name)
}

/**
 * 这个文件名值不值得触发。
 *
 * 编辑器保存不是一次原子写：Office 会先落 `~$xxx.docx`、vim 会落 `.x.swp`、
 * 很多工具用 `.tmp` 中转。这些中间文件也出现在目录里，
 * 不挡掉的话"保存一次文档"会触发两三次流程。
 */
export function isWatchedFileName(name: string): boolean {
  if (!name || name.startsWith('.')) return false
  if (name.startsWith('~$') || name.endsWith('~')) return false
  const lower = name.toLowerCase()
  return !lower.endsWith('.tmp') && !lower.endsWith('.swp') && !lower.endsWith('.part')
}

/** 剪贴板文本命中这个触发吗（只处理 clipboard 类型） */
export function matchesClipboard(t: WorkflowTrigger, text: string): boolean {
  if (t.kind !== 'clipboard' || !text) return false
  const p = (t.pattern ?? '').trim()
  if (!p) return false
  if (t.mode === 'regex') {
    try {
      return new RegExp(p, 'i').test(text)
    } catch {
      return false
    }
  }
  return text.toLowerCase().includes(p.toLowerCase())
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
