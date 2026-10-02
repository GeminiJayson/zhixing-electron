/**
 * 富文本编辑器里「多媒体」那部分能力的共享实现：图片的读取、落盘、粘贴与拖放。
 *
 * **为什么必须共享**：笔记页的编辑器（RichTextEditor）与快速笔记浮窗（QuickNotePanel）
 * 各自建了一个 Tiptap editor。粘贴处理如果只写在其中一个里，另一个就是坏的 ——
 * 用户报的「快速笔记不支持粘贴图片」正是这么来的。
 * 项目在工具栏上已经吃过一次同样的亏（RichTextToolbar 的注释：复制一份的话，
 * 以后调样式就得改两处，迟早会不一致），这里沿用同一条判断。
 */
import type { Editor } from '@tiptap/react'

export interface PreparedImage {
  file: File
  /** 原图 data URI（落盘用） */
  full: string
  /** 缩略图 data URI（文档里显示的就是它） */
  thumb: string
}

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => resolve('')
    reader.readAsDataURL(file)
  })
}

/** 生成缩略图的 data URI。createImageBitmap 比 img+onload 稳，也不占用 DOM。 */
export async function makeThumb(source: ImageBitmapSource, max = 480): Promise<string> {
  try {
    const bitmap = await createImageBitmap(source)
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close?.()
    return canvas.toDataURL('image/webp', 0.8)
  } catch {
    // 浏览器不支持 webp 或图片解不开：返回空串，调用方回退到原图
    return ''
  }
}

/**
 * 把一批图片文件落盘并插入编辑器。
 *
 * **粘贴、拖放、选文件三条路都走这里** —— 落盘逻辑只能有一份。
 * 粘贴若另写一遍，很容易漏掉「批量存附件」那一步，于是图片变成 base64
 * 直接写进文档，数据库被悄悄撑大。
 *
 * noteId 为空时（比如快速笔记还没落成笔记）不会落盘，只插入缩略图 ——
 * 这点是刻意的：宁可图先显示出来、之后再转存，也不要因为「还没有 id」就什么都不做。
 */
export async function insertImageFiles(
  editor: Editor | null,
  files: File[],
  noteId: number | undefined
): Promise<void> {
  if (!editor || !files.length) return
  const prepared: PreparedImage[] = []
  for (const file of files) {
    const [full, thumb] = await Promise.all([readAsDataUrl(file), makeThumb(file)])
    prepared.push({ file, full, thumb })
  }
  const saved = noteId
    ? await window.zhixing.db.saveAttachmentsBatch(
        noteId,
        prepared.map((p) => ({
          fileName: p.file.name,
          base64: p.full.slice(p.full.indexOf(',') + 1),
        }))
      )
    : []
  prepared.forEach((p, i) => {
    editor
      .chain()
      .insertContent({
        type: 'image',
        attrs: {
          src: p.thumb || p.full,
          alt: p.file.name,
          attachment: saved[i]?.path || '',
        },
      })
      .run()
  })
}

/**
 * 生成粘贴与拖放的 editorProps。
 *
 * 只拦「剪贴板里确实有图片文件」的情况，其余（纯文本、HTML、表格）一律返回 false
 * 交给 Tiptap 自己处理 —— 表格能贴进来是因为编辑器注册了 TableKit。
 */
export function imagePasteProps(
  getEditor: () => Editor | null,
  getNoteId: () => number | undefined
): {
  handlePaste: (view: unknown, event: ClipboardEvent) => boolean
  handleDrop: (view: unknown, event: DragEvent) => boolean
} {
  const grab = (files: FileList | undefined | null): File[] =>
    Array.from(files ?? []).filter((f) => f.type.startsWith('image/'))
  return {
    handlePaste: (_view, event) => {
      const files = grab(event.clipboardData?.files)
      if (!files.length) return false
      event.preventDefault()
      void insertImageFiles(getEditor(), files, getNoteId())
      return true
    },
    handleDrop: (_view, event) => {
      const files = grab(event.dataTransfer?.files)
      if (!files.length) return false
      event.preventDefault()
      void insertImageFiles(getEditor(), files, getNoteId())
      return true
    },
  }
}
