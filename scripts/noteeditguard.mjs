/**
 * 笔记切页不丢编辑：在防抖窗口（800ms）内切走，内容必须已经落盘。
 *
 * 来由：自动保存 effect 的 cleanup 只 clearTimeout。它的依赖里有 title / content，
 * 所以「每敲一个字」和「组件卸载」都会触发同一个 cleanup —— 卸载时挂起的保存被取消，编辑丢失。
 *
 * 输入用真实鼠标（Input.dispatchMouseEvent）聚焦 + Input.insertText：
 * 程序化 element.click() 不触发 mousedown，CodeMirror 不会聚焦。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = join(root, '.screenshots', 'noteedit-home')
const PORT = 9388
const MARKER = '守门标记' + Date.now().toString().slice(-6)
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db'), join(tmpHome, 'zhixing.db'))

const SYS_PATH = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem'].join(';')
console.log('【启动】拉起 Electron…（标记 ' + MARKER + '）')
const child = spawn(
  electronPath,
  ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(tmpHome, 'profile')],
  {
    cwd: root,
    env: { ...process.env, PATH: SYS_PATH + ';' + (process.env.PATH ?? ''), ZHIXING_HOME: tmpHome },
    stdio: ['ignore', 'pipe', 'pipe']
  }
)

const listTargets = async () => {
  try {
    return await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
  } catch {
    return []
  }
}

let main = null
for (let i = 0; i < 70 && !main; i++) {
  const all = await listTargets()
  const t = all.find((x) => x.type === 'page' && !/[?&](widget|reminder|condition|capture)=1/.test(x.url))
  if (t) {
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((res) => ws.addEventListener('open', res, { once: true }))
    const send = (m, p = {}) =>
      new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e6)
        const timer = setTimeout(() => {
          ws.removeEventListener('message', h)
          reject(new Error('CDP 超时（15s）：' + m))
        }, 15000)
        const h = (ev) => {
          const x = JSON.parse(ev.data)
          if (x.id !== id) return
          clearTimeout(timer)
          ws.removeEventListener('message', h)
          resolve(x)
        }
        ws.addEventListener('message', h)
        ws.send(JSON.stringify({ id, method: m, params: p }))
      })
    await send('Runtime.enable')
    main = {
      send,
      evaluate: async (expr, quiet) => {
        if (!quiet) console.log('  · eval ' + String(expr).replace(/\s+/g, ' ').slice(0, 62))
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
        if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval 失败')
        return r.result?.result?.value
      }
    }
  } else {
    if (i % 4 === 0) console.log('【等窗口】' + Math.round(i * 0.5) + 's')
    await sleep(500)
  }
}

const results = []
const check = (n, ok, d = '') => {
  results.push(ok)
  console.log((ok ? '✓ ' : '✗ ') + n + (d ? ' — ' + d : ''))
}
const J = (v) => JSON.stringify(v)

const clickAt = async (x, y) => {
  await main.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await main.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

try {
  console.log('【就绪】等界面稳定…')
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    if (i % 3 === 2) console.log('  ' + Math.round((i + 1) * 0.5) + 's')
  }

  await main.evaluate("document.querySelector('[data-nav-item=\"notes\"]')?.click()")
  await sleep(1800)

  const target = await main.evaluate(`(async () => {
    const notes = await window.zhixing.db.notes()
    const n = notes.find((x) => x.format === 'markdown')
    return n ? { id: n.id, title: n.title } : null
  })()`)
  check('找到一篇 Markdown 笔记', !!target && typeof target.id === 'number', J(target))

  if (target) {
    const titleJs = JSON.stringify(target.title)
    const clicked = await main.evaluate(`(() => {
      const el = [...document.querySelectorAll('.ntree__note')].find((e) => e.textContent.includes(${titleJs}))
      if (!el) return false
      el.click()
      return true
    })()`)
    check('在笔记树里选中它', clicked === true)
    await sleep(1500)

    const spot = await main.evaluate(`(() => {
      const r = document.querySelector('.cm-content')?.getBoundingClientRect()
      return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 30) } : null
    })()`)
    check('编辑器已就绪（.cm-content 可见）', !!spot, J(spot))

    if (spot) {
      await clickAt(spot.x, spot.y)
      await sleep(300)
      await main.send('Input.insertText', { text: MARKER })
      await sleep(150)
      const typed = await main.evaluate(
        `document.querySelector('.cm-content')?.textContent?.includes(${JSON.stringify(MARKER)}) === true`,
        true
      )
      check('标记文字已进入编辑器', typed === true)

      await main.evaluate("document.querySelector('[data-nav-item=\"tasks\"]')?.click()")
      console.log('  （已切到任务页 —— 在 800ms 防抖窗口内）')
      await sleep(2000)

      const persisted = await main.evaluate(`(async () => {
        const list = await window.zhixing.db.notes()
        const n = list.find((x) => x.id === ${target.id})
        return { hit: !!n && (n.content_md || '').includes(${JSON.stringify(MARKER)}) }
      })()`, true)
      check('切页后内容已经落盘（不丢编辑）', persisted?.hit === true, J(persisted))
    }
  }
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
const failed = results.filter((r) => !r).length
console.log('')
console.log(failed ? '✗ ' + failed + ' 项未通过' : '✓ 全部通过（' + results.length + ' 项）')
await sleep(400)
child.kill()
process.exit(failed ? 1 : 0)
