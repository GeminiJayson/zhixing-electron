/**
 * 图谱画布（G6 v5）—— 渲染与交互**全部交给 G6**，本文件只做数据映射与业务回调。
 *
 * ## 职责边界
 *
 * **这个组件只管「画」与「指针交互」，不做任何业务判断。**
 * 能不能连、连了写哪张表、双击该干什么，全部由 `GraphPage` 决定并通过回调传进来 ——
 * 见 docs/specs/g6-migration.md 的保留清单。
 *
 * ## 用了 G6 的哪些能力（不重复造轮子）
 *
 * | 事项 | 交给谁 |
 * | --- | --- |
 * | 节点外形与命中 | 内置 `circle`（keyShape 就是命中区域） |
 * | 节点图标 | `iconSrc` + 自包含 SVG data URL（见 lib/graph-icon.ts） |
 * | 边 | 内置 `cubic` 三次贝塞尔 + `endArrow` 方向箭头 |
 * | 布局 | 内置 `d3-force` |
 * | 配色/状态 | **G6 主题**（lib/g6-theme.ts 注册的 `zhixing` 主题）+ `state.selected/active/dim` |
 * | 选中 | 内置 `click-select` |
 * | 悬停高亮 | 内置 `hover-activate` |
 * | 拖拽（力导向） | 内置 `drag-element-force` |
 * | 画布平移缩放 | 内置 `drag-canvas` / `zoom-canvas` |
 * | 右键菜单 | 内置 `contextmenu` 插件 |
 *
 * 自己写的只剩「按业务态给元素打 `dim`（搜索命中之外淡化）」，因为那是业务语义，不是通用交互。
 *
 * ## 位置持久化
 *
 * 布局由 G6 拥有，但**用户的拖动结果要跨页面存活**：
 * 初始位置从 `positions` 读，拖完/定时通过 `onPositions` 交回去。
 */
import { Graph, type IEvent } from '@antv/g6'
import { useEffect, useImperativeHandle, useRef, type ReactElement, type Ref } from 'react'
import { toG6Data } from '@renderer/lib/g6-adapt'
import { iconDataUrl } from '@renderer/lib/graph-icon'
import {
  THEME_NAME,
  applyZhixingTheme,
  registerZhixingTheme,
  subscribeG6Theme,
  themeTokens,
  tokNum,
} from '@renderer/lib/g6-theme'
import type { GraphNodePayload, GraphPayload } from '@shared/types'

export interface GraphCanvasHandle {
  /** 「重新布局」：把力导向重新加热。 */
  relayout(): void
  /** 「重置视图」：缩放回 1 并适配内容。 */
  resetView(): void
  /** 镜头飞入某个节点（图内搜索命中的第一个）。 */
  focusNode(id: number): void
}

interface GraphCanvasProps {
  data: GraphPayload
  /** 节点主色（note 走知识类型/文件夹色，其余走 kind 色）—— 由 lib/graph-colors 的 colorOf 决定。 */
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
  /** 右键边 → 删除连线。能不能删仍由 GraphPage 的 canEditEdge 判定。 */
  onEdgeDelete: (sourceId: number, targetId: number, kind: 'ownership' | 'reference') => void
  /**
   * 右键边 → 改挂某一端。
   * `end` 是要换掉的那一端：`'src'` 换起点、`'dst'` 换终点；另一端保持不变。
   */
  onEdgeRewire: (
    sourceId: number,
    targetId: number,
    kind: 'ownership' | 'reference',
    end: 'src' | 'dst'
  ) => void
  handleRef?: Ref<GraphCanvasHandle>
}

/** 透明色：canvas 不认 `transparent` 关键字，用 rgba 全零。 */
const NONE = 'rgba(0,0,0,0)'

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
  onEdgeDelete,
  onEdgeRewire,
  handleRef,
}: GraphCanvasProps): ReactElement {
  const box = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)
  /** 回调放 ref：G6 的事件订阅只登记一次，闭包不能捕获过期的 props。 */
  const cb = useRef({ onSelect, onHover, onFocus, onOpenNode, onPositions, onEdgeDelete, onEdgeRewire })
  cb.current = { onSelect, onHover, onFocus, onOpenNode, onPositions, onEdgeDelete, onEdgeRewire }
  /** 边 id（"src,dst"）→ 类别。右键菜单用它在删除时带上归属/引用。 */
  const edgeKindById = useRef(new Map<string, 'ownership' | 'reference'>())
  edgeKindById.current = new Map(data.edges.map(([a, b]) => [a + ',' + b, data.edgeKinds[a + ',' + b] ?? 'reference']))
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

    // 主题必须先注册，G6 只会按名字去注册表里取（见 lib/g6-theme.ts）
    registerZhixingTheme()
    const tokens = themeTokens()
    const size = tokNum('--size-18')
    /**
     * 节点是「圆 + 图标」：圆的直径 = 图标盒 36（与原实现的视觉尺寸一致），
     * **图标只占 78%**（28）—— 这样图标外接方完全落在圆内，四周留出边距，看着才不挤
     * （用户反馈：图标顶满/超出节点）。
     */
    const nodeD = size * 2
    const iconBox = Math.round(nodeD * 0.78)
    const iconR = iconBox / 2

    const graph = new Graph({
      container: el,

      /** 主题：背景、节点/边/combo 的默认样式与状态样式全在 lib/g6-theme.ts 里，这里只引用名字。 */
      theme: THEME_NAME,

      /**
       * `'view'` 即「渲染后适配视图」。
       *
       * **不要给它加内边距**：试过顶层 `padding: 32`，结果是**布局彻底不跑** ——
       * 251 个节点全叠在同一个点上，不报错、不警告。去掉之后立刻恢复。
       */
      autoFit: 'view',

      data: toG6Data(data),

      node: {
        /** 内置圆形节点：keyShape 既是命中区域也是选中环的载体。 */
        type: 'circle',
        style: {
          size: [nodeD, nodeD],
          /**
           * keyShape 默认**透明**：视觉主体是图标本身，圆只负责命中与状态反馈
           * （选中/悬停时由主题的 state 把 stroke 换成焦点色）。
           */
          fill: NONE,
          stroke: NONE,
          /** 图标：自包含 SVG（颜色已在 TS 里算好）—— G6 负责画，我们只提供资产。 */
          iconSrc: (d: { id: string }): string => {
            const n = payloadById.current.get(Number(d.id))
            if (!n) return ''
            return iconDataUrl(n.kind, iconR, { color: colorRef.current(n), ...tokens })
          },
          iconWidth: iconBox,
          iconHeight: iconBox,
          /** 图标即节点，不再叠一层文字标签（标题在侧栏与悬停提示里）。 */
          label: false,
        },
      },

      edge: {
        /** 三次贝塞尔 + 方向箭头：关系图的通用画法（官方推荐用于任意方向连接）。 */
        type: 'cubic',
        style: {
          endArrow: true,
          endArrowType: 'triangle',
          /** 归属=实线、引用=虚线，语义见 docs/specs/ownership-vs-reference.md。 */
          lineDash: (d: { data?: { kind?: string } }): number[] =>
            d.data?.kind === 'ownership' ? [] : [tokNum('--space-hair') * 2, tokNum('--space-2xs')],
        },
      },

      /**
       * 力参数**照搬原 d3 模拟**，不是随手填的：
       *   link.distance 100 / strength 0.12、manyBody -320 / distanceMax 420、
       *   collide 半径 = 节点半径 + 6、alphaDecay 0.018。
       * 这套值是调出来的 —— 换个数字图就会散开或者挤成一团。
       */
      layout: {
        type: 'd3-force',
        link: { distance: 100, strength: 0.12 },
        manyBody: { strength: -320, distanceMax: 420 },
        /** 碰撞半径按**节点的实际半径**（nodeD/2 = 18）算，再留 6px 间距 —— 否则节点会叠在一起。 */
        collide: { radius: nodeD / 2 + 6, strength: 0.7 },
        alphaDecay: 0.018,
      },

      /**
       * 交互全部用内置 behavior（官方 behavior 章节那一批）：
       *   click-select（选中）· hover-activate（悬停高亮）· drag-element-force（力导向里拖节点）
       *   · drag-canvas / zoom-canvas（导航）
       *
       * **不加 focus-element**：它会把「点击」和「镜头飞到元素」绑在一起，
       * 而图谱的点击已经用于选中/连线，每次点都移动视口很打扰；聚焦改由
       * `focusNode()` 命令式调用（搜索命中时），见下面的 handle。
       */
      behaviors: [
        'drag-canvas',
        'zoom-canvas',
        { type: 'click-select', key: 'click-select', state: 'selected' },
        'hover-activate',
        'drag-element-force',
      ],

      /**
       * 右键菜单，当前只挂了「改挂端点 / 删除连线」。
       *
       * 注意：插件自带的 `CONTEXTMENU_CSS` 是**硬编码的白底、圆角 4px**，不跟主题；
       * 所以传了 `className`，由 graph.css 用 token 覆盖。
       */
      plugins: [
        {
          type: 'contextmenu',
          trigger: 'contextmenu',
          className: 'g6-menu',
          offset: [4, 4],
          getItems: (e: IEvent) => {
            const id = (e as unknown as { target?: { id?: string }; targetType?: string }).target?.id
            const type = (e as unknown as { targetType?: string }).targetType
            if (type !== 'edge' || !id) return []
            return [
              { name: '改挂起点', value: 'edge:rewire-src:' + id },
              { name: '改挂终点', value: 'edge:rewire-dst:' + id },
              { name: '删除连线', value: 'edge:delete:' + id },
            ]
          },
          onClick: (value: string) => {
            const m = /^edge:(delete|rewire-src|rewire-dst):(.+)$/.exec(value)
            if (!m) return
            const [, action, id] = m
            const [s, t] = id.split(',')
            if (!s || !t) return
            const kind = edgeKindById.current.get(id) ?? 'reference'
            if (action === 'delete') cb.current.onEdgeDelete(Number(s), Number(t), kind)
            else cb.current.onEdgeRewire(Number(s), Number(t), kind, action === 'rewire-src' ? 'src' : 'dst')
          },
        },
      ],
    })
    graphRef.current = graph

    /**
     * 取事件里的元素 id。
     *
     * G6 的元素事件把被点中的元素放在 `target` 上，但 `IEvent` 这个基础类型里没有它
     * （在 `IElementEvent` 上）—— 这里按实际形状收窄，比给每个回调都套一层泛型干净。
     */
    const idOf = (e: IEvent): number =>
      Number((e as unknown as { target?: { id?: string } }).target?.id)

    /**
     * 选中态**由 G6 的 click-select 自己维护**，我们只把结果转告页面（侧栏要跟着变）。
     * 页面的 `selected` prop 再回来时是幂等的（setElementState 同一状态），不会打架。
     */
    graph.on('node:click', (e: IEvent) => cb.current.onSelect(idOf(e)))
    graph.on('node:dblclick', (e: IEvent) => {
      const n = payloadById.current.get(idOf(e))
      if (n) cb.current.onOpenNode(n)
    })
    graph.on('node:pointerenter', (e: IEvent) => cb.current.onHover(idOf(e)))
    graph.on('node:pointerleave', () => cb.current.onHover(null))
    graph.on('canvas:click', () => cb.current.onSelect(null))

    /** 把当前所有节点的落位读出来，交给坐标缓存。 */
    const snapshotPositions = (): void => {
      const next = new Map<number, { x: number; y: number }>()
      for (const n of payloadById.current.values()) {
        const p = graph.getElementPosition(String(n.id)) as [number, number]
        if (p) next.set(n.id, { x: p[0], y: p[1] })
      }
      if (next.size) cb.current.onPositions(next)
    }
    graph.on('node:dragend', snapshotPositions)

    /**
     * 定时回写落位，**替代原实现里 d3 模拟每 tick 的回写**。
     * 力导向是异步迭代的、没有可靠的「布局结束」事件 —— 与其猜时间，不如定期快照：
     * 这份缓存在下次挂载时才被读，**写中间值无害，最后一次写就是最终布局**。
     */
    const posTimer = window.setInterval(snapshotPositions, 1000)

    /**
     * 跟随容器尺寸变化。**G6 只在建图时量一次容器** —— 拖大窗口后内容会锁在小画布里，
     * 试过 `canvas: { autoResize: true }`，**不在 `CanvasConfig` 类型里**，所以自己盯。
     */
    const ro = new ResizeObserver(() => graph.resize())
    ro.observe(el)

    void graph.render().then(() => {
      if (dead) return
      // 主题变更：重新注册主题对象并切换，不重建图（见 lib/g6-theme.ts 的注释）
      stopTheme = subscribeG6Theme(() => {
        applyZhixingTheme(graph)
      })
    })

    return () => {
      dead = true
      ro.disconnect()
      window.clearInterval(posTimer)
      // 卸载前补一次快照：刚摆好就切页时，最后那次落定不该丢
      try {
        snapshotPositions()
      } catch {
        // 图已在销毁流程里，取不到位置就算了 —— 缓存只是下次的播种值
      }
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

  // ---- 业务态同步：选中 / 搜索结果淡化 / 连线起点 ----
  // 选中由 click-select 负责，这里同步的是「页面侧发起的那一份」（侧栏点选、搜索聚焦），
  // 以及 G6 不该知道的业务语义：搜索未命中、连线态之外的节点淡化。
  useEffect(() => {
    const g = graphRef.current
    if (!g) return
    const dimmed = searchHits
    /**
     * **只有「连线起点」会淡化其他节点，悬停不再淡化**。
     *
     * 之前把 `hover` 也算进来，结果鼠标一停在某个节点上，其余 250 个一起变淡 ——
     * 看起来就是「整张图被置灰」（用户反馈）。悬停的高亮交给内置的 `hover-activate`
     * （主题里配的是 halo 光晕），不抢别的节点的存在感。
     */
    const active = linkFrom
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
    focusNode: (id: number) => {
      void graphRef.current?.focusElement(String(id), { duration: 300 })
    },
  }))

  /**
   * **必须有确定的高度**：G6 建图时按容器量尺寸，容器高度为 0 会让画布塌成一条线，
   * 而 `autoFit` 又会把整张图缩到那个高度里 —— 结果是「251 个节点都在、但一个也看不见」。
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
