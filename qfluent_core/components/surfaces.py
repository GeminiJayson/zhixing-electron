# -*- coding: utf-8 -*-
"""容器类组件：卡片、分隔线、折叠面板、页头、表单行。

层级原则：先用 canvas/layer 角色、间距和排版建立层次，只有当某个区域真的拥有
独立填充/边界/选择/交互时才加卡片；不做"每个区块都套卡片"。
"""
from __future__ import annotations

from typing import Optional, Tuple

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QFrame, QHBoxLayout, QLabel, QSizePolicy, QToolButton, QVBoxLayout, QWidget,
)

from .. import motion
from ..settings import UISettings
from ..theme import ThemeManager
from .base import ThemedMixin, token_px

__all__ = ["UCard", "UDivider", "UExpander", "UPageHeader", "UField"]

_CARD_VARIANTS = ("raised", "sunken", "plain")


class UCard(ThemedMixin, QFrame):
    """独立内容容器。业务往 body_layout 里加内容即可。

    variant: raised（默认卡片）| sunken（内嵌面板）| plain（无填充，仅分组）
    """

    def __init__(self, title: str = "", subtitle: str = "",
                 parent: Optional[QWidget] = None, *, variant: str = "raised",
                 padding: Optional[int] = None,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UCard")
        self.setProperty("variant", variant if variant in _CARD_VARIANTS else "raised")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self._init_theme(settings, theme)

        self._root = QVBoxLayout(self)
        self._root.setContentsMargins(0, 0, 0, 0)
        self._root.setSpacing(0)

        self.header: Optional[QFrame] = None
        self.title_label: Optional[QLabel] = None
        self.subtitle_label: Optional[QLabel] = None
        if title or subtitle:
            self._build_header(title, subtitle)

        self.body = QFrame(self)
        self.body.setObjectName("UCardBody")
        self.body_layout = QVBoxLayout(self.body)
        self.body_layout.setSpacing(8)
        self._root.addWidget(self.body, 1)
        self.footer: Optional[QFrame] = None

        self._padding = padding
        # 业务显式指定的正文内边距（如紧凑统计卡）：一旦设定，restyle() 不再用 token 覆盖
        self._body_margins: Optional[Tuple[int, int, int, int]] = None
        self.restyle()

    def set_body_margins(self, left: int, top: int, right: int, bottom: int) -> None:
        """固定正文内边距（覆盖 token 内边距）——紧凑/自绘卡片用。

        必须走这里而不是直接改 body_layout.setContentsMargins()：restyle() 在换肤与
        换设置时都会重设内边距，直接改会被静默抹掉。
        """
        self._body_margins = (int(left), int(top), int(right), int(bottom))
        self.restyle()

    def _build_header(self, title: str, subtitle: str) -> None:
        self.header = QFrame(self)
        self.header.setObjectName("UCardHeader")
        layout = QVBoxLayout(self.header)
        layout.setSpacing(2)
        # title 为空时不预建标题标签：header_row() 的标题要放进它自己那一行，
        # 预建会让同一张卡片出现两个同文本标题（「链接」曾重复两份）。
        if title:
            layout.addWidget(self._ensure_title(title))
        if subtitle:
            self.subtitle_label = QLabel(subtitle, self.header)
            self.subtitle_label.setObjectName("UCardSubtitle")
            self.subtitle_label.setWordWrap(True)
            layout.addWidget(self.subtitle_label)
        # 标题区恒在正文之上：header_row/header_title 可能在构造完成后才补建，
        # 用 addWidget 会把标题排到正文下面。
        self._root.insertWidget(0, self.header)

    def _ensure_title(self, title: str) -> QLabel:
        """取本卡片唯一的标题标签（复用同一实例，绝不建第二个）。"""
        if self.title_label is None:
            self.title_label = QLabel(title, self.header)
            self.title_label.setObjectName("UCardTitle")
        else:
            self.title_label.setText(title)
        return self.title_label

    # ---------- 内容装配 ----------
    def header_row(self, title: str = ""):
        # 兼容宿主写法：在卡片标题区开一行，返回可继续加控件的容器。
        if self.header is None:
            self._build_header("", "")
        host = QFrame(self.header)
        host.setObjectName("UCardHeaderRow")
        row = QHBoxLayout(host)
        row.setContentsMargins(0, 0, 0, 0)
        if title:
            label = self._ensure_title(title)
            prev = label.parentWidget()
            if prev is not None and prev is not host and prev.layout() is not None:
                prev.layout().removeWidget(label)   # 换行前先脱开旧布局，避免残留项
                label.setParent(host)
            row.addWidget(label)
        row.addStretch(1)
        self.header.layout().addWidget(host)
        self._header_row_host = host
        self._header_row_lay = row
        # 业务把它当布局用（hdr.addWidget(...)），所以返回 row 而不是 host
        return row

    def header_title(self, title: str) -> QLabel:
        # 兼容宿主写法：设标题并返回那个 QLabel
        if self.header is None:
            self._build_header(title, "")
        else:
            label = self._ensure_title(title)
            lay = self.header.layout()
            if lay is not None and lay.indexOf(label) < 0:
                lay.insertWidget(0, label)   # 补建的标题要进标题区布局，否则不可见
        return self.title_label
    def add_widget(self, widget: QWidget, stretch: int = 0) -> QWidget:
        self.body_layout.addWidget(widget, stretch)
        return widget

    def add_layout(self, layout, stretch: int = 0):
        self.body_layout.addLayout(layout, stretch)
        return layout

    def set_footer_widget(self, widget: QWidget, *, divider: bool = True) -> QWidget:
        """底部动作区（独立于正文，可带分隔线）。"""
        if self.footer is None:
            self.footer = QFrame(self)
            self.footer.setObjectName("UCardFooter")
            self.footer_layout = QHBoxLayout(self.footer)
            self.footer_layout.setSpacing(8)
            self.footer_layout.addStretch(1)
            self._root.addWidget(self.footer)
        if not divider:
            self.footer.setStyleSheet("border-top: none;")
        self.footer_layout.addWidget(widget)
        return widget

    def restyle(self) -> None:
        tokens = self.theme_tokens()
        pad = self._padding
        if pad is None:
            pad = int(str(tokens.get("space-4", "16px")).replace("px", "") or 16)
        self._root.setContentsMargins(0, 0, 0, 0)
        if self.header is not None:
            self.header.layout().setContentsMargins(pad, pad, pad, 0)
        if self._body_margins is not None:
            self.body_layout.setContentsMargins(*self._body_margins)
        else:
            self.body_layout.setContentsMargins(pad, pad if self.header is None else 8,
                                                pad, pad)
        if self.footer is not None:
            self.footer.layout().setContentsMargins(pad, 10, pad, 10)


class UDivider(ThemedMixin, QFrame):
    """轻量区域边界（优先于加卡片）。"""

    def __init__(self, orientation: str = "horizontal",
                 parent: Optional[QWidget] = None, *,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UDivider")
        self.setProperty("orientation", orientation)
        self.setAttribute(Qt.WA_StyledBackground, True)
        if orientation == "vertical":
            self._apply_thickness()
            self.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Expanding)
        else:
            self._apply_thickness()
            self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self._init_theme(settings, theme)


    def _apply_thickness(self) -> None:
        width = token_px(self, 'divider-w', 1)
        if self.property('orientation') == 'vertical':
            self.setFixedWidth(width)
        else:
            self.setFixedHeight(width)
    def restyle(self) -> None:
        self._apply_thickness()
        self.update()
class UExpander(ThemedMixin, QWidget):
    """单个可折叠区域（多个协同折叠请用多个 UExpander 或业务自行编排）。"""

    toggled = Signal(bool)

    def __init__(self, title: str = "", parent: Optional[QWidget] = None, *,
                 expanded: bool = False,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UExpander")
        self._init_theme(settings, theme)

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(4)

        self.header = QToolButton(self)
        self.header.setObjectName("UExpanderHeader")
        self.header.setText(title)
        self.header.setCheckable(True)
        self.header.setChecked(expanded)
        self.header.setToolButtonStyle(Qt.ToolButtonTextBesideIcon)
        self.header.setArrowType(Qt.DownArrow if expanded else Qt.RightArrow)
        self.header.setCursor(Qt.PointingHandCursor)
        self.header.setFocusPolicy(Qt.StrongFocus)
        self.header.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.header.setAccessibleName(title)
        self.header.toggled.connect(self._on_toggled)
        root.addWidget(self.header)

        self.body = QFrame(self)
        self.body.setObjectName("UExpanderBody")
        self.body_layout = QVBoxLayout(self.body)
        self.body_layout.setContentsMargins(12, 0, 0, 0)
        self.body_layout.setSpacing(8)
        root.addWidget(self.body)
        self.body.setVisible(expanded)
        self.body.setMaximumHeight(16777215 if expanded else 0)

    def _collapse_body(self) -> None:
        """收起终态：高度归零并隐藏（无论是否走了动画）。"""
        self.body.setMaximumHeight(0)
        self.body.setVisible(False)

    def add_widget(self, widget: QWidget, stretch: int = 0) -> QWidget:
        self.body_layout.addWidget(widget, stretch)
        return widget

    def is_expanded(self) -> bool:
        return self.header.isChecked()

    def set_expanded(self, expanded: bool) -> None:
        self.header.setChecked(expanded)

    def _on_toggled(self, expanded: bool) -> None:
        from .. import motion
        self.header.setArrowType(Qt.DownArrow if expanded else Qt.RightArrow)
        if expanded:
            self.body.show()
            target = self.body.sizeHint().height()
            # 起点取 maximumHeight 而不是 height()：Qt 隐藏 widget 不会把 height 归零，
            # 用 height() 会导致第二次展开拿 139->139，动画看起来「没动」。
            start = self.body.maximumHeight()
            if start < 0 or start > target:
                start = 0
            anim = motion.animate(self.body, "maximumHeight", start, target, dur="fast")
            if anim is None:
                self.body.setMaximumHeight(16777215)
        else:
            # 起点同样取 maximumHeight：未布局时 height() 可能是 0，会让 start == end
            # 而静默跳过动画（收起后 maximumHeight 仍停在展开值，第二次展开也不动）。
            start = self.body.maximumHeight()
            if start <= 0:
                start = self.body.sizeHint().height()
            anim = motion.animate(self.body, "maximumHeight", start, 0, dur="fast",
                                  on_done=lambda: self._collapse_body())
            if anim is None:
                self._collapse_body()
        self.toggled.emit(expanded)


class UPageHeader(ThemedMixin, QWidget):
    """页面标题区：主标题 + 副标题 + 右侧动作区（一个区域只放一个 accent 动作）。"""

    def __init__(self, title: str = "", subtitle: str = "",
                 parent: Optional[QWidget] = None, *,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UPageHeader")
        self._init_theme(settings, theme)
        root = QHBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(12)

        texts = QVBoxLayout()
        texts.setSpacing(2)
        self.title_label = QLabel(title, self)
        self.title_label.setObjectName("UPageHeaderTitle")
        texts.addWidget(self.title_label)
        self.subtitle_label = QLabel(subtitle, self)
        self.subtitle_label.setObjectName("UPageHeaderSubtitle")
        self.subtitle_label.setWordWrap(True)
        self.subtitle_label.setVisible(bool(subtitle))
        texts.addWidget(self.subtitle_label)
        root.addLayout(texts, 1)

        self.actions = QHBoxLayout()
        self.actions.setSpacing(8)
        root.addLayout(self.actions)

    def add_action(self, widget: QWidget) -> QWidget:
        self.actions.addWidget(widget)
        return widget

    def set_title(self, text: str) -> None:
        self.title_label.setText(text)

    def set_subtitle(self, text: str) -> None:
        self.subtitle_label.setText(text)
        self.subtitle_label.setVisible(bool(text))

    def play_enter(self) -> None:
        # 兼容宿主写法：页面入场动画（标题轻微淡入上移）
        motion.fade_in(self, dur="fast", slide=6)

    def _sync_labels(self) -> None:
        # 宿主通过 title_label / subtitle_label 直接改文案
        self.title_label = getattr(self, "title_label", None)
        self.subtitle_label = getattr(self, "subtitle_label", None)

class UField(ThemedMixin, QWidget):
    """表单行：标签 + 控件 + 帮助/错误文案（错误就近显示，不用顶部汇总）。"""

    def __init__(self, label: str, widget: Optional[QWidget] = None,
                 parent: Optional[QWidget] = None, *, help_text: str = "",
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UField")
        self._init_theme(settings, theme)
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(4)

        self.label = QLabel(label, self)
        self.label.setObjectName("UFieldLabel")
        root.addWidget(self.label)

        self.control: Optional[QWidget] = None
        if widget is not None:
            self.set_control(widget)
            root.addWidget(widget)

        self.help = QLabel(help_text, self)
        self.help.setObjectName("UFieldHelp")
        self.help.setProperty("state", "normal")
        self.help.setWordWrap(True)
        self.help.setVisible(bool(help_text))
        self._help_text = help_text
        root.addWidget(self.help)

    def set_control(self, widget: QWidget) -> QWidget:
        self.control = widget
        if widget.toolTip() == "" and self.label.text():
            widget.setAccessibleName(self.label.text())
        return widget

    def set_help(self, text: str) -> None:
        self._help_text = text
        self.help.setProperty("state", "normal")
        self.help.setText(text)
        self.help.setVisible(bool(text))

    def set_error(self, text: str) -> None:
        """错误就近显示；空字符串表示清除错误。"""
        self.help.setProperty("state", "error" if text else "normal")
        self.help.setText(text or self._help_text)
        self.help.setVisible(bool(text or self._help_text))
        if self.control is not None and hasattr(self.control, "set_error"):
            self.control.set_error(bool(text))
