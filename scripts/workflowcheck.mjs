/**
 * 工作流链路验证：副本库上跑 模板校验/保存/节点坐标、实例化、步骤推进与中止。
 * 用法：node scripts/workflowcheck.mjs
 */
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

const root = ROOT
const require = createRequire(import.meta.url)
const tmpHome = join(ROOT, '.screenshots', 'wfcheck-home')
const PORT = 9228
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
const sql = (file, query) => {
  if (!existsSync(file)) return ''
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare(query).get()
    return row ? String(Object.values(row)[0] ?? '') : ''
  } finally {
    db.close()
  }
}

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish, results } = createChecker()
const info = await app.evaluate('window.zhixing.db.info()')
check('数据库指向副本库', String(info.path).startsWith(tmpHome), info.path)

// 1) 空节点模板被拒绝
const empty = await app.evaluate(
  "window.zhixing.db.saveWorkflowTemplate({ name: '验证-空模板', nodes: [] })"
)
check('空模板被拒绝', empty.ok === false && empty.problems.length > 0, empty.problems?.[0])

// 2) 缺标题被拒绝
const noTitle = await app.evaluate(
  "window.zhixing.db.saveWorkflowTemplate({ name: '验证-缺标题', nodes: [{ title: '  ' }] })"
)
check('缺标题被拒绝', noTitle.ok === false, noTitle.problems?.[0])

// 3) 分支自指被拒绝
const self = await app.evaluate(
  "window.zhixing.db.saveWorkflowTemplate({ name: '验证-自指', nodes: [{ title: 'A' }] }).then(r => r.ok ? window.zhixing.db.workflowTemplate(r.templateId).then(t => window.zhixing.db.saveWorkflowTemplate({ id: t.id, name: t.name, nodes: [{ id: t.nodes[0].id, title: 'A', branch_node_id: t.nodes[0].id }] })) : r)"
)
check('分支自指被拒绝', self.ok === false, self.problems?.[0])

// 4) 正常模板保存 + 节点坐标持久化
const saved = await app.evaluate(
  "window.zhixing.db.saveWorkflowTemplate({ name: '验证-三步流程', description: 'd', start_policy: 'first', nodes: [{ title: '第一步', order_index: 0 }, { title: '第二步', order_index: 1 }, { title: '第三步', order_index: 2 }] })"
)
check('三步模板保存成功', saved.ok === true && saved.templateId != null, `id=${saved.templateId}`)

const tpl = await app.evaluate(`window.zhixing.db.workflowTemplate(${saved.templateId})`)
check('模板节点数正确且顺序稳定', tpl?.nodes?.length === 3, `nodes=${tpl?.nodes?.length}`)

const moved = await app.evaluate(
  `window.zhixing.db.updateWorkflowNodePos(${tpl.nodes[0].id}, 321, 222).then(() => window.zhixing.db.workflowTemplate(${saved.templateId}))`
)
check('节点坐标已持久化', moved?.nodes?.[0]?.pos_x === 321 && moved?.nodes?.[0]?.pos_y === 222, `${moved?.nodes?.[0]?.pos_x},${moved?.nodes?.[0]?.pos_y}`)

// 5) 实例化：policy=first 只下发第一步
const inst = await app.evaluate(`window.zhixing.db.instantiateWorkflow(${saved.templateId}, null, null)`)
const spawned = inst?.steps.filter((s) => s.task_id != null).length ?? 0
check('实例化只下发第一步（first 策略）', inst?.status === 'running' && spawned === 1, `spawned=${spawned}`)
const firstTaskId = inst?.steps.find((s) => s.task_id != null)?.task_id ?? null
check('步骤任务已建立绑定', firstTaskId != null, `taskId=${firstTaskId}`)

const firstTask = await app.evaluate(`window.zhixing.db.tasks().then(rows => rows.find(r => r.id === ${firstTaskId}))`)
check('步骤任务标题带流程前缀', String(firstTask?.title ?? '').startsWith('验证-三步流程：'), firstTask?.title)

// 6) 完成第一步 → 推进并下发第二步
const advanced = await app.evaluate(`window.zhixing.db.completeWorkflowStep(${firstTaskId})`)
const after = await app.evaluate(`window.zhixing.db.workflowInstance(${inst.id})`)
const spawned2 = after?.steps.filter((s) => s.task_id != null).length ?? 0
check('完成一步后推进到第二步', advanced === true && spawned2 === 2, `spawned=${spawned2}`)
check('current_node 指向第二步', after?.current_node_id === tpl.nodes[1].id, `cur=${after?.current_node_id}`)

// 7) 走完最后一步 → 实例完成
const step2Task = after?.steps.find((s) => s.node_id === tpl.nodes[1].id)?.task_id ?? null
await app.evaluate(`window.zhixing.db.completeWorkflowStep(${step2Task})`)
const mid = await app.evaluate(`window.zhixing.db.workflowInstance(${inst.id})`)
const step3Task = mid?.steps.find((s) => s.node_id === tpl.nodes[2].id)?.task_id ?? null
await app.evaluate(`window.zhixing.db.completeWorkflowStep(${step3Task})`)
const finished = await app.evaluate(`window.zhixing.db.workflowInstance(${inst.id})`)
check('最后一步完成后实例完结', finished?.status === 'done' && !!finished?.finished_at, finished?.status)

// 8) 中止
const inst2 = await app.evaluate(`window.zhixing.db.instantiateWorkflow(${saved.templateId}, null, null)`)
const aborted = await app.evaluate(`window.zhixing.db.abortWorkflowInstance(${inst2.id})`)
const inst2After = await app.evaluate(`window.zhixing.db.workflowInstance(${inst2.id})`)
check('中止实例置为 aborted', aborted === true && inst2After?.status === 'aborted', inst2After?.status)

app.ws.close()
await sleep(600)

const tmpDb = join(tmpHome, 'zhixing.db')
const nodeRows = sql(tmpDb, `SELECT COUNT(*) FROM workflow_node WHERE template_id = ${saved.templateId};`)
check('节点整体替换落库（3 行）', nodeRows === '3', `rows=${nodeRows}`)
const bindRows = sql(tmpDb, `SELECT COUNT(*) FROM workflow_step_task WHERE instance_id = ${inst.id};`)
check('步骤任务绑定落库（3 步）', bindRows === '3', `rows=${bindRows}`)

const leaked = sql(realDb, "SELECT COUNT(*) FROM workflow_template WHERE name LIKE '验证-%';")
const realInst = sql(realDb, "SELECT COUNT(*) FROM workflow_instance WHERE title LIKE '验证-%';")
check('真实库未写入测试模板/实例', leaked === '0' && realInst === '0', `template=${leaked} instance=${realInst}`)

await app.close()

process.exit(finish())