import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, Maximize2, Play, Plus, Trash2, X } from 'lucide-react'
import type {
  WorkflowInstancePayload,
  WorkflowNodePayload,
  WorkflowTemplatePayload,
  WorkflowTemplateSummary,
} from '@shared/types'
import { subscribeDomain } from '@shared/events'
import { t } from '../i18n'
import { useDialog } from '../components/Dialogs'
import { usePanZoom } from '../lib/usePanZoom'
import { edgePath } from '../lib/edge-path'

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

/** 没有持久化坐标时按执行顺序横向排布。 */
function layoutOf(nodes: WorkflowNodePayload[]): Map<number, { x: number; y: number }> {
  const ordered = [...nodes].sort(
    (a, b) => (a.order_index || 0) - (b.order_index || 0) || a.id - b.id
  )
  const map = new Map<number, { x: number; y: number }>()
  ordered.forEach((n, i) => {
    map.set(n.id, {
      x: n.pos_x ?? 60 + i * 190,
      y: n.pos_y ?? 120 + (i % 2) * 130,
    })
  })
  return map
}

export function WorkflowPage({ onNotice, onChanged }: Props) {
  const dialog = useDialog()
  const [templates, setTemplates] = useState<WorkflowTemplateSummary[]>([])
  const [current, setCurrent] = useState<WorkflowTemplatePayload | null>(null)
  const [instances, setInstances] = useState<WorkflowInstancePayload[]>([])
  const [pos, setPos] = useState<Map<number, { x: number; y: number }>>(new Map())
  const [selected, setSelected] = useState<number | null>(null)
  const [editing, setEditing] = useState<WorkflowNodePayload | null>(null)
  const dragRef = useRef<{ id: number; dx: number; dy: number } | null>(null)
  /** 悬停的分支连线（用源步骤 id 标识），以及正在改挂的那一条 */
  const [branchHover, setBranchHover] = useState<number | null>(null)
  /** 鼠标悬浮的步骤：与它相连的连线高亮、其余淡到几乎隐形（与知识图谱同一套交互） */
  const [hoverStep, setHoverStep] = useState<number | null>(null)
  const [branchDrag, setBranchDrag] = useState<{ fromId: number; x: number; y: number } | null>(null)
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
    setPos(tpl ? layoutOf(tpl.nodes) : new Map())
    setSelected(null)
  }, [])

  useEffect(() => {
    void (async () => {
      const rows = await loadTemplates()
      if (rows.length) await openTemplate(rows[0].id)
      await loadInstances()
    })()
  }, [loadTemplates, openTemplate, loadInstances])

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
    if (!drag) return
    const p = pos.get(drag.id)
    if (p) await window.zhixing.db.updateWorkflowNodePos(drag.id, Math.round(p.x), Math.round(p.y))
  }

  // 画布级平移 / 缩放：拖背景平移、滚轮以光标为中心缩放；非平移时的移动转给节点拖拽
  const pan = usePanZoom({
    baseW: CANVAS_W,
    baseH: CANVAS_H,
    onMove,
    onEnd: (e) => void endDrag(e),
  })
  panRef.current = pan

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

  const handleAddStep = async (): Promise<void> => {
    if (!current) return
    const res = await window.zhixing.db.saveWorkflowTemplate({
      id: current.id,
      name: current.name,
      description: current.description,
      start_policy: current.start_policy,
      nodes: [
        ...ordered.map((n) => ({
          id: n.id,
          title: n.title,
          detail: n.detail,
          order_index: n.order_index,
          note_id: n.note_id,
          action_kind: n.action_kind,
          action_value: n.action_value,
          condition: n.condition,
          branch_node_id: n.branch_node_id,
          pos_x: pos.get(n.id)?.x ?? null,
          pos_y: pos.get(n.id)?.y ?? null,
        })),
        { title: `第 ${ordered.length + 1} 步`, order_index: ordered.length },
      ],
    })
    if (!res.ok) onNotice(`保存失败：${res.problems.join('；')}`)
    await refresh()
  }

  const handleSaveNode = async (node: WorkflowNodePayload): Promise<void> => {
    if (!current) return
    const res = await window.zhixing.db.saveWorkflowTemplate({
      id: current.id,
      name: current.name,
      description: current.description,
      start_policy: current.start_policy,
      nodes: ordered.map((n) => ({
        id: n.id,
        title: n.id === node.id ? node.title : n.title,
        detail: n.id === node.id ? node.detail : n.detail,
        order_index: n.order_index,
        note_id: n.id === node.id ? node.note_id : n.note_id,
        action_kind: n.id === node.id ? node.action_kind : n.action_kind,
        action_value: n.id === node.id ? node.action_value : n.action_value,
        condition: n.id === node.id ? node.condition : n.condition,
        branch_node_id: n.id === node.id ? node.branch_node_id : n.branch_node_id,
        pos_x: pos.get(n.id)?.x ?? null,
        pos_y: pos.get(n.id)?.y ?? null,
      })),
    })
    if (!res.ok) {
      onNotice(`保存失败：${res.problems.join('；')}`)
      return
    }
    setEditing(null)
    await refresh()
    onNotice('步骤已保存')
  }

  /** 执行节点动作；RUN_COMMAND 有副作用，执行前必须二次确认。 */
  const runNodeAction = async (n: WorkflowNodePayload): Promise<void> => {
    const kind = n.action_kind
    if (!kind || kind === 'none') return
    if (kind === 'run_command') {
      const desc = await window.zhixing.db.describeWorkflowAction(kind, n.action_value)
      if (!window.confirm(`即将在本机运行命令：\n\n${desc}\n\n确定执行？`)) return
    }
    const res = await window.zhixing.db.runWorkflowAction(kind, n.action_value)
    onNotice(res.message)
    if (res.ok && kind === 'open_note') {
      const id = Number(n.action_value)
      if (Number.isFinite(id) && id > 0) {
        window.dispatchEvent(new CustomEvent('zhixing:open-note', { detail: id }))
      }
    }
  }

  const handleInstantiate = async (): Promise<void> => {
    if (!current) return
    const inst = await window.zhixing.db.instantiateWorkflow(current.id, null, null)
    if (!inst) {
      onNotice('该模板没有可运行的步骤')
      return
    }
    onNotice(`已启动「${inst.title}」`)
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
      <div className="page__head">
        <h1 className="page__title">{t('page.workflow')}</h1>
        <p className="page__subtitle">{t('page.workflow.sub')}</p>
      </div>
      <div className="page__body">
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
                </span>
              </div>
            ))}
            {instances.length === 0 && <p className="u-aux">还没有运行中的实例。</p>}
          </div>
        </aside>

        <div className="wf-main">
          <div className="tasks-toolbar">
            <span className="u-aux">
              {current ? `${current.name} · ${ordered.length} 步` : '未选择模板'}
            </span>
            <div className="tasks-toolbar__right">
              <button className="text-btn" onClick={() => void handleAddStep()} disabled={!current}>
                <Plus size={13} /> 加一步
              </button>
              <button className="text-btn" onClick={pan.reset}>
                <Maximize2 size={13} /> 重置视图
              </button>
              <button className="text-btn text-btn--accent" onClick={() => void handleInstantiate()} disabled={!current}>
                <Play size={13} /> 启动实例
              </button>
              <button className="text-btn text-btn--danger" onClick={() => void handleDeleteTemplate()} disabled={!current}>
                <Trash2 size={13} /> 删除
              </button>
            </div>
          </div>

          {instance && (
            <div className="wf-progress">
              <GitBranch size={14} />
              <strong>{instance.title}</strong>
              <span className="u-aux">
                {instance.steps.filter((s) => s.done).length}/{instance.steps.length} 步完成
              </span>
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
                    d={edgePath({
                      x1: a.x + NODE_W / 2,
                      y1: a.y + NODE_H,
                      x2: b.x + NODE_W / 2,
                      y2: b.y
                    })}
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
              const x1 = a.x + NODE_W
              const y1 = a.y + NODE_H / 2
              const x2 = b.x
              const y2 = b.y + NODE_H / 2
              const d = edgePath({ x1, y1, x2, y2 })
              const related = hoverStep != null && (n.id === hoverStep || n.branch_node_id === hoverStep)
              const dim = stepFocusSet != null && !related
              return (
                <g key={`branch-${n.id}`} className={dim ? 'is-dimmed' : undefined}>
                  <path
                    d={d}
                    markerEnd={related ? 'url(#wf-arrow-on)' : 'url(#wf-arrow)'}
                    className={'wf-edge wf-edge--branch' + (related ? ' wf-edge--on' : '')}
                  />
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
                  onDoubleClick={() => setEditing(n)}
                  role="button"
                  aria-label={`步骤 ${i + 1}：${n.title}`}
                  tabIndex={0}
                >
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
                  <text x={10} y={20} className="wf-node__idx">
                    第 {i + 1} 步
                  </text>
                  <text x={10} y={40} className="wf-node__title">
                    {n.title.length > 10 ? n.title.slice(0, 10) + '…' : n.title}
                  </text>
                </g>
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
              (() => {
                const node = ordered.find((x) => x.id === selected)
                const p = node ? pos.get(node.id) : undefined
                if (!node || !p) return null
                const gap = 10
                const flipX = p.x + NODE_W + gap + CARD_W > CANVAS_W
                const flipY = p.y + CARD_H > CANVAS_H
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
                      <div className="wf-card__meta">
                        {node.action_kind && node.action_kind !== 'none' ? (
                          <button
                            className={
                              node.action_kind === 'run_command' ? 'text-btn text-btn--danger' : 'text-btn'
                            }
                            onClick={() => void runNodeAction(node)}
                          >
                            {node.action_kind === 'run_command' ? '执行命令…' : '执行动作'}
                          </button>
                        ) : (
                          <span className="u-aux">无动作</span>
                        )}
                        <button className="text-btn" onClick={() => setEditing(node)}>
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

      {editing && (
        <div className="modal-mask" onMouseDown={() => setEditing(null)}>
          <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
            <header className="modal__head">
              <h2>编辑步骤 #{editing.id}</h2>
            </header>
            <div className="modal__body">
              <label className="form-row">
                <span>标题</span>
                <input
                  className="field"
                  value={editing.title}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                />
              </label>
              <label className="form-row">
                <span>详情</span>
                <textarea
                  className="field field--area"
                  rows={4}
                  value={editing.detail}
                  onChange={(e) => setEditing({ ...editing, detail: e.target.value })}
                />
              </label>
              <div className="form-grid">
                <label className="form-row">
                  <span>动作</span>
                  <select
                    className="field"
                    value={editing.action_kind}
                    onChange={(e) => setEditing({ ...editing, action_kind: e.target.value })}
                  >
                    <option value="none">无</option>
                    <option value="open_url">打开网址</option>
                    <option value="run_command">执行命令</option>
                    <option value="open_note">打开笔记</option>
                  </select>
                </label>
                <label className="form-row">
                  <span>动作值</span>
                  <input
                    className="field"
                    value={editing.action_value}
                    onChange={(e) => setEditing({ ...editing, action_value: e.target.value })}
                  />
                </label>
              </div>
              <label className="form-row">
                <span>进入条件（自由文本，供人工判断）</span>
                <input
                  className="field"
                  value={editing.condition}
                  onChange={(e) => setEditing({ ...editing, condition: e.target.value })}
                />
              </label>
              <label className="form-row">
                <span>条件分支到</span>
                <select
                  className="field"
                  value={editing.branch_node_id ?? ''}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      branch_node_id: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                >
                  <option value="">不分支（按顺序走下一步）</option>
                  {ordered
                    .filter((n) => n.id !== editing.id)
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.title}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <footer className="modal__foot">
              <span className="modal__spacer" />
              <button className="text-btn" onClick={() => setEditing(null)}>取消</button>
              <button className="text-btn text-btn--accent" onClick={() => void handleSaveNode(editing)}>
                保存
              </button>
            </footer>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
