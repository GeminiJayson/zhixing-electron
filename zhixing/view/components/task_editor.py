# -*- coding: utf-8 -*-
"""任务详情编辑面板：全字段编辑 + 关联笔记 + 子任务快捷添加。

v0.18 起编辑面板改为 Tab 分页（水平 Tab 条在上），三个 Tab：
  - 「基本」：基本信息卡（任务名称 / 状态 / 恢复于 / 优先级）
  - 「时间」：时间卡（开始 / 截止「今天/明天」/ 循环 / 自定义 RRULE）
  - 「详情」：标签 + 备注 + 关联笔记 + 关联段落 + 子任务

每个 Tab 页内部各带一个 QScrollArea 独立滚动（长内容不再被压缩），
TaskEditorPanel 自身仍是对外面板容器（QScrollArea + setWidgetResizable），
对外方法/信号/字段（load/clear/task_id/…_edit/…_combo）保持不变。
"""
from datetime import date, timedelta
from typing import Optional

from PySide6.QtCore import Qt, Signal, QDate, QTimer
from PySide6.QtGui import QTextCursor
from PySide6.QtWidgets import (QDialog, QDialogButtonBox, QFrame, QHBoxLayout, QListWidgetItem, QVBoxLayout, QWidget, QScrollArea, QSizePolicy)

from ...model.domain.entities import Priority, RepeatPeriod, Task, TaskStatus
from ..kit import motion
from qfluent_core import ThemeManager as ThemeEngine
from ..ui import UCard
from .general import IconWidget, TagChip, shake
from zhixing.view.kit.fluent_compat import QComboBox, QDateEdit, QLabel, QLineEdit, QPushButton, QTabWidget, QTextEdit
from zhixing.view.kit.fluent_compat import QListWidget
from zhixing.view.kit.fluent_compat import QCheckBox

_STATUS_LABELS = [("todo", "待办"), ("doing", "进行中"), ("waiting", "等待中"),
                  ("done", "已完成"), ("abandoned", "已放弃")]
_REPEAT_LABELS = [("none", "不重复"), ("daily", "每日"), ("weekly", "每周"), ("monthly", "每月"), ("custom", "自定义")]
_PRIORITY_LABELS = None  # v0.17 8 级：改由 kit/priority.priority_choices() 提供


def _priority_combo_items():
    """优先级下拉项 (label, data=int)：无 → P1..P8（P1 低 → P8 高）。"""
    from ..kit.priority import priority_choices
    return [(label, int(v)) for v, label in priority_choices()]


def _find_task(items, task_id):
    """在已装配 children 的任务树中按 id 定位节点。"""
    for t in items:
        if t.id == task_id:
            return t
        hit = _find_task(t.children, task_id)
        if hit:
            return hit
    return None


class TaskEditorPanel(QScrollArea):
    """任务详情编辑面板（主窗右侧抽屉 / 窄窗浮层共用）。

    信号语义保持不变：
      changed(int)          —— task_id（任意字段变化）
      deleted(int)          —— 请求删除任务
      focusRequested(int)   —— 请求开始番茄钟
      noteOpenRequested(int)—— 打开关联笔记
      tagNamesChanged(int, list) —— 标签集合变化
    """

    changed = Signal(int)                 # task_id（任意字段变化）
    deleted = Signal(int)
    focusRequested = Signal(int)          # 请求开始番茄钟
    noteOpenRequested = Signal(int)       # 打开关联笔记
    noteBlockOpenRequested = Signal(int, str)   # v0.15 P0-1: 打开笔记并定位段落 (note_id, block_key)
    tagNamesChanged = Signal(int, list)

    def __init__(self, task_service, note_service, parent=None):
        super().__init__(parent)
        self.task_service = task_service
        self.note_service = note_service
        self._task_id: Optional[int] = None
        self._loading = False

        # 对外仍是滚动面板容器（task_page/_TaskEditDialog/浮窗直接以 panel 为内容区）
        self.setWidgetResizable(True)
        self.setFrameShape(QScrollArea.NoFrame)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        body = QWidget()
        self.setWidget(body)
        self._body_lay = QVBoxLayout(body)
        self._body_lay.setContentsMargins(0, 0, 0, 0)
        self._body_lay.setSpacing(0)

        # v0.18: 编辑页改 Tab 分页，三个 Tab 各自独立滚动
        self.tabs = QTabWidget()
        self.tabs.setDocumentMode(False)
        self._body_lay.addWidget(self.tabs, 1)
        # 复用全项目同款切页动效（尊重 reduce-motion）
        motion.attach_tab_fade(self.tabs)

        basic_lay = self._new_tab_page("基本")
        time_lay = self._new_tab_page("时间")
        detail_lay = self._new_tab_page("详情")

        # 各卡片拆分为独立私有方法，便于阅读与后续扩展
        self._init_basic_card(basic_lay)
        self._init_time_card(time_lay)
        self._init_tag_note_card(detail_lay)
        self._init_link_sub_card(detail_lay)
        # 每个 Tab 页：卡片贴顶，剩余空白不参与拉伸
        for lay in (basic_lay, time_lay, detail_lay):
            lay.addStretch(1)

        self._restyle()
        self.clear()

    def _new_tab_page(self, title: str):
        """新建一个水平 Tab 页：页内自带 QScrollArea 独立滚动，返回页面布局。

        参照设置页 _make_tab 的做法：Tab 页 = QScrollArea(NoFrame) + 内容页贴顶堆卡片，
        保证标签/备注/子任务等长内容在窄高容器里可独立滚动、不被压缩。
        """
        page = QWidget()
        lay = QVBoxLayout(page)
        lay.setContentsMargins(16, 12, 16, 16)
        lay.setSpacing(10)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setWidget(page)
        self.tabs.addTab(scroll, title)
        return lay

    def _add_group(self, title: str, parent_lay: QVBoxLayout):
        """在指定 Tab 页布局里新建一张带清晰组标题的 UCard，并返回其内部布局。"""
        card = UCard(title)
        card.body_layout.setContentsMargins(12, 10, 12, 12)
        card.body_layout.setSpacing(6)
        parent_lay.addWidget(card)
        return card.body_layout

    # ---------- 卡片构造 ----------
    def _init_basic_card(self, lay):
        """「基本信息」卡片（Tab「基本」）：仅 任务名称 + 状态 + 优先级。"""
        basic = self._add_group("基本信息", lay)
        self.title_edit = QLineEdit()
        f = self.title_edit.font()
        f.setBold(True)
        self.title_edit.setFont(f)
        self.title_edit.returnPressed.connect(self.title_edit.clearFocus)
        self.title_edit.editingFinished.connect(self._commit_title)
        basic.addWidget(self.title_edit)

        row = QHBoxLayout()
        self.status_combo = QComboBox()
        self.status_combo.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        for _v, label in _STATUS_LABELS:
            self.status_combo.addItem(label, _v)
        self.status_combo.currentIndexChanged.connect(self._commit_status)
        row.addWidget(QLabel("状态"))
        row.addWidget(self.status_combo, 1)
        basic.addLayout(row)

        # v0.15 P2-8: 等待中可设「恢复日期」（到期自动回待办）；仅 waiting 时显示
        self._resume_default = QDate(1752, 9, 14)   # 与 due/start 同款哨兵「无」
        row_resume = QHBoxLayout()
        row_resume.addWidget(QLabel("恢复于"))
        self.resume_edit = QDateEdit()
        self.resume_edit.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.resume_edit.setCalendarPopup(True)
        self.resume_edit.setDisplayFormat("yyyy-MM-dd")
        self.resume_edit.setSpecialValueText("无")
        self.resume_edit.dateChanged.connect(self._commit_resume)
        row_resume.addWidget(self.resume_edit, 1)
        self.resume_row_widget = QWidget()
        self.resume_row_widget.setLayout(row_resume)
        self.resume_row_widget.setVisible(False)
        basic.addWidget(self.resume_row_widget)
        self.resume_edit.setDate(self._resume_default)

        row_p = QHBoxLayout()
        self.priority_combo = QComboBox()
        self.priority_combo.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        for label, data in _priority_combo_items():
            self.priority_combo.addItem(label, data)
        self.priority_combo.currentIndexChanged.connect(self._commit_priority)
        row_p.addWidget(QLabel("优先级"))
        row_p.addWidget(self.priority_combo, 1)
        basic.addLayout(row_p)

    def _init_time_card(self, lay):
        """「时间」卡片（Tab「时间」）：开始 / 截止（含快捷按钮）/ 循环，含开始→截止联动。"""
        time_g = self._add_group("时间", lay)

        # 记录 QDateEdit 默认最小日期，作为「无日期」的哨兵值。
        # 截止日期的 minimumDate 会随开始日期联动变化，因此不能用它当哨兵，
        # 必须固定用这里的默认最小值判断“是否为空”。
        self._default_min_date = QDate(1752, 9, 14)

        row_start = QHBoxLayout()
        row_start.addWidget(QLabel("开始"))
        self.start_edit = QDateEdit()
        self.start_edit.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.start_edit.setCalendarPopup(True)
        self.start_edit.setDisplayFormat("yyyy-MM-dd")
        self.start_edit.setSpecialValueText("无")
        # 开始日期变化 → 同步截止日期下限 + 提交开始日期
        self.start_edit.dateChanged.connect(self._on_start_date_changed)
        row_start.addWidget(self.start_edit, 1)
        time_g.addLayout(row_start)

        row2 = QHBoxLayout()
        row2.addWidget(QLabel("截止"))
        self.due_edit = QDateEdit()
        self.due_edit.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.due_edit.setCalendarPopup(True)
        self.due_edit.setDisplayFormat("yyyy-MM-dd")
        self.due_edit.setSpecialValueText("无")
        self.due_edit.dateChanged.connect(self._commit_due)
        row2.addWidget(self.due_edit, 1)
        # 「今天」「明天」快捷按钮：固定宽度，缩放不变形
        quick = QPushButton("今天")
        quick.setFlat(True)
        quick.setFixedWidth(56)
        quick.clicked.connect(lambda: self._quick_due(0))
        row2.addWidget(quick)
        quick2 = QPushButton("明天")
        quick2.setFlat(True)
        quick2.setFixedWidth(56)
        quick2.clicked.connect(lambda: self._quick_due(1))
        row2.addWidget(quick2)
        time_g.addLayout(row2)

        row3 = QHBoxLayout()
        row3.addWidget(QLabel("循环"))
        self.repeat_combo = QComboBox()
        self.repeat_combo.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        for _v, label in _REPEAT_LABELS:
            self.repeat_combo.addItem(label, _v)
        self.repeat_combo.currentIndexChanged.connect(self._commit_repeat)
        row3.addWidget(self.repeat_combo, 1)
        time_g.addLayout(row3)

        # 自定义 RRULE 子集（F1-8）：选择「自定义」时显示
        self.repeat_rule_edit = QLineEdit()
        self.repeat_rule_edit.setPlaceholderText("RRULE 子集，如 FREQ=DAILY;INTERVAL=2")
        self.repeat_rule_edit.setVisible(False)
        self.repeat_rule_edit.editingFinished.connect(self._commit_repeat_rule)
        time_g.addWidget(self.repeat_rule_edit)

    def _init_tag_note_card(self, lay):
        """「标签」与「备注」两张卡片（Tab「详情」）。

        标签：输入框在上、已有标签 chip 在下（tag_wrap）。
        备注：QTextEdit，最小高度约 100px，可随内容/可用空间纵向延伸，延迟自动保存。
        """
        tag_g = self._add_group("标签", lay)
        self.tag_edit = QLineEdit()
        self.tag_edit.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.tag_edit.setPlaceholderText("输入标签，回车或逗号分隔")
        self.tag_edit.returnPressed.connect(self._commit_tags)
        tag_g.addWidget(self.tag_edit)
        self.tag_wrap = QHBoxLayout()
        self.tag_wrap.setSpacing(6)
        tag_g.addLayout(self.tag_wrap)

        note_g = self._add_group("备注", lay)
        self.notes_edit = QTextEdit()
        self.notes_edit.setMinimumHeight(100)
        self.notes_edit.setPlaceholderText("支持 [[笔记链接]] 与 Markdown，输入 [[ 弹出补全")
        # 延迟自动保存：与旧 QPlainTextEditSmall 保持一致的 1200ms 去抖语义
        self._notes_timer = QTimer(self)
        self._notes_timer.setSingleShot(True)
        self._notes_timer.setInterval(1200)
        self._notes_timer.timeout.connect(self._commit_notes)
        self.notes_edit.textChanged.connect(self._on_notes_changed)
        # [[ 笔记链接]] 补全（F4-3）：复用 markdown_editor 的轻量候选浮层
        from .markdown_editor import WikiSuggestPopup
        self._wiki_popup = WikiSuggestPopup(self)
        self._wiki_popup.picked.connect(self._insert_wiki_title)
        note_g.addWidget(self.notes_edit)

    def _init_link_sub_card(self, lay):
        """「关联笔记」与「子任务」两张卡片（Tab「详情」）。"""
        # 关联笔记：右侧「+ 挂笔记」按钮，下方列表每项带红色「移除」按钮
        linked_g = self._add_group("关联笔记", lay)
        notes_row = QHBoxLayout()
        notes_row.addStretch(1)
        self.attach_btn = QPushButton("+ 挂笔记")
        self.attach_btn.setFlat(True)
        self.attach_btn.setCursor(Qt.PointingHandCursor)
        self.attach_btn.clicked.connect(self._attach_note)
        notes_row.addWidget(self.attach_btn)
        linked_g.addLayout(notes_row)
        self.linked_wrap = QVBoxLayout()
        self.linked_wrap.setSpacing(4)
        linked_g.addLayout(self.linked_wrap)

        # 子任务：顶部「+ 添加子任务」输入框，下方动态列表
        sub_g = self._add_group("子任务", lay)
        sub_row = QHBoxLayout()
        self.sub_edit = QLineEdit()
        self.sub_edit.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.sub_edit.setPlaceholderText("+ 添加子任务，回车确认")
        self.sub_edit.returnPressed.connect(self._add_subtask)
        sub_row.addWidget(self.sub_edit, 1)
        sub_g.addLayout(sub_row)
        self.sub_list = QVBoxLayout()
        self.sub_list.setSpacing(4)
        sub_g.addLayout(self.sub_list)

    # ---------- 时间联动 ----------
    def _on_start_date_changed(self, qd: QDate):
        """开始日期变化：同步截止下限，防「截止早于开始」，再提交开始日期。"""
        self._sync_due_minimum(qd)
        self._commit_start()

    def _sync_due_minimum(self, start_qd: QDate):
        """按开始日期设置截止日期的 minimumDate；开始为「无」时恢复默认最小日期。"""
        if start_qd.isValid() and start_qd > self._default_min_date:
            # 有效开始日期：截止日期不得早于开始日期
            self.due_edit.setMinimumDate(start_qd)
            if self.due_edit.date() < start_qd:
                self.due_edit.setDate(start_qd)
        else:
            # 「无」开始日期：恢复截止日期的最小默认日期
            self.due_edit.setMinimumDate(self._default_min_date)

    # ---------- 数据绑定 ----------
    def load(self, task: Task):
        self._loading = True
        # v0.18: 每次载入回到第一个 Tab（「基本」），标题聚焦等入口始终落在可见页
        self.tabs.setCurrentIndex(0)
        self._task_id = task.id
        self.title_edit.setText(task.title)
        self._set_combo(self.status_combo, task.status.value)
        # v0.15 P2-8: waiting 显示「恢复于」并加载 resume_at
        resume = getattr(task, "resume_at", None)
        if resume:
            self.resume_edit.setDate(QDate(resume.year, resume.month, resume.day))
        else:
            self.resume_edit.setDate(self._resume_default)
        self._update_resume_row_visibility(TaskStatus(task.status.value))
        self._set_combo(self.priority_combo, int(task.priority))
        # 先设开始日期（触发截止下限联动），再设截止日期
        if task.start_date:
            self.start_edit.setDate(QDate(task.start_date.year, task.start_date.month, task.start_date.day))
        else:
            self.start_edit.setDate(self._default_min_date)
        if task.due_date:
            self.due_edit.setDate(QDate(task.due_date.year, task.due_date.month, task.due_date.day))
        else:
            self.due_edit.setDate(self._default_min_date)
        self._set_combo(self.repeat_combo, task.repeat_period.value)
        self.repeat_rule_edit.setText(getattr(task, "repeat_rule", None) or "")
        self.repeat_rule_edit.setVisible(task.repeat_period.value == "custom")
        # blockSignals 防止 load 写入备注触发延迟保存（避免无意义的回写）
        self.notes_edit.blockSignals(True)
        self.notes_edit.setPlainText(task.notes_md or "")
        self.notes_edit.blockSignals(False)
        self.sub_edit.clear()
        self.tag_edit.clear()
        self._reload_tags(task)
        self._reload_linked_notes(task)
        self._reload_subtasks()
        self._loading = False
        # 循环任务的子任务会在翻篇后重置：轻抖提示（9e）
        if getattr(task, "repeat_period", None) and task.repeat_period.value != "none":
            shake(self, distance=4)
        motion.fade_in(self, "fast", 0)

    def clear(self):
        self._loading = True
        self._task_id = None
        # v0.18: 清空后回到第一个 Tab（「基本」）
        self.tabs.setCurrentIndex(0)
        self.title_edit.clear()
        self.notes_edit.blockSignals(True)
        self.notes_edit.clear()
        self.notes_edit.blockSignals(False)
        self.status_combo.setCurrentIndex(0)
        self.resume_edit.setDate(self._resume_default)
        self._update_resume_row_visibility(TaskStatus.TODO)
        self.priority_combo.setCurrentIndex(0)
        self.repeat_combo.setCurrentIndex(0)
        self.start_edit.setDate(self._default_min_date)
        # 清空：恢复截止日期最小默认日期
        self.due_edit.setMinimumDate(self._default_min_date)
        self.due_edit.setDate(self._default_min_date)
        self.sub_edit.clear()
        self.tag_edit.clear()
        self._clear_sub_list()
        self._clear_layout(self.tag_wrap)
        self._clear_layout(self.linked_wrap)
        self._loading = False

    def task_id(self):
        return self._task_id

    # ---------- 提交 ----------
    def _commit_title(self):
        """标题编辑失焦/回车后持久化（F2 重命名依赖此提交）。"""
        if self._loading or not self._task_id:
            return
        title = self.title_edit.text().strip()
        if not title:
            t = self.task_service.get(self._task_id)
            if t:
                self.title_edit.setText(t.title)
            return
        self.task_service.update(self._task_id, title=title)

    def _commit_status(self):
        if self._loading or not self._task_id:
            return
        status = TaskStatus(self.status_combo.currentData())
        kwargs = {"status": status}
        # 离开 waiting → 清恢复日期；进入 waiting 且有日期则一并提交
        if status != TaskStatus.WAITING:
            kwargs["resume_at"] = None
        elif self.resume_edit.date() > self._resume_default:
            qd = self.resume_edit.date()
            kwargs["resume_at"] = date(qd.year(), qd.month(), qd.day())
        self._update_resume_row_visibility(status)
        t = self.task_service.update(self._task_id, **kwargs)
        if t and t.status == TaskStatus.DONE:
            self.changed.emit(self._task_id)

    def _commit_resume(self):
        """恢复日期变化（仅 waiting 显示时可达）。"""
        if self._loading or not self._task_id:
            return
        if TaskStatus(self.status_combo.currentData()) != TaskStatus.WAITING:
            return
        qd = self.resume_edit.date()
        if qd <= self._resume_default:
            self.task_service.update(self._task_id, resume_at=None)
        else:
            self.task_service.update(self._task_id,
                                     resume_at=date(qd.year(), qd.month(), qd.day()))

    def _update_resume_row_visibility(self, status: TaskStatus):
        self.resume_row_widget.setVisible(status == TaskStatus.WAITING)

    def _commit_priority(self):
        if self._loading or not self._task_id:
            return
        self.task_service.update(self._task_id, priority=Priority(self.priority_combo.currentData()))

    def _commit_due(self):
        if self._loading or not self._task_id:
            return
        qd = self.due_edit.date()
        if qd <= self._default_min_date:
            self.task_service.update(self._task_id, due_date=None)
        else:
            self.task_service.update(self._task_id,
                                     due_date=date(qd.year(), qd.month(), qd.day()))

    def _commit_start(self):
        if self._loading or not self._task_id:
            return
        qd = self.start_edit.date()
        if qd <= self._default_min_date:
            self.task_service.update(self._task_id, start_date=None)
        else:
            self.task_service.update(self._task_id,
                                     start_date=date(qd.year(), qd.month(), qd.day()))

    def _quick_due(self, offset: int):
        """把截止日期设为今天/明天（offset=0/1），受开始日期下限约束自动钳制。"""
        d = date.today() + timedelta(days=offset)
        self.due_edit.setDate(QDate(d.year, d.month, d.day))

    def _commit_repeat(self):
        if self._loading or not self._task_id:
            return
        period = RepeatPeriod(self.repeat_combo.currentData())
        is_custom = period == RepeatPeriod.CUSTOM
        self.repeat_rule_edit.setVisible(is_custom)
        self.task_service.update(self._task_id, repeat_period=period,
                                 repeat_rule=(self.repeat_rule_edit.text().strip()
                                              if is_custom else None))

    def _commit_repeat_rule(self):
        if self._loading or not self._task_id:
            return
        if RepeatPeriod(self.repeat_combo.currentData()) == RepeatPeriod.CUSTOM:
            self.task_service.update(self._task_id,
                                     repeat_rule=self.repeat_rule_edit.text().strip())

    def _commit_notes(self):
        if self._loading or not self._task_id:
            return
        self.task_service.update(self._task_id, notes_md=self.notes_edit.toPlainText())

    def _on_notes_changed(self):
        self._notes_timer.start()
        self._maybe_complete_wiki()

    def _maybe_complete_wiki(self):
        """备注输入 [[ 时弹出笔记标题补全（F4-3）。"""
        if not self.note_service or not hasattr(self.note_service, "list"):
            return
        cur = self.notes_edit.textCursor()
        before = cur.block().text()[:cur.positionInBlock()]
        idx = before.rfind("[[")
        if idx < 0:
            self._wiki_popup.hide()
            return
        prefix = before[idx + 2:]
        if "]" in prefix or "\n" in prefix:
            self._wiki_popup.hide()
            return
        try:
            titles = [n.title for n in self.note_service.list(q=prefix)][:8]
            if not titles and not prefix:
                titles = [n.title for n in self.note_service.recent(8)]
        except Exception:
            titles = []
        if titles:
            pos = self.notes_edit.mapToGlobal(self.notes_edit.cursorRect().bottomLeft())
            self._wiki_popup.move(pos)
            self._wiki_popup.show_titles(titles)
        else:
            self._wiki_popup.hide()

    def _insert_wiki_title(self, title: str):
        cur = self.notes_edit.textCursor()
        before = cur.block().text()[:cur.positionInBlock()]
        start = before.rfind("[[")
        if start >= 0:
            cur.movePosition(QTextCursor.Left, QTextCursor.KeepAnchor,
                             cur.positionInBlock() - start)
            cur.removeSelectedText()
        cur.insertText(f"[[{title}]]")
        self._wiki_popup.hide()
        self.notes_edit.setFocus()

    def _commit_tags(self):
        if self._loading or not self._task_id:
            return
        names = [x.strip().lstrip("#") for x in self.tag_edit.text().replace("，", ",").split(",")]
        names = [x for x in names if x]
        if not names:
            return
        self.task_service.set_tags(self._task_id, names)
        self.tag_edit.clear()
        t = self.task_service.get(self._task_id)
        if t:
            self._reload_tags(t)
        self.tagNamesChanged.emit(self._task_id, names)

    def _add_subtask(self):
        if self._loading or not self._task_id:
            return
        title = self.sub_edit.text().strip()
        if title:
            task = self.task_service.add_subtask(self._task_id, title)
            self.sub_edit.clear()
            self._reload_subtasks()
            if task:
                self.changed.emit(self._task_id)

    # ---------- 子任务列表 ----------
    def _clear_layout(self, layout):
        """清空布局内的所有子项并释放 widget。"""
        while layout.count():
            item = layout.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()

    def _clear_sub_list(self):
        self._clear_layout(self.sub_list)

    def _reload_subtasks(self):
        """重建子任务列表：每项左侧 QCheckBox（勾选=完成），右侧红色「删除」按钮。"""
        self._clear_sub_list()
        if not self.task_service or not self._task_id:
            return
        try:
            roots = self.task_service.all_tree()
        except Exception:
            return
        node = _find_task(roots, self._task_id)
        eng = ThemeEngine.instance()
        fg = eng.t("fg", "#1A1A1A") if eng else "#1A1A1A"
        fg2 = eng.t("fg2", "#6B7280") if eng else "#6B7280"
        danger = eng.t("danger", "#DC2626") if eng else "#DC2626"
        for c in (node.children if node else []):
            done = c.is_done
            row = QHBoxLayout()
            row.setContentsMargins(0, 0, 0, 0)
            cb = QCheckBox(c.title)
            # 先屏蔽信号再设勾选态，避免初始化时误触发 toggle_complete
            cb.blockSignals(True)
            cb.setChecked(done)
            cb.blockSignals(False)
            cb.setStyleSheet(
                f"QCheckBox {{ color: {fg2 if done else fg}; background: transparent; }}"
                + ("QCheckBox {{ text-decoration: line-through; }}" if done else ""))
            cb.clicked.connect(lambda _checked=False, cid=c.id: self._toggle_subtask(cid))
            rm = QPushButton("删除")
            rm.setFlat(True)
            rm.setCursor(Qt.PointingHandCursor)
            rm.setStyleSheet(
                f"font-size:12px; color: {danger}; background: transparent; padding: 2px 6px;")
            rm.clicked.connect(lambda _=False, cid=c.id: self._delete_subtask(cid))
            row.addWidget(cb, 1)
            row.addWidget(rm)
            w = QFrame()
            w.setLayout(row)
            w.setStyleSheet("QFrame { background: transparent; }")
            self.sub_list.addWidget(w)

    def _toggle_subtask(self, subtask_id: int):
        """勾选/取消勾选子任务 → 切换完成状态并刷新。"""
        if not self.task_service or not self._task_id:
            return
        try:
            self.task_service.toggle_complete(subtask_id)
        except Exception:
            pass
        self._reload_subtasks()
        self.changed.emit(self._task_id)

    def _delete_subtask(self, subtask_id: int):
        """删除子任务并刷新列表。"""
        if not self.task_service or not self._task_id:
            return
        try:
            self.task_service.delete(subtask_id)
        except Exception:
            pass
        self._reload_subtasks()
        self.changed.emit(self._task_id)

    # ---------- 标签 ----------
    def _reload_tags(self, task: Task):
        self._clear_layout(self.tag_wrap)
        # MVC 收口：标签经 task_service.tag_map 只读 facade 装配，不再直连 db.session/TagRow。
        try:
            tags = self.task_service.tag_map([task.id]).get(task.id, [])
        except Exception:
            tags = []
        for _tid, name, color in tags:
            chip = TagChip(name, color, removable=True)
            chip.clicked.connect(lambda _=False, n=name: self._remove_tag(n))
            self.tag_wrap.addWidget(chip)
        self.tag_wrap.addStretch(1)

    def _remove_tag(self, name: str):
        """从当前任务移除指定名称的标签并刷新 chip 展示。"""
        if not self._task_id or not self.task_service:
            return
        try:
            tags = self.task_service.tag_map([self._task_id]).get(self._task_id, [])
        except Exception:
            tags = []
        names = [n for (_tid, n, _c) in tags if n != name]
        self.task_service.set_tags(self._task_id, names)
        t = self.task_service.get(self._task_id)
        if t:
            self._reload_tags(t)
        self.tagNamesChanged.emit(self._task_id, names)

    # ---------- 关联笔记 ----------
    def _attach_note(self):
        """关联笔记改为搜索挂载（F4-1/W11）：弹搜索框，输入关键词过滤笔记。"""
        if not self._task_id or not self.note_service:
            return
        dlg = _NoteSearchDialog(self.note_service, self)
        if dlg.exec() == QDialog.Accepted and dlg.selected_id is not None:
            self._do_attach(dlg.selected_id)

    def _do_attach(self, note_id: int):
        if self._task_id:
            self.task_service.attach_note(self._task_id, note_id)
            t = self.task_service.get(self._task_id)
            if t:
                self._reload_linked_notes(t)

    def _reload_linked_notes(self, task: Task):
        self._clear_layout(self.linked_wrap)
        eng = ThemeEngine.instance()
        danger = eng.t("danger", "#DC2626") if eng else "#DC2626"
        accent = eng.t("accent", "#0D9488") if eng else "#0D9488"
        # v0.15 P0-1: 段落级定位信息（note_id → [(block_key, snippet首行)]）
        ctx_map = {}
        try:
            for c in self.task_service.linked_contexts(task.id):
                ctx_map.setdefault(c.note_id, []).append((c.block_key, c.snippet))
        except Exception:
            pass
        for n in self.task_service.linked_notes(task.id):
            row = QHBoxLayout()
            ic = IconWidget("nav.notes", 14)
            lbl = QLabel(n.title)
            lbl.setStyleSheet("background: transparent;")
            lbl.setCursor(Qt.PointingHandCursor)
            lbl.mousePressEvent = lambda ev, nid=n.id: self.noteOpenRequested.emit(nid)
            row.addWidget(ic)
            row.addWidget(lbl)
            row.addStretch(1)
            ctxs = ctx_map.get(n.id) or []
            if ctxs:
                # 段落定位小按钮：「§ 首行…」悬浮展示 snippet，点击跳转定位
                bkey = ctxs[0][0]
                snip = (ctxs[0][1] or "").strip().replace("\n", " ")
                label = f"§ {snip[:14]}…" if snip else "§ 定位段落"
                btn = QPushButton(label)
                btn.setFlat(True)
                btn.setCursor(Qt.PointingHandCursor)
                btn.setToolTip(snip or "跳转到关联段落")
                btn.setStyleSheet(
                    f"font-size:12px; color: {accent}; background: transparent;"
                    f"padding: 2px 6px; border: none;")
                btn.clicked.connect(
                    lambda _=False, nid=n.id, bk=bkey: self.noteBlockOpenRequested.emit(nid, bk))
                row.addWidget(btn)
            rm = QPushButton("移除")
            rm.setFlat(True)
            rm.setCursor(Qt.PointingHandCursor)
            rm.setStyleSheet(
                f"font-size:12px; color: {danger}; background: transparent; padding: 2px 6px;")
            rm.clicked.connect(lambda _=False, nid=n.id: self._do_detach(nid))
            row.addWidget(rm)
            w = QFrame()
            w.setLayout(row)
            w.setStyleSheet("QFrame { background: transparent; }")
            self.linked_wrap.addWidget(w)

    def _do_detach(self, note_id: int):
        if self._task_id:
            self.task_service.detach_note(self._task_id, note_id)
            t = self.task_service.get(self._task_id)
            if t:
                self._reload_linked_notes(t)

    def _set_combo(self, combo: QComboBox, data):
        i = combo.findData(data)
        if i >= 0:
            combo.setCurrentIndex(i)

    def _restyle(self):
        eng = ThemeEngine.instance()
        if eng:
            accent = eng.t("accent", "#0D9488")
            self.setStyleSheet(f"QScrollArea {{ background: transparent; }}"
                               f"QLabel {{ color: {eng.t('fg2', '#6B7280')}; }}")
            self.attach_btn.setStyleSheet(
                f"color: {accent}; background: transparent; padding: 2px 8px; border-radius: 6px;")


class _NoteSearchDialog(QDialog):
    """关联笔记搜索挂载（F4-1/W11）：输入关键词过滤笔记并选中挂载。"""

    def __init__(self, note_service, parent=None):
        super().__init__(parent)
        self.note_service = note_service
        self.selected_id = None
        self.setWindowTitle("挂载笔记")
        self.resize(380, 420)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(12, 12, 12, 12)
        lay.setSpacing(8)

        self.search = QLineEdit()
        self.search.setPlaceholderText("搜索笔记标题…")
        self.search.textChanged.connect(self._reload)
        lay.addWidget(self.search)

        self.list = QListWidget()
        self.list.itemActivated.connect(self._pick)
        lay.addWidget(self.list, 1)

        btns = QDialogButtonBox(QDialogButtonBox.Cancel)
        btns.rejected.connect(self.reject)
        lay.addWidget(btns)
        self._reload()

    def _reload(self):
        self.list.clear()
        q = self.search.text().strip()
        try:
            notes = self.note_service.list(q=q) if hasattr(self.note_service, "list") else []
        except Exception:
            notes = []
        if not notes and not q:
            try:
                notes = self.note_service.recent(10)
            except Exception:
                notes = []
        for n in notes[:30]:
            item = QListWidgetItem(n.title or "（无标题）")
            item.setData(Qt.UserRole, n.id)
            self.list.addItem(item)
        if self.list.count():
            self.list.setCurrentRow(0)

    def _pick(self, item: QListWidgetItem):
        self.selected_id = item.data(Qt.UserRole)
        self.accept()
