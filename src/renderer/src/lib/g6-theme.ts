/**
 * G6 主题桥：把 `tokens.css` 的设计令牌翻译成 G6 能吃的样式对象。
 *
 * ## 为什么必须有这一层
 *
 * 换成 G6 之后图是**画在 Canvas 上**的 —— canvas 里的像素**不认 CSS 变量**。
 * 如果不做这层桥，上一轮 token 化的成果（主题包、强调色、暗色模式、密度设置）
 * 在图谱与工作流上会**全部失效**，而且是静默失效：图照样画出来，只是颜色不再跟随主题。
 *
 * 所以规则只有一条：**G6 的每一个样式键，值都必须来自 token**。
 * 这里出现的十六进制字面量只允许有一个来源 —— `tok()`。
 *
 * ## 什么时候重建
 *
 * 主题切换（`zhixing:theme` 事件 / 设置页改主题包）后 token 的值变了，
 * **已画上去的图不会自己重画**。用 `subscribeG6Theme` 订阅，回调里调 `graph.setOptions`
 * 增量更新即可，不必整图重建。
 */

/** 读一个 CSS 自定义属性的当前计算值。 */
export function tok(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/**
 * 读一个**保证是实色**的 token。
 *
 * **这是本次迁移第一个踩到的坑**（实测，2026-10-05）：`--bg-canvas` 的值是
 * `color-mix(in srgb, #1f1f1f max(55%, calc(56% * 1.05)), transparent)` ——
 * **CSS 能解析，canvas 不能**。把它交给 G6 当背景，canvas 直接回退成**白色**；
 * 而深色主题的文字是浅色（`#f2f2f2`）—— 结果就是**浅字白底，整张图看不见标签**。
 *
 * 更麻烦的是它**不报错**：图照画，只是"看着不对"。所以这里显式挡一道：
 * 值里出现 `color-mix(` / `calc(` / `transparent` 就换用兜底 token，
 * 并把这件事记进 console 一次（静默降级比崩溃更难查）。
 */
const UNRESOLVABLE = /color-mix\(|calc\(|^transparent$|^$/
const warned = new Set<string>()

export function tokSolid(name: string, fallback: string): string {
  const v = tok(name)
  if (!UNRESOLVABLE.test(v)) return v
  const fb = tok(fallback)
  if (!warned.has(name)) {
    warned.add(name)
    console.warn('[g6-theme] ' + name + ' 的值 canvas 解析不了（' + v.slice(0, 60) + '…），改用 ' + fallback + ' = ' + fb)
  }
  return fb
}

/** 读一个像素值并转成数字（G6 的尺寸类样式要数字，不要 "12px"）。 */
export function tokNum(name: string): number {
  return Number.parseFloat(tok(name)) || 0
}

export interface G6Theme {
  /**
   * **没有 `canvas.background`** —— 实测：G6 v5 的 `GraphOptions` 里没有这个键，
   * 传了不报错但也不生效（画布保持透明，透出容器的底色）。背景改用容器上的
   * CSS 变量 `--bg-canvas` 设置 —— 容器是真实 DOM，CSS 天然生效且跟随主题。
   */
  node: Record<string, unknown>
  edge: Record<string, unknown>
  combo: Record<string, unknown>
  /** 归属边（实线）—— 与引用边（虚线）是两种语义，见 docs/specs/ownership-vs-reference.md */
  edgeOwnership: Record<string, unknown>
  edgeReference: Record<string, unknown>
}

/**
 * 生成当前主题下的 G6 样式。
 *
 * **每次调用都重新读一遍 token** —— 不要在模块顶层缓存成常量，那样主题切换后
 * 拿到的还是旧值。需要缓存就在主题变更时失效。
 */
export function g6Theme(): G6Theme {
  const fontUi = tok('--font-ui')
  const fgPrimary = tok('--fg-primary')
  const fgSecondary = tok('--fg-secondary')
  const borderStrong = tok('--border-strong')
  // 一律走 tokSolid：canvas 与 CSS 的取值能力不同，见 tokSolid 的注释
  const bgLayer = tokSolid('--bg-layer-solid', '--pack-layer')
  const bgHover = tokSolid('--bg-hover', '--pack-layer')

  const labelBase = {
    labelFill: fgPrimary,
    labelFontFamily: fontUi,
    labelFontSize: tokNum('--text-aux'),
    labelFontWeight: Number(tok('--fw-normal')) || 400,
  }

  return {
    node: {
      fill: bgLayer,
      stroke: borderStrong,
      lineWidth: tokNum('--border-w'),
      ...labelBase,
    },

    edge: {
      stroke: borderStrong,
      lineWidth: tokNum('--border-w'),
      endArrow: false,
    },

    combo: {
      fill: bgHover,
      stroke: tok('--border'),
      lineWidth: tokNum('--border-w'),
      radius: tokNum('--radius-lg'),
      ...labelBase,
      labelFill: fgSecondary,
    },

    /** 归属：实线，用较强的边框色 */
    edgeOwnership: {
      stroke: borderStrong,
      lineWidth: tokNum('--border-w'),
      lineDash: [],
    },

    /** 引用：虚线，弱一档 */
    edgeReference: {
      stroke: tok('--border-strong'),
      lineWidth: tokNum('--border-w'),
      lineDash: [tokNum('--space-hair') * 2, tokNum('--space-2xs')],
    },
  }
}

/**
 * 订阅主题变更。返回取消订阅函数。
 *
 * 目前靠 `zhixing:theme` 这个 DOM 事件 —— 主题包切换时由 applyTheme 派发。
 * 另外监听系统深浅色变化（「跟随系统」模式下会走到这里）。
 */
export function subscribeG6Theme(onChange: (t: G6Theme) => void): () => void {
  const fire = (): void => onChange(g6Theme())
  window.addEventListener('zhixing:theme', fire)
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', fire)
  return () => {
    window.removeEventListener('zhixing:theme', fire)
    mq.removeEventListener('change', fire)
  }
}
