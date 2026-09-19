/**
 * 步骤动作（一个节点「怎么才算做完」）：任务 / 命令 / 脚本。
 *
 * 主进程执行、渲染层编辑，两端共用同一份定义。参数存在 workflow_node 的
 * action_value（命令文本 / 脚本内容），期望退出码存在 action_expect。
 *
 * 为什么要分三类而不是像早先那样把「打开网址 / 打开笔记」也算动作：
 *   task    —— 实例化时**生成待办任务项**，等人勾选完成（人做的事）
 *   command —— 不生成待办，直接跑一条命令并**等待它退出**，退出码 == 期望才算完成
 *   script  —— 同上，但跑的是脚本内容（Windows 走 PowerShell）
 *
 * 后两类的「等待」是硬要求：节点不在进程发出的瞬间就标完成，而是等它真的结束、
 * 核对返回值之后再推进 —— 只有这样，紧随其后的条件判断才拿得到可信的结果。
 */

export const TASK_KIND = 'task'
export const COMMAND_KIND = 'command'
export const SCRIPT_KIND = 'script'

/** 归一后的动作类型（库里的历史值不在此列，见 normalizeActionKind）。 */
export type StepActionKind = 'task' | 'command' | 'script'

/** 三类动作的界面文案与说明（编辑弹窗的下拉与提示共用）。 */
export const STEP_ACTION_KINDS: { value: StepActionKind; label: string; hint: string }[] = [
  { value: TASK_KIND, label: '任务', hint: '实例化时生成一条待办任务，人工完成后自动推进' },
  { value: COMMAND_KIND, label: '命令', hint: '直接执行一条命令并等待退出，退出码正确才算完成' },
  { value: SCRIPT_KIND, label: '脚本', hint: '执行一段脚本（Windows 走 PowerShell）并等待退出码' },
]

/**
 * 历史动作值 —— 编辑器不再提供，但旧模板里可能还存着，必须继续能跑、能看懂。
 * 它们此前都会生成待办（只有条件节点是例外），所以归一后一律并入 task，
 * 浮卡上的「执行动作」按钮也照旧可用。
 *
 * `none` / 空值**不算历史动作**：它们本来就等价于「任务」，是旧库里的默认值，
 * 把它们也标成历史会让几乎每个旧步骤都挂一条莫名其妙的提示。
 */
export const LEGACY_ACTION_LABELS: Record<string, string> = {
  open_url: '打开网址',
  open_note: '打开笔记',
  run_command: '执行命令（发完即忘，不等待）',
}

/** 判据：编辑器要不要把它当「历史值」另作提示（'none' / 空值不算，它们就是任务）。 */
export function isLegacyActionKind(raw: string | null | undefined): boolean {
  const k = (raw ?? '').trim()
  if (!k || k === 'none') return false
  return k !== TASK_KIND && k !== COMMAND_KIND && k !== SCRIPT_KIND
}

/**
 * 把库里的 action_kind 归一到三类。
 * 空值、'none'、'open_url'、'open_note'、'run_command' 一律 = task：
 * 它们此前的实际行为就是「派一条待办 + 浮卡上手动触发动作」。
 */
export function normalizeActionKind(raw: string | null | undefined): StepActionKind {
  const k = (raw ?? '').trim()
  if (k === COMMAND_KIND) return COMMAND_KIND
  if (k === SCRIPT_KIND) return SCRIPT_KIND
  return TASK_KIND
}

/** 自动执行型（命令 / 脚本）：不派待办，执行完自行推进。 */
export function isAutoActionKind(raw: string | null | undefined): boolean {
  const k = normalizeActionKind(raw)
  return k === COMMAND_KIND || k === SCRIPT_KIND
}

/** 期望退出码的默认值。 */
export const DEFAULT_EXPECT_CODE = 0

/** 解析期望退出码：空 / 非数字都回落到 0（默认「成功」）。 */
export function parseExpectCode(raw: string | number | null | undefined): number {
  if (raw == null || raw === '') return DEFAULT_EXPECT_CODE
  const n = Number(raw)
  return Number.isFinite(n) ? n : DEFAULT_EXPECT_CODE
}

/** 动作类型的中文名（画布标签、说明文字用）。 */
export function actionKindLabel(raw: string | null | undefined): string {
  const k = (raw ?? '').trim()
  if (k === 'condition') return '条件'
  if (isLegacyActionKind(k)) return LEGACY_ACTION_LABELS[k] ?? '历史动作'
  return STEP_ACTION_KINDS.find((a) => a.value === normalizeActionKind(k))?.label ?? '任务'
}
