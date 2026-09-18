# -*- coding: utf-8 -*-
"""qfluent_core 组件库：语义组件 + 全 token 皮肤 + 主题/配置自愈。

组件只有「外观 + 交互状态」，不含业务语义；变体用 tone/kind/size 表达，
皮肤由 resources/qss/components.qss 承担，组件代码里不出现任何色值与字号。
"""
from __future__ import annotations

from .actions import (UButton, UColorSwatch, UIconButton, USegmentedControl,
                      UToggleSwitch)
from .base import (KINDS, SIZES, TONES, ThemedMixin, apply_skin, tone_color,
                   tone_soft)
from .data import (UAvatar, UConsole, UDataTable, UImageCompare, UList,
                    UTable, UToast)
from .dialogs import (DialogType, UConfirmDialog, UDialog,
                      UInputDialog, USpinner)
from .feedback import UAlert
from .forms import (UCheckbox, UComboBox, UDatePicker, UMultiComboBox, URadioButton,
                    USlider, USpinBox,
                    UUpload)
from .inputs import ULineEdit, USearchBox, UTextEdit
from .interactive import (
    UActionCard, UBottomBar, UCollapseCard, UFilterChips, UFlipCard,
    UMaskedInput, UProgressCard, USwipeConfirm)
from .navigation import (UBreadcrumb, UDropdown, UMenu, UPagination, UTabStrip,
                         UTabs, UTopbar)
from .status import (UBadge, UEmptyState, UInfoBar, UProgressBar, UProgressRing,
                     USkeleton, UStatusPill)
from .surfaces import UCard, UDivider, UExpander, UField, UPageHeader
from .settings_panel import USettingsPanel
from .text import ROLES, UTitle

__all__ = [
    # 底座
    "UTextEdit",
    "USpinBox",
    "URadioButton",
    "ThemedMixin", "apply_skin", "tone_color", "tone_soft", "TONES", "KINDS", "SIZES",
    # 文字
    "UTitle", "ROLES",
    # 动作
    "UButton", "UIconButton", "UToggleSwitch", "USegmentedControl", "UColorSwatch",
    # 输入（表单）
    "ULineEdit", "USearchBox", "UCheckbox", "USlider", "UComboBox",
    "UMultiComboBox", "UDatePicker", "UUpload",
    # 数据展示
    "UAvatar", "UList", "UToast", "UTable", "UDataTable", "UImageCompare", "UConsole",
    # 导航
    "UMenu", "UTopbar", "UBreadcrumb", "UTabs", "UTabStrip", "UPagination",
    "UDropdown",
    # 交互动效
    "USettingsPanel",
    "UCollapseCard", "UFlipCard", "USwipeConfirm", "UActionCard",
    "UFilterChips", "UProgressCard", "UBottomBar", "UMaskedInput",
    # 反馈
    "UAlert",
    # 容器
    "UCard", "UDivider", "UExpander", "UPageHeader", "UField",
    # 状态
    "UStatusPill", "UBadge", "UInfoBar", "UProgressBar", "UProgressRing",
    "UEmptyState", "USkeleton",
    # 浮层
    "UDialog", "UConfirmDialog",
]
