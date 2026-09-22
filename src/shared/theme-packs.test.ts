import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME_PACK, THEME_PACKS, THEME_PACK_NAMES, resolveThemePack } from '@shared/theme-packs'

const REQUIRED = [
  'canvas', 'layer', 'hover', 'hover2', 'fg', 'fg2', 'fg3',
  'border', 'border2', 'input', 'scroll', 'accent_soft', 'warm', 'danger', 'success',
] as const

describe('主题包', () => {
  it('14 款主题包都在', () => {
    expect(THEME_PACK_NAMES).toHaveLength(14)
    expect(THEME_PACK_NAMES).toContain('墨黑')
    expect(THEME_PACK_NAMES).toContain('樱花粉')
  })

  it('每个包都提供完整的 light / dark 语义色', () => {
    for (const name of THEME_PACK_NAMES) {
      const pack = THEME_PACKS[name]
      expect(pack, name).toBeTruthy()
      for (const key of REQUIRED) {
        expect(pack.light[key], `${name}.light.${key}`).toBeTruthy()
        expect(pack.dark[key], `${name}.dark.${key}`).toBeTruthy()
      }
    }
  })

  it('未知包名回退到默认包', () => {
    expect(resolveThemePack('不存在的包')).toBe(THEME_PACKS[DEFAULT_THEME_PACK])
    expect(resolveThemePack(undefined)).toBe(THEME_PACKS[DEFAULT_THEME_PACK])
  })

  it('明暗两套确实不同（否则切主题没有意义）', () => {
    const pack = THEME_PACKS[DEFAULT_THEME_PACK]
    expect(pack.light.canvas).not.toBe(pack.dark.canvas)
  })
})
