import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import TextAlign from '@tiptap/extension-text-align'
import Placeholder from '@tiptap/extension-placeholder'
import FontSize from '@tiptap/extension-text-style/font-size'
import Color from '@tiptap/extension-color'
import { attachmentUrl } from '@shared/attachment-url'
import { Toolbar } from './Toolbar'
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
      FontSize,
      Color,
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
      // 附件存的是绝对路径。旧写法在 Windows 反斜杠路径下产出无效 URL
      // （file://C%3A%5C...，new URL() 报 Invalid URL），统一走 shared/attachment-url.ts
      setPreview(attachmentUrl(attach))
    }
    root.addEventListener('dblclick', onDbl)
    return () => root.removeEventListener('dblclick', onDbl)
  }, [editor])

  if (!editor) return <div className="rt-editor" />

  const chain = (): ReturnType<Editor['chain']> => editor.chain().focus()
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

  /** 插入文件附件：沿用旧的 attachment:pick，把它挂成一段链接文字。 */
  const insertFile = async (): Promise<void> => {
    const id = noteIdRef.current
    if (!id) return
    const res = await window.zhixing.db.pickAttachment(id)
    const paths = (res?.paths ?? []) as string[]
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop() ?? p
      const url = attachmentUrl(p)
      chain().insertContent('<a href="' + url + '">' + name + '</a>').run()
    }
  }

  const insertImage = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      void (async () => {
        // 先本地读取（不碰 IPC），再一次性存附件，最后统一插入。
        // 原先是循环里逐张读 + 逐张 IPC：第 N 张失败时前 N-1 张已经落盘落库了。
        const prepared: { file: File; full: string; thumb: string }[] = []
        for (const file of files) {
          const [full, thumb] = await Promise.all([readAsDataUrl(file), makeThumb(file)])
          prepared.push({ file, full, thumb })
        }
        const id = noteIdRef.current
        const saved = id
          ? await window.zhixing.db.saveAttachmentsBatch(
              id,
              prepared.map((p) => ({
                fileName: p.file.name,
                base64: p.full.slice(p.full.indexOf(',') + 1),
              }))
            )
          : []
        prepared.forEach((p, i) => {
          chain()
            .insertContent({
              type: 'image',
              attrs: { src: p.thumb || p.full, alt: p.file.name, attachment: saved[i]?.path || null },
            })
            .run()
        })
      })()
    }
    input.click()
  }

  return (
    <div className="rt-editor">
      {!readOnly && (
        <Toolbar
          variant="panel"
          sticky={false}
          filters={[
            <select
              key="size"
              className="field field--compact"
              title="字号"
              aria-label="字号"
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value
                if (v) chain().setFontSize(v + 'px').run()
                e.target.value = ''
              }}
            >
              <option value="">字号</option>
              {[12, 14, 16, 18, 20, 24, 28].map((sz) => (
                <option key={sz} value={String(sz)}>
                  {sz}
                </option>
              ))}
            </select>,
            <input
              key="color"
              type="color"
              title="文字颜色"
              aria-label="文字颜色"
              onChange={(e) => chain().setColor(e.target.value).run()}
            />,
          ]}
          secondary={[
            <button key="b" className="text-btn" title="加粗" onClick={() => chain().toggleBold().run()}>
              B
            </button>,
            <button key="i" className="text-btn" title="斜体" onClick={() => chain().toggleItalic().run()}>
              I
            </button>,
            <button key="u" className="text-btn" title="下划线" onClick={() => chain().toggleUnderline().run()}>
              U
            </button>,
            <button key="s" className="text-btn" title="删除线" onClick={() => chain().toggleStrike().run()}>
              S
            </button>,
            ...[1, 2, 3].map((lv) => (
              <button
                key={'h' + lv}
                className="text-btn"
                title={lv + ' 级标题'}
                onClick={() => chain().toggleHeading({ level: lv as 1 | 2 | 3 }).run()}
              >
                H{lv}
              </button>
            )),
            <button key="ul" className="text-btn" title="无序列表" onClick={() => chain().toggleBulletList().run()}>
              • 列表
            </button>,
            <button key="ol" className="text-btn" title="有序列表" onClick={() => chain().toggleOrderedList().run()}>
              1. 列表
            </button>,
            <button key="q" className="text-btn" title="引用" onClick={() => chain().toggleBlockquote().run()}>
              引用
            </button>,
            <button key="code" className="text-btn" title="代码块" onClick={() => chain().toggleCodeBlock().run()}>
              代码
            </button>,
            <button key="jl" className="text-btn" title="左对齐" onClick={() => chain().setTextAlign('left').run()}>
              左
            </button>,
            <button key="jc" className="text-btn" title="居中" onClick={() => chain().setTextAlign('center').run()}>
              中
            </button>,
            <button key="jr" className="text-btn" title="右对齐" onClick={() => chain().setTextAlign('right').run()}>
              右
            </button>,
            <button key="link" className="text-btn" title="插入链接" onClick={() => void insertLink()}>
              链接
            </button>,
            <button key="img" className="text-btn" title="插入图片" onClick={insertImage}>
              图片
            </button>,
            <button key="file" className="text-btn" title="插入文件附件" onClick={() => void insertFile()}>
              文件
            </button>,
          ]}
        />
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
