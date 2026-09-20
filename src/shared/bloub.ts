/**
 * bloub 悬浮球可选的**体型**与默认值。
 *
 * 放在 shared 是因为两边都要用：主进程据此构建右键菜单，渲染层据此把选中的体型交给引擎。
 * id 与 vendor/bloub/bot/skins.ts 的 SHAPES 一一对应 —— 上游若改名而这里没跟上，菜单选了
 * 只会静默回落到默认形状，所以配了单测盯着这件事。
 */

export interface BloubShape {
  id: string
  label: string
}

/** 8 种体型，顺序沿用上游 `SHAPES`（圆 → 鹅卵石 → … → 水滴）。 */
export const BLOUB_SHAPES: BloubShape[] = [
  { id: 'cercle', label: '圆' },
  { id: 'galet', label: '鹅卵石' },
  { id: 'squircle', label: '方圆' },
  { id: 'capsule', label: '胶囊' },
  { id: 'triangle', label: '三角' },
  { id: 'hexagone', label: '六边形' },
  { id: 'nuage', label: '云朵' },
  { id: 'goutte', label: '水滴' },
]

/** 与上游 skins.ts 的 DEFAULT_SHAPE 一致。 */
export const BLOUB_DEFAULT_SHAPE = 'cercle'

/** 认不出来的值一律回落到默认：旧配置里存过某个后来被上游删掉的形状时也不至于崩。 */
export function normalizeBloubShape(raw: string | null | undefined): string {
  return BLOUB_SHAPES.some((s) => s.id === raw) ? (raw as string) : BLOUB_DEFAULT_SHAPE
}
