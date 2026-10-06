/**
 * 图谱节点图标 —— **纯数据 + 生成自包含 SVG**。
 *
 * 之前这份形状长在 `GraphNodeIcon.tsx`（React 组件）里，颜色靠 `graph.css` 的
 * `.gnode__icon .gn-s1` 这类 CSS 规则 + `--gnode-c` 变量派生。
 * 那条路在 canvas 上走不通（G6 的原生节点不认 CSS），所以这里做两件事：
 *
 *   1. **形状**照旧是六个 kind 各自的分层结构（基底 / 内层 / 细节线），只是从 JSX 变成数据；
 *   2. **颜色**由 TS 按原来的 CSS 公式算出来并**内联进 SVG**，再交给 G6 的 `iconSrc`
 *      （data URL）—— 于是「节点图标」这件事完全交给 G6 画，我们只提供资产。
 *
 * 颜色公式与原 CSS 一一对应（见 graph.css 的 .gnode__icon 段）：
 *
 *   | 色槽 | 原 CSS | 现在 |
 *   | --- | --- | --- |
 *   | s1 | 主色令牌 --gnode-c | 主色 |
 *   | s2 | `color-mix(in srgb, 主色 38%, --bg-layer-solid)` | `mix(主色, .38, 底色)` |
 *   | s3 | `color-mix(in srgb, 主色 22%, --fg-primary)` | `mix(主色, .22, 前景)` |
 *   | stroke | `color-mix(in srgb, 主色 40%, --bg-canvas)` | `mix(主色, .40, 画布底)` |
 *   | ring | 主色 --gnode-c + 虚线 | 主色 + `3 3` |
 *   | plus / lines | `color-mix(in srgb, 主色 30%/22%, --fg-primary)` | 同左 |
 *
 * 换主题 → 颜色重新算 → 新的 data URL → `setOptions` 增量更新（不必重建图）。
 */
import { mix } from './g6-theme'

/** 图标的色槽 —— 与原来那批 CSS 类同名，方便对照。 */
export type IconTone = 's1' | 's2' | 's3' | 'stroke' | 'ring' | 'plus' | 'lines'

export type IconShape =
  | { tag: 'polygon'; points: string; tone: IconTone }
  | { tag: 'circle'; r: number; tone: IconTone }
  | { tag: 'rect'; x: number; y: number; width: number; height: number; rx: number; tone: IconTone }
  | { tag: 'path'; d: string; tone: IconTone }

/** 十角星（任务）。 */
function starPoints(r: number): string {
  const pts: string[] = []
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45
    const a = (Math.PI / 5) * i - Math.PI / 2
    pts.push(`${(Math.cos(a) * rad).toFixed(2)},${(Math.sin(a) * rad).toFixed(2)}`)
  }
  return pts.join(' ')
}

/** 闪电（闪念）。 */
function boltPoints(r: number, scale = 1): string {
  return [
    `${(-r * 0.35 * scale).toFixed(2)},${(-r * scale).toFixed(2)}`,
    `${(r * 0.55 * scale).toFixed(2)},${(-r * 0.15 * scale).toFixed(2)}`,
    `${(r * 0.1 * scale).toFixed(2)},${(-r * 0.15 * scale).toFixed(2)}`,
    `${(r * 0.4 * scale).toFixed(2)},${(r * scale).toFixed(2)}`,
    `${(-r * 0.5 * scale).toFixed(2)},${(r * 0.1 * scale).toFixed(2)}`,
    `${(-r * 0.1 * scale).toFixed(2)},${(r * 0.1 * scale).toFixed(2)}`,
  ].join(' ')
}

/**
 * 六个 kind 的分层形状 —— 与原 `GraphNodeIcon` 逐条对应。
 *
 * 语义没变：笔记有折角与文本线、任务在星里嵌圆点、闪念叠一层内闪电、
 * 段落引用双菱形、待建链接是虚线环加号、文件夹是深浅两片。
 */
export function iconShapes(kind: string, r: number): IconShape[] {
  if (kind === 'task') {
    return [
      { tag: 'polygon', points: starPoints(r), tone: 's1' },
      { tag: 'circle', r: r * 0.42, tone: 's2' },
      { tag: 'circle', r: r * 0.16, tone: 's3' },
    ]
  }
  if (kind === 'flash') {
    return [
      { tag: 'polygon', points: boltPoints(r), tone: 's1' },
      { tag: 'polygon', points: boltPoints(r * 0.55), tone: 's2' },
    ]
  }
  if (kind === 'anchor') {
    const rad = r * 0.72
    return [
      { tag: 'polygon', points: `0,${-rad} ${rad},0 0,${rad} ${-rad},0`, tone: 's1' },
      { tag: 'polygon', points: `0,${-rad * 0.52} ${rad * 0.52},0 0,${rad * 0.52} ${-rad * 0.52},0`, tone: 's2' },
      { tag: 'circle', r: r * 0.14, tone: 's3' },
    ]
  }
  if (kind === 'dangling') {
    return [
      { tag: 'circle', r, tone: 'ring' },
      { tag: 'path', d: `M${-r * 0.45} 0 h${r * 0.9} M0 ${-r * 0.45} v${r * 0.9}`, tone: 'plus' },
    ]
  }
  if (kind === 'folder') {
    return [
      { tag: 'rect', x: -r, y: -r * 1.02, width: r * 0.95, height: r * 0.42, rx: 1.5, tone: 's2' },
      { tag: 'rect', x: -r, y: -r * 0.72, width: r * 2, height: r * 1.62, rx: 2.5, tone: 'stroke' },
    ]
  }
  // note（默认）：文档 + 折角 + 文本线
  const f = r * 0.42
  return [
    { tag: 'path', d: `M${-r},${-r} L${r - f},${-r} L${r},${-r + f} L${r},${r} L${-r},${r} Z`, tone: 'stroke' },
    { tag: 'path', d: `M${r - f},${-r} L${r},${-r + f} L${r - f},${-r + f} Z`, tone: 's2' },
    { tag: 'path', d: `M${-r * 0.55} ${-r * 0.1} h${r * 0.95} M${-r * 0.55} ${r * 0.42} h${r * 0.6}`, tone: 'lines' },
  ]
}

/** 当前主题下的一组颜色（由调用方从 token 读好传进来）。 */
export interface IconPalette {
  /** 节点主色（colorOf 的结果）。 */
  color: string
  /** `--bg-layer-solid`：图层底色，s2 向它混合。 */
  bgLayer: string
  /** `--fg-primary`：前景色，s3 与细节线向它混合。 */
  fgPrimary: string
  /** `--bg-canvas`：画布底色，描边向它混合。 */
  bgCanvas: string
}

/** 色槽 → SVG 呈现属性（与 graph.css 原规则等价）。 */
export function toneAttrs(tone: IconTone, p: IconPalette): string {
  switch (tone) {
    case 's1':
      return `fill="${p.color}"`
    case 's2':
      return `fill="${mix(p.color, 0.38, p.bgLayer)}"`
    case 's3':
      return `fill="${mix(p.color, 0.22, p.fgPrimary)}"`
    case 'stroke':
      return `stroke="${mix(p.color, 0.4, p.bgCanvas)}" stroke-width="1" stroke-linejoin="round"`
    case 'ring':
      return `fill="none" stroke="${p.color}" stroke-width="1.4" stroke-dasharray="3 3"`
    case 'plus':
      return `fill="none" stroke="${mix(p.color, 0.3, p.fgPrimary)}" stroke-width="1.6" stroke-linecap="round"`
    default:
      return `fill="none" stroke="${mix(p.color, 0.22, p.fgPrimary)}" stroke-width="1" stroke-linecap="round"`
  }
}

function shapeToSvg(s: IconShape, p: IconPalette): string {
  const attrs = toneAttrs(s.tone, p)
  if (s.tag === 'polygon') return `<polygon points="${s.points}" ${attrs}/>`
  if (s.tag === 'circle') return `<circle r="${s.r}" ${attrs}/>`
  if (s.tag === 'rect') return `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${s.rx}" ${attrs}/>`
  return `<path d="${s.d}" ${attrs}/>`
}

/**
 * 生成自包含的图标 SVG（坐标系以原点为中心，半径 r）。
 *
 * **自包含**是重点：颜色内联成具体色值，不引用任何 CSS 类或变量 ——
 * 上一轮试过把带 `.gn-s1` 类的 SVG 转 data URL，渲染出来是**纯黑**
 * （data URL 里拿不到页面的 CSS），所以颜色必须在这里算好。
 */
export function iconSvg(kind: string, r: number, p: IconPalette): string {
  const box = r * 2
  const body = iconShapes(kind, r)
    .map((s) => shapeToSvg(s, p))
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="${-r} ${-r} ${box} ${box}">` +
    body +
    '</svg>'
  )
}

/** 图标 → G6 的 `iconSrc` 能吃的 data URL。 */
export function iconDataUrl(kind: string, r: number, p: IconPalette): string {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(iconSvg(kind, r, p))
}
