import { describe, expect, it } from 'vitest'
import {
  MAX_BULGE,
  bulgeOf,
  controlPoints,
  edgeMidpoint,
  edgePath,
  edgePointFrom,
  trimEnd,
  type EdgeEnds
} from './edge-path'

describe('连线贝塞尔几何（对齐 Obsidian 的流体弧）', () => {
  it('路径串沿用 M…C… 结构，两端点精确落在节点上', () => {
    const d = edgePath({ x1: 0, y1: 0, x2: 100, y2: 0 })
    expect(d.startsWith('M0,0 C')).toBe(true)
    expect(d.endsWith('100,0')).toBe(true)
  })

  it('弧高随长度增长但封顶，短线接近直线', () => {
    expect(bulgeOf(10)).toBeCloseTo(1.2, 6)
    expect(bulgeOf(1000)).toBe(MAX_BULGE)
    expect(bulgeOf(0)).toBe(0)
    expect(bulgeOf(Number.NaN)).toBe(0)
  })

  it('控制点沿法线偏移：水平连线的弧朝竖直方向', () => {
    const [c1x, c1y, c2x, c2y] = controlPoints({ x1: 0, y1: 0, x2: 100, y2: 0 })
    // 水平线的法线是竖直方向：控制点 x 落在 1/4 与 3/4，y 同为弧高
    expect(c1x).toBeCloseTo(25, 6)
    expect(c2x).toBeCloseTo(75, 6)
    expect(c1y).toBeCloseTo(12, 6)
    expect(c2y).toBeCloseTo(12, 6)
  })

  it('中点在曲线上，且比两端连线中点更偏离（证明真的鼓起来了）', () => {
    const ends: EdgeEnds = { x1: 0, y1: 0, x2: 100, y2: 0 }
    const mid = edgeMidpoint(ends)
    expect(mid.x).toBeCloseTo(50, 6)
    // 直线中点是 y=0；曲线中点应被弧高抬起（3/8 的偏移量）
    expect(mid.y).toBeGreaterThan(0)
    expect(mid.y).toBeCloseTo((3 * 12 + 3 * 12) / 8, 6)
  })

  it('零长度连线退化为直线且不产生 NaN', () => {
    const ends = { x1: 7, y1: 9, x2: 7, y2: 9 }
    expect(edgePath(ends)).toBe('M7,9 L7,9')
    const mid = edgeMidpoint(ends)
    expect(Number.isNaN(mid.x)).toBe(false)
    expect(Number.isNaN(mid.y)).toBe(false)
    expect(mid).toEqual({ x: 7, y: 9 })
  })

  it('两端沿连线方向收回，给箭头留落点', () => {
    const t = trimEnd({ x1: 0, y1: 0, x2: 100, y2: 0 }, 10)
    expect(t.x1).toBeCloseTo(10, 6)
    expect(t.x2).toBeCloseTo(90, 6)
    expect(t.y1).toBeCloseTo(0, 6)
    expect(t.y2).toBeCloseTo(0, 6)
  })

  it('过短的边不收，避免退化成零长甚至反向', () => {
    const ends = { x1: 0, y1: 0, x2: 12, y2: 0 }
    expect(trimEnd(ends, 10)).toEqual(ends)
  })

  it('贴起点的标签位置：沿单位方向前进，不是按分量', () => {
    const flat = edgePointFrom({ x1: 0, y1: 0, x2: 100, y2: 0 }, 30)
    expect(flat.x).toBeCloseTo(30, 6)
    expect(flat.y).toBeCloseTo(0, 6)
    const diag = edgePointFrom({ x1: 0, y1: 0, x2: 30, y2: 40 }, 25)
    expect(Math.hypot(diag.x, diag.y)).toBeCloseTo(25, 6)
  })

  it('贴起点时超过半长会收到中点，不会越过目标；零长退化为起点', () => {
    expect(edgePointFrom({ x1: 0, y1: 0, x2: 20, y2: 0 }, 999)).toEqual({ x: 10, y: 0 })
    expect(edgePointFrom({ x1: 5, y1: 7, x2: 5, y2: 7 }, 30)).toEqual({ x: 5, y: 7 })
  })

  it('弧高不随方向变化（旋转后仍是对称的微弱弯）', () => {
    const flat = controlPoints({ x1: 0, y1: 0, x2: 100, y2: 0 })
    const diag = controlPoints({ x1: 0, y1: 0, x2: 70.71, y2: 70.71 })
    const flatBulge = Math.abs(flat[1] - 0)
    const diagBulge = Math.hypot(diag[0] - 70.71 * 0.25, diag[1] - 70.71 * 0.25)
    expect(diagBulge).toBeCloseTo(flatBulge, 1)
  })
})
