/**
 * 任务↔笔记「归属」关联的对账计划（纯函数，不碰数据库）。
 *
 * 背景：task_note_link 同时承载两种来源的关联 ——
 *   ① wiki：任务 notes_md 里的 [[笔记标题]] 派生出来的（文本即真相）；
 *   ② manual：用户在「归属任务」或图谱里手动拉的一条边（操作即真相）。
 *
 * 缺陷在于这张表原先只增不减：把 [[标题]] 从正文里删掉，行还在，
 * 于是任务行上的 ⇄N 计数和图谱里的任务-笔记边永远不消失。
 * 但也不能简单清空重写 —— 手动拉的那条边并不出现在正文里，
 * 一律删会把它一起抹掉。所以先给每行记来源（task_note_link.source），再按来源分别对账。
 */

/** 一行既有关联。title 为 null = 目标笔记查不到（已被删除或标题变了）。 */
export interface LinkRow {
  note_id: number
  title: string | null
  /** 'wiki' | 'manual'；历史库里可能为 null（无法判定来源） */
  source: string | null
}

export interface LinkPlan {
  /** 需要删掉的 note_id */
  remove: number[]
  /** 需要新增的 note_id */
  add: number[]
}

/**
 * 算出要把既有关联拨到哪个状态。
 *
 * @param mdTitles 正文里解析出的 [[标题]] 列表（可含解析不到笔记的悬空标题）
 * @param existing 该任务当前的关联行
 * @param resolve  按标题解析笔记 id（解析不到返回 null）
 */
export function planTaskNoteLinks(
  mdTitles: string[],
  existing: LinkRow[],
  resolve: (title: string) => number | null
): LinkPlan {
  const wantedTitles = new Set(mdTitles)
  const targetIds = new Set<number>()
  for (const t of mdTitles) {
    const id = resolve(t)
    if (id != null) targetIds.add(id)
  }

  const remove: number[] = []
  const keptIds = new Set<number>()
  for (const r of existing) {
    // 手动关联以操作为准，正文里有没有提到它都不作数
    if (r.source === 'manual') {
      keptIds.add(r.note_id)
      continue
    }
    // 正文里还写着这篇笔记的标题 → 这一行仍然成立。
    // 两种情况都靠它兜住：① 笔记进了回收站，resolve 查不到，但正文没改、链接就该留着，
    // 等它出站自动恢复；② 笔记被改名重建，旧行按标题判定就不该被当成泄漏清掉。
    if (targetIds.has(r.note_id) || (r.title != null && wantedTitles.has(r.title))) {
      keptIds.add(r.note_id)
      continue
    }
    remove.push(r.note_id)
  }

  // 已在库里的不重复插；注意用 keptIds 而不是原 existing —— 上面判定要删的不能算作已有
  const add = [...targetIds].filter((id) => !keptIds.has(id))
  return { remove, add }
}
