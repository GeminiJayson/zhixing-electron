/**
 * 连线路径：三次贝塞尔（对齐 Obsidian Graph View 的流体弧）。
 *
 * 控制点沿**连线法线**方向偏移，于是曲线中段微微鼓起、两端贴住节点 ——
 * 这是 Obsidian 那种「轻微自然弧度」的来源，而不是大弧线或死板直线。
 * 弧高与长度挂钩但有上限：短线几乎笔直，长线也不会甩出夸张的弯。
 *
 * 单独成文件是为了能在 vitest 里直接钉住几何（页面里跑不了单测）。
 */

/** 弧高上限（px）—— 保证「微弱、优雅」，不是大弧。 */
export const MAX_BULGE = 18

/** 弧高相对长度的比例。 */
const BULGE_RATIO = 0.12

/** 控制点相对端点的位置（0.25 / 0.75 是标准三次贝塞尔对称取法）。 */
const C1_T = 0.25
const C2_T = 0.75

/** 一条连线的两个端点。 */
export interface EdgeEnds {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** 弧高：length 的 12%，封顶 MAX_BULGE。极短的边按接近直线处理。 */
export function bulgeOf(len: number): number {
  if (!Number.isFinite(len) || len <= 0) return 0
  return Math.min(MAX_BULGE, len * BULGE_RATIO)
}

/** 控制点（两个，对称分布在法线同侧）。零长度时退化为端点本身。 */
export function controlPoints({ x1, y1, x2, y2 }: EdgeEnds): [number, number, number, number] {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy)
  const bulge = bulgeOf(len)
  if (len < 0.5) return [x1, y1, x2, y2]
  // 法线方向（连线逆时针旋转 90°）
  const nx = -dy / len
  const ny = dx / len
  return [
    x1 + dx * C1_T + nx * bulge,
    y1 + dy * C1_T + ny * bulge,
    x1 + dx * C2_T + nx * bulge,
    y1 + dy * C2_T + ny * bulge
  ]
}

/** 供 <path d=…> 使用的路径串。 */
export function edgePath(ends: EdgeEnds): string {
  const { x1, y1, x2, y2 } = ends
  const [c1x, c1y, c2x, c2y] = controlPoints(ends)
  // 太短的边直接画直线：贝塞尔在这种尺度上只会显得抖
  if (Math.hypot(x2 - x1, y2 - y1) < 0.5) return `M${x1},${y1} L${x2},${y2}`
  return `M${x1},${y1} C${c1x},${c1y} ${c2x},${c2y} ${x2},${y2}`
}

/**
 * 沿连线方向、从起点前进 dist 的点 —— 给「贴着起点的边标签」用。
 *
 * 为什么不用中点：边的中段很可能正好穿过另一个节点（纵向分层布局里很常见），
 * 标签压上去就糊成一团；而起点附近一定是空的。
 */
export function edgePointFrom(ends: EdgeEnds, dist: number): { x: number; y: number } {
  const { x1, y1, x2, y2 } = ends
  const len = Math.hypot(x2 - x1, y2 - y1)
  if (len < 0.5) return { x: x1, y: y1 }
  const step = Math.min(dist, len / 2)
  return { x: x1 + ((x2 - x1) / len) * step, y: y1 + ((y2 - y1) / len) * step }
}

/**
 * 把两端从节点中心沿连线方向收回一段，给箭头留出落点。
 *
 * 不收边的话箭头会压在节点图形下面 —— 表现就是「明明设了箭头却看不到」。
 * 太短的边原样返回，免得收回后退化成零长甚至反向。
 */
export function trimEnd(ends: EdgeEnds, shrink: number): EdgeEnds {
  const { x1, y1, x2, y2 } = ends
  const len = Math.hypot(x2 - x1, y2 - y1)
  if (len <= shrink * 2) return ends
  const ux = (x2 - x1) / len
  const uy = (y2 - y1) / len
  return {
    x1: x1 + ux * shrink,
    y1: y1 + uy * shrink,
    x2: x2 - ux * shrink,
    y2: y2 - uy * shrink
  }
}

/**
 * 曲线在 t=0.5 处的点 —— 删除按钮要压在**曲线上**，用两端的中点会偏出去。
 * 三次贝塞尔在 t=0.5 的取值：(P0 + 3C1 + 3C2 + P3) / 8
 */
export function edgeMidpoint(ends: EdgeEnds): { x: number; y: number } {
  const { x1, y1, x2, y2 } = ends
  const [c1x, c1y, c2x, c2y] = controlPoints(ends)
  return {
    x: (x1 + 3 * c1x + 3 * c2x + x2) / 8,
    y: (y1 + 3 * c1y + 3 * c2y + y2) / 8
  }
}
