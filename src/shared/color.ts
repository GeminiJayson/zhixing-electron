/**
 * 颜色工具：对比度校正（对齐 Python 版 theme.py 的 _ensure_text_contrast）。
 *
 * 为什么需要：主题包的 fg2/fg3 是按观感调的柔和色，对 canvas / layer 的对比度
 * 大量落在 2.4–4.5 之间（实测 168 组里 74 组不达标，辅助文字最低只有 2.36:1）。
 * Python 版在 docs/ui_polish_v014_audit.md 做过同一件事（fg2 ≥4.5、fg3 ≥4.0），
 * Electron 的主题包是另一份数据，所以在应用主题时按同一套下限做运行时校正，
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
