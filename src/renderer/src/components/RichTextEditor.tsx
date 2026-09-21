import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import TextAlign from '@tiptap/extension-text-align'
import Placeholder from '@tiptap/extension-placeholder'
import { useDialog } from './Dialogs'

interface RichProps {
  html: string
  onChange: (html: string) => void
  readOnly?: boolean
  placeholder?: string
  onCommit?: (html: string) => void
  /** 插入图片时要把原图存成这篇笔记的附件 */
  noteId?: number
}

/** 缩略图长边上限（px）：正文里只放这个，原图另存附件。 */
const THUMB_MAX = 360

/**
 * 图片节点扩展：多带一个 attachment 属性，记下原图在附件里的落盘路径。
 *
 * 正文里存的是**缩略图**（data URI，几百像素），原图走附件接口存到数据目录 ——
 * 这样一篇笔记里放几十张图也不会把 HTML 撑成几兆，滚动与输入就不会卡。
 */
const ImageWithAttach = Image.extend({
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

/** 生成缩略图的 data URI。createImageBitmap 比 <img> + onload 稳，也不占用 DOM。 */
async function makeThumb(file: File, max = THUMB_MAX): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.82)
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsDataURL(file)
  })
}

/**
 * 所见即所得富文本编辑器 —— 内核是 **TipTap**（ProseMirror）。
 *
 * 旧实现是 contentEditable + document.execCommand，而 execCommand 已被标准废弃，
 * 只有 Chromium 还在兼容。工具栏 16 个按钮现在全部走 TipTap 的正式命令。
 *
 * 存储格式不变：正文仍是 HTML 片段，已有笔记零迁移。图片按需求改成「正文缩略图 +
 * 原图存附件」，双击图片可以用原图预览。
 */
export function RichTextEditor({ html, onChange, readOnly = false, placeholder, onCommit, noteId }: RichProps) {
  const dialog = useDialog()
  const commitTimer = useRef<number | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  // onUpdate 是创建时闭包进去的，读 props 会拿到旧值 —— 用 ref 兜住
  const emitRef = useRef<(v: string) => void>(() => undefined)
  emitRef.current = (value: string) => {
    onChange(value)
    if (commitTimer.current) window.clearTimeout(commitTimer.current)
    commitTimer.current = window.setTimeout(() => onCommit?.(value), 800)
  }
  const noteIdRef = useRef(noteId)
  noteIdRef.current = noteId

  const editor = useEditor({
    editable: !readOnly,
    extensions: [
      // StarterKit 已含 bold / italic / strike / underline / heading / 两种列表 /
      // codeBlock / blockquote / link，不必再单独装。
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true } }),
      ImageWithAttach.configure({ inline: false, allowBase64: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: placeholder ?? '' }),
    ],
    content: html || '',
    onUpdate: ({ editor: ed }) => emitRef.current(ed.getHTML()),
  })

  useEffect(() => {
    editor?.setEditable(!readOnly)
  }, [editor, readOnly])

  useEffect(() => {
    if (!editor || editor.isFocused) return
    const next = html || ''
    if (editor.getHTML() === next) return
    editor.commands.setContent(next, { emitUpdate: false })
  }, [editor, html])

  useEffect(
    () => () => {
      if (commitTimer.current) window.clearTimeout(commitTimer.current)
    },
    []
  )

  // 双击图片用原图预览（正文里是缩略图，看细节时再看原图）
  useEffect(() => {
    const root = editor?.view.dom as HTMLElement | undefined
    if (!root) return
    const onDbl = (e: MouseEvent): void => {
      const img = (e.target as HTMLElement | null)?.closest('img')
      const attach = img?.getAttribute('data-attachment')
      if (!attach) return
      e.preventDefault()
      // 附件存的是绝对路径，file:// 直接能读；路径里的空格等要转义
      setPreview('file://' + attach.split('/').map(encodeURIComponent).join('/'))
    }
    root.addEventListener('dblclick', onDbl)
    return () => root.removeEventListener('dblclick', onDbl)
  }, [editor])

  if (!editor) return <div className="rt-editor" />

  const chain = (): ReturnType<Editor['chain']> => editor.chain().focus()
  const btn = (label: string, active: boolean, onClick: () => void, title: string): JSX.Element => (
    <button
      key={label}
      type="button"
      className={'tb' + (active ? ' tb--on' : '')}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  )

  const insertLink = async (): Promise<void> => {
    const url = await dialog.prompt({ title: '插入链接', label: '网址或本地文件路径' })
    if (!url?.trim()) return
    let target = url.trim()
    if (!/^(https?:|file:)/i.test(target)) target = 'https://' + target
    const text = await dialog.prompt({ title: '插入链接', label: '显示文字', defaultValue: target })
    if (text === null) return
    const label2 = text.trim() || target
    if (editor.state.selection.empty) chain().insertContent('<a href="' + target + '">' + label2 + '</a>').run()
    else chain().extendMarkRange('link').setLink({ href: target }).run()
  }

  const insertImage = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      void (async () => {
        for (const file of files) {
          const [full, thumb] = await Promise.all([readAsDataUrl(file), makeThumb(file)])
          const id = noteIdRef.current
          let path = ''
          if (id) {
            const base64 = full.slice(full.indexOf(',') + 1)
            const saved = await window.zhixing.db.saveAttachmentData(id, file.name, base64)
            path = saved?.path ?? ''
          }
          chain()
            .insertContent({
              type: 'image',
              attrs: { src: thumb || full, alt: file.name, attachment: path || null },
            })
            .run()
        }
      })()
    }
    input.click()
  }

  return (
    <div className="rt-editor">
      {!readOnly && (
        <div className="rt-editor__bar" role="toolbar" aria-label="格式工具">
          {btn('B', editor.isActive('bold'), () => chain().toggleBold().run(), '加粗')}
          {btn('I', editor.isActive('italic'), () => chain().toggleItalic().run(), '斜体')}
          {btn('U', editor.isActive('underline'), () => chain().toggleUnderline().run(), '下划线')}
          {btn('S', editor.isActive('strike'), () => chain().toggleStrike().run(), '删除线')}
          {btn('H1', editor.isActive('heading', { level: 1 }), () => chain().toggleHeading({ level: 1 }).run(), '一级标题')}
          {btn('H2', editor.isActive('heading', { level: 2 }), () => chain().toggleHeading({ level: 2 }).run(), '二级标题')}
          {btn('H3', editor.isActive('heading', { level: 3 }), () => chain().toggleHeading({ level: 3 }).run(), '三级标题')}
          {btn('•', editor.isActive('bulletList'), () => chain().toggleBulletList().run(), '无序列表')}
          {btn('1.', editor.isActive('orderedList'), () => chain().toggleOrderedList().run(), '有序列表')}
          {btn('❝', editor.isActive('blockquote'), () => chain().toggleBlockquote().run(), '引用')}
          {btn('<>', editor.isActive('codeBlock'), () => chain().toggleCodeBlock().run(), '代码块')}
          {btn('⬅', editor.isActive({ textAlign: 'left' }), () => chain().setTextAlign('left').run(), '左对齐')}
          {btn('↔', editor.isActive({ textAlign: 'center' }), () => chain().setTextAlign('center').run(), '居中')}
          {btn('➡', editor.isActive({ textAlign: 'right' }), () => chain().setTextAlign('right').run(), '右对齐')}
          {btn('🔗', editor.isActive('link'), () => void insertLink(), '插入链接')}
          {btn('🖼', false, insertImage, '插入图片（正文存缩略图，原图存附件）')}
        </div>
      )}
      <EditorContent className="rt-editor__body" editor={editor} />
      {preview && (
        <div
          className="rt-preview"
          role="dialog"
          aria-label="图片预览"
          onClick={() => setPreview(null)}
        >
          <img className="rt-preview__img" src={preview} alt="原图预览" />
        </div>
      )}
    </div>
  )
}

export { RichTextEditor as default }
