/**
 * 确认弹框的端到端验证：全部改成了应用内弹框（带图标）。
 *
 * 覆盖：
 *   1. 点删除 → 出现应用内弹框（.modal--dialog），带图标
 *   2. 标题 / 正文 / 按钮文案正确
 *   3. 点「取消」→ 弹框关闭、数据没动
 *   4. 再点一次 → 点「删除」→ 数据真的被删
 * 顺带断言：源码里已经没有 window.confirm（由 scripts 外的 grep 保证，这里只验证行为）
 *
 * 用法：node scripts/confirmcheck.mjs（需先 npm run build）
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

const tmpHome = join(ROOT, '.screenshots', 'confirm-home')
const PORT = 9248

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish, results } = createChecker()
const shoot = async (name) => {
  const r = await app.send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) writeFileSync(join(shotDir, name), Buffer.from(r.result.data, 'base64'))
}

const TITLE = 'CONFIRM-' + Date.now().toString(36)
await app.evaluate(`window.zhixing.db.createNote(${JSON.stringify(TITLE)}, null, '正文', 'markdown')`)
await app.evaluate("document.querySelector('[data-nav-item=notes]').click()")
await sleep(1500)

/** 点笔记树里那篇测试笔记的删除按钮 */
const clickTreeDelete = async () =>
  app.evaluate(
    `(() => {
      const row = [...document.querySelectorAll('.ntree__note')].find((el) => el.innerText.includes(${JSON.stringify(TITLE)}))
      if (!row) return false
      row.querySelector('.icon-btn--danger')?.click()
      return true
    })()`
  )

const opened = await clickTreeDelete()
await sleep(500)
const dlg = await app.evaluate(`(() => {
  const modal = document.querySelector('.modal--dialog')
  if (!modal) return null
  const icon = modal.querySelector('.dialog__icon')
  const buttons = [...modal.querySelectorAll('.modal__foot button')].map((b) => b.textContent.trim())
  return {
    title: modal.querySelector('.modal__head h2')?.textContent.trim() ?? '',
    message: modal.querySelector('.dialog__message')?.textContent.trim() ?? '',
    hasIcon: !!icon,
    iconSvg: icon ? !!icon.querySelector('svg') : false,
    iconDanger: icon ? icon.classList.contains('dialog__icon--danger') : false,
    buttons,
  }
})()`)
check('点删除后弹出应用内弹框（不是原生框）', !!dlg, JSON.stringify(dlg))
check('弹框带图标（圆形底色 + svg）', dlg?.hasIcon === true && dlg?.iconSvg === true, '')
check('删除类弹框用危险色图标', dlg?.iconDanger === true, '')
check('标题与正文正确', dlg?.title === '删除笔记' && String(dlg?.message).includes(TITLE), `${dlg?.title} / ${dlg?.message}`)
check('按钮是「取消 / 删除」', JSON.stringify(dlg?.buttons) === JSON.stringify(['取消', '删除']), JSON.stringify(dlg?.buttons))
await shoot('confirm-dialog.png')

// 取消 → 什么也没发生
await app.evaluate(
  "[...document.querySelectorAll('.modal--dialog .modal__foot button')].find((b) => b.textContent.trim() === '取消')?.click()"
)
await sleep(400)
const afterCancel = await app.evaluate(`(() => ({
  modal: !!document.querySelector('.modal--dialog'),
  exists: !!document.body.innerText.includes(${JSON.stringify(TITLE)}),
}))()`)
check('点取消后弹框关闭且数据还在', afterCancel.modal === false && afterCancel.exists === true, JSON.stringify(afterCancel))

// 确定 → 真的删掉
await clickTreeDelete()
await sleep(400)
await app.evaluate(
  "[...document.querySelectorAll('.modal--dialog .modal__foot button')].find((b) => b.textContent.trim() === '删除')?.click()"
)
await sleep(800)
const afterOk = await app.evaluate(`(() => {
  const count = document.querySelectorAll('.ntree__note').length
  const rows = [...document.querySelectorAll('.ntree__note')].map((el) => el.innerText)
  return { modal: !!document.querySelector('.modal--dialog'), stillThere: rows.some((t) => t.includes(${JSON.stringify(TITLE)})) }
})()`)
check('点删除后弹框关闭且数据被删除', afterOk.modal === false && afterOk.stillThere === false, JSON.stringify(afterOk))

await sleep(500)

await app.close()
process.exit(finish())