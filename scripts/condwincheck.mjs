/**
 * 工作流条件节点的「提示确认」验证：它应该开在**独立小窗口**里，不占主窗口。
 *
 * 覆盖：
 *   1. 跑到条件节点时出现一个新窗口（url 含 condition=1），主窗口里没有任何弹框
 *   2. 那个窗口的内容：标题 / 提示文案 / 图标 / 「不成立 · 成立」按钮
 *   3. 点「成立」→ 窗口关闭，实例走条件分支
 *   4. 点「不成立」→ 走顺序下一步（逻辑与原生模态一致）
 *   5. 直接关窗 = 不成立
 *
 * 用法：node scripts/condwincheck.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

// 老脚本里的 root 一律指向仓库根，原样保留的自有声明就能继续用
const root = ROOT
const shotDir = join(root, '.screenshots')
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
const SYS_PATH = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem'].join(';')

const tmpHome = join(ROOT, '.screenshots', 'condwin-home')
const PORT = 9250

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()
const STAMP = 'CW' + Date.now().toString(36)

// 模板：条件(confirm) → 步骤A，条件成立时跳到 步骤B
const tpl = await app.evaluate(
  `window.zhixing.db.saveWorkflowTemplate({ name: ${J(STAMP + ' 条件流程')}, start_policy: 'first', nodes: [
      { title: '人工判断', order_index: 0, action_kind: 'condition', action_value: JSON.stringify({ kind: 'confirm', prompt: '继续吗？' }) },
      { title: '顺序下一步', order_index: 1 },
      { title: '分支目标', order_index: 2 }
    ] }).then((r) => (r.ok ? window.zhixing.db.workflowTemplate(r.templateId) : r))`
)
const nodes = tpl.nodes
await app.evaluate(`window.zhixing.db.setWorkflowBranch(${nodes[0].id}, ${nodes[2].id})`)
check('测试模板已建立', tpl?.nodes?.length === 3, J(tpl?.problems ?? ''))

/** 发一次实例化（不等待 —— 它会被条件阻塞，直到窗口里点了按钮） */
const fireInstantiate = async () =>
  app.send('Runtime.evaluate', {
    expression: `window.zhixing.db.instantiateWorkflow(${tpl.id}, null, null, 'first')`,
    returnByValue: false,
    awaitPromise: false,
  })

/** 等条件窗口出现（url 带 condition=1） */
const waitConditionWindow = async (timeout = 15000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const pages = await app.targets()
    const win = pages.find((t) => String(t.url).includes('condition=1'))
    if (win) return win
    await sleep(250)
  }
  return null
}

const latestInstance = () =>
  app.evaluate("window.zhixing.db.workflowInstances('running').then((rows) => rows[0] ?? null)")

// ---------------- 场景 1：点「成立」走分支
await fireInstantiate()
const condTarget = await waitConditionWindow()
check('跑到条件节点时开了一个独立窗口', !!condTarget, condTarget ? condTarget.url.slice(-30) : '（没出现）')

let condShotTaken = false
if (condTarget) {
  const cw = await app.attach((x) => x.type === 'page' && x.url.includes('condition=1'))
  // 窗口是刚创建的，卡片可能还没渲染出来 —— 轮询等它出现
  let info = null
  for (let i = 0; i < 30 && !info; i++) {
    info = await cw.evaluate(`(() => {
    const root = document.querySelector('.cond-win')
    if (!root) return null
    const card = root.querySelector('.modal.modal--dialog')
    return {
      title: card?.querySelector('.modal__head h2')?.textContent.trim() ?? '',
      msg: card?.querySelector('.dialog__message')?.textContent.trim() ?? '',
      buttons: [...root.querySelectorAll('.modal__foot button')].map((b) => b.textContent.trim()),
      hasIcon: !!card?.querySelector('.dialog__icon svg'),
      surface: document.documentElement.dataset.surface,
      // 与应用内弹框同一套骨架（head / body / foot）
      reusesModal: !!card && !!card.querySelector('.modal__body') && !!card.querySelector('.modal__foot'),
      theme: document.documentElement.dataset.theme ?? '',
      cardBg: card ? getComputedStyle(card).backgroundColor : '',
    }
  })()`)
    if (!info) await sleep(200)
  }
  check('窗口里是确认卡片（不是主窗口那种遮罩弹框）', info?.surface === 'condition' && !!info, J(info))
  check('标题与提示文案正确', info?.title === '工作流条件' && info?.msg === '继续吗？', `${info?.title} / ${info?.msg}`)
  check('按钮是「不成立 / 成立」', JSON.stringify(info?.buttons) === JSON.stringify(['不成立', '成立']), J(info?.buttons))
  check('带图标', info?.hasIcon === true, '')
  check('复用应用内弹框的骨架（head / body / foot）', info?.reusesModal === true, '')
  const mainTheme = await app.evaluate("document.documentElement.dataset.theme ?? ''")
  check(
    '主题与应用一致（不再是默认深色）',
    !!info?.theme && info.theme === mainTheme,
    `确认窗=${info?.theme} 主窗口=${mainTheme}`
  )
  const shot = await cw.send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) {
    writeFileSync(join(shotDir, 'condition-window.png'), Buffer.from(shot.result.data, 'base64'))
    condShotTaken = true
  }

  // 主窗口里不应该有弹框
  const mainModal = await app.evaluate("!!document.querySelector('.modal--dialog') || !!document.querySelector('.modal-mask')")
  check('主窗口里没有出现任何弹框', mainModal === false, '')

  // 点完主进程会立刻关掉这个窗口，CDP 不会再回响应 —— 所以**不等**它返回
  void cw.send('Runtime.evaluate', {
    expression: "[...document.querySelectorAll('.cond-win button')].find((b) => b.textContent.trim() === '成立').click()",
    returnByValue: false,
    awaitPromise: false,
  })
  await sleep(600)
  cw.ws.close()
}

await sleep(1500)
const gone = (await app.targets()).every((t) => !String(t.url).includes('condition=1'))
check('应答后条件窗口自动关闭', gone, '')
const inst = await latestInstance()
check('点「成立」后走条件分支', inst?.current_node_id === nodes[2].id, `cur=${inst?.current_node_id} 期望=${nodes[2].id}`)
check('截图已保存', condShotTaken, 'condition-window.png')

// ---------------- 场景 2：点「不成立」走顺序下一步（同一套判定逻辑的另一半）
await fireInstantiate()
const condTarget2 = await waitConditionWindow()
check('第二次确认同样开独立窗口', !!condTarget2, condTarget2 ? 'ok' : '（没出现）')
if (condTarget2) {
  const cw2 = await app.attach((x) => x.type === 'page' && x.url.includes('condition=1'))
  let ready = false
  for (let i = 0; i < 30 && !ready; i++) {
    ready = (await cw2.evaluate("!!document.querySelector('.cond-win')")) === true
    if (!ready) await sleep(200)
  }
  void cw2.send('Runtime.evaluate', {
    expression:
      "[...document.querySelectorAll('.cond-win button')].find((b) => b.textContent.trim() === '不成立').click()",
    returnByValue: false,
    awaitPromise: false,
  })
  await sleep(600)
  cw2.ws.close()
}
await sleep(1500)
const inst2 = await latestInstance()
check(
  '点「不成立」走顺序下一步',
  inst2?.current_node_id === nodes[1].id,
  `cur=${inst2?.current_node_id} 期望=${nodes[1].id}`
)

// 收尾：把实例与模板清掉
if (inst) await app.evaluate(`window.zhixing.db.abortWorkflowInstance(${inst.id})`)
const running = await app.evaluate("window.zhixing.db.workflowInstances('running').then((rows) => rows.map((r) => r.id))")
for (const id of running ?? []) await app.evaluate(`window.zhixing.db.abortWorkflowInstance(${id})`)
await app.evaluate(`window.zhixing.db.deleteWorkflowTemplate(${tpl.id})`)

await app.close()

process.exit(finish())