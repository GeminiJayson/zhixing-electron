/**
 * 笔记编辑器验证：CodeMirror 挂载、语法高亮、[[ 补全、内容同步落库。
 * 用法：node scripts/editorcheck.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

// 老脚本里的 root / require 一律保留：原样带过来的自有声明（sql/dbFile 等）还依赖它们
const root = ROOT
const require = createRequire(import.meta.url)
const tmpHome = join(ROOT, '.screenshots', 'editor-home')
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

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()
// 造一篇已知正文的笔记并打开
const note = await app.evaluate(`window.zhixing.db.createNote('验证-编辑器', null, '# 原始标题\\n\\n正文第一行')`)
await app.evaluate(`document.querySelector('[data-nav-item="notes"]')?.click()`)
await sleep(600)
await app.evaluate(`([...document.querySelectorAll('.ntree__note')].find(el => el.textContent.includes('验证-编辑器')))?.click()`)
await sleep(1200)

const mounted = await app.evaluate(`JSON.stringify({
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
const hlRaw = await app.evaluate(
  `JSON.stringify([...document.querySelectorAll('.cm-content span')].map(s => ({ t: s.textContent, w: getComputedStyle(s).fontWeight, c: getComputedStyle(s).color })))`
)
const spans = JSON.parse(hlRaw)
const headingSpans = spans.filter((s) => Number(s.w) >= 600 && s.t && s.t.includes('原始标题'))
check('Markdown 标题被高亮（加粗 + 强调色）', headingSpans.length > 0, JSON.stringify(headingSpans.slice(0, 2)))

// 输入 [[ 应弹出补全候选（候选来自其他笔记标题）
await app.evaluate(`document.querySelector('.cm-content')?.focus()`, false)
await app.evaluate(`window.getSelection()`, false)
app.send('Input.insertText', { text: '\n\n[[验证' })
await sleep(1200)
const comp = await app.evaluate(`JSON.stringify({
  tooltip: !!document.querySelector('.cm-tooltip-autocomplete'),
  options: [...document.querySelectorAll('.cm-tooltip-autocomplete li')].map(li => li.textContent).slice(0, 5),
})`)
const c = JSON.parse(comp)
check('输入 [[ 弹出补全', c.tooltip === true, JSON.stringify(c.options))
check('候选匹配到已有笔记标题', c.options.some((o) => String(o).includes('验证-编辑器')), JSON.stringify(c.options))

// 内容同步落库（等自动保存）
await sleep(1800)
const saved = app.evaluate(`window.zhixing.db.note(${note.id}).then(n => n.content_md)`)
check('编辑内容已同步到数据库', String(await saved).includes('验证'), String(await saved).slice(-30))

await sleep(600)
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
check('真实库未被写入', sql(realDb, "SELECT COUNT(*) FROM note WHERE title = '验证-编辑器';") === '0')

await app.close()
process.exit(finish())