import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = join(root, '.screenshots', 'excel-home')
const PORT = 9401
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db'), join(tmpHome, 'zhixing.db'))
const XLSX = require('xlsx')
const book = XLSX.utils.book_new()
const rows = [['编号', '名称', '数量']]
for (let i = 1; i <= 3000; i++) rows.push([String(i), '项目 ' + i, String(i * 3)])
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '大表')
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['a', 'b']]), '小表')
const xlsxPath = join(tmpHome, 'big.xlsx')
XLSX.writeFile(book, xlsxPath)
console.log('【1】已写出 3000 行 xlsx')
const SYS = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem'].join(';')
const child = spawn(require('electron'), ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(tmpHome, 'profile')], { cwd: root, env: { ...process.env, PATH: SYS + ';' + (process.env.PATH ?? ''), ZHIXING_HOME: tmpHome }, stdio: ['ignore', 'pipe', 'pipe'] })
const list = async () => { try { return await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json() } catch { return [] } }
let main = null
for (let i = 0; i < 120 && !main; i++) { main = (await list()).find((t) => t.type === 'page'); if (!main) { if (i % 6 === 0) console.log('【2】等窗口 ' + Math.round(i * 0.5) + 's'); await sleep(500) } }
console.log('【3】连 CDP')
const ws = new WebSocket(main.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const send = (m, p = {}, ms = 15000) => new Promise((res, rej) => {
  const id = Math.floor(Math.random() * 1e6)
  const t = setTimeout(() => { ws.removeEventListener('message', h); rej(new Error('超时 ' + ms + 'ms: ' + m)) }, ms)
  const h = (e) => { const x = JSON.parse(e.data); if (x.id !== id) return; clearTimeout(t); ws.removeEventListener('message', h); res(x) }
  ws.addEventListener('message', h)
  ws.send(JSON.stringify({ id, method: m, params: p }))
})
await send('Runtime.enable')
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result?.result?.value
}
const R = []
const ck = (n, ok, d = '') => { R.push(ok); console.log((ok ? '✓ ' : '✗ ') + n + (d ? ' — ' + d : '')) }
const J = (v) => JSON.stringify(v)
console.log('【4】等界面稳定')
for (let i = 0; i < 8; i++) { await sleep(500); if (i % 3 === 2) console.log('  ' + Math.round((i + 1) * 0.5) + 's') }
const url = xlsxPath.split(String.fromCharCode(92)).join('/')
try {
  await ev('window.__x = ' + JSON.stringify(url))
  const made = await ev('(async () => { const n = await window.zhixing.db.createNote("Excel 验证", null, window.__x, "excel"); return n && { id: n.id, format: n.format, content: n.content_md } })()')
  ck('造出 Excel 笔记并指向 .xlsx', made && made.format === 'excel', J(made))
  await ev('document.querySelector(String.fromCharCode(91) + "data-nav-item=\\\"notes\\\"" + String.fromCharCode(93))?.click()')
  await sleep(2200)
  const clicked = await ev('(async () => { const f = [...document.querySelectorAll(".ntree__note")].find((x) => x.textContent.indexOf("Excel 验证") >= 0); if (!f) return false; f.click(); return true })()')
  ck('在笔记树里点开了它', clicked === true, J({ clicked }))
  await sleep(3000)
  const g = await ev('(() => { const w = document.querySelector(".xlsx-ag"); const h = document.querySelector(".editor__office-head .u-aux"); return { wrap: !!w, ag: !!(document.querySelector(".xlsx-ag .ag-root") || document.querySelector(".ag-root")), rows: document.querySelectorAll(".ag-row").length, head: (document.querySelector(".ag-header-cell-text") || {}).textContent || null, msg: h ? h.textContent.trim() : null } })()')
  ck('渲染出了 ag-grid 网格', g && g.wrap === true && g.ag === true, J(g))
  console.log('【诊断】编辑区提示：' + (g && g.msg))
  ck('表头来自 .xlsx 的真实列名', g && g.head === '编号', J({ head: g && g.head, msg: g && g.msg }))
  ck('虚拟滚动生效（3000 行只渲染可见的少数行）', g && g.rows > 0 && g.rows < 200, J({ rendered: g && g.rows, total: 3000 }))
} catch (e) { ck('脚本跑完', false, e instanceof Error ? e.message : String(e)) }
const bad = R.filter((x) => !x).length
console.log('')
console.log(bad ? '✗ ' + bad + ' 项未通过' : '✓ 全部通过（' + R.length + ' 项）')
await sleep(500)
child.kill()
process.exit(bad ? 1 : 0)
