/**
 * 补充验收（1.8.0 追加两项）：
 *   1. 清单栏的行内操作按钮未悬浮时**不占位**（宽度为 0），鼠标移上去才展开；
 *   2. 清单计数跟主题强调色一致；
 *   3. 设置页可以自定义强调色（任意取色）与主题包 token（覆盖生效并落库、可一键恢复）。
 */
import { join } from 'node:path'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

const app = await launchApp({ port: 9398, home: join(ROOT, '.screenshots', 'themecustom-home') })
const { check, finish } = createChecker()

/** 把一个 <input type="color"> 设成指定值并触发 React 的 onChange */
const SET_COLOR = (selector, value) => `(() => {
  const input = document.querySelector('${selector}')
  if (!input) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '${value}')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`

const TASK_ROW = ".tasklists__body:not(.tasklists__body--sub) .tasklists__row"

try {
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    if (i % 3 === 2) console.log('  ' + Math.round((i + 1) * 0.5) + 's')
  }
  await app.evaluate("document.querySelector('[data-nav-item=\"tasks\"]')?.click()")
  await sleep(1800)

  // ---------------------------------------------------------------- 1. 行内按钮不占位
  const idle = await app.evaluate(`(() => {
    const row = [...document.querySelectorAll('${TASK_ROW}')].find((r) => r.querySelector('.tasklists__more'))
    if (!row) return null
    const btn = row.querySelector('.tasklists__more')
    const name = row.querySelector('.tasklists__name')
    return {
      btnWidth: Math.round(btn.getBoundingClientRect().width),
      nameWidth: Math.round(name.getBoundingClientRect().width),
      x: name.getBoundingClientRect().left + 20,
      y: name.getBoundingClientRect().top + name.getBoundingClientRect().height / 2,
    }
  })()`)
  check('未悬浮时行内操作按钮宽度为 0（不占位）', idle !== null && idle.btnWidth === 0, J(idle))

  if (idle) {
    await app.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(idle.x),
      y: Math.round(idle.y),
      button: 'none',
    })
    await sleep(400)
    const hovered = await app.evaluate(`(() => {
      const row = [...document.querySelectorAll('${TASK_ROW}')].find((r) => r.querySelector('.tasklists__more'))
      const btn = row?.querySelector('.tasklists__more')
      return btn ? Math.round(btn.getBoundingClientRect().width) : -1
    })()`)
    check('鼠标悬浮后按钮展开（宽度 > 0）', hovered > 0, J({ hovered }))
  }

  // ---------------------------------------------------------------- 2. 计数用强调色
  const countColor = await app.evaluate(`(() => {
    const el = document.querySelector('.tasklists__count')
    if (!el) return null
    const hex = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    const probe = document.createElement('span')
    probe.style.color = hex
    document.body.appendChild(probe)
    const want = getComputedStyle(probe).color
    probe.remove()
    return { got: getComputedStyle(el).color, want, hex }
  })()`)
  check(
    '清单计数用的是主题强调色',
    countColor !== null && countColor.got === countColor.want,
    J(countColor)
  )

  // ---------------------------------------------------------------- 3. 设置页自定义
  await app.evaluate("document.querySelector('[data-nav-item=\"settings\"]')?.click()")
  await sleep(1600)

  const hasCustom = await app.evaluate(
    "(() => ({ accent: !!document.querySelector('.swatch--custom input[type=color]'), tokens: document.querySelectorAll('.theme-token input[type=color]').length }))()"
  )
  check(
    '设置页有自定义强调色与主题包配色入口',
    hasCustom.accent === true && hasCustom.tokens >= 4,
    J(hasCustom)
  )

  const accentSet = await app.evaluate(SET_COLOR('.swatch--custom input[type=color]', '#123456'))
  await sleep(1200)
  const accentState = await app.evaluate(`(async () => ({
    css: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase(),
    db: (await window.zhixing.db.settings()).accent_color || '',
  }))()`)
  check(
    '强调色可以任意取色：CSS 变量与设置都更新到 #123456',
    accentSet === true && accentState.css === '#123456' && accentState.db.toLowerCase() === '#123456',
    J(accentState)
  )

  const tokenSet = await app.evaluate(SET_COLOR('.theme-token input[type=color]', '#0A0B0C'))
  await sleep(1200)
  const tokenState = await app.evaluate(`(async () => {
    const raw = await window.zhixing.db.settings()
    return {
      css: getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas').trim(),
      stored: raw.theme_custom_light || '',
      marks: document.querySelectorAll('.theme-token--custom').length,
    }
  })()`)
  check(
    '主题包配色可自定义：第一个 token 覆盖生效并落库',
    tokenSet === true &&
      tokenState.css.toLowerCase() === '#0a0b0c' &&
      tokenState.stored.toLowerCase().includes('#0a0b0c') &&
      tokenState.marks >= 1,
    J(tokenState)
  )

  const reset = await app.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '恢复主题包默认')
    if (!btn || btn.disabled) return false
    btn.click()
    return true
  })()`)
  await sleep(1200)
  const resetState = await app.evaluate(`(async () => {
    const raw = await window.zhixing.db.settings()
    return {
      stored: raw.theme_custom_light || '',
      css: getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas').trim(),
      marks: document.querySelectorAll('.theme-token--custom').length,
    }
  })()`)
  check(
    '「恢复主题包默认」清空自定义并回到主题包配色',
    reset === true && resetState.stored === '' && resetState.marks === 0,
    J({ reset, resetState })
  )
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
await app.close()
process.exit(finish())
