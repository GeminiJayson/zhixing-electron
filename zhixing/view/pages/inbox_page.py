# -*- coding: utf-8 -*-
"""收件箱页：任务收件箱 | 闪念 两个 Tab，含整理闭环操作。"""
from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (QFrame, QHBoxLayout, QMenu, QScrollArea, QTreeView, QVBoxLayout, QWidget, QDialog, QDialogButtonBox)

from ...core import settings_keys as K
from ...model.domain.entities import TaskStatus
from ...model.qt.models import RoleTaskId, TaskTreeModel
from ..components.general import EmptyState, IconWidget
from ..delegates.task_delegate import TaskDelegate
from ..kit.control_style import clear_fixed_height
from qfluent_core import ThemeManager as ThemeEngine
from ..ui import UButton, UCard, UTitle, PageHeader
from zhixing.view.kit.fluent_compat import QLabel, QTabWidget
from zhixing.view.kit.fluent_compat import InfoBar, InfoBarPosition
from zhixing.view.kit.fluent_compat import QCheckBox


class InboxPage(QWidget):
    openTaskRequested = Signal(int)
    openNoteRequested = Signal(int)
    toggleRequested = Signal(int)
    flashDeleted = Signal(int)          # 闪念删除（撤销）
    moveTaskRequested = Signal(int, int)   # 收件箱任务移动到列表：task_id, list_id

    def __init__(self, task_service, flash_service, note_service, settings, parent=None):
        super().__init__(parent)
        self.task_service = task_service
        self.flash_service = flash_service
        self.note_service = note_service
        self.settings = settings
        self._show_archived = False
        self._build()
        self._restyle()
        ThemeEngine.instance() and ThemeEngine.instance().changed.connect(self._restyle)

    def _build(self):
        lay = QVBoxLayout(self)
        lay.setContentsMargins(24, 16, 24, 16)
        self.header = PageHeader("收件箱", "快速收集的任务与闪念都在这里")
        lay.addWidget(self.header)
        self.tabs = QTabWidget()
        self.tabs.setDocumentMode(False)
        # 双边框修复：全局 QSS 的「QTabWidget::pane { border:1px solid … }」会在
        # Tab 内容外围画一圈边框，而本页两个 Tab 的内容都是自绘轮廓的 UCard，
        # 两层轮廓相距仅 1~2px 平行紧贴 → 视觉上就是「两个边框」。
        # 这里去掉 pane 边框（仅本页生效），让卡片轮廓成为唯一边界。
        self.tabs.setObjectName("inboxTabs")
        from ..kit.motion import attach_tab_fade
        attach_tab_fade(self.tabs)
        lay.addWidget(self.tabs, 1)

        # ---- Tab 1：任务收件箱（树形：父任务 → 缩进子任务） ----
        self.task_model = TaskTreeModel(self)
        self.task_tree = QTreeView()
        self.task_tree.setModel(self.task_model)
        self.task_tree.setHeaderHidden(True)
        self.task_tree.setRootIsDecorated(False)
        # 缩进跟随「任务缩进」设置（与今日页/任务页同源），非硬编码 20
        self.task_tree.setIndentation(self._indent())
        self.task_tree.setFrameShape(QTreeView.NoFrame)
        self.task_tree.setExpandsOnDoubleClick(False)
        # 行高/缩进必须跟随「任务行高」设置（今日页/任务页/桌面浮窗同源），
        # 否则用默认 38 会与全站任务列表高度不一致（「高度与整体布局不相符」）。
        self.task_delegate = TaskDelegate(
            self.task_tree, show_actions=False,
            row_height=self._row_height(), indent=self._indent())
        self.task_tree.setItemDelegate(self.task_delegate)
        self.task_delegate.toggleRequested.connect(self.toggleRequested.emit)
        self.task_delegate.openRequested.connect(self.openTaskRequested.emit)
        self.task_tree.setContextMenuPolicy(Qt.CustomContextMenu)
        self.task_tree.customContextMenuRequested.connect(self._show_task_menu)
        task_host = QWidget()
        task_host_lay = QVBoxLayout(task_host)
        task_host_lay.setContentsMargins(0, 0, 0, 0)
        task_host_lay.setSpacing(4)
        task_host_lay.addWidget(self.task_tree, 1)
        self.empty_task = EmptyState("nav.tasks", "收件箱是空的，快速收集的任务会先落在这里", "", task_host)
        task_host_lay.addWidget(self.empty_task)
        card_task = UCard()
        card_task.add_widget(task_host, 1)
        self.tabs.addTab(card_task, "任务收件箱")
        # 兼容旧测试/调用方：保留 task_list 属性名指向树视图
        self.task_list = self.task_tree

        # ---- Tab 2：闪念 ----
        self.flash_list = QVBoxLayout()
        self.flash_list.setSpacing(8)
        flash_wrap = _ScrollWrap(self.flash_list)
        self.flash_scroll = flash_wrap
        self._flash_cards = {}
        self._flash_checks = {}   # fid -> QCheckBox
        flash_tool = QHBoxLayout()
        self.merge_btn = UButton("合并选中", tone="accent", kind="solid")
        self.merge_btn.clicked.connect(self._merge_selected)
        self.select_all_btn = UButton("全选", tone="default", kind="ghost")
        self.select_all_btn.clicked.connect(self._toggle_select_all)
        self.archive_toggle = UButton("已归档", tone="default", kind="ghost")
        self.archive_toggle.setCheckable(True)
        self.archive_toggle.toggled.connect(self._on_archive_toggle)
        flash_tool.addWidget(self.merge_btn)
        flash_tool.addWidget(self.select_all_btn)
        flash_tool.addWidget(self.archive_toggle)
        flash_tool.addStretch(1)
        flash_body = QWidget()
        flash_body_lay = QVBoxLayout(flash_body)
        flash_body_lay.setContentsMargins(0, 0, 0, 0)
        flash_body_lay.setSpacing(8)
        flash_body_lay.addLayout(flash_tool)
        flash_body_lay.addWidget(flash_wrap, 1)
        card_flash = UCard()
        card_flash.add_widget(flash_body, 1)
        self.holder_flash_empty = card_flash
        self.tabs.addTab(card_flash, "闪念")

    def _row_height(self) -> int:
        return self.settings.get_int(K.K_TASK_ROW_HEIGHT, 38) if self.settings else 38

    def _indent(self) -> int:
        return self.settings.get_int(K.K_TASK_INDENT, 20) if self.settings else 20

    def apply_row_metrics(self):
        """「任务行高/缩进」设置变更后刷新（由 controller 调用，与其它页一致）。"""
        self.task_delegate.row_height = self._row_height()
        self.task_delegate.indent = self._indent()
        self.task_tree.setIndentation(self._indent())
        self.task_tree.doItemsLayout()

    # ---------- 刷新 ----------
    def reload(self):
        self._reload_tasks()
        self._reload_flashes()

    def select_flash(self, fid: int):
        """切到「闪念」Tab 并把目标闪念滚动到可视区（供图谱双击跳转定位）。"""
        self.tabs.setCurrentIndex(1)
        self.reload()
        card = self._flash_cards.get(fid)
        if card is not None and hasattr(self, "flash_scroll"):
            self.flash_scroll.scroll.ensureWidgetVisible(card, 0, 40)

    def _reload_tasks(self):
        tasks = self.task_service.list_tree(None) if self.task_service else []
        self.task_model.reload(tasks)
        undone = self._count_undone(tasks)
        self.tabs.setTabText(0, f"任务收件箱 · {undone}")
        has = bool(tasks)
        self.task_tree.setVisible(has)
        self.empty_task.setVisible(not has)

    def _count_undone(self, tasks) -> int:
        n = 0
        # MVC 收口：有效完成 roll-up 规则经 service 只读 facade，不再直读 domain 规则函数。
        eff = self.task_service.effective_done_map(tasks) if self.task_service else {}

        def walk(items):
            nonlocal n
            for t in items:
                if not eff.get(t.id, t.status == TaskStatus.DONE):
                    n += 1
                walk(t.children)
        walk(tasks)
        return n

    def _show_task_menu(self, pos):
        """收件箱任务行右键菜单：移动到列表（方案 A 的整理闭环）。"""
        index = self.task_tree.indexAt(pos)
        if not index.isValid():
            return
        task_id = index.data(RoleTaskId)
        if task_id is None:
            return
        menu = QMenu(self.task_tree)
        move_menu = menu.addMenu("移动到列表")
        if self.task_service:
            folders = self.task_service.folder_tree()
            by_parent = {}
            for f in folders:
                by_parent.setdefault(f.parent_id, []).append(f)

            def build(sub_menu, parent_id):
                for f in sorted(by_parent.get(parent_id, []),
                                key=lambda x: (x.sort or 0.0, x.id or 0)):
                    if f.kind.value == "list":
                        act = sub_menu.addAction(f.name)
                        act.triggered.connect(
                            lambda _=False, fid=f.id: self.moveTaskRequested.emit(task_id, fid))
                    else:
                        g = sub_menu.addMenu(f.name)
                        build(g, f.id)

            build(move_menu, None)
        if not move_menu.actions():
            move_menu.addAction("（暂无列表）").setEnabled(False)
        menu.exec(self.task_tree.viewport().mapToGlobal(pos))

    def _reload_flashes(self):
        _clear(self.flash_list)
        self._flash_cards = {}
        self._flash_checks = {}
        flashes = (self.flash_service.archived() if self._show_archived
                    else self.flash_service.list())
        eng = ThemeEngine.instance()
        fg = eng.t("fg", "#1A1A1A") if eng else "#1A1A1A"
        fg2 = eng.t("fg2", "#6B7280") if eng else "#6B7280"
        layer = eng.t("layer", "#FFFFFF") if eng else "#FFFFFF"
        border = eng.t("border", "#E5E5E5") if eng else "#E5E5E5"
        accent = eng.t("accent", "#0D9488") if eng else "#0D9488"
        self.flash_list.setAlignment(Qt.AlignTop | Qt.AlignLeft)
        for f in flashes:
            card = QFrame()
            card_lay = QVBoxLayout(card)
            card_lay.setContentsMargins(12, 10, 12, 10)
            card_lay.setSpacing(6)
            head = QHBoxLayout()
            chk = QCheckBox()
            # 必须用 objectName 限定并显式写死尺寸：全局 component_qss 的
            # 「QCheckBox::indicator」会按「控件高度」改写宽高（12~22px），
            # 而本处圆角若硬编码 8px，尺寸≠16px 时就变成圆角方形（不是圆）。
            # 这里锁死 16px + radius 8px（=半高），任何设置下都是正圆。
            chk.setObjectName("flashPick")
            chk.setStyleSheet(
                f"QCheckBox#flashPick::indicator {{ width: 16px; height: 16px;"
                f" border-radius: 8px; border: 1.5px solid {fg2};"
                f" background: transparent; }}"
                f"QCheckBox#flashPick::indicator:hover {{ border-color: {accent}; }}"
                f"QCheckBox#flashPick::indicator:checked {{ background: {accent};"
                f" border-color: {accent}; }}")
            self._flash_checks[f.id] = chk
            head.addWidget(chk)
            head.addStretch(1)
            card_lay.addLayout(head)
            content = QLabel(f.content)
            content.setWordWrap(True)
            content.setStyleSheet(f"background: transparent; color: {fg};")
            card_lay.addWidget(content)
            if f.remark:
                remark = QLabel(f"└ {f.remark}")
                remark.setStyleSheet(f"background: transparent; color: {fg2}; font-size: 12px;")
                card_lay.addWidget(remark)
            meta = QLabel(f"来自 {f.source_app or '未知'} · "
                          f"{f.created_at.strftime('%m-%d %H:%M') if f.created_at else ''}")
            meta.setStyleSheet(f"background: transparent; color: {fg2}; font-size:12px;")
            card_lay.addWidget(meta)
            btn_row = QHBoxLayout()
            if self._show_archived:
                actions = [("还原到收件箱", lambda _=False, fid=f.id: self._unarchive(fid)),
                           ("删除", lambda _=False, fid=f.id: self._delete_flash(fid))]
            else:
                actions = [("转为笔记", lambda _=False, fid=f.id: self._to_note(fid)),
                           ("转为任务", lambda _=False, fid=f.id: self._to_task(fid)),
                           ("打标签", lambda _=False, fid=f.id: self._tag_flash(fid)),
                           ("归档", lambda _=False, fid=f.id: self._archive(fid)),
                           ("删除", lambda _=False, fid=f.id: self._delete_flash(fid))]
            for text, cb in actions:
                b = UButton(text, tone=("danger" if text == "删除" else "default"),
                            kind="ghost")
                b.clicked.connect(cb)
                btn_row.addWidget(b)
            btn_row.addStretch(1)
            card_lay.addLayout(btn_row)
            # 必须用 objectName 限定：QLabel 是 QFrame 的子类，裸「QFrame{}」规则会
            # 级联到卡片内的每个 QLabel（内容/来源行），给它们套上直角边框 →
            # 视觉上与卡片圆角割裂。命名后只作用于卡片本身。
            card.setObjectName("flashCard")
            card.setStyleSheet(
                f"QFrame#flashCard {{ background: {layer}; border: 1px solid {border};"
                f" border-radius: 10px; }}")
            self._flash_cards[f.id] = card
            self.flash_list.addWidget(card)
        if not flashes:
            self.flash_list.setAlignment(Qt.AlignCenter)
            # 空状态每次重建，避免反复 addWidget 同一实例被 _clear deleteLater 后引用已删除对象
            self.flash_list.addWidget(
                EmptyState("nav.flash", "按 Ctrl+Shift+S 在任何应用里划词捕获", "", self))

    # ---------- 动作 ----------
    def _to_note(self, fid: int):
        
        note = self.flash_service.to_note(fid, self.note_service)
        self.reload()
        if note:
            _toast(self, "已转为笔记：打开「笔记」查看")

    def _to_task(self, fid: int):
        self.flash_service.to_task(fid, self.task_service)
        self.reload()

    def _tag_flash(self, fid: int):
        # 原先用 qfluentwidgets 的 MessageBoxBase（yesButton/viewLayout 是它的私有结构）。
        # 换成普通对话框：框架模板已经美化 QDialog / QLineEdit / QPushButton，
        # 外观与其它弹窗一致，也不再依赖第三方库。
        dialog = QDialog(self)
        dialog.setWindowTitle("为闪念打标签")
        layout = QVBoxLayout(dialog)
        layout.setSpacing(8)
        layout.addWidget(QLabel("为闪念打标签"))
        edit = QLineEdit(placeholder="逗号分隔，如：灵感, PySide6")
        layout.addWidget(edit)
        buttons = QDialogButtonBox(
            QDialogButtonBox.Ok | QDialogButtonBox.Cancel, dialog)
        buttons.accepted.connect(dialog.accept)
        buttons.rejected.connect(dialog.reject)
        layout.addWidget(buttons)
        if dialog.exec() and edit.text().strip():
            names = [x.strip() for x in edit.text().replace("，", ",").split(",") if x.strip()]
            self.flash_service.tag(fid, names)
            self.reload()

    def _delete_flash(self, fid: int):
        self.flash_service.delete(fid)
        self.flashDeleted.emit(fid)
        self.reload()

    # ---------- 归档（F11-4） ----------
    def _on_archive_toggle(self, checked: bool):
        self._show_archived = checked
        self._reload_flashes()

    def _archive(self, fid: int):
        self.flash_service.archive(fid)
        self.reload()

    def _unarchive(self, fid: int):
        self.flash_service.unarchive(fid)
        self.reload()

    # ---------- 多选合并（F11-3） ----------
    def _selected_flash_ids(self):
        return [fid for fid, chk in self._flash_checks.items() if chk.isChecked()]

    def _merge_selected(self):
        ids = self._selected_flash_ids()
        if len(ids) < 2:
            _toast(self, "请至少勾选两条闪念再合并")
            return
        self.flash_service.merge(ids)
        self.reload()

    def _toggle_select_all(self):
        if not self._flash_checks:
            return
        all_checked = all(chk.isChecked() for chk in self._flash_checks.values())
        target = not all_checked
        for chk in self._flash_checks.values():
            chk.setChecked(target)

    def _restyle(self):
        eng = ThemeEngine.instance()
        if eng:
            self.setStyleSheet(
                f"QLabel {{ background: transparent; }}"
                f"QTreeView::item:selected, QTreeView::item:selected:active, "
                f"QTreeView::item:selected:!active {{ "
                f"background: transparent; color: {eng.t('fg', '#1A1A1A')}; }}"
                f"QTreeView::item:hover {{ background: transparent; }}"
                # 去掉 pane 边框：Tab 内容已是自绘 UCard，再套一圈 pane 边框会
                # 形成两条平行紧贴的边界（「两个边框」）。仅限本页 tabs。
                f"QTabWidget#inboxTabs::pane {{ border: none; background: transparent; }}")


def _clear(lay):
    while lay.count():
        item = lay.takeAt(0)
        w = item.widget()
        if w:
            w.deleteLater()


def _toast(parent, text: str):
    
    InfoBar.success("完成", text, duration=2500, position=InfoBarPosition.BOTTOM, parent=parent)


class _ScrollWrap(QWidget):
    def __init__(self, inner_lay, parent=None):
        super().__init__(parent)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.NoFrame)
        # 第12项：不出现横向滚动，子内容宽度限制在视口内（放不下由内部流式/换行承接）
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        body = QWidget()
        body.setLayout(inner_lay)
        scroll.setWidget(body)
        outer.addWidget(scroll)
        self.scroll = scroll
