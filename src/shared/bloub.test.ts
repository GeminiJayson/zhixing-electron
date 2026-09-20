import { describe, expect, it } from 'vitest'
import { SHAPE_BY_ID } from '../renderer/src/vendor/bloub/bot/skins'
import { BLOUB_DEFAULT_SHAPE, BLOUB_SHAPES, normalizeBloubShape } from './bloub'

describe('bloub 体型清单', () => {
  it('菜单里的 id 与 vendor 引擎的形状一一对应', () => {
    // 这条是重点：菜单（主进程）与引擎（渲染层）各持一份 id 列表，
    // 上游改了名字而这里没跟上时，用户选了也只会静默回落 —— 让编译器以外的东西盯着它
    const engine = [...SHAPE_BY_ID.keys()].sort()
    const menu = BLOUB_SHAPES.map((s) => s.id).sort()
    expect(menu).toEqual(engine)
  })

  it('默认形状确实在清单里', () => {
    expect(BLOUB_SHAPES.some((s) => s.id === BLOUB_DEFAULT_SHAPE)).toBe(true)
  })

  it('认不出来的值回落到默认', () => {
    expect(normalizeBloubShape('capsule')).toBe('capsule')
    expect(normalizeBloubShape('无此形状')).toBe(BLOUB_DEFAULT_SHAPE)
    expect(normalizeBloubShape(null)).toBe(BLOUB_DEFAULT_SHAPE)
    expect(normalizeBloubShape(undefined)).toBe(BLOUB_DEFAULT_SHAPE)
  })

  it('每个体型都有中文名', () => {
    for (const s of BLOUB_SHAPES) expect(s.label.length).toBeGreaterThan(0)
  })
})
