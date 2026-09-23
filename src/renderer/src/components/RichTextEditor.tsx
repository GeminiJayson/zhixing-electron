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
async function makeThumb(source: ImageBitmapSource, max = THUMB_MAX): Promise<string> {
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

/** 载入一张已经存在于正文里的图片（data URI / 附件地址都行）。失败返回 null。 */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    // 用 createElement 而不是 new Image()：本文件里的 Image 是 TipTap 的图片扩展
    const im = document.createElement('img')
    im.onload = () => resolve(im)
    im.onerror = () => resolve(null)
    im.src = src
  })
}

/** data URI 的图片类型 → 附件文件名后缀（只影响附件的 kind 展示）。 */
function extOfDataUrl(src: string): string {
  const mime = (/^data:image\/([a-z0-9.+-]+)/i.exec(src)?.[1] ?? 'png').toLowerCase()
  return mime === 'jpeg' ? 'jpg' : mime
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
  /** 已经收过缩略图的旧图 src（StrictMode 会把 effect 跑两遍，不加这个就会存两份附件） */
  const legacyBusy = useRef<Set<string>>(new Set())
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

  /**
   * 旧笔记里的图片就地收一次缩略图。
   *
   * 早期版本的正文里嵌的是**原图** data URI（那时还没有「缩略图 + 附件」这一步），
   * 一篇带几张照片的笔记正文能有几兆，输入与滚动都跟着卡。载入时顺手收：长边超限的
   * 生成缩略图、原图落成附件，img 换成「缩略图 + data-attachment」。
   * 本来就小的（≤ 上限）不动 —— 它已经是缩略图了。
   *
   * 幂等：换过之后 src 不再是原图、attachment 也非空，第二次运行找不到目标。
   * 附件存失败就整张跳过：宁可正文大一点，也不能把用户唯一的原图换成糊图。
   */
  useEffect(() => {
    const id = noteId
    const ed = editor
    if (!ed || !id || readOnly) return
    let alive = true
    void (async () => {
      // 先收集：生成缩略图是异步的，用户中途还在编辑，所以最后按 src 重新定位节点
      const targets: string[] = []
      ed.state.doc.descendants((node) => {
        if (node.type.name !== 'image') return
        const src = String(node.attrs.src ?? '')
        if (!src.startsWith('data:image') || node.attrs.attachment) return
        if (!targets.includes(src)) targets.push(src)
      })
      // 循环里只做画布运算，IPC 放到循环外**一次批量**存：逐张存时第 N 张失败会让
      // 前 N-1 张已经落盘，顺序一致性也就落到了渲染层（架构约束盯着这条）
      const jobs: { src: string; thumb: string }[] = []
      for (const src of targets) {
        if (legacyBusy.current.has(src)) continue
        legacyBusy.current.add(src)
        const im = await loadImage(src)
        if (!im || !im.naturalWidth) continue
        if (Math.max(im.naturalWidth, im.naturalHeight) <= THUMB_MAX) continue
        const thumb = await makeThumb(im)
        if (thumb) jobs.push({ src, thumb })
      }
      if (!alive || jobs.length === 0) return
      const saved = await window.zhixing.db.saveAttachmentsBatch(
        id,
        jobs.map((j) => ({
          fileName: `legacy-image.${extOfDataUrl(j.src)}`,
          base64: j.src.slice(j.src.indexOf(',') + 1),
        }))
      )
      const replaced = new Map<string, { thumb: string; path: string }>()
      jobs.forEach((j, i) => {
        const one = saved[i]
        if (one?.ok && one.path) replaced.set(j.src, { thumb: j.thumb, path: one.path })
      })
      if (!alive || replaced.size === 0) return
      const tr = ed.state.tr
      let changed = false
      ed.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'image') return
        const hit = replaced.get(String(node.attrs.src ?? ''))
        if (!hit || node.attrs.attachment) return
        // 只换 attrs：image 是定尺的块级原子节点，文档尺寸不变，遍历拿到的 pos 仍然有效
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: hit.thumb, attachment: hit.path })
        changed = true
      })
      if (changed) ed.view.dispatch(tr)
    })()
    return () => {
      alive = false
    }
  }, [editor, noteId, readOnly, html])

  /**
   * 双击 / 空格预览原图（正文里是缩略图，看细节时再看原图）。
   *
   * 旧图没有 data-attachment（那时还没存附件），此时就用它自己的 src 预览 ——
   * 此前「没有 attachment 直接 return」，于是所有旧笔记的图片都点不开。
   * 空格只在**图片被选中**时才是预览：其它时候空格就是输入一个空格。
   */
  useEffect(() => {
    const ed = editor
    if (!ed) return
    const root = ed.view.dom as HTMLElement
    const open = (attach: string | null, src: string): void => {
      // 附件存的是绝对路径。旧写法在 Windows 反斜杠路径下产出无效 URL
      // （file://C%3A%5C...，new URL() 报 Invalid URL），统一走 shared/attachment-url.ts
      setPreview(attach ? attachmentUrl(attach) : src)
    }
    const onDbl = (e: MouseEvent): void => {
      const img = (e.target as HTMLElement | null)?.closest('img')
      if (!img) return
      e.preventDefault()
      open(img.getAttribute('data-attachment'), img.currentSrc || img.src)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== ' ' && e.key !== 'Enter') return
      const sel = ed.state.selection as unknown as {
        node?: { type: { name: string }; attrs: Record<string, unknown> }
      }
      const node = sel.node
      if (!node || node.type.name !== 'image') return
      // 捕获阶段先拦下：否则 ProseMirror 会把这个空格当成「用空格替换选中的图片」
      e.preventDefault()
      e.stopPropagation()
      open(
        node.attrs.attachment ? String(node.attrs.attachment) : null,
        String(node.attrs.src ?? '')
      )
    }
    root.addEventListener('dblclick', onDbl)
    root.addEventListener('keydown', onKey, true)
    return () => {
      root.removeEventListener('dblclick', onDbl)
      root.removeEventListener('keydown', onKey, true)
    }
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
