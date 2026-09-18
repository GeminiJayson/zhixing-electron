# -*- coding: utf-8 -*-
"""交互动效组件（一）：折叠卡片、翻转卡片、滑动确认条。

共同约定：动画一律走 motion.animate_value()，因此统一尊重
「动效开关」与「动效档位」，并且同一条曲线可以驱动多个属性。
"""
from __future__ import annotations

import math
from typing import Dict, List, Optional, Sequence

from PySide6.QtCore import QPointF, QRectF, Qt, QVariantAnimation, Signal
from PySide6.QtGui import QColor, QPainter, QPainterPath, QPaintEvent, QPen
from PySide6.QtWidgets import (
    QFrame, QGraphicsOpacityEffect, QHBoxLayout, QLabel, QScrollArea,
    QSizePolicy, QToolButton, QVBoxLayout, QWidget,
)

from .actions import UButton, UToggleSwitch
from .forms import USlider
from .inputs import ULineEdit

from .. import motion
from ..settings import UISettings
from ..theme import ThemeManager
from .base import ThemedMixin, token_px

__all__ = ["UCollapseCard", "UFlipCard", "USwipeConfirm", "UActionCard",
           "UFilterChips", "UProgressCard", "UBottomBar", "UMaskedInput"]


def _lerp(start: float, end: float, ratio: float) -> float:
    return start + (end - start) * ratio


def _space(widget, token: str = "space-4", default: int = 16) -> int:
    """读取间距 token（取不到就退回默认值）。"""
    try:
        raw = str(widget.theme_tokens().get(token, "%dpx" % default))
        return int(raw.replace("px", "") or default)
    except (AttributeError, TypeError, ValueError):
        return default


class _RotatingChevron(ThemedMixin, QWidget):
    """按角度旋转的主题色 chevron（自绘，角度可被动画驱动）。"""

    def __init__(self, parent: Optional[QWidget] = None, *, size: int = 16,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("URotatingChevron")
        self.setFixedSize(size, size)
        self._angle = -90.0            # -90 = 收起（指向右），0 = 展开（指向下）
        self._init_theme(settings, theme)

    def set_angle(self, degrees: float) -> None:
        if abs(degrees - self._angle) < 0.01:
            return
        self._angle = float(degrees)
        self.update()

    def angle(self) -> float:
        return self._angle

    def paintEvent(self, event: QPaintEvent) -> None:  # noqa: N802
        tokens = self.theme_tokens()
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        painter.translate(self.width() / 2.0, self.height() / 2.0)
        painter.rotate(self._angle)
        pen = QPen(QColor(tokens.get("fg2", "#5A6570")))
        pen.setWidthF(1.6)
        pen.setCapStyle(Qt.RoundCap)
        pen.setJoinStyle(Qt.RoundJoin)
        painter.setPen(pen)
        size = min(self.width(), self.height()) * 0.38
        path = QPainterPath()
        path.moveTo(QPointF(-size, -size * 0.55))
        path.lineTo(QPointF(0.0, size * 0.55))
        path.lineTo(QPointF(size, -size * 0.55))
        painter.drawPath(path)
        painter.end()

    def restyle(self) -> None:
        self.update()


class _CollapseHeader(QFrame):
    """折叠卡片的标题栏：整行可点、可聚焦。

    用 QFrame 而不是 QToolButton —— QToolButton 有自己的内容绘制与内边距，
    往它里面再塞布局会叠加偏移（实测内容比其它卡片多缩进 28px）。
    """

    clicked = Signal()

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UCollapseHeader")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setCursor(Qt.PointingHandCursor)
        self.setFocusPolicy(Qt.StrongFocus)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if (event.button() == Qt.LeftButton
                and self.rect().contains(event.position().toPoint())):
            self.clicked.emit()
        super().mouseReleaseEvent(event)

    def keyPressEvent(self, event) -> None:  # noqa: N802
        """键盘也能展开 / 收起（无障碍）。"""
        if event.key() in (Qt.Key_Space, Qt.Key_Return, Qt.Key_Enter):
            self.clicked.emit()
        super().keyPressEvent(event)


class UCollapseCard(ThemedMixin, QFrame):
    """可折叠卡片：高度、内容透明度、箭头角度由**同一条缓动曲线**驱动。

    三者在一个动画的每帧里一起更新，所以是一个整体动作，不会出现
    「高度已经到位、箭头还在转」的错位感。
    """

    toggled = Signal(bool)

    def __init__(self, title: str = "", parent: Optional[QWidget] = None, *,
                 expanded: bool = True, settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UCollapseCard")
        self.setAttribute(Qt.WA_StyledBackground, True)
        # 卡片高度跟随内容：不被外层布局拉伸，否则展开时会顶满整个容器
        self.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Maximum)
        self._init_theme(settings, theme)
        self._expanded = bool(expanded)
        self._progress = 1.0 if expanded else 0.0
        self._animation: Optional[QVariantAnimation] = None

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        self.header = _CollapseHeader(self)
        self.header.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.header.setAccessibleName(title)
        self.header.clicked.connect(self.toggle)
        self.header.setProperty("expanded", "true" if expanded else "false")
        root.addWidget(self.header)

        head_row = QHBoxLayout(self.header)
        # 与 UCard 相同的内容边距：这样折叠卡片与其它卡片组件的视觉效果一致
        # 折叠卡片没有外层卡片托底，左右留白给宽一档（space-5），否则内容紧贴边界
        pad = _space(self, "space-5", 20)
        head_row.setContentsMargins(pad, 12, pad, 12)
        head_row.setSpacing(8)
        self.title_label = QLabel(title, self.header)
        self.title_label.setObjectName("UCollapseTitle")
        self.title_label.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        head_row.addWidget(self.title_label)
        head_row.addStretch(1)
        self.chevron = _RotatingChevron(self.header, settings=settings, theme=theme)
        self.chevron.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        head_row.addWidget(self.chevron)

        self.body = QFrame(self)
        self.body.setObjectName("UCollapseBody")
        # body 的垂直策略必须是 Preferred（而不是 Minimum）：
        # Minimum 的语义是「sizeHint 是不可再小的下限」，布局会拒绝让 body 缩到
        # sizeHint 以下 —— 折叠动画的 maximumHeight 就完全不起作用，收起时内容
        # 依然按原高度绘制，从而溢出卡片。Preferred 允许布局把它压到 0。
        self.body.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Preferred)
        self.body.setMinimumHeight(0)
        # 内容透明度也要跟着同一条曲线 —— 这需要常驻一个 opacity effect
        self._body_effect = QGraphicsOpacityEffect(self.body)
        self.body.setGraphicsEffect(self._body_effect)
        # 内边距与 UCard 对齐（左右 16），否则折叠卡片的内容会比其他卡片更贴边
        self.body_layout = QVBoxLayout(self.body)
        body_pad = _space(self, "space-5", 20)
        self.body_layout.setContentsMargins(body_pad, 0, body_pad, body_pad)
        self.body_layout.setSpacing(8)
        root.addWidget(self.body)
        self.body.setVisible(expanded)
        # 必须按初始状态应用一次：否则展开的卡片会挂着「收起态」的箭头角度
        self._apply_progress(self._progress)
        self.restyle()

    # ---------- 内容 ----------
    def add_widget(self, widget: QWidget, stretch: int = 0) -> QWidget:
        self.body_layout.addWidget(widget, stretch)
        return widget

    def add_layout(self, layout, stretch: int = 0):
        self.body_layout.addLayout(layout, stretch)
        return layout

    # ---------- 折叠 ----------
    def is_expanded(self) -> bool:
        return self._expanded

    def set_title(self, text: str) -> None:
        self.title_label.setText(text)
        self.header.setAccessibleName(text)

    def toggle(self) -> None:
        self.set_expanded(not self._expanded)

    def set_expanded(self, expanded: bool, *, animate: bool = True) -> None:
        expanded = bool(expanded)
        if expanded == self._expanded and abs(self._progress - (1.0 if expanded else 0.0)) < 0.01:
            return
        self._expanded = expanded
        self.header.setProperty('expanded', 'true' if expanded else 'false')
        target = 1.0 if expanded else 0.0
        if expanded:
            self.body.setVisible(True)
        if not animate:
            self._apply_progress(target)
            self.toggled.emit(expanded)
            return

        self._animation = motion.animate_value(
            self._progress, target, dur="panel", easing="panel", parent=self,
            on_update=self._apply_progress,
            on_done=lambda: self._finish(expanded))
        if self._animation is None:
            self._apply_progress(target)
            self._finish(expanded)

    def _finish(self, expanded: bool) -> None:
        if expanded:
            # 展开动画结束后解除高度限制：换行文本的高度随宽度变化，
            # 用一个算死的值去限制它，内容就会溢出卡片（被挤压甚至画到边界外）
            self.body.setMaximumHeight(16777215)
        else:
            self.body.setVisible(False)
        self.toggled.emit(expanded)

    def _apply_progress(self, ratio: float) -> None:
        """一条曲线同时驱动三个属性 —— 这就是「共用一条缓动曲线」。"""
        self._progress = max(0.0, min(1.0, float(ratio)))
        full = self._body_full_height()
        self.body.setMaximumHeight(max(0, int(round(full * self._progress))))
        if self._progress >= 1.0:
            # 完全展开时不再限制：内容按实际需要换行，绝不裁剪
            self.body.setMaximumHeight(16777215)
        effect = self.body.graphicsEffect()
        if effect is not None and hasattr(effect, "setOpacity"):
            effect.setOpacity(self._progress)
        self.chevron.set_angle(_lerp(-90.0, 0.0, self._progress))

    def _body_full_height(self) -> int:
        """内容在当前宽度下需要的高度。

        必须用 heightForWidth：换行标签（wordWrap）的高度取决于实际宽度，
        只取 sizeHint() 会得到「未换行」的那个偏小值，展开后内容会被挤压溢出。
        """
        width = self.body.width() or self.width()
        layout = self.body_layout
        hint = 0
        if layout.hasHeightForWidth() and width > 0:
            hint = int(layout.heightForWidth(width))
        if hint <= 0:
            hint = self.body_layout.sizeHint().height()
        return max(hint, 1)


class UFlipCard(ThemedMixin, QFrame):
    """可翻转卡片：正面核心信息、背面规则说明，翻转中途换面。

    Qt 没有 3D 变换，用「宽度压扁」模拟 Y 轴翻转：scaleX 由 1 → 0 → 1，
    在 t 跨过 0.5（最窄的那一刻）切换显示的面 —— 这就是「中途换面」，
    用户看到的是正面收拢、背面展开，而不是突然跳变。
    """

    flipped = Signal(bool)

    def __init__(self, front: Optional[QWidget] = None,
                 back: Optional[QWidget] = None,
                 parent: Optional[QWidget] = None, *,
                 height: Optional[int] = None,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UFlipCard")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self._init_theme(settings, theme)
        self._flipped = False
        self._progress = 0.0
        self._animation: Optional[QVariantAnimation] = None
        if height:
            self.setMinimumHeight(height)

        self.front = front or QFrame(self)
        self.back = back or QFrame(self)
        for face, name in ((self.front, "UFlipFront"), (self.back, "UFlipBack")):
            face.setParent(self)
            face.setObjectName(name)
            face.setAttribute(Qt.WA_StyledBackground, True)
        self.front.setVisible(True)
        self.back.setVisible(False)

    # ---------- 翻转 ----------
    def is_flipped(self) -> bool:
        return self._flipped

    def flip(self) -> None:
        self.set_flipped(not self._flipped)

    def set_flipped(self, flipped: bool, *, animate: bool = True) -> None:
        flipped = bool(flipped)
        target = 1.0 if flipped else 0.0
        if not animate or abs(self._progress - target) < 0.01:
            self._flipped = flipped
            self._progress = target
            self._apply_progress(target)
            self.flipped.emit(flipped)
            return
        self._animation = motion.animate_value(
            self._progress, target, dur="panel", easing="page", parent=self,
            on_update=self._apply_progress,
            on_done=lambda: self._on_done(flipped))
        if self._animation is None:
            self._flipped = flipped
            self._apply_progress(target)
            self.flipped.emit(flipped)

    def _on_done(self, flipped: bool) -> None:
        self._flipped = flipped
        self._apply_progress(1.0 if flipped else 0.0)
        self.flipped.emit(flipped)

    def _apply_progress(self, ratio: float) -> None:
        self._progress = max(0.0, min(1.0, float(ratio)))
        half = self._progress >= 0.5
        self.front.setVisible(not half)
        self.back.setVisible(half)
        self._layout_faces()

    def _layout_faces(self) -> None:
        scale = abs(math.cos(math.pi * self._progress))
        width = max(0, int(round(self.width() * scale)))
        offset = (self.width() - width) // 2
        geometry = (offset, 0, width, self.height())
        self.front.setGeometry(*geometry)
        self.back.setGeometry(*geometry)

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        self._layout_faces()

    def showEvent(self, event) -> None:  # noqa: N802
        super().showEvent(event)
        self._layout_faces()


class USwipeConfirm(ThemedMixin, QFrame):
    """滑动确认条：滑过阈值（默认 80%）才触发，不到就回弹。

    关键点：松手时不是「直接归零」，而是动画回弹 —— 用户能看到自己没滑够。
    """

    confirmed = Signal()

    def __init__(self, text: str = "滑动确认", parent: Optional[QWidget] = None, *,
                 threshold: float = 0.8, height: int = 48,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("USwipeConfirm")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setFixedHeight(height)
        self.setMinimumWidth(200)
        self._threshold = max(0.3, min(0.95, float(threshold)))
        self._progress = 0.0
        self._dragging = False
        self._locked = False
        self._text = text
        self.setCursor(Qt.PointingHandCursor)
        self.setAccessibleName(text)
        self._animation: Optional[QVariantAnimation] = None
        self._init_theme(settings, theme)

    # ---------- 状态 ----------
    def progress(self) -> float:
        return self._progress

    def set_text(self, text: str) -> None:
        self._text = text
        self.setAccessibleName(text)
        self.update()

    def reset(self) -> None:
        self._locked = False
        self._animate_to(0.0)

    def _animate_to(self, target: float) -> None:
        self._animation = motion.animate_value(
            self._progress, target, dur="fast", easing="spring", parent=self,
            on_update=self._set_progress)
        if self._animation is None:
            self._set_progress(target)

    def _set_progress(self, ratio: float) -> None:
        self._progress = max(0.0, min(1.0, float(ratio)))
        self.update()

    # ---------- 交互 ----------
    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.LeftButton and not self._locked:
            self._dragging = True
            self._update_from_pos(event.position().x())
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if self._dragging:
            self._update_from_pos(event.position().x())
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if not self._dragging:
            super().mouseReleaseEvent(event)
            return
        self._dragging = False
        if self._progress >= self._threshold:
            self._locked = True
            self._animate_to(1.0)
            self.confirmed.emit()
        else:
            self._animate_to(0.0)        # 没滑够：回弹
        super().mouseReleaseEvent(event)

    def _update_from_pos(self, x: float) -> None:
        travel = max(1.0, self.width() - self.height())
        self._set_progress((float(x) - self.height() / 2.0) / travel)

    # ---------- 绘制 ----------
    def paintEvent(self, event: QPaintEvent) -> None:  # noqa: N802
        tokens = self.theme_tokens()
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        radius = self.height() / 2.0
        track = QRectF(0, 0, self.width(), self.height())

        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor(tokens.get("control-pressed", "#E8EFEB")))
        painter.drawRoundedRect(track, radius, radius)

        # 已滑过的填充：滑够阈值时直接转成实底强调色，给一个"解锁"的视觉信号
        done = self._progress >= self._threshold
        fill_color = tokens.get("accent-solid" if done else "accent-soft",
                                tokens.get("accent", "#0D9488"))
        fill = QRectF(0, 0, max(self.height(), self.width() * self._progress),
                      self.height())
        painter.setBrush(QColor(fill_color))
        painter.drawRoundedRect(fill, radius, radius)

        handle = self.height() - 8
        travel = self.width() - self.height()
        cx = self.height() / 2.0 + travel * self._progress
        painter.setBrush(QColor(tokens.get("layer", "#FFFFFF")))
        painter.drawEllipse(QPointF(cx, self.height() / 2.0), handle / 2.0, handle / 2.0)

        painter.setPen(QPen(QColor(tokens.get("accent" if done else "fg2", "#0D9488"))))
        painter.drawText(track, Qt.AlignCenter,
                         "已确认" if done else self._text)
        painter.end()

    def restyle(self) -> None:
        self.update()


# ============================ 操作型卡片 ============================
class UActionCard(ThemedMixin, QFrame):
    """带操作区的卡片：加减 / 开关 / 滑块就地生效，并回显结果。

    「就地生效」= 每个控件的变更立刻通过 valueChanged 抛出，同时在卡片底部
    回显当前值，不需要额外的确认按钮。
    """

    valueChanged = Signal(str, object)

    def __init__(self, title: str = "", subtitle: str = "",
                 parent: Optional[QWidget] = None, *,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UActionCard")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self._init_theme(settings, theme)
        self._values: Dict[str, object] = {}
        self._labels: Dict[str, str] = {}

        root = QVBoxLayout(self)
        root.setContentsMargins(16, 14, 16, 14)
        root.setSpacing(10)
        if title:
            head = QLabel(title, self)
            head.setObjectName("UActionCardTitle")
            root.addWidget(head)
        if subtitle:
            note = QLabel(subtitle, self)
            note.setObjectName("UActionCardSubtitle")
            note.setWordWrap(True)
            root.addWidget(note)
        self._rows = QVBoxLayout()
        self._rows.setSpacing(8)
        root.addLayout(self._rows)

        self.result = QLabel("", self)
        self.result.setObjectName("UActionCardResult")
        self.result.setWordWrap(True)
        root.addWidget(self.result)

    def _row(self, label: str) -> QHBoxLayout:
        row = QHBoxLayout()
        row.setSpacing(8)
        name = QLabel(label, self)
        name.setObjectName("UActionCardLabel")
        row.addWidget(name)
        row.addStretch(1)
        self._rows.addLayout(row)
        return row

    def _publish(self, key: str, value: object) -> None:
        self._values[key] = value
        self._refresh_result()
        self.valueChanged.emit(key, value)

    def add_stepper(self, key: str, label: str, value: int = 0, *,
                    minimum: int = 0, maximum: int = 99, step: int = 1) -> QLabel:
        row = self._row(label)
        value_label = QLabel(str(value), self)
        value_label.setObjectName("UActionCardValue")
        value_label.setAlignment(Qt.AlignCenter)
        value_label.setMinimumWidth(36)
        minus = UButton("-", tone="subtle", size="compact",
                        settings=self._ui_settings, theme=self._ui_theme)
        plus = UButton("+", tone="subtle", size="compact",
                       settings=self._ui_settings, theme=self._ui_theme)
        minus.setAccessibleName("减少 %s" % label)
        plus.setAccessibleName("增加 %s" % label)

        def apply(delta: int) -> None:
            current = int(self._values.get(key, value))
            nxt = max(minimum, min(maximum, current + delta))
            if nxt == current:
                return
            value_label.setText(str(nxt))
            self._publish(key, nxt)

        minus.clicked.connect(lambda: apply(-step))
        plus.clicked.connect(lambda: apply(step))
        row.addWidget(minus)
        row.addWidget(value_label)
        row.addWidget(plus)
        self._values[key] = value
        self._labels[key] = label
        self._refresh_result()
        return value_label

    def add_switch(self, key: str, label: str, checked: bool = False) -> "UToggleSwitch":
        row = self._row(label)
        switch = UToggleSwitch(checked, tooltip=label, settings=self._ui_settings,
                               theme=self._ui_theme)
        switch.toggled.connect(lambda state, k=key: self._publish(k, bool(state)))
        row.addWidget(switch)
        self._values[key] = bool(checked)
        self._labels[key] = label
        self._refresh_result()
        return switch

    def add_slider(self, key: str, label: str, value: int = 0, *,
                   minimum: int = 0, maximum: int = 100) -> "USlider":
        row = self._row(label)
        slider = USlider(value, minimum=minimum, maximum=maximum, label=label,
                         settings=self._ui_settings, theme=self._ui_theme)
        slider.setMinimumWidth(140)
        readout = QLabel(str(value), self)
        readout.setObjectName("UActionCardValue")
        readout.setMinimumWidth(36)
        readout.setAlignment(Qt.AlignCenter)

        def on_change(current: int) -> None:
            readout.setText(str(current))
            self._publish(key, int(current))

        slider.valueChanged.connect(on_change)
        row.addWidget(slider)
        row.addWidget(readout)
        self._values[key] = int(value)
        self._labels[key] = label
        self._refresh_result()
        return slider

    def value(self, key: str, default: object = None) -> object:
        return self._values.get(key, default)

    def values(self) -> Dict[str, object]:
        return dict(self._values)

    def set_result(self, text: str) -> None:
        self.result.setText(text)

    def _refresh_result(self) -> None:
        """就地回显：每改一次刷新一次汇总（业务可用 set_result 覆盖）。"""
        parts = []
        for key, label in self._labels.items():
            value = self._values.get(key)
            if isinstance(value, bool):
                value = "开" if value else "关"
            parts.append("%s %s" % (label, value))
        if parts:
            self.result.setText(" · ".join(parts))


# ============================ 筛选胶囊 ============================
class UFilterChips(ThemedMixin, QFrame):
    """筛选胶囊：选中态实底，超出宽度横向滚动。"""

    selectionChanged = Signal(list)

    def __init__(self, parent: Optional[QWidget] = None, *, multiple: bool = True,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UFilterChips")
        self._init_theme(settings, theme)
        self._multiple = bool(multiple)
        self._chips: List[UButton] = []
        self._keys: List[str] = []

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        self._scroll = QScrollArea(self)
        self._scroll.setObjectName("UFilterChipsScroll")
        self._scroll.setWidgetResizable(True)
        self._scroll.setFrameShape(QScrollArea.NoFrame)
        self._scroll.setFixedHeight(token_px(self, 'control-h-large', 36)
                                   + token_px(self, 'space-1', 4) * 2)
        self._scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self._scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        track = QWidget()
        track.setObjectName("UFilterChipsTrack")
        self._row = QHBoxLayout(track)
        self._row.setContentsMargins(0, 0, 0, 0)
        self._row.setSpacing(8)
        self._row.addStretch(1)
        self._scroll.setWidget(track)
        root.addWidget(self._scroll)

    def add_chip(self, text: str, key: Optional[str] = None, *,
                 selected: bool = False) -> UButton:
        chip = UButton(text, tone="accent" if selected else "subtle",
                       kind="solid" if selected else "ghost", size="compact",
                       settings=self._ui_settings, theme=self._ui_theme)
        chip.setCheckable(True)
        chip.setChecked(selected)
        chip.setAccessibleName(text)
        chip.clicked.connect(lambda _c=False, c=chip: self._on_chip_clicked(c))
        self._row.insertWidget(len(self._chips), chip)
        self._chips.append(chip)
        self._keys.append(key if key is not None else text)
        return chip

    def _on_chip_clicked(self, chip: UButton) -> None:
        if self._multiple:
            chip.setChecked(not chip.isChecked())
        else:
            for other in self._chips:
                other.setChecked(other is chip)
        self._restyle_chips()
        self.selectionChanged.emit(self.selected())

    def _restyle_chips(self) -> None:
        for chip in self._chips:
            active = chip.isChecked()
            chip.set_tone("accent" if active else "subtle")
            chip.set_kind("solid" if active else "ghost")

    def keys(self) -> List[str]:
        return list(self._keys)

    def selected(self) -> List[str]:
        return [self._keys[i] for i, chip in enumerate(self._chips) if chip.isChecked()]

    def set_selected(self, keys: Sequence[str]) -> None:
        wanted = {str(k) for k in keys}
        for index, chip in enumerate(self._chips):
            chip.setChecked(self._keys[index] in wanted)
        self._restyle_chips()
        self.selectionChanged.emit(self.selected())

    def clear(self) -> None:
        for chip in self._chips:
            chip.setChecked(False)
        self._restyle_chips()
        self.selectionChanged.emit([])


# ============================ 进度卡片 ============================
class _StepTrack(ThemedMixin, QWidget):
    """节点链自绘：done / current / pending 三态。"""

    clicked = Signal(int)

    def __init__(self, parent: Optional[QWidget] = None, *,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UStepTrack")
        self.setFixedHeight(token_px(self, 'control-h', 34))
        self._count = 0
        self._current = 0
        self._init_theme(settings, theme)

    def set_steps(self, count: int, current: int) -> None:
        self._count = max(0, int(count))
        self._current = int(current)
        self.update()

    def _centers(self) -> List[int]:
        if self._count <= 0:
            return []
        if self._count == 1:
            return [self.width() // 2]
        span = max(1, self.width() - 24)
        return [12 + int(span * i / (self._count - 1)) for i in range(self._count)]

    def mousePressEvent(self, event) -> None:  # noqa: N802
        centers = self._centers()
        if centers:
            nearest = min(range(len(centers)),
                          key=lambda i: abs(centers[i] - event.position().x()))
            self.clicked.emit(nearest)
        super().mousePressEvent(event)

    def paintEvent(self, event) -> None:  # noqa: N802
        tokens = self.theme_tokens()
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        centers = self._centers()
        mid = self.height() / 2.0
        accent = QColor(tokens.get("accent-solid", "#0D9488"))
        pending = QColor(tokens.get("track", tokens.get("control-pressed", "#E8EFEB")))

        for i in range(len(centers) - 1):
            painter.setPen(Qt.NoPen)
            painter.setBrush(accent if i < self._current else pending)
            painter.drawRoundedRect(
                QRectF(centers[i], mid - 1.5, centers[i + 1] - centers[i], 3), 1.5, 1.5)

        for i, cx in enumerate(centers):
            if i < self._current:
                painter.setBrush(accent)
                painter.setPen(Qt.NoPen)
                painter.drawEllipse(QPointF(cx, mid), 6, 6)
            elif i == self._current:
                painter.setBrush(QColor(tokens.get("layer", "#FFFFFF")))
                painter.setPen(QPen(accent, 3))
                painter.drawEllipse(QPointF(cx, mid), 8, 8)
                painter.setPen(Qt.NoPen)
                painter.setBrush(accent)
                painter.drawEllipse(QPointF(cx, mid), 3, 3)
            else:
                painter.setBrush(QColor(tokens.get("layer", "#FFFFFF")))
                painter.setPen(QPen(pending, 2))
                painter.drawEllipse(QPointF(cx, mid), 6, 6)
        painter.end()


class UProgressCard(ThemedMixin, QFrame):
    """进度卡片：节点分三态，当前节点高亮并展开详情。"""

    stepActivated = Signal(int)

    def __init__(self, title: str = "", parent: Optional[QWidget] = None, *,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UProgressCard")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self._init_theme(settings, theme)
        self._steps: List[tuple] = []
        self._current = 0
        self._detail_effect: Optional[QGraphicsOpacityEffect] = None

        root = QVBoxLayout(self)
        root.setContentsMargins(16, 14, 16, 14)
        root.setSpacing(10)
        if title:
            head = QLabel(title, self)
            head.setObjectName("UProgressCardTitle")
            root.addWidget(head)

        self.track = _StepTrack(self, settings=settings, theme=theme)
        self.track.clicked.connect(self.set_current)
        root.addWidget(self.track)

        self.caption = QLabel("", self)
        self.caption.setObjectName("UProgressCardCaption")
        root.addWidget(self.caption)

        self.detail = QLabel("", self)
        self.detail.setObjectName("UProgressCardDetail")
        self.detail.setWordWrap(True)
        self.detail.setMaximumHeight(0)
        self._detail_effect = QGraphicsOpacityEffect(self.detail)
        self.detail.setGraphicsEffect(self._detail_effect)
        root.addWidget(self.detail)

    def set_steps(self, steps: Sequence) -> None:
        """steps: [(标题, 详情), ...]"""
        self._steps = [(str(item[0]), str(item[1]) if len(item) > 1 else "")
                       for item in steps]
        self.track.set_steps(len(self._steps), self._current)
        self._sync(animate=False)

    def current(self) -> int:
        return self._current

    def set_current(self, index: int, *, animate: bool = True) -> None:
        if not (0 <= index < len(self._steps)):
            return
        changed = index != self._current
        self._current = index
        self.track.set_steps(len(self._steps), index)
        self._sync(animate=animate)
        if changed:
            self.stepActivated.emit(index)

    def _sync(self, *, animate: bool) -> None:
        if not self._steps:
            return
        title, detail = self._steps[self._current]
        self.caption.setText("%d / %d · %s" % (self._current + 1, len(self._steps), title))
        self.detail.setText(detail)
        target = max(24, self.detail.sizeHint().height())

        def apply(ratio: float) -> None:
            self.detail.setMaximumHeight(int(target * ratio))
            if self._detail_effect is not None:
                self._detail_effect.setOpacity(ratio)

        if animate:
            motion.animate_value(0.0, 1.0, dur="fast", easing="standard", parent=self,
                                 on_update=apply)
        else:
            apply(1.0)


# ============================ 吸底操作栏 ============================
class UBottomBar(ThemedMixin, QFrame):
    """吸底操作栏：左边关键信息，右边主按钮，并避开底部安全区。

    safe_margin 是底部额外留白（安全区）：整条栏的高度 = 内容高度 + 安全区，
    内容本身垂直居中在安全区之上，不会被 home indicator / 系统边条压住。
    """

    actionTriggered = Signal()

    def __init__(self, title: str = "", subtitle: str = "",
                 parent: Optional[QWidget] = None, *, action_text: str = "",
                 safe_margin: int = 0,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UBottomBar")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self._init_theme(settings, theme)
        self._safe = max(0, int(safe_margin))

        root = QHBoxLayout(self)
        root.setContentsMargins(16, 10, 16, 10 + self._safe)
        root.setSpacing(12)

        texts = QVBoxLayout()
        texts.setSpacing(2)
        self.title = QLabel(title, self)
        self.title.setObjectName("UBottomBarTitle")
        texts.addWidget(self.title)
        self.subtitle = QLabel(subtitle, self)
        self.subtitle.setObjectName("UBottomBarSubtitle")
        self.subtitle.setVisible(bool(subtitle))
        texts.addWidget(self.subtitle)
        root.addLayout(texts)
        root.addStretch(1)

        self._action = UButton(action_text or "确定", tone="accent",
                               settings=self._ui_settings, theme=self._ui_theme)
        self._action.clicked.connect(self.actionTriggered.emit)
        self._action.setVisible(bool(action_text))
        root.addWidget(self._action)

    def set_title(self, text: str) -> None:
        self.title.setText(text)

    def set_subtitle(self, text: str) -> None:
        self.subtitle.setText(text)
        self.subtitle.setVisible(bool(text))

    def set_action_text(self, text: str) -> None:
        self._action.setText(text)
        self._action.setAccessibleName(text)
        self._action.setVisible(bool(text))

    def action_button(self) -> UButton:
        return self._action

    def add_before_action(self, widget: QWidget) -> QWidget:
        """在主动作左边插入次要控件（如「取消」）。"""
        layout = self.layout()
        layout.insertWidget(layout.count() - 1, widget)
        return widget

    def safe_margin(self) -> int:
        return self._safe

    def attach_to(self, layout, stretch: int = 0):
        """挂到底部：调用方只需 attach_to(页面布局)，不必自己记插入位置。"""
        layout.addWidget(self, stretch)
        return self


# ============================ 格式化输入框 ============================
class UMaskedInput(ThemedMixin, QFrame):
    """带格式化的输入框：日期 / 时间自动分隔，右侧长驻单位与字数。

    mask 里 # 表示一个可输入位，其余字符是自动插入的分隔符。例如：
        ####-##-##   -> 20260913 显示为 2026-09-13
        ##:##        -> 0930 显示为 09:30
    右侧的「单位」与「字数」常驻显示，不随输入消失。
    """

    textChanged = Signal(str)

    def __init__(self, mask: str = "", parent: Optional[QWidget] = None, *,
                 placeholder: str = "", unit: str = "", max_length: int = 0,
                 label: str = "", show_counter: bool = True,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UMaskedInput")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self._init_theme(settings, theme)
        self._mask = mask or ""
        self._limit = max_length or self._mask.count("#") or 0
        self._guard = False

        root = QHBoxLayout(self)
        root.setContentsMargins(10, 0, 8, 0)
        root.setSpacing(6)

        self.input = ULineEdit("", placeholder, self, clearable=False,
                               settings=settings, theme=theme)
        self.input.setObjectName("UMaskedField")
        self.input.setAccessibleName(label or placeholder or "输入")
        root.addWidget(self.input, 1)

        self.unit = QLabel(unit, self)
        self.unit.setObjectName("UMaskedUnit")
        self.unit.setVisible(bool(unit))
        root.addWidget(self.unit)

        self.counter = QLabel("", self)
        self.counter.setObjectName("UMaskedCounter")
        self.counter.setVisible(bool(show_counter and self._limit))
        root.addWidget(self.counter)

        self.input.textEdited.connect(self._on_edited)
        self.input.textChanged.connect(self._on_changed)
        self._refresh_counter()

    # ---------- 值 ----------
    def raw_text(self) -> str:
        """去掉分隔符的原始值（业务提交时用这个）。"""
        return "".join(ch for ch in self.input.text() if ch.isalnum())

    def text(self) -> str:
        return self.input.text()

    def set_text(self, value: str) -> None:
        self._guard = True
        self.input.setText(self._format(str(value)))
        self._guard = False
        self._refresh_counter()

    def clear(self) -> None:
        self.input.clear()

    def set_unit(self, unit: str) -> None:
        self.unit.setText(unit)
        self.unit.setVisible(bool(unit))

    def setFocus(self) -> None:  # noqa: N802
        self.input.setFocus()

    # ---------- 格式化 ----------
    def _format(self, raw: str) -> str:
        value = "".join(ch for ch in raw if ch.isalnum())
        if self._limit:
            value = value[:self._limit]
        if not self._mask:
            return value
        out: List[str] = []
        index = 0
        for token in self._mask:
            if index >= len(value):
                break
            if token == "#":
                out.append(value[index])
                index += 1
            else:
                out.append(token)
        return "".join(out)

    def _on_edited(self, _text: str) -> None:
        if self._guard:
            return
        formatted = self._format(self.input.text())
        if formatted != self.input.text():
            self._guard = True
            self.input.setText(formatted)
            self.input.setCursorPosition(len(formatted))
            self._guard = False
        self._refresh_counter()

    def _on_changed(self, text: str) -> None:
        self._refresh_counter()
        if not self._guard:
            self.textChanged.emit(text)

    def _refresh_counter(self) -> None:
        if not self._limit:
            return
        self.counter.setText("%d/%d" % (len(self.raw_text()), self._limit))

