import { subscribeDomain } from '@shared/events'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link2 } from '@renderer/lib/icons'


import { Maximize2, RefreshCw } from '@renderer/lib/icons'
import type { GraphDelta, GraphNodePayload, GraphPayload, NoteFolder } from '@shared/types'
import { Toolbar } from '../components/Toolbar'
import { GraphCanvasG6, type GraphCanvasHandle } from '../components/GraphCanvasG6'
// 配色只有一处来源（lib/graph-colors）：页面与 G6 画布必须用同一套规则，
// 否则会出现「侧栏是一种颜色、画布上是另一种」这种很难查的错位。
import { KIND_CN, colorOf } from '../lib/graph-colors'

interface Props {
  onOpenNote: (id: number) => void
  onCreateNoteFromDangling: (title: string) => Promise<void>
  onNotice: (message: string) => void
}

type Scope = 'all' | 'n1' | 'n2'

/** 图谱节点。曾是 d3 的 `SimulationNodeDatum`，d3 移除后就只剩业务字段。 */
type SimNode = GraphNodePayload
/** 图谱边。同理，原来继承 `SimulationLinkDatum`（那个基类提供 source/target 的对象/序号双形态）。 */
interface SimLink {
  src: number
  dst: number
  kind: 'ownership' | 'reference'
}


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
  /** 任务↔笔记两种关系皆可：归属（实线）或引用（虚线） */
  const [linkMode, setLinkMode] = useState<'ownership' | 'reference'>('ownership')
  /** 鼠标悬浮的节点：与它直接相连的线与节点高亮，其余淡化到几乎隐形 */
  const [hoverNode, setHoverNode] = useState<number | null>(null)

  // 拉连线要用世界坐标（画布可能被缩放/平移）。startLinkDrag 定义在 usePanZoom 之前，
  // 用这个 ref 桥接。
  const searchRef = useRef<HTMLInputElement>(null)
  /** 上一次提示过的循环归属边集合 */
  const lastCycleWarn = useRef('')
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

  /**
   * **切到邻域但还没选中心节点时，自动挑一个。**
   *
   * 邻域视图的语义是「以**选中的节点**为中心、只留 N 跳以内的关联」——
   * 没选中心时 `base` 会退回全图（见上面的 useMemo），于是整块切换看起来**毫无反应**
   * （用户反馈「切换不起作用」）。这里自动选中**度数最高**的那个节点当中心：
   * 它通常是整张图里最值得看的一处，切过去立刻能看到邻域收窄的效果。
   * 已经有选中节点时不介入 —— 用户手动选的永远优先。
   */
  useEffect(() => {
    if (scope === 'all' || selected != null || !data?.nodes.length) return
    const hub = [...data.nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0))[0]
    if (hub) setSelected(hub.id)
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

  const g6Ref = useRef<GraphCanvasHandle>(null)

  /**
   * 节点从 **`base`** 派生（不是 `data`）—— `base` 才是「当前该看什么」：
   * `scope=all` 时是全图，切到 1/2 度邻域时是主进程算出来的子图。
   *
   * ⚠️ 这里原先接的是 `data`，于是**邻域切换只影响搜索与侧栏、画布照旧画全图** ——
   * 表现就是「点了 1 度邻域毫无反应」（用户反馈）。画布、计数、侧栏都该跟着 `base` 走。
   */
  const nodes = (base?.nodes ?? []) as SimNode[]
  // 边同样从 base 派生（原先是问 d3 模拟要 —— 换成 G6 后布局归 G6，边不再由模拟持有）
  const links: SimLink[] = (base?.edges ?? []).map(([a, b]) => ({
    src: a,
    dst: b,
    kind: (base?.edgeKinds[a + ',' + b] ?? 'ownership') as 'ownership' | 'reference',
  }))

  const selectedNode = nodes.find((n) => n.id === selected) ?? null

  /**
   * 连线写入：
   * 先按允许矩阵判断，任务↔笔记再用 ownership/reference 决定写哪张表。
   */
  const linkBetween = useCallback(
    async (src: GraphNodePayload, dst: GraphNodePayload): Promise<void> => {
      // 允许矩阵在主进程：画布与页面都不自行判断「能不能连」
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
            await window.zhixing.db.linkTaskNote(src.refId, dst.refId)
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
    [linkMode, onNotice, load]
  )

  /** 点选式连线：先选了起点（侧栏「从此节点连线」），再点终点。 */
  const tryLink = useCallback(
    async (dst: GraphNodePayload): Promise<void> => {
      if (linkFrom == null) return
      const src = nodes.find((n) => n.id === linkFrom)
      setLinkFrom(null)
      if (!src) return
      await linkBetween(src, dst)
    },
    [linkFrom, nodes, linkBetween]
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
   * 按两端 id 删除连线 —— G6 画布走这条路。
   *
   * 与 `removeEdge`（按下标，旧 SVG 路径）**共用同一套判定与同一个 IPC**：
   * `canEditEdge` 排掉段落锚、文件夹↔文件夹与悬空引用，`removeGraphEdge` 是唯一的落库入口。
   * 两份实现会让「这条边能不能删」出现两种答案。
   */
  /**
   * 改挂端点：右键边选「改挂起点 / 改挂终点」后进入，再点一个节点作为新端点。
   *
   * 旧实现是「悬停边 → 冒出端点手柄 → 拖到新节点」。G6 的 HTML 节点没有端口，
   * 拖拽式无从挂起，所以换成**两段式点选** —— 与点选式连线同一套交互语言。
   *
   * `keep` 是不动的那一端，`from` 是要换掉的那一端；`rewireGraphEdge` 会**先建新边再删旧边**，
   * 所以中途失败不会两头都丢。
   */
  const [rewire, setRewire] = useState<{
    keep: number
    from: number
    kind: 'ownership' | 'reference'
  } | null>(null)

  /**
   * 改挂的**核心逻辑**：`keep` 那一端不动，把 `from` 换成 `to`。
   *
   * 抽出来是因为有**两条触发路径**：右键菜单的「两段式」（先选端、再点节点）
   * 与拖拽（按住端点拖到目标节点松手）—— 后者在松手时目标已经确定，不需要再点一次。
   */
  const doRewire = useCallback(
    async (keepId: number, fromId: number, kind: 'ownership' | 'reference', toId: number): Promise<void> => {
      const keep = nodes.find((n) => n.id === keepId)
      const from = nodes.find((n) => n.id === fromId)
      const dst = nodes.find((n) => n.id === toId)
      if (!keep || !from || !dst) return
      if (!canEditEdge(keep, from)) {
        onNotice('这条连线不支持改挂')
        return
      }
      if (!canEditEdge(keep, dst)) {
        onNotice('不能改挂到这个节点')
        return
      }
      const ok = await window.zhixing.db.rewireGraphEdge({
        keepKind: keep.kind,
        keepRef: keep.refId,
        fromKind: from.kind,
        fromRef: from.refId,
        toKind: dst.kind,
        toRef: dst.refId,
        edgeKind: kind,
      })
      onNotice(ok ? '已改挂该连线' : '改挂失败：该组合可能不允许')
      await load()
    },
    [nodes, canEditEdge, onNotice, load]
  )

  const rewireEdgeTo = useCallback(
    async (dst: GraphNodePayload): Promise<void> => {
      const r = rewire
      setRewire(null)
      if (!r) return
      await doRewire(r.keep, r.from, r.kind, dst.id)
    },
    [rewire, doRewire]
  )

  const removeEdgeBetween = useCallback(
    async (sourceId: number, targetId: number, kind: 'ownership' | 'reference'): Promise<void> => {
      const a = nodes.find((n) => n.id === sourceId)
      const b = nodes.find((n) => n.id === targetId)
      if (!a || !b || !canEditEdge(a, b)) {
        onNotice('这条连线不支持删除')
        return
      }
      const ok = await window.zhixing.db.removeGraphEdge(a.kind, a.refId, b.kind, b.refId, kind)
      onNotice(ok ? '已删除该连线' : '删除失败：该连线可能已被移除')
      await load()
    },
    [nodes, canEditEdge, onNotice, load]
  )


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
        title={'图谱'}
        subtitle={'笔记与任务的关联'}
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
            onClick={() => g6Ref.current?.relayout()}
          >
            <RefreshCw size={13} /> 重新布局
          </button>,
          <button
            key="reset"
            className="text-btn"
            onClick={() => g6Ref.current?.resetView()}
          >
            <Maximize2 size={13} /> 重置视图
          </button>,
        ]}
      />

      <div className="graph-wrap">
        {data && (
          <GraphCanvasG6
            /* 画布也接 base：邻域视图下画的就是那张子图 */
            data={base ?? data}
            colorOf={colorOf}
            positions={POS_CACHE}
            selected={selected}
            hover={hoverNode}
            focused={focused}
            searchHits={searchHits}
            linkFrom={linkFrom}
            // 点选式连线：侧栏点了「从此节点连线」之后，再点另一个节点即建立关系。
            // **能不能连由 tryLink 里的 graphConnectionAllowed 判定**（主进程），
            // 画布不参与裁决 —— 它只负责把「点了谁」报上来。
            onSelect={(id) => {
              // 改挂模式：点到的节点作为新的那一端（keep 那一端不参与选择）
              if (rewire != null && id != null && id !== rewire.keep) {
                const dst = data?.nodes.find((n) => n.id === id)
                if (dst) {
                  void rewireEdgeTo(dst)
                  return
                }
              }
              if (linkFrom != null && id != null && id !== linkFrom) {
                const dst = data?.nodes.find((n) => n.id === id)
                if (dst) {
                  void tryLink(dst)
                  return
                }
              }
              setSelected(id)
            }}
            onHover={setHoverNode}
            onFocus={setFocused}
            onOpenNode={(n) => void openNode(n)}
            onPositions={(pos) => {
              for (const [id, p] of pos) POS_CACHE.set(id, p)
            }}
            onConnect={(s, t) => {
              // 拖拽建链：一步到位，直接走 linkBetween（与「点起点 → 点终点」同一条落库路径）
              const a = nodes.find((n) => n.id === s)
              const b = nodes.find((n) => n.id === t)
              if (a && b) void linkBetween(a, b)
            }}
            onEdgeDelete={(s, t, k) => void removeEdgeBetween(s, t, k)}
            onEdgeRewire={(s, t, k, end) => {
              // 换起点时 keep 是终点，换终点时 keep 是起点
              setRewire({ keep: end === 'src' ? t : s, from: end === 'src' ? s : t, kind: k })
              onNotice(end === 'src' ? '点一个节点作为新的起点' : '点一个节点作为新的终点')
            }}
            onEdgeRewireTo={(s, t, k, end, toId) => {
              // 拖拽路径：松手时目标已确定，直接落库（与上面同一条 doRewire）
              void doRewire(end === 'src' ? t : s, end === 'src' ? s : t, k, toId)
            }}
            handleRef={g6Ref}
          />
        )}

        {/* key 挂选中节点：换节点就重挂一次侧栏卡片，让它重播一遍进场动画
            （aside 是常驻的，只换 class 不会重播；这里的内容全是纯展示，重挂无副作用） */}
        <aside className="graph-side" key={selectedNode ? selectedNode.id : 'none'} aria-label="节点信息">
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
      </div>
    </div>
  )
}
