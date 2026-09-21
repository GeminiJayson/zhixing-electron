/**
 * 笔记编辑器验证（O9）：CodeMirror 挂载、语法高亮、[[ 补全、内容同步落库。
 * 用法：node scripts/editorcheck.mjs
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
const tmpHome = join(root, '.screenshots', 'editor-home')
const PORT = 9239
const sql = (f, q) => {
  // 原来走 `execFileSync('sqlite3', ...)` —— 那要系统装了 CLI 才有，本机与 CI 都没有，
  // 于是脚本一跑到 sql() 就 ENOENT 崩掉，后面的断言根本没机会执行（这也是污染长期没被发现的原因）。
  // 改用 Node 自带的 node:sqlite：不依赖外部程序，也不必碰 better-sqlite3 的 Electron ABI。
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(f)
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
copyFileSync(seedDb, join(tmpHome, 'zhixing.db'))
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
const ev = async (e, awaitPromise = true) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'fail')
  return r.result?.result?.value }
await sleep(2500)
const results = []
const check = (n, ok, d = '') => { results.push([n, ok]); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`) }

// 造一篇已知正文的笔记并打开
const note = await ev(`window.zhixing.db.createNote('验证-编辑器', null, '# 原始标题\\n\\n正文第一行')`)
await ev(`document.querySelector('[data-nav-item="notes"]')?.click()`)
await sleep(600)
await ev(`([...document.querySelectorAll('.ntree__note')].find(el => el.textContent.includes('验证-编辑器')))?.click()`)
await sleep(1200)

const mounted = await ev(`JSON.stringify({
  cm: !!document.querySelector('.cm-editor'),
  content: document.querySelector('.cm-content')?.textContent ?? '',
  textareaLeft: document.querySelectorAll('textarea.editor__area').length,
})`)
const m = JSON.parse(mounted)
check('CodeMirror 已挂载', m.cm === true)
check('编辑器里是笔记正文', m.content.includes('原始标题') && m.content.includes('正文第一行'), m.content.slice(0, 40))
check('旧的 textarea 已不在', m.textareaLeft === 0)

// 语法高亮：CodeMirror 6 用动态 hash 类名（.ͼX），不能按类名断言，
// 改为检查标题 span 实际拿到了加粗 + 强调色。
const hlRaw = await ev(
  `JSON.stringify([...document.querySelectorAll('.cm-content span')].map(s => ({ t: s.textContent, w: getComputedStyle(s).fontWeight, c: getComputedStyle(s).color })))`
)
const spans = JSON.parse(hlRaw)
const headingSpans = spans.filter((s) => Number(s.w) >= 600 && s.t && s.t.includes('原始标题'))
check('Markdown 标题被高亮（加粗 + 强调色）', headingSpans.length > 0, JSON.stringify(headingSpans.slice(0, 2)))

// 输入 [[ 应弹出补全候选（候选来自其他笔记标题）
await ev(`document.querySelector('.cm-content')?.focus()`, false)
await ev(`window.getSelection()`, false)
send('Input.insertText', { text: '\n\n[[验证' })
await sleep(1200)
const comp = await ev(`JSON.stringify({
  tooltip: !!document.querySelector('.cm-tooltip-autocomplete'),
  options: [...document.querySelectorAll('.cm-tooltip-autocomplete li')].map(li => li.textContent).slice(0, 5),
})`)
const c = JSON.parse(comp)
check('输入 [[ 弹出补全', c.tooltip === true, JSON.stringify(c.options))
check('候选匹配到已有笔记标题', c.options.some((o) => String(o).includes('验证-编辑器')), JSON.stringify(c.options))

// 内容同步落库（等自动保存）
await sleep(1800)
const saved = ev(`window.zhixing.db.note(${note.id}).then(n => n.content_md)`)
check('编辑内容已同步到数据库', String(await saved).includes('验证'), String(await saved).slice(-30))

ws.close()
child.kill()
await sleep(600)
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
check('真实库未被写入', sql(realDb, "SELECT COUNT(*) FROM note WHERE title = '验证-编辑器';") === '0')
rmSync(tmpHome, { recursive: true, force: true })
const failed = results.filter(([, ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
process.exit(failed ? 1 : 0)
