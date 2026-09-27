/**
 * 动效性能采样：把「交互期间不卡」从口号变成可失败的断言。
 *
 * 为什么需要它：docs/03 §11.5 自己写着「无统一的帧率/性能预算实测」。本轮加入了
 * 一大批新动效（完成划线、列表交错、浮层进出场、图谱聚焦、工具栏滚动抬升、主题过渡），
 * 如果没有一条能红的下限，谁都不知道某次改动是不是把主线程压垮了。
 *
 * 判据（首次量化，写进 docs/03 §11）：
 * - 每个页面渲染后的 1.2s 内，平均帧率不得低于 50fps（60fps 显示器下留出余量）；
 * - 采样窗口内不得出现长任务（>50ms）—— 只允许 0 个；
 * - 切页之后 getAnimations() 必须 > 0（证明动效确实在跑，而不是被谁悄悄关掉）；
 * - 把根元素的 data-motion 置为 none 后，动画必须归零（两级降级的运行时证据）。
 *
 * 跑之前必须先 npm run build（lib/cdp.mjs 起的是 out/ 产物），且不能与其他 E2E 并行。
 */
import { join } from 'node:path'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

const tmpHome = join(ROOT, '.screenshots', 'motionperf-home')
const PORT = 9391

/** 采样窗口（毫秒）：够长以覆盖进入动画，够短以不拖慢脚本。 */
const WINDOW_MS = 1200
/** 平均帧率下限：60fps 显示器留 10 帧余量，避免 CI 抖动误报。 */
const MIN_FPS = 50

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()

/** 在页面里跑一个 rAF 采样 + 长任务观察器。 */
const sampler = `(async () => {
  const long = []
  const po = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) long.push(Math.round(e.duration))
  })
  try { po.observe({ entryTypes: ['longtask'] }) } catch {}
  const t0 = performance.now()
  let frames = 0
  // 动画数取「窗口内出现过的最大值」：进入动画只有 200-280ms，
  // 采样结束时再读一次必然已经播完，那样断言等于永远为 0。
  let anims = 0
  await new Promise((res) => {
    const tick = () => {
      frames += 1
      anims = Math.max(anims, document.getAnimations().length)
      if (performance.now() - t0 < ${WINDOW_MS}) requestAnimationFrame(tick)
      else res()
    }
    requestAnimationFrame(tick)
  })
  po.disconnect()
  const ms = performance.now() - t0
  return {
    frames,
    ms: Math.round(ms),
    fps: Math.round((frames * 1000) / ms),
    long,
    anims
  }
})()`

/** 页面 key → 侧栏项 key 一致，直接点导航。 */
const PAGES = ['today', 'tasks', 'notes', 'graph', 'workflow', 'inbox', 'settings', 'review']

try {
  console.log('【就绪】等界面稳定…')
  for (let i = 0; i < 6; i++) {
    await sleep(500)
    if (i % 3 === 2) console.log('  ' + Math.round((i + 1) * 0.5) + 's')
  }

  for (const page of PAGES) {
    const clicked = await app.evaluate(
      `(() => { const b = document.querySelector('[data-nav-item="${page}"]'); if (!b) return false; b.click(); return true })()`
    )
    if (!clicked) {
      check('导航项存在：' + page, false, '找不到 [data-nav-item="' + page + '"]')
      continue
    }
    // 切页动画在挂载那一帧开始，所以不等待，直接采
    const seen = await app.evaluate(sampler)
    check(
      page + ' 页帧率 ≥ ' + MIN_FPS + 'fps',
      seen && seen.fps >= MIN_FPS,
      J({ fps: seen?.fps, frames: seen?.frames, ms: seen?.ms })
    )
    check(
      page + ' 页采样窗口内无长任务',
      Array.isArray(seen?.long) && seen.long.length === 0,
      J(seen?.long ?? null)
    )
    if (page !== 'today') {
      check(page + ' 页切换后有动画在跑', (seen?.anims ?? 0) > 0, J(seen?.anims ?? 0))
    }
  }

  // 降级：data-motion='none' 之后，动画必须归零（tokens.css 与 theme.ts 的共同契约）
  await app.evaluate("document.documentElement.dataset.motion = 'none'")
  await app.evaluate("document.querySelector('[data-nav-item=\"tasks\"]')?.click()")
  await sleep(200)
  // 只数「会动的」动画：duration 为 0ms 的 CSS 动画在诞生那一帧仍然出现在 getAnimations() 里
  // （它瞬间就结束），数数量会把「已经归零」误判成「还在动」。
  const frozen = await app.evaluate(
    'JSON.stringify(document.getAnimations().filter((a) => a.effect && a.effect.getTiming && (a.effect.getTiming().duration || 0) > 0).map((a) => ({ n: a.animationName || a.transitionProperty || a.constructor.name, d: a.effect.getTiming().duration, t: a.effect.target ? (a.effect.target.className || a.effect.target.tagName) : '' })))'
  )
  check('data-motion=none 时不再有会动的动画', frozen === '[]', frozen)
  await app.evaluate("document.documentElement.dataset.motion = ''")
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}

await app.close()
process.exit(finish())
