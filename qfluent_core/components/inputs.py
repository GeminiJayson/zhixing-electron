# -*- coding: utf-8 -*-
"""输入类组件：单行输入与搜索框。

Qt 的 QSS 不表达占位符颜色与部分焦点合成，这类"token 无法覆盖"的部分按
Fluent 规范改用语义 QPalette 角色，并在主题变化时刷新（restyle 钩子）。
"""
from __future__ import annotations

from typing import Optional

from PySide6.QtCore import QEvent, QObject, Qt, Signal, QSize
from PySide6.QtGui import QColor, QPalette
from PySide6.QtWidgets import (
    QFrame, QHBoxLayout, QLabel, QLineEdit, QToolButton, QWidget,
    QTextEdit,
)

from .. import icons
from ..settings import UISettings
from ..theme import ThemeManager
from .base import ThemedMixin

__all__ = ["UTextEdit", "ULineEdit", "USearchBox"]


class ULineEdit(ThemedMixin, QLineEdit):
    """主题化单行输入。原生 clear button 与 4.5:1 占位符对比度都已接入。"""

    def __init__(self, text: str = "", placeholder: str = "",
                 parent: Optional[QWidget] = None, *, clearable: bool = True,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(text or "", parent)
        self.setObjectName("ULineEdit")
        self.setFocusPolicy(Qt.StrongFocus)
        self.setClearButtonEnabled(clearable)
        if placeholder:
            self.setPlaceholderText(placeholder)
            self.setAccessibleName(placeholder)
        self.setProperty("state", "normal")
        self._init_theme(settings, theme)
        self.restyle()

    def set_error(self, error: bool) -> None:
        """校验失败态（描边转语义红；文案由 UField 承担）。"""
        self._set_variant("state", "error" if error else "normal",
                          ("normal", "error"))

    def restyle(self) -> None:
        """占位符色走 palette：QSS 不表达 placeholder-text-color。"""
        tokens = self.theme_tokens()
        palette = self.palette()
        palette.setColor(QPalette.PlaceholderText,
                         QColor(tokens.get("fg-placeholder", "#8B949E")))
        palette.setColor(QPalette.Text, QColor(tokens.get("fg", "#1A1D21")))
        palette.setColor(QPalette.Highlight,
                         QColor(tokens.get("accent-soft", "#D7F0EB")))
        palette.setColor(QPalette.HighlightedText, QColor(tokens.get("fg", "#1A1D21")))
        self.setPalette(palette)


class USearchBox(ThemedMixin, QFrame):
    """搜索框：图标 + 输入 + 清空。信号 textChanged(str) / submitted(str)。"""

    textChanged = Signal(str)
    submitted = Signal(str)

    def __init__(self, placeholder: str = "搜索…",
                 parent: Optional[QWidget] = None, *,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("USearchBox")
        self.setProperty("focused", "false")
        layout = QHBoxLayout(self)
        layout.setContentsMargins(8, 0, 4, 0)
        layout.setSpacing(2)

        self.icon = QLabel("\u2315", self)      # ⌕ 放大镜（可换成注入的图标）
        self.icon.setObjectName("USearchIcon")
        self.icon.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        layout.addWidget(self.icon)

        self.input = ULineEdit("", placeholder, self, clearable=False,
                               settings=settings, theme=theme)
        self.input.setObjectName("USearchInput")
        self.input.setAccessibleName(placeholder)
        layout.addWidget(self.input, 1)

        self.clear_button = QToolButton(self)
        self.clear_button.setObjectName("USearchClear")
        self.clear_button.setIcon(icons.icon("close", size=14))
        self.clear_button.setIconSize(QSize(14, 14))
        self.clear_button.setToolTip("清空搜索")
        self.clear_button.setAccessibleName("清空搜索")
        self.clear_button.setCursor(Qt.PointingHandCursor)
        self.clear_button.clicked.connect(self.clear)
        layout.addWidget(self.clear_button)

        self.input.textChanged.connect(self._on_text_changed)
        self.input.returnPressed.connect(lambda: self.submitted.emit(self.text()))
        self.input.installEventFilter(self)
        self._init_theme(settings, theme)
        self.restyle()

    # ---------- 焦点态让容器描边跟随（QSS 无 :focus-within） ----------
    def eventFilter(self, obj: QObject, event: QEvent) -> bool:  # noqa: N802
        if obj is self.input and event.type() in (QEvent.FocusIn, QEvent.FocusOut):
            self.setProperty("focused",
                             "true" if event.type() == QEvent.FocusIn else "false")
            self.repolish()
        return super().eventFilter(obj, event)

    def _on_text_changed(self, text: str) -> None:
        self.clear_button.setVisible(bool(text))
        self.textChanged.emit(text)

    # ---------- 便捷代理（业务层常用） ----------
    def text(self) -> str:
        return self.input.text()

    def setText(self, text: str) -> None:  # noqa: N802
        self.input.setText(text)

    def clear(self) -> None:
        self.input.clear()

    def setFocus(self) -> None:  # noqa: N802
        self.input.setFocus()
        self.input.selectAll()

    def restyle(self) -> None:
        self.clear_button.setVisible(bool(self.input.text()))


# ============================ 多行文本 ============================
class UTextEdit(ThemedMixin, QTextEdit):
    """多行文本编辑器：输入框同款边框/圆角/焦点态，高度自适应内容区。

    与 QLineEdit 系列的差别只在于「高度不锁死」—— 多行编辑的内容区必须可伸缩，
    否则换行内容会被挤在一行里。
    """

    def __init__(self, text: str = "", parent: Optional[QWidget] = None, *,
                 placeholder: str = "", read_only: bool = False,
                 tooltip: str = "",
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UTextEdit")
        self.setAttribute(Qt.WA_StyledBackground, True)
        if text:
            self.setPlainText(text)
        if placeholder:
            self.setPlaceholderText(placeholder)
        self.setReadOnly(bool(read_only))
        self.setAcceptRichText(False)
        if tooltip:
            self.setToolTip(tooltip)
        self.setAccessibleName(placeholder or tooltip or "多行文本")
        self._init_theme(settings, theme)

