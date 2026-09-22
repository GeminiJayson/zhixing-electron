import { subscribeDomain } from '@shared/events'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link2 } from '@renderer/lib/icons'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import { Maximize2, RefreshCw } from '@renderer/lib/icons'
import type { GraphDelta, GraphNodePayload, GraphPayload, NoteFolder } from '@shared/types'
import { t } from '../i18n'
import { Toolbar } from '../components/Toolbar'
import { GraphNodeIcon } from '../components/GraphNodeIcon'
import { usePanZoom } from '../lib/usePanZoom'
import { edgeMidpoint, edgePath, trimEnd } from '../lib/edge-path'

interface Props {
  onOpenNote: (id: number) => void
  onCreateNoteFromDangling: (title: string) => Promise<void>
  onNotice: (message: string) => void
}

type Scope = 'all' | 'n1' | 'n2'

/** 文件夹色板与根目录专属色。 */
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
  anchor: '#0891B2',
}

/** 六类节点的中文名。 */
const KIND_CN: Record<string, string> = {
  note: '笔记',
  flash: '闪念',
  dangling: '待建链接',
  task: '任务',
  folder: '文件夹',
  anchor: '段落引用',
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

/* 节点形状已迁到 components/GraphNodeIcon.tsx —— 那里按类型给出多色分层图标，
   本文件只负责把 kind / 半径 / 主色传进去。 */

/** 图谱页：力导向布局 + 按 kind 区分的节点形状 + 归属实线/引用虚线。 */
/**
 * 节点坐标缓存：按节点 id 记住上次位置。
 * 放在模块级而不是组件内，是为了「离开图谱页再回来」也能复用——
 * 否则每次重进都从随机位置重跑布局，同一份数据的位置会变。
 */
const POS_CACHE = new Map<number, { x: number; y: number }>()

export function GraphPage({ onOpenNote, onCreateNoteFromDangling, onNotice }: Props) {
  const [data, setData] = useState<GraphPayload | null>(null)
  const [scope, setScope] = useState<Scope>('all')
  /** 默认纳入任务节点 */
  const [includeTasks, setIncludeTasks] = useState(true)
  /** 文件夹 / 标签过滤 */
  const [folderId, setFolderId] = useState<number | null>(null)
  const [tagId, setTagId] = useState<number | null>(null)
  const [folders, setFolders] = useState<NoteFolder[]>([])
  const [tags, setTags] = useState<{ id: number; name: string; color: string }[]>([])
  /** 图内搜索 */
  const [search, setSearch] = useState('')
  /** 邻域子图：scope≠all 且选中节点时由主进程按 note_link 算 */
  const [neighbor, setNeighbor] = useState<GraphPayload | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  /** 键盘焦点落在哪个节点上（Tab 走图时画圆环用，见 gnode 的 onFocus/onBlur） */
  const [focused, setFocused] = useState<number | null>(null)
  const [preview, setPreview] = useState('')
  /** 连线起点：点「从此节点连线」后进入连线模式，再点另一个节点建立关系 */
  const [linkFrom, setLinkFrom] = useState<number | null>(null)
  /**
   * 正在从节点手柄「拉」连线：记源节点与指针的世界坐标，用来画那条跟随的虚线。
   * 与 linkFrom 是同一件事的两个阶段 —— 按下手柄即进入连线态（linkFrom），
   * 松开时按落点判定，所以在节点上直接拖拽也能建链，而不是只能「点按钮再点目标」。
   */
  const [linkDrag, setLinkDrag] = useState<{ from: number; x: number; y: number } | null>(null)
  /** 任务↔笔记两种关系皆可：归属（实线）或引用（虚线） */
  const [linkMode, setLinkMode] = useState<'ownership' | 'reference'>('ownership')
  /** 鼠标悬停的边（按下标标识）：只在悬停时才亮出端点手柄与删除按钮 */
  const [edgeHover, setEdgeHover] = useState<number | null>(null)
  /** 鼠标悬浮的节点：与它直接相连的线与节点高亮，其余淡化到几乎隐形 */
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
  // 拉连线要用世界坐标（画布可能被缩放/平移）。startLinkDrag 定义在 usePanZoom 之前，
  // 用这个 ref 桥接。
  const panRef = useRef<ReturnType<typeof usePanZoom> | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  /** 上一次提示过的循环归属边集合 */
  const lastCycleWarn = useRef('')
  /** 当前动效档位（'' = full）：模拟重建时据此决定是否立即冻结 */
  const motionRef = useRef('')
  const scopeRef = useRef<Scope>(scope)
  scopeRef.current = scope
  // 坐标缓存见模块级 POS_CACHE（离开页面再回来也要能复用）

  const load = useCallback(async () => {
    setData(await window.zhixing.db.graph({ includeTasks, folderId, tagId }))
  }, [includeTasks, folderId, tagId])

  useEffect(() => {
    void load()
  }, [load])

  // 文件夹 / 标签过滤下拉
  useEffect(() => {
    void window.zhixing.db.noteFolders().then(setFolders)
    void window.zhixing.db.tags().then(setTags)
  }, [data])

  // 邻域子图：只在 scope≠all 且有选中节点时按 note_link BFS 现算
  useEffect(() => {
    if (scope === 'all' || selected == null) {
      setNeighbor(null)
      return
    }
    let alive = true
    void window.zhixing.db
      .graphNeighborhood(selected, scope === 'n1' ? 1 : 2)
      .then((g) => {
        if (alive) setNeighbor(g)
      })
    return () => {
      alive = false
    }
  }, [scope, selected, data])

  /** 最近一次收到增量的时刻：域订阅兜底据此避免与增量重复重查。 */
  const lastDeltaAt = useRef(0)

  /**
   * 消费主进程推来的图谱增量——按节点/边定点增删，保留布局（POS_CACHE 持有坐标）。
   * full 或邻域视图下退回整体重查（邻域缓存参数不同，局部合并没有意义）。
   */
  const applyDelta = useCallback(
    (delta: GraphDelta): void => {
      lastDeltaAt.current = Date.now()
      if (delta.full || scopeRef.current !== 'all') {
        void load()
        return
      }
      setData((prev) => {
        if (!prev) return prev
        const goneNodes = new Set(delta.removedNodeIds)
        const goneEdges = new Set(delta.removedEdges.map(([a, b]) => a + ',' + b))
        const fresh = new Map((delta.updatedNodes ?? []).map((n) => [n.id, n]))
        const present = new Set<number>()
        const nodes: GraphNodePayload[] = []
        for (const n of prev.nodes) {
          if (goneNodes.has(n.id)) continue
          nodes.push(fresh.get(n.id) ?? n)
          present.add(n.id)
        }
        for (const n of delta.addedNodes) {
          if (present.has(n.id)) continue
          nodes.push(n)
          present.add(n.id)
        }
        const edges: [number, number][] = prev.edges.filter(
          ([a, b]) => !goneEdges.has(a + ',' + b) && present.has(a) && present.has(b)
        )
        const edgeKeys = new Set(edges.map(([a, b]) => a + ',' + b))
        const edgeKinds = { ...prev.edgeKinds }
        for (const [a, b] of delta.addedEdges) {
          const key = a + ',' + b
          if (!present.has(a) || !present.has(b) || edgeKeys.has(key)) continue
          edges.push([a, b])
          edgeKeys.add(key)
          edgeKinds[key] = delta.edgeKinds[key] ?? 'reference'
        }
        for (const key of goneEdges) delete edgeKinds[key]
        return { nodes, edges, edgeKinds, cycleEdges: prev.cycleEdges }
      })
    },
    [load]
  )
  const applyDeltaRef = useRef(applyDelta)
  applyDeltaRef.current = applyDelta

  // 打开图谱页时登记增量推送；笔记/任务/闪念写一次就推一帧 diff。
  useEffect(() => {
    void window.zhixing.db.graphWatch(true)
    // 登记时先打一次时间戳，避免首次写入时域订阅兜底与增量各查一遍
    lastDeltaAt.current = Date.now()
    // 接住取消函数：这个 effect 每次进图谱页都跑，不注销就会叠一层监听 ——
    // 一次 delta 触发 N 次旧闭包回调（含整图重查），并在已卸载的组件上 setData
    const offDelta = window.zhixing.db.onGraphDelta((d) => applyDeltaRef.current(d))
    return () => {
      offDelta()
      void window.zhixing.db.graphWatch(false)
    }
  }, [])

  // 域订阅作兜底（例如没走 graph:delta 的写入路径）：紧邻的增量已覆盖时不再整表重查
  useEffect(
    () =>
      subscribeDomain(['note', 'task', 'flash'], () => {
        if (Date.now() - lastDeltaAt.current < 800) return
        void load()
      }),
    [load]
  )

  // 循环归属断开提示
  useEffect(() => {
    const cycles = data?.cycleEdges ?? []
    if (!cycles.length) return
    const key = cycles
      .map(([a, b]) => a + ',' + b)
      .sort()
      .join('|')
    if (key === lastCycleWarn.current) return
    lastCycleWarn.current = key
    onNotice(`检测到循环归属，已断开 ${cycles.length} 条边`)
  }, [data, onNotice])

  /**
   * 邻域视图：scope=all 用全图；否则用主进程算出的 1/2 度邻域子图。
   * 与旧实现不同——不再在已加载 payload 上做全类型边 BFS，邻域只沿 note_link。
   */
  const base = useMemo((): GraphPayload | null => {
    if (!data) return null
    if (scope === 'all' || selected == null) return data
    return neighbor ?? data
  }, [data, neighbor, scope, selected])

  /** 图内搜索命中集合（空搜索返回 null = 不做淡化） */
  const searchHits = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle || !base) return null
    const hits = base.nodes.filter((n) => (n.label || '').toLowerCase().includes(needle))
    return hits.length ? new Set(hits.map((n) => n.id)) : null
  }, [search, base])

  // 文本变化 → 选中第一个命中；空文本则只清高亮
  const firstHit = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle || !base) return null
    return base.nodes.find((n) => (n.label || '').toLowerCase().includes(needle)) ?? null
  }, [search, base])
  useEffect(() => {
    if (firstHit) setSelected(firstHit.id)
  }, [firstHit])

  // 选中节点按类型取预览文本
  useEffect(() => {
    if (!base || selected == null) {
      setPreview('')
      return
    }
    const node = base.nodes.find((n) => n.id === selected)
    if (!node) {
      setPreview('')
      return
    }
    let alive = true
    void window.zhixing.db.graphPreview(node).then((text) => {
      if (alive) setPreview(text)
    })
    return () => {
      alive = false
    }
  }, [selected, base])

  // Ctrl+F 聚焦图内搜索框
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f') return
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const view = base

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

    // 处于减动效档位时，模拟一经建立就冻结。
    // stop() 之后不会再触发 tick，所以手动推一帧让静态节点渲染出来。
    if (motionRef.current === 'reduced' || motionRef.current === 'none') {
      sim.stop()
      setTick((t) => t + 1)
    }
    simRef.current = sim
    return () => {
      sim.stop()
      simRef.current = null
    }
  }, [view])

  // 动效降级 —— reduced/none 时冻结力导向物理，回到 full 且当前有节点时恢复
  //
  useEffect(() => {
    const apply = (level: string): void => {
      motionRef.current = level
      const sim = simRef.current
      if (!sim) return
      if (level === 'reduced' || level === 'none') sim.stop()
      // 重新升温再跑：力导向收敛后 alpha 已接近 0，单纯 restart() 不会真的动起来
      else if ((sim.nodes() as SimNode[]).length) sim.alpha(0.3).restart()
    }
    const onMotion = (e: Event): void => {
      const level = (e as CustomEvent<{ level?: string }>).detail?.level
      apply(level ?? document.documentElement.dataset.motion ?? '')
    }
    // 挂载时先按当前档位对齐一次：applyMotion 通常在页面挂载前就广播过了，收不到那次事件
    apply(document.documentElement.dataset.motion || 'full')
    window.addEventListener('zhixing:motion', onMotion)
    return () => window.removeEventListener('zhixing:motion', onMotion)
  }, [])

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
   * 连线写入：
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
          const t = await window.zhixing.db.reparentTask(dst.refId, src.refId)
          onNotice(t ? '已改挂任务层级' : '不能挂到自己的子孙下（会形成环）')
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
   * 这条边能否编辑。排除三类：
   * - 文件夹↔文件夹（主进程也不支持建立这种连线）；
   * - 悬空引用（负 id 的虚拟节点）：真要删掉得改正文里的 [[标题]]，不在本次范围；
   * - 段落锚（只读生成边，删边应改任务的段落引用）。
   */
  const canEditEdge = useCallback((a: SimNode | undefined, b: SimNode | undefined): boolean => {
    if (!a || !b) return false
    if (a.kind === 'anchor' || b.kind === 'anchor') return false
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

  /** 搜索淡化集合优先于悬浮淡化：搜索是显式动作，悬浮是临时态。 */
  const dimSet = searchHits

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

  /**
   * 从节点手柄按下：进入连线态并开始拉虚线。
   * 手柄是节点 <g> 的子元素，stopPropagation 能挡在节点拖拽之前 —— 所以「拖节点」与
   * 「拉连线」两种手势不会互相打架。
   */
  const startLinkDrag = (n: SimNode) => (e: React.PointerEvent<SVGGElement>): void => {
    e.stopPropagation()
    try {
      // 由手柄自己接管指针：之后即使指针划出节点，move/up 也仍然回到这里。
      // （先前试过让画布 svg 转发 pointerup，但它并不总能到达 endDrag，虚线会留在画布上。）
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // 捕获失败（合成事件等）不影响连线本身
    }
    setLinkFrom(n.id)
    // 初始位置取节点自身坐标（世界坐标），指针一移动就会被覆盖
    setLinkDrag({ from: n.id, x: n.x ?? 0, y: n.y ?? 0 })
  }

  /** 手柄接管的指针移动：把虚线终点跟到指针（世界坐标）。 */
  const onLinkHandleMove = (e: React.PointerEvent<SVGGElement>): void => {
    if (!linkDrag) return
    const w = panRef.current?.toWorld(e.clientX, e.clientY)
    if (w) setLinkDrag((d) => (d ? { ...d, x: w.x, y: w.y } : d))
  }

  /** 手柄接管的抬手：交给落点判定。 */
  const onLinkHandleUp = (e: React.PointerEvent<SVGGElement>): void => {
    if (!linkDrag) return
    void dropLinkAt(e.clientX, e.clientY)
  }

  /**
   * 拉线的落点判定：与改挂端点同一套反查（拖拽期间指针被画布捕获，hover 不触发）。
   * 落在空白或自己身上就取消，否则交给 tryLink 走既有的允许矩阵与写入分支。
   */
  const dropLinkAt = useCallback(
    async (clientX: number, clientY: number): Promise<void> => {
      const drag = linkDrag
      setLinkDrag(null)
      if (!drag) return
      const hit = document.elementFromPoint(clientX, clientY)?.closest('[data-node-id]')
      const target = hit
        ? nodes.find((n) => n.id === Number(hit.getAttribute('data-node-id')))
        : undefined
      if (!target) {
        // 明确回执：否则用户不知道是「没落到节点上」还是「功能坏了」
        setLinkFrom(null)
        onNotice('已取消连线（没有落在节点上）')
        return
      }
      if (target.id === drag.from) {
        setLinkFrom(null)
        onNotice('已取消连线（不能连到自己）')
        return
      }
      await tryLink(target)
    },
    [linkDrag, nodes, tryLink, onNotice]
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
    // 正在拉新连线：同样只更新虚线终点
    if (linkDrag) {
      if (world) setLinkDrag((d) => (d ? { ...d, x: world.x, y: world.y } : d))
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
    if (linkDrag) {
      // 同上：移出画布算取消
      if (e?.type === 'pointerleave' || e?.clientX == null || e?.clientY == null) {
        setLinkDrag(null)
        setLinkFrom(null)
      } else void dropLinkAt(e.clientX, e.clientY)
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
  panRef.current = pan

  // 图内搜索命中首个节点时镜头飞入。
  // 坐标在力导向模拟里，所以从 sim 取当前落位；centerOn 是稳定引用，避免每次渲染都重跑。
  const firstHitId = firstHit?.id ?? null
  const centerOn = pan.centerOn
  useEffect(() => {
    if (firstHitId == null) return
    const timer = window.setTimeout(() => {
      const node = (simRef.current?.nodes() as SimNode[] | undefined)?.find(
        (n) => n.id === firstHitId
      )
      if (node && node.x != null && node.y != null) centerOn(node.x, node.y)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [firstHitId, centerOn])

  /**
   * 六类节点的打开动作：
   * - note → 打开笔记；
   * - dangling → 按标题新建笔记并绑定悬空引用；
   * - anchor → 打开所属笔记（段落定位键随行，深链消费端补齐前只到笔记粒度）；
   * - task / folder / flash → 经 db:graphOpenNode 走主窗口既有的深链路由切页。
   */
  const openNode = useCallback(
    async (n: GraphNodePayload): Promise<void> => {
      if (n.kind === 'note') onOpenNote(n.refId || n.id)
      else if (n.kind === 'anchor') {
        onNotice(`已打开「${n.label}」所在的笔记（定位键 ${n.blockKey || '—'}）`)
        onOpenNote(n.refId)
      } else if (n.kind === 'dangling') {
        await onCreateNoteFromDangling(n.label)
        await load()
      } else if (n.kind === 'task' || n.kind === 'folder' || n.kind === 'flash') {
        await window.zhixing.db.graphOpenNode(n.kind, n.refId)
      }
    },
    [onOpenNote, onCreateNoteFromDangling, onNotice, load]
  )

  const sidebarAction = (n: GraphNodePayload): string =>
    ({ note: '打开笔记', flash: '跳转闪念', dangling: '新建笔记', task: '打开任务', folder: '定位文件夹', anchor: '定位段落' })[
      n.kind
    ] ?? '打开'

  return (
    <div className="page page--graph">
      <div className="page__body">
      <Toolbar
        title={t('page.graph')}
        subtitle={t('page.graph.sub')}
        nav={(
          <div className="seg" role="group" aria-label="范围">
            {(['all', 'n1', 'n2'] as Scope[]).map((s) => (
              <button key={s} aria-pressed={scope === s} onClick={() => setScope(s)}>
                {s === 'all' ? '全部' : s === 'n1' ? '1 度邻域' : '2 度邻域'}
              </button>
            ))}
          </div>
        )}
        filters={[
          <select
            key="folder"
            className="field field--compact"
            aria-label="按文件夹过滤"
            value={folderId ?? ''}
            onChange={(e) => setFolderId(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">全部文件夹</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>,
          <select
            key="tag"
            className="field field--compact"
            aria-label="按标签过滤"
            value={tagId ?? ''}
            onChange={(e) => setTagId(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">全部标签</option>
            {tags.map((tg) => (
              <option key={tg.id} value={tg.id}>
                {tg.name}
              </option>
            ))}
          </select>,
        ]}
        search={(
          <input
            ref={searchRef}
            className="field field--compact"
            type="search"
            value={search}
            placeholder="搜索节点（Ctrl+F）…"
            aria-label="搜索节点"
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
        meta={(
          <span className="u-aux">
            {nodes.length} 节点 · {(links ?? []).length} 边
          </span>
        )}
        secondary={[
          <button key="tn" className="text-btn" aria-pressed={includeTasks} onClick={() => setIncludeTasks((v) => !v)}>
            任务节点
          </button>,
          <button
            key="relayout"
            className="text-btn"
            onClick={() => {
              simRef.current?.alpha(1).restart()
              setTick((t) => t + 1)
            }}
          >
            <RefreshCw size={13} /> 重新布局
          </button>,
          <button key="reset" className="text-btn" onClick={pan.reset}>
            <Maximize2 size={13} /> 重置视图
          </button>,
        ]}
      />

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
              const isHit = searchHits != null && searchHits.has(n.id)
              return (
                <g
                  key={n.id}
                  data-node-id={n.id}
                  transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
                  className={
                    'gnode' +
                    (n.id === hoverNode ? ' gnode--on' : '') +
                    (dimSet != null && !dimSet.has(n.id) ? ' is-dimmed' : '') +
                    (focusSet && !focusSet.has(n.id) ? ' is-dimmed' : '')
                  }
                  onPointerEnter={() => {
                    // 拖动中不更新悬浮态：指针会一路划过其它节点，画面会乱闪
                    if (dragRef.current == null) setHoverNode(n.id)
                  }}
                  onPointerLeave={() => setHoverNode((h) => (h === n.id ? null : h))}
                  // 焦点自己接管：SVG <g> 的默认 outline 是**包围盒**矩形，
                  // 而包围盒把标签文字也圈了进去（看起来像选中了一整块）。见 graph.css
                  onFocus={() => setFocused(n.id)}
                  onBlur={() => setFocused((f) => (f === n.id ? null : f))}
                  onPointerDown={onNodePointerDown(n)}
                  onDoubleClick={() => void openNode(n)}
                  onClick={() => {
                    if (linkFrom != null) void tryLink(n)
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`${KIND_CN[n.kind] ?? n.kind} ${n.label}`}
                >
                  {/* 节点图标：多色分层（主色 + 派生内层 + 深描边），见 GraphNodeIcon */}
                  <GraphNodeIcon kind={n.kind} r={r} color={color} />
                  {isSel && <circle r={r + 4} fill="none" stroke="var(--accent)" strokeWidth={2} />}
                  {/* 焦点环也只包图标：半径与选中圆一致，虚线以便与「已选中」区分 */}
                  {!isSel && focused === n.id && <circle r={r + 4} className="gnode__focus" />}
                  {isHit && <circle r={r + 7} fill="none" stroke="var(--accent)" strokeWidth={1} strokeDasharray="2 2" />}
                  <text y={r + 12} textAnchor="middle" className="gnode__label">
                    {n.label.length > 12 ? n.label.slice(0, 12) + '…' : n.label}
                  </text>
                  {/* 连接手柄：hover 或选中时出现在节点右侧，从这里按住往外拖就能拉出连线。
                      它是本 <g> 的子元素，pointerdown 里 stopPropagation 挡在节点拖拽之前 ——
                      于是「拖节点」与「拉连线」两种手势各走各的，不打架。 */}
                  {(n.id === hoverNode || isSel) && linkDrag == null && (
                    <g
                      className="gnode__link-handle"
                      onPointerDown={startLinkDrag(n)}
                      onPointerMove={onLinkHandleMove}
                      onPointerUp={onLinkHandleUp}
                      role="button"
                      aria-label={`从「${n.label}」拉出连线`}
                    >
                      <circle cx={r + 11} cy={0} r={6} />
                      <path d={`M${r + 8} 0 h6 M${r + 11} -3 v6`} />
                    </g>
                  )}
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
          {/* 拉新连线的虚线：从源节点跟到指针 */}
          {linkDrag &&
            (() => {
              const from = (simRef.current?.nodes() as SimNode[] | undefined)?.find(
                (n) => n.id === linkDrag.from
              )
              if (!from) return null
              return (
                <line
                  className="graph__edge-drag"
                  x1={from.x ?? 0}
                  y1={from.y ?? 0}
                  x2={linkDrag.x}
                  y2={linkDrag.y}
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
                <dd>{KIND_CN[selectedNode.kind] ?? selectedNode.kind}</dd>
                <dt>连接数</dt>
                <dd>{selectedNode.degree}</dd>
                {selectedNode.format && (
                  <>
                    <dt>格式</dt>
                    <dd>{selectedNode.format}</dd>
                  </>
                )}
              </dl>
              {/* 按类型输出的预览文本（摘要/状态/优先级/截止/父任务/关联笔记/来源） */}
              {preview && (
                <p className="u-aux graph-side__preview" style={{ whiteSpace: 'pre-line' }}>
                  {preview}
                </p>
              )}
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
              {/* 六类节点都有主操作按钮 */}
              <button className="text-btn text-btn--accent" onClick={() => void openNode(selectedNode)}>
                {sidebarAction(selectedNode)}
              </button>
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
