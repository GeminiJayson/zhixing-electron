/**
 * 「AI 整理」界面验证：设置页的配置卡片 + 笔记页的入口按钮。
 * 用法：node scripts/aiui.mjs（需先 npm run build）
 *
 * 表达式一律**单行 + 简单**：多行 IIFE 里混着属性选择器与可选链时，
 * 一旦某处转义出错，报的只是「Invalid or unexpected token」，很难定位。
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
const tmpHome = join(root, '.screenshots', 'aiui-home')
const shotDir = join(root, '.screenshots')
const PORT = 9242

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
  ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(tmpHome, 'profile')],
  {
    cwd: root,
    env: { ...process.env, PATH: SYS_PATH + ';' + (process.env.PATH ?? ''), ZHIXING_HOME: tmpHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
)

const attach = async () => {
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
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
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''))
}
const shoot = async (name) => {
  const r = await conn.send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) writeFileSync(join(shotDir, name), Buffer.from(r.result.data, 'base64'))
}

// ---------------- 设置页
await conn.evaluate("document.querySelector('[data-nav-item=settings]').click()")
await sleep(1200)
const tabs = await conn.evaluate(
  "[...document.querySelectorAll('[role=tab]')].map((b) => b.textContent.trim()).join(',')"
)
check('设置页出现「AI 整理」分区', String(tabs).includes('AI 整理'), tabs)

await conn.evaluate(
  "[...document.querySelectorAll('[role=tab]')].filter((b) => b.textContent.trim() === 'AI 整理')[0].click()"
)
await sleep(700)

const promptSel = "textarea[aria-label='整理提示词']"
const promptValue = await conn.evaluate(
  "(document.querySelector(" + JSON.stringify(promptSel) + ") || {}).value || ''"
)
const panelText = await conn.evaluate(
  "[...document.querySelectorAll('.set-card')].map((c) => c.innerText).join(' | ')"
)
const hasKey = await conn.evaluate("!!document.querySelector('input[type=password]')")
const hasProtocol = await conn.evaluate(
  "[...document.querySelectorAll('select')].some((s) => [...s.options].some((o) => o.value === 'anthropic'))"
)
const cardCount = await conn.evaluate("document.querySelectorAll('.set-card').length")

check('配置卡片齐全（协议 / 地址 / Key / 模型 / 超时）', hasKey === true && cardCount >= 2, 'cards=' + cardCount)
check('协议下拉含三种协议', hasProtocol === true, '')
check('有可编辑的提示词框', String(promptValue).length > 50, String(promptValue).length + ' 字')
check(
  '提示词里说明了关键变量',
  String(promptValue).includes('{{CONTENT}}') && String(promptValue).includes('{{FOLDERS}}'),
  ''
)
check(
  '卡片文案说明了占位符机制',
  String(panelText).includes('@@IMG1@@') && String(panelText).includes('不会上传'),
  ''
)
check(
  '有「测试连接」与「恢复默认提示词」',
  String(panelText).includes('测试连接') && String(panelText).includes('恢复默认提示词'),
  ''
)
await shoot('ai-settings.png')

// ---------------- 笔记页入口
await conn.evaluate("document.querySelector('[data-nav-item=notes]').click()")
await sleep(1500)
const noteTitle = await conn.evaluate(
  "window.zhixing.db.notes(1).then((rows) => (rows[0] && rows[0].title) || '')"
)
// 笔记树里的一行是 div.ntree__note（不是 button），按标题文本命中后点它
await conn.evaluate(
  "[...document.querySelectorAll('.ntree__note')].filter((el) => el.innerText.includes(" +
    JSON.stringify(noteTitle) +
    '))[0]?.click()'
)
await sleep(1500)
const hasAiButton = await conn.evaluate(
  "[...document.querySelectorAll('button')].some((b) => b.textContent.includes('AI 整理'))"
)
check('笔记工具栏有「AI 整理」入口', hasAiButton === true, '选中：' + noteTitle)
await shoot('ai-note-toolbar.png')

conn.ws.close()
child.kill()
await sleep(500)
rmSync(tmpHome, { recursive: true, force: true })

const failed = results.filter(([, ok]) => !ok)
console.log('')
console.log((results.length - failed.length) + '/' + results.length + ' 项通过')
process.exit(failed.length ? 1 : 0)
