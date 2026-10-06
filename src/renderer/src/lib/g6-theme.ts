/**
 * G6 主题桥 —— 把本软件的设计 token 翻译成 **G6 的主题对象**。
 *
 * ## 用 G6 的主题接口，而不是自己塞样式
 *
 * G6 的主题就是「Graph Options 的子集」：
 *
 * ```
 * { background, node: { palette, style, state, animation }, edge: {…}, combo: {…} }
 * ```
 *
 * 用法只有两步（见官方文档 theme/custom-theme）：
 *
 * ```ts
 * register(ExtensionCategory.THEME, 'zhixing', theme)   // 注册
 * new Graph({ theme: 'zhixing' })                        // 按名字引用
 * ```
 *
 * 所以本文件产出的是**一份完整的主题对象**，画布里只需要写 `theme: THEME_NAME`；
 * 各元素自己的样式（比如按数据变化的节点主色、图标）才留在图配置项的 style 里 ——
 * 因为**主题只支持静态值，不支持回调**（官方明确限制）。
 *
 * ## 两条硬约束（都踩过）
 *
 * 1. **canvas 不认 CSS 变量、也不认 `color-mix()`** —— 主题里的每个色值都必须是解好的实色，
 *    所以统一走 `tokSolid()`；它遇到 `color-mix(...)` / `calc(...)` 会退回兜底 token 并 warn 一次。
 * 2. **主题只在建图时按名字解析一次**，`register` 同名会覆盖（G6 会打一条 warn）。
 *    所以换主题的流程是：重新 `register` → `graph.setTheme(名字)` → `graph.draw()`，
 *    见 `applyZhixingTheme()`。
 */
import { ExtensionCategory, register } from '@antv/g6'

/** 注册到 G6 的主题名（全局唯一，重复注册即覆盖）。 */
export const THEME_NAME = 'zhixing'

/** 读一个 CSS 自定义属性的当前计算值。 */
function tok(name: string): string {
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

/** 按比例混两个颜色：`a` 占 `pa`（等价于 CSS 的 `color-mix(in srgb, a pa%, b)`）。 */
export function mix(a: string, pa: number, b: string): string {
  const parse = (s: string): [number, number, number] | null => {
    const m = /^#([0-9a-f]{6})$/i.exec(s.trim())
    if (m) {
      const n = parseInt(m[1], 16)
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }
    const r = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(s.trim())
    return r ? [Number(r[1]), Number(r[2]), Number(r[3])] : null
  }
  const ca = parse(a)
  const cb = parse(b)
  if (!ca || !cb) return a
  const c = ca.map((v, i) => Math.round(v * pa + cb[i] * (1 - pa)))
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
}

/** 图标等地方要用到的关键色值（与主题同源，避免两处各读一遍 token）。 */
export interface ThemeTokens {
  bgLayer: string
  bgCanvas: string
  fgPrimary: string
  borderStrong: string
  fontUi: string
}

export function themeTokens(): ThemeTokens {
  return {
    bgLayer: tokSolid('--bg-layer-solid', '--pack-layer'),
    bgCanvas: tokSolid('--bg-canvas', '--pack-canvas'),
    fgPrimary: tok('--fg-primary'),
    borderStrong: tok('--border-strong'),
    fontUi: tok('--font-ui'),
  }
}

/**
 * 当前软件主题 → **G6 主题对象**。
 *
 * 每次调用都重新读一遍 token —— 不要在模块顶层缓存，那样主题切换后拿到的还是旧值。
 *
 * ⚠️ G6 的限制：**主题里只能写静态值**（不支持回调），且**状态样式用到的属性要在默认样式里出现过**。
 */
export function zhixingTheme(): Record<string, unknown> {
  const t = themeTokens()
  const fgSecondary = tok('--fg-secondary')
  const bgHover = tokSolid('--bg-hover', '--pack-layer')
  const focusRing = tokSolid('--focus-ring', '--accent')
  const borderW = tokNum('--border-w')
  const focusW = tokNum('--focus-w')
  const textAux = tokNum('--text-aux')
  const fontWeight = Number(tok('--fw-normal')) || 400

  return {
    /** 画布背景（主题里的 background 就是干这个的；早先试过 canvas.background，那个键不存在）。 */
    background: t.bgCanvas,

    node: {
      style: {
        fill: t.bgLayer,
        stroke: t.borderStrong,
        lineWidth: borderW,
        labelFill: t.fgPrimary,
        labelFontFamily: t.fontUi,
        labelFontSize: textAux,
        labelFontWeight: fontWeight,
        labelPlacement: 'bottom',
        labelOffsetY: 4,
        portFill: t.bgLayer,
        portStroke: t.borderStrong,
        portLineWidth: borderW,
        badgeFill: t.bgLayer,
        badgeFontSize: 9,
        /**
         * 选中/悬停用 **halo（光晕）** 表达，而不是改 stroke ——
         * 图谱节点的 keyShape 是透明的（视觉主体是图标），改 stroke 会让圆圈"啪"地冒出来，
         * 看起来就是「点击后闪一下」（用户反馈）。halo 在默认样式里先声明、状态里只翻开关，
         * 过渡就平顺了（G6 内置主题也正是这么做的）。
         */
        halo: false,
        haloStroke: focusRing,
        haloLineWidth: 12,
        haloStrokeOpacity: 0.28,
        haloPointerEvents: 'none',
      },
      state: {
        selected: { halo: true },
        active: { halo: true },
        highlight: { halo: true },
        inactive: { opacity: 0.3 },
        /** 图谱搜索/连线时的淡化用自己的状态名，与 inactive 分开，便于独立调。 */
        dim: { opacity: 0.3 },
      },
    },

    edge: {
      style: {
        stroke: t.borderStrong,
        lineWidth: borderW,
        endArrow: false,
        labelFill: t.fgPrimary,
        labelFontFamily: t.fontUi,
        labelFontSize: textAux,
        labelBackground: true,
        labelBackgroundFill: t.bgLayer,
        labelBackgroundOpacity: 0.85,
        labelPadding: [0, 4],
      },
      state: {
        selected: { lineWidth: focusW, stroke: focusRing },
        active: { lineWidth: focusW },
        inactive: { opacity: 0.08 },
        dim: { opacity: 0.08 },
      },
    },

    combo: {
      style: {
        fill: bgHover,
        stroke: tok('--border'),
        lineWidth: borderW,
        radius: tokNum('--radius-lg'),
        labelFill: fgSecondary,
        labelFontFamily: t.fontUi,
        labelFontSize: textAux,
      },
      state: {
        selected: { stroke: focusRing, lineWidth: focusW },
        inactive: { opacity: 0.15 },
      },
    },
  }
}

/**
 * 注册（或按当前主题重新注册）。
 *
 * **同名重复注册 G6 会打一条 warn** —— 这是有意的：主题对象是静态的，
 * 换主题只能换一份新对象，而名字要保持稳定（画布、其他组件都按 THEME_NAME 引用）。
 */
export function registerZhixingTheme(): string {
  register(ExtensionCategory.THEME, THEME_NAME, zhixingTheme() as never)
  return THEME_NAME
}

/** 主题变了：重新注册 + 切换 + 重绘。 */
export function applyZhixingTheme(graph: { setTheme(t: string): void; draw(): unknown }): void {
  registerZhixingTheme()
  graph.setTheme(THEME_NAME)
  void graph.draw()
}

/**
 * 订阅软件主题变更。返回取消订阅函数。
 *
 * 目前靠 `zhixing:theme` 这个 DOM 事件 —— 主题包切换时由 applyTheme 派发；
 * 另外监听系统深浅色变化（「跟随系统」模式下会走到这里）。
 * **回调不带参数**：调用方拿到信号后自己 `applyZhixingTheme(graph)`。
 */
export function subscribeG6Theme(onChange: () => void): () => void {
  window.addEventListener('zhixing:theme', onChange)
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onMq = (): void => onChange()
  mq.addEventListener('change', onMq)
  return () => {
    window.removeEventListener('zhixing:theme', onChange)
    mq.removeEventListener('change', onMq)
  }
}
