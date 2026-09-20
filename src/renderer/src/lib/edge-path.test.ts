import { describe, expect, it } from 'vitest'
import {
  MAX_BULGE,
  ORTHO_STUB,
  bulgeOf,
  controlPoints,
  edgeMidpoint,
  edgePath,
  edgePointFrom,
  edgePathMidpoint,
  elbowPath,
  orthogonalPath,
  trimEnd,
  type Anchor,
  type AnchorSide,
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

  it('正交折线：纵向为主时先竖-再横-再竖（三个 L）', () => {
    const d = elbowPath({ x1: 0, y1: 0, x2: 100, y2: 200 })
    expect(d).toBe('M0,0 L0,100 L100,100 L100,200')
  })

  it('正交折线：横向为主时先横-再竖-再横', () => {
    const d = elbowPath({ x1: 0, y1: 0, x2: 200, y2: 100 })
    expect(d).toBe('M0,0 L100,0 L100,100 L200,100')
  })

  it('正交折线：正对时退化成一条直线（不为 1px 错位拐两次）', () => {
    expect(elbowPath({ x1: 0, y1: 0, x2: 0, y2: 100 })).toBe('M0,0 L0,100')
    expect(elbowPath({ x1: 0, y1: 0, x2: 100, y2: 0 })).toBe('M0,0 L100,0')
  })

  it('正交折线：只用直线段，不含任何曲线命令', () => {
    const d = elbowPath({ x1: 10, y1: 20, x2: 130, y2: 260 })
    expect(/[CQAST]/.test(d)).toBe(false)
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

/** 把 d 串解析回点列表，方便断言「垂直出入」这类几何性质。 */
const parse = (d: string): { x: number; y: number }[] =>
  [...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))

const at = (x: number, y: number, side: AnchorSide): Anchor => ({ x, y, side })

describe('orthogonalPath —— 按边方向折线，两端都垂直于节点的边', () => {
  /** 每一段都必须是轴对齐的（不能出现斜线）。 */
  const expectAxisAligned = (pts: { x: number; y: number }[]): void => {
    for (let i = 1; i < pts.length; i++) {
      const dx = Math.abs(pts[i].x - pts[i - 1].x)
      const dy = Math.abs(pts[i].y - pts[i - 1].y)
      expect(dx < 0.001 || dy < 0.001).toBe(true)
    }
  }

  it('首段垂直于「出发的那条边」，且朝节点外走', () => {
    const pts = parse(orthogonalPath(at(190, 68, 'right'), at(170, 160, 'top')))
    expect(pts[1].y).toBe(pts[0].y) // 右尖角出线 → 首段水平
    expect(pts[1].x).toBeGreaterThan(pts[0].x) // 朝外，不是往节点里走
    expectAxisAligned(pts)
  })

  it('末段垂直于「进入的那条边」，且正好落在锚点上', () => {
    const pts = parse(orthogonalPath(at(190, 68, 'right'), at(170, 160, 'top')))
    const end = pts[pts.length - 1]
    const before = pts[pts.length - 2]
    expect(end).toEqual({ x: 170, y: 160 })
    expect(before.x).toBe(end.x) // 竖直进入上边
    expect(before.y).toBeLessThan(end.y)
  })

  it('末段的过渡线落在节点之外，不与目标边框重合', () => {
    // 进入上边时，所有水平段的 y 都必须严格位于目标上边之上
    const pts = parse(orthogonalPath(at(190, 68, 'right'), at(170, 160, 'top')))
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].y === pts[i - 1].y && pts[i].x !== pts[i - 1].x) {
        expect(pts[i].y).toBeLessThan(160)
      }
    }
    expect(pts[pts.length - 2].y).toBeCloseTo(160 - ORTHO_STUB, 6)
  })

  it('竖出竖入（普通顺序线）：仍然是轴对齐的折线，末段垂直', () => {
    const pts = parse(orthogonalPath(at(115, 96, 'bottom'), at(170, 160, 'top')))
    expectAxisAligned(pts)
    expect(pts[pts.length - 1]).toEqual({ x: 170, y: 160 })
    expect(pts[pts.length - 2].x).toBe(170)
    expect(pts[pts.length - 2].y).toBeLessThan(160)
  })

  it('横出横入：过渡竖线落在两个节点之间，不会横穿过去', () => {
    // 源在右、目标在左且略高：源从左侧出线、从目标右侧进入（directedAnchors 的真实组合）
    const pts = parse(orthogonalPath(at(300, 128, 'left'), at(150, 88, 'right')))
    expectAxisAligned(pts)
    const verticals = pts.slice(1).filter((p, i) => p.x === pts[i].x && p.y !== pts[i].y)
    expect(verticals.length).toBe(1)
    expect(verticals[0].x).toBeGreaterThan(150) // 落在两节点之间，而不是压在目标右侧
    expect(pts[pts.length - 1]).toEqual({ x: 150, y: 88 })
    expect(pts[pts.length - 2].y).toBe(88) // 水平进入
  })

  it('两点的出入方向共线且正对时，退化成一条直线（不折返）', () => {
    expect(orthogonalPath(at(0, 0, 'bottom'), at(0, 200, 'top'))).toBe('M0,0 L0,200')
  })

  it('两点极近时不会折出零长段或回头线', () => {
    const pts = parse(orthogonalPath(at(0, 0, 'right'), at(6, 2, 'left')))
    for (let i = 1; i < pts.length; i++) {
      const len = Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y)
      expect(len).toBeGreaterThan(0)
    }
    expectAxisAligned(pts)
  })

  it('只用直线段，不含任何曲线命令', () => {
    expect(/[CQAST]/.test(orthogonalPath(at(40, 68, 'left'), at(115, 280, 'top')))).toBe(false)
  })
})

describe('edgePathMidpoint —— 删除按钮必须压在线上', () => {
  it('直线：取正中间', () => {
    expect(edgePathMidpoint('M0,0 L100,0')).toEqual({ x: 50, y: 0 })
  })

  it('折线：按弧长取一半，落在较长的那一段上（不是两端点的中点）', () => {
    // 10 + 100 的 L 形：弧长中点应在竖直段里，而「两端点中点」会落在 (5,50) 附近偏出去
    const m = edgePathMidpoint('M0,0 L10,0 L10,100')
    expect(m.x).toBeCloseTo(10, 6)
    expect(m.y).toBeCloseTo(45, 6)
  })

  it('正交折线（真实连线形状）的中点在线上', () => {
    const d = orthogonalPath(at(190, 68, 'right'), at(170, 160, 'top'))
    const m = edgePathMidpoint(d)
    const pts = parse(d)
    // 中点必须落在某一段线段上
    const onSegment = pts.some((p, i) => {
      if (i === 0) return false
      const q = pts[i - 1]
      const cross = (p.x - q.x) * (m.y - q.y) - (p.y - q.y) * (m.x - q.x)
      if (Math.abs(cross) > 0.01) return false
      return (
        m.x >= Math.min(p.x, q.x) - 0.01 &&
        m.x <= Math.max(p.x, q.x) + 0.01 &&
        m.y >= Math.min(p.y, q.y) - 0.01 &&
        m.y <= Math.max(p.y, q.y) + 0.01
      )
    })
    expect(onSegment).toBe(true)
  })

  it('单点 / 空串不炸', () => {
    expect(edgePathMidpoint('M5,7')).toEqual({ x: 5, y: 7 })
    expect(edgePathMidpoint('')).toEqual({ x: 0, y: 0 })
  })
})
