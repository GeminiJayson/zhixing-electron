/**
 * 任务清单 / 分组（对齐 task_service 的 folder_tree / create_folder / rename_folder /
 * delete_folder / default_list_id / list_tree / move_to_list）。
 *
 * 此前 list_folder 表只有 quickAdd 的隐式写入：任务没有分组视图、不能按清单浏览或移动，
 * 与 Python 版的列表数据模型实际不可互操作。
 */
import { conn, nowStamp } from './connection'
import { batchMove } from './task-ops'
import type { ListFolder, Task } from '../../shared/types'

const LIST_COLUMNS = 'id, parent_id, kind, name, icon, collapsed, sort'

/** 全部清单与分组（对齐 folder_tree）。 */
export function listFolders(): ListFolder[] {
  return conn()
    .prepare('SELECT ' + LIST_COLUMNS + ' FROM list_folder ORDER BY sort, id')
    .all() as ListFolder[]
}

/** 新建清单或分组（对齐 create_folder）。 */
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

/** 重命名（对齐 rename_folder）。 */
export function renameListFolder(id: number, name: string): number {
  return conn()
    .prepare('UPDATE list_folder SET name = ? WHERE id = ?')
    .run((name ?? '').trim() || '未命名', id).changes
}

/**
 * 删除（对齐 folders.delete）：列表下的任务回落收件箱（list_id→NULL），
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

/** 默认清单「我的清单」：不存在则创建（对齐 default_list_id）。 */
export function defaultListId(): number {
  const found = conn()
    .prepare("SELECT id FROM list_folder WHERE name = '我的清单' ORDER BY id LIMIT 1")
    .get() as { id: number } | undefined
  if (found) return found.id
  return createListFolder('我的清单', 'list', null).id
}

/** 把任务移到清单（对齐 move_to_list；复用批量移动，事务与时间戳一致）。 */
export function moveTaskToList(taskId: number, listId: number | null): number {
  return batchMove([taskId], listId)
}

/**
 * 某清单下的任务（对齐 list_tree）：以 list_id 匹配的任务为根，闭包收全部后代。
 * 子任务的 list_id 可能与父不同，闭包保证它们不会因为「根判定」被漏掉。
 */
export function listTasksByList(listId: number | null): Task[] {
  return conn()
    .prepare(
      // 根必须是「该清单下的顶层任务」：否则子任务（自身 list_id 可能为空）会同时出现在
      // 收件箱与父任务的清单里（对齐 list_tree 的 roots 判定）。第二段是 Python 的
      // 「无顶层根时回退列出该列表全部任务」兼容分支。
      'WITH RECURSIVE seed(id) AS (' +
        ' SELECT id FROM task WHERE deleted_at IS NULL AND list_id IS ? AND parent_id IS NULL' +
        ' UNION' +
        ' SELECT id FROM task WHERE deleted_at IS NULL AND list_id IS ?' +
        '   AND NOT EXISTS (SELECT 1 FROM task r WHERE r.deleted_at IS NULL' +
        '                     AND r.list_id IS ? AND r.parent_id IS NULL)' +
        ' UNION' +
        ' SELECT t.id FROM task t JOIN seed ON t.parent_id = seed.id WHERE t.deleted_at IS NULL' +
        ')' +
        ' SELECT id, title, notes_md, status, priority, due_date, start_date, reminder_at,' +
        ' list_id, parent_id, repeat_period, repeat_rule, streak, sort_key, resume_at,' +
        ' last_reset_date, completed_at, created_at, updated_at' +
        ' FROM task WHERE id IN (SELECT id FROM seed)' +
        ' ORDER BY sort_key ASC, id ASC'
    )
    .all(listId, listId, listId) as Task[]
}
