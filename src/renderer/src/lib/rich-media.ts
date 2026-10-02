import type { Editor } from '@tiptap/react'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table/kit'

/**
 * 图片节点：正文里存缩略图（data URI），原图走附件接口存到数据目录。
 * 这样一篇笔记放几十张图也不会把 HTML 撑成几兆。
 * data-attachment 指回附件路径，点击预览时用它取原图。
 */
export const ImageWithAttach = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      attachment: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-attachment'),
        renderHTML: (attrs) =>
          attrs.attachment ? { 'data-attachment': String(attrs.attachment) } : {},
      },
    }
  },
})

/**
 * 两个编辑器都必须注册的媒体扩展。
 *
 * 抽成数组是有教训的：上一版只抽了粘贴与落盘的逻辑，没抽扩展注册，
 * 结果快速笔记的 editor 里没有 image 节点类型 —— 粘贴时全链路都跑通了
 *（文件读到、缩略图生成、附件走完），最后一步 insertContent 被 Tiptap 判为
 * Unknown node type: image 静默拒绝，文档里什么都不出现。
 *
 * 以后再往编辑器加媒体能力，在这里加一次，笔记页与快速笔记同时生效。
 */
export const RICH_MEDIA_EXTENSIONS = [
  ImageWithAttach.configure({ inline: false, allowBase64: true }),
  TableKit.configure({ table: { resizable: true } }),
]

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

/** 生成缩略图。createImageBitmap 比 img+onload 稳，也不占用 DOM。 */
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
    return ''
  }
}
/**
 * 把一批图片文件落盘并插入编辑器。粘贴、拖放、选文件三条路都走这里。
 * noteId 为空时（快速笔记还没落成笔记）不落盘，只插缩略图 ——
 * 宁可图先显示出来，也不要因为还没有 id 就什么都不做。
 */
export async function insertImageFiles(
  editor: Editor | null,
  files: File[],
  noteId: number | undefined
): Promise<void> {
  if (!editor) {
    console.warn('[rich-media] editor 为空，editorRef 还没拿到实例')
    return
  }
  if (!files.length) return
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
 * 只拦剪贴板里确实有图片文件的情况，其余（纯文本、HTML、表格）返回 false
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
