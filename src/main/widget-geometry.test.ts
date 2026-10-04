import { describe, expect, it } from 'vitest'
import {
  BALL_MARGIN,
  BALL_SIZE_DEFAULT,
  BALL_SIZE_MAX,
  BALL_SIZE_MIN,
  BALL_WIN_MIN,
  ballWindowPx,
  clampBallSize,
} from './widget-geometry'

describe('悬浮球 · 尺寸钳制', () => {
  it('区间内原样返回（取整）', () => {
    expect(clampBallSize(100)).toBe(100)
    expect(clampBallSize(100.4)).toBe(100)
    expect(clampBallSize(100.6)).toBe(101)
  })

  it('小于下限拉到下限 —— 再小表情就看不清了', () => {
    expect(clampBallSize(10)).toBe(BALL_SIZE_MIN)
    expect(clampBallSize(BALL_SIZE_MIN - 1)).toBe(BALL_SIZE_MIN)
  })

  it('大于上限压到上限', () => {
    expect(clampBallSize(9999)).toBe(BALL_SIZE_MAX)
  })

  it('0 与 NaN 落到默认值，而不是传一个坏值给 setBounds', () => {
    // 这个值来自设置（可能被写坏），而它决定窗口尺寸：
    // 传进 setBounds 一个 NaN 会让窗口直接消失
    expect(clampBallSize(0)).toBe(BALL_SIZE_DEFAULT)
    expect(clampBallSize(Number.NaN)).toBe(BALL_SIZE_DEFAULT)
  })
})

describe('悬浮球 · 窗口边长', () => {
  it('四周各留一个 BALL_MARGIN（放 hover 放大与投影）', () => {
    expect(ballWindowPx(96)).toBe(96 + BALL_MARGIN * 2)
  })

  it('最小窗口边长与最小球体对得上 —— 它必须固定不变', () => {
    // 最小尺寸一变，平台会异步重排窗口（保持左上角），把紧随其后的 setBounds
    // 位置参数盖掉：症状是「球变大了、位置却没动」
    expect(BALL_WIN_MIN).toBe(ballWindowPx(BALL_SIZE_MIN))
  })
})
