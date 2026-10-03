import type { EditorView } from '@codemirror/view'
import { sanitizeHtml } from '@shared/sanitize-html'
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import {
  X,
  ChevronRight,
  Database,
  ExternalLink,
  FilePlus2,
  FileText,
  FolderPlus,
  Link2,
  Maximize2,
  Morph,
  IconData,
  Plus,
  Sparkles,
  Tag,
  Trash2,
} from '@renderer/lib/icons'
import { subscribeDomain } from '@shared/events'
import { useDialog } from '../components/Dialogs'
import type { Backlink, Note, NoteFolder, NoteLink } from '@shared/types'
import type { AiLibraryProgress } from '@shared/ai-note'
import { parseLinkItems, type NoteLinkItem } from '@shared/note-links'
import { t } from '../i18n'
import { MarkdownEditor, RichTextEditor, blockFingerprint, locateBlockInView } from '../components/MarkdownEditor'
import { MarkdownView } from '../components/MarkdownView'
import { isMotionFull } from '../lib/presence'
// Excel 网格懒加载：ag-grid 体积可观，只有真的打开 Excel 笔记才下载
const XlsxGrid = lazy(() => import('../components/XlsxGrid'))
import { NoteHistory } from '../components/NoteHistory'
import { NotePicker } from '../components/NotePicker'
import type { MarkdownEditorHandle } from '../components/MarkdownEditor'
import { NOTE_FORMATS, NoteTree, noteIcon, type NoteFormat } from '../components/NoteTree'

/** 知识类型。与主进程 db/knowledge.ts 的 KNOWLEDGE_KINDS 对应（那边是权威）。 */
const KNOWLEDGE_KINDS: { key: string; label: string }[] = [
  { key: 'concept', label: '概念' },
  { key: 'summary', label: '摘要' },
  { key: 'synthesis', label: '综合分析' },
  { key: 'method', label: '方法论' },
  { key: 'output', label: '输出' },
  { key: 'pitfall', label: '踩坑' },
  { key: 'note', label: '笔记' },
  { key: 'project', label: '项目记录' },
]
import { NoteTabs, type NoteTab } from '../components/NoteTabs'
import { KnowledgeChip } from '../components/KnowledgeChip'
import { Toolbar } from '../components/Toolbar'
import { VaultPage } from './VaultPage'
import { PopMenu } from '../components/PopMenu'
import { TagMenu } from '../components/TagMenu'

interface Props {
  onNotice: (message: string) => void
  /** 由其他页面（如图谱）跳转过来时要打开的笔记 */
  initialNoteId?: number | null
  /** 全屏编辑：状态交给 App，左侧主导航才能一起让位 */
  onZenChange?: (zen: boolean) => void
}

/** 笔记标签（与任务共用同一张 tag 表，颜色因此全局一致）。 */
type NoteTag = { id: number; name: string; color: string }

/** 自动保存防抖：输入停顿后落库。 */
const AUTOSAVE_MS = 800

/**
 * 覆盖式抽屉的退场窗口，与 notes.css 里 .links--drawer.is-leaving 那条
 * 动效非 full 档时它同步卸载，不会白等这一下。
 */

/** 读一个时长令牌的毫秒数（--dur-fast）。读不到按 0 处理 = 直接切换。 */
function readTokenMs(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name)
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : 0
}

/** 笔记多标签页：上限。到顶时最久未使用的那个被挤出去（见 docs/note-tabs-plan.md）。 */
const TAB_MAX = 12
/** 已打开笔记的持久化键：纯界面偏好，与 `zhixing.tree.notes` 同一套路，不跟着数据导出。 */
const TABS_KEY = 'zhixing.noteTabs'

/**
 * 读上次的 tab 列表。
 *
 * 这里的输入来自 localStorage，**什么都不可信**：可能被手工改过、可能是旧版本
 * 残留、可能记着一个已经不存在的笔记 id。所以一律过滤成合法形态 ——
 * 只留正整数、去重、截到上限，`active` 必须真的在列表里。
 */
function readStoredTabs(): { ids: number[]; active: number | null } {
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY) ?? '') as { ids?: unknown; active?: unknown }
    const ids = Array.isArray(raw?.ids)
      ? [...new Set(raw.ids.filter((x): x is number => Number.isInteger(x) && (x as number) > 0))].slice(-TAB_MAX)
      : []
    const active = Number.isInteger(raw?.active) && ids.includes(raw.active as number) ? (raw.active as number) : null
    return { ids, active }
  } catch {
    return { ids: [], active: null }
  }
}

/** 链接表格的列宽（与 notes.css 里的 grid 定义保持一致）。 */
const LINK_GAP_W = 6
const LINK_OPS_W = 76
/** 拖动分界时两端各留一成半，避免把某一列拖没 */
const LINK_SPLIT_MIN = 0.15
const LINK_SPLIT_MAX = 0.85

export function NotesPage({ onNotice, initialNoteId = null, onZenChange }: Props) {
  const dialog = useDialog()
  const [notes, setNotes] = useState<Note[]>([])
  const [folders, setFolders] = useState<NoteFolder[]>([])
  /**
   * 已打开的笔记（顺序即打开顺序）与当前 tab。
   *
   * 初次进入从 localStorage 恢复；带 initialNoteId 跳进来时直接把它并进列表并激活 ——
   * 省掉"先激活列表末尾、再切过去"的一次多余读库与内容闪现。
   */
  const bootTabs = useMemo(() => {
    const stored = readStoredTabs()
    if (initialNoteId == null) return stored
    return {
      ids: stored.ids.includes(initialNoteId) ? stored.ids : [...stored.ids, initialNoteId].slice(-TAB_MAX),
      active: initialNoteId,
    }
    // 只在首次渲染算一次：此后 initialNoteId 的变化由下面的 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [openTabs, setOpenTabs] = useState<number[]>(bootTabs.ids)
  const [selectedId, setSelectedId] = useState<number | null>(bootTabs.active)
  /** 笔记列表是否已经拉过一次：tab 收敛要等它，否则会把恢复出来的 id 全当「已删除」清掉。 */
  const [notesLoaded, setNotesLoaded] = useState(false)
  const [current, setCurrent] = useState<Note | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [preview, setPreview] = useState(false)
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [outLinks, setOutLinks] = useState<NoteLink[]>([])
  const [linksOpen, setLinksOpen] = useState(true)
  /**
   * 信息区（属性 / 反向链接 / 引用 / 归属）默认**收起**成一行计数。
   * 为何改：这三组在空态下字数很少，却固定吃掉编辑区约三成高度，
   * 还把「标题 → 正文」的连续阅读打断成四段。展开后与改动前可见性一致。
   */
  const [linksExpanded, setLinksExpanded] = useState(false)
  /** 全屏编辑：只留笔记正文（隐藏页面标题、笔记树、信息区，App 侧同时收起导航） */
  const [zen, setZen] = useState(false)
  /**
   * 笔记树是否收起。与任务页、工作流页同一个约定：纯界面偏好，
   * 存 localStorage（不该跟着数据一起被导出 / 同步）。
   */
  const [treeHidden, setTreeHidden] = useState(() => localStorage.getItem('zhixing.tree.notes') === '1')
  useEffect(() => {
    localStorage.setItem('zhixing.tree.notes', treeHidden ? '1' : '0')
  }, [treeHidden])
  /**
   * 知识库筛选。
   *
   * 知识库**不是一个独立页面** —— 类型与可信状态是笔记自己的属性，
   * 所以它们在这里以筛选的形式存在（原方案里"六个区域"说的是区域，不是页面）。
   */
  /** 这一页有两个视图：知识库（默认）与保险箱。入口在工具栏最右端。 */
  const [view, setView] = useState<'notes' | 'vault'>('notes')
  /**
   * 笔记树的搜索词。
   *
   * 搜索框原本长在树上（NoteTree 自己持有 state），现在挪到页面工具栏 ——
   * 它是「对这一页所有内容的筛选」，归属该在这一层。树那边改成受控。
   */
  const [treeQuery, setTreeQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'verified' | 'draft' | 'archived' | 'noSource'>('all')
  /** id → { kind, verified }，由主进程按"全部状态含归档"一次取回 */
  const [metaById, setMetaById] = useState<
    Record<number, { kind: string; verified: boolean; archived: boolean; hasSource: boolean }>
  >({})

  /**
   * 取一次知识元信息（类型 + 可信状态）。
   * 用 status:'all' 与 includeArchived:true 把**所有**笔记都拿回来 ——
   * 只拿可用的话，待确认的条目在树上会凭空消失。
   */
  const reloadMeta = useCallback(async (): Promise<void> => {
    const k = window.zhixing.knowledge
    if (!k) return
    const rows = await k.list({ kind: 'all', status: 'all', includeArchived: true, limit: 1000 })
    if (!rows) return
    const map: Record<
      number,
      { kind: string; verified: boolean; archived: boolean; hasSource: boolean }
    > = {}
    for (const r of rows) map[r.id] = {
      kind: r.kind,
      verified: !!r.verified_at,
      archived: !!r.archived_at,
      hasSource: !!r.has_source,
    }
    setMetaById(map)
  }, [])

  /**
   * 把模板结构插进正文。
   *
   * **追加而不是覆盖** —— 用户可能已经写了一半，覆盖等于毁掉他的输入。
   * 有内容时在中间留一个空行，免得模板的第一个标题贴着上一段。
   */
  const insertTemplate = useCallback((text: string): void => {
    if (!text) return
    setContent((prev) => (prev.trim() ? prev.replace(/\s*$/, '') + '\n\n' + text : text))
    setDirty(true)
  }, [])

  const mainRef = useRef<HTMLDivElement | null>(null)
  /** 正文区：切 tab / 换笔记时在它身上补一次极轻的淡入（见下面的 effect） */
  const sheetBodyRef = useRef<HTMLDivElement | null>(null)
  const bodyFadeRef = useRef<Animation | null>(null)
  /** 上一次做淡入的笔记 id，null 表示还没进过这篇（首次进入不播，页面本身已有进场动画） */
  const fadeFromRef = useRef<number | null>(null)
  const [dirty, setDirty] = useState(false)
  /**
   * 装载时的正文基线。
   *
   * 用来回答"这次 onChange 是真的用户在改，还是编辑器在装载时回调了一次" ——
   * 后者在 MarkdownEditor（外部同步 dispatch）与 RichTextEditor（初始化）上都会发生，
   * 无条件置 dirty 会让刚打开的笔记直接显示"未保存"。
   */
  const baselineRef = useRef('')
  /**
   * 编辑器是否已经装载完成。
   *
   * 原先想用"内容与装载基线是否相同"来判断这次 onChange 算不算改动，
   * **但这条路不可靠**：编辑器的序列化结果与 content_md 未必逐字相同
   * （尾随换行、格式规范化），于是它一回调就被判成"脏"，而 setContent 又
   * 触发下一次 render 与回调 —— dirty 恒为 true，保存完立刻又被置回来。
   *
   * 改成时间维度：装载完成后的一小段（等编辑器把初始化那几次回调走完）
   * 才把 ready 置起来，之前的 onChange 一律不计入 dirty。
   */
  const editorReadyRef = useRef(false)

  const reportEditorChange = useCallback((v: string): void => {
    if (editorReadyRef.current) setDirty(true)
    void v
  }, [])
  /**
   * Word/Excel「还没写回本地文件」的状态，与 dirty 分开记。
   *
   * 为什么要分：dirty 说的是「标题 / content_md 还没落库」，而 Word 的正文不在 content_md 里 ——
   * 它走 commitWord 写回 .docx。混成一个的话，自动保存那条 effect 会在 800ms 后把 dirty 清掉，
   * 于是文件还没写回、标题栏已经显示「已保存」。胶囊取两者的并集。
   */
  const [officePending, setOfficePending] = useState(false)
  /** 新建笔记时使用的格式 */
  const [historyId, setHistoryId] = useState<number | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  /** 全部标签（任务与笔记共用一套）：标签弹层用它列候选 */
  const [allTags, setAllTags] = useState<NoteTag[]>([])
  /** 每篇笔记的标签：左侧树与编辑器都从这里取胶囊 */
  const [tagsOf, setTagsOf] = useState<Map<number, NoteTag[]>>(new Map())
  /** 标签弹层的锚点（点胶囊或「加标签」时打开） */
  const [tagMenu, setTagMenu] = useState<{ x: number; y: number } | null>(null)
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
  /** 「移动到文件夹…」目标菜单 */
  const [moveMenu, setMoveMenu] = useState<{ noteId: number; x: number; y: number } | null>(null)
  /** 标题行那个动作菜单：移动到文件夹（归属）+ 关联到任务（引用）两件事 */
  const [attachMenu, setAttachMenu] = useState<{ x: number; y: number } | null>(null)
  /** 归属选择器：候选任务列表 */
  const [taskPick, setTaskPick] = useState<{
    x: number
    y: number
    /** 带 listName / groupName —— 弹层按 分组 → 列表 → 任务 展示层级 */
    items: { id: number; title: string; listName: string; groupName: string }[]
  } | null>(null)
  /** 引用了这篇的任务（链接面板「反向链接」栏）。任务用 [[标题]] 引用笔记，属引用关系 */
  const [attachedTasks, setAttachedTasks] = useState<{ id: number; title: string }[]>([])
  /** Word/Excel 可编辑内容 */
  const [officeEdit, setOfficeEdit] = useState<{ kind: string; html: string; rows: string[][]; message: string } | null>(null)
  const [excelRows, setExcelRows] = useState<string[][]>([])
  /** AI 整理进行中（请求可能跑几十秒，期间按钮要禁用并给出文案） */
  const [aiBusy, setAiBusy] = useState(false)
  /** 整库整理任务：非空表示正在跑（进度由主进程推送） */
  const [libJob, setLibJob] = useState<AiLibraryProgress | null>(null)
  /**
   * 链接笔记的编辑草稿。为什么要单独存一份：序列化会丢掉 target 还没填的空行，
   * 直接以 content 为唯一真相的话，「添加链接」后那一行会立刻消失。
   */
  const [linkDraft, setLinkDraft] = useState<NoteLinkItem[] | null>(null)
  /** 链接表格里「标题 : 链接」的宽度比例（拖分界手柄调整，记在 localStorage） */
  const [linkSplit, setLinkSplit] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem('notes.linkSplit'))
      return Number.isFinite(v) && v >= LINK_SPLIT_MIN && v <= LINK_SPLIT_MAX ? v : 0.5
    } catch {
      return 0.5
    }
  })
  /** 同 id 重载计数器：AI 改写后标题/正文/文件夹都变了，得把加载流程再跑一遍 */
  const [reloadToken, setReloadToken] = useState(0)
  /** 右键选中的那一段（等待选任务后建立关联） */
  const [blockDraft, setBlockDraft] = useState<{ text: string; blockKey: string } | null>(null)

  /** 笔记属性（每行一条 key: value），落库为 JSON 对象 */
  const [propDraft, setPropDraft] = useState('')
  /** 信息区底部新增行用：属性填「键: 值」，引用填标题 */
  const [propNew, setPropNew] = useState('')
  /** 正向引用的笔记选择器锚点（null = 未打开） */
  const [linkPick, setLinkPick] = useState<DOMRect | null>(null)
  /** 正文里输入 [[ 的位置（null = 没在补全） */
  const [linkTrigger, setLinkTrigger] = useState<{ from: number; to: number; query: string } | null>(null)
  /** Markdown 编辑器的 view，补全选中后要用它替换那半截 [[ */
  const mdViewRef = useRef<MarkdownEditorHandle | null>(null)

  const propsToText = (raw?: string | null): string => {
    if (!raw) return ''
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>
      return Object.entries(obj)
        .map(([k, v]) => k + ': ' + String(v))
        .join('\n')
    } catch {
      return ''
    }
  }

  const parsePropsText = (text: string): string => {
    const obj: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const i = line.indexOf(':')
      if (i <= 0) continue
      const k = line.slice(0, i).trim()
      const v = line.slice(i + 1).trim()
      if (k) obj[k] = v
    }
    return JSON.stringify(obj)
  }

  /**
   * 属性列表。**propDraft 仍是唯一真相** —— 这里是它的只读视图。
   * 信息区改成胶囊展示后需要"一条一条"的形态，但保存路径没变：
   * 仍把整段文本解析成 JSON 存进 props。少一个数据源，就少一处不一致。
   */
  const propItems = propDraft
    .split('\n')
    .map((line) => {
      const i = line.indexOf(':')
      if (i <= 0) return null
      const k = line.slice(0, i).trim()
      if (!k) return null
      return { key: k, value: line.slice(i + 1).trim() }
    })
    .filter((x): x is { key: string; value: string } => x !== null)

  /** 改属性都落到 propDraft 并立刻保存 —— 不让用户改完还得再点一次保存 */
  const writeProps = async (lines: string[]): Promise<void> => {
    const text = lines.join('\n')
    setPropDraft(text)
    if (selectedId == null) return
    await window.zhixing.db.saveNote(selectedId, { props: parsePropsText(text) })
    await load()
  }

  const addProp = (): void => {
    const raw = propNew.trim()
    if (!raw) return
    // 允许只写键（"来源"）不写值 —— 先把位置占下来也是常见用法
    const line = raw.includes(':') ? raw : raw + ': '
    void writeProps(propItems.map((p) => p.key + ': ' + p.value).concat(line)).then(() =>
      setPropNew('')
    )
  }

  const removeProp = (key: string): void => {
    void writeProps(propItems.filter((p) => p.key !== key).map((p) => p.key + ': ' + p.value))
  }

  /**
   * 从正文里删掉那一行 [[标题]]。
   * 用整行字符串比较而不是正则：标题里可能有正则元字符，转义漏一个就会误删别的行。
   */
  const dropLinkLine = (contentMd: string, title: string): string =>
    contentMd
      .split('\n')
      .filter((line) => line.trim() !== '[[' + title + ']]')
      .join('\n')

  const handleRemoveOutLink = (l: { dst_title: string }): void => {
    if (!current) return
    const next = dropLinkLine(current.content_md ?? '', l.dst_title)
    void window.zhixing.db.saveNote(current.id, { content_md: next }).then(async () => {
      await load()
      onNotice('已删除引用')
    })
  }

  /**
   * 反向链接：**改的是对方那篇笔记的正文**。
   *
   * 反链不是一条独立记录，而是"别人的正文里写着 [[这篇的标题]]"。
   * 所以删它只能去改对方的内容 —— 这也是为什么要先确认：
   * 它在动一篇用户当前没在看的笔记。
   */
  const handleRemoveBacklink = async (b: {
    src_note_id: number
    src_title: string
  }): Promise<void> => {
    if (!current) return
    const ok = await dialog.confirm({
      title: '删除反向链接',
      message:
        '「' +
        b.src_title +
        '」的正文里写着指向这篇的 [[' +
        (current.title ?? '') +
        ']]。删掉会改的是那一篇，不是这一篇。',
      confirmText: '删掉那条链接',
      danger: true,
    })
    if (!ok) return
    const src = await window.zhixing.db.note(b.src_note_id)
    if (!src) return
    const next = dropLinkLine(src.content_md ?? '', current.title ?? '')
    await window.zhixing.db.saveNote(b.src_note_id, { content_md: next })
    await load()
    onNotice('已从「' + b.src_title + '」里删掉那条链接')
  }

  /**
   * 把文件夹按层级展开成「父在前、子紧随」的序列，并带上深度。
   *
   * 直接 folders.map 出来的是平铺列表，看不出谁属于谁 —— 用户报的
   * 「移动到文件夹的弹窗没有层级」就是这个。先排序再给 depth，弹层负责缩进。
   */
  const folderTree = (): { f: NoteFolder; depth: number }[] => {
    const walk = (parentId: number | null, depth: number): { f: NoteFolder; depth: number }[] =>
      folders
        .filter((f) => (f.parent_id ?? null) === parentId)
        .flatMap((f) => [{ f, depth }].concat(walk(f.id, depth + 1)))
    return walk(null, 0)
  }

  /** 归属栏：点文件夹胶囊在笔记树里定位它 */
  const handleRevealFolder = (id: number): void => {
    window.dispatchEvent(new CustomEvent('zhixing:open-note-folder', { detail: { id } }))
  }

  const handleMoveNoteToFolder = (folderId: number | null): void => {
    if (!current) return
    void handleMoveNote(current.id, folderId)
  }

  /** 归属栏：点任务胶囊跳到那个任务 */
  const handleOpenTask = (id: number): void => {
    window.dispatchEvent(new CustomEvent('zhixing:open-task', { detail: { id } }))
  }

  const handleDetachTask = (taskId: number): void => {
    if (!current) return
    void window.zhixing.db.detachTaskNote(taskId, current.id).then(async () => {
      await load()
      onNotice('已解除关联')
    })
  }

  // 切笔记时把属性铺进编辑框
  useEffect(() => {
    setPropDraft(propsToText(current?.props))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.props])
  const officeTimer = useRef<number | null>(null)

  const isOffice = current?.format === 'word' || current?.format === 'excel'

  /**
   * 标签：一次取「全部标签 + 每篇笔记挂的标签」。
   *
   * 颜色写在共用的 tag 表里，所以这里读到的色值同时决定任务页胶囊与笔记胶囊的颜色；
   * 改色之后也是重新走这个函数对齐两份状态。
   */
  const loadNoteTags = useCallback(async (): Promise<void> => {
    const [tg, nt] = await Promise.all([window.zhixing.db.tags(), window.zhixing.db.noteTags()])
    setAllTags(tg)
    const map = new Map<number, NoteTag[]>()
    for (const r of nt) {
      const list = map.get(r.note_id) ?? []
      list.push({ id: r.id, name: r.name, color: r.color })
      map.set(r.note_id, list)
    }
    setTagsOf(map)
  }, [])

  const load = useCallback(async () => {
    /**
   * 取一次知识元信息（类型 + 可信状态）。
   * 用 status:'all' 与 includeArchived:true 把**所有**笔记都拿回来 ——
   * 只拿可用的话，待确认的条目在树上会凭空消失。
   */
  void reloadMeta()

  const fs0 = await window.zhixing.db.noteFolders()
    // 文件夹为空时补默认文件夹
    if (fs0.length === 0) {
      await window.zhixing.db.ensureDefaultFolder()
    }
    const [rows, fs] = await Promise.all([
      window.zhixing.db.notes(),
      fs0.length === 0 ? window.zhixing.db.noteFolders() : Promise.resolve(fs0),
    ])
    setNotes(rows)
    setFolders(fs)
    setNotesLoaded(true)
    await loadNoteTags()
  }, [loadNoteTags])

  useEffect(() => {
    void load()
    void window.zhixing.db.noteTemplates().then(setTemplates)
  }, [load])

  // 跨页跳转：带着笔记 id 进来时打开（或激活）它。首次挂载那一次已经并进 bootTabs，
  // 这里负责「人已经在笔记页、又被别处跳过来」的情况。
  useEffect(() => {
    if (initialNoteId != null) void selectNote(initialNoteId)
    // selectNote 每次渲染都是新引用，进依赖会让它每渲染跑一遍
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // 装载基线：编辑器初始化/外部同步时回调的 onChange 与它相同，不算改动
      baselineRef.current = note.content_md ?? ''
      /*
        装载期间编辑器会回调若干次 onChange（Markdown 是外部同步的 dispatch、
        富文本是初始化）。那些都不算用户改动 —— 等这一帧过去再开闸。
      */
      editorReadyRef.current = false
      window.setTimeout(() => {
        editorReadyRef.current = true
      }, 0)
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

  // 换一篇笔记就重置「写回待完成」：文件是另一篇的
  useEffect(() => {
    setOfficePending(false)
  }, [current?.id])

  // 别的页面改了笔记（新建/删除/改标题）会影响反链；这里只更新反链与归属，
  // 不重载正文 —— 当前笔记可能正在编辑，整篇重载会覆盖输入。
  useEffect(() => {
    if (selectedId == null) return
    return subscribeDomain(['note'], () => {
      void window.zhixing.db.backlinks(selectedId).then(setBacklinks)
      void window.zhixing.db.noteAttachedTasks(selectedId).then(setAttachedTasks)
      // 标签是 note 域的数据（note_tag）：别的页面改了标签颜色 / 关联，这里要跟着换
      void loadNoteTags()
    })
  }, [selectedId, loadNoteTags])

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
   * 静默丢弃。这里补齐。
   */
  const flushPending = useCallback(async (): Promise<void> => {
    if (!current || !dirty) return
    if (timer.current) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    await persist(current.id, { title, content_md: content })
  }, [current, dirty, persist, title, content])

  // 整库整理的进度订阅：主进程逐篇推进时会推过来，最后一帧 running=false 用于收尾
  useEffect(() => {
    let alive = true
    void window.zhixing.ai.libraryProgress().then((p) => {
      if (alive && p?.running) setLibJob(p)
    })
    const off = window.zhixing.ai.onLibraryProgress((p) => {
      setLibJob(p.running ? p : null)
      if (!p.running) {
        onNotice(
          `整库整理结束：成功 ${p.ok} 篇${p.failed ? `，失败 ${p.failed} 篇` : ''}${
            p.skipped ? `，跳过 ${p.skipped} 篇` : ''
          }`
        )
        void load()
      }
    })
    return () => {
      alive = false
      off()
    }
  }, [load, onNotice])

  /** 拖动链接表格的分界：按可用宽度（减去操作列与分界列）换算比例 */
  const startColumnResize = (e: ReactPointerEvent<HTMLSpanElement>): void => {
    const table = e.currentTarget.closest('.link-table') as HTMLElement | null
    if (!table) return
    const rect = table.getBoundingClientRect()
    const avail = Math.max(1, rect.width - LINK_OPS_W - LINK_GAP_W)
    const onMove = (ev: PointerEvent): void => {
      const ratio = (ev.clientX - rect.left) / avail
      setLinkSplit(Math.min(LINK_SPLIT_MAX, Math.max(LINK_SPLIT_MIN, ratio)))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      // 松手才落库：拖动过程中每帧写一次 localStorage 没必要
      setLinkSplit((v) => {
        try {
          localStorage.setItem('notes.linkSplit', String(v))
        } catch {
          // 存不了就只在本次会话里生效
        }
        return v
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    e.preventDefault()
  }

  /** 链接列表改动：草稿 + 正文一起更新（正文走既有的自动保存） */
  const updateLinkItems = (next: NoteLinkItem[]): void => {
    setLinkDraft(next)
    setContent(JSON.stringify(next))
    setDirty(true)
  }

  /** 换笔记 / 重新载入时丢掉链接草稿，让编辑器重新跟随正文 */
  useEffect(() => {
    setLinkDraft(null)
  }, [selectedId, reloadToken])

  /**
   * 整库整理：逐篇交给主进程（串行、每篇独立审计）。
   * 正在跑时这个按钮变成「停止」—— 停止只影响下一篇，已经发出的那篇会跑完入库。
   */
  /** 附件：选文件 → 主进程复制进数据目录并落库 → 在正文末尾补一条链接 */
  const handleAddAttachment = async (): Promise<void> => {
    if (selectedId == null) {
      onNotice('先在左侧选一篇笔记')
      return
    }
    const res = await window.zhixing.db.pickAttachment(selectedId)
    if (!res.ok) {
      onNotice(res.message)
      return
    }
    const note = notes.find((n) => n.id === selectedId)
    const lines = res.paths.map((p) => {
      const name = p.split(/[\\/]/).pop() ?? p
      return `📎 [${name}](file:///${p.replace(/\\/g, '/')})`
    })
    const next = `${note?.content_md ?? ''}\n\n${lines.join('\n')}\n`
    await window.zhixing.db.saveNote(selectedId, { content_md: next })
    setContent(next)
    setDirty(false)
    await load()
    onNotice(res.message)
  }

  const handleLibraryOrganize = async (): Promise<void> => {
    if (libJob) {
      // 取消现在会回一句人话：没在跑时说「当前没有正在运行的整库整理」，
      // 而不是把 false 静默吞掉
      const res = await window.zhixing.ai.cancelLibrary()
      onNotice(res.message)
      return
    }
    const all = await window.zhixing.db.notes()
    if (!all.length) {
      onNotice('笔记库还是空的')
      return
    }
    const confirmed = await dialog.confirm({
      title: '整理全库',
      message:
        `将逐篇把 ${all.length} 篇笔记交给大模型整理，并直接改写原笔记。\n\n` +
        '· Markdown/富文本：重排正文；Word/Excel：只归类；链接笔记：分配每条链接的去向\n' +
        '· 每篇都会先过审计，不通过就不写库\n' +
        '· 正文变更前会留一份版本快照，可在笔记历史里回滚\n' +
        '· 篇数多时要跑一阵，随时可以停止',
      icon: <Sparkles size={15} />,
      tone: 'warning',
      confirmText: '开始整理',
    })
    if (!confirmed) return
    const res = await window.zhixing.ai.organizeLibrary()
    if (!res.ok) onNotice(res.message)
    else if (res.failedTitles.length) {
      onNotice(`${res.message}；失败：${res.failedTitles.join('、')}`)
    }
  }

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

  /**
   * 所有「打开笔记」的入口都走这里（笔记树、`[[标题]]`、反链 / 出链、命令面板、
   * 跨页跳转…）：先落盘，再把这篇放进 tab 列表并激活。
   *
   * 已打开的笔记**只激活、不重复开** —— 树上反复点是安全的；未打开的才新开一个，
   * 超过 TAB_MAX 时最久未使用的那个被挤出去（当前这篇刚进队尾，不会挤到自己）。
   */
  const selectNote = useCallback(
    async (id: number | null): Promise<void> => {
      await flushPending()
      if (id == null) {
        setSelectedId(null)
        return
      }
      setOpenTabs((prev) => {
        if (prev.includes(id)) return prev
        const next = [...prev, id]
        return next.length > TAB_MAX ? next.slice(next.length - TAB_MAX) : next
      })
      setSelectedId(id)
    },
    [flushPending]
  )

  /**
   * 关掉一个 tab，并决定接下来激活谁：**右邻 → 左邻 → 空态**。
   *
   * `flush` 决定关闭前要不要把未落盘的正文写回去：正常关闭要（否则丢掉最后 <800ms
   * 的输入），**删除笔记时必须传 false** —— 那篇已经从库里没了，落盘会写一篇本不该存在的笔记。
   */
  const dropTab = useCallback(
    async (id: number, flush: boolean): Promise<void> => {
      const idx = openTabs.indexOf(id)
      if (idx < 0) return
      const next = openTabs.filter((x) => x !== id)
      if (id === selectedId) {
        if (flush) await flushPending()
        setSelectedId(next[idx] ?? next[idx - 1] ?? null)
      }
      setOpenTabs(next)
    },
    [openTabs, selectedId, flushPending]
  )

  /** 给 tab 条用的关闭入口（事件回调不 await，包一层）。 */
  const handleCloseTab = useCallback(
    (id: number): void => {
      void dropTab(id, true)
    },
    [dropTab]
  )

  // tab 列表里不允许有已经不存在的笔记：删笔记、换库、回收站恢复之后都要收敛。
  // 必须等第一次 load() 完成 —— 否则启动瞬间 notes 还是空的，恢复出来的 id 会被全当「已删除」清掉。
  useEffect(() => {
    if (!notesLoaded) return
    const alive = new Set(notes.map((n) => n.id))
    setOpenTabs((prev) => {
      const next = prev.filter((id) => alive.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [notes, notesLoaded])

  // 不变量：当前笔记必须属于 tab 列表（列表为空时才没有当前笔记）。
  // 守住它，「树上高亮的那篇」与「tab 条里选中的那枚」才永远指同一篇。
  useEffect(() => {
    if (selectedId != null && openTabs.includes(selectedId)) return
    setSelectedId(openTabs.length ? openTabs[openTabs.length - 1] : null)
  }, [openTabs, selectedId])

  // 持久化：切页会卸载整个笔记页，重启更不用说 —— 恢复全靠这里记下的这一份
  useEffect(() => {
    localStorage.setItem(TABS_KEY, JSON.stringify({ ids: openTabs, active: selectedId }))
  }, [openTabs, selectedId])

  // 关窗/刷新前也把未落盘的编辑冲出去：
  // 之前只有「切笔记」8 个入口会 flush，直接关窗会丢最后 <800ms 的输入。
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

  /**
   * 切走（组件卸载）时把防抖窗口里的编辑冲掉。
   *
   * 不能把这一步写进上面那个 effect 的 cleanup：它的依赖含 title / content，
   * **每敲一个字 cleanup 都会跑一次**，在那里落盘就等于取消防抖、一字一次写库。
   * 所以用 ref 存一份「当前待落盘的内容」，交给一个空依赖的 effect，只在真正卸载时调用。
   */
  const flushOnUnmount = useRef<() => void>(() => {})
  flushOnUnmount.current = () => {
    if (!current || !dirty) return
    if (timer.current) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    void persist(current.id, { title, content_md: content })
  }
  useEffect(() => () => flushOnUnmount.current(), [])

  /** 在正文里找下一个匹配并选中。 */
  const findNext = useCallback((): void => {
    const needle = findText
    if (!needle) return
    if (current?.format === 'richtext') {
      // 富文本用浏览器原生查找；
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

  /** 查找下一处并替换。 */
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
   * 新建笔记：
   * 类型由左栏选择；Word/Excel/链接 额外问一次目标（文件路径或 URL），
   * Word/Excel 留空时自动生成空白文件。
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

  // 应用内快捷键由 App 统一监听，页面只负责自己的动作
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

  /** 点击悬空 [[标题]]：按标题新建并绑定该引用。 */
  const handleCreateFromLink = async (linkTitle: string): Promise<void> => {
    if (selectedId == null) return
    const dst = await window.zhixing.db.materializeDangling(selectedId, linkTitle)
    if (dst == null) return
    onNotice(`已创建并绑定「${linkTitle}」`)
    await load()
    setOutLinks(await window.zhixing.db.outLinks(selectedId))
    await selectNote(dst)
  }

  /** 主动建引用。 */
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

  /** 关联到任务。这是**引用**关系，不是归属 —— 见 docs/specs/ownership-vs-reference.md */
  const handleAttachTask = async (taskId: number, taskTitle: string): Promise<void> => {
    if (selectedId == null) return
    const added = await window.zhixing.db.attachTaskNote(taskId, selectedId)
    onNotice(added ? `已把本笔记关联到任务「${taskTitle}」` : `本笔记已关联任务「${taskTitle}」，未重复归属`)
    setAttachedTasks(await window.zhixing.db.noteAttachedTasks(selectedId))
  }

  /**
   * 段落级关联（右键触发）：**只建立关联关系，不做任何状态回写**。
   * 这段文字已经关联过任务 → 直接解除；否则打开任务选择器挑一个任务。
   */
  const handleBlockContext = async (info: {
    text: string
    blockKey: string
    x: number
    y: number
  }): Promise<void> => {
    if (selectedId == null) return
    const links = await window.zhixing.db.contextsForNote(selectedId)
    const hit = links.find((l) => l.block_key === info.blockKey)
    if (hit) {
      const n = await window.zhixing.db.detachBlock(hit.task_id, selectedId, info.blockKey)
      onNotice(n ? '已解除这段文字与任务的关联' : '这段文字没有关联任务')
      setReloadToken((t) => t + 1)
      return
    }
    setBlockDraft({ text: info.text, blockKey: info.blockKey })
    await openTaskPick(info.x, info.y)
  }

  /** 把右键选中的那一段挂到任务上。 */
  const handleAttachBlock = async (taskId: number, taskTitle: string): Promise<void> => {
    if (selectedId == null || !blockDraft) return
    const res = await window.zhixing.db.attachBlock(
      taskId,
      selectedId,
      blockDraft.blockKey,
      blockDraft.text.slice(0, 120)
    )
    setBlockDraft(null)
    setReloadToken((t) => t + 1)
    onNotice(res ? `已把这段文字关联到「${taskTitle}」` : '关联失败或已存在')
  }

  /** 打开任务候选选择器。 */
  const openTaskPick = async (x: number, y: number, q = ''): Promise<void> => {
    const items = await window.zhixing.db.noteTaskCandidates(q)
    setTaskPick({ x, y, items })
  }

  /** 移动到文件夹。 */
  const handleMoveNote = async (noteId: number, folderId: number | null): Promise<void> => {
    const saved = await window.zhixing.db.saveNote(noteId, { folder_id: folderId })
    const name = folderId == null ? '全部笔记' : folders.find((f) => f.id === folderId)?.name ?? ''
    onNotice(saved ? `已把笔记移入「${name}」` : '移动失败')
    /**
     * 必须显式更新 current。
     *
     * load() 只刷新 notes 与 folders 两张列表，**不动 current** ——
     * 而信息区「归属」栏读的是 current.folder_id。于是移动之后笔记树里
     * 那篇已经换了位置、信息区却还显示旧文件夹。
     */
    if (saved) setCurrent(saved)
    await load()
  }

  const handleCreateFolder = async (parentId: number | null): Promise<void> => {
    const name = await dialog.prompt({ title: '新建文件夹', label: '文件夹名称' })
    if (!name?.trim()) return
    await window.zhixing.db.createNoteFolder(name, parentId)
    await load()
  }

  /** 重命名文件夹。 */
  const handleRenameFolder = async (id: number, currentName: string): Promise<void> => {
    const name = await dialog.prompt({ title: '重命名文件夹', label: '文件夹名称', defaultValue: currentName })
    if (!name?.trim()) return
    await window.zhixing.db.renameNoteFolder(id, name.trim())
    await load()
    onNotice('已重命名文件夹')
  }

  /** 删除文件夹。 */
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

  /** 移动文件夹到新父级。 */
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
    const confirmed = await dialog.confirm({
      title: '删除笔记',
      message: `删除笔记「${note.title}」？\n软删除，可在回收站恢复。`,
      icon: <Trash2 size={15} />,
      danger: true,
      confirmText: '删除',
    })
    if (!confirmed) return
    await window.zhixing.db.deleteNote(id)
    // 删掉的笔记不该在 tab 里留一个死标签：关掉它，并激活右邻。
    // flush=false —— 这篇已经从库里没了，落盘会写一篇本不该存在的笔记。
    await dropTab(id, false)
    await load()
    onNotice('已删除（可在回收站恢复）')
  }

  /** 选文转任务：建任务、备注带回源引用，blockKey 非空时落段落锚。 */
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

  /** Word 写回。 */
  const commitWord = useCallback(
    async (html: string) => {
      if (!current || current.format !== 'word') return
      const res = await window.zhixing.db.saveWordNote(current.id, html)
      // 成功不弹提示：保存状态由标题栏的胶囊表达 —— 每停一次手就弹一条「已写回 …」是纯噪音。
      // 失败必须说，那时胶囊还停在「未保存」，用户需要知道为什么。
      if (res.ok) setOfficePending(false)
      else onNotice(res.message)
    },
    [current, onNotice]
  )

  /** Excel 写回。 */
  const scheduleExcelSave = useCallback(
    (rows: string[][]) => {
      if (!current || current.format !== 'excel') return
      setExcelRows(rows)
      setOfficePending(true)
      if (officeTimer.current) window.clearTimeout(officeTimer.current)
      const id = current.id
      officeTimer.current = window.setTimeout(() => {
        void window.zhixing.db.saveExcelNote(id, rows).then((res) => {
          // 与 Word 同一口径：成功静默，失败才提示
          if (res.ok) setOfficePending(false)
          else onNotice(res.message)
        })
      }, 1000)
    },
    [current, onNotice]
  )

  /**
   * 段落锚定位：任务/图谱/深链想跳到笔记的某一段时
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

  // 深链段落定位。主进程把 block 一并下发（preload onDeepLink），
  // 这里独立消费，不必改 App.tsx 的跨页路由。
  const locateRef = useRef(locateBlock)
  locateRef.current = locateBlock
  const selectRef = useRef(selectNote)
  selectRef.current = selectNote
  // 回调里读最新 ref，所以依赖为空；preload 的 on* 现在返回取消函数，直接交给 effect 收尾
  useEffect(
    () =>
      window.zhixing.app.onDeepLink((link) => {
        if (link.kind !== 'note') return
        if (link.id) void selectRef.current(link.id)
        if (link.block) window.setTimeout(() => locateRef.current(link.block), 400)
      }),
    []
  )

  /** 当前笔记的标签胶囊 */
  const currentTags = useMemo(
    () => (current ? tagsOf.get(current.id) ?? [] : []),
    [current, tagsOf]
  )

  const openTagMenu = (e: ReactMouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setTagMenu({ x: r.left, y: r.bottom + 4 })
  }

  /**
   * 笔记标签与任务标签共用一套：覆盖式写回（清空后重插），标签不存在时按名新建，
   * 与任务侧 handleToggleTag 同一套语义 —— 于是「标签管理」里的重命名 / 合并 / 删除
   * 自动同时作用于任务与笔记。
   */
  const handleToggleNoteTag = async (tag: NoteTag): Promise<void> => {
    if (!current) return
    const cur = (tagsOf.get(current.id) ?? []).map((x) => x.name)
    const next = cur.includes(tag.name) ? cur.filter((n) => n !== tag.name) : [...cur, tag.name]
    await window.zhixing.db.setNoteTags(current.id, next)
    await loadNoteTags()
  }

  const handleCreateNoteTag = async (): Promise<void> => {
    if (!current) return
    const name = await dialog.prompt({ title: '新建标签', label: '标签名称（可逗号分隔多个）' })
    if (!name?.trim()) return
    const added = name
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (added.length === 0) return
    const cur = (tagsOf.get(current.id) ?? []).map((x) => x.name)
    await window.zhixing.db.setNoteTags(current.id, [...cur, ...added])
    await loadNoteTags()
    onNotice('已添加标签')
  }

  /** 改标签颜色：取色器拖动会连续触发，所以先乐观更新本地两份状态，再把色值写库 */
  const handleSetTagColor = async (id: number, color: string): Promise<void> => {
    setAllTags((prev) => prev.map((x) => (x.id === id ? { ...x, color } : x)))
    setTagsOf((prev) => {
      const next = new Map<number, NoteTag[]>()
      for (const [k, list] of prev) {
        next.set(k, list.map((x) => (x.id === id ? { ...x, color } : x)))
      }
      return next
    })
    await window.zhixing.db.setTagColor(id, color)
  }

  /** 属性条数：信息条收起时也要能看到「有几条」，不然用户不知道点开有什么 */
  const propCount = propDraft.split('\n').filter((l) => l.trim()).length

  /**
   * 笔记多标签切换：正文区补一次极轻的淡入（opacity 0→1，--dur-fast / --ease-enter）。
   *
   * 为什么不用 key 驱动：正文容器里住着 ProseMirror / CodeMirror 实例，给 .sheet 挂 key
   * 会把它整个重建 —— 撤销栈、选区、滚动位置全丢。WAAPI 只补一段 opacity，
   * 元素与实例都原地不动，动画结束（fill:'none'）即回到自然态。
   * 动效非 full 档直接不挂：令牌归零只管得住 CSS，这条得自己判档。
   */
  useEffect(() => {
    const changed = fadeFromRef.current !== null && fadeFromRef.current !== selectedId
    fadeFromRef.current = selectedId
    // 首次进入这篇笔记不播：页面本身已经有一段进场动画
    if (!changed) return
    const el = sheetBodyRef.current
    if (!el || !isMotionFull()) return
    bodyFadeRef.current?.cancel()
    bodyFadeRef.current = el.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: readTokenMs('--dur-fast'),
      easing:
        getComputedStyle(document.documentElement).getPropertyValue('--ease-enter').trim() || 'linear',
      fill: 'none',
    })
  }, [selectedId])

  // 全屏编辑：Esc 退出（与浮层一致，按一次就能回来）
  useEffect(() => {
    if (!zen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setZen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zen])

  // 全屏状态同步给 App（收起左侧主导航）；离开笔记页时还回去
  useEffect(() => {
    onZenChange?.(zen)
  }, [zen, onZenChange])
  useEffect(() => () => onZenChange?.(false), [onZenChange])

  /**
   * 链接体检：孤儿笔记 / 失效链接。
   * 入口已挪到笔记树（整库视角的操作），结果仍用同一个浮层列出。
   */
  const handleLinkAudit = async (
    kind: 'orphan' | 'broken',
    anchor: { x: number; y: number }
  ): Promise<void> => {
    if (kind === 'orphan') {
      const rows = await window.zhixing.db.orphanNotes()
      setPanelItems(rows.map((n) => ({ key: `o-${n.id}`, label: n.title, id: n.id })))
    } else {
      const rows = await window.zhixing.db.brokenLinks()
      setPanelItems(
        rows.map((b, i) => ({
          key: `b-${i}`,
          label: `${b.src_title} → [[${b.dst_title}]]`,
          id: b.src_note_id,
        }))
      )
    }
    setPanel({ kind, x: anchor.x, y: anchor.y })
  }

  /** chip 文案：只讲归属（文件夹名）。引用数属于信息区的反向链接栏，不塞进 chip */
  /** 标题栏胶囊的状态：库内改动与 Word/Excel 的文件写回，任一没落地都算「未保存」。 */
  const unsaved = dirty || officePending
      ? `关联 ${attachedTasks.length} 个任务`
      : '归属'

  /**
   * 正文自带格式条的形态：富文本，以及 Word 可编辑（同一套 RichTextEditor，
   * 挂在 .editor__office-body 里）。这两种形态下，下面那组操作挂到格式条的**最左侧**，
   * 两者合成一条工具栏 —— Word 不再多出一条只放 6 个入口的行。
   * 其余形态（Markdown / Excel / 链接 / 预览）没有格式条可挂，这一行自成一行，
   * 位置同样是编辑区顶部、同样靠左，视觉上仍是同一条。
   */
  const wordEditing = isOffice && current?.format === 'word'
  /** Excel 可编辑：没有格式条可挂，出口按钮挂到页面工具栏的 primary（不折叠位）。 */
  const excelEditing = isOffice && current?.format === 'excel'
  /**
   * 链接笔记：条目草稿优先（编辑中不被入库值覆盖）。标题行的计数胶囊与工具栏的
   * 「添加链接」都读这一份 —— 和正文表格用的是同一个来源，三处不会分叉。
   */
  const linkEditing = current?.format === 'link'
  const linkItems: NoteLinkItem[] = linkEditing ? (linkDraft ?? parseLinkItems(content)) : []
  const usesRichToolbar = !preview && (current?.format === 'richtext' || wordEditing)
  /**
   * 标题行的**类型胶囊**（只读）：图标 + 名称都取自笔记树那套映射（noteIcon / NOTE_FORMATS），
   * 与笔记树、多标签页共用同一份来源，三处不会分叉。
   *
   * 类型只在新建时决定（入口在笔记树的「新建笔记」格式菜单），编辑区不再提供事后切换 ——
   * 所以这里是一个纯陈述的 span，不是 button，也不可聚焦。
   */
  const { Comp: FormatIcon, tone: formatTone } = noteIcon(current?.format)
  const formatName = NOTE_FORMATS.find((f) => f.key === current?.format)?.label ?? 'Markdown 笔记'

  /** 编辑区的操作组：回答「怎么编辑这一篇」，所以归工具栏，且一律排在左侧。 */
  const editorActions: ReactNode[] = [
    <button key="preview" className="text-btn" aria-pressed={preview} onClick={() => setPreview((v) => !v)}>
      <Morph icon={preview ? IconData.Pencil : IconData.Eye} size={13} />
      <span className="tb-label">{preview ? '编辑' : '预览'}</span>
    </button>,
    <button
      key="ai"
      className="text-btn"
      title="把这篇笔记交给大模型：Markdown 重排正文、Word/Excel 只归类、链接笔记分配每条链接的去向（结果先过审计再入库）"
      disabled={aiBusy}
      onClick={() => void handleAiOrganize()}
    >
      <Sparkles size={13} /> <span className="tb-label">{aiBusy ? '整理中…' : 'AI 整理'}</span>
    </button>,
    <button key="links" className="text-btn" aria-pressed={linksOpen} onClick={() => setLinksOpen((v) => !v)}>
      <Link2 size={13} /> <span className="tb-label">链接</span>
    </button>,
    <button key="ref" className="text-btn" title="添加指向其他笔记的引用" onClick={() => void handleAddReference()}>
      <Link2 size={13} /> <span className="tb-label">引用</span>
    </button>,
    <button
      key="tpl"
      className="text-btn"
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        setTemplateMenu({ x: r.left, y: r.bottom + 4 })
      }}
    >
      <Plus size={13} /> <span className="tb-label">模板</span>
    </button>,
    <button
      key="zen"
      className="text-btn"
      aria-pressed={zen}
      title={zen ? '退出全屏编辑（Esc）' : '全屏编辑：只留笔记正文，隐藏导航、笔记树与信息区'}
      onClick={() => setZen((v) => !v)}
    >
      <Maximize2 size={13} /> <span className="tb-label">{zen ? '退出全屏' : '全屏'}</span>
    </button>,
  ]

  /** tab 条的数据：标题与格式只从已加载的 notes 取，不额外查库。 */
  const tabItems: NoteTab[] = useMemo(
    () =>
      openTabs.map((id) => {
        const n = notes.find((x) => x.id === id)
        return {
          id,
          title: n?.title ?? '（已删除）',
          format: (n?.format ?? 'markdown') as NoteFormat,
          // 只有当前 tab 可能「还没落盘」—— 切走前都会 flush，其余 tab 一定是已保存的
          unsaved: id === selectedId && (dirty || officePending),
        }
      }),
    [openTabs, notes, selectedId, dirty, officePending]
  )

  /**
   * 按知识库的筛选条件收窄列表。
   *
   * 在**这里**过滤而不是改 NoteTree：树组件负责"怎么显示"，筛选是页面的事；
   * 而且树内已有的搜索框管的是"找得到"，这里的类型/状态管的是"看哪些"。
   */
  /**
   * 哪些类型**才谈得上**缺来源。
   *
   * note（笔记）与 project（项目记录）不是知识类，本来就不需要来源 ——
   * 把它们算进「无来源」会让这个数字等于全部笔记（实测 32/32），指标就失去意义了。
   * 口径与主进程 knowledgeHealth 一致。
   */
  const NEEDS_SOURCE = new Set(['concept', 'summary', 'synthesis', 'method', 'output', 'pitfall'])
  const lacksSource = (m: { kind: string; hasSource: boolean }): boolean =>
    NEEDS_SOURCE.has(m.kind) && !m.hasSource

  const visibleNotes = useMemo(() => {
    if (kindFilter === 'all' && statusFilter === 'all') return notes
    return notes.filter((n) => {
      const m = metaById[n.id]
      // 元信息还没到时不隐藏任何东西 —— 加载间隙里闪一下比"笔记突然不见"好
      if (!m) return true
      if (kindFilter !== 'all' && m.kind !== kindFilter) return false
      if (statusFilter === 'archived' && !m.archived) return false
      // 归档是"我现在不看它了"，所以除了「归档」这一档，其他档位都不含归档条目
      if (statusFilter !== 'archived' && statusFilter !== 'all' && m.archived) return false
      if (statusFilter === 'verified' && !m.verified) return false
      if (statusFilter === 'draft' && m.verified) return false
      if (statusFilter === 'noSource' && !lacksSource(m)) return false
      return true
    })
  }, [notes, kindFilter, statusFilter, metaById])

  /**
   * 每个档位的条数。
   *
   * 先按类型筛，再按档位数 —— 这样数字与"点了之后会看到几条"是一致的。
   * 归档不进任何其他档（它是"我现在不看它了"），无来源也不含归档条目。
   *
   * 元信息还没到的条目算进"全部"、不算进具体档位：加载间隙里数字跳动一下
   * 比显示一个假的 0 好。
   */
  const tabCounts = useMemo(() => {
    const inKind = notes.filter((n) => {
      const m = metaById[n.id]
      return !m || kindFilter === 'all' || m.kind === kindFilter
    })
    const count = (pred: (m: { kind: string; verified: boolean; archived: boolean; hasSource: boolean }) => boolean): number =>
      inKind.filter((n) => {
        const m = metaById[n.id]
        return m ? pred(m) : false
      }).length
    return {
      all: inKind.length,
      verified: count((m) => m.verified && !m.archived),
      draft: count((m) => !m.verified && !m.archived),
      archived: count((m) => m.archived),
      noSource: count((m) => lacksSource(m) && !m.archived),
    }
  }, [notes, metaById, kindFilter])

  /**
   * 保险箱是这一页的第二个视图，不是独立页面。
   *
   * 它原本在侧边导航里占一格，但那是"偶尔进去看一眼"的东西 —— 导航的每一格
   * 都应该对应日常会待的地方。现在入口在筛选条右侧，和知识库共用同一个页面壳。
   * 放在所有 hooks 之后早返回，遵守 hooks 规则。
   */
  if (view === 'vault') {
    return (
      /*
        返回入口交给 VaultPage 自己在每个状态分支里渲染 —— 它三个分支的按钮区不同，
        只有它自己知道往哪儿放。（早先在这里放了个固定定位的悬浮按钮，
        结果位置不对也点不到：position: fixed 在祖先带 transform/filter 时会
        相对那个祖先定位，还被同层内容盖住。）
      */
      <VaultPage onNotice={onNotice} onBack={() => setView('notes')} />
    )
  }

  return (
    <div className={'page page--notes' + (zen ? ' page--zen' : '')}>
      {/*
        页面工具栏：树收放、标题、知识库筛选、待办数字、搜索、树级动作、保险箱入口
        全部收在同一个 Toolbar 里。

        这些都是「对这一页所有内容生效」的东西 —— 原先按位置散在三处
        （page__head、notes-filter、以及长在笔记树上的搜索框与三个动作），
        同一类操作分居三地，树也被压得很重。收进工具栏之后还白得一个能力：
        空间不够时框架会自动把右侧的次要操作折进「更多」浮层。
      */}
      <Toolbar
        variant="page"
        titleNode={
          <>
            <h1 className="page__title">{t('page.notes')}</h1>
            <p className="page__subtitle">{t('page.notes.sub')}</p>
          </>
        }
        nav={
          <>
            {/* 树的收放 —— 放在工具栏最前。它改变的是这一页的版式，先于一切筛选；
                但它是「工具」不是「标题」，所以归工具栏区而不是标题区。 */}
            <button
              className="icon-btn page__head-toggle"
              aria-pressed={!treeHidden}
              aria-label={treeHidden ? '展开笔记树' : '收起笔记树'}
              title={treeHidden ? '展开笔记树' : '收起笔记树'}
              onClick={() => setTreeHidden((prev) => !prev)}
            >
              <Morph icon={treeHidden ? IconData.PanelLeftOpen : IconData.PanelLeftClose} size={15} />
            </button>
          <select
            className="notes-filter__select"
            value={kindFilter}
            aria-label="按类型筛选"
            onChange={(e) => setKindFilter(e.target.value)}
          >
            {/* 「所有类型」而不是「全部」—— 右边状态那一组也有个"全部"，
                两个都叫"全部"会让人不知道在筛什么 */}
            <option value="all">所有类型</option>
            {KNOWLEDGE_KINDS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
            {/*
              筛选档位。每一档都带条数 —— 这样"有多少待确认"和"点进去看什么"
              是同一个数字，不必再在旁边摆一组待办胶囊（那组数字与这里的重复，
              用户指出的正是这个）。无来源也收进这里，它和可信状态一样是"看哪些"。
            */}
            <div className="notes-filter__seg">
              {(
                [
                  ['all', '全部'],
                  ['verified', '可用'],
                  ['draft', '待确认'],
                  ['noSource', '无来源'],
                  ['archived', '归档'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  className={
                    'notes-filter__btn' + (statusFilter === key ? ' notes-filter__btn--on' : '')
                  }
                  title={label + '：' + tabCounts[key] + ' 条'}
                  onClick={() => setStatusFilter(key)}
                >
                  {label}
                  <span className="notes-filter__n">{tabCounts[key]}</span>
                </button>
              ))}
            </div>
            {(kindFilter !== 'all' || statusFilter !== 'all') && (
              <button
                className="notes-filter__clear"
                onClick={() => {
                  setKindFilter('all')
                  setStatusFilter('all')
                }}
              >
                清除筛选
              </button>
            )}
          </>
        }
        search={
          <input
            className="field field--compact"
            value={treeQuery}
            onChange={(e) => setTreeQuery(e.target.value)}
            placeholder="搜索标题…"
            aria-label="搜索笔记标题"
          />
        }
        /*
          树级动作原本长在笔记树上（搜索框下面那三个整行按钮），
          现在收进工具栏 —— 空间不够时框架会自动把它们折进「更多」浮层。
        */
        secondary={[
          <button
            key="ai"
            className={libJob ? 'text-btn text-btn--danger' : 'text-btn'}
            title={
              libJob
                ? '正在整理整个笔记库；点此停止'
                : '逐篇整理整个笔记库（按类型分别处理，可随时停止）'
            }
            onClick={() => void handleLibraryOrganize()}
          >
            <Sparkles size={14} />{' '}
            {libJob ? `停止整理（${libJob.done}/${libJob.total}）` : 'AI 整理全库'}
          </button>,
          <button
            key="attach"
            className="text-btn"
            title="把本地文件复制进数据目录并挂到当前笔记（原文件移动或删除也不影响）"
            onClick={() => void handleAddAttachment()}
          >
            <FilePlus2 size={14} /> 添加附件
          </button>,
          <button
            key="audit"
            className="text-btn"
            title="链接体检：没有入链的孤儿笔记 / 指向不存在笔记的失效链接"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              void handleLinkAudit('orphan', { x: r.left, y: r.bottom + 4 })
            }}
          >
            <Link2 size={14} /> 链接体检
          </button>,
        ]}
        primary={
          /* 保险箱入口。它原本在侧边导航里占一格，但那是偶尔进去看一眼的东西 ——
             导航的每一格都该对应日常会待的地方。 */
          <button
            className="notes-filter__vault"
            title="密码保险箱"
            aria-label="打开密码保险箱"
            onClick={() => setView('vault')}
          >
            <Database size={14} /> 保险箱
          </button>
        }
      />
      <div className="page__body">
      <div className="notes-wrap">
        {/* 笔记树：收起时整块不渲染（而不是藏起来），宽度全部让给编辑区。
            收放按钮在页面副标题旁边；全屏编辑时页面头整体让位，树也随之不显示。 */}
        {!treeHidden ? (
          <NoteTree
        queryProp={treeQuery}
            notes={visibleNotes}
            folders={folders}
            selectedId={selectedId}
            onSelect={(id) => void selectNote(id)}
            onCreateNote={handleCreateNote}
            onCreateFolder={handleCreateFolder}
            onTogglePin={(id, pinned) => void handleTogglePin(id, pinned)}
            onDeleteNote={(id) => void handleDelete(id)}
            onContextMenuNote={(id, x, y) => setCtxMenu({ id, x, y })}
            tagsOf={(id) => tagsOf.get(id) ?? []}
            onRenameFolder={(id, name) => void handleRenameFolder(id, name)}
            onDeleteFolder={(id) => void handleDeleteFolder(id)}
            onMoveFolder={(id, parentId) => void handleMoveFolder(id, parentId)}
            libJob={libJob}
            onOrganizeLibrary={() => void handleLibraryOrganize()}
            onAddAttachment={() => void handleAddAttachment()}
            onLinkAudit={(kind, anchor) => void handleLinkAudit(kind, anchor)}
          />
        ) : null}

        {/* 编辑区与链接面板纵向排列：链接面板从右侧栏挪到了编辑区下方 */}
        <div className={'notes-main' + (zen ? ' notes-main--zen' : '')} ref={mainRef}>
        {/* 笔记多标签页：全屏编辑时随页面头一起让位。
            只有 1 个 tab 时 NoteTabs 自己返回 null —— 不给单篇笔记白占那 30px。 */}
        {zen ? null : (
          <NoteTabs
            tabs={tabItems}
            activeId={selectedId}
            onActivate={(id) => void selectNote(id)}
            onClose={handleCloseTab}
          />
        )}
        <div className="editor">
          {current ? (
            /* 一张「笔记纸」装下头部、标签与正文：卡片只标记容器，不再标记分区 */
            <div className="sheet">
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
                      {/* 类型胶囊：排在标题之后、状态之前 —— 先回答「这一篇是什么」，
                          再回答「存好了没有」。只读，不可点、不可切换。 */}
                      <span
                        className="chip chip--type"
                        title={formatName + '：类型在新建时决定，编辑区不能切换'}
                      >
                        <FormatIcon size={12} className={'ntree__type--' + formatTone} aria-hidden />
                        {formatName}
                      </span>
                      {/* 知识徽标：这一篇是什么类型、可信吗。点开才能改类型与核对。
                          放在格式胶囊之后 —— 两者回答的都是「这一篇是什么」。 */}
                      {selectedId !== null && (
                        <KnowledgeChip
                          noteId={selectedId}
                          meta={metaById[selectedId]}
                          onChanged={reloadMeta}
                          onNotice={onNotice}
                          onInsertTemplate={insertTemplate}
                          onOpenNote={(id) => void selectNote(id)}
                        />
                      )}
                      {/* 保存状态：图标 + 文案。此前只在脏的时候冒出一行「未保存…」，
                          干净时什么都不显示 —— 于是「没在动」和「已经存好」看起来一样。 */}
                      <span
                        className={'chip chip--save' + (unsaved ? ' chip--save-dirty' : '')}
                        role="status"
                        aria-label={unsaved ? '未保存' : '已保存'}
                        title={unsaved ? '改动还没落盘（停顿后自动保存；Word / Excel 是写回本地文件）' : '已保存'}
                      >
                        <Morph icon={unsaved ? IconData.CircleAlert : IconData.Check} size={12} />
                        {unsaved ? '未保存' : '已保存'}
                      </span>
                      {/* 链接笔记的条数从编辑区头部搬到标题行：它回答的是「这一篇有多少条」，
                          与保存状态、标签、归属同属一行身份信息，不该另占一条 40px 的行。 */}
                      {linkEditing ? (
                        <span className="chip chip--count" title="这篇笔记里的链接条数">
                          <Link2 size={12} /> 链接 {linkItems.length} 条
                        </span>
                      ) : null}
                      {/* 标签与归属从原来的元信息行并进标题行：标题、状态、标签、归属
                          回答的都是「这一篇是什么」，拆成两行只是把一句话读成两半。 */}
                      <div className="note-tags" aria-label="笔记标签">
                        {currentTags.map((tg) => (
                          <button
                            key={tg.id}
                            type="button"
                            className="chip chip--tag"
                            style={{ '--tag-color': tg.color } as React.CSSProperties}
                            title="点击增删标签或改颜色"
                            onClick={openTagMenu}
                          >
                            {tg.name}
                          </button>
                        ))}
                        <button
                          type="button"
                          className="chip chip--tag-add"
                          title="添加 / 编辑标签"
                          onClick={openTagMenu}
                        >
                          <Tag size={12} /> {currentTags.length === 0 ? '加标签' : '标签'}
                        </button>
                      </div>
                      {/*
                        标题行原来还有一个「归属」胶囊（文件夹名 / 关联任务数）。
                        删掉了：同一件事在信息区已经有一整栏，标题行是"编辑这篇"的地方，
                        不该同时承担"这篇属于谁"的展示 —— 两处显示同一个状态，
                        迟早会出现一处更新、另一处没更新。
                      */}
                    </>
                  }
                  /* 操作组一律靠左：富文本形态下它是空的（那六个入口挂到了格式条左侧），
                     工具行随之整行不渲染 —— 见 Toolbar 的 hasSubRow。 */
                  nav={usesRichToolbar ? undefined : editorActions}
                  /* Office 的出口按钮落在同一条工具栏的最右端（不折叠位）：
                     Word 走 RichTextEditor 的 primary，Excel 没有格式条，挂在这里 ——
                     两者位置与样式一致，Excel 也不再为此单占一行头部。 */
                  primary={
                    excelEditing ? (
                      <button
                        className="text-btn"
                        onClick={() =>
                          void window.zhixing.db.openNoteFile(current.id).then((r) => onNotice(r.message))
                        }
                      >
                        用系统应用打开
                      </button>
                    ) : linkEditing ? (
                      /* 链接笔记的「添加链接」也从编辑区头部搬进工具栏最右端：
                         与 Word / Excel 的出口动作同一落点。 */
                      <button
                        className="text-btn"
                        onClick={() => updateLinkItems([...linkItems, { title: '', target: '' }])}
                      >
                        <Plus size={13} /> 添加链接
                      </button>
                    ) : undefined
                  }
                />

              {/* 正文：Markdown / 富文本 / Word / Excel / 链接 / 预览。
                  容器一律不再自带边框 —— 纸只有一张，分层靠留白。
                  宽度一律铺满纸面：五种形态同宽，不再按形态分「宽体 / 书写列」。 */}
              {/* ref 给「切 tab / 换笔记」那段淡入用（见上面的 effect） */}
              <div className="sheet__body" ref={sheetBodyRef}>
              {current.format === 'link' ? (
                // 链接笔记：content_md 存 [{title,target}] JSON。
                // 这里是**可编辑**的多链接列表 —— 「一条笔记多条链接、每条带标题」正是这个格式的用处，
                // AI 整理会按标题把每条链接归纳到对应的链接笔记（没有就新建）。
                ((items: NoteLinkItem[]) => (
                  <div className="editor__link">
                    <div
                      className="link-table"
                      style={
                        {
                          '--link-a': `${linkSplit}fr`,
                          '--link-b': `${1 - linkSplit}fr`,
                        } as CSSProperties
                      }
                    >
                      <div className="link-table__head">
                        <span>标题</span>
                        {/* 分界手柄：拖它调「标题 : 链接」的宽度比例 */}
                        <span
                          className="link-table__grip"
                          role="separator"
                          aria-label="调整列宽"
                          aria-orientation="vertical"
                          onPointerDown={startColumnResize}
                        />
                        <span>链接</span>
                        <span className="link-table__ops-head">操作</span>
                      </div>
                      {items.map((it, i) => (
                        <div className="link-table__row" key={i}>
                          <input
                            className="link-table__cell"
                            value={it.title}
                            placeholder="标题"
                            aria-label="链接标题"
                            onChange={(e) =>
                              updateLinkItems(
                                items.map((x, j) => (j === i ? { ...x, title: e.target.value } : x))
                              )
                            }
                          />
                          <span className="link-table__gap" aria-hidden />
                          <input
                            className="link-table__cell link-table__cell--url"
                            value={it.target}
                            placeholder="https://… 或本地路径"
                            aria-label="链接地址"
                            onChange={(e) =>
                              updateLinkItems(
                                items.map((x, j) => (j === i ? { ...x, target: e.target.value } : x))
                              )
                            }
                          />
                          <span className="link-table__ops">
                            {/^https?:/i.test(it.target) ? (
                              <a
                                className="icon-btn"
                                href={it.target}
                                target="_blank"
                                rel="noreferrer"
                                aria-label="打开链接"
                                title="在浏览器打开"
                              >
                                <ExternalLink size={13} />
                              </a>
                            ) : (
                              <button
                                className="icon-btn"
                                disabled
                                aria-label="打开链接"
                                title="只支持 http/https 链接"
                              >
                                <ExternalLink size={13} />
                              </button>
                            )}
                            <button
                              className="icon-btn"
                              aria-label="删除这条链接"
                              title="删除这条链接"
                              onClick={() => updateLinkItems(items.filter((_, j) => j !== i))}
                            >
                              <Trash2 size={13} />
                            </button>
                          </span>
                        </div>
                      ))}
                      {!items.length && (
                        <p className="u-aux link-table__empty">
                          还没有链接。点工具栏的「添加链接」，填上标题与地址。
                        </p>
                      )}
                    </div>
                  </div>
                ))(linkItems)
              ) : isOffice ? (
                // Word/Excel 直接可编辑并自动写回原文件
                <div className="editor__office">
                  {/* Word / Excel 的出口按钮都并进了工具栏（Word 见下面 RichTextEditor 的
                      primary，Excel 见上面页面工具栏的 primary）—— 头部那一行原本只装一句
                      状态文案加一个按钮，白占 40px。 */}
                  {current.format === 'word' ? (
                    /* --word：Word 的格式条自己带 4px 下内边距 + ProseMirror 的 8px 上内边距，
                       容器再补 8px 上内边距会让「标题行 ↔ 格式条」比富文本多出一档。
                       Excel 没有格式条，那 8px 正是它正文与工具栏之间的一档，故只对 Word 归零。 */
                    <div className="editor__office-body editor__office-body--word">
                      <RichTextEditor
                        noteId={current.id}
                        html={officeEdit?.html ?? ''}
                        leading={editorActions}
                        primary={
                          <>
                            <button
                              className="text-btn"
                              title="把当前编辑内容导出成新的 .docx（原文件保持不动）"
                              onClick={() => {
                                void window.zhixing.db
                                  .exportDocx(content, officeEdit?.html ?? '', current.title)
                                  .then((r) =>
                                    onNotice(r.ok ? '已导出到 ' + (r.path ?? '') : '导出失败：' + (r.message ?? ''))
                                  )
                              }}
                            >
                              导出 .docx
                            </button>
                            <button
                              className="text-btn"
                              onClick={() =>
                                void window.zhixing.db.openNoteFile(current.id).then((r) => onNotice(r.message))
                              }
                            >
                              用系统应用打开
                            </button>
                          </>
                        }
                        onChange={(h) => {
                          setOfficeEdit((prev) => (prev ? { ...prev, html: h } : prev))
                          // 正文还没写回 .docx —— 胶囊据此显示「未保存」
                          setOfficePending(true)
                        }}
                        onCommit={(h) => void commitWord(h)}
                        placeholder="从这里开始编辑 Word 正文…"
                      />
                    </div>
                  ) : (
                    <div className="editor__office-body">
                      {/* ag-grid 走懒加载：它的体积可观，只有真的打开 Excel 笔记才会下载。
                          虚拟滚动是这里的关键 —— 几千行也只渲染可见的那几十行。 */}
                      <Suspense fallback={<p className="u-aux">正在加载表格…</p>}>
                        <XlsxGrid rows={excelRows} onChange={scheduleExcelSave} />
                      </Suspense>
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
              ) : current.format === 'word' || current.format === 'excel' ? (
                // Word / Excel 的正文在本地文件里：应用内不做预览，给一条明确的出口
                // （变体类：居中空状态，不能与上面的可编辑预览共用 .editor__office）
                <div className="editor__office editor__office--fallback">
                  <FileText size={18} aria-hidden />
                  <p className="u-aux">
                    {current.format === 'word' ? 'Word' : 'Excel'} 笔记的正文在本地文件里，应用内只登记条目。
                  </p>
                  <button
                    className="text-btn text-btn--accent"
                    onClick={() => {
                      void window.zhixing.db.openPath(content).then((err) => {
                        if (err) onNotice('打开失败：' + err)
                      })
                    }}
                  >
                    用系统应用打开
                  </button>
                  <code className="u-aux editor__office-path">{content || '（没有记录文件路径）'}</code>
                </div>
              ) : current.format === 'richtext' ? (
                <RichTextEditor
                  noteId={current.id}
                  html={content}
                  leading={editorActions}
                  /*
                    只有内容**真的偏离装载基线**才置 dirty。
                    编辑器在装载正文时会回调一次 onChange（初始化 / 外部同步），
                    无条件置 dirty 的结果就是：刚打开一篇还没动过的笔记，
                    标题栏已经写着"未保存"。
                  */
                  onChange={(h) => {
                    setContent(h)
                    reportEditorChange(h)
                  }}
                  placeholder="从这里开始记录富文本…"
                />
              ) : (
                <MarkdownEditor
                  value={content}
                  onAttachTask={(info) => void handleBlockContext(info)}
                  onChange={(v) => {
                    setContent(v)
                    reportEditorChange(v)
                  }}
                  titles={notes.map((n) => n.title)}
                    onLinkPick={(info) => {
                      setLinkTrigger(info)
                      // 锚点取光标处：选择器贴在正在输入的那一行下方，而不是挂在某个按钮上
                      const view = mdViewRef.current
                      if (!view) return
                      const c = view.coordsAtPos(info.to)
                      setLinkPick({ left: c.left, top: c.top, bottom: c.bottom } as DOMRect)
                    }}
                  placeholder="用 Markdown 写作；输入 [[ 可链接到其他笔记"
                  highlight={findOpen ? findText : ''}
                  onCreateTask={(text, blockKey) => void handleCreateTaskFromSelection(text, blockKey)}
                  onReady={(v) => {
                    viewRef.current = v
                  }}
                  onHandle={(h) => {
                    mdViewRef.current = h
                  }}
                />
              )}
              </div>
            </div>
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
          <>
            {/*
              信息区**只有一种展开方式：向上展开**，无论笔记树是开是关、编辑区宽还是窄。
              原先窄窗口会切成覆盖式抽屉（右侧滑出 + 遮罩），于是同一块内容有两种形态、
              两种交互，用户看到的是"笔记树一开它就换个样子"。
            */}
            <aside
              className={'links' + (linksExpanded ? ' links--open' : ' links--collapsed')}
              aria-label="链接面板"
            >
            {/*
              收起态只有这一行：信息区默认收起，正文才能拿到最大高度。

              **整条都可点**，而不是只有左边那个「信息」按钮 —— 它本来就是一条通栏的
              信息头，把可点区域限制在一小段文字上，用户得瞄准。
              「隐藏」按钮也去掉了：它和"收起"是同一件事的两种说法，
              收起本来就等价于隐藏，多一个按钮只会让人犹豫该点哪个。
            */}
            <div
              className="links__bar"
              role="button"
              tabIndex={0}
              aria-expanded={linksExpanded}
              title={linksExpanded ? '收起信息区' : '展开属性 / 反向链接 / 引用 / 归属'}
              onClick={() => setLinksExpanded((v) => !v)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setLinksExpanded((v) => !v)
                }
              }}
            >
              <span className="links__toggle">
                <ChevronRight size={13} className={'links__caret' + (linksExpanded ? ' links__caret--open' : '')} />
                信息
              </span>
              {/* 统计只在收起态显示 —— 展开后每栏标题上已经各有一个数字，
                  再在顶上重复一遍是多余的（用户指出的） */}
              {!linksExpanded && (
                <span className="links__counts">
                  属性 {propCount} · 反链 {backlinks.length} · 引用 {outLinks.length} · 归属{' '}
                  {attachedTasks.length + (current.folder_id ? 1 : 0)}
                </span>
              )}
              <span className="links__spacer" />
            </div>
            {/* 退场期间正文也要留着：否则抽屉还挂在屏幕上、里面却已经空了 */}
            {linksExpanded && (
            <div className="links__body">
            {/*
              四栏并排：属性 / 反向链接 / 正向引用 / 归属。

              每栏内部是「胶囊列表（自己滚）+ 底部新增行 + 底部提示行」的三段结构，
              信息区高度固定 —— 它不该因为某栏内容变多就把正文挤上去，
              那样每加一条引用正文都会跳一下。

              胶囊承载跳转（点胶囊本体），删除图标居右（点它只删不跳）。
            */}
            <section className="links__col">
              <header className="links__head" title="每行一条，形如「来源: 书籍」">
                属性 · {propItems.length}
              </header>
              <div className="links__items">
                {propItems.length === 0 ? (
                  <p className="links__empty">还没有属性</p>
                ) : (
                  propItems.map((p) => (
                    <span key={p.key} className="links__pill" title={p.key + ": " + p.value}>
                      <span className="links__pill-text">
                        <b>{p.key}</b>
                        {p.value ? " " + p.value : ""}
                      </span>
                      <button
                        type="button"
                        className="links__pill-del"
                        aria-label={"删除属性 " + p.key}
                        title="删除"
                        onClick={() => removeProp(p.key)}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))
                )}
              </div>
              <div className="links__foot">
                <div className="links__add">
                  <input
                    className="field links__add-input"
                    value={propNew}
                    aria-label="新增属性"
                    placeholder="键: 值"
                    onChange={(e) => setPropNew(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        addProp()
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="links__add-btn"
                    aria-label="添加属性"
                    title="添加"
                    disabled={!propNew.trim()}
                    onClick={addProp}
                  >
                    <Plus size={13} />
                  </button>
                </div>

              </div>
            </section>

            <section className="links__col">
              <header
                className="links__head"
                title="别人引用这篇时自动出现；删除会改对方那篇的正文"
              >
                反向链接 · {backlinks.length + attachedTasks.length}
              </header>
              <div className="links__items">
                {/* 空状态只在**两种引用都没有**时出现 —— 原来只判 backlinks，
                    于是任务引用了它的时候，下面明明躺着任务胶囊，上面还说"还没有引用" */}
                {backlinks.length === 0 && attachedTasks.length === 0 ? (
                  <p className="links__empty">还没有笔记或任务引用它</p>
                ) : (
                  backlinks.map((b) => (
                    <span key={b.src_note_id} className="links__pill">
                      <button
                        type="button"
                        className="links__pill-text"
                        title={b.snippet || b.src_title}
                        onClick={() => void selectNote(b.src_note_id)}
                      >
                        <b>{b.src_title}</b>
                      </button>
                      <button
                        type="button"
                        className="links__pill-del"
                        aria-label={"删除反向链接 " + b.src_title}
                        title="从对方正文里删掉这条链接"
                        onClick={() => void handleRemoveBacklink(b)}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))
                )}
                {/*
                  引用了这篇的**任务**。
                  任务对笔记的关联本质是引用 —— 任务备注里写着 [[这偏的标题]]，
                  改名时的修复逻辑（note-assoc.ts）就是照着这条在跑。
                  原先它被摆在「归属」栏，与"属于哪个文件夹"混为一谈。
                */}
                {attachedTasks.map((task) => (
                  <span key={task.id} className="links__pill">
                    <button
                      type="button"
                      className="links__pill-text"
                      title="打开这个任务"
                      onClick={() => handleOpenTask(task.id)}
                    >
                      <b>{task.title}</b>
                    </button>
                    <button
                      type="button"
                      className="links__pill-del"
                      aria-label={"解除关联 " + task.title}
                      title="解除关联"
                      onClick={() => handleDetachTask(task.id)}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
              <div className="links__foot">
                <div className="links__add">
                  <button
                    type="button"
                    className="links__add-btn links__add-btn--wide"
                    onClick={(e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      void openTaskPick(r.left, r.bottom + 4)
                    }}
                  >
                    <Plus size={13} /> 关联到任务…
                  </button>
                </div>
              </div>
            </section>

            <section className="links__col">
              <header className="links__head" title="正文里的 [[链接]] 会自动出现在这里">
                正向引用 · {outLinks.length}
              </header>
              <div className="links__items">
                {outLinks.length === 0 ? (
                  <p className="links__empty">正文里还没有 [[链接]]</p>
                ) : (
                  outLinks.map((l) => (
                    <span
                      key={l.id}
                      className={"links__pill" + (l.dst_note_id == null ? " links__pill--dangling" : "")}
                    >
                      <button
                        type="button"
                        className="links__pill-text"
                        title={l.dst_note_id == null ? "目标还不存在，点击创建并绑定" : "打开这篇笔记"}
                        onClick={() =>
                          l.dst_note_id != null
                            ? void selectNote(l.dst_note_id)
                            : void handleCreateFromLink(l.dst_title)
                        }
                      >
                        <b>{l.dst_title}</b>
                      </button>
                      <button
                        type="button"
                        className="links__pill-del"
                        aria-label={"删除引用 " + l.dst_title}
                        title="从正文里删掉这行引用"
                        onClick={() => handleRemoveOutLink(l)}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))
                )}
              </div>
              <div className="links__foot">
                {/*
                  正向引用改用笔记选择器而不是输入框 —— 引用要选的是「已经存在的
                  那一篇」，凭记忆敲标题既不精确、也容易建出重复笔记。选择器带
                  文件夹层级与类型图标，与任务项编辑框里关联笔记用的是同一个组件、
                  同一套摆放规则（placeAnchored：下方放不下翻上方、右侧放不下往左收，
                  实测能保证完整落在视口内）。
                */}
                <button
                  type="button"
                  className="links__add-btn links__add-btn--wide"
                  onClick={(e) => {
                    setLinkPick((e.currentTarget as HTMLElement).getBoundingClientRect())
                  }}
                >
                  <Plus size={13} /> 选择笔记…
                </button>

              </div>
            </section>

            <section className="links__col">
              <header className="links__head">
                归属 · {current.folder_id ? 1 : 0}
              </header>
              <div className="links__items">
                {!current.folder_id && (
                  <p className="links__empty">未归入任何文件夹</p>
                )}
                {current.folder_id ? (
                  <span className="links__pill">
                    <button
                      type="button"
                      className="links__pill-text"
                      title="在笔记树里定位这个文件夹"
                      onClick={() => handleRevealFolder(current.folder_id as number)}
                    >
                      <FolderPlus size={11} />
                      <b>{folders.find((f) => f.id === current.folder_id)?.name ?? "未知"}</b>
                    </button>
                    <button
                      type="button"
                      className="links__pill-del"
                      aria-label="移出文件夹"
                      title="移出文件夹"
                      onClick={() => handleMoveNoteToFolder(null)}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ) : null}
              </div>
              <div className="links__foot">
                {/*
                  归属栏只做一件事：把这篇放进某个文件夹/分类。
                  「关联到任务」挪去反向链接栏 —— 那是引用关系，不是容器关系
                  （见 docs/specs/ownership-vs-reference.md）。
                */}
                <div className="links__add">
                  <button
                    type="button"
                    className="links__add-btn links__add-btn--wide"
                    onClick={(e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setMoveMenu({ noteId: current.id, x: r.left, y: r.bottom + 4 })
                    }}
                  >
                    <FolderPlus size={13} /> 移动到文件夹…
                  </button>
                </div>
              </div>
            </section>
            </div>
            )}
          </aside>
          </>
        )}
        </div>
      </div>
      </div>

      {tagMenu && current && (
        <TagMenu
          x={tagMenu.x}
          y={tagMenu.y}
          title="笔记标签"
          tags={allTags}
          selectedIds={currentTags.map((t) => t.id)}
          onToggle={(t) => void handleToggleNoteTag(t)}
          onCreate={() => void handleCreateNoteTag()}
          onColor={(id, color) => void handleSetTagColor(id, color)}
          onClose={() => setTagMenu(null)}
        />
      )}

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
              label: '关联到任务…',
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
            ...folderTree().map(({ f, depth }) => ({
              key: `f-${f.id}`,
              label: f.name,
              depth,
              onPick: () => void handleMoveNote(moveMenu.noteId, f.id),
            })),
          ]}
          searchable
          searchPlaceholder="输入文件夹名筛选…"
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
          searchable
          searchPlaceholder="输入任务标题筛选…"
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
            /*
              按层级展示：分组 → 列表 → 任务。
              原先是一列平铺的任务标题，用户分不清哪个是哪儿的 —— 同名任务
              （"写文档"这种）尤其明显。分组与列表做成不可点的标题行，
              只负责分段与缩进；任务才可点。
            */
            ...(taskPick.items.length
              ? (() => {
                  const rows: {
                    key: string
                    label: string
                    depth?: number
                    onPick: () => void
                  }[] = []
                  let lastGroup = '\u0000'
                  let lastList = '\u0000'
                  for (const t of taskPick.items) {
                    if (t.groupName && t.groupName !== lastGroup) {
                      lastGroup = t.groupName
                      lastList = '\u0000'
                      rows.push({
                        key: 'g-' + t.groupName,
                        label: t.groupName,
                        depth: 0,
                        onPick: () => undefined,
                      })
                    }
                    if (t.listName && t.listName !== lastList) {
                      lastList = t.listName
                      rows.push({
                        key: 'l-' + (t.groupName || '') + '-' + t.listName,
                        label: t.listName,
                        depth: t.groupName ? 1 : 0,
                        onPick: () => undefined,
                      })
                    }
                    rows.push({
                      key: 't-' + t.id,
                      label: t.title,
                      depth: (t.groupName ? 1 : 0) + (t.listName ? 1 : 0),
                      onPick: () =>
                        void (blockDraft
                          ? handleAttachBlock(t.id, t.title)
                          : handleAttachTask(t.id, t.title)),
                    })
                  }
                  return rows
                })()
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

      {linkPick && current && (
        <NotePicker
          notes={notes}
          folders={folders}
          value=""
          anchor={linkPick}
          onPick={(id) => {
            const target = notes.find((n) => String(n.id) === id)
            const trig = linkTrigger
            setLinkPick(null)
            setLinkTrigger(null)
            if (!target) return
            /*
              正文补全：把光标前那半截 [[（含已输入的前缀）整段替换成完整的 [[标题]]，
              而不是再追加一行。dispatch 会触发 onChange，落盘与建链接因此照常发生。
            */
            if (trig) {
              mdViewRef.current?.replaceRange(trig.from, trig.to, "[[" + target.title + "]]")
              return
            }
            if (!current) return
            const body = (current.content_md ?? '').replace(/\s*$/, '')
            void window.zhixing.db
              .saveNote(current.id, { content_md: body + '\n\n[[' + target.title + ']]\n' })
              .then(async () => {
                await load()
                onNotice('已引用「' + target.title + '」')
              })
          }}
          onClose={() => setLinkPick(null)}
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

