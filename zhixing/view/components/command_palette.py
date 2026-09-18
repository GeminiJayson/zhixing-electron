# -*- coding: utf-8 -*-
"""命令面板（Ctrl+K / ⌘K 胶囊）：统一搜索任务/笔记/闪念/标签/命令。

v0.17.1 第5项：改用 UDialog 框架承载（标题栏「命令面板」+ 关闭钮、
16px 大圆角实色、主题自愈），原交互（回车执行/Esc 关闭/前缀过滤）不变。
"""
from typing import Optional

from PySide6.QtCore import Qt, Signal, QTimer, QSize
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (QHBoxLayout, QListWidgetItem, QVBoxLayout, QWidget)

from ..kit import icons
from ..kit.icons import icon
from qfluent_core import ThemeManager as ThemeEngine
from ..ui import DialogType, UDialog
from zhixing.view.kit.fluent_compat import QLabel, QLineEdit
from zhixing.view.kit.fluent_compat import QListWidget

_KIND_LABEL = {"command": "命令", "task": "任务", "note": "笔记", "flash": "闪念", "tag": "标签"}


class CommandPalette(UDialog):
    """命令面板（UDialog 框架）：单输入框统一入口；回车执行选中项，Esc/关闭钮关闭。"""

    # 非命令命中（task/note/flash/tag）无 action，由 AppController 按 kind 导航。
    activated = Signal(str, object)   # kind, payload
    createNoteRequested = Signal(str)  # 无结果新建笔记（F7-1 增强）
    themeRequested = Signal(str)       # 主题包命令直达

    def __init__(self, parent=None):
        super().__init__("命令面板", parent=parent,
                         dialog_type=DialogType.INPUT,
                         icon_name="action.search",
                         width=520, height=400)
        self._hits = []

        lay = self.body_layout
        lay.setContentsMargins(12, 10, 12, 12)
        lay.setSpacing(8)
        self.search = _PaletteInput()
        self.search.setPlaceholderText("搜索任务、笔记、闪念、命令…（前缀 task: note: flash: tag:）")
        self.search.returnPressed.connect(self._run_current)
        lay.addWidget(self.search)
        self.list = QListWidget()
        self.list.itemActivated.connect(lambda _i: self._run_current())
        self.list.clicked.connect(lambda _i: self._run_current())
        lay.addWidget(self.list, 1)

        self._engine = None
        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.setInterval(120)
        self._debounce.timeout.connect(self._do_search)
        self.search.textChanged.connect(lambda _t: self._debounce.start())
        self._restyle()

    def set_engine(self, search_service):
        self._engine = search_service

    def open_palette(self, anchor=None):
        """打开命令面板。

        ``anchor``：锚点控件（标题栏的「搜索任务、笔记、命令… ⌘K」胶囊）。
        面板会**对齐到该控件正下方**展开——命令面板的语义是「从搜索框展开的
        结果列表」，悬浮在屏幕中央会失去与触发点的视觉联系。
        未给锚点时回退到屏幕居中（保留旧行为，兼容其它调用方）。
        """
        self.search.clear()
        self._do_search()
        self.search.setFocus()
        self._restyle()
        self._place_under(anchor)
        # v0.16/v0.17.1：UDialog 无边框（无系统 Esc 键语义），显式接 Esc → reject
        self.setModal(True)
        self.exec()

    def _place_under(self, anchor) -> None:
        """把面板移到 anchor 正下方并水平居中对齐（越界时夹回屏幕内）。"""
        if anchor is None:
            return
        try:
            from PySide6.QtCore import QPoint
            from PySide6.QtGui import QGuiApplication
            w, h = self.width(), self.height()
            top_left = anchor.mapToGlobal(QPoint(0, anchor.height()))
            x = top_left.x() + (anchor.width() - w) // 2
            y = top_left.y() + 6          # 与锚点留 6px 间隙
            screen = (QGuiApplication.screenAt(top_left)
                      or QGuiApplication.primaryScreen())
            if screen is not None:
                g = screen.availableGeometry()
                x = max(g.left() + 8, min(x, g.right() - w - 8))
                # 下方放不下时（罕见）贴着屏幕下沿内收
                if y + h > g.bottom() - 8:
                    y = max(g.top() + 8, g.bottom() - h - 8)
            self.move(x, y)
        except Exception:  # noqa: BLE001 —— 定位失败不应阻断面板打开
            pass

    def keyPressEvent(self, ev):  # noqa: N802
        from PySide6.QtCore import Qt as _Qt
        if ev.key() == _Qt.Key_Escape:
            self.reject()
            return
        super().keyPressEvent(ev)

    # ---------- 内部 ----------
    def _add_hit(self, h, fg2: str):
        icon_name = {"command": "action.more", "task": "nav.tasks", "note": "nav.notes",
                     "flash": "nav.flash", "tag": "tag.tag"}.get(h.kind, "action.more")
        item = QListWidgetItem(icon(icon_name, fg2, 16), h.title)
        item.setData(Qt.UserRole, len(self._hits))
        if h.subtitle:
            item.setToolTip(h.subtitle)
        item.setSizeHint(QSize(item.sizeHint().width(), 36))
        self.list.addItem(item)
        self._hits.append(h)

    def _do_search(self):
        self.list.clear()
        self._hits = []
        if not self._engine:
            return
        from ...model.application.search_service import SearchHit
        q = self.search.text().strip()
        eng = ThemeEngine.instance()
        fg2 = eng.t("fg2", "#6B7280") if eng else "#6B7280"

        groups = []
        if q.startswith("主题") or q.lower().startswith("theme:"):
            needle = (q[2:] if q.startswith("主题") else q[6:]).strip()
            hits = []
            for name in (list(eng.packs) if eng else []):
                if not needle or needle in name:
                    hits.append(SearchHit("command", f"主题：{name}", "命令", None,
                                          action=lambda n=name: self.themeRequested.emit(n)))
            if hits:
                groups.append(("命令", hits))
        else:
            groups = self._engine.global_search(q).groups()

        for group_label, hits in groups:
            head = QListWidgetItem(f"  {group_label}")
            head.setFlags(Qt.NoItemFlags)
            head.setForeground(QColor(fg2))
            head.setSizeHint(QSize(head.sizeHint().width(), 26))
            self.list.addItem(head)
            for h in hits:
                self._add_hit(h, fg2)

        if not self._hits and q:
            self._add_hit(SearchHit("command", f"新建笔记「{q}」", "命令", None,
                                    action=lambda: self.createNoteRequested.emit(q)), fg2)

        if self.list.count():
            self.list.setCurrentRow(1 if self.list.count() > 1 else 0)

    def _run_current(self):
        row = self.list.currentRow()
        item = self.list.item(row) if row >= 0 else None
        idx = item.data(Qt.UserRole) if item else None
        if idx is None:
            return
        hit = self._hits[idx]
        self.accept()
        if hit.action:
            hit.action()
        else:
            self.activated.emit(hit.kind, hit.payload)

    def _restyle(self):
        """在 UDialog 大圆角实色基础上，补命令面板自己的控件样式。"""
        super()._restyle()          # UDialog：#uiDialog 16px 圆角 + layer 实色 + 标题栏
        eng = ThemeEngine.instance()
        if not eng:
            return
        t = eng.tokens
        self.setStyleSheet(self.styleSheet() + "\n" +
                           f"CommandPalette {{ background: transparent; }}"
                           f"QListWidget {{ border: none; }}")


class _PaletteInput(QWidget):
    """搜索输入（带左图标）。"""

    returnPressed = Signal()
    textChanged = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self.edit = QLineEdit()
        self.edit.returnPressed.connect(self.returnPressed.emit)
        self.edit.textChanged.connect(self.textChanged.emit)
        lay.addWidget(self.edit)

    def setPlaceholderText(self, t):  # noqa: N802
        self.edit.setPlaceholderText(t)

    def clear(self):
        self.edit.clear()

    def text(self) -> str:
        return self.edit.text()

    def setFocus(self):
        self.edit.setFocus()
