# -*- coding: utf-8 -*-
"""zhixing UI 统一入口：业务代码只从这里取组件。

迁移约定（本项目的硬约束）：

1. 业务层（view/pages、view/components、view/capture …）**不再直接 import**
   PySide6.QtWidgets 里的可见组件；需要用组件时，一律从本模块取；
2. 本模块的组件全部来自 qfluent_core，外观与主题由框架模板渲染，
   业务代码里不该出现任何色值、字号、圆角、px；
3. 尚未迁移完的旧代码仍可用原生组件（框架模板按原生类选择器写的，
   所以它们同样会被统一皮肤覆盖），但数量只许减少 —— 由
   tests/test_zhixing_migration.py 的看板守住。

对照表见 NATIVE_MAP；迁移时按它替换 import 即可。
"""
from __future__ import annotations

from qfluent_core import (
    K, MATERIAL_LABELS, MATERIALS, FluentTemplateWindow, ThemeManager, UISettings,
    UActionCard, UAlert, UAvatar, UBadge, UBottomBar, UButton, UCard, UCheckbox,
    UCollapseCard, UColorSwatch, UComboBox, UConfirmDialog, UConsole, UDataTable,
    UDatePicker, UDialog, UDivider, UDropdown, UEmptyState, UExpander, UField,
    UFilterChips, UFlipCard, UIconButton, UImageCompare, UInfoBar, ULineEdit,
    UMaskedInput, UMenu, UMultiComboBox, UPageHeader, UPagination, UProgressBar,
    UProgressCard, UProgressRing, USearchBox, USegmentedControl, USettingsPanel,
    USkeleton, USlider, UStatusPill, USwipeConfirm, UTable, UTabStrip, UTabs,
    UTitle, UToggleSwitch, UTopbar, UUpload,
)

__all__ = [
    "K", "MATERIAL_LABELS", "MATERIALS", "FluentTemplateWindow", "ThemeManager",
    "UISettings",
    "UActionCard", "UAlert", "UAvatar", "UBadge", "UBottomBar", "UButton", "UCard",
    "UCheckbox", "UCollapseCard", "UColorSwatch", "UComboBox", "UConfirmDialog",
    "UConsole", "UDataTable", "UDatePicker", "UDialog", "UDivider", "UDropdown",
    "UEmptyState", "UExpander", "UField", "UFilterChips", "UFlipCard",
    "UIconButton", "UImageCompare", "UInfoBar", "ULineEdit", "UMaskedInput",
    "UMenu", "UMultiComboBox", "UPageHeader", "UPagination", "UProgressBar",
    "UProgressCard", "UProgressRing", "USearchBox", "USegmentedControl",
    "USettingsPanel", "USkeleton", "USlider", "UStatusPill", "USwipeConfirm",
    "UTable", "UTabStrip", "UTabs", "UTitle", "UToggleSwitch", "UTopbar",
    "UUpload",
    "NATIVE_MAP",
]

#: 原生组件 -> 框架组件（迁移清单；容器类保留原生）
NATIVE_MAP = {
    "QLabel": "UTitle / UStatusPill / UBadge",
    "QPushButton": "UButton",
    "QToolButton": "UButton(icon_only) / UIconButton",
    "QLineEdit": "ULineEdit / USearchBox",
    "QTextEdit / QPlainTextEdit": "待补 UTextEdit",
    "QCheckBox": "UCheckbox",
    "QRadioButton": "UCheckbox(tone=accent)",
    "QComboBox": "UComboBox / UMultiComboBox",
    "QSlider": "USlider",
    "QSpinBox / QDoubleSpinBox": "待补 USpinBox",
    "QDateEdit / QDateTimeEdit": "UDatePicker",
    "QProgressBar": "UProgressBar / UProgressRing",
    "QListWidget": "UTable / UDataTable",
    "QTreeWidget": "待补 UTree",
    "QTableWidget": "UTable / UDataTable",
    "QTabWidget": "UTabs / UTabStrip",
    "QGroupBox": "UCard / UExpander",
    "QDialog": "UDialog / UConfirmDialog",
    "QMenu": "UMenu / UDropdown",
    "QScrollArea": "按需保留（滚动容器）",
    "QSplitter": "按需保留（分割容器）",
    "QFrame": "UCard / UCcollapseCard / 自绘基类",
    "QWidget": "按需保留（自定义组件的基类）",
}
