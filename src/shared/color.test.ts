import { describe, expect, it } from 'vitest'
import {
  TAG_COLOR_PRESETS,
  contrastRatio,
  ensureTextContrast,
  inkOn,
  mixHex,
  relativeLuminance,
} from './color'
import { THEME_PACKS } from './theme-packs'

/**
 * 对比度下限：
 * 正文/次要文字 4.5:1（WCAG AA），辅助文字放宽到 4.0:1。
 */
const FG_MIN = 4.5
const FG2_MIN = 4.5
const FG3_MIN = 4.0

describe('对比度校正', () => {
  it('已达标的前景色原样返回（不制造无谓的色偏）', () => {
    expect(ensureTextContrast('#171717', ['#F5F5F5', '#FFFFFF'], FG_MIN)).toBe('#171717')
  })

  it('亮底压暗、暗底提亮，方向不搞反', () => {
    const onLight = ensureTextContrast('#B3B3B3', ['#FFFFFF'], FG_MIN)
    expect(relativeLuminance(onLight)).toBeLessThan(relativeLuminance('#B3B3B3'))

    const onDark = ensureTextContrast('#555555', ['#101010'], FG_MIN)
    expect(relativeLuminance(onDark)).toBeGreaterThan(relativeLuminance('#555555'))
  })

  it('对最差的那个背景负责：canvas 与 layer 都要达标', () => {
    // layer 是纯白、canvas 更浅，取更差的约束后两边都应满足
    const fixed = ensureTextContrast('#B3B3B3', ['#FFFFFF', '#F5F5F5'], FG_MIN)
    expect(contrastRatio(fixed, '#FFFFFF')).toBeGreaterThanOrEqual(FG_MIN)
    expect(contrastRatio(fixed, '#F5F5F5')).toBeGreaterThanOrEqual(FG_MIN)
  })

  it('非十六进制或背景为空时原样返回，不抛错', () => {
    expect(ensureTextContrast('rgba(0,0,0,0.5)', ['#FFFFFF'], FG_MIN)).toBe('rgba(0,0,0,0.5)')
    expect(ensureTextContrast('#B3B3B3', [], FG_MIN)).toBe('#B3B3B3')
  })

  it('mixHex 端点与中点', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('任意强调色当文字用，对真实主题表面都达标', () => {
    // 强调色由用户自选，浅色值本身不保证可读（浅黄在白底上只有 1.51:1）。
    // 注意约束只能落在**同一明暗模式**的一组表面上：要求一个颜色同时对纯白和
    // 纯黑底达标在几何上不可能，所以这里用真实主题包的 canvas/layer/accent_soft。
    const accents = ['#0d9488', '#2563eb', '#eab308', '#dc2626', '#7c3aed', '#f97316']
    for (const [name, pack] of Object.entries(THEME_PACKS)) {
      for (const mode of ['light', 'dark'] as const) {
        const c = pack[mode]
        const surfaces = [c.canvas, c.layer, c.accent_soft]
        for (const a of accents) {
          const fixed = ensureTextContrast(a, surfaces, FG_MIN)
          for (const s of surfaces) {
            expect(contrastRatio(fixed, s), `${a} on ${name}[${mode}] ${s}`).toBeGreaterThanOrEqual(FG_MIN)
          }
        }
      }
    }
  })

  // 这条是真正的守门断言：14 个主题包 × 双模式 × canvas/layer 全量覆盖
  it('全部主题包在 canvas 与 layer 上都达到可访问性下限', () => {
    const packs = Object.entries(THEME_PACKS)
    expect(packs.length).toBeGreaterThan(10)
    for (const [name, pack] of packs) {
      for (const mode of ['light', 'dark'] as const) {
        const c = pack[mode]
        const surfaces = [c.canvas, c.layer]
        const fg = ensureTextContrast(c.fg, surfaces, FG_MIN)
        const fg2 = ensureTextContrast(c.fg2, surfaces, FG2_MIN)
        const fg3 = ensureTextContrast(c.fg3, surfaces, FG3_MIN)
        for (const s of surfaces) {
          expect(contrastRatio(fg, s), `${name}[${mode}] fg ${c.fg} on ${s}`).toBeGreaterThanOrEqual(FG_MIN)
          expect(contrastRatio(fg2, s), `${name}[${mode}] fg2 ${c.fg2} on ${s}`).toBeGreaterThanOrEqual(FG2_MIN)
          expect(contrastRatio(fg3, s), `${name}[${mode}] fg3 ${c.fg3} on ${s}`).toBeGreaterThanOrEqual(FG3_MIN)
        }
      }
    }
  })
})

/**
 * 标签胶囊把用户自选的颜色当**实心底色**用，所以文字色必须跟着翻面 ——
 * 这一组断言守着「任意颜色都不会变成看不见的文字」。
 */
describe('实心底色上的文字色', () => {
  it('浅底给深字、深底给浅字', () => {
    expect(inkOn('#FDE047')).toBe('#111827')
    expect(inkOn('#FFFFFF')).toBe('#111827')
    expect(inkOn('#111827')).toBe('#f8fafc')
    // 青色走的是「对比度择优」而不是亮度阈值：它亮度 0.23，浅字只有 3.6:1，深字 4.6:1
    expect(inkOn('#0D9488')).toBe('#111827')
  })

  it('11px 的标签胶囊：每个预设色配它的文字色都达到 4.5:1', () => {
    expect(TAG_COLOR_PRESETS.length).toBeGreaterThanOrEqual(8)
    for (const c of TAG_COLOR_PRESETS) {
      expect(contrastRatio(inkOn(c), c), `${c} 上的文字`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('中亮区的底色也不会选错方向：总是给出两个候选里更可读的那个', () => {
    // 中亮区两种文字都可能不达标，但绝不能选反 —— 选到 3.6:1 而放着 4.6:1 不用就是 bug。
    // 这里的判据与实现同源，属于「方向不许翻」的回归钉子。
    for (const c of ['#3B82F6', '#F59E0B', '#DB2777', '#22C55E']) {
      const picked = inkOn(c)
      const best = contrastRatio('#111827', c) >= contrastRatio('#f8fafc', c) ? '#111827' : '#f8fafc'
      expect(picked, `${c} 应该用 ${best}`).toBe(best)
    }
    // 非法值不能原样返回（否则 CSS 里会出现无效颜色）
    for (const bad of ['rgba(0,0,0,.5)', 'red', '', '#12345']) {
      expect(['#111827', '#f8fafc']).toContain(inkOn(bad))
    }
  })

  it('非法色值不抛错，退回浅色文字', () => {
    expect(inkOn('rgba(0,0,0,.5)')).toBe('#f8fafc')
    expect(inkOn('')).toBe('#f8fafc')
  })
})
