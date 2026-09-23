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
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

// 老脚本里的 root 一律指向仓库根，原样保留的自有声明就能继续用
const root = ROOT
// shotDir 是脚本自己的（截图落到 .screenshots），别当成样板丢掉
const shotDir = join(root, '.screenshots')

const tmpHome = join(ROOT, '.screenshots', 'bloub-home')
const PORT = 9311

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()
try {
  // 显示浮窗，再收成球（close 的语义就是「收起成球」）
  await app.evaluate(`window.zhixing.widget.toggle()`)
  await sleep(1200)
  await app.evaluate(`window.zhixing.widget.close()`)
  await sleep(1500)

  let ball = (await app.targets()).find((t) => t.type === 'page' && String(t.url).includes('widget=1'))
  check('浮窗（球形态）已出现', Boolean(ball), J((await app.targets()).map((t) => String(t.url).slice(-40))))
  if (!ball) throw new Error('没有浮窗可测')

  const conn = await app.attach((x) => String(x.url).includes('widget=1'))
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

  // ------------------------------------------------ 球色跟随主题强调色
  const colorOf = () =>
    conn.evaluate(`(() => {
       const svg = document.querySelector('svg.bloub')
       if (!svg) return null
       // 用一个临时元素把 var(--accent) 解析成 rgb 再比对，省得自己解析颜色
       const probe = document.createElement('div')
       probe.style.color = 'var(--accent)'
       document.body.appendChild(probe)
       const accent = getComputedStyle(probe).color
       const ball = getComputedStyle(svg).color
       probe.remove()
       return { accent, ball, same: accent === ball }
     })()`)
  const before = await colorOf()
  check('球的颜色等于主题强调色', before?.same === true, J(before))

  // 换强调色：浮窗靠 settings 域的广播实时重铺，不该等重启
  await app.evaluate(`window.zhixing.db.setSetting('accent_color', '#e8483f')`)
  await sleep(1200)
  const after = await colorOf()
  check(
    '改强调色后球色实时跟着变',
    Boolean(after) && after.ball !== before.ball && after.same === true,
    J({ before, after })
  )

  // ------------------------------------------------ 透明窗口：底色 / 全局 alpha 都不能碰
  // 球是画在**透明窗口**上的：主进程只要给这个窗口设过底色或全局 alpha，球周围本该
  // 透明的那块矩形就会浮出一层底（亮暗主题都有）。这里钉住两件事：窗口根节点没有底色；
  // 设置里的「透明度」走的是渲染层的 CSS 变量，而不是 win.setOpacity。
  const bg = await conn.evaluate(`(() => {
    const g = (el) => getComputedStyle(el).backgroundColor
    return { html: g(document.documentElement), body: g(document.body), root: g(document.getElementById('root')) }
  })()`)
  check(
    '浮窗的 html / body / #root 都没有底色（窗口才透得过去）',
    [bg.html, bg.body, bg.root].every((c) => c === 'rgba(0, 0, 0, 0)'),
    J(bg)
  )

  await app.evaluate(`window.zhixing.widget.setOpacity(70)`)
  await sleep(800)
  const transp = await conn.evaluate(`(() => {
    const root = document.documentElement
    const v = getComputedStyle(root).getPropertyValue('--widget-opacity').trim()
    const el = document.querySelector('.wball') || document.querySelector('.widget')
    return { surface: root.dataset.surface, v, opacity: el ? getComputedStyle(el).opacity : null }
  })()`)
  check(
    '浮窗透明度由 CSS 变量画（不再用窗口 setOpacity 设全局 alpha）',
    transp.surface === 'widget' && transp.v === '0.7' && transp.opacity === '0.7',
    J(transp)
  )
  await app.evaluate(`window.zhixing.widget.setOpacity(85)`)
  await sleep(400)

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
await app.close()
process.exit(finish())