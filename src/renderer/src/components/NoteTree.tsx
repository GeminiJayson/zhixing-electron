import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, FilePlus2, FolderPlus, Pin, Search, Trash2 } from 'lucide-react'
import type { Note, NoteFolder } from '@shared/types'
import { PopMenu } from './PopMenu'

interface Props {
  notes: Note[]
  folders: NoteFolder[]
  selectedId: number | null
  onSelect: (id: number) => void
  onCreateNote: (folderId: number | null) => void
  /** 新建笔记使用的格式（Markdown / 富文本 / Word / Excel / 链接） */
  createFormat: string
  onCreateFormatChange: (format: string) => void
  onCreateFolder: () => void
  onTogglePin: (id: number, pinned: boolean) => void
  onDeleteNote: (id: number) => void
  onContextMenuNote: (id: number, x: number, y: number) => void
  /** 文件夹操作（对齐 note_page 的 _rename_folder_dialog / _delete_folder / move_folder） */
  onRenameFolder: (id: number, currentName: string) => void
  onDeleteFolder: (id: number) => void
  onMoveFolder: (id: number, parentId: number | null) => void
}

/** 笔记树：文件夹层级 + 文件夹内笔记（对齐 note_page 的两栏左树）。 */
export function NoteTree({
  notes,
  folders,
  selectedId,
  onSelect,
  onCreateNote,
  createFormat,
  onCreateFormatChange,
  onCreateFolder,
  onTogglePin,
  onDeleteNote,
  onContextMenuNote,
  onRenameFolder,
  onDeleteFolder,
  onMoveFolder,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [query, setQuery] = useState('')
  /** 树宽（可拖右边缘调整），默认与 CSS 里的 240px 一致 */
  const [treeWidth, setTreeWidth] = useState(240)
  const resizeRef = useRef<{ x: number; w: number } | null>(null)
  /** 文件夹右键菜单（N-§1.3#12）：重命名 / 移动 / 删除 */
  const [folderMenu, setFolderMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  /** 「移动到…」二级菜单：列出可作为父级的文件夹 */
  const [moveMenu, setMoveMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  /** S22 文件夹深链目标：展开父链后高亮该文件夹并滚入视野，随后自动取消高亮 */
  const [folderFocus, setFolderFocus] = useState<number | null>(null)

  // S22：文件夹深链（图谱双击文件夹）——展开父链（折叠时目标不渲染），登记待定位 id
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

  const noteRow = (n: Note, depth: number): React.ReactNode => {
    const hit = matched === null || matched.has(n.id)
    if (!hit) return null
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
        {n.pinned ? <Pin size={12} className="ntree__pin" /> : <span className="ntree__dot" />}
        <span className="ntree__title">{n.title}</span>
        <span className="ntree__actions">
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
            <ChevronRight size={13} />
          </button>
          <span className="ntree__foldername">{f.name}</span>
          <span className="u-aux">{own.length}</span>
        </div>
        {isOpen && (
          <>
            {own.map((n) => noteRow(n, depth + 1))}
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
      <div className="ntree__tools">
        <div className="ntree__search">
          <Search size={13} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题…"
            aria-label="搜索笔记标题"
          />
        </div>
        <select
          className="field field--compact ntree__format"
          value={createFormat}
          onChange={(e) => onCreateFormatChange(e.target.value)}
          aria-label="新建笔记的格式"
          title="新建笔记的格式"
        >
          <option value="markdown">Markdown</option>
          <option value="richtext">富文本</option>
          <option value="word">Word</option>
          <option value="excel">Excel</option>
          <option value="link">链接</option>
        </select>
        <button className="icon-btn" title="新建笔记" aria-label="新建笔记" onClick={() => onCreateNote(null)}>
          <FilePlus2 size={15} />
        </button>
        <button className="icon-btn" title="新建文件夹" aria-label="新建文件夹" onClick={onCreateFolder}>
          <FolderPlus size={15} />
        </button>
      </div>
      <div className="ntree__body">
        {rootNotes.map((n) => noteRow(n, 0))}
        {childrenOf(null).map((f) => folderNode(f, 0))}
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

      {folderMenu && menuFolder && (
        <PopMenu
          x={folderMenu.x}
          y={folderMenu.y}
          onClose={() => setFolderMenu(null)}
          items={[
            {
              key: 'new-sub',
              label: '在此新建笔记',
              onPick: () => onCreateNote(folderMenu.id),
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
