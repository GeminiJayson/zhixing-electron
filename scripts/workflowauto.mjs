/**
 * 自动步骤（命令 / 脚本）+ 结果传递验证：副本库上跑真实主进程。
 *
 * 覆盖：
 *   1. SOP 多绑定往返（note_ids ⇄ note_id 兼容列）
 *   2. 命令步骤实例化后自动执行、结果落库、自动推进到人工任务
 *   3. 只有「任务」型才生成任务项（命令 / 脚本 / 条件都不生成）
 *   4. 返回值不对 → 停在原地（last_result=failed），retry 后能继续
 *   5. 条件节点「上一步结果」：成立走分支、不成立走顺序
 *   6. 脚本步骤（PowerShell）同样等待退出码
 *
 * 用法：node scripts/workflowauto.mjs（需先 npm run build）
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = join(root, '.screenshots', 'wfauto-home')
const PORT = 9231

const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
if (!existsSync(realDb)) {
  console.error('✗ 找不到真实库：' + realDb)
  process.exit(1)
}
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(realDb, join(tmpHome, 'zhixing.db'))

/**
 * 注入系统 PATH：DSH 的 pwsh 工具环境只带它自己的 bin 目录，
 * 从这种环境启动的 Electron 里 `cmd.exe` / `powershell.exe` 会 ENOENT。
 * 这纯粹是验证环境的限制（用户正常启动应用时 PATH 是完整的），
 * 所以只在验证脚本里补，不去改产品代码。
 */
const SYS_PATH = [
  'C:\\Windows\\System32',
  'C:\\Windows',
  'C:\\Windows\\System32\\Wbem',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
].join(';')

const child = spawn(
  electronPath,
  ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpHome, 'profile')}`],
  {
    cwd: root,
    env: { ...process.env, PATH: `${SYS_PATH};${process.env.PATH ?? ''}`, ZHIXING_HOME: tmpHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
)

const attach = async () => {
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      page = list.find((t) => t.type === 'page')
    } catch {
      /* 等待 */
    }
    if (!page) await sleep(500)
  }
  if (!page) return null
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1e6)
      const h = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id !== id) return
        ws.removeEventListener('message', h)
        resolve(m)
      }
      ws.addEventListener('message', h)
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails)
      throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result?.result?.value
  }
  return { ws, evaluate }
}

const conn = await attach()
if (!conn) {
  console.error('✗ 无法连接渲染进程')
  child.kill()
  process.exit(1)
}
await sleep(3000)

const results = []
const check = (name, ok, detail = '') => {
  results.push([name, ok])
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}
const J = (v) => JSON.stringify(v)

/** 轮询等异步泵推进到位。 */
const waitFor = async (expr, predicate, timeout = 20000) => {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeout) {
    last = await conn.evaluate(expr)
    if (predicate(last)) return last
    await sleep(250)
  }
  return last
}

const info = await conn.evaluate('window.zhixing.db.info()')
check('数据库指向副本库', String(info.path).startsWith(tmpHome), info.path)

// 拿两条真实笔记做 SOP 绑定
const notes = await conn.evaluate('window.zhixing.db.recentNotes(4)')
const sopIds = (notes ?? []).slice(0, 2).map((n) => n.id)
check('取到两条笔记用于 SOP', sopIds.length === 2, J(sopIds))

// ---------------------------------------------------------------- 1) SOP 多绑定
const sop = await conn.evaluate(
  `window.zhixing.db.saveWorkflowTemplate({ name: '验证-多SOP', nodes: [{ title: '带SOP的步骤', note_ids: ${J(sopIds)} }] }).then(r => r.ok ? window.zhixing.db.workflowTemplate(r.templateId) : r)`
)
const sopNode = sop?.nodes?.[0]
check(
  'SOP 多绑定往返（note_ids 两条）',
  Array.isArray(sopNode?.note_ids) && sopNode.note_ids.length === 2,
  J(sopNode?.note_ids)
)
check(
  '兼容列 note_id 同步为第一条',
  sopNode?.note_id === sopIds[0],
  `note_id=${sopNode?.note_id}`
)

// ---------------------------------------------------------------- 2) 命令自动执行
// 命令成功（退出码 7 == 期望 7）→ 自动推进到人工任务
const cmdTpl = await conn.evaluate(
  `window.zhixing.db.saveWorkflowTemplate({ name: '验证-命令自动跑', start_policy: 'first', nodes: [
      { title: '跑个命令', order_index: 0, action_kind: 'command', action_value: 'cmd.exe /c exit 7', action_expect: '7' },
      { title: '人工确认', order_index: 1 }
    ] }).then(r => r.ok ? window.zhixing.db.workflowTemplate(r.templateId) : r)`
)
check('命令模板保存成功', cmdTpl?.nodes?.length === 2, J(cmdTpl?.problems ?? ''))

const cmdInst = await conn.evaluate(
  `window.zhixing.db.instantiateWorkflow(${cmdTpl.id}, null, null, 'first')`
)
const cmdSettled = await waitFor(
  `window.zhixing.db.workflowInstance(${cmdInst.id})`,
  (i) => i && i.last_result && i.last_result.state !== 'running'
)
check(
  '命令步骤自动执行并记录退出码',
  cmdSettled?.last_result?.state === 'ok' && cmdSettled?.last_result?.code === 7,
  `state=${cmdSettled?.last_result?.state} code=${cmdSettled?.last_result?.code}`
)
const cmdNodes = cmdTpl.nodes
check(
  '命令步骤不生成任务项，只下发下一步',
  cmdSettled?.steps?.length === 1 && cmdSettled.steps[0].node_id === cmdNodes[1].id,
  `steps=${J((cmdSettled?.steps ?? []).map((s) => s.node_id))}`
)
check(
  'current_node 已推进到人工任务',
  cmdSettled?.current_node_id === cmdNodes[1].id,
  `cur=${cmdSettled?.current_node_id}`
)

// ---------------------------------------------------------------- 3) 失败停在原地 + 重试
const badTpl = await conn.evaluate(
  `window.zhixing.db.saveWorkflowTemplate({ name: '验证-返回值不对', start_policy: 'first', nodes: [
      { title: '必然失败', order_index: 0, action_kind: 'command', action_value: 'cmd.exe /c exit 3', action_expect: '0' },
      { title: '后面这步', order_index: 1 }
    ] }).then(r => r.ok ? window.zhixing.db.workflowTemplate(r.templateId) : r)`
)
const badInst = await conn.evaluate(
  `window.zhixing.db.instantiateWorkflow(${badTpl.id}, null, null, 'first')`
)
const badSettled = await waitFor(
  `window.zhixing.db.workflowInstance(${badInst.id})`,
  (i) => i && i.last_result && i.last_result.state !== 'running'
)
check(
  '返回值不对 → 状态 failed 且带退出码',
  badSettled?.last_result?.state === 'failed' && badSettled?.last_result?.code === 3,
  `state=${badSettled?.last_result?.state} code=${badSettled?.last_result?.code}`
)
check(
  '失败时停在原节点、不生成后续任务',
  badSettled?.current_node_id === badTpl.nodes[0].id && badSettled?.steps?.length === 0,
  `cur=${badSettled?.current_node_id} steps=${badSettled?.steps?.length}`
)

// 重试：同一条件必然再次失败，但必须真的重跑（at 变新），实例仍在 running
const retried = await conn.evaluate(`window.zhixing.db.retryWorkflowStep(${badInst.id})`)
const retrySettled = await waitFor(
  `window.zhixing.db.workflowInstance(${badInst.id})`,
  (i) =>
    i &&
    i.last_result &&
    i.last_result.state === 'failed' &&
    i.last_result.at !== badSettled.last_result.at
)
check(
  '重试会原地重跑（时间戳更新，仍停在失败节点）',
  retried === true && retrySettled?.last_result?.at !== badSettled?.last_result?.at,
  `retried=${retried} at=${retrySettled?.last_result?.at}`
)

// 期望值与命令一致时，同一条命令能跑通 —— 证明失败判据来自期望值而不是命令本身
const okTpl = await conn.evaluate(
  `window.zhixing.db.saveWorkflowTemplate({ name: '验证-期望值一致', start_policy: 'first', nodes: [
      { title: '退出码3', order_index: 0, action_kind: 'command', action_value: 'cmd.exe /c exit 3', action_expect: '3' },
      { title: '后面这步', order_index: 1 }
    ] }).then(r => r.ok ? window.zhixing.db.workflowTemplate(r.templateId) : r)`
)
const okInst = await conn.evaluate(
  `window.zhixing.db.instantiateWorkflow(${okTpl.id}, null, null, 'first')`
)
const okSettled = await waitFor(
  `window.zhixing.db.workflowInstance(${okInst.id})`,
  (i) => i && i.steps && i.steps.length === 1
)
check(
  '同一条命令、期望值一致时通过并推进',
  okSettled?.last_result?.state === 'ok' && okSettled?.steps?.length === 1,
  `state=${okSettled?.last_result?.state} steps=${okSettled?.steps?.length}`
)

// ---------------------------------------------------------------- 4) 条件读上一步结果
// 命令成功 → 条件（上一步成功）成立 → 跳到「分支目标」，跳过顺序上的那一步
const condTpl = await conn.evaluate(
  `window.zhixing.db.saveWorkflowTemplate({ name: '验证-结果传给条件', start_policy: 'first', nodes: [
      { title: '命令', order_index: 0, action_kind: 'command', action_value: 'cmd.exe /c exit 0', action_expect: '0' },
      { title: '判断上一步', order_index: 1, action_kind: 'condition', action_value: JSON.stringify({ kind: 'prev', expectOk: true }) },
      { title: '顺序下一步', order_index: 2 },
      { title: '分支目标', order_index: 3 }
    ] }).then(r => r.ok ? window.zhixing.db.workflowTemplate(r.templateId) : r)`
)
// 把条件的 branch 指向第 4 个节点
const condNodes = condTpl.nodes
await conn.evaluate(
  `window.zhixing.db.setWorkflowBranch(${condNodes[1].id}, ${condNodes[3].id})`
)
const condInst = await conn.evaluate(
  `window.zhixing.db.instantiateWorkflow(${condTpl.id}, null, null, 'first')`
)
const condSettled = await waitFor(
  `window.zhixing.db.workflowInstance(${condInst.id})`,
  (i) => i && i.steps && i.steps.length >= 1
)
check(
  '条件条件成立走分支（跳过顺序下一步）',
  condSettled?.current_node_id === condNodes[3].id &&
    condSettled?.steps?.length === 1 &&
    condSettled.steps[0].node_id === condNodes[3].id,
  `cur=${condSettled?.current_node_id} steps=${J((condSettled?.steps ?? []).map((s) => s.node_id))}`
)
check(
  '条件节点自身不生成任务项',
  !(condSettled?.steps ?? []).some((s) => s.node_id === condNodes[1].id)
)

// 上一步成功、但条件期望「失败」→ 不成立 → 走顺序下一步
const condTpl2 = await conn.evaluate(
  `window.zhixing.db.saveWorkflowTemplate({ name: '验证-条件不成立', start_policy: 'first', nodes: [
      { title: '命令', order_index: 0, action_kind: 'command', action_value: 'cmd.exe /c exit 0', action_expect: '0' },
      { title: '判断上一步', order_index: 1, action_kind: 'condition', action_value: JSON.stringify({ kind: 'prev', expectOk: false }) },
      { title: '顺序下一步', order_index: 2 },
      { title: '分支目标', order_index: 3 }
    ] }).then(r => r.ok ? window.zhixing.db.workflowTemplate(r.templateId) : r)`
)
await conn.evaluate(`window.zhixing.db.setWorkflowBranch(${condTpl2.nodes[1].id}, ${condTpl2.nodes[3].id})`)
const cond2Inst = await conn.evaluate(
  `window.zhixing.db.instantiateWorkflow(${condTpl2.id}, null, null, 'first')`
)
const cond2Settled = await waitFor(
  `window.zhixing.db.workflowInstance(${cond2Inst.id})`,
  (i) => i && i.steps && i.steps.length >= 1
)
check(
  '条件不成立走顺序下一步',
  cond2Settled?.current_node_id === condTpl2.nodes[2].id,
  `cur=${cond2Settled?.current_node_id}`
)

// ---------------------------------------------------------------- 5) 脚本步骤
const scriptTpl = await conn.evaluate(
  `window.zhixing.db.saveWorkflowTemplate({ name: '验证-脚本', start_policy: 'first', nodes: [
      { title: '跑脚本', order_index: 0, action_kind: 'script', action_value: 'exit 5', action_expect: '5' },
      { title: '人工步', order_index: 1 }
    ] }).then(r => r.ok ? window.zhixing.db.workflowTemplate(r.templateId) : r)`
)
const scriptInst = await conn.evaluate(
  `window.zhixing.db.instantiateWorkflow(${scriptTpl.id}, null, null, 'first')`
)
const scriptSettled = await waitFor(
  `window.zhixing.db.workflowInstance(${scriptInst.id})`,
  (i) => i && i.last_result && i.last_result.state !== 'running',
  30000
)
check(
  '脚本步骤执行并核对退出码',
  scriptSettled?.last_result?.state === 'ok' && scriptSettled?.last_result?.code === 5,
  `state=${scriptSettled?.last_result?.state} code=${scriptSettled?.last_result?.code} msg=${scriptSettled?.last_result?.message}`
)
check(
  '脚本步骤也不生成任务项',
  scriptSettled?.steps?.length === 1 && scriptSettled.steps[0].node_id === scriptTpl.nodes[1].id,
  `steps=${J((scriptSettled?.steps ?? []).map((s) => s.node_id))}`
)

// ---------------------------------------------------------------- 6) 多 SOP 落到任务备注
const sopInst = await conn.evaluate(
  `window.zhixing.db.instantiateWorkflow(${sop.id}, null, null, 'first')`
)
const sopTaskId = sopInst?.steps?.[0]?.task_id ?? null
const sopTask = await conn.evaluate(
  `window.zhixing.db.tasks(500).then(rows => rows.find(r => r.id === ${sopTaskId}) ?? null)`
)
const links = (String(sopTask?.notes_md ?? '').match(/\[\[/g) ?? []).length
check('多绑 SOP 全部写成任务备注链接', links === 2, `links=${links} md=${sopTask?.notes_md}`)

// ---------------------------------------------------------------- 7) 四类脚本运行环境
// PowerShell / cmd / Node 本机都有，逐类实测退出码；Python 视有无解释器分别验证。
const runtimeInsts = []
const runtimeTpls = []
const runtimeCases = [
  { runtime: 'powershell', label: 'PowerShell', script: 'exit 4', expect: '4' },
  { runtime: 'cmd', label: 'CMD', script: 'exit /b 6', expect: '6' },
  { runtime: 'node', label: 'Node', script: 'process.exit(9)', expect: '9' },
]
for (const c of runtimeCases) {
  const tpl = await conn.evaluate(
    `window.zhixing.db.saveWorkflowTemplate({ name: ${J('验证-运行时-' + c.label)}, start_policy: 'first', nodes: [
        { title: '脚本', order_index: 0, action_kind: 'script', action_value: ${J(c.script)}, action_expect: ${J(c.expect)}, action_runtime: ${J(c.runtime)} },
        { title: '人工步', order_index: 1 }
      ] }).then(r => r.ok ? window.zhixing.db.workflowTemplate(r.templateId) : r)`
  )
  check(`${c.label} 运行环境已持久化`, tpl?.nodes?.[0]?.action_runtime === c.runtime, tpl?.nodes?.[0]?.action_runtime)
  const inst = await conn.evaluate(`window.zhixing.db.instantiateWorkflow(${tpl.id}, null, null, 'first')`)
  const settled = await waitFor(
    `window.zhixing.db.workflowInstance(${inst.id})`,
    (i) => i && i.last_result && i.last_result.state !== 'running',
    30000
  )
  check(
    `${c.label} 脚本执行并核对退出码`,
    settled?.last_result?.state === 'ok' && settled?.last_result?.code === Number(c.expect),
    `state=${settled?.last_result?.state} code=${settled?.last_result?.code} msg=${settled?.last_result?.message}`
  )
  runtimeInsts.push(inst)
  runtimeTpls.push(tpl.id)
}

// Python：本机没装解释器时，必须报出「试过哪些候选」而不是一句干巴巴的失败
const pyTpl = await conn.evaluate(
  `window.zhixing.db.saveWorkflowTemplate({ name: '验证-运行时-Python', start_policy: 'first', nodes: [
      { title: '脚本', order_index: 0, action_kind: 'script', action_value: 'import sys\\nsys.exit(0)', action_expect: '0', action_runtime: 'python' },
      { title: '人工步', order_index: 1 }
    ] }).then(r => r.ok ? window.zhixing.db.workflowTemplate(r.templateId) : r)`
)
const pyInst = await conn.evaluate(`window.zhixing.db.instantiateWorkflow(${pyTpl.id}, null, null, 'first')`)
const pySettled = await waitFor(
  `window.zhixing.db.workflowInstance(${pyInst.id})`,
  (i) => i && i.last_result && i.last_result.state !== 'running',
  30000
)
const pythonAvailable = !spawnSync('python', ['-c', 'pass'], {
  env: { ...process.env, PATH: `${SYS_PATH};${process.env.PATH ?? ''}` },
  windowsHide: true,
}).error
if (pythonAvailable) {
  check(
    'Python 脚本执行并核对退出码（本机装了 Python）',
    pySettled?.last_result?.state === 'ok' && pySettled?.last_result?.code === 0,
    `state=${pySettled?.last_result?.state} code=${pySettled?.last_result?.code}`
  )
} else {
  // 这台机器没有 Python：重点验证「找不到解释器」时信息是否可操作
  check(
    'Python 不可用时给出「已尝试哪些解释器」的失败信息',
    pySettled?.last_result?.state === 'failed' &&
      /已尝试 python \/ python3 \/ py/.test(String(pySettled?.last_result?.message)),
    pySettled?.last_result?.message
  )
}
runtimeInsts.push(pyInst)
runtimeTpls.push(pyTpl.id)

// 清理：先中止这些实例（有 running 实例时模板拒绝删除），再删模板
for (const id of [...[cmdInst, badInst, okInst, condInst, cond2Inst, scriptInst, sopInst], ...runtimeInsts]) {
  await conn.evaluate(`window.zhixing.db.abortWorkflowInstance(${id.id})`)
}
for (const id of [...[sop.id, cmdTpl.id, badTpl.id, okTpl.id, condTpl.id, condTpl2.id, scriptTpl.id], ...runtimeTpls]) {
  await conn.evaluate(`window.zhixing.db.deleteWorkflowTemplate(${id})`)
}
const leftovers = await conn.evaluate(
  "window.zhixing.db.workflowTemplates().then(rows => rows.filter(r => r.name.startsWith('验证-')).length)"
)
check('验证模板可删除', leftovers === 0, `left=${leftovers}`)

conn.ws.close()
child.kill()
await sleep(600)
rmSync(tmpHome, { recursive: true, force: true })

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length ? 1 : 0)
