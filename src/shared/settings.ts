/**
 * settings 表的类型层：所有读取都经过这里，把「字符串 KV」转成有类型的值。
 *
 * 起因：启动时应用字号曾写成 `${s.font_size + 1.5}`，而 settings 读出来是字符串，
 * "12" + 1.5 被拼成 "121.5"，整屏被撑大。把字符串→数值的转换集中到这一层后，
 * 调用方拿到的就是 number/boolean，这类拼接错误在类型层已不可能发生。
 */

export type ThemeMode = 'light' | 'dark' | 'system'
export type MotionLevel = 'full' | 'essential' | 'none'

/**
 * 窗口背景材质（Windows 11）。mica / acrylic / tabbed 是 Electron 支持的全部半透明材质，
 * none 表示普通不透明窗口。macOS 的 vibrancy 刻意不进枚举 —— 列给 Windows 用户
 * 只会得到一个必然无效的选项。
 */
export const WINDOW_MATERIALS = ['mica', 'acrylic', 'tabbed', 'none'] as const
export type WindowMaterial = (typeof WINDOW_MATERIALS)[number]

export interface AppSettings {
  theme_mode: ThemeMode
  theme_pack: string
  accent_color: string
  font_size: number
  task_row_height: number
  task_indent: number
  control_height: number
  motion_level: MotionLevel
  pomodoro_focus_min: number
  pomodoro_break_min: number
  pomodoro_auto_break: boolean
  reminder_enabled: boolean
  calendar_show_done: boolean
  recycle_retention_days: number
  widget_enabled: boolean
  widget_opacity: number
  widget_click_through: boolean
  widget_hotkey: string
  /** 关闭主窗口时最小化到托盘/浮窗而不是退出（对齐 Python 的 close_to_widget） */
  close_to_widget: boolean
  /** 开机自启（对齐 autostart） */
  autostart_enabled: boolean
  /** 剪贴板监听：复制后提示可快速捕获 */
  clipboard_monitor: boolean
  /** 划词速记热键（读取当前选中文字预填快速捕获） */
  select_quick_hotkey: string
  /** 标题栏签名文案 */
  signature: string
  /**
   * 窗口背景材质（旧 mica_enabled 的迁移目标）。这里只存「用户意图」，
   * 真正能否生效由主进程按平台/系统版本判定，不支持时降级为 none。
   */
  material: WindowMaterial
  quick_capture_hotkey: string
  capture_hotkey: string
  /** ui_state 是嵌套 JSON，这里保持原始字符串，由需要的一方自行解析 */
  ui_state: string
}

const num = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  // 注意：Number('') === 0，空串必须显式当成「没配」而不是 0，
  // 否则会被钳到下限（历史上就被这条坑过）。
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 历史值可能缺失或为空串，两者都回退到默认值。 */
const bool = (raw: string | undefined, fallback: boolean): boolean =>
  raw === undefined || raw === '' ? fallback : raw !== '0'

const str = (raw: string | undefined, fallback: string): string =>
  raw === undefined || raw === '' ? fallback : raw

const oneOf = <T extends string>(raw: string | undefined, values: readonly T[], fallback: T): T =>
  values.includes(raw as T) ? (raw as T) : fallback

const MOTION_LEVELS = ['full', 'essential', 'none'] as const

/** 默认沿用旧 mica_enabled 的默认 true，老库升级后外观不会突然变。 */
const DEFAULT_MATERIAL: WindowMaterial = 'mica'

/**
 * mica_enabled（boolean）→ material（枚举）的向后兼容解析。
 *
 * 先看新键，新键缺失或为空才回退旧键：true → mica、false → none（与 bool() 同规则，
 * '0'/'' 视为 false）。非法值钳到默认，避免手改库或被别的客户端写入脏值后材质乱跳。
 */
const parseMaterial = (raw: Record<string, string>): WindowMaterial => {
  const direct = raw.material
  if (direct !== undefined && direct !== '') return oneOf(direct, WINDOW_MATERIALS, DEFAULT_MATERIAL)
  const legacy = raw.mica_enabled
  if (legacy === undefined || legacy === '') return DEFAULT_MATERIAL
  return legacy === '0' ? 'none' : 'mica'
}

/** 原始设置表 → 类型化设置。所有默认值与取值范围都集中在这里。 */
export function parseSettings(raw: Record<string, string> = {}): AppSettings {
  return {
    // theme_mode 与 Python 一致地支持 system；非法值回退到 Python 的默认 system。
    theme_mode: raw.theme_mode === 'dark' ? 'dark' : raw.theme_mode === 'light' ? 'light' : 'system',
    theme_pack: str(raw.theme_pack, '青竹'),
    accent_color: str(raw.accent_color, '#0D9488'),
    // 默认值与范围逐项对齐 Python：core/constants.py 的 FONT_SIZE_/CONTROL_HEIGHT_ 常量
    // 与 settings_page.py 的 setRange。两版共用同一张 settings 表，默认值不一致会让
    // 来回切换客户端时行为跳变。
    font_size: num(raw.font_size, 14, 9, 20),
    task_row_height: num(raw.task_row_height, 38, 24, 72),
    task_indent: num(raw.task_indent, 20, 8, 48),
    control_height: num(raw.control_height, 32, 24, 48),
    motion_level: oneOf(raw.motion_level, MOTION_LEVELS, 'full'),
    pomodoro_focus_min: num(raw.pomodoro_focus_min, 25, 5, 90),
    pomodoro_break_min: num(raw.pomodoro_break_min, 5, 1, 30),
    pomodoro_auto_break: bool(raw.pomodoro_auto_break, false),
    reminder_enabled: bool(raw.reminder_enabled, true),
    calendar_show_done: bool(raw.calendar_show_done, false),
    recycle_retention_days: num(raw.recycle_retention_days, 30, 1, 365),
    widget_enabled: bool(raw.widget_enabled, true),
    widget_opacity: num(raw.widget_opacity, 85, 60, 100),
    widget_click_through: bool(raw.widget_click_through, false),
    close_to_widget: bool(raw.close_to_widget, true),
    autostart_enabled: bool(raw.autostart_enabled, false),
    clipboard_monitor: bool(raw.clipboard_monitor, false),
    select_quick_hotkey: str(raw.select_quick_hotkey, 'ctrl+shift+u'),
    signature: str(raw.signature, '知行合一'),
    material: parseMaterial(raw),
    widget_hotkey: str(raw.widget_hotkey, 'ctrl+shift+d'),
    quick_capture_hotkey: str(raw.quick_capture_hotkey, 'ctrl+alt+n'),
    capture_hotkey: str(raw.capture_hotkey, 'ctrl+shift+s'),
    ui_state: str(raw.ui_state, '{}'),
  }
}

/**
 * 启动时写入 settings 表的默认值，逐项对齐 Python 的 ensure_defaults
 * （zhixing/model/application/settings.py:77-95）。
 *
 * 此前 Electron 只在内存里回退默认值、从不落库，于是同一个库被两个客户端
 * 先后打开时会各自回退到不同默认（主题包、字号、行高、自动休息、捕获热键），
 * 表现为「行为跳变且难以归因」。
 */
export const DEFAULT_SETTINGS: Record<string, string> = {
  theme_mode: 'system',
  theme_pack: '青竹',
  accent_color: '#0D9488',
  // 这里故意只留旧键、不写新的 material：ensureDefaultSettings 是 ON CONFLICT DO NOTHING，
  // 老库里 material 本就不存在，一旦补进默认值 'mica' 会盖掉老用户「关掉材质」
  // （mica_enabled='0'）的偏好。新键缺失时 parseMaterial 会回退读旧键，默认值照样生效。
  mica_enabled: '1',
  motion_level: 'full',
  pomodoro_focus_min: '25',
  pomodoro_break_min: '5',
  reminder_enabled: '1',
  capture_hotkey: 'ctrl+shift+s',
  quick_capture_hotkey: 'ctrl+alt+n',
  widget_hotkey: 'ctrl+shift+d',
  widget_enabled: '1',
  widget_opacity: '85',
  close_to_widget: '1',
  clipboard_monitor: '0',
  autostart_enabled: '0',
  widget_click_through: '0',
  recycle_retention_days: '30',
  signature: '知行合一',
}

/** 写回 settings 表时的字符串化（与 parseSettings 对称）。 */
export const serializeSetting = {
  bool: (value: boolean): string => (value ? '1' : '0'),
  num: (value: number): string => String(value),
  str: (value: string): string => value,
}
