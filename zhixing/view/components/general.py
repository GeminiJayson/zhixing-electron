# -*- coding: utf-8 -*-
"""通用小组件：空状态、标签 chip、概览卡、区块标题。"""
from typing import List, Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QFont
from PySide6.QtWidgets import (QFrame, QHBoxLayout, QVBoxLayout, QWidget, QSizePolicy)

from ..kit import icons, motion
from ..ui import UCard
from zhixing.view.kit.fluent_compat import QLabel, QPushButton


def _fg2() -> str:
    from qfluent_core import ThemeManager as ThemeEngine
    eng = ThemeEngine.instance()
    return eng.t("fg2", "#6B7280") if eng else "#6B7280"


def _accent() -> str:
    from qfluent_core import ThemeManager as ThemeEngine
    eng = ThemeEngine.instance()
    return eng.t("accent", "#0D9488") if eng else "#0D9488"


class IconWidget(QWidget):
    """SVG 图标显示组件（自动跟随主题色）。"""

    def __init__(self, name: str, size: int = 20, color: Optional[str] = None, parent=None):
        super().__init__(parent)
        self.name, self.size = name, size
        self._color = color
        self.setFixedSize(size, size)
        self.setAccessibleName(name)   # 13b：图标控件可被读屏识别
        self.setAccessibleDescription(name)

    def color(self) -> str:
        if self._color:
            return self._color
        return _fg2()

    def set_icon(self, name: str):
        self.name = name
        self.update()

    def set_color(self, color: Optional[str]):
        self._color = color
        self.update()

    def paintEvent(self, ev):  # noqa: N802
        from PySide6.QtGui import QPainter
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        pm = icons.pixmap(self.name, self.color(), self.size,
                          self.devicePixelRatioF())
        p.drawPixmap(0, 0, self.width(), self.height(), pm)
        p.end()


class EmptyState(QWidget):
    """空状态：大图标 + 一句人话 + 主行动按钮。"""

    def __init__(self, icon_name: str, text: str, action_text: str = "",
                 parent=None, on_action=None):
        super().__init__(parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(24, 32, 24, 32)
        lay.setSpacing(12)
        lay.setAlignment(Qt.AlignCenter)

        big = IconWidget(icon_name, 44)
        big.setFixedHeight(48)
        lay.addWidget(big, alignment=Qt.AlignCenter)

        lbl = QLabel(text)
        lbl.setAlignment(Qt.AlignCenter)
        lbl.setStyleSheet(f"color: {_fg2()}; font-size: 13px; background: transparent;")
        lay.addWidget(lbl)

        if action_text and on_action:
            from ..ui import UButton  # A 路线统一按钮，随主题自愈（替代旧 PrimaryPushButton）
            btn = UButton(action_text, tone="accent", kind="solid")
            btn.clicked.connect(on_action)
            wrap = QHBoxLayout()
            wrap.addStretch(1)
            wrap.addWidget(btn)
            wrap.addStretch(1)
            lay.addLayout(wrap)


class TagChip(QPushButton):
    """彩色标签 chip。"""

    def __init__(self, name: str, color: str = "#0D9488", parent=None, removable=False):
        super().__init__(f"#{name}", parent)
        self.tag_name, self.color_hex = name, color
        if removable:
            self.setToolTip(f"点击移除 #{name}")
            from ..kit import icons
            self.setIcon(icons.icon("action.close", color, 12))
        self.setFlat(True)
        self.setCursor(Qt.PointingHandCursor)
        self._apply()

    def _apply(self):
        from qfluent_core import ThemeManager as ThemeEngine
        eng = ThemeEngine.instance()
        soft = _mix(self.color_hex, "#FFFFFF", 0.18) if not (eng and eng.mode == "dark") \
            else _mix(self.color_hex, "#1E1E1E", 0.35)
        self.setStyleSheet(
            f"QPushButton {{ background: {soft}; color: {self.color_hex}; border: none;"
            f"border-radius: 10px; padding: 2px 10px; font-size: 12px; }}"
            f"QPushButton:hover {{ background: {self.color_hex}; color: white; }}")


def _mix(c1, c2, r):
    a, b = QColor(c1), QColor(c2)
    return QColor(int(a.redF() * r + b.redF() * (1 - r) * 255),
                  int(a.greenF() * r + b.greenF() * (1 - r) * 255),
                  int(a.blueF() * r + b.blueF() * (1 - r) * 255)).name()


class TagBar(QFrame):
    changed = Signal()

    def __init__(self, tags: List = None, parent=None):
        super().__init__(parent)
        self._lay = QHBoxLayout(self)
        self._lay.setContentsMargins(0, 0, 0, 0)
        self._lay.setSpacing(6)
        self._lay.addStretch(1)
        self.set_tags(tags or [])

    def set_tags(self, tags: List):
        while self._lay.count() > 1:
            item = self._lay.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        for name, color in tags:
            chip = TagChip(name, color)
            self._lay.insertWidget(self._lay.count() - 1, chip)


class StatCard(UCard):
    """概览卡（沉浸同族）：图标+数字+标题，可点击；沿用 UCard 无框/羽影/顶光自绘。"""

    clicked = Signal()

    def __init__(self, icon_name: str, title: str, color: str, parent=None):
        super().__init__(title="", parent=parent)
        self.color_hex = color
        self.title = title
        self.setCursor(Qt.PointingHandCursor)
        # 内部紧凑压缩 —— 放进单个 pack 再 body(0) 让 icon/数字/标题紧密贴合
        pack = QWidget()
        inner = QVBoxLayout(pack)
        inner.setContentsMargins(2, 2, 2, 2)
        inner.setSpacing(1)
        top = QHBoxLayout()
        top.setSpacing(6)
        self._icon = IconWidget(icon_name, 16, color)
        top.addWidget(self._icon)
        top.addStretch(1)
        inner.addLayout(top)
        self.num_label = QLabel("0")
        self.num_label.setAlignment(Qt.AlignLeft)
        inner.addWidget(self.num_label)
        self.title_label = QLabel(title)
        self.title_label.setAlignment(Qt.AlignLeft)
        inner.addWidget(self.title_label)
        self.add_widget(pack, 1)
        # 紧凑内边距必须走框架 API：直接改 body_layout 会被 restyle()（换肤/换设置）抹掉
        self.set_body_margins(10, 4, 10, 4)
        self._restyle_ui()

    def _num_qss(self) -> str:
        # 字号/字重只能写在样式表里：Qt 的 QSS 优先级高于 setFont()，
        # 全局 QLabel 规则会把 setFont 设的大字号压回 14px（数字被压扁、糊在一起）
        from qfluent_core import ThemeManager as ThemeEngine
        eng = ThemeEngine.instance()
        size = eng.t("font-size-title", "20px") if eng else "20px"
        weight = eng.t("font-weight-strong", "600") if eng else "600"
        return (f"color: {self.color_hex}; background: transparent;"
                f" font-size: {size}; font-weight: {weight};")

    def _restyle_ui(self):
        super()._restyle_ui()
        if not hasattr(self, "title_label"):
            return
        from qfluent_core import ThemeManager as ThemeEngine
        eng = ThemeEngine.instance()
        small = eng.t("font-size-sm", "12px") if eng else "12px"
        self.num_label.setStyleSheet(self._num_qss())
        self.title_label.setStyleSheet(
            f"color: {_fg2()}; font-size: {small}; background: transparent;")

    def set_value(self, v: int):
        motion.number_roller(self.num_label, int(v))

    def set_tone(self, color: str):
        self.color_hex = color
        self._icon.set_icon(self._icon.name)
        self.num_label.setStyleSheet(self._num_qss())

    def mouseReleaseEvent(self, ev):  # noqa: N802
        if ev.button() == Qt.LeftButton:
            self.clicked.emit()
        super().mouseReleaseEvent(ev)


class SectionHeader(QWidget):
    """区块标题 + 右侧动作区。"""

    def __init__(self, text: str, parent=None):
        super().__init__(parent)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 4, 0, 4)
        self.label = QLabel(text)
        f = QFont()
        f.setPixelSize(15)
        f.setBold(True)
        self.label.setFont(f)
        self.label.setStyleSheet("background: transparent;")
        lay.addWidget(self.label)
        lay.addStretch(1)
        self.action_lay = lay

    def add_action(self, w: QWidget):
        self.action_lay.addWidget(w)


def shake(widget: QWidget, distance: int = 5) -> None:
    """循环子任务重置抖动提示（9e）：横向小幅抖动，尊重 reduce-motion。

    触发方在「循环任务的子任务因翻篇而重建」时调用，给用户一个视觉提示。
    """
    if not motion.motion_enabled():
        return
    from PySide6.QtCore import QAbstractAnimation, QEasingCurve, QPoint, QPropertyAnimation
    geo = widget.geometry()
    origin = geo.topLeft()
    anim = QPropertyAnimation(widget, b"pos", widget)
    anim.setDuration(320)
    anim.setStartValue(origin)
    anim.setKeyValueAt(0.2, origin + QPoint(distance, 0))
    anim.setKeyValueAt(0.4, origin + QPoint(-distance, 0))
    anim.setKeyValueAt(0.6, origin + QPoint(distance // 2, 0))
    anim.setKeyValueAt(0.8, origin + QPoint(-distance // 2, 0))
    anim.setEndValue(origin)
    anim.setEasingCurve(QEasingCurve.InOutQuad)
    anim.start(QAbstractAnimation.DeleteWhenStopped)
    try:
        widget._zhixing_shake = anim  # 保持引用，防被 GC 提前回收
    except Exception:
        pass
