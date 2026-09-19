import type { EditorView } from '@codemirror/view'
import { sanitizeHtml } from '@shared/sanitize-html'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Morph, IconData, Link2, Plus, Sparkles, UserPlus } from '@renderer/lib/icons'
import { subscribeDomain } from '@shared/events'
import { useDialog } from '../components/Dialogs'
import type { Backlink, Note, NoteFolder, NoteLink } from '@shared/types'
import { t } from '../i18n'
import { MarkdownEditor, RichTextEditor, blockFingerprint, locateBlockInView } from '../components/MarkdownEditor'
import { MarkdownView } from '../components/MarkdownView'
import { NoteHistory } from '../components/NoteHistory'
import { NoteTree, type NoteFormat } from '../components/NoteTree'
import { Toolbar } from '../components/Toolbar'
import { PopMenu } from '../components/PopMenu'

interface Props {
  onNotice: (message: string) => void
  /** 由其他页面（如图谱）跳转过来时要打开的笔记 */
  initialNoteId?: number | null
}

/** 自动保存防抖：与 markdown_editor 的自动保存节奏对齐，输入停顿后落库。 */
const AUTOSAVE_MS = 800

/** 五种格式的展示名（对齐 NOTE_FORMAT_LABELS）。 */
const FORMAT_LABELS: { value: string; label: string }[] = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'richtext', label: '富文本' },
  { value: 'word', label: 'Word' },
  { value: 'excel', label: 'Excel' },
  { value: 'link', label: '链接' },
]

export function NotesPage({ onNotice, initialNoteId = null }: Props) {
  const dialog = useDialog()
  const [notes, setNotes] = useState<Note[]>([])
  const [folders, setFolders] = useState<NoteFolder[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [current, setCurrent] = useState<Note | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [preview, setPreview] = useState(false)
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [outLinks, setOutLinks] = useState<NoteLink[]>([])
  const [linksOpen, setLinksOpen] = useState(true)
  const [dirty, setDirty] = useState(false)
  /** 新建笔记时使用的格式 */
  const [historyId, setHistoryId] = useState<number | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  const [templateMenu, setTemplateMenu] = useState<{ x: number; y: number } | null>(null)
  const [templates, setTemplates] = useState<string[]>([])
  const [panel, setPanel] = useState<{ kind: 'orphan' | 'broken'; x: number; y: number } | null>(null)
  /** 查找替换（Ctrl/Cmd+F 打开） */
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  /** CodeMirror 实例：查找定位要走它的 selection API */
  const viewRef = useRef<EditorView | null>(null)
  const [panelItems, setPanelItems] = useState<{ key: string; label: string; id: number }[]>([])
  const timer = useRef<number | null>(null)
  /** 「移动到文件夹…」目标菜单（N-§1.3#9） */
  const [moveMenu, setMoveMenu] = useState<{ noteId: number; x: number; y: number } | null>(null)
  /** 「归属」动作菜单（N-§1.3#8）：关联任务 / 移动到文件夹 */
  const [attachMenu, setAttachMenu] = useState<{ x: number; y: number } | null>(null)
  /** 归属选择器：候选任务列表 */
  const [taskPick, setTaskPick] = useState<{ x: number; y: number; items: { id: number; title: string }[] } | null>(null)
  /** 本笔记归属的任务（链接面板「归属」分组） */
  const [attachedTasks, setAttachedTasks] = useState<{ id: number; title: string }[]>([])
  /** Word/Excel 可编辑内容（N-§1.3#5） */
  const [officeEdit, setOfficeEdit] = useState<{ kind: string; html: string; rows: string[][]; message: string } | null>(null)
  const [excelRows, setExcelRows] = useState<string[][]>([])
  /** AI 整理进行中（请求可能跑几十秒，期间按钮要禁用并给出文案） */
  const [aiBusy, setAiBusy] = useState(false)
  /** 同 id 重载计数器：AI 改写后标题/正文/文件夹都变了，得把加载流程再跑一遍 */
  const [reloadToken, setReloadToken] = useState(0)
  const officeTimer = useRef<number | null>(null)

  const isOffice = current?.format === 'word' || current?.format === 'excel'

  const load = useCallback(async () => {
    const fs0 = await window.zhixing.db.noteFolders()
    // N-§1.3#13：文件夹为空时补默认文件夹（对齐 note_page._reload_tree）
    if (fs0.length === 0) {
      await window.zhixing.db.ensureDefaultFolder()
    }
    const [rows, fs] = await Promise.all([
      window.zhixing.db.notes(),
      fs0.length === 0 ? window.zhixing.db.noteFolders() : Promise.resolve(fs0),
    ])
    setNotes(rows)
    setFolders(fs)
  }, [])

  useEffect(() => {
    void load()
    void window.zhixing.db.noteTemplates().then(setTemplates)
  }, [load])

  // 跨页跳转：带着笔记 id 进来时直接选中它
  useEffect(() => {
    if (initialNoteId != null) setSelectedId(initialNoteId)
  }, [initialNoteId])

  // 打开笔记：装载正文、出链、反链与归属任务
  useEffect(() => {
    if (selectedId == null) {
      setCurrent(null)
      setTitle('')
      setContent('')
      setBacklinks([])
      setOutLinks([])
      setAttachedTasks([])
      setDirty(false)
      return
    }
    let alive = true
    void (async () => {
      const [note, back, out, attached] = await Promise.all([
        window.zhixing.db.note(selectedId),
        window.zhixing.db.backlinks(selectedId),
        window.zhixing.db.outLinks(selectedId),
        window.zhixing.db.noteAttachedTasks(selectedId),
      ])
      if (!alive || !note) return
      setCurrent(note)
      setTitle(note.title)
      setContent(note.content_md ?? '')
      setBacklinks(back)
      setOutLinks(out)
      setAttachedTasks(attached)
      setDirty(false)
    })()
    return () => {
      alive = false
    }
  }, [selectedId, reloadToken])

  // Office 笔记：选中时按需载入可编辑内容（Word→HTML，Excel→单元格）
  useEffect(() => {
    if (!current || (current.format !== 'word' && current.format !== 'excel')) {
      setOfficeEdit(null)
      setExcelRows([])
      return
    }
    let alive = true
    void window.zhixing.db.officeDoc(current.id).then((res) => {
      if (!alive) return
      setOfficeEdit(res)
      setExcelRows(res.rows ?? [])
    })
    return () => {
      alive = false
    }
  }, [current])

  // 别的页面改了笔记（新建/删除/改标题）会影响反链；这里只更新反链与归属，
  // 不重载正文 —— 当前笔记可能正在编辑，整篇重载会覆盖输入（O3）。
  useEffect(() => {
    if (selectedId == null) return
    return subscribeDomain(['note'], () => {
      void window.zhixing.db.backlinks(selectedId).then(setBacklinks)
      void window.zhixing.db.noteAttachedTasks(selectedId).then(setAttachedTasks)
    })
  }, [selectedId])

  /** 已解析标题表：驱动 [[标题]] 的链接化（未命中的即悬空）。 */
  const resolved = useMemo(() => new Map(notes.map((n) => [n.title, n.id])), [notes])

  const persist = useCallback(
    async (id: number, fields: { title?: string; content_md?: string; folder_id?: number | null }) => {
      const saved = await window.zhixing.db.saveNote(id, fields)
      if (!saved) return
      setCurrent(saved)
      setNotes((prev) => prev.map((n) => (n.id === saved.id ? saved : n)))
      setDirty(false)
    },
    []
  )

  /**
   * 切换笔记前，把还在防抖窗口里的编辑立刻落盘。
   *
   * 装载 effect 会把 dirty 重置为 false，自动保存 effect 随即清掉排队中的定时器
   * （NotesPage.tsx 自动保存 effect 的 cleanup），于是切换前 <800ms 的输入会被
   * 静默丢弃。Python 侧由 note_page._commit_current_editor 兜底，这里补齐。
   */
  const flushPending = useCallback(async (): Promise<void> => {
    if (!current || !dirty) return
    if (timer.current) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    await persist(current.id, { title, content_md: content })
  }, [current, dirty, persist, title, content])

  /**
   * AI 整理当前笔记：先把未落盘的编辑冲出去（否则整理的是旧内容），
   * 再交给主进程「取出 → 占位 → 请求 → 审计 → 归类 → 入库」。
   * 成功后才重载本地视图；失败时原笔记一个字节都没动。
   */
  const handleAiOrganize = async (): Promise<void> => {
    if (!current || aiBusy) return
    await flushPending()
    setAiBusy(true)
    try {
      const res = await window.zhixing.ai.organizeNote(current.id)
      if (!res.ok) {
        const errors = (res.issues ?? [])
          .filter((i) => i.level === 'error')
          .slice(0, 2)
          .map((i) => i.message)
          .join('；')
        onNotice(errors ? `${res.message}：${errors}` : res.message)
        return
      }
      const parts = ['AI 已整理并保存']
      if (res.summary) parts.push(res.summary)
      if (res.folderPath) {
        parts.push(
          res.createdFolders?.length ? `新建并归入「${res.folderPath}」` : `归入「${res.folderPath}」`
        )
      }
      const warns = (res.issues ?? []).filter((i) => i.level === 'warn').length
      if (warns) parts.push(`${warns} 条提醒`)
      onNotice(parts.join('｜'))
      setReloadToken((n) => n + 1)
      // 可能新建了文件夹，笔记树要重新拉一遍
      await load()
    } finally {
      setAiBusy(false)
    }
  }

  /** 所有「切换笔记」的入口都走这里：先落盘，再切换。 */
  const selectNote = useCallback(
    async (id: number | null): Promise<void> => {
      await flushPending()
      setSelectedId(id)
    },
    [flushPending]
  )

  // N1：关窗/刷新前也把未落盘的编辑冲出去（Python 由窗口关闭流程 commit 编辑器，
  // 之前只有「切笔记」8 个入口会 flush，直接关窗会丢最后 <800ms 的输入）。
  useEffect(() => {
    const onBeforeUnload = (): void => {
      if (!current || !dirty) return
      // beforeunload 里不能 await：用 sendSync 的同步落盘，保证写入在卸载前真正完成
      if (timer.current) {
        window.clearTimeout(timer.current)
        timer.current = null
      }
      window.zhixing.db.flushNoteSync(current.id, { title, content_md: content })
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [current, dirty, title, content])

  // Ctrl/Cmd+S 立即保存（不必等自动保存的 800ms 防抖）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFindOpen(true)
        return
      }
      if (!mod || e.key.toLowerCase() !== 's') return
      e.preventDefault()
      if (!current) return
      void persist(current.id, { title, content_md: content }).then(async () => {
        setOutLinks(await window.zhixing.db.outLinks(current.id))
        onNotice('已保存')
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, title, content, persist, onNotice])

  // 自动保存
  useEffect(() => {
    if (!current || !dirty) return
    if (timer.current) window.clearTimeout(timer.current)
    const id = current.id
    timer.current = window.setTimeout(() => {
      void persist(id, { title, content_md: content }).then(async () => {
        setOutLinks(await window.zhixing.db.outLinks(id))
      })
    }, AUTOSAVE_MS)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [title, content, current, dirty, persist])

  /** 在正文里找下一个匹配并选中（循环；对齐 Python _find_next）。 */
  const findNext = useCallback((): void => {
    const needle = findText
    if (!needle) return
    if (current?.format === 'richtext') {
      // 富文本用浏览器原生查找（对齐 Python 对 QTextEdit 的 find 支持）；
      // window.find 未进 TS 标准库，这里显式声明
      const w = window as Window & {
        find?: (text: string, caseSensitive?: boolean, backwards?: boolean, wrap?: boolean) => boolean
      }
      if (!w.find?.(needle, false, false, true)) onNotice('没有匹配项')
      return
    }
    const view = viewRef.current
    if (!view) return
    const doc = view.state.doc.toString()
    const pos = view.state.selection.main.to
    let idx = doc.indexOf(needle, pos)
    if (idx < 0) idx = doc.indexOf(needle) // 到尾部后回到开头
    if (idx < 0) {
      onNotice('没有匹配项')
      return
    }
    view.dispatch({
      selection: { anchor: idx, head: idx + needle.length },
      scrollIntoView: true,
    })
    view.focus()
  }, [current, findText, onNotice])

  /** 查找下一处并替换（循环；对齐 Python _replace）。 */
  const replaceNext = useCallback((): void => {
    const view = viewRef.current
    const needle = findText
    if (!view || !needle) return
    const sel = view.state.selection.main
    const selected = view.state.sliceDoc(sel.from, sel.to)
    if (selected === needle) {
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: replaceText } })
    }
    findNext()
  }, [findText, replaceText, findNext])

  const replaceAll = useCallback((): void => {
    if (!findText) return
    const count = content.split(findText).length - 1
    if (count === 0) {
      onNotice('没有匹配项')
      return
    }
    setContent(content.split(findText).join(replaceText))
    setDirty(true)
    onNotice(`已替换 ${count} 处`)
  }, [content, findText, replaceText, onNotice])

  /**
   * 新建笔记（对齐 note_create_dialog + app_controller._prompt_create_note）：
   * 类型由左栏选择；Word/Excel/链接 额外问一次目标（文件路径或 URL），
   * Word/Excel 留空时自动生成空白文件（N3）。
   */
  const handleCreateNote = useCallback(
    async (folderId: number | null, createFormat: NoteFormat): Promise<void> => {
      await flushPending()
      const name = await dialog.prompt({ title: '新建笔记', label: '笔记名称', defaultValue: '未命名笔记' })
      if (name === null) return
      const title = name.trim() || '未命名笔记'
      let body = createFormat === 'markdown' ? '（在这里开始写作…）\n' : ''
      if (createFormat === 'link') {
        const target = await dialog.prompt({
          title: '新建链接笔记',
          label: '链接目标（网页 URL 或本地文件路径）',
          placeholder: 'https://…',
        })
        if (target === null) return
        body = target.trim()
      } else if (createFormat === 'word' || createFormat === 'excel') {
        const target = await dialog.prompt({
          title: createFormat === 'word' ? '新建 Word 笔记' : '新建 Excel 笔记',
          label: '已有文件路径（留空则新建空白文件）',
          placeholder: createFormat === 'word' ? 'C:\\…\\文档.docx' : 'C:\\…\\表格.xlsx',
        })
        if (target === null) return
        if (target.trim()) {
          body = target.trim()
        } else {
          const blank = await window.zhixing.db.createBlankOffice(createFormat, title)
          if (blank.ok) body = blank.path
          else onNotice(blank.message)
        }
      }
      const n = await window.zhixing.db.createNote(title, folderId, body, createFormat)
      if (!n) return
      await load()
      setSelectedId(n.id)
    },
    [flushPending, dialog, load, onNotice]
  )

  // 应用内快捷键由 App 统一监听，页面只负责自己的动作（对齐 note_page 的 toggle_preview / 查找）
  useEffect(() => {
    const onNew = (): void => void handleCreateNote(null, 'markdown')
    const onPreview = (): void => setPreview((p) => !p)
    const onFind = (): void => setFindOpen(true)
    window.addEventListener('zhixing:new-note', onNew)
    window.addEventListener('zhixing:toggle-preview', onPreview)
    window.addEventListener('zhixing:find', onFind)
    return () => {
      window.removeEventListener('zhixing:new-note', onNew)
      window.removeEventListener('zhixing:toggle-preview', onPreview)
      window.removeEventListener('zhixing:find', onFind)
    }
  }, [handleCreateNote])

  /** 点击悬空 [[标题]]：按标题新建并绑定该引用（对齐 materialize_dangling）。 */
  const handleCreateFromLink = async (linkTitle: string): Promise<void> => {
    if (selectedId == null) return
    const dst = await window.zhixing.db.materializeDangling(selectedId, linkTitle)
    if (dst == null) return
    onNotice(`已创建并绑定「${linkTitle}」`)
    await load()
    setOutLinks(await window.zhixing.db.outLinks(selectedId))
    await selectNote(dst)
  }

  /** 主动建引用（对齐 note_page._prompt_reference → add_reference_link）。 */
  const handleAddReference = async (): Promise<void> => {
    if (selectedId == null) return
    const target = await dialog.prompt({
      title: '添加引用链接',
      label: '笔记标题（不存在则建「待建」链接）',
    })
    if (!target?.trim()) return
    const status = await window.zhixing.db.addReferenceLink(selectedId, target.trim())
    const msg =
      status === 'added'
        ? `已建立引用 →「${target.trim()}」`
        : status === 'dangling'
          ? `已建「待建」链接「${target.trim()}」：点击它可创建同名笔记`
          : status === 'bound'
            ? `引用已转正 →「${target.trim()}」`
            : status === 'duplicate'
              ? `已存在指向「${target.trim()}」的引用，未重复添加`
              : status === 'self'
                ? '不能链接到笔记自身'
                : '目标不可用（不存在或已删除）'
    onNotice(msg)
    setOutLinks(await window.zhixing.db.outLinks(selectedId))
  }

  /** 归属到任务（对齐 note_page 的 attach_note_to_task → task_note_link）。 */
  const handleAttachTask = async (taskId: number, taskTitle: string): Promise<void> => {
    if (selectedId == null) return
    const added = await window.zhixing.db.attachTaskNote(taskId, selectedId)
    onNotice(added ? `已把本笔记关联到任务「${taskTitle}」` : `本笔记已关联任务「${taskTitle}」，未重复归属`)
    setAttachedTasks(await window.zhixing.db.noteAttachedTasks(selectedId))
  }

  /** 打开任务候选选择器（对齐 TaskRepository.candidates）。 */
  const openTaskPick = async (x: number, y: number, q = ''): Promise<void> => {
    const items = await window.zhixing.db.noteTaskCandidates(q)
    setTaskPick({ x, y, items })
  }

  /** 移动到文件夹（对齐 note_service.attach_note_to_folder）。 */
  const handleMoveNote = async (noteId: number, folderId: number | null): Promise<void> => {
    const saved = await window.zhixing.db.saveNote(noteId, { folder_id: folderId })
    const name = folderId == null ? '全部笔记' : folders.find((f) => f.id === folderId)?.name ?? ''
    onNotice(saved ? `已把笔记移入「${name}」` : '移动失败')
    await load()
  }

  const handleCreateFolder = async (parentId: number | null): Promise<void> => {
    const name = await dialog.prompt({ title: '新建文件夹', label: '文件夹名称' })
    if (!name?.trim()) return
    await window.zhixing.db.createNoteFolder(name, parentId)
    await load()
  }

  /** 重命名文件夹（对齐 note_page._rename_folder_dialog）。 */
  const handleRenameFolder = async (id: number, currentName: string): Promise<void> => {
    const name = await dialog.prompt({ title: '重命名文件夹', label: '文件夹名称', defaultValue: currentName })
    if (!name?.trim()) return
    await window.zhixing.db.renameNoteFolder(id, name.trim())
    await load()
    onNotice('已重命名文件夹')
  }

  /** 删除文件夹（对齐 note_page._delete_folder：笔记不删，只回落「全部笔记」）。 */
  const handleDeleteFolder = async (id: number): Promise<void> => {
    const ok = await dialog.confirm({
      title: '删除文件夹',
      message: '删除后文件夹内的笔记会移到「全部笔记」，不会删除笔记。确认删除？',
      danger: true,
      confirmText: '删除',
    })
    if (!ok) return
    await window.zhixing.db.deleteNoteFolder(id)
    await load()
    onNotice('已删除文件夹（笔记已移回全部笔记）')
  }

  /** 移动文件夹到新父级（对齐 note_service.move_folder 的环校验）。 */
  const handleMoveFolder = async (id: number, parentId: number | null): Promise<void> => {
    const res = await window.zhixing.db.moveNoteFolder(id, parentId)
    if (!res) {
      onNotice('不能把文件夹移动到它自己或它的子文件夹下')
      return
    }
    await load()
    onNotice('已移动文件夹')
  }

  const handleTogglePin = async (id: number, pinned: boolean): Promise<void> => {
    await window.zhixing.db.saveNote(id, { pinned })
    await load()
  }

  const handleDelete = async (id: number): Promise<void> => {
    const note = notes.find((n) => n.id === id)
    if (!note) return
    if (!window.confirm(`删除笔记「${note.title}」？\n（软删除，可在回收站恢复）`)) return
    await window.zhixing.db.deleteNote(id)
    if (selectedId === id) setSelectedId(null)
    await load()
    onNotice('已删除（可在回收站恢复）')
  }

  /** 改笔记格式（N3：saveNote.format 入口）。 */
  const handleChangeFormat = async (format: string): Promise<void> => {
    if (!current) return
    const saved = await window.zhixing.db.saveNote(current.id, { format })
    if (!saved) return
    setCurrent(saved)
    setNotes((prev) => prev.map((n) => (n.id === saved.id ? saved : n)))
    onNotice(`已改为「${FORMAT_LABELS.find((f) => f.value === format)?.label ?? format}」格式`)
    await load()
  }

  /** 选文转任务（N-§1.3#10）：建任务、备注带回源引用，blockKey 非空时落段落锚。 */
  const handleCreateTaskFromSelection = async (text: string, blockKey: string | null): Promise<void> => {
    if (!current || !text.trim()) return
    const quote = text.trim()
    const taskTitle = quote.split('\n')[0].slice(0, 60) || '来自笔记的任务'
    const task = await window.zhixing.db.createTask(taskTitle, null, null)
    if (!task) return
    await window.zhixing.db.updateTask(task.id, {
      notes_md: `来自 [[${current.title}]]\n> ${quote}`,
    })
    if (blockKey) {
      const fp = blockKey || blockFingerprint(quote.split('\n')[0])
      await window.zhixing.db.attachNoteBlock(task.id, current.id, fp, quote)
    }
    onNotice(blockKey ? `已创建任务「${taskTitle}」并关联本段` : `已创建任务「${taskTitle}」`)
  }

  /** Word 写回（对齐 WordEditView.commit）。 */
  const commitWord = useCallback(
    async (html: string) => {
      if (!current || current.format !== 'word') return
      const res = await window.zhixing.db.saveWordNote(current.id, html)
      onNotice(res.message)
    },
    [current, onNotice]
  )

  /** Excel 写回（对齐 ExcelEditView.commit，1s 防抖）。 */
  const scheduleExcelSave = useCallback(
    (rows: string[][]) => {
      if (!current || current.format !== 'excel') return
      setExcelRows(rows)
      if (officeTimer.current) window.clearTimeout(officeTimer.current)
      const id = current.id
      officeTimer.current = window.setTimeout(() => {
        void window.zhixing.db.saveExcelNote(id, rows).then((res) => onNotice(res.message))
      }, 1000)
    },
    [current, onNotice]
  )

  /**
   * 段落锚定位（对齐 note_page.locate_in_note）：任务/图谱/深链想跳到笔记的某一段时
   * 派发 `zhixing:locate-note-block` 事件，本页负责切笔记并滚动高亮该段。
   */
  const locateBlock = useCallback((blockKey: string): void => {
    const view = viewRef.current
    if (view && blockKey) locateBlockInView(view, blockKey)
  }, [])

  useEffect(() => {
    const onLocate = (e: Event): void => {
      const detail = (e as CustomEvent<{ noteId?: number; blockKey?: string }>).detail
      if (!detail?.blockKey) return
      if (detail.noteId && detail.noteId !== selectedId) {
        void selectNote(detail.noteId)
        // 等笔记装载与编辑器就绪后再定位
        window.setTimeout(() => locateBlock(detail.blockKey!), 400)
      } else {
        locateBlock(detail.blockKey)
      }
    }
    window.addEventListener('zhixing:locate-note-block', onLocate)
    return () => window.removeEventListener('zhixing:locate-note-block', onLocate)
  }, [locateBlock, selectNote, selectedId])

  // N-§1.3#10 后半：深链段落定位。主进程把 block 一并下发（preload onDeepLink），
  // 这里独立消费，不必改 App.tsx 的跨页路由。
  const locateRef = useRef(locateBlock)
  locateRef.current = locateBlock
  const selectRef = useRef(selectNote)
  selectRef.current = selectNote
  useEffect(() => {
    // onDeepLink 基于 ipcRenderer.on，没有取消订阅接口：只注册一次，回调里读最新 ref
    window.zhixing.app.onDeepLink((link) => {
      if (link.kind !== 'note') return
      if (link.id) void selectRef.current(link.id)
      if (link.block) window.setTimeout(() => locateRef.current(link.block), 400)
    })
  }, [])

  const dangling = outLinks.filter((l) => l.dst_note_id == null)

  return (
    <div className="page page--notes">
      <div className="page__head">
        <h1 className="page__title">{t('page.notes')}</h1>
        <p className="page__subtitle">{t('page.notes.sub')}</p>
      </div>
      <div className="page__body">
      <div className="notes-wrap">
        <NoteTree
          notes={notes}
          folders={folders}
          selectedId={selectedId}
          onSelect={(id) => void selectNote(id)}
          onCreateNote={handleCreateNote}
          onCreateFolder={handleCreateFolder}
          onTogglePin={(id, pinned) => void handleTogglePin(id, pinned)}
          onDeleteNote={(id) => void handleDelete(id)}
          onContextMenuNote={(id, x, y) => setCtxMenu({ id, x, y })}
          onRenameFolder={(id, name) => void handleRenameFolder(id, name)}
          onDeleteFolder={(id) => void handleDeleteFolder(id)}
          onMoveFolder={(id, parentId) => void handleMoveFolder(id, parentId)}
        />

        {/* 编辑区与链接面板纵向排列：链接面板从右侧栏挪到了编辑区下方 */}
        <div className="notes-main">
        <div className="editor">
          {current ? (
            <>
                <Toolbar
                  variant="page"
                  sticky={false}
                  titleNode={
                    <>
                      <input
                        className="editor__title"
                        value={title}
                        onChange={(e) => {
                          setTitle(e.target.value)
                          setDirty(true)
                        }}
                        aria-label="笔记标题"
                      />
                      {/* 编辑状态只在真的在编辑时出现；常驻在标题右侧会一直占着标题的宽度 */}
                      {dirty ? <span className="editor__status">未保存…</span> : null}
                    </>
                  }
                  filters={[
                    <select
                      key="format"
                      className="field field--compact"
                      value={current.format}
                      aria-label="笔记格式"
                      title="笔记格式"
                      onChange={(e) => void handleChangeFormat(e.target.value)}
                    >
                      {FORMAT_LABELS.map((f) => (
                        <option key={f.value} value={f.value}>
                          {f.label}
                        </option>
                      ))}
                    </select>,
                  ]}
                  secondary={[
                    <button key="preview" className="text-btn" aria-pressed={preview} onClick={() => setPreview((v) => !v)}>
                      <Morph icon={preview ? IconData.Pencil : IconData.Eye} size={13} />
                      {preview ? '编辑' : '预览'}
                    </button>,
                    <button
                      key="ai"
                      className="text-btn"
                      title="把这篇笔记交给大模型重新归类并优化排版（结果先过审计再入库）"
                      disabled={aiBusy || current.format === 'word' || current.format === 'excel' || current.format === 'link'}
                      onClick={() => void handleAiOrganize()}
                    >
                      <Sparkles size={13} /> {aiBusy ? '整理中…' : 'AI 整理'}
                    </button>,
                    <button key="links" className="text-btn" aria-pressed={linksOpen} onClick={() => setLinksOpen((v) => !v)}>
                      <Link2 size={13} /> 链接
                    </button>,
                    <button key="ref" className="text-btn" title="添加指向其他笔记的引用" onClick={() => void handleAddReference()}>
                      <Link2 size={13} /> 引用
                    </button>,
                    <button
                      key="attach"
                      className="text-btn"
                      title="把本笔记归属到某任务或某文件夹"
                      onClick={(e) => {
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        setAttachMenu({ x: r.left, y: r.bottom + 4 })
                      }}
                    >
                      <UserPlus size={13} /> 归属
                    </button>,
                    <button
                      key="tpl"
                      className="text-btn"
                      onClick={(e) => {
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        setTemplateMenu({ x: r.left, y: r.bottom + 4 })
                      }}
                    >
                      <Plus size={13} /> 模板
                    </button>,
                    <button
                      key="orphan"
                      className="text-btn"
                      onClick={(e) => {
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        void (async () => {
                          const rows = await window.zhixing.db.orphanNotes()
                          setPanelItems(rows.map((n) => ({ key: `o-${n.id}`, label: n.title, id: n.id })))
                          setPanel({ kind: 'orphan', x: r.left, y: r.bottom + 4 })
                        })()
                      }}
                    >
                      孤儿
                    </button>,
                    <button
                      key="broken"
                      className="text-btn"
                      onClick={(e) => {
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        void (async () => {
                          const rows = await window.zhixing.db.brokenLinks()
                          setPanelItems(
                            rows.map((b, i) => ({
                              key: `b-${i}`,
                              label: `${b.src_title} → [[${b.dst_title}]]`,
                              id: b.src_note_id,
                            }))
                          )
                          setPanel({ kind: 'broken', x: r.left, y: r.bottom + 4 })
                        })()
                      }}
                    >
                      失效链接
                    </button>,
                  ]}
                />

              {current.format === 'link' ? (
                // 链接笔记：content_md 存 URL，或存 Python 版写的 [{title,target}] JSON 数组。
                <div className="editor__link">
                  <p className="u-aux">链接笔记</p>
                  {(() => {
                    let items: { title: string; target: string }[] = []
                    try {
                      const parsed = JSON.parse(content)
                      if (Array.isArray(parsed)) items = parsed
                    } catch {
                      // 不是 JSON：按单个 URL / 路径处理
                    }
                    if (!items.length) {
                      items = [{ title: content.slice(0, 60) || '未命名链接', target: content }]
                    }
                    return items.map((it, i) => (
                      <p key={i} className="editor__link-row">
                        <a href={it.target} target="_blank" rel="noreferrer">
                          {it.title || it.target}
                        </a>
                        <button
                          className="text-btn"
                          onClick={() =>
                            void window.zhixing.db
                              .openNoteFile(current.id)
                              .then((r) => onNotice(r.message))
                          }
                        >
                          用系统应用打开
                        </button>
                      </p>
                    ))
                  })()}
                </div>
              ) : isOffice ? (
                // N-§1.3#5：Word/Excel 直接可编辑并自动写回原文件
                <div className="editor__office">
                  <div className="editor__office-head">
                    <span className="u-aux">
                      {current.format === 'word' ? 'Word 可编辑（自动写回 .docx）' : 'Excel 可编辑（自动写回 .xlsx）'}
                      {officeEdit?.message ? ` · ${officeEdit.message}` : ''}
                    </span>
                    <button
                      className="text-btn"
                      onClick={() =>
                        void window.zhixing.db.openNoteFile(current.id).then((r) => onNotice(r.message))
                      }
                    >
                      用系统应用打开
                    </button>
                  </div>
                  {current.format === 'word' ? (
                    <div className="editor__office-body">
                      <RichTextEditor
                        html={officeEdit?.html ?? ''}
                        onChange={(h) => setOfficeEdit((prev) => (prev ? { ...prev, html: h } : prev))}
                        onCommit={(h) => void commitWord(h)}
                        placeholder="从这里开始编辑 Word 正文…"
                      />
                    </div>
                  ) : (
                    <div className="editor__office-body">
                      <table className="xlsx-grid">
                        <tbody>
                          {excelRows.map((row, ri) => (
                            <tr key={ri}>
                              {row.map((cell, ci) => (
                                <td
                                  key={ci}
                                  contentEditable
                                  suppressContentEditableWarning
                                  onBlur={(ev) => {
                                    const next = excelRows.map((r) => [...r])
                                    next[ri][ci] = ev.currentTarget.textContent ?? ''
                                    scheduleExcelSave(next)
                                  }}
                                >
                                  {cell}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ) : preview ? (
                <div className="editor__preview">
                  {current.format === 'richtext' ? (
                    // 富文本正文是用户自己的内容，渲染前仍走一次基础清洗
                    <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(content) }} />
                  ) : (
                    <MarkdownView
                      md={content}
                      resolved={resolved}
                      onOpenNote={(id) => void selectNote(id)}
                      onCreateNote={(t) => void handleCreateFromLink(t)}
                    />
                  )}
                </div>
              ) : current.format === 'richtext' ? (
                <RichTextEditor
                  html={content}
                  onChange={(h) => {
                    setContent(h)
                    setDirty(true)
                  }}
                  placeholder="从这里开始记录富文本…"
                />
              ) : (
                <MarkdownEditor
                  value={content}
                  onChange={(v) => {
                    setContent(v)
                    setDirty(true)
                  }}
                  titles={notes.map((n) => n.title)}
                  placeholder="用 Markdown 写作；输入 [[ 可链接到其他笔记"
                  highlight={findOpen ? findText : ''}
                  onCreateTask={(text, blockKey) => void handleCreateTaskFromSelection(text, blockKey)}
                  onReady={(v) => {
                    viewRef.current = v
                  }}
                />
              )}
              </>
            ) : (
              <p className="empty-hint">从左侧选择一篇笔记，或点右上角新建。</p>
            )}

            {findOpen && current && (
              <div className="find-bar" role="search">
                <input
                  className="field field--compact"
                  value={findText}
                  placeholder="查找…"
                  aria-label="查找内容"
                  onChange={(e) => setFindText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') findNext()
                    if (e.key === 'Escape') setFindOpen(false)
                  }}
                />
                <input
                  className="field field--compact"
                  value={replaceText}
                  placeholder="替换为…"
                  aria-label="替换内容"
                  onChange={(e) => setReplaceText(e.target.value)}
                />
                <button className="text-btn" onClick={findNext}>
                  查找下一个
                </button>
                <button className="text-btn" onClick={replaceNext}>
                  替换下一处
                </button>
                <button className="text-btn" onClick={replaceAll}>
                  全部替换
                </button>
                <button className="text-btn" onClick={() => setFindOpen(false)}>
                  关闭
                </button>
              </div>
            )}
        </div>

        {linksOpen && current && (
          <aside className="links" aria-label="链接面板">
            <section className="links__card">
              <header className="links__head">反向链接 · {backlinks.length}</header>
              {backlinks.length === 0 ? (
                <p className="u-aux">还没有其他笔记引用它。</p>
              ) : (
                backlinks.map((b) => (
                  <button key={b.src_note_id} className="links__item" onClick={() => void selectNote(b.src_note_id)}>
                    <strong>{b.src_title}</strong>
                    <span className="u-aux">{b.snippet}</span>
                  </button>
                ))
              )}
            </section>
            <section className="links__card">
              <header className="links__head">引用（正向）· {outLinks.length}</header>
              {outLinks.length === 0 ? (
                <p className="u-aux">正文里还没有 [[链接]]；点上方「引用」也可主动添加。</p>
              ) : (
                outLinks.map((l) =>
                  l.dst_note_id != null ? (
                    <button key={l.id} className="links__item" onClick={() => void selectNote(l.dst_note_id!)}>
                      <strong>{l.dst_title}</strong>
                    </button>
                  ) : (
                    <button
                      key={l.id}
                      className="links__item links__item--dangling"
                      onClick={() => void handleCreateFromLink(l.dst_title)}
                      title="目标笔记还不存在，点击创建并绑定"
                    >
                      <span className="dangling">[[{l.dst_title}]]</span>
                      <span className="u-aux"><Plus size={11} /> 创建</span>
                    </button>
                  )
                )
              )}
            </section>
            {/* N-§1.3#8：归属分组（任务关联 + 所在文件夹） */}
            <section className="links__card">
              <header className="links__head">
                归属 · {attachedTasks.length + (current.folder_id ? 1 : 0)}
              </header>
              {current.folder_id ? (
                <p className="u-aux">
                  文件夹 · {folders.find((f) => f.id === current.folder_id)?.name ?? '未知'}
                </p>
              ) : (
                <p className="u-aux">未归属文件夹</p>
              )}
              {attachedTasks.length === 0 ? (
                <p className="u-aux">还没有关联任务；点上方「归属」可挂到某任务或某文件夹。</p>
              ) : (
                attachedTasks.map((task) => (
                  <p key={task.id} className="u-aux">
                    任务 · {task.title}
                  </p>
                ))
              )}
            </section>
            {dangling.length > 0 && (
              <p className="u-aux">有 {dangling.length} 条待建链接，点击即可创建目标笔记。</p>
            )}
          </aside>
        )}
        </div>
      </div>
      </div>

      {ctxMenu && (
        <PopMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              key: 'pin',
              label: notes.find((n) => n.id === ctxMenu.id)?.pinned ? '取消置顶' : '置顶',
              onPick: () =>
                void handleTogglePin(ctxMenu.id, !notes.find((n) => n.id === ctxMenu.id)?.pinned),
            },
            {
              key: 'rename',
              label: '重命名…',
              onPick: () => {
                const note = notes.find((n) => n.id === ctxMenu.id)
                void (async () => {
                  const next = await dialog.prompt({
                    title: '重命名笔记',
                    label: '新标题',
                    defaultValue: note?.title ?? '',
                  })
                  if (next?.trim()) await window.zhixing.db.saveNote(ctxMenu.id, { title: next }).then(load)
                })()
              },
            },
            {
              key: 'move',
              label: '移动到文件夹…',
              onPick: () => setMoveMenu({ noteId: ctxMenu.id, x: ctxMenu.x, y: ctxMenu.y }),
            },
            {
              key: 'attach',
              label: '归属到任务…',
              onPick: () => void openTaskPick(ctxMenu.x, ctxMenu.y),
            },
            {
              key: 'history',
              label: '版本历史…',
              onPick: () => setHistoryId(ctxMenu.id),
            },
            {
              key: 'delete',
              label: '删除',
              danger: true,
              onPick: () => void handleDelete(ctxMenu.id),
            },
          ]}
        />
      )}

      {moveMenu && (
        <PopMenu
          x={moveMenu.x}
          y={moveMenu.y}
          onClose={() => setMoveMenu(null)}
          items={[
            {
              key: 'root',
              label: '移出到「全部笔记」',
              onPick: () => void handleMoveNote(moveMenu.noteId, null),
            },
            ...folders.map((f) => ({
              key: `f-${f.id}`,
              label: f.name,
              onPick: () => void handleMoveNote(moveMenu.noteId, f.id),
            })),
          ]}
        />
      )}

      {attachMenu && (
        <PopMenu
          x={attachMenu.x}
          y={attachMenu.y}
          onClose={() => setAttachMenu(null)}
          items={[
            {
              key: 'task',
              label: '关联到任务…',
              onPick: () => void openTaskPick(attachMenu.x, attachMenu.y),
            },
            {
              key: 'folder',
              label: '移动到文件夹…',
              onPick: () =>
                selectedId != null && setMoveMenu({ noteId: selectedId, x: attachMenu.x, y: attachMenu.y }),
            },
          ]}
        />
      )}

      {taskPick && (
        <PopMenu
          x={taskPick.x}
          y={taskPick.y}
          onClose={() => setTaskPick(null)}
          items={[
            {
              key: 'search',
              label: '按关键词搜索…',
              onPick: () => {
                void (async () => {
                  const q = await dialog.prompt({ title: '搜索任务', label: '标题关键词' })
                  if (q === null) return
                  await openTaskPick(taskPick.x, taskPick.y, q)
                })()
              },
            },
            ...(taskPick.items.length
              ? taskPick.items.map((t) => ({
                  key: `t-${t.id}`,
                  label: t.title,
                  onPick: () => void handleAttachTask(t.id, t.title),
                }))
              : [
                  {
                    key: 'none',
                    label: '（没有匹配的未完成任务）',
                    onPick: () => undefined,
                  },
                ]),
          ]}
        />
      )}

      {templateMenu && (
        <PopMenu
          x={templateMenu.x}
          y={templateMenu.y}
          onClose={() => setTemplateMenu(null)}
          items={templates.map((name) => ({
            key: name,
            label: name,
            onPick: () => {
              void (async () => {
                const created = await window.zhixing.db.createNoteFromTemplate(name, null)
                if (!created) return
                await load()
                await selectNote(created.id)
                onNotice(`已按「${name}」新建笔记`)
              })()
            },
          }))}
        />
      )}

      {panel && (
        <PopMenu
          x={panel.x}
          y={panel.y}
          onClose={() => setPanel(null)}
          items={
            panelItems.length
              ? panelItems.map((it) => ({
                  key: it.key,
                  label: it.label,
                  onPick: () => void selectNote(it.id),
                }))
              : [{ key: 'none', label: '没有符合条件的笔记', onPick: () => undefined }]
          }
        />
      )}

      {historyId != null && (
        <NoteHistory
          noteId={historyId}
          onRestored={async () => {
            await load()
            const note = await window.zhixing.db.note(historyId)
            if (note) {
              setCurrent(note)
              setTitle(note.title)
              setContent(note.content_md ?? '')
            }
            onNotice('已回滚到所选版本')
          }}
          onClose={() => setHistoryId(null)}
        />
      )}
    </div>
  )
}

