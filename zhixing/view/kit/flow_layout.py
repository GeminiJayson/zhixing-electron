# -*- coding: utf-8 -*-
"""流式布局 FlowLayout（Qt 官方示例的通用实现）：子控件按行自动换行。

用于主题包、强调色等「多子控件」场景，避免横向 QHBoxLayout 在控件多时
溢出容器/超出页面宽度；配合 hasHeightForWidth 让外层 QGridLayout 正确伸缩。
"""
from PySide6.QtCore import QPoint, QRect, QSize, Qt
from PySide6.QtWidgets import QLayout, QSizePolicy


class FlowLayout(QLayout):
    def __init__(self, parent=None, margin: int = 0, hspacing: int = -1, vspacing: int = -1):
        super().__init__(parent)
        self._items = []
        self._hspacing = hspacing
        self._vspacing = vspacing
        self.setContentsMargins(margin, margin, margin, margin)

    def __del__(self):  # noqa: D105
        while self.count():
            self.takeAt(0)

    # ---------- QLayout 协议 ----------
    def addItem(self, item):  # noqa: N802
        self._items.append(item)

    def count(self) -> int:
        return len(self._items)

    def itemAt(self, index: int):  # noqa: N802
        return self._items[index] if 0 <= index < len(self._items) else None

    def takeAt(self, index: int):  # noqa: N802
        return self._items.pop(index) if 0 <= index < len(self._items) else None

    def expandingDirections(self):  # noqa: N802
        return Qt.Orientations(Qt.Orientation(0))

    def hasHeightForWidth(self) -> bool:  # noqa: N802
        return True

    def heightForWidth(self, width: int) -> int:  # noqa: N802
        return self._do_layout(QRect(0, 0, width, 0), test_only=True)

    def setGeometry(self, rect: QRect):  # noqa: N802
        super().setGeometry(rect)
        self._do_layout(rect, test_only=False)

    def sizeHint(self):  # noqa: N802
        return self.minimumSize()

    def minimumSize(self):  # noqa: N802
        size = QSize()
        for item in self._items:
            size = size.expandedTo(item.minimumSize())
        m = self.contentsMargins()
        size += QSize(m.left() + m.right(), m.top() + m.bottom())
        return size

    # ---------- 核心换行逻辑 ----------
    def _do_layout(self, rect: QRect, test_only: bool) -> int:
        m = self.contentsMargins()
        right = rect.right() - m.right()
        x = rect.x() + m.left()
        y = rect.y() + m.top()
        line_height = 0
        hspace = self._hspacing if self._hspacing >= 0 else self.spacing()
        vspace = self._vspacing if self._vspacing >= 0 else self.spacing()

        for item in self._items:
            hint = item.sizeHint()
            next_x = x + hint.width() + hspace
            if next_x - hspace > right and line_height > 0:
                # 换行
                x = rect.x() + m.left()
                y = y + line_height + vspace
                next_x = x + hint.width() + hspace
                line_height = 0
            if not test_only:
                item.setGeometry(QRect(QPoint(x, y), hint))
            x = next_x
            line_height = max(line_height, hint.height())
        return y + line_height - rect.y() + m.bottom()
