/**
 * 图谱坐标复用验证（O5）。
 *
 * d3-force 的初始位置其实是确定性螺旋，所以「同一节点集合重建」位置本来就一样；
 * 真正会跳的场景是**节点集合变化**（勾选任务节点 / 邻域过滤），
 * 此时若不复用旧坐标，原有节点会被重新分配到新的螺旋位置而整体跳动。
 * 用法：node scripts/graphcheck.mjs
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
const tmpHome = join(root, '.screenshots', 'graph-home')
const PORT = 9237
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
await sleep(2500)
const results = []
const check = (n, ok, d = '') => { results.push([n, ok]); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`) }

// 进入图谱页
await ev(`document.querySelector('[data-nav-item="graph"]')?.click()`);
await sleep(3000)

// 按节点 id 匹配：label 会重复（例如多篇「未命名笔记」），用它比对会串节点
const readPositions = () =>
  ev(`JSON.stringify(Object.fromEntries([...document.querySelectorAll('.gnode')].map(g => {
    const m = /translate\\(([-\\d.]+),([-\\d.]+)\\)/.exec(g.getAttribute('transform') || '')
    return [g.getAttribute('data-node-id'), m ? [Number(m[1]), Number(m[2])] : null]
  })))`)

const before = JSON.parse(await readPositions())
const beforeCount = Object.keys(before).length
check('图谱渲染出节点', beforeCount > 3, `nodes=${beforeCount}`)

// 改变节点集合：勾选任务节点
await ev(`[...document.querySelectorAll('.text-btn')].find(b => b.textContent.includes('任务节点'))?.click()`)
await sleep(3000)
const after = JSON.parse(await readPositions())
const afterCount = Object.keys(after).length
check('勾选任务节点后节点数增加', afterCount > beforeCount, `${beforeCount} → ${afterCount}`)

// 共有节点的位移：复用坐标时只做微调，不复用则会被重新分配螺旋位置
let maxShift = 0
let sum = 0
let shared = 0
for (const [label, p1] of Object.entries(before)) {
  const p2 = after[label]
  if (!p1 || !p2) continue
  const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
  maxShift = Math.max(maxShift, d)
  sum += d
  shared += 1
}
const avgShift = shared ? sum / shared : 0
check('存在共有节点可比对', shared >= 3, `shared=${shared}`)
check(
  '节点集合变化后原有节点位置保持（复用旧坐标）',
  maxShift < 150,
  `max=${maxShift.toFixed(1)}px avg=${avgShift.toFixed(1)}px`
)

// 离开图谱再回来：模块级缓存应让位置继续保持
await ev(`document.querySelector('[data-nav-item="tasks"]')?.click()`)
await sleep(400)
await ev(`document.querySelector('[data-nav-item="graph"]')?.click()`)
await sleep(2000)
const back = JSON.parse(await readPositions())
let backMax = 0
let backShared = 0
for (const [label, p1] of Object.entries(after)) {
  const p2 = back[label]
  if (!p1 || !p2) continue
  backMax = Math.max(backMax, Math.hypot(p2[0] - p1[0], p2[1] - p1[1]))
  backShared += 1
}
check('切走再回来仍能复用坐标', backShared >= 3 && backMax < 120, `max=${backMax.toFixed(1)}px shared=${backShared}`)

ws.close()
child.kill()
await sleep(500)
rmSync(tmpHome, { recursive: true, force: true })
const failed = results.filter(([, ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
process.exit(failed ? 1 : 0)
