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
  return (
    '<svg class="wf-node__svg" width="' + NODE_W + '" height="' + NODE_H + '" viewBox="0 0 ' + NODE_W + ' ' + NODE_H + '">' +
    parts.join('') +
    '</svg>'
  )
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
  const cb = useRef({ onSelect, onOpen, selectedId, nodes: [] as readonly WorkflowCanvasNode[] })
  cb.current = { onSelect, onOpen, selectedId, nodes }

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
          style: e.branch ? { lineDash: [4, 4] } : {},
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
        style: { innerHTML: nodeSvg(n, cb.current.selectedId === n.id) },
      })),
      edges: workflowEdges(nodes).map((e) => ({
        id: e.from + '>' + e.to,
        source: String(e.from),
        target: String(e.to),
        data: { kind: kindOfEdge(nodes, e.from, e.to, e.branch) },
        style: e.branch ? { lineDash: [4, 4] } : {},
      })),
    } as never)
    void g.render()
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
