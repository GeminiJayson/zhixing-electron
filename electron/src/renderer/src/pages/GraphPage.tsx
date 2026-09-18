import { subscribeDomain } from '@shared/events'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link2 } from 'lucide-react'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import { Maximize2, RefreshCw } from 'lucide-react'
import type { GraphNodePayload, GraphPayload } from '@shared/types'
import { t } from '../i18n'
import { usePanZoom } from '../lib/usePanZoom'
import { edgeMidpoint, edgePath, trimEnd } from '../lib/edge-path'

interface Props {
  onOpenNote: (id: number) => void
  onCreateNoteFromDangling: (title: string) => Promise<void>
  onNotice: (message: string) => void
}

type Scope = 'all' | 'n1' | 'n2'

/** 文件夹色板与根目录专属色，逐值取自 graph_page._FOLDER_PALETTE / _ROOT_NOTE_COLOR。 */
const FOLDER_PALETTE = [
  '#0D9488', '#2563EB', '#7C3AED', '#DB2777', '#EA580C', '#16A34A',
  '#D97706', '#0891B2', '#4F46E5', '#65A30D', '#B45309', '#0EA5E9',
]
const ROOT_NOTE_COLOR = '#64748B'
const KIND_COLOR: Record<string, string> = {
  folder: '#7C3AED',
  task: '#16A34A',
  flash: '#EA580C',
  dangling: '#94A3B8',
}

interface SimNode extends SimulationNodeDatum, GraphNodePayload {}
interface SimLink extends SimulationLinkDatum<SimNode> {
  src: number
  dst: number
  kind: 'ownership' | 'reference'
}

/**
 * 节点统一外接半径 —— 不再随度数变化。
 * 原来 `5 + size * 4.5` 让同一个「笔记」在不同连接数下半径差出一倍，图上一眼就看出参差。
 * 度数改由标签字号与选中环表达，形状大小保持一致。
 */
const NODE_R = 9
const radiusOf = (): number => NODE_R

/** 笔记：文档形（右上角折起），比纯方块更贴「一篇笔记」的语义。 */
function notePath(r: number): string {
  const f = r * 0.42
  return `M${-r},${-r} L${r - f},${-r} L${r},${-r + f} L${r},${r} L${-r},${r} Z`
}

function starPoints(r: number): string {
  const pts: string[] = []
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45
    const a = (Math.PI / 5) * i - Math.PI / 2
    pts.push(`${(Math.cos(a) * rad).toFixed(2)},${(Math.sin(a) * rad).toFixed(2)}`)
  }
  return pts.join(' ')
}

function boltPoints(r: number): string {
  return [
    `${(-r * 0.35).toFixed(2)},${(-r).toFixed(2)}`,
    `${(r * 0.55).toFixed(2)},${(-r * 0.15).toFixed(2)}`,
    `${(r * 0.1).toFixed(2)},${(-r * 0.15).toFixed(2)}`,
    `${(r * 0.4).toFixed(2)},${r.toFixed(2)}`,
    `${(-r * 0.5).toFixed(2)},${(r * 0.1).toFixed(2)}`,
    `${(-r * 0.1).toFixed(2)},${(r * 0.1).toFixed(2)}`,
  ].join(' ')
}

/** 图谱页：力导向布局 + 按 kind 区分的节点形状 + 归属实线/引用虚线。 */
/**
 * 节点坐标缓存（O5）：按节点 id 记住上次位置。
 * 放在模块级而不是组件内，是为了「离开图谱页再回来」也能复用——
 * 否则每次重进都从随机位置重跑布局，同一份数据的位置会变。
 */
const POS_CACHE = new Map<number, { x: number; y: number }>()

export function GraphPage({ onOpenNote, onCreateNoteFromDangling, onNotice }: Props) {
  const [data, setData] = useState<GraphPayload | null>(null)
  const [scope, setScope] = useState<Scope>('all')
  const [includeTasks, setIncludeTasks] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  /** 连线起点：点「从此节点连线」后进入连线模式，再点另一个节点建立关系 */
  const [linkFrom, setLinkFrom] = useState<number | null>(null)
  /** 任务↔笔记两种关系皆可：归属（实线）或引用（虚线） */
  const [linkMode, setLinkMode] = useState<'ownership' | 'reference'>('ownership')
  /** 鼠标悬停的边（按下标标识）：只在悬停时才亮出端点手柄与删除按钮 */
  const [edgeHover, setEdgeHover] = useState<number | null>(null)
  /** 鼠标悬浮的节点：与它直接相连的线与节点高亮，其余淡化到几乎隐形（对齐 Obsidian） */
  const [hoverNode, setHoverNode] = useState<number | null>(null)
  /** 正在改挂端点：记录边下标、被拖的那一端，以及指针当前的世界坐标 */
  const [edgeDrag, setEdgeDrag] = useState<{
    index: number
    end: 'src' | 'dst'
    x: number
    y: number
  } | null>(null)
  const [tick, setTick] = useState(0)
  const width = 900
  const height = 560
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null)
  const dragRef = useRef<number | null>(null)
  // 坐标缓存见模块级 POS_CACHE（离开页面再回来也要能复用）

  const load = useCallback(async () => {
    setData(await window.zhixing.db.graph(includeTasks))
  }, [includeTasks])

  useEffect(() => {
    void load()
  }, [load])

  // 任务/笔记写作后图谱数据会变，按域订阅比整页重查省事（O3）
  useEffect(() => subscribeDomain(['note', 'task'], () => void load()), [load])

  /** 邻域过滤：以选中节点为起点做 BFS，保留 1/2 度子图（对齐 scope_combo 语义）。 */
  const view = useMemo(() => {
    if (!data) return null
    if (scope === 'all' || selected == null) return data
    const adj = new Map<number, Set<number>>()
    for (const [a, b] of data.edges) {
      if (!adj.has(a)) adj.set(a, new Set())
      if (!adj.has(b)) adj.set(b, new Set())
      adj.get(a)!.add(b)
      adj.get(b)!.add(a)
    }
    const depth = scope === 'n1' ? 1 : 2
    const keep = new Set<number>([selected])
    let frontier = [selected]
    for (let d = 0; d < depth; d++) {
      const next: number[] = []
      for (const id of frontier) {
        for (const nb of adj.get(id) ?? []) {
          if (!keep.has(nb)) {
            keep.add(nb)
            next.push(nb)
          }
        }
      }
      frontier = next
    }
    return {
      nodes: data.nodes.filter((n) => keep.has(n.id)),
      edges: data.edges.filter(([a, b]) => keep.has(a) && keep.has(b)),
      edgeKinds: data.edgeKinds,
    }
  }, [data, scope, selected])

  // 布局：节点集合变化时重建模拟
  useEffect(() => {
    if (!view || view.nodes.length === 0) return
    const cache = POS_CACHE
    // 已有坐标的节点直接套用；新节点落在旧布局质心附近（而不是从螺旋分布起步），
    // 否则新节点一进来就会把整个布局推开，老节点被迫搬家。
    const hitNodes = view.nodes.filter((n) => cache.has(n.id))
    const hitRatio = view.nodes.length ? hitNodes.length / view.nodes.length : 0
    const centroid = hitNodes.length
      ? {
          x: hitNodes.reduce((s, n) => s + cache.get(n.id)!.x, 0) / hitNodes.length,
          y: hitNodes.reduce((s, n) => s + cache.get(n.id)!.y, 0) / hitNodes.length,
        }
      : { x: width / 2, y: height / 2 }

    let fresh = 0
    const simNodes: SimNode[] = view.nodes.map((n) => {
      const hit = cache.get(n.id)
      if (hit) return { ...n, x: hit.x, y: hit.y }
      // 黄金角散布，确定性且均匀；半径很小，只为避免完全重叠
      const a = fresh * 2.399963
      fresh += 1
      return { ...n, x: centroid.x + Math.cos(a) * 24, y: centroid.y + Math.sin(a) * 24 }
    })
    const known = new Set(simNodes.map((n) => n.id))
    const simLinks: SimLink[] = view.edges
      .filter(([a, b]) => known.has(a) && known.has(b))
      .map(([a, b]) => ({
        source: a,
        target: b,
        src: a,
        dst: b,
        kind: view.edgeKinds[`${a},${b}`] ?? 'ownership',
      }))

    // 复用比例越高，越只做微调。注意 alphaDecay 默认 0.0228：alpha=0.25 也要跑
    // 两百多步才停，节点照样会被一点点推走，所以微调场景必须同时加快收敛与摩擦。
    // 阈值按「保住老节点」的实际意图定：只要多数节点是复用的就微调。
    // 定成 0.6 会把 20/34 这种情况判成新图，导致老节点被重新布局。
    const tuning = hitRatio > 0.3
    const sim = forceSimulation<SimNode>(simNodes)
      .alpha(tuning ? 0.25 : hitRatio > 0.1 ? 0.45 : 1)
      // 收敛更慢、阻尼更大 —— 这是 Obsidian 那种「橡皮筋落定」手感的来源：
      // 边缘不是一步到位，而是带着余量滑进去，全程不抖
      .alphaDecay(tuning ? 0.06 : 0.018)
      .velocityDecay(tuning ? 0.62 : 0.55)
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(100)
          // 略高的连 strength：连线更像有张力的橡皮筋，而不是松垮的绳
          .strength(0.12)
      )
      // distanceMax 限制力的作用半径：远节点不再互相推挤，整体更稳
      .force('charge', forceManyBody().strength(-320).distanceMax(420))
      // 微调场景沿用旧质心：若仍居中到画面中心，整个已有布局会被整体平移
      .force(
        'center',
        forceCenter(tuning && hitNodes.length ? centroid.x : width / 2, tuning && hitNodes.length ? centroid.y : height / 2)
      )
      .force('collide', forceCollide<SimNode>().radius(() => radiusOf() + 8))
      .on('tick', () => {
        // 每 tick 回写坐标，下一次重建模拟即可复用（含用户手动拖动后的位置）
        for (const n of simNodes) {
          if (n.x != null && n.y != null) cache.set(n.id, { x: n.x, y: n.y })
        }
        setTick((t) => t + 1)
      })

    simRef.current = sim
    return () => {
      sim.stop()
      simRef.current = null
    }
  }, [view])

  const nodes = (simRef.current?.nodes() ?? []) as SimNode[]
  const links = (simRef.current?.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>> | undefined)?.links() as SimLink[] | undefined

  const folderColor = useMemo(() => {
    const cache = new Map<string, string>()
    return (hint: string): string => {
      if (hint === 'root') return ROOT_NOTE_COLOR
      if (KIND_COLOR[hint]) return KIND_COLOR[hint]
      if (!cache.has(hint)) cache.set(hint, FOLDER_PALETTE[cache.size % FOLDER_PALETTE.length])
      return cache.get(hint)!
    }
  }, [])

  const colorOf = (n: GraphNodePayload): string =>
    n.kind === 'note' ? folderColor(n.colorHint) : (KIND_COLOR[n.kind] ?? ROOT_NOTE_COLOR)

  const selectedNode = nodes.find((n) => n.id === selected) ?? null

  /**
   * 连线写入（对齐 dialog 拖拽建链的裁决口径）：
   * 先按允许矩阵判断，任务↔笔记再用 ownership/reference 决定写哪张表。
   */
  const tryLink = useCallback(
    async (dst: GraphNodePayload): Promise<void> => {
      if (linkFrom == null) return
      const src = nodes.find((n) => n.id === linkFrom)
      setLinkFrom(null)
      if (!src) return
      const kind = await window.zhixing.db.graphConnectionAllowed(src.kind, dst.kind)
      if (!kind) {
        onNotice(`不允许连接 ${src.kind} → ${dst.kind}`)
        return
      }
      const mode = kind === 'either' ? linkMode : (kind as 'ownership' | 'reference')
      try {
        if (src.kind === 'note' && dst.kind === 'note') {
          const ok = await window.zhixing.db.linkNotes(src.refId, dst.refId)
          onNotice(ok ? '已建立笔记引用' : '未能建立（可能已存在）')
        } else if (src.kind === 'task' && dst.kind === 'note') {
          if (mode === 'reference') {
            await window.zhixing.db.linkTaskNoteRef(src.refId, dst.refId)
            onNotice('已建立任务引用笔记')
          } else {
            await window.zhixing.db.attachTaskNote(src.refId, dst.refId)
            onNotice('已建立任务归属笔记')
          }
        } else if (src.kind === 'folder' && dst.kind === 'note') {
          await window.zhixing.db.saveNote(dst.refId, { folder_id: src.refId })
          onNotice('已把笔记移入该文件夹')
        } else if (src.kind === 'task' && dst.kind === 'task') {
          await window.zhixing.db.reparentTask(dst.refId, src.refId)
          onNotice('已改挂任务层级')
        } else {
          onNotice('该组合暂不支持')
        }
      } catch (err) {
        onNotice('建立关系失败：' + (err as Error).message)
      }
      await load()
    },
    [linkFrom, linkMode, nodes, onNotice, load]
  )

  /** 边的两端节点。d3 模拟会把 source/target 替换成对象，两种形态都要认。 */
  const edgeEnds = useCallback(
    (l: SimLink): [SimNode | undefined, SimNode | undefined] => [
      typeof l.source === 'object' ? (l.source as SimNode) : nodes.find((n) => n.id === l.src),
      typeof l.target === 'object' ? (l.target as SimNode) : nodes.find((n) => n.id === l.dst)
    ],
    [nodes]
  )

  /**
   * 这条边能否编辑。排除两类：
   * - 文件夹↔文件夹（主进程也不支持建立这种连线）；
   * - 悬空引用（负 id 的虚拟节点）：真要删掉得改正文里的 [[标题]]，不在本次范围。
   */
  const canEditEdge = useCallback((a: SimNode | undefined, b: SimNode | undefined): boolean => {
    if (!a || !b) return false
    if (a.kind === 'folder' && b.kind === 'folder') return false
    return a.refId > 0 && b.refId > 0
  }, [])

  /**
   * 悬浮节点的直接邻居（含自己）。返回 null 表示不做任何淡化。
   *
   * 两种状态下强制不淡化：**连线模式**与**改挂端点**。这两种场景用户都在挑「目标节点」，
   * 把不相连的候选淡到 0.05 会让人根本看不清该点哪里 —— 连不上不是点不准，是看不见。
   */
  const focusSet = useMemo(() => {
    if (linkFrom != null || edgeDrag != null || hoverNode == null) return null
    const set = new Set<number>([hoverNode])
    for (const l of links ?? []) {
      const [a, b] = edgeEnds(l)
      if (!a || !b) continue
      if (a.id === hoverNode) set.add(b.id)
      if (b.id === hoverNode) set.add(a.id)
    }
    return set
  }, [hoverNode, links, edgeEnds, linkFrom, edgeDrag])

  /** 删除一条连线。分派交给主进程 —— 图谱连线的唯一入口，和改挂共用同一套裁决。 */
  const removeEdge = useCallback(
    async (index: number): Promise<void> => {
      const l = (links ?? [])[index]
      if (!l) return
      const [a, b] = edgeEnds(l)
      if (!a || !b || !canEditEdge(a, b)) {
        onNotice('这条连线不支持删除')
        return
      }
      const ok = await window.zhixing.db.removeGraphEdge(
        a.kind,
        a.refId,
        b.kind,
        b.refId,
        (l.kind ?? 'ownership') as 'ownership' | 'reference'
      )
      onNotice(ok ? '已删除该连线' : '删除失败：该连线可能已被移除')
      setEdgeHover(null)
      await load()
    },
    [links, edgeEnds, canEditEdge, onNotice, load]
  )

  /**
   * 端点改挂的落点判定。
   * 拖拽期间指针被画布捕获，节点的 hover 事件不会触发，所以用 elementFromPoint 反查。
   */
  const dropEdgeAt = useCallback(
    async (clientX: number, clientY: number): Promise<void> => {
      const drag = edgeDrag
      setEdgeDrag(null)
      if (!drag) return
      const l = (links ?? [])[drag.index]
      if (!l) return
      const [a, b] = edgeEnds(l)
      if (!a || !b || !canEditEdge(a, b)) return
      const keep = drag.end === 'src' ? b : a
      const from = drag.end === 'src' ? a : b
      const hit = document.elementFromPoint(clientX, clientY)?.closest('[data-node-id]')
      const target = hit
        ? nodes.find((n) => n.id === Number(hit.getAttribute('data-node-id')))
        : undefined
      if (!target || target.id === keep.id) return // 落在空白或落回原端：取消
      const ok = await window.zhixing.db.rewireGraphEdge({
        keepKind: keep.kind,
        keepRef: keep.refId,
        fromKind: from.kind,
        fromRef: from.refId,
        toKind: target.kind,
        toRef: target.refId,
        edgeKind: (l.kind ?? 'ownership') as 'ownership' | 'reference'
      })
      onNotice(ok ? `已把连线改挂到「${target.label}」` : '改挂失败：该组合不允许连接')
      await load()
    },
    [edgeDrag, links, edgeEnds, canEditEdge, nodes, onNotice, load]
  )

  const onNodePointerDown = (n: SimNode) => (e: React.PointerEvent<SVGGElement>) => {
    dragRef.current = n.id
    try {
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
    } catch {
      // 指针已失效（合成事件 / 快速交互）时忽略。
      // 关键：捕获失败**不能挡住下面的 setSelected** —— 否则节点点不中、连线模式进不去。
    }
    setSelected(n.id)
  }

  const onSvgPointerMove = (
    _e: React.PointerEvent<SVGSVGElement>,
    world: { x: number; y: number } | null
  ): void => {
    // 正在改挂端点：跟随指针画那条虚线，此时不拖动节点
    if (edgeDrag) {
      if (world) setEdgeDrag((d) => (d ? { ...d, x: world.x, y: world.y } : d))
      return
    }
    const id = dragRef.current
    if (id == null || !simRef.current || !world) return
    const node = (simRef.current.nodes() as SimNode[]).find((n) => n.id === id)
    if (!node) return
    // 必须用画布世界坐标：画布缩放后同样的像素位移对应的世界位移不同，
    // 直接拿 clientX 会让节点跟不上鼠标
    node.fx = world.x
    node.fy = world.y
    simRef.current.alpha(0.4).restart()
  }

  const endDrag = (e?: { type?: string; clientX?: number; clientY?: number }): void => {
    if (edgeDrag) {
      // 移出画布算取消；在画布内抬手才做落点判定
      if (e?.type === 'pointerleave' || e?.clientX == null || e?.clientY == null) setEdgeDrag(null)
      else void dropEdgeAt(e.clientX, e.clientY)
      return
    }
    const id = dragRef.current
    dragRef.current = null
    if (id == null || !simRef.current) return
    const node = (simRef.current.nodes() as SimNode[]).find((n) => n.id === id)
    if (node) {
      node.fx = null
      node.fy = null
    }
  }

  // 画布级平移 / 缩放：拖背景平移、滚轮以光标为中心缩放。
  // 节点拖拽继续走原来的 onSvgPointerMove / endDrag，由 hook 在非平移时转发。
  const pan = usePanZoom({ baseW: width, baseH: height, onMove: onSvgPointerMove, onEnd: endDrag })

  const handleDouble = async (n: GraphNodePayload): Promise<void> => {
    if (n.kind === 'note') onOpenNote(n.refId)
    else if (n.kind === 'dangling') {
      await onCreateNoteFromDangling(n.label)
      await load()
    } else onNotice(`${n.kind} 节点：${n.label}`)
  }

  return (
    <div className="page page--graph">
      <div className="page__head">
        <h1 className="page__title">{t('page.graph')}</h1>
        <p className="page__subtitle">{t('page.graph.sub')}</p>
      </div>
      <div className="page__body">
      <div className="tasks-toolbar">
        <div className="seg" role="group" aria-label="范围">
          {(['all', 'n1', 'n2'] as Scope[]).map((s) => (
            <button key={s} aria-pressed={scope === s} onClick={() => setScope(s)}>
              {s === 'all' ? '全部' : s === 'n1' ? '1 度邻域' : '2 度邻域'}
            </button>
          ))}
        </div>
        <span className="u-aux">{nodes.length} 节点 · {(links ?? []).length} 边</span>
        <div className="tasks-toolbar__right">
          <button className="text-btn" aria-pressed={includeTasks} onClick={() => setIncludeTasks((v) => !v)}>
            任务节点
          </button>
          <button
            className="text-btn"
            onClick={() => {
              simRef.current?.alpha(1).restart()
              setTick((t) => t + 1)
            }}
          >
            <RefreshCw size={13} /> 重新布局
          </button>
          <button className="text-btn" onClick={pan.reset}>
            <Maximize2 size={13} /> 重置视图
          </button>
        </div>
      </div>

      <div className="graph-wrap">
        <svg
          ref={pan.svgRef}
          className="graph"
          viewBox={pan.viewBox}
          role="img"
          aria-label="知识图谱"
          style={{ cursor: pan.panning ? 'grabbing' : 'grab' }}
          onPointerDown={pan.handlers.onPointerDown}
          onPointerMove={pan.handlers.onPointerMove}
          onPointerUp={pan.handlers.onPointerUp}
          onPointerLeave={pan.handlers.onPointerLeave}
        >
          {/* 箭头：两条连线用不同 marker —— marker 是独立元素，不会跟着线的 class 变色 */}
          <defs>
            <marker
              id="edge-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L8,4 L0,8 Z" className="edge-arrow" />
            </marker>
            <marker
              id="edge-arrow-on"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L8,4 L0,8 Z" className="edge-arrow edge-arrow--on" />
            </marker>
          </defs>
          <g className={'graph__edges' + (focusSet ? ' is-focused' : '')}>
            {(links ?? []).map((l, i) => {
              const [a, b] = edgeEnds(l)
              if (!a || !b) return null
              // 端点要收回节点外缘：线是从节点中心连出去的，不收边箭头会被节点图形盖住
              const d = edgePath(
                trimEnd(
                  { x1: a.x ?? 0, y1: a.y ?? 0, x2: b.x ?? 0, y2: b.y ?? 0 },
                  radiusOf() + 5
                )
              )
              const related = hoverNode != null && (a.id === hoverNode || b.id === hoverNode)
              const dim = focusSet != null && !related
              return (
                <g key={`${l.src}-${l.dst}-${i}`} className={dim ? 'is-dimmed' : undefined}>
                  <path
                    d={d}
                    markerEnd={related ? 'url(#edge-arrow-on)' : 'url(#edge-arrow)'}
                    className={
                      'graph__edge' +
                      (l.kind === 'reference' ? ' graph__edge--ref' : '') +
                      (related ? ' graph__edge--on' : '')
                    }
                  />
                  {/* 曲线只有 1.2px 根本点不到，沿同一条路径铺透明粗线做热区 */}
                  {canEditEdge(a, b) && (
                    <path
                      d={d}
                      className="graph__edge-hit"
                      onPointerEnter={() => setEdgeHover(i)}
                      onPointerLeave={() => setEdgeHover((h) => (h === i ? null : h))}
                      onPointerDown={(e) => e.stopPropagation()}
                    />
                  )}
                </g>
              )
            })}
          </g>
          <g className="graph__nodes">
            {nodes.map((n) => {
              const r = radiusOf()
              const color = colorOf(n)
              const isSel = selected === n.id
              return (
                <g
                  key={n.id}
                  data-node-id={n.id}
                  transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
                  className={
                    'gnode' +
                    (n.id === hoverNode ? ' gnode--on' : '') +
                    (focusSet && !focusSet.has(n.id) ? ' is-dimmed' : '')
                  }
                  onPointerEnter={() => {
                    // 拖动中不更新悬浮态：指针会一路划过其它节点，画面会乱闪
                    if (dragRef.current == null) setHoverNode(n.id)
                  }}
                  onPointerLeave={() => setHoverNode((h) => (h === n.id ? null : h))}
                  onPointerDown={onNodePointerDown(n)}
                  onDoubleClick={() => void handleDouble(n)}
                  onClick={() => {
                    if (linkFrom != null) void tryLink(n)
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`${n.kind} ${n.label}`}
                >
                  {n.kind === 'task' ? (
                    <polygon points={starPoints(r)} fill={color} />
                  ) : n.kind === 'flash' ? (
                    <polygon points={boltPoints(r)} fill={color} />
                  ) : n.kind === 'dangling' ? (
                    <circle r={r} fill="none" stroke={color} strokeWidth={1.4} strokeDasharray="3 3" />
                  ) : n.kind === 'folder' ? (
                    <>
                      <rect x={-r} y={-r * 0.75} width={r * 2} height={r * 1.5} rx={2} fill={color} />
                      <rect x={-r} y={-r * 1.05} width={r * 0.9} height={r * 0.34} rx={1.5} fill={color} />
                    </>
                  ) : (
                    <path d={notePath(r)} fill={color} />
                  )}
                  {isSel && <circle r={r + 4} fill="none" stroke="var(--accent)" strokeWidth={2} />}
                  <text y={r + 12} textAnchor="middle" className="gnode__label">
                    {n.label.length > 12 ? n.label.slice(0, 12) + '…' : n.label}
                  </text>
                </g>
              )
            })}
          </g>

          {/* 端点手柄与删除按钮画在节点层之上 —— 手柄就在端点上，放节点下面会被节点自身盖住 */}
          {(links ?? []).map((l, i) => {
            if (edgeHover !== i) return null
            const [a, b] = edgeEnds(l)
            if (!a || !b || !canEditEdge(a, b)) return null
            const x1 = a.x ?? 0
            const y1 = a.y ?? 0
            const x2 = b.x ?? 0
            const y2 = b.y ?? 0
            // 删除按钮要压在**曲线上**：用两端中点会偏出去
            const mid = edgeMidpoint({ x1, y1, x2, y2 })
            const mx = mid.x
            const my = mid.y
            // 手柄必须抬到节点外缘：放在节点中心会和节点重合，点下去命中的是节点、
            // 触发的是节点拖拽，端点根本拖不动
            const off = radiusOf() + 7
            const len = Math.hypot(x2 - x1, y2 - y1) || 1
            const ux = (x2 - x1) / len
            const uy = (y2 - y1) / len
            const hx1 = x1 + ux * off
            const hy1 = y1 + uy * off
            const hx2 = x2 - ux * off
            const hy2 = y2 - uy * off
            return (
              <g key={`tools-${i}`}>
                <circle
                  className="edge-handle"
                  cx={hx1}
                  cy={hy1}
                  r={5}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    setEdgeDrag({ index: i, end: 'src', x: hx1, y: hy1 })
                  }}
                />
                <circle
                  className="edge-handle"
                  cx={hx2}
                  cy={hy2}
                  r={5}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    setEdgeDrag({ index: i, end: 'dst', x: hx2, y: hy2 })
                  }}
                />
                <g
                  className="edge-del"
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    void removeEdge(i)
                  }}
                >
                  <circle cx={mx} cy={my} r={8} />
                  <path
                    d={`M${mx - 3.5} ${my - 3.5} L${mx + 3.5} ${my + 3.5} M${mx + 3.5} ${my - 3.5} L${mx - 3.5} ${my + 3.5}`}
                  />
                </g>
              </g>
            )
          })}
          {edgeDrag &&
            (() => {
              const l = (links ?? [])[edgeDrag.index]
              const [a, b] = l ? edgeEnds(l) : [undefined, undefined]
              const keep = edgeDrag.end === 'src' ? b : a
              if (!keep) return null
              return (
                <line
                  className="graph__edge-drag"
                  x1={keep.x ?? 0}
                  y1={keep.y ?? 0}
                  x2={edgeDrag.x}
                  y2={edgeDrag.y}
                />
              )
            })()}
        </svg>

        <aside className="graph-side" aria-label="节点信息">
          {selectedNode ? (
            <>
              <h2 className="graph-side__title">{selectedNode.label}</h2>
              <dl className="kv">
                <dt>类型</dt>
                <dd>{selectedNode.kind}</dd>
                <dt>连接数</dt>
                <dd>{selectedNode.degree}</dd>
                {selectedNode.format && (
                  <>
                    <dt>格式</dt>
                    <dd>{selectedNode.format}</dd>
                  </>
                )}
              </dl>
              <div className="graph-side__link">
                {linkFrom == null ? (
                  <button className="text-btn text-btn--accent" onClick={() => setLinkFrom(selectedNode.id)}>
                    <Link2 size={13} /> 从此节点连线
                  </button>
                ) : linkFrom === selectedNode.id ? (
                  <button className="text-btn" onClick={() => setLinkFrom(null)}>
                    取消连线
                  </button>
                ) : (
                  <button className="text-btn" onClick={() => void tryLink(selectedNode)}>
                    连到这里
                  </button>
                )}
                {linkFrom != null && (
                  <label className="u-aux">
                    任务↔笔记可选用关系：
                    <select
                      className="field field--compact"
                      value={linkMode}
                      onChange={(e) => setLinkMode(e.target.value as 'ownership' | 'reference')}
                      aria-label="关系类型"
                    >
                      <option value="ownership">归属（实线）</option>
                      <option value="reference">引用（虚线）</option>
                    </select>
                  </label>
                )}
              </div>
              {selectedNode.kind === 'note' && (
                <button className="text-btn text-btn--accent" onClick={() => onOpenNote(selectedNode.refId)}>
                  打开笔记
                </button>
              )}
              {selectedNode.kind === 'dangling' && (
                <button
                  className="text-btn text-btn--accent"
                  onClick={() => void handleDouble(selectedNode)}
                >
                  创建这篇笔记
                </button>
              )}
            </>
          ) : (
            <p className="u-aux">点击节点查看信息；双击笔记打开，双击待建链接创建。</p>
          )}
        </aside>
      </div>
      <span hidden>{tick}</span>
      </div>
    </div>
  )
}
