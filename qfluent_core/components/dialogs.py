# -*- coding: utf-8 -*-
"""对话框组件：无边框主题化弹层 + 确认框。

生命周期约定：UDialog 是「一次性浮层」，由调用方持有引用到 exec()/finished；
关闭后可正常被回收。框架不维护任何全局对话框注册表。
"""
from __future__ import annotations

from enum import IntEnum

from typing import Optional

from PySide6.QtCore import QPoint, QRect, Qt, Signal, QTimer, QSize
from PySide6.QtGui import QMouseEvent, QPainter, QPen, QColor, QPaintEvent
from PySide6.QtWidgets import (
    QDialog, QFrame, QHBoxLayout, QLabel, QToolButton, QVBoxLayout, QWidget,
)

from .. import icons
from .. import motion
from ..settings import UISettings
from ..theme import ThemeManager
from .actions import UButton
from .inputs import ULineEdit
from .text import UTitle
from ..platform import is_windows
from .base import ThemedMixin

__all__ = ["UDialog", "UConfirmDialog"]

_RESIZE_MARGIN = 6
#: 标题栏高度（宿主旧常量名，公开）
TITLE_BAR_H = 44
MIN_H = 180    # 通用最小高度（宿主旧常量）
COMPACT_TITLE_BAR_H = 34
#: 边缘拉伸命中宽度（公开给宿主使用）
RESIZE_MARGIN = _RESIZE_MARGIN


class UDialog(ThemedMixin, QDialog):
    """无边框主题化对话框：标题栏 + 正文 + 底部动作区，可拖动与边缘拉伸。"""

    def __init__(self, title: str = "", parent: Optional[QWidget] = None, *,
                 width: int = 460, height: int = 300, resizable: bool = False,
                 closable: bool = True,
                 # ---- 兼容宿主原有写法（原 zhixing view/ui/dialog.py）----
                 dialog_type: "DialogType" = None, icon_name: str = "",
                 tool: bool = False, show_title_bar: bool = True,
                 sticky: bool = False, auto_close_on_deactivate: bool = False,
                 compact_title: bool = False,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        if dialog_type is not None:
            resizable = dialog_type == DialogType.RESIZABLE
        self.dialog_type = dialog_type
        self.icon_name = icon_name
        self.compact_title = compact_title
        super().__init__(parent)
        self.setObjectName("UDialog")
        self.setWindowFlag(Qt.FramelessWindowHint, True)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setMouseTracking(True)
        self._resizable = resizable
        self._resize_edge = Qt.Edge(0)
        self._resize_geo = QRect()
        self._resize_global = QPoint()
        self._drag_offset: Optional[QPoint] = None
        self.resize(width, height)
        if not resizable:
            self.setFixedSize(width, height)
        self._init_theme(settings, theme)

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # 标题栏
        self.title_bar = QFrame(self)
        self.title_bar.setObjectName("UDialogTitleBar")
        bar = QHBoxLayout(self.title_bar)
        bar.setContentsMargins(16, 10, 8, 10)
        bar.setSpacing(8)
        # 标题栏图标：icon_name 之前只是个被存下来没用的参数，现在真的画出来
        self.title_icon: Optional[QLabel] = None
        if icon_name:
            self.title_icon = QLabel(self.title_bar)
            self.title_icon.setObjectName("UDialogTitleIcon")
            self.title_icon.setPixmap(icons.pixmap(icon_name, size=16))
            self.title_icon.setFixedSize(16, 16)
            bar.addWidget(self.title_icon)
        self.title_label = QLabel(title, self.title_bar)
        self.title_label.setObjectName("UDialogTitle")
        bar.addWidget(self.title_label, 1)
        self.close_button: Optional[QToolButton] = None
        if closable:
            self.close_button = QToolButton(self.title_bar)
            self.close_button.setObjectName("UDialogClose")
            self.close_button.setIcon(icons.icon("close", size=14,
                                                  active_color="#FFFFFF"))
            self.close_button.setIconSize(QSize(14, 14))
            self.close_button.setToolTip("关闭")
            self.close_button.setAccessibleName("关闭")
            self.btn_close = self.close_button   # 兼容宿主旧成员名
            self.close_button.setCursor(Qt.PointingHandCursor)
            self.close_button.clicked.connect(self.reject)
            bar.addWidget(self.close_button)
        # 兼容宿主旧写法：它们通过 dialog.title_bar.titleLabel / .btn_close 取用
        self.title_bar.titleLabel = self.title_label
        self.title_bar.btn_close = self.close_button
        # 宿主旧成员名（旧的标题栏按钮组里有最小化/最大化）
        self.btn_min = getattr(self, "min_button", None)
        self.btn_max = getattr(self, "max_button", None)
        self.title_bar.btn_min = self.btn_min
        self.title_bar.btn_max = self.btn_max
        root.addWidget(self.title_bar)

        # 正文
        self.body = QFrame(self)
        self.body.setObjectName("UDialogBody")
        self.body_layout = QVBoxLayout(self.body)
        self.body_layout.setContentsMargins(16, 8, 16, 16)
        self.body_layout.setSpacing(10)
        root.addWidget(self.body, 1)

        # 动作区（默认右对齐，取消在左、主行动在右）
        self.footer = QFrame(self)
        self.footer.setObjectName("UDialogFooter")
        self.footer_layout = QHBoxLayout(self.footer)
        self.footer_layout.setContentsMargins(16, 10, 16, 12)
        self.footer_layout.setSpacing(8)
        self.footer_layout.addStretch(1)
        self.footer.setVisible(False)
        root.addWidget(self.footer)

    # ---------- 内容装配 ----------
    def add_widget(self, widget: QWidget, stretch: int = 0) -> QWidget:
        self.body_layout.addWidget(widget, stretch)
        return widget

    def add_layout(self, layout, stretch: int = 0):
        self.body_layout.addLayout(layout, stretch)
        return layout

    def _hit_edge(self, pos):
        # 兼容宿主旧方法名，转发到框架的边缘判定
        return self._edge_at(pos)

    def _on_theme(self) -> None:
        # 兼容宿主旧钩子（它们在主题变化时调 super()._on_theme()）
        self.update()

    def _refresh_icon(self) -> None:
        self.update()

    def _update_cursor(self, *args) -> None:
        pass

    def _toggle_maximize(self) -> None:
        self._on_maximize_clicked() if hasattr(self, "_on_maximize_clicked") else None

    def _restyle(self) -> None:
        # 兼容宿主写法：它们的子类会在主题变化时调 super()._restyle()
        self.update()

    def setContentWidget(self, widget: QWidget, stretch: int = 1) -> None:
        # 兼容宿主写法（原 zhixing view/ui/dialog.py）
        self.body_layout.addWidget(widget, stretch)

    def add_layout(self, layout, stretch: int = 1):
        self.body_layout.addLayout(layout, stretch)
        return layout
    def add_action(self, text: str, tone: str = "standard",
                   on_click=None) -> UButton:
        button = UButton(text, tone=tone, parent=self.footer,
                         settings=self._ui_settings, theme=self._ui_theme)
        if on_click is not None:
            button.clicked.connect(on_click)
        if is_windows():
            # 按钮顺序各平台相反：macOS/Linux 是「取消在左、主动作在右」，
            # Windows 是「主动作在左、取消在右」。调用方统一按「取消先加、
            # 主动作后加」的顺序调用，这里插到 stretch 之后即可自动反转。
            self.footer_layout.insertWidget(1, button)
        else:
            self.footer_layout.addWidget(button)
        self.footer.setVisible(True)
        return button

    def set_primary_action(self, text: str, on_click=None) -> UButton:
        """对话框的主动作（每层只允许一个 accent 动作）。"""
        return self.add_action(text, tone="accent", on_click=on_click)

    def set_cancel_action(self, text: str = "取消", on_click=None) -> UButton:
        return self.add_action(text, tone="standard",
                               on_click=on_click or self.reject)

    def set_title(self, text: str) -> None:
        self.title_label.setText(text)

    # ---------- 拖动 / 拉伸 ----------
    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if event.button() != Qt.LeftButton:
            super().mousePressEvent(event)
            return
        if self._resizable:
            edge = self._edge_at(event.position().toPoint())
            if edge:
                handle = self.windowHandle()
                started = False
                if handle is not None:
                    try:
                        started = bool(handle.startSystemResize(edge))
                    except Exception:  # noqa: BLE001
                        started = False
                if started:
                    return
                self._resize_edge = edge
                self._resize_geo = self.geometry()
                self._resize_global = event.globalPosition().toPoint()
                return
        handle = self.windowHandle()
        if handle is not None:
            try:
                if handle.startSystemMove():
                    return
            except Exception:  # noqa: BLE001
                pass
        self._drag_offset = (event.globalPosition().toPoint()
                             - self.frameGeometry().topLeft())
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._resize_edge:
            self._apply_resize(event.globalPosition().toPoint())
            return
        if self._drag_offset is not None and (event.buttons() & Qt.LeftButton):
            self.move(event.globalPosition().toPoint() - self._drag_offset)
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        self._resize_edge = Qt.Edge(0)
        self._drag_offset = None
        super().mouseReleaseEvent(event)

    def _edge_at(self, pos: QPoint) -> Qt.Edge:
        margin = _RESIZE_MARGIN
        edge = Qt.Edge(0)
        if pos.x() <= margin:
            edge |= Qt.LeftEdge
        if pos.x() >= self.width() - margin:
            edge |= Qt.RightEdge
        if pos.y() <= margin:
            edge |= Qt.TopEdge
        if pos.y() >= self.height() - margin:
            edge |= Qt.BottomEdge
        return edge

    def _apply_resize(self, global_pos: QPoint) -> None:
        delta = global_pos - self._resize_global
        geo = QRect(self._resize_geo)
        edge = self._resize_edge
        if edge & Qt.LeftEdge:
            geo.setLeft(min(geo.left() + delta.x(), geo.right() - 200))
        if edge & Qt.RightEdge:
            geo.setRight(max(geo.right() + delta.x(), geo.left() + 200))
        if edge & Qt.TopEdge:
            geo.setTop(min(geo.top() + delta.y(), geo.bottom() - 120))
        if edge & Qt.BottomEdge:
            geo.setBottom(max(geo.bottom() + delta.y(), geo.top() + 120))
        self.setGeometry(geo)

    def showEvent(self, event) -> None:  # noqa: N802
        from .. import motion
        motion.fade_in(self, "fast", 6)
        super().showEvent(event)


class UConfirmDialog(UDialog):
    """确认框。ask() 为一次性便捷入口，返回用户是否确认。"""

    def __init__(self, title: str = "确认操作", text: str = "",
                 parent: Optional[QWidget] = None, *, danger: bool = False,
                 confirm_text: str = "确定", cancel_text: str = "取消",
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(title, parent, width=400, height=190,
                         settings=settings, theme=theme)
        message = QLabel(text, self.body)
        message.setWordWrap(True)
        self.add_widget(message, 1)
        # 破坏性动作：默认按钮保持中性，红只在 hover/确认时出现（由 tone=danger 承担）
        self.set_cancel_action(cancel_text)
        self.set_primary_action(confirm_text, self.accept)
        if danger:
            for button in self.footer.findChildren(UButton):
                if button.text() == confirm_text:
                    button.set_tone("danger")

    @staticmethod
    def ask(parent: Optional[QWidget], title: str, text: str, *,
            danger: bool = False, confirm_text: str = "确定",
            cancel_text: str = "取消", settings: Optional[UISettings] = None,
            theme: Optional[ThemeManager] = None) -> bool:
        dialog = UConfirmDialog(title, text, parent, danger=danger,
                                confirm_text=confirm_text, cancel_text=cancel_text,
                                settings=settings, theme=theme)
        return dialog.exec() == QDialog.Accepted


# ============================ 组件层兼容（原 zhixing view/ui）============================
# 这些接口原先由宿主项目自己实现（zhixing/view/ui/），现已并入框架，
# 宿主那一层随之删除；调用方的写法保持不变。


class DialogType(IntEnum):
    """弹窗类型：决定标题栏按钮组与是否可调整尺寸。"""

    INPUT = 0       # 输入/提示类：固定尺寸，仅关闭按钮
    RESIZABLE = 1   # 可调整尺寸类：最小化 + 最大化 + 关闭


class USpinner(ThemedMixin, QFrame):
    """行内自转圈：不确定进度，用作后台任务的轻量指示。

    只做「在转」这一件事，尺寸取自 token，颜色跟随强调色。
    """

    def __init__(self, parent: Optional[QWidget] = None, *, size: int = 18,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("USpinner")
        self.setFixedSize(size, size)
        self.bar = self              # 兼容宿主旧成员名

        self._angle = 0
        self._timer = QTimer(self)
        self._timer.setInterval(40)
        self._timer.timeout.connect(self._tick)
        self._init_theme(settings, theme)

    def _tick(self) -> None:
        self._angle = (self._angle + 24) % 360
        self.update()

    def start(self) -> None:
        self._timer.start()

    def stop(self) -> None:
        self._timer.stop()

    def is_spinning(self) -> bool:
        return self._timer.isActive()

    def showEvent(self, event) -> None:  # noqa: N802
        super().showEvent(event)
        if motion.motion_enabled():
            self.start()

    def hideEvent(self, event) -> None:  # noqa: N802
        super().hideEvent(event)
        self.stop()

    def paintEvent(self, event: QPaintEvent) -> None:  # noqa: N802
        tokens = self.theme_tokens()
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        pen = QPen(QColor(tokens.get("accent-solid", "#0D9488")))
        pen.setWidthF(2.0)
        pen.setCapStyle(Qt.RoundCap)
        painter.setPen(pen)
        rect = QRectF(2, 2, self.width() - 4, self.height() - 4)
        # 画 3/4 圈：起点随 _angle 旋转即为「转」的观感
        painter.drawArc(rect, int(-self._angle * 16), int(270 * 16))
        painter.end()

    def restyle(self) -> None:
        self.update()


class UInputDialog(UDialog):
    """单行输入对话框：可当 QInputDialog.getText 用。"""

    def __init__(self, title: str = "", label: str = "", text: str = "",
                 placeholder: str = "", parent: Optional[QWidget] = None, *,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(title, parent, width=420, height=170,
                         settings=settings, theme=theme)
        if label:
            self.body_layout.addWidget(UTitle(label, role="caption", parent=self,
                                              settings=settings, theme=theme))
        self._edit = ULineEdit(text, placeholder, self, settings=settings, theme=theme)
        self.line = self._edit          # 兼容宿主旧成员名
        self.body_layout.addWidget(self._edit)
        self.cancel_btn = self.add_action("取消", on_click=self.reject)
        self.ok_btn = self.add_action("确定", tone="accent", on_click=self.accept)

    def text(self) -> str:
        return self._edit.text()

    @staticmethod
    def get_text(parent, title: str, label: str = "", text: str = "",
                 placeholder: str = "") -> tuple:
        """QInputDialog.getText 的替换：返回 (text, ok)。"""
        dialog = UInputDialog(title=title, label=label, text=text,
                              placeholder=placeholder, parent=parent)
        try:
            if dialog.exec() == QDialog.Accepted:
                return dialog.text(), True
            return "", False
        finally:
            dialog.deleteLater()
