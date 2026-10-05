/**
 * 图谱画布（G6 v5 实现）—— 替换原来手写 SVG + d3-force 的那一层。
 *
 * ## 职责边界
 *
 * **这个组件只管「画」与「指针交互」，不做任何业务判断。**
 * 能不能连、连了写哪张表、双击该干什么，全部由 `GraphPage` 决定并通过回调传进来 ——
 * 见 docs/specs/g6-migration.md 的保留清单。
 *
 * ## 为什么节点用 HTML 而不是内置形状
 *
 * 节点图标（`GraphNodeIcon`）是**多层 SVG + CSS 变量**画的，三档颜色全在
 * `graph.css` 的 `.gnode__icon` 规则里。用 G6 内置形状（circle/star/…）等于重画一遍图标，
 * 而且**丢掉 CSS** —— 主题包一换就得再补一套映射。
 *
 * HTML 节点是**真实 DOM**：`GraphNodeIcon` 原样复用，`var(--accent-warm)` 这类
 * 值由浏览器解析，主题切换天然跟随。代价是 251 个 DOM 节点比纯 canvas 慢，
 * 但实测（P0）这个量级完全够用。
 *
 * ## 位置持久化
 *
 * 布局由 G6 拥有，但**用户的拖动结果要跨页面存活**（原实现走模块级 `POS_CACHE`）：
 * 初始位置从 `positions` 读，拖完通过 `onPositions` 交回去。
 */
import { Graph, type IEvent } from '@antv/g6'
import { useEffect, useImperativeHandle, useRef, type ReactElement, type Ref } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GraphNodeIcon } from '@renderer/components/GraphNodeIcon'
import { NODE_R } from '@renderer/lib/graph-colors'
import { toG6Data } from '@renderer/lib/g6-adapt'
import { g6Theme, subscribeG6Theme, tokNum, tokSolid } from '@renderer/lib/g6-theme'
import type { GraphNodePayload, GraphPayload } from '@shared/types'

export interface GraphCanvasHandle {
  /** 「重新布局」：把力导向重新加热。 */
  relayout(): void
  /** 「重置视图」：缩放回 1 并适配内容。 */
  resetView(): void
}

export interface GraphCanvasProps {
  data: GraphPayload
  /** 节点主色（note 走知识类型/文件夹色，其余走 kind 色）—— 由 GraphPage 的 colorOf 决定。 */
  colorOf: (n: GraphNodePayload) => string
  /** 已存在的坐标（模块级缓存），有则沿用，没有交给布局。 */
  positions: Map<number, { x: number; y: number }>
  selected: number | null
  hover: number | null
  focused: number | null
  /** 搜索命中集合；null = 未搜索，不做淡化。 */
  searchHits: Set<number> | null
  /** 连线模式的起点（高亮用）。 */
  linkFrom: number | null
  onSelect: (id: number | null) => void
  onHover: (id: number | null) => void
  onFocus: (id: number | null) => void
  /** 双击 / 侧栏「打开」 */
  onOpenNode: (n: GraphNodePayload) => void
  /** 拖动结束后回传最新坐标 */
  onPositions: (pos: Map<number, { x: number; y: number }>) => void
  handleRef?: Ref<GraphCanvasHandle>
}

/**
 * 生成节点图标的 HTML。
 *
 * **必须自己包一层 `<svg>`**：`GraphNodeIcon` 返回的是 `<g class="gnode__icon">` ——
 * 一个 **SVG 片段**，它的尺寸在原实现里由外层 `<svg>` 给。直接塞进 HTML 的 `<div>` 里，
 * `<g>` 不是 HTML 图形元素，**不渲染也不报错**：容器有 17×17，图标却是 0×0，
 * 于是「254 个节点都在 DOM 里、一个都看不见」。
 *
 * 图标以原点为中心、半径 r 画，所以 viewBox 取 `-r -r 2r 2r` 正好框住。
 */
function iconHtml(n: GraphNodePayload, color: string, size: number): string {
  const box = size * 2
  return renderToStaticMarkup(
    <svg
      className="gnode"
      width={box}
      height={box}
      viewBox={-size + ' ' + -size + ' ' + box + ' ' + box}
      style={{ overflow: 'visible' }}
    >
      <GraphNodeIcon kind={n.kind} r={size} color={color} />
    </svg>
  )
}

export function GraphCanvasG6({
  data,
  colorOf,
  positions,
  selected,
  hover,
  focused,
  searchHits,
  linkFrom,
  onSelect,
  onHover,
  onFocus,
  onOpenNode,
  onPositions,
  handleRef,
}: GraphCanvasProps): ReactElement {
  const box = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)
  /** 回调放 ref：G6 的事件订阅只登记一次，闭包不能捕获过期的 props。 */
  const cb = useRef({ onSelect, onHover, onFocus, onOpenNode, onPositions })
  cb.current = { onSelect, onHover, onFocus, onOpenNode, onPositions }
  const payloadById = useRef(new Map<number, GraphNodePayload>())
  payloadById.current = new Map(data.nodes.map((n) => [n.id, n]))
  const colorRef = useRef(colorOf)
  colorRef.current = colorOf

  // ---- 建图（只一次）----
  useEffect(() => {
    const el = box.current
    if (!el) return
    let dead = false
    let stopTheme: (() => void) | null = null

    const t = g6Theme()
    const size = tokNum('--size-18')

    const graph = new Graph({
      container: el,
      autoFit: 'view',
      data: toG6Data(data),
      node: {
        type: 'html',
        style: {
          size: [size * 2, size * 2],
          innerHTML: (d: { id: string }) => {
            const n = payloadById.current.get(Number(d.id))
            if (!n) return ''
            return iconHtml(n, colorRef.current(n), size)
          },
          ...t.node,
        },
        state: {
          selected: { lineWidth: tokNum('--focus-w'), stroke: tokSolid('--focus-ring', '--accent') },
          dim: { opacity: 0.15 },
        },
      },
      edge: {
        style: {
          ...t.edge,
          lineDash: (d: { data?: { kind?: string } }): number[] =>
            d.data?.kind === 'ownership' ? [] : (t.edgeReference.lineDash as number[]),
        },
        state: { dim: { opacity: 0.08 }, active: { lineWidth: tokNum('--focus-w') } },
      },
      /**
       * 力参数**照搬原 d3 模拟**（GraphPage 里那套），不是随手填的：
       *   link.distance 100 / strength 0.12、manyBody -320 / distanceMax 420、
       *   collide 半径 = NODE_R + 8 = 17、alphaDecay 0.018。
       * 这套值是调出来的 —— 换个数字图就会散开或者挤成一团（第一版只给 link.distance，
       * 结果外围挂着一圈孤立节点，见 P1 的第一张实测截图）。
       */
      layout: {
        type: 'd3-force',
        link: { distance: 100, strength: 0.12 },
        manyBody: { strength: -320, distanceMax: 420 },
        collide: { radius: NODE_R + 8, strength: 0.7 },
        alphaDecay: 0.018,
      },
      behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element'],
    })
    graphRef.current = graph

    // 事件只登记一次；用 ref 取最新回调
    /**
     * 取事件里的元素 id。
     *
     * G6 的元素事件把被点中的元素放在 `target` 上，但 `IEvent` 这个基础类型里没有它
     * （在 `IElementEvent` 上）—— 这里按实际形状收窄，比给每个回调都套一层泛型干净。
     */
    const idOf = (e: IEvent): number =>
      Number((e as unknown as { target?: { id?: string } }).target?.id)
    graph.on('node:click', (e: IEvent) => cb.current.onSelect(idOf(e)))
    graph.on('node:dblclick', (e: IEvent) => {
      const n = payloadById.current.get(idOf(e))
      if (n) cb.current.onOpenNode(n)
    })
    graph.on('node:pointerenter', (e: IEvent) => cb.current.onHover(idOf(e)))
    graph.on('node:pointerleave', () => cb.current.onHover(null))
    graph.on('canvas:click', () => cb.current.onSelect(null))
    graph.on('node:dragend', () => {
      const next = new Map<number, { x: number; y: number }>()
      for (const n of payloadById.current.values()) {
        const p = graph.getElementPosition(String(n.id)) as [number, number]
        if (p) next.set(n.id, { x: p[0], y: p[1] })
      }
      cb.current.onPositions(next)
    })

    void graph.render().then(() => {
      if (dead) return
      // 主题变更：只换样式，不重建图
      stopTheme = subscribeG6Theme((next) => {
        graph.setOptions({
          node: { style: { ...graph.getOptions().node?.style, ...next.node } },
          edge: { style: { ...graph.getOptions().edge?.style, ...next.edge } },
        })
        void graph.draw()
      })
    })

    return () => {
      dead = true
      stopTheme?.()
      // G6 是有状态对象：不 destroy 会留下 canvas、事件监听与 rAF 循环
      graph.destroy()
      graphRef.current = null
    }
    // 建图只跑一次；数据与选中态由下面的 effect 增量同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- 数据增量同步 ----
  useEffect(() => {
    const g = graphRef.current
    if (!g) return
    // setData 返回 void（只有 render/布局是异步的），不能链 .then
    g.setData(toG6Data(data))
    void g.render()
  }, [data])

  // ---- 选中 / 悬浮 / 搜索淡化 / 连线起点：状态同步 ----
  useEffect(() => {
    const g = graphRef.current
    if (!g) return
    const dimmed = searchHits
    const active = hover ?? linkFrom
    const states: Record<string, string[]> = {}
    for (const n of data.nodes) {
      const id = String(n.id)
      const st: string[] = []
      if (n.id === selected || n.id === focused) st.push('selected')
      // 搜索是显式动作，优先于悬浮；两者都无命中才淡化
      if (dimmed && !dimmed.has(n.id)) st.push('dim')
      else if (!dimmed && active != null && n.id !== active) st.push('dim')
      states[id] = st
    }
    void g.setElementState(states)
  }, [data, selected, hover, focused, searchHits, linkFrom])

  useImperativeHandle(handleRef, () => ({
    relayout: () => {
      const g = graphRef.current
      if (!g) return
      // 重新跑一次布局即等于「重新加热」——G6 的 layout() 返回 Promise<void>
      void g.layout()
    },
    resetView: () => {
      void graphRef.current?.fitView()
    },
  }))

  /**
   * **必须有确定的高度**：G6 建图时按容器量尺寸，容器高度为 0 会让画布塌成一条线，
   * 而 `autoFit` 又会把整张图缩到那个高度里 —— 结果是「251 个节点都在、但一个也看不见」。
   * 实测过一次（容器 1141×4、缩放 0.01），所以这里显式撑满父容器。
   */
  return (
    <div
      ref={box}
      className="graph graph--g6"
      role="img"
      aria-label="知识图谱"
      style={{ width: '100%', height: '100%' }}
    />
  )
}
