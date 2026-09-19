/**
 * 外部任务同步端到端验证（本地假接口）。
 *
 * 覆盖：
 *   1. 没配地址时明确拒绝
 *   2. 首次同步：新增任务、落到收件箱、记录 external_id
 *   3. 再次同步（外部没变）：只统计「未变」，不重复创建
 *   4. 外部改了标题 / 标了完成：本地更新；外部又取消完成时**本地不回退**
 *   5. 缺 id 或缺标题的条目被跳过
 *   6. 响应不是数组时给出可操作的提示（同时也认 { items: [...] }）
 *
 * 用法：node scripts/tasksynccheck.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = join(root, '.screenshots', 'tasksync-home')
const PORT = 9252
const API_PORT = 9251

const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
if (!existsSync(realDb)) {
  console.error('✗ 找不到真实库：' + realDb)
  process.exit(1)
}

// ---------------- 假接口：payload 可变，按场景改
let payload = []
let mode = 'array'
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  const body =
    mode === 'array'
      ? payload
      : mode === 'wrapped'
        ? { items: payload }
        : mode === 'wrapped-deep'
          ? { data: { rows: payload } }
          : { message: 'ok' }
  res.end(JSON.stringify(body))
})
await new Promise((r) => server.listen(API_PORT, '127.0.0.1', r))

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

const attach = async () => {
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
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
  server.close()
  process.exit(1)
}
await sleep(3000)

const results = []
const check = (name, ok, detail = '') => {
  results.push([name, ok])
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''))
}
const J = (v) => JSON.stringify(v)
const API_URL = 'http://127.0.0.1:' + API_PORT + '/tasks'
const STAMP = 'TS' + Date.now().toString(36)

// 1) 没配地址
const noUrl = await conn.evaluate('window.zhixing.taskSync.now()')
check('未配置接口地址时拒绝并说明', noUrl?.ok === false && /地址/.test(noUrl.message), noUrl?.message)

// 2) 首次同步
payload = [
  { id: STAMP + '-1', title: STAMP + ' 外部任务一', description: '来自接口', due_date: '2026-10-01', priority: 'high' },
  { id: STAMP + '-2', title: STAMP + ' 外部任务二', done: false },
]
await conn.evaluate(
  `window.zhixing.db.setSettings({ task_api_url: ${J(API_URL)}, task_api_key: 'k1', task_api_enabled: '0', task_api_interval_min: '30' })`
)
const first = await conn.evaluate('window.zhixing.taskSync.now()')
check('首次同步新建两条', first?.ok === true && first.created === 2, J(first))

const tasks1 = await conn.evaluate('window.zhixing.db.tasks(200)')
const t1 = tasks1.find((t) => t.title === STAMP + ' 外部任务一')
const t2 = tasks1.find((t) => t.title === STAMP + ' 外部任务二')
check('任务真的落库（标题 / 备注 / 截止 / 优先级）', !!t1 && t1.notes_md === '来自接口' && t1.due_date === '2026-10-01' && t1.priority === 6, J({ due: t1?.due_date, p: t1?.priority }))
check('未完成的外部任务保持待办', t2?.status === 'todo', t2?.status)
check('重复标题不会被当成同一条（按 id 认领）', !!t2 && t1.id !== t2.id, `${t1?.id} / ${t2?.id}`)

// 3) 原样再同步
const second = await conn.evaluate('window.zhixing.taskSync.now()')
check('没有变化时只统计「未变」，不重复创建', second?.ok === true && second.created === 0 && second.unchanged === 2, J(second))
const countAfter = (await conn.evaluate('window.zhixing.db.tasks(200)')).filter((t) => t.title.startsWith(STAMP)).length
check('本地任务数没有增加', countAfter === 2, 'count=' + countAfter)

// 4) 改名 + 完成；再取消完成（本地不回退）
payload = [
  { id: STAMP + '-1', title: STAMP + ' 外部任务一（改名）', description: '来自接口', due_date: '2026-10-02', priority: 2 },
  { id: STAMP + '-2', title: STAMP + ' 外部任务二', done: true },
]
const third = await conn.evaluate('window.zhixing.taskSync.now()')
check('外部改动被同步（两条都更新）', third?.ok === true && third.updated === 2, J(third))
const tasks2 = await conn.evaluate('window.zhixing.db.tasks(200)')
const t1b = tasks2.find((t) => t.id === t1.id)
const t2b = tasks2.find((t) => t.id === t2.id)
check('标题与截止跟着外部走', t1b?.title === STAMP + ' 外部任务一（改名）' && t1b?.due_date === '2026-10-02', J({ title: t1b?.title, due: t1b?.due_date }))
check('外部标完成 → 本地也完成', t2b?.status === 'done', t2b?.status)

payload = [
  { id: STAMP + '-1', title: STAMP + ' 外部任务一（改名）', description: '来自接口', due_date: '2026-10-02', priority: 2 },
  { id: STAMP + '-2', title: STAMP + ' 外部任务二', done: false },
]
await conn.evaluate('window.zhixing.taskSync.now()')
const tasks3 = await conn.evaluate('window.zhixing.db.tasks(200)')
check('外部取消完成时本地**不回退**', tasks3.find((t) => t.id === t2.id)?.status === 'done', tasks3.find((t) => t.id === t2.id)?.status)

// 5) 缺 id / 缺标题 → 跳过
payload = [
  { title: STAMP + ' 没有 id' },
  { id: STAMP + '-3', description: '没有标题' },
  { id: STAMP + '-4', title: STAMP + ' 正常的一条' },
]
const fourth = await conn.evaluate('window.zhixing.taskSync.now()')
check('缺 id / 缺标题的条目被跳过并计数', fourth?.skipped === 2 && fourth.created === 1, J(fourth))

// 6) 字段映射（JSON 路径）+ 列表路径
payload = [
  {
    key: { id: STAMP + '-M1' },
    attributes: { name: STAMP + ' 映射标题', desc: '映射备注' },
    when: { due: '2026-11-05' },
  },
]
mode = 'wrapped-deep'
await conn.evaluate(
  `window.zhixing.db.setSettings({
     task_api_rows_path: 'data.rows',
     task_api_map: ${J(JSON.stringify({ id: 'key.id', title: 'attributes.name', notes: 'attributes.desc', due: 'when.due' }))}
   })`
)
const mapped = await conn.evaluate('window.zhixing.taskSync.now()')
check('字段映射生效（按 JSON 路径取值）', mapped?.ok === true && mapped.created === 1, J(mapped))
const mappedTask = (await conn.evaluate('window.zhixing.db.tasks(200)')).find(
  (t) => t.title === STAMP + ' 映射标题'
)
check(
  '映射到的标题 / 备注 / 截止都落库了',
  mappedTask?.notes_md === '映射备注' && mappedTask?.due_date === '2026-11-05',
  J({ notes: mappedTask?.notes_md, due: mappedTask?.due_date })
)
await conn.evaluate("window.zhixing.db.setSettings({ task_api_rows_path: '', task_api_map: '' })")
mode = 'array'

// 7) 去重：本地已有同名任务 → 认领而不是新建
const LOCAL_TITLE = STAMP + ' 本地已有的任务'
await conn.evaluate(`window.zhixing.db.createTask(${J(LOCAL_TITLE)}, null, null)`)
const beforeCount = (await conn.evaluate('window.zhixing.db.tasks(300)')).filter(
  (t) => t.title === LOCAL_TITLE
).length
payload = [{ id: STAMP + '-D1', title: LOCAL_TITLE, description: '来自外部' }]
const deduped = await conn.evaluate('window.zhixing.taskSync.now()')
check('同名任务被认领（不是新建）', deduped?.ok === true && deduped.linked === 1 && deduped.created === 0, J(deduped))
const afterList = (await conn.evaluate('window.zhixing.db.tasks(300)')).filter((t) => t.title === LOCAL_TITLE)
check('本地那条没有被复制成两条', beforeCount === 1 && afterList.length === 1, `${beforeCount} → ${afterList.length}`)
const again = await conn.evaluate('window.zhixing.taskSync.now()')
// 认领后再同步走的是 id 匹配：不会再新建、也不会再认领一次
// （这次 updated=1 是正常的 —— 认领只建立身份映射，外部字段从这一刻起开始同步）
check(
  '认领后按 id 匹配（不再新建、也不再认领）',
  again?.created === 0 && again.linked === 0,
  J(again)
)

// 8) 非数组响应
mode = 'other'
const bad = await conn.evaluate('window.zhixing.taskSync.now()')
check('响应不是数组时给出可操作的提示', bad?.ok === false && /items/.test(bad.message), bad?.message)
mode = 'wrapped'
const wrapped = await conn.evaluate('window.zhixing.taskSync.now()')
check('{ items: [...] } 这种包装也认', wrapped?.ok === true, wrapped?.message)

conn.ws.close()
child.kill()
server.close()
await sleep(500)
rmSync(tmpHome, { recursive: true, force: true })

const failed = results.filter(([, ok]) => !ok)
console.log('')
console.log((results.length - failed.length) + '/' + results.length + ' 项通过')
process.exit(failed.length ? 1 : 0)
