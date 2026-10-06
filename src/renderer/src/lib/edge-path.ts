/**
 * 连线路径：**按边方向的正交折线**。
 *
 * 工作流画布用它代替流体弧 —— 流程图更像工程图：「谁连到谁、从哪条边出入」
 * 一眼可辨，而贝塞尔弧线在节点密集时会糊成一片。
 *
 * 单独成文件是为了能在 vitest 里直接钉住几何（页面里跑不了单测）。
 *
 * 早先这里还有图谱那边的贝塞尔弧（`edgePath` / `elbowPath` / `bulgeOf` /
 * `controlPoints` / `MAX_BULGE` / `EdgeEnds`）—— 图谱换 G6 后用内置的 cubic 边，
 * 那几条连同它们的常量一起删了；`SIDE_NORMAL` / `ORTHO_STUB` 收成模块内部常量。
 */

/** 锚点所在的边（也是连线的出入方向基准）。 */
export type AnchorSide = 'top' | 'bottom' | 'left' | 'right'

/** 带边方向的锚点：side 说明这条线是从哪条边出去 / 进入哪条边。 */
export interface Anchor {
  x: number
  y: number
  side: AnchorSide
}

/** 各边**朝外**的法线方向。 */
const SIDE_NORMAL: Record<AnchorSide, { x: number; y: number }> = {
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
const ORTHO_STUB = 14

/**
 * 正交连线：从 from 沿它所在边的**法线**出发、逆着 to 所在边的法线**垂直进入**。
 *
 * 与「按 |dx| / |dy| 猜主方向」的老写法（已删的 elbowPath）的关键差别：
 * 那种写法在「条件节点从菱形尖角水平出线、却要接到目标上边」时会走「竖—横—竖」，
 * 末段竖直正好落在目标右边缘上，整条线贴着目标边框往下走，看上去就像线和节点的边重合了。
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
