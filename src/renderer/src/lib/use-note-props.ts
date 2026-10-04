import { useCallback, useEffect, useState } from 'react'
import { parsePropsText, propsToText } from './note-props'

interface Options {
  /** 当前笔记；null 时一切操作都不落库 */
  noteId: number | null
  /** 当前笔记的 props（JSON 对象字符串），来自 current?.props —— 可能为 null */
  rawProps: string | null | undefined
  /** 保存后重查（上层传 load） */
  onSaved: () => Promise<void>
  onNotice: (msg: string) => void
}

/**
 * 笔记属性的一组状态与操作。
 *
 * 从 NotesPage 抽出来（那个文件 2465 行）。抽它的理由是**这一组状态自成闭环**：
 * 一份草稿文本（`draft`）就是唯一真相，`propItems` / `count` 都是它的只读派生，
 * 增删都走"改草稿 → 立刻保存"。它不需要知道编辑器、链接、标签的任何事情。
 *
 * 外部只需要在装载笔记时把它喂进来（`rawProps` 变化即重置草稿），
 * 以及提供两个回调（保存后重查、发提示）。
 */
export function useNoteProps({ noteId, rawProps, onSaved, onNotice }: Options): {
  propItems: { key: string; value: string }[]
  propCount: number
  propNew: string
  setPropNew: (v: string) => void
  addProp: () => void
  removeProp: (key: string) => void
} {
  /** 每行一条 key: value 的草稿文本。**唯一真相** —— 其余都是它的派生视图。 */
  const [draft, setDraft] = useState('')
  /** 底部新增行里正在输入的内容 */
  const [propNew, setPropNew] = useState('')

  // 装载笔记（或它被别处改写）时重置草稿
  useEffect(() => {
    setDraft(propsToText(rawProps))
  }, [rawProps])

  /** 属性列表：草稿的只读视图 */
  const propItems = draft
    .split('\n')
    .map((line) => {
      const i = line.indexOf(':')
      if (i <= 0) return null
      const k = line.slice(0, i).trim()
      if (!k) return null
      return { key: k, value: line.slice(i + 1).trim() }
    })
    .filter((x): x is { key: string; value: string } => x !== null)

  /** 改属性都落到草稿并**立刻保存** —— 不让用户改完还得再点一次保存 */
  const writeProps = useCallback(
    async (lines: string[]): Promise<void> => {
      const text = lines.join('\n')
      setDraft(text)
      if (noteId == null) return
      await window.zhixing.db.saveNote(noteId, { props: parsePropsText(text) })
      await onSaved()
    },
    [noteId, onSaved]
  )

  const addProp = useCallback((): void => {
    const raw = propNew.trim()
    if (!raw) return
    // 允许只写键（"来源"）不写值 —— 先把位置占下来也是常见用法
    const line = raw.includes(':') ? raw : raw + ': '
    void writeProps(propItems.map((p) => p.key + ': ' + p.value).concat(line)).then(() =>
      setPropNew('')
    )
  }, [propNew, propItems, writeProps])

  const removeProp = useCallback(
    (key: string): void => {
      void writeProps(propItems.filter((p) => p.key !== key).map((p) => p.key + ': ' + p.value))
    },
    [propItems, writeProps]
  )

  const propCount = draft.split('\n').filter((l) => l.trim()).length

  // onNotice 目前只在保存路径上用得到，保留参数以便将来提示"已保存属性"
  void onNotice

  return { propItems, propCount, propNew, setPropNew, addProp, removeProp }
}
