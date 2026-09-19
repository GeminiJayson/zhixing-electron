/**
 * 条件节点的配置：主进程求值、渲染层编辑，两端共用同一份定义。
 *
 * 存在 workflow_node.action_value 里（JSON 字符串），action_kind 固定为 'condition'。
 * 复用它而不是新增字段：action_kind / action_value 本来就是自由字符串，
 * 加个枚举值不必动 schema，也就不会影响与 Python 版共用的库。
 */

/** 条件节点的 action_kind。 */
export const CONDITION_KIND = 'condition'

/** 注入条件的来源。 */
export type ConditionSource = 'confirm' | 'task' | 'script'

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
}

/** 各来源的中文名（下拉与描述共用）。 */
export const CONDITION_SOURCES: { value: ConditionSource; label: string; hint: string }[] = [
  { value: 'confirm', label: '提示确认', hint: '弹出确认框，用户选「是」则条件成立' },
  { value: 'task', label: '任务状态', hint: '按某个任务是否已完成来判定' },
  { value: 'script', label: '脚本返回状态', hint: '运行脚本并比较退出码（不经 shell，有 15s 超时）' },
]

/** 解析 action_value 里的条件 JSON；坏数据一律返回 null，不抛。 */
export function parseCondition(raw: string | null | undefined): ConditionConfig | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as ConditionConfig
    if (!v || typeof v !== 'object') return null
    if (v.kind !== 'confirm' && v.kind !== 'task' && v.kind !== 'script') return null
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
  return `脚本返回：${cfg.command?.trim() || '（未写命令）'}，退出码 = ${cfg.expectCode ?? 0}`
}
