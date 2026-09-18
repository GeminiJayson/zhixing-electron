# -*- coding: utf-8 -*-
"""数据展示类组件：头像、表格、高级表格、图像对比、控制台日志。"""
from __future__ import annotations

from typing import List, Optional, Sequence

from PySide6.QtCore import QEvent, QRect, QSize, Qt, QTimer, Signal
from PySide6.QtGui import (
    QColor, QFont, QPainter, QPaintEvent, QPen, QPixmap, QTextCharFormat,
)
from PySide6.QtWidgets import (
    QAbstractItemView, QFrame, QGraphicsOpacityEffect, QHBoxLayout, QHeaderView,
    QLabel, QPlainTextEdit,
    QSizePolicy, QTableView, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
    QListWidget, QToolButton,
)

from .. import icons
from .. import motion
from ..settings import UISettings
from ..theme import ThemeManager
from .actions import UButton
from .text import UTitle
from .base import ThemedMixin, token_px

__all__ = ["UAvatar", "UTable", "UDataTable", "UImageCompare", "UConsole",
           "UList", "UToast"]

#: 控制台级别 -> 语义 tone（颜色来自 token，不写死）
CONSOLE_LEVEL_TONES = {"debug": "muted", "info": "info", "success": "success",
                       "warn": "warn", "error": "danger"}


class UAvatar(ThemedMixin, QFrame):
    """头像：文字首字或图片，圆形/方形，可选状态点。颜色取自 token。"""

    def __init__(self, name: str = "", parent: Optional[QWidget] = None, *,
                 size: int = 36, image: Optional[QPixmap] = None,
                 shape: str = "circle", status: str = "",
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UAvatar")
        self.setFixedSize(size, size)
        self._name = name
        self._pixmap = image
        self._shape = shape if shape in ("circle", "square") else "circle"
        self._status = status
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        if name:
            self.setAccessibleName(name)
        self._init_theme(settings, theme)

    def set_name(self, name: str) -> None:
        self._name = name
        self.setAccessibleName(name)
        self.update()

    def set_image(self, image: Optional[QPixmap]) -> None:
        self._pixmap = image
        self.update()

    def set_status(self, status: str) -> None:
        self._status = status
        self.update()

    def paintEvent(self, event: QPaintEvent) -> None:  # noqa: N802
        tokens = self.theme_tokens()
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        rect = self.rect().adjusted(0, 0, -1, -1)
        radius = rect.width() / 2.0 if self._shape == "circle" else 8.0

        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor(tokens.get("accent-soft", "#D7F0EB")))
        painter.drawRoundedRect(rect, radius, radius)

        if self._pixmap is not None and not self._pixmap.isNull():
            path = _rounded_path(rect, radius)
            painter.save()
            painter.setClipPath(path)
            scaled = self._pixmap.scaled(rect.size(), Qt.KeepAspectRatioByExpanding,
                                         Qt.SmoothTransformation)
            painter.drawPixmap(rect.topLeft(), scaled)
            painter.restore()
        elif self._name:
            painter.setPen(QColor(tokens.get("accent", "#0D9488")))
            font = QFont(self.font())
            font.setPointSizeF(max(8.0, rect.height() * 0.42 / 1.6))
            font.setBold(True)
            painter.setFont(font)
            painter.drawText(rect, Qt.AlignCenter, self._name.strip()[:1].upper())

        if self._status:
            tone = CONSOLE_LEVEL_TONES.get(self._status, "success")
            color = tokens.get({"muted": "fg3", "info": "info", "success": "success",
                                "warn": "warn", "danger": "danger"}.get(tone, "success"),
                               tokens.get("success", "#12874B"))
            dot = max(8, rect.width() // 4)
            center = rect.bottomRight()
            painter.setBrush(QColor(tokens.get("layer", "#FFFFFF")))
            painter.setPen(Qt.NoPen)
            painter.drawEllipse(center.x() - dot, center.y() - dot, dot, dot)
            painter.setBrush(QColor(color))
            painter.drawEllipse(center.x() - dot + 2, center.y() - dot + 2,
                                dot - 4, dot - 4)
        painter.end()

    def sizeHint(self) -> QSize:
        return QSize(self.width(), self.height())


def _rounded_path(rect: QRect, radius: float):
    from PySide6.QtGui import QPainterPath
    path = QPainterPath()
    path.addRoundedRect(rect, radius, radius)
    return path


class UTable(ThemedMixin, QTableWidget):
    """基础表格：便捷填充 + 主题化表头。默认只读、整行选择。

    需要搜索/排序/分页时用 UDataTable。
    """

    def __init__(self, headers: Optional[Sequence[str]] = None,
                 parent: Optional[QWidget] = None, *, readonly: bool = True,
                 stretch_last: bool = True, row_height: Optional[int] = None,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UTable")
        self.setAccessibleName("数据表格")
        self.setAlternatingRowColors(True)
        self.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.setSelectionMode(QAbstractItemView.SingleSelection)
        self.setEditTriggers(QAbstractItemView.NoEditTriggers if readonly
                             else QAbstractItemView.DoubleClicked)
        self.verticalHeader().setVisible(False)
        header = self.horizontalHeader()
        header.setHighlightSections(False)
        # 默认均分列宽。用 StretchLastSection 的话，前几列按默认宽度排布，
        # 首列稍长就被压成省略号，而末列白白空一大片。
        header.setSectionResizeMode(QHeaderView.Stretch if stretch_last
                                    else QHeaderView.Interactive)
        if row_height:
            self.verticalHeader().setDefaultSectionSize(int(row_height))
        self._init_theme(settings, theme)
        if headers:
            self.set_headers(headers)

    def set_headers(self, headers: Sequence[str]) -> None:
        self.setColumnCount(len(headers))
        self.setHorizontalHeaderLabels([str(h) for h in headers])
        if headers:
            # 表头就是这张表最自然的可访问名称（读屏会念出列名）
            self.setAccessibleName("表格：%s" % "、".join(str(h) for h in headers))

    def set_rows(self, rows: Sequence[Sequence]) -> None:
        self.setRowCount(0)
        for row in rows:
            self.append_row(row)

    def append_row(self, values: Sequence) -> int:
        row = self.rowCount()
        self.insertRow(row)
        for column, value in enumerate(values):
            item = QTableWidgetItem("" if value is None else str(value))
            item.setFlags(item.flags() & ~Qt.ItemIsEditable)
            self.setItem(row, column, item)
        return row

    def selected_row_values(self) -> List[str]:
        row = self.currentRow()
        if row < 0:
            return []
        return [self.item(row, column).text() if self.item(row, column) else ""
                for column in range(self.columnCount())]


class UDataTable(ThemedMixin, QFrame):
    """高级表格：搜索 + 排序 + 分页 + 行选择。

    适合中等到较大规模（数百 ~ 数万行）的静态数据集：过滤/排序在内存里做一次，
    只把当前页交给视图，因此视图行数恒定，不会因为数据增长而变慢。
    流式或超大数据请自行接 model/view 与增量分页。
    """

    rowActivated = Signal(int)          # 源数据行号
    selectionChanged = Signal(list)     # 选中行的源数据

    def __init__(self, headers: Optional[Sequence[str]] = None,
                 parent: Optional[QWidget] = None, *, page_size: int = 20,
                 searchable: bool = True, search_placeholder: str = "搜索…",
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UDataTable")
        self._init_theme(settings, theme)
        self._headers: List[str] = [str(h) for h in (headers or [])]
        self._rows: List[List[str]] = []
        self._view_indices: List[int] = []      # 当前页显示行 -> 源数据行号
        self._page = 0
        self._page_size = max(1, int(page_size))
        self._query = ""
        self._sort_column: Optional[int] = None
        self._sort_desc = False

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(8)

        self.toolbar = QFrame(self)
        self.toolbar.setObjectName("UDataTableToolbar")
        bar = QHBoxLayout(self.toolbar)
        bar.setContentsMargins(0, 0, 0, 0)
        bar.setSpacing(8)
        self.search = None
        if searchable:
            from .inputs import USearchBox
            self.search = USearchBox(search_placeholder, self.toolbar,
                                     settings=settings, theme=theme)
            self.search.textChanged.connect(self._on_query_changed)
            bar.addWidget(self.search, 1)
        else:
            bar.addStretch(1)
        self.summary = QLabel("", self.toolbar)
        self.summary.setObjectName("UDataTableSummary")
        bar.addWidget(self.summary)
        root.addWidget(self.toolbar)

        self.table = QTableView(self)
        self.table.setObjectName("UDataTableGrid")
        self.table.setAccessibleName("数据表格")
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.verticalHeader().setVisible(False)
        self.table.horizontalHeader().setHighlightSections(False)
        view_header = self.table.horizontalHeader()
        view_header.setSectionsClickable(True)
        view_header.sectionClicked.connect(self._on_header_clicked)
        view_header.setSectionResizeMode(QHeaderView.Stretch)
        view_header.setDefaultAlignment(Qt.AlignLeft | Qt.AlignVCenter)
        self.table.doubleClicked.connect(self._on_double_clicked)
        # selectionModel 要等 setModel 之后才存在，连接放在 _refresh 里
        root.addWidget(self.table, 1)

        from .navigation import UPagination
        self.pagination = UPagination(parent=self, page_size=self._page_size,
                                      settings=settings, theme=theme)
        self.pagination.pageChanged.connect(self._on_page_changed)
        root.addWidget(self.pagination)

    # ---------- 数据 ----------
    def set_data(self, rows: Sequence[Sequence]) -> None:
        self._rows = [["" if cell is None else str(cell) for cell in row]
                      for row in rows]
        self._page = 0
        self._apply_sort()
        self._refresh()

    def data(self) -> List[List[str]]:
        return [list(row) for row in self._rows]

    def set_page_size(self, size: int) -> None:
        self._page_size = max(1, int(size))
        self.pagination.set_page_size(self._page_size)
        self._page = 0
        self._refresh()

    def current_page(self) -> int:
        return self._page

    def set_page(self, index: int) -> None:
        self.pagination.set_page(index)
        self._on_page_changed(index)

    def visible_rows(self) -> List[List[str]]:
        """当前页显示的数据（按过滤与排序后的顺序）。"""
        rows = self._visible_rows()
        start = self._page * self._page_size
        return rows[start:start + self._page_size]

    def selected_rows(self) -> List[List[str]]:
        selection = self.table.selectionModel()
        if selection is None:
            return []
        result = []
        for index in sorted({i.row() for i in selection.selectedRows()
                             or selection.selectedIndexes()}):
            if 0 <= index < len(self._view_indices):
                result.append(list(self._rows[self._view_indices[index]]))
        return result

    # ---------- 内部 ----------
    def _visible_rows(self) -> List[List[str]]:
        if not self._query:
            return self._rows
        needle = self._query.lower()
        return [row for row in self._rows
                if any(needle in cell.lower() for cell in row)]

    def _apply_sort(self) -> None:
        if self._sort_column is None:
            return
        column = self._sort_column

        def key(row: List[str]):
            value = row[column] if column < len(row) else ""
            try:
                return (0, float(value))
            except (TypeError, ValueError):
                return (1, value.lower())

        try:
            self._rows.sort(key=key, reverse=self._sort_desc)
        except (TypeError, ValueError):
            pass

    def _refresh(self) -> None:
        from PySide6.QtGui import QStandardItem, QStandardItemModel
        rows = self._visible_rows()
        pages = max(1, (len(rows) + self._page_size - 1) // self._page_size)
        self._page = max(0, min(self._page, pages - 1))
        start = self._page * self._page_size
        page_rows = rows[start:start + self._page_size]
        self._view_indices = list(range(start, start + len(page_rows)))

        model = QStandardItemModel(len(page_rows), len(self._headers), self.table)
        model.setHorizontalHeaderLabels(self._headers)
        for r, row in enumerate(page_rows):
            for c in range(len(self._headers)):
                item = QStandardItem(row[c] if c < len(row) else "")
                item.setEditable(False)
                model.setItem(r, c, item)
        self.table.setModel(model)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.selectionModel().selectionChanged.connect(
            lambda *_: self.selectionChanged.emit(self.selected_rows()))
        self.summary.setText("%d / %d 行" % (len(rows), len(self._rows)))
        self.pagination.set_total(len(rows))
        self.pagination.set_page(self._page)

    def _on_query_changed(self, text: str) -> None:
        self._query = (text or "").strip()
        self._page = 0
        self._refresh()

    def _on_page_changed(self, index: int) -> None:
        if index == self._page and self.table.model() is not None:
            return
        self._page = max(0, int(index))
        self._refresh()

    def _on_header_clicked(self, column: int) -> None:
        if self._sort_column == column:
            self._sort_desc = not self._sort_desc
        else:
            self._sort_column = column
            self._sort_desc = False
        self._apply_sort()
        self._refresh()

    def _on_double_clicked(self, index) -> None:
        row = index.row()
        if 0 <= row < len(self._view_indices):
            self.rowActivated.emit(self._view_indices[row])

    def theme_tokens_hook(self) -> None:  # pragma: no cover - 保留扩展点
        pass


class UImageCompare(ThemedMixin, QFrame):
    """图像对比：两张图叠放，中间分割线可左右拖动。"""

    def __init__(self, parent: Optional[QWidget] = None, *, position: float = 0.5,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UImageCompare")
        self.setMinimumHeight(160)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setCursor(Qt.SplitHCursor)
        self._left: Optional[QPixmap] = None
        self._right: Optional[QPixmap] = None
        self._position = min(1.0, max(0.0, float(position)))
        self._dragging = False
        self.setAccessibleName("图像对比")
        self._init_theme(settings, theme)

    def set_images(self, left: Optional[QPixmap],
                   right: Optional[QPixmap]) -> None:
        self._left = left
        self._right = right
        self.update()

    def set_position(self, ratio: float) -> None:
        self._position = min(1.0, max(0.0, float(ratio)))
        self.update()

    def position(self) -> float:
        return self._position

    def paintEvent(self, event: QPaintEvent) -> None:  # noqa: N802
        tokens = self.theme_tokens()
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(tokens.get("control-hover", "#F1F5F3")))
        split = int(self.width() * self._position)
        self._paint_side(painter, self._right, QRect(0, 0, self.width(), self.height()),
                         QRect(split, 0, self.width() - split, self.height()))
        self._paint_side(painter, self._left, QRect(0, 0, self.width(), self.height()),
                         QRect(0, 0, split, self.height()))

        pen = QPen(QColor(tokens.get("layer", "#FFFFFF")))
        pen.setWidth(2)
        painter.setPen(pen)
        painter.drawLine(split, 0, split, self.height())
        handle = 22
        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor(tokens.get("accent-solid", "#0D9488")))
        painter.drawEllipse(split - handle // 2, self.height() // 2 - handle // 2,
                            handle, handle)
        painter.end()

    @staticmethod
    def _paint_side(painter: QPainter, pixmap: Optional[QPixmap],
                    source: QRect, target: QRect) -> None:
        if pixmap is None or pixmap.isNull() or target.width() <= 0:
            return
        painter.save()
        painter.setClipRect(target)
        painter.drawPixmap(target, pixmap, source)
        painter.restore()

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.LeftButton:
            self._dragging = True
            self.set_position(event.position().x() / max(1, self.width()))
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if self._dragging:
            self.set_position(event.position().x() / max(1, self.width()))
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        self._dragging = False
        super().mouseReleaseEvent(event)

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)


class UConsole(ThemedMixin, QFrame):
    """控制台日志：分级别着色、上限行数（自动丢弃最旧）、清空与自动滚动。

    行数上限用 QPlainTextEdit.maximumBlockCount 实现，长时间运行不会无限增长。
    """

    LEVELS = ("debug", "info", "success", "warn", "error")

    def __init__(self, parent: Optional[QWidget] = None, *, max_lines: int = 2000,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UConsole")
        self._init_theme(settings, theme)
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(6)

        head = QHBoxLayout()
        head.setSpacing(8)
        self.title = QLabel("控制台", self)
        self.title.setObjectName("UConsoleTitle")
        head.addWidget(self.title)
        head.addStretch(1)
        self.clear_button = UButton("清空", tone="subtle", size="compact",
                                    settings=self._ui_settings, theme=self._ui_theme)
        self.clear_button.clicked.connect(self.clear)
        head.addWidget(self.clear_button)
        root.addLayout(head)

        self.view = QPlainTextEdit(self)
        self.view.setObjectName("UConsoleView")
        self.view.setReadOnly(True)
        self.view.setMaximumBlockCount(max(50, int(max_lines)))
        self.view.setLineWrapMode(QPlainTextEdit.NoWrap)
        self.view.setAccessibleName("控制台日志")
        root.addWidget(self.view, 1)

    def append(self, text: str, level: str = "info") -> None:
        tone = CONSOLE_LEVEL_TONES.get(level, "info")
        color = self._tone_color(tone)
        fmt = QTextCharFormat()
        fmt.setForeground(QColor(color))
        cursor = self.view.textCursor()
        cursor.movePosition(cursor.MoveOperation.End)
        prefix = {"debug": "·", "info": "i", "success": "✓",
                  "warn": "!", "error": "✕"}.get(level, "i")
        cursor.insertText("%s %s\n" % (prefix, text), fmt)
        self.view.setTextCursor(cursor)
        self.view.ensureCursorVisible()

    def clear(self) -> None:
        self.view.clear()

    def text(self) -> str:
        return self.view.toPlainText()

    def _tone_color(self, tone: str) -> str:
        tokens = self.theme_tokens()
        key = {"muted": "fg3", "info": "info", "success": "success",
               "warn": "warn", "danger": "danger"}.get(tone, "fg")
        return tokens.get(key, tokens.get("fg", "#1A1D21"))


# ============================ 列表 ============================
class UList(ThemedMixin, QListWidget):
    """列表（QListWidget 语义完整保留：addItem/addItems/item/currentItem…）。

    外观由框架模板渲染；行高、圆角、选中态都走 token，
    与框架的表格 / 树保持同一套视觉。
    """

    def __init__(self, items: Optional[Sequence[str]] = None,
                 parent: Optional[QWidget] = None, *,
                 multi: bool = False, tooltip: str = "",
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UList")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setSelectionMode(
            QAbstractItemView.ExtendedSelection if multi else QAbstractItemView.SingleSelection)
        self.setUniformItemSizes(True)
        if tooltip:
            self.setToolTip(tooltip)
        if items:
            self.addItems([str(item) for item in items])
        self._init_theme(settings, theme)


# ============================ 浮层通知 ============================
class UToast(ThemedMixin, QFrame):
    """浮层通知：贴在父窗口底部（或右下角），淡入、停留、淡出。

    为什么需要它：框架原先只有 UInfoBar（内联状态条，嵌在页面里）。
    业务需要的是「操作完成后从边缘冒出来、几秒后自己消失」的提示，
    而且调用习惯要能直接替代 qfluentwidgets 的 InfoBar。
    """

    _LEVELS = {"success": "success", "warning": "warn", "warn": "warn",
               "error": "danger", "danger": "danger", "info": "info"}

    def __init__(self, title: str, content: str = "", parent: Optional[QWidget] = None, *,
                 level: str = "info", duration: int = 2500,
                 position: str = "bottom", closable: bool = True,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UToast")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setProperty("tone", self._LEVELS.get(str(level), "info"))
        self.setAttribute(Qt.WA_TransparentForMouseEvents, False)
        self._duration = max(600, int(duration))
        self._position = str(position)
        self._effect: Optional[QGraphicsOpacityEffect] = None
        self._hide_timer: Optional[QTimer] = None

        # 宽度必须给定：正文是 wrap 标签，宽度未定时算不出换行，内容会挤成一团。
        # （多条通知叠在一起是 _stack_offset() 那件事，与宽度无关。）
        self.setMinimumWidth(280)
        self.setMaximumWidth(440)

        root = QHBoxLayout(self)
        root.setContentsMargins(14, 12, 10, 12)
        root.setSpacing(12)
        icon_name = _TOAST_ICONS.get(self._LEVELS.get(str(level), "info"), "info")
        icon = QLabel(self)
        icon.setObjectName("UToastIcon")
        icon.setAlignment(Qt.AlignCenter)
        icon.setFixedSize(18, 18)
        icon.setPixmap(icons.pixmap(icon_name, size=18))
        root.addWidget(icon, 0, Qt.AlignTop)
        texts = QVBoxLayout()
        texts.setSpacing(2)
        self.title = UTitle(title, role="body", parent=self)
        self.title.setObjectName("UToastTitle")
        texts.addWidget(self.title)
        if content:
            self.body = UTitle(content, role="caption", wrap=True, parent=self)
            self.body.setObjectName("UToastText")
            texts.addWidget(self.body)
        root.addLayout(texts, 1)
        if closable:
            close = QToolButton(self)
            close.setObjectName("UToastClose")
            close.setIcon(icons.icon("close", size=14))
            close.setIconSize(QSize(14, 14))
            close.setCursor(Qt.PointingHandCursor)
            close.setAccessibleName("关闭通知")
            close.clicked.connect(self.dismiss)
            root.addWidget(close, 0, Qt.AlignTop)

        self._init_theme(settings, theme)
        self.hide()

    # ---------- 便捷构造（对齐 qfluentwidgets.InfoBar 的调用习惯）----------
    # 第三方特有的参数（orient / isClosable 等）会被忽略，调用方不必改写。
    @staticmethod
    def _clean(kwargs: dict) -> dict:
        allowed = {"duration", "position", "closable", "settings", "theme"}
        return {k: v for k, v in kwargs.items() if k in allowed}

    @classmethod
    def show_message(cls, title: str, content: str = "",
                     parent: Optional[QWidget] = None, *, level: str = "info",
                     duration: int = 2500, position: Any = "bottom",
                     **kwargs: Any) -> "UToast":
        toast = cls(title, content, parent, level=level, duration=duration,
                    position=cls._normalize_position(position),
                    **cls._clean(kwargs))
        toast.popup()
        return toast

    @staticmethod
    def _normalize_position(value: Any) -> str:
        # 第三方会把位置写成 InfoBarPosition.BOTTOM 这类枚举，这里取其名
        text = str(getattr(value, "name", value) or "bottom").lower()
        for key in ("top-right", "top-left", "bottom-right", "bottom-left",
                    "top", "bottom"):
            if key.replace("-", "") in text.replace("-", ""):
                return key
        return "bottom"

    @classmethod
    def success(cls, title: str, content: str = "",
                parent: Optional[QWidget] = None, **kwargs: Any) -> "UToast":
        return cls.show_message(title, content, parent, level="success", **kwargs)

    @classmethod
    def warning(cls, title: str, content: str = "",
                parent: Optional[QWidget] = None, **kwargs: Any) -> "UToast":
        return cls.show_message(title, content, parent, level="warn", **kwargs)

    @classmethod
    def error(cls, title: str, content: str = "",
                parent: Optional[QWidget] = None, **kwargs: Any) -> "UToast":
        return cls.show_message(title, content, parent, level="danger", **kwargs)

    @classmethod
    def info(cls, title: str, content: str = "",
                parent: Optional[QWidget] = None, **kwargs: Any) -> "UToast":
        return cls.show_message(title, content, parent, level="info", **kwargs)

    # ---------- 生命周期 ----------
    def _chrome_width(self) -> int:
        """正文列之外占用的宽度（左右内边距 + 图标 + 间距 + 关闭按钮）。"""
        root = self.layout()
        if root is None:
            return 0
        margins = root.contentsMargins()
        total = margins.left() + margins.right()
        skip = (getattr(self, "body", None), getattr(self, "title", None))
        for widget in self.findChildren(QWidget, options=Qt.FindDirectChildrenOnly):
            if widget in skip:
                continue
            total += widget.sizeHint().width() + root.spacing()
        return total

    def _fit_width(self) -> None:
        """先定宽，再让布局按这个宽度算高度。

        正文是换行标签，QLabel 只有拿到最终宽度才知道要折几行；不定宽就 adjustSize()，
        拿到的 sizeHint 是按「不换行的理想宽度」算的，正文首末两行会被裁掉
        （实测 192px 宽需要 51px 却只给 34px）。
        """
        body = getattr(self, "body", None)
        if body is None:
            return
        chrome = self._chrome_width()
        ideal = body.fontMetrics().horizontalAdvance(body.text()) + 8
        width = max(self.minimumWidth(), min(self.maximumWidth(), ideal + chrome))
        self.setFixedWidth(width)
        body.setFixedWidth(max(80, width - chrome))

    def popup(self) -> None:
        host = self.parentWidget()
        self._fit_width()      # 宽度先定下来（min/max 宽仍生效），否则正文高度算错
        self.adjustSize()
        self._relocate()
        self.show()
        self.raise_()
        if self._effect is None:
            self._effect = QGraphicsOpacityEffect(self)
            self.setGraphicsEffect(self._effect)
        motion.fade_in(self, dur="fast")
        self._hide_timer = QTimer(self)
        self._hide_timer.setSingleShot(True)
        self._hide_timer.timeout.connect(self.dismiss)
        self._hide_timer.start(self._duration)
        if host is not None:
            host.installEventFilter(self)

    def dismiss(self) -> None:
        if self._hide_timer is not None:
            self._hide_timer.stop()
        self.hide()
        self.deleteLater()

    def _stack_offset(self) -> int:
        """同侧已显示通知占用的竖直高度 —— 多条通知要依次排开，不能叠在同一坐标。"""
        host = self.parentWidget()
        if host is None:
            return 0
        gap = token_px(self, "space-2", 8)
        total = 0
        for other in host.findChildren(UToast):
            if other is self or not other.isVisible():
                continue
            if getattr(other, "_position", "") != self._position:
                continue
            total += (other.height() or other.sizeHint().height()) + gap
        return total

    def _relocate(self) -> None:
        host = self.parentWidget()
        if host is None:
            return
        margin = 20
        # 原先每条通知都算同一个 y，后弹的会精确盖住先弹的（看起来「都堆到一起」）
        stack = self._stack_offset()
        if self._position in ("top", "top-left", "top-right"):
            y = margin + token_px(self, "control-h-large", 36) + stack
        else:
            y = host.height() - self.height() - margin - stack
        if "left" in self._position:
            x = margin
        elif "right" in self._position:
            x = host.width() - self.width() - margin
        else:
            x = (host.width() - self.width()) // 2
        self.move(max(margin, x), max(margin, y))

    def eventFilter(self, watched, event) -> bool:  # noqa: N802
        if watched is self.parentWidget() and event.type() == QEvent.Resize:
            self._relocate()
        return super().eventFilter(watched, event)

    def restyle(self) -> None:
        self.update()


#: 通知图标（按 tone 取一个字形，避免引入图标库依赖）
_TOAST_ICONS = {"success": "success", "warn": "warning", "danger": "error",
                "info": "info", "standard": "info"}

