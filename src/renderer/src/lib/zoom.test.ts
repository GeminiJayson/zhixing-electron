import { describe, expect, it } from 'vitest'
import {
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  nextZoom,
  readZoomFor,
  readZoomMap,
  writeZoomFor,
  zoomLabel,
} from './zoom'

describe('编辑区缩放', () => {
  it('收进区间并对齐到一档 10%', () => {
    expect(clampZoom(0.2)).toBe(ZOOM_MIN)
    expect(clampZoom(9)).toBe(ZOOM_MAX)
    expect(clampZoom(1.04)).toBe(1)
    expect(clampZoom(1.06)).toBe(1.1)
    // 浮点累加的结果也要抹平：1.2000000000000002 显示成 120%
    expect(clampZoom(0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1)).toBe(1.2)
  })

  it('NaN / ±Infinity 不放大也不缩小', () => {
    expect(clampZoom(Number.NaN)).toBe(ZOOM_DEFAULT)
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(ZOOM_MAX)
    expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(ZOOM_MIN)
  })

  it('向上滚放大、向下滚缩小，到顶到底就停住', () => {
    expect(nextZoom(1, -120)).toBe(1.1)
    expect(nextZoom(1, 120)).toBe(0.9)
    expect(nextZoom(ZOOM_MAX, -120)).toBe(ZOOM_MAX)
    expect(nextZoom(ZOOM_MIN, 120)).toBe(ZOOM_MIN)
  })

  it('百分比文案取整', () => {
    expect(zoomLabel(1)).toBe('100%')
    expect(zoomLabel(1.25)).toBe('130%')
    expect(zoomLabel(ZOOM_MIN)).toBe('50%')
  })
})

describe('缩放按笔记各记一份', () => {
  it('没存过的笔记是 100%', () => {
    expect(readZoomFor(null, 3)).toBe(ZOOM_DEFAULT)
    expect(readZoomFor('{}', 3)).toBe(ZOOM_DEFAULT)
    expect(readZoomFor(undefined, 3)).toBe(ZOOM_DEFAULT)
  })

  it('各篇互不影响，切回来还是原来那个比例', () => {
    let raw = writeZoomFor(null, 3, 1.4)
    raw = writeZoomFor(raw, 7, 0.8)
    expect(readZoomFor(raw, 3)).toBe(1.4)
    expect(readZoomFor(raw, 7)).toBe(0.8)
    expect(readZoomFor(raw, 9)).toBe(ZOOM_DEFAULT)
    // 改一篇不动另一篇
    const next = writeZoomFor(raw, 3, 2)
    expect(readZoomFor(next, 3)).toBe(2)
    expect(readZoomFor(next, 7)).toBe(0.8)
  })

  it('数字 id 与字符串 id 是同一篇', () => {
    const raw = writeZoomFor(null, 3, 1.2)
    expect(readZoomFor(raw, '3')).toBe(1.2)
  })

  it('写回时收进合法区间', () => {
    expect(readZoomFor(writeZoomFor(null, 3, 9), 3)).toBe(ZOOM_MAX)
    expect(readZoomFor(writeZoomFor(null, 3, 0.1), 3)).toBe(ZOOM_MIN)
  })

  it('存档坏了当没存过，坏条目单独丢弃', () => {
    expect(readZoomFor('{oops', 3)).toBe(ZOOM_DEFAULT)
    expect(readZoomFor('[1,2]', 3)).toBe(ZOOM_DEFAULT)
    expect(readZoomFor('"x"', 3)).toBe(ZOOM_DEFAULT)
    expect(readZoomFor('{"3":"1.4"}', 3)).toBe(ZOOM_DEFAULT)
    expect(readZoomMap('{"3":1.4,"4":"x","5":null}')).toEqual({ 3: 1.4 })
  })

  it('没有当前笔记时不写入、读回默认值', () => {
    expect(readZoomFor(writeZoomFor(null, null, 1.5), null)).toBe(ZOOM_DEFAULT)
    expect(writeZoomFor(null, null, 1.5)).toBe('{}')
  })
})
