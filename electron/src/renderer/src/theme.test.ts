import { describe, expect, it } from 'vitest'
import { parseSettings, type AppSettings } from '@shared/settings'
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
    expect(vars.get('--bg-canvas')).toBe(THEME_PACKS['樱花粉'].dark.canvas)
    expect(vars.get('--fg-primary')).toBe(THEME_PACKS['樱花粉'].dark.fg)
    expect(dataset.theme).toBe('dark')
  })

  it('同一主题包切明暗会重铺成另一套配色（只改 data-theme 不算）', () => {
    const { root, vars } = fakeRoot()
    const base = settings({ theme_pack: '樱花粉' })
    applyAppearance({ ...base, theme_mode: 'dark' }, root)
    expect(vars.get('--bg-canvas')).toBe(THEME_PACKS['樱花粉'].dark.canvas)
    applyAppearance({ ...base, theme_mode: 'light' }, root)
    expect(vars.get('--bg-canvas')).toBe(THEME_PACKS['樱花粉'].light.canvas)
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
    expect(vars.get('--text-body')).toBe('15.5px')
    expect(vars.get('--row-h')).toBe('46px')
    expect(dataset.motion).toBe('none')
  })

  it('未知主题包退回默认包', () => {
    const { root, vars } = fakeRoot()
    applyAppearance(settings({ theme_mode: 'light', theme_pack: '不存在的包' }), root)
    expect(vars.get('--bg-canvas')).toBe(THEME_PACKS[DEFAULT_THEME_PACK].light.canvas)
  })
})
