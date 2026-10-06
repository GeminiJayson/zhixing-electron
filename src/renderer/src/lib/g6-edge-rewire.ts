/**
 * 拖拽改挂连线 —— 按住连线**靠近某一端**的位置拖动，松手落到另一个节点上即完成改挂。
 *
 * ## 为什么自己写这一小段
 *
 * G6 内置的 `create-edge` 只做「**新建**边」（从节点拖/点到节点），没有「改挂已有边的一端」这回事，
 * 官方 behavior 列表里也没有对应项。所以这里用 G6 的事件与坐标 API 拼一个小模块：
 *
 * | 需要的能力 | 用的 G6 API |
 * | --- | --- |
 * | 命中「按在了哪条边上」 | `edge:pointerdown` 事件的 `targetType === 'edge'` 与 `target.id` |
 * | 屏幕坐标 → 图坐标 | `graph.getCanvasByViewport()` |
 * | 指针下的节点 | 各节点的 `getShape('key').getRenderBounds()`（世界坐标） |
 * | 候选高亮 | `graph.setElementState(id, ['active'])`（样式走主题的 `active`） |
 *
 * ## 「靠近哪一端」怎么判
 *
 * 不去读边的端点坐标（`key.getPoint(0)` 在 Path 图形上返回 `[null, null]`，实测不可用），
 * 而是比**指针到两端节点中心**的距离：近的那端就是要换掉的端。
 * 再加一道门槛 —— 指针离最近那端超过 `max(40, 边长 × 0.35)` 就算「按在线的中段」，不进入拖拽，
 * 否则想平移画布时会误触。
 */
import type { Graph } from '@antv/g6'

export interface EdgeRewireHandlers {
  /** 这条边允不允许改挂（工作流只允许**分支边**，顺序边是隐式的、改不动）。 */
  canRewire: (edgeId: string) => boolean
  /** 允不允许落到这个节点上（例如不能连到自己）。 */
  canDropOn?: (nodeId: string, edgeId: string) => boolean
  /** 拖拽结束、指针落在目标节点上时回调。`end` 是要换掉的那一端。 */
  onDrop: (edgeId: string, end: 'src' | 'dst', targetId: string) => void
}

const dist = (a: [number, number], b: [number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1])

export function setupEdgeRewire(
  graph: Graph,
  container: HTMLElement,
  handlers: EdgeRewireHandlers
): () => void {
  /** 正在拖的那条边；null = 没在拖。 */
  let drag: { edgeId: string; end: 'src' | 'dst'; fixed: string } | null = null
  /** 当前高亮的候选节点。 */
  let hovered: string | null = null

  /** 屏幕坐标 → 图坐标（`getCanvasByClient` 直接吃 client 坐标，省掉容器 rect 换算）。 */
  const toCanvas = (ev: { clientX: number; clientY: number }): [number, number] =>
    graph.getCanvasByClient([ev.clientX, ev.clientY]) as [number, number]

  /** 指针落在哪个节点上（用节点 keyShape 的世界包围盒判定）。 */
  const nodeAt = (p: [number, number]): string | null => {
    for (const n of graph.getNodeData()) {
      const id = String(n.id)
      const b = graph.getElementRenderBounds(id)
      if (!b) continue
      if (p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1]) return id
    }
    return null
  }

  const clearHover = (): void => {
    if (hovered) graph.setElementState(hovered, [])
    hovered = null
  }

  const endDrag = (): void => {
    clearHover()
    if (drag) container.style.removeProperty('cursor')
    drag = null
  }

  /**
   * 拖拽期间的光标。
   *
   * 必须带 `important`：G6 的 `drag-canvas` 也在容器上写 inline `cursor`（`grab`），
   * 同是 inline 样式时后写的赢，光靠赋值会被它盖掉。
   */
  const setCursor = (): void => {
    container.style.setProperty('cursor', 'grabbing', 'important')
  }

  const onEdgeDown = (e: unknown): void => {
    /**
     * ⚠️ G6 事件对象上的坐标是 `client` / `canvas` / `viewport` / `page` / `screen` **对象**，
     * **没有 `clientX` / `clientY`**（第一版按 DOM 事件的样子写了 `ev.clientX`，
     * 结果永远取不到坐标、直接 return —— 表现是「按住端点毫无反应」）。
     */
    const ev = e as {
      targetType?: string
      target?: { id?: string }
      client?: { x: number; y: number }
      canvas?: [number, number] | null
    }
    if (ev.targetType !== 'edge' || !ev.target?.id) return
    const edgeId = String(ev.target.id)
    if (!handlers.canRewire(edgeId)) return
    const [src, dst] = edgeId.split(/>|,/)
    if (!src || !dst) return
    const p: [number, number] | null =
      ev.canvas && ev.canvas[0] != null
        ? ev.canvas
        : ev.client
          ? (graph.getCanvasByClient([ev.client.x, ev.client.y]) as [number, number])
          : null
    if (!p) return
    const sPos = graph.getElementPosition(src) as [number, number]
    const tPos = graph.getElementPosition(dst) as [number, number]
    const dS = dist(p, [sPos[0], sPos[1]])
    const dT = dist(p, [tPos[0], tPos[1]])
    /**
     * **按在线上任何位置都能起拖**，靠近哪一端就改挂哪一端。
     *
     * 第一版加了一条「按在线的中段就不进拖拽」的门槛（想避免与拖画布误触），
     * 实测**行不通**：连线的端点正好落在节点边框上，而节点层级比边高
     * （节点 `zIndex: 2`、边 1），按上去命中的是**节点** —— 于是"按在靠近端点处"
     * 这条唯一能过门槛的操作根本按不到边。改成不设门槛：按空白处仍是拖画布，
     * 按到线就改挂（`increasedLineWidthForHitTesting` 已经让线好按了）。
     */
    const end: 'src' | 'dst' = dS <= dT ? 'src' : 'dst'
    drag = { edgeId, end, fixed: end === 'src' ? dst : src }
    setCursor()
  }

  const onMove = (ev: PointerEvent): void => {
    if (!drag) return
    /** G6 的 `drag-canvas` 会在每次指针移动时重写 inline `cursor`，所以这里每次都设回来。 */
    setCursor()
    const p = toCanvas(ev)
    const id = nodeAt(p)
    const ok = id && id !== drag.fixed && (handlers.canDropOn?.(id, drag.edgeId) ?? true) ? id : null
    if (ok === hovered) return
    clearHover()
    if (ok) {
      graph.setElementState(ok, ['active'])
      hovered = ok
    }
  }

  const onUp = (ev: PointerEvent): void => {
    if (!drag) return
    const d = drag
    const p = toCanvas(ev)
    const id = nodeAt(p)
    endDrag()
    if (!id || id === d.fixed) return
    if (handlers.canDropOn && !handlers.canDropOn(id, d.edgeId)) return
    handlers.onDrop(d.edgeId, d.end, id)
  }

  /** 拖出容器也要收尾，否则会卡在拖拽态。 */
  const onLeave = (): void => {
    if (drag) endDrag()
  }

  graph.on('edge:pointerdown', onEdgeDown)
  /**
   * `pointermove` / `pointerup` 挂在 **window** 上而不是容器上：
   * 拖拽时指针很容易滑出画布（尤其往视口边缘的节点上放），挂在容器上会**收不到 pointerup**，
   * 于是拖拽态一直挂着、候选高亮不消失。挂在 window 上按到哪都能收尾。
   */
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  container.addEventListener('pointerleave', onLeave)

  return () => {
    graph.off('edge:pointerdown', onEdgeDown)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    container.removeEventListener('pointerleave', onLeave)
    endDrag()
  }
}
