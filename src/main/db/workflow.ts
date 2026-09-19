import { nextSortKey } from './tasks'
import { getNote } from './notes'
import { openExternalSafely } from '../security'
import { spawn } from 'node:child_process'
import { dialog } from 'electron'
import type {
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
  parseCondition,
  type ConditionConfig,
} from '../../shared/workflow-condition'

// ---------------------------------------------------------------- 工作流

export const NODE_COLUMNS =
  'id, template_id, title, detail, order_index, note_id, action_kind, action_value, condition, branch_node_id, pos_x, pos_y'

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
  const nodes = c
    .prepare(`SELECT ${NODE_COLUMNS} FROM workflow_node WHERE template_id = ?`)
    .all(id) as WorkflowNodePayload[]
  return { ...t, nodes }
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
  nodes: { id?: number | null; title: string; detail?: string; order_index?: number; note_id?: number | null; action_kind?: string; action_value?: string; condition?: string; branch_node_id?: number | null; pos_x?: number | null; pos_y?: number | null }[]
}): { ok: boolean; problems: string[]; templateId?: number } {
  const draft: WorkflowNodePayload[] = tpl.nodes.map((n, i) => ({
    id: n.id ?? -(i + 1), // 新节点用负临时 id，供分支引用重映射
    template_id: tpl.id ?? 0,
    title: n.title ?? '',
    detail: n.detail ?? '',
    order_index: n.order_index || i,
    note_id: n.note_id ?? null,
    action_kind: n.action_kind ?? 'none',
    action_value: n.action_value ?? '',
    condition: n.condition ?? '',
    branch_node_id: n.branch_node_id ?? null,
    pos_x: n.pos_x ?? null,
    pos_y: n.pos_y ?? null,
  }))
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
          `INSERT INTO workflow_node (template_id, title, detail, order_index, note_id, action_kind,
                                     action_value, condition, pos_x, pos_y, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(tid, n.title, n.detail, n.order_index, n.note_id, n.action_kind, n.action_value, n.condition, n.pos_x, n.pos_y, stamp)
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
      action_kind: n.action_kind,
      action_value: n.action_value,
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

/** 把一步下发为真实任务并建立绑定（对齐 _spawn_step_task）。 */
export function spawnStepTask(
  instanceId: number,
  node: WorkflowNodePayload,
  tplName: string,
  parentId: number | null
): number | null {
  const c = conn()
  let notesMd = ''
  if (node.note_id) {
    const note = c.prepare('SELECT title FROM note WHERE id = ? AND deleted_at IS NULL').get(node.note_id) as
      | { title: string }
      | undefined
    if (note?.title) notesMd = `[[${note.title}]]`
  }
  const stamp = nowStamp()
  const info = c
    .prepare(
      `INSERT INTO task (title, notes_md, status, priority, repeat_period, streak, sort_key, parent_id, created_at, updated_at)
       VALUES (?, ?, 'todo', 0, 'none', 0, ?, ?, ?, ?)`
    )
    .run(`${tplName}：${node.title}`, notesMd, nextSortKey(parentId), parentId, stamp, stamp)
  const taskId = Number(info.lastInsertRowid)
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
  const start = usePolicy === 'all' ? null : await resolveNextRunnable(tpl, null)
  const headId = usePolicy === 'all' ? ordered[0]?.id ?? null : start?.node?.id ?? null
  const instanceTitle = title || `${tpl.name} · ${stamp.slice(5, 16)}`
  const info = c
    .prepare(
      `INSERT INTO workflow_instance (template_id, title, status, current_node_id, origin_task_id, created_at)
       VALUES (?, ?, 'running', ?, ?, ?)`
    )
    .run(templateId, instanceTitle, headId, originTaskId, stamp)
  const instanceId = Number(info.lastInsertRowid)

  // policy=first 只下发第一步，完成后自动推进；all 一次性下发全部。
  // 两种情况下条件节点都不建任务 —— 它是自动求值的关卡，不是待办。
  const toSpawn = usePolicy === 'all' ? ordered : start?.node ? [start.node] : []
  for (const n of toSpawn) {
    if (n.action_kind === CONDITION_KIND) continue
    spawnStepTask(instanceId, n, tpl.name, originTaskId)
  }
  return getWorkflowInstance(instanceId)
}

export function getWorkflowInstance(id: number): WorkflowInstancePayload | null {
  const c = conn()
  const inst = c
    .prepare(
      'SELECT id, template_id, title, status, current_node_id, origin_task_id, created_at, finished_at FROM workflow_instance WHERE id = ?'
    )
    .get(id) as Omit<WorkflowInstancePayload, 'steps'> | undefined
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
  return { ...inst, steps }
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
    .prepare('SELECT id, template_id, status, origin_task_id FROM workflow_instance WHERE id = ?')
    .get(bind.instance_id) as
    | { id: number; template_id: number; status: string; origin_task_id: number | null }
    | undefined
  if (!inst || inst.status !== 'running') return false
  const tpl = getWorkflowTemplate(inst.template_id)
  if (!tpl) return false

  // 条件节点在这一步被自动消费掉：成立走分支、不成立走顺序下一个
  const { node: nxt } = await resolveNextRunnable(tpl, bind.node_id)
  const stamp = nowStamp()
  if (!nxt) {
    c.prepare("UPDATE workflow_instance SET status = 'done', finished_at = ? WHERE id = ?").run(stamp, inst.id)
    return true
  }
  const has = c
    .prepare('SELECT 1 FROM workflow_step_task WHERE instance_id = ? AND node_id = ?')
    .get(inst.id, nxt.id)
  if (!has) spawnStepTask(inst.id, nxt, tpl.name, inst.origin_task_id)
  c.prepare('UPDATE workflow_instance SET current_node_id = ? WHERE id = ?').run(nxt.id, inst.id)
  return true
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
 * 三种来源：
 *   - confirm：弹出模态确认框（主进程 dialog，阻塞直到用户选择）——「提示确认」
 *   - task：查目标任务的状态是否与期望一致
 *   - script：以独立进程运行命令并比较**退出码**（不是只看有没有启动）
 */
export async function evaluateCondition(raw: string | null | undefined): Promise<{
  ok: boolean
  message: string
}> {
  const cfg = parseCondition(raw)
  if (!cfg) return { ok: false, message: '条件未配置或格式错误' }

  if (cfg.kind === 'confirm') {
    const answer = dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['否', '是'],
      defaultId: 1,
      cancelId: 0,
      title: '工作流条件',
      message: cfg.prompt?.trim() || '这个条件成立吗？',
      detail: '这是工作流里的人工确认条件节点：选「是」走条件分支，选「否」走顺序下一步。',
    })
    return { ok: answer === 1, message: answer === 1 ? '人工确认：是' : '人工确认：否' }
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
  fromId: number | null
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
    const r = await evaluateCondition(node.action_value)
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

export function describeWorkflowAction(actionKind: string, actionValue: string): string {
  const kind = actionKind || 'none'
  if (kind === 'open_note') {
    // 对齐 Python 的 `(action_value or "").isdigit()` 判定
    const title = /^\d+$/.test(actionValue || '') ? getNote(Number(actionValue))?.title ?? '' : ''
    return title ? `打开笔记「${title}」` : '打开关联笔记'
  }
  if (kind === 'open_url') return `在浏览器打开 ${actionValue}`
  if (kind === 'run_command') return `运行命令：${actionValue}`
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
  actionValue: string
): Promise<{ ok: boolean; message: string; kind: string }> {
  const kind = actionKind || 'none'
  if (kind === 'none' || !kind) return { ok: false, message: '该步骤没有配置动作', kind }

  // 条件节点不是「动作」：它由推进逻辑自动求值，浮卡上的按钮只是手动试跑一次
  if (kind === CONDITION_KIND) {
    const r = await evaluateCondition(actionValue)
    return { ok: r.ok, message: r.message, kind }
  }

  if (kind === 'open_note') {
    const id = Number(actionValue)
    if (!Number.isFinite(id) || id <= 0) return { ok: false, message: '未配置关联笔记', kind }
    const note = getNote(id)
    if (!note) return { ok: false, message: '关联笔记不存在或已删除', kind }
    return { ok: true, message: `打开笔记「${note.title}」`, kind }
  }

  if (kind === 'open_url') {
    const url = (actionValue || '').trim()
    if (!/^https?:\/\//i.test(url)) return { ok: false, message: '只支持 http/https 链接', kind }
    openExternalSafely(url)
    return { ok: true, message: `已在浏览器打开 ${url}`, kind }
  }

  if (kind === 'run_command') {
    const cmd = (actionValue || '').trim()
    if (!cmd) return { ok: false, message: '未填写要运行的命令', kind }
    let argv: string[] = []
    // splitCommand 会抛「引号未闭合」；与 Python 一样归到 try 里，
    // 转成 { ok:false, message:'执行失败：…' }，而不是让 IPC reject。
    // spawn 的失败是**异步**通过 'error' 事件报告的，try/catch 根本捕不到：
    // 必须等 'spawn'（进程真的起来了）或 'error'（如 ENOENT）才能给出准确结果。
    // 否则命令不存在时既误报「已启动」，又会因为没人监听 'error' 而抛未捕获异常。
    try {
      argv = splitCommand(cmd)
      if (!argv.length) return { ok: false, message: '命令为空', kind }
      const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', shell: false })
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve())
        child.once('error', (err) => reject(err))
      })
      child.unref()
      return { ok: true, message: `已启动：${argv[0]}`, kind }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `执行失败：${msg}`, kind }
    }
  }

  return { ok: false, message: '未知动作类型', kind }
}
