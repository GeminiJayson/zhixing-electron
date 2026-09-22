/**
 * 任务正文 [[标题]] ↔ task_note_link 的对账（含「笔记建好之后回绑」）。
 *
 * 为什么单独成文件：这段逻辑同时被「任务侧」（写正文时解析）和「笔记侧」
 * （新建/改名后回绑）需要。放在 tasks.ts 里，notes.ts 要调它就成环
 * （tasks.ts 已经 import notes.ts）。这里做成叶子，只依赖 connection 与两个纯模块。
 */
import { conn } from './connection'
import { extractLinks } from '../../shared/wiki'
import { planTaskNoteLinks, type LinkRow } from '../../shared/task-note-links'

/**
 * 按标题解析笔记 id：只按 title + 未删除过滤后取首行，**不排序**。
 *
 * 若按 pinned/updated_at 排序，同标题多篇笔记时会解析到「置顶/最新」那篇；
 * 这里明确退化为无排序取首行。
 */
export function resolveNoteTitle(title: string): number | null {
  const row = conn()
    .prepare('SELECT id FROM note WHERE title = ? AND deleted_at IS NULL LIMIT 1')
    .get(title) as { id: number } | undefined
  return row?.id ?? null
}

/** 该任务当前的关联行（连笔记标题一起取，对账要靠它判断「这一行还成立吗」）。 */
function linkRows(taskId: number): LinkRow[] {
  return conn()
    .prepare(
      'SELECT l.note_id AS note_id, n.title AS title, l.source AS source ' +
        'FROM task_note_link l LEFT JOIN note n ON n.id = l.note_id WHERE l.task_id = ?'
    )
    .all(taskId) as LinkRow[]
}

/**
 * 任务 notes_md 里的 [[笔记标题]] 与 task_note_link 对账。
 *
 * 这张表原先只增不减：把 [[标题]] 从正文里删掉，行还留着 ——
 * 任务行的 ⇄N 计数和图谱里的任务-笔记边于是永远不消失。
 * 反过来直接清空重写又会误伤手动关联（source = 'manual'），
 * 所以对账规则按来源分开，判定逻辑在 shared/task-note-links.ts 里（可单测）。
 */
export function syncTaskNoteLinks(taskId: number, notesMd: string): number {
  const c = conn()
  const plan = planTaskNoteLinks(extractLinks(notesMd ?? ''), linkRows(taskId), resolveNoteTitle)
  if (plan.remove.length === 0 && plan.add.length === 0) return 0

  const del = c.prepare('DELETE FROM task_note_link WHERE task_id = ? AND note_id = ?')
  const ins = c.prepare(
    "INSERT OR IGNORE INTO task_note_link (task_id, note_id, source) VALUES (?, ?, 'wiki')"
  )
  // 一删一增必须同事务：否则中途失败会留下「旧的删了、新的没落」的半截关联，
  // 而 ⇄N 计数和图谱边都是按这张表读的，半截状态会直接显示成 0。
  c.transaction(() => {
    for (const id of plan.remove) del.run(taskId, id)
    for (const id of plan.add) ins.run(taskId, id)
  })()
  return plan.add.length
}

/** 正文里写了 [[title]] 的任务（含顶层与子任务，不含已删除）。 */
function tasksReferencing(title: string): { id: number; notes_md: string | null }[] {
  return conn()
    .prepare(
      "SELECT id, notes_md FROM task WHERE deleted_at IS NULL AND instr(notes_md, '[[' || ? || ']]') > 0"
    )
    .all(title) as { id: number; notes_md: string | null }[]
}

/**
 * 笔记出现（新建）或改名之后，把正文里已经写着 [[title]] 的任务重新对一遍账。
 *
 * 补的是这个缺陷：任务的正文是**先**写的，那时笔记还不存在，
 * syncTaskNoteLinks 解析不到标题就不落链；等笔记真的建出来，再也没有人去重解析它。
 * 用户看到的是「[[标题]] 明明写着，⇄N 却是 0」，而且不报任何错。
 *
 * 用 instr 而不是 LIKE：标题里的 % 和 _ 不该被当成通配符。
 * 返回实际发生变化的链接数。
 */
export function relinkTasksForTitle(title: string): number {
  const clean = (title ?? '').trim()
  if (!clean) return 0
  let changed = 0
  for (const t of tasksReferencing(clean)) {
    changed += syncTaskNoteLinks(t.id, t.notes_md ?? '')
  }
  return changed
}

/**
 * 显式重新解析某个任务的 [[链接]]。
 *
 * 有了 relinkTasksForTitle，新建/改名会自动补齐；这个入口是给**修历史数据**用的：
 * 修复上线之前就已经写坏的那些任务，只能靠它重跑一遍。
 */
export function linkTaskWikiNotes(taskId: number): number[] {
  const row = conn().prepare('SELECT notes_md FROM task WHERE id = ?').get(taskId) as
    | { notes_md: string | null }
    | undefined
  if (!row) return []
  const before = new Set(linkRows(taskId).map((r) => r.note_id))
  syncTaskNoteLinks(taskId, row.notes_md ?? '')
  return linkRows(taskId)
    .map((r) => r.note_id)
    .filter((id) => !before.has(id))
    .sort((a, b) => a - b)
}
