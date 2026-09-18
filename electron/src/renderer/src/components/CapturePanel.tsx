import { useEffect, useRef, useState } from 'react'
import { FileText, Inbox, ListPlus } from 'lucide-react'

interface Props {
  open: boolean
  /** quick：只管快速建任务；capture：三去向（闪念/任务/笔记） */
  mode: 'quick' | 'capture'
  onClose: () => void
  onNotice: (message: string) => void
  onChanged: () => Promise<void>
}

/**
 * 捕获面板：全局热键或托盘唤出。
 * quick 模式回车即建任务（支持 !2 @列表 #标签 明天 语法糖）；
 * capture 模式提供三去向。选中文本由剪贴板预填——Electron 侧没有读取
 * 其他应用选区的 API，这一点与 Python 的 SelectionGrabber 不等价。
 */
export function CapturePanel({ open, mode, onClose, onNotice, onChanged }: Props) {
  const [text, setText] = useState('')
  const [remark, setRemark] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setText('')
    setRemark('')
    void (async () => {
      if (mode === 'capture') {
        try {
          const clip = await navigator.clipboard.readText()
          if (clip?.trim()) setText(clip.trim().slice(0, 500))
        } catch {
          // 剪贴板不可读时留空，用户可直接输入
        }
      }
      window.setTimeout(() => inputRef.current?.focus(), 30)
    })()
  }, [open, mode])

  useEffect(() => {
    if (!open) return
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [open, onClose])

  if (!open) return null

  const toTask = async (): Promise<void> => {
    const value = text.trim()
    if (!value) return
    const created = await window.zhixing.db.quickAdd(value)
    if (!created) {
      onNotice('没解析出可用的标题')
      return
    }
    onNotice(`已添加任务「${created.title}」`)
    await onChanged()
    onClose()
  }

  const toFlash = async (): Promise<void> => {
    const value = text.trim()
    if (!value) return
    await window.zhixing.db.addFlash(value, remark, '捕获')
    onNotice('已存入闪念收件箱')
    await onChanged()
    onClose()
  }

  const toNote = async (): Promise<void> => {
    const value = text.trim()
    if (!value) return
    const title = (remark.trim() || value.split('\n')[0]).slice(0, 40) || '来自捕获'
    const note = await window.zhixing.db.createNote(title, null, value)
    if (!note) return
    onNotice(`已新建笔记「${note.title}」`)
    await onChanged()
    onClose()
  }

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div
        className="capture"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'quick' ? '快速添加任务' : '划词捕获'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="capture__head">
          {mode === 'quick' ? '快速添加任务' : '捕获 · Esc 取消'}
        </header>
        <textarea
          ref={inputRef as unknown as React.RefObject<HTMLTextAreaElement>}
          className="capture__text"
          rows={mode === 'capture' ? 4 : 2}
          value={text}
          placeholder={
            mode === 'quick'
              ? '输入任务，回车确认（支持 !2 @列表 #标签 明天）'
              : '捕获内容（已尝试用剪贴板预填）'
          }
          aria-label="捕获内容"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void toTask()
            }
          }}
        />
        <input
          className="field"
          value={remark}
          placeholder="备注（可作笔记标题）"
          aria-label="备注"
          onChange={(e) => setRemark(e.target.value)}
        />
        <div className="capture__actions">
          {mode === 'capture' && (
            <>
              <button className="text-btn" onClick={() => void toFlash()}>
                <Inbox size={13} /> 闪念
              </button>
              <button className="text-btn" onClick={() => void toNote()}>
                <FileText size={13} /> 笔记
              </button>
            </>
          )}
          <span className="modal__spacer" />
          <button className="text-btn" onClick={onClose}>
            取消
          </button>
          <button className="text-btn text-btn--accent" onClick={() => void toTask()}>
            <ListPlus size={13} /> 任务
          </button>
        </div>
      </div>
    </div>
  )
}
