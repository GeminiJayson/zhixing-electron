/**
 * 主题应用：把主题包的 token 覆盖写入设计令牌变量。
 * 数据来自 shared/theme-packs.ts，
 * 所以新增主题包只需加数据，不用改这里的代码。
 */
import {
  effectiveThemeColors,
  parseThemeOverrides,
  type ThemeColors,
} from '@shared/theme-packs'
import { ensureTextContrast, parseHex, toHex } from '@shared/color'
import type { AppSettings, ThemeMode } from '@shared/settings'

/** theme_mode 为 system 时按系统明暗解析成实际模式。 */
export function resolveThemeMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode
  // 非浏览器环境（node 下的单测）没有 matchMedia，按浅色处理
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * 把 accent 以 alpha 压在底色上，得到它的实际呈现色 ——
 * 与 CSS 的 color-mix(in srgb, var(--accent) 14%, transparent) 叠在 bg 上等价。
 *
 * 需要它是因为对比度要在 JS 里算，而 color-mix 的结果 JS 拿不到。
 * 底色取 canvas / layer（--accent-soft 实际压在最浅的 layer 上，取它最保守）。
 */
function mixOn(accent: string, alpha: number, bg: string): string {
  const a = parseHex(accent)
  const b = parseHex(bg)
  if (!a || !b) return bg
  return toHex({
    r: a.r * alpha + b.r * (1 - alpha),
    g: a.g * alpha + b.g * (1 - alpha),
    b: a.b * alpha + b.b * (1 - alpha),
  })
}

/** 主题包 token → 设计令牌变量（一个 token 可能喂多个变量）。 */
const TOKEN_VARS: Record<keyof ThemeColors, string[]> = {
  /**
   * 画布色同样只写中间变量：页面底的**不透明度**要跟着玻璃滑块走
   * （它就是"透多少桌面"的那个量），而主题包只负责色相。
   * 与 layer 的处理同理，见下面 layer 的注释。
   */
  canvas: ['--pack-canvas'],
  /**
   * 主题包的层色只写一个中间变量 --pack-layer，**不再直接写 --bg-layer / --bg-layer-solid**。
   *
   * 原因：应用里 30 多处面（面板、卡片、菜单、控件、SVG 填充）都在用那两个令牌，
   * 而玻璃化要求它们全部变成"按 --glass-alpha 派生的半透明色"。逐个改使用点既容易漏，
   * 也把"层的通透程度"这件事散到了各处。现在改成：主题包只负责**色相**（--pack-layer），
   * 通透程度由 tokens.css 的四个玻璃层统一决定 —— 一处改完，30 多处一起变。
   */
  layer: ['--pack-layer'],
  hover: ['--bg-hover'],
  hover2: ['--bg-pressed'],
  fg: ['--fg-primary'],
  fg2: ['--fg-secondary'],
  fg3: ['--fg-tertiary'],
  border: ['--border'],
  border2: ['--border-strong'],
  input: ['--bg-input'],
  scroll: ['--scroll-thumb'],
  /**
   * accent_soft **刻意不在这里** —— 这是「主题包与强调色不联动」的根因。
   *
   * tokens.css 里 --accent-soft 本来是派生的（color-mix(in srgb, var(--accent) 14%, transparent)），
   * 但主题包也各自定义了一份 accent_soft，而 applyTheme 用**行内样式**写变量 ——
   * 行内优先级高于样式表，于是主题包的固定色每次都把派生值盖掉。
   * 结果：选「青竹」包（青绿淡底）再把强调色改成红，就得到红色按钮压在青绿淡底上；
   * 更隐蔽的是 --accent-text 的对比度是拿这份不同源的 soft 算的，那个保证也一起失效。
   *
   * 现在不再写它，让 CSS 的派生生效 —— 永远与强调色同色相，且跟着亮暗主题走。
   * ThemeColors 里的 accent_soft 字段保留但不再读取（删字段要动 28 处定义，不划算）；
   * 这里留一个空数组占位，既满足 Record<keyof ThemeColors, …> 的类型，
   * 又不会往任何变量写值。
   */
  accent_soft: [],
  warm: ['--accent-warm'],
  danger: ['--danger'],
  success: ['--success'],
}

/**
 * 应用主题：先铺主题包的语义色（可被用户自定义色覆盖），再单独写入强调色。
 * 强调色与主题包正交——换主题包不会改掉你选的强调色。
 *
 * `overrides` 是用户在设置页改过的那几个 token；没给的键仍跟随主题包，
 * 所以换主题包时只有用户明确改过的地方保持不变。
 */
export function applyTheme(
  mode: 'light' | 'dark',
  packName: string,
  accentColor: string,
  root: HTMLElement = document.documentElement,
  overrides: Partial<ThemeColors> = {}
): void {
  const colors: ThemeColors = { ...effectiveThemeColors(packName, mode, overrides) }
  // 主题包的文字色是按观感调的柔和色，对 canvas / layer 的对比度大量落在 4.5 以下
  // （实测 168 组里 74 组不达标）。这里按同一套下限做校正：
  // 正文/次要 4.5:1、辅助文字 4.0:1；已达标的值原样保留。
  const surfaces = [colors.canvas, colors.layer]
  colors.fg = ensureTextContrast(colors.fg, surfaces, 4.5)
  colors.fg2 = ensureTextContrast(colors.fg2, surfaces, 4.5)
  colors.fg3 = ensureTextContrast(colors.fg3, surfaces, 4.0)
  for (const [token, vars] of Object.entries(TOKEN_VARS) as [keyof ThemeColors, string[]][]) {
    const value = colors[token]
    if (!value) continue
    for (const v of vars) root.style.setProperty(v, value)
  }
  root.style.setProperty('--accent', accentColor)
  // --accent 是品牌色原值，当文字用对浅底只有 2.9–3.7:1、落在 accent-soft 上仅 2.94，
  // 用户自选浅色时更低（浅黄 1.51）。这里按同一套下限生成 --accent-text（保留色相），
  // 只供 color 使用；填充、边框、accent-color 继续用品牌原值。
  root.style.setProperty(
    '--accent-text',
    // --accent-text 要考虑它自己会落在 accent-soft 的淡底上。那个底现在是派生的
    // （accent 以 14% 压在 layer 上），这里按同一算式还原出实际色值再算对比度 ——
    // 不能再用主题包里那份（早已不同源）。
    ensureTextContrast(accentColor, [...surfaces, ...surfaces.map((bg) => mixOn(accentColor, 0.14, bg))], 4.5)
  )
  // 强调底上的文字不再恒为白 —— 浅强调色（如 #FDE047）上白字只有约 1.3:1。
  // 与上面同一套 ensureTextContrast：从白起步，浅底压暗到 4.5:1，深底保持白。
  root.style.setProperty('--fg-on-accent', ensureTextContrast('#ffffff', [accentColor], 4.5))
  root.dataset.theme = mode
}

/** 动效档位：full=完整、reduced=仅必要、none=关闭。 */
export type MotionState = 'full' | 'reduced' | 'none'

/**
 * OS 级「减少动态效果」探测。
 *
 * Chromium 已把系统开关映射到 CSS 的 prefers-reduced-motion，渲染层直接读即可，
 * 无需再经主进程 + 原生调用。
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 把设置项 + OS 探测合成实际动效档位：
 * 手动 none → 关闭；手动 full 但系统要求减动效 → 仅必要；其余按手动值。
 */
export function resolveMotionState(level: AppSettings['motion_level']): MotionState {
  if (level === 'none') return 'none'
  if (level === 'essential') return 'reduced'
  return prefersReducedMotion() ? 'reduced' : 'full'
}

/**
 * 动效时长表：full 与 tokens.css 的默认值逐项一致。
 * 之所以在 JS 里显式铺一遍而不是只写 data-motion：tokens.css 只定义了
 * [data-motion='none']（全 0），「仅必要」这一档需要比默认更短但非零的时长，
 * 而 tokens.css 不在外观域的改动范围内，故在此以行内变量落地。
 */
const MOTION_DURATIONS: Record<MotionState, Record<string, string>> = {
  full: {
    '--dur-instant': '100ms',
    '--dur-fast': '150ms',
    '--dur-normal': '250ms',
    '--dur-slow': '400ms',
    '--dur-strike': '200ms',
    '--dur-page': '200ms',
    '--dur-panel': '280ms',
  },
  reduced: {
    '--dur-instant': '80ms',
    '--dur-fast': '100ms',
    '--dur-normal': '120ms',
    '--dur-slow': '120ms',
    '--dur-strike': '80ms',
    '--dur-page': '100ms',
    '--dur-panel': '120ms',
  },
  none: {
    '--dur-instant': '0ms',
    '--dur-fast': '0ms',
    '--dur-normal': '0ms',
    '--dur-slow': '0ms',
    '--dur-strike': '0ms',
    '--dur-page': '0ms',
    '--dur-panel': '0ms',
  },
}

/**
 * 应用动效档位：写 data-motion（供纯 CSS 降级）+ 时长变量，并广播事件。
 *
 * 事件 zhixing:motion 是给「无法只靠 CSS 降级」的画布类视图用的
 * （图谱的 d3-force 物理需在减动效时冻结）。
 */
export function applyMotion(
  level: AppSettings['motion_level'],
  root: HTMLElement = document.documentElement
): MotionState {
  const state = resolveMotionState(level)
  root.dataset.motion = state === 'full' ? '' : state
  for (const [name, value] of Object.entries(MOTION_DURATIONS[state])) {
    root.style.setProperty(name, value)
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(
      new CustomEvent('zhixing:motion', { detail: { level: state, enabled: state !== 'none' } })
    )
  }
  return state
}

/**
 * 一次应用全部「外观类」设置：主题（明暗 + 主题包 + 强调色）+ 字号 / 行高 / 控件高度 / 动效。
 *
 * 主窗口、设置页、桌面浮窗共用这一份实现——浮窗是独立渲染进程，只能自己
 * 从 settings 表读一遍；三处各写一遍就会在换包/改字号时互相漂移。
 *
 * 映射口径：设置值即像素值，
 * 此前 font_size+1.5 / task_row_height+10 的补偿偏移已取消（会与设置页 SpinBox、
 * 与共用 settings 表的显示值不一致）。
 */
/** 上一次应用过的「主题身份」：只有它变了才播主题切换过渡。 */
let lastThemeKey: string | null = null
let themeTimer: number | null = null

/**
 * 主题切换的颜色过渡窗口。
 *
 * 为什么不做成常驻 transition：常驻的全局颜色过渡会让滚动、输入与虚拟列表的每一帧
 * 都多算一遍过渡，而主题切换是低频操作 —— 只在切换后的这几百毫秒里开启。
 * 动效档位不是 full 时直接跳过：那种情况下切主题应当是瞬时的。
 */
function beginThemeTransition(root: HTMLElement): void {
  if (typeof window === 'undefined' || !('classList' in root)) return
  if (root.dataset.motion === 'reduced' || root.dataset.motion === 'none') return
  // 读**行内**的 --dur-normal（applyMotion 用 setProperty 写在 root.style 上），
  // 而不是 window.getComputedStyle(root)：后者会强制一次全量样式重算，
  // 而 applyAppearance 是在首屏（CSS 刚解析完、元素还没完成布局）被调用的 ——
  // 实测这一步足以把渲染主线程按死：CDP 的 Runtime.evaluate 直接超时、界面白屏，
  // 而主进程与渲染进程都不报任何错。行内读取不触发重算，语义仍是「跟随令牌」。
  const raw = root.style.getPropertyValue('--dur-normal').trim()
  const parsed = Number.parseFloat(raw)
  // 读不到就按 250ms（--dur-normal 的档位值）兜底：过渡窗口宁可略长，
  // 短于 CSS 那条过渡会让颜色在切换中途被硬切
  const ms = Number.isFinite(parsed) ? (raw.endsWith('ms') ? parsed : parsed * 1000) : 250
  root.classList.add('theme-transition')
  if (themeTimer !== null) window.clearTimeout(themeTimer)
  themeTimer = window.setTimeout(() => {
    root.classList.remove('theme-transition')
    themeTimer = null
  }, ms + 20)
}

export function applyAppearance(
  s: AppSettings,
  root: HTMLElement = document.documentElement
): void {
  const mode = resolveThemeMode(s.theme_mode)
  // 主题身份变了才播过渡：改字号 / 行高 / 控件高度不该触发它
  const themeKey = [mode, s.theme_pack, s.accent_color, s.theme_custom_light, s.theme_custom_dark].join('|')
  const themeChanged = lastThemeKey !== null && lastThemeKey !== themeKey
  if (themeChanged) beginThemeTransition(root)
  lastThemeKey = themeKey
  applyTheme(
    mode,
    s.theme_pack,
    s.accent_color,
    root,
    parseThemeOverrides(mode === 'dark' ? s.theme_custom_dark : s.theme_custom_light)
  )
  /**
   * 窗口内阴影的浓度由「窗口阴影」强度派生。
   * 50 对应 edge 16% / inner 9%（也就是原来的观感），0 就是完全没有轮廓与厚度。
   * 外投影在透明窗口上放不了（要么被窗口边界裁成直边，要么留出透明区露出方角），
   * 所以窗口的轮廓只能往内画 —— 这也是这个值值得做成可调的原因。
   */
  /**
   * edge 的系数：它是 1px 的细线，同样的百分比看着比面状阴影淡，所以给得比 inner 高；
   * 但它又必须是"若有若无"的收边，不能抢内容 —— 0.3 是这两者之间试出来的值
   *（0.5 在默认强度下偏重）。
   */
  root.style.setProperty('--shadow-edge', s.window_shadow * 0.3 + '%')
  root.style.setProperty('--shadow-inner', s.window_shadow * 0.18 + '%')
  // 「设置值 → CSS 像素」的映射只在这里一处；s.font_size 已是 number，不可能再被字符串拼接
  root.style.setProperty('--text-body', `${s.font_size}px`)
  root.style.setProperty('--row-h', `${s.task_row_height}px`)
  // control_height 的消费点：tokens.css 的 --control-h（任务行内控件等按它撑高）
  root.style.setProperty('--control-h', `${s.control_height}px`)
  // 玻璃拟态：只在关闭时写 off（开启时清掉属性，与 tokens.css 的默认值一致）
  if (s.glass_enabled) delete root.dataset.glass
  else root.dataset.glass = 'off'
  /**
   * 玻璃的三个参数写成中间变量，由 tokens.css 里的 --glass-filter / --glass-bg 引用。
   * 这样 JS 不必知道当前是亮色还是暗色 —— 两套基色留在样式表里各自适配。
   * 总开关关掉时不写：那时 data-glass='off' 已把整组令牌换成不透明值。
   */
  /**
   * 切完主题让主进程重新确认一次窗口透明（见 preload 里 reassertTransparency 的注释）。
   * 只在"主题身份真的变了"时调 —— 改字号、拖滑块都不需要惊动合成器。
   */
  // 测试环境（vitest 的 node 环境）里没有 window，所以先判存在性 ——
  // 同文件其他地方也是这个写法
  if (themeChanged && typeof window !== 'undefined') {
    void window.zhixing?.app?.reassertTransparency?.()
  }
  if (s.glass_enabled) {
    root.style.setProperty('--glass-blur', s.glass_blur + 'px')
    root.style.setProperty('--glass-alpha', s.glass_alpha + '%')
    root.style.setProperty('--glass-saturate', s.glass_saturate + '%')
  } else {
    root.style.removeProperty('--glass-blur')
    root.style.removeProperty('--glass-alpha')
    root.style.removeProperty('--glass-saturate')
  }
  // 树的路径跟踪虚线：同样是"关闭才写 off"，选择器统一挂 html[data-tree-guide]
  if (s.tree_guide) delete root.dataset.treeGuide
  else root.dataset.treeGuide = 'off'
  applyMotion(s.motion_level, root)
  // 切主题后强制刷新一次合成：Chromium 在没有新合成层时会复用上一帧，表现为侧边残留旧内容。
  // 用 transform 短暂建一个新层、下一帧撤掉 —— 比改窗口尺寸温和。单测跑在 node 环境里没有 rAF，故带守卫。
  root.style.transform = 'translateZ(0)'
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      root.style.transform = ''
    })
  } else {
    root.style.transform = ''
  }
}
