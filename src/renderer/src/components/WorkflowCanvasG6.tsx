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
import { useEffect, useImperativeHandle, useRef, type ReactElement, type Ref } from 'react'
import { subscribeG6Theme, tok, tokNum, tokSolid } from '@renderer/lib/g6-theme'
import { workflowEdges, type LayoutNode, type WorkflowRankDir } from '@renderer/lib/workflow-layout'

export interface WorkflowCanvasHandle {
  /** 重新跑一次布局。 */
  relayout(): void
  /** 适配视图。 */
  fit(): void
}

export interface WorkflowCanvasProps {
  nodes: readonly LayoutNode[]
  /** 模板节点标题（id → 文案）。 */
  labelOf: (id: number) => string
  selectedId: number | null
  rankdir?: WorkflowRankDir
  onSelect: (id: number | null) => void
  /** 双击节点（打开编辑弹窗）。 */
  onOpen: (id: number) => void
  handleRef?: Ref<WorkflowCanvasHandle>
}

export function WorkflowCanvasG6({
  nodes,
  labelOf,
  selectedId,
  rankdir = 'TB',
  onSelect,
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
  const cb = useRef({ onSelect, onOpen, labelOf, nodes: [] as readonly LayoutNode[] })
  cb.current = { onSelect, onOpen, labelOf, nodes }

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
          style: { labelText: cb.current.labelOf(n.id) },
        })),
        // 分支边虚线 —— 与顺序边区分，语义来自 workflowEdges 的投影，不在这里重判
        edges: edges.map((e) => ({
          id: e.from + '>' + e.to,
          source: String(e.from),
          target: String(e.to),
          data: { branch: e.branch },
          style: e.branch ? { lineDash: [4, 4] } : {},
        })),
      }
    }

    const graph = new Graph({
      container: el,
      autoFit: 'view',
      // setData / 构造的 data 类型对不上是 G6 的已知粗糙处，这里的形状是对的
      data: build() as never,
      node: {
        type: 'rect',
        style: {
          size: [150, 56],
          radius: tokNum('--radius-md'),
          fill: tokSolid('--bg-layer-solid', '--pack-layer'),
          stroke: tokSolid('--border-strong', '--border'),
          lineWidth: tokNum('--border-w'),
          labelFill: tokSolid('--fg-primary', '--fg-primary'),
          labelFontFamily: tok('--font-ui'),
          labelFontSize: tokNum('--text-aux'),
          labelMaxWidth: 130,
        },
        state: {
          selected: { stroke: tokSolid('--accent', '--accent'), lineWidth: tokNum('--focus-w') },
        },
      },
      edge: {
        type: 'polyline',
        style: {
          stroke: tokSolid('--border-strong', '--border'),
          lineWidth: tokNum('--border-w'),
          endArrow: true,
          router: { type: 'orth' },
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
    })
    graphRef.current = graph

    const idOf = (e: IEvent): number =>
      Number((e as unknown as { target?: { id?: string } }).target?.id)
    graph.on('node:click', (e: IEvent) => cb.current.onSelect(idOf(e)))
    graph.on('node:dblclick', (e: IEvent) => cb.current.onOpen(idOf(e)))
    graph.on('canvas:click', () => cb.current.onSelect(null))

    // 同图谱画布：G6 只在建图时量一次容器，尺寸变化要自己盯（canvas.autoResize 不在类型里）
    const ro = new ResizeObserver(() => graph.resize())
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
        style: { labelText: cb.current.labelOf(n.id) },
      })),
      edges: workflowEdges(nodes).map((e) => ({
        id: e.from + '>' + e.to,
        source: String(e.from),
        target: String(e.to),
        data: { branch: e.branch },
        style: e.branch ? { lineDash: [4, 4] } : {},
      })),
    } as never)
    void g.render()
  }, [nodes])

  // 选中态
  useEffect(() => {
    const g = graphRef.current
    if (!g) return
    const states: Record<string, string[]> = {}
    for (const n of nodes) states[String(n.id)] = selectedId === n.id ? ['selected'] : []
    void g.setElementState(states)
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
