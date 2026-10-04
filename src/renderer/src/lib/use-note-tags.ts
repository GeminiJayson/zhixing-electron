import { useCallback, useMemo, useState } from 'react'
import type { Note } from '@shared/types'

/** 一个标签（颜色与任务标签共用同一张表） */
export interface NoteTag {
  id: number
  name: string
  color: string
}

interface Options {
  current: Note | null
  onNotice: (msg: string) => void
  prompt: (opts: { title: string; label: string }) => Promise<string | null>
}

/**
 * 笔记的标签一组：全部标签、每篇笔记挂的标签，以及增删改。
 *
 * 从 NotesPage 抽出来（那个文件 2339 行）。
 *
 * **笔记标签与任务标签共用一套**：颜色写在共用的 tag 表里，所以这里读到的色值
 * 同时决定任务页胶囊与笔记胶囊的颜色 —— 改色后要重新走 loadNoteTags 对齐两份状态。
 * 写入是覆盖式的（清空后重插），标签不存在时按名新建，与任务侧 handleToggleTag
 * 同一套语义，于是「标签管理」里的重命名 / 合并 / 删除自动同时作用于任务与笔记。
 */
export function useNoteTags({ current, onNotice, prompt }: Options): {
  allTags: NoteTag[]
  tagsOf: Map<number, NoteTag[]>
  currentTags: NoteTag[]
  loadNoteTags: () => Promise<void>
  toggleTag: (tag: NoteTag) => Promise<void>
  createTag: () => Promise<void>
  setTagColor: (id: number, color: string) => Promise<void>
} {
  const [allTags, setAllTags] = useState<NoteTag[]>([])
  const [tagsOf, setTagsOf] = useState<Map<number, NoteTag[]>>(new Map())

  /**
   * 一次取「全部标签 + 每篇笔记挂的标签」。
   *
   * 颜色写在共用的 tag 表里，所以这里读到的色值同时决定任务页胶囊与笔记胶囊的颜色；
   * 改色之后也是重新走这个函数对齐两份状态。
   */
  const loadNoteTags = useCallback(async (): Promise<void> => {
    const [tg, nt] = await Promise.all([
      window.zhixing.db.tags(),
      window.zhixing.db.noteTags(),
    ])
    setAllTags(tg)
    const map = new Map<number, NoteTag[]>()
    for (const r of nt) {
      const list = map.get(r.note_id) ?? []
      list.push({ id: r.id, name: r.name, color: r.color })
      map.set(r.note_id, list)
    }
    setTagsOf(map)
  }, [])

  /** 当前笔记的标签胶囊 */
  const currentTags = useMemo(
    () => (current ? tagsOf.get(current.id) ?? [] : []),
    [current, tagsOf]
  )

  /** 切换一个标签（有则去掉、无则加上）。写入是覆盖式的，与任务侧同一套语义。 */
  const toggleTag = useCallback(
    async (tag: NoteTag): Promise<void> => {
      if (!current) return
      const cur = (tagsOf.get(current.id) ?? []).map((x) => x.name)
      const next = cur.includes(tag.name) ? cur.filter((n) => n !== tag.name) : [...cur, tag.name]
      await window.zhixing.db.setNoteTags(current.id, next)
      await loadNoteTags()
    },
    [current, tagsOf, loadNoteTags]
  )

  /** 新建标签并按名挂到当前笔记上（支持逗号分隔多个） */
  const createTag = useCallback(async (): Promise<void> => {
    if (!current) return
    const name = await prompt({ title: '新建标签', label: '标签名称（可逗号分隔多个）' })
    if (!name?.trim()) return
    const added = name
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (added.length === 0) return
    const cur = (tagsOf.get(current.id) ?? []).map((x) => x.name)
    await window.zhixing.db.setNoteTags(current.id, [...cur, ...added])
    await loadNoteTags()
    onNotice('已添加标签')
  }, [current, tagsOf, prompt, loadNoteTags, onNotice])

  /** 改标签颜色：取色器拖动会连续触发，所以先乐观更新本地两份状态，再把色值写库 */
  const setTagColor = useCallback(
    async (id: number, color: string): Promise<void> => {
      setAllTags((prev) => prev.map((x) => (x.id === id ? { ...x, color } : x)))
      setTagsOf((prev) => {
        const next = new Map<number, NoteTag[]>()
        for (const [k, list] of prev) {
          next.set(k, list.map((x) => (x.id === id ? { ...x, color } : x)))
        }
        return next
      })
      await window.zhixing.db.setTagColor(id, color)
    },
    []
  )

  return { allTags, tagsOf, currentTags, loadNoteTags, toggleTag, createTag, setTagColor }
}
