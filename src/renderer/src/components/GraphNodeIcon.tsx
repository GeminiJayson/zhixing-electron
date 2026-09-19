import type { CSSProperties, ReactElement } from 'react'

/**
 * 图谱节点图标（多色）。
 *
 * 之前每类节点都是**单色实心**（一个 fill 的星/闪电/便签），在小尺寸下只剩一个色块，
 * 既分不出层次、也读不出「这是哪一类」。现在每类都由 2~3 个图层组成：
 *
 *   - 基底   fill  = 节点主色（--gnode-c，由 colorOf 决定，保留原有语义）
 *   - 内层   fill  = 主色向底色混合（更浅，造出「切面」）
 *   - 描边   stroke= 主色向画布底色混合（更深，让形状在深色底上也有边界）
 *
 * 形状本身也按语义强化：笔记有折角与文本线、任务在星里嵌圆点、闪念叠一层内闪电、
 * 段落引用双菱形、待建链接是虚线环加号、文件夹是深浅两片。
 *
 * 三档颜色全部走 CSS（见 graph.css 的 .gnode__icon 规则），这里只管形状与色槽，
 * 于是换主题时无需改这个文件。
 */

interface Props {
  /** 节点类型：note / task / flash / anchor / dangling / folder */
  kind: string
  /** 外接半径 */
  r: number
  /** 节点主色，作为 --gnode-c 传进 CSS */
  color: string
}

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

export function GraphNodeIcon({ kind, r, color }: Props): ReactElement {
  const style = { '--gnode-c': color } as CSSProperties

  if (kind === 'task') {
    return (
      <g className="gnode__icon" style={style}>
        <polygon className="gn-stroke gn-s1" points={starPoints(r)} />
        {/* 内圈 + 中心点：星形里嵌一个「待办项」的样子 */}
        <circle className="gn-s2" r={r * 0.42} />
        <circle className="gn-s3" r={r * 0.16} />
      </g>
    )
  }

  if (kind === 'flash') {
    return (
      <g className="gnode__icon" style={style}>
        <polygon className="gn-stroke gn-s1" points={boltPoints(r)} />
        {/* 叠一层更小的闪电：闪电的「再闪一次」，也补上第二色 */}
        <polygon className="gn-s2" points={boltPoints(r * 0.55)} />
      </g>
    )
  }

  if (kind === 'anchor') {
    const rad = r * 0.72
    return (
      <g className="gnode__icon" style={style}>
        <polygon className="gn-stroke gn-s1" points={`0,${-rad} ${rad},0 0,${rad} ${-rad},0`} />
        {/* 双菱形：外圈引用、内核锚点 */}
        <polygon className="gn-s2" points={`0,${-rad * 0.52} ${rad * 0.52},0 0,${rad * 0.52} ${-rad * 0.52},0`} />
        <circle className="gn-s3" r={r * 0.14} />
      </g>
    )
  }

  if (kind === 'dangling') {
    return (
      <g className="gnode__icon" style={style}>
        {/* 虚线环 + 加号：这一圈就是在说「还没有这条链接，点我建一个」 */}
        <circle className="gn-ring" r={r} />
        <path className="gn-plus" d={`M${-r * 0.45} 0 h${r * 0.9} M0 ${-r * 0.45} v${r * 0.9}`} />
      </g>
    )
  }

  if (kind === 'folder') {
    return (
      <g className="gnode__icon" style={style}>
        {/* 后片（选项卡）用浅色、前片用主色：两块深浅一叠就是文件夹 */}
        <rect className="gn-s2" x={-r} y={-r * 1.02} width={r * 0.95} height={r * 0.42} rx={1.5} />
        <rect className="gn-stroke gn-s1" x={-r} y={-r * 0.72} width={r * 2} height={r * 1.62} rx={2.5} />
      </g>
    )
  }

  // note（默认）：文档 + 折角 + 文本线
  const f = r * 0.42
  return (
    <g className="gnode__icon" style={style}>
      <path className="gn-stroke gn-s1" d={`M${-r},${-r} L${r - f},${-r} L${r},${-r + f} L${r},${r} L${-r},${r} Z`} />
      {/* 折角三角用浅色：一眼看出这是「一页纸」而不是方块 */}
      <path className="gn-s2" d={`M${r - f},${-r} L${r},${-r + f} L${r - f},${-r + f} Z`} />
      <path className="gn-lines gn-s3" d={`M${-r * 0.55} ${-r * 0.1} h${r * 0.95} M${-r * 0.55} ${r * 0.42} h${r * 0.6}`} />
    </g>
  )
}
