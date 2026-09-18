/**
 * 长列表虚拟滚动验证（O4）：造 400 条任务，确认 DOM 行数远小于数据行数，且滚动后会换行。
 * 用法：node scripts/vlistcheck.mjs
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
const tmpHome = join(root, '.screenshots', 'vlist-home')
const PORT = 9241
const sql = (f, q) => execFileSync('sqlite3', [f, q]).toString().trim()
if (!existsSync(backup)) { console.error('✗ 缺备份库'); process.exit(1) }
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(backup, join(tmpHome, 'zhixing.db'))
const dbFile = join(tmpHome, 'zhixing.db')

// 递归 CTE 造 400 条任务（不经过 IPC，省时间）
sql(dbFile, `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 400)
  INSERT INTO task (title, notes_md, status, priority, repeat_period, streak, sort_key, created_at, updated_at)
  SELECT '验证-虚拟-' || x, '', 'todo', 0, 'none', 0, 1000 + x, datetime('now'), datetime('now') FROM c;`)
const total = Number(sql(dbFile, "SELECT COUNT(*) FROM task WHERE deleted_at IS NULL AND title LIKE '验证-虚拟-%';"))

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

await ev(`document.querySelector('[data-nav-item="tasks"]')?.click()`)
await sleep(1500)

const snap = JSON.parse(await ev(`JSON.stringify({
  hasList: !!document.querySelector('.vlist'),
  hasOldTree: !!document.querySelector('.task-tree'),
  rows: document.querySelectorAll('.vlist__row').length,
  taskRows: document.querySelectorAll('.trow').length,
  innerHeight: document.querySelector('.vlist__inner')?.style.height ?? '',
})`))
check('列表视图使用虚拟容器', snap.hasList === true)
check('旧的整棵树容器已移除', snap.hasOldTree === false)
check('数据里有 400+ 行', total >= 400, `db=${total}`)
check('DOM 只渲染窗口内的行', snap.rows > 0 && snap.rows < 120, `dom=${snap.rows} db=${total}`)
check('内层撑高到总高度', parseInt(snap.innerHeight, 10) >= 400 * 30, `inner=${snap.innerHeight}`)

// 滚动后应换行
await ev(`document.querySelector('.vlist').scrollTop = 3000`, false)
await sleep(700)
const after = JSON.parse(await ev(`JSON.stringify({
  rows: document.querySelectorAll('.vlist__row').length,
  first: document.querySelector('.vlist__row .trow__title')?.textContent ?? '',
})`))
check('滚动后仍是窗口化渲染', after.rows > 0 && after.rows < 120, `dom=${after.rows}`)
check('滚动后渲染的是靠后的行', after.first !== snap.first, `first=${after.first}`)

ws.close()
child.kill()
await sleep(500)
const realDb = join(process.env.HOME, 'Library/Application Support/ZhiXing/zhixing.db')
check('真实库未被写入', sql(realDb, "SELECT COUNT(*) FROM task WHERE title LIKE '验证-虚拟-%';") === '0')
rmSync(tmpHome, { recursive: true, force: true })
const failed = results.filter(([, ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
process.exit(failed ? 1 : 0)
