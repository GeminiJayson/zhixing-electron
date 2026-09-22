import { describe, expect, it } from 'vitest'
import {
  CUSTOM_THEME_TOKENS,
  DEFAULT_THEME_PACK,
  THEME_PACKS,
  THEME_PACK_NAMES,
  effectiveThemeColors,
  parseThemeOverrides,
  resolveThemePack,
} from '@shared/theme-packs'

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

/**
 * 用户自定义配色：存的是 JSON 串，会被写进 CSS 变量 ——
 * 所以入口必须只放行白名单键与 #RRGGBB，坏值一律丢弃。
 */
describe('用户自定义配色', () => {
  it('只认白名单里的 token 与 #RRGGBB', () => {
    const o = parseThemeOverrides(
      JSON.stringify({ canvas: '#112233', fg: 'not-a-color', input: '#445566', 未知键: '#778899' })
    )
    expect(o).toEqual({ canvas: '#112233' })
  })

  it('空串 / 坏 JSON / 数组一律当「没有自定义」', () => {
    expect(parseThemeOverrides('')).toEqual({})
    expect(parseThemeOverrides(null)).toEqual({})
    expect(parseThemeOverrides('{')).toEqual({})
    expect(parseThemeOverrides('[1,2]')).toEqual({})
    expect(parseThemeOverrides('"#112233"')).toEqual({})
  })

  it('大小写与空白容错', () => {
    expect(parseThemeOverrides(JSON.stringify({ layer: '  #aAbBcC ' }))).toEqual({ layer: '#aAbBcC' })
  })

  it('覆盖层叠在主题包之上，没给的 token 仍跟随主题包', () => {
    const pack = THEME_PACKS[DEFAULT_THEME_PACK]
    const merged = effectiveThemeColors(DEFAULT_THEME_PACK, 'dark', { canvas: '#000000' })
    expect(merged.canvas).toBe('#000000')
    expect(merged.layer).toBe(pack.dark.layer)
  })

  it('每个可自定义 token 都是 #RRGGBB —— 否则 <input type="color"> 会显示错色', () => {
    for (const { key } of CUSTOM_THEME_TOKENS) {
      for (const name of THEME_PACK_NAMES) {
        expect(/^#[0-9a-f]{6}$/i.test(THEME_PACKS[name].light[key]), `${name}.light.${key}`).toBe(true)
        expect(/^#[0-9a-f]{6}$/i.test(THEME_PACKS[name].dark[key]), `${name}.dark.${key}`).toBe(true)
      }
    }
  })
})
