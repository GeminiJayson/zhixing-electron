/**
 * 工作流：条件节点的「满足 / 不满足」两条分支 + 实例再次运行/删除 + 模板栏宽度可调。
 *
 * 覆盖：
 *   1. branch_false_node_id 落库并能读回（Electron 私有附加列，不占 Python 的迁移号）
 *   2. 推进：条件不成立走 false 分支、成立走 true 分支
 *   3. 实例：rerunWorkflowInstance 新开一个实例；deleteWorkflowInstance 只删该实例，
 *      模板与已生成的任务都不动
 *   4. 画布：条件节点下方有内容条、两个分支端口、两条分支标签（满足 / 不满足）
 *   5. 模板栏：分隔条存在，拖动改宽度并记进 localStorage
 *
 * 用法：node scripts/wfbranchcheck.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = join(root, '.screenshots', 'wfbranch-home')
const PORT = 9257

const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
if (!existsSync(realDb)) {
  console.error('✗ 找不到真实库：' + realDb)
  process.exit(1)
}
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(realDb, join(tmpHome, 'zhixing.db'))

const SYS_PATH = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem'].join(';')
const child = spawn(
  electronPath,
  ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(tmpHome, 'profile')],
  {
    cwd: root,
    env: { ...process.env, PATH: SYS_PATH + ';' + (process.env.PATH ?? ''), ZHIXING_HOME: tmpHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
)

const list = async () => {
  try {
    return await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
  } catch {
    return []
  }
}

const connect = async (target) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
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
  const evaluate = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result?.exceptionDetails)
      throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result?.result?.value
  }
  return { ws, send, evaluate }
}

let main = null
for (let i = 0; i < 60 && !main; i++) {
  const pages = await list()
  main = pages.find((t) => t.type === 'page')
  if (!main) await sleep(500)
}
if (!main) {
  console.error('✗ 主窗口没起来')
  child.kill()
  process.exit(1)
}
const conn = await connect(main)
await sleep(2500)

const results = []
const check = (name, ok, detail = '') => {
  results.push([name, ok])
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''))
}
const J = (v) => JSON.stringify(v)
const STAMP = 'WB' + Date.now().toString(36)

try {
  // ------------------------------------------------ 1. 建模板：条件节点两条分支
  // 新节点用负临时 id，saveWorkflowTemplate 会把分支引用重映射成真实 id
  const task = await conn.evaluate(`window.zhixing.db.createTask(${J(STAMP + ' 条件任务')})`)
  const actionValue = JSON.stringify({ kind: 'task', taskId: task.id, expectDone: true })
  const tpl = await conn.evaluate(
    `window.zhixing.db.saveWorkflowTemplate({ name: ${J(STAMP + ' 双分支')}, start_policy: 'first', nodes: [
        { id: -1, title: '判断', order_index: 0, action_kind: 'condition', action_value: ${J(actionValue)}, branch_node_id: -2, branch_false_node_id: -3 },
        { id: -2, title: '满足目标', order_index: 1 },
        { id: -3, title: '不满足目标', order_index: 2 }
      ] }).then((r) => (r.ok ? window.zhixing.db.workflowTemplate(r.templateId) : r))`
  )
  const cond = tpl?.nodes?.find((n) => n.action_kind === 'condition')
  const yesNode = tpl?.nodes?.find((n) => n.title === '满足目标')
  const noNode = tpl?.nodes?.find((n) => n.title === '不满足目标')
  check('测试模板已建立', tpl?.nodes?.length === 3, J(tpl?.problems ?? ''))
  check(
    'branch_false_node_id 落库并能读回',
    cond?.branch_node_id === yesNode?.id && cond?.branch_false_node_id === noNode?.id,
    J(cond && { t: cond.branch_node_id, f: cond.branch_false_node_id })
  )

  // ------------------------------------------------ 2. 推进：不成立走 false、成立走 true
  const instFalse = await conn.evaluate(
    `window.zhixing.db.instantiateWorkflow(${tpl.id}, ${J(STAMP + ' 不成立')}, null, 'first')`
  )
  check(
    '条件不成立 → 走「不满足」分支',
    instFalse?.steps?.[0]?.title === '不满足目标',
    J(instFalse?.steps?.map((s) => s.title))
  )

  await conn.evaluate(`window.zhixing.db.toggleTask(${task.id})`)
  const instTrue = await conn.evaluate(
    `window.zhixing.db.instantiateWorkflow(${tpl.id}, ${J(STAMP + ' 成立')}, null, 'first')`
  )
  check(
    '条件成立 → 走「满足」分支',
    instTrue?.steps?.[0]?.title === '满足目标',
    J(instTrue?.steps?.map((s) => s.title))
  )

  // ------------------------------------------------ 3. 实例再次运行 / 删除
  const rerun = await conn.evaluate(`window.zhixing.db.rerunWorkflowInstance(${instFalse.id})`)
  check(
    '再次运行新开一个实例（旧实例保留）',
    Boolean(rerun) && rerun.id !== instFalse.id,
    J({ old: instFalse.id, next: rerun?.id })
  )
  const stillOld = await conn.evaluate(`window.zhixing.db.workflowInstance(${instFalse.id})`)
  check('旧实例记录仍在', stillOld?.id === instFalse.id)

  const rerunTaskId = rerun?.steps?.[0]?.task_id ?? 0
  const delOk = await conn.evaluate(`window.zhixing.db.deleteWorkflowInstance(${rerun.id})`)
  const gone = await conn.evaluate(`window.zhixing.db.workflowInstance(${rerun.id})`)
  const tplAlive = await conn.evaluate(`window.zhixing.db.workflowTemplate(${tpl.id})`)
  check('删除实例：实例没了、模板还在', delOk === true && gone === null && tplAlive?.id === tpl.id)
  const taskAlive = await conn.evaluate(
    `window.zhixing.db.tasks(500).then((rows) => rows.some((t) => t.id === ${rerunTaskId}))`
  )
  check('删除实例不删已生成的任务', taskAlive === true, J(rerunTaskId))

  // ------------------------------------------------ 4. 画布 UI
  await conn.evaluate(`document.querySelector('[data-nav-item="workflow"]').click()`)
  await sleep(1400)
  const ui = await conn.evaluate(
    `(() => {
       const on = document.querySelector('.wf-node--template.wf-node--on strong')
       const strip = document.querySelector('.wf-node__cond text')
       return {
         template: on ? on.textContent : '',
         strip: strip ? strip.textContent : '',
         ports: document.querySelectorAll('.wf-port').length,
         labels: [...document.querySelectorAll('.wf-port__label')].map((e) => e.textContent),
         instBtns: document.querySelectorAll('[aria-label="再次运行实例"],[aria-label="删除实例"]').length,
         splitter: document.querySelectorAll('.wf-splitter').length
       }
     })()`
  )
  check('打开的是刚建的模板', String(ui.template).includes('双分支'), J(ui.template))
  check('条件节点上显示了条件内容', String(ui.strip).includes('任务'), J(ui.strip))
  check('两条分支端口都在', ui.ports === 2, J(ui.ports))
  // 「满足 / 不满足」写在条件节点两个端口旁，不是画在虚线上
  check(
    '两个端口分别标着满足 / 不满足',
    ui.labels.includes('满足') && ui.labels.includes('不满足'),
    J(ui.labels)
  )
  check('实例行有「再次运行 / 删除」入口', ui.instBtns >= 2, J(ui.instBtns))
  check('模板栏分隔条存在', ui.splitter === 1, J(ui.splitter))

  // ------------------------------------------------ 5. 拖动分隔条改宽度
  const drag = await conn.evaluate(
    `(async () => {
       const el = document.querySelector('.wf-splitter')
       const aside = document.querySelector('.wf-side')
       if (!el || !aside) return null
       const before = Math.round(aside.getBoundingClientRect().width)
       const opts = { bubbles: true, pointerId: 7, isPrimary: true, clientY: 320 }
       el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, opts, { clientX: 240 })))
       el.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, opts, { clientX: 330 })))
       el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts, { clientX: 330 })))
       await new Promise((r) => setTimeout(r, 150))
       return {
         before,
         after: Math.round(aside.getBoundingClientRect().width),
         stored: Number(localStorage.getItem('wf.sideWidth'))
       }
     })()`
  )
  check(
    '拖动分隔条能加宽模板栏并记进 localStorage',
    Boolean(drag) && drag.after > drag.before + 40 && drag.stored === drag.after,
    J(drag)
  )
} catch (err) {
  check('脚本执行完成', false, err instanceof Error ? err.message : String(err))
}

const failed = results.filter(([, ok]) => !ok)
console.log('\n' + (failed.length ? '✗ ' + failed.length + ' 项未通过' : '✓ 全部通过') + `（${results.length} 项）`)
child.kill()
process.exit(failed.length ? 1 : 0)
