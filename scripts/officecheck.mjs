/**
 * Office 内嵌预览验证：docx/xlsx 解析为 HTML，非 Office 与缺失文件降级。
 * 用法：node scripts/officecheck.mjs
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
const tmpHome = join(root, '.screenshots', 'office-home')
const fixtures = join(tmpHome, 'files')
const PORT = 9238
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
mkdirSync(fixtures, { recursive: true })
copyFileSync(seedDb, join(tmpHome, 'zhixing.db'))

// 夹具用 Node 的 docx / xlsx 造真实 .docx / .xlsx（生成脚本随仓库走，别放 /tmp）。
// 直接用当前 Node 进程执行生成脚本，不需要任何外部解释器。
const docxFile = join(fixtures, '预览验证.docx')
const xlsxFile = join(fixtures, '预览验证.xlsx')
const fixturesScript = join(root, 'scripts', 'fixtures', 'gen-office-fixtures.mjs')
execFileSync(process.execPath, [fixturesScript, docxFile, xlsxFile], { stdio: 'inherit' })

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
await sleep(2500)
const results = []
const check = (n, ok, d = '') => { results.push([n, ok]); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`) }

const mkNote = async (title, format, path) => {
  const n = await ev(`window.zhixing.db.createNote(${JSON.stringify(title)}, null, ${JSON.stringify(path)})`)
  await ev(`window.zhixing.db.saveNote(${n.id}, { format: ${JSON.stringify(format)} })`)
  return n.id
}

const wordId = await mkNote('验证-Word-预览', 'word', docxFile)
const excelId = await mkNote('验证-Excel-预览', 'excel', xlsxFile)
const missingId = await mkNote('验证-缺失-预览', 'word', join(fixtures, '不存在.docx'))
const linkId = await mkNote('验证-链接-预览', 'link', 'https://example.com')

const word = await ev(`window.zhixing.db.previewNote(${wordId})`)
check('docx 被识别并解析', word.kind === 'docx' && word.html.length > 0, `${word.kind} len=${word.html.length}`)
check('docx 段落文本进入结果', word.html.includes('知行 Office 预览验证段落'))
check('docx 第二段落也在', word.html.includes('第二段落内容'))
check('docx 表格被保留', word.html.includes('<table') && word.html.includes('单元格A') && word.html.includes('单元格B'))

const excel = await ev(`window.zhixing.db.previewNote(${excelId})`)
check('xlsx 被识别并解析', excel.kind === 'xlsx' && excel.html.length > 0, `${excel.kind} len=${excel.html.length}`)
check('xlsx 输出表格', excel.html.includes('<table') && excel.html.includes('知行') && excel.html.includes('100'))
check('xlsx 保留工作表名', excel.html.includes('验证表') && excel.html.includes('第二表'), excel.message)
check('xlsx 不含 html/body 外壳', !excel.html.includes('<html') && !excel.html.includes('<body'))

const missing = await ev(`window.zhixing.db.previewNote(${missingId})`)
check('文件不存在时降级', missing.kind === 'none' && missing.message.includes('不存在'), missing.message)
const link = await ev(`window.zhixing.db.previewNote(${linkId})`)
check('链接笔记给出对应提示', link.kind === 'none' && link.message.includes('链接'), link.message)
const ghost = await ev(`window.zhixing.db.previewNote(999999)`)
check('笔记不存在时降级', ghost.kind === 'none' && ghost.message.includes('不存在'))

// 清洗：外部文档产出的 HTML 不应带脚本类标签
const hasDanger = /<script|onerror=|onload=|javascript:/i.test(word.html + excel.html)
check('解析结果不含危险标签/属性', !hasDanger)

ws.close()
child.kill()
await sleep(500)
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
/**
 * 只读地数一格真实库。
 * 原先走 execFileSync('sqlite3') —— 本机没有 CLI，这条「真实库未被写入」的断言从来没跑成过，
 * 而它恰恰是唯一能发现测试污染用户数据的那道关。
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
check('真实库未被写入', countOf(realDb, "SELECT COUNT(*) FROM note WHERE title LIKE '验证-%预览';") === '0')
rmSync(tmpHome, { recursive: true, force: true })
const failed = results.filter(([, ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
process.exit(failed ? 1 : 0)
