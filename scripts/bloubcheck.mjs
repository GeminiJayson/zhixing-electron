/**
 * 悬浮球：bloub 引擎是否真的画出来了、动画在不在跑、能不能换体型。
 *
 * 覆盖：
 *   1. 浮窗收成球之后，球上确实挂着一棵 bloub 的 SVG（而不是空容器）；
 *   2. 两次采样之间身体路径在变 —— 引擎的动画循环真的在跑（idle 自带呼吸）；
 *   3. 换体型之后身体路径随之改变（走的是与右键菜单同一个入口）。
 *
 * 用法：node scripts/bloubcheck.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = join(root, '.screenshots', 'bloub-home')
const shotDir = join(root, '.screenshots')
const PORT = 9311

const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
if (!existsSync(realDb)) {
  console.error('✗ 找不到真实库：' + realDb)
  process.exit(1)
}
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(realDb, join(tmpHome, 'zhixing.db'))

const SYS_PATH = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem'].join(';')
const child = spawn(
  electronPath,
  ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(tmpHome, 'profile')],
  {
    cwd: root,
    env: { ...process.env, PATH: SYS_PATH + ';' + (process.env.PATH ?? ''), ZHIXING_HOME: tmpHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
)

const list = async () => {
  try {
    return await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
  } catch {
    return []
  }
}
const connect = async (target) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1e6)
      const h = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id !== id) return
        ws.removeEventListener('message', h)
        resolve(m)
      }
      ws.addEventListener('message', h)
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  const evaluate = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result?.exceptionDetails)
      throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result?.result?.value
  }
  return { send, evaluate }
}

let main = null
for (let i = 0; i < 60 && !main; i++) {
  main = (await list()).find((t) => t.type === 'page' && !String(t.url).includes('widget=1'))
  if (!main) await sleep(500)
}
if (!main) {
  console.error('✗ 主窗口没起来')
  child.kill()
  process.exit(1)
}
const host = await connect(main)
await sleep(2500)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''))
}
const J = (v) => JSON.stringify(v)

try {
  // 显示浮窗，再收成球（close 的语义就是「收起成球」）
  await host.evaluate(`window.zhixing.widget.toggle()`)
  await sleep(1200)
  await host.evaluate(`window.zhixing.widget.close()`)
  await sleep(1500)

  let ball = (await list()).find((t) => t.type === 'page' && String(t.url).includes('widget=1'))
  check('浮窗（球形态）已出现', Boolean(ball), J((await list()).map((t) => String(t.url).slice(-40))))
  if (!ball) throw new Error('没有浮窗可测')

  const conn = await connect(ball)
  await sleep(1200)

  const probe = () =>
    conn.evaluate(`(() => {
       const svg = document.querySelector('svg.bloub')
       // 身体本体是一个铺满 viewBox 的 rect（用 mask 抠出眼睛），不是 path
       const body = document.querySelector('rect.bloub__ink')
       // 身体轮廓是 mask 里的第一条 path，它的 d 就是每次采样出来的身体形状
       const paper = document.querySelector('svg.bloub mask path')
       const mask = document.querySelector('svg.bloub mask')
       return {
         hasBall: !!document.querySelector('.wball'),
         hasSvg: !!svg,
         viewBox: svg ? svg.getAttribute('viewBox') : null,
         bodyW: body ? body.getAttribute('width') : null,
         bodyLen: paper ? (paper.getAttribute('d') || '').length : 0,
         body: paper ? (paper.getAttribute('d') || '').slice(0, 40) : null,
         // mask 里应当是「1 个身体 + 2 只眼睛」
         maskChildren: mask ? mask.children.length : 0,
         maskPaths: mask ? mask.querySelectorAll('path').length : 0,
         // 元素清单（不带 d，短）：一眼看清 mask 里到底有什么
         tree: svg
           ? [...svg.querySelectorAll('*')]
               .map((e) => e.tagName + (e.getAttribute('class') ? '.' + e.getAttribute('class') : ''))
               .join('|')
           : null
       }
     })()`)

  const first = await probe()
  console.log(
    '[dom] ' +
      J({
        maskChildren: first.maskChildren,
        maskPaths: first.maskPaths,
        bodyLen: first.bodyLen,
      })
  )
  console.log('[tree] ' + String(first.tree))
  check('球上挂着 bloub 的 SVG', first.hasBall && first.hasSvg, J(first))
  check(
    '身体铺满 viewBox，mask 里是「身体 + 两只眼睛」',
    first.bodyW === '316' && first.bodyLen > 100 && first.maskChildren >= 3,
    J({ bodyW: first.bodyW, bodyLen: first.bodyLen, maskChildren: first.maskChildren, maskPaths: first.maskPaths })
  )
  check('viewBox 用的是上游坐标系（±158）', first.viewBox === '-158 -158 316 316', J(first.viewBox))

  // 采样两次：idle 自带呼吸 / 眨眼，路径应当一直在变
  await sleep(700)
  const second = await probe()
  check('动画在跑（两次采样的身体路径不同）', Boolean(first.body) && first.body !== second.body, J({ a: first.body, b: second.body }))

  // 换体型：走的是与右键菜单同一个入口
  const shapeBefore = await conn.evaluate(`window.zhixing.widget.ballShape()`)
  await conn.evaluate(`window.zhixing.widget.setBallShape('triangle')`)
  await sleep(1200)
  const third = await probe()
  const shapeAfter = await conn.evaluate(`window.zhixing.widget.ballShape()`)
  check('体型已切换并推给浮窗', shapeAfter === 'triangle', J({ shapeBefore, shapeAfter }))
  check('换成三角后身体路径确实变了', Boolean(third.body) && third.body !== second.body, J({ b: second.body, c: third.body }))

  // 截图：先回到默认圆，再看三角与水滴（球窗口很小，看图时自行放大）
  await conn.evaluate(`window.zhixing.widget.setBallShape('cercle')`)
  await sleep(900)
  const shot0 = await conn.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(join(shotDir, 'bloub-ball-cercle.png'), Buffer.from(shot0.result.data, 'base64'))
  await conn.evaluate(`window.zhixing.widget.setBallShape('triangle')`)
  await sleep(900)
  const shot = await conn.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(join(shotDir, 'bloub-ball-triangle.png'), Buffer.from(shot.result.data, 'base64'))
  await conn.evaluate(`window.zhixing.widget.setBallShape('goutte')`)
  await sleep(900)
  const shot2 = await conn.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(join(shotDir, 'bloub-ball-goutte.png'), Buffer.from(shot2.result.data, 'base64'))
  console.log('（截图已存 .screenshots/bloub-ball-triangle.png 与 bloub-ball-goutte.png）')
} catch (err) {
  check('脚本执行完成', false, err instanceof Error ? err.message : String(err))
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length ? '✗ ' + failed.length + ' 项未通过' : '✓ 全部通过') + `（${results.length} 项）`)
child.kill()
process.exit(failed.length ? 1 : 0)
