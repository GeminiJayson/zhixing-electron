/**
 * 工作流分层布局（dagre）—— 对照 AntV F6 的「Dagre 流程图」示例。
 *
 * F6 那个示例的做法是：把流程交给 dagre 做**分层**布局 —— 按依赖关系分层、
 * 层内排序以尽量少交叉、节点尺寸参与计算（所以不会重叠），方向由 rankdir 决定。
 * 本模块把同样的语义搬到工作流上。
 *
 * 工作流的图结构是**隐式**的：没有边表，只有两处约定 ——
 *   1. 顺序边：order_index 相邻的步骤之间存在依赖（相邻即先后）
 *   2. 分支边：node → node.branch_node_id（满足）/ node.branch_false_node_id（不满足）
 * 这里把它们投影成 dagre 的有向图。
 *
 * 为什么用最小输入接口而不是整个 WorkflowNodePayload：布局只需要 id / 顺序 / 分支
 * 这三个字段，收窄之后既可以脱离数据层单测，也不会因为 payload 长出字段而跟着变。
 */
import dagre from '@dagrejs/dagre'
import { NODE_H, NODE_W } from './workflow-node-box'

/** 布局只需要这三个字段（WorkflowNodePayload 结构上兼容）。 */
export interface LayoutNode {
  id: number
  order_index: number
  branch_node_id: number | null
  /** 条件不成立时的分支目标（条件节点的第二条出边） */
  branch_false_node_id?: number | null
}

/** 布局方向：TB 纵向（步骤自上而下）/ LR 横向（步骤自左而右）。 */
export type WorkflowRankDir = 'TB' | 'LR'

interface WorkflowLayoutOptions {
  rankdir?: WorkflowRankDir
  /** 同层节点间距 */
  nodesep?: number
  /** 层间距 */
  ranksep?: number
  nodeWidth?: number
  nodeHeight?: number
}

/**
 * 布局四周留白（喂给 dagre 的 marginx / marginy）。
 *
 * 节点盒尺寸**不在本文件定义** —— 它只有一处来源（`workflow-node-box` 的
 * NODE_W / NODE_H）。这里曾经有一对 LAYOUT_NODE_W / LAYOUT_NODE_H，靠一句
 * 「与 WorkflowPage 保持一致」的注释维持同步，换 G6 时已经收掉了。
 */
const LAYOUT_MARGIN = 40

/** 投影出来的边。branch=true 表示条件分支边（页面用虚线画）。 */
interface LayoutEdge {
  from: number
  to: number
  branch: boolean
}

/**
 * 把工作流投影成边表。
 * 自环与指向不存在节点的分支直接丢弃（数据层会校验，但布局不该因此崩掉）；
 * 同一条边只保留一次，避免顺序边与分支边重复时把 dagre 的图撑出重边。
 */
export function workflowEdges(nodes: readonly LayoutNode[]): LayoutEdge[] {
  const ordered = [...nodes].sort((a, b) => (a.order_index || 0) - (b.order_index || 0) || a.id - b.id)
  const ids = new Set(ordered.map((n) => n.id))
  const seen = new Set<string>()
  const out: LayoutEdge[] = []
  const push = (from: number, to: number, branch: boolean): void => {
    const key = from + '>' + to
    if (seen.has(key)) return
    seen.add(key)
    out.push({ from, to, branch })
  }
  for (let i = 0; i + 1 < ordered.length; i++) push(ordered[i].id, ordered[i + 1].id, false)
  for (const n of ordered) {
    // 条件节点的两条出边都参与分层，分支才会落到与主线不同的层
    for (const to of [n.branch_node_id, n.branch_false_node_id ?? null]) {
      if (to == null || to === n.id || !ids.has(to)) continue
      push(n.id, to, true)
    }
  }
  return out
}

/**
 * 计算分层布局，返回**节点左上角**坐标（dagre 给的是中心点，这里换算掉）。
 * 纯函数：同样的输入永远得到同样的输出，几何由单测钉住。
 */
export function layoutWorkflow(
  nodes: readonly LayoutNode[],
  options: WorkflowLayoutOptions = {}
): Map<number, { x: number; y: number }> {
  const {
    rankdir = 'TB',
    nodesep = 48,
    ranksep = 64,
    nodeWidth = NODE_W,
    nodeHeight = NODE_H,
  } = options
  const out = new Map<number, { x: number; y: number }>()
  if (!nodes.length) return out

  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir, nodesep, ranksep, marginx: LAYOUT_MARGIN, marginy: LAYOUT_MARGIN })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of nodes) g.setNode(String(n.id), { width: nodeWidth, height: nodeHeight })
  for (const e of workflowEdges(nodes)) g.setEdge(String(e.from), String(e.to))

  dagre.layout(g)

  for (const n of nodes) {
    const p = g.node(String(n.id)) as { x: number; y: number } | undefined
    if (!p) continue
    out.set(n.id, {
      x: Math.round(p.x - nodeWidth / 2),
      y: Math.round(p.y - nodeHeight / 2),
    })
  }
  return out
}

/*
 * 这里原来还有一个 `directedAnchors` —— 按相对位置在两个节点盒之间挑连线边（上/下/左/右）。
 *
 * 它连同 lib/edge-path.ts 的 `orthogonalPath`、lib/workflow-anchors.ts 一起删掉了：
 * 那是「自己算正交折线」的那套轮子，现在连线交给 G6 内置的
 * `polyline` 边 + `router: { type: 'shortest-path' }`（A* 避障）——
 * 节点上不留固定连接点，端点由 G6 按连线方向自动取边框交点。
 */

/**
 * 布局结果的包围盒（含节点尺寸与 padding）。
 * 画布基准尺寸要用它 —— 否则自动布局把步骤铺开后，fitView 仍按旧基准适配，会显示不全。
 */
export function layoutBounds(
  pos: Map<number, { x: number; y: number }>,
  nodeWidth = NODE_W,
  nodeHeight = NODE_H,
  padding = LAYOUT_MARGIN
): { width: number; height: number } {
  if (!pos.size) return { width: nodeWidth + padding * 2, height: nodeHeight + padding * 2 }
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pos.values()) {
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return {
    width: Math.round(maxX + nodeWidth + padding),
    height: Math.round(maxY + nodeHeight + padding),
  }
}
