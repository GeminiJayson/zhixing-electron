import { describe, expect, it } from 'vitest'
import {
  MAX_SCALE,
  MIN_SCALE,
  fitView,
  panBy,
  scaleOf,
  toViewBoxString,
  wheelFactor,
  zoomAt,
  type ViewBox
} from './panzoom'

const BASE_W = 900
const BASE_H = 520

describe('画布视图（平移 / 缩放）', () => {
  it('初始视图铺满基准尺寸，缩放为 1', () => {
    const v = fitView(BASE_W, BASE_H)
    expect(v).toEqual({ x: 0, y: 0, w: BASE_W, h: BASE_H })
    expect(scaleOf(v, BASE_W)).toBe(1)
  })

  it('缩放时光标下的那个点保持不动', () => {
    const v = fitView(BASE_W, BASE_H)
    const cursor = { rx: 0.25, ry: 0.75 }
    const worldX = v.x + cursor.rx * v.w
    const worldY = v.y + cursor.ry * v.h

    const zoomed = zoomAt(v, BASE_W, BASE_H, cursor, 2)

    expect(scaleOf(zoomed, BASE_W)).toBeCloseTo(2, 6)
    // 同一个世界坐标，在缩放后仍应落在光标的同一相对位置
    expect(zoomed.x + cursor.rx * zoomed.w).toBeCloseTo(worldX, 6)
    expect(zoomed.y + cursor.ry * zoomed.h).toBeCloseTo(worldY, 6)
  })

  it('缩放倍数被钳制在 MIN_SCALE 与 MAX_SCALE 之间', () => {
    const v = fitView(BASE_W, BASE_H)
    let tiny = v
    for (let i = 0; i < 40; i++) tiny = zoomAt(tiny, BASE_W, BASE_H, { rx: 0.5, ry: 0.5 }, 0.8)
    expect(scaleOf(tiny, BASE_W)).toBeCloseTo(MIN_SCALE, 6)

    let huge = v
    for (let i = 0; i < 40; i++) huge = zoomAt(huge, BASE_W, BASE_H, { rx: 0.5, ry: 0.5 }, 1.25)
    expect(scaleOf(huge, BASE_W)).toBeCloseTo(MAX_SCALE, 6)
  })

  it('已到边界时继续滚不会把视图滚飞', () => {
    const atMax = zoomAt(fitView(BASE_W, BASE_H), BASE_W, BASE_H, { rx: 0.5, ry: 0.5 }, MAX_SCALE)
    const again = zoomAt(atMax, BASE_W, BASE_H, { rx: 0.5, ry: 0.5 }, 2)
    expect(again.w).toBeCloseTo(atMax.w, 6)
    expect(again.x).toBeCloseTo(atMax.x, 6)
  })

  it('平移方向跟着拖拽方向：向右拖内容右移', () => {
    const v: ViewBox = fitView(BASE_W, BASE_H)
    const moved = panBy(v, 0.1, 0)
    // 内容右移 = viewBox 原点左移
    expect(moved.x).toBeCloseTo(-0.1 * BASE_W, 6)
    expect(moved.y).toBeCloseTo(0, 6)
    expect(moved.w).toBe(BASE_W)
  })

  it('滚轮倍率向上滚放大、向下滚缩小，且互为倒数', () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1)
    expect(wheelFactor(100)).toBeLessThan(1)
    expect(wheelFactor(-100) * wheelFactor(100)).toBeCloseTo(1, 10)
  })

  it('viewBox 字符串格式', () => {
    expect(toViewBoxString({ x: 1, y: 2, w: 3, h: 4 })).toBe('1 2 3 4')
  })
})
