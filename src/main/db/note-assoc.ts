/**
 * AI 整理之后的「关联修复」。
 *
 * 笔记被改写后，两类跨实体关联会悄悄失效：
 *   1. **标题引用**：任务备注（task.notes_md）里写着 \`[[旧标题]]\` —— 笔记改名后这句就悬空了。
 *      工作流步骤派发的任务、任务归属笔记等都把标题写在备注里，所以这一处必须跟着改。
 *   2. **段落锚**：task_note_context.block_key 是「段落文本的 sha1 指纹」。正文一改写，
 *      全部指纹都对不上，任务侧「跳到关联段落」就再也定位不到。
 *
 * 修复策略：标题走字面替换；段落锚拿旧 snippet 在新正文里找回最相似的一行重新算指纹，
 * 找不回来就**保持原样**（宁可锚不动，也不能把它指到一段无关的文字上）。
 *
 * 注意 note_link.dst_title（笔记之间的双链）不在这里处理 —— saveNote 改名时已经同步过了。
 */
import { conn, nowStamp } from './connection'
import { getNote } from './notes'
import { blockFingerprint, findBestLine } from '../../shared/block-fingerprint'

export interface AssociationRepair {
  /** 同步了多少条任务备注里的标题引用 */
  taskNotes: number
  /** 重算了多少个段落锚 */
  contexts: number
  /** 没能找回的段落锚（正文改动太大） */
  unresolved: number
}

export function repairNoteAssociations(
  noteId: number,
  prev: { title: string; content_md: string }
): AssociationRepair {
  const result: AssociationRepair = { taskNotes: 0, contexts: 0, unresolved: 0 }
  const c = conn()
  const now = getNote(noteId)
  if (!now) return result

  // 1) 标题引用
  if (prev.title && now.title && prev.title !== now.title) {
    const from = `[[${prev.title}]]`
    const to = `[[${now.title}]]`
    result.taskNotes = c
      .prepare(
        'UPDATE task SET notes_md = replace(notes_md, ?, ?), updated_at = ? WHERE notes_md LIKE ?'
      )
      .run(from, to, nowStamp(), `%${from}%`).changes
  }

  // 2) 段落锚
  const contentChanged = (prev.content_md ?? '') !== (now.content_md ?? '')
  if (contentChanged) {
    const rows = c
      .prepare('SELECT id, task_id, block_key, snippet FROM task_note_context WHERE note_id = ?')
      .all(noteId) as { id: number; task_id: number; block_key: string; snippet: string | null }[]
    const findDup = c.prepare(
      'SELECT id FROM task_note_context WHERE task_id = ? AND note_id = ? AND block_key = ?'
    )
    const del = c.prepare('DELETE FROM task_note_context WHERE id = ?')
    const upd = c.prepare('UPDATE task_note_context SET block_key = ?, snippet = ? WHERE id = ?')
    for (const row of rows) {
      // 没有旧片段就没法找回（早期数据可能只存了指纹）—— 跳过而不是算失败
      if (!(row.snippet ?? '').trim()) continue
      const match = findBestLine(now.content_md ?? '', row.snippet ?? '')
      if (!match) {
        result.unresolved += 1
        continue
      }
      const nextKey = blockFingerprint(match.line)
      if (!nextKey || nextKey === row.block_key) continue
      // 新指纹可能已经被别的任务关联过：删掉这条旧记录，避免撞唯一约束
      const dup = findDup.get(row.task_id, noteId, nextKey)
      if (dup) del.run(row.id)
      else upd.run(nextKey, match.line, row.id)
      result.contexts += 1
    }
  }
  return result
}
