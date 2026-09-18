/**
 * 优先级 8 档的共享 UI 语义，与 zhixing/view/kit/priority.py 逐值对齐。
 *
 * 档位 = int(priority)：0 无 · P1..P8（数字越大优先级越高）。
 * 色阶自 v0.17.1 起为固定「绿 → 黄 → 橙 → 红」高辨识色，**不随主题派生**，
 * 深/浅主题与各主题包下都必须一致可读。
 */

/** NONE 用的中性灰 */
export const PRIORITY_NONE_COLOR = '#8A9BA8'

/** 下标即档位；[0] 为 NONE */
export const PRIORITY_SCALE: readonly string[] = [
  PRIORITY_NONE_COLOR,
  '#2E9E5B', // P1 绿
  '#2BAE4F', // P2 亮绿
  '#5BA83A', // P3 草绿
  '#8F9E1D', // P4 橄榄黄绿
  '#C08A00', // P5 深琥珀
  '#E67E00', // P6 橙
  '#E8402E', // P7 红橙
  '#C81E1E', // P8 深红
]

export const PRIORITY_CHOICES: readonly { value: number; label: string }[] = [
  { value: 0, label: '无' },
  ...Array.from({ length: 8 }, (_, i) => ({ value: i + 1, label: `P${i + 1}` })),
]

export function clampPriority(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(8, Math.max(0, Math.trunc(value)))
}

export function priorityLabel(priority: number): string {
  const v = clampPriority(priority)
  return v === 0 ? '无' : `P${v}`
}

export function priorityColor(priority: number): string {
  return PRIORITY_SCALE[clampPriority(priority)]
}

/** Eisenhower「重要」判定：≥ P5 */
export function isImportant(priority: number): boolean {
  return clampPriority(priority) >= 5
}
