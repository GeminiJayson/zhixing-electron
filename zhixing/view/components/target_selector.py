# -*- coding: utf-8 -*-
"""捕获目标选择器：加入分组 / 加为子任务 的内联选择（最近使用 + 模糊搜索）。"""
from typing import List, Optional

from PySide6.QtCore import Qt, Signal, QSize
from PySide6.QtWidgets import (QFrame, QHBoxLayout, QListWidgetItem, QVBoxLayout)

from ..kit.icons import icon
from qfluent_core import ThemeManager as ThemeEngine
from zhixing.view.kit.fluent_compat import QLabel, QLineEdit
from zhixing.view.kit.fluent_compat import QListWidget


def _fg2() -> str:
    eng = ThemeEngine.instance()
    return eng.t("fg2", "#6B7280") if eng else "#6B7280"


class TargetSelector(QFrame):
    """捕获卡内嵌目标选择器。

    mode='group'：展示分组/列表树（最近使用置顶），确认返回 (list_id, name)。
    mode='subtask'：模糊搜索任务标题，确认返回 (task_id, title)。
    """

    picked = Signal(int, str)      # 目标 id, 名称
    cancelled = Signal()

    def __init__(self, task_service, settings_service, mode: str, parent=None):
        super().__init__(parent)
        self.task_service = task_service
        self.settings = settings_service
        self.mode = mode
        self.setFixedHeight(230)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(8, 8, 8, 8)
        lay.setSpacing(6)

        row = QHBoxLayout()
        back = QLabel()
        back.setPixmap(icon("action.back", _fg2(), 16).pixmap(16, 16))
        back.setCursor(Qt.PointingHandCursor)
        back.setToolTip("返回")
        back.mousePressEvent = lambda ev: self.cancelled.emit()
        self.hint = QLabel("选择目标分组（内容将成为新任务）" if mode == "group"
                           else "选择父任务，内容将成为其子待办")
        self.hint.setStyleSheet(f"color: {_fg2()}; background: transparent;")
        row.addWidget(back)
        row.addWidget(self.hint)
        row.addStretch(1)
        lay.addLayout(row)

        self.search = QLineEdit()
        self.search.setPlaceholderText("键入即搜索…")
        self.search.textChanged.connect(self._reload)
        lay.addWidget(self.search)

        self.list = QListWidget()
        self.list.itemActivated.connect(self._activate)
        self.list.itemClicked.connect(self._activate)
        lay.addWidget(self.list)

        self.recent_key = "capture_recent_groups" if mode == "group" else "capture_recent_tasks"
        self._restyle()
        self._reload()

    # ---------- 数据 ----------
    def _reload(self):
        self.list.clear()
        q = self.search.text().strip()
        eng = ThemeEngine.instance()
        fg2 = eng.t("fg2", "#6B7280") if eng else "#6B7280"
        recents = (self.settings.ui_state() or {}).get(self.recent_key, [])

        if self.mode == "group":
            folders = self.task_service.folder_tree()
            # G 模式「键入即模糊搜索」（F11-8）：按搜索词过滤名称
            if q:
                folders = [f for f in folders if q.lower() in (f.name or "").lower()]
            rec_map = {f.id: f for f in folders}
            rec_ids = [rid for rid in recents if rid in rec_map]
            for rid in rec_ids:
                f = rec_map[rid]
                self._add_item(f.name, f.id, f.name, fg2, icon_name="task.calendar")
            # 树形呈现：按 parent_id 建树，嵌套缩进（F11-8）
            shown = set(rec_ids)
            by_parent = {}
            for f in folders:
                by_parent.setdefault(f.parent_id, []).append(f)

            def walk(parent_id, depth):
                for f in sorted(by_parent.get(parent_id, []),
                                key=lambda x: (x.sort or 0.0, x.id or 0)):
                    if f.id in shown:
                        continue
                    prefix = "· " if f.kind.value == "list" else ""
                    self._add_item("　" * depth + prefix + f.name, f.id, f.name, fg2,
                                   icon_name="folder.folder" if f.kind.value != "list" else "nav.tasks")
                    walk(f.id, depth + 1)

            walk(None, 0)
        else:
            for rid in recents:
                t = self.task_service.get(rid)
                if t and not t.is_done:
                    self._add_item(t.title, t.id, t.title, fg2)
            # MVC 收口：候选经 task_service.task_candidates 只读 facade，不再直连 db.session/仓储。
            for t in self.task_service.task_candidates(q):
                self._add_item(t.title, t.id, t.title, fg2)

    def _add_item(self, label, payload, name, fg2, icon_name="nav.tasks"):
        item = QListWidgetItem(icon(icon_name, fg2, 15), label)
        item.setData(Qt.UserRole, (payload, name))
        item.setSizeHint(QSize(item.sizeHint().width(), 30))
        self.list.addItem(item)

    def _activate(self, item: QListWidgetItem):
        payload = item.data(Qt.UserRole)
        if not payload:
            return
        target_id, name = payload
        self._remember(target_id)
        self.picked.emit(target_id, name)

    def _remember(self, target_id: int):
        state = self.settings.ui_state()
        rec = state.get(self.recent_key, [])
        if target_id in rec:
            rec.remove(target_id)
        rec.insert(0, target_id)
        self.settings.ui_set(self.recent_key, rec[:3])

    def popup(self):
        self.setVisible(True)
        self.search.setFocus()
        self._reload()

    def _restyle(self):
        eng = ThemeEngine.instance()
        if eng:
            self.setStyleSheet(
                f"TargetSelector {{ background: {eng.t('layer', '#FFFFFF')};"
                f"border: 1px solid {eng.t('border', '#E5E5E5')}; border-radius: 8px; }}")

