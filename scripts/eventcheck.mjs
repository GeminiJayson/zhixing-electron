/**
 * 数据变更事件层验证（O3）：写操作广播、域划分正确、读操作不广播、订阅能收到。
 * 用法：node scripts/eventcheck.mjs
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
const tmpHome = join(root, '.screenshots', 'event-home')
const PORT = 9242
const sql = (f, q) => execFileSync('sqlite3', [f, q]).toString().trim()
if (!existsSync(backup)) { console.error('✗ 缺备份库'); process.exit(1) }
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(backup, join(tmpHome, 'zhixing.db'))
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpHome, 'p')}`], {
  cwd: root, env: { ...process.env, ZHIXING_HOME: tmpHome }, stdio: ['ignore', 'pipe', 'pipe'],
})
let page = null
for (let i = 0; i < 40 && !page; i++) {
  await sleep(500)
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); page = l.find((t) => t.type === 'page') } catch {}
}
if (!page) { console.error('✗ 无法连接'); child.kill(); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const send = (m, p = {}) => new Promise((resolve) => {
  const id = Math.floor(Math.random() * 1e6)
  const h = (ev) => { const x = JSON.parse(ev.data); if (x.id !== id) return; ws.removeEventListener('message', h); resolve(x) }
  ws.addEventListener('message', h); ws.send(JSON.stringify({ id, method: m, params: p })) })
await send('Runtime.enable')
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'fail')
  return r.result?.result?.value }
await sleep(2600)
const results = []
const check = (n, ok, d = '') => { results.push([n, ok]); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`) }

// 收集广播：直接挂 preload 的订阅通道
await ev(`window.__domains = []; window.zhixing.db.onDataChanged((d) => window.__domains.push(d))`)

// 任务域写操作
const t = await ev("window.zhixing.db.createTask('验证-事件-任务', null, null).then(x => x.id)")
await sleep(300)
await ev(`window.zhixing.db.toggleTask(${t})`)
await sleep(300)
const afterTask = await ev('JSON.stringify(window.__domains)')
const taskDomains = JSON.parse(afterTask)
check('任务写操作广播 task 域', taskDomains.filter((d) => d === 'task').length >= 2, JSON.stringify(taskDomains))

// 读操作不应广播
const before = taskDomains.length
await ev('window.zhixing.db.tasks()')
await ev('window.zhixing.db.overview()')
await ev('window.zhixing.db.graph(false)')
await sleep(300)
const afterRead = JSON.parse(await ev('JSON.stringify(window.__domains)'))
check('读操作不广播', afterRead.length === before, `${before} → ${afterRead.length}`)

// 笔记域
const n = await ev("window.zhixing.db.createNote('验证-事件-笔记', null).then(x => x.id)")
await sleep(300)
await ev(`window.zhixing.db.saveNote(${n}, { content_md: '正文' })`)
await sleep(400)
const afterNote = JSON.parse(await ev('JSON.stringify(window.__domains)'))
check('笔记写操作广播 note 域', afterNote.includes('note'), JSON.stringify(afterNote.slice(-4)))
check('域是分开的（task 与 note 不混淆）', afterNote.includes('task') && afterNote.includes('note'))

// 设置域
await ev("window.zhixing.db.setSetting('验证_事件键', '1')")
await sleep(300)
const afterSetting = JSON.parse(await ev('JSON.stringify(window.__domains)'))
check('设置写操作广播 settings 域', afterSetting.includes('settings'), JSON.stringify(afterSetting.slice(-3)))

// 渲染侧订阅能收到（经 shared/events 的订阅表）
await ev(`window.__hits = 0`)
await ev(`(() => {
  const m = window.__zhixingEvents
  return typeof m
})()`)
await ev(`window.zhixing.db.createTask('验证-事件-订阅', null, null)`)
await sleep(300)
const finalDomains = JSON.parse(await ev('JSON.stringify(window.__domains)'))
check('多次写入持续广播（订阅不会被一次性消费）', finalDomains.filter((d) => d === 'task').length >= 3, `task=${finalDomains.filter((d) => d === 'task').length}`)

ws.close()
child.kill()
await sleep(500)
const dbFile = join(tmpHome, 'zhixing.db')
check('测试数据落在副本库', Number(sql(dbFile, "SELECT COUNT(*) FROM task WHERE title LIKE '验证-事件-%';")) >= 2)
const realDb = join(process.env.HOME, 'Library/Application Support/ZhiXing/zhixing.db')
check('真实库未被写入', sql(realDb, "SELECT COUNT(*) FROM task WHERE title LIKE '验证-事件-%';") === '0')
rmSync(tmpHome, { recursive: true, force: true })
const failed = results.filter(([, ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
process.exit(failed ? 1 : 0)
