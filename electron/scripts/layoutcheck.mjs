/**
 * 布局成长性检查：视口变高时，各页「主工作区」是否跟着变高。
 * 底部留白的根因就是主区域不随窗口增长，这里直接量化它。
 * 用法：node scripts/layoutcheck.mjs
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const profile = join(root, '.screenshots', 'layoutcheck-profile')
const PORT = 9229
rmSync(profile, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })

const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
  cwd: root,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let page = null
for (let i = 0; i < 40 && !page; i++) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    page = list.find((t) => t.type === 'page')
  } catch {}
}
if (!page) { console.error('✗ 无法连接'); child.kill(); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const send = (m, p = {}) =>
  new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e6)
    const h = (ev) => {
      const x = JSON.parse(ev.data)
      if (x.id !== id) return
      ws.removeEventListener('message', h)
      resolve(x)
    }
    ws.addEventListener('message', h)
    ws.send(JSON.stringify({ id, method: m, params: p }))
  })
await send('Runtime.enable')
await sleep(2500)

/** 每页的主工作区选择器（页面内容型页面不参与成长性检查） */
const CASES = [
  { nav: 'tasks', sub: '列表', sel: '.tasks-work' },
  { nav: 'tasks', sub: '四象限', sel: '.quad-grid' },
  { nav: 'tasks', sub: '日历', sel: '.cal__grid' },
  { nav: 'tasks', sub: '看板', sel: '.kcol' },
  // 笔记页要先打开一篇笔记，编辑区才存在
  { nav: 'notes', sub: '', sel: '.md-editor', preClick: '.ntree__note' },
  { nav: 'graph', sub: '', sel: '.graph' },
  { nav: 'workflow', sub: '', sel: '.wf-canvas' },
  { nav: 'inbox', sub: '', sel: '.inbox-panel' },
]
const SIZES = [
  [1280, 820],
  [1920, 1200],
]

const measure = async (sel) => {
  const r = await send('Runtime.evaluate', {
    expression: `(() => { const el = document.querySelector('${sel}'); if (!el) return -1; return Math.round(el.getBoundingClientRect().height) })()`,
    returnByValue: true,
  })
  return r.result?.result?.value ?? -1
}

const results = []
for (const { nav, sub, sel, preClick } of CASES) {
  const heights = []
  for (const [w, h] of SIZES) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
    await sleep(400)
    await send('Runtime.evaluate', { expression: `document.querySelector('[data-nav-item="${nav}"]')?.click()` })
    await sleep(450)
    if (sub) {
      await send('Runtime.evaluate', {
        expression: `[...document.querySelectorAll('.seg button')].find(b => b.textContent.trim() === '${sub}')?.click()`,
      })
      await sleep(450)
    }
    if (preClick) {
      await send('Runtime.evaluate', {
        expression: `document.querySelector('${preClick}')?.click()`,
      })
      await sleep(600)
    }
    heights.push(await measure(sel))
  }
  const [a, b] = heights
  const delta = b - a
  const expected = 1200 - 820 // 视口高度差
  const ok = a > 0 && delta >= expected - 60
  results.push({ nav, sub, sel, a, b, delta, ok })
  console.log(
    `${ok ? '✓' : '✗'} ${(nav + (sub ? '/' + sub : '')).padEnd(16)} ${sel.padEnd(16)} 820px→${a}  1200px→${b}  增长=${delta} (期望≈${expected})`
  )
}

// ---- 滚动结构：标题固定，只有 .page__body 滚 ----
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 640, deviceScaleFactor: 1, mobile: false })
await sleep(500)
const scrollCases = ['tasks', 'settings', 'review']
for (const nav of scrollCases) {
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-nav-item="${nav}"]')?.click()` })
  await sleep(700)
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const title = document.querySelector('.page__title')
      const body = document.querySelector('.page__body')
      const content = document.querySelector('.app__content')
      if (!title || !body || !content) return JSON.stringify({ missing: true })
      const titleTopBefore = Math.round(title.getBoundingClientRect().top)
      const contentScrollBefore = content.scrollTop
      body.scrollTop = 200
      const titleTopAfter = Math.round(title.getBoundingClientRect().top)
      const result = {
        titleFixed: titleTopBefore === titleTopAfter && titleTopAfter > 0,
        outerNotScrolled: content.scrollTop === contentScrollBefore,
        bodyScrollable: body.scrollHeight > body.clientHeight,
        bodyScrollTop: body.scrollTop,
      }
      body.scrollTop = 0
      return JSON.stringify(result)
    })()`,
    returnByValue: true,
  })
  const snap = JSON.parse(r.result?.result?.value ?? '{}')
  // 标题固定 + 外层不滚是硬要求；内容是否溢出取决于页面，只有溢出时才要求真的能滚
  const ok = snap.titleFixed && snap.outerNotScrolled && (!snap.bodyScrollable || snap.bodyScrollTop > 0)
  console.log(
    `${ok ? '✓' : '✗'} 滚动结构 ${nav.padEnd(9)} 标题固定=${snap.titleFixed} 外层未滚=${snap.outerNotScrolled} 内容可滚=${snap.bodyScrollable}(>${snap.bodyScrollTop}) `
  )
  results.push({ nav, sel: 'scroll', ok })
}

await send('Emulation.clearDeviceMetricsOverride')
ws.close()
child.kill()
rmSync(profile, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log('')
if (failed.length) {
  console.log(`✗ ${failed.length}/${results.length} 个主区域没有跟着窗口变高`)
  process.exit(1)
}
console.log(`✓ ${results.length}/${results.length} 个主区域都随窗口高度增长（不再有底部留白）`)
