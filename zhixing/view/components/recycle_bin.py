# -*- coding: utf-8 -*-
"""回收站对话框（F9-3）：任务 / 笔记 / 闪念的软删除记录，支持还原 / 彻底删除 / 清空。"""
from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (QDialog, QHBoxLayout, QListWidgetItem, QStackedWidget, QVBoxLayout, QWidget)

from qfluent_core import ThemeManager as ThemeEngine
from ..ui import DialogType, UButton, UDialog
from .general import EmptyState
from zhixing.view.kit.fluent_compat import QLabel, QTabWidget
from zhixing.view.kit.fluent_compat import QListWidget


def _fg2() -> str:
    eng = ThemeEngine.instance()
    return eng.t("fg2", "#6B7280") if eng else "#6B7280"


def _fmt_time(dt):
    if dt is None:
        return ""
    try:
        return dt.strftime("%m-%d %H:%M")
    except Exception:
        return ""


class RecycleBinDialog(UDialog):
    """回收站：三 Tab 展示软删除记录，操作后由调用方刷新。"""

    changed = Signal()

    def __init__(self, ctx, parent=None):
        super().__init__(title="回收站", parent=parent,
                         dialog_type=DialogType.RESIZABLE, icon_name="action.refresh",
                         width=560, height=480)
        self.ctx = ctx
        content = QWidget()
        lay = QVBoxLayout(content)
        lay.setContentsMargins(14, 14, 14, 14)
        lay.setSpacing(10)

        tip = QLabel("删除的内容在这里保留 30 天，可还原或彻底清除。")
        tip.setStyleSheet(f"color: {_fg2()};")
        lay.addWidget(tip)

        self.tabs = QTabWidget()
        self._task_list = QListWidget()
        self._note_list = QListWidget()
        self._flash_list = QListWidget()
        self._list_stacks = {}   # list -> QStackedWidget（列表 / 空态切换，T10）
        for lst, title, empty_text in (
                (self._task_list, "任务", "回收站暂无任务，删除的任务会出现在这里"),
                (self._note_list, "笔记", "回收站暂无笔记，删除的笔记会出现在这里"),
                (self._flash_list, "闪念", "回收站暂无闪念，删除的闪念会出现在这里")):
            lst.setSelectionMode(QListWidget.ExtendedSelection)
            stack = QStackedWidget()
            stack.addWidget(lst)
            empty = EmptyState("data.trash", empty_text, "", stack)
            stack.addWidget(empty)
            self._list_stacks[lst] = stack
            self.tabs.addTab(stack, title)
        from ..kit.motion import attach_tab_fade
        attach_tab_fade(self.tabs)
        lay.addWidget(self.tabs, 1)

        btns = QHBoxLayout()
        self.restore_btn = UButton("还原", tone="accent", kind="solid")
        self.restore_btn.clicked.connect(self._restore)
        self.purge_btn = UButton("彻底删除", tone="danger", kind="ghost")
        self.purge_btn.clicked.connect(self._purge)
        self.empty_btn = UButton("清空回收站", tone="danger", kind="solid")
        self.empty_btn.clicked.connect(self._empty)
        close_btn = UButton("关闭", tone="default", kind="ghost")
        close_btn.clicked.connect(self.accept)
        btns.addWidget(self.restore_btn)
        btns.addWidget(self.purge_btn)
        btns.addStretch(1)
        btns.addWidget(self.empty_btn)
        btns.addWidget(close_btn)
        lay.addLayout(btns)
        self.setContentWidget(content)

        self.reload()
        ThemeEngine.instance() and ThemeEngine.instance().changed.connect(self._restyle)

    # ---------- 数据 ----------
    def _current_list(self):
        idx = self.tabs.currentIndex()
        return (self._task_list, self._note_list, self._flash_list)[idx]

    def _current_kind(self):
        return ("task", "note", "flash")[self.tabs.currentIndex()]

    def reload(self):
        self._task_list.clear()
        self._note_list.clear()
        self._flash_list.clear()
        try:
            for t in self.ctx.task_service.trash():
                item = QListWidgetItem(f"「{t.title or '（无标题）'}」  {_fmt_time(t.deleted_at)}")
                item.setData(Qt.UserRole, t.id)
                self._task_list.addItem(item)
        except Exception:
            pass
        try:
            for n in self.ctx.note_service.trash():
                item = QListWidgetItem(f"「{n.title or '（无标题）'}」  {_fmt_time(n.deleted_at)}")
                item.setData(Qt.UserRole, n.id)
                self._note_list.addItem(item)
        except Exception:
            pass
        try:
            for f in self.ctx.flash_service.trash():
                title = (f.content or "").split("\n")[0][:40] or "闪念"
                item = QListWidgetItem(f"「{title}」  {_fmt_time(f.deleted_at)}")
                item.setData(Qt.UserRole, f.id)
                self._flash_list.addItem(item)
        except Exception:
            pass
        self._update_tab_titles()

    def _sync_empty_states(self):
        """T10: 各 Tab 空态切换——列表为空时显示 EmptyState 页，否则显示列表页。"""
        for lst, stack in self._list_stacks.items():
            stack.setCurrentIndex(0 if lst.count() else 1)

    def _update_tab_titles(self):
        self.tabs.setTabText(0, f"任务 {self._task_list.count()}")
        self.tabs.setTabText(1, f"笔记 {self._note_list.count()}")
        self.tabs.setTabText(2, f"闪念 {self._flash_list.count()}")
        self._sync_empty_states()

    def _selected_ids(self):
        lst = self._current_list()
        return [lst.item(i).data(Qt.UserRole) for i in range(lst.count())
                if lst.item(i).isSelected()]

    # ---------- 动作 ----------
    def _restore(self):
        kind = self._current_kind()
        ids = self._selected_ids()
        for i in ids:
            if kind == "task":
                self.ctx.task_service.restore(i)
            elif kind == "note":
                self.ctx.note_service.restore(i)
            else:
                self.ctx.flash_service.restore(i)
        self.changed.emit()
        self.reload()

    def _purge(self):
        kind = self._current_kind()
        ids = self._selected_ids()
        for i in ids:
            if kind == "task":
                self.ctx.task_service.purge(i)
            elif kind == "note":
                self.ctx.note_service.purge(i)
            else:
                self.ctx.flash_service.purge(i)
        self.changed.emit()
        self.reload()

    def _empty(self):
        for t in self.ctx.task_service.trash():
            self.ctx.task_service.purge(t.id)
        for n in self.ctx.note_service.trash():
            self.ctx.note_service.purge(n.id)
        for f in self.ctx.flash_service.trash():
            self.ctx.flash_service.purge(f.id)
        self.changed.emit()
        self.reload()

    def _restyle(self):
        eng = ThemeEngine.instance()
        if eng:
            self.setStyleSheet(f"RecycleBinDialog {{ background: {eng.t('layer', '#FFFFFF')}; }}")
