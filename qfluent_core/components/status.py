# -*- coding: utf-8 -*-
"""状态与反馈类组件：胶囊、徽标、内联状态条、进度、空状态、骨架屏。

选择原则：持久内联状态用 UInfoBar；短暂确认用 toast（由业务承载）；
可比或精确进度用 UProgressBar；紧凑活动用 UProgressRing；
加载期保持几何用 USkeleton；无数据用 UEmptyState（空态必须是有意设计的）。
"""
from __future__ import annotations

from typing import Callable, Optional

from PySide6.QtCore import (
    Property, QEasingCurve, QPropertyAnimation, QRectF, QSize, Qt, QTimer, Signal,
)
from PySide6.QtGui import QColor, QPainter, QPaintEvent, QPen
from PySide6.QtWidgets import (
    QFrame, QHBoxLayout, QLabel, QProgressBar, QSizePolicy, QToolButton,
    QVBoxLayout, QWidget,
)

from .. import icons
from ..settings import UISettings
from ..theme import ThemeManager
from .actions import UButton
from .base import KINDS, TONES, ThemedMixin, center_label, token_px

__all__ = ["UStatusPill", "UBadge", "UInfoBar", "UProgressBar", "UProgressRing",
           "UEmptyState", "USkeleton"]

_PILL_KINDS = ("soft", "solid", "outline")


class UStatusPill(ThemedMixin, QFrame):
    """语义状态胶囊。tone: standard|accent|danger|warn|success|info

    继承 QFrame 而不是 QLabel：QLabel 不绘制 QSS 的 border-radius，
    胶囊会渲染成方块（实测确认）。文字由内部 QLabel 承担。
    """

    def __init__(self, text: str = "", tone: str = "standard", kind: str = "soft",
                 parent: Optional[QWidget] = None, *,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UStatusPill")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setSizePolicy(QSizePolicy.Maximum, QSizePolicy.Fixed)
        self.setProperty("tone", tone if tone in TONES else "standard")
        self.setProperty("kind", kind if kind in _PILL_KINDS else "soft")
        self._label = center_label(self, text, "UStatusPillText")
        if text:
            self.setAccessibleName(text)
        self._init_theme(settings, theme)
        self.restyle()

    # ---- QLabel 兼容 API（迁移时旧调用点无需改） ----
    def text(self) -> str:
        return self._label.text()

    def setText(self, text: str) -> None:  # noqa: N802
        self._label.setText(text)
        self.setAccessibleName(text)
        self.updateGeometry()

    def setAlignment(self, flag) -> None:  # noqa: N802
        self._label.setAlignment(flag)

    def set_tone(self, tone: str) -> None:
        self._set_variant("tone", tone, TONES)

    def set_kind(self, kind: str) -> None:
        self._set_variant("kind", kind, _PILL_KINDS)

    def set_status(self, text: str, tone: str = "standard") -> None:
        self.setText(text)
        self.set_tone(tone)

    def restyle(self) -> None:
        self.updateGeometry()
class UBadge(ThemedMixin, QFrame):
    """计数徽标。超过 max_display 显示 N+（同样用 QFrame 承担圆角）。"""

    def __init__(self, count: int = 0, parent: Optional[QWidget] = None, *,
                 tone: str = "accent", max_display: int = 99,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UBadge")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setSizePolicy(QSizePolicy.Maximum, QSizePolicy.Fixed)
        self._max_display = max_display
        self.setProperty("tone", tone if tone in TONES else "accent")
        self._label = center_label(self, "", "UBadgeText")
        self._init_theme(settings, theme)
        self.set_count(count)

    def text(self) -> str:
        return self._label.text()

    def set_count(self, count: int) -> None:
        text = "%d+" % self._max_display if count > self._max_display else str(count)
        self._label.setText(text)
        self.setVisible(count > 0)
        self.setAccessibleName("未读 %d" % count)
        self.updateGeometry()


class UInfoBar(ThemedMixin, QFrame):
    """内联持久状态（校验提示、连接异常、后台任务结果），可带一个动作与关闭。"""

    closed = Signal()
    actionTriggered = Signal()

    def __init__(self, text: str = "", tone: str = "standard",
                 parent: Optional[QWidget] = None, *, closable: bool = True,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UInfoBar")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setProperty("tone", tone if tone in TONES else "standard")
        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 8, 8, 8)
        layout.setSpacing(8)

        self.text = QLabel(text, self)
        self.text.setObjectName("UInfoBarText")
        self.text.setWordWrap(True)
        layout.addWidget(self.text, 1)

        self._action: Optional[UButton] = None
        self._close: Optional[QToolButton] = None
        if closable:
            self._close = QToolButton(self)
            self._close.setObjectName("UInfoBarClose")
            self._close.setIcon(icons.icon("close", size=14))
            self._close.setIconSize(QSize(14, 14))
            self._close.setCursor(Qt.PointingHandCursor)
            self._close.setToolTip("关闭提示")
            self._close.setAccessibleName("关闭提示")
            self._close.clicked.connect(self.close_bar)
            layout.addWidget(self._close)
        self._init_theme(settings, theme)

    def add_action(self, text: str,
                   handler: Optional[Callable[[], None]] = None) -> UButton:
        self._action = UButton(text, tone="subtle", size="compact", parent=self,
                               settings=self._ui_settings, theme=self._ui_theme)
        if handler is not None:
            self._action.clicked.connect(handler)
        self._action.clicked.connect(self.actionTriggered.emit)
        self.layout().insertWidget(self.layout().count() - (1 if self._close else 0),
                                   self._action)
        return self._action

    def set_text(self, text: str) -> None:
        self.text.setText(text)
        self.setAccessibleName(text)

    def set_tone(self, tone: str) -> None:
        self._set_variant("tone", tone, TONES)
        self.text.setAccessibleName(self.text.text())

    def close_bar(self) -> None:
        self.setVisible(False)
        self.closed.emit()


class UProgressBar(ThemedMixin, QProgressBar):
    """语义进度条。tone 表达进度含义（默认 accent，成功/警告/危险按语义选）。"""

    def __init__(self, value: int = 0, maximum: int = 100,
                 parent: Optional[QWidget] = None, *, tone: str = "accent",
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UProgressBar")
        self.setTextVisible(False)
        self.setRange(0, maximum)
        self.setValue(value)
        self.setProperty("tone", tone if tone in TONES else "accent")
        self.setAccessibleName("进度")
        self._init_theme(settings, theme)

    def set_tone(self, tone: str) -> None:
        self._set_variant("tone", tone, TONES)

    def set_progress(self, value: int, maximum: Optional[int] = None) -> None:
        if maximum is not None:
            self.setRange(0, maximum)
        self.setValue(value)


class UProgressRing(ThemedMixin, QWidget):
    """紧凑活动/进度指示。indeterminate 模式持续旋转，尊重 reduce-motion。

    set_range(0, 0) 表示不确定进度；set_range(0, n) 表示确定进度。
    """

    def __init__(self, parent: Optional[QWidget] = None, *, size: int = 24,
                 indeterminate: bool = False,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UProgressRing")
        self._size = size
        self._angle = 0.0
        self._value = 0
        self._maximum = 100
        self._indeterminate = indeterminate
        self._anim: Optional[QPropertyAnimation] = None
        self.setFixedSize(size, size)
        self.setAccessibleName("加载中")
        self._init_theme(settings, theme)
        if indeterminate:
            self.start()

    # ---------- 旋转属性 ----------
    def _get_angle(self) -> float:
        return self._angle

    def _set_angle(self, value: float) -> None:
        self._angle = float(value)
        self.update()

    angle = Property(float, _get_angle, _set_angle)

    def set_range(self, minimum: int, maximum: int) -> None:
        self._maximum = maximum
        if maximum <= 0:
            self.start()
        else:
            self.stop()
            self._value = max(0, min(minimum, maximum))

    def set_value(self, value: int) -> None:
        self._value = max(0, min(int(value), self._maximum))
        self.update()

    def start(self) -> None:
        from .. import motion
        self._indeterminate = True
        if not motion.motion_enabled():
            self.update()
            return
        self._anim = QPropertyAnimation(self, b"angle", self)
        self._anim.setDuration(900)
        self._anim.setStartValue(0.0)
        self._anim.setEndValue(360.0)
        self._anim.setLoopCount(-1)
        self._anim.start()

    def stop(self) -> None:
        self._indeterminate = False
        if self._anim is not None:
            self._anim.stop()
            self._anim = None
        self.update()

    def paintEvent(self, event: QPaintEvent) -> None:  # noqa: N802
        tokens = self.theme_tokens()
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        pen_width = max(2.0, self._size / 10.0)
        rect = QRectF(pen_width / 2.0, pen_width / 2.0,
                      self._size - pen_width, self._size - pen_width)
        track_pen = QPen(QColor(tokens.get("track", tokens.get("control-pressed", "#E8EFEB"))))
        track_pen.setWidthF(pen_width)
        track_pen.setCapStyle(Qt.RoundCap)
        painter.setPen(track_pen)
        painter.drawArc(rect, 0, 360 * 16)

        arc_pen = QPen(QColor(tokens.get("accent-solid", "#0D9488")))
        arc_pen.setWidthF(pen_width)
        arc_pen.setCapStyle(Qt.RoundCap)
        painter.setPen(arc_pen)
        if self._indeterminate:
            painter.drawArc(rect, int(-self._angle * 16), int(-100 * 16))
        else:
            span = 360 if self._maximum <= 0 else int(360 * self._value / self._maximum)
            painter.drawArc(rect, 90 * 16, -span * 16)
        painter.end()

    def restyle(self) -> None:
        self.update()


class UEmptyState(ThemedMixin, QFrame):
    """有意设计的空状态：说明为什么空、下一步能做什么。"""

    actionTriggered = Signal()

    def __init__(self, title: str = "暂无内容", text: str = "",
                 parent: Optional[QWidget] = None, *, icon_text: str = "\u25cb",
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UEmptyState")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 32, 24, 32)
        layout.setSpacing(8)
        layout.setAlignment(Qt.AlignCenter)

        # 圆角图标底同样由 QFrame 承担（QLabel 不画 border-radius）
        self.icon = QFrame(self)
        self.icon.setObjectName("UEmptyStateIcon")
        self.icon.setAttribute(Qt.WA_StyledBackground, True)
        self._apply_icon_size()
        self.icon_label = center_label(self.icon, icon_text, "UEmptyStateIconText")
        layout.addWidget(self.icon, 0, Qt.AlignHCenter)

        self.title = QLabel(title, self)
        self.title.setObjectName("UEmptyStateTitle")
        self.title.setAlignment(Qt.AlignCenter)
        layout.addWidget(self.title)

        self.text = QLabel(text, self)
        self.text.setObjectName("UEmptyStateText")
        self.text.setAlignment(Qt.AlignCenter)
        self.text.setWordWrap(True)
        self.text.setVisible(bool(text))
        layout.addWidget(self.text)

        self._action: Optional[UButton] = None
        self._init_theme(settings, theme)

    def add_action(self, text: str,
                   handler: Optional[Callable[[], None]] = None) -> UButton:
        self._action = UButton(text, tone="accent", parent=self,
                               settings=self._ui_settings, theme=self._ui_theme)
        if handler is not None:
            self._action.clicked.connect(handler)
        self._action.clicked.connect(self.actionTriggered.emit)
        self.layout().addWidget(self._action, 0, Qt.AlignHCenter)
        return self._action

    def set_content(self, title: str, text: str = "") -> None:
        self.title.setText(title)
        self.text.setText(text)
        self.text.setVisible(bool(text))
    def _apply_icon_size(self) -> None:
        avatar = token_px(self, 'avatar-size', 44)
        self.icon.setFixedSize(avatar, avatar)

    def restyle(self) -> None:
        self._apply_icon_size()
        self.updateGeometry()
class USkeleton(ThemedMixin, QFrame):
    """保持几何的加载占位（避免加载完成后布局跳动）。默认呼吸动画。"""

    def __init__(self, parent: Optional[QWidget] = None, *, width: int = 160,
                 height: int = 12, radius: Optional[int] = None,
                 animated: bool = True,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("USkeleton")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self._radius = radius
        self.setFixedSize(width, height)
        self._timer: Optional[QTimer] = None
        self._phase = 0.0
        self._init_theme(settings, theme)
        self.restyle()
        if animated:
            self._start_pulse()

    def _start_pulse(self) -> None:
        from .. import motion
        if not motion.motion_enabled():
            return
        self._timer = QTimer(self)
        self._timer.setInterval(700)
        self._timer.timeout.connect(self._pulse)
        self._timer.start()

    def _pulse(self) -> None:
        self._phase = 1.0 - self._phase
        self.setProperty("pulse", "true" if self._phase > 0.5 else "false")
        self.repolish()

    def restyle(self) -> None:
        tokens = self.theme_tokens()
        radius = self._radius
        if radius is None:
            radius = int(str(tokens.get("radius-sm", "4px")).replace("px", "") or 4)
        self.setStyleSheet("#USkeleton { border-radius: %dpx; }" % radius)
