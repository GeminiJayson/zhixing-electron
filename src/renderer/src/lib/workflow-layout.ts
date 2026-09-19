/**
 * 工作流分层布局（dagre）—— 对照 AntV F6 的「Dagre 流程图」示例。
 *
 * F6 那个示例的做法是：把流程交给 dagre 做**分层**布局 —— 按依赖关系分层、
 * 层内排序以尽量少交叉、节点尺寸参与计算（所以不会重叠），方向由 rankdir 决定。
 * 本模块把同样的语义搬到工作流上。
 *
 * 工作流的图结构是**隐式**的：没有边表，只有两处约定 ——
 *   1. 顺序边：order_index 相邻的步骤之间存在依赖（相邻即先后）
 *   2. 分支边：node → node.branch_node_id（条件分支的去向，见 WorkflowPage 的分支连线）
 * 这里把它们投影成 dagre 的有向图。
 *
 * 为什么用最小输入接口而不是整个 WorkflowNodePayload：布局只需要 id / 顺序 / 分支
 * 这三个字段，收窄之后既可以脱离数据层单测，也不会因为 payload 长出字段而跟着变。
 */
import dagre from '@dagrejs/dagre'

/** 布局只需要这三个字段（WorkflowNodePayload 结构上兼容）。 */
export interface LayoutNode {
  id: number
  order_index: number
  branch_node_id: number | null
}

/** 布局方向：TB 纵向（步骤自上而下）/ LR 横向（步骤自左而右）。 */
export type WorkflowRankDir = 'TB' | 'LR'

export interface WorkflowLayoutOptions {
  rankdir?: WorkflowRankDir
  /** 同层节点间距 */
  nodesep?: number
  /** 层间距 */
  ranksep?: number
  nodeWidth?: number
  nodeHeight?: number
}

/** 画布基准尺寸与节点盒尺寸（与 WorkflowPage 的 NODE_W / NODE_H 保持一致）。 */
export const LAYOUT_NODE_W = 150
export const LAYOUT_NODE_H = 56
/** 布局四周留白（喂给 dagre 的 marginx / marginy）。 */
export const LAYOUT_MARGIN = 40

/** 投影出来的边。branch=true 表示条件分支边（页面用虚线画）。 */
export interface LayoutEdge {
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
    const to = n.branch_node_id
    if (to == null || to === n.id || !ids.has(to)) continue
    push(n.id, to, true)
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
    nodeWidth = LAYOUT_NODE_W,
    nodeHeight = LAYOUT_NODE_H,
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

/**
 * 两个节点盒之间的连线锚点：**按相对位置挑边**，而不是写死「从底部连到顶部」。
 *
 * 纵向布局时走上下边、横向布局时走左右边、斜向时取主方向 —— 这样同一条连线在
 * TB / LR 两种排布下都贴边，而不是从节点侧面穿出去。
 */
export function edgeAnchors(
  from: { x: number; y: number },
  to: { x: number; y: number },
  nodeWidth = LAYOUT_NODE_W,
  nodeHeight = LAYOUT_NODE_H
): { x1: number; y1: number; x2: number; y2: number } {
  const fx = from.x + nodeWidth / 2
  const fy = from.y + nodeHeight / 2
  const tx = to.x + nodeWidth / 2
  const ty = to.y + nodeHeight / 2
  const dx = tx - fx
  const dy = ty - fy
  if (Math.abs(dy) >= Math.abs(dx)) {
    // 纵向为主：下边 → 上边（反之亦然）
    return dy >= 0
      ? { x1: fx, y1: from.y + nodeHeight, x2: tx, y2: to.y }
      : { x1: fx, y1: from.y, x2: tx, y2: to.y + nodeHeight }
  }
  // 横向为主：右边 → 左边（反之亦然）
  return dx >= 0
    ? { x1: from.x + nodeWidth, y1: fy, x2: to.x, y2: ty }
    : { x1: from.x, y1: fy, x2: to.x + nodeWidth, y2: ty }
}

/**
 * 布局结果的包围盒（含节点尺寸与 padding）。
 * 画布基准尺寸要用它 —— 否则自动布局把步骤铺开后，fitView 仍按旧基准适配，会显示不全。
 */
export function layoutBounds(
  pos: Map<number, { x: number; y: number }>,
  nodeWidth = LAYOUT_NODE_W,
  nodeHeight = LAYOUT_NODE_H,
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
