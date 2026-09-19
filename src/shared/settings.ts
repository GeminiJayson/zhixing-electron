/**
 * settings 表的类型层：所有读取都经过这里，把「字符串 KV」转成有类型的值。
 *
 * 起因：启动时应用字号曾写成 `${s.font_size + 1.5}`，而 settings 读出来是字符串，
 * "12" + 1.5 被拼成 "121.5"，整屏被撑大。把字符串→数值的转换集中到这一层后，
 * 调用方拿到的就是 number/boolean，这类拼接错误在类型层已不可能发生。
 */

import { AI_DEFAULT_TIMEOUT_SEC, normalizeAiProtocol, type AiProtocol } from './ai-note'

export type ThemeMode = 'light' | 'dark' | 'system'
export type MotionLevel = 'full' | 'essential' | 'none'

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
  quick_capture_hotkey: string
  capture_hotkey: string
  /** ui_state 是嵌套 JSON，这里保持原始字符串，由需要的一方自行解析 */
  ui_state: string
  /** 笔记「大模型整理」的配置，详见 shared/ai-note.ts */
  ai_base_url: string
  ai_api_key: string
  ai_protocol: AiProtocol
  ai_model: string
  /** 单篇整理提示词模板（可编辑）；为空时主进程回落到 DEFAULT_AI_PROMPT */
  ai_prompt: string
  /** 整库整理提示词；为空表示「跟单篇用同一份」 */
  ai_library_prompt: string
  ai_timeout_sec: number
  /** 外部任务接口：GET 这个地址，把返回的 JSON 同步成本地任务 */
  task_api_url: string
  task_api_key: string
  /** 开启后按间隔自动同步（关掉只留手动「立即同步」） */
  task_api_enabled: boolean
  task_api_interval_min: number
  /** 拉回来的任务落到哪个清单；null = 收件箱 */
  task_api_list_id: number | null
  /** 任务数组所在的 JSON 路径，如 data.items；空 = 自动探测 */
  task_api_rows_path: string
  /** 字段映射（JSON：字段 → JSON 路径），空 = 按候选字段名自动识别 */
  task_api_map: string
  /** 按标题与本地任务去重：命中就认领那条任务，不再新建 */
  task_api_dedupe: boolean
  /** 上次同步时间 / 结果（运行时写入，用于设置页展示） */
  task_api_last_at: string
  task_api_last_result: string
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
    widget_hotkey: str(raw.widget_hotkey, 'ctrl+shift+d'),
    quick_capture_hotkey: str(raw.quick_capture_hotkey, 'ctrl+alt+n'),
    capture_hotkey: str(raw.capture_hotkey, 'ctrl+shift+s'),
    ui_state: str(raw.ui_state, '{}'),
    // AI 整理：默认「没配」——地址/Key/模型都留空，界面据此提示先去设置里填。
    // 这几项不进 DEFAULT_SETTINGS：它们是本应用私有的键，没必要写进与 Python 共用的默认集合。
    ai_base_url: (raw.ai_base_url ?? '').trim(),
    ai_api_key: (raw.ai_api_key ?? '').trim(),
    ai_protocol: normalizeAiProtocol(raw.ai_protocol),
    ai_model: (raw.ai_model ?? '').trim(),
    ai_prompt: raw.ai_prompt ?? '',
    ai_library_prompt: raw.ai_library_prompt ?? '',
    ai_timeout_sec: num(raw.ai_timeout_sec, AI_DEFAULT_TIMEOUT_SEC, 10, 600),
    task_api_url: (raw.task_api_url ?? '').trim(),
    task_api_key: (raw.task_api_key ?? '').trim(),
    task_api_enabled: bool(raw.task_api_enabled, false),
    task_api_interval_min: num(raw.task_api_interval_min, 30, 5, 1440),
    task_api_list_id: numOrNull(raw.task_api_list_id),
    task_api_rows_path: (raw.task_api_rows_path ?? '').trim(),
    task_api_map: raw.task_api_map ?? '',
    task_api_dedupe: bool(raw.task_api_dedupe, true),
    task_api_last_at: raw.task_api_last_at ?? '',
    task_api_last_result: raw.task_api_last_result ?? '',
  }
}

/** 可空数字：空串 / 非数字都当「没选」。 */
function numOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
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
