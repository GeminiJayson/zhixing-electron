import type {
  GraphNodePayload,
  GraphPayload,
} from '../../shared/types'
import { conn } from './connection'
import { attachTaskNote, detachTaskNote } from './tasks'
import { reparentTask } from './task-ops'
import { saveNote } from './notes'

// ---------------------------------------------------------------- 图谱

/** 节点 id 空间（对齐 GraphService 常量，正负分区避免与笔记主键冲突）。 */
export const TASK_ID_OFFSET = 5_000_000
export const FLASH_ID_OFFSET = 1_000_000
export const FOLDER_ID_OFFSET = 2_000_000
export const folderNodeId = (id: number): number => -id - FOLDER_ID_OFFSET

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
  return refId
}

/**
 * 构建图谱数据，对齐 GraphService._assemble + _finalize_edges：
 * 文件夹层级与包含（归属）、note→note 与悬空引用（引用）、闪念为孤立节点。
 */
export function buildGraph(includeTasks = false): GraphPayload {
  const c = conn()
  const notes = c
    .prepare('SELECT id, title, folder_id, format FROM note WHERE deleted_at IS NULL')
    .all() as { id: number; title: string; folder_id: number | null; format: string }[]
  const folders = c
    .prepare('SELECT id, parent_id, name FROM note_folder')
    .all() as { id: number; parent_id: number | null; name: string }[]
  const links = c
    .prepare('SELECT src_note_id, dst_note_id, dst_title FROM note_link')
    .all() as { src_note_id: number; dst_note_id: number | null; dst_title: string }[]

  const allowed = new Set(notes.map((n) => n.id))
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

  // 闪念：独立负空间，只入图不连线
  const flashes = c
    .prepare('SELECT id, content FROM flash WHERE deleted_at IS NULL ORDER BY created_at DESC')
    .all() as { id: number; content: string }[]
  for (const f of flashes) {
    const id = graphNodeId('flash', f.id)
    const label = (f.content || '').trim().replace(/\s+/g, ' ')
    nodes.push({
      id,
      label: label.length > 16 ? label.slice(0, 16) + '…' : label,
      kind: 'flash',
      size: 0.35,
      degree: 0,
      colorHint: 'flash',
      refId: f.id,
      format: '',
    })
  }

  // 任务节点（可选）：task→note 为引用边，task→task 层级为归属边
  if (includeTasks) {
    const tasks = c
      .prepare('SELECT id, title, parent_id FROM task WHERE deleted_at IS NULL')
      .all() as { id: number; title: string; parent_id: number | null }[]
    const taskIds = new Set(tasks.map((t) => t.id))
    for (const t of tasks) {
      nodes.push({
        id: graphNodeId('task', t.id),
        label: t.title || '无标题',
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
  }

  const edgeKinds: Record<string, 'ownership' | 'reference'> = {}
  for (const [src, dst] of edges) {
    const a = byId.get(src)
    const b = byId.get(dst)
    edgeKinds[`${src},${dst}`] = classifyEdge(a?.kind ?? '', b?.kind ?? '')
  }

  return { nodes, edges, edgeKinds }
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
