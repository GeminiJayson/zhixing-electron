/**
 * 工作流画布（G6 v5）—— 渲染与交互**全部交给 G6**，本文件只做数据映射与业务回调。
 *
 * ## 用了 G6 的哪些能力（不重复造轮子）
 *
 * | 事项 | 交给谁 |
 * | --- | --- |
 * | 节点外形 | 内置 `rect`（步骤）/ `diamond`（条件） |
 * | 角标（「第 3 步 · 任务」「条件」） | 节点 `badges`（`placement: 'left-top'`） |
 * | 标题 | 节点 `labelText`（wordWrap + maxLines + textOverflow 全由 G6 处理） |
 * | 条件判据 | 节点 `badges`（`placement: 'bottom'`） |
 * | 端口 | 节点 `ports`（条件节点左右各一、步骤右侧一个） |
 * | 连线 | 内置 `polyline` + `router: { type: 'orth' }`（正交折线是内置路由） |
 * | 分支说明 | **边的 `labelText`**（「满足 / 不满足 / 跳到」写在线上，不再挂在端口旁） |
 * | 方向箭头 | 边 `endArrow` |
 * | 布局 | 内置 `antv-dagre` |
 * | 选中 / 悬停 / 拖拽 / 导航 | 内置 `click-select` / `hover-activate` / `drag-element` / `drag-canvas` / `zoom-canvas` |
 * | 右键菜单 | 内置 `contextmenu` 插件 |
 * | 配色与状态 | **G6 主题**（lib/g6-theme.ts 的 `zhixing`）+ 图配置里的 `node.state` |
 *
 * 自己写的只剩两处**业务语义**：分支颜色（满足绿 / 不满足红 / 跳到中性）与
 * 「点的是端口还是节点」（用 `e.originalTarget` 与 `node.getPorts()` 做对象比对）。
 */
import { Diamond, ExtensionCategory, Graph, Rect, register, type IEvent } from '@antv/g6'
import { useEffect, useImperativeHandle, useRef, type ReactElement, type Ref } from 'react'
import {
  THEME_NAME,
  applyZhixingTheme,
  mix,
  registerZhixingTheme,
  subscribeG6Theme,
  tokNum,
  tokSolid,
} from '@renderer/lib/g6-theme'
import { setupEdgeRewire } from '@renderer/lib/g6-edge-rewire'
import { NODE_H, NODE_W } from '@renderer/lib/workflow-node-box'
import { workflowEdges, type LayoutNode, type WorkflowRankDir } from '@renderer/lib/workflow-layout'

export interface WorkflowCanvasHandle {
  /** 重新跑一次布局。 */
  relayout(): void
  /** 适配视图。 */
  fit(): void
}

/** 节点外观需要、而布局不需要的字段（`LayoutNode` 保持三个字段，不撑肥）。 */
interface WorkflowNodeView {
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

interface WorkflowCanvasProps {
  nodes: readonly WorkflowCanvasNode[]
  selectedId: number | null
  rankdir?: WorkflowRankDir
  onSelect: (id: number | null) => void
  /**
   * 点了某个节点的出线端口。画布**只报告「点了谁、哪个槽位」**，落库与刷新交给页面。
   * `slot` 只有条件节点才有意义（'true' = 满足 / 'false' = 不满足）。
   */
  onBranch: (nodeId: number, slot: 'true' | 'false') => void
  /**
   * 拖完一个节点。**坐标是节点盒左上角**（旧实现的语义），G6 的 `getElementPosition`
   * 返回中心，这里替调用方转好。
   */
  onNodeMoved: (id: number, x: number, y: number) => void
  /** 删除某条分支出边（右键菜单触发）。 */
  onBranchRemove: (fromId: number, slot: 'true' | 'false') => void
  /**
   * **拖拽改挂分支**：按住某条分支边靠近其起点的一端拖到另一个节点上松手。
   *
   * 只有**分支边**能改挂 —— 顺序边是 `order_index` 相邻隐式推出来的，
   * 没有「挂在哪」这回事（要改顺序得用步骤的上下移动）。
   */
  onEdgeRewire: (fromId: number, slot: 'true' | 'false', toId: number) => void
  /** 双击节点（打开编辑弹窗）。 */
  onOpen: (id: number) => void
  handleRef?: Ref<WorkflowCanvasHandle>
}

/** 边语义 → 描边与虚线（颜色现算：canvas 不认 CSS 变量与 color-mix）。 */
function edgeStyleOf(kind: string): { stroke: string; lineWidth: number; lineDash: number[] } {
  const base = tokSolid('--graph-edge', '--border-strong')
  switch (kind) {
    case 'branch-true':
      return { stroke: mix(tokSolid('--success', '--accent'), 0.62, base), lineWidth: 1.2, lineDash: [5, 4] }
    case 'branch-false':
      return { stroke: mix(tokSolid('--danger', '--accent'), 0.58, base), lineWidth: 1.2, lineDash: [5, 4] }
    case 'branch-jump':
      return { stroke: base, lineWidth: 1.2, lineDash: [5, 4] }
    default:
      return { stroke: base, lineWidth: 1.2, lineDash: [] }
  }
}

/** 边上的说明文字 —— 分支语义写在线上（而不是挂在端口旁边）。 */
function edgeLabelOf(kind: string): string | undefined {
  if (kind === 'branch-true') return '满足'
  if (kind === 'branch-false') return '不满足'
  if (kind === 'branch-jump') return '跳到'
  return undefined
}

/**
 * 边的语义类别：顺序 / 满足 / 不满足 / 跳到。
 * `workflowEdges` 只给 `branch: boolean`；「满足」还是「不满足」要看源节点的两个分支字段。
 */
function kindOfEdge(nodes: readonly WorkflowCanvasNode[], from: number, to: number, branch: boolean): string {
  if (!branch) return 'seq'
  const src = nodes.find((n) => n.id === from)
  if (!src) return 'branch-jump'
  if (src.view.isCondition) {
    if (src.branch_node_id === to) return 'branch-true'
    if (src.branch_false_node_id === to) return 'branch-false'
  }
  return 'branch-jump'
}

/**
 * 步骤 / 条件节点 —— 内置 `rect` / `diamond` 各加一行**角标**。
 *
 * 为什么不是 badge：G6 的 `Badge` 定位是"贴包围盒的某条边"（`getTextStyleByPlacement`），
 * `top-left` 会把文字**右对齐到盒左上角**、于是整行飘到框外面去（实测）。
 * 我们要的是"盒内左上角的小字"，所以用 G6 的图形能力补一行 `text` ——
 * 这仍然是 G6 的 shape（`upsert('idx', 'text', …)`），不是自己造轮子。
 */
/** 角标那行文字的样式（盒内左上角）。 */
function idxStyle(text: string): Record<string, unknown> {
  return {
    x: -(NODE_W / 2) + 10,
    y: -(NODE_H / 2) + 13,
    text,
    fontSize: 9,
    fill: tokSolid('--fg-secondary', '--fg-primary'),
    textAlign: 'left',
    textBaseline: 'middle',
  }
}

class WfStepNode extends Rect {
  render(attributes = this.parsedAttributes, container = this): void {
    super.render(attributes, container)
    const idx = (attributes as unknown as { idxText?: string }).idxText
    if (idx) this.upsert('idx', 'text', idxStyle(idx), container)
  }
}

class WfCondNode extends Diamond {
  render(attributes = this.parsedAttributes, container = this): void {
    super.render(attributes, container)
    const idx = (attributes as unknown as { idxText?: string }).idxText
    if (idx) this.upsert('idx', 'text', { ...idxStyle(idx), x: -18, y: -(NODE_H / 2) + 12 }, container)
  }
}

/** 注册只做一次（重复注册 G6 会打 warn）。 */
let nodesRegistered = false
function ensureWorkflowNodes(): void {
  if (nodesRegistered) return
  nodesRegistered = true
  register(ExtensionCategory.NODE, 'wf-step', WfStepNode)
  register(ExtensionCategory.NODE, 'wf-cond', WfCondNode)
}

function nodeDataOf(
  n: WorkflowCanvasNode,
  selectedId: number | null,
  xy?: [number, number]
): Record<string, unknown> {
  const v = n.view
  const cond = v.isCondition
  const states: string[] = []
  if (selectedId === n.id) states.push('selected')
  if (v.done) states.push('done')
  if (v.current) states.push('current')

  /**
   * **不用连接桩（ports）**：节点上不钉死连接点，让 G6 按连线方向自动取边框交点
   * （`BaseEdge` 的 `getEndpoints` → `getIntersectPoint`）—— 这是内置行为，比固定桩更自然，
   * 也不会出现「线从一个奇怪的桩上斜着出去」。分支语义已经写在**边 label** 上，不靠桩区分。
   *
   * 建分支的入口相应地从「点端口」改成**节点右键菜单**（见下方 contextmenu 的 items）。
   */

  /** 角标走自定义节点里那行 `text`（badge 定不出"盒内左上角"，见 makeNodeClass 的注释）。 */
  const badges: Record<string, unknown>[] = []
  if (cond && v.condText) {
    badges.push({
      text: v.condText,
      placement: 'bottom',
      /** 往下让开——贴太近会压住菱形本体（用户反馈）。 */
      offsetY: 16,
      fontSize: 9,
      fill: tokSolid('--fg-secondary', '--fg-primary'),
      backgroundFill: tokSolid('--accent-warm-soft', '--bg-hover'),
      padding: [2, 6],
      /**
       * **限宽**：判据比菱形还宽时，胶囊的左右两端都突到菱形投影外面 ——
       * 实测宽度 202 对菱形 150，看着就像「没跟节点对齐、偏左」（用户反馈）。
       * 压到比菱形窄一点，单行 + 省略号。
       */
      wordWrap: true,
      wordWrapWidth: NODE_W - 26,
      maxLines: 1,
      textOverflow: '...',
    })
  }

  return {
    id: String(n.id),
    type: cond ? 'wf-cond' : 'wf-step',
    data: { id: n.id },
    states,
    style: {
      size: [NODE_W, NODE_H],
      /** 布局算出来的坐标：**必须写回数据**，否则下一次 setData 会把它们清掉（见 applyLayout）。 */
      ...(xy ? { x: xy[0], y: xy[1] } : {}),
      radius: cond ? 0 : 8,
      /** 自定义键：自定义节点在 render 里读它画角标。 */
      idxText: v.badge,
      badge: true,
      badges,
      labelText: v.title,
      labelPlacement: 'center',
      /**
       * 左对齐要靠 `offsetX` 把锚点挪到盒左边界 —— 只设 textAlign 会让文字从盒中心向右跑出框
       * （实测溢出 46px）。
       */
      labelTextAlign: cond ? 'center' : 'left',
      labelOffsetX: cond ? 0 : -(NODE_W / 2) + 10,
      labelWordWrap: true,
      /**
       * 条件节点的标题在**菱形内部**，可用宽度随行位置收窄：
       * 菱形半宽 = 75 × (1 − |y|/28)，两行文字（行高 13）跨度 y ∈ [−13, 13]，
       * 在 y=13 处只剩 80px —— 所以 wrap 宽度取 72，字号降到 10。
       * （之前用 NODE_W*0.6 = 90 + 12px 字号，第二行实测量到 43 的半宽，
       *   正好越过该处的菱形边界，看着就是「第二行顶出菱形」。）
       */
      labelWordWrapWidth: cond ? 72 : NODE_W - 20,
      labelMaxLines: 2,
      labelTextOverflow: '...',
      labelFontSize: cond ? 10 : 12,
      labelLineHeight: cond ? 13 : 16,
    },
  }
}

/**
 * **回边**：连到流程顺序更靠前的节点（例如「满足 → 回到第 1 步」）。
 *
 * 这类边会在 dagre 里形成环，而 dagre **消环的办法是反转其中一条边** —— 实测它反转的是主干边：
 * 「第 1 步 → 第 2 步 → 条件 → 第 1 步」这个环里它反转了「第 2 步 → 条件」，
 * 于是**条件被排到最上层**、整张图自上而下的顺序与流程设计正好相反（用户反馈）。
 * 试过 `ranker` / `acyclicer` / 边的 `weight`、`minlen`，实测**都改不动它**。
 *
 * 所以布局数据里**只放前进边**，回边等布局跑完再把坐标写回、连同它一起画（见 `applyLayout`）。
 */
function isBackEdge(nodes: readonly WorkflowCanvasNode[], from: number, to: number): boolean {
  const a = nodes.find((n) => n.id === from)
  const b = nodes.find((n) => n.id === to)
  if (!a || !b) return false
  return b.order_index <= a.order_index
}

function layoutCfg(rankdir: WorkflowRankDir): Record<string, unknown> {
  return { type: 'antv-dagre', rankdir, nodesep: 24, ranksep: 40, marginx: 40, marginy: 40 }
}

/**
 * 一次完整的「布局 → 写回坐标 → 补齐回边并绘制」。
 *
 * 分两趟是必须的：喂给 dagre 的数据**不能含回边**（否则它会反转主干边、层级反过来），
 * 但回边又得画出来。所以第一趟只放前进边跑布局，把算出来的坐标记下来，
 * 第二趟带着坐标和全部边重设数据 —— **坐标必须写进数据**，
 * 因为 `setData` 会把没有 x/y 的元素位置清掉。
 */
async function syncLayout(
  g: Graph,
  nodes: readonly WorkflowCanvasNode[],
  selectedId: number | null,
  rankdir: WorkflowRankDir
): Promise<void> {
  g.setData(buildData(nodes, selectedId, { forwardOnly: true }) as never)
  await g.layout(layoutCfg(rankdir) as never)
  const pos = new Map<string, [number, number]>()
  for (const n of nodes) {
    const p = g.getElementPosition(String(n.id)) as [number, number] | undefined
    if (p) pos.set(String(n.id), [p[0], p[1]])
  }
  g.setData(buildData(nodes, selectedId, { pos }) as never)
  await g.draw()
}

function buildData(
  nodes: readonly WorkflowCanvasNode[],
  selectedId: number | null,
  opts: { forwardOnly?: boolean; pos?: Map<string, [number, number]> } = {}
): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
  const { forwardOnly = false, pos } = opts
  return {
    nodes: nodes.map((n) => nodeDataOf(n, selectedId, pos?.get(String(n.id)))),
    edges: workflowEdges(nodes)
      .filter((e) => !forwardOnly || !isBackEdge(nodes, e.from, e.to))
      .map((e) => {
      const kind = kindOfEdge(nodes, e.from, e.to, e.branch)
      return {
        id: e.from + '>' + e.to,
        source: String(e.from),
        target: String(e.to),
        type: 'polyline',
        style: {
          ...edgeStyleOf(kind),
          /**
           * **A\* 避障路由** —— 三个参数缺一不可，都是实测出来的（`utils/router/shortest-path.ts`）：
           *
           * · `enableObstacleAvoidance: true` —— 默认是 **false**，此时障碍物只有源和目标两个节点
           *   （`const obstacles = options.enableObstacleAvoidance ? nodes : [sourceNode, targetNode]`），
           *   A\* 只是在空白网格上找折线，**中间的节点照穿不误**；
           * · `gridSize: 10` —— 默认 **5** 太细：格子越多搜索空间越大，配合默认的
           *   `maximumLoops: 3000` 根本走不到终点，`aStarSearch` 返回空数组 → `polyline.ts`
           *   回退到普通正交路由 → **线又穿过去了**（实测：gridSize 5 时路径与「完全不开避障」逐字相同；
           *   调到 8/10/15/20 才真正绕行）；
           * · `maximumLoops: 50000` —— 给绕行留足搜索预算（默认 3000 在稍大的图上就会耗尽）。
           *
           * 真找不到路径时 `polyline.ts` 仍会回退正交路由，所以不会出现「画不出线」。
           */
          router: {
            type: 'shortest-path',
            offset: 12,
            gridSize: 10,
            maximumLoops: 50000,
            enableObstacleAvoidance: true,
          },
          endArrow: true,
          endArrowType: 'triangle',
          labelText: edgeLabelOf(kind),
          labelFontSize: 9,
          labelBackground: true,
          /** 正交折线有竖直段，标签默认会跟着边旋转 —— 关掉，让它始终水平可读。 */
          labelAutoRotate: false,
        },
      }
    }),
  }
}

export function WorkflowCanvasG6({
  nodes,
  selectedId,
  rankdir = 'TB',
  onSelect,
  onBranch,
  onBranchRemove,
  onNodeMoved,
  onEdgeRewire,
  onOpen,
  handleRef,
}: WorkflowCanvasProps): ReactElement {
  const box = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)
  /**
   * 回调与节点表都放 ref：父组件的回调是内联箭头函数，每次渲染都是新引用 ——
   * 依赖它会让「数据没变但 effect 重跑」，转成无限循环。画布只该对**数据**变化有反应。
   */
  const cb = useRef({
    onSelect,
    onBranch,
    onBranchRemove,
    onNodeMoved,
    onEdgeRewire,
    onOpen,
    selectedId,
    nodes: [] as readonly WorkflowCanvasNode[],
  })
  cb.current = { onSelect, onBranch, onBranchRemove, onNodeMoved, onEdgeRewire, onOpen, selectedId, nodes }
  /** 边 id（"from>to"）→ 语义类别。右键菜单要知道被点中的是哪一类边。 */
  const edgeKindById = useRef(new Map<string, string>())
  edgeKindById.current = new Map(
    workflowEdges(nodes).map((e) => [e.from + '>' + e.to, kindOfEdge(nodes, e.from, e.to, e.branch)])
  )

  useEffect(() => {
    const el = box.current
    if (!el) return
    let dead = false
    let stopTheme: (() => void) | null = null
    let stopRewire: (() => void) | null = null

    registerZhixingTheme()
    ensureWorkflowNodes()

    const graph = new Graph({
      container: el,
      theme: THEME_NAME,
      autoFit: 'view',
      /**
       * 首屏数据**只放前进边** —— 回边会让 dagre 反转主干边、把层级排反（见 isBackEdge）。
       * 回边由 render 之后的 syncLayout 补齐（那时坐标已经算好了）。
       */
      data: buildData(cb.current.nodes, cb.current.selectedId, { forwardOnly: true }) as never,

      node: {
        /** 尺寸/圆角/端口/角标/标题都在数据里逐节点给（见 nodeDataOf）。 */
        style: { port: true, badge: true },
        /** 工作流特有的两个业务状态：跑过这一步、正停在这一步。 */
        state: {
          done: { stroke: tokSolid('--success', '--accent'), lineWidth: tokNum('--focus-w') },
          current: {
            stroke: tokSolid('--accent', '--focus-ring'),
            lineWidth: tokNum('--focus-w'),
            shadowColor: tokSolid('--accent', '--focus-ring'),
            shadowBlur: 8,
          },
        },
      },

      edge: { style: { labelFill: tokSolid('--fg-secondary', '--fg-primary') } },

      layout: {
        // AntV 自己的 dagre 实现，选项与原 @dagrejs/dagre 一致 —— 原有参数可 1:1 搬
        type: 'antv-dagre',
        rankdir,
        nodesep: 24,
        ranksep: 40,
        marginx: 40,
        marginy: 40,
      },

      /** 交互全部用内置 behavior；「点端口建分支」已取消（节点上不留固定连接点）。 */
      behaviors: [
        'drag-canvas',
        'zoom-canvas',
        'drag-element',
        { type: 'click-select', key: 'click-select', state: 'selected' },
        'hover-activate',
      ],

      /**
       * 右键菜单：节点上给「清除分支」，边上给「删除分支」。
       * 旧实现是「悬停分支线 → 冒出删除按钮」；G6 没有对应浮层，右键菜单是它的惯用做法。
       */
      plugins: [
        {
          type: 'contextmenu',
          trigger: 'contextmenu',
          className: 'g6-menu',
          offset: [4, 4],
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
              /**
               * 建分支：**先在这里选槽位，再点目标节点**（页面的两段式点选）。
               * 这是取消固定连接点之后「分支从哪里开始」的入口。
               */
              if (n.view.isCondition) {
                items.push({ name: '建立「满足」分支', value: 'wf:branch:' + n.id + ':true' })
                items.push({ name: '建立「不满足」分支', value: 'wf:branch:' + n.id + ':false' })
              } else {
                items.push({ name: '建立「跳到」分支', value: 'wf:branch:' + n.id + ':true' })
              }
              if (n.branch_node_id) items.push({ name: '清除「满足」分支', value: 'wf:unbranch:' + n.id + ':true' })
              if (n.branch_false_node_id)
                items.push({ name: '清除「不满足」分支', value: 'wf:unbranch:' + n.id + ':false' })
              return items
            }
            return []
          },
          onClick: (value: string) => {
            const mb = /^wf:branch:(\d+):(true|false)$/.exec(value)
            if (mb) {
              cb.current.onBranch(Number(mb[1]), mb[2] as 'true' | 'false')
              return
            }
            const me = /^wf:unbranch-edge:(\d+)>(\d+)$/.exec(value)
            if (me) {
              const kind = edgeKindById.current.get(me[1] + '>' + me[2])
              cb.current.onBranchRemove(Number(me[1]), kind === 'branch-false' ? 'false' : 'true')
              return
            }
            const mn = /^wf:unbranch:(\d+):(true|false)$/.exec(value)
            if (mn) cb.current.onBranchRemove(Number(mn[1]), mn[2] as 'true' | 'false')
          },
        },
      ],
    })
    graphRef.current = graph

    const idOf = (e: IEvent): number => Number((e as unknown as { target?: { id?: string } }).target?.id)

    /**
     * 点节点 = 选中。**不再有「点端口」这一支** —— 节点上没有固定连接点，
     * 边由 G6 按方向自动取交点；建分支改走右键菜单（见上面 contextmenu 的 items）。
     */
    graph.on('node:click', (e: IEvent) => cb.current.onSelect(idOf(e)))
    graph.on('node:dblclick', (e: IEvent) => cb.current.onOpen(idOf(e)))
    /**
     * 拖完落库。**只在 dragend 报**，不在拖动过程中报 —— 一次拖动只写一次库，
     * 否则每帧一次 IPC（渲染层逐条调 IPC 那条架构断言正是拦这个的）。
     */
    graph.on('node:dragend', (e: IEvent) => {
      const id = idOf(e)
      const p = graph.getElementPosition(String(id)) as [number, number] | undefined
      if (!p) return
      cb.current.onNodeMoved(id, Math.round(p[0] - NODE_W / 2), Math.round(p[1] - NODE_H / 2))
    })
    graph.on('canvas:click', () => cb.current.onSelect(null))

    /**
     * 同图谱画布：G6 只在建图时量一次容器，尺寸变化要自己盯。
     *
     * **必须防抖 + 比尺寸** —— 选中节点会让侧栏/滚动条变化，容器宽度高频抖动，
     * 而每次 `resize()` 都会重建 canvas（重建期间画面是空的，看着就是白屏闪一下）。
     * 只有静置 150ms 后尺寸确实不同才真正 resize。
     */
    let lastW = el.getBoundingClientRect().width
    let lastH = el.getBoundingClientRect().height
    let resizeTimer = 0
    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        // **必须挡一道**：disconnect() 挡不住已经排进队列的那一次回调
        if (dead) return
        const r = el.getBoundingClientRect()
        if (Math.abs(r.width - lastW) < 1 && Math.abs(r.height - lastH) < 1) return
        lastW = r.width
        lastH = r.height
        graph.resize()
      }, 150)
    })
    ro.observe(el)

    void graph.render().then(async () => {
      if (dead) return
      // 首屏布局已由 render 跑完（数据里只有前进边），这里把回边连同坐标补上
      await syncLayout(graph, cb.current.nodes, cb.current.selectedId, rankdir)
      if (dead) return
      /**
       * 拖拽改挂分支。
       *
       * 只有**分支边**能改挂（顺序边由 order_index 隐式推出，没有「挂在哪」）；
       * 而且只能拖**指向目标的那一端** —— 分支是挂在起点节点上的属性
       * （`branch_node_id` / `branch_false_node_id`），改的永远是「满足/不满足去哪」。
       */
      stopRewire = setupEdgeRewire(graph, el, {
        canRewire: (edgeId) => {
          const k = edgeKindById.current.get(edgeId)
          return k === 'branch-true' || k === 'branch-false' || k === 'branch-jump'
        },
        canDropOn: (nodeId, edgeId) => nodeId !== edgeId.split('>')[0],
        onDrop: (edgeId, end, targetId) => {
          if (end !== 'dst') return
          const kind = edgeKindById.current.get(edgeId)
          const from = edgeId.split('>')[0]
          if (!from || !kind) return
          cb.current.onEdgeRewire(Number(from), kind === 'branch-false' ? 'false' : 'true', Number(targetId))
        },
      })
      stopTheme = subscribeG6Theme(() => applyZhixingTheme(graph))
    })

    return () => {
      dead = true
      ro.disconnect()
      window.clearTimeout(resizeTimer)
      stopTheme?.()
      stopRewire?.()
      graph.destroy()
      graphRef.current = null
    }
    // 依赖是**空**：图只建一次。方向变化改走下面那个 effect（改布局配置重跑 layout）
  }, [])

  /** 布局方向变化：改配置 + 重跑一次布局，**不重建图**（首帧那次与建图配置等价、幂等）。 */
  const dirSeen = useRef(false)
  useEffect(() => {
    if (!dirSeen.current) {
      dirSeen.current = true
      return
    }
    const g = graphRef.current
    if (!g) return
    void syncLayout(g, cb.current.nodes, cb.current.selectedId, rankdir)
  }, [rankdir])

  // 数据变化 → 增量同步（不重建图，布局会自己重跑）
  useEffect(() => {
    const g = graphRef.current
    if (!g) return
    void syncLayout(g, nodes, cb.current.selectedId, rankdir)
  }, [nodes, rankdir])

  /**
   * 选中态：**由 G6 的 `click-select` 负责**（点节点即加 `selected`，样式走主题/图配置），
   * 这里只同步「页面侧发起的那一份」（侧栏点选、关闭弹窗后清空）。
   */
  useEffect(() => {
    const g = graphRef.current
    if (!g) return
    for (const n of nodes) {
      g.setElementState(String(n.id), selectedId === n.id ? ['selected'] : [])
    }
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
