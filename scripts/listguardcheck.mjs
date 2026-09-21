/**
 * 清单设置的守门验证：改名与删除必须是两个独立动作，绝不能互相滑过去。
 *
 * 来由：1.6.0 的「清单设置」把两件事塞进一个函数 —— 改名对话框的默认值就是当前名，
 * 条件不成立（没改名、或者用户点了取消，此时 prompt resolve(null)）就继续往下走，
 * 落到 dialog.confirm「删除清单？」。取消一次 = 弹一次删除确认。
 *
 * 断言写成行为而不是实现细节：不管这里最终用的是菜单还是两个按钮，
 * 「取消重命名之后不得出现删除确认」都必须成立。
 */
import { join } from 'node:path'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

const tmpHome = join(ROOT, '.screenshots', 'listguard-home')
const PORT = 9386

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()

/** 当前弹框（如果有）的标题与是否出现删除确认。 */
const dialogState = `(() => {
  const d = document.querySelector('.modal--dialog')
  return { open: !!d, title: d ? (d.querySelector('h2')?.textContent || '') : '' }
})()`

try {
  console.log('【就绪】等界面稳定…')
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    if (i % 3 === 2) console.log('  ' + Math.round((i + 1) * 0.5) + 's')
  }

  await app.evaluate("document.querySelector('[data-nav-item=\"tasks\"]')?.click()")
  await sleep(1500)

  const listId = await app.evaluate(`(async () => {
    const folders = await window.zhixing.db.listFolders()
    const one = folders.find((f) => f.kind === 'list')
    if (one) return one.id
    const made = await window.zhixing.db.createListFolder('守门验证清单', 'list', null)
    return made && made.id
  })()`)
  check('拿到一张可操作的清单', typeof listId === 'number' && listId > 0, J(listId))

  await app.evaluate(`(() => {
    const s = document.querySelector('select[aria-label="按清单筛选"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(s, '${listId}')
    s.dispatchEvent(new Event('change', { bubbles: true }))
    return s.value
  })()`)
  await sleep(900)

  // 点「清单设置」
  const opened = await app.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '清单设置')
    if (!b) return 'no-button'
    b.click()
    return 'clicked'
  })()`)
  check('任务页有「清单设置」入口', opened === 'clicked', J(opened))
  await sleep(800)

  // 进来之后是什么？菜单（新实现）还是改名对话框（旧实现）都接受，但必须能分辨
  const first = await app.evaluate(dialogState)
  const menuItems = await app.evaluate(
    "(() => [...document.querySelectorAll('.popmenu button, .popmenu__item')].map((b) => b.textContent.trim()))()"
  )
  console.log('  首个界面：' + J({ dialog: first, menu: menuItems }))

  // 这条必须在菜单还开着的时候断言 —— 选完菜单就关了
  check(
    '清单设置里改名与删除是分开的两个独立入口',
    menuItems.includes('重命名清单') && menuItems.includes('删除清单'),
    J(menuItems)
  )

  if (first.open && first.title.includes('重命名')) {
    // 旧实现：改名对话框直接出现 —— 点取消，然后检查有没有滑向删除
    await app.evaluate(
      "[...document.querySelectorAll('.modal__foot button')].find((b) => b.textContent.trim() === '取消')?.click()"
    )
  } else {
    // 新实现：菜单。点「重命名清单」，再在对话框里取消
    await app.evaluate(
      "[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '重命名清单')?.click()"
    )
    await sleep(700)
    await app.evaluate(
      "[...document.querySelectorAll('.modal__foot button')].find((b) => b.textContent.trim() === '取消')?.click()"
    )
  }
  await sleep(900)

  const after = await app.evaluate(dialogState)
  check(
    '取消重命名之后不得出现「删除清单」确认',
    !(after.open && after.title.includes('删除')),
    J(after)
  )

} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
await app.close()
process.exit(finish())