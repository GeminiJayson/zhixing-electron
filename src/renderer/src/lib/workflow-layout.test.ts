import { describe, expect, it } from 'vitest'
import { NODE_H, NODE_W } from './workflow-node-box'
import { layoutBounds, layoutWorkflow, workflowEdges, type LayoutNode } from './workflow-layout'

/** 造一个最小节点：只带布局关心的字段。 */
const node = (
  id: number,
  order_index: number,
  branch_node_id: number | null = null,
  branch_false_node_id: number | null = null
): LayoutNode => ({
  id,
  order_index,
  branch_node_id,
  branch_false_node_id,
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

  it('「不满足」分支与「满足」分支一样投影成边', () => {
    // 1 是条件节点：满足去 3、不满足去 4（都不与顺序边重合）
    const edges = workflowEdges([node(1, 0, 3, 4), node(2, 1), node(3, 2), node(4, 3)])
    expect(edges).toContainEqual({ from: 1, to: 3, branch: true })
    expect(edges).toContainEqual({ from: 1, to: 4, branch: true })
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

  it('「不满足」分支也落在源之下（两条出边都分层）', () => {
    const pos = layoutWorkflow([node(1, 0, 3, 4), node(2, 1), node(3, 2), node(4, 3)])
    const src = pos.get(1)!
    for (const id of [2, 3, 4]) {
      expect(pos.get(id)!.y).toBeGreaterThan(src.y)
    }
  })

  it('节点尺寸参与布局：任意两个节点都不重叠', () => {
    const pos = layoutWorkflow([node(1, 0, 4), node(2, 1), node(3, 2, 5), node(4, 3), node(5, 4)])
    expect(minCenterGap(pos)).toBeGreaterThanOrEqual(NODE_H)
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
    const pos = layoutWorkflow([node(1, 0)], { nodeWidth: NODE_W, nodeHeight: NODE_H })
    // 单节点时 dagre 的中心等于自身中心，左上角应落在 margin 上
    expect(pos.get(1)).toEqual({ x: 40, y: 40 })
  })
})

describe('layoutBounds —— 画布基准尺寸', () => {
  it('空布局退化为一个节点盒', () => {
    const b = layoutBounds(new Map())
    expect(b.width).toBe(NODE_W + 80)
    expect(b.height).toBe(NODE_H + 80)
  })

  it('装得下右下角那个节点（含尺寸与 padding）', () => {
    const b = layoutBounds(new Map([[1, { x: 500, y: 300 }]]))
    expect(b.width).toBe(500 + NODE_W + 40)
    expect(b.height).toBe(300 + NODE_H + 40)
  })
})
