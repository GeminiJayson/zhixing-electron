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

/**
 * 把结构化规则拼回 RRULE 串 —— parseRRule 的逆运算。
 *
 * 有了它，界面才能"只让人做选择、不让人写字符串"：控件改的是这几个字段，
 * 串由这里统一生成。两边成对存在，改一边必须改另一边，所以放在同一个文件里。
 */
export function formatRRule(info: RRule): string {
  const parts = [`FREQ=${info.freq.toUpperCase()}`, `INTERVAL=${Math.max(1, info.interval)}`]
  if (info.count != null) parts.push(`COUNT=${Math.max(0, info.count)}`)
  if (info.until) parts.push(`UNTIL=${info.until.replace(/-/g, '')}`)
  return parts.join(';')
}

/** 规则的人话描述（界面上跟 RRULE 串并排显示，让用户对得上自己选了什么） */
export function describeRRule(info: RRule): string {
  const n = Math.max(1, info.interval)
  const unit = info.freq === 'daily' ? '天' : info.freq === 'weekly' ? '周' : '个月'
  const head = n === 1 ? `每${unit}` : `每 ${n} ${unit}`
  if (info.count != null) return `${head}，共 ${info.count} 次`
  if (info.until) return `${head}，直到 ${info.until}`
  return `${head}，一直重复`
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
 *
 * **结束条件是"循环的终点"，对所有档位一视同仁。** 早先只有 `custom` 档位读 `repeat_rule`：
 * 选「每日 / 每周 / 每月」时界面会把规则串清成 null，用户在界面上根本没有"结束"可设，
 * 于是勾一次生成一期、永远停不下来（用户报的「截止时间不生效、一直往后延、无限生成」）。
 * 现在档位只决定**周期**，`repeat_rule` 里的 COUNT / UNTIL 一律照办。
 */
export function nextRecurrence(task: RecurrenceSource, today: string): [string | null, string | null] {
  if (task.repeat_period === 'none') return [null, null]
  /**
   * 基准是**完成日**（`today`），不是这一期的截止日。
   *
   * 两个理由：
   * ① 截止日在循环任务里兼任**终点**（"到了那天就别再生成"，见 TaskEditor 保存时的）
   *    ——若拿它当基准，下一期必然越过终点，循环只能生效一次；
   * ② 用截止日推会**追补**：10-13 的每日任务拖到 10-16 才勾，会一口气冒出 10-14、10-15、
   *    10-16 三条逾期任务（实测）。按完成日推则只有一条。
   */
  const base = today
  const nd = nextDue(base, task.repeat_period, task.repeat_rule)
  if (nd === null) return [null, null]
  const info = parseRRule(task.repeat_rule)
  // UNTIL 含当天（这一期就落在终点那天，接着停）
  if (info?.until && nd > info.until) return [null, null]
  // 只有**带 COUNT** 时才递减：nextCountRule 对"没有规则"也返回 null，
  // 不先判一下就会把"一直重复"误当成"次数用完"
  if (info?.count != null) {
    const rule = nextCountRule(task.repeat_rule)
    if (rule === null) return [null, null]
    return [nd, rule]
  }
  return [nd, task.repeat_rule]
}

/**
 * 只带"结束条件"的规则串 —— 非 custom 档位存的就是这种。
 *
 * 频率与间隔已经由 `repeat_period` 表达，再往串里写 FREQ/INTERVAL 就是两处口径，
 * 迟早对不上（早先正是因此把整串清空，连结束条件一起丢了）。
 */
export function formatEndRule(info: Pick<RRule, 'count' | 'until'>): string {
  const parts: string[] = []
  if (info.count != null) parts.push(`COUNT=${Math.max(0, info.count)}`)
  if (info.until) parts.push(`UNTIL=${info.until.replace(/-/g, '')}`)
  return parts.join(';')
}

/**
 * 落库用的循环规则串 —— 任务编辑器保存时调它。
 *
 * 两条规则：
 * ① 非自定义档位只写**结束条件**（COUNT / UNTIL）—— 周期由 `repeat_period` 表达，
 *    写第二遍迟早对不上；早先这里一律清成 null，选「每日」的用户设的结束条件当场被丢掉。
 * ② **截止日顺带当循环终点**：循环任务只要填了截止日、又没显式设结束条件，就把它写成
 *    UNTIL，于是"到了那天就别再生成"。用户不必在「截止日」和「结束」里填两遍同一个日期。
 */
export function saveRule(opts: { period: RepeatPeriod; rule: string; due: string | null }): string | null {
  if (opts.period === 'none') return null
  const info = parseRRule(opts.rule) ?? { freq: 'daily', interval: 1, count: null, until: null }
  const end =
    info.count == null && info.until == null && opts.due
      ? { count: null, until: opts.due }
      : { count: info.count, until: info.until }
  return opts.period === 'custom' ? formatRRule({ ...info, ...end }) : formatEndRule(end) || null
}

/**
 * 循环子任务跨天重置：该重置就返回这一期的截止日与新的规则串，否则返回 null。
 *
 * 四种"不动它"：不是循环任务、还没到下一期、UNTIL 已过、COUNT 用完。
 * `base` 取 `last_reset_date ?? due_date`：相位以"上一期"为准，不用今天，
 * 否则每次跨天都会把周期重新起算一遍。
 */
export function rollRecurrence(
  task: RecurrenceSource & { last_reset_date?: string | null },
  day: string
): { due: string; rule: string | null } | null {
  if (task.repeat_period === 'none') return null
  const base = task.last_reset_date ?? task.due_date ?? day
  const due = nextDue(base, task.repeat_period, task.repeat_rule)
  if (due === null) return null
  // 还没到下一期：今天不该做，原样留着
  if (due > day) return null
  const info = parseRRule(task.repeat_rule)
  if (info?.until && day > info.until) return null
  // 同上：没有 COUNT 就不是"次数用完"
  let rule = task.repeat_rule
  if (info?.count != null) {
    rule = nextCountRule(task.repeat_rule)
    if (rule === null) return null
  }
  // 重置后"今天就该做"：截止日落在今天，而不是算出来那个已经过去的日子
  // （否则界面上会显示成逾期）。下一次的相位从今天重新起算。
  return { due: day, rule }
}
