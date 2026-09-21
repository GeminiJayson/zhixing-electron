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
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

// 老脚本里的 root / require 一律保留：原样带过来的自有声明（sql/dbFile 等）还依赖它们
const root = ROOT
const require = createRequire(import.meta.url)
const tmpHome = join(ROOT, '.screenshots', 'graph-home')
const PORT = 9237
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()
// 进入图谱页
await app.evaluate(`document.querySelector('[data-nav-item="graph"]')?.click()`);
await sleep(3000)

// 按节点 id 匹配：label 会重复（例如多篇「未命名笔记」），用它比对会串节点
const readPositions = () =>
  app.evaluate(`JSON.stringify(Object.fromEntries([...document.querySelectorAll('.gnode')].map(g => {
    const m = /translate\\(([-\\d.]+),([-\\d.]+)\\)/.exec(g.getAttribute('transform') || '')
    return [g.getAttribute('data-node-id'), m ? [Number(m[1]), Number(m[2])] : null]
  })))`)

const before = JSON.parse(await readPositions())
const beforeCount = Object.keys(before).length
check('图谱渲染出节点', beforeCount > 3, `nodes=${beforeCount}`)

// 改变节点集合：切换「任务节点」开关。
// 注意方向：图谱**默认就包含任务节点**（buildGraph 的 includeTasks 默认为真），
// 所以第一次点它是把任务节点**排除**掉（32 → 5）。这里只断言「集合确实变了」，
// 不再假设增减方向 —— 本脚本真正要守的是下面那条「共有节点坐标保持」。
await app.evaluate(`[...document.querySelectorAll('.text-btn')].find(b => b.textContent.includes('任务节点'))?.click()`)
await sleep(3000)
const after = JSON.parse(await readPositions())
const afterCount = Object.keys(after).length
check('切换任务节点开关后节点集合变化', afterCount !== beforeCount, `${beforeCount} → ${afterCount}`)

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
await app.evaluate(`document.querySelector('[data-nav-item="tasks"]')?.click()`)
await sleep(400)
await app.evaluate(`document.querySelector('[data-nav-item="graph"]')?.click()`)
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

await sleep(500)

await app.close()
process.exit(finish())