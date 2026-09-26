import { useState, type DragEvent as ReactDragEvent, type ReactNode } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FolderTree,
  Inbox,
  List,
  MoreHorizontal,
  Plus,
  SlidersHorizontal,
  X,
} from '@renderer/lib/icons'
import type { ListFolder } from '@shared/types'
import { PopMenu, type PopMenuItem } from './PopMenu'

/**
 * 「已完成」与「已放弃」的筛选键。
 *
 * 它们不是真实清单 id（带下划线前缀，永不与数字冲突）：终态任务不从属于任何
 * 清单视图的位置关系，而是被**收归**到这两个入口里 —— 清单里留着划掉的行，
 * 既占位置，又让「还剩多少」变得不可信。
 */
export const DONE_KEY = '__done'
export const ABANDONED_KEY = '__abandoned'

/** 侧栏每个入口右上角的数字；byList 是「顶层未完成根任务数」 */
export interface ListCounts {
  all: number
  inbox: number
  done: number
  abandoned: number
  byList: Map<number, number>
}

/** 智能清单（保存的查询）：名称 + 表达式，求值在渲染层 */
export interface SavedQuery {
  id: number
  name: string
  kind: string
  expr: string
}

interface Props {
  /** list_folder 全表（分组 + 清单，已按 sort 排序） */
  folders: ListFolder[]
  /** 当前筛选键：'' 全部 / 'none' 收件箱 / DONE_KEY / ABANDONED_KEY / 清单 id 字符串 */
  activeKey: string
  counts: ListCounts
  onPick: (key: string) => void
  /** 新建清单；parentId 非空表示挂在该分组下 */
  onNewList: (parentId: number | null) => void
  /** 新建分组；parentId 非空表示建子分组 */
  onNewGroup: (parentId: number | null) => void
  onRename: (f: ListFolder) => void
  onDelete: (f: ListFolder) => void
  /** 把清单 / 分组移动到某分组下（null = 顶层） */
  onMove: (id: number, parentId: number | null) => void
  /** 拖拽落点：把 id 放到 anchor 的上（below=false）或下（below=true） */
  onReorder: (id: number, anchorId: number, below: boolean) => void
  /** 智能清单（第二段） */
  queries: SavedQuery[]
  activeQueryId: number | null
  onPickQuery: (id: number) => void
  onNewQuery: () => void
  onRenameQuery: (q: SavedQuery) => void
  onDeleteQuery: (q: SavedQuery) => void
}

/**
 * 任务页左侧的清单栏。
 *
 * 三块：上面是全部任务 / 收件箱，中间是清单与分组树（可拖拽排序、可拖进拖出分组），
 * 下面是智能清单与两个终态入口。清单、分组、智能清单都做成看得见、点得到的行。
 */
export function TaskLists({
  folders,
  activeKey,
  counts,
  onPick,
  onNewList,
  onNewGroup,
  onRename,
  onDelete,
  onMove,
  onReorder,
  queries,
  activeQueryId,
  onPickQuery,
  onNewQuery,
  onRenameQuery,
  onDeleteQuery,
}: Props) {
  /** 折叠的分组（只影响分组自身的展开状态；空分组展开后什么也不显示） */
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  /** 行右键菜单（重命名 / 删除 / 新建子级 / 移动到分组） */
  const [menu, setMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  /** 「移动到分组…」二级菜单 */
  const [moveMenu, setMoveMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  /** 智能清单行的右键菜单 */
  const [queryMenu, setQueryMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  /** 正在拖的行；null = 没有拖拽 */
  const [dragId, setDragId] = useState<number | null>(null)
  /** 落点提示：before/after 是同级插入，inside 是「放进这个分组」 */
  const [dropHint, setDropHint] = useState<{ id: number; pos: 'before' | 'after' | 'inside' } | null>(null)

  const childrenOf = (parentId: number | null): ListFolder[] =>
    folders.filter((f) => (f.parent_id ?? null) === parentId)

  const toggle = (id: number): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /** 分组自身的计数 = 其下清单与子分组的计数之和（分组不直接装任务） */
  const groupTotal = (id: number): number => {
    let n = counts.byList.get(id) ?? 0
    for (const k of childrenOf(id)) n += groupTotal(k.id)
    return n
  }

  /** 可作为移动目标的父级：所有分组，排除自己与自己的后代（避免树成环） */
  const moveTargets = (id: number): ListFolder[] => {
    const banned = new Set<number>([id])
    const collect = (pid: number): void => {
      for (const k of childrenOf(pid)) {
        banned.add(k.id)
        collect(k.id)
      }
    }
    collect(id)
    const out: ListFolder[] = []
    const walk = (parentId: number | null): void => {
      for (const g of childrenOf(parentId)) {
        if (g.kind !== 'group' || banned.has(g.id)) continue
        out.push(g)
        walk(g.id)
      }
    }
    walk(null)
    return out
  }

  const rowCls = (on: boolean, extra = ''): string =>
    'tasklists__row' + (on ? ' tasklists__row--on' : '') + extra

  /** 拖拽相关的类名：正在拖的行变淡，落点行画出插入线 / 分组高亮 */
  const dragCls = (id: number): string => {
    const dragging = dragId === id ? ' tasklists__row--dragging' : ''
    const hint = dropHint?.id === id ? ` tasklists__row--drop-${dropHint.pos}` : ''
    return dragging + hint
  }

  const dragHandlers = (id: number, allowInside: boolean) => ({
    draggable: true,
    onDragStart: (e: ReactDragEvent) => {
      e.dataTransfer.setData('text/plain', String(id))
      e.dataTransfer.effectAllowed = 'move'
      setDragId(id)
    },
    onDragEnd: () => {
      setDragId(null)
      setDropHint(null)
    },
    onDragOver: (e: ReactDragEvent) => {
      if (dragId === null || dragId === id) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const r = e.currentTarget.getBoundingClientRect()
      const ratio = (e.clientY - r.top) / r.height
      // 分组行中间那条（25%–75%）是「放进这个分组」；清单行没有内部，只分上下
      const pos: 'before' | 'after' | 'inside' = allowInside
        ? ratio < 0.25
          ? 'before'
          : ratio > 0.75
            ? 'after'
            : 'inside'
        : ratio < 0.5
          ? 'before'
          : 'after'
      setDropHint((prev) => (prev?.id === id && prev.pos === pos ? prev : { id, pos }))
    },
    onDrop: (e: ReactDragEvent) => {
      e.preventDefault()
      // 落点按**放下的那一刻**的坐标重算，而不是读 state：
      // dragover 与 drop 之间可能差一帧，用 state 会偶尔拿到上一次的提示。
      const from = dragId ?? Number(e.dataTransfer.getData('text/plain'))
      setDragId(null)
      setDropHint(null)
      if (!Number.isFinite(from) || from === id) return
      const r = e.currentTarget.getBoundingClientRect()
      const ratio = (e.clientY - r.top) / r.height
      if (allowInside && ratio >= 0.25 && ratio <= 0.75) {
        onMove(from, id)
        return
      }
      const below = allowInside ? ratio > 0.75 : ratio >= 0.5
      onReorder(from, id, below)
    },
  })

  const listRow = (f: ListFolder, depth: number): ReactNode => {
    const on = activeKey === String(f.id)
    return (
      <div
        key={f.id}
        className={rowCls(on, dragCls(f.id))}
        style={{ paddingLeft: 8 + depth * 12 }}
        role="treeitem"
        aria-selected={on}
        onClick={() => onPick(String(f.id))}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ id: f.id, x: e.clientX, y: e.clientY })
        }}
        {...dragHandlers(f.id, false)}
      >
        <List size={13} className="tasklists__icon" aria-hidden />
        <span className="tasklists__name">{f.name}</span>
        <span className="tasklists__count">{counts.byList.get(f.id) ?? 0}</span>
        <button
          className="icon-btn tasklists__more"
          aria-label={`清单「${f.name}」的更多操作`}
          title="更多操作"
          onClick={(e) => {
            e.stopPropagation()
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setMenu({ id: f.id, x: r.left, y: r.bottom + 4 })
          }}
        >
          <MoreHorizontal size={13} />
        </button>
      </div>
    )
  }

  const groupNode = (g: ListFolder, depth: number): ReactNode => {
    const kids = childrenOf(g.id)
    const open = !collapsed.has(g.id)
    const on = activeKey === String(g.id)
    return (
      <div key={g.id}>
        <div
          className={rowCls(on, ' tasklists__row--group' + dragCls(g.id))}
          style={{ paddingLeft: 4 + depth * 12 }}
          role="treeitem"
          aria-selected={on}
          // 点分组 = 选中它（看这个分组下所有清单的任务），折叠交给左侧的 caret。
          // 此前整行都是折叠开关：分组因此点不「选中」，而 caret 又藏在一个 14px 的
          // 小按钮里，想选中分组根本没有入口。
          onClick={() => onPick(String(g.id))}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ id: g.id, x: e.clientX, y: e.clientY })
          }}
          {...dragHandlers(g.id, true)}
        >
          <button
            className="trow__caret"
            aria-expanded={open}
            aria-label={open ? `折叠分组「${g.name}」` : `展开分组「${g.name}」`}
            onClick={(e) => {
              e.stopPropagation()
              toggle(g.id)
            }}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <FolderTree size={13} className="tasklists__icon" aria-hidden />
          <span className="tasklists__name">{g.name}</span>
          <span className="tasklists__count">{groupTotal(g.id)}</span>
          <button
            className="icon-btn tasklists__more"
            title="在此分组新建清单"
            aria-label={`在「${g.name}」下新建清单`}
            onClick={(e) => {
              e.stopPropagation()
              onNewList(g.id)
            }}
          >
            <Plus size={13} />
          </button>
          <button
            className="icon-btn tasklists__more"
            title="更多操作"
            aria-label={`分组「${g.name}」的更多操作`}
            onClick={(e) => {
              e.stopPropagation()
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setMenu({ id: g.id, x: r.left, y: r.bottom + 4 })
            }}
          >
            <MoreHorizontal size={13} />
          </button>
        </div>
        {open && kids.length > 0 && (
          <div role="group">
            {kids.map((k) => (k.kind === 'group' ? groupNode(k, depth + 1) : listRow(k, depth + 1)))}
          </div>
        )}
      </div>
    )
  }

  const menuFolder = menu ? folders.find((f) => f.id === menu.id) : undefined
  const menuItems: PopMenuItem[] = menuFolder
    ? [
        ...(menuFolder.kind === 'group'
          ? ([
              { key: 'new-list', label: '在此新建清单…', onPick: () => onNewList(menuFolder.id) },
              { key: 'new-group', label: '在此新建子分组…', onPick: () => onNewGroup(menuFolder.id) },
            ] satisfies PopMenuItem[])
          : []),
        { key: 'rename', label: '重命名…', onPick: () => onRename(menuFolder) },
        {
          key: 'move',
          label: '移动到分组…',
          onPick: () => setMoveMenu({ id: menuFolder.id, x: menu!.x, y: menu!.y }),
        },
        { key: 'delete', label: '删除', danger: true, onPick: () => onDelete(menuFolder) },
      ]
    : []

  const menuQuery = queryMenu ? queries.find((q) => q.id === queryMenu.id) : undefined

  return (
    <aside className="tasklists" aria-label="清单">
      {/* 整栏的收起按钮不在这里：它挪到了任务页工具栏「列表」旁边。
          这里只管「折叠某个分组」——两者是两件事。 */}
      <div className="tasklists__head">
        <span>清单</span>
        <button
          className="icon-btn"
          title="新建清单"
          aria-label="新建清单"
          onClick={() => onNewList(null)}
        >
          <Plus size={13} />
        </button>
      </div>

      {/* 整栏的显示与否由任务页决定（只在列表视图、且没被收起时渲染本组件）——
          这里**不**再把树藏起来：藏起来的行仍会被查询/自动化脚本当成「看得见」。 */}
      <div className="tasklists__body" role="tree" aria-label="清单树">
          <div
            className={rowCls(activeKey === '')}
            style={{ paddingLeft: 8 }}
            role="treeitem"
            aria-selected={activeKey === ''}
            onClick={() => onPick('')}
          >
            <List size={13} className="tasklists__icon" aria-hidden />
            <span className="tasklists__name">全部任务</span>
            <span className="tasklists__count">{counts.all}</span>
          </div>
          <div
            className={rowCls(activeKey === 'none')}
            style={{ paddingLeft: 8 }}
            role="treeitem"
            aria-selected={activeKey === 'none'}
            onClick={() => onPick('none')}
          >
            <Inbox size={13} className="tasklists__icon" aria-hidden />
            <span className="tasklists__name">收件箱</span>
            <span className="tasklists__count">{counts.inbox}</span>
          </div>

          {childrenOf(null).map((f) => (f.kind === 'group' ? groupNode(f, 0) : listRow(f, 0)))}

          {folders.length === 0 && (
            <p className="u-aux tasklists__hint" style={{ paddingLeft: 8 }}>
              还没有清单。点上方 ＋ 新建一个。
            </p>
          )}
        </div>

        {/* 第二段：智能清单 —— 和清单一样是「我要看什么」的入口，只是过滤条件由表达式给出 */}
        <div className="tasklists__section">
          <div className="tasklists__head tasklists__head--sub">
            <span>智能清单</span>
            <button
              className="icon-btn"
              title="把当前筛选保存成智能清单"
              aria-label="新建智能清单"
              onClick={onNewQuery}
            >
              <Plus size={13} />
            </button>
          </div>
          <div className="tasklists__body tasklists__body--sub" role="tree" aria-label="智能清单">
            {queries.length === 0 && (
              <p className="u-aux tasklists__hint" style={{ paddingLeft: 8 }}>
                还没有智能清单。
              </p>
            )}
            {queries.map((q) => (
              <div
                key={q.id}
                className={rowCls(activeQueryId === q.id)}
                style={{ paddingLeft: 8 }}
                role="treeitem"
                aria-selected={activeQueryId === q.id}
                onClick={() => onPickQuery(q.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setQueryMenu({ id: q.id, x: e.clientX, y: e.clientY })
                }}
              >
                <SlidersHorizontal size={13} className="tasklists__icon" aria-hidden />
                <span className="tasklists__name" title={q.expr}>
                  {q.name}
                </span>
                <button
                  className="icon-btn tasklists__more"
                  title="更多操作"
                  aria-label={`智能清单「${q.name}」的更多操作`}
                  onClick={(e) => {
                    e.stopPropagation()
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setQueryMenu({ id: q.id, x: r.left, y: r.bottom + 4 })
                  }}
                >
                  <MoreHorizontal size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="tasklists__foot">
          <div
            className={rowCls(activeKey === DONE_KEY)}
            style={{ paddingLeft: 8 }}
            role="treeitem"
            aria-selected={activeKey === DONE_KEY}
            onClick={() => onPick(DONE_KEY)}
          >
            <CheckCircle2 size={13} className="tasklists__icon" aria-hidden />
            <span className="tasklists__name">已完成</span>
            <span className="tasklists__count">{counts.done}</span>
          </div>
          <div
            className={rowCls(activeKey === ABANDONED_KEY)}
            style={{ paddingLeft: 8 }}
            role="treeitem"
            aria-selected={activeKey === ABANDONED_KEY}
            onClick={() => onPick(ABANDONED_KEY)}
          >
            <X size={13} className="tasklists__icon" aria-hidden />
            <span className="tasklists__name">已放弃</span>
            <span className="tasklists__count">{counts.abandoned}</span>
          </div>
      </div>

      {menu && menuFolder && (
        <PopMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuItems} />
      )}

      {queryMenu && menuQuery && (
        <PopMenu
          x={queryMenu.x}
          y={queryMenu.y}
          onClose={() => setQueryMenu(null)}
          items={[
            { key: 'apply', label: '应用这个智能清单', onPick: () => onPickQuery(menuQuery.id) },
            { key: 'rename', label: '重命名…', onPick: () => onRenameQuery(menuQuery) },
            {
              key: 'delete',
              label: '删除',
              danger: true,
              onPick: () => onDeleteQuery(menuQuery),
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
            { key: 'root', label: '顶层（不分分组）', onPick: () => onMove(moveMenu.id, null) },
            ...moveTargets(moveMenu.id).map((g) => ({
              key: `g-${g.id}`,
              label: g.name,
              onPick: () => onMove(moveMenu.id, g.id),
            })),
          ]}
        />
      )}
    </aside>
  )
}
