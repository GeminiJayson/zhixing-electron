import { useEffect, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TextAlign from '@tiptap/extension-text-align'
import Placeholder from '@tiptap/extension-placeholder'
import { TextStyle } from '@tiptap/extension-text-style'
import FontSize from '@tiptap/extension-text-style/font-size'
import Color from '@tiptap/extension-color'
import { CodeBlockLanguage } from './CodeBlockLanguage'
import { RichTextToolbar } from './RichTextToolbar'
import { RICH_MEDIA_EXTENSIONS } from '@renderer/lib/rich-media'

/**
 * 「写总结」的编辑区 —— **复用快速笔记那套 tiptap**（同一份扩展 + 同一条工具栏）。
 *
 * 为什么不直接内嵌 QuickNotePanel：那个面板还带着多条目列表、归档、透明度、拖拽调尺寸，
 * 而这里只要「一块能写富文本的地方」。扩展与工具栏是真正要复用的部分，
 * 缺一个扩展的后果很具体（缺 ImageWithAttach 粘图会被静默拒绝、缺 TableKit 表格退化成纯文本）。
 *
 * 触发方式是全局事件 `zhixing:summary`：总结是从**勾选框**发起的，
 * 那里不在任务编辑器内部，没法直接渲染这个组件 —— 由 App 挂一份监听。
 *
 * 保存 = 落库知识库（新建 richtext 笔记）+ 关联任务 + 把任务标记完成。
 * 不塞任务备注：那样搜不到、引用不了、图谱里也看不见。
 */
export interface SummaryJob {
  taskId: number
  taskTitle: string
}

/**
 * **受控**组件：job 由 App 持有并传进来。
 *
 * 为什么不自己监听 `zhixing:summary`：踩过——监听的 effect 挂在**已被卸载的实例**上时，
 * 它调用的 setState 会被 React 静默忽略（诊断值：setJob 记到了 269，而每次渲染读到的 job 仍是 null，
 * 控制台一句报错都没有）。宿主是 App，状态就该放在 App —— 它不会变成幽灵实例。
 */
export function SummaryEditor({ job, onClose }: { job: SummaryJob | null; onClose: () => void }): React.JSX.Element | null {
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)

  const editor = useEditor({
    extensions: [
      StarterKit,
      TextStyle,
      FontSize,
      Color,
      ...RICH_MEDIA_EXTENSIONS,
      CodeBlockLanguage,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: '写点结论、要点、后续动作…' }),
    ],
    content: '',
    editorProps: { attributes: { class: 'sum__body' } },
  })

  // 每个任务进来时清一次旧内容（浮层是复用的，不重建编辑器）
  useEffect(() => {
    setMsg('')
    try {
      editor?.commands.clearContent()
    } catch {
      // 编辑器实例已失效：浮层照样要开，清不掉旧内容而已
    }
  }, [editor, job?.taskId])


  // 诊断：组件到底渲染了几次、最新一次拿到的 job 是什么
  ;(window as unknown as Record<string, unknown>).__z_render =
    (Number((window as unknown as Record<string, unknown>).__z_render) || 0) + 1
  ;(window as unknown as Record<string, unknown>).__z_job = job ? job.taskId : null

  if (!job) return null

  /** 关闭并把任务标记完成（写没写总结都要完成它 —— 用户点的是勾选框）。 */
  const finish = async (): Promise<void> => {
    const id = job.taskId
    onClose()
    await window.zhixing.db.toggleTask(id)
  }

  const save = async (): Promise<void> => {
    if (!editor) return
    const html = editor.getHTML()
    if (!editor.getText().trim()) {
      setMsg('还没写内容')
      return
    }
    setSaving(true)
    try {
      const stamp = new Date().toISOString().slice(0, 10)
      const title = `总结 · ${job.taskTitle}（${stamp}）`
      const note = await window.zhixing.db.createNote(title, null, html, 'richtext')
      if (!note) {
        setMsg('保存失败：笔记没建成')
        setSaving(false)
        return
      }
      await window.zhixing.db.linkTaskNote(job.taskId, note.id)
      setSaving(false)
      await finish()
    } catch (e) {
      setMsg('保存失败：' + ((e as Error).message || '未知原因'))
      setSaving(false)
    }
  }

  return (
    <div className="modal-mask">
      <div className="modal modal--summary">
        {/* 头/脚用项目现成的 .modal__head / .modal__foot —— 它们自带内边距，
            中间那块自己补左右内边距（.modal 本身没有整体 padding）。 */}
        <header className="modal__head">
          <h2>写总结 · {job.taskTitle}</h2>
        </header>
        <div className="sum__main">
          <p className="u-aux sum__hint">会存成知识库里的一篇笔记，并关联到这个任务</p>
          <RichTextToolbar editor={editor} />
          <div className="sum__editor">
            <EditorContent editor={editor} />
          </div>
          {msg ? <p className="u-aux sum__msg">{msg}</p> : null}
        </div>
        {/* .modal__spacer 是项目里「按钮组靠右」的惯例（flex:1 把后面的推过去） */}
        <div className="modal__foot">
          <span className="modal__spacer" />
          <button className="btn btn--ghost" onClick={() => void finish()}>
            跳过，直接完成
          </button>
          <button className="btn" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存并完成'}</button>
        </div>
      </div>
    </div>
  )
}