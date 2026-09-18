# -*- coding: utf-8 -*-
"""任务页：列表/四象限/日历视图 + 按需弹出的任务编辑页。

列表视图为 TaskTreeModel + TaskDelegate，直接展示「根任务 → 子任务」树；
标签以行内 chip 呈现；每行右侧提供「编辑 / 删除」按钮，编辑时弹出模态编辑页。
键盘：←/→ 折叠展开，Ctrl+↑/↓ 移动排序，N 新任务，F2 重命名（由 shell 转发）。
"""
from datetime import date, timedelta
from typing import Optional

from PySide6.QtCore import (
    QByteArray, QDate, QEvent, QMimeData, QModelIndex, QRect, QSortFilterProxyModel,
    Qt, QTimer, Signal,
)
from PySide6.QtGui import (
    QColor, QCursor, QDrag, QKeySequence, QPainter, QShortcut,
)
from PySide6.QtWidgets import (QAbstractItemView, QApplication, QCalendarWidget, QDialog, QFrame, QGridLayout, QHBoxLayout, QInputDialog, QMessageBox, QSizePolicy, QStackedWidget, QTableView, QToolTip, QTreeView, QVBoxLayout, QWidget)

from ...core import settings_keys as K
from ...model.domain.entities import Priority, Task, TaskStatus
from ...model.qt.models import TaskFilterProxy, TaskTreeModel, RoleTaskId
from ..components.general import EmptyState
from ..components.task_editor import TaskEditorPanel
from ..delegates.task_delegate import TaskDelegate
from qfluent_core import ThemeManager as ThemeEngine
from ..ui import DialogType, UButton, UCard, UDialog, UInputDialog, UTitle, PageHeader
from .kanban import KanbanView
from zhixing.view.kit.fluent_compat import QComboBox, QLabel, QLineEdit, QPushButton
from zhixing.view.kit.fluent_compat import Action, InfoBar, InfoBarPosition, RoundMenu
from zhixing.view.kit.fluent_compat import QCheckBox

_TASK_MIME = "application/x-zhixing-task-id"


class _DraggableTaskFilterProxy(TaskFilterProxy):
    """任务树过滤代理：为拖拽排序补 ItemIsDrag/DropEnabled 与 MIME 声明（不改 models.py）。"""

    def flags(self, index):
        return super().flags(index) | Qt.ItemIsDragEnabled | Qt.ItemIsDropEnabled

    def mimeTypes(self):
        return [_TASK_MIME]

    def canDropMimeData(self, data, action, row, column, parent):
        return data is not None and data.hasFormat(_TASK_MIME)


class _TaskTreeView(QTreeView):
    """任务树：鼠标拖拽排序 + 移动归属（F1-13），拖拽结果经信号上抛，不改 model。"""

    dropRequested = Signal(int, object, str)   # src_id, anchor_id|None, "above"/"below"/"on"/"root"

    def __init__(self, parent=None):
        super().__init__(parent)
        self._pressed_index = QModelIndex()

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self._pressed_index = self.indexAt(event.position().toPoint())
        super().mousePressEvent(event)

    def startDrag(self, supported_actions):
        idx = self._pressed_index if self._pressed_index.isValid() else self.currentIndex()
        src = self._map_to_source(idx)
        tid = src.data(RoleTaskId) if src.isValid() else None
        if tid is None:
            return
        mime = QMimeData()
        mime.setData(_TASK_MIME, QByteArray(str(int(tid)).encode()))
        drag = QDrag(self)
        drag.setMimeData(mime)
        drag.exec(Qt.MoveAction)

    def dropEvent(self, event):
        tid = self._task_id_from(event.mimeData())
        if tid is None:
            event.ignore()
            return
        pos = event.position().toPoint()
        target = self.indexAt(pos)
        anchor_src = self._map_to_source(target) if target.isValid() else QModelIndex()
        anchor_id = anchor_src.data(RoleTaskId) if anchor_src.isValid() else None
        indicator = self.dropIndicatorPosition()
        if anchor_id is None or anchor_id == tid:
            position = "root"
        elif indicator == QAbstractItemView.OnItem:
            position = "on"
        elif indicator == QAbstractItemView.AboveItem:
            position = "above"
        else:
            position = "below"
        self.dropRequested.emit(tid, anchor_id, position)
        event.accept()
        self._pressed_index = QModelIndex()

    def _map_to_source(self, index):
        model = self.model()
        if isinstance(model, QSortFilterProxyModel):
            return model.mapToSource(index)
        return index

    def _task_id_from(self, mime):
        if mime is not None and mime.hasFormat(_TASK_MIME):
            try:
                return int(bytes(mime.data(_TASK_MIME)).decode())
            except (ValueError, UnicodeDecodeError):
                return None
        return None


class TaskPage(QWidget):
    # View → Controller / Shell
    toggleRequested = Signal(int)
    openTaskRequested = Signal(int)
    selectGroupRequested = Signal(str, object)     # kind, payload（保留兼容）
    quickAddRequested = Signal(str, object)        # text, list_id
    moveRequested = Signal(int, str, object)       # task_id, kind, payload（拖拽/菜单移动）
    noteOpenRequested = Signal(int)
    noteBlockOpenRequested = Signal(int, str)   # v0.15 P0-1: 打开笔记并定位段落
    focusRequested = Signal(int)                    # 行内「专注」入口（F5-1）

    def __init__(self, task_service, note_service, settings, parent=None,
                 workflow_service=None):
        super().__init__(parent)
        self.task_service = task_service
        self.note_service = note_service
        self.settings = settings
        # 工作流（v10）：用于速览面板的「工作流」卡片（任务 ↔ 流程双向绑定）
        self.workflow_service = workflow_service
        self._current_list = ("smart", "all")
        self._edit_dialog = None
        # v0.17: 四象限/日历/看板「父任务 → 子任务」展开集合。
        # 页面内存态（不落库），三个视图共享同一引用：切视图/刷新不丢展开状态。
        self._expanded_ids: set = set()
        self._build()
        self._restyle()
        ThemeEngine.instance() and ThemeEngine.instance().changed.connect(self._restyle)

    # ================= 布局 =================
    def _build(self):
        lay = QVBoxLayout(self)
        lay.setContentsMargins(12, 12, 12, 10)
        lay.setSpacing(6)
        self.header = PageHeader("任务", "管理待办、子任务、四象限与日历")
        lay.addWidget(self.header)

        card = UCard()
        lay.addWidget(card, 1)

        mid = QWidget()
        mid_lay = QVBoxLayout(mid)
        mid_lay.setContentsMargins(10, 14, 10, 12)
        mid_lay.setSpacing(8)

        tool_row = QHBoxLayout()
        self.view_switch = QComboBox()
        self.view_switch.addItems(["列表", "四象限", "日历", "看板"])
        self.view_switch.currentIndexChanged.connect(self._on_view_switched)
        self.filter_input = QLineEdit()
        self.filter_input.setPlaceholderText("过滤当前视图…")
        self.filter_input.textChanged.connect(self._apply_filter)
        self.filter_input.setFixedWidth(180)
        self.new_task_btn = UButton("+ 新建任务", tone="accent", kind="solid")
        self.new_task_btn.clicked.connect(self._new_task_dialog)
        self.batch_btn = UButton("批量", tone="default", kind="ghost")
        self.batch_btn.clicked.connect(self._batch_menu)
        # v0.16 P1-c: 右栏「速览」（Context Inspector，默认折叠）
        self.inspector_btn = UButton("速览", tone="default", kind="ghost")
        self.inspector_btn.setCheckable(True)
        self.inspector_btn.clicked.connect(self._toggle_inspector)
        tool_row.addWidget(self.view_switch)
        tool_row.addStretch(1)
        tool_row.addWidget(self.inspector_btn)
        tool_row.addWidget(self.filter_input)
        tool_row.addWidget(self.batch_btn)
        tool_row.addWidget(self.new_task_btn)
        mid_lay.addLayout(tool_row)

        # 主区 = 多视图 stack + 右栏速览（横向并列；速览默认折叠不占宽）
        work_host = QWidget()
        work_lay = QHBoxLayout(work_host)
        work_lay.setContentsMargins(0, 0, 0, 0)
        work_lay.setSpacing(10)
        self.stack = QStackedWidget()
        work_lay.addWidget(self.stack, 1)
        self._build_inspector(work_lay)
        mid_lay.addWidget(work_host, 1)

        # 列表视图：所有根任务为顶层，子任务缩进其下（parent_id 树）
        tag_provider = getattr(self.task_service, "tag_map", None) if self.task_service is not None else None
        self.task_model = TaskTreeModel(self, tag_provider=tag_provider)
        self.proxy = _DraggableTaskFilterProxy(self)
        self.proxy.setSourceModel(self.task_model)
        self.tree = _TaskTreeView()
        self.tree.setModel(self.proxy)
        self.tree.setHeaderHidden(True)
        self.tree.setRootIsDecorated(False)
        self.tree.setIndentation(0)
        self.tree.setFrameShape(QTreeView.NoFrame)
        self.tree.setExpandsOnDoubleClick(False)
        self.tree.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.tree.setDragEnabled(True)
        self.tree.setAcceptDrops(True)
        self.tree.setDragDropMode(QAbstractItemView.DragDrop)
        self.tree.setDropIndicatorShown(True)
        self.tree.setDefaultDropAction(Qt.MoveAction)
        self.tree.dropRequested.connect(self._on_tree_drop)
        self.delegate = TaskDelegate(
            self.tree,
            row_height=self._row_height(),
            indent=self._indent(),
            inline_edit=True)
        self.tree.setItemDelegate(self.delegate)
        self.delegate.snippet_lookup = self._snippet_for_task   # v0.15 P1-5
        self.delegate.toggleRequested.connect(self.toggleRequested.emit)
        self.delegate.openRequested.connect(self.openTaskRequested.emit)
        self.delegate.deleteRequested.connect(self._delete_current)
        self.delegate.toggleExpandRequested.connect(self._toggle_expand)
        self.delegate.editPriorityRequested.connect(self._edit_priority)
        self.delegate.editTagsRequested.connect(self._edit_tags)
        self.delegate.addSubtaskRequested.connect(self._add_subtask)
        self.delegate.focusRequested.connect(self.focusRequested.emit)
        self.delegate.titleEditRequested.connect(self.begin_inline_edit)
        self.delegate.titleCommitted.connect(self._on_inline_title_committed)
        self.tree.expanded.connect(lambda idx: self._remember_expand(idx, True))
        self.tree.collapsed.connect(lambda idx: self._remember_expand(idx, False))
        # v0.16 P1-c: 列表选中变化 → 右栏速览刷新（若展开）
        try:
            self.tree.selectionModel().currentChanged.connect(
                lambda _c, _p: self._on_tree_current_changed())
        except Exception:  # noqa: BLE001 —— 模型未装 selectionModel 时忽略
            pass
        # 页面内键盘（仅当任务列表获得焦点时生效）：
        # - ←/→ 子任务折叠/展开由 QTreeView 原生处理（左=折叠/上移，右=展开/下移）；
        # - Space 完成/取消当前行；F2 重命名 → 弹出编辑页并聚焦标题。
        self._space_shortcut = QShortcut(QKeySequence("Space"), self.tree)
        self._space_shortcut.setContext(Qt.WidgetShortcut)
        self._space_shortcut.activated.connect(self._toggle_current)
        self._rename_shortcut = QShortcut(QKeySequence("F2"), self.tree)
        self._rename_shortcut.setContext(Qt.WidgetShortcut)
        self._rename_shortcut.activated.connect(self._rename_current)
        # Ctrl+↑/↓ 移动任务排序（F1-13 / §11.8.8）
        self._move_up_shortcut = QShortcut(QKeySequence("Ctrl+Up"), self.tree)
        self._move_up_shortcut.setContext(Qt.WidgetShortcut)
        self._move_up_shortcut.activated.connect(lambda: self._move_current(-1))
        self._move_down_shortcut = QShortcut(QKeySequence("Ctrl+Down"), self.tree)
        self._move_down_shortcut.setContext(Qt.WidgetShortcut)
        self._move_down_shortcut.activated.connect(lambda: self._move_current(1))
        self.stack.addWidget(self._wrap(
            self.tree, empty_text="还没有任务，点右上角「+ 新建任务」快速添加"))

        # 四象限
        self.quadrant = QuadrantView(self, task_service=self.task_service,
                                     expanded_ids=self._expanded_ids)
        self.quadrant.openTaskRequested.connect(self.openTaskRequested.emit)
        self.quadrant.toggleRequested.connect(self.toggleRequested.emit)
        self.quadrant.changeQuadrantRequested.connect(self._on_quadrant_changed)
        self.quadrant.subtreeToggleRequested.connect(self._on_subtree_expand_toggled)
        self.stack.addWidget(self.quadrant)

        # 日历
        self.calendar = CalendarTaskView(self, settings=self.settings,
                                         expanded_ids=self._expanded_ids)
        self.calendar.daySelected.connect(self._calendar_day)
        self.calendar.taskActivated.connect(self.openTaskRequested.emit)
        self.calendar.taskRescheduled.connect(self._on_calendar_reschedule)
        self.calendar.taskToggleRequested.connect(self.toggleRequested.emit)
        self.calendar.subtreeToggleRequested.connect(self._on_subtree_expand_toggled)
        self.stack.addWidget(self.calendar)

        # 看板（F1-11）
        self.kanban = KanbanView(self, expanded_ids=self._expanded_ids)
        self.kanban.tag_provider = getattr(self.task_service, "tag_map", None)
        self.kanban.openTaskRequested.connect(self.openTaskRequested.emit)
        self.kanban.taskDropped.connect(self._on_kanban_dropped)
        self.kanban.addRequested.connect(self._on_kanban_add)
        self.kanban.subtreeToggleRequested.connect(self._on_subtree_expand_toggled)
        self.stack.addWidget(self.kanban)

        # 任务编辑页（按需弹出，非“常驻抽屉”）
        self.editor = TaskEditorPanel(self.task_service, self.note_service)
        self.editor.deleted.connect(self._editor_deleted)
        self.editor.noteOpenRequested.connect(self._open_note)
        self.editor.noteBlockOpenRequested.connect(self._open_note_block)
        self.editor.focusRequested.connect(lambda _tid: self._close_editor())
        self.editor.changed.connect(self._on_editor_changed)

        card.add_widget(mid, 1)

    def _wrap(self, w, empty_text: str):
        wrap = QWidget()
        lay = QVBoxLayout(wrap)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(w, 1)
        self._empty_list = EmptyState("nav.tasks", empty_text, "", wrap)
        lay.addWidget(self._empty_list)
        return wrap

    def _restyle(self):
        eng = ThemeEngine.instance()
        if eng:
            self.setStyleSheet(
                f"QLabel {{ background: transparent; }}"
                f"QTreeView, QListView {{ background: {eng.t('layer', '#FFFFFF')};"
                f"color: {eng.t('fg', '#1A1A1A')}; }}"
                f"QTreeView::item:selected, QTreeView::item:selected:active, "
                f"QTreeView::item:selected:!active, "
                f"QListView::item:selected, QListView::item:selected:active, "
                f"QListView::item:selected:!active {{ "
                f"background: transparent; "
                f"color: {eng.t('fg', '#1A1A1A')}; }}"
                f"QTreeView::item:hover, QListView::item:hover {{ background: transparent; }}"
                # v0.17: 三视图「N 子」展开 chip（随主题自愈重建）
                f"QPushButton#subtreeChip {{ background: transparent; border: 1px solid transparent;"
                f" color: {eng.t('accent', '#0D9488')}; font-size: 11px; padding: 1px 7px;"
                f" border-radius: 8px; }}"
                f"QPushButton#subtreeChip:hover {{ background: {eng.t('accent_soft', '#D9F2EE')}; }}"
                f"QPushButton#subtreeChip:pressed {{ background: {eng.t('hover2', '#E8EFEB')}; }}")

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

    # ================= 行内标题编辑 =================
    def _index_for(self, task_id: int):
        return self.proxy.mapFromSource(self.task_model.index_of(task_id))

    def begin_inline_edit(self, task_id: int):
        if not task_id:
            return
        idx = self._index_for(task_id)
        if not idx.isValid():
            return
        # v0.17.1：立即选中（同步，测试/命中依赖 current 立即就位），
        # 行内编辑延迟到布局稳定后触发 —— 修复父任务刚展开、子任务行未稳时
        # edit 触发的真机崩溃（新增子任务自动行内编辑）。
        self.tree.setCurrentIndex(idx)
        QTimer.singleShot(80, lambda: self._edit_index(idx))

    def _edit_index(self, idx):
        if idx.isValid():
            self.tree.edit(idx)

    def _on_inline_title_committed(self, task_id: int, text: str):
        QTimer.singleShot(0, lambda: self._apply_title(task_id, text))

    def _apply_title(self, task_id: int, text: str):
        if self.task_service and task_id and text.strip():
            self.task_service.update(task_id, title=text.strip())

    # ================= 数据装载 =================
    def _on_view_switched(self, i):
        """切换视图：切换栈页并装载目标视图（象限/日历/看板首次切换才载入；列表强制刷新防空白）。"""
        self.stack.setCurrentIndex(i)
        self.reload_tasks()

    def reload_tasks(self, keep_selection: bool = True):
        """reload 后恢复展开与当前选中（v0.17.1：修复勾选/编辑后焦点错行）。

        - 展开状态：settings.ui_state.task_expanded（跨会话记忆）
        - 当前选中：reload 前记下 current task_id，重建后恢复 setCurrentIndex，
          否则任何任务变更触发 reload 都会把焦点/高亮跳到别处。
        """
        # reload 前记录当前选中任务 id（供重建后恢复）
        cur_id = None
        if keep_selection:
            cur = self.tree.currentIndex()
            if cur.isValid():
                cur_id = cur.data(RoleTaskId)
        roots = self.task_service.all_tree() if self.task_service else []
        self.task_model.reload(roots)
        self.delegate.clear_reveal()
        self._empty_list.setVisible(not roots)
        self.tree.setVisible(bool(roots))
        if self.view_switch.currentIndex() == 1:
            self.quadrant.load(roots)
        elif self.view_switch.currentIndex() == 2:
            self._reload_calendar()
        elif self.view_switch.currentIndex() == 3:
            self.kanban.load(roots)
        self._restore_expansion()
        if keep_selection and cur_id is not None:
            idx = self.proxy.mapFromSource(self.task_model.index_of(cur_id))
            if idx.isValid():
                self.tree.setCurrentIndex(idx)
                self.tree.scrollTo(idx)

    def reload_alt_views(self):
        """四象限/日历/看板强制刷新（任务字段变更后，含标题/优先级等非时间字段）。

        任务修改后 controller 的 on_task_changed 调用本方法，确保即便当前停在列表视图，
        切换视图时也不会看到旧数据（#④）。
        """
        roots = self.task_service.all_tree() if self.task_service else []
        self.quadrant.load(roots)
        self._reload_calendar()
        self.kanban.load(roots)

    def _reload_calendar(self):
        """日历刷新：已装载时保持当前选中日，仅重算归类并重绘。"""
        if getattr(self.calendar, "task_service", None) is not None:
            self.calendar.refresh()
        else:
            self.calendar.load(self.task_service)

    # ================= 批量操作（F1-14） =================
    def _selected_task_ids(self):
        ids = []
        for idx in self.tree.selectedIndexes():
            if idx.column() != 0:
                continue
            src = self.proxy.mapToSource(idx)
            tid = src.data(RoleTaskId)
            if tid and tid not in ids:
                ids.append(tid)
        return ids

    def _batch_menu(self):
        ids = self._selected_task_ids()
        if not ids:
            
            InfoBar.warning("批量", "请先在列表视图中多选任务（Ctrl/⌘ 点选）",
                            duration=2200, position=InfoBarPosition.BOTTOM, parent=self)
            return
        
        menu = RoundMenu(parent=self)
        for text, cb in [
                (f"批量完成（{len(ids)}）", lambda: self._batch_complete(ids)),
                ("批量改期到今天", lambda: self._batch_due_today(ids)),
                ("批量打标签…", lambda: self._batch_tag(ids)),
                ("批量删除", lambda: self._batch_delete(ids))]:
            a = Action(text, self)
            a.triggered.connect(lambda _checked=False, fn=cb: fn())
            menu.addAction(a)
        menu.exec(QCursor.pos())

    def _batch_complete(self, ids):
        if hasattr(self.task_service, "batch_complete"):
            self.task_service.batch_complete(ids)
        self.reload_tasks()

    def _batch_due_today(self, ids):
        if hasattr(self.task_service, "batch_set_due"):
            self.task_service.batch_set_due(ids, date.today())
        self.reload_tasks()

    def _batch_tag(self, ids):
        from PySide6.QtWidgets import QInputDialog
        text, ok = QInputDialog.getText(self, "批量打标签", "标签名（逗号分隔）：")
        if not ok or not text.strip():
            return
        names = [x.strip().lstrip("#") for x in text.replace("，", ",").split(",") if x.strip()]
        for tid in ids:
            existing = [n for (_tid, n, _c) in self.task_service.tag_map([tid]).get(tid, [])]
            self.task_service.set_tags(tid, existing + [n for n in names if n not in existing])
        self.reload_tasks()

    def _batch_delete(self, ids):
        for tid in ids:
            self.task_service.delete(tid)
        self.reload_tasks()

    def _on_kanban_dropped(self, task_id: int, status_value: str):
        """看板拖拽改状态（F1-11）。"""
        try:
            self.task_service.set_status(task_id, TaskStatus(status_value))
        except Exception:
            pass
        self.reload_tasks()

    def _on_quadrant_changed(self, task_id: int, key: str):
        """四象限拖拽换象限（F1-10）：改 priority + due_date。"""
        if not self.task_service or not task_id:
            return
        priority, due = {
            "q1": (Priority.P8, date.today()),
            "q2": (Priority.P8, None),
            "q3": (Priority.P2, date.today()),
            "q4": (Priority.P2, None),
        }.get(key, (Priority.NONE, None))
        self.task_service.change_quadrant(task_id, priority, due)
        self.reload_tasks()

    def _on_calendar_reschedule(self, task_id: int, new_date):
        """日历胶囊拖拽改期（F1-12）：调用 service.reschedule。"""
        if self.task_service and task_id:
            self.task_service.reschedule(task_id, new_date)
            self.reload_tasks()

    def _on_kanban_add(self, status_value: str):
        """看板列添加入口（F1-11）：新建任务并落到对应状态列。"""
        from PySide6.QtWidgets import QInputDialog
        text, ok = QInputDialog.getText(self, "新建任务", "任务标题：")
        if not ok or not text.strip():
            return
        if self.task_service:
            t = self.task_service.create(text.strip(), list_id=self._current_list_id())
            if t is not None:
                self.task_service.set_status(t.id, TaskStatus(status_value))
            self.reload_tasks()

    def current_task_id(self) -> Optional[int]:
        idx = self.tree.currentIndex()
        if idx.isValid():
            src = self.proxy.mapToSource(idx)
            return src.data(RoleTaskId)
        return self.editor.task_id()

    def show_task(self, task_id: int):
        self._open_editor(task_id)

    def set_focus_list(self, kind: str, payload):
        """命令面板 tag 命中导航入口：清空/设置标签过滤后刷新（不崩溃）。"""
        self._current_list = (kind, payload)
        if kind == "tag" and payload:
            tag_id = payload[0] if isinstance(payload, (tuple, list)) else payload
            self.proxy.set_tag_filter(tag_id)
        else:
            self.proxy.set_tag_filter(None)
        self.reload_tasks()

    def _current_list_id(self) -> Optional[int]:
        """当前视图若为具体列表则返回其 id，否则返回 None（即落收件箱收集箱）。

        方案 A（GTD 收集箱语义）：只有明确选中某个「列表」时，新建/快速任务才落该列表；
        在智能清单、分组、标签、收件箱等视图里新建，一律落收件箱（list_id=None）。
        """
        kind, payload = self._current_list
        if kind == "list" and payload is not None:
            return getattr(payload, "id", None)
        return None

    # ================= 编辑页（按需弹出） =================
    def _open_editor(self, task_id: int, focus_title: bool = False):
        if not self.task_service or not task_id:
            return
        t = self.task_service.get(task_id)
        if not t:
            return
        self.editor.load(t)
        self._ensure_edit_dialog()
        if focus_title:
            self.editor.title_edit.setFocus()
            self.editor.title_edit.selectAll()
        self._edit_dialog.exec()

    def _ensure_edit_dialog(self):
        if self._edit_dialog is None:
            self._edit_dialog = _TaskEditDialog(self.editor, self)

    def _close_editor(self):
        if self._edit_dialog is not None:
            self._edit_dialog.close()

    def _editor_deleted(self, task_id: int):
        self._close_editor()
        self._delete_current(task_id)

    def _on_editor_changed(self, task_id: int):
        """添加子任务等结构变化后，展开该任务使新子任务立即可见。"""
        if not task_id:
            return
        if self.settings:
            try:
                state = self.settings.ui_state()
                expanded_set = set(state.get("task_expanded", []))
                expanded_set.add(task_id)
                self.settings.ui_set("task_expanded", sorted(expanded_set)[-200:])
            except Exception:
                pass
        try:
            idx = self.proxy.mapFromSource(self.task_model.index_of(task_id))
            if idx.isValid():
                self.tree.expand(idx)
        except Exception:
            pass

    # ================= 交互 =================
    def _current_tree_task_id(self) -> Optional[int]:
        idx = self.tree.currentIndex()
        if not idx.isValid():
            return None
        src = self.proxy.mapToSource(idx)
        tid = src.data(RoleTaskId)
        return tid or None

    def _toggle_current(self):
        """Space：完成/取消当前选中行。"""
        tid = self._current_tree_task_id()
        if tid:
            self.toggleRequested.emit(tid)

    def _rename_current(self):
        """F2：重命名选中项 —— 弹出编辑页并聚焦标题输入框。"""
        tid = self._current_tree_task_id()
        if not tid:
            return
        self._open_editor(tid, focus_title=True)

    def _move_current(self, delta: int):
        """Ctrl+↑/↓ 同级内移动排序。"""
        tid = self._current_tree_task_id()
        if not tid or not self.task_service:
            return
        move = getattr(self.task_service, "move_relative", None)
        if move is None:
            return
        move(tid, delta)
        self.reload_tasks()
        idx = self._index_for(tid)
        if idx.isValid():
            self.tree.setCurrentIndex(idx)

    def _apply_filter(self, text):
        self.proxy.set_text(text)

    def _on_tree_drop(self, src_id, anchor_id, position):
        """任务树拖拽（F1-13）：接线 service.reorder / move_to_list。"""
        if not self.task_service or not src_id:
            return
        src = self.task_service.get(src_id)
        if src is None:
            return
        if position == "root":
            # 拖到空白/根区域：移出父级，归属收件箱（list_id=None）
            self.task_service.move_to_list(src_id, None)
            if src.parent_id is not None:
                self.task_service.update(src_id, parent_id=None)
        elif position == "on":
            if not anchor_id or anchor_id == src_id or self._is_descendant(src_id, anchor_id):
                return
            anchor = self.task_service.get(anchor_id)
            self.task_service.update(src_id, parent_id=anchor_id)
            if anchor is not None:
                self.task_service.move_to_list(src_id, anchor.list_id)
        else:
            below = position == "below"
            if not anchor_id or anchor_id == src_id:
                return
            anchor = self.task_service.get(anchor_id)
            if anchor is None:
                return
            if src.parent_id != anchor.parent_id:
                if self._is_descendant(src_id, anchor_id):
                    return
                self.task_service.update(src_id, parent_id=anchor.parent_id)
            self.task_service.reorder(src_id, anchor_id, below=below)
        self.reload_tasks()
        idx = self._index_for(src_id)
        if idx.isValid():
            self.tree.setCurrentIndex(idx)

    def _is_descendant(self, ancestor_id, node_id):
        """判断 node_id 是否 ancestor_id 的后代（向上回溯防成环）。"""
        seen = set()
        cur = node_id
        while cur is not None and cur not in seen:
            if cur == ancestor_id:
                return True
            seen.add(cur)
            t = self.task_service.get(cur)
            cur = t.parent_id if t else None
        return False

    def _delete_current(self, task_id: int):
        if task_id and task_id > 0 and self.task_service:
            self.task_service.delete(task_id)

    def _toggle_expand(self, task_id: int):
        """点击行：折叠/展开该任务（叶子任务由 delegate 交还视图选中）。"""
        if not task_id:
            return
        idx = self.proxy.mapFromSource(self.task_model.index_of(task_id))
        if idx.isValid():
            will_expand = not self.tree.isExpanded(idx)
            self.tree.setExpanded(idx, will_expand)
            # 子任务展开后直接显示，不再做 reveal 透明淡入动画：
            # 动画残留 0.0 会导致子任务整行透明（空白），仅在悬浮/选中时才重绘可见。

    def _stagger_children(self, idx):
        """子任务展开 stagger（9c）：逐行淡入，复用 motion.py 工厂。"""
        from ..kit import motion
        count = self.proxy.rowCount(idx)

        def reveal(i):
            child = self.proxy.index(i, 0, idx)
            if not child.isValid():
                return
            src = self.proxy.mapToSource(child)
            tid = src.data(RoleTaskId)
            if tid is None:
                return
            self.delegate.set_reveal(tid, 0.0)
            motion.animate_value(0.0, 1.0, dur="fast", easing="standard",
                                 on_update=lambda v, k=tid: self.delegate.set_reveal(k, v),
                                 on_done=lambda k=tid: self.delegate.set_reveal(k, 1.0))

        motion.stagger(count, reveal)

    def _edit_priority(self, task_id: int):
        if not self.task_service or not task_id:
            return
        
        from ..kit.priority import priority_choices
        menu = RoundMenu(parent=self)
        for value, label in priority_choices():
            a = Action(label, self)
            a.triggered.connect(lambda _checked=False, v=value, tid=task_id:
                                self._set_priority(tid, v))
            menu.addAction(a)
        menu.exec(QCursor.pos())

    def _set_priority(self, task_id: int, priority: Priority):
        self.task_service.update(task_id, priority=priority)
        self.reload_tasks()

    def _edit_tags(self, task_id: int):
        if not self.task_service or not task_id:
            return
        
        menu = RoundMenu(parent=self)
        tags = self.task_service.tag_map([task_id]).get(task_id, [])
        for _tag_id, name, _color in tags:
            a = Action(f"移除 #{name}", self)
            a.triggered.connect(lambda _checked=False, tid=task_id, n=name:
                                self._remove_tag(tid, n))
            menu.addAction(a)
        if tags:
            menu.addSeparator()
        add_a = Action("添加标签…", self)
        add_a.triggered.connect(lambda _checked=False: self._prompt_add_tag(task_id))
        menu.addAction(add_a)
        menu.exec(QCursor.pos())

    def _remove_tag(self, task_id: int, name: str):
        tag_map = self.task_service.tag_map([task_id]).get(task_id, [])
        names = [n for (_tid, n, _c) in tag_map if n != name]
        self.task_service.set_tags(task_id, names)
        self.reload_tasks()

    def _prompt_add_tag(self, task_id: int):
        from PySide6.QtWidgets import QInputDialog
        text, ok = QInputDialog.getText(self, "添加标签", "标签名（逗号分隔多个）：")
        if not ok or not text.strip():
            return
        names = [x.strip().lstrip("#") for x in text.replace("，", ",").split(",") if x.strip()]
        if not names:
            return
        existing = [n for (_tid, n, _c) in self.task_service.tag_map([task_id]).get(task_id, [])]
        self.task_service.set_tags(task_id, existing + [n for n in names if n not in existing])
        self.reload_tasks()

    def _add_subtask(self, task_id: int):
        if not self.task_service or not task_id:
            return
        task = self.task_service.add_subtask(task_id, "新子任务")
        if not task:
            return
        # 结构变化后展开父任务，使新子任务立即可见
        if self.settings:
            try:
                state = self.settings.ui_state()
                expanded_set = set(state.get("task_expanded", []))
                expanded_set.add(task_id)
                self.settings.ui_set("task_expanded", sorted(expanded_set)[-200:])
            except Exception:
                pass
        self.reload_tasks()
        idx = self._index_for(task_id)
        if idx.isValid():
            self.tree.expand(idx)
        # 定位新子任务并自动触发行内标题编辑（begin_inline_edit 内已做延迟以避
        # 免父任务刚展开、子任务行未稳时编辑触发崩溃）。
        self.begin_inline_edit(task.id)

    def _open_note(self, note_id: int):
        self._close_editor()
        self.noteOpenRequested.emit(note_id)

    def _snippet_for_task(self, task_id: int):
        """v0.15 P1-5: 任务 hover 上下文速读 → (笔记标题, 段落 snippet)；无则 None。"""
        try:
            ctxs = self.task_service.linked_contexts(task_id) if self.task_service else []
        except Exception:
            return None
        if not ctxs:
            return None
        c = ctxs[0]
        title = ""
        if self.note_service:
            try:
                n = self.note_service.get(c.note_id)
                title = n.title if n else ""
            except Exception:
                pass
        snip = (c.snippet or "").strip().replace("\n", " ")
        return (title or "关联笔记", snip) if snip else None

    # ---------- v0.16 P1-c: 右栏速览（Context Inspector，默认折叠） ----------
    def _build_inspector(self, parent_lay: QHBoxLayout):
        from PySide6.QtWidgets import QFrame, QScrollArea
        self.inspector = QFrame()
        self.inspector.setObjectName("taskInspector")
        self.inspector.setFixedWidth(260)
        v = QVBoxLayout(self.inspector)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(6)
        self._insp_title = UTitle("任务速览", role="title")
        v.addWidget(self._insp_title)
        body = QScrollArea()
        body.setWidgetResizable(True)
        body.setFrameShape(QFrame.NoFrame)
        body_w = QWidget()
        self._insp_body_lay = QVBoxLayout(body_w)
        self._insp_body_lay.setContentsMargins(0, 0, 4, 0)
        self._insp_body_lay.setSpacing(6)
        self._insp_body_lay.addStretch(1)
        body.setWidget(body_w)
        v.addWidget(body, 1)
        self.inspector.hide()
        parent_lay.addWidget(self.inspector, 0)

    def _toggle_inspector(self, checked: bool = True):
        if checked and not self.inspector.isVisible():
            self.inspector.show()
            self._refresh_inspector(self._current_inspector_task_id())
        elif not checked:
            self.inspector.hide()
        # 布局变化后重新铺 FAB 位（MainWindow 已监听 resize，无需这里处理）

    def _current_inspector_task_id(self):
        try:
            idx = self.tree.currentIndex()
            if idx.isValid():
                return idx.data(RoleTaskId)
        except Exception:
            return None
        return None

    def _on_tree_current_changed(self):
        if self.inspector.isVisible():
            self._refresh_inspector(self._current_inspector_task_id())

    @staticmethod
    def _clear_layout(layout):
        """移除布局内全部子项并 deleteLater（右栏速览重建用）。"""
        while layout.count():
            item = layout.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()
            elif item.layout() is not None:
                TaskPage._clear_layout(item.layout())

    def _refresh_inspector(self, task_id: Optional[int]):
        """刷新右栏速览内容：内容按「任务 / 关联段落 / 标签」分组为 UCard 卡片。

        卡片标题用 12px fg3 小字、字段值 13px fg2（与旧行内样式一致）；
        空内容卡片不生成；无选中 / 任务不存在保持原空状态提示。
        """
        self._clear_layout(self._insp_body_lay)
        if not task_id or not self.task_service:
            self._insp_body_lay.addWidget(QLabel("在列表中选择任务查看速览"))
            self._insp_body_lay.addStretch(1)
            return
        t = self.task_service.get(task_id)
        if t is None:
            self._insp_body_lay.addWidget(QLabel("（任务不存在）"))
            self._insp_body_lay.addStretch(1)
            return
        eng = ThemeEngine.instance()
        tokens = eng.tokens if eng else {}
        fg2 = tokens.get("fg2", "#6B7280")
        fg3 = tokens.get("fg3", "#A8AEB6")
        self._insp_body_lay.setSpacing(8)

        def row(title: str, value: str):
            box = QFrame()
            b = QVBoxLayout(box)
            b.setContentsMargins(0, 0, 0, 0)
            b.setSpacing(1)
            lab = QLabel(title)
            lab.setStyleSheet(f"color: {fg3}; font-size: 12px; background: transparent;")
            val = QLabel(value or "—")
            val.setWordWrap(True)
            val.setStyleSheet(f"color: {fg2}; font-size: 13px; background: transparent;")
            b.addWidget(lab)
            b.addWidget(val)
            return box

        def add_card(title: str) -> UCard:
            """新建一张 UCard：卡片标题为 12px fg3 小字，随后 body() 追加内容。"""
            card = UCard()
            head = QLabel(title)
            head.setStyleSheet(f"color: {fg3}; font-size: 12px; background: transparent;")
            card.add_widget(head, 0)
            self._insp_body_lay.addWidget(card)
            return card

        # ---- 卡片 1「任务」----
        card = add_card("任务")
        card.add_widget(row("标题", t.title or "（无标题）"))
        from ...model.domain.entities import TaskStatus
        status_txt = {TaskStatus.TODO: "待办", TaskStatus.DOING: "进行中",
                      TaskStatus.WAITING: "等待中", TaskStatus.DONE: "已完成",
                      TaskStatus.ABANDONED: "已放弃"}.get(t.status, "")
        card.add_widget(row("状态", status_txt))
        card.add_widget(row("优先级", _priority_label(t.priority)))
        if t.due_date:
            card.add_widget(row("截止", str(t.due_date)))
        if getattr(t, "resume_at", None):
            card.add_widget(row("等待至", str(t.resume_at)))

        # ---- 卡片 2「关联段落」（v0.15 context；有才显示，点击定位段落）----
        try:
            ctxs = self.task_service.linked_contexts(task_id)
        except Exception:
            ctxs = []
        if ctxs:
            card2 = add_card("关联段落")
            for c in ctxs[:5]:
                snip = (c.snippet or "").strip().replace("\n", " ")[:38]
                b = QPushButton(f"§ {snip or '段落'}")
                b.setFlat(True)
                b.setCursor(Qt.PointingHandCursor)
                b.setStyleSheet(f"text-align:left; color: {tokens.get('accent', '#0D9488')};"
                                f" background: transparent; font-size:12px;")
                b.setToolTip(c.snippet or "")
                b.clicked.connect(
                    lambda _=False, nid=c.note_id, bk=c.block_key:
                    self.noteBlockOpenRequested.emit(nid, bk))
                card2.add_widget(b, 0)

        # ---- 卡片 3「标签」（有才显示）----
        try:
            tags = self.task_service.tag_map([task_id]).get(task_id, []) if self.task_service else []
        except Exception:
            tags = []
        if tags:
            card3 = add_card("标签")
            card3.add_widget(row("标签", " ".join(f"#{n}" for _i, n, _c in tags)))

        # ---- 卡片 4「工作流」（v10：任务 ↔ 流程双向绑定的任务侧入口）----
        self._append_workflow_card(add_card, row, task_id)

        self._insp_body_lay.addStretch(1)
        self._insp_title.setText(f"任务速览 · #{task_id}")

    def _append_workflow_card(self, add_card, row, task_id: int):
        """速览「工作流」卡片：列出本任务启动的流程实例，并可启动新的流程。

        这是任务 ↔ 工作流双向绑定的**任务侧入口**：
        - 任务 → 流程：点「启动工作流」选模板，即创建实例并把首步下发为子任务；
        - 流程 → 任务：实例的每个步骤就是本任务下的子任务（完成即推进流程）。
        """
        ws = getattr(self, "workflow_service", None)
        if ws is None:
            return
        try:
            instances = ws.instances_of_task(task_id)
        except Exception:  # noqa: BLE001
            instances = []
        card = add_card("工作流")
        if instances:
            for inst in instances:
                mark = {"running": "进行中", "done": "已完成",
                        "aborted": "已终止"}.get(inst.status, inst.status)
                card.add_widget(row(f"{inst.title}（{mark}）", inst.progress_text))
                for s in inst.steps:
                    flag = "✅" if s.done else "⬜"
                    card.add_widget(row(f"　{flag} {s.title}",
                                  f"任务 #{s.task_id}" if s.task_id else "—"))
        else:
            card.add_widget(row("", "尚未启动任何流程"))
        start = QPushButton("启动工作流…")
        start.setFlat(True)
        start.setCursor(Qt.PointingHandCursor)
        eng = ThemeEngine.instance()
        accent = eng.t("accent", "#0D9488") if eng else "#0D9488"
        start.setStyleSheet(f"text-align:left; color: {accent};"
                            f" background: transparent; font-size:12px;")
        start.clicked.connect(lambda _=False, tid=task_id: self._start_workflow_for(tid))
        card.add_widget(start, 0)

    def _start_workflow_for(self, task_id: int):
        """为当前任务选择一个工作流模板并启动实例（实例首步成为该任务的子任务）。"""
        ws = getattr(self, "workflow_service", None)
        if ws is None:
            return
        try:
            templates = ws.list_templates()
        except Exception:  # noqa: BLE001
            templates = []
        if not templates:
            QMessageBox.information(
                self, "知行", "还没有工作流模板。请先到「工作流」页新建一个流程。")
            return
        names = [t.name for t in templates]
        choice, ok = QInputDialog.getItem(
            self, "启动工作流", "选择要启动的流程：", names, 0, False)
        if not ok or not choice:
            return
        tpl = next((t for t in templates if t.name == choice), None)
        if tpl is None:
            return
        inst = ws.instantiate(tpl.id, origin_task_id=task_id)
        if inst is None:
            QMessageBox.warning(self, "知行", "启动失败：流程配置有误")
            return
        if self._inspector_open():
            self._refresh_inspector(task_id)
        QMessageBox.information(
            self, "知行",
            f"已启动「{inst.title}」，首步已作为本任务的子任务下发。")

    def _inspector_open(self) -> bool:
        try:
            return self.inspector.isVisible()
        except Exception:  # noqa: BLE001
            return False

    def _open_note_block(self, note_id: int, block_key: str):
        """v0.15 P0-1: 打开关联笔记并定位段落（跳转前收起任务编辑器）。"""
        self._close_editor()
        self.noteBlockOpenRequested.emit(note_id, block_key)

    def _new_task_dialog(self):
        text, ok = UInputDialog.get_text(
            self, "新建任务", "任务内容（支持 !2 @列表 #标签 明天）：")
        if ok and text.strip():
            self.quickAddRequested.emit(text.strip(), self._current_list_id())

    def _remember_expand(self, index, expanded: bool):
        src = self.proxy.mapToSource(index)
        tid = src.data(RoleTaskId)
        if tid is None or not self.settings:
            return
        state = self.settings.ui_state()
        expanded_set = set(state.get("task_expanded", []))
        (expanded_set.add if expanded else expanded_set.discard)(tid)
        self.settings.ui_set("task_expanded", sorted(expanded_set)[-200:])

    def _restore_expansion(self):
        try:
            expanded = set(self.settings.ui_state().get("task_expanded", [])) if self.settings else set()
        except Exception:
            expanded = set()
        for tid in expanded:
            idx = self.proxy.mapFromSource(self.task_model.index_of(tid))
            if idx.isValid():
                self.tree.expand(idx)

    def _calendar_day(self, d):
        # 兼容 QDate（点击日历）与 date（load 主动触发）两种来源
        if isinstance(d, QDate):
            d = date(d.year(), d.month(), d.day())
        self.calendar.show_day_tasks(d)

    def _on_subtree_expand_toggled(self, task_id: int):
        """四象限/日历/看板「父任务展开/收起子任务」：翻转页面内存态后只重载当前视图。

        展开集合自页面级 _expanded_ids 共享给三个视图；此处仅触发所在视图重绘，
        其余视图在下次切入（reload_tasks）时按同一集合重建，从而保留展开状态。
        """
        if not task_id or not self.task_service:
            return
        if task_id in self._expanded_ids:
            self._expanded_ids.discard(task_id)
        else:
            self._expanded_ids.add(task_id)
        try:
            i = self.view_switch.currentIndex()
        except Exception:
            i = -1
        try:
            roots = self.task_service.all_tree() if self.task_service else []
        except Exception:
            return
        if i == 1:
            self.quadrant.load(roots)
        elif i == 2:
            self._reload_calendar()
        elif i == 3:
            self.kanban.load(roots)


class _TaskEditDialog(UDialog):
    """包裹 TaskEditorPanel 的模态编辑页（点击「编辑」时弹出）。

    统一无边框弹窗框架：标题栏「编辑任务」+ 最小化/最大化/关闭按钮组（随主题自愈），
    底部动作栏从左到右为「开始专注 / 删除任务 / 取消 / 保存」。
    TaskEditorPanel 只负责字段编辑。
    """

    def __init__(self, editor: TaskEditorPanel, parent=None):
        super().__init__(title="编辑任务", parent=parent,
                         dialog_type=DialogType.RESIZABLE, icon_name="nav.tasks",
                         width=560, height=760)
        self.editor = editor
        # 编辑面板占满内容区
        self.setContentWidget(editor, stretch=1)

        # 底部动作栏：开始专注 / 删除任务 /（弹簧）/ 取消 / 保存
        foot = QHBoxLayout()
        foot.setSpacing(8)
        self.focus_btn = UButton("开始专注", tone="accent", kind="ghost")
        self.focus_btn.clicked.connect(self._request_focus)
        self.delete_btn = self._make_danger_soft_button("删除任务")
        self.delete_btn.clicked.connect(self._request_delete)
        self.cancel_btn = UButton("取消", tone="default", kind="ghost")
        self.cancel_btn.clicked.connect(self.reject)
        self.save_btn = UButton("保存", tone="accent", kind="solid")
        self.save_btn.clicked.connect(self.accept)
        foot.addWidget(self.focus_btn)
        foot.addWidget(self.delete_btn)
        foot.addStretch(1)
        foot.addWidget(self.cancel_btn)
        foot.addWidget(self.save_btn)
        self.add_layout(foot, stretch=0)

    def _request_focus(self):
        """开始专注：转发编辑面板的 focusRequested 信号（保留原有语义）。"""
        self.editor.focusRequested.emit(self.editor.task_id() or -1)

    def _request_delete(self):
        """删除任务：转发编辑面板的 deleted 信号（保留原有语义）。"""
        self.editor.deleted.emit(self.editor.task_id() or -1)

    def _make_danger_soft_button(self, text: str) -> QPushButton:
        """危险样式按钮：浅红底 / 深红字，hover 加深，颜色取自主题 token。"""
        btn = QPushButton(text)
        btn.setCursor(Qt.PointingHandCursor)
        eng = ThemeEngine.instance()
        danger = eng.t("danger", "#DC2626") if eng else "#DC2626"
        layer = eng.t("layer", "#FFFFFF") if eng else "#FFFFFF"
        soft = _mix_hex(danger, layer, 0.12)   # 浅红底：危险色 12% 混入表面色
        hover = _mix_hex(danger, layer, 0.24)  # hover 加深
        btn.setStyleSheet(
            f"QPushButton {{ background: {soft}; color: {danger};"
            f"border: 1px solid {danger}; border-radius: 6px; padding: 5px 12px; }}"
            f"QPushButton:hover {{ background: {hover}; }}"
            f"QPushButton:pressed {{ background: {danger}; color: white; }}")
        return btn


def _mix_hex(c1: str, c2: str, ratio: float) -> str:
    """把 c1 按 ratio 权重混入 c2，返回 #rrggbb（供危险按钮浅色底使用）。"""
    from PySide6.QtGui import QColor
    a, b = QColor(c1), QColor(c2)
    r = int(a.red() * ratio + b.red() * (1 - ratio))
    g = int(a.green() * ratio + b.green() * (1 - ratio))
    bl = int(a.blue() * ratio + b.blue() * (1 - ratio))
    return QColor(r, g, bl).name()


class _QuadrantDragLabel(QLabel):
    """四象限标题：单击=打开编辑页，按住拖动=换象限（F1-10）。"""

    openRequested = Signal(int)

    def __init__(self, text, task_id):
        super().__init__(text)
        self.task_id = task_id
        self.setCursor(Qt.PointingHandCursor)
        self._press_pos = None

    def mousePressEvent(self, ev):
        if ev.button() == Qt.LeftButton:
            self._press_pos = ev.position().toPoint()
        super().mousePressEvent(ev)

    def mouseMoveEvent(self, ev):
        if (ev.buttons() & Qt.LeftButton) and self._press_pos is not None:
            if (ev.position().toPoint() - self._press_pos).manhattanLength() >= QApplication.startDragDistance():
                self._begin_drag()
                self._press_pos = None
                return
        super().mouseMoveEvent(ev)

    def mouseReleaseEvent(self, ev):
        if ev.button() == Qt.LeftButton and self._press_pos is not None:
            self.openRequested.emit(self.task_id)
        self._press_pos = None
        super().mouseReleaseEvent(ev)

    def _begin_drag(self):
        mime = QMimeData()
        mime.setData(_TASK_MIME, QByteArray(str(int(self.task_id)).encode()))
        drag = QDrag(self)
        drag.setMimeData(mime)
        drag.exec(Qt.MoveAction)


class _SubtreeChip(QPushButton):
    """「▸/▾ N 子」展开/收起 chip：独立小矩形点击区（QPushButton），
    不与「整行/整卡打开」冲突；QSS 由 TaskPage._restyle 按 #subtreeChip 提供（随主题自愈）。"""

    subtreeToggleRequested = Signal(int)

    def __init__(self, task_id: int, count: int, expanded: bool):
        super().__init__()
        self.task_id = task_id
        self.setCursor(Qt.PointingHandCursor)
        self.setObjectName("subtreeChip")
        self.setFocusPolicy(Qt.NoFocus)
        self._sync(count, expanded)
        self.clicked.connect(lambda: self.subtreeToggleRequested.emit(task_id))

    def _sync(self, count: int, expanded: bool):
        mark = "▾" if expanded else "▸"
        self.setText(f"{mark} {count} 子")
        self.setToolTip("收起子任务" if expanded else f"展开 {count} 个子任务")


class _QuadrantRow(QWidget):
    """四象限任务行：checkbox 勾选完成 + 标题点击打开编辑页 + 可选「N 子」展开 chip。

    depth>0 的子任务行按层级左侧缩进；chip 仅在有可见子任务时出现。
    """

    toggleRequested = Signal(int)
    openRequested = Signal(int)
    subtreeToggleRequested = Signal(int)

    def __init__(self, t: Task, depth: int = 0, child_count: int = 0,
                 expanded: bool = False):
        super().__init__()
        self.task = t
        lay = QHBoxLayout(self)
        lay.setContentsMargins(2 + 18 * max(0, depth), 1, 2, 1)
        lay.setSpacing(6)
        self.check = QCheckBox()
        self.check.setToolTip("勾选完成")
        self.check.toggled.connect(lambda _on, tid=t.id: self.toggleRequested.emit(tid))
        lay.addWidget(self.check)
        self.title_label = _QuadrantDragLabel(t.title or "（无标题）", t.id)
        self.title_label.openRequested.connect(self.openRequested.emit)
        lay.addWidget(self.title_label, 1)
        self._chip = None
        if child_count > 0:
            self._chip = _SubtreeChip(t.id, child_count, expanded)
            self._chip.subtreeToggleRequested.connect(self.subtreeToggleRequested.emit)
            lay.addWidget(self._chip, 0)


class QuadrantView(QWidget):
    """重要×紧急四象限（点击打开编辑、checkbox 勾选、拖拽换象限）。

    v0.17：支持父任务展开子任务——父行右侧「N 子」chip 点击后，其未完成
    子任务以缩进行出现在同一象限框内；展开集合与看板/日历共享（页面内存态）。
    """

    openTaskRequested = Signal(int)
    toggleRequested = Signal(int)
    changeQuadrantRequested = Signal(int, str)   # task_id, quadrant_key
    subtreeToggleRequested = Signal(int)          # task_id（父任务展开/收起）

    def __init__(self, parent=None, task_service=None, expanded_ids=None):
        super().__init__(parent)
        self.task_service = task_service
        self._expanded = expanded_ids if expanded_ids is not None else set()
        grid = QGridLayout(self)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setSpacing(10)
        self.boxes = {}
        for key, (label, row, col) in {
            "q1": ("重要且紧急", 0, 0), "q2": ("重要不紧急", 0, 1),
            "q3": ("紧急不重要", 1, 0), "q4": ("不重要不紧急", 1, 1),
        }.items():
            box = _QuadrantBox(label, key)
            box.openTaskRequested.connect(self.openTaskRequested.emit)
            box.toggleRequested.connect(self.toggleRequested.emit)
            box.changeQuadrantRequested.connect(self.changeQuadrantRequested.emit)
            box.subtreeToggleRequested.connect(self.subtreeToggleRequested.emit)
            self.boxes[key] = box
            grid.addWidget(box, row, col)

    def load(self, tasks):
        """装载象限：仅根任务归格（沿用 existing 判定），展开的父任务子树
        以缩进行附加到父行所在象限框（子任务自身日期/优先级不参与归格）。
        """
        for b in self.boxes.values():
            b.clear()
        from datetime import date
        today = date.today()
        eff = (self.task_service.effective_done_map(tasks) if self.task_service else {}) or {}

        def is_eff_done(t) -> bool:
            return bool(eff.get(t.id, t.status in (TaskStatus.DONE, TaskStatus.ABANDONED)))

        def visible_kids(t):
            return [k for k in (getattr(t, "children", []) or [])
                    if not is_eff_done(k)]

        def emit_rows(box, t, depth):
            """树序输出：父行 + （展开时）直接子行，深度缩进。"""
            kids = visible_kids(t)
            box.add_task(t, depth=depth, child_count=len(kids),
                         expanded=t.id in self._expanded)
            if t.id in self._expanded and kids:
                for k in kids:
                    emit_rows(box, k, depth + 1)

        for t in tasks or []:
            if is_eff_done(t) or t.parent_id is not None:
                continue
            important = int(t.priority) >= int(Priority.MID)   # ≥P5=重要（v0.17 8 级，兼容别名 MID=P5）
            urgent = t.due_date is not None and t.due_date <= today
            if important and urgent:
                key = "q1"
            elif important:
                key = "q2"
            elif urgent:
                key = "q3"
            else:
                key = "q4"
            emit_rows(self.boxes[key], t, 0)


class _QuadrantBox(QFrame):
    openTaskRequested = Signal(int)
    toggleRequested = Signal(int)
    changeQuadrantRequested = Signal(int, str)
    subtreeToggleRequested = Signal(int)

    def __init__(self, label: str, key: str):
        super().__init__()
        self.label = label
        self.key = key
        self.setAcceptDrops(True)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(10, 8, 10, 8)
        lay.setSpacing(4)
        self.title = QLabel(label)
        f = self.title.font()
        f.setBold(True)
        self.title.setFont(f)
        lay.addWidget(self.title)
        self.list_lay = QVBoxLayout()
        self.list_lay.setSpacing(2)
        lay.addLayout(self.list_lay)
        lay.addStretch(1)

    def clear(self):
        while self.list_lay.count():
            item = self.list_lay.takeAt(0)
            if item.widget():
                item.widget().deleteLater()

    def add_task(self, t: Task, depth: int = 0, child_count: int = 0,
                 expanded: bool = False):
        row = _QuadrantRow(t, depth=depth, child_count=child_count, expanded=expanded)
        row.toggleRequested.connect(self.toggleRequested.emit)
        row.openRequested.connect(self.openTaskRequested.emit)
        if child_count > 0:
            row.subtreeToggleRequested.connect(self.subtreeToggleRequested.emit)
        self.list_lay.addWidget(row)

    # ---- 拖拽换象限（F1-10） ----
    def dragEnterEvent(self, ev):
        if ev.mimeData().hasFormat(_TASK_MIME):
            ev.acceptProposedAction()
        else:
            super().dragEnterEvent(ev)

    def dragMoveEvent(self, ev):
        if ev.mimeData().hasFormat(_TASK_MIME):
            ev.acceptProposedAction()
        else:
            super().dragMoveEvent(ev)

    def dropEvent(self, ev):
        if ev.mimeData().hasFormat(_TASK_MIME):
            try:
                tid = int(bytes(ev.mimeData().data(_TASK_MIME)).decode())
                self.changeQuadrantRequested.emit(tid, self.key)
                ev.acceptProposedAction()
                return
            except (ValueError, UnicodeDecodeError):
                pass
        super().dropEvent(ev)


_STATUS_LABELS = {
    TaskStatus.TODO: "待办", TaskStatus.DOING: "进行中", TaskStatus.WAITING: "等待中",
    TaskStatus.DONE: "已完成", TaskStatus.ABANDONED: "已放弃",
}


def _priority_label(priority) -> str:
    """档位显示名：无 / P1..P8（v0.17 8 级）。"""
    from ..kit.priority import priority_label
    return priority_label(priority)


def _priority_color(priority) -> str:
    """胶囊/速览优先级色（v0.17 8 级）：统一走 kit/priority 主题派生色阶。"""
    from ..kit.priority import priority_color
    return priority_color(priority)


def _tooltip_text(t: Task) -> str:
    """胶囊悬浮详情：标题 / 优先级 / 状态 / 开始~截止。"""
    s = t.start_date.strftime("%Y-%m-%d") if t.start_date else "—"
    e = t.due_date.strftime("%Y-%m-%d") if t.due_date else "—"
    return "\n".join([
        t.title or "（无标题）",
        f"优先级：{_priority_label(t.priority)}",
        f"状态：{_STATUS_LABELS.get(t.status, t.status.value)}",
        f"时间：{s} ~ {e}",
    ])


def group_tasks_by_date(tasks, today=None):
    """把任务按日期归类为 date -> [Task]（供胶囊与当日列表共用）。

    归类规则（与需求一致）：
    - 开始 + 截止：在 [开始, 截止] 区间内每一天都显示（含两端，跨月/跨年逐日展开）；
    - 仅截止：截止当天；
    - 仅开始：开始当天；
    - 无日期（无开始无截止）：都归入「今日」。
    """
    today = today or date.today()
    out = {}
    # 防御性上限：异常超大跨度不逐日展开到内存爆炸（约 10 年）
    _MAX_SPAN_DAYS = 3660
    for t in tasks or []:
        if t.start_date and t.due_date:
            lo, hi = t.start_date, t.due_date
            if lo > hi:
                lo, hi = hi, lo
            if (hi - lo).days > _MAX_SPAN_DAYS:
                hi = lo + timedelta(days=_MAX_SPAN_DAYS)
            cur = lo
            while cur <= hi:
                out.setdefault(cur, []).append(t)
                cur += timedelta(days=1)
        elif t.due_date:
            out.setdefault(t.due_date, []).append(t)
        elif t.start_date:
            out.setdefault(t.start_date, []).append(t)
        else:
            out.setdefault(today, []).append(t)
    for d in out:
        out[d].sort(key=lambda x: (-int(x.priority), x.sort_key or 0, x.id or 0))
    return out


class TaskCalendarWidget(QCalendarWidget):
    """月历：在日期单元格内绘制任务胶囊，并支持悬浮详情 / 点击跳转。

    paintCell 期间重建每个日期的胶囊 QRect 与 task_id 映射（``_pill_hits``），
    鼠标事件在内部 QCalendarView 的 viewport 上做命中判断（两者同为 viewport 坐标）。
    """

    taskActivated = Signal(int)
    taskRescheduled = Signal(int, object)   # task_id, new_date（F1-12 拖拽改期）

    def __init__(self, parent=None):
        super().__init__(parent)
        self._tasks_by_date = {}     # date -> [Task]（过滤后）
        self._task_by_id = {}        # task_id -> Task
        self._pill_hits = {}         # date -> [(QRect, task_id)]，paint 时重建
        self._date_rects = {}        # date -> QRect（拖拽改期命中日期格）
        self._hovered = None         # 当前悬浮的 task_id（去重 tooltip）
        self._viewport = None
        self._drag_task = None
        self._drag_start_pos = None
        self._dragging = False
        self.currentPageChanged.connect(self._on_page_changed)
        QTimer.singleShot(0, self._install_view_filter)

    def _on_page_changed(self, _year, _month):
        # 换月后旧日期的胶囊命中区域失效，清空等待重绘重建
        self._pill_hits = {}
        self._date_rects = {}
        self._hovered = None
        QToolTip.hideText()

    # ---- 数据 ----
    def set_tasks(self, tasks_by_date, task_by_id):
        self._tasks_by_date = tasks_by_date or {}
        self._task_by_id = task_by_id or {}
        self._pill_hits = {}
        self.updateCells()

    # ---- 绘制 ----
    def paintCell(self, painter, rect, qdate):
        d = date(qdate.year(), qdate.month(), qdate.day())
        self._date_rects[d] = rect   # 记录日期格位置，供拖拽改期命中判断
        tasks = self._tasks_by_date.get(d, [])
        if not tasks:
            super().paintCell(painter, rect, qdate)
            return
        # 有任务的日期：自己绘制背景 + 左上角日期 + 任务胶囊，隐藏 super 的原日期数字
        eng = ThemeEngine.instance()
        tok = eng.tokens if eng else {}
        painter.save()
        selected = (qdate == self.selectedDate())
        today = (qdate == QDate.currentDate())
        if selected:
            bg = QColor(tok.get("accent_soft", "#D9F2EE"))
        elif today:
            bg = QColor(tok.get("accent", "#0D9488"))
            bg.setAlpha(36)
        else:
            bg = QColor(tok.get("layer", "#FFFFFF"))
        painter.fillRect(rect, bg)
        fg = tok.get("fg", "#1A1A1A")
        layer = tok.get("layer", "#FFFFFF")
        margin = 3
        gap = 2
        # 日期数字明确画在左上角（加粗小号），任务胶囊画在其下方、不遮挡日期
        day_font = painter.font()
        day_font.setPixelSize(11)
        day_font.setBold(True)
        painter.setFont(day_font)
        painter.setPen(QColor(fg))
        painter.drawText(QRect(rect.left() + 4, rect.top() + 3, 24, 13),
                         Qt.AlignLeft | Qt.AlignTop, str(qdate.day()))
        day_area = max(16, int(rect.height() * 0.28))
        pill_h = max(10, min(14, rect.height() // 4))
        x = rect.left() + margin
        w = max(10, rect.width() - 2 * margin)
        y = rect.top() + day_area
        bottom = rect.bottom() - 2
        recorded = []
        shown = 0
        for t in tasks:
            if y + pill_h > bottom:
                break
            pr = QRect(x, y, w, pill_h)
            self._draw_pill(painter, pr, t, fg, layer)
            recorded.append((pr, t.id))
            shown += 1
            y += pill_h + gap
        # 超出格子高度时给出省略提示胶囊（+N）
        if shown < len(tasks) and y + max(10, pill_h - 1) <= bottom:
            more_rect = QRect(x, y, w, max(10, pill_h - 1))
            self._draw_more_pill(painter, more_rect, len(tasks) - shown, fg)
        self._pill_hits[d] = recorded
        painter.restore()

    def _draw_pill(self, painter, pr, t, fg, layer):
        prio = _priority_color(t.priority)
        soft = _mix_hex(prio, layer, 0.22)   # 浅色底 + 优先级描边，文字用主题 fg
        painter.save()
        painter.setRenderHint(QPainter.Antialiasing, True)
        radius = pr.height() / 2.0
        painter.setPen(QColor(prio))
        painter.setBrush(QColor(soft))
        painter.drawRoundedRect(pr, radius, radius)
        font = painter.font()
        font.setPixelSize(max(9, pr.height() - 4))
        painter.setFont(font)
        painter.setPen(QColor(fg))
        title = t.title or "（无标题）"
        elided = painter.fontMetrics().elidedText(title, Qt.ElideRight, max(8, pr.width() - 8))
        painter.drawText(pr.adjusted(5, 0, -3, 0), Qt.AlignVCenter | Qt.AlignLeft, elided)
        painter.restore()

    def _draw_more_pill(self, painter, pr, n, fg):
        painter.save()
        painter.setRenderHint(QPainter.Antialiasing, True)
        radius = pr.height() / 2.0
        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor(0, 0, 0, 30))
        painter.drawRoundedRect(pr, radius, radius)
        font = painter.font()
        font.setPixelSize(max(9, pr.height() - 3))
        painter.setFont(font)
        painter.setPen(QColor(fg))
        painter.drawText(pr, Qt.AlignCenter, f"+{n}")
        painter.restore()

    # ---- 命中检测 ----
    def _install_view_filter(self):
        view = self.findChild(QTableView)
        if view is None:
            return
        self._viewport = view.viewport()
        self._viewport.setMouseTracking(True)
        self._viewport.installEventFilter(self)

    def eventFilter(self, watched, event):
        if watched is self._viewport:
            t = event.type()
            if t == QEvent.MouseButtonPress and event.button() == Qt.LeftButton:
                pos = event.position().toPoint()
                hit = self._hit_test(pos)
                if hit is not None:
                    self._drag_task = hit
                    self._drag_start_pos = pos
                    self._dragging = False
            elif t == QEvent.MouseMove:
                pos = event.position().toPoint()
                if self._drag_task is not None and self._drag_start_pos is not None:
                    if not self._dragging:
                        if (pos - self._drag_start_pos).manhattanLength() >= QApplication.startDragDistance():
                            self._dragging = True
                            self._hovered = None
                            QToolTip.hideText()
                    return super().eventFilter(watched, event)
                hit = self._hit_test(pos)
                self._handle_hover(hit, event)
            elif t == QEvent.MouseButtonRelease and event.button() == Qt.LeftButton:
                pos = event.position().toPoint()
                if self._dragging and self._drag_task is not None:
                    target = self._date_at(pos)
                    if target is not None:
                        QTimer.singleShot(0, lambda tid=self._drag_task, d=target:
                                          self.taskRescheduled.emit(tid, d))
                else:
                    hit = self._hit_test(pos)
                    if hit is not None:
                        # 延迟一帧发出，避免在事件过滤器中直接打开模态编辑页
                        QTimer.singleShot(0, lambda tid=hit: self.taskActivated.emit(tid))
                self._drag_task = None
                self._drag_start_pos = None
                self._dragging = False
        return super().eventFilter(watched, event)

    def _hit_test(self, pos):
        for pills in self._pill_hits.values():
            for rect, tid in pills:
                if rect.contains(pos):
                    return tid
        return None

    def _date_at(self, pos):
        for d, rect in self._date_rects.items():
            if rect.contains(pos):
                return d
        return None

    def _handle_hover(self, hit, event):
        if hit == self._hovered:
            return
        self._hovered = hit
        if hit is not None:
            t = self._task_by_id.get(hit)
            if t is not None:
                QToolTip.showText(event.globalPosition().toPoint(), _tooltip_text(t), self)
            return
        QToolTip.hideText()


class _OpenTitleLabel(QLabel):
    """可点击标题标签（日历当日面板行）：单击请求打开任务。"""

    openRequested = Signal(int)

    def __init__(self, text: str, task_id: int):
        super().__init__(text)
        self.task_id = task_id
        self.setCursor(Qt.PointingHandCursor)

    def mouseReleaseEvent(self, ev):
        if ev.button() == Qt.LeftButton:
            self.openRequested.emit(self.task_id)
        super().mouseReleaseEvent(ev)


class _DayTaskRow(QWidget):
    """日历「当日任务」清单行：checkbox 勾选 + 标题点击打开 + 可选「N 子」展开 chip。

    depth>0 的行（展开出的子任务）左侧缩进；chip 仅在父任务有「可见子任务」时出现。
    """

    toggleRequested = Signal(int)
    openRequested = Signal(int)
    subtreeToggleRequested = Signal(int)

    def __init__(self, t: Task, depth: int = 0, child_count: int = 0,
                 expanded: bool = False, done: bool = False):
        super().__init__()
        self.task = t
        lay = QHBoxLayout(self)
        lay.setContentsMargins(12 * max(0, depth), 0, 0, 0)
        lay.setSpacing(4)
        self.check = QCheckBox()
        self.check.setChecked(bool(done))
        self.check.setToolTip("取消勾选恢复" if done else "勾选完成")
        lay.addWidget(self.check)
        full = t.title or "（无标题）"
        self.title_label = _OpenTitleLabel("", t.id)
        self.title_label.setToolTip(full)
        fm = self.title_label.fontMetrics()
        # 固定 240px 面板 − UCard 边距(16*2) − checkbox/chip 占用；省略号截断 + tooltip 全文
        avail = 240 - 32 - 24 - (50 if child_count else 0) - 12 * max(0, depth)
        self.title_label.setText(fm.elidedText(full, Qt.ElideRight, max(30, avail)))
        self.title_label.openRequested.connect(self.openRequested.emit)
        lay.addWidget(self.title_label, 1)
        self._chip = None
        if child_count > 0:
            self._chip = _SubtreeChip(t.id, child_count, expanded)
            self._chip.subtreeToggleRequested.connect(self.subtreeToggleRequested.emit)
            lay.addWidget(self._chip, 0)
        self.check.toggled.connect(lambda _on, tid=t.id: self.toggleRequested.emit(tid))


class CalendarTaskView(QWidget):
    """月历（日期单元格内绘制任务胶囊）+ 右侧当日任务清单。

    兼容原有接口：``daySelected`` / ``show_day_tasks`` / ``load`` 保留；
    新增 ``taskActivated(int)`` 供点击胶囊/当日清单行跳转任务。

    v0.17：当日任务清单行支持勾选/打开；父任务（当日胶囊）行带「N 子」chip，
    展开后其未完成子任务以缩进行出现在当日清单中（共享页面级 _expanded_ids）。
    """

    daySelected = Signal(object)
    taskActivated = Signal(int)
    taskRescheduled = Signal(int, object)   # task_id, new_date（F1-12）
    taskToggleRequested = Signal(int)         # 当日清单行 checkbox（勾选/恢复）
    subtreeToggleRequested = Signal(int)      # 父任务展开/收起

    def __init__(self, parent=None, settings=None, expanded_ids=None):
        super().__init__(parent)
        self.settings = settings
        self.task_service = None
        self._expanded = expanded_ids if expanded_ids is not None else set()
        self._tasks_by_date = {}   # date -> [Task]（已按显示已完成开关过滤）
        self._flat_tasks = []
        self._eff = {}

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self.cal = TaskCalendarWidget()
        self.cal.setGridVisible(True)
        self.cal.setVerticalHeaderFormat(QCalendarWidget.NoVerticalHeader)
        self.cal.clicked.connect(self.daySelected.emit)
        self.cal.taskActivated.connect(self.taskActivated.emit)
        self.cal.taskRescheduled.connect(self.taskRescheduled.emit)
        lay.addWidget(self.cal, 1)

        side = QVBoxLayout()
        self.day_title = QLabel("选中日期")
        f = self.day_title.font()
        f.setBold(True)
        self.day_title.setFont(f)
        side.addWidget(self.day_title)
        self.day_list = QVBoxLayout()
        side.addLayout(self.day_list)
        side.addStretch(1)
        wrap = QWidget()
        wrap.setLayout(side)
        wrap.setFixedWidth(240)
        card = UCard("当日任务")
        card.add_widget(wrap)
        lay.addWidget(card)

        self._connect_settings_bus()
        if ThemeEngine.instance():
            ThemeEngine.instance().changed.connect(self._on_theme)

    # ---- 设置项 ----
    def _show_done(self):
        s = self.settings
        getter = getattr(s, "get_bool", None) if s is not None else None
        if getter is None:
            return False
        try:
            return bool(getter(K.K_CALENDAR_SHOW_DONE, False))
        except Exception:
            return False

    def _connect_settings_bus(self):
        """订阅 settings_changed，使「日历显示已完成任务」改动即时刷新。"""
        bus = getattr(self.settings, "bus", None)
        sig = getattr(bus, "settings_changed", None)
        if sig is not None:
            try:
                sig.connect(self._on_setting_changed)
            except Exception:
                pass

    def _on_setting_changed(self, key):
        if key == K.K_CALENDAR_SHOW_DONE:
            self.refresh()

    def _on_theme(self):
        self.cal.updateCells()

    # ---- 数据 ----
    def load(self, task_service):
        """日历视图装载：记住服务、重建日期归类、选中今天并展示今日任务。"""
        self.task_service = task_service
        self._rebuild()
        self.cal.setSelectedDate(QDate.currentDate())
        self.daySelected.emit(date.today())

    def refresh(self):
        """设置/主题变化后重算归类并重绘（保持当前选中日）。"""
        if not self.task_service:
            return
        self._rebuild()
        self.cal.updateCells()
        cur = self.cal.selectedDate()
        self.show_day_tasks(date(cur.year(), cur.month(), cur.day()))

    def _rebuild(self):
        roots = self.task_service.all_tree() if self.task_service else []

        def walk(items):
            flat = []
            for t in items or []:
                flat.append(t)
                flat.extend(walk(getattr(t, "children", []) or []))
            return flat

        flat = walk(roots)
        self._flat_tasks = flat
        self._eff = self.task_service.effective_done_map(flat) if self.task_service else {}
        visible = self._visible_tasks(flat)
        self._tasks_by_date = group_tasks_by_date(visible)
        self.cal.set_tasks(self._tasks_by_date,
                           {t.id: t for t in flat if t.id is not None})

    def _visible_tasks(self, flat):
        if self._show_done():
            return flat
        return [t for t in flat if not self._eff.get(t.id, t.is_done)]

    def show_day_tasks(self, d, tasks=None):
        """展示某天任务清单（与胶囊同一套日期归类 + 显示已完成开关）。

        每行可勾选（taskToggleRequested）/ 点击打开（taskActivated）；
        父任务行右侧提供「N 子」chip：展开后其可见（未有效完成）子任务按层级
        缩进列于父行下方；子任务已因自身日期单独出现在当日清单时不重复插入。
        """
        while self.day_list.count():
            item = self.day_list.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        if isinstance(d, QDate):
            d = date(d.year(), d.month(), d.day())
        self.day_title.setText(d.strftime("%Y-%m-%d"))
        if tasks is None:
            tasks = self._tasks_by_date.get(d, [])
        elif not self._show_done():
            eff = self.task_service.effective_done_map(tasks) if self.task_service and tasks else {}
            tasks = [t for t in tasks if not eff.get(t.id, t.is_done)]
        eff = self._eff
        top_ids = {t.id for t in tasks}
        added = [0]          # 小列表计数（避免闭包 nonlocal 纠结）

        def visible_kids(t):
            kids = list(getattr(t, "children", []) or [])
            if self._show_done():
                return kids
            return [k for k in kids if not eff.get(k.id, k.is_done)]

        def emit(t, depth):
            if added[0] >= 60:
                return
            kids = visible_kids(t)
            row = _DayTaskRow(t, depth=depth, child_count=len(kids),
                              expanded=t.id in self._expanded,
                              done=bool(eff.get(t.id, t.is_done)))
            row.toggleRequested.connect(self.taskToggleRequested.emit)
            row.openRequested.connect(self.taskActivated.emit)
            if kids:
                row.subtreeToggleRequested.connect(self.subtreeToggleRequested.emit)
            self.day_list.addWidget(row)
            added[0] += 1
            if t.id in self._expanded and kids:
                for k in kids:
                    if k.id in top_ids:      # 已按自身日期单独显示过，避免重复
                        continue
                    emit(k, depth + 1)

        for t in tasks[:30]:
            emit(t, 0)
            if added[0] >= 60:
                break
        if not tasks:
            self.day_list.addWidget(QLabel("（无任务）"))
