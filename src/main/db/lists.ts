/**
 * 任务清单 / 分组：树形清单、创建 / 改名 / 删除文件夹、默认清单 id、移动到清单。
 *
 * 此前 list_folder 表只有 quickAdd 的隐式写入：任务没有分组视图、不能按清单浏览或移动。
 */
import { conn, nowStamp, TASK_COLUMNS } from './connection'
import { batchMove } from './task-ops'
import type { ListFolder, Task } from '../../shared/types'

const LIST_COLUMNS = 'id, parent_id, kind, name, icon, collapsed, sort'

/** 全部清单与分组。 */
export function listFolders(): ListFolder[] {
  return conn()
    .prepare('SELECT ' + LIST_COLUMNS + ' FROM list_folder ORDER BY sort, id')
    .all() as ListFolder[]
}

/** 新建清单或分组。 */
export function createListFolder(
  name: string,
  kind: 'group' | 'list' = 'list',
  parentId: number | null = null
): ListFolder {
  const clean = (name ?? '').trim() || '新列表'
  const c = conn()
  const next = c
    .prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM list_folder')
    .get() as { s: number }
  const info = c
    .prepare(
      "INSERT INTO list_folder (parent_id, kind, name, icon, collapsed, sort, created_at) VALUES (?, ?, ?, 'folder', 0, ?, ?)"
    )
    .run(parentId, kind, clean, next.s, nowStamp())
  return c
    .prepare('SELECT ' + LIST_COLUMNS + ' FROM list_folder WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as ListFolder
}

/** 重命名。 */
export function renameListFolder(id: number, name: string): number {
  return conn()
    .prepare('UPDATE list_folder SET name = ? WHERE id = ?')
    .run((name ?? '').trim() || '未命名', id).changes
}

/**
 * 删除：列表下的任务回落收件箱（list_id→NULL），
 * 子节点上移一级后删除自身。
 */
export function deleteListFolder(id: number): number {
  const c = conn()
  const run = c.transaction(() => {
    const row = c.prepare('SELECT id, parent_id, kind FROM list_folder WHERE id = ?').get(id) as
      | { id: number; parent_id: number | null; kind: string | null }
      | undefined
    if (!row) return 0
    if (row.kind === 'list') {
      c.prepare('UPDATE task SET list_id = NULL WHERE list_id = ?').run(id)
    }
    c.prepare('UPDATE list_folder SET parent_id = ? WHERE parent_id = ?').run(row.parent_id, id)
    return c.prepare('DELETE FROM list_folder WHERE id = ?').run(id).changes
  })
  return run()
}

/**
 * 把清单 / 分组移动到某个分组下（parentId 为 null 表示顶层）。
 *
 * 两处校验都返回 0（未改任何行）而不是抛错：
 *   - 目标是它自己或它的后代 —— 否则树会自成环，渲染端会无限递归；
 *   - 目标不是分组 —— list 套 list 在数据模型里能存，但视图里没有意义。
 */
export function moveListFolder(id: number, parentId: number | null): number {
  const c = conn()
  if (id === parentId) return 0
  if (parentId !== null) {
    const parent = c.prepare('SELECT kind FROM list_folder WHERE id = ?').get(parentId) as
      | { kind: string | null }
      | undefined
    if (!parent || parent.kind !== 'group') return 0
  }
  let cur = parentId
  while (cur != null) {
    if (cur === id) return 0
    const row = c.prepare('SELECT parent_id FROM list_folder WHERE id = ?').get(cur) as
      | { parent_id: number | null }
      | undefined
    cur = row?.parent_id ?? null
  }
  // 落到目标分组的末尾：拖进分组时「放在哪儿」不该由它原来的 sort 决定
  const next = c
    .prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM list_folder WHERE parent_id IS ?')
    .get(parentId) as { s: number }
  return c
    .prepare('UPDATE list_folder SET parent_id = ?, sort = ? WHERE id = ?')
    .run(parentId, next.s, id).changes
}

/** 某个父级下的清单 / 分组（可排除自身），按 sort 排。 */
function listSiblings(parentId: number | null, excludeId?: number): ListFolder[] {
  return conn()
    .prepare(
      `SELECT ${LIST_COLUMNS} FROM list_folder
        WHERE (parent_id IS ? OR parent_id = ?)
          AND (? IS NULL OR id != ?)
     ORDER BY sort ASC, id ASC`
    )
    .all(parentId, parentId, excludeId ?? null, excludeId ?? null) as ListFolder[]
}

/** nodeId 是否在 ancestorId 的子树内（拖拽防成环）。 */
export function isListDescendantOf(ancestorId: number, nodeId: number): boolean {
  const c = conn()
  let cur: number | null = nodeId
  const guard = new Set<number>()
  while (cur !== null && !guard.has(cur)) {
    guard.add(cur)
    const row = c.prepare('SELECT parent_id FROM list_folder WHERE id = ?').get(cur) as
      | { parent_id: number | null }
      | undefined
    if (!row) return false
    if (row.parent_id === ancestorId) return true
    cur = row.parent_id
  }
  return false
}

/**
 * 拖拽排序 / 跨分组拖拽：把 id 放到 anchor 的上（below=false）或下（below=true），
 * 父级跟随 anchor —— 于是「拖到另一个分组里的某行旁边」就等于「跨组移动 + 排序」。
 *
 * sort 取相邻两项的中间值（与任务排序同一套算法）：只写一行，不必重排整棵树。
 * 拒绝把自己拖进自己的子树：那样会让渲染端无限递归。
 */
export function reorderListFolder(id: number, anchorId: number, below: boolean): number {
  const c = conn()
  if (id === anchorId) return 0
  const me = c.prepare(`SELECT ${LIST_COLUMNS} FROM list_folder WHERE id = ?`).get(id) as
    | ListFolder
    | undefined
  const anchor = c.prepare(`SELECT ${LIST_COLUMNS} FROM list_folder WHERE id = ?`).get(anchorId) as
    | ListFolder
    | undefined
  if (!me || !anchor) return 0
  if (isListDescendantOf(id, anchorId)) return 0
  const parentId = anchor.parent_id ?? null
  const sib = listSiblings(parentId, id)
  const idxBase = sib.findIndex((x) => x.id === anchorId)
  const idx = (idxBase < 0 ? sib.length : idxBase) + (below ? 1 : 0)
  const keyOf = (x: ListFolder | undefined, fallback: number): number =>
    typeof x?.sort === 'number' ? x.sort : fallback
  const prevKey = idx > 0 ? keyOf(sib[idx - 1], 0) : sib.length ? keyOf(sib[0], 0) - 2 : 0
  const nextKey =
    idx < sib.length ? keyOf(sib[idx], 2) : sib.length ? keyOf(sib[sib.length - 1], 0) + 2 : 2
  const key = (prevKey + nextKey) / 2
  return c
    .prepare('UPDATE list_folder SET parent_id = ?, sort = ? WHERE id = ?')
    .run(parentId, key, id).changes
}

/** 默认清单「我的清单」：不存在则创建。 */
export function defaultListId(): number {
  const found = conn()
    .prepare("SELECT id FROM list_folder WHERE name = '我的清单' ORDER BY id LIMIT 1")
    .get() as { id: number } | undefined
  if (found) return found.id
  return createListFolder('我的清单', 'list', null).id
}

/** 把任务移到清单。 */
export function moveTaskToList(taskId: number, listId: number | null): number {
  return batchMove([taskId], listId)
}

/**
 * 某清单下的任务：以 list_id 匹配的任务为根，闭包收全部后代。
 * 子任务的 list_id 可能与父不同，闭包保证它们不会因为「根判定」被漏掉。
 */
export function listTasksByList(listId: number | null): Task[] {
  return conn()
    .prepare(
      // 根必须是「该清单下的顶层任务」：否则子任务（自身 list_id 可能为空）会同时出现在
      // 收件箱与父任务的清单里。第二段是
      // 「无顶层根时回退列出该列表全部任务」的兼容分支。
      'WITH RECURSIVE seed(id) AS (' +
        ' SELECT id FROM task WHERE deleted_at IS NULL AND list_id IS ? AND parent_id IS NULL' +
        ' UNION' +
        ' SELECT id FROM task WHERE deleted_at IS NULL AND list_id IS ?' +
        '   AND NOT EXISTS (SELECT 1 FROM task r WHERE r.deleted_at IS NULL' +
        '                     AND r.list_id IS ? AND r.parent_id IS NULL)' +
        ' UNION' +
        ' SELECT t.id FROM task t JOIN seed ON t.parent_id = seed.id WHERE t.deleted_at IS NULL' +
        ')' +
        // 复用权威列清单：此前这里是手抄的一份，漏了 start_time / due_time，
        // 于是清单视图里 TaskRow 拿不到这两个字段、进度条退化成 00:00–23:59
        ' SELECT ' +
        TASK_COLUMNS +
        ' FROM task WHERE id IN (SELECT id FROM seed)' +
        ' ORDER BY sort_key ASC, id ASC'
    )
    .all(listId, listId, listId) as Task[]
}
