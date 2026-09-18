import { nextSortKey } from './tasks'
import { getNote } from './notes'
import { openExternalSafely } from '../security'
import { spawn } from 'node:child_process'
import type {
  WorkflowInstancePayload,
  WorkflowNodePayload,
  WorkflowStepPayload,
  WorkflowTemplatePayload,
  WorkflowTemplateSummary,
} from '../../shared/types'
import { conn, nowStamp } from './connection'

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
         FROM workflow_template t ORDER BY t.updated_at DESC`
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
  const stamp = nowStamp()
  const run = c.transaction(() => {
    let tid = tpl.id ?? 0
    if (tid) {
      const exists = c.prepare('SELECT id FROM workflow_template WHERE id = ?').get(tid)
      if (!exists) throw new Error('模板不存在: ' + tid)
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
      if (n.id > 0) idMap.set(n.id, rowId)
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

export function instantiateWorkflow(
  templateId: number,
  title: string | null,
  originTaskId: number | null,
  policy?: string
): WorkflowInstancePayload | null {
  const tpl = getWorkflowTemplate(templateId)
  if (!tpl || tpl.nodes.length === 0) return null
  const usePolicy = policy || tpl.start_policy || 'first'
  const c = conn()
  const stamp = nowStamp()
  const ordered = orderedNodes(tpl.nodes)
  const first = ordered[0] ?? null
  const instanceTitle = title || `${tpl.name} · ${stamp.slice(5, 16)}`
  const info = c
    .prepare(
      `INSERT INTO workflow_instance (template_id, title, status, current_node_id, origin_task_id, created_at)
       VALUES (?, ?, 'running', ?, ?, ?)`
    )
    .run(templateId, instanceTitle, first?.id ?? null, originTaskId, stamp)
  const instanceId = Number(info.lastInsertRowid)

  // policy=first 只下发第一步，完成后自动推进；all 一次性下发全部
  const toSpawn = usePolicy === 'all' ? ordered : first ? [first] : []
  for (const n of toSpawn) spawnStepTask(instanceId, n, tpl.name, originTaskId)
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
  const rows = c
    .prepare(
      `SELECT n.id AS node_id, n.title, st.task_id, t.status AS task_status
         FROM workflow_node n
         LEFT JOIN workflow_step_task st ON st.node_id = n.id AND st.instance_id = ?
         LEFT JOIN task t ON t.id = st.task_id
        WHERE n.template_id = ?`
    )
    .all(id, inst.template_id) as {
    node_id: number
    title: string
    task_id: number | null
    task_status: string | null
  }[]
  const steps: WorkflowStepPayload[] = rows.map((r) => ({
    node_id: r.node_id,
    title: r.title,
    task_id: r.task_id,
    done: r.task_status === 'done' || r.task_status === 'abandoned',
  }))
  return { ...inst, steps }
}

export function listWorkflowInstances(status?: string | null): WorkflowInstancePayload[] {
  const c = conn()
  const rows = (
    status
      ? c.prepare('SELECT id FROM workflow_instance WHERE status = ? ORDER BY created_at DESC').all(status)
      : c.prepare('SELECT id FROM workflow_instance ORDER BY created_at DESC').all()
  ) as { id: number }[]
  return rows.map((r) => getWorkflowInstance(r.id)).filter((x): x is WorkflowInstancePayload => x !== null)
}

/**
 * 某步骤任务完成时推进实例（对齐 complete_step_task）：
 * 有下一步则生成其任务并前移 current_node_id，最后一步则完结实例。
 */
export function completeWorkflowStep(taskId: number): boolean {
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

  const nxt = nextWorkflowNode(tpl.nodes, bind.node_id)
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

/**
 * 简化版 shlex：按空白切分并支持单双引号包裹（对齐 Python shlex.split 的常见用法）。
 * 只做切分，不解析管道/重定向——因为执行时**不经 shell**。
 */
export function splitCommand(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'"
    } else if (/\s/.test(ch)) {
    if (cur) {
        out.push(cur)
        cur = ''
      }
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

/** 人类可读的动作描述（对齐 describe_action，用于执行前确认文案）。 */
export function describeWorkflowAction(actionKind: string, actionValue: string): string {
  if (actionKind === 'open_note') return actionValue ? '打开关联笔记' : '打开关联笔记'
  if (actionKind === 'open_url') return `在浏览器打开 ${actionValue}`
  if (actionKind === 'run_command') return actionValue
  return ''
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
    const argv = splitCommand(cmd)
    if (!argv.length) return { ok: false, message: '命令为空', kind }
    // spawn 的失败是**异步**通过 'error' 事件报告的，try/catch 根本捕不到：
    // 必须等 'spawn'（进程真的起来了）或 'error'（如 ENOENT）才能给出准确结果。
    // 否则命令不存在时既误报「已启动」，又会因为没人监听 'error' 而抛未捕获异常。
    try {
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
