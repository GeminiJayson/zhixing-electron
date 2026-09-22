/**
 * 画布视图（平移 + 缩放）的纯计算。
 *
 * 图谱页与工作流页两块画布共用：都是 SVG、都用 viewBox 表达视图，
 * 所以只要产出正确的 viewBox 就够了。缩放中心、边界钳制这类最容易写错的地方
 * 放在纯函数里，用单测钉住。
 */

export interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}

/** 光标在视口内的相对位置（0–1）。 */
export interface CursorRatio {
  rx: number
  ry: number
}

// 缩放钳位：`max(0.15, min(4.0, _zoom))`。
// 早期实现取下限 0.25，少一级缩小档，大图上退不出来。
export const MIN_SCALE = 0.15
export const MAX_SCALE = 4

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** 初始视图：基准尺寸整幅铺满（缩放 1 倍）。 */
export function fitView(baseW: number, baseH: number): ViewBox {
  return { x: 0, y: 0, w: baseW, h: baseH }
}

/** 由 viewBox 反推当前缩放倍数。 */
export function scaleOf(view: ViewBox, baseW: number): number {
  return view.w > 0 ? baseW / view.w : 1
}

/**
 * 以光标为中心缩放：**光标下的那个图形点保持不动**，这样滚轮手感才对
 * （否则内容是往画布中心缩，光标下的东西会跑掉）。
 */
export function zoomAt(
  view: ViewBox,
  baseW: number,
  baseH: number,
  cursor: CursorRatio,
  factor: number
): ViewBox {
  const next = clamp(scaleOf(view, baseW) * factor, MIN_SCALE, MAX_SCALE)
  const w = baseW / next
  const h = baseH / next
  // 光标处的世界坐标，缩放在新尺寸下要落回同一个相对位置
  const worldX = view.x + cursor.rx * view.w
  const worldY = view.y + cursor.ry * view.h
  return { x: worldX - cursor.rx * w, y: worldY - cursor.ry * h, w, h }
}

/**
 * 镜头飞入：把视图中心移到指定世界坐标，保持当前缩放不变。
 */
export function centerView(view: ViewBox, worldX: number, worldY: number): ViewBox {
  return { ...view, x: worldX - view.w / 2, y: worldY - view.h / 2 }
}

/** 平移：dxRatio / dyRatio 是视口相对位移（像素位移 ÷ 视口尺寸）。 */
export function panBy(view: ViewBox, dxRatio: number, dyRatio: number): ViewBox {
  return { ...view, x: view.x - dxRatio * view.w, y: view.y - dyRatio * view.h }
}

export function toViewBoxString(view: ViewBox): string {
  return `${view.x} ${view.y} ${view.w} ${view.h}`
}

/**
 * 滚轮增量 → 缩放倍率。用指数而不是线性：连续滚动的手感才均匀，
 * 且向上滚和向下滚互为倒数，来回滚不会漂移。
 */
export function wheelFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.0015)
}
