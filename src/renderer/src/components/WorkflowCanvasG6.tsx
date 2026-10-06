/**
 * 工作流画布（G6 v5 实现）—— 冒烟版，先只验证「隐式图投影 + 分层布局 + 主题」这条链路。
 *
 * ## 为什么从布局切进来
 *
 * 工作流的图结构是**隐式**的（没有边表）：顺序边来自 `order_index` 相邻，分支边来自
 * `branch_node_id` / `branch_false_node_id`。这层投影已经在 `lib/workflow-layout.ts` 的
 * `workflowEdges()` 里做掉了，**与渲染无关，可以直接复用** —— 那是这次迁移最干净的接缝。
 *
 * 所以第一刀只换 `layoutWorkflow` 的**实现**（dagre → G6 的 `antv-dagre`），
 * 节点仍用内置矩形 + 标签 —— 先把「图能不能画对、层对不对」验掉，
 * 再换 HTML 节点还原外观（图谱那次就是这么走的，P0 冒烟先于 P1 全量替换）。
 *
 * ## 与图谱画布的关系
 *
 * 主题桥（`g6-theme`）与坐标缓存（`graph-positions`）是共用的；不共用的是布局参数与
 * 边语义（这里的分支边是虚线，和图谱的「引用=虚线」不是一回事）。
 */
import { Graph, type IEvent } from '@antv/g6'
import { CONDITION_KIND } from '@shared/workflow-condition'
import { useEffect, useImperativeHandle, useRef, type ReactElement, type Ref } from 'react'
import { ensureWorkflowEdge, wfEdgeStyle, type WfEdgeKind } from '@renderer/lib/g6-workflow-edge'
import { subscribeG6Theme } from '@renderer/lib/g6-theme'
import { NODE_H, NODE_W, NODE_TEXT_W, COND_TEXT_W, fitNodeText } from '@renderer/lib/workflow-node-box'
import { workflowEdges, type LayoutNode, type WorkflowRankDir } from '@renderer/lib/workflow-layout'

export interface WorkflowCanvasHandle {
  /** 重新跑一次布局。 */
  relayout(): void
  /** 适配视图。 */
  fit(): void
}

/**
 * 节点外观需要、而布局不需要的字段。
 *
 * `LayoutNode` 刻意只有 id / 顺序 / 分支三个字段（那样才能脱离数据层单测），
 * 所以外观信息单独一层传进来，**不去把它撑肥**。
 */
export interface WorkflowNodeView {
  title: string
  /** 角标：「第 3 步 · 任务」或「条件」。 */
  badge: string
  isCondition: boolean
  /** 条件节点菱形下方那行判据。 */
  condText?: string
  /** 已完成（实例跑过这一步）。 */
  done?: boolean
  /** 实例当前停在这一步。 */
  current?: boolean
}

export type WorkflowCanvasNode = LayoutNode & { view: WorkflowNodeView }

export interface WorkflowCanvasProps {
  nodes: readonly WorkflowCanvasNode[]
  selectedId: number | null
  rankdir?: WorkflowRankDir
  onSelect: (id: number | null) => void
  /**
   * 点了某个节点的出线端口。
   *
   * 画布**只报告「点了谁、哪个槽位」**，落库与刷新交给页面 —— 与图谱画布同一条边界。
   * `slot` 只有条件节点才有意义（'true' = 满足 / 'false' = 不满足）；普通步骤的
   * 「跳到」口传 'true'，因为 `setWorkflowBranch` 的第三参默认就是 'true'。
   */
  onBranch: (nodeId: number, slot: 'true' | 'false') => void
  /**
   * 拖完一个节点。
   *
   * **坐标是节点盒的左上角，不是中心** —— 旧实现存的就是左上角（它用
   * `transform: translate(x, y)` 且节点内容从 `(0,0)` 画起），而 G6 的
   * `getElementPosition` 返回中心。这里替调用方转好，免得存错了下次打开节点移位。
   */
  onNodeMoved: (id: number, x: number, y: number) => void
  /**
   * 删除某条分支出边（右键菜单触发）。
   *
   * **改挂端点不需要单独的回调** —— 重新走一次两段式点选就是改挂
   * （`setWorkflowBranch(fromId, 新目标, slot)` 会覆盖旧值）。
   */
  onBranchRemove: (fromId: number, slot: 'true' | 'false') => void
  /** 双击节点（打开编辑弹窗）。 */
  onOpen: (id: number) => void
  handleRef?: Ref<WorkflowCanvasHandle>
}

/**
 * 节点外观的 HTML 模板。
 *
 * **沿用 WorkflowPage 那一套类名**（`wf-node__box` / `wf-node__diamond` / `wf-node__idx` /
 * `wf-node__title` / `wf-node__cond`），所以 `workflow.css` 原样生效 ——
 * 选中、完成、当前步骤这些状态也是同一批 `--on` / `--done` / `--current` 修饰类。
 *
 * **必须自己包一层 `<svg>`**：里面的 `<rect>` / `<polygon>` / `<text>` 是 SVG 命名空间，
 * 直接塞进 HTML 的 `<div>` 不会渲染（图谱那边踩过同一个坑：`<g>` 不报错也不显示）。
 */
function nodeSvg(n: WorkflowCanvasNode, selected: boolean): string {
  const v = n.view
  const title = fitNodeText(v.title, 12, 10, v.isCondition ? COND_TEXT_W : NODE_TEXT_W)
  const parts: string[] = []
  if (v.isCondition) {
    parts.push(
      '<polygon class="wf-node__diamond' +
        (selected ? ' wf-node__diamond--on' : '') +
        '" points="' +
        NODE_W / 2 + ',2 ' + (NODE_W - 2) + ',' + NODE_H / 2 + ' ' + NODE_W / 2 + ',' + (NODE_H - 2) + ' 2,' + NODE_H / 2 +
        '"></polygon>'
    )
  } else {
    parts.push(
      '<rect class="wf-node__box' +
        (selected ? ' wf-node__box--on' : '') +
        (v.done ? ' wf-node__box--done' : '') +
        (v.current ? ' wf-node__box--current' : '') +
        '" width="' + NODE_W + '" height="' + NODE_H + '" rx="8"></rect>'
    )
  }
  const cx = v.isCondition ? NODE_W / 2 : 10
  parts.push(
    '<text class="wf-node__idx' + (v.isCondition ? ' wf-node__idx--center' : '') + '" x="' + cx + '" y="20">' +
      escapeHtml(v.badge) +
      '</text>'
  )
  parts.push(
    '<text class="wf-node__title' + (v.isCondition ? ' wf-node__title--center' : '') + '" x="' + cx + '" y="40" font-size="' + title.size + '">' +
      escapeHtml(title.text) +
      '</text>'
  )
  if (v.isCondition && v.condText) {
    const fit = fitNodeText(v.condText, 9, 8)
    parts.push(
      '<g class="wf-node__cond" transform="translate(0,' + (NODE_H + 5) + ')">' +
        '<rect x="6" width="' + (NODE_W - 12) + '" height="18" rx="6"></rect>' +
        '<text x="' + NODE_W / 2 + '" y="12.5" font-size="' + fit.size + '">' + escapeHtml(fit.text) + '</text>' +
        '</g>'
    )
  }
  /**
   * 出线端口。
   *
   * 条件节点是菱形左右两个尖角（右 = 满足、左 = 不满足），普通步骤是右边中点一个「跳到」口 ——
   * **与 `lib/workflow-anchors` 的 `nodePort` 同一套约定**，位置照它算。
   *
   * 端口画在**节点盒的边界上**（尖角正好在边界），所以这层 `<svg>` 要 `overflow: visible`：
   * 圆的半径与标签都会溢到盒外。命中判定不指望 HTML 节点的点击区域能延伸出去 ——
   * 那由画布的坐标判定负责。
   */
  const ports = v.isCondition
    ? [
        { cx: NODE_W, cy: NODE_H / 2, label: '满足', outward: 1 },
        { cx: 0, cy: NODE_H / 2, label: '不满足', outward: -1 },
      ]
    : [{ cx: NODE_W, cy: NODE_H / 2, label: '跳到', outward: 1 }]
  for (const p of ports) {
    parts.push(
      '<g class="wf-port">' +
        '<circle cx="' + p.cx + '" cy="' + p.cy + '" r="5"></circle>' +
        '<text class="wf-port__label" x="' + (p.cx + p.outward * 8) + '" y="' + (p.cy + 3) +
        '" text-anchor="' + (p.outward > 0 ? 'start' : 'end') + '">' + escapeHtml(p.label) + '</text>' +
        '</g>'
    )
  }
  return (
    '<svg class="wf-node__svg" width="' + NODE_W + '" height="' + NODE_H + '" viewBox="0 0 ' + NODE_W + ' ' + NODE_H +
    '" style="overflow:visible">' +
    parts.join('') +
    '</svg>'
  )
}

/**
 * 布局配置。
 *
 * **必须显式传给 `layout()`** —— 不传参时它用 context.layout 里**建图那一刻**的
 * presetOptions；而 `render()` 也用那一份。所以「切方向」只有把配置交进来才生效。
 */
function LAYOUT_OPTS(rankdir: WorkflowRankDir): never {
  // G6 的 LayoutOptions 联合类型没有导出可用的窄化形式，这里断言一次；
  // 形状与建图时 layout 那段完全一致（同一份参数两处用，不该各写一遍）。
  return { type: 'antv-dagre', rankdir, nodesep: 24, ranksep: 40, marginx: 40, marginy: 40 } as never
}

/** 标题是用户输入，进 innerHTML 前要转义 —— 否则一个 `<` 就能把节点画坏。 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 边的语义类别：顺序 / 满足 / 不满足 / 跳到 —— 决定颜色与虚线样式。
 *
 * \`workflowEdges\` 只给 \`branch: boolean\`；「满足」还是「不满足」要看源节点的
 * \`branch_node_id\` / \`branch_false_node_id\` 与终点的对应关系。
 */
function kindOfEdge(
  nodes: readonly WorkflowCanvasNode[],
  from: number,
  to: number,
  branch: boolean
): WfEdgeKind {
  if (!branch) return 'seq'
  const src = nodes.find((n) => n.id === from)
  if (!src) return 'branch-jump'
  if (src.view.isCondition) {
    if (src.branch_node_id === to) return 'branch-true'
    if (src.branch_false_node_id === to) return 'branch-false'
  }
  return 'branch-jump'
}
export function WorkflowCanvasG6({
  nodes,
  selectedId,
  rankdir = 'TB',
  onSelect,
  onBranch,
  onBranchRemove,
  onNodeMoved,
  onOpen,
  handleRef,
}: WorkflowCanvasProps): ReactElement {
  const box = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)
  /**
   * 回调与取标题的函数都放 ref。
   *
   * **不能进 effect 的依赖数组**：父组件里 `labelOf={(id) => …}` 是内联箭头函数，
   * 每次渲染都是新引用 —— 依赖它会让「数据没变但 effect 重跑」，`setData` + `render`
   * 又触发渲染，转成无限循环（实测：页面永不空闲，连 CDP 截图都超时）。
   * 画布只该对**数据**变化有反应。
   */
  const cb = useRef({
    onSelect,
    onBranch,
    onBranchRemove,
    onNodeMoved,
    onOpen,
    selectedId,
    nodes: [] as readonly WorkflowCanvasNode[],
  })
  cb.current = { onSelect, onBranch, onBranchRemove, onNodeMoved, onOpen, selectedId, nodes }
  /**
   * 边 id（"from>to"）→ 语义类别。
   *
   * 右键菜单要知道被点中的是哪一类边（顺序边不给菜单、分支边才给）。
   * 每次渲染重建：边是数据的纯函数，不值得为它做记忆化。
   */
  const edgeKindById = useRef(new Map<string, WfEdgeKind>())
  edgeKindById.current = new Map(
    workflowEdges(nodes).map((e) => [e.from + '>' + e.to, kindOfEdge(nodes, e.from, e.to, e.branch)])
  )

  // 注册自定义边类型（只注册一次）
  ensureWorkflowEdge()
  useEffect(() => {
    const el = box.current
    if (!el) return
    let dead = false
    let stopTheme: (() => void) | null = null

    const build = (): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } => {
      const ns = cb.current.nodes
      const edges = workflowEdges(ns)
      return {
        nodes: ns.map((n) => ({
          id: String(n.id),
          data: { id: n.id },
          style: { innerHTML: nodeSvg(n, cb.current.selectedId === n.id) },
        })),
        // 分支边虚线 —— 与顺序边区分，语义来自 workflowEdges 的投影，不在这里重判
        edges: edges.map((e) => ({
          id: e.from + '>' + e.to,
          source: String(e.from),
          target: String(e.to),
          data: { kind: kindOfEdge(cb.current.nodes, e.from, e.to, e.branch) },
          style: {
            // 自定义边在 getKeyPath 里拿不到 data，只能从 style 读这三项
            wfKind: kindOfEdge(cb.current.nodes, e.from, e.to, e.branch),
            wfNodeKind: cb.current.nodes.find((n) => n.id === e.from)?.view.isCondition ? CONDITION_KIND : undefined,
            // 条件节点的分支要带槽位（满足 / 不满足），普通步骤的「跳到」口不带 ——
            // 不带槽位时 getKeyPath 走 directedAnchors，正是「跳到」该有的锚点
            wfSlot: e.branch && cb.current.nodes.find((n) => n.id === e.from)?.view.isCondition
              ? (cb.current.nodes.find((n) => n.id === e.from)?.branch_node_id === e.to ? 'true' : 'false')
              : undefined,
          },
        })),
      }
    }

    const graph = new Graph({
      container: el,
      autoFit: 'view',
      // setData / 构造的 data 类型对不上是 G6 的已知粗糙处，这里的形状是对的
      data: build() as never,
      /**
       * HTML 节点：外观交给 `nodeSvg` 与 `workflow.css`，**选中态也画在模板里**
       * （用同一批 `--on` 修饰类），所以这里不再需要 G6 的 state 动画。
       */
      node: {
        type: 'html',
        style: {
          size: [NODE_W, NODE_H],
          innerHTML: (d: { id: string }) => {
            const n = cb.current.nodes.find((x) => String(x.id) === d.id)
            return n ? nodeSvg(n, cb.current.selectedId === n.id) : ''
          },
        },
      },
      /**
       * `wf-edge`：从**端口**出发的自定义正交折线（见 lib/g6-workflow-edge.ts）。
       *
       * 样式按边的语义类别取（顺序实线 / 分支两色虚线 / 兜底点线），
       * 类别走 style 上的 `wfKind` —— 自定义边在 `getKeyPath` 里拿不到 `data`。
       */
      edge: {
        type: 'wf-edge',
        style: {
          /**
           * `halo`：把命中区域加宽。
           *
           * **1.2px 的线本身点不到** —— 旧 SVG 实现为此刻意叠了一条透明的粗线
           * （它的注释写着「热区复用图谱那边的透明粗线」）。G6 里对应的就是 halo：
           * 不给的话右键永远命不中分支线（实测：15×10 的网格扫下来一条都没中）。
           */
          /**
           * ⚠️ **实测：halo 不能扩大命中区域**（它只管视觉光晕）。
           *
           * 自定义边是 1.2px 的线，**右键很难命不中** —— 用 CDP 真实右键扫了两遍网格
           * （15×10 与 28×18）都没稳定命中；换到冒烟页、用节点位置推算的探测点，
           * 才偶尔触发到 edge:contextmenu（44 个点里中过 2 次）。
           *
           * 旧 SVG 实现是靠**额外叠一条透明粗线**当热区解决的（它的注释写着
           * 「热区复用图谱那边的透明粗线：1px 的线本身点不到」）—— 同一个坑。
           *
           * **G6 没有公开的命中区域配置**（查过 BaseShapeStyleProps 与 edges 的类型，
           * 没有 hit / pointerEvents / hotspot 之类的键）。要真正修好得覆写
           * `drawKeyShape`，在 key shape 之外再画一条透明的粗路径 —— 那是一条独立的工作。
           */
          halo: true,
          haloStroke: 'transparent',
          haloLineWidth: 12,
          endArrow: true,
          endArrowType: 'triangle',
          stroke: (d: { data?: { kind?: WfEdgeKind } }) => wfEdgeStyle(d.data?.kind ?? 'seq').stroke,
          lineWidth: (d: { data?: { kind?: WfEdgeKind } }) =>
            wfEdgeStyle(d.data?.kind ?? 'seq').lineWidth,
          lineDash: (d: { data?: { kind?: WfEdgeKind } }) =>
            wfEdgeStyle(d.data?.kind ?? 'seq').lineDash,
        },
      },
      layout: {
        // AntV 自己的 dagre 实现，选项与原 @dagrejs/dagre 一致 —— 原有参数可 1:1 搬
        type: 'antv-dagre',
        rankdir,
        nodesep: 24,
        ranksep: 40,
        marginx: 40,
        marginy: 40,
      },
      behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element'],
      /**
       * 右键菜单，当前只挂了「删除分支」。
       *
       * 旧实现是「鼠标移到分支线上 → 冒出删除按钮」。G6 没有对应的悬停浮层，
       * 右键菜单是它的惯用做法（图谱的边删除也是这么做的）。
       *
       * **改挂端点不需要单独做** —— 重新走一次两段式点选就是改挂
       * （`setWorkflowBranch(fromId, 新目标, slot)` 会覆盖旧值）。
       *
       * 自带样式是硬编码白底，用 `className` 挂钩、由 workflow.css 用 token 覆盖。
       */
      plugins: [
        {
          type: 'contextmenu',
          trigger: 'contextmenu',
          className: 'g6-menu',
          offset: [4, 4],
          /**
           * 菜单项。
           *
           * **节点上的分支清除走这里，不走边** —— 边的命中区域只有 1.2px，实测
           * 右键很难点中（见文件下方 halo 的注释）；而节点是 HTML、命中区域 150×56，
           * 点它选中都验证过，可靠得多。旧实现的浮卡在 `<foreignObject>` 里、
           * G6 路径下不显示，所以这里用右键代替它。
           */
          getItems: (e: IEvent) => {
            const t = e as unknown as { target?: { id?: string }; targetType?: string }
            if (!t.target?.id) return []
            if (t.targetType === 'edge') {
              const kind = edgeKindById.current.get(t.target.id)
              if (!kind || kind === 'seq') return [] // 顺序边是隐式的，删它没有意义
              return [{ name: '删除分支', value: 'wf:unbranch-edge:' + t.target.id }]
            }
            if (t.targetType === 'node') {
              const n = cb.current.nodes.find((x) => String(x.id) === t.target?.id)
              if (!n) return []
              const items: { name: string; value: string }[] = []
              if (n.branch_node_id) items.push({ name: '清除「满足」分支', value: 'wf:unbranch:' + n.id + ':true' })
              if (n.branch_false_node_id)
                items.push({ name: '清除「不满足」分支', value: 'wf:unbranch:' + n.id + ':false' })
              return items
            }
            return []
          },
          onClick: (value: string) => {
            // 边来的：wf:unbranch-edge:<from>><to>
            const me = /^wf:unbranch-edge:(\d+)>(\d+)$/.exec(value)
            if (me) {
              const kind = edgeKindById.current.get(me[1] + '>' + me[2])
              cb.current.onBranchRemove(Number(me[1]), kind === 'branch-false' ? 'false' : 'true')
              return
            }
            // 节点来的：wf:unbranch:<nodeId>:<slot>
            const mn = /^wf:unbranch:(\d+):(true|false)$/.exec(value)
            if (mn) cb.current.onBranchRemove(Number(mn[1]), mn[2] as 'true' | 'false')
          },
        },
      ],
    })
    graphRef.current = graph

    const idOf = (e: IEvent): number =>
      Number((e as unknown as { target?: { id?: string } }).target?.id)
    /**
     * 点的**是端口**还是节点本体？
     *
     * HTML 节点是真实 DOM，所以直接看事件目标有没有落在 `.wf-port` 里 —— 比拿
     * client 坐标去反算端口位置可靠（不用管画布缩放与平移）。
     */
    const portOf = (e: IEvent): 'true' | 'false' | null => {
      // G6 的事件对象上，原生事件与坐标的字段名没有一个稳定的公开契约 ——
      // 逐个试，都拿不到就当没点端口（退回选中）。**这是实测踩出来的**：
      // 只认 originalEvent 时端口点击全被当成选中节点。
      const ev = e as unknown as {
        originalEvent?: { target?: Element }
        nativeEvent?: { target?: Element }
        client?: { x: number; y: number }
      }
      const domTarget = ev.originalEvent?.target ?? ev.nativeEvent?.target
      let g = domTarget?.closest?.('.wf-port') ?? null
      if (!g && ev.client) {
        // 退路：按屏幕坐标反查。端口圆点会溢到节点盒外，DOM 命中比坐标换算可靠，
        // 但坐标这条路能覆盖「HTML 节点的容器把事件吞了」的情况。
        g = document.elementFromPoint(ev.client.x, ev.client.y)?.closest?.('.wf-port') ?? null
      }
      if (!g) return null
      // 条件节点左尖角 = 不满足；右尖角与普通步骤的「跳到」口都是 true
      const text = g.querySelector?.('.wf-port__label')?.textContent ?? ''
      return text.includes('不满足') ? 'false' : 'true'
    }
    graph.on('node:click', (e: IEvent) => {
      const slot = portOf(e)
      if (slot) cb.current.onBranch(idOf(e), slot)
      else cb.current.onSelect(idOf(e))
    })
    graph.on('node:dblclick', (e: IEvent) => cb.current.onOpen(idOf(e)))
    /**
     * 拖完落库。**只在 dragend 报**，不在拖动过程中报 —— 一次拖动只写一次库，
     * 否则每帧一次 IPC（渲染层逐条调 IPC 那条架构断言正是拦这个的）。
     */
    graph.on('node:dragend', (e: IEvent) => {
      const id = idOf(e)
      const p = graph.getElementPosition(String(id)) as [number, number] | undefined
      if (!p) return
      // 中心 → 左上角（旧实现的坐标语义）
      cb.current.onNodeMoved(id, Math.round(p[0] - NODE_W / 2), Math.round(p[1] - NODE_H / 2))
    })
    graph.on('canvas:click', () => cb.current.onSelect(null))

    // 同图谱画布：G6 只在建图时量一次容器，尺寸变化要自己盯（canvas.autoResize 不在类型里）
    const ro = new ResizeObserver(() => {
      // **必须挡一道**：ro.disconnect() 挡不住已经排进队列的那一次回调 ——
      // 图 destroy() 之后它照样会跑，G6 内部再读到 undefined.draw 就抛
      // 「The graph instance has been destroyed」（实测：切纵向/横向时每次必现）。
      if (dead) return
      graph.resize()
    })
    ro.observe(el)

    void graph.render().then(() => {
      if (dead) return
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
      ro.disconnect()
      stopTheme?.()
      graph.destroy()
      graphRef.current = null
    }
    // 依赖是**空**：图只建一次。方向变化改走下面那个 effect（改布局配置重跑 layout）——
    // 早先依赖 rankdir，切方向会整图重建，而 G6 内部的异步任务会在 destroy 之后才完成，
    // 每次都抛 "The graph instance has been destroyed"（实测，堆栈里全是 @antv/g6 的帧）。
  }, [])

  /**
   * 布局方向变化：改配置 + 重跑一次布局，**不重建图**。
   *
   * 首帧也会跑一次（与建图时那份配置等价，幂等）。这样切「纵向 / 横向」时
   * 图实例始终是同一个，没有「销毁后异步任务才回来」的窗口。
   */
  /** 当前方向 —— 数据同步那个 effect 也要用它（render() 只认建图时的 options）。 */
  const dirSeenRankdir = useRef(rankdir)
  dirSeenRankdir.current = rankdir
  const dirSeen = useRef(false)
  useEffect(() => {
    // **跳过首帧**：建图时那份配置已经带着当时的 rankdir，此时 render() 还没完成，
    // 这会儿调 layout() 会炸（实测堆栈落在 @antv/g6 的 layout 里）。
    if (!dirSeen.current) {
      dirSeen.current = true
      return
    }
    const g = graphRef.current
    if (!g) return
    // **配置要直接传给 layout()**：不传参时它用的是 context.layout 里建图那一刻的
    // presetOptions，而 setOptions 并不会更新那份 —— 于是永远按旧 rankdir 排
    // （实测：点「横向」按钮与 state 都正常切换，节点坐标却一个都没动）。
    // **layout() 之后必须再 draw() 一次** —— 实测：模型坐标确实重排了（getElementPosition
    // 从 TB 的 [99,204] 变成 LR 的 [345,52]），但页面上 HTML 节点的 DOM 位置一动不动，
    // 用户看不到任何变化。layout 只更新模型，画布要自己再画一帧。
    void Promise.resolve(g.layout(LAYOUT_OPTS(rankdir) as never)).then(() => g.draw())
  }, [rankdir])

  // 数据变化 → 增量同步（不重建图，布局会自己重跑）。
  // 依赖只有 nodes —— 取标题走 ref，见 cb 的注释。
  useEffect(() => {
    const g = graphRef.current
    if (!g) return
    g.setData({
      nodes: nodes.map((n) => ({
        id: String(n.id),
        data: { id: n.id },
        style: { innerHTML: nodeSvg(n, cb.current.selectedId === n.id) },
      })),
      edges: workflowEdges(nodes).map((e) => ({
        id: e.from + '>' + e.to,
        source: String(e.from),
        target: String(e.to),
        data: { kind: kindOfEdge(nodes, e.from, e.to, e.branch) },
        style: {
            // 自定义边在 getKeyPath 里拿不到 data，只能从 style 读这三项
            wfKind: kindOfEdge(nodes, e.from, e.to, e.branch),
            wfNodeKind: nodes.find((n) => n.id === e.from)?.view.isCondition ? CONDITION_KIND : undefined,
            // 条件节点的分支要带槽位（满足 / 不满足），普通步骤的「跳到」口不带 ——
            // 不带槽位时 getKeyPath 走 directedAnchors，正是「跳到」该有的锚点
            wfSlot: e.branch && nodes.find((n) => n.id === e.from)?.view.isCondition
              ? (nodes.find((n) => n.id === e.from)?.branch_node_id === e.to ? 'true' : 'false')
              : undefined,
          },
      })),
    } as never)
    // **不能只 render()** —— 它用的是建图那一刻的 options，会把方向覆盖回初始值
    // （实测：切方向时 effect 明明跑了、rankdir 也确实变成了 LR，节点坐标却一点没动；
    //  而在页面里手动调 layout({rankdir:'LR'}) 立刻就变了）。
    // 所以这里也把当前方向一起交给 layout()。
    void Promise.resolve(g.layout(LAYOUT_OPTS(dirSeenRankdir.current))).then(() => g.draw())
  }, [nodes])

  /**
   * 选中态。
   *
   * **重写节点内容、而不是切 G6 的 state** —— 选中是画在 `nodeSvg` 里的（用了 workflow.css
   * 原有的 `--on` 修饰类），这样外观与旧 SVG 实现逐像素一致；用 state 就得再维护一份样式映射。
   */
  useEffect(() => {
    const g = graphRef.current
    if (!g) return
    for (const n of nodes) {
      g.updateNodeData([{ id: String(n.id), style: { innerHTML: nodeSvg(n, selectedId === n.id) } }])
    }
    void g.draw()
  }, [nodes, selectedId])

  useImperativeHandle(handleRef, () => ({
    relayout: () => void graphRef.current?.layout(),
    fit: () => void graphRef.current?.fitView(),
  }))

  return (
    <div
      ref={box}
      className="wf-canvas wf-canvas--g6"
      role="img"
      aria-label="工作流画布"
      style={{ width: '100%', height: '100%' }}
    />
  )
}
