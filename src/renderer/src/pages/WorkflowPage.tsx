import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  WorkflowCanvasG6,
  type WorkflowCanvasHandle,
  type WorkflowCanvasNode,
} from '../components/WorkflowCanvasG6'
import { NODE_W, NODE_H } from '../lib/workflow-node-box'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  Diamond,
  FilePlus2,
  FolderPlus,
  GitBranch,
  History,
  IconData,
  LayoutGrid,
  Maximize2,
  Morph,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Square,
  Timer,
  Trash2,
} from '@renderer/lib/icons'
import type {
  Note,
  WorkflowInstancePayload,
  WorkflowNodePayload,
  WorkflowRunLogEntry,
  WorkflowTemplatePayload,
  WorkflowTemplateSummary,
} from '@shared/types'
import { useCollapsedSet } from '@renderer/lib/use-collapsed'
import { subscribeDomain } from '@shared/events'
import { CONDITION_KIND, describeCondition, serializeCondition } from '@shared/workflow-condition'
import {
  TASK_KIND,
  actionKindLabel,
} from '@shared/workflow-action'
import {
  branchTarget,
  withBranchTarget,
  type BranchSlot,
} from '@shared/workflow-branch'
import { Select } from '../components/Select'
import { Toolbar } from '../components/Toolbar'
import { WorkflowStepDialog } from '../components/WorkflowStepDialog'
import { WorkflowScheduleDialog } from '../components/WorkflowScheduleDialog'
import { WorkflowRunDialog } from '../components/WorkflowRunDialog'
import { WorkflowConditionDialog } from '../components/WorkflowConditionDialog'
import { useDialog } from '../components/Dialogs'
import {
  layoutBounds,
  layoutWorkflow,
  type WorkflowRankDir,
} from '../lib/workflow-layout'
import { quietFailure } from '@shared/quiet-failure'

interface Props {
  onNotice: (message: string) => void
  onChanged: () => Promise<void>
}
/** 画布基准坐标系（viewBox 与 panzoom 共用同一套尺寸）。 */
const CANVAS_W = 900
const CANVAS_H = 520
/** 节点详情浮卡尺寸（条件节点要多写一行「两条分支通向哪」，比普通步骤高一些） */
const CARD_W = 236
const CARD_H = 196
/** 步骤编辑弹窗里「SOP 文档」下拉最多列出的笔记数 */
const NOTE_CHOICE_LIMIT = 200
/** 模板树侧栏宽度：可拖拽调节，边界保证两边都还能用 */
const SIDE_DEFAULT = 220
const SIDE_MIN = 170
const SIDE_MAX = 460
/** 键盘调节侧栏宽度时的步长（← → 各一格） */
const SIDE_KEY_STEP = 16


/**
 * 画布初始坐标：用户拖过的位置（pos_x/pos_y）优先，没拖过的用 dagre 分层结果补齐。
 * 早先这里是「60 + i * 190、上下交替」的手工排布 —— 步骤一多就横竖重叠；
 * 现在交给分层布局，同层间距、层间距、是否绕开分支都由 dagre 算。
 */
function layoutOf(
  nodes: WorkflowNodePayload[],
  rankdir: WorkflowRankDir
): Map<number, { x: number; y: number }> {
  const computed = layoutWorkflow(nodes, { rankdir, nodeWidth: NODE_W, nodeHeight: NODE_H })
  const map = new Map<number, { x: number; y: number }>()
  for (const n of nodes) {
    const c = computed.get(n.id)
    map.set(n.id, { x: n.pos_x ?? c?.x ?? 60, y: n.pos_y ?? c?.y ?? 120 })
  }
  return map
}

/**
 * 画布基准尺寸：节点包围盒之外还要给右侧的详情浮卡留出空间。
 *
 * 少留这一块会出很隐蔽的问题 —— 浮卡「右边放不下就往左翻」的判断用的是画布基准，
 * 基准比「节点 + 浮卡」还小时它会误判成放不下，于是把浮卡塞到左上角、正好压住节点，
 * 两个边框叠在一起，看起来像「预览框有两层边框」。
 */
function canvasBoundsOf(layout: Map<number, { x: number; y: number }>): {
  width: number
  height: number
} {
  const b = layoutBounds(layout, NODE_W, NODE_H)
  return { width: b.width + CARD_W + 20, height: b.height + CARD_H }
}

export function WorkflowPage({ onNotice, onChanged }: Props) {
  const dialog = useDialog()
  const [templates, setTemplates] = useState<WorkflowTemplateSummary[]>([])
  const [current, setCurrent] = useState<WorkflowTemplatePayload | null>(null)
  const [instances, setInstances] = useState<WorkflowInstancePayload[]>([])
  /** 展开着执行详情的实例 id（同时只开一个：侧栏宽度有限，开多个会互相挤） */
  const [runLogFor, setRunLogFor] = useState<number | null>(null)
  /** 「计划与触发」弹窗 */
  const [scheduleOpen, setScheduleOpen] = useState(false)
  /**
   * 外部触发端点监听的端口。主进程 listen(0) 之后写进 settings，
   * 这里读出来才能把完整调用地址显示给用户 —— 否则弹窗里只有一个 <端口> 占位符。
   */
  const [triggerPort, setTriggerPort] = useState('')
  useEffect(() => {
    void (async () => {
      try {
        const s = await window.zhixing.db.settings()
        setTriggerPort(s.workflow_trigger_port ?? '')
      } catch (err) {
        // 读不到就退化成占位符，不影响其它功能
        console.error('[workflow] 读取触发端口失败', err)
      }
    })()
  }, [])
  /**
   * 任务状态触发的候选：**还没结束**的任务才列出来。
   * 已经完成/已放弃的任务不会再变状态，把它们放进下拉只会让人选到一个永远不会触发的项。
   */
  const [taskChoices, setTaskChoices] = useState<{ id: number; title: string; status: string }[]>([])
  const [runLog, setRunLog] = useState<WorkflowRunLogEntry[]>([])

  /**
   * 打开某个实例的执行记录弹窗。
   * 每次打开都重新拉一次 —— 实例可能正在跑，缓存的日志会立刻过时。
   *
   * 查询本身是 **id 正序**（后端 ORDER BY id ASC），弹窗按时间顺序读，
   * 这里**不要再反转** —— 上一版我多写了一次 reverse，结果第一步显示在最后一步后面。
   */
  const openRunLog = async (id: number): Promise<void> => {
    setRunLogFor(id)
    setRunLog(await window.zhixing.db.workflowRunLog(id))
  }
  const [selected, setSelected] = useState<number | null>(null)
  /**
   * 待定的分支出边：点了某个端口、还没点目标节点。
   *
   * 旧实现是从端口**拖**到目标节点（拖拽期间画一条跟指针的虚线）。G6 的 HTML 节点
   * 命中区域限于节点盒，而端口画在盒的边界上、标签还溢到盒外 —— 拖拽的起手点做不了。
   * 所以改成两段式点选：**点端口 → 点目标节点**，与图谱的点选式连线同一套语言。
   */
  const [pendingBranch, setPendingBranch] = useState<{ fromId: number; slot: 'true' | 'false' } | null>(
    null
  )
  /**
   * 布局方向（TB 纵向 / LR 横向）。记住选择，重开页面仍是上次那个方向；
   * 它同时决定 dagre 的分层方向与连线的出入边（见 edgeAnchors）。
   */
  const [rankdir, setRankdir] = useState<WorkflowRankDir>(() => {
    try {
      return localStorage.getItem('wf.rankdir') === 'LR' ? 'LR' : 'TB'
    } catch {
      return 'TB'
    }
  })
  /**
   * 画布基准尺寸：随布局结果伸缩。
   * 必须是独立 state 而不是从 pos 现算 —— pos 在拖拽时会逐帧变化，基准一变
   * usePanZoom 就会 fitView，视图会在拖拽过程中不停跳。
   */
  /**
   * 模板 / 实例侧栏宽度：拖动中间的分隔条改，值记在 localStorage 里，
   * 下次打开页面还是你调过的宽度。
   */
  const [sideWidth, setSideWidth] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem('wf.sideWidth'))
      return Number.isFinite(v) && v >= SIDE_MIN && v <= SIDE_MAX ? v : SIDE_DEFAULT
    } catch {
      return SIDE_DEFAULT
    }
  })
  /** 正在拖侧栏分隔条：只用来加样式（拖动期间禁止选中文本） */
  const [sideResizing, setSideResizing] = useState(false)
  /**
   * 模板树整栏是否收起。与「拖动调宽度」是两件事：收起时连分隔条一起不渲染，
   * 宽度全给画布。纯界面偏好，和 sideWidth 一样存 localStorage。
   */
  const [treeHidden, setTreeHidden] = useState(() => localStorage.getItem('zhixing.tree.workflow') === '1')
  useEffect(() => {
    localStorage.setItem('zhixing.tree.workflow', treeHidden ? '1' : '0')
  }, [treeHidden])
  /** 拖动分隔条的过程状态；width 记住最近一次的宽度，松手时按它落盘 */
  const sideDragRef = useRef<{ startX: number; startW: number; width: number } | null>(null)
  /** 键盘调节时读最新宽度：事件闭包里的 state 可能还是上一帧的值 */
  const sideWidthRef = useRef(sideWidth)
  sideWidthRef.current = sideWidth
  const [canvasSize, setCanvasSize] = useState({ width: CANVAS_W, height: CANVAS_H })
  const [editing, setEditing] = useState<WorkflowNodePayload | null>(null)
  /** editing 是否为「新增步骤」（决定保存时插到选中节点之后，而不是原位替换） */
  const [editingNew, setEditingNew] = useState(false)
  /** 新增步骤时是否设为选中节点的条件分支 */
  /** 正在编辑的是条件节点还是普通步骤 —— 渲染哪个编辑弹窗由它决定 */
  const editingIsCondition = editing?.action_kind === CONDITION_KIND
  /** 步骤可绑定的 SOP 笔记 */
  const [noteChoices, setNoteChoices] = useState<Note[]>([])
  /**
   * 正在拖动节点。拖动期间不渲染详情浮卡 —— 浮卡画在 foreignObject 里，
   * 节点移动时它的坐标更新了但不会重绘，会在原地留下一张「拖影」。
   */
  // 画布视图（平移 / 缩放）。startDrag 定义在 hook 之前，用这个 ref 桥接。

  /** 模板分类 */
  type WfGroup = Awaited<ReturnType<typeof window.zhixing.db.workflowGroups>>[number]
  const [groups, setGroups] = useState<WfGroup[]>([])
  const [templateGroups, setTemplateGroups] = useState<{ id: number; group_id: number | null }[]>([])
  /**
   * 分类的收起状态，持久化在 localStorage：切模板、切页、重启应用后都保持原样。
   * 与笔记树 / 任务清单树共用 lib/use-collapsed.ts 的同一套行为。
   */
  const { collapsed: collapsedGroups, toggle: toggleGroupRaw } = useCollapsedSet('zhixing.tree.collapsed.wf-groups')

  const loadGroups = useCallback(async (): Promise<void> => {
    const [gs, links] = await Promise.all([
      window.zhixing.db.workflowGroups(),
      window.zhixing.db.workflowTemplateGroups(),
    ])
    setGroups(gs)
    setTemplateGroups(links)
  }, [])

  const loadTemplates = useCallback(async () => {
    const rows = await window.zhixing.db.workflowTemplates()
    setTemplates(rows)
    await loadGroups()
    return rows
  }, [loadGroups])

  const loadInstances = useCallback(async () => {
    setInstances(await window.zhixing.db.workflowInstances())
  }, [])

  /**
   * rankdir 只用于「打开模板时按当前方向排一次」。
   *
   * 放进 openTemplate 的依赖会连带出问题：下面的初始化 effect 依赖 openTemplate，
   * 于是**切换方向就会重跑初始化**，把用户正在看的模板换成列表里的第一个。
   * 而方向按钮本身已经调 `handleAutoLayout(nextDir)` 重排，并不需要这条依赖。
   * 所以用 ref 读它、依赖数组里去掉 —— 初始化 effect 从此只跑一次。
   */
  const rankdirRef = useRef<WorkflowRankDir>(rankdir)
  useEffect(() => {
    rankdirRef.current = rankdir
  }, [rankdir])

  const openTemplate = useCallback(async (id: number) => {
    const tpl = await window.zhixing.db.workflowTemplate(id)
    setCurrent(tpl)
    const layout = tpl ? layoutOf(tpl.nodes, rankdirRef.current) : new Map()
    setCanvasSize(canvasBoundsOf(layout))
    setSelected(null)
  }, [])

  useEffect(() => {
    void (async () => {
      const rows = await loadTemplates()
      if (rows.length) await openTemplate(rows[0].id)
      await loadInstances()
    })()
  }, [loadTemplates, openTemplate, loadInstances])

  // SOP 文档候选：近期笔记，最多 200 条
  useEffect(() => {
    void (async () => {
      try {
        setNoteChoices(await window.zhixing.db.recentNotes(NOTE_CHOICE_LIMIT))
      } catch (e) {
        // SOP 文档候选会变空，看起来像「一篇笔记都没有」
        quietFailure('读取笔记候选（SOP 文档）', e)
        setNoteChoices([])
      }
    })()
  }, [])

  // 任务完成会推进所属实例（主进程广播 'workflow' 域），这里跟着刷新实例进度
  useEffect(() => subscribeDomain(['workflow', 'task'], () => void loadInstances()), [loadInstances])

  const refresh = useCallback(async () => {
    await loadTemplates()
    if (current) await openTemplate(current.id)
    await loadInstances()
    // 任务候选跟着刷新：勾完一条任务再回来，它不该还留在"可触发"的列表里
    try {
      const list = await window.zhixing.db.tasks(200)
      setTaskChoices(
        list
          .filter((t) => t.status !== 'done' && t.status !== 'abandoned')
          .map((t) => ({ id: t.id, title: t.title, status: t.status }))
      )
    } catch (err) {
      // 拿不到任务列表不该影响整页刷新，弹窗里会显示"还没有可选的未完成任务"
      console.error('[workflow] 读取任务候选失败', err)
    }
    await onChanged()
  }, [loadTemplates, openTemplate, loadInstances, current, onChanged])

  const ordered = useMemo(() => {
    if (!current) return []
    return [...current.nodes].sort(
      (a, b) => (a.order_index || 0) - (b.order_index || 0) || a.id - b.id
    )
  }, [current])

  const instance = useMemo(
    () => instances.find((i) => i.template_id === current?.id && i.status === 'running') ?? null,
    [instances, current]
  )

  /**
   * 画布实现开关（**迁移期临时**）：\`?wfg6=1\` 时用 G6 画布，否则走原来的手写 SVG。
   *
   * 两者共用同一份数据与同一套业务规则（分支、拖拽、落库都在本文件），**只是画法不同**。
   * 留开关是为了能在真实页面上对照；确认无回归后连同它和整条旧路径一起删。
   */

  /** G6 画布要的节点（布局字段 + 外观字段）—— 外观那层不塞进 LayoutNode 里。 */
  const g6Nodes: WorkflowCanvasNode[] = useMemo(
    () =>
      ordered.map((n, i) => ({
        id: n.id,
        order_index: n.order_index,
        branch_node_id: n.branch_node_id,
        branch_false_node_id: n.branch_false_node_id,
        view: {
          title: n.title,
          badge:
            n.action_kind === CONDITION_KIND
              ? '条件'
              : '第 ' + (i + 1) + ' 步' + (actionKindLabel(n.action_kind) === '任务' ? '' : ' · ' + actionKindLabel(n.action_kind)),
          isCondition: n.action_kind === CONDITION_KIND,
          condText: n.action_kind === CONDITION_KIND ? describeCondition(n.action_value) : undefined,
          done: instance?.steps.find((s) => s.node_id === n.id)?.done,
          current: instance?.current_node_id === n.id,
        },
      })),
    [ordered, instance]
  )

  /** 画布上被点中的节点（浮卡与「作为某条件的分支」都以它为准）。 */
  const selectedNode = useMemo(
    () => ordered.find((n) => n.id === selected) ?? null,
    [ordered, selected]
  )

  // 画布级平移 / 缩放：拖背景平移、滚轮以光标为中心缩放；非平移时的移动转给节点拖拽
  const wfRef = useRef<WorkflowCanvasHandle>(null)

  // 侧栏分隔条：拖拽改宽度，松手才落 localStorage（避免每帧写）
  const startSideDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    // 不 preventDefault：让分隔条能被点击聚焦（点击后 ← → 可微调），
    // 拖动期间靠 .is-resizing 的 user-select:none 防止选中文本
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // 捕获失败不影响拖动
    }
    sideDragRef.current = { startX: e.clientX, startW: sideWidth, width: sideWidth }
    setSideResizing(true)
  }
  const onSideResizeDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = sideDragRef.current
    if (!d) return
    d.width = Math.min(SIDE_MAX, Math.max(SIDE_MIN, d.startW + (e.clientX - d.startX)))
    setSideWidth(d.width)
  }
  /** 宽度落盘（拖动松手 / 键盘调节都走这里）。 */
  const persistSideWidth = (w: number): void => {
    try {
      localStorage.setItem('wf.sideWidth', String(Math.round(w)))
    } catch {
      // 存不下就只在本次会话里生效
    }
  }
  const endSideDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = sideDragRef.current
    if (!d) return
    sideDragRef.current = null
    setSideResizing(false)
    // 用拖动过程中记下的宽度落盘：down/move/up 若在同一次任务里连发，
    // 闭包里的 sideWidth 还是旧值（React 会把这几次更新合并掉）
    persistSideWidth(d.width)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // 指针已经松开就无所谓
    }
  }
  /** 分隔条可以聚焦，键盘也能调宽窄：←/→ 各一格，Home 回到默认宽度。 */
  const onSideKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const delta = e.key === 'ArrowLeft' ? -SIDE_KEY_STEP : e.key === 'ArrowRight' ? SIDE_KEY_STEP : 0
    if (delta) {
      e.preventDefault()
      const next = Math.min(SIDE_MAX, Math.max(SIDE_MIN, sideWidthRef.current + delta))
      setSideWidth(next)
      persistSideWidth(next)
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      setSideWidth(SIDE_DEFAULT)
      persistSideWidth(SIDE_DEFAULT)
    }
  }

  // 基准尺寸一变（打开模板 / 自动布局 / 切方向）就适配一次视图。
  // 不能直接在 handleAutoLayout 里 fit：那时 setCanvasSize 尚未生效，
  // reset 用的是旧基准，视图会缩在角落（实测横向布局后节点全挤在右上角）。
  useEffect(() => {
    wfRef.current?.fit()
  }, [canvasSize])


  const handleNewTemplate = async (groupId: number | null = null): Promise<void> => {
    const name = await dialog.prompt({ title: '新建工作流', label: '名称' })
    if (!name?.trim()) return
    const res = await window.zhixing.db.saveWorkflowTemplate({
      name: name.trim(),
      description: '',
      start_policy: 'first',
      nodes: [{ title: '第一步', order_index: 0 }],
    })
    if (!res.ok) {
      onNotice(`保存失败：${res.problems.join('；')}`)
      return
    }
    // 分类不写进模板本体（saveWorkflowTemplate 的入参里没有它），建好后再挂上去
    if (groupId !== null && res.templateId) {
      await window.zhixing.db.moveWorkflowTemplate(res.templateId, groupId)
    }
    await loadTemplates()
    if (res.templateId) await openTemplate(res.templateId)
    onNotice(`已创建「${name.trim()}」`)
  }

  const handleNewGroup = async (parentId: number | null): Promise<void> => {
    const name = await dialog.prompt({
      title: parentId === null ? '新建分类' : '新建子分类',
      label: '分类名称',
    })
    if (!name?.trim()) return
    const res = await window.zhixing.db.saveWorkflowGroup({ name: name.trim(), parentId })
    if (!res.ok) {
      onNotice(`新建失败：${res.problems.join('；')}`)
      return
    }
    await loadGroups()
    onNotice(`已创建分类「${name.trim()}」`)
  }

  const handleRenameGroup = async (g: WfGroup): Promise<void> => {
    const name = await dialog.prompt({ title: '重命名分类', label: '分类名称', defaultValue: g.name })
    if (!name?.trim() || name.trim() === g.name) return
    await window.zhixing.db.saveWorkflowGroup({ id: g.id, name: name.trim() })
    await loadGroups()
    onNotice('已重命名分类')
  }

  const handleDeleteGroup = async (g: WfGroup): Promise<void> => {
    const ok = await dialog.confirm({
      title: '删除分类',
      message: `删除分类「${g.name}」？\n子分类会上提一级，里面的工作流回到「未分类」——都不会被删除。`,
      icon: <Trash2 size={15} />,
      danger: true,
      confirmText: '删除',
    })
    if (!ok) return
    await window.zhixing.db.deleteWorkflowGroup(g.id)
    await loadGroups()
    onNotice('已删除分类（工作流已回到未分类）')
  }

  const handleRenameInstance = async (i: { id: number; title: string }): Promise<void> => {
    const name = await dialog.prompt({ title: '重命名实例', label: '实例名称', defaultValue: i.title })
    if (!name?.trim() || name.trim() === i.title) return
    await window.zhixing.db.renameWorkflowInstance(i.id, name.trim())
    await loadInstances()
    onNotice('已重命名实例')
  }

  /** 重复运行：按同一模板再开一个新实例，旧实例记录留着当历史。 */
  const handleRerunInstance = async (i: WorkflowInstancePayload): Promise<void> => {
    const inst = await window.zhixing.db.rerunWorkflowInstance(i.id)
    if (!inst) {
      onNotice('再次运行失败：模板已不存在或没有可运行的步骤')
      return
    }
    onNotice(`已再次运行「${inst.title}」`)
    await refresh()
  }

  /** 删除实例的运行记录：只删这一次运行，模板与已生成的任务都不动。 */
  const handleDeleteInstance = async (i: WorkflowInstancePayload): Promise<void> => {
    const confirmed = await dialog.confirm({
      title: '删除实例',
      message: `删除实例「${i.title}」的运行记录？\n模板不会被删除，已经生成的任务也都会保留。`,
      icon: <Trash2 size={15} />,
      danger: true,
      confirmText: '删除',
    })
    if (!confirmed) return
    await window.zhixing.db.deleteWorkflowInstance(i.id)
    onNotice('已删除该实例记录（模板与任务都还在）')
    await refresh()
  }

  /** 分类树渲染辅助 */
  const groupOf = (id: number): number | null =>
    templateGroups.find((x) => x.id === id)?.group_id ?? null
  const toggleGroup = (id: number): void => toggleGroupRaw(id)

  const renderTemplateRow = (t: WorkflowTemplateSummary, depth: number): JSX.Element => (
    <div
      key={'t' + t.id}
      className={'wf-node wf-node--template' + (current?.id === t.id ? ' wf-node--on' : '')}
      data-depth={depth}
      // --tree-depth / --tree-step 供路径跟踪虚线定位（见 global.css 的树形控件一段）
      style={{ paddingLeft: 6 + depth * 12, '--tree-depth': depth, '--tree-step': '12px' } as React.CSSProperties}
    >
      <button className="wf-node__label" onClick={() => void openTemplate(t.id)}>
        <strong>{t.name}</strong>
        {/* 策略在顶部工具栏已经写着，这里只留步数，把宽度让给名称 */}
        <span className="u-aux">{t.node_count} 步</span>
      </button>
      <div className="wf-node__ops">
        <button
          className="icon-btn"
          title="重命名"
          aria-label="重命名工作流"
          onClick={() => void openTemplate(t.id).then(() => handleRenameTemplate())}
        >
          <Pencil size={13} />
        </button>
        <button
          className="icon-btn"
          title="复制"
          aria-label="复制工作流"
          onClick={() => void handleDuplicateTemplate(t.id)}
        >
          <Copy size={13} />
        </button>
        <button
          className="icon-btn icon-btn--danger"
          title="删除"
          aria-label="删除工作流"
          onClick={() => void openTemplate(t.id).then(() => handleDeleteTemplate())}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )

  const renderGroupRow = (g: WfGroup, depth: number): JSX.Element => {
    const kids = groups.filter((x) => x.parent_id === g.id)
    const tpls = templates.filter((t) => groupOf(t.id) === g.id)
    const collapsed = collapsedGroups.has(g.id)
    return (
      <div key={'g' + g.id}>
        <div
          className={'wf-node wf-node--group' + (collapsed ? ' wf-node--collapsed' : '')}
          data-depth={depth}
          style={{ paddingLeft: 6 + depth * 12, '--tree-depth': depth, '--tree-step': '12px' } as React.CSSProperties}
        >
          <button className="wf-node__label" aria-expanded={!collapsed} onClick={() => toggleGroup(g.id)}>
            {/* 与笔记树 / 任务行同一套：同一位置换图标，morphicons 自己形变过去（size 也是同一档 16）。
                不要再叠 CSS rotate —— 那会和形变叠加成转两次。 */}
            {collapsed ? (
              <ChevronRight size={16} className="wf-node__caret" aria-hidden />
            ) : (
              <ChevronDown size={16} className="wf-node__caret" aria-hidden />
            )}
            <strong>{g.name}</strong>
            <span className="u-aux">{tpls.length} 个</span>
          </button>
          <div className="wf-node__ops">
            <button
              className="icon-btn"
              title="在此分类下新建工作流"
              aria-label="在此分类下新建工作流"
              onClick={() => void handleNewTemplate(g.id)}
            >
              <FilePlus2 size={13} />
            </button>
            <button className="icon-btn" title="新建子分类" aria-label="新建子分类" onClick={() => void handleNewGroup(g.id)}>
              <FolderPlus size={13} />
            </button>
            <button className="icon-btn" title="重命名分类" aria-label="重命名分类" onClick={() => void handleRenameGroup(g)}>
              <Pencil size={13} />
            </button>
            <button
              className="icon-btn icon-btn--danger"
              title="删除分类"
              aria-label="删除分类"
              onClick={() => void handleDeleteGroup(g)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
        {!collapsed && (
          <>
            {kids.map((k) => renderGroupRow(k, depth + 1))}
            {tpls.map((t) => renderTemplateRow(t, depth + 1))}
          </>
        )}
      </div>
    )
  }

  /** 当前模板节点的保存入参（坐标取画布上的当前值）。 */
  const nodePayload = (
    nodes: WorkflowNodePayload[]
  ): Parameters<typeof window.zhixing.db.saveWorkflowTemplate>[0]['nodes'] =>
    nodes.map((n) => ({
      id: n.id,
      title: n.title,
      detail: n.detail,
      order_index: n.order_index,
      note_id: n.note_id,
      note_ids: n.note_ids,
      action_kind: n.action_kind,
      action_value: n.action_value,
      action_expect: n.action_expect,
      action_runtime: n.action_runtime,
      log_rules: n.log_rules,
      condition: n.condition,
      branch_node_id: n.branch_node_id,
      branch_false_node_id: n.branch_false_node_id,
      // 坐标只沿用**库里已有的值**，不取画布上的当前值：拖动本身是即时落库的
      // （见 endDrag），这里再写一遍会把 dagre 的临时排布固化成手动坐标 ——
      // 随后插入新步骤时，新旧节点就会重叠在同一格。
      pos_x: n.pos_x ?? null,
      pos_y: n.pos_y ?? null,
    }))

  /** 统一的模板保存入口：校验失败给出 problems，成功则刷新并返回 true。 */
  const persistTemplate = async (
    nodes: WorkflowNodePayload[],
    patch?: { name?: string; description?: string; start_policy?: string; schedule?: string; triggers?: string }
  ): Promise<boolean> => {
    if (!current) return false
    const res = await window.zhixing.db.saveWorkflowTemplate({
      id: current.id,
      name: patch?.name ?? current.name,
      description: patch?.description ?? current.description,
      start_policy: patch?.start_policy ?? current.start_policy,
      schedule: patch?.schedule ?? current.schedule,
      triggers: patch?.triggers ?? current.triggers,
      nodes: nodePayload(nodes),
    })
    if (!res.ok) {
      onNotice(`保存失败：${res.problems.join('；')}`)
      return false
    }
    await refresh()
    return true
  }

  /** 复制一份：名称加「 副本」，节点整体复制、不复制坐标。 */
  const handleDuplicateTemplate = async (id?: number): Promise<void> => {
    const tid = id ?? current?.id
    if (!tid) return
    const copy = await window.zhixing.db.duplicateWorkflowTemplate(tid)
    if (!copy) {
      onNotice('复制失败：模板不存在')
      return
    }
    await loadTemplates()
    await openTemplate(copy.id)
    onNotice(`已复制为「${copy.name}」`)
  }

  /** 重命名模板。 */
  const handleRenameTemplate = async (): Promise<void> => {
    if (!current) return
    const name = await dialog.prompt({
      title: '重命名工作流',
      label: '名称',
      defaultValue: current.name,
    })
    if (name == null || !name.trim()) return
    if (await persistTemplate(ordered, { name: name.trim() })) onNotice('已重命名')
  }

  /** 启动策略可编辑。 */
  const handlePolicyChange = async (policy: string): Promise<void> => {
    if (!current) return
    await persistTemplate(ordered, { start_policy: policy })
  }

  /** 删除选中步骤。 */
  const handleDeleteStep = async (): Promise<void> => {
    if (!current || selected == null) return
    const removedId = selected
    // 指向被删节点的分支引用必须一并清掉：留着它，校验会以「分支指向了不存在的步骤」
    // 直接拒绝保存 —— 表现就是「这一步删不掉，得先把别人的分支改到别处去」
    let rest = ordered.filter((n) => n.id !== removedId)
    for (const slot of ['true', 'false'] as const) {
      rest = rest.map((n) =>
        branchTarget(n, slot) === removedId ? withBranchTarget(n, slot, null) : n
      )
    }
    const next = rest.map((n, i) => ({ ...n, order_index: i }))
    if (!next.length) {
      onNotice('至少要保留一个步骤')
      return
    }
    const confirmed = await dialog.confirm({
      title: '删除步骤',
      message: '删除选中的步骤？删除后按顺序重排其余步骤，指向它的连线也会一并去掉。',
      icon: <Trash2 size={15} />,
      danger: true,
      confirmText: '删除',
    })
    if (!confirmed) return
    setSelected(null)
    await persistTemplate(next)
  }

  /** 上移 / 下移。 */
  const handleMoveStep = async (delta: number): Promise<void> => {
    if (!current || selected == null) return
    const list = [...ordered]
    const idx = list.findIndex((n) => n.id === selected)
    const tgt = idx + delta
    if (idx < 0 || tgt < 0 || tgt >= list.length) return
    ;[list[idx], list[tgt]] = [list[tgt], list[idx]]
    await persistTemplate(list.map((n, i) => ({ ...n, order_index: i })))
  }

  /**
   * 自动布局：交给 dagre 按依赖关系分层 —— 顺序边（order_index 相邻）与条件分支边
   * 一起参与，所以分支会落在与主线不同的层，不再和主线挤在同一列。
   * 坐标逐个写回后在本地一并更新（persistTemplate 读的是闭包里的旧 pos，会盖掉新坐标）。
   */
  const handleAutoLayout = async (dir: WorkflowRankDir = rankdir): Promise<void> => {
    if (!current) return
    const next = layoutWorkflow(ordered, { rankdir: dir, nodeWidth: NODE_W, nodeHeight: NODE_H })
    if (!next.size) return
    // 一次提交全部坐标：逐条写的话，中途失败会留下「一半新坐标一半旧坐标」的画布
    await window.zhixing.db.batchUpdateNodePos([...next].map(([id, p]) => ({ id, x: p.x, y: p.y })))
    await refresh()
    // 只改基准：适配视图由上面那个 effect 统一做（它等得到新基准）
    setCanvasSize(canvasBoundsOf(next))
    onNotice(dir === 'TB' ? '已按依赖关系纵向分层排布' : '已按依赖关系横向分层排布')
  }

  const handleDeleteTemplate = async (): Promise<void> => {
    if (!current) return
    const confirmed = await dialog.confirm({
      title: '删除工作流',
      message: `删除工作流「${current.name}」及其全部节点？\n还有运行中的实例时会被拒绝。`,
      icon: <Trash2 size={15} />,
      danger: true,
      confirmText: '删除',
    })
    if (!confirmed) return
    const removed = await window.zhixing.db.deleteWorkflowTemplate(current.id)
    if (!removed) {
      onNotice('该工作流还有运行中的实例，请先中断实例再删除')
      return
    }
    await loadTemplates()
    const rows = await window.zhixing.db.workflowTemplates()
    if (rows.length) await openTemplate(rows[0].id)
    else setCurrent(null)
    onNotice('已删除')
  }

  /**
   * 加一步 / 加条件：先弹步骤编辑窗，保存时**插到选中节点之后**（未选中则追加末尾），
   * 并可勾选「作为选中节点的条件分支」。
   * 新节点用负临时 id，保存时经 id_map 重映射成真实 id，分支引用才不会悬空。
   *
   * 条件节点与普通步骤走同一个弹窗，只是预置好 action_kind 与一份「提示确认」草稿 ——
   * 于是从工具栏点「加条件」进去就能直接填条件，不用先选动作类型。
   */
  const openNewNodeDialog = (kind: 'step' | 'condition'): void => {
    if (!current) return
    const isCondition = kind === 'condition'
    setEditing({
      id: -(ordered.length + 1),
      template_id: current.id,
      title: isCondition ? '条件判断' : '',
      detail: '',
      order_index: ordered.length,
      note_id: null,
      note_ids: [],
      action_kind: isCondition ? CONDITION_KIND : TASK_KIND,
      action_value: isCondition ? serializeCondition({ kind: 'confirm' }) : '',
      action_expect: '',
      action_runtime: '',
      log_rules: '',
      condition: '',
      branch_node_id: null,
      branch_false_node_id: null,
      pos_x: null,
      pos_y: null,
    })
    setEditingNew(true)
  }

  /** 打开已有步骤的编辑弹窗（双击节点 / 卡片「编辑」）。 */
  const openEditNode = (node: WorkflowNodePayload): void => {
    setEditing(node)
    setEditingNew(false)
  }

  /** 关闭节点编辑弹窗（取消 / 点遮罩）。 */
  const closeNodeDialog = (): void => {
    setEditing(null)
    setEditingNew(false)
  }

  const handleSaveNode = async (
    node: WorkflowNodePayload,
    asBranch: BranchSlot | null
  ): Promise<void> => {
    if (!current) return
    if (!node.title.trim()) {
      onNotice('请填写步骤标题')
      return
    }
    if (editingNew) {
      const list = [...ordered]
      const selIdx = selected != null ? list.findIndex((n) => n.id === selected) : -1
      // 在条件节点上新增：必须是「满足」或「不满足」的分支步骤，不接受「不挂分支」——
      // 否则新步骤会落进顺序链，条件节点等于被绕过（这正是用户反馈的那一点）。
      if (selIdx >= 0 && list[selIdx].action_kind === CONDITION_KIND && asBranch == null) {
        onNotice('请选择挂到「满足」还是「不满足」分支')
        return
      }
      if (selIdx >= 0) list.splice(selIdx + 1, 0, node)
      else list.push(node)
      // 把选中条件节点的对应出边指到新节点（满足 / 不满足各一条）
      const slot = asBranch
      const linked =
        slot && selIdx >= 0
          ? list.map((n) => (n.id === selected ? withBranchTarget(n, slot, node.id) : n))
          : list
      if (!(await persistTemplate(linked.map((n, i) => ({ ...n, order_index: i }))))) return
      // 新节点的负临时 id 保存后已失效：清掉选中态，避免高亮指向不存在的节点
      setSelected(null)
    } else {
      // 只覆盖被编辑节点自身字段，其余保持原样（避免把未保存的拖动坐标写串）
      const list = ordered.map((n) => (n.id === node.id ? { ...n, ...node } : n))
      if (!(await persistTemplate(list))) return
    }
    setEditing(null)
    setEditingNew(false)
    onNotice('步骤已保存')
  }

  const handleInstantiate = async (): Promise<void> => {
    if (!current) return
    // 把当前启动策略显式传给实例化（不依赖库里的旧值）
    const inst = await window.zhixing.db.instantiateWorkflow(
      current.id,
      null,
      null,
      current.start_policy
    )
    if (!inst) {
      onNotice('该模板没有可运行的步骤')
      return
    }
    onNotice(`已启动「${inst.title}」`)
    await refresh()
  }

  /** 自动步骤失败后原地重跑（实例停在当前节点）。 */
  const handleRetry = async (): Promise<void> => {
    if (!instance) return
    await window.zhixing.db.retryWorkflowStep(instance.id)
    await refresh()
  }

  const handleAbort = async (): Promise<void> => {
    if (!instance) return
    const confirmed = await dialog.confirm({
      title: '中止实例',
      message: '中止这个实例？已下发的步骤任务会保留。',
      icon: <Square size={15} />,
      tone: 'warning',
      confirmText: '中止',
    })
    if (!confirmed) return
    await window.zhixing.db.abortWorkflowInstance(instance.id)
    await refresh()
  }

  return (
    <div className="page page--workflow">
      <div className="page__body">
  <Toolbar
    title={'工作流'}
    subtitle={'可复用的流程模板'}
    nav={(
      // 模板树的收放：按需求放在工具栏最左边
      <button
        className="icon-btn"
        aria-pressed={!treeHidden}
        aria-label={treeHidden ? '展开模板树' : '收起模板树'}
        title={treeHidden ? '展开模板树' : '收起模板树'}
        onClick={() => setTreeHidden((prev) => !prev)}
      >
        <Morph icon={treeHidden ? IconData.PanelLeftOpen : IconData.PanelLeftClose} size={15} />
      </button>
    )}
    meta={(
      <span className="u-aux">{current ? `${current.name} · ${ordered.length} 步` : '未选择模板'}</span>
    )}
    filters={[
      <label key="policy" className="wf-policy">
        <span className="u-aux">启动策略</span>
        <Select
          className="field field--compact"
          ariaLabel="启动策略"
          value={current?.start_policy === 'all' ? 'all' : 'first'}
          disabled={!current}
          onChange={(v) => void handlePolicyChange(v)}
          options={[
            { value: 'first', label: '只生成第一步待办' },
            { value: 'all', label: '一次性生成全部待办' },
          ]}
        />
      </label>,
    ]}
    primary={(
      <button className="text-btn text-btn--accent" onClick={() => void handleInstantiate()} disabled={!current}>
        <Play size={13} /> 启动实例
      </button>
    )}
    secondary={[
      <button
        key="add"
        className="text-btn"
        onClick={() => openNewNodeDialog('step')}
        disabled={!current}
      >
        <Plus size={13} /> 加一步
      </button>,
      <button
        key="addCond"
        className="text-btn"
        onClick={() => openNewNodeDialog('condition')}
        disabled={!current}
        title="新增条件节点：到点自动求值（不建任务），成立走「满足」分支、不成立走「不满足」分支（没配的按顺序走下一步）"
      >
        {/* 用菱形：与画布上条件节点的形状一致，一眼对应得上 */}
        <Diamond size={13} /> 加条件
      </button>,
      <button
        key="edit"
        className="text-btn"
        onClick={() => {
          const n = ordered.find((x) => x.id === selected)
          if (n) openEditNode(n)
        }}
        disabled={selected == null}
        title="编辑选中步骤（也可双击节点）"
      >
        <Pencil size={13} /> 编辑
      </button>,
      <button key="del" className="text-btn" onClick={() => void handleDeleteStep()} disabled={selected == null}>
        <Trash2 size={13} /> 删除步骤
      </button>,
      <button key="up" className="text-btn" onClick={() => void handleMoveStep(-1)} disabled={selected == null} title="上移">
        <ArrowUp size={13} /> 上移
      </button>,
      <button key="down" className="text-btn" onClick={() => void handleMoveStep(1)} disabled={selected == null} title="下移">
        <ArrowDown size={13} /> 下移
      </button>,
      <button
        key="plan"
        className="text-btn"
        onClick={() => setScheduleOpen(true)}
        disabled={!current}
        title="定时计划与外部触发（什么时候自己跑起来）"
      >
        <Timer size={13} /> 计划
      </button>,
      <button
        key="align"
        className="text-btn"
        onClick={() => void handleAutoLayout()}
        disabled={!current}
        title="按依赖关系分层重新排布（顺序边 + 条件分支边一起参与）"
      >
        <LayoutGrid size={13} /> 自动布局
      </button>,
      <button
        key="dir"
        className="text-btn"
        onClick={() => {
          const nextDir: WorkflowRankDir = rankdir === 'TB' ? 'LR' : 'TB'
          setRankdir(nextDir)
          try {
            localStorage.setItem('wf.rankdir', nextDir)
          } catch {
            // 存不下就只在本次会话里生效
          }
          void handleAutoLayout(nextDir)
        }}
        disabled={!current}
        title="切换分层方向并立即重排：纵向（步骤自上而下）/ 横向（步骤自左而右）"
      >
        <GitBranch size={13} /> {rankdir === 'TB' ? '纵向' : '横向'}
      </button>,
      <button key="reset" className="text-btn" onClick={() => wfRef.current?.fit()}>
        <Maximize2 size={13} /> 重置视图
      </button>,
      <button key="rename" className="text-btn" onClick={() => void handleRenameTemplate()} disabled={!current}>
        <Pencil size={13} /> 重命名
      </button>,
      <button key="dup" className="text-btn" onClick={() => void handleDuplicateTemplate()} disabled={!current}>
        <Copy size={13} /> 复制
      </button>,
      <button
        key="delTpl"
        className="text-btn text-btn--danger"
        onClick={() => void handleDeleteTemplate()}
        disabled={!current}
      >
        <Trash2 size={13} /> 删除
      </button>,
    ]}
  />

      <div className={'wf-wrap' + (sideResizing ? ' is-resizing' : '')}>
        {/* 模板树整栏：收起时连分隔条一起不渲染，宽度全给画布 ——
            不是「藏起来」：藏起来的节点仍会被查询与自动化脚本当成看得见。
            收放按钮在工具栏最左边。 */}
        {!treeHidden ? (
        <>
        <aside
          className="wf-side"
          style={{ width: sideWidth, flexBasis: sideWidth }}
          aria-label="模板与实例"
        >
          <div className="wf-side__head">
            <span>模板</span>
            {/* 原先的「新建工作流」按钮已取消：模板统一在分类的胶囊里新建 */}
            <div className="wf-node__ops wf-node__ops--always">
              <button
                className="icon-btn"
                title="新建分类"
                aria-label="新建分类"
                onClick={() => void handleNewGroup(null)}
              >
                <FolderPlus size={15} />
              </button>
            </div>
          </div>
          <div className="wf-tree">
            {groups.filter((g) => g.parent_id === null).map((g) => renderGroupRow(g, 0))}
            {templates.filter((t) => groupOf(t.id) === null).map((t) => renderTemplateRow(t, 0))}
            {templates.length === 0 && groups.length === 0 && (
              <p className="u-aux">
                还没有分类或工作流。右上角可以先建一个分类，或者直接
                <button className="text-btn" onClick={() => void handleNewTemplate(null)}>
                  新建工作流
                </button>
                （不归入任何分类）。
              </p>
            )}
          </div>

          <div className="wf-side__head">实例</div>
          <div className="wf-tree">
            {instances.map((i) => (
              <div key={i.id} className="wf-node wf-node--static">
                <div className="wf-node__label wf-node__label--static">
                  <strong>{i.title}</strong>
                  <span className="u-aux">
                    {i.status === 'running' ? '进行中' : i.status === 'done' ? '已完成' : '已中止'} ·
                    {i.steps.filter((s) => s.done).length}/{i.steps.length}
                    {i.last_result?.state === 'running' ? ' · 正在执行' : ''}
                    {i.last_result?.state === 'failed' || i.last_result?.state === 'timeout'
                      ? ' · 某步未通过'
                      : ''}
                  </span>
                </div>
                <div className="wf-node__ops">
                  <button
                    className="icon-btn"
                    title="执行记录：每一步什么时候跑的、结果如何、逐步的执行日志"
                    aria-label="执行记录"
                    aria-haspopup="dialog"
                    onClick={() => void openRunLog(i.id)}
                  >
                    <History size={13} />
                  </button>
                  <button
                    className="icon-btn"
                    title="重命名实例"
                    aria-label="重命名实例"
                    onClick={() => void handleRenameInstance(i)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="icon-btn"
                    title="再次运行：按同一模板再开一个新实例（旧记录保留）"
                    aria-label="再次运行实例"
                    onClick={() => void handleRerunInstance(i)}
                  >
                    <RotateCcw size={13} />
                  </button>
                  <button
                    className="icon-btn icon-btn--danger"
                    title="删除这个实例记录（不会删除模板，也不删已生成的任务）"
                    aria-label="删除实例"
                    onClick={() => void handleDeleteInstance(i)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
            {instances.length === 0 && <p className="u-aux">还没有运行中的实例。</p>}
          </div>
        </aside>

        {/* 分隔条：拖动改模板栏宽度；可聚焦，← → 也能微调 */}
        <div
          className="wf-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整模板栏宽度"
          aria-valuenow={Math.round(sideWidth)}
          aria-valuemin={SIDE_MIN}
          aria-valuemax={SIDE_MAX}
          tabIndex={0}
          title="拖动调整模板栏宽度（← → 微调，Home 复位）"
          onPointerDown={startSideDrag}
          onPointerMove={onSideResizeDrag}
          onPointerUp={endSideDrag}
          onPointerCancel={endSideDrag}
          onKeyDown={onSideKeyDown}
        />
        </>
        ) : null}

        <div className="wf-main">

          {instance && (
            <div className="wf-progress">
              <GitBranch size={14} />
              <strong>{instance.title}</strong>
              <span className="u-aux">
                {instance.steps.filter((s) => s.done).length}/{instance.steps.length} 步完成
              </span>
              {/* 自动步骤（命令 / 脚本）的实时状态：运行中、还是卡在某个返回值不对的步骤上 */}
              {instance.last_result && (
                <span
                  className={'wf-run wf-run--' + instance.last_result.state}
                  // 悬停看进程输出尾部：失败原因往往只在 stdout/stderr 里（进度条是单行，放不下）
                  title={instance.last_result.output || undefined}
                >
                  {instance.last_result.message}
                  {instance.last_result.code != null ? `（退出码 ${instance.last_result.code}）` : ''}
                </span>
              )}
              {instance.last_result &&
                (instance.last_result.state === 'failed' ||
                  instance.last_result.state === 'timeout') && (
                  <button className="text-btn text-btn--accent" onClick={() => void handleRetry()}>
                    重试该步
                  </button>
                )}
              <button className="text-btn text-btn--danger" onClick={() => void handleAbort()}>
                中止
              </button>
            </div>
          )}

          {current && (
            <WorkflowCanvasG6
              nodes={g6Nodes}
              handleRef={wfRef}
              /**
               * **必须传** —— 早先漏了这一行，画布一直用默认的 'TB'，
               * 点「横向」时画布毫无反应（布局没重跑）。实测：切方向后节点坐标一个都没动。
               */
              rankdir={rankdir}
              selectedId={selected}
              onSelect={async (id) => {
                // 待定分支态下，点到的节点就是分支目标
                if (pendingBranch && id != null) {
                  const from = pendingBranch
                  setPendingBranch(null)
                  await window.zhixing.db.setWorkflowBranch(from.fromId, id, from.slot)
                  await refresh()
                  return
                }
                setSelected(id)
              }}
              onNodeMoved={async (id, x, y) => {
                // 只在 dragend 落一次库（不在拖动过程中写 —— 那是每帧一次 IPC）。
                // **落完不 refresh**：画布上节点已经在拖后的位置了，重载数据会让 G6
                // 重跑布局、节点跳回原处；侧栏等地方并不显示坐标，不需要立刻同步。
                await window.zhixing.db.updateWorkflowNodePos(id, x, y)
              }}
              onOpen={(id) => {
                const n = ordered.find((x) => x.id === id)
                if (n) openEditNode(n)
              }}
              onBranch={(nodeId, slot) => {
                // 两段式：点端口先进「待定分支」态，再点一个目标节点才落库。
                // 旧实现是从端口拖到目标节点；G6 的 HTML 节点命中区域限于节点盒，
                // 而端口画在盒的边界上 —— 拖拽起手点做不了，于是改成同一套
                // 「点起点 → 点终点」的语言（与图谱的点选式连线一致）。
                // 画布仍然只报「点了谁、哪个槽位」。
                setPendingBranch({ fromId: nodeId, slot })
              }}
              onBranchRemove={async (fromId, slot) => {
                // 删除分支出边：同一个 IPC，第二参传 null 即清空该槽位。
                await window.zhixing.db.setWorkflowBranch(fromId, null, slot)
                await refresh()
              }}
              onBranchTo={async (fromId, slot, toId) => {
                // 拖拽建分支：与右键菜单的两段式落到同一个 IPC
                await window.zhixing.db.setWorkflowBranch(fromId, toId, slot)
                await refresh()
              }}
              onEdgeRewire={async (fromId, slot, toId) => {
                // 拖拽改挂：与上面的两段式点选落到同一个 IPC（`setWorkflowBranch` 本就是把
                // 「谁的分支、去哪个节点」重写一遍），只是在松手那一刻就拿到了目标。
                await window.zhixing.db.setWorkflowBranch(fromId, toId, slot)
                await refresh()
              }}
            />
          )}
          <p className="u-aux">
            点节点选中（工具栏的编辑 / 删除 / 上移 / 下移按它定位）、双击编辑；拖动节点改布局（自动保存）。
            画布空白处拖动可平移、滚轮缩放。条件节点下方写着判定内容，它连出的分支线上标着
            「满足 / 不满足」。**按住分支线靠近目标的一端拖动，松手落到另一个节点上即可改挂**；
            右键分支线可删除。新建分支走节点右键菜单（建立「满足」/「不满足」/「跳到」分支），
            之后再点一个目标节点。
          </p>
        </div>
      </div>

      {editing &&
        (editingIsCondition ? (
          <WorkflowConditionDialog
            node={editing}
            isNew={editingNew}
            siblings={ordered
              .filter((n) => n.id !== editing.id)
              .map((n) => ({ id: n.id, title: n.title }))}
            onSave={(node) => void handleSaveNode(node, null)}
            onCancel={closeNodeDialog}
          />
        ) : (
          <WorkflowStepDialog
            node={editing}
            isNew={editingNew}
            selectedTitle={selectedNode?.title ?? null}
            selectedIsCondition={selectedNode?.action_kind === CONDITION_KIND}
            noteChoices={noteChoices}
            // 排除自己：一个流程接续自己就是死循环。间接成环（A→B→A）在启动时另有拦截
            subflowChoices={templates.filter((t) => t.id !== current?.id).map((t) => ({ id: t.id, name: t.name }))}
            onSave={(node, asBranch) => void handleSaveNode(node, asBranch)}
            onCancel={closeNodeDialog}
          />
        ))}

        {/* 执行记录：从侧栏内联展开搬到了弹窗 —— 时间轴天生是长内容，
            内联会把实例列表挤得只剩两行 */}
        {runLogFor != null &&
          (() => {
            const inst = instances.find((x) => x.id === runLogFor)
            if (!inst) return null
            return (
              <WorkflowRunDialog instance={inst} runLog={runLog} onClose={() => setRunLogFor(null)} />
            )
          })()}

        {scheduleOpen && current && (
          <WorkflowScheduleDialog
            template={
              templates.find((t) => t.id === current.id) ?? {
                ...current,
                node_count: current.nodes.length,
                updated_at: '',
              }
            }
            taskChoices={taskChoices}
            triggerPort={triggerPort}
            onSave={(patch) => {
              setScheduleOpen(false)
              void persistTemplate(current.nodes, patch)
            }}
            onCancel={() => setScheduleOpen(false)}
          />
        )}
      </div>
    </div>
  )
}
