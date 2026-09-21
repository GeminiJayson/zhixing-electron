/**
 * 视觉检查：冷启动 Electron 并截图渲染层。
 * 两阶段——先用一次性实例落主题偏好，再冷启动截图；避免 reload/切换后
 * Chromium 返回旧合成帧导致「截图 ≠ 真实窗口」。
 * 用法：node scripts/capture.mjs [输出路径] [light|dark]
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outPath = process.argv[2] ?? join(root, '.screenshots', 'today.png')
const theme = process.argv[3] ?? 'dark'
const navKey = process.argv[4] ?? 'today'
/** 子视图按钮文案（任务页的 列表/四象限/日历/看板） */
const subview = process.argv[5] ?? ''
/** 截图前要点击的元素选择器（如打开第一篇笔记） */
const clickSel = process.argv[6] ?? ''
const PORT = 9223

/**
 * 库也要隔离。
 *
 * 这个脚本刻意要「真实数据」的截图，但**没有理由动真实库**：阶段 1 会把 theme_mode
 * 写进 settings 表，而那是用户的真实数据（还与 Python 版共用）。以前它没设 ZHIXING_HOME，
 * 于是跑一次截图就把用户的主题改掉了。
 * 复制一份副本、把 ZHIXING_HOME 指过去 —— 截图看到的是同一份数据，改的却是副本。
 */
const tmpHome = join(root, '.screenshots', 'capture-home')
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db'), join(tmpHome, 'zhixing.db'))

const profileDir = join(root, '.screenshots', 'profile')
rmSync(profileDir, { recursive: true, force: true })
mkdirSync(profileDir, { recursive: true })

const launch = () =>
  spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`], {
    cwd: root,
    env: { ...process.env, ZHIXING_HOME: tmpHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

const attach = async () => {
  let page = null
  for (let i = 0; i < 40 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      page = list.find((t) => t.type === 'page')
    } catch {
      /* 等待端口 */
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
      const onMessage = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id !== id) return
        ws.removeEventListener('message', onMessage)
        resolve(msg)
      }
      ws.addEventListener('message', onMessage)
      ws.send(JSON.stringify({ id, method, params }))
    })

  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result
      ?.result?.value

  const waitForRender = async () => {
    for (let i = 0; i < 25; i++) {
      if ((await evaluate("document.querySelectorAll('.stat-card__value').length")) === 4) return true
      await sleep(400)
    }
    return false
  }

  await send('Page.enable')
  await send('Runtime.enable')
  return { ws, send, evaluate, waitForRender }
}

// 阶段 1：写入主题偏好后退出
const first = await launch()
const firstConn = await attach()
if (!firstConn) {
  console.error('✗ 首次启动失败')
  first.kill()
  process.exit(1)
}
await firstConn.waitForRender()
// 主题的真源是 settings 表（与 Python 版共用），localStorage 仅作快速缓存
await firstConn.evaluate(`window.zhixing.db.setSetting('theme_mode', '${theme}')`)
await firstConn.evaluate(`localStorage.setItem('zhixing.theme', '${theme}')`)
await sleep(400)
firstConn.ws.close()
first.kill()
await sleep(1000)

// 阶段 2：冷启动即以目标主题渲染，无切换、无 reload
const second = await launch()
const conn = await attach()
if (!conn) {
  console.error('✗ 截图实例启动失败')
  second.kill()
  process.exit(1)
}
if (!(await conn.waitForRender())) {
  console.error('✗ 渲染未完成')
  second.kill()
  process.exit(1)
}
if (navKey !== 'today') {
  await conn.evaluate(`document.querySelector('[data-nav-item="${navKey}"]')?.click()`)
  await sleep(900)
}
for (const sel of clickSel.split('|').filter(Boolean)) {
  await conn.evaluate(`document.querySelector(${JSON.stringify(sel)})?.click()`)
  await sleep(900)
}
if (subview) {
  await conn.evaluate(
    `[...document.querySelectorAll('.seg button')].find(b => b.textContent.trim() === '${subview}')?.click()`
  )
  await sleep(700)
}
await sleep(700) // 入场动效结束

const diag = await conn.evaluate(
  "(async () => JSON.stringify({textBody: getComputedStyle(document.documentElement).getPropertyValue('--text-body').trim(), rowH: getComputedStyle(document.documentElement).getPropertyValue('--row-h').trim(), platform: window.zhixing.platform, theme: document.documentElement.dataset.theme, dbPath: (await window.zhixing.db.info()).path, rows: document.querySelectorAll('.trow').length, quads: document.querySelectorAll('.quad-box').length, qrows: document.querySelectorAll('.qrow').length, calCells: document.querySelectorAll('.cal__cell').length, calPills: document.querySelectorAll('.cal-pill').length, calSide: document.querySelectorAll('.cal-side__row').length, kcols: document.querySelectorAll('.kcol').length, setCards: document.querySelectorAll('.set-card').length, setRows: document.querySelectorAll('.set-row').length, chartBars: document.querySelectorAll('.chart__bar').length, heatCells: document.querySelectorAll('.heat__cell').length, achv: document.querySelectorAll('.achv__item').length, wfNodes: document.querySelectorAll('.wf-node').length, wfItems: document.querySelectorAll('.wf-item').length, gNodes: document.querySelectorAll('.gnode').length, gEdges: document.querySelectorAll('.graph__edge').length, gRefEdges: document.querySelectorAll('.graph__edge--ref').length, ntreeNotes: document.querySelectorAll('.ntree__note').length, editorTitle: document.querySelector('.editor__title')?.value ?? '', backlinks: document.querySelectorAll('.links__item').length, ntreeFolders: document.querySelectorAll('.ntree__folder').length, mdBlocks: document.querySelectorAll('.md').length, kcards: document.querySelectorAll('.kcard').length, kheads: [...document.querySelectorAll('.kcol__head')].map(h => h.textContent).join('|'), title: document.querySelector('.page__title')?.textContent ?? ''}))()"
)

const shot = await conn.send('Page.captureScreenshot', { format: 'png' })
conn.ws.close()
second.kill()

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, Buffer.from(shot.result.data, 'base64'))
console.log('已保存截图:', outPath, '|', diag)
