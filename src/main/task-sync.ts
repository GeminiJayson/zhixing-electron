/**
 * 外部任务源同步：GET 一个接口，把返回的 JSON 变成本地任务。
 *
 * 设计要点：
 *   - **幂等**：以 (external_source='api', external_id) 认领，重复同步只更新不新建；
 *     外部删掉的条目本地**不删**（用户可能已经把它当自己的任务在用）。
 *   - **字段名宽松识别**：不同接口叫法差很多，每类字段给一组候选名（见 FIELD_KEYS），
 *     常见 REST 返回（id/title/description/due_date/priority/done）开箱可用。
 *   - **只进不退**：外部完成 → 本地标完成；外部又变回未完成时**不动**本地状态
 *     （避免外部系统的一次抖动把用户已经做完的任务翻回去）。
 *   - 缺 id 或缺标题的条目会被跳过并计数，不猜、不编。
 */
import { conn, nowStamp } from './db/connection'
import { nextSortKey } from './db/tasks'
import { listSettings, setSettings } from './db/settings'
import { parseSettings } from '../shared/settings'

/** 外部来源标识（将来接第二种来源时用它区分） */
export const EXTERNAL_SOURCE = 'api'

export interface TaskSyncResult {
  ok: boolean
  message: string
  total: number
  created: number
  updated: number
  unchanged: number
  skipped: number
}

export interface TaskSyncStatus {
  enabled: boolean
  url: string
  intervalMin: number
  lastAt: string
  lastResult: string
}

/** 每类字段的候选名，按顺序取第一个有值的 */
const FIELD_KEYS = {
  id: ['id', 'external_id', 'externalId', 'uid', 'key', 'uuid', 'task_id'],
  title: ['title', 'name', 'subject', 'content', 'text', 'summary'],
  notes: ['notes', 'notes_md', 'description', 'desc', 'body', 'remark', 'detail'],
  due: ['due', 'due_date', 'dueDate', 'deadline', 'end_date', 'endDate'],
  priority: ['priority', 'prio', 'importance', 'level'],
  done: ['done', 'completed', 'is_done', 'isDone', 'finished', 'checked'],
  status: ['status', 'state'],
} as const

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

function pick(row: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = row[k]
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && v.trim() === '') continue
    return v
  }
  return undefined
}

/** 接口返回的数组：直接给数组，或者包在 items / data / tasks / list 里 */
export function extractRows(payload: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(payload)) return payload.map(asRecord).filter((r): r is Record<string, unknown> => !!r)
  const root = asRecord(payload)
  if (!root) return null
  for (const key of ['items', 'data', 'tasks', 'list', 'results']) {
    const v = root[key]
    if (Array.isArray(v)) return v.map(asRecord).filter((r): r is Record<string, unknown> => !!r)
  }
  return null
}

/** 日期 → YYYY-MM-DD；认不出来就当作「没填」 */
export function toDueDate(v: unknown): string | null {
  const raw = String(v ?? '').trim()
  if (!raw) return null
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(raw)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('sv-SE')
}

/** 优先级：数字按 0~8 夹取；high/medium/low 这类词映射到 6/4/2 */
export function toPriority(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.min(8, Math.max(0, Math.round(v)))
  const s = String(v ?? '').trim().toLowerCase()
  if (!s) return 0
  if (['high', 'urgent', 'p1', 'h'].includes(s)) return 6
  if (['medium', 'normal', 'p2', 'm'].includes(s)) return 4
  if (['low', 'p3', 'l'].includes(s)) return 2
  const n = Number(s)
  return Number.isFinite(n) ? Math.min(8, Math.max(0, Math.round(n))) : 0
}

function toDone(row: Record<string, unknown>): boolean {
  const d = pick(row, FIELD_KEYS.done)
  if (d !== undefined) {
    if (d === true) return true
    if (d === false) return false
    return ['1', 'true', 'yes', 'done', 'completed'].includes(String(d).trim().toLowerCase())
  }
  const st = String(pick(row, FIELD_KEYS.status) ?? '').trim().toLowerCase()
  return ['done', 'completed', 'finished', 'closed'].includes(st)
}

function remember(message: string): void {
  setSettings({ task_api_last_at: nowStamp(), task_api_last_result: message })
}

export function taskSyncStatus(): TaskSyncStatus {
  const s = parseSettings(listSettings())
  return {
    enabled: s.task_api_enabled,
    url: s.task_api_url,
    intervalMin: s.task_api_interval_min,
    lastAt: s.task_api_last_at,
    lastResult: s.task_api_last_result,
  }
}

type UpsertOutcome = 'created' | 'updated' | 'unchanged'

function upsertOne(row: Record<string, unknown>, listId: number | null): UpsertOutcome | 'skipped' {
  const c = conn()
  const extId = String(pick(row, FIELD_KEYS.id) ?? '').trim()
  const title = String(pick(row, FIELD_KEYS.title) ?? '').trim()
  if (!extId || !title) return 'skipped'
  const notes = String(pick(row, FIELD_KEYS.notes) ?? '')
  const due = toDueDate(pick(row, FIELD_KEYS.due))
  const priority = toPriority(pick(row, FIELD_KEYS.priority))
  const done = toDone(row)
  const stamp = nowStamp()

  const existing = c
    .prepare(
      'SELECT id, title, notes_md, due_date, priority, status FROM task ' +
        'WHERE external_source = ? AND external_id = ? AND deleted_at IS NULL'
    )
    .get(EXTERNAL_SOURCE, extId) as
    | { id: number; title: string; notes_md: string | null; due_date: string | null; priority: number | null; status: string | null }
    | undefined

  if (existing) {
    const sets: string[] = []
    const args: unknown[] = []
    if (title !== existing.title) {
      sets.push('title = ?')
      args.push(title)
    }
    if (notes !== (existing.notes_md ?? '')) {
      sets.push('notes_md = ?')
      args.push(notes)
    }
    if ((due ?? null) !== (existing.due_date ?? null)) {
      sets.push('due_date = ?')
      args.push(due)
    }
    if (priority !== (existing.priority ?? 0)) {
      sets.push('priority = ?')
      args.push(priority)
    }
    // 只进不退：外部说完成就标完成；外部又变回未完成时不动本地
    if (done && existing.status !== 'done') {
      sets.push("status = 'done'", 'completed_at = ?')
      args.push(stamp)
    }
    if (!sets.length) return 'unchanged'
    sets.push('updated_at = ?')
    args.push(stamp, existing.id)
    c.prepare(`UPDATE task SET ${sets.join(', ')} WHERE id = ?`).run(...args)
    return 'updated'
  }

  c.prepare(
    `INSERT INTO task (title, notes_md, status, priority, due_date, repeat_period, streak,
                       sort_key, list_id, parent_id, completed_at, created_at, updated_at,
                       external_source, external_id)
     VALUES (?, ?, ?, ?, ?, 'none', 0, ?, ?, NULL, ?, ?, ?, ?, ?)`
  ).run(
    title,
    notes,
    done ? 'done' : 'todo',
    priority,
    due,
    nextSortKey(null),
    listId,
    done ? stamp : null,
    stamp,
    stamp,
    EXTERNAL_SOURCE,
    extId
  )
  return 'created'
}

export async function syncExternalTasks(): Promise<TaskSyncResult> {
  const empty = (message: string): TaskSyncResult => ({
    ok: false,
    message,
    total: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
  })
  const s = parseSettings(listSettings())
  const url = s.task_api_url.trim()
  if (!url) return empty('还没配置外部接口地址')
  if (!/^https?:\/\//i.test(url)) return empty('接口地址只支持 http/https')

  let payload: unknown
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(s.task_api_key ? { authorization: `Bearer ${s.task_api_key}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    if (!res.ok) {
      const message = `同步失败：HTTP ${res.status} ${text.slice(0, 160)}`
      remember(message)
      return empty(message)
    }
    payload = JSON.parse(text)
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    const detail =
      name === 'TimeoutError' || name === 'AbortError'
        ? '等待超过 30 秒'
        : err instanceof Error
          ? err.message
          : String(err)
    const message = `同步失败：${detail}`
    remember(message)
    return empty(message)
  }

  const rows = extractRows(payload)
  if (!rows) {
    const message = '接口返回的不是任务数组（可以是 [...]，或 { items: [...] } / { data: [...] }）'
    remember(message)
    return empty(message)
  }

  let created = 0
  let updated = 0
  let unchanged = 0
  let skipped = 0
  for (const row of rows) {
    const outcome = upsertOne(row, s.task_api_list_id)
    if (outcome === 'created') created += 1
    else if (outcome === 'updated') updated += 1
    else if (outcome === 'unchanged') unchanged += 1
    else skipped += 1
  }

  const parts = [`拉到 ${rows.length} 条`, `新增 ${created}`, `更新 ${updated}`]
  if (unchanged) parts.push(`未变 ${unchanged}`)
  if (skipped) parts.push(`跳过 ${skipped}（缺 id 或标题）`)
  const message = parts.join('，')
  remember(message)
  return { ok: true, message, total: rows.length, created, updated, unchanged, skipped }
}
