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
  /** 双击节点（打开编辑弹窗）。 */
  onOpen: (id: number) => void
  handleRef?: Ref<WorkflowCanvasHandle>
}

/** 出线端口的 key —— 条件节点左右各一，普通步骤右侧一个「跳到」。 */
function portKeyOf(n: WorkflowCanvasNode, to: number): string | undefined {
  if (n.branch_false_node_id === to) return 'false'
  if (n.branch_node_id === to) return 'true'
  return n.view.isCondition ? undefined : 'jump'
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

function nodeDataOf(n: WorkflowCanvasNode, selectedId: number | null): Record<string, unknown> {
  const v = n.view
  const cond = v.isCondition
  const states: string[] = []
  if (selectedId === n.id) states.push('selected')
  if (v.done) states.push('done')
  if (v.current) states.push('current')

  /**
   * 端口：条件节点左右各一（满足 / 不满足），步骤右侧一个「跳到」。
   *
   * ⚠️ **必须给 `r`**：G6 把「没给 r（或 r=0）」的端口当作 *simple port* ——
   * 不画图形但仍是可连接的点（`utils/element.ts` 的 `isSimplePort`）。
   * 第一版漏了 r，结果端口一个都看不见。颜色与对应分支的边同源，一眼能对上。
   */
  const gEdge = tokSolid('--graph-edge', '--border-strong')
  const gFill = tokSolid('--bg-layer-solid', '--pack-layer')
  const ports = cond
    ? [
        { key: 'true', placement: 'right' as const, r: 4, fill: gFill, stroke: mix(tokSolid('--success', '--accent'), 0.62, gEdge), lineWidth: 1.4 },
        { key: 'false', placement: 'left' as const, r: 4, fill: gFill, stroke: mix(tokSolid('--danger', '--accent'), 0.58, gEdge), lineWidth: 1.4 },
      ]
    : [{ key: 'jump', placement: 'right' as const, r: 4, fill: gFill, stroke: gEdge, lineWidth: 1.4 }]

  /** 角标走自定义节点里那行 `text`（badge 定不出"盒内左上角"，见 makeNodeClass 的注释）。 */
  const badges: Record<string, unknown>[] = []
  if (cond && v.condText) {
    badges.push({
      text: v.condText,
      placement: 'bottom',
      fontSize: 9,
      fill: tokSolid('--fg-secondary', '--fg-primary'),
      backgroundFill: tokSolid('--accent-warm-soft', '--bg-hover'),
      padding: [2, 6],
    })
  }

  return {
    id: String(n.id),
    type: cond ? 'wf-cond' : 'wf-step',
    data: { id: n.id },
    states,
    style: {
      size: [NODE_W, NODE_H],
      radius: cond ? 0 : 8,
      ports,
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
      labelWordWrapWidth: cond ? NODE_W * 0.6 : NODE_W - 20,
      labelMaxLines: 2,
      labelTextOverflow: '...',
      labelFontSize: 12,
    },
  }
}

function buildData(
  nodes: readonly WorkflowCanvasNode[],
  selectedId: number | null
): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
  return {
    nodes: nodes.map((n) => nodeDataOf(n, selectedId)),
    edges: workflowEdges(nodes).map((e) => {
      const kind = kindOfEdge(nodes, e.from, e.to, e.branch)
      const src = nodes.find((n) => n.id === e.from)
      return {
        id: e.from + '>' + e.to,
        source: String(e.from),
        target: String(e.to),
        /** 从**指定端口**出发（内置边按 key 找桩）。 */
        sourcePort: src ? portKeyOf(src, e.to) : undefined,
        type: 'polyline',
        style: {
          ...edgeStyleOf(kind),
          /** 正交折线是内置路由，不用自己算折点。 */
          router: { type: 'orth', padding: 6 },
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
    onOpen,
    selectedId,
    nodes: [] as readonly WorkflowCanvasNode[],
  })
  cb.current = { onSelect, onBranch, onBranchRemove, onNodeMoved, onOpen, selectedId, nodes }
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

    registerZhixingTheme()
    ensureWorkflowNodes()

    const graph = new Graph({
      container: el,
      theme: THEME_NAME,
      autoFit: 'view',
      data: buildData(cb.current.nodes, cb.current.selectedId) as never,

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

      /** 交互全部用内置 behavior；端口点击不是独立交互（见下面的 portOf）。 */
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
              if (n.branch_node_id) items.push({ name: '清除「满足」分支', value: 'wf:unbranch:' + n.id + ':true' })
              if (n.branch_false_node_id)
                items.push({ name: '清除「不满足」分支', value: 'wf:unbranch:' + n.id + ':false' })
              return items
            }
            return []
          },
          onClick: (value: string) => {
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
     * 点的**是端口**还是节点本体？
     *
     * G6 事件里 `e.target` 永远是元素（节点），要拿**原始命中图形**得看 `e.originalTarget`；
     * 再用 `node.getPorts()`（`subObject` 已剥掉 `port-` 前缀）做一次**对象身份比对**即可 ——
     * 实测四次点击（左桩 / 右桩 / 菱形尖角 / 节点本体）全部判断正确。
     * 旧实现那套「closest('.wf-port') → elementFromPoint 兜底 → 按中文字面量判槽位」已删。
     */
    const portOf = (e: IEvent): string | null => {
      const ev = e as unknown as {
        originalTarget?: unknown
        target?: { getPorts?: () => Record<string, unknown> }
      }
      const hit = ev.originalTarget
      const node = ev.target
      if (!hit || !node?.getPorts) return null
      for (const [key, shape] of Object.entries(node.getPorts())) {
        if (shape === hit) return key
      }
      return null
    }

    graph.on('node:click', (e: IEvent) => {
      const key = portOf(e)
      if (key) cb.current.onBranch(idOf(e), key === 'false' ? 'false' : 'true')
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
      cb.current.onNodeMoved(id, Math.round(p[0] - NODE_W / 2), Math.round(p[1] - NODE_H / 2))
    })
    graph.on('canvas:click', () => cb.current.onSelect(null))

    // 同图谱画布：G6 只在建图时量一次容器，尺寸变化要自己盯
    const ro = new ResizeObserver(() => {
      // **必须挡一道**：disconnect() 挡不住已经排进队列的那一次回调
      if (dead) return
      graph.resize()
    })
    ro.observe(el)

    void graph.render().then(() => {
      if (dead) return
      stopTheme = subscribeG6Theme(() => applyZhixingTheme(graph))
    })

    return () => {
      dead = true
      ro.disconnect()
      stopTheme?.()
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
    // **配置要直接传给 layout()**：不传参时它用建图那一刻的 presetOptions，setOptions 不会更新那份
    void g.layout({ type: 'antv-dagre', rankdir, nodesep: 24, ranksep: 40, marginx: 40, marginy: 40 } as never)
  }, [rankdir])

  // 数据变化 → 增量同步（不重建图，布局会自己重跑）
  useEffect(() => {
    const g = graphRef.current
    if (!g) return
    g.setData(buildData(nodes, cb.current.selectedId) as never)
    void g.layout({ type: 'antv-dagre', rankdir, nodesep: 24, ranksep: 40, marginx: 40, marginy: 40 } as never)
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
