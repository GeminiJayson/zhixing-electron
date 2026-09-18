# -*- coding: utf-8 -*-
"""动作类组件：按钮、图标按钮、开关、分段控件。

设计约束（对齐 Fluent 控件选择规范）：
- 一个局部决策区只允许一个 accent 主动作；普通动作用 standard，低强调用 subtle；
- 破坏性动作常态中性，hover/确认才转红，不做永久大红；
- 图标按钮必须带可读标签（tooltip 为必填参数），保证无障碍。
"""
from __future__ import annotations

from typing import Callable, List, Optional, Tuple

from PySide6.QtCore import (
    Property, QEasingCurve, QPoint, QPropertyAnimation, QSize, Qt, Signal,
)
from PySide6.QtGui import QColor, QIcon, QMouseEvent, QPainter, QPaintEvent, QPen
from PySide6.QtWidgets import (
    QButtonGroup, QCheckBox, QFrame, QHBoxLayout, QPushButton, QToolButton, QWidget,
)

from ..settings import UISettings
from ..theme import ThemeManager
from .. import motion
from .base import KINDS, SIZES, TONES, ThemedMixin

__all__ = ["UButton", "UIconButton", "UToggleSwitch", "USegmentedControl",
           "UColorSwatch"]


class UButton(ThemedMixin, QPushButton):
    """语义按钮。UButton("保存", tone="accent")

    tone: standard | accent | subtle | danger | warn | success | info
    kind: solid | ghost
    size: compact | standard | large
    """

    def __init__(self, text: str = "", tone: str = "standard", kind: str = "solid",
                 size: str = "standard", parent: Optional[QWidget] = None, *,
                 icon: Optional[QIcon] = None,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(text or "", parent)
        self.setObjectName("UButton")
        self.setCursor(Qt.PointingHandCursor)
        self.setFocusPolicy(Qt.StrongFocus)
        if icon is not None and not icon.isNull():
            self.setIcon(icon)
        self.setProperty("tone", tone if tone in TONES else "standard")
        self.setProperty("kind", kind if kind in KINDS else "solid")
        # 属性名用 uiSize 而非 size：QWidget 自带 size（QSize）内建属性，
        # 同名会让 QSS 属性选择器读到 QSize，变体样式永远不生效。
        self.setProperty("uiSize", size if size in SIZES else "standard")
        self.setProperty("pressed", "false")
        if text:
            self.setAccessibleName(text)
        self._init_theme(settings, theme)
        self.restyle()

    # ---------- 变体 ----------
    def set_tone(self, tone: str) -> None:
        self._set_variant("tone", tone, TONES)

    def set_kind(self, kind: str) -> None:
        self._set_variant("kind", kind, KINDS)

    def set_size(self, size: str) -> None:
        self._set_variant("uiSize", size, SIZES)
        self.restyle()

    @property
    def tone(self) -> str:
        return str(self.property("tone"))

    # ---------- 按压反馈（QSS 无 transform，用属性切换内缩） ----------
    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if event.button() == Qt.LeftButton:
            self._set_pressed(True)
        super().mousePressEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        self._set_pressed(False)
        super().mouseReleaseEvent(event)

    def leaveEvent(self, event) -> None:  # noqa: N802
        self._set_pressed(False)
        super().leaveEvent(event)

    def _set_pressed(self, pressed: bool) -> None:
        value = "true" if pressed else "false"
        if self.property("pressed") != value:
            self.setProperty("pressed", value)
            self.repolish()

    def _render_hover_css(self) -> None:
        pass

    def _render_hover_css_t(self) -> None:
        pass

    def _start_hover_anim(self, *args) -> None:
        pass

    def restyle(self) -> None:
        size = int(self.theme_tokens().get("icon-size", "18px").replace("px", "") or 18)
        self.setIconSize(QSize(size, size))


class UIconButton(ThemedMixin, QToolButton):
    """图标按钮（工具栏/chrome）。tooltip 必填 —— 图标本身不构成可读标签。"""

    def __init__(self, icon: Optional[QIcon], tooltip: str,
                 parent: Optional[QWidget] = None, *, text: str = "",
                 size: str = "standard", checkable: bool = False,
                 role: str = "", on_click: Optional[Callable[[], None]] = None,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UIconButton")
        self.setCursor(Qt.PointingHandCursor)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setCheckable(checkable)
        self.setAutoRaise(True)
        self.setToolTip(tooltip)
        self.setAccessibleName(tooltip)
        if text:
            self.setText(text)
        if icon is not None and not icon.isNull():
            self.setIcon(icon)
            self.setToolButtonStyle(Qt.ToolButtonIconOnly)
        else:
            # 无图标时显示文字：QToolButton 默认 IconOnly 会让文字消失（只剩空占位）
            self.setToolButtonStyle(Qt.ToolButtonTextOnly)
        if role:
            self.setProperty("role", role)
        self.setProperty("uiSize", size if size in SIZES else "standard")
        if on_click is not None:
            self.clicked.connect(lambda _checked=False: on_click())
        self._init_theme(settings, theme)
        self.restyle()

    def set_size_variant(self, size: str) -> None:
        self._set_variant("uiSize", size, SIZES)
        self.restyle()

    def restyle(self) -> None:
        tokens = self.theme_tokens()
        key = "icon-size-sm" if self.property("uiSize") == "compact" else "icon-size"
        px = int(str(tokens.get(key, "18px")).replace("px", "") or 18)
        self.setIconSize(QSize(px, px))


class UToggleSwitch(ThemedMixin, QCheckBox):
    """持久设置开关（立即生效）。自绘滑轨 + 圆点，颜色全取 token。

    继承 QCheckBox：isChecked()/toggled/click 等 Qt 语义完整保留。
    """

    _KNOB_INSET = 2

    def __init__(self, checked: bool = False,
                 parent: Optional[QWidget] = None, *, tooltip: str = "",
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UToggleSwitch")
        self.setCheckable(True)
        self.setChecked(checked)
        self.setCursor(Qt.PointingHandCursor)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setText("")
        if tooltip:
            self.setToolTip(tooltip)
            self.setAccessibleName(tooltip)
        self._pos = 1.0 if checked else 0.0      # 0..1 圆点位置
        self._anim: Optional[QPropertyAnimation] = None
        self._init_theme(settings, theme)
        self.toggled.connect(self._animate_to_state)

    # ---------- 位置属性（供动画驱动） ----------
    def _get_pos(self) -> float:
        return self._pos

    def _set_pos(self, value: float) -> None:
        self._pos = max(0.0, min(1.0, float(value)))
        self.update()

    knobPos = Property(float, _get_pos, _set_pos)

    def _animate_to_state(self, checked: bool) -> None:
        from .. import motion
        target = 1.0 if checked else 0.0
        self._anim = motion.animate(self, "knobPos", self._pos, target,
                                    dur="fast", easing="standard")
        if self._anim is None:
            self._set_pos(target)

    # ---------- 自绘 ----------
    def paintEvent(self, event: QPaintEvent) -> None:  # noqa: N802
        tokens = self.theme_tokens()
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        height = 22
        width = 40
        x = 0
        y = max(0, (self.height() - height) // 2)
        radius = height / 2.0

        # 开关的滑轨同样是「轨道」语义，与进度条 / 滑块用同一个 token
        track = QColor(tokens.get("accent-solid", "#0D9488") if self.isChecked()
                       else tokens.get("track", tokens.get("control-pressed", "#E8EFEB")))
        border = QColor(tokens.get("accent-solid", "#0D9488") if self.isChecked()
                        else tokens.get("border2", "#C9D1D8"))
        if not self.isEnabled():
            track = QColor(tokens.get("control-disabled", "#F2F3F5"))
            border = QColor(tokens.get("border", "#E3E7EB"))
        painter.setPen(border)
        painter.setBrush(track)
        painter.drawRoundedRect(x, y, width, height, radius, radius)

        knob_d = height - 2 * self._KNOB_INSET
        travel = width - knob_d - 2 * self._KNOB_INSET
        knob_x = x + self._KNOB_INSET + travel * self._pos
        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor(tokens.get("accent-on", "#FFFFFF")))
        painter.drawEllipse(int(knob_x), y + self._KNOB_INSET, knob_d, knob_d)
        painter.end()

    def sizeHint(self) -> QSize:
        return QSize(40, 22)

    def restyle(self) -> None:
        self.update()


class UColorSwatch(ThemedMixin, QToolButton):
    """强调色色块（自绘圆点）。选中态用 fg 描边环，随主题自适应。

    颜色是实例数据而不是 token，所以用自绘而不是 QSS —— 避免为了一个实例值
    去 setStyleSheet 覆盖整份组件皮肤。
    """

    def __init__(self, color: str, parent: Optional[QWidget] = None, *,
                 tooltip: str = "", selected: bool = False, size: int = 24,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UColorSwatch")
        self._color = str(color)
        self.setCheckable(True)
        self.setChecked(selected)
        self.setCursor(Qt.PointingHandCursor)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setFixedSize(size, size)
        label = tooltip or self._color
        self.setToolTip(label)
        self.setAccessibleName(label)
        self.toggled.connect(lambda _checked: self.update())
        self._init_theme(settings, theme)

    def color(self) -> str:
        return self._color

    def paintEvent(self, event: QPaintEvent) -> None:  # noqa: N802
        tokens = self.theme_tokens()
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        inset = 2 if self.isChecked() else 1
        rect = self.rect().adjusted(inset, inset, -inset, -inset)
        painter.setBrush(QColor(self._color))
        pen = QPen(QColor(tokens.get("fg", "#1A1D21") if self.isChecked()
                          else tokens.get("border2", "#C9D1D8")))
        pen.setWidth(2 if self.isChecked() else 1)
        painter.setPen(pen)
        painter.drawEllipse(rect)
        painter.end()

    def sizeHint(self) -> QSize:
        return QSize(self.width(), self.height())


class USegmentedControl(ThemedMixin, QFrame):
    """分段控件：小集合邻近视图互斥切换（替代零散 radio/下拉）。

    信号 segmentChanged(index, key) —— 业务据此换数据，控件本身不含业务。
    """

    segmentChanged = Signal(int, str)

    def __init__(self, parent: Optional[QWidget] = None, *,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("USegmentedControl")
        # 容器本身不取焦点：焦点属于各分段按钮（各自带可读标签），
        # 避免出现「可聚焦但无标签」的控件（无障碍反模式）。
        self.setFocusPolicy(Qt.NoFocus)
        self._layout = QHBoxLayout(self)
        self._layout.setContentsMargins(2, 2, 2, 2)
        self._layout.setSpacing(2)
        self._group = QButtonGroup(self)
        self._group.setExclusive(True)
        self._keys: List[str] = []
        self._stack = None
        # 选中块（thumb）位于按钮之下，选中时用 geometry 动画跟过去 ——
        # 这样选中是「块在移动」，而不是「颜色跳变」。
        self._thumb = QFrame(self)
        self._thumb.setObjectName("USegmentThumb")
        self._thumb.setAttribute(Qt.WA_StyledBackground, True)
        self._thumb.lower()
        self._init_theme(settings, theme)

    def add_segment(self, text: str, key: Optional[str] = None) -> int:
        index = len(self._keys)
        button = QToolButton(self)
        button.setObjectName("USegmentButton")
        button.setText(text)
        button.setCheckable(True)
        button.setCursor(Qt.PointingHandCursor)
        button.setFocusPolicy(Qt.StrongFocus)
        button.setToolTip(text)
        button.setAccessibleName(text)
        button.setSizePolicy(button.sizePolicy().horizontalPolicy(),
                             button.sizePolicy().verticalPolicy())
        self._group.addButton(button, index)
        self._keys.append(key if key is not None else text)
        self._layout.addWidget(button)
        if index == 0:
            button.setChecked(True)
        self._group.idClicked.connect(self._on_clicked)
        if index == 0:
            self._sync_thumb(animate=False)
        return index

    def _on_clicked(self, index: int) -> None:
        self._sync_thumb(animate=True)
        self._switch_stack(index)
        self.segmentChanged.emit(index, self.current_key())

    def _sync_thumb(self, animate: bool = True) -> None:
        button = self._group.checkedButton()
        if button is None:
            return
        target = button.geometry()
        if animate:
            motion.animate(self._thumb, "geometry", self._thumb.geometry(), target,
                           dur="fast", easing="standard")
        else:
            self._thumb.setGeometry(target)
        # 滑块必须垫在按钮之下：按钮背景透明，滑块从下面透出来。
        # 若 raise_() 到按钮之上，就会盖住选中项的文字。
        self._thumb.lower()

    def bind_stack(self, stack) -> None:
        """与内容栈绑定：切换分段时内容区同步横向滑动（不是硬切）。"""
        self._stack = stack

    def _switch_stack(self, index: int) -> None:
        stack = self._stack
        if stack is None or not (0 <= index < stack.count()):
            return
        previous = stack.currentIndex()
        if index == previous:
            return
        old_page, new_page = stack.widget(previous), stack.widget(index)
        width = max(1, stack.width())
        direction = 1 if index > previous else -1
        stack.setCurrentIndex(index)
        if new_page is not None:
            new_page.move(direction * width, new_page.y())
            motion.animate(new_page, "pos", new_page.pos(), QPoint(0, new_page.y()),
                           dur="page", easing="page")
        if old_page is not None and old_page is not new_page:
            motion.animate(old_page, "pos", old_page.pos(),
                           QPoint(-direction * width, old_page.y()),
                           dur="page", easing="page")

    def showEvent(self, event) -> None:  # noqa: N802
        # 构造期按钮还没被布局，geometry 是默认值 —— 必须等真正显示后再对齐滑块
        super().showEvent(event)
        self._sync_thumb(animate=False)

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        self._sync_thumb(animate=False)

    def restyle(self) -> None:
        self._sync_thumb(animate=False)

    def current_index(self) -> int:
        return max(0, self._group.checkedId())

    def current_key(self) -> str:
        index = self.current_index()
        return self._keys[index] if 0 <= index < len(self._keys) else ""

    def set_current_index(self, index: int) -> None:
        button = self._group.button(index)
        if button is not None:
            button.setChecked(True)

    def segments(self) -> List[Tuple[int, str]]:
        return list(enumerate(self._keys))
