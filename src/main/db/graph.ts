import type {
  GraphDelta,
  GraphNodePayload,
  GraphPayload,
  GraphQuery,
} from '../../shared/types'
import { priorityLabel } from '../../shared/priority'
import { conn } from './connection'
import { attachTaskNote, detachTaskNote } from './tasks'
import { reparentTask } from './task-ops'
import { saveNote } from './notes'

// ---------------------------------------------------------------- 图谱

/** 节点 id 空间（对齐 GraphService 常量，正负分区避免与笔记主键冲突）。 */
export const TASK_ID_OFFSET = 5_000_000
export const FLASH_ID_OFFSET = 1_000_000
export const FOLDER_ID_OFFSET = 2_000_000
/** v0.15 P1-3：段落锚点独立负空间（任务→笔记段落级引用锚，唯一确定性 id）。 */
export const ANCHOR_ID_OFFSET = 3_000_000
export const folderNodeId = (id: number): number => -id - FOLDER_ID_OFFSET
export const anchorNodeId = (contextId: number): number => -contextId - ANCHOR_ID_OFFSET

/**
 * 两类边判定，逐条对齐 graph_service.classify_edge：
 * - 任一端是 anchor（段落锚）→ 引用虚线；
 * - **两端**都在 {note, dangling} 内（但不含 dangling↔dangling）→ 引用虚线；
 * - 其余 → 归属实线。
 * 注意 folder→note 是**归属实线**（容器→内容），不是引用。
 */
export function classifyEdge(aKind: string, bKind: string): 'ownership' | 'reference' {
  if (aKind === 'anchor' || bKind === 'anchor') return 'reference'
  const refSide = new Set(['note', 'dangling'])
  const bothRef = refSide.has(aKind) && refSide.has(bKind)
  const danglingPair = aKind === 'dangling' && bKind === 'dangling'
  return bothRef && !danglingPair ? 'reference' : 'ownership'
}

export const graphNodeId = (kind: string, refId: number): number => {
  if (kind === 'folder') return folderNodeId(refId)
  if (kind === 'flash') return -refId - FLASH_ID_OFFSET
  if (kind === 'task') return refId + TASK_ID_OFFSET
  if (kind === 'anchor') return anchorNodeId(refId)
  return refId
}

/**
 * 归属层级边破环（对齐 _acyclic_ownership_edges）：DFS 三色标记，去掉指向当前访问栈的回边。
 *
 * 归属 DAG 只可能被自引用父子链（folder.parent_id / task.parent_id）破坏；
 * folder→note、task→note 单向，不可能成环，无需进入本函数。
 */
export function acyclicOwnershipEdges(edges: [number, number][]): [number, number][] {
  const adj = new Map<number, number[]>()
  for (const [s, d] of edges) {
    const list = adj.get(s)
    if (list) list.push(d)
    else adj.set(s, [d])
  }
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<number, number>()
  const bad = new Set<string>()
  const dfs = (u: number): void => {
    color.set(u, GRAY)
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE
      if (c === WHITE) dfs(v)
      else if (c === GRAY) bad.add(u + ',' + v)
    }
    color.set(u, BLACK)
  }
  for (const node of [...adj.keys()]) if ((color.get(node) ?? WHITE) === WHITE) dfs(node)
  return edges.filter(([s, d]) => !bad.has(s + ',' + d))
}

/** 把正文压成单行摘要：折叠空白/换行后按字符截断（对齐 _summarize_text）。 */
function summarizeText(text: string | null | undefined, limit: number): string {
  const t = (text ?? '').split(/\s+/).filter(Boolean).join(' ')
  return t.length <= limit ? t : t.slice(0, limit) + '…'
}

/**
 * 闪念无标题字段：取正文**首行**截断作为图谱节点标题。
 * 对齐 _flash_label：首行 trim → 截 40 字 → 空则兜底「闪念」。
 */
export function flashLabel(content: string | null | undefined): string {
  const text = (content ?? '').trim().split('\n')[0].trim()
  return text.slice(0, 40) || '闪念'
}

interface NoteRow {
  id: number
  title: string | null
  folder_id: number | null
  format: string | null
}

/**
 * 构建图谱数据，对齐 GraphService.build → _assemble + _finalize_edges：
 * - 笔记节点（可按 folder_id / tag_id 过滤；onlyIds 用于邻域子图）；
 * - 文件夹层级与包含（归属）、note→note 与悬空引用（引用）；
 * - 闪念为孤立节点（仅全图，邻域子图不含，对齐 only_ids 判断）；
 * - 可选任务节点：task→note 归属 + task→note 引用 + task→task 层级 + 段落锚（G3/G4）。
 * 归属层级边最后统一破环并把被丢弃的边写入 cycleEdges（G2）。
 */
export function buildGraph(query: GraphQuery = {}): GraphPayload {
  const includeTasks = query.includeTasks ?? false
  const folderId = query.folderId ?? null
  const tagId = query.tagId ?? null
  const onlyIds = query.onlyIds ?? null
  const c = conn()

  let notes = c
    .prepare('SELECT id, title, folder_id, format FROM note WHERE deleted_at IS NULL')
    .all() as NoteRow[]
  if (folderId != null) notes = notes.filter((n) => n.folder_id === folderId)
  if (tagId != null) {
    const tagged = new Set(
      (
        c.prepare('SELECT note_id FROM note_tag WHERE tag_id = ?').all(tagId) as {
          note_id: number
        }[]
      ).map((r) => r.note_id)
    )
    notes = notes.filter((n) => tagged.has(n.id))
  }
  // 邻域子图：only_ids 同时限制节点与边。Python 侧只用它限制边、节点仍全量，
  // 会让图页出现一圈无边孤立点；这里按「邻域子图」语义一并裁剪（偏离点见注释）。
  if (onlyIds) {
    const keep = new Set(onlyIds)
    notes = notes.filter((n) => keep.has(n.id))
  }
  const allowed = new Set(notes.map((n) => n.id))

  // 文件夹层级节点仅在全图（未按文件夹/标签/邻域过滤）时展示（对齐 _assemble）
  const folders =
    folderId == null && tagId == null && onlyIds == null
      ? (c.prepare('SELECT id, parent_id, name FROM note_folder').all() as {
          id: number
          parent_id: number | null
          name: string
        }[])
      : []

  const links = c
    .prepare('SELECT src_note_id, dst_note_id, dst_title FROM note_link')
    .all() as { src_note_id: number; dst_note_id: number | null; dst_title: string }[]

  const degree = new Map<number, number>()
  for (const l of links) {
    if (l.dst_note_id != null && allowed.has(l.src_note_id) && allowed.has(l.dst_note_id)) {
      degree.set(l.src_note_id, (degree.get(l.src_note_id) ?? 0) + 1)
      degree.set(l.dst_note_id, (degree.get(l.dst_note_id) ?? 0) + 1)
    }
  }
  const maxDeg = Math.max(1, ...degree.values())

  const nodes: GraphNodePayload[] = []
  const byId = new Map<number, GraphNodePayload>()
  for (const n of notes) {
    const deg = degree.get(n.id) ?? 0
    const node: GraphNodePayload = {
      id: n.id,
      label: n.title || '无标题',
      kind: 'note',
      refId: n.id,
      size: 1 + (deg / maxDeg) * 1.6,
      degree: deg,
      // 根目录笔记（folder_id 为空）用独立色位 'root'，不与 folder 0 混色
      colorHint: n.folder_id == null ? 'root' : String(n.folder_id),
      format: n.format || 'markdown',
    }
    nodes.push(node)
    byId.set(node.id, node)
  }

  const edges: [number, number][] = []
  /** 已显式标注的边类（task→note 引用）：优先于按节点类型推断的默认结果。 */
  const presetKinds: Record<string, 'ownership' | 'reference'> = {}

  // 文件夹节点 + 层级/包含边（归属实线）
  if (folders.length) {
    for (const f of folders) {
      const id = folderNodeId(f.id)
      const node: GraphNodePayload = {
        id,
        label: f.name || '文件夹',
        kind: 'folder',
        size: 0.7,
        degree: 0,
        colorHint: 'folder',
        refId: f.id,
        format: '',
      }
      nodes.push(node)
      byId.set(id, node)
    }
    const folderIds = new Set(folders.map((f) => f.id))
    for (const f of folders) {
      const fid = folderNodeId(f.id)
      if (f.parent_id != null && folderIds.has(f.parent_id)) edges.push([folderNodeId(f.parent_id), fid])
      for (const n of notes) {
        if (n.folder_id === f.id) edges.push([fid, n.id])
      }
    }
  }

  // 引用边：已解析的 note→note，以及悬空引用（负空间节点，id 递减）
  let nextVirtual = -1
  for (const l of links) {
    if (!allowed.has(l.src_note_id)) continue
    if (l.dst_note_id == null) {
      const existing = byId.get(nextVirtual)
      if (!existing || existing.label !== l.dst_title) {
        const node: GraphNodePayload = {
          id: nextVirtual,
          label: l.dst_title,
          kind: 'dangling',
          size: 0.9,
          degree: 0,
          colorHint: 'dangling',
          refId: 0,
          format: '',
        }
        nodes.push(node)
        byId.set(nextVirtual, node)
      }
      edges.push([l.src_note_id, nextVirtual])
      nextVirtual -= 1
    } else if (allowed.has(l.dst_note_id)) {
      edges.push([l.src_note_id, l.dst_note_id])
    }
  }

  // 闪念：独立负空间，只入图不连线（邻域子图不含，对齐 only_ids 判断）
  if (onlyIds == null) {
    const flashes = c
      .prepare('SELECT id, content FROM flash WHERE deleted_at IS NULL ORDER BY created_at DESC')
      .all() as { id: number; content: string }[]
    for (const f of flashes) {
      const id = graphNodeId('flash', f.id)
      nodes.push({
        id,
        label: flashLabel(f.content),
        kind: 'flash',
        size: 0.35,
        degree: 0,
        colorHint: 'flash',
        refId: f.id,
        format: '',
      })
    }
  }

  // 任务节点（可选，仅全图）：task→note 归属 + task→note 引用 + task→task 层级 + 段落锚
  if (includeTasks && onlyIds == null) {
    const tasks = c
      .prepare('SELECT id, title, parent_id FROM task WHERE deleted_at IS NULL')
      .all() as { id: number; title: string | null; parent_id: number | null }[]
    const taskIds = new Set(tasks.map((t) => t.id))
    for (const t of tasks) {
      nodes.push({
        id: graphNodeId('task', t.id),
        label: t.title || '（无标题）',
        kind: 'task',
        size: 0.8,
        degree: 0,
        colorHint: 'task',
        refId: t.id,
        format: '',
      })
    }
    for (const t of tasks) {
      if (t.parent_id != null && taskIds.has(t.parent_id)) {
        edges.push([graphNodeId('task', t.parent_id), graphNodeId('task', t.id)])
      }
    }
    const tns = c
      .prepare('SELECT task_id, note_id FROM task_note_link')
      .all() as { task_id: number; note_id: number }[]
    for (const l of tns) {
      if (taskIds.has(l.task_id) && allowed.has(l.note_id)) {
        edges.push([graphNodeId('task', l.task_id), l.note_id])
      }
    }
    // G3：task_note_ref 引用边与归属并存。同一对同时存在两种关系时按「引用」呈现
    // （虚线优先），归属语义仍留在 task_note_link 数据层，避免同一条边叠画两次。
    const refs = c
      .prepare('SELECT task_id, note_id FROM task_note_ref')
      .all() as { task_id: number; note_id: number }[]
    for (const l of refs) {
      if (!taskIds.has(l.task_id) || !allowed.has(l.note_id)) continue
      const edge: [number, number] = [graphNodeId('task', l.task_id), l.note_id]
      if (!edges.some(([s, d]) => s === edge[0] && d === edge[1])) edges.push(edge)
      presetKinds[edge[0] + ',' + edge[1]] = 'reference'
    }

    // G4：段落锚子节点——任务引用笔记内某段（task_note_context）时，
    // 在笔记下挂一个小锚点（引用虚线），锚点带定位键，图谱侧可跳转到该段。
    const ctxRows = c
      .prepare('SELECT id, task_id, note_id, block_key, snippet FROM task_note_context')
      .all() as {
      id: number
      task_id: number
      note_id: number
      block_key: string | null
      snippet: string | null
    }[]
    for (const ctx of ctxRows) {
      if (!allowed.has(ctx.note_id) || !taskIds.has(ctx.task_id)) continue
      if (!byId.has(ctx.note_id)) continue
      const aid = anchorNodeId(ctx.id)
      if (byId.has(aid)) continue
      const snippet = (ctx.snippet ?? '').trim().replace(/\n/g, ' ')
      const label = snippet.length > 10 ? snippet.slice(0, 10) + '…' : snippet || '段落引用'
      const node: GraphNodePayload = {
        id: aid,
        label,
        kind: 'anchor',
        size: 0.3,
        degree: 0,
        colorHint: 'anchor',
        refId: ctx.note_id,
        refTask: ctx.task_id,
        blockKey: ctx.block_key ?? '',
        snippet,
        format: '',
      }
      nodes.push(node)
      byId.set(aid, node)
      // note→anchor（就近挂载）+ task→anchor（引用来源）
      edges.push([ctx.note_id, aid])
      edges.push([graphNodeId('task', ctx.task_id), aid])
    }
  }

  // 1) 分类两类边（显式标注的优先保留，否则按端点类型推断）
  const edgeKinds: Record<string, 'ownership' | 'reference'> = {}
  for (const [src, dst] of edges) {
    const key = src + ',' + dst
    if (presetKinds[key]) {
      edgeKinds[key] = presetKinds[key]
      continue
    }
    edgeKinds[key] = classifyEdge(byId.get(src)?.kind ?? '', byId.get(dst)?.kind ?? '')
  }

  // 2) 归属层级边破环（folder→folder / task→task），丢弃的回边写进 cycleEdges
  let finalEdges = edges
  let cycleEdges: [number, number][] = []
  const hier = new Map<string, [number, number]>()
  for (const e of edges) {
    const a = byId.get(e[0])
    const b = byId.get(e[1])
    if (a && b && a.kind === b.kind && (a.kind === 'folder' || a.kind === 'task')) {
      hier.set(e[0] + ',' + e[1], e)
    }
  }
  if (hier.size) {
    const hierList = [...hier.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1])
    const keep = new Set(acyclicOwnershipEdges(hierList).map(([s, d]) => s + ',' + d))
    const dropped = [...hier.keys()].filter((k) => !keep.has(k))
    if (dropped.length) {
      const droppedSet = new Set(dropped)
      for (const k of dropped) delete edgeKinds[k]
      finalEdges = edges.filter((e) => !droppedSet.has(e[0] + ',' + e[1]))
      cycleEdges = dropped
        .map((k) => k.split(',').map(Number) as [number, number])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    }
  }

  return { nodes, edges: finalEdges, edgeKinds, cycleEdges }
}

// ---------------------------------------------------------------- 增量同步（G5）

/** 最近一帧的构建结果与构建参数（对齐 GraphService._cache / _cache_params）。 */
let graphCache: GraphPayload | null = null
let graphParams: GraphQuery = {}
/** 图页是否在看图谱：没人看就不必每次写入都重算 diff。 */
let graphWatching = false

export function setGraphWatch(active: boolean): void {
  graphWatching = active
}

export function isGraphWatching(): boolean {
  return graphWatching
}

/**
 * 构建并缓存一帧 —— **只给全图视图用**。
 *
 * 它会同时覆盖模块级的 graphCache 与 graphParams，而 graphDelta() 正是拿这两个当
 * 「上一帧全图」的基线去做 diff。所以任何**子图 / 过滤视图**都必须走裸 buildGraph：
 * 一旦基线被换成子图，下一次写入算出来的增量就会把子图之外的节点当成「已删除」推给界面。
 */
export function buildGraphTracked(query: GraphQuery = {}): GraphPayload {
  const data = buildGraph(query)
  graphCache = data
  graphParams = { ...query }
  return data
}

/**
 * 相对上一帧的最小变更集（对齐 GraphService._sync：按缓存参数重建 → diff）。
 * 无上一帧时返回 full=true，消费端应整体重建但保留节点坐标。
 */
export function graphDelta(): GraphDelta {
  const old = graphCache
  const fresh = buildGraph(graphParams)
  const delta = diffGraph(fresh, old)
  graphCache = fresh
  return delta
}

/** 节点是否需要更新（label/kind/color/size/degree/format/ref 任一变化）。 */
export function nodeChanged(a: GraphNodePayload, b: GraphNodePayload): boolean {
  return !(
    a.label === b.label &&
    a.kind === b.kind &&
    a.colorHint === b.colorHint &&
    a.format === b.format &&
    a.refId === b.refId &&
    a.size === b.size &&
    a.degree === b.degree
  )
}

/** 计算增量（对齐 GraphService.diff）。 */
export function diffGraph(next: GraphPayload, prev: GraphPayload | null): GraphDelta {
  const key = (e: [number, number]): string => e[0] + ',' + e[1]
  if (!prev) {
    return {
      addedNodes: [...next.nodes],
      removedNodeIds: [],
      updatedNodeIds: [],
      addedEdges: next.edges.map((e) => [...e] as [number, number]),
      removedEdges: [],
      edgeKinds: { ...next.edgeKinds },
      full: true,
    }
  }
  const oldById = new Map(prev.nodes.map((n) => [n.id, n]))
  const newIds = new Set(next.nodes.map((n) => n.id))
  const addedNodes = next.nodes.filter((n) => !oldById.has(n.id))
  const removedNodeIds = prev.nodes.filter((n) => !newIds.has(n.id)).map((n) => n.id)
  const updatedNodes = next.nodes.filter((n) => {
    const a = oldById.get(n.id)
    return a != null && nodeChanged(a, n)
  })
  const updatedNodeIds = updatedNodes.map((n) => n.id)
  const oldEdges = new Set(prev.edges.map(key))
  const newEdges = new Set(next.edges.map(key))
  const addedEdges = next.edges.filter((e) => !oldEdges.has(key(e)))
  const removedEdges = prev.edges.filter((e) => !newEdges.has(key(e)))
  const edgeKinds: Record<string, 'ownership' | 'reference'> = {}
  for (const e of addedEdges) edgeKinds[key(e)] = next.edgeKinds[key(e)] ?? 'reference'
  return {
    addedNodes,
    removedNodeIds,
    updatedNodeIds,
    updatedNodes,
    addedEdges: addedEdges.map((e) => [...e] as [number, number]),
    removedEdges: removedEdges.map((e) => [...e] as [number, number]),
    edgeKinds,
    full: false,
  }
}

// ---------------------------------------------------------------- 邻域（G8）

/**
 * 某笔记的 1~2 度邻域子图（对齐 GraphService.neighborhood）。
 *
 * 只在 note_link 上做 BFS——不掺 folder / flash / task 节点，结果不随
 * includeTasks 或文件夹节点变化。悬空引用由 buildGraph 的 onlyIds 分支自然带入
 * （Python 在 neighborhood 里又补了一遍同样的悬空节点，那一步是重复的，这里不重复）。
 */
export function graphNeighborhood(noteId: number, degree = 1): GraphPayload {
  const c = conn()
  const links = c
    .prepare('SELECT src_note_id, dst_note_id FROM note_link')
    .all() as { src_note_id: number; dst_note_id: number | null }[]
  const adj = new Map<number, Set<number>>()
  for (const l of links) {
    if (l.dst_note_id == null) continue
    if (!adj.has(l.src_note_id)) adj.set(l.src_note_id, new Set())
    if (!adj.has(l.dst_note_id)) adj.set(l.dst_note_id, new Set())
    adj.get(l.src_note_id)!.add(l.dst_note_id)
    adj.get(l.dst_note_id)!.add(l.src_note_id)
  }
  const keep = new Set<number>([noteId])
  let frontier = [noteId]
  for (let d = 0; d < Math.max(1, Math.trunc(degree)); d++) {
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
  // 这里曾经走 buildGraphTracked —— 于是「在图页点一下节点」就把全图基线换成了这一小块邻域，
  // 之后任何写入触发的 graphDelta() 都在拿邻域帧 diff，界面上会闪出一批并不存在的增删。
  // 邻域是**另一个视图**，不该动全图的缓存。
  return buildGraph({ onlyIds: [...keep] })
}

// ---------------------------------------------------------------- 节点预览（G9）

/** 所属笔记文件夹名（找不到返回空串）。 */
function folderName(folderId: number | null): string {
  if (folderId == null) return ''
  const row = conn().prepare('SELECT name FROM note_folder WHERE id = ?').get(folderId) as
    | { name: string | null }
    | undefined
  return row?.name ?? ''
}

/**
 * 按节点类型生成选中面板的预览文本（对齐 GraphService.preview_text）：
 * note→摘要/字数/置顶；task→状态/优先级/截止/父任务/关联笔记；
 * folder→上级/子文件夹/笔记数；flash→正文/备注/来源；anchor→引用任务/片段。
 */
export function graphPreview(node: GraphNodePayload): string {
  const c = conn()
  try {
    if (node.kind === 'note') {
      const n = c
        .prepare('SELECT content_md, word_count, folder_id, pinned FROM note WHERE id = ?')
        .get(node.refId || node.id) as
        | { content_md: string | null; word_count: number | null; folder_id: number | null; pinned: number | null }
        | undefined
      if (!n) return '类型：笔记\n链接数：' + node.degree
      const lines = ['类型：笔记']
      const fn = folderName(n.folder_id)
      if (fn) lines.push('所属：' + fn)
      const summary = summarizeText(n.content_md, 140)
      if (summary) lines.push('摘要：' + summary)
      lines.push('字数：' + (n.word_count ?? 0) + ' · 链接：' + node.degree)
      if (n.pinned) lines.push('已置顶')
      return lines.join('\n')
    }
    if (node.kind === 'task') {
      const t = c
        .prepare(
          'SELECT id, title, status, priority, due_date, parent_id, notes_md FROM task WHERE id = ? AND deleted_at IS NULL'
        )
        .get(node.refId) as
        | {
            id: number
            title: string | null
            status: string
            priority: number
            due_date: string | null
            parent_id: number | null
            notes_md: string | null
          }
        | undefined
      if (!t) return '类型：任务\n链接数：' + node.degree
      const STATUS: Record<string, string> = {
        todo: '待办',
        doing: '进行中',
        waiting: '等待中',
        done: '已完成',
        abandoned: '已放弃',
      }
      const lines = ['类型：任务', '状态：' + (STATUS[t.status] ?? t.status) + ' · 优先级：' + priorityLabel(t.priority)]
      if (t.due_date) lines.push('截止：' + t.due_date)
      if (t.parent_id != null) {
        const p = c.prepare('SELECT title FROM task WHERE id = ?').get(t.parent_id) as
          | { title: string | null }
          | undefined
        if (p) lines.push('父任务：' + (p.title || '无标题'))
      }
      if ((t.notes_md ?? '').trim()) lines.push('备注：' + summarizeText(t.notes_md, 80))
      const linked = c
        .prepare(
          'SELECT n.title AS title FROM task_note_link l JOIN note n ON n.id = l.note_id WHERE l.task_id = ?'
        )
        .all(t.id) as { title: string | null }[]
      if (linked.length) {
        lines.push('关联笔记：' + linked.slice(0, 4).map((r) => r.title || '无标题').join('、'))
        if (linked.length > 4) lines.push('… 共 ' + linked.length + ' 个')
      } else {
        lines.push('关联笔记：0 个')
      }
      return lines.join('\n')
    }
    if (node.kind === 'folder') {
      const folders = c.prepare('SELECT id, parent_id, name FROM note_folder').all() as {
        id: number
        parent_id: number | null
        name: string | null
      }[]
      const target = folders.find((f) => f.id === node.refId)
      const children = folders.filter((f) => f.parent_id === node.refId)
      const noteCount = (
        c
          .prepare('SELECT COUNT(*) AS c FROM note WHERE deleted_at IS NULL AND folder_id = ?')
          .get(node.refId) as { c: number }
      ).c
      const lines = ['类型：文件夹']
      if (target && target.parent_id != null) {
        const parent = folders.find((f) => f.id === target.parent_id)
        if (parent) lines.push('上级：' + (parent.name ?? ''))
      }
      lines.push('子文件夹：' + children.length + ' 个 · 笔记：' + noteCount + ' 篇')
      if (children.length) lines.push('　' + children.slice(0, 5).map((f) => f.name ?? '').join('、'))
      return lines.join('\n')
    }
    if (node.kind === 'flash') {
      const f = c
        .prepare('SELECT content, remark, source_app, source_url FROM flash WHERE id = ? AND deleted_at IS NULL')
        .get(node.refId) as
        | { content: string | null; remark: string | null; source_app: string | null; source_url: string | null }
        | undefined
      if (!f) return '类型：闪念'
      const lines = ['类型：闪念']
      if ((f.content ?? '').trim()) lines.push('正文：' + summarizeText(f.content, 140))
      if ((f.remark ?? '').trim()) lines.push('备注：' + summarizeText(f.remark, 80))
      if (f.source_app) lines.push('来源：' + f.source_app)
      if (f.source_url) lines.push('链接：' + f.source_url.slice(0, 60))
      return lines.join('\n')
    }
    if (node.kind === 'dangling') {
      return '类型：待建链接\n目标：' + node.label + '\n双击新建笔记'
    }
    if (node.kind === 'anchor') {
      let taskTitle = ''
      if (node.refTask) {
        const row = c.prepare('SELECT title FROM task WHERE id = ?').get(node.refTask) as
          | { title: string | null }
          | undefined
        taskTitle = row?.title ?? ''
      }
      const snip = (node.snippet || node.label || '').replace(/\n/g, ' ')
      const lines = ['类型：段落引用']
      if (taskTitle) lines.push('引用自任务：' + taskTitle)
      if (snip) lines.push('片段：' + snip.slice(0, 60))
      lines.push('双击跳转定位到该段落')
      return lines.join('\n')
    }
  } catch {
    // 预览失败不该把侧栏带崩（对齐 Python 的 except → 兜底文本）
  }
  return '类型：' + node.kind + '\n链接数：' + node.degree
}

// ---------------------------------------------------------------- 图谱写入（拖拽连线）

/** 任务↔笔记是唯一「两种关系皆可」的组合：归属走 task_note_link，引用走 task_note_ref。 */
export const EDGE_EITHER = 'either'

/**
 * 允许连接矩阵（需求契约 §3.4，对齐 ALLOWED_CONNECTIONS）。
 * 未列出的组合一律禁止；task↔note 两个方向都归一到「任务 → 笔记」。
 */
const ALLOWED_CONNECTIONS: Record<string, 'ownership' | 'reference'> = {
  'note|note': 'reference',
  'note|dangling': 'reference',
  'folder|folder': 'ownership',
  'folder|note': 'ownership',
  'task|task': 'ownership',
  'task|note': 'ownership',
  'note|task': 'ownership',
}

/** 拖拽连线是否允许：返回边类、'either'，或 null（禁止）。 */
export function connectionAllowed(srcKind: string, dstKind: string): string | null {
  const pair = srcKind + '|' + dstKind
  if (pair === 'task|note' || pair === 'note|task') return EDGE_EITHER
  return ALLOWED_CONNECTIONS[pair] ?? null
}

/** 结合入口模式确定最终边类；未指定时默认归属（保持旧拖拽语义）。 */
export function resolveEdgeKind(
  srcKind: string,
  dstKind: string,
  mode?: 'ownership' | 'reference'
): 'ownership' | 'reference' | null {
  const kind = connectionAllowed(srcKind, dstKind)
  if (kind === EDGE_EITHER) return mode ?? 'ownership'
  return (kind as 'ownership' | 'reference' | null) ?? null
}

/** 归属层级父子映射（folder + task，节点 id 空间）。 */
function ownershipParents(): Map<number, number> {
  const c = conn()
  const parent = new Map<number, number>()
  for (const r of c
    .prepare('SELECT id, parent_id FROM note_folder WHERE parent_id IS NOT NULL')
    .all() as { id: number; parent_id: number }[]) {
    parent.set(folderNodeId(r.id), folderNodeId(r.parent_id))
  }
  for (const r of c
    .prepare('SELECT id, parent_id FROM task WHERE parent_id IS NOT NULL AND deleted_at IS NULL')
    .all() as { id: number; parent_id: number }[]) {
    parent.set(r.id + TASK_ID_OFFSET, r.parent_id + TASK_ID_OFFSET)
  }
  return parent
}

/**
 * 归属 DAG 环检测：把 childNode 挂到 newParentNode 下是否会成环（祖先链回溯）。
 * 既有坏环数据保守拒绝（对齐 would_create_cycle）。
 */
export function wouldCreateCycle(childNodeId: number, newParentNodeId: number): boolean {
  if (childNodeId === newParentNodeId) return true
  const parents = ownershipParents()
  const seen = new Set<number>()
  let cur: number | undefined = newParentNodeId
  while (cur !== undefined) {
    if (cur === childNodeId) return true
    if (seen.has(cur)) return true
    seen.add(cur)
    cur = parents.get(cur)
  }
  return false
}

/**
 * 笔记↔笔记引用边（对齐 link_notes）。
 * 已有同向行（含悬空）时只补 dst_note_id，避免撞唯一约束；反向已连视为已连。
 */
export function linkNotes(srcId: number, dstId: number): boolean {
  if (!srcId || !dstId || srcId <= 0 || dstId <= 0 || srcId === dstId) return false
  const c = conn()
  const src = c
    .prepare('SELECT id, title FROM note WHERE id = ? AND deleted_at IS NULL')
    .get(srcId) as { id: number; title: string | null } | undefined
  const dst = c
    .prepare('SELECT id, title FROM note WHERE id = ? AND deleted_at IS NULL')
    .get(dstId) as { id: number; title: string | null } | undefined
  if (!src || !dst) return false
  const tSrc = src.title || '无标题'
  const tDst = dst.title || '无标题'
  let made = false
  const run = c.transaction(() => {
    const pairs: [number, number, string][] = [
      [srcId, dstId, tDst],
      [dstId, srcId, tSrc],
    ]
    for (const [a, b, t] of pairs) {
      const row = c
        .prepare('SELECT id, dst_note_id FROM note_link WHERE src_note_id = ? AND dst_title = ?')
        .get(a, t) as { id: number; dst_note_id: number | null } | undefined
      if (row) {
        if ((row.dst_note_id ?? null) !== b) {
          c.prepare('UPDATE note_link SET dst_note_id = ? WHERE id = ?').run(b, row.id)
        }
        made = true
        return
      }
    }
    c.prepare('INSERT INTO note_link (src_note_id, dst_note_id, dst_title) VALUES (?, ?, ?)').run(
      srcId,
      dstId,
      tDst
    )
    made = true
  })
  run()
  return made
}

/** 建立「任务引用笔记」关系（对齐 link_task_note_ref，幂等）。 */
export function linkTaskNoteRef(taskId: number, noteId: number): boolean {
  if (!taskId || !noteId || taskId <= 0 || noteId <= 0) return false
  conn()
    .prepare('INSERT OR IGNORE INTO task_note_ref (task_id, note_id) VALUES (?, ?)')
    .run(taskId, noteId)
  return true
}

/** 解除「任务引用笔记」关系。 */
export function unlinkTaskNoteRef(taskId: number, noteId: number): boolean {
  return (
    conn()
      .prepare('DELETE FROM task_note_ref WHERE task_id = ? AND note_id = ?')
      .run(taskId, noteId).changes > 0
  )
}

// ---------------------------------------------------------------- 连线编辑

/** 边的两类：归属实线 / 引用虚线（与 classifyEdge 的返回值一致）。 */
export type EdgeKind = 'ownership' | 'reference'

/**
 * 解除笔记↔笔记引用。
 *
 * 注意：`linkNotes` 是**双向写**的（src→dst 与 dst→src 各一行），所以这里必须对称删两侧。
 * Python 版只删单向，是因为它那边只写了单向行；照搬会只删掉一半、图谱上边看似还在。
 */
export function unlinkNotes(srcId: number, dstId: number): boolean {
  if (!srcId || !dstId || srcId <= 0 || dstId <= 0) return false
  return (
    conn()
      .prepare(
        'DELETE FROM note_link WHERE (src_note_id = ? AND dst_note_id = ?) OR (src_note_id = ? AND dst_note_id = ?)'
      )
      .run(srcId, dstId, dstId, srcId).changes > 0
  )
}

/**
 * 建立一条连接：按端点类型 + 边类分派到真数据写入。
 *
 * 从渲染进程的连线逻辑下沉到这里，是为了让「改挂端点」能复用同一套裁决，
 * 而不是在前端再抄一遍分支。
 */
export function connectGraphNodes(
  srcKind: string,
  srcRef: number,
  dstKind: string,
  dstRef: number,
  edgeKind: EdgeKind
): boolean {
  // 方向归一：task↔note 一律按 task 在前（对齐 Python commit_connection）
  if (srcKind === 'note' && dstKind === 'task') {
    return connectGraphNodes(dstKind, dstRef, srcKind, srcRef, edgeKind)
  }
  // G2：归属层级改挂（folder→folder / task→task）先做祖先链环路校验
  // （对齐 commit_connection 第 3 步；避免把节点挂到自己的子孙下）。
  if (
    edgeKind === 'ownership' &&
    srcKind === dstKind &&
    (srcKind === 'folder' || srcKind === 'task') &&
    wouldCreateCycle(graphNodeId(srcKind, srcRef), graphNodeId(dstKind, dstRef))
  ) {
    return false
  }
  if (srcKind === 'note' && dstKind === 'note') return linkNotes(srcRef, dstRef)
  if (srcKind === 'task' && dstKind === 'note') {
    if (edgeKind === 'reference') return linkTaskNoteRef(srcRef, dstRef)
    attachTaskNote(srcRef, dstRef)
    return true
  }
  if (srcKind === 'folder' && dstKind === 'note') {
    return saveNote(dstRef, { folder_id: srcRef }) !== null
  }
  if (srcKind === 'task' && dstKind === 'task') {
    return reparentTask(dstRef, srcRef) !== null
  }
  return false
}

/**
 * 删除一条连线：按「边类 + 端点类型」分派到真数据操作。
 * 逐条对齐 Python `graph_page.remove_edge` 的分派表。
 */
export function removeGraphEdge(
  srcKind: string,
  srcRef: number,
  dstKind: string,
  dstRef: number,
  edgeKind: EdgeKind
): boolean {
  const kinds = new Set([srcKind, dstKind])
  try {
    if (kinds.has('task') && kinds.has('note')) {
      const taskRef = srcKind === 'task' ? srcRef : dstRef
      const noteRef = srcKind === 'note' ? srcRef : dstRef
      return edgeKind === 'reference'
        ? unlinkTaskNoteRef(taskRef, noteRef)
        : detachTaskNote(taskRef, noteRef) > 0
    }
    if (srcKind === 'task' && dstKind === 'task') return reparentTask(dstRef, null) !== null
    if (srcKind === 'note' && dstKind === 'note') return unlinkNotes(srcRef, dstRef)
    if (kinds.has('folder') && kinds.has('note')) {
      const noteRef = srcKind === 'note' ? srcRef : dstRef
      return saveNote(noteRef, { folder_id: null }) !== null
    }
    return false
  } catch {
    // 删除失败不该把界面带崩（对齐 Python 的 except → 提示）
    return false
  }
}

/**
 * 改挂一条连线的一端：**先建新关系、成功后再删旧关系**。
 *
 * 顺序不能反：先删后建的话，只要新建因约束被拒，这条边就直接弄丢了。
 */
export function rewireGraphEdge(params: {
  keepKind: string
  keepRef: number
  fromKind: string
  fromRef: number
  toKind: string
  toRef: number
  edgeKind: EdgeKind
}): boolean {
  const { keepKind, keepRef, fromKind, fromRef, toKind, toRef, edgeKind } = params
  if (!connectionAllowed(keepKind, toKind)) return false
  if (!connectGraphNodes(keepKind, keepRef, toKind, toRef, edgeKind)) return false
  removeGraphEdge(keepKind, keepRef, fromKind, fromRef, edgeKind)
  return true
}
