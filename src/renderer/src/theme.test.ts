import { describe, expect, it } from 'vitest'
import { parseSettings, type AppSettings } from '@shared/settings'
import { contrastRatio } from '@shared/color'
import { DEFAULT_THEME_PACK, THEME_PACKS } from '@shared/theme-packs'
import { applyAppearance } from './theme'

/**
 * 外观落地的核心不变量：明暗要取主题包的另一套配色、强调色与主题包正交。
 * 浮窗和主窗口共用 applyAppearance，所以这里守住就等于两边都守住。
 */
function fakeRoot(): { root: HTMLElement; vars: Map<string, string>; dataset: Record<string, string> } {
  const vars = new Map<string, string>()
  const dataset: Record<string, string> = {}
  const style = { setProperty: (name: string, value: string): void => void vars.set(name, value) }
  return { root: { style, dataset } as unknown as HTMLElement, vars, dataset }
}

const settings = (over: Partial<AppSettings> = {}): AppSettings => ({ ...parseSettings({}), ...over })

describe('外观应用（主窗口与浮窗共用）', () => {
  it('深色取该主题包 dark 的一套', () => {
    const { root, vars, dataset } = fakeRoot()
    applyAppearance(settings({ theme_mode: 'dark', theme_pack: '樱花粉' }), root)
    expect(vars.get('--pack-canvas')).toBe(THEME_PACKS['樱花粉'].dark.canvas)
    expect(vars.get('--fg-primary')).toBe(THEME_PACKS['樱花粉'].dark.fg)
    expect(dataset.theme).toBe('dark')
  })

  it('同一主题包切明暗会重铺成另一套配色（只改 data-theme 不算）', () => {
    const { root, vars } = fakeRoot()
    const base = settings({ theme_pack: '樱花粉' })
    applyAppearance({ ...base, theme_mode: 'dark' }, root)
    expect(vars.get('--pack-canvas')).toBe(THEME_PACKS['樱花粉'].dark.canvas)
    applyAppearance({ ...base, theme_mode: 'light' }, root)
    expect(vars.get('--pack-canvas')).toBe(THEME_PACKS['樱花粉'].light.canvas)
    expect(THEME_PACKS['樱花粉'].light.canvas).not.toBe(THEME_PACKS['樱花粉'].dark.canvas)
  })

  it('强调色与主题包正交：换包不改强调色', () => {
    const { root, vars } = fakeRoot()
    applyAppearance(settings({ theme_pack: '墨黑', accent_color: '#DB2777' }), root)
    expect(vars.get('--accent')).toBe('#DB2777')
    applyAppearance(settings({ theme_pack: '薄荷绿', accent_color: '#DB2777' }), root)
    expect(vars.get('--accent')).toBe('#DB2777')
  })

  it('字号 / 行高 / 动效一并落到变量上', () => {
    const { root, vars, dataset } = fakeRoot()
    applyAppearance(settings({ font_size: 14, task_row_height: 36, motion_level: 'none' }), root)
    // 设置值即像素值：不再有 +1.5px / +10px 的补偿偏移
    expect(vars.get('--text-body')).toBe('14px')
    expect(vars.get('--row-h')).toBe('36px')
    // control_height 的消费点
    expect(vars.get('--control-h')).toBe('32px')
    expect(dataset.motion).toBe('none')
  })

  it('未知主题包退回默认包', () => {
    const { root, vars } = fakeRoot()
    applyAppearance(settings({ theme_mode: 'light', theme_pack: '不存在的包' }), root)
    expect(vars.get('--pack-canvas')).toBe(THEME_PACKS[DEFAULT_THEME_PACK].light.canvas)
  })

  /**
   * 断言的是 --pack-canvas / --pack-layer，不是最终的 --bg-canvas / --bg-layer：
   * 主题包（与自定义色）现在只负责**色相**，页面底与各层的通透程度由 tokens.css
   * 按 --glass-alpha 派生 —— 那是"透多少桌面 / 玻璃多实"的统一旋钮。
   */
  it('自定义配色覆盖主题包，且浅色 / 深色两套互不影响', () => {
    const { root, vars } = fakeRoot()
    const custom = JSON.stringify({ canvas: '#010203', layer: '#040506' })
    applyAppearance(settings({ theme_mode: 'dark', theme_custom_dark: custom }), root)
    expect(vars.get('--pack-canvas')).toBe('#010203')
    // 主题包的层色现在只写中间变量 --pack-layer：通透程度由 tokens.css 的四个玻璃层决定，
    // 所以 --bg-layer 不再是那个色值，而是 color-mix(...) 的表达式。
    expect(vars.get('--pack-layer')).toBe('#040506')
    // 深色的自定义不该影响浅色：切回浅色仍是主题包原值
    applyAppearance(settings({ theme_mode: 'light', theme_custom_dark: custom }), root)
    expect(vars.get('--pack-canvas')).toBe(THEME_PACKS[DEFAULT_THEME_PACK].light.canvas)
  })

  it('自定义的正文色仍被校正到可读下限 —— 自定义不绕过对比度守卫', () => {
    const { root, vars } = fakeRoot()
    applyAppearance(
      settings({
        theme_mode: 'light',
        theme_pack: '墨黑',
        theme_custom_light: JSON.stringify({ canvas: '#FFFFFF', fg: '#EEEEEE' }),
      }),
      root
    )
    const fg = vars.get('--fg-primary') ?? ''
    expect(fg).not.toBe('#EEEEEE')
    expect(contrastRatio(fg, '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
  })
})