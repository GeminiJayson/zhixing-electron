/**
 * 笔记切页不丢编辑：在防抖窗口（800ms）内切走，内容必须已经落盘。
 *
 * 来由：自动保存 effect 的 cleanup 只 clearTimeout。它的依赖里有 title / content，
 * 所以「每敲一个字」和「组件卸载」都会触发同一个 cleanup —— 卸载时挂起的保存被取消，编辑丢失。
 *
 * 输入用真实鼠标（Input.dispatchMouseEvent）聚焦 + Input.insertText：
 * 程序化 element.click() 不触发 mousedown，CodeMirror 不会聚焦。
 */
import { join } from 'node:path'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

const MARKER = '守门标记' + Date.now().toString().slice(-6)
const tmpHome = join(ROOT, '.screenshots', 'noteedit-home')
const PORT = 9388

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()

const clickAt = async (x, y) => {
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

try {
  console.log('【就绪】等界面稳定…')
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    if (i % 3 === 2) console.log('  ' + Math.round((i + 1) * 0.5) + 's')
  }

  await app.evaluate("document.querySelector('[data-nav-item=\"notes\"]')?.click()")
  await sleep(1800)

  const target = await app.evaluate(`(async () => {
    const notes = await window.zhixing.db.notes()
    const n = notes.find((x) => x.format === 'markdown')
    return n ? { id: n.id, title: n.title } : null
  })()`)
  check('找到一篇 Markdown 笔记', !!target && typeof target.id === 'number', J(target))

  if (target) {
    const titleJs = JSON.stringify(target.title)
    const clicked = await app.evaluate(`(() => {
      const el = [...document.querySelectorAll('.ntree__note')].find((e) => e.textContent.includes(${titleJs}))
      if (!el) return false
      el.click()
      return true
    })()`)
    check('在笔记树里选中它', clicked === true)
    await sleep(1500)

    const spot = await app.evaluate(`(() => {
      const r = document.querySelector('.cm-content')?.getBoundingClientRect()
      return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 30) } : null
    })()`)
    check('编辑器已就绪（.cm-content 可见）', !!spot, J(spot))

    if (spot) {
      await clickAt(spot.x, spot.y)
      await sleep(300)
      await app.send('Input.insertText', { text: MARKER })
      await sleep(150)
      const typed = await app.evaluate(
        `document.querySelector('.cm-content')?.textContent?.includes(${JSON.stringify(MARKER)}) === true`,
        true
      )
      check('标记文字已进入编辑器', typed === true)

      await app.evaluate("document.querySelector('[data-nav-item=\"tasks\"]')?.click()")
      console.log('  （已切到任务页 —— 在 800ms 防抖窗口内）')
      await sleep(2000)

      const persisted = await app.evaluate(`(async () => {
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
await app.close()
process.exit(finish())