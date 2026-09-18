# -*- coding: utf-8 -*-
"""今日页：概览卡 + 今日/逾期任务 + 最近笔记 + 顶部快速添加。"""
from datetime import date

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtWidgets import (QFrame, QHBoxLayout, QTreeView, QVBoxLayout, QWidget)

from ...core import settings_keys as K
from ...model.qt.models import TaskTreeModel
from ..components.general import EmptyState, IconWidget, SectionHeader, StatCard
from ..delegates.task_delegate import TaskDelegate
from ..ui import UCard, UTitle, PageHeader
from qfluent_core import ThemeManager as ThemeEngine
from zhixing.view.kit.fluent_compat import QLabel, QLineEdit


class _NoteRow(QFrame):
    """今日页「最近笔记」单行：整行可点击，跳转到对应笔记。"""

    clicked = Signal(int)   # note_id

    def __init__(self, note_id: int, title: str, time_text: str,
                 accent: str, fg2: str, parent=None):
        super().__init__(parent)
        self._note_id = note_id
        self.setCursor(Qt.PointingHandCursor)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(4, 4, 4, 4)
        lay.setSpacing(6)
        ic = IconWidget("nav.notes", 15)
        lbl = QLabel(title)
        lbl.setStyleSheet(f"background: transparent; color: {accent};")
        time_lbl = QLabel(time_text)
        time_lbl.setStyleSheet(f"background: transparent; color: {fg2}; font-size:12px;")
        for w in (ic, lbl, time_lbl):
            w.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        lay.addWidget(ic)
        lay.addWidget(lbl)
        lay.addStretch(1)
        lay.addWidget(time_lbl)

    def mouseReleaseEvent(self, ev):  # noqa: N802
        if ev.button() == Qt.LeftButton:
            self.clicked.emit(self._note_id)
        super().mouseReleaseEvent(ev)


class TodayPage(QWidget):
    toggleRequested = Signal(int)
    openTaskRequested = Signal(int)
    noteOpenRequested = Signal(int)   # 最近笔记点击 → 跳转笔记
    quickAddRequested = Signal(str)
    jumpRequested = Signal(str)
    # 今日页无 task_service，快捷编辑/删除上抛到 controller 执行
    deleteRequested = Signal(int)
    editPriorityRequested = Signal(int)
    editTagsRequested = Signal(int)
    addSubtaskRequested = Signal(int)
    focusRequested = Signal(int)
    titleEditCommitted = Signal(int, str)

    def __init__(self, parent=None, settings=None, tag_provider=None):
        super().__init__(parent)
        self.settings = settings
        self._tag_provider = tag_provider
        self._build()
        self._restyle()
        ThemeEngine.instance() and ThemeEngine.instance().changed.connect(self._restyle)

    def _build(self):
        outer = QVBoxLayout(self)
        outer.setContentsMargins(28, 20, 28, 20)
        outer.setSpacing(12)

        self.header = PageHeader("今天", "在此查看今日待办、概览与最近笔记")
        self.greeting = self.header.title_label
        outer.addWidget(self.header)

        # 概览卡
        cards = QHBoxLayout()
        cards.setSpacing(12)
        from qfluent_core import ThemeManager as ThemeEngine
        eng = ThemeEngine.instance()
        accent = eng.t("accent", "#0D9488") if eng else "#0D9488"
        warm = eng.t("warm", "#EA580C") if eng else "#EA580C"
        success = eng.t("success", "#16A34A") if eng else "#16A34A"
        self.card_due = StatCard("nav.tasks", "今日待办", accent)
        self.card_done = StatCard("action.check", "已完成", success)
        self.card_over = StatCard("warn.overdue", "已逾期", warm)
        self.card_flash = StatCard("nav.flash", "闪念收件箱", "#7C3AED")
        self.card_due.clicked.connect(lambda: self._jump("today"))
        self.card_done.clicked.connect(lambda: self._jump("done"))
        self.card_over.clicked.connect(lambda: self._jump("overdue"))
        self.card_flash.clicked.connect(lambda: self._jump("flash"))
        for c in (self.card_due, self.card_done, self.card_over, self.card_flash):
            c.setFixedHeight(74)   # 紧凑固定高度：贴合「图标 + 大数字 + 标题」，去掉多余留白
            cards.addWidget(c, 1)
        outer.addLayout(cards)

        # 快速添加
        self.quick_input = QLineEdit()
        self.quick_input.setPlaceholderText("快速添加今日任务，回车确认（支持 !2 @列表 #标签 明天）")
        self.quick_input.returnPressed.connect(
            lambda: (self.quickAddRequested.emit(self.quick_input.text()),
                     self.quick_input.clear()))
        outer.addWidget(self.quick_input)

        # 今日待办 —— 沉浸式 UCard 分区（今天到期/逾期根任务及其子树）
        self.card_tasks = UCard("今日待办")
        self.task_model = TaskTreeModel(self, tag_provider=self._tag_provider)
        self.tree = QTreeView()
        self.tree.setModel(self.task_model)
        self.tree.setHeaderHidden(True)
        self.tree.setRootIsDecorated(False)
        self.tree.setIndentation(0)
        self.tree.setFrameShape(QTreeView.NoFrame)
        self.tree.setExpandsOnDoubleClick(False)
        self.delegate = TaskDelegate(
            self.tree, show_actions=True,
            row_height=self._row_height(), indent=self._indent(), inline_edit=True)
        self.tree.setItemDelegate(self.delegate)
        self.delegate.toggleRequested.connect(self.toggleRequested.emit)
        self.delegate.openRequested.connect(self.openTaskRequested.emit)
        self.delegate.toggleExpandRequested.connect(self._toggle_expand)
        self.delegate.editPriorityRequested.connect(self.editPriorityRequested.emit)
        self.delegate.editTagsRequested.connect(self.editTagsRequested.emit)
        self.delegate.addSubtaskRequested.connect(self.addSubtaskRequested.emit)
        self.delegate.focusRequested.connect(self.focusRequested.emit)
        self.delegate.deleteRequested.connect(self.deleteRequested.emit)
        self.delegate.titleEditRequested.connect(self.begin_inline_edit)
        self.delegate.titleCommitted.connect(self._on_inline_title_committed)
        host_t = QWidget()
        lay_t = QVBoxLayout(host_t)
        lay_t.setContentsMargins(0, 0, 0, 0)
        lay_t.setSpacing(4)
        lay_t.addWidget(self.tree, 1)
        self.empty = EmptyState("nav.today", "今天没有任务，享受当下，或直接在上面输入一条", "", host_t)
        lay_t.addWidget(self.empty)
        self.card_tasks.add_widget(host_t)
        outer.addWidget(self.card_tasks, 1)

        # 最近笔记 —— 沉浸式 UCard 分区
        self.card_notes = UCard("最近笔记")
        host_n = QWidget()
        lay_n = QVBoxLayout(host_n)
        lay_n.setContentsMargins(0, 0, 0, 0)
        lay_n.setSpacing(6)
        self.recent_wrap = QVBoxLayout()
        self.recent_wrap.setSpacing(4)
        lay_n.addLayout(self.recent_wrap)
        self.card_notes.add_widget(host_n, 0)
        outer.addWidget(self.card_notes)

    def set_stats(self, counts: dict):
        self.card_due.set_value(counts.get("today_due", 0))
        self.card_done.set_value(counts.get("done_today", 0))
        self.card_over.set_value(counts.get("overdue", 0))
        self.card_flash.set_value(counts.get("flash", 0))

    def set_recent_notes(self, notes):
        self._recent_notes = list(notes or [])
        while self.recent_wrap.count():
            item = self.recent_wrap.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        eng = ThemeEngine.instance()
        fg2 = eng.t("fg2", "#6B7280") if eng else "#6B7280"
        accent = eng.t("accent", "#0D9488") if eng else "#0D9488"
        for n in notes[:5]:
            time_text = n.updated_at.strftime("%m-%d %H:%M") if n.updated_at else ""
            row = _NoteRow(n.id, n.title, time_text, accent, fg2)
            row.clicked.connect(self.noteOpenRequested.emit)
            self.recent_wrap.addWidget(row)

    def set_tree(self, roots):
        self.task_model.reload(roots)
        self.empty.setVisible(not roots)
        self.tree.setVisible(bool(roots))
        self.tree.expandAll()

    def _toggle_expand(self, task_id: int):
        if not task_id:
            return
        idx = self.task_model.index_of(task_id)
        if idx.isValid():
            self.tree.setExpanded(idx, not self.tree.isExpanded(idx))

    # ================= 行高/缩进（设置项） =================
    def _row_height(self) -> int:
        return self.settings.get_int(K.K_TASK_ROW_HEIGHT, 38) if self.settings else 38

    def _indent(self) -> int:
        return self.settings.get_int(K.K_TASK_INDENT, 20) if self.settings else 20

    def apply_row_metrics(self):
        self.delegate.row_height = self._row_height()
        self.delegate.indent = self._indent()
        self.tree.setIndentation(0)
        self.tree.doItemsLayout()
        self.tree.viewport().update()

    # ================= 行内标题编辑 / 展开辅助 =================
    def _index_for(self, task_id: int):
        return self.task_model.index_of(task_id)

    def begin_inline_edit(self, task_id: int):
        if not task_id:
            return
        idx = self._index_for(task_id)
        if not idx.isValid():
            return
        self.tree.setCurrentIndex(idx)
        QTimer.singleShot(0, lambda: self._edit_index(idx))

    def _edit_index(self, idx):
        if idx.isValid():
            self.tree.edit(idx)

    def _on_inline_title_committed(self, task_id: int, text: str):
        QTimer.singleShot(0, lambda: self.titleEditCommitted.emit(task_id, text))

    def expand_task(self, task_id: int):
        idx = self._index_for(task_id)
        if idx.isValid():
            self.tree.expand(idx)

    def refresh_greeting(self):
        today = date.today()
        weeks = "一二三四五六日"
        self.header.set_title(f"{today.month}月{today.day}日 周{weeks[today.weekday()]} · 今日概览")

    def _jump(self, key: str):
        self.jumpRequested.emit(key)

    def _restyle(self):
        eng = ThemeEngine.instance()
        if eng:
            self.setStyleSheet(
                f"TodayPage {{ background: transparent; }}"
                f"QTreeView::item:selected, QTreeView::item:selected:active, "
                f"QTreeView::item:selected:!active {{ "
                f"background: transparent; color: {eng.t('fg', '#1A1A1A')}; }}"
                f"QTreeView::item:hover {{ background: transparent; }}")
            self.quick_input.setStyleSheet(
                f"QLineEdit {{ background: {eng.t('layer', '#FFFFFF')};"
                f"border: 1px solid {eng.t('border', '#E5E5E5')}; border-radius: 8px;"
                f"padding: 6px 12px; }}")
            # 概览卡颜色随主题即时刷新（F9-1 主题自愈，避免动态行残留旧色）
            self.card_due.set_tone(eng.t("accent", "#0D9488"))
            self.card_done.set_tone(eng.t("success", "#16A34A"))
            self.card_over.set_tone(eng.t("warm", "#EA580C"))
            if getattr(self, "_recent_notes", None):
                self.set_recent_notes(self._recent_notes)
