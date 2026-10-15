import { describe, expect, it } from 'vitest'
import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, clampZoom, nextZoom, readZoom, zoomLabel } from './zoom'

describe('编辑区缩放', () => {
  it('收进区间并对齐到一档 10%', () => {
    expect(clampZoom(0.2)).toBe(ZOOM_MIN)
    expect(clampZoom(9)).toBe(ZOOM_MAX)
    expect(clampZoom(1.04)).toBe(1)
    expect(clampZoom(1.06)).toBe(1.1)
    // 浮点累加的结果也要抹平：1.2000000000000002 显示成 120%
    expect(clampZoom(0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1)).toBe(1.2)
  })

  it('NaN / Infinity 不放大也不缩小，回到 1', () => {
    expect(clampZoom(Number.NaN)).toBe(ZOOM_DEFAULT)
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(ZOOM_MAX)
    expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(ZOOM_MIN)
  })

  it('向上滚放大、向下滚缩小', () => {
    expect(nextZoom(1, -120)).toBe(1.1)
    expect(nextZoom(1, 120)).toBe(0.9)
  })

  it('到顶到底就停住，不会越界', () => {
    expect(nextZoom(ZOOM_MAX, -120)).toBe(ZOOM_MAX)
    expect(nextZoom(ZOOM_MIN, 120)).toBe(ZOOM_MIN)
  })

  it('读存档：没存过 / 存坏了都回到 1，存过的照收', () => {
    expect(readZoom(null)).toBe(ZOOM_DEFAULT)
    expect(readZoom(undefined)).toBe(ZOOM_DEFAULT)
    expect(readZoom('')).toBe(ZOOM_DEFAULT)
    expect(readZoom('abc')).toBe(ZOOM_DEFAULT)
    expect(readZoom('1.4')).toBe(1.4)
    expect(readZoom('99')).toBe(ZOOM_MAX)
  })

  it('百分比文案取整', () => {
    expect(zoomLabel(1)).toBe('100%')
    expect(zoomLabel(1.25)).toBe('130%')
    expect(zoomLabel(ZOOM_MIN)).toBe('50%')
  })
})
