import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  FolderPlus,
  LayoutGrid,
  Link2,
  NotebookPen,
  Pin,
  Search,
  Sparkles,
  Trash2,
} from '@renderer/lib/icons'
import type { Note, NoteFolder } from '@shared/types'
import type { AiLibraryProgress } from '@shared/ai-note'
import { inkOn } from '@shared/color'
import { PopMenu } from './PopMenu'

/** 新建笔记时可选的类型：原先在工具栏里选，现在放到「新建」动作里选 */
export type NoteFormat = 'markdown' | 'richtext' | 'word' | 'excel' | 'link'

/**
 * 每种笔记一个图标 + 一个色阶。
 *
 * 图标只有五个可用（word 与 markdown 都落在 FileText 上），所以靠颜色区分 ——
 * 树里扫一眼就能分辨类型，不必点开看。
 */
const FORMAT_ICON: Record<string, { Comp: typeof FileText; tone: string }> = {
  markdown: { Comp: FileText, tone: 'markdown' },
  richtext: { Comp: NotebookPen, tone: 'richtext' },
  word: { Comp: FileText, tone: 'word' },
  excel: { Comp: LayoutGrid, tone: 'excel' },
  link: { Comp: Link2, tone: 'link' },
}

function noteIcon(format: string | undefined): { Comp: typeof FileText; tone: string } {
  return FORMAT_ICON[format ?? 'markdown'] ?? FORMAT_ICON.markdown
}
export const NOTE_FORMATS: { key: NoteFormat; label: string }[] = [
  { key: 'markdown', label: 'Markdown 笔记' },
  { key: 'richtext', label: '富文本笔记' },
  { key: 'word', label: 'Word 笔记' },
  { key: 'excel', label: 'Excel 笔记' },
  { key: 'link', label: '链接笔记' },
]

interface Props {
  notes: Note[]
  folders: NoteFolder[]
  selectedId: number | null
  onSelect: (id: number) => void
  /** 在指定父级（文件夹 / null = 全部笔记）下新建笔记，类型在点击时选 */
  onCreateNote: (folderId: number | null, format: NoteFormat) => void
  /** 在指定父级下新建子文件夹 */
  onCreateFolder: (parentId: number | null) => void
  onTogglePin: (id: number, pinned: boolean) => void
  onDeleteNote: (id: number) => void
  onContextMenuNote: (id: number, x: number, y: number) => void
  /** 文件夹操作 */
  onRenameFolder: (id: number, currentName: string) => void
  onDeleteFolder: (id: number) => void
  onMoveFolder: (id: number, parentId: number | null) => void
  /** 整库 AI 整理的进度；非空表示正在跑（按钮变成「停止」） */
  libJob?: AiLibraryProgress | null
  /** 触发 / 停止整库整理 */
  onOrganizeLibrary?: () => void
  /** 把本地文件归档成当前笔记的附件 */
  onAddAttachment?: () => void
  /** 每篇笔记的标签：行内显示小胶囊（最多两个，其余折成 +N） */
  tagsOf?: (noteId: number) => { id: number; name: string; color: string }[]
}

/** 笔记树：文件夹层级 + 文件夹内笔记。 */
export function NoteTree({
  notes,
  folders,
  selectedId,
  onSelect,
  onCreateNote,
  onCreateFolder,
  onTogglePin,
  onDeleteNote,
  onContextMenuNote,
  onRenameFolder,
  onDeleteFolder,
  onMoveFolder,
  libJob = null,
  onOrganizeLibrary,
  onAddAttachment,
  tagsOf = () => [],
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [query, setQuery] = useState('')
  /** 树宽（可拖右边缘调整），默认与 CSS 里的 240px 一致 */
  const [treeWidth, setTreeWidth] = useState(240)
  const resizeRef = useRef<{ x: number; w: number } | null>(null)
  /** 文件夹右键菜单：重命名 / 移动 / 删除 */
  const [folderMenu, setFolderMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  /** 「移动到…」二级菜单：列出可作为父级的文件夹 */
  const [moveMenu, setMoveMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  /** 文件夹深链目标：展开父链后高亮该文件夹并滚入视野，随后自动取消高亮 */
  const [folderFocus, setFolderFocus] = useState<number | null>(null)
  /** 新建类型菜单：点行内「新建」时弹出，选完类型才创建（替代工具栏里的格式下拉） */
  const [formatMenu, setFormatMenu] = useState<{ x: number; y: number; parentId: number | null } | null>(null)
  /** 从某个行内按钮弹出类型菜单（阻止冒泡，免得顺带选中该行） */
  const openFormatMenu = (e: React.MouseEvent, parentId: number | null): void => {
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setFormatMenu({ x: r.left, y: r.bottom + 4, parentId })
  }

  // 文件夹深链（图谱双击文件夹）——展开父链（折叠时目标不渲染），登记待定位 id
  useEffect(() => {
    const onOpenFolder = (e: Event): void => {
      const id = Number((e as CustomEvent<{ id?: number }>).detail?.id)
      if (!Number.isFinite(id) || id <= 0) return
      setCollapsed((prev) => {
        const next = new Set(prev)
        let cur = folders.find((f) => f.id === id)?.parent_id ?? null
        while (cur != null) {
          next.delete(cur)
          cur = folders.find((f) => f.id === cur)?.parent_id ?? null
        }
        return next
      })
      setFolderFocus(id)
    }
    window.addEventListener('zhixing:open-note-folder', onOpenFolder)
    return () => window.removeEventListener('zhixing:open-note-folder', onOpenFolder)
  }, [folders])

  // 目标渲染出来后滚入视野；高亮 2.6s 后自动消除
  useEffect(() => {
    if (folderFocus == null) return
    const el = document.querySelector<HTMLElement>(
      `.ntree__folder[data-folder-id="${folderFocus}"]`
    )
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    const timer = window.setTimeout(() => setFolderFocus(null), 2600)
    return () => window.clearTimeout(timer)
  }, [folderFocus, folders])

  const childrenOf = (parentId: number | null): NoteFolder[] =>
    folders.filter((f) => f.parent_id === parentId)
  const notesOf = (folderId: number | null): Note[] =>
    notes.filter((n) => (n.folder_id ?? null) === folderId)

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    return new Set(notes.filter((n) => n.title.toLowerCase().includes(q)).map((n) => n.id))
  }, [notes, query])

  const noteRow = (n: Note, depth: number, folderId: number | null): React.ReactNode => {
    const hit = matched === null || matched.has(n.id)
    if (!hit) return null
    const rowTags = tagsOf(n.id)
    return (
      <div
        key={n.id}
        className={'ntree__note' + (selectedId === n.id ? ' ntree__note--on' : '')}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => onSelect(n.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          onContextMenuNote(n.id, e.clientX, e.clientY)
        }}
        role="treeitem"
        aria-selected={selectedId === n.id}
      >
        {(() => {
          const { Comp, tone } = noteIcon(n.format)
          return <Comp size={13} className={'ntree__type ntree__type--' + tone} aria-hidden />
        })()}
        {n.pinned && <Pin size={12} className="ntree__pin" />}
        <span className="ntree__title">{n.title}</span>
        {rowTags.length > 0 && (
          <span className="ntree__tags" aria-label="笔记标签">
            {rowTags.slice(0, 2).map((tg) => (
              <span
                key={tg.id}
                className="chip chip--tag chip--tag--mini"
                style={{ background: tg.color, borderColor: tg.color, color: inkOn(tg.color) }}
                title={tg.name}
              >
                {tg.name}
              </span>
            ))}
            {rowTags.length > 2 && (
              <span
                className="chip chip--tag chip--tag--mini"
                title={rowTags.slice(2).map((x) => x.name).join('、')}
              >
                +{rowTags.length - 2}
              </span>
            )}
          </span>
        )}
        <span className="ntree__actions">
          <button
            className="icon-btn"
            title="在此新建笔记"
            aria-label="在此新建笔记"
            onClick={(e) => openFormatMenu(e, folderId)}
          >
            <FilePlus2 size={12} />
          </button>
          <button
            className="icon-btn"
            title={n.pinned ? '取消置顶' : '置顶'}
            aria-label={n.pinned ? '取消置顶' : '置顶'}
            onClick={(e) => {
              e.stopPropagation()
              onTogglePin(n.id, !n.pinned)
            }}
          >
            <Pin size={12} />
          </button>
          <button
            className="icon-btn icon-btn--danger"
            title="删除"
            aria-label="删除笔记"
            onClick={(e) => {
              e.stopPropagation()
              onDeleteNote(n.id)
            }}
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>
    )
  }

  const folderNode = (f: NoteFolder, depth: number): React.ReactNode => {
    const kids = childrenOf(f.id)
    const isOpen = !collapsed.has(f.id)
    const own = notesOf(f.id)
    return (
      <div key={f.id}>
        <div
          className={'ntree__folder' + (folderFocus === f.id ? ' ntree__folder--on' : '')}
          data-folder-id={f.id}
          style={{ paddingLeft: 6 + depth * 14 }}
          onContextMenu={(e) => {
            e.preventDefault()
            setFolderMenu({ id: f.id, x: e.clientX, y: e.clientY })
          }}
        >
          <button
            className={'trow__caret' + (isOpen ? ' trow__caret--open' : '')}
            onClick={() =>
              setCollapsed((prev) => {
                const next = new Set(prev)
                if (next.has(f.id)) next.delete(f.id)
                else next.add(f.id)
                return next
              })
            }
            aria-expanded={isOpen}
            aria-label={isOpen ? '折叠文件夹' : '展开文件夹'}
          >
            {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          <span className="ntree__foldername">{f.name}</span>
          <span className="ntree__count">{own.length}</span>
          <span className="ntree__actions">
            <button
              className="icon-btn"
              title="在此新建笔记"
              aria-label="在此新建笔记"
              onClick={(e) => openFormatMenu(e, f.id)}
            >
              <FilePlus2 size={13} />
            </button>
            <button
              className="icon-btn"
              title="新建子文件夹"
              aria-label="新建子文件夹"
              onClick={(e) => {
                e.stopPropagation()
                onCreateFolder(f.id)
              }}
            >
              <FolderPlus size={13} />
            </button>
          </span>
        </div>
        {isOpen && (
          <>
            {own.map((n) => noteRow(n, depth + 1, f.id))}
            {kids.map((k) => folderNode(k, depth + 1))}
          </>
        )}
      </div>
    )
  }

  const rootNotes = notesOf(null)
  const menuFolder = folderMenu ? folders.find((f) => f.id === folderMenu.id) : undefined
  /** 可作为新父级的文件夹：排除自己（子孙由主进程 moveNoteFolder 做环校验） */
  const moveTargets = moveMenu ? folders.filter((f) => f.id !== moveMenu.id) : []

  return (
    <div
      className="ntree"
      role="tree"
      aria-label="笔记树"
      style={{ width: treeWidth, flexBasis: treeWidth }}
    >
      {/* 搜索框不是「工具」而是「表单行」：独立于工具栏，才能撑满树的宽度 */}
      <div className="ntree__search-wrap">
        <Search size={14} aria-hidden />
        <input
          className="field ntree__search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索标题…"
          aria-label="搜索笔记标题"
        />
      </div>
      {/* 树级动作：整库整理属于「整棵树」的操作，放在搜索框下面比塞进编辑器工具栏更顺手 */}
      {(onOrganizeLibrary || onAddAttachment) && (
        <div className="ntree__topbar">
          <button
            className={libJob ? 'text-btn text-btn--danger' : 'text-btn'}
            title={
              libJob
                ? `正在整理：${libJob.currentTitle || '…'}（成功 ${libJob.ok} / 失败 ${libJob.failed}）；点此停止，当前这一篇会跑完`
                : '逐篇整理整个笔记库（按类型分别处理，可随时停止）'
            }
            onClick={() => onOrganizeLibrary?.()}
          >
            <Sparkles size={13} /> {libJob ? `停止整理（${libJob.done}/${libJob.total}）` : 'AI 整理全库'}
          </button>
          {onAddAttachment && (
            <button
              className="text-btn"
              title="把本地文件复制进数据目录并挂到当前笔记（原文件移动或删除也不影响）"
              onClick={() => onAddAttachment()}
            >
              <FilePlus2 size={13} /> 添加附件
            </button>
          )}
          {libJob && (
            <span className="u-aux ntree__topbar-hint" title={libJob.currentTitle}>
              {libJob.currentTitle || '准备中…'}
            </span>
          )}
        </div>
      )}
      <div className="ntree__body">
        {rootNotes.map((n) => noteRow(n, 0, null))}
        {childrenOf(null).map((f) => folderNode(f, 0))}
        {/* 空树兜底：没有行可 hover，必须留一个入口 */}
        {rootNotes.length === 0 && childrenOf(null).length === 0 && (
          <div className="ntree__empty">
            <p className="u-aux">还没有笔记。</p>
            <button className="text-btn" onClick={(e) => openFormatMenu(e, null)}>
              新建第一篇笔记
            </button>
            <button className="text-btn" onClick={() => onCreateFolder(null)}>
              新建文件夹
            </button>
          </div>
        )}
      </div>
      {/* 右边缘手柄：拖动调整树宽。宽度放在组件内，根元素内联 style 覆盖 CSS 里的默认值 */}
      <div
        className="ntree__resizer"
        role="separator"
        aria-label="调整笔记树宽度"
        onPointerDown={(e) => {
          resizeRef.current = { x: e.clientX, w: treeWidth }
          try {
            e.currentTarget.setPointerCapture?.(e.pointerId)
          } catch {
            // 指针已失效时忽略：捕获失败不影响拖动本身
          }
        }}
        onPointerMove={(e) => {
          const start = resizeRef.current
          if (!start) return
          setTreeWidth(Math.min(460, Math.max(180, start.w + (e.clientX - start.x))))
        }}
        onPointerUp={(e) => {
          resizeRef.current = null
          try {
            e.currentTarget.releasePointerCapture?.(e.pointerId)
          } catch {
            // 同上
          }
        }}
      />

      {formatMenu && (
        <PopMenu
          x={formatMenu.x}
          y={formatMenu.y}
          onClose={() => setFormatMenu(null)}
          items={NOTE_FORMATS.map((f) => ({
            key: f.key,
            label: f.label,
            onPick: () => {
              onCreateNote(formatMenu.parentId, f.key)
              setFormatMenu(null)
            },
          }))}
        />
      )}

      {folderMenu && menuFolder && (
        <PopMenu
          x={folderMenu.x}
          y={folderMenu.y}
          onClose={() => setFolderMenu(null)}
          items={[
            {
              key: 'new-sub',
              label: '在此新建笔记…',
              onPick: () => setFormatMenu({ x: folderMenu.x, y: folderMenu.y, parentId: folderMenu.id }),
            },
            {
              key: 'new-folder',
              label: '在此新建子文件夹',
              onPick: () => onCreateFolder(folderMenu.id),
            },
            {
              key: 'rename',
              label: '重命名文件夹…',
              onPick: () => onRenameFolder(folderMenu.id, menuFolder.name),
            },
            {
              key: 'move',
              label: '移动到…',
              onPick: () => setMoveMenu({ id: folderMenu.id, x: folderMenu.x, y: folderMenu.y }),
            },
            {
              key: 'delete',
              label: '删除文件夹',
              danger: true,
              onPick: () => onDeleteFolder(folderMenu.id),
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
              label: '顶层（全部笔记）',
              onPick: () => onMoveFolder(moveMenu.id, null),
            },
            ...moveTargets.map((f) => ({
              key: `f-${f.id}`,
              label: f.name,
              onPick: () => onMoveFolder(moveMenu.id, f.id),
            })),
          ]}
        />
      )}
    </div>
  )
}
