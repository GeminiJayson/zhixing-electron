import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, FolderTree, List } from '@renderer/lib/icons'
import type { ListFolder, Task } from '@shared/types'

/**
 * 捕获目标选择器（对齐 zhixing/view/components/target_selector.py）。
 *
 * mode='group'：分组/清单树（最近使用置顶 + 键入即过滤），选中返回 (list_id, name)；
 * mode='subtask'：父任务候选（最近 3 条 + 模糊搜索），选中返回 (task_id, title)。
 *
 * 「最近使用」写在 settings.ui_state 的 capture_recent_groups / capture_recent_tasks，
 * 与 Python 同名同结构——两版共用同一个库时最近项互通。
 */
export const RECENT_GROUPS_KEY = 'capture_recent_groups'
export const RECENT_TASKS_KEY = 'capture_recent_tasks'

const RECENT_LIMIT = 3

interface Props {
  mode: 'group' | 'subtask'
  onPick: (id: number, name: string) => void
  onCancel: () => void
}

interface Item {
  id: number
  name: string
  label: string
  kind: 'group' | 'list' | 'task'
}

/** 读取 settings.ui_state（坏 JSON 视作空对象，对齐 Python 的 ui_state）。 */
async function readUiState(): Promise<Record<string, unknown>> {
  try {
    const all = await window.zhixing.db.settings()
    const parsed: unknown = JSON.parse(all.ui_state || '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 记住最近使用的目标（对齐 _remember：去重后置顶，只保留 3 条）。 */
async function rememberRecent(key: string, id: number): Promise<void> {
  const state = await readUiState()
  const raw = state[key]
  const prev = Array.isArray(raw) ? raw.filter((x): x is number => typeof x === 'number') : []
  state[key] = [id, ...prev.filter((x) => x !== id)].slice(0, RECENT_LIMIT)
  await window.zhixing.db.setSetting('ui_state', JSON.stringify(state))
}

/** 任务是否终态（对齐 Task.is_done：done + abandoned 都不再作为父任务候选）。 */
const isTerminal = (status: string): boolean => status === 'done' || status === 'abandoned'

export function TargetSelector({ mode, onPick, onCancel }: Props) {
  const [q, setQ] = useState('')
  const [folders, setFolders] = useState<ListFolder[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  /** 最近使用但不在候选集里的任务（Python 是按 id 单独取回，这里用全量任务解析） */
  const [recentTasks, setRecentTasks] = useState<Task[]>([])
  const [recents, setRecents] = useState<number[]>([])
  const recentKey = mode === 'group' ? RECENT_GROUPS_KEY : RECENT_TASKS_KEY

  // 初次装载：最近使用 + 目标数据（分组树 / 近期活跃顶层任务）
  useEffect(() => {
    let alive = true
    void (async () => {
      const state = await readUiState()
      const raw = state[recentKey]
      if (alive) {
        setRecents(Array.isArray(raw) ? raw.filter((x): x is number => typeof x === 'number') : [])
      }
      if (mode === 'group') {
        const rows = (await window.zhixing.db.listFolders()) as ListFolder[]
        if (alive) setFolders(rows)
      } else {
        const rows = await window.zhixing.db.taskCandidates('', 20)
        if (alive) setTasks(rows)
        // 最近使用项可能没有截止日、不在候选集里：按 id 从全量任务里补齐
        const ids = Array.isArray(raw) ? raw.filter((x): x is number => typeof x === 'number') : []
        const present = new Set(rows.map((t) => t.id))
        const missing = ids.filter((rid) => !present.has(rid))
        if (missing.length) {
          const all = await window.zhixing.db.tasks(500)
          if (alive) setRecentTasks(all.filter((t) => missing.includes(t.id) && !isTerminal(t.status)))
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [mode, recentKey])

  // 任务模式：键入即模糊搜索（对齐 task_candidates(q)，过滤终态由主进程负责）；
  // 清空搜索词回到「近期活跃顶层任务」，与 Python 每次 textChanged 都 _reload 一致
  useEffect(() => {
    if (mode !== 'subtask') return
    const term = q.trim()
    let alive = true
    void (async () => {
      const rows = await window.zhixing.db.taskCandidates(term, 20)
      if (alive) setTasks(rows)
    })()
    return () => {
      alive = false
    }
  }, [q, mode])

  const items = useMemo<Item[]>(() => {
    const term = q.trim().toLowerCase()
    const out: Item[] = []
    if (mode === 'group') {
      // 对齐 Python：先按搜索词过滤 folders，再从过滤结果里挑最近使用项
      const visible = term ? folders.filter((f) => (f.name || '').toLowerCase().includes(term)) : folders
      const byId = new Map(visible.map((f) => [f.id, f]))
      const seen = new Set<number>()
      for (const rid of recents) {
        const f = byId.get(rid)
        if (!f) continue
        seen.add(f.id)
        out.push({ id: f.id, name: f.name, label: f.name, kind: f.kind })
      }
      const byParent = new Map<number | null, ListFolder[]>()
      for (const f of visible) {
        const key = f.parent_id ?? null
        const arr = byParent.get(key) ?? []
        arr.push(f)
        byParent.set(key, arr)
      }
      for (const arr of byParent.values()) {
        arr.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id - b.id)
      }
      const walk = (parentId: number | null, depth: number): void => {
        for (const f of byParent.get(parentId) ?? []) {
          if (seen.has(f.id)) continue
          seen.add(f.id)
          // 清单（kind='list'）加「· 」前缀、按层级用全角空格缩进（对齐 Python 的树形呈现）
          const prefix = f.kind === 'list' ? '· ' : ''
          out.push({
            id: f.id,
            name: f.name,
            label: '　'.repeat(depth) + prefix + f.name,
            kind: f.kind,
          })
          walk(f.id, depth + 1)
        }
      }
      walk(null, 0)
      return out
    }
    // subtask：最近使用（未完成）置顶，其余是主进程给的候选（同一条只展示一次）
    const pool = [...recentTasks, ...tasks]
    const seenTask = new Set<number>()
    for (const rid of recents) {
      const t = pool.find((x) => x.id === rid)
      if (!t || isTerminal(t.status) || seenTask.has(t.id)) continue
      seenTask.add(t.id)
      out.push({ id: t.id, name: t.title, label: t.title, kind: 'task' })
    }
    for (const t of tasks) {
      if (seenTask.has(t.id)) continue
      seenTask.add(t.id)
      out.push({ id: t.id, name: t.title, label: t.title, kind: 'task' })
    }
    return out
  }, [mode, q, folders, tasks, recentTasks, recents])

  const pick = async (item: Item): Promise<void> => {
    await rememberRecent(recentKey, item.id)
    onPick(item.id, item.name)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} role="dialog" aria-label={mode === 'group' ? '选择目标分组' : '选择父任务'}>
      <div className="wf-side__head">
        <button className="icon-btn" aria-label="返回" onClick={onCancel}>
          <ArrowLeft size={14} />
        </button>
        <span className="u-aux">
          {mode === 'group' ? '选择目标分组（内容将成为新任务）' : '选择父任务，内容将成为其子待办'}
        </span>
      </div>
      <input
        className="field field--mini"
        autoFocus
        value={q}
        placeholder="键入即搜索…"
        aria-label="搜索目标"
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="wf-list" style={{ maxHeight: 190, overflowY: 'auto' }}>
        {items.length === 0 ? (
          <p className="u-aux">没有匹配的目标。</p>
        ) : (
          items.map((it, i) => (
            <button
              key={`${it.kind}-${it.id}-${i}`}
              className="wf-item"
              onClick={() => void pick(it)}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {it.kind === 'task' ? <List size={13} /> : <FolderTree size={13} />}
                <strong>{it.label}</strong>
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
