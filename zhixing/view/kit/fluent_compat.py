# -*- coding: utf-8 -*-
"""原生 Qt 组件 -> qfluent_core 组件的兼容层（迁移期使用）。

为什么需要它：框架组件的**命名与签名**都与原生类不同，例如
    QComboBox(parent)   vs  UComboBox(items, parent)
    QLabel(text)        vs  UTitle(text, role, parent)
所以不能简单做别名赋值。这里用薄包装类把签名适配回**原生用法**，
业务代码一行都不用改，只换 import 来源。

导入方式：
    from zhixing.view.kit.fluent_compat import QLabel, QPushButton

容器类（QWidget / QScrollArea / QStackedWidget / QSplitter / 各种 Layout）
**不在本层**：它们不是「可见控件」，各自按需继续用原生。
"""
from __future__ import annotations

from typing import Any, Optional, Tuple

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QAction
from PySide6.QtWidgets import QMenu, QToolButton as QtToolButton
from PySide6.QtWidgets import QWidget

from qfluent_core import (
    UToggleSwitch,
    UTable,
    UList,
    UConfirmDialog, UToast,
    UButton, UCheckbox, UComboBox, UDatePicker, ULineEdit, UProgressBar,
    URadioButton, USlider, USpinBox, UTabs,
    UTextEdit, UTitle,
)

__all__ = [
    "QLabel", "QPushButton", "QCheckBox",
    "QListWidget", "QTableWidget", 
    "QRadioButton", "QToolButton", "QLineEdit", 
    "QTextEdit", "QPlainTextEdit", "QComboBox", 
    "QSpinBox", "QDateEdit", "QProgressBar", 
    "QSlider", "QTabWidget",
    "MIGRATED_CLASSES",
]


def _split_args(args: Tuple[Any, ...], kwargs: dict) -> Tuple[str, Optional[QWidget]]:
    """从原生风格的位置参数里解析出 (文本, 父控件)。

    原生构造有多种写法，必须全部兼容：
        QLabel()                    -> ("", None)
        QLabel("文本")               -> ("文本", None)
        QLabel("文本", parent)       -> ("文本", parent)
        QLabel(parent)              -> ("", parent)
        QLabel("文本", parent, flag) -> ("文本", parent)   多余位置参数忽略
    """
    text = ""
    parent: Optional[QWidget] = None
    if args:
        first = args[0]
        if isinstance(first, str):
            text = first
            if len(args) > 1 and isinstance(args[1], QWidget):
                parent = args[1]
        elif isinstance(first, QWidget):
            parent = first
    parent = kwargs.pop("parent", parent)
    # 原生可能传 window flags 之类的额外位置参数，这里忽略
    return text, parent


class QLabel(UTitle):
    """QLabel -> UTitle（默认 body 层级；方法集由 QLabel 基类提供）。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        text, parent = _split_args(args, kwargs)
        kwargs.setdefault("role", "body")
        super().__init__(text, parent=parent, **kwargs)


class QPushButton(UButton):
    """QPushButton -> UButton（标准尺寸、实底 tone）。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        text, parent = _split_args(args, kwargs)
        super().__init__(text, parent=parent, **kwargs)


class QCheckBox(UCheckbox):
    """QCheckBox -> UCheckbox。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        text, parent = _split_args(args, kwargs)
        super().__init__(text, parent=parent, **kwargs)


class QRadioButton(URadioButton):
    """QRadioButton -> URadioButton（保留互斥语义）。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        text, parent = _split_args(args, kwargs)
        super().__init__(text, parent=parent, **kwargs)


class QToolButton(QtToolButton):
    """QToolButton：保留原生全部 API（setToolButtonStyle / setPopupMode / setMenu…）。

    这里**不套 UButton**：它的语义是「小图标按钮 + 可能的弹出菜单」，与 UButton
    差异太大，硬套会丢 API（实测 setToolButtonStyle 直接不存在）。
    外观由框架模板的 QToolButton 规则统一，所以视觉仍然一致。
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        parent = kwargs.pop("parent", None)
        if parent is None and args and isinstance(args[0], QWidget):
            parent = args[0]
            args = args[1:]
        super().__init__(parent)
        self.setObjectName("UCompatToolButton")

class QLineEdit(ULineEdit):
    """QLineEdit -> ULineEdit（带清除按钮；原生 setText 等语义不变）。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        text, parent = _split_args(args, kwargs)
        super().__init__(text, parent=parent, **kwargs)


class QTextEdit(UTextEdit):
    """QTextEdit -> UTextEdit。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        text, parent = _split_args(args, kwargs)
        super().__init__(text, parent=parent, **kwargs)


class QPlainTextEdit(UTextEdit):
    """QPlainTextEdit -> UTextEdit（纯文本；setPlainText/toPlainText 都可用）。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        text, parent = _split_args(args, kwargs)
        super().__init__(text, parent=parent, **kwargs)


class QComboBox(UComboBox):
    """QComboBox -> UComboBox。

    原生构造是 QComboBox(parent)，框架是 UComboBox(items, parent)，
    这里统一成「可选的父控件或条目列表都接受」。
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        items = None
        parent = None
        if args:
            first = args[0]
            if isinstance(first, QWidget) or first is None:
                parent = first
            else:
                items = first
                if len(args) > 1 and isinstance(args[1], QWidget):
                    parent = args[1]
        parent = kwargs.pop("parent", parent)
        items = kwargs.pop("items", items)
        super().__init__(items, parent, **kwargs)


class QSpinBox(USpinBox):
    """QSpinBox -> USpinBox。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        value = 0
        parent = None
        if args:
            first = args[0]
            if isinstance(first, QWidget) or first is None:
                parent = first
            else:
                value = int(first)
        parent = kwargs.pop("parent", parent)
        super().__init__(value, parent, **kwargs)


class QDateEdit(UDatePicker):
    """QDateEdit -> UDatePicker。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        parent = None
        if args and isinstance(args[0], QWidget):
            parent = args[0]
        parent = kwargs.pop("parent", parent)
        super().__init__(parent, **kwargs)


class QProgressBar(UProgressBar):
    """QProgressBar -> UProgressBar。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        parent = None
        if args and isinstance(args[0], QWidget):
            parent = args[0]
        parent = kwargs.pop("parent", parent)
        super().__init__(0, kwargs.pop("maximum", 100), parent, **kwargs)


class QSlider(USlider):
    """QSlider -> USlider（原生 QSlider(Qt.Horizontal) 写法也兼容）。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        orientation = "horizontal"
        parent = None
        for value in args:
            if isinstance(value, QWidget):
                parent = value
            elif value in (Qt.Vertical, Qt.Vertical.value):
                orientation = "vertical"
        parent = kwargs.pop("parent", parent)
        kwargs.setdefault("orientation", orientation)
        super().__init__(0, parent, **kwargs)


class QTabWidget(UTabs):
    """QTabWidget -> UTabs。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        parent = args[0] if args and isinstance(args[0], QWidget) else None
        parent = kwargs.pop("parent", parent)
        super().__init__(parent, **kwargs)


# ---- qfluentwidgets 控件名 -> 框架组件（设置页仍在用这些名字）----
# 第三方库已退场：这些名字现在指向框架组件，调用代码不必改写。
LineEdit = QLineEdit
SpinBox = QSpinBox
ComboBox = QComboBox
class SwitchButton(UToggleSwitch):
    """qfluentwidgets.SwitchButton -> UToggleSwitch。

    第三方用的是 checkedChanged 信号（框架/原生是 toggled），这里补一个同名信号
    并单向转发，调用代码无需改写。
    """

    checkedChanged = Signal(bool)

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        _text, parent = _split_args(args, kwargs)
        super().__init__(False, parent, **kwargs)
        # 单向转发：toggled -> checkedChanged
        self.toggled.connect(self.checkedChanged.emit)


class PrimaryPushButton(UButton):
    """qfluentwidgets.PrimaryPushButton -> UButton（强调色实底）。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        text, parent = _split_args(args, kwargs)
        kwargs.setdefault("tone", "accent")
        super().__init__(text, parent=parent, **kwargs)


#: 本层已接管的原生类名（迁移看板据此计算进度）
MIGRATED_CLASSES = ("QLabel", "QPushButton", "QCheckBox", "QRadioButton",
                    "QToolButton", "LineEdit", "SpinBox", "ComboBox",
                    "SwitchButton", "PrimaryPushButton")




class QListWidget(UList):
    """QListWidget -> UList（addItem/addItems/currentItem 等语义完整保留）。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        _text, parent = _split_args(args, kwargs)
        items = args[0] if args and isinstance(args[0], (list, tuple)) else None
        parent = kwargs.pop("parent", parent)
        super().__init__(items, parent, **kwargs)


class QTableWidget(UTable):
    """QTableWidget -> UTable（保留 setRowCount/setItem 等表格语义）。"""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        rows = cols = 0
        parent = None
        for value in args:
            if isinstance(value, QWidget):
                parent = value
            elif isinstance(value, int):
                if rows == 0:
                    rows = value
                else:
                    cols = value
        parent = kwargs.pop("parent", parent)
        kwargs.pop("rows", None)
        kwargs.pop("cols", None)
        super().__init__(None, parent, **kwargs)
        if rows:
            self.setRowCount(rows)
        if cols:
            self.setColumnCount(cols)


# ==================== qfluentwidgets 的兼容替代 ====================
# 目的：把业务里的第三方控件调用原地接管，调用代码一行都不用改。
# 未接管的仍在用第三方（FluentWindow 主窗口基类 —— 需单独一轮重构）。


class InfoBar:
    """qfluentwidgets.InfoBar -> 框架的 UToast（浮层通知）。"""

    success = staticmethod(UToast.success)
    warning = staticmethod(UToast.warning)
    error = staticmethod(UToast.error)
    info = staticmethod(UToast.info)


class InfoBarPosition:
    """占位枚举：第三方会把位置写成 InfoBarPosition.BOTTOM，取其名即可。"""

    TOP = "top"
    BOTTOM = "bottom"
    TOP_LEFT = "top-left"
    TOP_RIGHT = "top-right"
    BOTTOM_LEFT = "bottom-left"
    BOTTOM_RIGHT = "bottom-right"


#: qfluentwidgets.RoundMenu -> 原生 QMenu（框架模板已美化 QMenu）
RoundMenu = QMenu
#: qfluentwidgets.Action -> 原生 QAction
Action = QAction
#: qfluentwidgets.PushButton -> UButton
PushButton = UButton


class MessageBox:
    """qfluentwidgets.MessageBox -> UConfirmDialog（保留 exec() 语义）。"""

    def __init__(self, title: str = "", content: str = "",
                 parent: Optional[QWidget] = None, **kwargs: Any) -> None:
        self._dialog = UConfirmDialog(title, content, parent)

    def exec(self) -> int:
        return self._dialog.exec()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._dialog, name)

