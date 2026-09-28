/**
 * 步骤的日志规则：用关键字匹配决定「这一步算不算成功」，以及要不要替用户回答。
 *
 * 为什么需要它：命令/脚本的退出码并不总能说明问题 ——
 * 有的工具失败也返回 0、有的把结论写在日志里（`BUILD SUCCESS` / `ERROR`）、
 * 有的跑一半停下来问 `(y/n)`。这三件事退出码都表达不了。
 *
 * 存在 workflow_node.log_rules 里（JSON 字符串），空 = 只认退出码，行为与从前一致。
 */
/** 命中后的判定：ok=算成功 / fail=算失败 / wait_input=需要输入（并自动回答，不改变成败） */
export type LogRuleResult = 'ok' | 'fail' | 'wait_input'

export interface LogRule {
  /** 关键字（contains）或正则（regex） */
  pattern: string
  mode: 'contains' | 'regex'
  result: LogRuleResult
  /** 命中时显示给用户的说明 */
  message?: string
  /** result=wait_input 时写进 stdin 的内容；字面 \n / \r 会被还原成真换行 */
  reply?: string
}

export interface LogRules {
  rules: LogRule[]
  /** 判定口径：exit=只看退出码（默认）/ log=只看日志 / both=日志优先、无命中退回退出码 */
  judge: 'exit' | 'log' | 'both'
}

const MODES = new Set(['contains', 'regex'])
const RESULTS = new Set<LogRuleResult>(['ok', 'fail', 'wait_input'])
const JUDGES = new Set(['exit', 'log', 'both'])

/** 默认：不看日志，只认退出码 —— 与加这个功能之前的行为完全一致 */
export const DEFAULT_LOG_RULES: LogRules = { rules: [], judge: 'exit' }

function oneRule(raw: unknown): LogRule | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const pattern = typeof r.pattern === 'string' ? r.pattern : ''
  if (!pattern) return null
  const mode = MODES.has(String(r.mode)) ? (String(r.mode) as LogRule['mode']) : 'contains'
  const result = RESULTS.has(String(r.result) as LogRuleResult)
    ? (String(r.result) as LogRuleResult)
    : 'fail'
  return {
    pattern,
    mode,
    result,
    message: typeof r.message === 'string' ? r.message : '',
    reply: typeof r.reply === 'string' ? r.reply : '',
  }
}

/** 解析 node.log_rules。坏数据一律退回默认（只认退出码），不让一条烂配置把步骤卡死 */
export function parseLogRules(raw: string | null | undefined): LogRules {
  if (!raw) return { ...DEFAULT_LOG_RULES }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_LOG_RULES }
    const obj = parsed as Record<string, unknown>
    const rules = Array.isArray(obj.rules)
      ? obj.rules.map(oneRule).filter((r): r is LogRule => r !== null)
      : []
    const judgeRaw = String(obj.judge ?? 'exit')
    const judge = JUDGES.has(judgeRaw) ? (judgeRaw as LogRules['judge']) : 'exit'
    return { rules, judge }
  } catch {
    return { ...DEFAULT_LOG_RULES }
  }
}

export function serializeLogRules(rules: LogRules): string {
  const clean = rules.rules.map(oneRule).filter((r): r is LogRule => r !== null)
  const judge = JUDGES.has(rules.judge) ? rules.judge : 'exit'
  // 全空就存空串：读回时走默认分支，与「从没配过」完全同构
  if (!clean.length && judge === 'exit') return ''
  return JSON.stringify({ rules: clean, judge })
}

/** 卡片/详情里的一行说明；没配规则时返回空串，调用方据此不显示这一行 */
export function describeLogRules(rules: LogRules): string {
  if (!rules.rules.length) return ''
  const judge = rules.judge === 'log' ? '只看日志' : rules.judge === 'both' ? '日志优先' : '仅退出码'
  return judge + ' · ' + rules.rules.length + ' 条关键字'
}

export interface LogMatch {
  rule: LogRule
  /** 实际命中的那段文本（正则场景下方便用户核对） */
  hit: string
}

/**
 * 在日志里按顺序找第一条命中的规则。
 *
 * **顺序即优先级**：用户把 `ERROR` 排在 `SUCCESS` 前面，就表示"同时出现时按失败算"。
 * 正则非法时跳过那一条而不是整体失败 —— 一条写错的正则不该让这一步直接报错。
 */
export function matchLogRules(rules: LogRules, text: string): LogMatch | null {
  if (!text) return null
  for (const rule of rules.rules) {
    if (rule.mode === 'contains') {
      const at = text.toLowerCase().indexOf(rule.pattern.toLowerCase())
      if (at >= 0) return { rule, hit: text.slice(at, at + rule.pattern.length) }
      continue
    }
    try {
      const re = new RegExp(rule.pattern, 'i')
      const m = re.exec(text)
      if (m) return { rule, hit: m[0] }
    } catch {
      // 正则写坏了就跳过这一条
    }
  }
  return null
}

/** 把配置里的 \\n 还原成真换行 —— 用户没法在单行输入框里直接敲回车 */
export function decodeReply(reply: string | undefined): string {
  return (reply ?? '').replace(/\\r/g, '\r').replace(/\\n/g, '\n')
}
