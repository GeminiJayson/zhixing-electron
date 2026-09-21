import { useEffect, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
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
}

/**
 * 所见即所得富文本编辑器 —— 内核换成 **TipTap**（ProseMirror）。
 *
 * 为什么换：旧实现是 contentEditable + document.execCommand，而 execCommand 已被标准废弃，
 * 只有 Chromium 还在兼容；工具栏的命令、选区还原、粘贴清理都得自己兜。TipTap 把这些
 * 都做成了正式 API（chain().focus().toggleBold().run() 这类），工具栏完全用它的命令。
 *
 * 存储格式不变：正文仍是 HTML 片段（html 进、onChange 出），**已有笔记一条都不用迁移**。
 *
 * 已知的下一步（图片缩略图）：现在插入的图片仍是 data URI 内嵌在正文里，文档一大就会卡；
 * 后续会改成「正文只放缩略图 + 原图另存为附件」，那一步要配一个存二进制的附件接口。
 */
export function RichTextEditor({ html, onChange, readOnly = false, placeholder, onCommit }: RichProps) {
  const dialog = useDialog()
  const commitTimer = useRef<number | null>(null)
  // onUpdate 是在编辑器创建时闭包进去的，读 props 会拿到旧值 —— 用 ref 兜住
  const emitRef = useRef<(v: string) => void>(() => undefined)
  emitRef.current = (value: string) => {
    onChange(value)
    if (commitTimer.current) window.clearTimeout(commitTimer.current)
    commitTimer.current = window.setTimeout(() => onCommit?.(value), 800)
  }

  const editor = useEditor({
    editable: !readOnly,
    extensions: [
      // StarterKit 已含 bold / italic / strike / underline / heading / 两种列表 /
      // codeBlock / blockquote / link 等，不必再单独装；只配我们需要的参数。
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true },
      }),
      Image.configure({ inline: false, allowBase64: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: placeholder ?? '' }),
    ],
    content: html || '',
    onUpdate: ({ editor: ed }) => emitRef.current(ed.getHTML()),
  })

  // 只读切换（同一篇笔记在编辑态与预览态之间来回时不需要重建编辑器）
  useEffect(() => {
    editor?.setEditable(!readOnly)
  }, [editor, readOnly])

  // 外部换笔记时才重置内容；用户正在输入时不动，否则光标会跳
  useEffect(() => {
    if (!editor) return
    if (editor.isFocused) return
    const next = html || ''
    if (editor.getHTML() === next) return
    editor.commands.setContent(next, { emitUpdate: false })
  }, [editor, html])

  // 卸载时把还没落盘的内容补交一次
  useEffect(
    () => () => {
      if (commitTimer.current) window.clearTimeout(commitTimer.current)
    },
    []
  )

  if (!editor) return <div className="rt-editor" />

  const chain = () => editor.chain().focus()
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
    // 有选区时给选中的文字套链接，没有则插入一段带链接的文字
    if (editor.state.selection.empty) {
      chain().insertContent(`<a href="${target}">${label2}</a>`).run()
    } else {
      chain().extendMarkRange('link').setLink({ href: target }).run()
    }
  }

  const insertImage = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      // NOTE: 仍走 data URI。缩略图 + 附件方案是下一步，见文件头的说明。
      reader.onload = () => chain().setImage({ src: String(reader.result ?? '') }).run()
      reader.readAsDataURL(file)
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
          {btn('🖼', false, insertImage, '插入图片')}
        </div>
      )}
      <EditorContent className="rt-editor__body" editor={editor} />
    </div>
  )
}
