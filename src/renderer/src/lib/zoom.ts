/**
 * 笔记编辑区的缩放（Ctrl / Cmd + 滚轮）—— 纯逻辑，便于单测。
 *
 * **一篇笔记一份比例**：切到另一篇用它自己的，切回来恢复原来的 —— 所以存档是一张
 * `{ 笔记 id: 比例 }` 的表，而不是一个全局值（早先那版是全局的，切一篇笔记就把
 * 另一篇的比例也带过去了）。
 *
 * 缩放值落在正文容器的 `zoom` 上（见 notes.css 的白名单规则，**不含工具栏**）：
 * 正文、表格、图片、代码块一起变，不必逐个去改编辑器内部的字号 —— 那样改不全
 * （图片与嵌入内容会漏），而且每加一处样式就得记着乘一次。
 */
/** 存档键：`{"12":1.4,"7":1.1}` */
export const ZOOM_MAP_KEY = 'note.zoom.map'
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

/** 存档字符串 → 比例表；坏值（非 JSON、数组、非数字、越界）一律丢弃 */
export function readZoomMap(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = clampZoom(v)
  }
  return out
}

/** 某篇笔记的比例；没有记录（或还没选中笔记）就是 100% */
export function readZoomFor(raw: string | null | undefined, noteId: string | number | null | undefined): number {
  if (noteId == null) return ZOOM_DEFAULT
  return readZoomMap(raw)[String(noteId)] ?? ZOOM_DEFAULT
}

/** 写回某篇笔记的比例，返回新的存档字符串（没有当前笔记就原样返回） */
export function writeZoomFor(
  raw: string | null | undefined,
  noteId: string | number | null | undefined,
  zoom: number
): string {
  const map = readZoomMap(raw)
  if (noteId != null) map[String(noteId)] = clampZoom(zoom)
  return JSON.stringify(map)
}

/** 比例 → 百分比文案（"110%"） */
export function zoomLabel(zoom: number): string {
  return Math.round(clampZoom(zoom) * 100) + '%'
}
