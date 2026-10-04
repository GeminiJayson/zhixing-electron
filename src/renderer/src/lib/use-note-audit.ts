import { useCallback, useState } from 'react'
import { dropLinkLine } from './note-props'

/** 一条失效链接：某篇笔记的正文里写着 [[dst_title]]，但那篇不存在 */
export interface BrokenLink {
  src_note_id: number
  src_title: string
  dst_title: string
}

/** 浮层里的一行：孤儿笔记或失效链接 */
export interface AuditItem {
  key: string
  label: string
  id: number
}

interface Options {
  onNotice: (msg: string) => void
  /** 确认框；返回 true 才继续 */
  confirm: (opts: {
    title: string
    message: string
    confirmText: string
    danger: boolean
  }) => Promise<boolean>
  /** 关掉浮层（删完一条失效链接时用） */
  onClose: () => void
}

/**
 * 链接体检：孤儿笔记、失效链接，以及「删掉这一行」的处理动作。
 *
 * 从 NotesPage 抽出来（那个文件 2429 行）。这一组自成闭环 —— 它只读整库的
 * 链接健康度，产出两个可列的清单，唯一会写库的动作是删失效链接的那一行。
 *
 * **浮层的位置（x/y）不在这里**：那是纯 UI 状态，hook 只负责"查到什么"。
 * 页面拿到结果后自己决定在哪儿展开。
 */
export function useNoteAudit({ onNotice, confirm, onClose }: Options): {
  brokenRows: BrokenLink[]
  panelItems: AuditItem[]
  /** 跑一次体检并填好清单；relink 是直接修复、不产生清单 */
  runAudit: (kind: 'orphan' | 'broken' | 'relink') => Promise<void>
  dropBrokenLink: (b: BrokenLink) => Promise<void>
} {
  /** 失效链接的原始行（面板要按它给出「删掉这一行」的动作） */
  const [brokenRows, setBrokenRows] = useState<BrokenLink[]>([])
  const [panelItems, setPanelItems] = useState<AuditItem[]>([])

  const runAudit = useCallback(
    async (kind: 'orphan' | 'broken' | 'relink'): Promise<void> => {
      /*
        relink 不是"列出来看"，它直接跑修复。
        这类链接（标题能解析到、dst_note_id 却是空）在 brokenLinks 里不算失效，
        但图谱的边与反链查询都按 id 走 —— 不修就永远看不见它。
      */
      if (kind === 'relink') {
        const n = await window.zhixing.db.relinkAllNotes()
        onNotice(n > 0 ? '已修复 ' + n + ' 条未绑定的链接' : '没有需要修复的链接')
        return
      }
      if (kind === 'orphan') {
        const rows = await window.zhixing.db.orphanNotes()
        setPanelItems(rows.map((n) => ({ key: 'o-' + n.id, label: n.title, id: n.id })))
        setBrokenRows([])
        return
      }
      const rows = await window.zhixing.db.brokenLinks()
      /*
        每条失效链接给两个动作，而不只是"跳过去"。

        跳过去只能让人自己找到那一行再手删；而失效链接的成因是
        `[[标题]]` 指向的笔记不存在 —— 要么补建那篇，要么删掉这一行。
        这里先把"删掉这一行"给出来（改的是来源笔记的正文，所以要点确认）。
      */
      const items: AuditItem[] = rows.map((b, i) => ({
        key: 'b-' + i,
        label: b.src_title + ' → [[' + b.dst_title + ']]',
        id: b.src_note_id,
      }))
      setBrokenRows(rows)
      setPanelItems(items)
    },
    [onNotice]
  )

  /**
   * 删掉一条失效链接：从**来源笔记的正文**里去掉那行 [[标题]]。
   *
   * 失效链接 = 正文里写着 [[某标题]] 但那篇笔记不存在。处理方式要么补建那篇、
   * 要么删掉这一行 —— 这里给后者。改的是别人的正文，所以先确认。
   */
  const dropBrokenLink = useCallback(
    async (b: BrokenLink): Promise<void> => {
      const ok = await confirm({
        title: '删掉这条失效链接',
        message:
          '「' + b.src_title + '」的正文里写着 [[' + b.dst_title + ']]，但这篇笔记不存在。\n' +
          '删掉会改「' + b.src_title + '」的正文。',
        confirmText: '删掉这一行',
        danger: true,
      })
      if (!ok) return
      const src = await window.zhixing.db.note(b.src_note_id)
      if (!src) return
      const next = dropLinkLine(src.content_md ?? '', b.dst_title)
      await window.zhixing.db.saveNote(b.src_note_id, { content_md: next })
      onClose()
      setBrokenRows((prev) =>
        prev.filter((r) => !(r.src_note_id === b.src_note_id && r.dst_title === b.dst_title))
      )
      onNotice('已从「' + b.src_title + '」里删掉那条链接')
    },
    [confirm, onClose, onNotice]
  )

  return { brokenRows, panelItems, runAudit, dropBrokenLink }
}
