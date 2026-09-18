# -*- coding: utf-8 -*-
"""组件层转发（原 zhixing 自建组件已并入 qfluent_core）。

这里**不再定义任何组件**：原先的 widgets.py / dialog.py / _util.py（共 1066 行）
已随「框架统一」删除，本模块只做名字转发，保证既有 import 继续可用。

新代码请直接从 qfluent_core 导入；这个转发层只为迁移期兼容而留。
"""
from __future__ import annotations

from qfluent_core import (
    UButton, UCard, UDialog, UInputDialog, UPageHeader, USkeleton, USpinner,
    UStatusPill, UTitle,
)
from qfluent_core.components.dialogs import (
    COMPACT_TITLE_BAR_H, DialogType, MIN_H, RESIZE_MARGIN, TITLE_BAR_H,
)

#: 旧名 -> 框架名（名字不同、但语义一致的几个）
Skeleton = USkeleton
PageHeader = UPageHeader
BusySpinner = USpinner

__all__ = [
    "UButton", "UCard", "UStatusPill", "UTitle", "Skeleton", "BusySpinner",
    "PageHeader", "DialogType", "RESIZE_MARGIN", "TITLE_BAR_H",
    "COMPACT_TITLE_BAR_H", "MIN_H", "UDialog", "UInputDialog",
]
