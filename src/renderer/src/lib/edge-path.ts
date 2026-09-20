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
 * 正交折线（H-V-H / V-H-V）：从起点沿主方向走、在中间拐两次、直角进入目标。
 *
 * 工作流画布用它代替流体弧 —— 流程图（F6 的 Dagre 示例也是这种）更像工程图：
 * 「谁连到谁、从哪条边出入」一眼可辨，而贝塞尔弧线在节点密集时会糊成一片。
 * 知识图谱仍用 edgePath 的流体弧（那边追求的是「网络感」，不是流程感）。
 */
export function elbowPath(ends: EdgeEnds): string {
  const { x1, y1, x2, y2 } = ends
  const dx = x2 - x1
  const dy = y2 - y1
  // 几乎正对时直接一条直线，别为 1px 的错位拐两次
  if (Math.abs(dx) < 1) return `M${x1},${y1} L${x2},${y2}`
  if (Math.abs(dy) < 1) return `M${x1},${y1} L${x2},${y2}`
  if (Math.abs(dy) >= Math.abs(dx)) {
    // 纵向为主：先竖到中线，横过去，再竖到目标
    const my = y1 + dy / 2
    return `M${x1},${y1} L${x1},${my} L${x2},${my} L${x2},${y2}`
  }
  // 横向为主：先横到中线，竖过去，再横到目标
  const mx = x1 + dx / 2
  return `M${x1},${y1} L${mx},${y1} L${mx},${y2} L${x2},${y2}`
}

// ---------------------------------------------------------------- 按边方向的正交路由

/** 锚点所在的边（也是连线的出入方向基准）。 */
export type AnchorSide = 'top' | 'bottom' | 'left' | 'right'

/** 带边方向的锚点：side 说明这条线是从哪条边出去 / 进入哪条边。 */
export interface Anchor {
  x: number
  y: number
  side: AnchorSide
}

/** 各边**朝外**的法线方向（调用方要沿它把按钮 / 手柄退到节点外时用得上）。 */
export const SIDE_NORMAL: Record<AnchorSide, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}

const isVerticalSide = (side: AnchorSide): boolean => side === 'top' || side === 'bottom'

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * 串成路径串，顺手做两件清理：
 *   1. 丢掉相邻的重复点（两点离得近时容易折出零长段）；
 *   2. 丢掉共线的中间点 —— 三点一线时中间那个点不改变走向，留着只会让路径
 *      绕出去再原路折回来（同一水平线上横出横入时最容易出现）。
 */
function polyline(points: { x: number; y: number }[]): string {
  const kept: { x: number; y: number }[] = []
  const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.001
  for (const p of points) {
    const last = kept[kept.length - 1]
    if (last && same(last.x, p.x) && same(last.y, p.y)) continue
    while (kept.length >= 2) {
      const a = kept[kept.length - 2]
      const b = kept[kept.length - 1]
      const collinear =
        (same(a.x, b.x) && same(b.x, p.x)) || (same(a.y, b.y) && same(b.y, p.y))
      if (!collinear) break
      kept.pop()
    }
    kept.push(p)
  }
  return kept.map((p, i) => `${i === 0 ? 'M' : 'L'}${round2(p.x)},${round2(p.y)}`).join(' ')
}

/** 连接点先沿法线走出的这一小段（px）：让末段落在节点之外，不与边框重合。 */
export const ORTHO_STUB = 14

/**
 * 正交连线：从 from 沿它所在边的**法线**出发、逆着 to 所在边的法线**垂直进入**。
 *
 * 与 elbowPath 的关键差别在「按什么决定折法」。elbowPath 用 |dx| / |dy| 猜主方向，
 * 于是出现这种坏情况：条件节点从菱形尖角**水平**出线，却要接到目标**上边** ——
 * 它按 |dy| 更大走了「竖—横—竖」，末段竖直正好落在目标右边缘上，
 * 整条线贴着目标边框往下走，看上去就是「线和节点的边重合了」。
 *
 * 这里改用锚点自带的边方向：首段一定垂直于出发的那条边，末段一定垂直于进入的那条边，
 * 中间的过渡段落在节点外侧（而不是节点边上）。
 */
export function orthogonalPath(from: Anchor, to: Anchor, stub = ORTHO_STUB): string {
  const span = Math.hypot(to.x - from.x, to.y - from.y)
  // 两点离得太近时把 stub 收一收，否则会折返出回头线
  const s = Math.max(3, Math.min(stub, span / 3))
  const outFrom = SIDE_NORMAL[from.side]
  const outTo = SIDE_NORMAL[to.side]
  const start = { x: from.x + outFrom.x * s, y: from.y + outFrom.y * s }
  const end = { x: to.x + outTo.x * s, y: to.y + outTo.y * s }

  const fromVertical = isVerticalSide(from.side)
  const toVertical = isVerticalSide(to.side)

  let mids: { x: number; y: number }[]
  if (fromVertical && toVertical) {
    // 竖出竖入：过渡横线贴着目标那条边之外走
    mids = [{ x: start.x, y: end.y }]
  } else if (!fromVertical && !toVertical) {
    // 横出横入：过渡竖线落在两个节点之间，避免从目标身上横穿过去
    const mx = (start.x + end.x) / 2
    mids = [
      { x: mx, y: start.y },
      { x: mx, y: end.y },
    ]
  } else if (!fromVertical && toVertical) {
    // 横出竖入：竖段贴着源的外侧，横段贴着目标那条边之外
    mids = [{ x: start.x, y: end.y }]
  } else {
    // 竖出横入：横段贴着源的外侧，竖段贴着目标那条边之外
    mids = [{ x: end.x, y: start.y }]
  }

  return polyline([{ x: from.x, y: from.y }, start, ...mids, end, { x: to.x, y: to.y }])
}

/**
 * 折线路径的**弧长中点** —— 删除按钮要压在这条线上，就得沿路径量一半，不能再用
 * 「两端点的中点」那种近似：连线改成正交折线之后，两端中点早就跑到线外面去了
 * （实测按钮飘在空白处，点不到、删不掉）。
 */
export function edgePathMidpoint(d: string): { x: number; y: number } {
  const pts = [...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }))
  if (!pts.length) return { x: 0, y: 0 }
  if (pts.length === 1) return pts[0]
  const lens: number[] = []
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    lens.push(len)
    total += len
  }
  if (total < 0.001) return pts[0]
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const len = lens[i - 1]
    if (acc + len >= total / 2) {
      const t = len < 0.001 ? 0 : (total / 2 - acc) / len
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
      }
    }
    acc += len
  }
  return pts[pts.length - 1]
}

/**
 * 沿连线方向、从起点按**直线距离**前进 dist 的点 —— 给「贴着起点的边标签」用。
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
