# -*- coding: utf-8 -*-
"""应用级配置键名（真源）. 叶子模块：允许被 core / model / view / controller 引用，
方向永远是 child.service/data → 本模块，不许反向（历史：曾由 model/application/settings
持有并从 core 反引，产生 core→model 反向依赖）。
"""
# 键（对应 settings 表的字符串键）
K_SCHEMA = "schema_version"
K_THEME_MODE = "theme_mode"            # light/dark/system
K_THEME_PACK = "theme_pack"            # 主题包名
K_ACCENT = "accent_color"              # hex
K_MICA = "mica_enabled"
K_MOTION = "motion_level"              # full/reduced
K_POMO_FOCUS = "pomodoro_focus_min"
K_POMO_BREAK = "pomodoro_break_min"
K_AUTO_START_BREAK = "pomodoro_auto_break"
K_REMINDER_ENABLED = "reminder_enabled"
K_CAPTURE_HOTKEY = "capture_hotkey"
K_QUICK_HOTKEY = "quick_capture_hotkey"
K_WIDGET_HOTKEY = "widget_hotkey"
K_WIDGET_ENABLED = "widget_enabled"
K_WIDGET_OPACITY = "widget_opacity"
K_WIDGET_GEOM = "widget_geometry"
K_WIDGET_EDGE = "widget_edge_hidden"
K_CLOSE_TO_WIDGET = "close_to_widget"
K_UI_STATE = "ui_state"                # JSON：展开状态、当前页、捕获默认目标等
K_TASK_ROW_HEIGHT = "task_row_height"  # 任务树单行高度（px）
K_TASK_INDENT = "task_indent"          # 任务树每级缩进（px）
K_CALENDAR_SHOW_DONE = "calendar_show_done"  # 日历是否显示已完成任务（默认 False）
K_CONTROL_HEIGHT = "control_height"    # 全局控件高度（px）
K_FONT_SIZE = "font_size"              # 全局字号（px）
K_SIGNATURE = "signature"              # 标题栏右侧签名（用户自定义）

# 全局字号/控件高度可调范围（设置页 SpinBox 与运行时校验共用的真源）。
# ⑤ 字号设置项下限从 12 放宽到 9。
FONT_SIZE_MIN = 9
FONT_SIZE_MAX = 20
CONTROL_HEIGHT_MIN = 24
CONTROL_HEIGHT_MAX = 48
K_CLIPBOARD_MONITOR = "clipboard_monitor"   # 剪贴板监听开关（默认关，F11-7）
K_AUTO_START = "autostart_enabled"          # 开机自启（默认关，F9-5）
K_WIDGET_CLICK_THROUGH = "widget_click_through"  # 浮窗鼠标穿透（默认关，F10-6）
K_RECYCLE_RETENTION = "recycle_retention_days"   # 回收站保留天数（默认 30）
