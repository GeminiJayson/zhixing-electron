import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  IconData,
  LayoutGrid,
  Maximize2,
  Morph,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Square,
  TerminalSquare,
  Trash2,
  X,
} from '@renderer/lib/icons'
import type {
  Note,
  WorkflowInstancePayload,
  WorkflowNodePayload,
  WorkflowTemplatePayload,
  WorkflowTemplateSummary,
} from '@shared/types'
import { subscribeDomain } from '@shared/events'
import { CONDITION_KIND, describeCondition, serializeCondition } from '@shared/workflow-condition'
import {
  TASK_KIND,
  actionKindLabel,
  isAutoActionKind,
  normalizeActionKind,
  scriptRuntimeLabel,
} from '@shared/workflow-action'
import {
  BRANCH_SLOTS,
  branchSlotLabel,
  branchTarget,
  fallthroughTarget,
  withBranchTarget,
  type BranchSlot,
} from '@shared/workflow-branch'
import { t } from '../i18n'
import { Toolbar } from '../components/Toolbar'
import { WorkflowStepDialog } from '../components/WorkflowStepDialog'
import { WorkflowConditionDialog } from '../components/WorkflowConditionDialog'
import { useDialog } from '../components/Dialogs'
import { usePanZoom } from '../lib/usePanZoom'
import {
  SIDE_NORMAL,
  edgePathMidpoint,
  edgePointFrom,
  orthogonalPath,
  type Anchor,
  type AnchorSide,
} from '../lib/edge-path'
import {
  directedAnchors,
  layoutBounds,
  layoutWorkflow,
  type WorkflowRankDir,
} from '../lib/workflow-layout'
import { quietFailure } from '@shared/quiet-failure'

interface Props {
  onNotice: (message: string) => void
  onChanged: () => Promise<void>
}

const NODE_W = 150
const NODE_H = 56
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
 * 一个节点的出线端口 —— 画布上每个节点都能**主动**拉一条线到别的节点，
 * 不必先有连线才谈得上改挂（用户反馈过这一点）。
 *
 * 条件节点：菱形左右两个尖角，右 = 满足、左 = 不满足。选尖角而不是下方，
 *          是为了避开贴在菱形下方的条件内容条（从下缘出线会横穿内容条）。
 * 普通步骤：右边中点一个「跳到」口。放在右边是为了不跟底部的顺序出边打架。
 */
function nodePort(
  node: Pick<WorkflowNodePayload, 'action_kind'>,
  a: { x: number; y: number },
  slot: BranchSlot
): { x: number; y: number; side: AnchorSide } {
  if (node.action_kind === CONDITION_KIND && slot === 'false') {
    return { x: a.x, y: a.y + NODE_H / 2, side: 'left' }
  }
  return { x: a.x + NODE_W, y: a.y + NODE_H / 2, side: 'right' }
}

/**
 * 一条分支出边的两端锚点。
 *
 * 出边一律从**端口**走（条件节点是尖角、普通步骤是右边中点），落点仍按相对位置挑边；
 * 两端都带上「这是哪条边」，交给 orthogonalPath 折线 —— 于是首段、末段都垂直于
 * 节点的边，中间的过渡段落在节点之外。
 *
 * 早先为了绕开被跳过的中间节点，硬把落点放到目标**同侧**的边上：那样末段是竖直的
 * 却落在目标的左右边框上，等于**和节点的边重合**了（用户实测就是这样）。
 */
function branchAnchors(
  from: WorkflowNodePayload,
  a: { x: number; y: number },
  slot: BranchSlot,
  to: { x: number; y: number }
): { from: Anchor; to: Anchor } {
  const anchors = directedAnchors(a, to, NODE_W, NODE_H)
  return { from: nodePort(from, a, slot), to: anchors.to }
}

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
  const [pos, setPos] = useState<Map<number, { x: number; y: number }>>(new Map())
  const [selected, setSelected] = useState<number | null>(null)
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
  const dragRef = useRef<{
    id: number
    dx: number
    dy: number
    /** 按下时的坐标：松手时比对用 —— 没真的挪动过就不要写库 */
    from: { x: number; y: number }
  } | null>(null)
  /** 悬停的分支连线（源步骤 id + 槽位），以及正在改挂的那一条 */
  const [branchHover, setBranchHover] = useState<{ id: number; slot: BranchSlot } | null>(null)
  /** 鼠标悬浮的步骤：与它相连的连线高亮、其余淡到几乎隐形（与知识图谱同一套交互） */
  const [hoverStep, setHoverStep] = useState<number | null>(null)
  const [branchDrag, setBranchDrag] = useState<{
    fromId: number
    slot: BranchSlot
    x: number
    y: number
  } | null>(null)
  /**
   * 正在拖动节点。拖动期间不渲染详情浮卡 —— 浮卡画在 foreignObject 里，
   * 节点移动时它的坐标更新了但不会重绘，会在原地留下一张「拖影」。
   */
  const [dragging, setDragging] = useState(false)
  // 画布视图（平移 / 缩放）。startDrag 定义在 hook 之前，用这个 ref 桥接。
  const panRef = useRef<ReturnType<typeof usePanZoom> | null>(null)

  /** 模板分类 */
  type WfGroup = Awaited<ReturnType<typeof window.zhixing.db.workflowGroups>>[number]
  const [groups, setGroups] = useState<WfGroup[]>([])
  const [templateGroups, setTemplateGroups] = useState<{ id: number; group_id: number | null }[]>([])
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number>>(new Set())

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
    setPos(layout)
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
    await onChanged()
  }, [loadTemplates, openTemplate, loadInstances, current, onChanged])

  const ordered = useMemo(() => {
    if (!current) return []
    return [...current.nodes].sort(
      (a, b) => (a.order_index || 0) - (b.order_index || 0) || a.id - b.id
    )
  }, [current])

  /**
   * 悬浮步骤的直接邻居（含自己）。返回 null 表示不做任何淡化。
   * 正在改挂分支端点时强制不淡化：那时用户在挑目标步骤，淡化候选会让人点不准。
   */
  const stepFocusSet = useMemo(() => {
    if (branchDrag != null || hoverStep == null) return null
    const set = new Set<number>([hoverStep])
    ordered.forEach((n, i) => {
      if (n.id === hoverStep) {
        const prev = ordered[i - 1]
        const next = ordered[i + 1]
        if (prev) set.add(prev.id)
        if (next) set.add(next.id)
        // 满足 / 不满足两条出边都算直接相连
        if (n.branch_node_id) set.add(n.branch_node_id)
        if (n.branch_false_node_id) set.add(n.branch_false_node_id)
      }
      // 别人的分支指向我，同样算直接相连
      if (n.branch_node_id === hoverStep || n.branch_false_node_id === hoverStep) set.add(n.id)
    })
    return set
  }, [hoverStep, ordered, branchDrag])

  const instance = useMemo(
    () => instances.find((i) => i.template_id === current?.id && i.status === 'running') ?? null,
    [instances, current]
  )

  /** 画布上被点中的节点（浮卡与「作为某条件的分支」都以它为准）。 */
  const selectedNode = useMemo(
    () => ordered.find((n) => n.id === selected) ?? null,
    [ordered, selected]
  )

  /** 画布上的分支连线：条件节点两条出边各算一条（普通步骤最多一条历史分支）。 */
  const branchEdges = useMemo(() => {
    const out: { from: WorkflowNodePayload; slot: BranchSlot; toId: number }[] = []
    for (const n of ordered) {
      if (n.branch_node_id) out.push({ from: n, slot: 'true', toId: n.branch_node_id })
      if (n.branch_false_node_id) out.push({ from: n, slot: 'false', toId: n.branch_false_node_id })
    }
    return out
  }, [ordered])

  const startDrag = (n: WorkflowNodePayload) => (e: React.PointerEvent<SVGGElement>) => {
    const p = pos.get(n.id)
    const world = panRef.current?.toWorld(e.clientX, e.clientY)
    if (!world || !p) return
    try {
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
    } catch {
      // 同上：捕获失败不能挡住选中与拖动
    }
    // 偏移量在世界坐标系里算：画布缩放后，同样的像素位移对应的世界位移不同
    dragRef.current = { id: n.id, dx: world.x - p.x, dy: world.y - p.y, from: { x: p.x, y: p.y } }
    setDragging(true)
    setSelected(n.id)
  }

  const onMove = (
    _e: React.PointerEvent<SVGSVGElement>,
    world: { x: number; y: number } | null
  ): void => {
    if (branchDrag) {
      if (world) setBranchDrag((d) => (d ? { ...d, x: world.x, y: world.y } : d))
      return
    }
    const drag = dragRef.current
    if (!drag || !world) return
    setPos((prev) => {
      const next = new Map(prev)
      next.set(drag.id, {
        x: Math.max(0, world.x - drag.dx),
        y: Math.max(0, world.y - drag.dy),
      })
      return next
    })
  }

  /**
   * 删除分支连线：清空该槽位的目标（满足 / 不满足各一条）。
   * 顺序连线（相邻步骤的实线）是 order_index 的投影、没有独立实体，所以不在编辑范围。
   */
  const removeBranch = async (fromId: number, slot: BranchSlot): Promise<void> => {
    await window.zhixing.db.setWorkflowBranch(fromId, null, slot)
    setBranchHover(null)
    onNotice(`已删除「${branchSlotLabel(slot)}」分支连线`)
    await refresh()
  }

  /** 分支端点改挂：落点用命中检测 —— 拖拽期间指针被画布捕获，节点的 hover 事件不会触发。 */
  const dropBranchAt = async (clientX: number, clientY: number): Promise<void> => {
    const drag = branchDrag
    setBranchDrag(null)
    if (!drag) return
    const hit = document.elementFromPoint(clientX, clientY)?.closest('[data-wf-node]')
    const targetId = hit ? Number(hit.getAttribute('data-wf-node')) : NaN
    if (!targetId || targetId === drag.fromId) return
    await window.zhixing.db.setWorkflowBranch(drag.fromId, targetId, drag.slot)
    const label = ordered.find((n) => n.id === targetId)?.title ?? ''
    onNotice(`已把「${branchSlotLabel(drag.slot)}」分支连到「${label}」`)
    await refresh()
  }

  /** 拖动结束才落库。 */
  const endDrag = async (e?: { type?: string; clientX?: number; clientY?: number }): Promise<void> => {
    if (branchDrag) {
      if (e?.type === 'pointerleave' || e?.clientX == null || e?.clientY == null) setBranchDrag(null)
      else await dropBranchAt(e.clientX, e.clientY)
      return
    }
    const drag = dragRef.current
    dragRef.current = null
    setDragging(false)
    if (!drag) return
    const p = pos.get(drag.id)
    if (!p) return
    const nx = Math.round(p.x)
    const ny = Math.round(p.y)
    // 只是「点一下选中」、并没有真的挪动过，就别写库：写下去等于把 dagre 的临时排布
    // 固化成手动坐标，之后再插入步骤时新旧节点会叠在同一个位置（实测踩到过）。
    if (nx === Math.round(drag.from.x) && ny === Math.round(drag.from.y)) return
    await window.zhixing.db.updateWorkflowNodePos(drag.id, nx, ny)
  }

  // 画布级平移 / 缩放：拖背景平移、滚轮以光标为中心缩放；非平移时的移动转给节点拖拽
  const pan = usePanZoom({
    baseW: canvasSize.width,
    baseH: canvasSize.height,
    onMove,
    onEnd: (e) => void endDrag(e),
  })
  panRef.current = pan

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
  // 不能直接在 handleAutoLayout 里调 pan.reset()：那时 setCanvasSize 尚未生效，
  // reset 用的是旧基准，视图会缩在角落（实测横向布局后节点全挤在右上角）。
  useEffect(() => {
    panRef.current?.reset()
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
  const toggleGroup = (id: number): void =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /** 浮卡里把分支目标 id 翻译成人话（没配 / 已删除都不留一个裸 id）。 */
  const branchTargetLabel = (id: number | null): string => {
    if (!id) return '按顺序下一步'
    return ordered.find((n) => n.id === id)?.title || '（节点已删除）'
  }

  const renderTemplateRow = (t: WorkflowTemplateSummary, depth: number): JSX.Element => (
    <div
      key={'t' + t.id}
      className={'wf-node wf-node--template' + (current?.id === t.id ? ' wf-node--on' : '')}
      style={{ paddingLeft: 6 + depth * 12 }}
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
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          <button className="wf-node__label" aria-expanded={!collapsed} onClick={() => toggleGroup(g.id)}>
            {collapsed ? (
              <ChevronRight size={13} className="wf-node__caret" aria-hidden />
            ) : (
              <ChevronDown size={13} className="wf-node__caret" aria-hidden />
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
    patch?: { name?: string; description?: string; start_policy?: string }
  ): Promise<boolean> => {
    if (!current) return false
    const res = await window.zhixing.db.saveWorkflowTemplate({
      id: current.id,
      name: patch?.name ?? current.name,
      description: patch?.description ?? current.description,
      start_policy: patch?.start_policy ?? current.start_policy,
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
    setPos(next)
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

  /**
   * 手动试跑一个节点的动作。
   * 命令 / 脚本有副作用且**会等待进程退出**（不再像历史 run_command 那样发完即忘），
   * 所以执行前必须二次确认；失败时把输出尾部一并报出来，方便当场定位。
   */
  const runNodeAction = async (n: WorkflowNodePayload): Promise<void> => {
    const kind = n.action_kind
    if (!kind || kind === 'none') return
    if (kind === 'run_command' || isAutoActionKind(kind)) {
      const desc = await window.zhixing.db.describeWorkflowAction(
        kind,
        n.action_value,
        n.action_expect,
        n.action_runtime
      )
      const wait = isAutoActionKind(kind) ? '\n\n这一步会等进程结束并核对退出码。' : ''
      const confirmed = await dialog.confirm({
        title: '在本机执行',
        message: `即将在本机执行：\n\n${desc}${wait}`,
        icon: <TerminalSquare size={15} />,
        danger: true,
        confirmText: '执行',
      })
      if (!confirmed) return
    }
    const res = await window.zhixing.db.runWorkflowAction(
      kind,
      n.action_value,
      n.action_expect,
      n.action_runtime
    )
    onNotice(
      res.ok || !res.output
        ? res.message
        : `${res.message}｜输出尾部：${res.output.trim().slice(-160)}`
    )
    if (res.ok && kind === 'open_note') {
      const id = Number(n.action_value)
      if (Number.isFinite(id) && id > 0) {
        window.dispatchEvent(new CustomEvent('zhixing:open-note', { detail: id }))
      }
    }
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
    title={t('page.workflow')}
    subtitle={t('page.workflow.sub')}
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
        <select
          className="field field--compact"
          value={current?.start_policy === 'all' ? 'all' : 'first'}
          disabled={!current}
          onChange={(e) => void handlePolicyChange(e.target.value)}
          aria-label="启动策略"
        >
          <option value="first">只生成第一步待办</option>
          <option value="all">一次性生成全部待办</option>
        </select>
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
      <button key="reset" className="text-btn" onClick={pan.reset}>
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

          <svg
            ref={pan.svgRef}
            className="wf-canvas"
            viewBox={pan.viewBox}
            style={{ cursor: pan.panning ? 'grabbing' : 'grab' }}
            onPointerDown={pan.handlers.onPointerDown}
            onPointerMove={pan.handlers.onPointerMove}
            onPointerUp={pan.handlers.onPointerUp}
            onPointerLeave={pan.handlers.onPointerLeave}
          >
            {/* 箭头：id 与图谱的分开，避免两页同时挂载时 id 撞车 */}
            <defs>
              <marker
                id="wf-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L8,4 L0,8 Z" className="edge-arrow" />
              </marker>
              <marker
                id="wf-arrow-on"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L8,4 L0,8 Z" className="edge-arrow edge-arrow--on" />
              </marker>
            </defs>
            {/* 顺序连线：主链上相邻两步之间的实线。
                条件节点的**出边不在这里画** —— 它的去向由满足 / 不满足两条分支决定，
                哪条槽位没配才另画一条兜底实线（见下面那块）。 */}
            {ordered.map((n, i) => {
              if (n.action_kind === CONDITION_KIND) return null
              const a = pos.get(n.id)
              const nxt = ordered[i + 1]
              const b = nxt ? pos.get(nxt.id) : undefined
              if (!a || !b) return null
              const ends = directedAnchors(a, b, NODE_W, NODE_H)
              const related = hoverStep != null && (n.id === hoverStep || nxt.id === hoverStep)
              const dim = stepFocusSet != null && !related
              return (
                <g key={`seq-${n.id}`} className={'wf-edge-group' + (dim ? ' is-dimmed' : '')}>
                  <path
                    d={orthogonalPath(ends.from, ends.to)}
                    markerEnd={related ? 'url(#wf-arrow-on)' : 'url(#wf-arrow)'}
                    className={'wf-edge' + (related ? ' wf-edge--on' : '')}
                  />
                </g>
              )
            })}

            {/* 条件节点的兜底出边：某条槽位没配分支时，它按顺序走第一个**不是自己分支目标**的节点。
                两条都配了就完全没有兜底路径，也就不画这条线 —— 于是从条件节点出来的只有
                满足 / 不满足两条分支虚线，不会再多挂一条「常规顺序」的实线。 */}
            {ordered.map((n) => {
              if (n.action_kind !== CONDITION_KIND) return null
              const a = pos.get(n.id)
              const target = fallthroughTarget(ordered, n)
              const b = target ? pos.get(target.id) : undefined
              if (!a || !b || !target) return null
              // 哪条槽位没配，就从它自己的端口拉一条点线到兜底目标。
              // 走端口而不是节点盒的边：端口在菱形尖角、首段水平向外，
              // 竖直通道落在节点之外 —— 否则「正对下方」的兜底线会从中间节点身上穿过去。
              const missing: BranchSlot[] = []
              if (!n.branch_node_id) missing.push('true')
              if (!n.branch_false_node_id) missing.push('false')
              const related = hoverStep != null && (n.id === hoverStep || target.id === hoverStep)
              const dim = stepFocusSet != null && !related
              return missing.map((slot) => {
                const ends = branchAnchors(n, a, slot, b)
                return (
                  <g
                    key={`fallback-${n.id}-${slot}`}
                    className={'wf-edge-group' + (dim ? ' is-dimmed' : '')}
                  >
                    <path
                      d={orthogonalPath(ends.from, ends.to)}
                      markerEnd={related ? 'url(#wf-arrow-on)' : 'url(#wf-arrow)'}
                      className={'wf-edge wf-edge--fallback' + (related ? ' wf-edge--on' : '')}
                    />
                  </g>
                )
              })
            })}

            {branchEdges.map(({ from, slot, toId }) => {
              const a = pos.get(from.id)
              const b = pos.get(toId)
              if (!a || !b) return null
              const ends = branchAnchors(from, a, slot, b)
              const d = orthogonalPath(ends.from, ends.to)
              const related = hoverStep != null && (from.id === hoverStep || toId === hoverStep)
              const hot = branchHover?.id === from.id && branchHover.slot === slot
              const dim = stepFocusSet != null && !related
              return (
                <g key={`branch-${from.id}-${slot}`} className={dim ? 'is-dimmed' : undefined}>
                  <path
                    d={d}
                    markerEnd={related || hot ? 'url(#wf-arrow-on)' : 'url(#wf-arrow)'}
                    className={
                      'wf-edge wf-edge--branch ' +
                      // 条件节点用满足 / 不满足两色；普通步骤的「跳到」用中性色
                      (from.action_kind === CONDITION_KIND
                        ? 'wf-edge--branch-' + slot
                        : 'wf-edge--branch-jump') +
                      (related || hot ? ' wf-edge--on' : '')
                    }
                  />
                  {/* 分支文案不在这里画：它得在所有节点之上，见下面的「分支标签层」 */}
                  {/* 热区复用图谱那边的透明粗线：1px 的线本身点不到 */}
                  <path
                    d={d}
                    className="graph__edge-hit"
                    onPointerEnter={() => setBranchHover({ id: from.id, slot })}
                    onPointerLeave={() =>
                      setBranchHover((h) => (h?.id === from.id && h.slot === slot ? null : h))
                    }
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                </g>
              )
            })}

            {ordered.map((n, i) => {
              const p = pos.get(n.id)
              if (!p) return null
              const done = instance?.steps.find((s) => s.node_id === n.id)?.done
              const isCurrent = instance?.current_node_id === n.id
              return (
                <g
                  key={n.id}
                  data-wf-node={n.id}
                  transform={`translate(${p.x},${p.y})`}
                  className={
                    'wf-node' +
                    (n.id === hoverStep ? ' wf-node--on' : '') +
                    (stepFocusSet && !stepFocusSet.has(n.id) ? ' is-dimmed' : '')
                  }
                  onPointerEnter={() => {
                    // 拖动中不更新悬浮态：指针会划过别的节点，画面会乱闪
                    if (!dragRef.current) setHoverStep(n.id)
                  }}
                  onPointerLeave={() => setHoverStep((h) => (h === n.id ? null : h))}
                  onPointerDown={startDrag(n)}
                  onDoubleClick={() => openEditNode(n)}
                  role="button"
                  aria-label={
                    n.action_kind === CONDITION_KIND
                      ? `条件 ${i + 1}：${n.title}（${describeCondition(n.action_value)}）`
                      : `步骤 ${i + 1}：${n.title}`
                  }
                  tabIndex={0}
                >
                  {n.action_kind === CONDITION_KIND ? (
                    /* 条件节点用菱形（流程图惯例）：它是个「关卡」而不是待办步骤 */
                    <polygon
                      points={`${NODE_W / 2},2 ${NODE_W - 2},${NODE_H / 2} ${NODE_W / 2},${NODE_H - 2} 2,${NODE_H / 2}`}
                      className={
                        'wf-node__diamond' + (selected === n.id ? ' wf-node__diamond--on' : '')
                      }
                    />
                  ) : (
                    <rect
                      width={NODE_W}
                      height={NODE_H}
                      rx={8}
                      className={
                        'wf-node__box' +
                        (selected === n.id ? ' wf-node__box--on' : '') +
                        (done ? ' wf-node__box--done' : '') +
                        (isCurrent ? ' wf-node__box--current' : '')
                      }
                    />
                  )}
                  <text
                    x={n.action_kind === CONDITION_KIND ? NODE_W / 2 : 10}
                    y={20}
                    className={
                      'wf-node__idx' + (n.action_kind === CONDITION_KIND ? ' wf-node__idx--center' : '')
                    }
                  >
                    {n.action_kind === CONDITION_KIND
                    ? '条件'
                    : `第 ${i + 1} 步${
                        actionKindLabel(n.action_kind) === '任务'
                          ? ''
                          : ' · ' + actionKindLabel(n.action_kind)
                      }`}
                  </text>
                  <text
                    x={n.action_kind === CONDITION_KIND ? NODE_W / 2 : 10}
                    y={40}
                    className={
                      'wf-node__title' +
                      (n.action_kind === CONDITION_KIND ? ' wf-node__title--center' : '')
                    }
                  >
                    {n.title.length > 10 ? n.title.slice(0, 10) + '…' : n.title}
                  </text>
                  {/* 条件内容直接贴在菱形下方：只画一条虚线看不出「什么情况下走它」，
                      把判据写出来才读得懂；完整文案在悬停提示与详情浮卡里 */}
                  {n.action_kind === CONDITION_KIND &&
                    (() => {
                      const desc = describeCondition(n.action_value)
                      // 13 个字是 9px 字号在 138px 宽度里放得下的上限，再多会溢出到边框外
                      const brief = desc.length > 13 ? desc.slice(0, 13) + '…' : desc
                      return (
                        <g className="wf-node__cond" transform={`translate(0, ${NODE_H + 5})`}>
                          <title>{desc}</title>
                          <rect x={6} width={NODE_W - 12} height={18} rx={6} />
                          <text x={NODE_W / 2} y={12.5}>
                            {brief}
                          </text>
                        </g>
                      )
                    })()}
                </g>
              )
            })}

            {/* 出线端口：**每个**节点都能主动拉一条线到别的节点，不必先有连线才谈得上改挂。
                条件节点是菱形左右两个尖角（右 = 满足、左 = 不满足，标签常驻）；
                普通步骤是右边中点的一个「跳到」口，平时压暗、悬停该节点时才亮。 */}
            {ordered.map((n) => {
              const a = pos.get(n.id)
              if (!a) return null
              const isCondition = n.action_kind === CONDITION_KIND
              const ports: { slot: BranchSlot; label: string; hint: string }[] = isCondition
                ? BRANCH_SLOTS.map((s) => ({
                    slot: s.value,
                    label: s.label,
                    hint: `从这里拖到目标节点，连出「${s.label}」分支`,
                  }))
                : [
                    {
                      slot: 'true',
                      label: '跳到',
                      hint: '从这里拖到目标节点：这一步完成后直接跳到它',
                    },
                  ]
              return (
                <g key={`ports-${n.id}`} className="wf-ports">
                  {ports.map(({ slot, label, hint }) => {
                    const p = nodePort(n, a, slot)
                    const outward = p.side === 'left' ? -1 : 1
                    return (
                      <g
                        key={slot}
                        data-wf-port={n.id}
                        data-wf-slot={slot}
                        className={
                          'wf-port wf-port--' +
                          (isCondition ? slot : 'jump') +
                          (hoverStep === n.id ? ' wf-port--on' : '')
                        }
                        onPointerDown={(e) => {
                          e.stopPropagation()
                          setBranchDrag({ fromId: n.id, slot, x: p.x, y: p.y })
                        }}
                      >
                        <title>{hint}</title>
                        <circle cx={p.x} cy={p.y} r={5} />
                        <text
                          x={p.x + outward * 8}
                          y={p.y + 3}
                          className={'wf-port__label wf-port__label--' + (isCondition ? slot : 'jump')}
                          textAnchor={outward > 0 ? 'start' : 'end'}
                        >
                          {label}
                        </text>
                      </g>
                    )
                  })}
                </g>
              )
            })}

            {/* 分支文案（普通步骤的历史遗留字段）单独一层，画在所有节点之上 ——
                SVG 后画的在上，跟连线一起画的话标签会被节点盒盖掉。 */}
            {branchEdges.map(({ from, slot, toId }) => {
              // 条件分支的「满足 / 不满足」由端口上的常驻标签承担（就写在两个尖角旁）；
              // 这里只保留普通步骤里历史遗留的条件文案
              if (from.action_kind === CONDITION_KIND) return null
              const a = pos.get(from.id)
              const b = pos.get(toId)
              if (!a || !b) return null
              const text = from.condition
              if (!text) return null
              const related = hoverStep != null && (from.id === hoverStep || toId === hoverStep)
              // 贴分支起点 30px，而不是边中点：中段可能正好穿过另一个节点
              const ends = branchAnchors(from, a, slot, b)
              const mid = edgePointFrom(
                { x1: ends.from.x, y1: ends.from.y, x2: ends.to.x, y2: ends.to.y },
                30
              )
              return (
                <text
                  key={`blabel-${from.id}-${slot}`}
                  x={mid.x}
                  y={mid.y}
                  className={
                    'wf-edge__label wf-edge__label--' + slot + (related ? ' wf-edge__label--on' : '')
                  }
                >
                  {text}
                </text>
              )
            })}

            {/* 端点手柄与删除按钮画在节点层之上 —— 手柄就在端点上，放节点下面会被盖住 */}
            {branchEdges.map(({ from, slot, toId }) => {
              if (branchHover?.id !== from.id || branchHover.slot !== slot) return null
              const a = pos.get(from.id)
              const b = pos.get(toId)
              if (!a || !b) return null
              const ends = branchAnchors(from, a, slot, b)
              const d = orthogonalPath(ends.from, ends.to)
              // 改挂手柄：贴住折线终点、沿入边法线退 8px ——
              // 正落在节点边框上会和节点抢指针，拖不动
              const normal = SIDE_NORMAL[ends.to.side]
              const hx = ends.to.x + normal.x * 8
              const hy = ends.to.y + normal.y * 8
              // 删除按钮压在折线的**弧长中点**上：连线改成正交折线之后，
              // 「两端点的中点」早就不在线上了，按钮会飘在空白处、点不到也删不掉
              const mid = edgePathMidpoint(d)
              return (
                <g key={`btools-${from.id}-${slot}`}>
                  <circle
                    className="edge-handle"
                    data-wf-handle={from.id}
                    cx={hx}
                    cy={hy}
                    r={5}
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      setBranchDrag({ fromId: from.id, slot, x: hx, y: hy })
                    }}
                  />
                  <g
                    className="edge-del"
                    data-wf-del={from.id}
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      void removeBranch(from.id, slot)
                    }}
                  >
                    <circle cx={mid.x} cy={mid.y} r={8} />
                    <path
                      d={`M${mid.x - 3.5} ${mid.y - 3.5} L${mid.x + 3.5} ${mid.y + 3.5} M${mid.x + 3.5} ${mid.y - 3.5} L${mid.x - 3.5} ${mid.y + 3.5}`}
                    />
                  </g>
                </g>
              )
            })}
            {branchDrag &&
              (() => {
                const n = ordered.find((x) => x.id === branchDrag.fromId)
                const a = n ? pos.get(n.id) : undefined
                if (!n || !a) return null
                // 预览线从真正的出线口出发（条件节点是尖角、普通步骤是右边中点）
                const p = nodePort(n, a, branchDrag.slot)
                return (
                  <line
                    className="graph__edge-drag"
                    x1={p.x}
                    y1={p.y}
                    x2={branchDrag.x}
                    y2={branchDrag.y}
                  />
                )
              })()}
            {/* 节点详情浮卡：跟随被点中的节点展开。
                展开方向由它在视图里的位置决定 —— 右边放不下就往左翻，下边放不下就上移，
                保证卡片始终留在画布内。 */}
            {selected != null &&
              !dragging &&
              (() => {
                const node = ordered.find((x) => x.id === selected)
                const p = node ? pos.get(node.id) : undefined
                if (!node || !p) return null
                const gap = 10
                // 用当前画布基准而不是写死的常量：布局会撑大基准，常量早就过时了
                const flipX = p.x + NODE_W + gap + CARD_W > canvasSize.width
                const flipY = p.y + CARD_H > canvasSize.height
                const cx = flipX ? Math.max(0, p.x - gap - CARD_W) : p.x + NODE_W + gap
                const cy = flipY ? Math.max(0, p.y + NODE_H - CARD_H) : p.y
                const idx = ordered.findIndex((x) => x.id === node.id)
                return (
                  <foreignObject x={cx} y={cy} width={CARD_W} height={CARD_H}>
                    <div className="wf-card">
                      <header className="wf-card__head">
                        <span>第 {idx + 1} 步</span>
                        <button
                          className="icon-btn"
                          aria-label="关闭详情"
                          onClick={() => setSelected(null)}
                        >
                          <X size={13} />
                        </button>
                      </header>
                      <strong className="wf-card__title">{node.title}</strong>
                      {node.detail && <p className="wf-card__detail">{node.detail}</p>}
                      {node.action_kind === CONDITION_KIND && (
                        <>
                          <p className="wf-card__detail">{describeCondition(node.action_value)}</p>
                          <p className="wf-card__detail">
                            满足 → {branchTargetLabel(node.branch_node_id)}；不满足 →{' '}
                            {branchTargetLabel(node.branch_false_node_id)}
                          </p>
                        </>
                      )}
                      {isAutoActionKind(node.action_kind) && node.action_value && (
                        <p className="wf-card__detail">
                          {normalizeActionKind(node.action_kind) === 'script'
                            ? `脚本（${scriptRuntimeLabel(node.action_runtime)}）`
                            : '命令'}
                          ：
                          {node.action_value.length > 60
                            ? node.action_value.slice(0, 60).replace(/\n/g, ' ') + '…'
                            : node.action_value}
                          {' · 期望退出码 '}
                          {node.action_expect === '' ? 0 : node.action_expect}
                        </p>
                      )}
                      <div className="wf-card__meta">
                        {node.action_kind === CONDITION_KIND ? (
                          <button className="text-btn" onClick={() => void runNodeAction(node)} title="立即求值这个条件（试跑）">
                            试跑条件
                          </button>
                        ) : isAutoActionKind(node.action_kind) ? (
                          <button
                            className="text-btn text-btn--danger"
                            title="等进程退出并核对退出码；只试跑，不影响实例状态"
                            onClick={() => void runNodeAction(node)}
                          >
                            {normalizeActionKind(node.action_kind) === 'script' ? '试跑脚本…' : '试跑命令…'}
                          </button>
                        ) : node.action_kind && node.action_kind !== 'none' && node.action_kind !== TASK_KIND ? (
                          <button className="text-btn" onClick={() => void runNodeAction(node)}>
                            执行动作
                          </button>
                        ) : (
                          <span className="u-aux">人工任务</span>
                        )}
                        <button className="text-btn" onClick={() => openEditNode(node)}>
                          编辑
                        </button>
                      </div>
                    </div>
                  </foreignObject>
                )
              })()}
          </svg>
          <p className="u-aux">
            点节点看详情（卡片跟随节点展开）、双击编辑；拖动节点改布局（自动保存）。
            画布空白处拖动可平移、滚轮缩放。条件节点下方写着判定内容，两个端口分别连出
            「满足 / 不满足」分支：从端口拖到目标节点即连线；鼠标移到分支线上可删除或拖动端点改挂。
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
            onSave={(node, asBranch) => void handleSaveNode(node, asBranch)}
            onCancel={closeNodeDialog}
          />
        ))}
      </div>
    </div>
  )
}
