/**
 * 任务操作层验证：排序 / 同级移动 / 改挂（防成环）/ 批量 / 标签。
 * 用法：node scripts/taskopscheck.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(root, '..')
const backup = join(repoRoot, 'backups', 'electron-migration', 'zhixing-before-electron-write.db')
const tmpHome = join(root, '.screenshots', 'taskops-home')
const PORT = 9233
const sql = (f, q) => execFileSync('sqlite3', [f, q]).toString().trim()
if (!existsSync(backup)) { console.error('✗ 缺备份库'); process.exit(1) }
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(backup, join(tmpHome, 'zhixing.db'))

const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpHome, 'p')}`], {
  cwd: root,
  env: { ...process.env, ZHIXING_HOME: tmpHome },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let page = null
for (let i = 0; i < 40 && !page; i++) {
  await sleep(500)
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    page = l.find((t) => t.type === 'page')
  } catch {}
}
if (!page) { console.error('✗ 无法连接'); child.kill(); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const send = (m, p = {}) =>
  new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e6)
    const h = (ev) => { const x = JSON.parse(ev.data); if (x.id !== id) return; ws.removeEventListener('message', h); resolve(x) }
    ws.addEventListener('message', h)
    ws.send(JSON.stringify({ id, method: m, params: p }))
  })
await send('Runtime.enable')
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'fail')
  return r.result?.result?.value
}
await sleep(2500)

const results = []
const check = (n, ok, d = '') => { results.push([n, ok]); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`) }

const mk = async (title, parentId) => {
  const t = await ev(`window.zhixing.db.createTask(${JSON.stringify(title)}, ${parentId ?? 'null'})`)
  return t.id
}
const orderOf = async (parentId) =>
  ev(`window.zhixing.db.tasks().then(rows => rows.filter(r => r.parent_id === ${parentId ?? 'null'}).sort((a,b) => a.sort_key - b.sort_key || a.id - b.id).map(r => r.title))`)

const a = await mk('验证-操作-A', null)
const b = await mk('验证-操作-B', null)
const c = await mk('验证-操作-C', null)
let order = await orderOf(null)
const tail = order.slice(-3)
check('三个任务按创建顺序排在末尾', tail.join(',') === '验证-操作-A,验证-操作-B,验证-操作-C', tail.join(','))

// 1) 拖到 B 上方 → A 应落在 B 之前（顺序不变，但走的是中间值算法）
await ev(`window.zhixing.db.reorderTask(${a}, ${b}, false)`)
order = await orderOf(null)
check('排序：A 放到 B 之前', order.indexOf('验证-操作-A') < order.indexOf('验证-操作-B'), order.slice(-3).join(','))

// 2) 同级下移：A +1 → 应在 B 之后
await ev(`window.zhixing.db.moveTaskRelative(${a}, 1)`)
order = await orderOf(null)
check('同级下移：A 落到 B 之后', order.indexOf('验证-操作-A') > order.indexOf('验证-操作-B'), order.slice(-3).join(','))

// 3) 同级上移：A -1 → 回到 B 之前
await ev(`window.zhixing.db.moveTaskRelative(${a}, -1)`)
order = await orderOf(null)
check('同级上移：A 回到 B 之前', order.indexOf('验证-操作-A') < order.indexOf('验证-操作-B'), order.slice(-3).join(','))

// 4) 改挂：C 挂到 A 下
await ev(`window.zhixing.db.reparentTask(${c}, ${a})`)
const kids = await orderOf(a)
check('改挂父级：C 成为 A 的子任务', kids.includes('验证-操作-C'), `children=${kids.join(',')}`)

// 5) 防成环：A 挂到 C（自己的子任务）下 → 应被拒绝
await ev(`window.zhixing.db.reparentTask(${a}, ${c})`)
const aRow = await ev(`window.zhixing.db.tasks().then(rows => rows.find(r => r.id === ${a}))`)
check('防成环：父不能挂到自己的后代下', aRow.parent_id === null, `parent_id=${aRow.parent_id}`)

// 6) 批量完成（只影响未完成的）
const n1 = await ev(`window.zhixing.db.batchComplete([${a}, ${b}])`)
const n2 = await ev(`window.zhixing.db.batchComplete([${a}, ${b}])`)
check('批量完成首次生效', n1 === 2, `changes=${n1}`)
check('批量完成幂等（已完成不再计入）', n2 === 0, `changes=${n2}`)

// 7) 批量设截止 / 清除
await ev(`window.zhixing.db.batchSetDue([${a}, ${b}], '2026-12-31')`)
const dueOk = await ev(`window.zhixing.db.tasks().then(rows => rows.filter(r => r.id === ${a} || r.id === ${b}).every(r => r.due_date === '2026-12-31'))`)
check('批量设截止', dueOk === true)
await ev(`window.zhixing.db.batchSetDue([${a}, ${b}], null)`)
const cleared = await ev(`window.zhixing.db.tasks().then(rows => rows.filter(r => r.id === ${a} || r.id === ${b}).every(r => r.due_date === null))`)
check('批量清除截止', cleared === true)

// 8) 标签：覆盖式写入 + 自动建标签
await ev(`window.zhixing.db.setTaskTags(${a}, ['验证标签一', '验证标签二'])`)
let t1 = await ev(`window.zhixing.db.taskTags().then(rows => rows.filter(r => r.task_id === ${a}).map(r => r.name).sort())`)
check('设置两个标签', t1.join(',') === '验证标签一,验证标签二', t1.join(','))
await ev(`window.zhixing.db.setTaskTags(${a}, ['验证标签二'])`)
t1 = await ev(`window.zhixing.db.taskTags().then(rows => rows.filter(r => r.task_id === ${a}).map(r => r.name))`)
check('覆盖式设置：只留一个', t1.join(',') === '验证标签二', t1.join(','))
const tagExists = await ev("window.zhixing.db.tags().then(rows => rows.some(r => r.name === '验证标签一'))")
check('标签字典里仍保留未被引用的标签', tagExists === true)

ws.close()
child.kill()
await sleep(600)

const realDb = join(process.env.HOME, 'Library/Application Support/ZhiXing/zhixing.db')
const leak = sql(realDb, "SELECT COUNT(*) FROM task WHERE title LIKE '验证-操作-%';")
const tagLeak = sql(realDb, "SELECT COUNT(*) FROM tag WHERE name LIKE '验证标签%';")
check('真实库未被写入（任务与标签）', leak === '0' && tagLeak === '0', `task=${leak} tag=${tagLeak}`)

rmSync(tmpHome, { recursive: true, force: true })
const failed = results.filter(([, ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
process.exit(failed ? 1 : 0)
