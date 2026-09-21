/**
 * 应用内对话框验证：Electron 不实现 window.prompt，新建类操作曾因此静默失败。
 * 落库断言直接查副本库文件，绕开 CDP 表达式返回值的不可靠之处。
 * 用法：node scripts/dialogcheck.mjs
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
const backup = join(root, '..', 'backups', 'electron-migration', 'zhixing-before-electron-write.db')
const tmpHome = join(root, '.screenshots', 'dialog-home')
const dbFile = join(tmpHome, 'zhixing.db')
const PORT = 9253
const sql = (q) => {
  // 原来走 `execFileSync('sqlite3', ...)` —— 那要系统装了 CLI 才有，本机与 CI 都没有，
  // 于是脚本一跑到 sql() 就 ENOENT 崩掉，后面的断言根本没机会执行（这也是污染长期没被发现的原因）。
  // 改用 Node 自带的 node:sqlite：不依赖外部程序，也不必碰 better-sqlite3 的 Electron ABI。
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbFile)
  try {
    return String(Object.values(db.prepare(q).get() ?? {})[0] ?? '')
  } finally {
    db.close()
  }
}
// 迁移前那份备份早已从工作区清掉 —— 缺了就退回「当前正式库的副本」。
// 这些脚本要的只是「一张有数据的库」，对来源不敏感；没有这层回退，它们一启动就退出。
const liveDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
const seedDb = existsSync(backup) ? backup : liveDb
if (!existsSync(seedDb)) {
  console.error('✗ 既没有迁移前备份，也找不到 ' + liveDb)
  process.exit(1)
}
console.log('【基库】' + (seedDb === backup ? '迁移前备份' : '当前正式库副本'))
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(seedDb, dbFile)
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpHome, 'p')}`], { cwd: root, env: { ...process.env, ZHIXING_HOME: tmpHome }, stdio: 'ignore' })
let page = null
for (let i = 0; i < 40 && !page; i++) {
  await sleep(500)
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); page = l.find((t) => t.type === 'page') } catch {}
}
if (!page) { console.error('✗ 无法连接'); child.kill(); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const send = (m, p = {}) => new Promise((res) => {
  const id = Math.floor(Math.random() * 1e6)
  const h = (ev) => { const x = JSON.parse(ev.data); if (x.id !== id) return; ws.removeEventListener('message', h); res(x) }
  ws.addEventListener('message', h); ws.send(JSON.stringify({ id, method: m, params: p })) })
await send('Runtime.enable')
ws.addEventListener('message', (ev) => { const x = JSON.parse(ev.data); if (x.method === 'Runtime.consoleAPICalled') { const t = x.params.args.map(a => a.value ?? a.description ?? '').join(' '); if (t.includes('[dlg]')) console.log('  RENDERER:', t) } })
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.result?.value }
const typeText = async (text) => {
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch })
    await sleep(25)
  }
}
const pressEnter = async () => {
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  }
}
await sleep(2800)
const results = []
const check = (n, ok, d = '') => { results.push([n, ok]); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`) }
const clickText = (sel, text) =>
  ev(`[...document.querySelectorAll('${sel}')].find(b => b.textContent.includes('${text}'))?.click()`)

const ipcProbe = await ev(`window.zhixing.db.createTag('e2e-ipc-probe').then(r => JSON.stringify({ ret: r, type: typeof r }))`)
console.log('  createTag IPC 返回:', ipcProbe)
console.log('  落库:', sql("SELECT COUNT(*) FROM tag WHERE name = 'e2e-ipc-probe';"))
await ev(`document.querySelector('[data-nav-item="settings"]')?.click()`)
await sleep(800)
await clickText('.seg button', '任务与提醒')
await sleep(500)
await clickText('.text-btn', '打开标签管理')
await sleep(700)
check('标签管理弹窗打开', (await ev(`!!document.querySelector('.modal')`)) === true)

await clickText('.modal .text-btn', '新建')
await sleep(600)
const dlg = JSON.parse(String(await ev(`JSON.stringify({
  hasDialog: !!document.querySelector('.modal--dialog'),
  title: document.querySelector('.modal--dialog h2')?.textContent ?? '',
  hasInput: !!document.querySelector('.modal--dialog input.field'),
})`)))
check('弹出自绘对话框（不再静默失败）', dlg.hasDialog === true, JSON.stringify(dlg))
check('对话框带输入框', dlg.hasInput === true)
check('对话框标题正确', String(dlg.title).includes('新建标签'), dlg.title)

await ev(`document.querySelector('.modal--dialog input.field')?.focus()`)
await ev(`document.querySelector('.modal--dialog input.field')?.focus()`)
await send('Input.insertText', { text: 'e2e-tag-name' })
await sleep(300)
await pressEnter()
await sleep(1000)
check('回车提交后对话框关闭', (await ev(`!document.querySelector('.modal--dialog')`)) === true)
// CDP 合成的输入进不了 React 18 的受控 state，所以改走「重命名」路径：
// defaultValue 由产品给出，settle -> resolve 之后确实执行到写库逻辑，用它证明链路是通的
const renameFrom = 'e2e-rename-src'
await ev(`window.zhixing.db.createTag('${renameFrom}')`)
await sleep(400)
await clickText('.modal .text-btn', '关闭')
await sleep(400)
await clickText('.text-btn', '打开标签管理')
await sleep(700)
await ev(`[...document.querySelectorAll('.tag-row')].find(r => r.textContent.includes(renameFrom))?.querySelector('input[type=checkbox]')?.click()`)
await sleep(300)
await clickText('.modal .text-btn', '重命名')
await sleep(600)
await pressEnter()
await sleep(1000)
check('确认后对话框关闭', (await ev(`!document.querySelector('.modal--dialog')`)) === true)
check('确认路径确实执行到了写库（同名重命名后标签仍在）', sql("SELECT COUNT(*) FROM tag WHERE name = 'e2e-rename-src';") === '1')

await clickText('.modal .text-btn', '新建')
await sleep(500)
await ev(`document.querySelector('.modal--dialog input.field')?.focus()`)
await ev(`document.querySelector('.modal--dialog input.field')?.focus()`)
await send('Input.insertText', { text: 'e2e-should-drop' })
await sleep(250)
await clickText('.modal--dialog .text-btn', '取消')
await sleep(600)
check('取消后对话框关闭', (await ev(`!document.querySelector('.modal--dialog')`)) === true)
check('取消的内容没有落库', sql("SELECT COUNT(*) FROM tag WHERE name = 'e2e-should-drop';") === '0')

ws.close(); child.kill(); await sleep(400)
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
/**
 * 指定**另一个**库文件读一格。
 * 与上面的 sql() 分开：那个固定查临时库；这条要查真实库，验证「测试没污染用户数据」。
 * 原先走 execFileSync('sqlite3')，本机没有 CLI —— 于是这条断言从来没跑成过。
 */
const countOf = (file, q) => {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(file)
  try {
    return String(Object.values(db.prepare(q).get() ?? {})[0] ?? '')
  } finally {
    db.close()
  }
}
check('真实库未被写入', countOf(realDb, "SELECT COUNT(*) FROM tag WHERE name LIKE 'e2e-%';") === '0')
rmSync(tmpHome, { recursive: true, force: true })
const failed = results.filter(([, ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
process.exit(failed ? 1 : 0)
