import { describe, expect, it } from 'vitest'
import { orthogonalPath, type Anchor, type AnchorSide } from './edge-path'

/** 几何常量：连接点先沿法线走出的那一小段（与实现里的默认值一致，测试钉死它）。 */
const ORTHO_STUB = 14

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
