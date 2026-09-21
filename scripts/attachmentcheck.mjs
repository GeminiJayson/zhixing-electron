import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = join(root, '.screenshots', 'attach-home')
const PORT = 9371
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db'), join(tmpHome, 'zhixing.db'))
const SYS_PATH = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem'].join(';')
const child = spawn(electronPath, ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(tmpHome, 'profile')], { cwd: root, env: { ...process.env, PATH: SYS_PATH + ';' + (process.env.PATH ?? ''), ZHIXING_HOME: tmpHome }, stdio: ['ignore', 'pipe', 'pipe'] })
const list = async () => { try { return await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json() } catch { return [] } }
let main = null
for (let i = 0; i < 60 && !main; i++) { main = (await list()).find((t) => t.type === 'page'); if (!main) await sleep(500) }
const ws = new WebSocket(main.webSocketDebuggerUrl)
await new Promise((res) => ws.addEventListener('open', res, { once: true }))
const send = (m, p = {}) => new Promise((resolve) => {
  const id = Math.floor(Math.random() * 1e6)
  const h = (ev) => { const x = JSON.parse(ev.data); if (x.id !== id) return; ws.removeEventListener('message', h); resolve(x) }
  ws.addEventListener('message', h)
  ws.send(JSON.stringify({ id, method: m, params: p }))
})
await send('Runtime.enable')
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result?.result?.value
}
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log((ok ? '✓ ' : '✗ ') + n + (d ? ' — ' + d : '')) }
const J = (v) => JSON.stringify(v)
try {
  await sleep(3200)
  // 1x1 的透明 PNG，最小的合法图片
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const noteId = await evaluate("window.zhixing.db.notes().then((n) => n[0]?.id ?? null)")
  check('拿到了第一篇文章的 id', typeof noteId === 'number', J({ noteId }))
  const saved = await evaluate("window.zhixing.db.saveAttachmentData(" + noteId + ", 'thumb-test.png', '" + png + "')")
  check('saveAttachmentData 成功返回落盘路径', saved?.ok === true && typeof saved.path === 'string', J(saved))
  if (saved?.path) {
    check('落盘路径在 attachments 目录下', String(saved.path).includes('attachment'), J({ path: saved.path }))
    check('文件确实写到了磁盘', existsSync(saved.path), J({ exists: existsSync(saved.path) }))
  }
  const list2 = await evaluate("window.zhixing.db.attachments().then((a) => a.filter((x) => String(x.path).includes('thumb-test'))) ")
  check('附件表里有这条记录', Array.isArray(list2) && list2.length >= 1, J({ n: Array.isArray(list2) ? list2.length : null }))
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
const failed = results.filter((r) => !r).length
console.log('')
console.log(failed ? '✗ ' + failed + ' 项未通过' : '✓ 全部通过（' + results.length + ' 项）')
await sleep(500)
child.kill()
process.exit(failed ? 1 : 0)
