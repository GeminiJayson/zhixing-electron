import { useEffect, useRef, useState } from 'react'
import { ClipboardList, FileText, FolderPlus, Inbox, ListPlus, Pin } from '@renderer/lib/icons'
import type { Task } from '@shared/types'
import { TargetSelector } from './TargetSelector'

interface Props {
  open: boolean
  /** quick：只管快速建任务（语法糖）；capture：划词捕获卡（五去向） */
  mode: 'quick' | 'capture'
  /**
   * 热键唤出时由主进程带进来的「当前选中文字」（它模拟了一次 Ctrl+C）。
   * 有它就优先用它，没有才退回剪贴板 —— 三个读选区的热键都走这条路。
   */
  seed?: { text: string; html: string } | null
  /**
   * 跑在独立窗口里（热键唤出的形态）：窗口本身就是「外面」，
   * 所以不再铺一层遮罩、点空白也不关闭。
   */
  embedded?: boolean
  onClose: () => void
  onNotice: (message: string) => void
  onChanged: () => Promise<void>
}

/** 划词捕获的默认来源应用名（对齐 Python 的 `source_app or "划词"`）。 */
const DEFAULT_SOURCE_APP = '划词'

/**
 * 从剪贴板 HTML 提取来源 URL（逐条对齐 app_controller._extract_source_url）：
 * 优先级 HTML href 显式链接 → HTML 元数据 source-url/canonical/og:url → 纯文本 URL；
 * `//` 补 https、`/` 用 HTML 里的 host 补全、`www.` 补 https；失败返回空串。
 */
export function extractSourceUrl(html: string, text: string): string {
  const h = html || ''
  if (h) {
    let m = h.match(/href=["']([^"']+)["']/i)
    if (!m) m = h.match(/(?:source-url|canonical|og:url)["'\s:=]+([^"'\s>]+)/i)
    if (m) {
      let url = (m[1] ?? '').trim()
      if (url && !url.startsWith('#') && !url.startsWith('javascript:')) {
        const host = h.match(/https?:\/\/[^/"']+/)
        if (url.startsWith('//')) url = 'https:' + url
        else if (url.startsWith('/') && host) url = host[0] + url
        if (url.startsWith('www.')) url = 'https://' + url
        if (/^https?:\/\//i.test(url)) return url
      }
    }
  }
  const tm = (text || '').match(/https?:\/\/[^\s]+/)
  return tm ? tm[0].replace(/[.,;:!?)】」』"']+$/, '') : ''
}

/**
 * 读剪贴板：优先经 `clipboard.read()` 拿 text/html（用于解析来源 URL），
 * 平台/权限不允许时退回 `readText()`（等价 Python 的 clipboard_fallback 降级）。
 */
export async function readClipboard(): Promise<{ text: string; html: string }> {
  let text = ''
  let html = ''
  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      if (!text && item.types.includes('text/plain')) {
        text = await (await item.getType('text/plain')).text()
      }
      if (!html && item.types.includes('text/html')) {
        html = await (await item.getType('text/html')).text()
      }
    }
  } catch {
    // read() 需要剪贴板权限：失败就只读文本
  }
  if (!text) {
    try {
      text = await navigator.clipboard.readText()
    } catch {
      text = ''
    }
  }
  return { text, html }
}

/**
 * 捕获面板：全局热键或托盘唤出。
 * quick 模式回车即建任务（支持 !2 @列表 #标签 明天 语法糖，对齐 quick_capture.quick_create）；
 * capture 模式是划词捕获卡的**五去向**：闪念 / 任务 / 笔记 / 入分组 / 子任务。
 *
 * 内容来源：全局热键唤出时，主进程会先模拟 Ctrl+C 取来**当前选中的文字**（连 HTML 一起），
 * 通过 seed 传进来；从托盘/浮窗打开、或确实取不到选区时，退回读系统剪贴板
 * （等价 Python 的 clipboard_fallback）。
 */
export function CapturePanel({
  open,
  mode,
  seed = null,
  embedded = false,
  onClose,
  onNotice,
  onChanged,
}: Props) {
  const [text, setText] = useState('')
  const [remark, setRemark] = useState('')
  /** 剪贴板 HTML 里解析出的来源 URL（I2），随闪念一起落库 */
  const [sourceUrl, setSourceUrl] = useState('')
  /** 正在选择目标：「入分组」/「子任务」展开内联 TargetSelector */
  const [selector, setSelector] = useState<'group' | 'subtask' | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    setText('')
    setRemark('')
    setSourceUrl('')
    setSelector(null)
    void (async () => {
      if (seed?.text?.trim()) {
        // 热键带来的「当前选中文字」最准：它就是用户此刻高亮的那段
        setText(seed.text.trim())
        setSourceUrl(extractSourceUrl(seed.html ?? '', seed.text))
      } else if (mode === 'capture') {
        const { text: clip, html } = await readClipboard()
        // 不再 slice(0,500)：Python 的 get_text 读全文，截断会丢内容
        if (clip?.trim()) setText(clip.trim())
        setSourceUrl(extractSourceUrl(html, clip))
      }
      window.setTimeout(() => inputRef.current?.focus(), 30)
    })()
  }, [open, mode, seed])

  useEffect(() => {
    if (!open) return
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [open, onClose])

  if (!open) return null

  /** 建任务后把正文写入备注（createTask 的 preload 签名没有 notes_md 参数）。 */
  const createTaskWithNotes = async (
    title: string,
    notes: string,
    parentId: number | null,
    listId: number | null
  ): Promise<Task | null> => {
    const task = await window.zhixing.db.createTask(title, parentId, listId)
    if (!task) return null
    await window.zhixing.db.updateTask(task.id, { notes_md: notes })
    return task
  }

  /** quick 模式：走语法糖解析（对齐 _quick_submit → quick_create）。 */
  const quickAddTask = async (): Promise<void> => {
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

  /** 捕获「任务」：**不解析语法糖**，标题取内容前 60 字、正文进备注（对齐 submitTask）。 */
  const toTask = async (): Promise<void> => {
    const value = text.trim()
    if (!value) return
    const created = await createTaskWithNotes(
      value.slice(0, 60) || '捕获任务',
      `捕获内容：${value}`,
      null,
      null
    )
    if (!created) return
    onNotice(`已创建任务「${created.title}」`)
    await onChanged()
    onClose()
  }

  /** 闪念：带上来源应用与来源 URL（I1）。 */
  const toFlash = async (): Promise<void> => {
    const value = text.trim()
    if (!value) return
    await window.zhixing.db.addFlash(value, remark.trim(), DEFAULT_SOURCE_APP, sourceUrl)
    onNotice('已存入闪念收件箱')
    await onChanged()
    onClose()
  }

  /** 笔记：标题=(备注||内容)[:30]，正文=引文 + 原文 + 备注（对齐 _capture_to_note）。 */
  const toNote = async (): Promise<void> => {
    const value = text.trim()
    if (!value) return
    const r = remark.trim()
    const title = (r || value).trim().slice(0, 30) || '来自捕获'
    const note = await window.zhixing.db.createNote(title, null, `> ${value}\n${r}\n`)
    if (!note) return
    onNotice(`已创建笔记「${note.title}」`)
    await onChanged()
    onClose()
  }

  /** 入分组：内容成为目标分组下的新任务（对齐 _capture_to_group）。 */
  const toGroup = async (listId: number, name: string): Promise<void> => {
    const value = text.trim()
    if (!value) return
    const created = await createTaskWithNotes(
      value.split('\n')[0].trim().slice(0, 60) || '捕获任务',
      `捕获内容：${value}\n${remark.trim()}`,
      null,
      listId
    )
    if (!created) return
    onNotice(`已添加到「${name}」`)
    await onChanged()
    onClose()
  }

  /** 加子任务：内容成为所选父任务下的子待办（对齐 _capture_to_subtask）。 */
  const toSubtask = async (parentId: number, name: string): Promise<void> => {
    const value = text.trim()
    if (!value) return
    const created = await createTaskWithNotes(
      value.split('\n')[0].trim().slice(0, 60) || '捕获子任务',
      `捕获内容：${value}\n${remark.trim()}`,
      parentId,
      null
    )
    if (!created) return
    onNotice(`已加为「${name}」的子待办`)
    await onChanged()
    onClose()
  }

  /** 五去向的字母快捷键（对齐 _install_shortcuts 的 F/T/N/G/U）；
   *  在输入框里打字时不拦截，否则备注里打不出 g/u 等字母。 */
  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    const key = e.key.toUpperCase()
    if (mode === 'capture') {
      if (key === 'F') void toFlash()
      else if (key === 'T') void toTask()
      else if (key === 'N') void toNote()
      else if (key === 'G') setSelector('group')
      else if (key === 'U') setSelector('subtask')
    }
  }

  return (
    <div className="capture-host" onMouseDown={embedded ? undefined : onClose}>
      <div
        className="modal modal--capture"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'quick' ? '快速添加任务' : '划词捕获'}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onPanelKeyDown}
      >
        {/* 与工作流条件确认窗同一套卡片骨架：图标 + 标题 + 内容 + 底部按钮 */}
        <header className="modal__head">
          <span className="dialog__icon" aria-hidden>
            {mode === 'quick' ? <ListPlus size={15} /> : <ClipboardList size={15} />}
          </span>
          <h2>{mode === 'quick' ? '快速添加任务' : '划词捕获'}</h2>
        </header>
        <div className="modal__body">
        <textarea
          ref={inputRef}
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
              if (mode === 'quick') void quickAddTask()
              else void toTask()
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
          {selector && mode === 'capture' && (
            <TargetSelector
              mode={selector}
              onCancel={() => setSelector(null)}
              onPick={(id, name) => {
                setSelector(null)
                if (selector === 'group') void toGroup(id, name)
                else void toSubtask(id, name)
              }}
            />
          )}
        </div>
        <footer className="modal__foot">
          <div className="capture__actions">
          {mode === 'capture' && (
            <>
              <button className="text-btn" onClick={() => void toFlash()}>
                <Inbox size={13} /> 闪念
              </button>
              <button className="text-btn" onClick={() => void toNote()}>
                <FileText size={13} /> 笔记
              </button>
              <button
                className="text-btn"
                onClick={() => setSelector('group')}
                disabled={!text.trim()}
              >
                <FolderPlus size={13} /> 入分组
              </button>
              <button
                className="text-btn"
                onClick={() => setSelector('subtask')}
                disabled={!text.trim()}
              >
                <Pin size={13} /> 子任务
              </button>
            </>
          )}
            <span className="modal__spacer" />
            <button className="text-btn" onClick={onClose}>
              取消
            </button>
            <button
              className="text-btn text-btn--accent"
              onClick={() => void (mode === 'quick' ? quickAddTask() : toTask())}
            >
              <ListPlus size={13} /> 任务
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
