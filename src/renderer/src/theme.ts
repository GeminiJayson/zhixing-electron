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
  root.dataset.theme = mode
}

/**
 * 一次应用全部「外观类」设置：主题（明暗 + 主题包 + 强调色）+ 字号 / 行高 / 动效。
 *
 * 主窗口、设置页、桌面浮窗共用这一份实现——浮窗是独立渲染进程，只能自己
 * 从 settings 表读一遍；三处各写一遍就会在换包/改字号时互相漂移。
 */
export function applyAppearance(
  s: AppSettings,
  root: HTMLElement = document.documentElement
): void {
  applyTheme(resolveThemeMode(s.theme_mode), s.theme_pack, s.accent_color, root)
  // 「设置值 → CSS 像素」的映射只在这里一处；s.font_size 已是 number，不可能再被字符串拼接
  root.style.setProperty('--text-body', `${s.font_size + 1.5}px`)
  root.style.setProperty('--row-h', `${s.task_row_height + 10}px`)
  root.dataset.motion = s.motion_level === 'none' ? 'none' : ''
}
