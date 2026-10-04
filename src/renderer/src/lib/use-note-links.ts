import { useCallback, useState } from 'react'
import type { Backlink, Note, NoteLink } from '@shared/types'
import { dropLinkLine } from './note-props'

interface Options {
  /** 当前笔记。null 时全部操作不动库 */
  current: Note | null
  /** 保存后重查列表（上层传 load） */
  onReload: () => Promise<void>
  onNotice: (msg: string) => void
  /** 确认框；返回 true 才继续 */
  confirm: (opts: { title: string; message: string; confirmText: string; danger: boolean }) => Promise<boolean>
}

/**
 * 笔记的链接关系一组：反向链接 / 正向引用 / 归属任务，以及它们的删除操作。
 *
 * 从 NotesPage 抽出来（那个文件 2429 行）。这一组和属性那组不同 —— 它跨了**两处数据**：
 *
 *   · 正向引用（outLinks）与反向链接（backlinks）都是正文里的 \`[[标题]]\`，
 *     不是独立记录。**删反链改的是对方那篇的正文** —— 用户在编辑这篇，
 *     动的却是另一篇，所以必须让用户确认。
 *   · 归属任务（attachedTasks）走 task_note_link，是真正的关系记录。
 *
 * 把这三样放在一起，是因为它们总是**同时装载、同时因一次保存而作废** ——
 * 分散在页面里时，"保存正文后只刷新了出链、忘了反链"这类漏刷就是这么来的。
 */
export function useNoteLinks({ current, onReload, onNotice, confirm }: Options): {
  backlinks: Backlink[]
  outLinks: NoteLink[]
  attachedTasks: { id: number; title: string }[]
  loadLinks: (noteId: number) => Promise<void>
  reloadOutLinks: (noteId: number) => Promise<void>
  reloadBacklinks: (noteId: number) => Promise<void>
  reloadAttachedTasks: (noteId: number) => Promise<void>
  clearLinks: () => void
  removeOutLink: (l: { dst_title: string }) => void
  removeBacklink: (b: Backlink) => Promise<void>
  detachTask: (taskId: number) => void
} {
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [outLinks, setOutLinks] = useState<NoteLink[]>([])
  const [attachedTasks, setAttachedTasks] = useState<{ id: number; title: string }[]>([])

  /** 三样一起查 —— 装载一篇笔记时用 */
  const loadLinks = useCallback(async (noteId: number): Promise<void> => {
    const [back, out, attached] = await Promise.all([
      window.zhixing.db.backlinks(noteId),
      window.zhixing.db.outLinks(noteId),
      window.zhixing.db.noteLinkedTasks(noteId),
    ])
    setBacklinks(back)
    setOutLinks(out)
    setAttachedTasks(attached)
  }, [])

  const reloadOutLinks = useCallback(async (noteId: number): Promise<void> => {
    setOutLinks(await window.zhixing.db.outLinks(noteId))
  }, [])

  const reloadBacklinks = useCallback(async (noteId: number): Promise<void> => {
    setBacklinks(await window.zhixing.db.backlinks(noteId))
  }, [])

  const reloadAttachedTasks = useCallback(async (noteId: number): Promise<void> => {
    setAttachedTasks(await window.zhixing.db.noteLinkedTasks(noteId))
  }, [])

  const clearLinks = useCallback((): void => {
    setBacklinks([])
    setOutLinks([])
    setAttachedTasks([])
  }, [])

  /** 删一条正向引用：把正文里的那一行 [[标题]] 去掉（改的是**这篇**） */
  const removeOutLink = useCallback(
    (l: { dst_title: string }): void => {
      if (!current) return
      const next = dropLinkLine(current.content_md ?? '', l.dst_title)
      void window.zhixing.db.saveNote(current.id, { content_md: next }).then(async () => {
        await onReload()
        onNotice('已删除引用')
      })
    },
    [current, onReload, onNotice]
  )

  /**
   * 删一条反向链接：改的是**对方那篇**的正文。
   *
   * 反链不是独立记录，而是"别人的正文里写着 [[这篇的标题]]"。所以先确认 ——
   * 它在动一篇用户当前没在看的笔记。
   */
  const removeBacklink = useCallback(
    async (b: Backlink): Promise<void> => {
      if (!current) return
      const ok = await confirm({
        title: '删除反向链接',
        message:
          '「' + b.src_title + '」的正文里写着指向这篇的 [[' + (current.title ?? '') +
          ']]。删掉会改的是那一篇，不是这一篇。',
        confirmText: '删掉那条链接',
        danger: true,
      })
      if (!ok) return
      const src = await window.zhixing.db.note(b.src_note_id)
      if (!src) return
      const next = dropLinkLine(src.content_md ?? '', current.title ?? '')
      await window.zhixing.db.saveNote(b.src_note_id, { content_md: next })
      await onReload()
      onNotice('已从「' + b.src_title + '」里删掉那条链接')
    },
    [current, confirm, onReload, onNotice]
  )

  /** 解除整篇级的任务关联 */
  const detachTask = useCallback(
    (taskId: number): void => {
      if (!current) return
      void window.zhixing.db.unlinkTaskNote(taskId, current.id).then(async () => {
        await onReload()
        onNotice('已解除关联')
      })
    },
    [current, onReload, onNotice]
  )

  return {
    backlinks,
    outLinks,
    attachedTasks,
    loadLinks,
    reloadOutLinks,
    reloadBacklinks,
    reloadAttachedTasks,
    clearLinks,
    removeOutLink,
    removeBacklink,
    detachTask,
  }
}
