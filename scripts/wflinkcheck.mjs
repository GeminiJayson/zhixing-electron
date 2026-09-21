/**
 * 工作流连线：删除按钮的位置与可用性、任意节点主动拉线、删除被引用的步骤。
 *
 * 覆盖用户报过的几件事：
 *   1. 连线 hover 出来的删除按钮必须**压在线上**（原先按两端点算中点，连线改成正交折线后
 *      按钮飘在空白处，点不到、删不掉）；
 *   2. 点删除按钮要真的把这条连线去掉；
 *   3. 从**普通步骤**也能主动拉一条线到指定节点（不只是条件节点）；
 *   4. 删除一个被别的节点引用的步骤要能成功 —— 指向它的引用要一并清掉，
 *      否则校验会以「分支指向了不存在的步骤」拒绝保存。
 *
 * 交互一律走 CDP 的真实鼠标事件（Input.dispatchMouseEvent）：合成 PointerEvent 在同一个
 * 任务里连发时，React 会把状态更新批处理掉，事件处理器读到的还是旧闭包 —— 拖不出线。
 *
 * 用法：node scripts/wflinkcheck.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

const root = ROOT
const require = createRequire(import.meta.url)
const tmpHome = join(ROOT, '.screenshots', 'wflink-home')
const PORT = 9281
const shotDir = join(root, '.screenshots')

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish, results } = createChecker()
const STAMP = 'LK' + Date.now().toString(36)

/** 视口坐标（CSS 像素），与 Input.dispatchMouseEvent 同一坐标系。 */
const mouse = (type, x, y, buttons) =>
  app.send('Input.dispatchMouseEvent', {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: type === 'mouseMoved' ? 'none' : 'left',
    buttons,
    clickCount: type === 'mouseMoved' ? 0 : 1,
  })

/**
 * 元素的点击点（视口坐标）。
 *
 * 对含 <circle> 的组（端口、删除按钮）要取 circle 的圆心：整个 <g> 的包围盒会把旁边的
 * 文字也算进去，中心点会落到文字上 —— 而文字是 pointer-events:none，点它等于点空气。
 */
const centerOf = (expr) =>
  app.evaluate(
    `(() => {
       const el = ${expr}
       if (!el) return null
       const target = el.querySelector('circle') || el
       const r = target.getBoundingClientRect()
       return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
     })()`
  )

/** 在连线上找一个**真正能命中**的点：弧长中点常常正好压在某个节点上。 */
const hoverPointOf = (selector) =>
  app.evaluate(
    `(() => {
       const path = document.querySelector(${JSON.stringify(selector)})
       if (!path) return null
       const total = path.getTotalLength()
       const m = path.getScreenCTM()
       for (let f = 0.15; f <= 0.85; f += 0.05) {
         const p = path.getPointAtLength(total * f)
         const x = p.x * m.a + p.y * m.c + m.e
         const y = p.x * m.b + p.y * m.d + m.f
         const el = document.elementFromPoint(x, y)
         if (el && el.classList.contains('graph__edge-hit')) return { x, y }
       }
       return null
     })()`
  )

/** 节点 g 元素（按标题找）。 */
const nodeExpr = (title) =>
  `[...document.querySelectorAll('g.wf-node[data-wf-node]')].find((g) => g.querySelector('.wf-node__title')?.textContent === '${title}')`

try {
  // 甲 → 乙 → 丙 顺序链，末尾一个条件节点「判」，它的满足分支指向 乙
  const tpl = await app.evaluate(
    `window.zhixing.db.saveWorkflowTemplate({ name: ${J(STAMP)}, start_policy: 'first', nodes: [
        { id: -1, title: '甲', order_index: 0 },
        { id: -2, title: '乙', order_index: 1 },
        { id: -3, title: '丙', order_index: 2 },
        { id: -4, title: '判', order_index: 3, action_kind: 'condition', action_value: JSON.stringify({ kind: 'confirm', prompt: '继续吗？' }), branch_node_id: -2 }
      ] }).then((r) => (r.ok ? window.zhixing.db.workflowTemplate(r.templateId) : r))`
  )
  check('测试模板已建立', tpl?.nodes?.length === 4, J(tpl?.problems ?? ''))

  await app.evaluate(`document.querySelector('[data-nav-item="workflow"]').click()`)
  await sleep(1400)
  await app.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('自动布局')); if (b) b.click() })()`)
  await sleep(900)

  // ------------------------------------------------ 1. 删除按钮压在线上
  const midOfBranch = await hoverPointOf('path.wf-edge--branch-true')
  check('分支连线有一段可以悬停命中（没有整条压在节点上）', Boolean(midOfBranch), J(midOfBranch))
  await mouse('mouseMoved', midOfBranch.x, midOfBranch.y, 0)
  await sleep(250)
  const delPos = await app.evaluate(
    `(() => {
       const path = document.querySelector('path.wf-edge--branch-true')
       const del = document.querySelector('.edge-del circle')
       if (!path || !del) return { error: del ? '找不到连线' : 'hover 后没有出现删除按钮' }
       const p = path.getPointAtLength(path.getTotalLength() / 2)
       const dx = Number(del.getAttribute('cx')) - p.x
       const dy = Number(del.getAttribute('cy')) - p.y
       return { distance: Math.round(Math.hypot(dx, dy) * 100) / 100 }
     })()`
  )
  check(
    'hover 连线后删除按钮正好压在线上',
    delPos && delPos.distance != null && delPos.distance < 0.5,
    J(delPos)
  )

  // ------------------------------------------------ 2. 从普通步骤主动拉线到指定节点
  const portPoint = await app.evaluate(
    `(() => {
       const jia = ${nodeExpr('甲')}
       const port = jia && document.querySelector('.wf-port[data-wf-port="' + jia.getAttribute('data-wf-node') + '"]')
       const circle = port && port.querySelector('circle')
       if (!circle) return null
       const r = circle.getBoundingClientRect()
       return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
     })()`
  )
  const bingPoint = await centerOf(nodeExpr('丙'))
  check('普通步骤也有出线端口', Boolean(portPoint))

  // 拖拽：按下 → 经过中点 → 落到目标 → 松开
  await mouse('mouseMoved', portPoint.x, portPoint.y, 0)
  await sleep(80)
  await mouse('mousePressed', portPoint.x, portPoint.y, 1)
  await sleep(160)
  const dragStarted = await app.evaluate(`document.querySelectorAll('.graph__edge-drag').length`)
  await mouse('mouseMoved', (portPoint.x + bingPoint.x) / 2, (portPoint.y + bingPoint.y) / 2, 1)
  await sleep(90)
  await mouse('mouseMoved', bingPoint.x, bingPoint.y, 1)
  await sleep(160)
  await mouse('mouseReleased', bingPoint.x, bingPoint.y, 0)
  await sleep(1000)
  check('按下端口后出现拉线预览', dragStarted === 1, J(dragStarted))

  const pulled = await app.evaluate(`document.querySelectorAll('path.wf-edge--branch-jump').length`)
  check('从普通步骤的端口能拉出一条「跳到」连线', pulled === 1, J(pulled))
  const afterPull = await app.evaluate(`window.zhixing.db.workflowTemplate(${tpl.id})`)
  check(
    '拉线落库为「完成后跳到」',
    afterPull.nodes.find((n) => n.title === '甲')?.branch_node_id ===
      tpl.nodes.find((n) => n.title === '丙')?.id,
    J(afterPull.nodes.find((n) => n.title === '甲')?.branch_node_id)
  )

  // ------------------------------------------------ 3. 点删除按钮把这条线删掉
  const midOfJump = await hoverPointOf('path.wf-edge--branch-jump')
  await mouse('mouseMoved', midOfJump.x, midOfJump.y, 0)
  await sleep(250)
  const delPoint = await centerOf(`document.querySelector('.edge-del')`)
  await mouse('mousePressed', delPoint.x, delPoint.y, 1)
  await sleep(60)
  await mouse('mouseReleased', delPoint.x, delPoint.y, 0)
  await sleep(1000)
  const afterRemoveDel = await app.evaluate(`document.querySelectorAll('path.wf-edge--branch-jump').length`)
  check('点删除按钮能把连线删掉', afterRemoveDel === 0, J(afterRemoveDel))
  const afterRemove = await app.evaluate(`window.zhixing.db.workflowTemplate(${tpl.id})`)
  check(
    '删线落库：甲 的「跳到」被清空',
    afterRemove.nodes.find((n) => n.title === '甲')?.branch_node_id === null,
    J(afterRemove.nodes.find((n) => n.title === '甲')?.branch_node_id)
  )

  // ------------------------------------------------ 4. 删除被引用的步骤
  // 乙 仍被条件节点「判」的满足分支引用着：以前这一步会以
  // 「分支指向了不存在的步骤」拒绝保存 —— 表现就是「删不掉，得先改别人的分支」
  const yiPoint = await centerOf(nodeExpr('乙'))
  await mouse('mouseMoved', yiPoint.x, yiPoint.y, 0)
  await mouse('mousePressed', yiPoint.x, yiPoint.y, 1)
  await sleep(60)
  await mouse('mouseReleased', yiPoint.x, yiPoint.y, 0)
  await sleep(400)
  const stepDel = await app.evaluate(
    `(async () => {
       const wait = (ms) => new Promise((r) => setTimeout(r, ms))
       const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '删除步骤')
       if (!btn) return { error: '找不到「删除步骤」按钮' }
       if (btn.disabled) return { error: '「删除步骤」按钮是禁用的（没有选中步骤）' }
       btn.click()
       await wait(350)
       const modal = document.querySelector('.modal')
       if (!modal) return { error: '没有出现二次确认' }
       const confirm = [...modal.querySelectorAll('button')].find((b) => b.textContent.trim() === '删除')
       if (!confirm) return { error: '确认弹窗里没有「删除」' }
       confirm.click()
       await wait(1500)
       return { left: [...document.querySelectorAll('g.wf-node .wf-node__title')].map((t) => t.textContent) }
     })()`
  )
  const afterDelete = await app.evaluate(`window.zhixing.db.workflowTemplate(${tpl.id})`)
  check('被引用的步骤能删掉', stepDel && !stepDel.error && !stepDel.left.includes('乙'), J(stepDel))
  check(
    '删除时指向它的引用被一并清空',
    afterDelete.nodes.find((n) => n.title === '判')?.branch_node_id === null,
    J(afterDelete.nodes.find((n) => n.title === '判')?.branch_node_id)
  )

  // 顺手留一张图，方便肉眼复核连线与端口
  const box = await app.evaluate(
    `(() => { const r = document.querySelector('.wf-canvas').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })()`
  )
  const shot = await app.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.w, height: Math.min(box.h, 620), scale: 1.5 },
  })
  writeFileSync(join(shotDir, 'wf-links.png'), Buffer.from(shot.result.data, 'base64'))
  console.log('（截图已存 .screenshots/wf-links.png）')
} catch (err) {
  check('脚本执行完成', false, err instanceof Error ? err.message : String(err))
}
await app.close()
process.exit(finish())