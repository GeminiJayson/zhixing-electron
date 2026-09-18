/**
 * 命令面板统一搜索（对齐 Python 的 model/application/search_service.py）。
 *
 * 语法：
 *   - 前缀 task: / note: / flash: / tag:
 *   - 过滤 due:today|tomorrow|overdue|none、status:<状态>、priority:p1..p8|none、folder:名称
 *   - 出现任一过滤词时强制只搜任务（与 Python 一致）
 *   - 空查询且无过滤：只回命令 —— 命令由渲染层合并，这里返回空的数据分组
 *
 * FTS 命中后统一按 rank 排序（task 20 / note 8 / flash 6，与 Python 分档一致），
 * 并一律排除 deleted_at 非空的行。
 */
import { conn, today } from './connection'
import { searchIndex } from './fts'

export interface SearchHit {
  kind: 'task' | 'note' | 'flash' | 'tag'
  id: number
  title: string
  subtitle: string
}

export interface SearchResult {
  task: SearchHit[]
  note: SearchHit[]
  flash: SearchHit[]
  tag: SearchHit[]
}

const DUE_PATTERNS: [RegExp, string][] = [
  [/\bdue:today\b/, 'today'],
  [/\bdue:tomorrow\b/, 'tomorrow'],
  [/\bdue:overdue\b/, 'overdue'],
  [/\bdue:none\b/, 'none'],
]
const STATUS_RE = /\bstatus:(todo|doing|waiting|done|abandoned)\b/
const PRIORITY_RE = /\bpriority:(p[1-8]|none)\b/i
const FOLDER_RE = /\bfolder:"([^"]+)"|\bfolder:(\S+)/i

/** 明天的 YYYY-MM-DD（本地日期，与 today() 同口径）。 */
function tomorrow(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toLocaleDateString('sv-SE')
}

const STATUS_LABEL: Record<string, string> = {
  todo: '待办',
  doing: '进行中',
  waiting: '等待中',
  done: '已完成',
  abandoned: '已放弃',
}

interface TaskRow {
  id: number
  title: string
  status: string
  due_date: string | null
  priority: number
  list_id: number | null
}

export function globalSearch(input: string): SearchResult {
  let q = (input ?? '').trim()
  const result: SearchResult = { task: [], note: [], flash: [], tag: [] }
  const day = today()
  const next = tomorrow()

  let dueMode: string | null = null
  for (const [pat, mode] of DUE_PATTERNS) {
    if (pat.test(q)) {
      dueMode = mode
      q = q.replace(pat, ' ').trim()
      break
    }
  }
  let statusFilter: string | null = null
  let m = STATUS_RE.exec(q)
  if (m) {
    statusFilter = m[1]
    q = q.replace(STATUS_RE, ' ').trim()
  }
  let priorityFilter: string | null = null
  m = PRIORITY_RE.exec(q)
  if (m) {
    priorityFilter = m[1].toLowerCase()
    q = q.replace(PRIORITY_RE, ' ').trim()
  }
  let folderFilter: string | null = null
  m = FOLDER_RE.exec(q)
  if (m) {
    folderFilter = (m[1] || m[2] || '').trim()
    q = q.replace(FOLDER_RE, ' ').trim()
  }

  let prefix: string | null = null
  if (q.startsWith('task:')) {
    prefix = 'task'
    q = q.slice(5).trim()
  } else if (q.startsWith('note:')) {
    prefix = 'note'
    q = q.slice(5).trim()
  } else if (q.startsWith('flash:')) {
    prefix = 'flash'
    q = q.slice(6).trim()
  } else if (q.startsWith('tag:')) {
    prefix = 'tag'
    q = q.slice(4).trim()
  }
  const hasFilter = !!(dueMode || statusFilter || priorityFilter || folderFilter)
  if (hasFilter) prefix = 'task'

  // folder: 名称 → 命中的分组连同其后裔列表一起纳入过滤集合
  let folderIds: Set<number> | null = null
  if (folderFilter) {
    const all = conn()
      .prepare('SELECT id, parent_id, kind, name FROM list_folder')
      .all() as { id: number; parent_id: number | null; kind: string | null; name: string | null }[]
    const key = folderFilter.toLowerCase()
    const matches = all.filter((f) => (f.name ?? '').toLowerCase().includes(key))
    if (!matches.length) return result
    const ids = new Set(matches.map((f) => f.id))
    folderIds = new Set(ids)
    for (const f of all) {
      if (ids.has(f.id) && f.kind === 'group') {
        for (const g of all) if (g.parent_id === f.id && g.kind === 'list') folderIds.add(g.id)
      }
    }
  }

  // 空查询且没有过滤：只回命令（渲染层负责命令分组）
  if (!q && !hasFilter) return result

  const c = conn()
  const matchesTask = (t: TaskRow): boolean => {
    if (dueMode === 'today' && t.due_date !== day) return false
    if (dueMode === 'tomorrow' && t.due_date !== next) return false
    if (dueMode === 'overdue' && (t.due_date === null || t.due_date >= day)) return false
    if (dueMode === 'none' && t.due_date !== null) return false
    if (statusFilter && t.status !== statusFilter) return false
    if (priorityFilter) {
      if (priorityFilter === 'none') {
        if (Number(t.priority) !== 0) return false
      } else if (Number(t.priority) !== Number(priorityFilter.slice(1))) return false
    }
    if (folderIds && !folderIds.has(Number(t.list_id))) return false
    return true
  }

  if (!prefix || prefix === 'task') {
    let ids: number[]
    if (hasFilter && !q) {
      // 纯过滤：不依赖 FTS，按条件扫全量（对齐 Python 的过滤模式分支）
      const rows = c
        .prepare('SELECT id FROM task WHERE deleted_at IS NULL ORDER BY sort_key, id')
        .all() as { id: number }[]
      ids = rows.map((r) => r.id)
    } else {
      ids = searchIndex('task', q, 20).map(([id]) => id)
    }
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',')
      const rows = c
        .prepare(
          'SELECT id, title, status, due_date, priority, list_id FROM task WHERE deleted_at IS NULL AND id IN (' +
            placeholders +
            ')'
        )
        .all(...ids) as TaskRow[]
      const byId = new Map(rows.map((r) => [r.id, r]))
      for (const id of ids) {
        const t = byId.get(id)
        if (!t || !matchesTask(t)) continue
        const label = STATUS_LABEL[t.status] ?? ''
        result.task.push({
          kind: 'task',
          id,
          title: t.title,
          subtitle: label + (t.due_date ? ' · 截止 ' + t.due_date : ''),
        })
      }
    }
  }

  if (!prefix || prefix === 'note') {
    for (const [id] of searchIndex('note', q, 8)) {
      const n = c
        .prepare('SELECT id, title, content_md FROM note WHERE id = ? AND deleted_at IS NULL')
        .get(id) as { id: number; title: string; content_md: string | null } | undefined
      if (!n) continue
      result.note.push({
        kind: 'note',
        id,
        title: n.title,
        subtitle: (n.content_md ?? '').slice(0, 40),
      })
    }
  }

  if (!prefix || prefix === 'flash') {
    for (const [id] of searchIndex('flash', q, 6)) {
      const f = c
        .prepare('SELECT id, content, remark FROM flash WHERE id = ? AND deleted_at IS NULL')
        .get(id) as { id: number; content: string; remark: string | null } | undefined
      if (!f) continue
      result.flash.push({
        kind: 'flash',
        id,
        title: f.content.slice(0, 50),
        subtitle: f.remark ?? '',
      })
    }
  }

  if (!prefix || prefix === 'tag') {
    const needle = q.toLowerCase()
    for (const t of c.prepare('SELECT id, name FROM tag ORDER BY name').all() as {
      id: number
      name: string
    }[]) {
      if (needle && !t.name.toLowerCase().includes(needle)) continue
      result.tag.push({ kind: 'tag', id: t.id, title: '#' + t.name, subtitle: '' })
    }
  }

  return result
}
