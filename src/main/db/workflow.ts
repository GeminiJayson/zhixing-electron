import { nextSortKey } from './tasks'
import { setTaskTags } from './task-ops'
import { getNote } from './notes'
import { openExternalSafely } from '../security'
import { spawn } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, dialog } from 'electron'
import type {
  NodeRunResult,
  WorkflowInstancePayload,
  WorkflowNodePayload,
  WorkflowStepPayload,
  WorkflowTemplatePayload,
  WorkflowTemplateSummary,
} from '../../shared/types'
import { conn, nowStamp } from './connection'
import {
  CONDITION_KIND,
  describeCondition,
  judgePrevResult,
  parseCondition,
  type ConditionConfig,
} from '../../shared/workflow-condition'
import {
  COMMAND_KIND,
  SCRIPT_KIND,
  TASK_KIND,
  isAutoActionKind,
  normalizeActionKind,
  normalizeScriptRuntime,
  parseExpectCode,
  scriptRuntimeLabel,
  type ScriptRuntime,
} from '../../shared/workflow-action'

// ---------------------------------------------------------------- 工作流

export const NODE_COLUMNS =
  'id, template_id, title, detail, order_index, note_id, note_ids, action_kind, action_value, action_expect, action_runtime, condition, branch_node_id, pos_x, pos_y'

/** workflow_node 的原始行（note_ids 是 JSON 文本，不是数组）。 */
interface WorkflowNodeRow extends Omit<WorkflowNodePayload, 'note_ids'> {
  note_ids: string | null
}

/**
 * SOP 绑定归一：note_ids（JSON 数组）优先，为空则回退到遗留的单值 note_id。
 * 两条路都读，是为了让「旧模板只有一个绑定」与「新模板绑了多条」用同一份逻辑渲染。
 */
export function parseNoteIds(raw: string | null | undefined, fallback: number | null): number[] {
  let ids: number[] = []
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        ids = parsed
          .map((v) => Number(v))
          .filter((n) => Number.isFinite(n) && n > 0)
      }
    } catch {
      // 坏 JSON 当没绑（不影响模板其余字段可用）
    }
  }
  if (!ids.length && fallback) ids = [fallback]
  return [...new Set(ids)]
}

/** 行 → payload：把 note_ids 从 JSON 文本解析成数组。 */
export function rowToNode(r: WorkflowNodeRow): WorkflowNodePayload {
  const note_ids = parseNoteIds(r.note_ids, r.note_id)
  return {
    ...r,
    note_ids,
    action_expect: r.action_expect ?? '',
    action_runtime: r.action_runtime ?? '',
  }
}


/** 按 order_index 升序、其次 id（对齐 WorkflowTemplate.ordered_nodes）。 */
export const orderedNodes = (nodes: WorkflowNodePayload[]): WorkflowNodePayload[] =>
  [...nodes].sort((a, b) => (a.order_index || 0) - (b.order_index || 0) || a.id - b.id)

/**
 * 某节点的下一步：优先条件分支，否则按顺序取下一个；
 * nodeId 为空时回到第一步（对齐 WorkflowTemplate.next_node）。
 */
export function nextWorkflowNode(
  nodes: WorkflowNodePayload[],
  nodeId: number | null
): WorkflowNodePayload | null {
  const ordered = orderedNodes(nodes)
  if (nodeId == null) return ordered[0] ?? null
  const idx = ordered.findIndex((n) => n.id === nodeId)
  if (idx < 0) return null
  const cur = ordered[idx]
  if (cur.branch_node_id) {
    const branched = ordered.find((n) => n.id === cur.branch_node_id)
    if (branched) return branched
  }
  return ordered[idx + 1] ?? null
}

/** 拓扑校验，逐条对齐 WorkflowTemplate.validate；返回问题列表（空 = 可保存）。 */
export function validateWorkflowTemplate(nodes: WorkflowNodePayload[]): string[] {
  const problems: string[] = []
  const ordered = orderedNodes(nodes)
  if (ordered.length === 0) return ['工作流至少要有一个步骤']
  const ids = new Set(ordered.map((n) => n.id))
  ordered.forEach((n, i) => {
    if (!(n.title || '').trim()) problems.push(`第 ${i + 1} 个步骤缺少标题`)
    if (n.branch_node_id != null) {
      if (n.branch_node_id === n.id) problems.push(`步骤「${n.title}」的分支不能指向自己`)
      else if (!ids.has(n.branch_node_id)) problems.push(`步骤「${n.title}」的分支指向了不存在的步骤`)
    }
  })

  // 条件分支环检测（只沿 branch 边走）
  const branch = new Map<number, number>()
  for (const n of ordered) if (n.branch_node_id) branch.set(n.id, n.branch_node_id)
  for (const start of branch.keys()) {
    const seen = new Set<number>()
    let cur: number | undefined = start
    while (cur !== undefined && branch.has(cur)) {
      if (seen.has(cur)) {
        problems.push('步骤的条件分支形成了环，实例将无法结束')
        return problems
      }
      seen.add(cur)
      cur = branch.get(cur)
    }
  }
  return problems
}

export function listWorkflowTemplates(): WorkflowTemplateSummary[] {
  return conn()
    .prepare(
      `SELECT t.id, t.name, t.description, t.start_policy, t.updated_at,
              (SELECT COUNT(*) FROM workflow_node n WHERE n.template_id = t.id) AS node_count
         FROM workflow_template t ORDER BY t.updated_at DESC, t.id DESC`
    )
    .all() as WorkflowTemplateSummary[]
}

export function getWorkflowTemplate(id: number): WorkflowTemplatePayload | null {
  const c = conn()
  const t = c
    .prepare('SELECT id, name, description, start_policy FROM workflow_template WHERE id = ?')
    .get(id) as Omit<WorkflowTemplatePayload, 'nodes'> | undefined
  if (!t) return null
  const rows = c
    .prepare(`SELECT ${NODE_COLUMNS} FROM workflow_node WHERE template_id = ?`)
    .all(id) as WorkflowNodeRow[]
  return { ...t, nodes: rows.map(rowToNode) }
}

/**
 * 保存模板（节点整体替换）。校验不过返回 problems 且不落库，
 * 避免存下无法运行的流程（对齐 save_template 的拒绝语义）。
 */
export function saveWorkflowTemplate(tpl: {
  id?: number | null
  name: string
  description?: string
  start_policy?: string
  nodes: { id?: number | null; title: string; detail?: string; order_index?: number; note_id?: number | null; note_ids?: number[]; action_kind?: string; action_value?: string; action_expect?: string; action_runtime?: string; condition?: string; branch_node_id?: number | null; pos_x?: number | null; pos_y?: number | null }[]
}): { ok: boolean; problems: string[]; templateId?: number } {
  const draft: WorkflowNodePayload[] = tpl.nodes.map((n, i) => {
    // SOP 多绑定的唯一真相是 note_ids；note_id 只作为兼容列同步写出（Python 版仍按单值读）
    const noteIds = parseNoteIds(
      n.note_ids ? JSON.stringify(n.note_ids) : null,
      n.note_id ?? null
    )
    return {
      id: n.id ?? -(i + 1), // 新节点用负临时 id，供分支引用重映射
      template_id: tpl.id ?? 0,
      title: n.title ?? '',
      detail: n.detail ?? '',
      order_index: n.order_index || i,
      note_id: noteIds[0] ?? null,
      note_ids: noteIds,
      action_kind: n.action_kind ?? TASK_KIND,
      action_value: n.action_value ?? '',
      action_expect: n.action_expect ?? '',
      action_runtime: n.action_runtime ?? '',
      condition: n.condition ?? '',
      branch_node_id: n.branch_node_id ?? null,
      pos_x: n.pos_x ?? null,
      pos_y: n.pos_y ?? null,
    }
  })
  const problems = validateWorkflowTemplate(draft)
  if (problems.length) return { ok: false, problems }

  const c = conn()
  // 对齐 Python save_template：更新一个不存在的模板时返回失败而**不是抛异常**
  // （Python 返回 None，页面按「保存失败：problems」提示；抛异常会让 IPC reject，
  // 渲染层拿不到 problems，只能看到一个未捕获的 Promise 拒绝）。
  if (tpl.id) {
    const exists = c.prepare('SELECT id FROM workflow_template WHERE id = ?').get(tpl.id)
    if (!exists) return { ok: false, problems: ['模板不存在或已被删除'] }
  }
  const stamp = nowStamp()
  const run = c.transaction(() => {
    let tid = tpl.id ?? 0
    if (tid) {
      c.prepare('UPDATE workflow_template SET name = ?, description = ?, start_policy = ?, updated_at = ? WHERE id = ?').run(
        tpl.name, tpl.description ?? '', tpl.start_policy ?? 'first', stamp, tid
      )
    } else {
      const info = c
        .prepare(
          'INSERT INTO workflow_template (name, description, start_policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(tpl.name, tpl.description ?? '', tpl.start_policy ?? 'first', stamp, stamp)
      tid = Number(info.lastInsertRowid)
    }
    // 节点整体替换：模板规模小，删旧插新比增量 diff 更可靠
    c.prepare('DELETE FROM workflow_node WHERE template_id = ?').run(tid)
    const idMap = new Map<number, number>()
    const inserted: { rowId: number; oldId: number; raw: (typeof draft)[number] }[] = []
    for (const n of draft) {
      const info = c
        .prepare(
          `INSERT INTO workflow_node (template_id, title, detail, order_index, note_id, note_ids, action_kind,
                                     action_value, action_expect, action_runtime, condition, pos_x, pos_y, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          tid,
          n.title,
          n.detail,
          n.order_index,
          n.note_id,
          n.note_ids.length ? JSON.stringify(n.note_ids) : null,
          n.action_kind,
          n.action_value,
          n.action_expect,
          n.action_runtime,
          n.condition,
          n.pos_x,
          n.pos_y,
          stamp
        )
      const rowId = Number(info.lastInsertRowid)
      // 任意非零 id 都进映射表（对齐 Python 的 `if n.id is not None`）：
      // 新增步骤用的是**负临时 id**，分支引用必须能重映射到真实 id，否则分支会悬空。
      if (n.id !== 0) idMap.set(n.id, rowId)
      inserted.push({ rowId, oldId: n.id, raw: n })
    }
    // 分支引用重映射（旧 id → 新 id）
    for (const it of inserted) {
      const branch = it.raw.branch_node_id
      if (branch == null) continue
      c.prepare('UPDATE workflow_node SET branch_node_id = ? WHERE id = ?').run(
        idMap.get(branch) ?? branch,
        it.rowId
      )
    }
    return tid
  })
  const templateId = run()
  return { ok: true, problems: [], templateId }
}

export function deleteWorkflowTemplate(id: number): number {
  const c = conn()
  // 对齐 workflow_service.delete_template：有运行中实例就拒绝删除（返回 0）。
  // 此前直接删，会留下悬空实例与孤儿步骤任务。
  const running = c
    .prepare(
      "SELECT count(*) AS n FROM workflow_instance WHERE template_id = ? AND status = 'running'"
    )
    .get(id) as { n: number }
  if (running.n > 0) return 0
  const run = c.transaction(() => {
    c.prepare('DELETE FROM workflow_node WHERE template_id = ?').run(id)
    return c.prepare('DELETE FROM workflow_template WHERE id = ?').run(id).changes
  })
  return run()
}

/**
 * 复制模板（对齐 duplicate_template）：名称加「 副本」，节点与分支引用整体复制，
 * **不复制坐标**（Python 的 clone 只带 order/note/action/condition/branch），副本重新排布。
 */
export function duplicateWorkflowTemplate(id: number): WorkflowTemplatePayload | null {
  const src = getWorkflowTemplate(id)
  if (!src) return null
  const res = saveWorkflowTemplate({
    name: `${src.name} 副本`,
    description: src.description,
    start_policy: src.start_policy,
    nodes: orderedNodes(src.nodes).map((n) => ({
      // 借用原 id 只是让 save 的分支引用重映射能把 branch 指到新行
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
    })),
  })
  if (!res.ok || !res.templateId) return null
  return getWorkflowTemplate(res.templateId)
}

/**
 * 一键对齐（对齐 _auto_layout）：按执行顺序重置为纵向网格，pos_x=0、pos_y=i*行距。
 * 只写坐标，不动其它字段（Python 是 silent save_template，不广播模板变更）。
 */
export function autoLayoutWorkflowNodes(templateId: number, yGap: number): number {
  const c = conn()
  const nodes = c
    .prepare(`SELECT ${NODE_COLUMNS} FROM workflow_node WHERE template_id = ?`)
    .all(templateId) as WorkflowNodePayload[]
  const ordered = orderedNodes(nodes)
  const run = c.transaction(() => {
    const upd = c.prepare('UPDATE workflow_node SET pos_x = ?, pos_y = ? WHERE id = ?')
    let n = 0
    ordered.forEach((node, i) => {
      n += upd.run(0, i * yGap, node.id).changes
    })
    return n
  })
  return run()
}

/**
 * 某任务启动/关联的所有实例（对齐 instances_of_task，任务速览「工作流」卡片用）。
 * Python 不带排序，这里同样保持自然顺序。
 */
export function listWorkflowInstancesByTask(taskId: number): WorkflowInstancePayload[] {
  const rows = conn()
    .prepare('SELECT id FROM workflow_instance WHERE origin_task_id = ?')
    .all(taskId) as { id: number }[]
  return rows
    .map((r) => getWorkflowInstance(r.id))
    .filter((x): x is WorkflowInstancePayload => x !== null)
}

/** 仅持久化节点坐标（拖动后静默保存，不触发整体重写）。 */
/** 单独设置 / 清除某个步骤的条件分支目标（不重写整个模板）。 */
export function setWorkflowBranch(nodeId: number, branchNodeId: number | null): number {
  return conn()
    .prepare('UPDATE workflow_node SET branch_node_id = ? WHERE id = ?')
    .run(branchNodeId, nodeId).changes
}

export function updateWorkflowNodePos(nodeId: number, x: number, y: number): number {
  return conn().prepare('UPDATE workflow_node SET pos_x = ?, pos_y = ? WHERE id = ?').run(x, y, nodeId)
    .changes
}

/** 工作流实例的标记标签：父任务与各步骤都打上它，任务页一眼能认出「这是流程派生的」。 */
export const WORKFLOW_TAG = '工作流'

/**
 * 给一个实例造「根任务」：把各步骤收在它下面，而不是让它们散在任务列表顶层。
 * 从某个任务启动工作流时不走这里（那个任务本身就是根）。
 */
function createWorkflowParentTask(tplName: string, instanceTitle: string): number {
  const c = conn()
  const stamp = nowStamp()
  const info = c
    .prepare(
      `INSERT INTO task (title, notes_md, status, priority, repeat_period, streak, sort_key, parent_id, created_at, updated_at)
       VALUES (?, ?, 'todo', 0, 'none', 0, ?, NULL, ?, ?)`
    )
    .run(
      `工作流：${tplName}`,
      `由工作流实例「${instanceTitle}」自动创建，各步骤作为子任务派发。`,
      nextSortKey(null),
      stamp,
      stamp
    )
  const taskId = Number(info.lastInsertRowid)
  // 标签是任务页上「明显标记」的载体（TaskRow 会渲染成胶囊）
  setTaskTags(taskId, [WORKFLOW_TAG])
  return taskId
}

/** 把一步下发为真实任务并建立绑定（对齐 _spawn_step_task）。 */
export function spawnStepTask(
  instanceId: number,
  node: WorkflowNodePayload,
  tplName: string,
  parentId: number | null
): number | null {
  const c = conn()
  // SOP 可以绑多条：逐条查标题拼成 wikilink。查不到的（已删除）跳过，
  // 但不因此丢掉其它绑定 —— 一个失效链接不该让整份 SOP 消失。
  const notesMd = node.note_ids
    .map((id) =>
      c.prepare('SELECT title FROM note WHERE id = ? AND deleted_at IS NULL').get(id) as
        | { title: string }
        | undefined
    )
    .filter((n): n is { title: string } => Boolean(n?.title))
    .map((n) => `[[${n.title}]]`)
    .join(' ')
  const stamp = nowStamp()
  const info = c
    .prepare(
      `INSERT INTO task (title, notes_md, status, priority, repeat_period, streak, sort_key, parent_id, created_at, updated_at)
       VALUES (?, ?, 'todo', 0, 'none', 0, ?, ?, ?, ?)`
    )
    .run(`${tplName}：${node.title}`, notesMd, nextSortKey(parentId), parentId, stamp, stamp)
  const taskId = Number(info.lastInsertRowid)
  // 与父任务同一个标记：任务页上能一眼看出这一串是流程派生的
  setTaskTags(taskId, [WORKFLOW_TAG])
  c.prepare('INSERT INTO workflow_step_task (instance_id, node_id, task_id, created_at) VALUES (?, ?, ?, ?)').run(
    instanceId,
    node.id,
    taskId,
    stamp
  )
  return taskId
}

export async function instantiateWorkflow(
  templateId: number,
  title: string | null,
  originTaskId: number | null,
  policy?: string
): Promise<WorkflowInstancePayload | null> {
  const tpl = getWorkflowTemplate(templateId)
  if (!tpl || tpl.nodes.length === 0) return null
  const usePolicy = policy || tpl.start_policy || 'first'
  const c = conn()
  const stamp = nowStamp()
  const ordered = orderedNodes(tpl.nodes)
  // 首节点可能就是个条件节点：它不建任务，先自动求值算出真正该下发的步骤。
  // policy=all 时不需要（下面会一次性下发全部非条件节点）。
  const start = usePolicy === 'all' ? null : await resolveNextRunnable(tpl, null, null)
  const headId = usePolicy === 'all' ? ordered[0]?.id ?? null : start?.node?.id ?? null
  const instanceTitle = title || `${tpl.name} · ${stamp.slice(5, 16)}`
  const info = c
    .prepare(
      `INSERT INTO workflow_instance (template_id, title, status, current_node_id, origin_task_id, created_at)
       VALUES (?, ?, 'running', ?, ?, ?)`
    )
    .run(templateId, instanceTitle, headId, originTaskId, stamp)
  const instanceId = Number(info.lastInsertRowid)

  // 没有「启动它的那个任务」时（从工作流页直接点启动）就现造一个根任务：
  // 各步骤挂在它下面形成一棵子树，而不是散落在任务列表顶层。
  // 同时把它写回 origin_task_id —— spawnStepTask 取父级、以及「按任务查实例」都靠这一列。
  const rootTaskId = originTaskId ?? createWorkflowParentTask(tpl.name, instanceTitle)
  if (rootTaskId !== originTaskId) {
    c.prepare('UPDATE workflow_instance SET origin_task_id = ? WHERE id = ?').run(rootTaskId, instanceId)
  }

  // policy=first 只下发第一步，完成后自动推进；all 一次性下发全部。
  // 两种情况下条件节点都不建任务 —— 它是自动求值的关卡，不是待办；
  // 命令 / 脚本也不建任务 —— 它们由泵直接执行，等进程退出后自行推进。
  const toSpawn = usePolicy === 'all' ? ordered : start?.node ? [start.node] : []
  for (const n of toSpawn) {
    if (!needsTask(n)) continue
    spawnStepTask(instanceId, n, tpl.name, rootTaskId)
  }
  // 首节点若是命令 / 脚本，建完实例就交给泵自动跑。这里**不 await**：
  // 长命令可能要跑一阵，页面应当立刻拿到实例并显示「运行中」，而不是卡在启动按钮上。
  const head = headId == null ? null : ordered.find((n) => n.id === headId) ?? null
  if (head && isAutoActionKind(head.action_kind)) void pumpInstance(instanceId)
  return getWorkflowInstance(instanceId)
}

export function getWorkflowInstance(id: number): WorkflowInstancePayload | null {
  const c = conn()
  const inst = c
    .prepare(
      'SELECT id, template_id, title, status, current_node_id, origin_task_id, created_at, finished_at, last_result FROM workflow_instance WHERE id = ?'
    )
    .get(id) as (Omit<WorkflowInstancePayload, 'steps' | 'last_result'> & { last_result: string | null }) | undefined
  if (!inst) return null
  // 步骤集合 = **已生成的步骤绑定**（对齐 workflow_service.get_instance 遍历 binds）：
  // 不能 LEFT JOIN 全部模板节点，否则 policy=first 时进度分母是模板节点数、
  // 且出现 task_id 为空的「空步骤行」。
  const rows = c
    .prepare(
      `SELECT st.node_id, n.title, st.task_id, t.status AS task_status
         FROM workflow_step_task st
         LEFT JOIN workflow_node n ON n.id = st.node_id
         LEFT JOIN task t ON t.id = st.task_id
        WHERE st.instance_id = ?
        ORDER BY st.id`
    )
    .all(id) as {
    node_id: number
    title: string | null
    task_id: number | null
    task_status: string | null
  }[]
  const steps: WorkflowStepPayload[] = rows.map((r) => ({
    node_id: r.node_id,
    title: r.title ?? '',
    task_id: r.task_id,
    // 对齐 _task_done_map：只认 status=='done'（放弃不算完成）
    done: r.task_status === 'done',
  }))
  // last_result 在库里是 JSON 文本：解析失败按「没有结果」处理，不让坏数据把实例读崩
  const { last_result: rawResult, ...rest } = inst
  return { ...rest, last_result: parseRunResult(rawResult), steps }
}

export function listWorkflowInstances(status?: string | null): WorkflowInstancePayload[] {
  const c = conn()
  // 对齐 list_instances：按 id desc（创建先后），不是按 created_at 字符串
  const rows = (
    status
      ? c.prepare('SELECT id FROM workflow_instance WHERE status = ? ORDER BY id DESC').all(status)
      : c.prepare('SELECT id FROM workflow_instance ORDER BY id DESC').all()
  ) as { id: number }[]
  return rows.map((r) => getWorkflowInstance(r.id)).filter((x): x is WorkflowInstancePayload => x !== null)
}

// ------------------------------- 实例推进（人工任务 / 自动步骤共用一个泵）

/** 主进程后台推进后通知渲染层刷新；由 IPC 层注入（workflow.ts 不该直接碰 BrowserWindow）。 */
let workflowNotifier: (() => void) | null = null

export function setWorkflowNotifier(fn: (() => void) | null): void {
  workflowNotifier = fn
}

function notifyWorkflow(): void {
  try {
    workflowNotifier?.()
  } catch (err) {
    // 通知失败不能影响推进本身
    console.error('[workflow] 变更通知失败', err)
  }
}

/** 解析 workflow_instance.last_result 里的 JSON；坏数据按「没有结果」处理。 */
function parseRunResult(raw: string | null | undefined): NodeRunResult | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as NodeRunResult
    return v && typeof v === 'object' && typeof v.nodeId === 'number' ? v : null
  } catch {
    return null
  }
}

/**
 * 实例上下文里的「上一步结果」。
 * 它既是条件节点（来源 = 上一步结果）的判定依据，也是自动步骤失败后给人看的凭据。
 */
export function readInstanceResult(instanceId: number): NodeRunResult | null {
  const row = conn()
    .prepare('SELECT last_result FROM workflow_instance WHERE id = ?')
    .get(instanceId) as { last_result: string | null } | undefined
  return parseRunResult(row?.last_result)
}

function writeInstanceResult(instanceId: number, res: NodeRunResult): void {
  conn()
    .prepare('UPDATE workflow_instance SET last_result = ? WHERE id = ?')
    .run(JSON.stringify(res), instanceId)
}

/**
 * 需要人工待办的节点：普通步骤（含 'none' / 'open_url' / 'open_note' / 'run_command' 这些历史值）。
 * 条件节点是自动求值的关卡、命令与脚本由泵直接跑，两者都不该生成待办。
 */
function needsTask(node: WorkflowNodePayload): boolean {
  return node.action_kind !== CONDITION_KIND && !isAutoActionKind(node.action_kind)
}

/**
 * 从某个已完成的节点往后推进：消费掉紧随其后的条件节点，落到下一个可运行节点，
 * 需要人工就派待办、否则只前移 current_node_id（由泵接着跑）。
 *
 * 调用方必须**先**把上一个节点的结果写进 last_result —— 紧随其后的条件节点
 * （来源 = 上一步结果）正是从这里取判定依据，这就是「结果传给下一个节点」的落点。
 */
async function advanceInstance(
  instanceId: number,
  fromNodeId: number
): Promise<{ next: WorkflowNodePayload | null }> {
  const c = conn()
  const inst = c
    .prepare('SELECT id, template_id, status, origin_task_id FROM workflow_instance WHERE id = ?')
    .get(instanceId) as
    | { id: number; template_id: number; status: string; origin_task_id: number | null }
    | undefined
  if (!inst || inst.status !== 'running') return { next: null }
  const tpl = getWorkflowTemplate(inst.template_id)
  if (!tpl) return { next: null }

  // 条件节点在这里被自动消费掉：成立走分支、不成立走顺序下一个
  const { node: nxt } = await resolveNextRunnable(tpl, fromNodeId, readInstanceResult(instanceId))
  const stamp = nowStamp()
  if (!nxt) {
    c.prepare("UPDATE workflow_instance SET status = 'done', finished_at = ? WHERE id = ?").run(stamp, instanceId)
    // 根任务跟着收尾：否则任务页上会一直挂着一个已无子步骤的「工作流：xxx」。
    // 直接写 SQL 而不是走任务模块的 setStatus —— 那个入口在 IPC 层还挂着「推进工作流」的钩子，
    // 在这里调用会绕回去。
    if (inst.origin_task_id) {
      c.prepare("UPDATE task SET status = 'done', updated_at = ? WHERE id = ?").run(stamp, inst.origin_task_id)
    }
    return { next: null }
  }
  if (needsTask(nxt)) {
    const has = c
      .prepare('SELECT 1 FROM workflow_step_task WHERE instance_id = ? AND node_id = ?')
      .get(instanceId, nxt.id)
    if (!has) spawnStepTask(instanceId, nxt, tpl.name, inst.origin_task_id)
  }
  c.prepare('UPDATE workflow_instance SET current_node_id = ? WHERE id = ?').run(nxt.id, instanceId)
  return { next: nxt }
}

/** 正在跑的实例：同一个实例只允许一个泵，避免重试与任务完成钩子并发跑同一个节点。 */
const pumping = new Set<number>()

/**
 * 自动节点泵：从 current_node_id 起，只要当前节点是命令 / 脚本就一直「执行 → 记录结果 → 推进」，
 * 直到落到人工任务（等人勾选）、流程结束、或某一步返回值不对（停在原地等重试）。
 */
export async function pumpInstance(instanceId: number): Promise<void> {
  if (pumping.has(instanceId)) return
  pumping.add(instanceId)
  try {
    for (let guard = 0; guard < 200; guard++) {
      const inst = getWorkflowInstance(instanceId)
      if (!inst || inst.status !== 'running') return
      const tpl = getWorkflowTemplate(inst.template_id)
      if (!tpl) return
      const node = tpl.nodes.find((n) => n.id === inst.current_node_id)
      if (!node) return
      if (!isAutoActionKind(node.action_kind)) return // 剩下的是人做的事

      const kind = normalizeActionKind(node.action_kind)
      // 先写「运行中」：长命令跑起来时页面上要看得见，而不是一个静止的旧结果
      writeInstanceResult(instanceId, {
        nodeId: node.id,
        kind,
        state: 'running',
        code: null,
        output: '',
        message: `正在执行「${node.title}」…`,
        at: nowStamp(),
      })
      notifyWorkflow()

      const r = await executeNodeAction(node)
      writeInstanceResult(instanceId, {
        nodeId: node.id,
        kind,
        state: r.state,
        code: r.code,
        output: r.output,
        message: r.message,
        at: nowStamp(),
      })
      notifyWorkflow()
      // 返回值不对就停在原地：不推进、不吞错误，等人重试或中止
      if (r.state !== 'ok') return

      const { next } = await advanceInstance(instanceId, node.id)
      notifyWorkflow()
      if (!next || !isAutoActionKind(next.action_kind)) return
    }
    console.error('[workflow] 自动节点连续推进超过 200 步，疑似成环', instanceId)
  } catch (err) {
    console.error('[workflow] 自动节点执行失败', err)
  } finally {
    pumping.delete(instanceId)
  }
}

/**
 * 某步骤任务完成时推进实例（对齐 complete_step_task）：
 * 有下一步则生成其任务并前移 current_node_id，最后一步则完结实例。
 */
export async function completeWorkflowStep(taskId: number): Promise<boolean> {
  const c = conn()
  const bind = c
    .prepare('SELECT instance_id, node_id FROM workflow_step_task WHERE task_id = ?')
    .get(taskId) as { instance_id: number; node_id: number } | undefined
  if (!bind) return false
  const inst = c
    .prepare('SELECT id, status FROM workflow_instance WHERE id = ?')
    .get(bind.instance_id) as { id: number; status: string } | undefined
  if (!inst || inst.status !== 'running') return false

  // 「任务做完了」本身也是一次结果：紧随其后的条件节点可以拿它当「上一步成功」来判定
  writeInstanceResult(inst.id, {
    nodeId: bind.node_id,
    kind: TASK_KIND,
    state: 'ok',
    code: null,
    output: '',
    message: '步骤任务已完成',
    at: nowStamp(),
  })
  const { next } = await advanceInstance(inst.id, bind.node_id)
  // 下一步若是命令 / 脚本，交回泵继续跑（不 await：钩子调用方不该等命令跑完）
  if (next && isAutoActionKind(next.action_kind)) void pumpInstance(inst.id)
  return true
}

/**
 * 重试当前自动步骤：把失败结果清掉再叫一次泵，从 current_node_id 原地重跑。
 * 失败后实例停在原地不推进，没有这个入口的话除了中止就没别的出路了。
 */
export async function retryWorkflowStep(instanceId: number): Promise<boolean> {
  const inst = getWorkflowInstance(instanceId)
  if (!inst || inst.status !== 'running') return false
  writeInstanceResult(instanceId, {
    nodeId: inst.current_node_id ?? -1,
    kind: 'command',
    state: 'running',
    code: null,
    output: '',
    message: '正在重试…',
    at: nowStamp(),
  })
  notifyWorkflow()
  await pumpInstance(instanceId)
  return true
}

// ------------------------------------------------------- 自动步骤（命令 / 脚本）执行

/** 自动步骤的执行上限：跑飞了不能把实例永远卡在「运行中」。 */
const ACTION_TIMEOUT_MS = 120_000
/** 输出只留尾部：够排查，又不至于把几 MB 日志塞进库、撑爆页面。 */
const OUTPUT_TAIL = 4000

interface ChildOutcome {
  code: number | null
  output: string
  timedOut: boolean
  error: string
  /** 实际启动成功的解释器（诊断用） */
  file: string
  /** 依次尝试过的解释器候选 */
  tried: string[]
}

/**
 * 跑一个子进程并**等它结束**（命令与脚本共用）。
 *
 * 与历史动作 run_command（detached + unref，发完即忘）的关键区别就在这里：
 * 自动步骤要拿退出码来判断「这一步成不成功」，所以必须等；
 * 同时必须有超时兜底，否则一个挂住的命令能让整个实例永远停在这一步。
 *
 * files 是解释器的**候选列表**：前一个不存在（ENOENT）才试下一个 ——
 * Python 可能是 python / python3 / py，PowerShell 可能是系统自带的 powershell.exe
 * 或跨平台的 pwsh，写死一个名字只会让「没装那一个」变成一句看不懂的失败。
 * 超时从**第一次尝试**起算，换候选不重置计时。
 */
function runChild(files: string[], args: string[], stdin?: string): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    let out = ''
    const push = (buf: Buffer): void => {
      out += buf.toString('utf8')
      if (out.length > OUTPUT_TAIL) out = out.slice(-OUTPUT_TAIL)
    }
    let settled = false
    let index = 0
    const tried: string[] = []
    let child: ReturnType<typeof spawn> | null = null
    const done = (r: Omit<ChildOutcome, 'file' | 'tried'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...r, file: files[index] ?? '', tried: [...tried] })
    }
    const killTree = (): void => {
      // Windows 上杀父进程不会带走它拉起的子进程：用 taskkill /T 整棵树一起收，
      // 否则解释器里启动的命令会变成孤儿继续跑。
      try {
        if (process.platform === 'win32' && child?.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        } else {
          child?.kill()
        }
      } catch {
        // 进程已经退出就无所谓
      }
    }
    const timer = setTimeout(() => {
      killTree()
      done({ code: null, output: out, timedOut: true, error: '' })
    }, ACTION_TIMEOUT_MS)
    const attempt = (): void => {
      const file = files[index]
      tried.push(file)
      try {
        child = spawn(file, args, {
          // 相对路径按用户主目录解析：脚本里写 `.out.log` 时不会落到应用的安装目录
          cwd: app.getPath('home'),
          windowsHide: true,
          shell: false,
          stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        })
      } catch (err) {
        done({
          code: null,
          output: out,
          timedOut: false,
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }
      child.stdout?.on('data', push)
      child.stderr?.on('data', push)
      child.once('error', (err: NodeJS.ErrnoException) => {
        // 只有「找不到这个可执行文件」才换下一个候选；权限 / 路径非法等错误直接报出来
        if (err.code === 'ENOENT' && index + 1 < files.length && !settled) {
          index += 1
          attempt()
          return
        }
        done({ code: null, output: out, timedOut: false, error: err.message })
      })
      child.once('close', (code) => done({ code, output: out, timedOut: false, error: '' }))
      if (stdin !== undefined) {
        // 进程提前退出时写 stdin 会 EPIPE，忽略即可（真正的结论看退出码）
        child.stdin?.on('error', () => undefined)
        child.stdin?.end(stdin)
      }
    }
    attempt()
  })
}

/**
 * 某一类脚本运行环境的启动方式。
 *
 * 除 cmd 外都走「脚本从标准输入喂进去」：不用落地临时文件、不用拼引号，
 * 而且 PowerShell 这种输入方式不受执行策略限制（`-File *.ps1` 会被 Restricted 拦住）。
 * cmd 没有「从 stdin 读脚本」的正规做法（交互模式会把提示符混进输出、退出码也不可控），
 * 所以它写一个临时 .cmd 再执行。
 */
function runtimeLaunch(runtime: ScriptRuntime): { files: string[]; args: string[]; ext?: string } {
  const win = process.platform === 'win32'
  if (runtime === 'cmd') {
    return win
      ? { files: ['cmd.exe', 'cmd'], args: ['/d', '/s', '/c'], ext: 'cmd' }
      : { files: ['sh'], args: [], ext: 'sh' }
  }
  if (runtime === 'python') {
    return { files: win ? ['python', 'python3', 'py'] : ['python3', 'python'], args: ['-'] }
  }
  if (runtime === 'node') {
    return { files: ['node', 'node.exe'], args: ['-'] }
  }
  const psArgs = ['-NoProfile', '-NonInteractive', '-Command', '-']
  return win
    ? { files: ['powershell.exe', 'pwsh'], args: psArgs }
    : { files: ['pwsh', 'powershell'], args: psArgs }
}

/** 跑一个脚本步骤：按运行环境选解释器；命令行 / Python / Node / PowerShell 走 stdin，cmd 走临时文件。 */
async function runScript(runtime: ScriptRuntime, script: string): Promise<ChildOutcome> {
  const launch = runtimeLaunch(runtime)
  if (!launch.ext) return runChild(launch.files, launch.args, script)
  // cmd 的临时脚本用 CRLF 写：这是它原生的换行，也免得某些构造被当成单行
  const file = join(tmpdir(), `zhixing-wf-${process.pid}-${Date.now().toString(36)}.${launch.ext}`)
  try {
    writeFileSync(file, script.replace(/\r?\n/g, '\r\n'), 'utf8')
    return await runChild(launch.files, [...launch.args, file])
  } finally {
    try {
      unlinkSync(file)
    } catch {
      // 删不掉就算了：它在系统临时目录里，重启会被清理
    }
  }
}

/**
 * 执行一个自动节点，返回它的结果。
 *
 * 命令：按 shlex 规则拆 argv、不经 shell 直接 spawn；
 * 脚本：按 action_runtime 选解释器（PowerShell / cmd / Python / Node），
 *       除 cmd 外都把脚本文本从 stdin 喂进去，cmd 落一个临时 .cmd 再执行。
 * 两者都以「退出码是否等于 action_expect（默认 0）」为成败判据。
 */
async function executeNodeAction(
  node: Pick<WorkflowNodePayload, 'action_kind' | 'action_value' | 'action_expect' | 'action_runtime'>
): Promise<{
  state: NodeRunResult['state']
  code: number | null
  output: string
  message: string
}> {
  const kind = normalizeActionKind(node.action_kind)
  const expect = parseExpectCode(node.action_expect)
  const raw = (node.action_value || '').trim()
  const runtime = normalizeScriptRuntime(node.action_runtime)
  const label = kind === SCRIPT_KIND ? `脚本（${scriptRuntimeLabel(runtime)}）` : '命令'

  // 命令只有「一个可执行文件」这一种候选；脚本按运行环境选解释器（见 runScript）
  let candidates: string[] = []
  let args: string[] = []
  if (kind === COMMAND_KIND) {
    if (!raw) return { state: 'failed', code: null, output: '', message: '没有填写要执行的命令' }
    try {
      const argv = splitCommand(raw)
      if (!argv.length) return { state: 'failed', code: null, output: '', message: '命令为空' }
      candidates = [argv[0]]
      args = argv.slice(1)
    } catch (err) {
      return {
        state: 'failed',
        code: null,
        output: '',
        message: `命令解析失败：${err instanceof Error ? err.message : String(err)}`,
      }
    }
  } else if (!raw) {
    return { state: 'failed', code: null, output: '', message: `没有填写${label}的内容` }
  }

  const r = kind === SCRIPT_KIND ? await runScript(runtime, raw) : await runChild(candidates, args)
  if (r.timedOut) {
    return {
      state: 'timeout',
      code: null,
      output: r.output,
      message: `${label}执行超时（超过 ${ACTION_TIMEOUT_MS / 1000} 秒已终止）`,
    }
  }
  if (r.code === null) {
    // 把「试过哪些解释器」一并报出来：装了 pwsh 却没装 powershell.exe 这类情况一眼可辨
    const tried = r.tried.length > 1 ? `（已尝试 ${r.tried.join(' / ')}）` : ''
    return {
      state: 'failed',
      code: null,
      output: r.output,
      message: `无法启动${label}${tried}：${r.error || r.file}`,
    }
  }
  const ok = r.code === expect
  return {
    state: ok ? 'ok' : 'failed',
    code: r.code,
    output: r.output,
    message: ok
      ? `${label}执行完成（退出码 ${r.code}）`
      : `${label}返回退出码 ${r.code}，期望 ${expect}`,
  }
}

export function abortWorkflowInstance(id: number): boolean {
  return (
    conn()
      .prepare("UPDATE workflow_instance SET status = 'aborted', finished_at = ? WHERE id = ?")
      .run(nowStamp(), id).changes > 0
  )
}

// ---------------------------------------------------------------- 工作流节点动作

type ShlexState = 'plain' | 'single' | 'double' | 'escape' | 'escapeDouble'

/**
 * POSIX shlex.split 等价实现（对齐 Python `shlex.split`，供 RUN_COMMAND 拆分 argv）。
 *
 * 与原「简化版」的差别正是它与 Python 的差别：
 * - 引号外 `\x` 是转义（`a\ b` → 一个参数 `a b`），`\` 后跟换行是续行；
 * - 双引号内只有 `\"` 与 `\\` 被反转义，其余反斜杠原样保留；
 * - 单引号内一切原样（含反斜杠）；
 * - 空引号（`''` / `""`）产生一个**空参数**，相邻引号与裸字符拼接；
 * - 引号未闭合**抛错**（Python 抛 ValueError('No closing quotation')），
 *   不再静默吞掉，由 runWorkflowAction 转成「执行失败：…」。
 *
 * 仍不解析管道/重定向——执行时不经 shell，这些字符只是普通参数。
 */
export function splitCommand(cmd: string): string[] {
  const out: string[] = []
  let token = ''
  let quoted = false
  let state: ShlexState = 'plain'
  for (const ch of cmd ?? '') {
    if (state === 'escape') {
      // 引号外的反斜杠：转义下一个字符；`\` + 换行 = 续行（不产出字符）
      if (ch !== '\n') token += ch
      state = 'plain'
      continue
    }
    if (state === 'escapeDouble') {
      // 双引号内的反斜杠：只对 " 与 \ 生效，其余保留反斜杠本身
      token += ch === '"' || ch === '\\' ? ch : '\\' + ch
      state = 'double'
      continue
    }
    if (state === 'single') {
      if (ch === "'") state = 'plain'
      else token += ch
      continue
    }
    if (state === 'double') {
      if (ch === '"') state = 'plain'
      else if (ch === '\\') state = 'escapeDouble'
      else token += ch
      continue
    }
    if (/\s/.test(ch)) {
      if (token || quoted) out.push(token)
      token = ''
      quoted = false
    } else if (ch === '\\') {
      state = 'escape'
    } else if (ch === "'") {
      state = 'single'
      quoted = true
    } else if (ch === '"') {
      state = 'double'
      quoted = true
    } else {
      token += ch
    }
  }
  if (state !== 'plain' && state !== 'escape') {
    throw new Error('No closing quotation')
  }
  if (token || quoted) out.push(token)
  return out
}

/**
 * 人类可读的动作描述（逐字对齐 describe_action，用于执行前确认/步骤提示）：
 * 绑定笔记能查到标题时给「打开笔记「标题」」，否则退回「打开关联笔记」；
 * 无动作给「无动作」而不是空串。
 */
// ---------------------------------------------------------------- 条件节点

/** 脚本条件的等待上限：跑飞了不能把推进卡死。 */
const CONDITION_TIMEOUT_MS = 15_000

/**
 * 求值一个条件节点。返回 ok=true 表示「条件成立」。
 *
 * 四种来源：
 *   - confirm：弹出模态确认框（主进程 dialog，阻塞直到用户选择）——「提示确认」
 *   - task：查目标任务的状态是否与期望一致
 *   - script：以独立进程运行命令并比较**退出码**（不是只看有没有启动）
 *   - prev：读实例上下文里的「上一步结果」（命令/脚本的退出码、任务的完成状态）——
 *           ctx.lastResult 由推进逻辑在调用前写入，这就是自动步骤把结果交给条件节点的通道
 */
/**
 * 人工确认的「问界面」通道，由 IPC 层注入（workflow.ts 不该直接碰 BrowserWindow）。
 * 返回 **null** 表示没有可用窗口 —— 调用方回落到原生模态框，
 * 这样「窗口都没了、没人应答」也不会把实例永久卡在条件节点上。
 */
let conditionAsker: ((prompt: string) => Promise<boolean | null>) | null = null

export function setConditionAsker(
  fn: ((prompt: string) => Promise<boolean | null>) | null
): void {
  conditionAsker = fn
}

export async function evaluateCondition(
  raw: string | null | undefined,
  ctx?: { lastResult?: NodeRunResult | null }
): Promise<{
  ok: boolean
  message: string
}> {
  const cfg = parseCondition(raw)
  if (!cfg) return { ok: false, message: '条件未配置或格式错误' }

  if (cfg.kind === 'confirm') {
    const prompt = cfg.prompt?.trim() || '这个条件成立吗？'
    // 优先用应用内弹框（与其它确认操作同一套样式与图标）；
    // 只有拿不到可见窗口时才回落到主进程原生模态 —— 判定语义两边完全一致：
    // 「是」= 条件成立走分支，「否」= 不成立走顺序下一步。
    const viaUi = conditionAsker ? await conditionAsker(prompt) : null
    const ok =
      viaUi === null
        ? dialog.showMessageBoxSync({
            type: 'question',
            buttons: ['否', '是'],
            defaultId: 1,
            cancelId: 0,
            title: '工作流条件',
            message: prompt,
            detail: '这是工作流里的人工确认条件节点：选「是」走条件分支，选「否」走顺序下一步。',
          }) === 1
        : viaUi
    return { ok, message: ok ? '人工确认：是' : '人工确认：否' }
  }

  if (cfg.kind === 'task') {
    if (!cfg.taskId) return { ok: false, message: '未选择要判定的任务' }
    const row = conn().prepare('SELECT title, status FROM task WHERE id = ?').get(cfg.taskId) as
      | { title: string; status: string }
      | undefined
    if (!row) return { ok: false, message: `任务 #${cfg.taskId} 不存在` }
    const done = row.status === 'done'
    const expectDone = cfg.expectDone !== false
    return {
      ok: done === expectDone,
      message: `任务「${row.title}」${done ? '已完成' : '未完成'}（期望${expectDone ? '已完成' : '未完成'}）`,
    }
  }

  // 上一步结果：命令 / 脚本看退出码，人工任务看「做完了没有」
  if (cfg.kind === 'prev') return judgePrevResult(cfg, ctx?.lastResult)

  const cmd = (cfg.command || '').trim()
  if (!cmd) return { ok: false, message: '未填写要运行的脚本' }
  let argv: string[] = []
  try {
    argv = splitCommand(cmd)
  } catch (err) {
    return { ok: false, message: `脚本解析失败：${err instanceof Error ? err.message : String(err)}` }
  }
  if (!argv.length) return { ok: false, message: '脚本为空' }

  const expect = Number.isFinite(cfg.expectCode) ? Number(cfg.expectCode) : 0
  const code = await new Promise<number | null>((resolve) => {
    let settled = false
    const done = (v: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    const child = spawn(argv[0], argv.slice(1), {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
    })
    // 超时兜底：条件求值必须能收敛，否则实例永远卡在这一步
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 已经退出就无所谓
      }
      done(null)
    }, CONDITION_TIMEOUT_MS)
    child.once('error', () => done(null))
    child.once('close', (c) => done(c))
  })
  if (code === null) return { ok: false, message: '脚本启动失败或超时' }
  return { ok: code === expect, message: `脚本退出码 ${code}（期望 ${expect}）` }
}

/**
 * 从 fromId 之后找出下一个**可运行**的节点。
 * fromId 传 null 表示「从头开始」（实例化时用）。
 *
 * 条件节点在这里就被消费掉：逐个求值，成立走它的 branch_node_id、不成立走顺序下一个，
 * 直到落到普通步骤或流程结束。guard 是防呆 —— 条件互相指向时不会转死。
 */
export async function resolveNextRunnable(
  tpl: WorkflowTemplatePayload,
  fromId: number | null,
  lastResult: NodeRunResult | null = null
): Promise<{ node: WorkflowNodePayload | null; log: string[] }> {
  // 必须用 orderedNodes 排过序的数组：getWorkflowTemplate 返回的 nodes 没有 ORDER BY，
  // 直接拿原始数组取「下一个」会按插入顺序乱走（分支路径看不出来，顺序路径就错）。
  const ordered = orderedNodes(tpl.nodes)
  const at = fromId == null ? -1 : ordered.findIndex((n) => n.id === fromId)
  let cur = at < 0 ? (fromId == null ? ordered[0] ?? null : null) : ordered[at + 1] ?? null
  const log: string[] = []
  for (let guard = 0; cur && guard < 50; guard++) {
    // 取局部常量：await 之后 TS 不再保留 cur 的非空收窄
    const node: WorkflowNodePayload = cur
    if (node.action_kind !== CONDITION_KIND) return { node, log }
    const r = await evaluateCondition(node.action_value, { lastResult })
    log.push(`条件「${node.title}」：${r.message} → ${r.ok ? '成立' : '不成立'}`)
    const branch =
      r.ok && node.branch_node_id
        ? tpl.nodes.find((n) => n.id === node.branch_node_id) ?? null
        : null
    const idx = ordered.findIndex((n) => n.id === node.id)
    cur = branch ?? (idx >= 0 ? ordered[idx + 1] ?? null : null)
  }
  return { node: null, log }
}

export function describeWorkflowAction(
  actionKind: string,
  actionValue: string,
  actionExpect?: string,
  actionRuntime?: string
): string {
  const kind = (actionKind || '').trim()
  // 自动步骤：把「要跑什么 + 什么算成功」一次说清，确认框里能看到判据
  if (kind === COMMAND_KIND) {
    return `运行命令：${actionValue}（等待退出，期望退出码 ${parseExpectCode(actionExpect)}）`
  }
  if (kind === SCRIPT_KIND) {
    // 确认框里要说清「用哪个解释器跑」——同一段内容在 PowerShell 和 Python 下完全不同
    const first = (actionValue || '').split('\n').find((l) => l.trim()) ?? ''
    const brief = first.trim().slice(0, 48)
    return `运行 ${scriptRuntimeLabel(actionRuntime)} 脚本：${brief}${brief ? '…' : '（空）'}（等待退出，期望退出码 ${parseExpectCode(actionExpect)}）`
  }
  if (kind === 'open_note') {
    // 对齐 Python 的 `(action_value or "").isdigit()` 判定
    const title = /^\d+$/.test(actionValue || '') ? getNote(Number(actionValue))?.title ?? '' : ''
    return title ? `打开笔记「${title}」` : '打开关联笔记'
  }
  if (kind === 'open_url') return `在浏览器打开 ${actionValue}`
  // 历史值：发完即忘、不等退出码，保留其原有描述以免旧模板的确认框说法变了
  if (kind === 'run_command') return `运行命令：${actionValue}（不等待）`
  if (kind === TASK_KIND) return '人工任务'
  return '无动作'
}

/**
 * 执行步骤动作，返回 { ok, message, kind }。
 * RUN_COMMAND 在**独立进程**中启动且不经 shell（避免注入与管道语义）；
 * 调用方（渲染进程）必须先做二次确认——本函数不做确认。
 * OPEN_URL 交给系统浏览器；OPEN_NOTE 由渲染进程完成跳转。
 */
export async function runWorkflowAction(
  actionKind: string,
  actionValue: string,
  actionExpect?: string,
  actionRuntime?: string
): Promise<{ ok: boolean; message: string; kind: string; code: number | null; output: string }> {
  const kind = actionKind || 'none'
  if (kind === 'none' || !kind) {
    return { ok: false, message: '该步骤没有配置动作', kind, code: null, output: '' }
  }

  // 条件节点不是「动作」：它由推进逻辑自动求值，浮卡上的按钮只是手动试跑一次
  if (kind === CONDITION_KIND) {
    const r = await evaluateCondition(actionValue)
    return { ok: r.ok, message: r.message, kind, code: null, output: '' }
  }

  // 命令 / 脚本：这里走的是与实例推进**同一个**执行器，手动试跑与自动跑结果口径一致。
  // 注意它是等待型（要等进程退出、核对退出码），不再是历史 run_command 那种发完即忘。
  if (kind === COMMAND_KIND || kind === SCRIPT_KIND) {
    const r = await executeNodeAction({
      action_kind: kind,
      action_value: actionValue,
      action_expect: actionExpect ?? '',
      action_runtime: actionRuntime ?? '',
    })
    return { ok: r.state === 'ok', message: r.message, kind, code: r.code, output: r.output }
  }

  if (kind === 'open_note') {
    const id = Number(actionValue)
    if (!Number.isFinite(id) || id <= 0) {
      return { ok: false, message: '未配置关联笔记', kind, code: null, output: '' }
    }
    const note = getNote(id)
    if (!note) return { ok: false, message: '关联笔记不存在或已删除', kind, code: null, output: '' }
    return { ok: true, message: `打开笔记「${note.title}」`, kind, code: null, output: '' }
  }

  if (kind === 'open_url') {
    const url = (actionValue || '').trim()
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, message: '只支持 http/https 链接', kind, code: null, output: '' }
    }
    openExternalSafely(url)
    return { ok: true, message: `已在浏览器打开 ${url}`, kind, code: null, output: '' }
  }

  if (kind === 'run_command') {
    const cmd = (actionValue || '').trim()
    if (!cmd) return { ok: false, message: '未填写要运行的命令', kind, code: null, output: '' }
    let argv: string[] = []
    // splitCommand 会抛「引号未闭合」；与 Python 一样归到 try 里，
    // 转成 { ok:false, message:'执行失败：…' }，而不是让 IPC reject。
    // spawn 的失败是**异步**通过 'error' 事件报告的，try/catch 根本捕不到：
    // 必须等 'spawn'（进程真的起来了）或 'error'（如 ENOENT）才能给出准确结果。
    // 否则命令不存在时既误报「已启动」，又会因为没人监听 'error' 而抛未捕获异常。
    try {
      argv = splitCommand(cmd)
      if (!argv.length) return { ok: false, message: '命令为空', kind, code: null, output: '' }
      const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', shell: false })
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve())
        child.once('error', (err) => reject(err))
      })
      child.unref()
      return { ok: true, message: `已启动：${argv[0]}`, kind, code: null, output: '' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `执行失败：${msg}`, kind, code: null, output: '' }
    }
  }

  return { ok: false, message: '未知动作类型', kind, code: null, output: '' }
}
