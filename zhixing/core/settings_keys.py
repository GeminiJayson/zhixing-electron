# -*- coding: utf-8 -*-
"""设置键名集中 re-export（供 UI / Controller / core 统一引用）。

常量真源在 core/constants；历史上一度反向依赖 model/application/settings
（core→model 反依赖）。现改为指向叶子模块，方向回归规范化。
"""
from ..core.constants import (  # noqa: F401 —— re-export 给外部稳定的入口
    K_ACCENT, K_AUTO_START, K_AUTO_START_BREAK, K_CALENDAR_SHOW_DONE, K_CAPTURE_HOTKEY,
    K_CLIPBOARD_MONITOR, K_CLOSE_TO_WIDGET, K_CONTROL_HEIGHT, K_FONT_SIZE,
    K_MICA, K_MOTION, K_POMO_BREAK, K_POMO_FOCUS, K_QUICK_HOTKEY,
    K_RECYCLE_RETENTION, K_REMINDER_ENABLED, K_SCHEMA, K_SIGNATURE,
    K_TASK_INDENT, K_TASK_ROW_HEIGHT, K_THEME_MODE, K_THEME_PACK, K_UI_STATE,
    K_WIDGET_CLICK_THROUGH, K_WIDGET_EDGE, K_WIDGET_ENABLED, K_WIDGET_GEOM,
    K_WIDGET_HOTKEY, K_WIDGET_OPACITY,
)
# 「读取选中并速记」全局热键键名（默认 ctrl+shift+u）。
# 本次为最小改动落地在本文件（真源在 core/constants，避免并行改动该文件）；
# 合并时可把本常量上移至 core/constants 再走 re-export。K_K_SELECT_HOTKEY
# 是需求文档写法的兼容别名，供并行改动方引用。
K_SELECT_HOTKEY = "select_quick_hotkey"
K_K_SELECT_HOTKEY = K_SELECT_HOTKEY
