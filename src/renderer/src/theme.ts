/**
 * 主题应用（O8）：把主题包的 token 覆盖写入设计令牌变量。
 * 数据来自 shared/theme-packs.ts（由 Python 版 resources/themes/*.json 生成），
 * 所以新增主题包只需加数据，不用改这里的代码。
 */
import { resolveThemePack, type ThemeColors } from '@shared/theme-packs'
import { ensureTextContrast } from '@shared/color'
import type { AppSettings, ThemeMode } from '@shared/settings'

/** theme_mode 为 system 时按系统明暗解析成实际模式（对齐 app_controller 的 styleHints 取值）。 */
export function resolveThemeMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode
  // 非浏览器环境（node 下的单测）没有 matchMedia，按浅色处理
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** 主题包 token → 设计令牌变量（一个 token 可能喂多个变量）。 */
const TOKEN_VARS: Record<keyof ThemeColors, string[]> = {
  canvas: ['--bg-canvas'],
  layer: ['--bg-layer', '--bg-layer-solid'],
  hover: ['--bg-hover'],
  hover2: ['--bg-pressed'],
  fg: ['--fg-primary'],
  fg2: ['--fg-secondary'],
  fg3: ['--fg-tertiary'],
  border: ['--border'],
  border2: ['--border-strong'],
  input: ['--bg-input'],
  scroll: ['--scroll-thumb'],
  accent_soft: ['--accent-soft'],
  warm: ['--accent-warm'],
  danger: ['--danger'],
  success: ['--success'],
}

/**
 * 应用主题：先铺主题包的语义色，再单独写入强调色。
 * 强调色与主题包正交（与 Python 版一致）——换主题包不会改掉你选的强调色。
 */
export function applyTheme(
  mode: 'light' | 'dark',
  packName: string,
  accentColor: string,
  root: HTMLElement = document.documentElement
): void {
  const pack = resolveThemePack(packName)
  const colors: ThemeColors = { ...(mode === 'dark' ? pack.dark : pack.light) }
  // 主题包的文字色是按观感调的柔和色，对 canvas / layer 的对比度大量落在 4.5 以下
  // （实测 168 组里 74 组不达标）。这里按与 Python 版同一套下限做校正：
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
    ensureTextContrast(accentColor, [...surfaces, colors.accent_soft], 4.5)
  )
  // R4：强调底上的文字不再恒为白 —— 浅强调色（如 #FDE047）上白字只有约 1.3:1。
  // 与上面同一套 ensureTextContrast：从白起步，浅底压暗到 4.5:1，深底保持白。
  root.style.setProperty('--fg-on-accent', ensureTextContrast('#ffffff', [accentColor], 4.5))
  root.dataset.theme = mode
}

/** 动效档位：full=完整、reduced=仅必要、none=关闭（对齐 Python 的 reduce-motion 语义）。 */
export type MotionState = 'full' | 'reduced' | 'none'

/**
 * OS 级「减少动态效果」探测（对齐 Python app_controller._os_reduce_motion）。
 *
 * Python 走 NSWorkspace / SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION)；
 * Chromium 已把同一个系统开关映射到 CSS 的 prefers-reduced-motion，渲染层直接读即可，
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
 * 映射口径与 Python app_controller._apply_theme 一致：设置值即像素值，
 * 此前 font_size+1.5 / task_row_height+10 的补偿偏移已取消（会与设置页 SpinBox、
 * 与共用 settings 表的 Python 版显示值不一致）。
 */
export function applyAppearance(
  s: AppSettings,
  root: HTMLElement = document.documentElement
): void {
  applyTheme(resolveThemeMode(s.theme_mode), s.theme_pack, s.accent_color, root)
  // 「设置值 → CSS 像素」的映射只在这里一处；s.font_size 已是 number，不可能再被字符串拼接
  root.style.setProperty('--text-body', `${s.font_size}px`)
  root.style.setProperty('--row-h', `${s.task_row_height}px`)
  // control_height 的消费点：tokens.css 的 --control-h（任务行内控件等按它撑高）
  root.style.setProperty('--control-h', `${s.control_height}px`)
  applyMotion(s.motion_level, root)
}
