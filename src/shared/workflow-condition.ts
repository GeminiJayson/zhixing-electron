/**
 * 条件节点的配置：主进程求值、渲染层编辑，两端共用同一份定义。
 *
 * 存在 workflow_node.action_value 里（JSON 字符串），action_kind 固定为 'condition'。
 * 复用它而不是新增字段：action_kind / action_value 本来就是自由字符串，
 * 加个枚举值不必动 schema，也就不会影响与 Python 版共用的库。
 */

import type { NodeRunResult } from './types'

/** 条件节点的 action_kind。 */
export const CONDITION_KIND = 'condition'

/** 注入条件的来源。 */
export type ConditionSource = 'confirm' | 'task' | 'script' | 'prev'

/** 条件节点的配置。 */
export interface ConditionConfig {
  kind: ConditionSource
  /** confirm：给用户看的提示文案 */
  prompt?: string
  /** task：判定哪个任务 */
  taskId?: number
  /** task：期望它「已完成」还是「未完成」（默认已完成） */
  expectDone?: boolean
  /** script：要运行的命令（按 shlex 规则拆 argv，不经 shell） */
  command?: string
  /** script：期望的退出码（默认 0） */
  expectCode?: number
  /** prev：期望上一步「成功」还是「失败」（默认成功） */
  expectOk?: boolean
}

/** 各来源的中文名（下拉与描述共用）。 */
export const CONDITION_SOURCES: { value: ConditionSource; label: string; hint: string }[] = [
  { value: 'confirm', label: '提示确认', hint: '弹出确认框，用户选「是」则条件成立' },
  { value: 'task', label: '任务状态', hint: '按某个任务是否已完成来判定' },
  { value: 'script', label: '脚本返回状态', hint: '运行脚本并比较退出码（不经 shell，有 15s 超时）' },
  {
    value: 'prev',
    label: '上一步结果',
    hint: '取紧邻的上一个执行节点的返回值来判定（命令/脚本看退出码，任务看是否完成）',
  },
]

/**
 * 「上一步结果」的判定。
 *
 * 抽成纯函数而不是留在主进程分支里，有两个原因：
 *   1. 它读的是实例上下文里的返回值，逻辑本身与 Electron / 数据库无关，可以单测；
 *   2. 期望退出码与「期望成功/失败」互斥的优先级只该有一处定义
 *      （填了退出码就按退出码判，没填才看成功与否）。
 */
export function judgePrevResult(
  cfg: ConditionConfig,
  last: NodeRunResult | null | undefined
): { ok: boolean; message: string } {
  if (!last) return { ok: false, message: '上一步还没有可用的执行结果' }
  if (last.state === 'running') return { ok: false, message: '上一步还在运行中' }
  const expectCode = Number.isFinite(cfg.expectCode) ? Number(cfg.expectCode) : null
  if (expectCode != null) {
    return {
      ok: last.code === expectCode,
      message: `上一步退出码 ${last.code ?? '无'}（期望 ${expectCode}）`,
    }
  }
  const expectOk = cfg.expectOk !== false
  const actualOk = last.state === 'ok'
  return {
    ok: actualOk === expectOk,
    message: `上一步${actualOk ? '成功' : '失败'}（${last.message}），期望${expectOk ? '成功' : '失败'}`,
  }
}

/** 解析 action_value 里的条件 JSON；坏数据一律返回 null，不抛。 */
export function parseCondition(raw: string | null | undefined): ConditionConfig | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as ConditionConfig
    if (!v || typeof v !== 'object') return null
    if (v.kind !== 'confirm' && v.kind !== 'task' && v.kind !== 'script' && v.kind !== 'prev')
      return null
    return v
  } catch {
    return null
  }
}

/** 序列化回 action_value。 */
export function serializeCondition(cfg: ConditionConfig): string {
  return JSON.stringify(cfg)
}

/** 条件的可读描述（编辑弹窗的预览、浮卡、连线标签都可能用）。 */
export function describeCondition(raw: string | null | undefined): string {
  const cfg = parseCondition(raw)
  if (!cfg) return '未配置条件'
  if (cfg.kind === 'confirm') return `人工确认：${cfg.prompt?.trim() || '（未写提示）'}`
  if (cfg.kind === 'task')
    return `任务状态：任务 #${cfg.taskId ?? '?'} ${cfg.expectDone === false ? '未完成' : '已完成'}`
  if (cfg.kind === 'prev') {
    const code = Number.isFinite(cfg.expectCode) ? `退出码 = ${Number(cfg.expectCode)}` : ''
    const ok = cfg.expectOk === false ? '失败' : '成功'
    return `上一步结果：${ok}${code ? '、' + code : ''}`
  }
  return `脚本返回：${cfg.command?.trim() || '（未写命令）'}，退出码 = ${cfg.expectCode ?? 0}`
}
