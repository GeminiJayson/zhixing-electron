/**
 * 颜色工具：对比度校正。
 *
 * 为什么需要：主题包的 fg2/fg3 是按观感调的柔和色，对 canvas / layer 的对比度
 * 大量落在 2.4–4.5 之间（实测 168 组里 74 组不达标，辅助文字最低只有 2.36:1）。
 * 因此在应用主题时按固定下限（fg2 ≥4.5、fg3 ≥4.0）做运行时校正，
 * 而不是手改 168 个色值。
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** #RRGGBB → 0-255 分量；非 6 位十六进制返回 null（rgba() 之类的值直接跳过）。 */
export function parseHex(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{6})$/i.exec((hex ?? '').trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}

export function toHex({ r, g, b }: Rgb): string {
  const h = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
  return '#' + h(r) + h(g) + h(b)
}

/** WCAG 2.1 相对亮度。 */
export function relativeLuminance(hex: string): number {
  const c = parseHex(hex)
  if (!c) return 0
  const f = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}

/** WCAG 2.1 对比度，取值 1–21。 */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** 浅底上用的正文色 / 深底上用的正文色；标签胶囊的实心底色靠它保证字看得见。 */
const INK_ON_LIGHT = '#111827'
const INK_ON_DARK = '#f8fafc'

/**
 * 给定底色，返回压在上面更可读的那个正文色（深字或浅字）。
 *
 * 标签颜色由用户自选，可能很浅（#FDE047）也可能很深（#111827）；胶囊把它当实心
 * 背景用时，文字色必须跟着翻面，否则「自定义颜色」会直接变成「看不见的标签」。
 *
 * 判据用**两个候选色的实际对比度取更优**，而不是「亮度过某个阈值就翻面」：
 * 中间亮度的底色（例如青色 #0D9488，亮度 0.23）在阈值法下会选到浅字，
 * 而那里的浅字只有 3.6:1、深字反而有 4.6:1。
 */
export function inkOn(hex: string): string {
  if (!parseHex(hex)) return INK_ON_DARK
  return contrastRatio(INK_ON_LIGHT, hex) >= contrastRatio(INK_ON_DARK, hex)
    ? INK_ON_LIGHT
    : INK_ON_DARK
}

/**
 * 标签调色板的 12 个预设色。
 *
 * 每个色都在「深字 ≥4.5:1 或浅字 ≥4.5:1」的范围内（见 color.test.ts 的断言）——
 * 胶囊是 11px 小字，按 WCAG AA 需要 4.5:1；色板里混进中间亮度的颜色，
 * 就会有一格天生读不清。用户仍可用取色器选任意颜色。
 */
export const TAG_COLOR_PRESETS = [
  '#0D9488',
  '#0891B2',
  '#2563EB',
  '#7C3AED',
  '#A21CAF',
  '#BE185D',
  '#BE123C',
  '#EA580C',
  '#D97706',
  '#65A30D',
  '#059669',
  '#64748B',
]

/** 线性混合两个色：t=0 取 a，t=1 取 b。 */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a)
  const cb = parseHex(b)
  if (!ca || !cb) return a
  const k = clamp01(t)
  return toHex({
    r: ca.r + (cb.r - ca.r) * k,
    g: ca.g + (cb.g - ca.g) * k,
    b: ca.b + (cb.b - ca.b) * k,
  })
}

/**
 * 把前景色推到至少 minRatio 的对比度，只沿一个方向调以保留色相：
 * 亮底压暗、暗底提亮。背景传一组，取其中对比度最差的那个作为约束
 * （同一段文字可能落在 canvas 也可能落在 layer 上，两边都要照顾）。
 */
export function ensureTextContrast(fg: string, backgrounds: string[], minRatio: number): string {
  const valid = (backgrounds ?? []).filter((b) => parseHex(b))
  if (!parseHex(fg) || valid.length === 0) return fg
  const worst = valid.reduce((acc, bg) => (contrastRatio(fg, bg) < contrastRatio(fg, acc) ? bg : acc))
  if (contrastRatio(fg, worst) >= minRatio) return fg
  const target = relativeLuminance(worst) > 0.5 ? '#000000' : '#ffffff'
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const candidate = mixHex(fg, target, t)
    if (contrastRatio(candidate, worst) >= minRatio) return candidate
  }
  return target
}
