# -*- coding: utf-8 -*-
"""反馈类组件：警告提示（带标题的多行提示）。

与 UInfoBar 的分工：UInfoBar 是一行状态条（轻、常驻）；UAlert 带图标与标题，
用于需要解释原因或给出后续动作的提示。两者共用同一套语义 tone。
"""
from __future__ import annotations

from typing import Callable, Optional

from PySide6.QtCore import Qt, Signal, QSize
from PySide6.QtWidgets import (
    QFrame, QHBoxLayout, QLabel, QToolButton, QVBoxLayout, QWidget,
)

from .. import icons
from ..settings import UISettings
from ..theme import ThemeManager
from .actions import UButton
from .base import TONES, ThemedMixin, center_label, token_px

__all__ = ["UAlert"]

_ALERT_TONES = ("info", "success", "warn", "danger", "standard")
_ICON_NAMES = {"info": "info", "success": "success", "warn": "warning", "danger": "error",
          "standard": "\u00b7"}


class UAlert(ThemedMixin, QFrame):
    """警告提示：图标 + 标题 + 正文 + 可选动作 + 关闭。"""

    closed = Signal()
    actionTriggered = Signal()

    def __init__(self, text: str = "", tone: str = "info",
                 parent: Optional[QWidget] = None, *, title: str = "",
                 closable: bool = False, icon: bool = True,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UAlert")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setProperty("tone", tone if tone in _ALERT_TONES else "info")
        self._init_theme(settings, theme)

        root = QHBoxLayout(self)
        root.setContentsMargins(12, 10, 10, 10)
        root.setSpacing(10)

        self.icon: Optional[QFrame] = None
        self.icon_label: Optional[QLabel] = None
        if icon:
            # 圆角图标块同样必须由 QFrame 承担（QLabel 不画 border-radius）
            self.icon = QFrame(self)
            self.icon.setObjectName("UAlertIcon")
            self.icon.setAttribute(Qt.WA_StyledBackground, True)
            self._apply_icon_size()
            self.icon_label = center_label(self.icon, "", "UAlertIconText")
            self._apply_icon_glyph()
            root.addWidget(self.icon, 0, Qt.AlignTop)

        texts = QVBoxLayout()
        texts.setSpacing(2)
        self.title = QLabel(title, self)
        self.title.setObjectName("UAlertTitle")
        self.title.setVisible(bool(title))
        texts.addWidget(self.title)
        self.text = QLabel(text, self)
        self.text.setObjectName("UAlertText")
        self.text.setWordWrap(True)
        texts.addWidget(self.text)
        root.addLayout(texts, 1)

        self.actions = QHBoxLayout()
        self.actions.setSpacing(6)
        root.addLayout(self.actions)

        self._close: Optional[QToolButton] = None
        if closable:
            self._close = QToolButton(self)
            self._close.setObjectName("UAlertClose")
            self._close.setIcon(icons.icon("close", size=14))
            self._close.setIconSize(QSize(14, 14))
            self._close.setToolTip("关闭提示")
            self._close.setAccessibleName("关闭提示")
            self._close.setCursor(Qt.PointingHandCursor)
            self._close.clicked.connect(self.close_alert)
            root.addWidget(self._close, 0, Qt.AlignTop)

    # ---------- 内容 ----------
    def set_title(self, text: str) -> None:
        self.title.setText(text)
        self.title.setVisible(bool(text))

    def set_text(self, text: str) -> None:
        self.text.setText(text)
        self.setAccessibleName(" ".join(x for x in (self.title.text(), text) if x))

    def set_tone(self, tone: str) -> None:
        self._set_variant("tone", tone, _ALERT_TONES)
        if self.icon_label is not None:
            self._apply_icon_glyph()

    def add_action(self, text: str,
                   handler: Optional[Callable[[], None]] = None) -> UButton:
        button = UButton(text, tone="subtle", size="compact", parent=self,
                         settings=self._ui_settings, theme=self._ui_theme)
        if handler is not None:
            button.clicked.connect(handler)
        button.clicked.connect(self.actionTriggered.emit)
        self.actions.addWidget(button)
        return button

    def close_alert(self) -> None:
        self.setVisible(False)
        self.closed.emit()
    def _apply_icon_glyph(self) -> None:
        # 图标块上用白色 SVG（背景是语义色实底，字符在字体里大小/基线不稳）
        if self.icon_label is None:
            return
        name = _ICON_NAMES.get(str(self.property("tone")), "info")
        size = token_px(self, "icon-box", 20)
        self.icon_label.setPixmap(icons.pixmap(name, "#FFFFFF", size))

    def _apply_icon_size(self) -> None:
        # 尺寸取自 token，restyle 时重算 —— 设置改了才会跟着变
        icon_box = token_px(self, 'icon-box', 20)
        self.icon.setFixedSize(icon_box, icon_box)
    def restyle(self) -> None:
        self._apply_icon_size()
        self.update()
