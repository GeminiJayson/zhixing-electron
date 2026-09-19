import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Diamond,
  GitBranch,
  LayoutGrid,
  Maximize2,
  Pencil,
  Play,
  Plus,
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
} from '@shared/workflow-action'
import { t } from '../i18n'
import { Toolbar } from '../components/Toolbar'
import { WorkflowStepDialog } from '../components/WorkflowStepDialog'
import { WorkflowConditionDialog } from '../components/WorkflowConditionDialog'
import { useDialog } from '../components/Dialogs'
import { usePanZoom } from '../lib/usePanZoom'
import { edgePointFrom, elbowPath } from '../lib/edge-path'
import {
  edgeAnchors,
  layoutBounds,
  layoutWorkflow,
  type WorkflowRankDir,
} from '../lib/workflow-layout'

interface Props {
  onNotice: (message: string) => void
  onChanged: () => Promise<void>
}

const NODE_W = 150
const NODE_H = 56
/** 画布基准坐标系（viewBox 与 panzoom 共用同一套尺寸）。 */
const CANVAS_W = 900
const CANVAS_H = 520
/** 节点详情浮卡尺寸 */
const CARD_W = 236
const CARD_H = 168
/** 步骤编辑弹窗里「SOP 文档」下拉最多列出的笔记数（对齐 note_choices 的 recent(200)） */
const NOTE_CHOICE_LIMIT = 200

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
  const [canvasSize, setCanvasSize] = useState({ width: CANVAS_W, height: CANVAS_H })
  const [editing, setEditing] = useState<WorkflowNodePayload | null>(null)
  /** editing 是否为「新增步骤」（决定保存时插到选中节点之后，而不是原位替换） */
  const [editingNew, setEditingNew] = useState(false)
  /** 新增步骤时是否设为选中节点的条件分支（对齐 _StepEditDialog 的 branch_check） */
  /** 正在编辑的是条件节点还是普通步骤 —— 渲染哪个编辑弹窗由它决定 */
  const editingIsCondition = editing?.action_kind === CONDITION_KIND
  /** 步骤可绑定的 SOP 笔记（对齐 note_choices：recent(200) 的 id/标题） */
  const [noteChoices, setNoteChoices] = useState<Note[]>([])
  const dragRef = useRef<{ id: number; dx: number; dy: number } | null>(null)
  /** 悬停的分支连线（用源步骤 id 标识），以及正在改挂的那一条 */
  const [branchHover, setBranchHover] = useState<number | null>(null)
  /** 鼠标悬浮的步骤：与它相连的连线高亮、其余淡到几乎隐形（与知识图谱同一套交互） */
  const [hoverStep, setHoverStep] = useState<number | null>(null)
  const [branchDrag, setBranchDrag] = useState<{ fromId: number; x: number; y: number } | null>(null)
  /**
   * 正在拖动节点。拖动期间不渲染详情浮卡 —— 浮卡画在 foreignObject 里，
   * 节点移动时它的坐标更新了但不会重绘，会在原地留下一张「拖影」。
   */
  const [dragging, setDragging] = useState(false)
  // 画布视图（平移 / 缩放）。startDrag 定义在 hook 之前，用这个 ref 桥接。
  const panRef = useRef<ReturnType<typeof usePanZoom> | null>(null)

  const loadTemplates = useCallback(async () => {
    const rows = await window.zhixing.db.workflowTemplates()
    setTemplates(rows)
    return rows
  }, [])

  const loadInstances = useCallback(async () => {
    setInstances(await window.zhixing.db.workflowInstances())
  }, [])

  const openTemplate = useCallback(async (id: number) => {
    const tpl = await window.zhixing.db.workflowTemplate(id)
    setCurrent(tpl)
    const layout = tpl ? layoutOf(tpl.nodes, rankdir) : new Map()
    setPos(layout)
    setCanvasSize(canvasBoundsOf(layout))
    setSelected(null)
  }, [rankdir])

  useEffect(() => {
    void (async () => {
      const rows = await loadTemplates()
      if (rows.length) await openTemplate(rows[0].id)
      await loadInstances()
    })()
  }, [loadTemplates, openTemplate, loadInstances])

  // SOP 文档候选：与 Python 的 note_choices 同口径（近期笔记，最多 200 条）
  useEffect(() => {
    void (async () => {
      try {
        setNoteChoices(await window.zhixing.db.recentNotes(NOTE_CHOICE_LIMIT))
      } catch {
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
        if (n.branch_node_id) set.add(n.branch_node_id)
      }
      // 别人分支指向我，同样算直接相连
      if (n.branch_node_id === hoverStep) set.add(n.id)
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
    dragRef.current = { id: n.id, dx: world.x - p.x, dy: world.y - p.y }
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
   * 删除分支连线：清空该步骤的分支目标。
   * 顺序连线（相邻步骤的实线）是 order_index 的投影、没有独立实体，所以不在编辑范围。
   */
  const removeBranch = async (fromId: number): Promise<void> => {
    await window.zhixing.db.setWorkflowBranch(fromId, null)
    setBranchHover(null)
    onNotice('已删除该分支连线')
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
    await window.zhixing.db.setWorkflowBranch(drag.fromId, targetId)
    const label = ordered.find((n) => n.id === targetId)?.title ?? ''
    onNotice(`已把分支改挂到「${label}」`)
    await refresh()
  }

  /** 拖动结束才落库（对齐 silent 保存，避免每帧写库）。 */
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
    if (p) await window.zhixing.db.updateWorkflowNodePos(drag.id, Math.round(p.x), Math.round(p.y))
  }

  // 画布级平移 / 缩放：拖背景平移、滚轮以光标为中心缩放；非平移时的移动转给节点拖拽
  const pan = usePanZoom({
    baseW: canvasSize.width,
    baseH: canvasSize.height,
    onMove,
    onEnd: (e) => void endDrag(e),
  })
  panRef.current = pan

  // 基准尺寸一变（打开模板 / 自动布局 / 切方向）就适配一次视图。
  // 不能直接在 handleAutoLayout 里调 pan.reset()：那时 setCanvasSize 尚未生效，
  // reset 用的是旧基准，视图会缩在角落（实测横向布局后节点全挤在右上角）。
  useEffect(() => {
    panRef.current?.reset()
  }, [canvasSize])

  const handleNewTemplate = async (): Promise<void> => {
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
    await loadTemplates()
    if (res.templateId) await openTemplate(res.templateId)
    onNotice(`已创建「${name.trim()}」`)
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
      condition: n.condition,
      branch_node_id: n.branch_node_id,
      pos_x: pos.get(n.id)?.x ?? n.pos_x ?? null,
      pos_y: pos.get(n.id)?.y ?? n.pos_y ?? null,
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

  /** I14 复制一份（对齐 duplicate_template）：名称加「 副本」，节点整体复制、不复制坐标。 */
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

  /** I15 重命名模板（对齐 _rename_template_by_id：改名后整体保存）。 */
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

  /** I16 启动策略可编辑（对齐 _on_policy_changed：改完立即保存）。 */
  const handlePolicyChange = async (policy: string): Promise<void> => {
    if (!current) return
    await persistTemplate(ordered, { start_policy: policy })
  }

  /** I17 删除选中步骤（对齐 _delete_step：删后按顺序整体重排 order_index）。 */
  const handleDeleteStep = async (): Promise<void> => {
    if (!current || selected == null) return
    const rest = ordered
      .filter((n) => n.id !== selected)
      .map((n, i) => ({ ...n, order_index: i }))
    if (!rest.length) {
      onNotice('至少要保留一个步骤')
      return
    }
    if (!window.confirm('删除选中的步骤？')) return
    setSelected(null)
    await persistTemplate(rest)
  }

  /** I17 上移 / 下移（对齐 _move_step：交换后整体重排 order_index）。 */
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
    for (const [id, p] of next) await window.zhixing.db.updateWorkflowNodePos(id, p.x, p.y)
    await refresh()
    setPos(next)
    // 只改基准：适配视图由上面那个 effect 统一做（它等得到新基准）
    setCanvasSize(canvasBoundsOf(next))
    onNotice(dir === 'TB' ? '已按依赖关系纵向分层排布' : '已按依赖关系横向分层排布')
  }

  const handleDeleteTemplate = async (): Promise<void> => {
    if (!current) return
    if (!window.confirm(`删除工作流「${current.name}」及其节点？`)) return
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
   * I18 加一步 / 加条件：先弹步骤编辑窗，保存时**插到选中节点之后**（未选中则追加末尾），
   * 并可勾选「作为选中节点的条件分支」（对齐 _add_step 的 dlg + as_branch）。
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
      condition: '',
      branch_node_id: null,
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

  const handleSaveNode = async (node: WorkflowNodePayload, asBranch: boolean): Promise<void> => {
    if (!current) return
    if (!node.title.trim()) {
      onNotice('请填写步骤标题')
      return
    }
    if (editingNew) {
      const list = [...ordered]
      const selIdx = selected != null ? list.findIndex((n) => n.id === selected) : -1
      if (selIdx >= 0) list.splice(selIdx + 1, 0, node)
      else list.push(node)
      // 勾了「设为分支」才把选中节点的 branch 指到新节点（对齐 _add_step）
      const linked =
        asBranch && selIdx >= 0
          ? list.map((n) => (n.id === selected ? { ...n, branch_node_id: node.id } : n))
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
      const desc = await window.zhixing.db.describeWorkflowAction(kind, n.action_value, n.action_expect)
      const wait = isAutoActionKind(kind) ? '\n\n这一步会等进程结束并核对退出码。' : ''
      if (!window.confirm(`即将在本机执行：\n\n${desc}${wait}\n\n确定执行？`)) return
    }
    const res = await window.zhixing.db.runWorkflowAction(kind, n.action_value, n.action_expect)
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
    // 与 Python 一样把当前启动策略显式传给实例化（不依赖库里的旧值）
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
    if (!window.confirm('中止这个实例？已下发的步骤任务会保留。')) return
    await window.zhixing.db.abortWorkflowInstance(instance.id)
    await refresh()
  }

  return (
    <div className="page page--workflow">
      <div className="page__body">
  <Toolbar
    title={t('page.workflow')}
    subtitle={t('page.workflow.sub')}
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
        title="新增条件节点：到点自动求值（不建任务），成立走条件分支、不成立走下一步"
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

      <div className="wf-wrap">
        <aside className="wf-side" aria-label="模板与实例">
          <div className="wf-side__head">
            <span>模板</span>
            <button className="icon-btn" title="新建工作流" aria-label="新建工作流" onClick={() => void handleNewTemplate()}>
              <Plus size={15} />
            </button>
          </div>
          <div className="wf-list">
            {templates.map((t) => (
              <button
                key={t.id}
                className={'wf-item' + (current?.id === t.id ? ' wf-item--on' : '')}
                onClick={() => void openTemplate(t.id)}
              >
                <strong>{t.name}</strong>
                <span className="u-aux">{t.node_count} 步 · {t.start_policy === 'all' ? '一次全下发' : '逐步下发'}</span>
              </button>
            ))}
            {templates.length === 0 && <p className="u-aux">还没有工作流模板。</p>}
          </div>

          <div className="wf-side__head">实例</div>
          <div className="wf-list">
            {instances.map((i) => (
              <div key={i.id} className="wf-item wf-item--static">
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
            ))}
            {instances.length === 0 && <p className="u-aux">还没有运行中的实例。</p>}
          </div>
        </aside>

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
            {/* 顺序连线 + 条件分支（分支用虚线区分） */}
            {ordered.map((n, i) => {
              const a = pos.get(n.id)
              const nxt = ordered[i + 1]
              const b = nxt ? pos.get(nxt.id) : undefined
              if (!a || !b) return null
              const related = hoverStep != null && (n.id === hoverStep || nxt.id === hoverStep)
              const dim = stepFocusSet != null && !related
              return (
                <g key={`seq-${n.id}`} className={'wf-edge-group' + (dim ? ' is-dimmed' : '')}>
                  <path
                    d={elbowPath(edgeAnchors(a, b, NODE_W, NODE_H))}
                    markerEnd={related ? 'url(#wf-arrow-on)' : 'url(#wf-arrow)'}
                    className={'wf-edge' + (related ? ' wf-edge--on' : '')}
                  />
                </g>
              )
            })}
            {ordered.map((n) => {
              if (!n.branch_node_id) return null
              const a = pos.get(n.id)
              const b = pos.get(n.branch_node_id)
              if (!a || !b) return null
              const anchors = edgeAnchors(a, b, NODE_W, NODE_H)
              const d = elbowPath(anchors)
              const related = hoverStep != null && (n.id === hoverStep || n.branch_node_id === hoverStep)
              const dim = stepFocusSet != null && !related
              return (
                <g key={`branch-${n.id}`} className={dim ? 'is-dimmed' : undefined}>
                  <path
                    d={d}
                    markerEnd={related ? 'url(#wf-arrow-on)' : 'url(#wf-arrow)'}
                    className={'wf-edge wf-edge--branch' + (related ? ' wf-edge--on' : '')}
                  />
                  {/* 条件文案不在这里画：它得在所有节点之上，见下面的「分支标签层」 */}
                  {/* 热区复用图谱那边的透明粗线：1px 的线本身点不到 */}
                  <path
                    d={d}
                    className="graph__edge-hit"
                    onPointerEnter={() => setBranchHover(n.id)}
                    onPointerLeave={() => setBranchHover((h) => (h === n.id ? null : h))}
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
                  aria-label={`步骤 ${i + 1}：${n.title}`}
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
                </g>
              )
            })}

            {/* 分支条件标签单独一层，画在所有节点之上。
                原先它跟连线一起画，而节点在其后渲染 —— SVG 后画的在上，标签会被节点盒
                盖掉（实测「资料不全」只露出一个字）。虚线只说明「这是条件分支」，
                不把条件写出来就不知道什么情况下走它，所以这句必须看得见。 */}
            {ordered.map((n) => {
              if (!n.branch_node_id || !n.condition) return null
              const a = pos.get(n.id)
              const b = pos.get(n.branch_node_id)
              if (!a || !b) return null
              const related = hoverStep != null && (n.id === hoverStep || n.branch_node_id === hoverStep)
              // 贴分支起点 30px，而不是边中点：中段可能正好穿过另一个节点
              const mid = edgePointFrom(edgeAnchors(a, b, NODE_W, NODE_H), 30)
              return (
                <text
                  key={`blabel-${n.id}`}
                  x={mid.x}
                  y={mid.y}
                  className={'wf-edge__label' + (related ? ' wf-edge__label--on' : '')}
                >
                  {n.condition}
                </text>
              )
            })}

            {/* 端点手柄与删除按钮画在节点层之上 —— 手柄就在端点上，放节点下面会被盖住 */}
            {ordered.map((n) => {
              if (branchHover !== n.id || !n.branch_node_id) return null
              const a = pos.get(n.id)
              const b = pos.get(n.branch_node_id)
              if (!a || !b) return null
              // 手柄退到节点外侧一点：正落在节点边框上会和节点抢指针，拖不动
              const x2 = b.x - 8
              const y2 = b.y + NODE_H / 2
              const mx = (a.x + NODE_W + x2) / 2
              const my = (a.y + NODE_H / 2 + y2) / 2
              return (
                <g key={`btools-${n.id}`}>
                  <circle
                    className="edge-handle"
                    cx={x2}
                    cy={y2}
                    r={5}
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      setBranchDrag({ fromId: n.id, x: x2, y: y2 })
                    }}
                  />
                  <g
                    className="edge-del"
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      void removeBranch(n.id)
                    }}
                  >
                    <circle cx={mx} cy={my} r={8} />
                    <path
                      d={`M${mx - 3.5} ${my - 3.5} L${mx + 3.5} ${my + 3.5} M${mx + 3.5} ${my - 3.5} L${mx - 3.5} ${my + 3.5}`}
                    />
                  </g>
                </g>
              )
            })}
            {branchDrag &&
              (() => {
                const n = ordered.find((x) => x.id === branchDrag.fromId)
                const a = n ? pos.get(n.id) : undefined
                if (!a) return null
                return (
                  <line
                    className="graph__edge-drag"
                    x1={a.x + NODE_W}
                    y1={a.y + NODE_H / 2}
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
                        <p className="wf-card__detail">{describeCondition(node.action_value)}</p>
                      )}
                      {isAutoActionKind(node.action_kind) && node.action_value && (
                        <p className="wf-card__detail">
                          {normalizeActionKind(node.action_kind) === 'script' ? '脚本' : '命令'}：
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
            画布空白处拖动可平移、滚轮缩放；鼠标移到分支虚线上可删除或拖动端点改挂。
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
            onSave={(node) => void handleSaveNode(node, false)}
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
