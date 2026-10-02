/**
 * 命令面板统一搜索。
 *
 * 语法：
 *   - 前缀 task: / note: / flash: / tag:
 *   - 过滤 due:today|tomorrow|overdue|none、status:<状态>、priority:p1..p8|none、folder:名称
 *   - 出现任一过滤词时强制只搜任务
 *   - 空查询且无过滤：只回命令
 *
 * FTS 命中后统一按 rank 排序，
 * 并一律排除 deleted_at 非空的行。
 * 最后按 MRU（最近访问优先）重排 task/note/flash 三组。
 */
import { conn, today } from './connection'
import { searchIndex } from './fts'

export interface SearchHit {
  kind: 'task' | 'note' | 'flash' | 'tag'
  id: number
  title: string
  subtitle: string
}

/** 命令面板可执行命令。 */
export interface CommandHit {
  /** 稳定命令 id：渲染层据此映射到具体动作 */
  id: string
  title: string
  subtitle: string
}

export interface SearchResult {
  command: CommandHit[]
  task: SearchHit[]
  note: SearchHit[]
  flash: SearchHit[]
  tag: SearchHit[]
}

/**
 * 命令注册表。
 * 动作在渲染层，这里只交付稳定 id + 标题，由 CommandPalette 映射。
 */
export const COMMANDS: CommandHit[] = [
  { id: 'theme-dark', title: '切换深色主题', subtitle: '命令 · 外观' },
  { id: 'theme-light', title: '切换浅色主题', subtitle: '命令 · 外观' },
  { id: 'toggle-widget', title: '显隐桌面浮窗', subtitle: '命令 · 窗口' },
  { id: 'new-note', title: '新建笔记', subtitle: '命令 · 笔记' },
  { id: 'open-graph', title: '打开图谱', subtitle: '命令 · 导航' },
  { id: 'backup-now', title: '立即备份', subtitle: '命令 · 数据' },
  { id: 'start-pomodoro', title: '开始番茄钟（25 分钟）', subtitle: '命令 · 专注' },
]

/**
 * MRU：kind:id → 最近命中时间戳。
 * 存在主进程内存里——重启即清，不进数据库。
 */
const mru = new Map<string, number>()

/** 记一次命中（命令面板选中某条时才调），供后续搜索按最近访问优先。 */
export function searchTouch(kind: string, id: number): void {
  mru.set(kind + ':' + id, Date.now())
}

/** 按 MRU 时间倒序重排 task / note / flash 三组。 */
function applyMru(result: SearchResult): void {
  if (!mru.size) return
  const sort = (hits: SearchHit[]): void => {
    hits.sort((a, b) => (mru.get(a.kind + ':' + a.id) ?? 0) - (mru.get(b.kind + ':' + b.id) ?? 0))
    hits.reverse()
  }
  sort(result.task)
  sort(result.note)
  sort(result.flash)
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
  const result: SearchResult = { command: [], task: [], note: [], flash: [], tag: [] }
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

  // 命令注入：空查询返回全部命令，有查询按标题/副标题包含匹配，最多 6 条
  //
  if (!prefix || prefix === 'command') {
    const needle = q.toLowerCase()
    for (const cmd of COMMANDS) {
      if (!q || cmd.title.toLowerCase().includes(needle) || cmd.subtitle.toLowerCase().includes(needle)) {
        result.command.push(cmd)
      }
      if (result.command.length >= 6) break
    }
  }

  // 空查询且没有过滤：只回命令
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
      // 纯过滤：不依赖 FTS，按条件扫全量
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

  demoteUnverified(result)
  applyMru(result)
  return result
}

/**
 * 把**待确认**的笔记排到可用笔记之后。
 *
 * 方案 §9 第 4 条：待确认的条目还没核对过，不该和结论平起平坐。
 * 只在结果内部调序，不隐藏 —— 隐藏会让人以为"搜不到"，
 * 而它们本来就该能被搜到，只是要带着"还没核对"的身份出现。
 *
 * Array.prototype.sort 是稳定的，所以同一组内仍保持 FTS 的 rank 顺序。
 */
function demoteUnverified(result: SearchResult): void {
  const rows = result.note
  if (rows.length < 2) return
  const ids = rows.map((r) => r.id)
  const marks = conn()
    .prepare(
      'SELECT id FROM note WHERE verified_at IS NOT NULL AND id IN (' +
        ids.map(() => '?').join(',') +
        ')'
    )
    .all(...ids) as { id: number }[]
  const ok = new Set(marks.map((m) => m.id))
  rows.sort((a, b) => (ok.has(b.id) ? 1 : 0) - (ok.has(a.id) ? 1 : 0))
}
