import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Morph, IconData, Plus, Trash2 } from '@renderer/lib/icons'
import {
  STATUS_LABELS,
  buildTaskTree,
  effectiveDoneMap,
  isTerminal,
  listIdsInFolder,
  tasksInListScope,
  type TaskNode,
} from '@shared/task'
import { filterTasks } from '@shared/query'
import { priorityLabel } from '@shared/priority'
import type {
  ListFolder,
  Task,
  TaskStatus,
  WorkflowInstancePayload,
  WorkflowTemplateSummary,
} from '@shared/types'
import { subscribeDomain } from '@shared/events'
import { parseSettings } from '@shared/settings'
import { t } from '../i18n'
import { useDialog } from '../components/Dialogs'
import { PopMenu, type PopMenuItem } from '../components/PopMenu'
import { TagMenu } from '../components/TagMenu'
import {
  ABANDONED_KEY,
  DONE_KEY,
  TaskLists,
  type ListCounts,
  type SavedQuery,
} from '../components/TaskLists'
import { VirtualList } from '../components/VirtualList'
import { PriorityMenu } from '../components/PriorityMenu'
import { StatusMenu } from '../components/StatusMenu'
import { CalendarBoard } from '../components/CalendarBoard'
import { KanbanBoard } from '../components/KanbanBoard'
import { QuadrantBoard, quadrantAssignment, type QuadrantKey } from '../components/QuadrantBoard'
import { TaskEditor } from '../components/TaskEditor'
import { TaskRow } from '../components/TaskRow'
import { Toolbar } from '../components/Toolbar'
import { dueLabel } from '../lib/date'
import { quietFailure } from '@shared/quiet-failure'

interface Props {
  onChanged: () => Promise<void>
  onNotice: (message: string) => void
  /** 今日页概览卡带过来的聚焦清单 */
  focus?: 'today' | 'done' | 'overdue' | null
  onClearFocus?: () => void
}

type ViewKey = 'list' | 'quadrant' | 'calendar' | 'kanban'

const VIEWS: { key: ViewKey; label: string }[] = [
  { key: 'list', label: '列表' },
  { key: 'quadrant', label: '四象限' },
  { key: 'calendar', label: '日历' },
  { key: 'kanban', label: '看板' },
]

type Tag = { id: number; name: string; color: string }

/** 工作流实例状态的中文名（与 WorkflowPage 的取值口径一致）。 */
function wfStatusLabel(status: string): string {
  return status === 'running' ? '进行中' : status === 'done' ? '已完成' : '已中止'
}

/** 过滤规则：自身命中或任一后代命中即保留。 */
function filterTree(nodes: TaskNode[], query: string): TaskNode[] {
  if (!query.trim()) return nodes
  const q = query.trim().toLowerCase()
  const walk = (list: TaskNode[]): TaskNode[] =>
    list
      .map((n) => ({ ...n, children: walk(n.children) }))
      .filter((n) => n.title.toLowerCase().includes(q) || n.children.length > 0)
  return walk(nodes)
}

export function TasksPage({ onChanged, onNotice, focus = null, onClearFocus }: Props) {
  const dialog = useDialog()
  const [tasks, setTasks] = useState<Task[]>([])
  const [counts, setCounts] = useState<Map<number, number>>(new Map())
  const [tags, setTags] = useState<Map<number, Tag[]>>(new Map())
  const [view, setView] = useState<ViewKey>('list')
  /**
   * 清单树是否收起。纯界面偏好，存 localStorage 而不是库表 ——
   * 与命令面板的 MRU 同一个理由：它不该跟着数据一起被导出 / 同步。
   */
  const [treeHidden, setTreeHidden] = useState(() => localStorage.getItem('zhixing.tree.tasks') === '1')
  useEffect(() => {
    localStorage.setItem('zhixing.tree.tasks', treeHidden ? '1' : '0')
  }, [treeHidden])
  const [filter, setFilter] = useState('')
  const [folders, setFolders] = useState<ListFolder[]>([])
  /** 清单筛选：'' = 全部；'none' = 收件箱（list_id 为空）；其它 = 清单 id */
  const [listKey, setListKey] = useState('')
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  /** 四象限/日历/看板共享的「展开子任务」集合（与列表的 collapsed 语义相反） */
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [selected, setSelected] = useState<number | null>(null)
  /** 多选集合（Ctrl/Cmd 点击切换、Shift 点击选范围），批量操作的输入 */
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [batchMenu, setBatchMenu] = useState<{ x: number; y: number } | null>(null)
  /** 清单设置的菜单锚点（改名与删除从这里分开走） */
  const [listMenu, setListMenu] = useState<{ x: number; y: number } | null>(null)
  /** 列表视图的行高（与 --row-h 同源，虚拟列表要求固定行高） */
  const [rowH, setRowH] = useState(40)
  // 行高取自 --row-h（虚拟列表要求固定行高，不能用内容撑开）
  useEffect(() => {
    const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row-h'), 10)
    if (Number.isFinite(v) && v > 0) setRowH(v)
  }, [])

  const [dragId, setDragId] = useState<number | null>(null)
  const [dropHint, setDropHint] = useState<{ id: number; pos: 'before' | 'after' | 'child' } | null>(null)
  const [inspector, setInspector] = useState(false)
  const [menu, setMenu] = useState<{ id: number; anchor: HTMLElement } | null>(null)
  /** 状态胶囊的快捷菜单（与优先级菜单互不影响，可以各自开着） */
  const [statusMenu, setStatusMenu] = useState<{ id: number; anchor: HTMLElement } | null>(null)
  const [allTags, setAllTags] = useState<{ id: number; name: string; color: string }[]>([])
  const [tagMenu, setTagMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  /** 移动到清单的选择器：ids 支持单选与批量共用 */
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number; ids: number[] } | null>(null)
  /** 「挂到任务下」目标选择器（走 task_candidates） */
  const [parentPicker, setParentPicker] = useState<{ id: number; x: number; y: number } | null>(null)
  const [pickerQ, setPickerQ] = useState('')
  const [pickerItems, setPickerItems] = useState<Task[]>([])
  /** 日历显示已完成（settings.calendar_show_done，默认 false；此前只写不读） */
  const [showDone, setShowDone] = useState(false)
  const [adding, setAdding] = useState<{ parentId: number | null } | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  /** 深链目标：等父链展开、目标行进入展平结果后再滚动，然后清空 */
  const [pendingFocus, setPendingFocus] = useState<number | null>(null)
  /** 选中任务关联的工作流实例（速览「工作流」卡片） */
  const [wfInstances, setWfInstances] = useState<WorkflowInstancePayload[]>([])
  /** 可启动的工作流模板（「启动工作流…」菜单） */
  const [wfTemplates, setWfTemplates] = useState<WorkflowTemplateSummary[]>([])
  const [wfMenu, setWfMenu] = useState<{ x: number; y: number } | null>(null)
  const addRef = useRef<HTMLInputElement>(null)

  /**
   * 取一次数据。
   *
   * **始终取全量任务**，清单范围改在渲染层切：侧栏要给每个清单显示「还剩多少」，
   * 而 tasksByList 一次只返回一个清单 —— 要么为每个清单各取一次，要么取全量。
   * 全量一份还能让「完成任务 → 从当前清单收走 → 出现在已完成」在同一帧里算准，
   * 不必等第二次 IPC。切换清单因此是纯前端过滤，点哪都是立刻响应。
   */
  const load = useCallback(async () => {
    const [rows, nc, tt, tg, fs, st] = await Promise.all([
      window.zhixing.db.tasks(),
      window.zhixing.db.noteCounts(),
      window.zhixing.db.taskTags(),
      window.zhixing.db.tags(),
      window.zhixing.db.listFolders(),
      window.zhixing.db.settings(),
    ])
    setAllTags(tg)
    setFolders(fs as ListFolder[])
    setShowDone(parseSettings(st).calendar_show_done)
    const countMap = new Map<number, number>()
    for (const r of nc) countMap.set(r.task_id, r.c)
    const tagMap = new Map<number, Tag[]>()
    for (const r of tt) {
      const list = tagMap.get(r.task_id) ?? []
      list.push({ id: r.id, name: r.name, color: r.color })
      tagMap.set(r.task_id, list)
    }
    setTasks(rows as Task[])
    setCounts(countMap)
    setTags(tagMap)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 任务域也要跟上。此前本页只订阅 settings / workflow，于是**任何不是本页自己发起**的
  // 任务改动都停在旧数据上：编辑弹窗里改完日期，列表里的日期 chip 与进度条都还是旧的。
  // 这类改动只广播事件，订阅一次就够了。
  useEffect(() => subscribeDomain(['task'], () => void load()), [load])

  // 「挂到任务下」候选：走 task_candidates（q 变化即时搜索）
  useEffect(() => {
    if (!parentPicker) return
    let alive = true
    const target = parentPicker.id
    void (async () => {
      const rows = await window.zhixing.db.taskCandidates(pickerQ, 20)
      if (alive) setPickerItems(rows.filter((t) => t.id !== target))
    })()
    return () => {
      alive = false
    }
  }, [parentPicker, pickerQ])

  useEffect(() => {
    if (adding) addRef.current?.focus()
  }, [adding])

  /** 智能清单：名称 + 表达式（表达式由 shared/query.ts 解析，在渲染层过滤） */
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([])
  const [activeQueryId, setActiveQueryId] = useState<number | null>(null)
  const activeQuery = savedQueries.find((q) => q.id === activeQueryId) ?? null

  const loadSavedQueries = useCallback(async (): Promise<void> => {
    try {
      setSavedQueries(await window.zhixing.db.savedQueries())
    } catch (e) {
      // 读失败会显示成「一个智能清单都没有」，看起来像数据没了
      quietFailure('读取智能清单', e)
      setSavedQueries([])
    }
  }, [])

  useEffect(() => {
    void loadSavedQueries()
  }, [loadSavedQueries])

  // 设置域同时包含「日历显示已完成」与保存的查询：别处新增 / 删除智能清单之后，
  // 清单栏第二段要跟着刷新 —— 否则刚存出来的智能清单要重开页面才看得见。
  useEffect(
    () =>
      subscribeDomain(['settings'], () => {
        void load()
        void loadSavedQueries()
      }),
    [load, loadSavedQueries]
  )

  /**
   * 点清单：切到该清单范围，并退出智能清单模式。
   *
   * 两者刻意不叠加：清单 + 表达式两层过滤的结果往往窄到「一条都没有」，
   * 用户看到空列表时根本不知道是哪一层把任务滤掉的。
   */
  const pickList = (key: string): void => {
    setListKey(key)
    setActiveQueryId(null)
  }

  /** 点智能清单：清空清单筛选，改用表达式过滤 */
  const pickQuery = (id: number): void => {
    setActiveQueryId(id)
    setListKey('')
  }

  /** 存为智能清单：工具栏按钮与清单栏第二段的 ＋ 共用同一条路径 */
  const saveAsSmartList = async (): Promise<void> => {
    const name = await dialog.prompt({ title: '保存为智能清单', label: '名称' })
    if (!name?.trim()) return
    const expr = await dialog.prompt({
      title: '查询表达式',
      label: '表达式（如 !done due<=today priority>=3）',
      defaultValue: filter,
    })
    if (!expr?.trim()) return
    const res = await window.zhixing.db.saveSavedQuery({ name: name.trim(), expr: expr.trim() })
    if (!res.ok) {
      onNotice('保存失败：' + res.problems.join('；'))
      return
    }
    await loadSavedQueries()
    if (res.id) pickQuery(res.id)
    onNotice('已保存智能清单「' + name.trim() + '」')
  }

  /** 重命名智能清单：只改名称，表达式原样带回 */
  const renameQuery = async (q: SavedQuery): Promise<void> => {
    const name = await dialog.prompt({
      title: '重命名智能清单',
      label: '新名称',
      defaultValue: q.name,
    })
    if (name === null) return
    const clean = name.trim()
    if (!clean || clean === q.name) return
    const res = await window.zhixing.db.saveSavedQuery({
      id: q.id,
      name: clean,
      kind: q.kind,
      expr: q.expr,
    })
    if (!res.ok) {
      onNotice('重命名失败：' + res.problems.join('；'))
      return
    }
    await loadSavedQueries()
    onNotice('已重命名为「' + clean + '」')
  }

  /** 删除智能清单：只删这条保存的查询，任务与清单都不受影响 */
  const deleteQuery = async (q: SavedQuery): Promise<void> => {
    const ok = await dialog.confirm({
      title: '删除智能清单',
      message: '删除「' + q.name + '」？只是删掉这条保存的查询，任务与清单都不受影响。',
      danger: true,
      confirmText: '删除',
    })
    if (!ok) return
    await window.zhixing.db.deleteSavedQuery(q.id)
    if (activeQueryId === q.id) setActiveQueryId(null)
    await loadSavedQueries()
    onNotice('已删除智能清单')
  }

  const effective = useMemo(() => effectiveDoneMap(tasks), [tasks])

  /**
   * 清单范围：选中某清单时取「根 + 后代闭包」，与主进程 listTasksByList 同一套语义
   * （根 = 该清单下的顶层任务；该清单没有任何顶层任务时回退为它的全部任务）。
   *
   * 子任务的 list_id 可能与父不同，闭包保证它们不会因为「根判定」被漏掉 ——
   * 这正是此前直接调 tasksByList 时最容易出错的地方，现在同一份判定只写在这里。
   */
  /**
   * 选中的是**分组**时，它下面所有清单的 id（含子分组的）。null = 当前选的不是分组。
   *
   * 分组自己不装任务（见 TaskLists 的 groupTotal），所以「选中分组」就是「选中它下面
   * 所有清单」。展开成清单 id 之后再走同一套 tasksInListScope 闭包 —— 清单范围的判定
   * 只写一次，不与主进程 listTasksByList 的语义打架。
   */
  const folderScopeIds = useMemo(() => {
    if (listKey === '' || listKey === 'none' || listKey === DONE_KEY || listKey === ABANDONED_KEY) {
      return null
    }
    const id = Number(listKey)
    if (!Number.isFinite(id)) return null
    const f = folders.find((x) => x.id === id)
    if (!f || f.kind !== 'group') return null
    return listIdsInFolder(folders, id)
  }, [listKey, folders])

  const listScopedTasks = useMemo(() => {
    if (listKey === '' || listKey === DONE_KEY || listKey === ABANDONED_KEY) return tasks
    if (folderScopeIds) {
      // 各清单的闭包取并集；最后按 tasks 的原顺序过滤，保住 sort_key 排出来的手工顺序
      const keep = new Set<number>()
      for (const id of folderScopeIds) {
        for (const t of tasksInListScope(tasks, id)) keep.add(t.id)
      }
      return tasks.filter((t) => keep.has(t.id))
    }
    const target = listKey === 'none' ? null : Number(listKey)
    if (target !== null && !Number.isFinite(target)) return tasks
    return tasksInListScope(tasks, target)
  }, [tasks, listKey, folderScopeIds])

  /**
   * 视图过滤：只筛根任务，子树仍由 buildTaskTree 自然挂回（与今日待办同口径）。
   *
   * 终态任务（完成 / 放弃）不再留在清单里，一律收进「已完成 / 已放弃」——
   * 清单里留着一排划掉的行，既占位置，又让「还剩多少」变得不可信。
   * 唯一的例外是子树：父任务还在，它的子任务就不该凭空消失。
   */
  const scopedTasks = useMemo(() => {
    const day = new Date().toLocaleDateString('sv-SE')
    const isDone = (t: Task): boolean => effective.get(t.id) ?? isTerminal(t.status)
    /** 终态视图（已完成 / 已放弃 / 今日页「已完成」聚焦）：跨清单，清单范围不参与 */
    const terminalView = listKey === DONE_KEY || listKey === ABANDONED_KEY || focus === 'done'
    const match = (t: Task): boolean => {
      if (terminalView) {
        // 终态视图里**逐行**判定：未完成的行哪怕挂在一条已完成的任务下，也不该出现在这里。
        // 此前「子任务一律放行」（parent_id !== null → true）是给普通清单视图留的例外，
        // 却让已完成清单里混进一排写着「待办」的子任务。
        if (listKey === ABANDONED_KEY) return t.status === 'abandoned'
        // 「已完成」显示**全部**有效已完成（跨清单、跨时间），而不是只有今天完成的；
        // 放弃的另有一格，不再混在里面 —— 两者的「该怎么处理」本来就不一样
        if (listKey === DONE_KEY) return isDone(t) && t.status !== 'abandoned'
        return isDone(t)
      }
      if (t.parent_id !== null) return true
      if (isDone(t)) return false
      if (focus === 'today') return t.due_date === null || t.due_date >= day
      if (focus === 'overdue') return t.due_date !== null && t.due_date < day
      return true
    }
    return listScopedTasks.filter(match)
  }, [listScopedTasks, focus, listKey, effective])

  /**
   * 终态视图按「最近结束的排最前」排：完成时间才是这时候最有用的线索；
   * 清单视图仍走 sort_key（用户拖出来的手工顺序）。
   */
  const orderedScopedTasks = useMemo(() => {
    if (listKey !== DONE_KEY && listKey !== ABANDONED_KEY) return scopedTasks
    const at = (t: Task): string => t.completed_at ?? t.updated_at ?? ''
    return [...scopedTasks].sort((a, b) => at(b).localeCompare(at(a)))
  }, [scopedTasks, listKey])

  /** 侧栏计数：只有顶层、未终态的任务算「还剩多少」；终态收归到两个入口里 */
  const listCounts = useMemo<ListCounts>(() => {
    const isDone = (t: Task): boolean => effective.get(t.id) ?? isTerminal(t.status)
    const byList = new Map<number, number>()
    let all = 0
    let inbox = 0
    let done = 0
    let abandoned = 0
    for (const t of tasks) {
      if (t.parent_id !== null) continue
      if (t.status === 'abandoned') {
        abandoned += 1
        continue
      }
      if (isDone(t)) {
        done += 1
        continue
      }
      all += 1
      if (t.list_id == null) inbox += 1
      else byList.set(t.list_id, (byList.get(t.list_id) ?? 0) + 1)
    }
    return { all, inbox, done, abandoned, byList }
  }, [tasks, effective])

  /** 工具栏「清单设置」里的当前目标：分组与清单的文案、后果都不同（分组不装任务） */
  const curFolderKind = folders.find((f) => f.id === Number(listKey))?.kind ?? null

  /** 清单 id → 名称：终态视图里给每一行标出它原来属于哪个清单 */
  const listNameById = useMemo(() => {
    const m = new Map<number, string>()
    for (const f of folders) m.set(f.id, f.name)
    return m
  }, [folders])

  /** 智能清单（保存的查询）：在聚焦过滤之后再套一层表达式过滤 */
  const queriedTasks = useMemo(() => {
    if (!activeQuery) return orderedScopedTasks
    const day = new Date().toLocaleDateString('sv-SE')
    const listNames: Record<number, string> = {}
    for (const f of folders) listNames[f.id] = f.name
    return filterTasks(orderedScopedTasks, activeQuery.expr, {
      today: day,
      listNames,
      tagsOf: (t) => (tags.get(t.id) ?? []).map((x) => x.name),
      // 把列表用的同一份「有效完成态」交给查询：否则智能清单里的 !done / done
      // 会和上面 scopedTasks 的判定不一致（abandoned 与 roll-up 都是分叉点）
      doneOf: (t) => effective.get(t.id) ?? isTerminal(t.status),
    })
  }, [orderedScopedTasks, activeQuery, folders, tags])

  const tree = useMemo(
    () => buildTaskTree(queriedTasks, effective, counts, tags),
    [queriedTasks, effective, counts, tags]
  )

  const visible = useMemo(() => filterTree(tree, filter), [tree, filter])

  /**
   * 树展平结果：[{node, depth}]，node 为 null 表示正在输入的「添加行」。
   *
   * 添加行必须计入行数：虚拟列表是按 count × rowHeight 做绝对定位的，
   * 漏算会让顶层新建压根不渲染（表现为「点新建任务没反应」），
   * 也会让子任务的添加行把后续行挤错位。
   */
  const flatRows = useMemo(() => {
    const rows: { node: TaskNode | null; depth: number }[] = []
    // 顶层新建：没有父任务时，添加行排在列表最前
    if (adding && adding.parentId === null) rows.push({ node: null, depth: 0 })
    const walk = (nodes: TaskNode[], depth: number): void => {
      for (const n of nodes) {
        rows.push({ node: n, depth })
        // 子任务添加行紧跟它的父任务
        if (adding?.parentId === n.id) rows.push({ node: null, depth: depth + 1 })
        if (!collapsed.has(n.id)) walk(n.children, depth + 1)
      }
    }
    walk(visible, 0)
    return rows
  }, [visible, collapsed, adding])

  const selectedNode = useMemo(() => {
    if (selected == null) return null
    const find = (list: TaskNode[]): TaskNode | null => {
      for (const n of list) {
        if (n.id === selected) return n
        const hit = find(n.children)
        if (hit) return hit
      }
      return null
    }
    return find(tree)
  }, [tree, selected])

  // 任务深链（托盘 / 图谱 / 命令面板）——切到列表视图、放开清单/聚焦/过滤等收窄条件，
  // 选中目标并登记待定位 id；父链展开与滚动交给下面的 effect
  useEffect(() => {
    const onOpenTask = (e: Event): void => {
      const id = Number((e as CustomEvent<{ id?: number }>).detail?.id)
      if (!Number.isFinite(id) || id <= 0) return
      setView('list')
      setFilter('')
      onClearFocus?.()
      setSelected(id)
      setSelectedIds(new Set([id]))
      setInspector(true)
      setPendingFocus(id)
      // 深链目标可能已经完成 —— 终态任务已被当前清单收走，若还停在原清单筛选上，
      // 下面的定位就永远等不到那一行（它会一直挂在 pendingFocus 上）。
      void (async () => {
        const t = await window.zhixing.db.getTask(id)
        const done = t != null && isTerminal(t.status)
        setListKey(done ? DONE_KEY : '')
      })()
    }
    window.addEventListener('zhixing:open-task', onOpenTask)
    return () => window.removeEventListener('zhixing:open-task', onOpenTask)
  }, [onClearFocus])

  // 深链定位：折叠状态下目标行不在 flatRows 里，所以先展开父链，等展平结果就绪再按
  // 固定行高把虚拟列表滚到目标居中；两步分开是为了避免用错位前的下标滚动
  useEffect(() => {
    if (pendingFocus == null) return
    const byId = new Map(tasks.map((t) => [t.id, t]))
    const target = byId.get(pendingFocus)
    if (!target) return
    const toOpen: number[] = []
    let cur = target.parent_id
    while (cur != null) {
      if (collapsed.has(cur)) toOpen.push(cur)
      cur = byId.get(cur)?.parent_id ?? null
    }
    if (toOpen.length) {
      setCollapsed((prev) => {
        const next = new Set(prev)
        for (const id of toOpen) next.delete(id)
        return next
      })
      return
    }
    const index = flatRows.findIndex((r) => r.node?.id === pendingFocus)
    if (index < 0) return
    const host = document.querySelector<HTMLElement>('.task-vlist')
    if (host) host.scrollTop = Math.max(0, index * rowH - host.clientHeight / 2 + rowH / 2)
    setPendingFocus(null)
  }, [pendingFocus, tasks, collapsed, flatRows, rowH])

  // 选中任务的工作流实例（速览卡片），工作流域有写入时跟着刷新
  const wfTaskId = selectedNode?.id ?? null
  useEffect(() => {
    if (wfTaskId == null) {
      setWfInstances([])
      return
    }
    let alive = true
    void window.zhixing.db.workflowInstancesOfTask(wfTaskId).then((rows) => {
      if (alive) setWfInstances(rows)
    })
    return () => {
      alive = false
    }
  }, [wfTaskId])

  useEffect(() => {
    if (wfTaskId == null) return
    return subscribeDomain(['workflow'], () => {
      void window.zhixing.db.workflowInstancesOfTask(wfTaskId).then(setWfInstances)
    })
  }, [wfTaskId])

  // 「启动工作流…」菜单的模板清单（模板本身只在工作流页改，进入本页取一次即可）
  useEffect(() => {
    void window.zhixing.db.workflowTemplates().then(setWfTemplates)
  }, [])

  const refresh = useCallback(async () => {
    await load()
    await onChanged()
  }, [load, onChanged])

  /** 为当前选中任务启动一个工作流实例（origin_task = 该任务）。 */
  const handleStartWorkflow = async (templateId: number): Promise<void> => {
    setWfMenu(null)
    const taskId = selectedNode?.id ?? null
    if (taskId == null) return
    await window.zhixing.db.instantiateWorkflow(templateId, null, taskId)
    onNotice('已启动工作流')
    setWfInstances(await window.zhixing.db.workflowInstancesOfTask(taskId))
    await refresh()
  }


  /** 列表视图的可见顺序，供 Shift 连选使用。 */
  const flatOrder = useMemo(() => {
    const out: number[] = []
    const walk = (nodes: TaskNode[]): void => {
      for (const n of nodes) {
        out.push(n.id)
        if (!collapsed.has(n.id)) walk(n.children)
      }
    }
    walk(visible)
    return out
  }, [visible, collapsed])

  /** 点击选择：默认单选；Ctrl/Cmd 切换；Shift 从主选中连选一片。 */
  const handleSelect = (id: number, e: React.MouseEvent): void => {
    if (e.shiftKey && selected != null) {
      const a = flatOrder.indexOf(selected)
      const b = flatOrder.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a <= b ? [a, b] : [b, a]
        setSelectedIds(new Set(flatOrder.slice(lo, hi + 1)))
        setSelected(id)
        return
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      setSelected(id)
      return
    }
    setSelectedIds(new Set([id]))
    setSelected(id)
  }

  const runBatch = async (
    action: 'complete' | 'due' | 'clearDue' | 'delete'
  ): Promise<void> => {
    const ids = [...selectedIds]
    if (!ids.length) return
    if (action === 'complete') {
      const n = await window.zhixing.db.batchComplete(ids)
      window.dispatchEvent(
        new CustomEvent('zhixing:undoable', { detail: { ids, label: `已批量完成 ${n} 项` } })
      )
    } else if (action === 'due') {
      const day = new Date().toLocaleDateString('sv-SE')
      const n = await window.zhixing.db.batchSetDue(ids, day)
      onNotice(`已把 ${n} 项截止设为今天`)
    } else if (action === 'clearDue') {
      const n = await window.zhixing.db.batchSetDue(ids, null)
      onNotice(`已清除 ${n} 项的截止日期`)
    } else {
      const confirmed = await dialog.confirm({
        title: '批量删除',
        message: `删除选中的 ${ids.length} 项及其子任务？\n软删除，可在回收站恢复。`,
        icon: <Trash2 size={15} />,
        danger: true,
        confirmText: '删除',
      })
      if (!confirmed) return
      await window.zhixing.db.batchDeleteTasks(ids)
      // 删除也可撤销
      window.dispatchEvent(
        new CustomEvent('zhixing:undoable', {
          detail: { ids, label: `已删除 ${ids.length} 项`, action: 'restore' },
        })
      )
    }
    setSelectedIds(new Set())
    await refresh()
  }

  /** 拖拽落点：上/下=排序，中间=改挂为该行的子任务。 */
  const handleDropRow = async (
    targetId: number,
    pos: 'before' | 'after' | 'child'
  ): Promise<void> => {
    const src = dragId
    setDragId(null)
    setDropHint(null)
    if (src == null || src === targetId) return
    if (pos === 'child') {
      await window.zhixing.db.reparentTask(src, targetId)
    } else {
      // before/after 落到别的父级下时先显式改挂
      // （reparent 只改父级、保留 sort_key），再 reorder 只调 sort_key。
      const srcTask = tasks.find((t) => t.id === src)
      const anchor = tasks.find((t) => t.id === targetId)
      if (srcTask && anchor && srcTask.parent_id !== anchor.parent_id) {
        await window.zhixing.db.reparentTask(src, anchor.parent_id)
      }
      await window.zhixing.db.reorderTask(src, targetId, pos === 'after')
    }
    await refresh()
  }

  const handleToggle = async (id: number): Promise<void> => {
    const before = tasks.find((t) => t.id === id)
    const wasDone = before
      ? (effective.get(id) ?? isTerminal(before.status))
      : false
    await window.zhixing.db.toggleTask(id)
    // 撤销要记录勾选前的 prev_status
    window.dispatchEvent(
      new CustomEvent('zhixing:undoable', {
        detail: {
          ids: [id],
          label: '任务状态已切换',
          prevStatus: wasDone ? (before?.status ?? 'todo') : 'done',
        },
      })
    )
    // 完成且挂有笔记段落 → 自动把「结论」回写到原笔记（只处理「有关联段落」的情形）
    if (!wasDone) {
      const ctxs = await window.zhixing.db.linkedContexts(id)
      if (ctxs.length) {
        const res = await window.zhixing.db.writeNoteAfterDone(id, before?.title ?? '')
        if (res) onNotice('已把结论回写到关联笔记')
      }
    }
    await refresh()
  }

  const handlePriority = async (priority: number): Promise<void> => {
    if (!menu) return
    await window.zhixing.db.setPriority(menu.id, priority)
    setMenu(null)
    await refresh()
  }

  const handleTitle = async (id: number, title: string): Promise<void> => {
    await window.zhixing.db.setTitle(id, title)
    await refresh()
  }

  const handleDelete = async (id: number): Promise<void> => {
    const node = tasks.find((t) => t.id === id)
    if (!node) return
    const ok = await dialog.confirm({
      title: '删除任务',
      message: `删除任务「${node.title}」及其子任务？\n软删除，可在回收站恢复。`,
      icon: <Trash2 size={15} />,
      danger: true,
      confirmText: '删除',
    })
    if (!ok) return
    const n = await window.zhixing.db.deleteTask(id)
    window.dispatchEvent(
      new CustomEvent('zhixing:undoable', {
        detail: { ids: [id], label: `已删除 ${n} 项`, action: 'restore' },
      })
    )
    if (selected === id) setSelected(null)
    await refresh()
  }

  /** 同级上移/下移。 */
  const handleMoveRelative = async (id: number, delta: number): Promise<void> => {
    await window.zhixing.db.moveTaskRelative(id, delta)
    await refresh()
  }

  /** 重新拉一次清单列表（增删改之后都要） */
  const reloadFolders = useCallback(async (): Promise<void> => {
    setFolders((await window.zhixing.db.listFolders()) as typeof folders)
  }, [])

  /** 新建清单：parentId 非空表示挂在某个分组下 */
  const newList = async (parentId: number | null = null): Promise<void> => {
    const name = await dialog.prompt({ title: '新建清单', label: '清单名称' })
    if (!name?.trim()) return
    await window.zhixing.db.createListFolder(name.trim(), 'list', parentId)
    await reloadFolders()
    onNotice('已新建清单「' + name.trim() + '」')
  }

  /** 新建分组：分组只收纳清单，不直接装任务 */
  const newGroup = async (parentId: number | null = null): Promise<void> => {
    const name = await dialog.prompt({ title: '新建分组', label: '分组名称' })
    if (!name?.trim()) return
    await window.zhixing.db.createListFolder(name.trim(), 'group', parentId)
    await reloadFolders()
    onNotice('已新建分组「' + name.trim() + '」')
  }

  /** 重命名任意清单 / 分组（侧栏右键与工具栏入口共用同一实现） */
  const renameList = async (f: ListFolder): Promise<void> => {
    const name = await dialog.prompt({ title: '重命名', label: '新名称', defaultValue: f.name })
    if (name === null) return // 用户取消
    const clean = name.trim()
    if (!clean || clean === f.name) return
    await window.zhixing.db.renameListFolder(f.id, clean)
    await reloadFolders()
    onNotice('已重命名为「' + clean + '」')
  }

  /** 删除清单 / 分组：清单里的任务回落收件箱，分组下的子级上移一级 */
  const deleteList = async (f: ListFolder): Promise<void> => {
    const ok = await dialog.confirm({
      title: f.kind === 'group' ? '删除分组' : '删除清单',
      message:
        f.kind === 'group'
          ? '删除分组「' + f.name + '」？它下面的清单会上移一级，任务不受影响。'
          : '删除「' + f.name + '」？清单里的任务会回到收件箱。',
      danger: true,
      confirmText: '删除',
    })
    if (!ok) return
    await window.zhixing.db.deleteListFolder(f.id)
    if (listKey === String(f.id)) setListKey('')
    await reloadFolders()
    onNotice('已删除「' + f.name + '」')
  }

  /** 把清单 / 分组移到某个分组下（null = 顶层）；环形目标由主进程拒绝 */
  const moveList = async (id: number, parentId: number | null): Promise<void> => {
    const n = await window.zhixing.db.moveListFolder(id, parentId)
    await reloadFolders()
    onNotice(n > 0 ? '已移动到「分组末尾」' : '不能移动到它自己或它的子级下')
  }

  /** 侧栏拖拽落点：把清单 / 分组放到 anchor 的上/下，父级跟随 anchor */
  const handleReorderList = async (id: number, anchorId: number, below: boolean): Promise<void> => {
    const n = await window.zhixing.db.reorderListFolder(id, anchorId, below)
    await reloadFolders()
    if (n === 0) onNotice('不能把分组拖进它自己的子级里')
  }

  /**
   * 重命名当前筛选到的清单。
   *
   * 与删除**彻底分开**。此前这两件事共用一个函数：改名分支不成立时（没改名，或者用户点了
   * 取消 —— prompt 此时 resolve(null)）就直接往下走到 dialog.confirm「删除清单？」。
   * 实测后果：在「清单设置」里取消一次，就会弹出一次删除确认，连击两下即误删清单。
   */
  const renameCurrentList = async (): Promise<void> => {
    const cur = folders.find((f) => f.id === Number(listKey))
    if (cur) await renameList(cur)
  }

  /** 删除当前筛选到的清单：独立入口，不会因为「名字没变」而被顺带走到。 */
  const deleteCurrentList = async (): Promise<void> => {
    const cur = folders.find((f) => f.id === Number(listKey))
    if (cur) await deleteList(cur)
  }
  /** 移动到清单：收件箱 = null；复用 moveTaskToList。 */
  const handleMoveToList = async (ids: number[], listId: number | null): Promise<void> => {
    await window.zhixing.db.batchMove(ids, listId)
    setMoveMenu(null)
    onNotice(ids.length > 1 ? `已移动 ${ids.length} 项` : '已移动 1 项')
    setSelectedIds(new Set())
    await refresh()
  }

  /** 暂停为等待中；恢复日期由编辑器「恢复于」写入。 */
  const handlePause = async (id: number): Promise<void> => {
    await window.zhixing.db.pauseTask(id, null)
    await refresh()
  }

  /** 从等待中恢复为待办。 */
  const handleResume = async (id: number): Promise<void> => {
    await window.zhixing.db.resumeTask(id)
    await refresh()
  }

  /** 「挂到任务下」：用 task_candidates 选父任务后改挂。 */
  const handleReparentTo = async (id: number, parentId: number): Promise<void> => {
    setParentPicker(null)
    await window.zhixing.db.reparentTask(id, parentId)
    await refresh()
  }

  /** 标签增删：点击行内 chip 弹出，勾选即切换（覆盖式写回）。 */
  const handleToggleTag = async (taskId: number, tagName: string): Promise<void> => {
    const current = (tags.get(taskId) ?? []).map((t) => t.name)
    const next = current.includes(tagName)
      ? current.filter((n) => n !== tagName)
      : [...current, tagName]
    await window.zhixing.db.setTaskTags(taskId, next)
    await refresh()
  }

  const handleCreateTag = async (taskId: number): Promise<void> => {
    const name = await dialog.prompt({
      title: '新建标签',
      label: '标签名称（可逗号分隔多个）',
    })
    if (!name?.trim()) return
    const added = name
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const current = (tags.get(taskId) ?? []).map((t) => t.name)
    await window.zhixing.db.setTaskTags(taskId, [...current, ...added])
    await refresh()
  }

  /**
   * 改标签颜色。
   *
   * 取色器拖动会连续触发 onChange，所以先乐观更新本地两份状态（行内胶囊与弹层），
   * 再把色值写库；写库后的广播会让其它页面各自对齐，不必在这里手动全量重取。
   */
  const handleSetTagColor = async (tagId: number, color: string): Promise<void> => {
    setAllTags((prev) => prev.map((t) => (t.id === tagId ? { ...t, color } : t)))
    setTags((prev) => {
      const next = new Map<number, Tag[]>()
      for (const [k, list] of prev) {
        next.set(k, list.map((t) => (t.id === tagId ? { ...t, color } : t)))
      }
      return next
    })
    await window.zhixing.db.setTagColor(tagId, color)
  }

  // 键盘快捷键：Space 完成 / F2 编辑 / Ctrl+↑↓ 同级移动 / ←→ 折叠展开
  // （仅在列表视图、且焦点不在输入框内时生效）
  const keyCtx = useRef({ view, selected, toggle: handleToggle, move: handleMoveRelative, refresh })
  keyCtx.current = { view, selected, toggle: handleToggle, move: handleMoveRelative, refresh }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const ctx = keyCtx.current
      if (ctx.view !== 'list' || ctx.selected == null) return
      const id = ctx.selected
      const mod = e.ctrlKey || e.metaKey
      if (e.key === ' ' && !mod) {
        e.preventDefault()
        void ctx.toggle(id)
      } else if (e.key === 'F2') {
        e.preventDefault()
        setEditingId(id)
      } else if (mod && e.key === 'ArrowUp') {
        e.preventDefault()
        void ctx.move(id, -1)
      } else if (mod && e.key === 'ArrowDown') {
        e.preventDefault()
        void ctx.move(id, 1)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setCollapsed((prev) => new Set(prev).add(id))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setCollapsed((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const handleQuadrant = async (id: number, key: QuadrantKey): Promise<void> => {
    const today = new Date().toLocaleDateString('sv-SE')
    await window.zhixing.db.updateTask(id, quadrantAssignment(key, today))
    await refresh()
  }

  const handleReschedule = async (id: number, day: string): Promise<void> => {
    await window.zhixing.db.setDueDate(id, day)
    await refresh()
  }

  const handleStatus = async (id: number, status: TaskStatus): Promise<void> => {
    await window.zhixing.db.setStatus(id, status)
    await refresh()
  }

  /** 看板各列的「+ 添加」：建一个待办任务后立刻把它挪到该列。 */
  const handleKanbanAdd = async (status: TaskStatus): Promise<void> => {
    const created = await window.zhixing.db.createTask('新任务', null, null)
    if (!created) return
    if (status !== 'todo') await window.zhixing.db.setStatus(created.id, status)
    setEditingId(created.id)
    await refresh()
  }

  const commitAdd = async (): Promise<void> => {
    const title = draftTitle.trim()
    const parentId = adding?.parentId ?? null
    setAdding(null)
    setDraftTitle('')
    if (!title) return
    // 子任务：走 create_task（继承父任务的 list_id）；
    // 顶层：走 quick_create 并传当前清单，
    // 未命中 @列表 时回退到该清单而不是新建。
    // 「已完成 / 已放弃」是终态视图，不是真实清单：在这里新建的任务落回收件箱，
    // 而不是把 '__done' 塞进 Number() —— 那会得到 NaN 并一路传进 list_id。
    // 分组也不装任务：选中分组时新建的任务落回收件箱，而不是挂到一个不是清单的节点上
    const realList =
      listKey === '' ||
      listKey === 'none' ||
      listKey === DONE_KEY ||
      listKey === ABANDONED_KEY ||
      folderScopeIds !== null
        ? null
        : Number(listKey)
    const currentList = realList !== null && Number.isFinite(realList) ? realList : null
    const created =
      parentId !== null
        ? await window.zhixing.db.createTask(title, parentId, null)
        : await window.zhixing.db.quickAdd(title, currentList)
    if (created) setSelected(created.id)
    await refresh()
  }

  /** 单行渲染：虚拟列表逐行调用，递归渲染也复用它。 */
  const renderRow = (node: TaskNode, depth: number): React.ReactNode => (
    <>
      <TaskRow
          node={node}
          depth={depth}
          // 终态视图是跨清单的：每行标出它原来属于哪个清单，否则「收归」之后就没了去向
          listName={
            listKey === DONE_KEY || listKey === ABANDONED_KEY
              ? node.list_id != null
                ? listNameById.get(node.list_id) ?? '未知清单'
                : '收件箱'
              : undefined
          }
          // 「已完成」视图里状态胶囊改按「有效完成」显示：收归进来的行必然是有效完成，
          // 若这里还读自身 status，就会出现「已完成清单里写着待办」
          doneView={listKey === DONE_KEY || focus === 'done'}
          selected={selectedIds.has(node.id)}
          collapsed={collapsed.has(node.id)}
          onToggle={handleToggle}
          onToggleCollapse={(id) =>
            setCollapsed((prev) => {
              const next = new Set(prev)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })
          }
          onSelect={handleSelect}
          onOpenPriority={(id, anchor) => setMenu({ id, anchor })}
          onOpenStatus={(id, anchor) => setStatusMenu({ id, anchor })}
          onDragStart={(id) => setDragId(id)}
          onDragOverRow={(id, pos) =>
            setDropHint((prev) => (prev?.id === id && prev.pos === pos ? prev : { id, pos }))
          }
          onDropRow={(id, pos) => void handleDropRow(id, pos)}
          onDragEnd={() => {
            setDragId(null)
            setDropHint(null)
          }}
          dropHint={dropHint?.id === node.id ? dropHint.pos : null}
          onOpenTags={(id, anchor) => {
            const r = anchor.getBoundingClientRect()
            setTagMenu({ id, x: r.left, y: r.bottom + 4 })
          }}
          onContextMenu={(id, x, y) => setCtxMenu({ id, x, y })}
          onTitleCommit={handleTitle}
          onFocus={(id, title) =>
            window.dispatchEvent(
              new CustomEvent('zhixing:pomodoro', { detail: { taskId: id, title } })
            )
          }
          onAddSubtask={(id) => setAdding({ parentId: id })}
          onEdit={setEditingId}
          onDelete={handleDelete}
        />
    </>
  )

  const renderNodes = (nodes: TaskNode[], depth = 0): React.ReactNode =>
    nodes.map((node) => (
      <div key={node.id}>
        {renderRow(node, depth)}
        {!collapsed.has(node.id) && renderNodes(node.children, depth + 1)}
      </div>
    ))

  const renderAddRow = (depth: number): React.ReactNode => (
    <div className="trow trow--adding" style={{ paddingLeft: 12 + depth * 20 }} key="add">
      <span className="trow__caret trow__caret--empty" />
      <span className="check" aria-hidden />
      <input
        ref={addRef}
        className="trow__input"
        placeholder={
          adding?.parentId === null ? '新任务标题，回车创建，Esc 取消' : '新子任务标题，回车创建，Esc 取消'
        }
        value={draftTitle}
        onChange={(e) => setDraftTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commitAdd()
          if (e.key === 'Escape') {
            setAdding(null)
            setDraftTitle('')
          }
        }}
        onBlur={() => {
          if (!draftTitle.trim()) setAdding(null)
        }}
      />
    </div>
  )

  return (
    <div className="page page--tasks">
      <div className="page__body">

      <Toolbar
        title={t('page.tasks')}
        subtitle={t('page.tasks.sub')}
        nav={(
          <div className="seg" role="group" aria-label="视图切换">
            {VIEWS.map((v) => (
              <Fragment key={v.key}>
                <button aria-pressed={view === v.key} onClick={() => setView(v.key)}>
                  {v.label}
                </button>
                {/* 清单树只在列表视图下出现，收放按钮就挨着「列表」这两个字 */}
                {v.key === 'list' && view === 'list' ? (
                  <button
                    className="seg__panel"
                    aria-pressed={!treeHidden}
                    aria-label={treeHidden ? '展开清单树' : '收起清单树'}
                    title={treeHidden ? '展开清单树' : '收起清单树'}
                    onClick={() => setTreeHidden((prev) => !prev)}
                  >
                    <Morph
                      icon={treeHidden ? IconData.PanelLeftOpen : IconData.PanelLeftClose}
                      size={14}
                    />
                  </button>
                ) : null}
              </Fragment>
            ))}
          </div>
        )}
        meta={(
          <span className="u-aux">
            共 {tree.length} 项
            {listKey === DONE_KEY ? ' · 已完成' : ''}
            {listKey === ABANDONED_KEY ? ' · 已放弃' : ''}
            {activeQuery ? ` · 智能清单「${activeQuery.name}」` : ''}
            {focus ? ` · 聚焦「${focus === 'today' ? '今日待办' : focus === 'done' ? '已完成' : '已逾期'}」` : ''}
          </span>
        )}
        search={(
          <input
            className="field field--compact"
            placeholder="过滤当前视图…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="过滤任务"
          />
        )}
        filters={[
          <select
            key="list"
            className="field field--compact"
            value={listKey}
            onChange={(e) => setListKey(e.target.value)}
            aria-label="按清单筛选"
          >
            <option value="">全部清单</option>
            <option value="none">收件箱（未归属）</option>
            <option value={DONE_KEY}>已完成</option>
            <option value={ABANDONED_KEY}>已放弃</option>
            {/* 顶层清单直挂；分组下的清单用 optgroup 归类，否则层级在下拉里完全看不出来 */}
            {folders
              .filter((f) => f.kind === 'list' && (f.parent_id ?? null) === null)
              .map((f) => (
                <option key={f.id} value={String(f.id)}>
                  {f.name}
                </option>
              ))}
            {folders
              .filter((f) => f.kind === 'group')
              .map((g) => {
                const kids = folders.filter((f) => f.kind === 'list' && f.parent_id === g.id)
                if (kids.length === 0) return null
                return (
                  <optgroup key={`group-${g.id}`} label={g.name}>
                    {kids.map((f) => (
                      <option key={f.id} value={String(f.id)}>
                        {f.name}
                      </option>
                    ))}
                  </optgroup>
                )
              })}
          </select>,
          <button key="newlist" className="text-btn" title="新建清单" onClick={() => void newList()}>
            ＋ 清单
          </button>,
          <button
            key="editlist"
            className="text-btn"
            title="重命名 / 删除当前选中的清单"
            disabled={
              !listKey ||
              listKey === 'none' ||
              listKey === DONE_KEY ||
              listKey === ABANDONED_KEY
            }
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setListMenu({ x: r.left, y: r.bottom + 4 })
            }}
          >
            清单设置
          </button>,
          <select
            key="smart"
            className="field field--compact"
            value={activeQueryId === null ? '' : String(activeQueryId)}
            onChange={(e) => (e.target.value ? pickQuery(Number(e.target.value)) : setActiveQueryId(null))}
            aria-label="智能清单"
            title="智能清单：把「我要看什么」固化成一条表达式"
          >
            <option value="">智能清单…</option>
            {savedQueries.map((q) => (
              <option key={q.id} value={String(q.id)}>
                {q.name}
              </option>
            ))}
          </select>,
        ]}
        secondary={[
          <button
            key="savesmart"
            className="text-btn"
            title="把当前筛选保存成智能清单。表达式支持 text:关键词 / tag:标签 / list:清单 / !done / priority>=3 / due<=today / due=overdue / due=none"
            onClick={() => void saveAsSmartList()}
          >
            存为智能清单
          </button>,
          <button
            key="newlist"
            className="text-btn"
            onClick={async () => {
              const name = await dialog.prompt({ title: '新建清单', label: '清单名称' })
              if (!name?.trim()) return
              await window.zhixing.db.createListFolder(name.trim(), 'list', null)
              await load()
              onNotice(`已新建清单「${name.trim()}」`)
            }}
          >
            新建清单
          </button>,
          <button
            key="batch"
            className="text-btn"
            disabled={selectedIds.size === 0}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setBatchMenu({ x: r.left, y: r.bottom + 4 })
            }}
          >
            批量{selectedIds.size > 0 ? ` · ${selectedIds.size}` : ''}
          </button>,
          <button key="insp" className="text-btn" aria-pressed={inspector} onClick={() => setInspector((v) => !v)}>
            速览
          </button>,
          ...(focus && onClearFocus
            ? [
                <button key="clear" className="text-btn" onClick={onClearFocus}>
                  清除聚焦
                </button>,
              ]
            : []),
        ]}
        primary={(
          <button
            className="text-btn text-btn--accent"
            onClick={() => {
              setAdding({ parentId: null })
              setDraftTitle('')
            }}
          >
            <Plus size={14} /> 新建任务
          </button>
        )}
      />

      <div className="tasks-work">
        {/* 清单栏：分组、各清单的未完成计数，以及两个终态入口都在这里。
            只在**列表视图**出现 —— 四象限 / 日历 / 看板都不按清单组织；
            收起时整块不渲染（而不是藏起来）：藏起来的行仍会被查询与自动化脚本
            当成「看得见」。收放按钮在工具栏「列表」旁边。 */}
        {view === 'list' && !treeHidden ? (
          <TaskLists
            folders={folders}
            activeKey={listKey}
            counts={listCounts}
            onPick={pickList}
            onNewList={(parentId) => void newList(parentId)}
            onNewGroup={(parentId) => void newGroup(parentId)}
            onRename={(f) => void renameList(f)}
            onDelete={(f) => void deleteList(f)}
            onMove={(id, parentId) => void moveList(id, parentId)}
            onReorder={(id, anchorId, below) => void handleReorderList(id, anchorId, below)}
            queries={savedQueries}
            activeQueryId={activeQueryId}
            onPickQuery={pickQuery}
            onNewQuery={() => void saveAsSmartList()}
            onRenameQuery={(q) => void renameQuery(q)}
            onDeleteQuery={(q) => void deleteQuery(q)}
          />
        ) : null}
        <div className="tasks-main">
          {view === 'quadrant' ? (
            <QuadrantBoard
              tasks={listScopedTasks}
              effective={effective}
              expanded={expanded}
              onToggle={handleToggle}
              onOpen={setEditingId}
              onToggleSubtree={(id) =>
                setExpanded((prev) => {
                  const next = new Set(prev)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
              onChangeQuadrant={(id, key: QuadrantKey) => void handleQuadrant(id, key)}
            />
          ) : view === 'calendar' ? (
            <CalendarBoard
              tasks={listScopedTasks}
              effective={effective}
              onOpen={setEditingId}
              onToggle={handleToggle}
              onReschedule={(id, day) => void handleReschedule(id, day)}
              showDone={showDone}
            />
          ) : view === 'kanban' ? (
            <KanbanBoard
              tasks={listScopedTasks}
              effective={effective}
              expanded={expanded}
              onOpen={setEditingId}
              onToggleSubtree={(id) =>
                setExpanded((prev) => {
                  const next = new Set(prev)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
              onDropStatus={(id, status) => void handleStatus(id, status)}
              onAdd={(status) => void handleKanbanAdd(status)}
            />
          ) : visible.length === 0 && !adding ? (
            <p className="empty-hint">还没有任务，点右上角「+ 新建任务」快速添加。</p>
          ) : (
            <VirtualList
              className="task-vlist"
              count={flatRows.length}
              rowHeight={rowH}
              renderRow={(i) => {
                const row = flatRows[i]
                if (!row) return null
                return row.node === null ? renderAddRow(row.depth) : renderRow(row.node, row.depth)
              }}
            />
          )}
        </div>

        {inspector && (
          <aside className="inspector" aria-label="任务速览">
            {selectedNode ? (
              <>
                <section className="inspector__card">
                  <header className="inspector__head">任务速览 · #{selectedNode.id}</header>
                  <dl className="kv">
                    <dt>标题</dt>
                    <dd>{selectedNode.title}</dd>
                    <dt>状态</dt>
                    <dd>{STATUS_LABELS[selectedNode.status]}</dd>
                    <dt>优先级</dt>
                    <dd>{priorityLabel(selectedNode.priority)}</dd>
                    <dt>截止</dt>
                    <dd>{dueLabel(selectedNode.due_date).text || '—'}</dd>
                    {selectedNode.status === 'waiting' && (
                      <>
                        <dt>等待至</dt>
                        <dd>{(selectedNode as Task & { resume_at?: string }).resume_at ?? '—'}</dd>
                      </>
                    )}
                  </dl>
                </section>
                <section className="inspector__card">
                  <header className="inspector__head">标签</header>
                  {selectedNode.tags.length ? (
                    <div className="chip-row">
                      {selectedNode.tags.map((t) => (
                        <span key={t.id} className="chip chip--tag" style={{ color: t.color, borderColor: t.color }}>
                          {t.name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="u-aux">无标签</p>
                  )}
                </section>
                {/* 工作流速览卡片 —— 该任务启动/关联的实例 + 「启动工作流…」入口 */}
                <section className="inspector__card">
                  <header className="inspector__head">工作流</header>
                  {wfInstances.length ? (
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                      {wfInstances.map((inst) => (
                        <li key={inst.id} className="u-aux">
                          {inst.title} · {wfStatusLabel(inst.status)} ·{' '}
                          {inst.steps.filter((s) => s.done).length}/{inst.steps.length} 步
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="u-aux">暂无关联的工作流</p>
                  )}
                  <button
                    className="text-btn text-btn--accent"
                    disabled={wfTemplates.length === 0}
                    onClick={(e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setWfMenu({ x: r.left, y: r.bottom + 4 })
                    }}
                  >
                    启动工作流…
                  </button>
                </section>
              </>
            ) : (
              <p className="u-aux">选中一个任务查看速览。</p>
            )}
          </aside>
        )}
      </div>

      {editingId != null &&
        (() => {
          const task = tasks.find((t) => t.id === editingId)
          if (!task) return null
          return (
            <TaskEditor
              task={task}
              onSave={async (id, fields) => {
                await window.zhixing.db.updateTask(id, fields)
                await refresh()
              }}
              onDelete={async (id) => {
                setEditingId(null)
                await handleDelete(id)
              }}
              onClose={() => setEditingId(null)}
            />
          )
        })()}

      {/* 清单设置：改名与删除分成两个菜单项 —— 一个入口承担两种不可逆语义正是之前的缺陷 */}
      {listMenu && (
        <PopMenu
          x={listMenu.x}
          y={listMenu.y}
          onClose={() => setListMenu(null)}
          items={[
            {
              key: 'rename',
              label: curFolderKind === 'group' ? '重命名分组' : '重命名清单',
              onPick: () => void renameCurrentList(),
            },
            {
              key: 'delete',
              label: curFolderKind === 'group' ? '删除分组' : '删除清单',
              danger: true,
              onPick: () => void deleteCurrentList(),
            },
          ]}
        />
      )}

      {batchMenu && (
        <PopMenu
          x={batchMenu.x}
          y={batchMenu.y}
          onClose={() => setBatchMenu(null)}
          items={[
            { key: 'done', label: '批量完成', onPick: () => void runBatch('complete') },
            { key: 'due', label: '截止设为今天', onPick: () => void runBatch('due') },
            { key: 'cleardue', label: '清除截止日期', onPick: () => void runBatch('clearDue') },
            {
              key: 'move',
              label: '移动到清单…',
              onPick: () => setMoveMenu({ x: batchMenu.x, y: batchMenu.y, ids: [...selectedIds] }),
            },
            { key: 'del', label: '批量删除', danger: true, onPick: () => void runBatch('delete') },
          ]}
        />
      )}

      {tagMenu && (
        <TagMenu
          x={tagMenu.x}
          y={tagMenu.y}
          title="任务标签"
          tags={allTags}
          selectedIds={(tags.get(tagMenu.id) ?? []).map((t) => t.id)}
          onToggle={(t) => void handleToggleTag(tagMenu.id, t.name)}
          onCreate={() => void handleCreateTag(tagMenu.id)}
          onColor={(id, color) => void handleSetTagColor(id, color)}
          onClose={() => setTagMenu(null)}
        />
      )}

      {ctxMenu && (
        <PopMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={
            [
              { key: 'toggle', label: '完成 / 取消完成', onPick: () => void handleToggle(ctxMenu.id) },
              { key: 'edit', label: '编辑…', onPick: () => setEditingId(ctxMenu.id) },
              { key: 'sub', label: '加子任务', onPick: () => setAdding({ parentId: ctxMenu.id }) },
              {
                key: 'move',
                label: '移动到清单…',
                onPick: () => setMoveMenu({ x: ctxMenu.x, y: ctxMenu.y, ids: [ctxMenu.id] }),
              },
              {
                key: 'parent',
                label: '挂到任务下…',
                onPick: () => {
                  setPickerQ('')
                  setParentPicker({ id: ctxMenu.id, x: ctxMenu.x, y: ctxMenu.y })
                },
              },
              { key: 'pause', label: '暂停（等待中）', onPick: () => void handlePause(ctxMenu.id) },
              { key: 'resume', label: '恢复为待办', onPick: () => void handleResume(ctxMenu.id) },
              { key: 'up', label: '上移一级', onPick: () => void handleMoveRelative(ctxMenu.id, -1) },
              { key: 'down', label: '下移一级', onPick: () => void handleMoveRelative(ctxMenu.id, 1) },
              {
                key: 'tag',
                label: '编辑标签…',
                onPick: () => setTagMenu({ id: ctxMenu.id, x: ctxMenu.x, y: ctxMenu.y }),
              },
              { key: 'del', label: '删除', danger: true, onPick: () => void handleDelete(ctxMenu.id) },
            ] satisfies PopMenuItem[]
          }
        />
      )}

      {wfMenu && (
        <PopMenu
          x={wfMenu.x}
          y={wfMenu.y}
          onClose={() => setWfMenu(null)}
          items={wfTemplates.map((tpl) => ({
            key: `wf-${tpl.id}`,
            label: tpl.name,
            onPick: () => void handleStartWorkflow(tpl.id),
          }))}
        />
      )}

      {moveMenu && (
        <PopMenu
          x={moveMenu.x}
          y={moveMenu.y}
          onClose={() => setMoveMenu(null)}
          items={[
            {
              key: 'inbox',
              label: '收件箱（未归属）',
              onPick: () => void handleMoveToList(moveMenu.ids, null),
            },
            ...folders
              .filter((f) => f.kind === 'list')
              .map((f) => ({
                key: `list-${f.id}`,
                label: f.name,
                onPick: () => void handleMoveToList(moveMenu.ids, f.id),
              })),
          ]}
        />
      )}

      {parentPicker && (
        <div
          className="popmenu"
          role="dialog"
          aria-label="选择父任务"
          style={{
            position: 'fixed',
            left: Math.max(8, Math.min(parentPicker.x, window.innerWidth - 260)),
            top: parentPicker.y,
          }}
        >
          <input
            className="field field--compact"
            autoFocus
            placeholder="搜索任务标题…"
            value={pickerQ}
            onChange={(e) => setPickerQ(e.target.value)}
          />
          <ul
            style={{
              listStyle: 'none',
              margin: '4px 0 0',
              padding: 0,
              maxHeight: 240,
              overflow: 'auto',
            }}
          >
            {pickerItems.length === 0 && <li className="u-aux">没有候选任务</li>}
            {pickerItems.map((t) => (
              <li key={t.id}>
                <button
                  className="popmenu__item"
                  onClick={() => void handleReparentTo(parentPicker.id, t.id)}
                >
                  {t.title}
                </button>
              </li>
            ))}
          </ul>
          <button className="popmenu__item" onClick={() => setParentPicker(null)}>
            取消
          </button>
        </div>
      )}

      {statusMenu && (
        <StatusMenu
          anchor={statusMenu.anchor}
          current={tasks.find((t) => t.id === statusMenu.id)?.status ?? 'todo'}
          onPick={(s) => {
            void handleStatus(statusMenu.id, s)
            setStatusMenu(null)
          }}
          onClose={() => setStatusMenu(null)}
        />
      )}

      {menu && (
        <PriorityMenu anchor={menu.anchor} current={tasks.find((t) => t.id === menu.id)?.priority ?? 0} onPick={handlePriority} onClose={() => setMenu(null)} />
      )}
      </div>
    </div>
  )
}
