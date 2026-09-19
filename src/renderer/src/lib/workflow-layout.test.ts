import { describe, expect, it } from 'vitest'
import {
  LAYOUT_NODE_H,
  LAYOUT_NODE_W,
  edgeAnchors,
  layoutBounds,
  layoutWorkflow,
  workflowEdges,
  type LayoutNode,
} from './workflow-layout'

/** 造一个最小节点：只带布局关心的三个字段。 */
const node = (id: number, order_index: number, branch_node_id: number | null = null): LayoutNode => ({
  id,
  order_index,
  branch_node_id,
})

/** 任意两个节点的中心距离 —— 用来钉「不重叠」。 */
const minCenterGap = (pos: Map<number, { x: number; y: number }>): number => {
  const list = [...pos.values()]
  let min = Infinity
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      min = Math.min(min, Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y))
    }
  }
  return min
}

describe('workflowEdges —— 把隐式结构投影成边', () => {
  it('顺序边按 order_index 相邻相连（而不是按数组顺序）', () => {
    const edges = workflowEdges([node(3, 2), node(1, 0), node(2, 1)])
    expect(edges).toEqual([
      { from: 1, to: 2, branch: false },
      { from: 2, to: 3, branch: false },
    ])
  })

  it('分支边是 node → branch_node_id，并与顺序边一起去重', () => {
    const edges = workflowEdges([node(1, 0, 2), node(2, 1)])
    // 1→2 既是顺序边又是分支边，只留一条（先到的是顺序边）
    expect(edges).toEqual([{ from: 1, to: 2, branch: false }])
  })

  it('自环与悬空分支被丢弃，不影响其它边', () => {
    const edges = workflowEdges([node(1, 0, 1), node(2, 1, 99), node(3, 2)])
    expect(edges).toEqual([
      { from: 1, to: 2, branch: false },
      { from: 2, to: 3, branch: false },
    ])
  })
})

describe('layoutWorkflow —— dagre 分层', () => {
  it('空输入返回空布局', () => {
    expect(layoutWorkflow([]).size).toBe(0)
  })

  it('TB：顺序步骤自上而下逐层排开（y 递增、同列 x 一致）', () => {
    const pos = layoutWorkflow([node(1, 0), node(2, 1), node(3, 2)])
    const a = pos.get(1)!
    const b = pos.get(2)!
    const c = pos.get(3)!
    expect(b.y).toBeGreaterThan(a.y)
    expect(c.y).toBeGreaterThan(b.y)
    expect(b.x).toBe(a.x)
    expect(c.x).toBe(a.x)
  })

  it('LR：顺序步骤自左而右（x 递增）', () => {
    const pos = layoutWorkflow([node(1, 0), node(2, 1), node(3, 2)], { rankdir: 'LR' })
    expect(pos.get(2)!.x).toBeGreaterThan(pos.get(1)!.x)
    expect(pos.get(3)!.x).toBeGreaterThan(pos.get(2)!.x)
  })

  it('条件分支落在与主线不同的层，且都在源之下', () => {
    // 1 → 2（顺序）；1 → 3（分支）
    const pos = layoutWorkflow([node(1, 0, 3), node(2, 1), node(3, 2)])
    const src = pos.get(1)!
    const main = pos.get(2)!
    const branch = pos.get(3)!
    expect(main.y).toBeGreaterThan(src.y)
    expect(branch.y).toBeGreaterThan(src.y)
    // 分支若与主线同层，就说明没有真正分层
    expect(branch.y).not.toBe(main.y)
  })

  it('节点尺寸参与布局：任意两个节点都不重叠', () => {
    const pos = layoutWorkflow([node(1, 0, 4), node(2, 1), node(3, 2, 5), node(4, 3), node(5, 4)])
    expect(minCenterGap(pos)).toBeGreaterThanOrEqual(LAYOUT_NODE_H)
  })

  it('多根无连线也不会叠在一起', () => {
    const pos = layoutWorkflow([node(1, 0), node(2, 1), node(3, 2)])
    expect(new Set([...pos.values()].map((p) => p.x + ',' + p.y)).size).toBe(3)
  })

  it('回边成环时不抛错（dagre 自己断环）', () => {
    // 1 → 2 → 3 顺序，3 又分支回 1：构成环
    const pos = layoutWorkflow([node(1, 0), node(2, 1), node(3, 2, 1)])
    expect(pos.size).toBe(3)
    for (const p of pos.values()) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
    }
  })

  it('返回的是左上角，而不是 dagre 的中心点', () => {
    const pos = layoutWorkflow([node(1, 0)], { nodeWidth: LAYOUT_NODE_W, nodeHeight: LAYOUT_NODE_H })
    // 单节点时 dagre 的中心等于自身中心，左上角应落在 margin 上
    expect(pos.get(1)).toEqual({ x: 40, y: 40 })
  })
})

describe('edgeAnchors —— 按相对位置选边', () => {
  const at = (x: number, y: number) => ({ x, y })

  it('纵向相邻：从下边连到上边', () => {
    expect(edgeAnchors(at(0, 0), at(0, 200))).toEqual({
      x1: LAYOUT_NODE_W / 2,
      y1: LAYOUT_NODE_H,
      x2: LAYOUT_NODE_W / 2,
      y2: 200,
    })
  })

  it('横向相邻：从右边连到左边（LR 布局的关键）', () => {
    expect(edgeAnchors(at(0, 0), at(300, 0))).toEqual({
      x1: LAYOUT_NODE_W,
      y1: LAYOUT_NODE_H / 2,
      x2: 300,
      y2: LAYOUT_NODE_H / 2,
    })
  })

  it('目标在上方 / 左侧时锚点反向，不会从背面穿出去', () => {
    expect(edgeAnchors(at(0, 200), at(0, 0)).y1).toBe(200)
    expect(edgeAnchors(at(0, 200), at(0, 0)).y2).toBe(LAYOUT_NODE_H)
    expect(edgeAnchors(at(300, 0), at(0, 0)).x1).toBe(300)
    expect(edgeAnchors(at(300, 0), at(0, 0)).x2).toBe(LAYOUT_NODE_W)
  })

  it('斜向时取主方向：纵向差更大就走上下边', () => {
    const a = edgeAnchors(at(0, 0), at(40, 300))
    expect(a.y1).toBe(LAYOUT_NODE_H)
    expect(a.y2).toBe(300)
  })
})

describe('layoutBounds —— 画布基准尺寸', () => {
  it('空布局退化为一个节点盒', () => {
    const b = layoutBounds(new Map())
    expect(b.width).toBe(LAYOUT_NODE_W + 80)
    expect(b.height).toBe(LAYOUT_NODE_H + 80)
  })

  it('装得下右下角那个节点（含尺寸与 padding）', () => {
    const b = layoutBounds(new Map([[1, { x: 500, y: 300 }]]))
    expect(b.width).toBe(500 + LAYOUT_NODE_W + 40)
    expect(b.height).toBe(300 + LAYOUT_NODE_H + 40)
  })
})
