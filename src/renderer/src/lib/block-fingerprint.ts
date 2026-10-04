/**
 * 笔记段落的「定位键」：把一个段落的内容折算成一个短标识，供任务 ↔ 段落关联使用。
 *
 * 键是**内容指纹**而不是位置索引：用户在段落前面插一段，后面所有段的序号都会变，
 * 但指纹不变 —— 关联因此不会因为"上面加了一行"全部错位。
 * sha1 前 12 位，前缀 `fp:`。
 *
 * 原先这段只活在 MarkdownEditor 里，于是只有 markdown 笔记能算键；
 * 任务编辑器那边只好让用户**手填这个键** —— 而键是内部标识符，用户无从得知，
 * 这就是"不知道怎么关联笔记段落"的根源。这一份只保留 Office 表格相关的键；
 * 段落指纹本身在 @shared，与主进程共用同一份。
 */

// sha1Hex 与 blockFingerprint 的**唯一实现**在 @shared/block-fingerprint。
//
// 这里原先各写了一份。两份今天逐字相同，但注释里都写着「定位靠它逐字一致，
// 所以规范化规则不能各写一份」—— 一份自称唯一实现的同时自己是第二份，
// 就是改一处忘另一处、段落锚定位静默失效的入口。
import { blockFingerprint, sha1Hex } from '@shared/block-fingerprint'

export { blockFingerprint, sha1Hex }

export interface NoteBlock {
  /** 段落定位键（可能为空：纯空白段不参与关联） */
  key: string
  /** 段落原文，用于列表展示 */
  text: string
  /** 段落在笔记里的序号（1 起），列表里当"第 N 段"显示 */
  index: number
}

/** 富文本 / Word 的块级元素：一个元素算一段 */
const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, pre, blockquote, td, th'

/**
 * Excel 单元格的定位键：`cell:<工作表>!<坐标>`。
 *
 * 与上面两种格式不同，Excel 笔记**在应用里拿不到内容** —— 正文在本地 .xlsx 里，
 * 应用只登记文件路径（见 NotesPage 的 editor__office--fallback）。所以单元格没法像
 * 段落那样"解析出来给用户挑"，只能让用户从系统应用里看着填。
 * 好在单元格地址本身就是稳定标识（B3 就是 B3），不需要内容指纹。
 *
 * 工作表名可省略（默认第一张），但**必须带上 `!`** 才不会和纯坐标混淆。
 */
export function cellKey(sheet: string, ref: string): string {
  const s = sheet.replace(/[!]/g, '').trim()
  const r = ref.trim().toUpperCase().replace(/\s+/g, '')
  if (!r) return ''
  return s ? `cell:${s}!${r}` : `cell:${r}`
}

/** 校验单元格坐标（A1 / $B$3 / AA10 都算合法） */
export function isCellRef(ref: string): boolean {
  return /^\$?[A-Z]{1,3}\$?[0-9]{1,7}$/.test(ref.trim().toUpperCase())
}

/** 校验工作表名（Excel 里不允许 : \ / ? * [ ]） */
export function isSheetName(name: string): boolean {
  const s = name.trim()
  return s.length > 0 && s.length <= 31 && !/[:\\/?*\[\]]/.test(s)
}

/**
 * 把一篇笔记的内容切成「可关联的段落」。
 *
 * 两种格式的段落定义不同，各自贴合它自己的真相：
 *   · markdown —— **一行一段**。这与 locateBlockInView 的定位口径一致
 *     （它同样按行扫描、逐行算指纹），改这里必须同时改那边，否则"关联上了却跳不过去"。
 *   · 富文本 / Word —— HTML 的**块级元素**。取 textContent 再算指纹，
 *     与段落文本无关的标签（span / strong 等行内标记）不影响结果。
 *
 * 空白段落一律跳过：它们的指纹是空串，关联了也没有意义。
 */
export function listNoteBlocks(format: string, content: string): NoteBlock[] {
  const out: NoteBlock[] = []
  const push = (raw: string): void => {
    const text = raw.replace(/\s+/g, ' ').trim()
    if (!text) return
    const key = blockFingerprint(text)
    if (!key) return
    out.push({ key, text, index: out.length + 1 })
  }

  /**
   * 链接笔记：content_md 是 `[{title,target}]`，**每条链接就是一项**。
   *
   * 键按 **target（URL）** 算而不是标题：标题是给人看的、随时会改，
   * URL 才是这条链接的身份。用标题做键的话，用户改个标题关联就全断了。
   */
  if (format === 'link') {
    try {
      const items: unknown = JSON.parse(content || '[]')
      if (Array.isArray(items)) {
        for (const raw of items) {
          if (!raw || typeof raw !== 'object') continue
          const o = raw as { title?: unknown; target?: unknown }
          const target = String(o.target ?? '').trim()
          if (!target) continue
          const key = blockFingerprint(target)
          if (!key) continue
          const title = String(o.title ?? '').trim()
          out.push({ key, text: title ? `${title} — ${target}` : target, index: out.length + 1 })
        }
        if (out.length) return out
      }
    } catch {
      // 不是合法 JSON（历史数据可能存了纯文本），落到下面的按行处理
    }
  }

  if (format === 'richtext' || format === 'word') {
    // DOMParser 在渲染层可用；解析失败（内容不是 HTML）时退回按行处理
    try {
      const doc = new DOMParser().parseFromString(content || '', 'text/html')
      const els = doc.body.querySelectorAll(BLOCK_SELECTOR)
      if (els.length) {
        els.forEach((el) => push(el.textContent ?? ''))
        return out
      }
    } catch {
      // 落到下面的按行处理
    }
  }
  for (const line of (content || '').split('\n')) push(line)
  return out
}
