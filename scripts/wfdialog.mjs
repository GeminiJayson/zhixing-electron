/**
 * 工作流编辑弹窗的界面验证（真实鼠标事件 + 截图）：
 *   1. 步骤弹窗：SOP 多选、动作三类下拉、不再有「进入条件 / 条件分支到」
 *   2. 条件弹窗：注入条件含「上一步结果」，选中后出现「期望结果」
 * 用法：node scripts/wfdialog.mjs（需先 npm run build）
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
const tmpHome = join(root, '.screenshots', 'wfdialog-home')
const shotDir = join(root, '.screenshots')
const PORT = 9232

const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
if (!existsSync(realDb)) {
  console.error('✗ 找不到真实库：' + realDb)
  process.exit(1)
}
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(realDb, join(tmpHome, 'zhixing.db'))

const SYS_PATH = [
  'C:\\Windows\\System32',
  'C:\\Windows',
  'C:\\Windows\\System32\\Wbem',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
].join(';')

const child = spawn(
  electronPath,
  ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpHome, 'profile')}`],
  {
    cwd: root,
    env: { ...process.env, PATH: `${SYS_PATH};${process.env.PATH ?? ''}`, ZHIXING_HOME: tmpHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
)

const attach = async () => {
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      page = list.find((t) => t.type === 'page')
    } catch {
      /* 等待 */
    }
    if (!page) await sleep(500)
  }
  if (!page) return null
  const ws = new WebSocket(page.webSocketDebuggerUrl)
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
  await send('Page.enable')
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails)
      throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result?.result?.value
  }
  return { ws, send, evaluate }
}

const conn = await attach()
if (!conn) {
  console.error('✗ 无法连接渲染进程')
  child.kill()
  process.exit(1)
}
await sleep(3000)

const results = []
const check = (name, ok, detail = '') => {
  results.push([name, ok])
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

/** 在某个元素中心派发一次真实双击（合成事件过不了 setPointerCapture，这里必须走 CDP）。 */
const dblclick = async (selector, index = 0) => {
  const box = await conn.evaluate(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!box) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await conn.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 2,
      buttons: type === 'mousePressed' ? 1 : 0,
    })
  }
  await sleep(400)
  return true
}

const shoot = async (name) => {
  const r = await conn.send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) writeFileSync(join(shotDir, name), Buffer.from(r.result.data, 'base64'))
}

// 造一个含「步骤 + 条件」的模板（最新的模板会排在列表首位并被自动打开）
const tpl = await conn.evaluate(
  `window.zhixing.db.saveWorkflowTemplate({ name: 'UI验证-步骤与条件', start_policy: 'first', nodes: [
      { title: '第一步', order_index: 0, detail: '看看弹窗字段' },
      { title: '条件判断', order_index: 1, action_kind: 'condition', action_value: JSON.stringify({ kind: 'confirm', prompt: '继续吗？' }) }
    ] }).then(r => r.ok ? window.zhixing.db.workflowTemplate(r.templateId) : r)`
)
check('测试模板已保存', tpl?.nodes?.length === 2, JSON.stringify(tpl?.problems ?? ''))

await conn.evaluate(`document.querySelector('[data-nav-item="workflow"]')?.click()`)
await sleep(1800)

const nodeCount = await conn.evaluate("document.querySelectorAll('.wf-node').length")
check('工作流页已渲染两个节点', nodeCount === 2, `nodes=${nodeCount}`)

// ---------------- 步骤弹窗
const openedStep = await dblclick('.wf-node', 0)
check('双击步骤节点打开弹窗', openedStep && (await conn.evaluate("!!document.querySelector('.modal')")))

const stepForm = await conn.evaluate(`(() => {
  const body = document.querySelector('.modal__body')
  if (!body) return null
  return {
    text: body.innerText,
    hasSopPicker: !!body.querySelector('.sop-picker'),
    hasChips: !!body.querySelector('.sop-picker__chips'),
    actionOptions: [...body.querySelectorAll('select')]
      .flatMap((s) => [...s.options].map((o) => o.value)),
    actionLabels: [...body.querySelectorAll('select')]
      .flatMap((s) => [...s.options].map((o) => o.textContent))
      .filter((t) => ['任务', '命令', '脚本'].includes(t)),
    inputs: [...body.querySelectorAll('input, textarea')].map((i) => i.className),
  }
})()`)
check('步骤弹窗有 SOP 多选区', stepForm?.hasSopPicker === true && stepForm?.hasChips === true)
check('动作下拉只有任务 / 命令 / 脚本', JSON.stringify(stepForm?.actionLabels) === JSON.stringify(['任务', '命令', '脚本']), JSON.stringify(stepForm?.actionLabels))
check('步骤弹窗不再有「进入条件」', !String(stepForm?.text ?? '').includes('进入条件'))
check('步骤弹窗不再有「条件分支到」', !String(stepForm?.text ?? '').includes('条件分支到'))
check('步骤弹窗保留了标题 / 详情 / SOP', ['标题', '详情', 'SOP 文档'].every((t) => String(stepForm?.text ?? '').includes(t)))
await shoot('wf-step-dialog.png')

// 切到「命令」：应出现命令输入与期望退出码
await conn.evaluate(`(() => {
  const sel = [...document.querySelectorAll('.modal__body select')].find((s) =>
    [...s.options].some((o) => o.value === 'command')
  )
  if (!sel) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, 'command')
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
await sleep(300)
const cmdForm = await conn.evaluate("document.querySelector('.modal__body').innerText")
check('选「命令」后出现期望退出码', String(cmdForm).includes('期望退出码'), '')
const cmdPlaceholders = await conn.evaluate(
  "[...document.querySelectorAll('.modal__body input')].map((i) => i.placeholder).join('|')"
)
check('选「命令」后出现命令输入框', String(cmdPlaceholders).includes('notepad.exe'), cmdPlaceholders)
await shoot('wf-step-dialog-command.png')

// 关闭步骤弹窗
await conn.evaluate(`[...document.querySelectorAll('.modal__foot button')].find((b) => b.textContent.includes('取消'))?.click()`)
await sleep(300)

// ---------------- 条件弹窗
const openedCond = await dblclick('.wf-node', 1)
check('双击条件节点打开条件弹窗', openedCond && (await conn.evaluate("!!document.querySelector('.modal')")))
const condForm = await conn.evaluate(`(() => {
  const body = document.querySelector('.modal__body')
  if (!body) return null
  return {
    text: body.innerText,
    hasSopPicker: !!body.querySelector('.sop-picker'),
    sources: [...body.querySelectorAll('select')].flatMap((s) => [...s.options].map((o) => o.textContent)),
  }
})()`)
check('条件弹窗含「上一步结果」来源', (condForm?.sources ?? []).includes('上一步结果'), JSON.stringify(condForm?.sources))
// 只按**字段**判定：正文里那句「没有动作与 SOP」的说明文字不该被算成字段
check(
  '条件弹窗没有 SOP 绑定与动作字段',
  condForm?.hasSopPicker === false &&
    !String(condForm?.text ?? '').includes('SOP 文档') &&
    !String(condForm?.text ?? '').includes('动作\n')
)
await shoot('wf-cond-dialog.png')

// 切到「上一步结果」：应出现期望结果
await conn.evaluate(`(() => {
  const sel = [...document.querySelectorAll('.modal__body select')].find((s) =>
    [...s.options].some((o) => o.value === 'prev')
  )
  if (!sel) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, 'prev')
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
await sleep(300)
const prevForm = await conn.evaluate("document.querySelector('.modal__body').innerText")
check('选「上一步结果」后出现期望结果与退出码', String(prevForm).includes('期望结果') && String(prevForm).includes('上一步'))
await shoot('wf-cond-dialog-prev.png')

// 清理
await conn.evaluate(`[...document.querySelectorAll('.modal__foot button')].find((b) => b.textContent.includes('取消'))?.click()`)
await conn.evaluate(`window.zhixing.db.deleteWorkflowTemplate(${tpl.id})`)

conn.ws.close()
child.kill()
await sleep(600)
rmSync(tmpHome, { recursive: true, force: true })

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length ? 1 : 0)
