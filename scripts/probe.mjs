import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = join(root, '.screenshots', 'probe-home')
const PORT = 9391
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db'), join(tmpHome, 'zhixing.db'))
const SYS_PATH = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem'].join(';')
console.log('【1】启动')
const child = spawn(require('electron'), ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(tmpHome, 'profile')], { cwd: root, env: { ...process.env, PATH: SYS_PATH + ';' + (process.env.PATH ?? ''), ZHIXING_HOME: tmpHome }, stdio: ['ignore', 'pipe', 'pipe'] })
const list = async () => { try { return await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json() } catch { return [] } }
let main = null
for (let i = 0; i < 120 && !main; i++) { main = (await list()).find((t) => t.type === 'page'); if (!main) { if (i % 6 === 0) console.log('【2】等窗口 ' + Math.round(i * 0.5) + 's'); await sleep(500) } }
console.log('【3】连上 CDP')
const ws = new WebSocket(main.webSocketDebuggerUrl)
await new Promise((res) => ws.addEventListener('open', res, { once: true }))
const send = (m, p = {}, ms = 8000) => new Promise((resolve, reject) => {
  const id = Math.floor(Math.random() * 1e6)
  const t = setTimeout(() => { ws.removeEventListener('message', h); reject(new Error('超时 ' + ms + 'ms: ' + m)) }, ms)
  const h = (ev) => { const x = JSON.parse(ev.data); if (x.id !== id) return; clearTimeout(t); ws.removeEventListener('message', h); resolve(x) }
  ws.addEventListener('message', h)
  ws.send(JSON.stringify({ id, method: m, params: p }))
})
await send('Runtime.enable')
console.log('【4】Runtime 就绪')
const ev = async (expr, awaitP = true) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: awaitP })
  if (r.result?.exceptionDetails) return { err: r.result.exceptionDetails.exception?.description ?? 'eval error' }
  return { val: r.result?.result?.value }
}
for (let i = 0; i < 8; i++) { await sleep(500) }
console.log('【5】等界面稳定 4s 完成')
const probes = [
  ['1+1', '1+1'],
  ['标题', 'document.title'],
  ['有没有 zhixing', 'typeof window.zhixing'],
  ['有没有 db', 'typeof window.zhixing?.db'],
  ['有没有 createTask', 'typeof window.zhixing?.db?.createTask'],
  ['有没有 todayTasks', 'typeof window.zhixing?.db?.todayTasks'],
]
for (const [name, expr] of probes) {
  try {
    const r = await ev(expr)
    console.log('【探针】' + name + ' → ' + JSON.stringify(r))
  } catch (e) { console.log('【探针】' + name + ' → 失败: ' + e.message) }
}
console.log('【6】开始调 todayTasks（不 await，先看能不能发出去）')
try { const r = await ev('window.zhixing.db.todayTasks().then((t) => t.subtree.length)', true); console.log('【todayTasks】' + JSON.stringify(r)) } catch (e) { console.log('【todayTasks】失败: ' + e.message) }
console.log('【7】开始调 createTask')
try { const r = await ev('window.zhixing.db.createTask(\'探针任务\', null, null).then((t) => t && t.id)', true); console.log('【createTask】' + JSON.stringify(r)) } catch (e) { console.log('【createTask】失败: ' + e.message) }
console.log('【8】结束')
child.kill()
process.exit(0)
