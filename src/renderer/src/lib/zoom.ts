/**
 * 笔记编辑区的缩放（Ctrl / Cmd + 滚轮）—— 纯逻辑，便于单测。
 *
 * 缩放值写在 `.sheet__body` 的 `zoom` 上（见 notes.css）：正文、表格、图片、代码块
 * 一起变，不必逐个去改编辑器内部的字号 —— 那样改不全（图片与嵌入的表格会漏），
 * 而且每加一处样式就得记着乘一次。
 *
 * 一个值管全页：库里的笔记与挂载进来的本地文件共用同一个 `.sheet__body`，
 * 所以"真实笔记与挂载文件都要能缩"这件事不需要两套实现。
 */
export const ZOOM_KEY = 'note.zoom'
export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 2.5
export const ZOOM_DEFAULT = 1
/** 一档 10%：再细就会滚半天看不出变化，再粗就跳得难受 */
export const ZOOM_STEP = 0.1

/** 收进 [0.5, 2.5] 并对齐到 0.1 —— 不这么做，滚十几下会攒出 1.2000000000000002 */
export function clampZoom(v: number): number {
  // 只把 NaN 当"没值"：±Infinity 是"极其大 / 极其小"，按上下限收才对
  if (Number.isNaN(v)) return ZOOM_DEFAULT
  const aligned = Math.round(v * 10) / 10
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, aligned))
}

/** 滚轮方向 → 下一档：向上滚（deltaY &lt; 0）放大，向下滚缩小 */
export function nextZoom(cur: number, deltaY: number): number {
  return clampZoom(clampZoom(cur) + (deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP))
}

/** localStorage 里的字符串 → 合法缩放值（没存过、存坏了都回到 1） */
export function readZoom(raw: string | null | undefined): number {
  if (raw == null || raw === '') return ZOOM_DEFAULT
  return clampZoom(Number(raw))
}

/** 缩放值 → 百分比文案（"110%"） */
export function zoomLabel(zoom: number): string {
  return Math.round(clampZoom(zoom) * 100) + '%'
}
