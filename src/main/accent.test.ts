import { describe, expect, it } from 'vitest'
import { PRESET_ACCENTS, hexToRgb, nearestAccent } from './accent'

describe('强调色 · hex 解析', () => {
  it('6 位直接解', () => {
    expect(hexToRgb('#0D9488')).toEqual([13, 148, 136])
  })

  it('3 位简写补成 6 位', () => {
    expect(hexToRgb('#abc')).toEqual([0xaa, 0xbb, 0xcc])
  })

  it('不带 # 也行', () => {
    expect(hexToRgb('2563EB')).toEqual([0x25, 0x63, 0xeb])
  })
})

describe('强调色 · 就近匹配', () => {
  it('正好是预设色时原样返回', () => {
    for (const c of PRESET_ACCENTS) expect(nearestAccent(c)).toBe(c)
  })

  it('略偏的色落到最近的那个预设', () => {
    // 与 #2563EB 只差一点点，应该仍落回它
    expect(nearestAccent('#2564ec')).toBe('#2563EB')
  })

  it('非法格式退回第一个预设，而不是抛错', () => {
    // 这个值来自设置页，用户可以填任意字符串 —— 抛错会让托盘图标整个消失
    expect(nearestAccent('')).toBe(PRESET_ACCENTS[0])
    expect(nearestAccent('   ')).toBe(PRESET_ACCENTS[0])
    expect(nearestAccent('不是颜色')).toBe(PRESET_ACCENTS[0])
    expect(nearestAccent('#12345')).toBe(PRESET_ACCENTS[0])
  })

  it('大小写不敏感', () => {
    expect(nearestAccent('#2563eb')).toBe('#2563EB')
    expect(nearestAccent('#2563EB')).toBe('#2563EB')
  })
})
