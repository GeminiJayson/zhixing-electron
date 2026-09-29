import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TextAlign from '@tiptap/extension-text-align'
import Placeholder from '@tiptap/extension-placeholder'
import { TextStyle } from '@tiptap/extension-text-style'
import FontSize from '@tiptap/extension-text-style/font-size'
import Color from '@tiptap/extension-color'
import { CodeBlockLanguage } from './CodeBlockLanguage'
import { RichTextToolbar } from './RichTextToolbar'
import { titleFromContent } from '@shared/html-text'
import { parseSettings } from '@shared/settings'
import { Pin } from '@renderer/lib/icons'
import type { Flash, Note, NoteFolder } from '@shared/types'

interface Props {
  onClose: () => void
  onNotice: (message: string) => void
}

/** 八个拖拽方向：n/s/e/w 的组合，与主进程 quicknote:resize 的解析一致。 */
const RESIZE_EDGES = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'] as const

/** 单条内容超过这个长度就截断（与主进程 addFlash 的上限一致，避免"存了但变了"）。 */
const MAX_LEN = 8000

/**
 * 快速笔记浮窗（形态 C：热键唤出 + 可钉住常驻）。
 *
 * 与 CapturePanel 的分工：那个是"写一条 → 走人"（任务/划词），
 * 这个要能**连着写**：Ctrl+Enter 存一条、输入框清空、焦点不丢，写完整批归到笔记。
 *
 * 数据落**闪念**（flash）而不是新表：
 *   · 每条即时落库 —— 关窗、崩溃都不丢，列表里显示的是"本次会话"而已；
 *   · 归档走现成的 flashToNote / mergeFlashes；
 *   · 代价是这些内容在收件箱里也看得到（这是有意的：那里就是"待整理的碎片"）。
 */
export function QuickNotePanel({ onClose, onNotice }: Props): React.JSX.Element {
  const [items, setItems] = useState<Flash[]>([])
  const [pinned, setPinned] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [notes, setNotes] = useState<Note[]>([])
  const [folders, setFolders] = useState<NoteFolder[]>([])
  /** 卡片不透明度（0.6–1）。写进 --qn-alpha，由 CSS 调卡片底色 —— 不用 win.setOpacity */
  const [alpha, setAlpha] = useState(1)
  /**
   * 窗口内的即时反馈。
   *
   * 原先动作成功只走主进程的 notice（发给**主窗口**）—— 而用这个浮窗的人
   * 多半在别的应用里，主窗口在后台，提示根本看不到。表现就是"点了转没反应"：
   * 笔记其实建了，条目也移走了，但用户无从知道。
   */
  const [flashMsg, setFlashMsg] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  const editor = useEditor({
    extensions: [
      StarterKit,
      TextStyle,
      FontSize,
      Color,
      CodeBlockLanguage,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: '随手记一句…（Ctrl+Enter 存下，接着写）' }),
    ],
    content: '',
    editorProps: { attributes: { class: 'qn__body' } },
  })

  /**
   * 窗口高度跟着内容走。
   * 捕获窗那套 window:fitHeight 是现成的，这里量卡片高度回报主进程即可。
   * 列表变长时窗口会长高 —— 上限由主进程钳制（见 openQuickNoteWindow）。
   */
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const report = (): void => window.zhixing.app.fitHeight(Math.ceil(el.getBoundingClientRect().height))
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** 启动时恢复上次的透明度与尺寸。 */
  useEffect(() => {
    void (async () => {
      const s = parseSettings(await window.zhixing.db.settings())
      setAlpha(s.quick_note_alpha)
      const [w, h] = String(s.quick_note_size).split('x').map((v) => Number.parseInt(v, 10))
      if (Number.isFinite(w) && Number.isFinite(h)) void window.zhixing.quickNote.setSize(w, h)
    })()
  }, [])

  /**
   * 拖窗口边缘/角落改尺寸。
   *
   * 不用窗口的原生 resizable：透明无边框窗口在 Windows 上的缩放会闪烁
   *（项目里其余浮窗也都关着它）。这里自绘八向热区，程序化 setBounds ——
   * 观感与原生一致，又不受那个限制影响。
   *
   * 起始矩形由主进程记（resizeStart），这里每次只报位移增量：
   * 若由渲染层自己累加，快速拖动时窗口跟不上指针会产生累积误差。
   */
  const startDrag = useCallback(
    (dir: string) =>
      (e: React.PointerEvent): void => {
        e.preventDefault()
        const x0 = e.clientX
        const y0 = e.clientY
        void window.zhixing.quickNote.resizeStart()
        const onMove = (ev: PointerEvent): void => {
          void window.zhixing.quickNote.resize(dir, ev.clientX - x0, ev.clientY - y0)
        }
        const onUp = (): void => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          void (async () => {
            const size = await window.zhixing.quickNote.resizeEnd()
            if (size) void window.zhixing.db.setSetting('quick_note_size', size)
          })()
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      },
    []
  )

  /** 归档目标（笔记与文件夹）每次打开弹层都重读一遍。 */
  const refreshTargets = useCallback(async (): Promise<void> => {
    setNotes(await window.zhixing.db.notes())
    setFolders(await window.zhixing.db.noteFolders())
  }, [])

  useEffect(() => {
    void refreshTargets()
  }, [refreshTargets])

  /** 窗口内的一行状态，几秒后自己消失。 */
  const say = useCallback((msg: string): void => {
    setFlashMsg(msg)
    window.setTimeout(() => setFlashMsg((cur) => (cur === msg ? '' : cur)), 4000)
  }, [])

  /** 存一条：落库 → 进列表 → 清空编辑器 → 焦点还给编辑器（连着写不用再点一次）。 */
  const save = useCallback(async (): Promise<void> => {
    if (!editor) return
    const html = editor.getHTML()
    // TipTap 的空文档是 <p></p>，不能只看字符串长度
    if (!titleFromContent(html) && !/<(img|hr|table)/i.test(html)) return
    const flash = await window.zhixing.db.addFlash(html.slice(0, MAX_LEN), '', '快速笔记', '')
    if (!flash) {
      onNotice('没能存下这条')
      return
    }
    setItems((prev) => [flash, ...prev])
    editor.commands.clearContent(true)
    editor.commands.focus('end')
  }, [editor, onNotice])

  /**
   * 键盘：Ctrl/Cmd+Enter 存一条并接着写；Esc 收窗（已存的内容都在库里，不受影响）。
   * 归档弹层开着时 Esc 让给弹层，避免"想取消归档却把整个窗口关了"。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        void save()
      } else if (e.key === 'Escape' && !archiving) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, onClose, archiving])

  const removeItem = useCallback(async (id: number): Promise<void> => {
    await window.zhixing.db.deleteFlash(id)
    setItems((prev) => prev.filter((f) => f.id !== id))
  }, [])

  /** 点条目回填到输入框重写：内容进编辑器，原条目删掉（避免同一条存在两份）。 */
  const editItem = useCallback(
    async (f: Flash): Promise<void> => {
      if (!editor) return
      editor.commands.setContent(f.content ?? '', { emitUpdate: true })
      editor.commands.focus('end')
      await removeItem(f.id)
    },
    [editor, removeItem]
  )

  const togglePin = useCallback(async (): Promise<void> => {
    const next = !pinned
    setPinned(next)
    await window.zhixing.app.setQuickNotePinned(next)
  }, [pinned])

  /** 归档：三条路径共用这一个入口。 */
  const archive = useCallback(
    async (mode: 'new' | 'append', targetId?: number, folderId?: number | null): Promise<void> => {
      const ids = items.map((f) => f.id)
      if (!ids.length) return
      if (mode === 'new') {
        // 合并成一条再转笔记：mergeFlashes 现成，转出来的是一篇完整笔记而不是十几篇碎片
        const merged = await window.zhixing.db.mergeFlashes(ids)
        if (!merged) {
          onNotice('合并失败')
          return
        }
        const noteId = await window.zhixing.db.flashToNote(merged, folderId ?? null)
        onNotice(noteId ? '已归到新笔记' : '转笔记失败')
      } else {
        const note = notes.find((n) => n.id === targetId)
        if (!note) return
        // 追加：按目标笔记的格式拼。markdown 里塞 HTML 会被当源码显示，
        // 所以富文本内容先剥成纯文本再拼（样式在跨格式时无法保真，这是取舍）。
        const merged = await window.zhixing.db.mergeFlashes(ids)
        const flash = merged ? (await window.zhixing.db.flashes(null)).find((f) => f.id === merged) : null
        const content = flash?.content ?? ''
        const sep = note.format === 'markdown' ? '\n\n---\n\n' : '<hr/>'
        const add = note.format === 'markdown' ? titleFromContent(content) + plainOf(content) : content
        await window.zhixing.db.saveNote(note.id, { content_md: (note.content_md ?? '') + sep + add })
        if (merged) await window.zhixing.db.deleteFlash(merged)
        onNotice('已追加到「' + note.title + '」')
      }
      setItems([])
      setArchiving(false)
      say(mode === 'new' ? '已归到新笔记' : '已追加到笔记')
    },
    [items, notes, onNotice, say]
  )

  /** 单条转成笔记（列表每行一个小按钮）。 */
  const convertOne = useCallback(
    async (f: Flash): Promise<void> => {
      const title = titleFromContent(f.content ?? '') || '未命名'
      const noteId = await window.zhixing.db.flashToNote(f.id, null)
      if (!noteId) {
        // 失败原先完全静默，用户只会觉得"点了没反应"
        say('转笔记失败')
        return
      }
      setItems((prev) => prev.filter((x) => x.id !== f.id))
      say('已转成笔记「' + title + '」')
      onNotice('已转成笔记')
    },
    [onNotice, say]
  )

  return (
    <div className="qn" ref={boxRef} style={{ '--qn-alpha': alpha } as React.CSSProperties}>
      <header className="qn__bar">
        <span className="qn__title">快速笔记</span>
        {/*
          透明度：调的是卡片底色，不是 win.setOpacity ——
          Windows 上后者是整窗全局 alpha（layered window），会破坏逐像素透明，
          圆角外立刻出现方角。调底色则只影响卡片，文字依然清晰。
        */}
        <input
          className="qn__alpha"
          type="range"
          min={60}
          max={100}
          value={Math.round(alpha * 100)}
          aria-label="窗口透明度"
          title={'不透明度 ' + Math.round(alpha * 100) + '%'}
          onChange={(e) => setAlpha(Number(e.target.value) / 100)}
          onPointerUp={() => void window.zhixing.db.setSetting('quick_note_alpha', String(alpha))}
        />
        <button
          type="button"
          className={'qn__icon' + (pinned ? ' qn__icon--on' : '')}
          aria-pressed={pinned}
          title={pinned ? '取消钉住（当前常驻）' : '钉住：窗口常驻、失焦也不关'}
          aria-label="钉住"
          onClick={() => void togglePin()}
        >
          <Pin size={14} />
        </button>
        <button type="button" className="qn__icon" aria-label="关闭" title="关闭（已存的内容不会丢）" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="qn__editor">
        {editor && <RichTextToolbar editor={editor} />}
        {/* 包一层是为了让编辑器撑满：EditorContent 自己会渲染一个 div，
            只给 contenteditable 设 flex 是够不到它的（实测输入区一直停在 min-height） */}
        <EditorContent className="qn__host" editor={editor} />
      </div>

      {items.length > 0 && (
        <ul className="qn__list" aria-label="本次已记">
          {items.map((f) => (
            <li key={f.id} className="qn__item">
              <button type="button" className="qn__item-main" title="点一下取回输入框继续改" onClick={() => void editItem(f)}>
                <span className="qn__item-time">{(f.created_at ?? '').slice(11, 16)}</span>
                <span className="qn__item-text">{titleFromContent(f.content ?? '') || '（空）'}</span>
              </button>
              <button type="button" className="qn__item-btn" title="单独转成笔记" aria-label="转成笔记" onClick={() => void convertOne(f)}>
                转
              </button>
              <button type="button" className="qn__item-btn" title="删掉这条" aria-label="删除" onClick={() => void removeItem(f.id)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <footer className="qn__foot">
        <span className={'u-aux' + (flashMsg ? ' qn__msg' : '')} role="status">
          {flashMsg || (items.length > 0 ? items.length + ' 条待归档' : 'Ctrl+Enter 存下')}
        </span>
        <button
          type="button"
          className="btn"
          disabled={!items.length}
          onClick={() => {
            // **每次打开弹层都重读一次归档目标**。只在挂载时读的话，
            // 浮窗开着期间新建的笔记不会出现在"追加到已有"的下拉里
            // （实测踩到过：下拉只有 1 篇，实际有 2 篇）。
            void refreshTargets()
            setArchiving(true)
          }}
        >
          归到笔记…
        </button>
      </footer>

      {/*
        八向拖拽热区：四边 + 四角，观感与原生 resize 一致。
        窗口本身 resizable:false（透明窗口原生缩放会闪烁），改尺寸走程序化 setBounds。
      */}
      {RESIZE_EDGES.map((dir) => (
        <span key={dir} className={'qn__edge qn__edge--' + dir} aria-hidden onPointerDown={startDrag(dir)} />
      ))}

      {archiving && (
        <ArchiveSheet
          count={items.length}
          notes={notes}
          folders={folders}
          onCancel={() => setArchiving(false)}
          onConfirm={(mode, targetId, folderId) => void archive(mode, targetId, folderId)}
        />
      )}
    </div>
  )
}

/**
 * 归档弹层：把本次会话的条目归到笔记。
 *
 * 两个方向：
 *   · 新建一篇 —— mergeFlashes 合成一条再 flashToNote，出来的是一篇完整笔记；
 *   · 追加到已有 —— 按目标笔记的格式拼接（markdown 拼纯文本、richtext 拼 HTML）。
 * 单条转在列表每行上，不进这里。
 */
function ArchiveSheet(props: {
  count: number
  notes: Note[]
  folders: NoteFolder[]
  onCancel: () => void
  onConfirm: (mode: 'new' | 'append', targetId?: number, folderId?: number | null) => void
}): React.JSX.Element {
  const [mode, setMode] = useState<'new' | 'append'>('new')
  const [target, setTarget] = useState('')
  const [folder, setFolder] = useState('')
  // excel / word 的正文在外部文件里，追加会让"文件内容"与"数据库内容"打架，所以只列可写的两种
  const writable = props.notes.filter((n) => n.format === 'markdown' || n.format === 'richtext')
  return (
    <div className="qn__sheet" role="dialog" aria-label="归到笔记">
      <div className="qn__sheet-card">
        <header className="qn__sheet-head">把 {props.count} 条归到笔记</header>
        <div className="seg">
          <button type="button" aria-pressed={mode === 'new'} onClick={() => setMode('new')}>
            新建一篇
          </button>
          <button type="button" aria-pressed={mode === 'append'} onClick={() => setMode('append')}>
            追加到已有
          </button>
        </div>
        {mode === 'new' ? (
          <label className="form-row">
            <span>文件夹</span>
            <select className="field" value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="目标文件夹">
              <option value="">未分类</option>
              {props.folders.map((f) => (
                <option key={f.id} value={String(f.id)}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="form-row">
            <span>目标笔记</span>
            <select className="field" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="目标笔记">
              <option value="">选择一篇…</option>
              {writable.map((n) => (
                <option key={n.id} value={String(n.id)}>
                  {n.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <footer className="qn__sheet-foot">
          <button type="button" className="text-btn" onClick={props.onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn"
            disabled={mode === 'append' && !target}
            onClick={() => props.onConfirm(mode, target ? Number(target) : undefined, folder ? Number(folder) : null)}
          >
            确定
          </button>
        </footer>
      </div>
    </div>
  )
}

/** 取纯文本（追加进 markdown 笔记用）。 */
function plainOf(html: string): string {
  return html
    .replace(/<(br|\/p|\/h[1-6]|\/li|\/blockquote|\/pre|\/div)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}