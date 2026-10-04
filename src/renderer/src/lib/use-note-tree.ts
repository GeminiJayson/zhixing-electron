import { useCallback } from 'react'
import type { Note, NoteFolder } from '@shared/types'

interface Options {
  notes: Note[]
  folders: NoteFolder[]
  onNotice: (msg: string) => void
  prompt: (opts: { title: string; label: string; defaultValue?: string }) => Promise<string | null>
  confirm: (opts: {
    title: string
    message: string
    icon?: React.ReactNode
    danger?: boolean
    confirmText?: string
  }) => Promise<boolean>
  /** 重查 notes/folders 两张列表 */
  onReload: () => Promise<void>
  /** 移动后必须显式更新 current —— load() 不动它 */
  setCurrent: (n: Note) => void
  /** 删掉的笔记要从 tab 里关掉（flush=false：它已经不在库里了） */
  dropTab: (id: number, flush: boolean) => Promise<void>
  icon: React.ReactNode
}

/**
 * 笔记树的结构操作：文件夹增删改移、笔记移动/置顶/删除。
 *
 * 从 NotesPage 抽出来（那个文件 2214 行）。这一组是**对树本身的操作**，
 * 与正文编辑无关 —— 它们只碰 folder_id / pinned / deleted_at 三样元数据。
 *
 * 有两处容易写错的细节，跟着实现一起搬过来了：
 *
 *   · **移动笔记后必须显式 setCurrent**。load() 只刷新 notes 与 folders 两张列表，
 *     **不动 current** —— 而信息区「归属」栏读的是 current.folder_id。不更新的话，
 *     笔记树里那篇已经换了位置、信息区却还显示旧文件夹。
 *   · **删除笔记时 dropTab 要传 flush=false**。这篇已经从库里没了，
 *     落盘会写一篇本不该存在的笔记。
 */
export function useNoteTree({
  notes,
  folders,
  onNotice,
  prompt,
  confirm,
  onReload,
  setCurrent,
  dropTab,
  icon,
}: Options): {
  moveNote: (noteId: number, folderId: number | null) => Promise<void>
  createFolder: (parentId: number | null) => Promise<void>
  renameFolder: (id: number, currentName: string) => Promise<void>
  deleteFolder: (id: number) => Promise<void>
  moveFolder: (id: number, parentId: number | null) => Promise<void>
  togglePin: (id: number, pinned: boolean) => Promise<void>
  deleteNote: (id: number) => Promise<void>
} {
  const moveNote = useCallback(
    async (noteId: number, folderId: number | null): Promise<void> => {
      const saved = await window.zhixing.db.saveNote(noteId, { folder_id: folderId })
      const name = folderId == null ? '全部笔记' : folders.find((f) => f.id === folderId)?.name
      onNotice(saved ? '已把笔记移入「' + name + '」' : '移动失败')
      if (saved) setCurrent(saved)
      await onReload()
    },
    [folders, onNotice, setCurrent, onReload]
  )

  const createFolder = useCallback(
    async (parentId: number | null): Promise<void> => {
      const name = await prompt({ title: '新建文件夹', label: '文件夹名称' })
      if (!name?.trim()) return
      await window.zhixing.db.createNoteFolder(name, parentId)
      await onReload()
    },
    [prompt, onReload]
  )

  const renameFolder = useCallback(
    async (id: number, currentName: string): Promise<void> => {
      const name = await prompt({
        title: '重命名文件夹',
        label: '文件夹名称',
        defaultValue: currentName,
      })
      if (!name?.trim()) return
      await window.zhixing.db.renameNoteFolder(id, name.trim())
      await onReload()
      onNotice('已重命名文件夹')
    },
    [prompt, onReload, onNotice]
  )

  const deleteFolder = useCallback(
    async (id: number): Promise<void> => {
      const ok = await confirm({
        title: '删除文件夹',
        message: '删除后文件夹内的笔记会移到「全部笔记」，不会删除笔记。确认删除？',
        danger: true,
        confirmText: '删除',
      })
      if (!ok) return
      await window.zhixing.db.deleteNoteFolder(id)
      await onReload()
      onNotice('已删除文件夹（笔记已移回全部笔记）')
    },
    [confirm, onReload, onNotice]
  )

  const moveFolder = useCallback(
    async (id: number, parentId: number | null): Promise<void> => {
      const res = await window.zhixing.db.moveNoteFolder(id, parentId)
      if (!res) {
        onNotice('不能把文件夹移动到它自己或它的子文件夹下')
        return
      }
      await onReload()
      onNotice('已移动文件夹')
    },
    [onReload, onNotice]
  )

  const togglePin = useCallback(
    async (id: number, pinned: boolean): Promise<void> => {
      await window.zhixing.db.saveNote(id, { pinned })
      await onReload()
    },
    [onReload]
  )

  const deleteNote = useCallback(
    async (id: number): Promise<void> => {
      const note = notes.find((n) => n.id === id)
      if (!note) return
      const confirmed = await confirm({
        title: '删除笔记',
        message: '删除笔记「' + note.title + '」？\n软删除，可在回收站恢复。',
        icon,
        danger: true,
        confirmText: '删除',
      })
      if (!confirmed) return
      await window.zhixing.db.deleteNote(id)
      await dropTab(id, false)
      await onReload()
      onNotice('已删除（可在回收站恢复）')
    },
    [notes, confirm, icon, dropTab, onReload, onNotice]
  )

  return { moveNote, createFolder, renameFolder, deleteFolder, moveFolder, togglePin, deleteNote }
}
