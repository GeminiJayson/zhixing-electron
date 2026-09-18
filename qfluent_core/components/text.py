# -*- coding: utf-8 -*-
"""文字层级组件：一个控件表达 role，不让每条标签各自设字号与颜色。"""
from __future__ import annotations

from typing import Optional

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QLabel, QSizePolicy, QWidget

from ..settings import UISettings
from ..theme import ThemeManager
from .base import ThemedMixin

__all__ = ["UTitle"]

#: 一个表面最多用到 title / body / caption 三个角色（Fluent 排版克制原则）
ROLES = ("title", "subtitle", "body", "caption", "muted")


class UTitle(ThemedMixin, QLabel):
    """语义文字。role: title | subtitle | body | caption | muted。

    字号与颜色全部来自 token（并随 UISettings 的字号设置实时变化）。
    """

    def __init__(self, text: str = "", role: str = "body",
                 parent: Optional[QWidget] = None, *,
                 wrap: bool = False, elide: bool = False,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(text, parent)
        self.setObjectName("UTitle")
        self.setProperty("role", role if role in ROLES else "body")
        self.setWordWrap(wrap)
        if wrap:
            # 换行标签必须允许被压缩：默认的水平策略会坚持按「不换行时的文本宽度」
            # 参与布局，于是在窄容器里它会顶破父级（表现为文字画到卡片边框之外）。
            self.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
            self.setMinimumWidth(0)
        self.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        if elide:
            self.setTextInteractionFlags(Qt.NoTextInteraction)
        self._init_theme(settings, theme)

    def set_role(self, role: str) -> None:
        self._set_variant("role", role, ROLES)
