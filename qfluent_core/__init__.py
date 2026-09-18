# -*- coding: utf-8 -*-
"""qfluent_core —— 可独立使用的 PySide6 UI 框架层（零业务依赖）。

分层（解耦契约 §1）::

    qfluent_core            UI 框架层：皮肤/绘制/动画/基础信号/纯 UI 状态
    └── theme.py            ThemeManager：语义 token -> QSS 模板渲染 + 变更广播
    └── settings.py         UISettings：主题/字号/控件高度/圆角/动效开关 + 变更信号
    └── motion.py           动画工厂与全局动效开关
    └── window.py           FluentTemplateWindow：无边框窗口壳 + 自绘标题栏 + 侧边导航
    └── resources/qss/      *.qss 皮肤模板（$token 占位符）

业务组合层（外壳）留在宿主项目中：导入本包的窗口/控件，用 Signal 连接业务函数。

最小用法::

    from qfluent_core import FluentTemplateWindow, UISettings, ThemeManager

    w = FluentTemplateWindow(None, "我的应用", command_placeholder=" 搜索… ")
    w.add_page(my_widget, "首页", icon=my_icon)
    w.commandRequested.connect(open_command_palette)     # 框架信号 -> 业务函数
    w.show()
"""
from __future__ import annotations

from .material import (MATERIAL_LABELS, MATERIALS, apply_window_material,
                       effective_material, platform_support)
from .components import (KINDS, SIZES, TONES, UAlert, UAvatar, UBadge,
                        UActionCard, UBottomBar, UCollapseCard, UFilterChips,
                        UFlipCard, UMaskedInput, UProgressCard, USwipeConfirm,
                        UTabStrip, UBreadcrumb,
                        UButton, UCard, UCheckbox, UColorSwatch,
                        UComboBox, UConfirmDialog, UConsole, UDataTable,
                        UDatePicker, UDialog, UDivider, UDropdown,
                        UEmptyState, UExpander, UField, UIconButton,
                        UImageCompare, UInfoBar, ULineEdit, UMenu,
                        UMultiComboBox, UPageHeader, UPagination,
                        UProgressBar, UProgressRing, USearchBox,
                        USegmentedControl, USkeleton, USlider, UStatusPill,
                        UTable, UTabs, UTitle, UToggleSwitch, UTopbar,
                        UUpload, ThemedMixin, apply_skin, tone_color,
                        tone_soft, USettingsPanel,
                        URadioButton,
                        USpinBox,
                        UTextEdit,
                        UList,
                        UToast,
                        DialogType,
                        UInputDialog,
                        USpinner,)
from .motion import (DURATION, EASING, animate, animate_value, bind_settings,
                     fade_in, motion_enabled, set_motion_enabled)
from .settings import DEFAULTS, K, RANGES, UISettings, clamp
from . import icons
from .theme import (BUILTIN_PACKS, DARK_TOKENS, LIGHT_TOKENS, QSS_DIR,
                    ThemeManager, ThemePack, control_tokens, radius_tokens)
from .window import (FluentTemplateWindow, NavButton, NavPage, NavPanel,
                     TitleBar)

__version__ = "0.1.0"

__all__ = [
    # 窗口壳
    "FluentTemplateWindow", "TitleBar", "NavPanel", "NavButton", "NavPage",
    # 组件库
    "ThemedMixin", "apply_skin", "tone_color", "tone_soft", "TONES", "KINDS", "SIZES",
    "UTitle", "UButton", "UIconButton", "UToggleSwitch", "USegmentedControl",
    "UColorSwatch",
    "UAlert",
    "UAvatar",
    "UBreadcrumb",
    "DialogType",
    "UInputDialog",
    "USpinner", "UList", "UToast",
    "UTextEdit",
    "USpinBox",
    "URadioButton",
    "UTabStrip",
    "USettingsPanel",
    "UCollapseCard", "UFlipCard", "USwipeConfirm", "UActionCard",
    "UFilterChips", "UProgressCard", "UBottomBar", "UMaskedInput",
    "UCheckbox",
    "UComboBox",
    "UConsole",
    "UDataTable",
    "UDatePicker",
    "UDropdown",
    "UImageCompare",
    "UMenu",
    "UMultiComboBox",
    "UPagination",
    "USlider",
    "UTable",
    "UTabs",
    "UTopbar",
    "UUpload",
    "MATERIALS", "MATERIAL_LABELS", "platform_support", "effective_material",
    "apply_window_material",
    "ULineEdit", "USearchBox",
    "UCard", "UDivider", "UExpander", "UPageHeader", "UField",
    "UStatusPill", "UBadge", "UInfoBar", "UProgressBar", "UProgressRing",
    "UEmptyState", "USkeleton", "UDialog", "UConfirmDialog",
    # 主题
    "ThemeManager", "ThemePack", "BUILTIN_PACKS", "radius_tokens", "control_tokens",
    "LIGHT_TOKENS", "DARK_TOKENS", "QSS_DIR",
    # 配置
    "UISettings", "K", "DEFAULTS", "RANGES", "clamp",
    # 动效
    "motion_enabled", "set_motion_enabled", "bind_settings",
    "animate", "animate_value", "fade_in", "DURATION", "EASING",
    "__version__",
]
