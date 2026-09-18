# -*- coding: utf-8 -*-
"""笔记页：笔记树（文件夹 → 笔记，可搜索）| 编辑器 + 链接面板（引用/反链/归属 + 主动添加）。"""
import html as _html
from datetime import datetime
from typing import Optional
from urllib.parse import quote, unquote

from PySide6.QtCore import QModelIndex, Qt, Signal
from PySide6.QtGui import QCursor, QKeySequence, QShortcut
from PySide6.QtWidgets import (QAbstractItemView, QFrame, QHBoxLayout, QListWidgetItem, QMenu, QScrollArea, QSizePolicy, QSplitter, QStackedWidget, QTreeView, QVBoxLayout, QWidget)

from ...model.application.note_service import (
    DEFAULT_NOTE_TITLE, NOTE_FORMAT_EXCEL, NOTE_FORMAT_LINK, NOTE_FORMAT_MARKDOWN,
    NOTE_FORMAT_RICHTEXT, NOTE_FORMAT_WORD, NOTE_TEMPLATES,
)
from ...model.domain.entities import Note
from ..components.general import EmptyState
from ..components.markdown_editor import MarkdownEditor
from ..components.note_create_dialog import NoteCreateDialog
from ..components.note_previews import ExcelEditView, LinkPreviewView, WordEditView
from ..components.richtext_editor import RichTextEditor
from ..kit.icons import icon
from qfluent_core import ThemeManager as ThemeEngine
from ..note_tree import (
    KIND_ALL, KIND_FOLDER, KIND_NOTE, NoteRoleId, NoteRoleKind,
    NoteTreeDelegate, NoteTreeFilterProxy, NoteTreeModel,
)
from ..ui import UButton, UCard, UDialog, DialogType, UInputDialog, UTitle, PageHeader
from zhixing.view.kit.fluent_compat import QComboBox, QLabel, QLineEdit, QTabWidget
from zhixing.view.kit.fluent_compat import InfoBar, InfoBarPosition
from zhixing.view.kit.fluent_compat import QListWidget


class NotePage(QWidget):
    noteSelected = Signal(int)
    noteDeleted = Signal(int, str)     # note_id, title（删除撤销）
    taskCreateRequested = Signal(str)  # 选中文本（W10：笔记转任务，由控制器接线兜底）

    def __init__(self, note_service, settings, parent=None, task_service=None):
        super().__init__(parent)
        self.note_service = note_service
        self.settings = settings
        self.task_service = task_service
        self._current_note: Optional[Note] = None
        self._expanded = {"all"}      # 记住展开的「全部/文件夹」节点 key
        self._restoring = False
        self._build()
        self._restyle()
        ThemeEngine.instance() and ThemeEngine.instance().changed.connect(self._restyle)

    def _build(self):
        outer = QVBoxLayout(self)
        outer.setContentsMargins(12, 12, 12, 10)
        outer.setSpacing(6)
        self.header = PageHeader("笔记", "写作、沉淀并链接你的知识")
        outer.addWidget(self.header)
        h = QHBoxLayout()
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(14)
        outer.addLayout(h, 1)
        split = QSplitter(Qt.Horizontal)
        h.addWidget(split)

        # ---- 左：笔记树（文件夹 → 笔记，顶部搜索）----
        card_left = UCard("笔记库")
        l_host = QWidget()
        l_lay = QVBoxLayout(l_host)
        l_lay.setContentsMargins(0, 0, 0, 0)
        l_lay.setSpacing(8)

        self.search = QLineEdit()
        self.search.setPlaceholderText("搜索笔记标题…")
        self.search.textChanged.connect(self._apply_search)
        l_lay.addWidget(self.search)

        self.note_model = NoteTreeModel(self)
        self.proxy = NoteTreeFilterProxy(self)
        self.proxy.setSourceModel(self.note_model)
        self.note_tree = QTreeView()
        self.note_tree.setModel(self.proxy)
        self.note_tree.setHeaderHidden(True)
        self.note_tree.setRootIsDecorated(False)
        self.note_tree.setIndentation(0)
        self.note_tree.setFrameShape(QTreeView.NoFrame)
        self.note_tree.setExpandsOnDoubleClick(False)
        self.note_tree.setSelectionMode(QAbstractItemView.SingleSelection)
        self.note_tree.setMouseTracking(True)
        self.note_tree.viewport().setMouseTracking(True)
        self.delegate = NoteTreeDelegate(self.note_tree, row_height=34, indent=18)
        self.note_tree.setItemDelegate(self.delegate)
        self.delegate.deleteRequested.connect(self._delete_note)
        self.delegate.togglePinRequested.connect(self._toggle_pin)
        self.delegate.renameRequested.connect(self._rename_note)
        self.delegate.addFolderRequested.connect(self._new_folder)
        self.delegate.addNoteRequested.connect(self._prompt_new_note)
        self.delegate.renameFolderRequested.connect(self._rename_folder_dialog)
        self.delegate.deleteFolderRequested.connect(self._delete_folder)
        self.note_tree.clicked.connect(self._on_tree_clicked)
        # v0.16 P2-b: 文件夹展开/折叠 → chevron 平滑旋转
        self.delegate.attach_view(self.note_tree)
        self.note_tree.expanded.connect(
            lambda idx: self.delegate.animate_chevron(idx.data(NoteRoleId), True))
        self.note_tree.collapsed.connect(
            lambda idx: self.delegate.animate_chevron(idx.data(NoteRoleId), False))
        self.note_tree.expanded.connect(self._on_expanded)
        self.note_tree.collapsed.connect(self._on_collapsed)
        l_lay.addWidget(self.note_tree, 1)

        # 空状态（10a）：无笔记时替代空白编辑器，给「新建笔记」主行动
        self.empty_note = EmptyState("nav.notes", "还没有笔记，点击新建开始记录",
                                     "新建笔记", self,
                                     on_action=lambda: self._prompt_new_note())
        self.empty_note.setVisible(False)
        l_lay.addWidget(self.empty_note, 1)

        new_row = QHBoxLayout()
        self.template_combo = QComboBox()
        self.template_combo.addItem("＋ 从模板新建…", None)
        for _name in NOTE_TEMPLATES:
            self.template_combo.addItem(_name, _name)
        self.template_combo.activated.connect(self._create_from_template)
        new_row.addWidget(self.template_combo)
        self.orphans_btn = UButton("孤儿笔记", tone="default", kind="ghost")
        self.orphans_btn.clicked.connect(self._open_orphans)
        new_row.addWidget(self.orphans_btn)
        new_row.addStretch(1)
        l_lay.addLayout(new_row)

        card_left.add_widget(l_host, 1)
        card_left.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Expanding)
        card_left.setMinimumWidth(240)
        split.addWidget(card_left)

        # ---- 右：编辑器 沉浸卡（含底部链接面板）----
        r_host = QWidget()
        right_lay = QVBoxLayout(r_host)
        right_lay.setContentsMargins(0, 0, 0, 0)
        right_lay.setSpacing(10)
        self.md_editor = MarkdownEditor(self.note_service)
        self.rt_editor = RichTextEditor(self.note_service)
        self.word_view = WordEditView()
        self.excel_view = ExcelEditView()
        self.link_view = LinkPreviewView()
        # 链接列表变更（增/删/改）立即落盘到 content_md
        self.link_view.linksChanged.connect(self._on_links_changed)
        self.editor = QStackedWidget()
        self.editor.addWidget(self.md_editor)
        self.editor.addWidget(self.rt_editor)
        self.editor.addWidget(self.word_view)
        self.editor.addWidget(self.excel_view)
        self.editor.addWidget(self.link_view)
        self.md_editor.saveRequested.connect(self._auto_save)
        self.rt_editor.saveRequested.connect(self._auto_save)
        self.word_view.saved.connect(self._mark_saved)
        self.excel_view.saved.connect(self._mark_saved)
        self.md_editor.linkClicked.connect(self._open_by_title)
        self.md_editor.taskCreateRequested.connect(self._create_task_from_selection)
        self.md_editor.taskCreateBlockRequested.connect(self._create_task_from_selection_block)
        self.rt_editor.taskCreateRequested.connect(self._create_task_from_selection)
        right_lay.addWidget(self.editor, 1)

        # 保存/版本历史/查找替换并入编辑器工具栏，并用与格式按钮（B/I/H1…）
        # 完全同款的按钮工厂创建 —— 此前用 UButton，圆角/内边距/高度与左侧
        # 格式按钮不一致，工具区看起来是两套控件。
        self.save_btn = self.md_editor.make_toolbar_button(
            "保存", self.save_now, "保存（Ctrl+S）")
        self.revisions_btn = self.md_editor.make_toolbar_button(
            "版本历史", self._open_revisions, "查看历史版本")
        self.find_btn = self.md_editor.make_toolbar_button(
            "查找替换", self._open_find_replace, "查找并替换正文内容")
        for _w in (self.save_btn, self.revisions_btn, self.find_btn):
            self.md_editor.add_toolbar_action(_w)
        # 保存状态标签由编辑器工具栏承载（原为独立工具行）
        self.save_status = self.md_editor.save_status
        self._save_shortcut = QShortcut(QKeySequence("Ctrl+S"), self)
        self._save_shortcut.activated.connect(self.save_now)

        # ---- 底部：链接面板（引用正向 / 反链 / 归属 + 主动添加按钮） ----
        self.links_panel = QFrame()
        panel_lay = QVBoxLayout(self.links_panel)
        panel_lay.setContentsMargins(0, 2, 0, 0)
        panel_lay.setSpacing(3)

        # 「引用 / 归属」动作改放链接卡片的标题区（见下方 links_card.header_row）。
        # 原 links_hint 反馈行与下方 tab 功能重复、且空态占一行造成标题与 tab 之间
        # 空白过大，已移除；操作反馈改用 InfoBar 浮动提示（见 _panel_feedback）。
        # 引用 / 归属按钮：改用与编辑器工具栏同款的 QToolButton（高 28），
        # 避免 UButton 过大的内边距在链接卡片标题区显得笨重、不和谐。
        self.btn_ref_add = self.md_editor.make_toolbar_button(
            "引用", self._prompt_reference,
            "添加指向其他笔记的引用链接；输入不存在的标题可建「待建」链接")
        self.btn_attach_add = self.md_editor.make_toolbar_button(
            "归属", self._prompt_attach,
            "把本笔记归属到某任务（关联）或某文件夹（移动）")

        # 三个分组页：引用（正向，含悬空待建）/ 反链（谁链接到我）/ 归属（任务 + 文件夹）
        self.link_tabs = QTabWidget()
        self.link_tabs.setDocumentMode(True)
        self.link_tabs.setStyleSheet(
            "QTabBar::tab { padding: 2px 10px; font-size: 12px; }")
        self.out_body, self.backlink_body, self.owner_body = (
            self._new_links_label(), self._new_links_label(), self._new_links_label())
        self.link_tabs.addTab(self._wrap_links_page(self.out_body), "引用（0）")
        self.link_tabs.addTab(self._wrap_links_page(self.backlink_body), "反链（0）")
        self.link_tabs.addTab(self._wrap_links_page(self.owner_body), "归属（0）")
        panel_lay.addWidget(self.link_tabs, 1)
        self.links_panel.setMaximumHeight(206)
        # 链接面板用 UCard 包裹（与左侧「笔记库」、上方「编辑器」视觉同构，
        # 原先裸 QFrame 直接贴在编辑器下方，缺少卡片层次）
        self.links_card = UCard()
        # 「引用 / 归属」放标题右侧：卡片级操作与所属卡片形成明确归属，
        # 且不再在面板正文里额外占一行。
        hdr = self.links_card.header_row("链接")
        self.backlink_title = self.links_card._header_row_host.findChild(QLabel)
        # 标题降为 12px 小字（与编辑器工具栏一致），避免标题区过高
        if self.backlink_title is not None:
            self.backlink_title.setStyleSheet(
                "font-size:12px; font-weight:600; background:transparent;")
        hdr.addWidget(self.btn_ref_add, 0, Qt.AlignVCenter)
        hdr.addWidget(self.btn_attach_add, 0, Qt.AlignVCenter)
        self.links_card.add_widget(self.links_panel, 1)
        self.links_card.setMaximumHeight(246)   # 206 面板 + 卡片标题与内边距
        right_lay.addWidget(self.links_card)
        card_right = UCard("编辑器")
        card_right.add_widget(r_host, 1)
        split.addWidget(card_right)
        split.setCollapsible(0, False)
        split.setSizes([320, 720])

    def _new_links_label(self) -> QLabel:
        """链接面板分组页正文 QLabel（富文本锚点，点击经 _open_links_anchor 分发）。"""
        label = QLabel("")
        label.setWordWrap(True)
        label.setTextFormat(Qt.RichText)
        label.setTextInteractionFlags(Qt.TextBrowserInteraction)
        label.linkActivated.connect(self._open_links_anchor)
        return label

    @staticmethod
    def _wrap_links_page(label: QLabel) -> QScrollArea:
        """把正文 QLabel 放进可滚动分组页（长列表不挤压编辑器）。"""
        page = QScrollArea()
        page.setWidgetResizable(True)
        page.setFrameShape(QFrame.NoFrame)
        page.setMinimumHeight(44)
        host = QWidget()
        v = QVBoxLayout(host)
        v.setContentsMargins(2, 4, 2, 4)
        v.setSpacing(2)
        v.addWidget(label)
        v.addStretch(1)
        page.setWidget(host)
        return page

    # ================= 数据 =================
    def reload_folders(self):
        """兼容旧接口：重载整棵笔记树。"""
        self._reload_tree()

    def reload_list(self, folder_id=None):
        """兼容旧接口（folder_id 已无独立列表语义，忽略）。"""
        self._reload_tree()

    def _reload_tree(self):
        # 记录当前选中节点，reload 后恢复，避免焦点自动跳到「全部笔记」
        cur_key = self._selection_key(self.note_tree.currentIndex())
        folders = []
        notes = []
        if self.note_service is not None:
            if hasattr(self.note_service, "folder_titles"):
                folders = self.note_service.folder_titles() or []
            # 文件夹为空时自动新建默认列表，避免笔记无处归属
            if not folders and hasattr(self.note_service, "ensure_default_folder"):
                self.note_service.ensure_default_folder()
                folders = self.note_service.folder_titles() or []
            if hasattr(self.note_service, "list"):
                notes = self.note_service.list() or []
        self.note_model.reload(folders, notes)
        has_notes = bool(notes)
        self.note_tree.setVisible(has_notes)
        if hasattr(self, "empty_note"):
            self.empty_note.setVisible(not has_notes)
        self._restore_expansion()
        self._restore_selection(cur_key)

    def select_note(self, note_id: int):
        n = self.note_service.get(note_id) if self.note_service else None
        if not n:
            return
        self._commit_current_editor()
        self._current_note = n
        fmt = getattr(n, "format", None) or NOTE_FORMAT_MARKDOWN
        if fmt == NOTE_FORMAT_RICHTEXT:
            self.editor.setCurrentWidget(self.rt_editor)
            self.rt_editor.set_html(n.content_md)
        elif fmt == NOTE_FORMAT_WORD:
            self.editor.setCurrentWidget(self.word_view)
            self.word_view.set_path(n.content_md)
        elif fmt == NOTE_FORMAT_EXCEL:
            self.editor.setCurrentWidget(self.excel_view)
            self.excel_view.set_path(n.content_md)
        elif fmt == NOTE_FORMAT_LINK:
            self.editor.setCurrentWidget(self.link_view)
            self.link_view.set_content(n.content_md)
        else:
            self.editor.setCurrentWidget(self.md_editor)
            self.md_editor.set_content(n.content_md)
            self.md_editor.set_mode("preview")   # Markdown 默认直接预览（不显示原文）
        self._reload_backlinks(note_id)
        idx = self.proxy.mapFromSource(self.note_model.index_of_note(note_id))
        if idx.isValid():
            self._reveal_index(idx)
            self.note_tree.setCurrentIndex(idx)
            self.note_tree.scrollTo(idx)

    def select_folder(self, folder_id: int):
        """定位并选中某文件夹（图谱双击文件夹节点跳转用）。"""
        src_idx = self.note_model.index_of_folder(folder_id)
        if src_idx.isValid():
            idx = self.proxy.mapFromSource(src_idx)
            if idx.isValid():
                self._reveal_index(idx)
                self.note_tree.expand(idx)
                self.note_tree.setCurrentIndex(idx)
                self.note_tree.scrollTo(idx)

    def current_note_id(self) -> Optional[int]:
        return self._current_note.id if self._current_note else None

    def _commit_current_editor(self):
        """切走前把当前编辑器里未防抖完成的内容落到旧笔记，避免串写到新笔记。"""
        cur = self.editor.currentWidget()
        if cur is not None and hasattr(cur, "commit"):
            cur.commit()

    # ================= 搜索 / 展开 =================
    def _apply_search(self, text: str):
        self.proxy.set_text(text)
        if text.strip():
            self._restoring = True
            try:
                self.note_tree.expandAll()
            finally:
                self._restoring = False
        else:
            self._restore_expansion()

    @staticmethod
    def _node_key(src: QModelIndex):
        kind = src.data(NoteRoleKind)
        if kind == KIND_ALL:
            return "all"
        if kind == KIND_FOLDER:
            return f"folder:{src.data(NoteRoleId)}"
        return None

    def _on_expanded(self, index):
        if self._restoring:
            return
        key = self._node_key(self.proxy.mapToSource(index))
        if key:
            self._expanded.add(key)

    def _on_collapsed(self, index):
        if self._restoring:
            return
        key = self._node_key(self.proxy.mapToSource(index))
        if key:
            self._expanded.discard(key)

    def _restore_expansion(self):
        self._restoring = True
        try:
            self.note_tree.collapseAll()
            self._expand_matching()
        finally:
            self._restoring = False

    def _selection_key(self, index):
        """当前选中节点的可恢复标识：(kind, id)。"""
        if not index.isValid():
            return None
        src = self.proxy.mapToSource(index)
        kind = src.data(NoteRoleKind)
        if kind == KIND_NOTE:
            return ("note", src.data(NoteRoleId))
        if kind == KIND_FOLDER:
            return ("folder", src.data(NoteRoleId))
        if kind == KIND_ALL:
            return ("all", None)
        return None

    def _restore_selection(self, key):
        """reload 后把选中恢复到原节点，避免焦点跳到「全部笔记」。"""
        if key is None:
            return
        kind, id_ = key
        src_idx = QModelIndex()
        if kind == "all":
            idx0 = self.note_model.index(0, 0)
            if idx0.isValid() and idx0.data(NoteRoleKind) == KIND_ALL:
                src_idx = idx0
        elif kind == "folder":
            src_idx = self.note_model.index_of_folder(id_)
        elif kind == "note":
            src_idx = self.note_model.index_of_note(id_)
        if src_idx.isValid():
            idx = self.proxy.mapFromSource(src_idx)
            if idx.isValid():
                self._reveal_index(idx)          # 展开父节点，确保选中项可见
                self.note_tree.setCurrentIndex(idx)
                self.note_tree.scrollTo(idx)      # 滚动到选中项，避免停在顶部「全部笔记」

    def _expand_matching(self):
        def walk(parent):
            for r in range(self.proxy.rowCount(parent)):
                idx = self.proxy.index(r, 0, parent)
                key = self._node_key(self.proxy.mapToSource(idx))
                if key and key in self._expanded:
                    self.note_tree.expand(idx)
                walk(idx)
        walk(QModelIndex())

    def _reveal_index(self, idx):
        parent = idx.parent()
        while parent.isValid():
            self.note_tree.expand(parent)
            parent = parent.parent()

    # ================= 交互 =================
    def _on_tree_clicked(self, index):
        src = self.proxy.mapToSource(index)
        kind = src.data(NoteRoleKind)
        if kind == KIND_NOTE:
            nid = src.data(NoteRoleId)
            if nid:
                self.note_tree.setCurrentIndex(index)   # v0.17.1: 点击即高亮该笔记行
                self.noteSelected.emit(nid)
        elif kind in (KIND_FOLDER, KIND_ALL):
            # v0.17.1: 文件夹/全部节点点击也选中该行（视觉高亮 + 焦点跟随），
            # 同时折叠/展开其子级。
            self.note_tree.setCurrentIndex(index)
            if self.proxy.rowCount(index) > 0:
                self.note_tree.setExpanded(index, not self.note_tree.isExpanded(index))

    def _delete_note(self, note_id: int):
        if not note_id or not self.note_service:
            return
        note = self.note_service.get(note_id)
        title = note.title if note else ""
        self.note_service.delete(note_id)
        self.noteDeleted.emit(note_id, title or "（无标题）")
        if self._current_note and self._current_note.id == note_id:
            self._current_note = None
            self.md_editor.cancel_pending()
            self.rt_editor.cancel_pending()
            self.md_editor.set_content("")
            self.rt_editor.set_html("")
            self.word_view.set_path("")
            self.excel_view.set_path("")
            self.link_view.set_content("")
            self._reset_links_panel()
        self._reload_tree()

    def _toggle_pin(self, note_id: int):
        if not note_id or not self.note_service:
            return
        note = self.note_model.note_at(note_id)
        if note is None or not hasattr(self.note_service, "set_pinned"):
            return
        self.note_service.set_pinned(note_id, not note.pinned)
        self._reload_tree()

    def _rename_note(self, note_id: int):
        if not note_id or not self.note_service:
            return
        note = self.note_model.note_at(note_id)
        title = note.title if note else ""
        new_title, ok = UInputDialog.get_text(self, "重命名笔记", label="笔记名称：",
                                              text=title)
        if not ok or not new_title:
            return
        if hasattr(self.note_service, "save"):
            self.note_service.save(note_id, title=new_title)
        self._reload_tree()
        # 若重命名的是当前打开笔记：刷新标题引用与反链面板
        # （反链目标标题已由 note_service.save 的 rename_target 同步）。
        if self._current_note and self._current_note.id == note_id:
            self._current_note = self.note_service.get(note_id)
            self._reload_backlinks(note_id)

    def _prompt_new_note(self, folder_id=None):
        """新建笔记：弹「名称 + 类型 + 目标」弹窗（需求④+⑦），以用户输入与类型创建笔记。"""
        if self.note_service is None:
            return
        picked = NoteCreateDialog.get_note(self)
        if picked is None:
            return
        name, fmt, target = picked
        title = (name or "").strip() or DEFAULT_NOTE_TITLE
        if fmt in (NOTE_FORMAT_WORD, NOTE_FORMAT_EXCEL, NOTE_FORMAT_LINK):
            content = (target or "").strip()
        elif fmt == NOTE_FORMAT_MARKDOWN:
            content = "（在这里开始写作…）\n"
        else:
            content = ""
        note = self.note_service.create(title=title, content_md=content,
                                        folder_id=folder_id, format=fmt)
        self._reload_tree()
        if note:
            self.select_note(note.id)

    # ---------- 文件夹操作（新建 / 重命名 / 删除） ----------
    def _new_folder(self, parent_id=None):
        """新建文件夹（悬浮「＋」胶囊按钮触发）；parent_id 为 None 时建在顶层。"""
        name, ok = UInputDialog.get_text(self, "新建文件夹", "文件夹名称：")
        if ok and name.strip() and self.note_service:
            self.note_service.create_folder(name.strip(), parent_id=parent_id)

    def _rename_folder_dialog(self, folder_id: int):
        current = ""
        for f in (self.note_service.folder_titles() if self.note_service else []):
            if f.id == folder_id:
                current = f.name
                break
        name, ok = UInputDialog.get_text(self, "重命名文件夹", "文件夹名称：", text=current)
        if ok and name.strip() and self.note_service:
            self.note_service.rename_folder(folder_id, name.strip())

    def _delete_folder(self, folder_id: int):
        from PySide6.QtWidgets import QMessageBox
        ret = QMessageBox.question(
            self, "删除文件夹",
            "删除后文件夹内的笔记会移到「全部笔记」，不会删除笔记。确认删除？",
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No)
        if ret == QMessageBox.Yes and self.note_service:
            self.note_service.delete_folder(folder_id)

    def _on_links_changed(self, payload: str):
        """链接型笔记：链接列表变更 → 立即持久化到 content_md。"""
        if not self._current_note:
            return
        self.note_service.save(self._current_note.id, content_md=payload)
        self._current_note = self.note_service.get(self._current_note.id)
        self.save_status.setText(f"已保存 {datetime.now().strftime('%H:%M')}")

    def _auto_save(self, _title: str, content: str):
        if self._current_note:
            # 需求④：标题由用户输入（新建/重命名弹窗）决定，自动保存仅落正文，
            # 不再用内容首行改写标题（编辑器外发的 title 字段被忽略）。
            self.note_service.save(self._current_note.id, content_md=content)
            self._current_note = self.note_service.get(self._current_note.id)
            if self._current_note:
                self._reload_backlinks(self._current_note.id)
            self.save_status.setText(f"已保存 {datetime.now().strftime('%H:%M')}")

    def save_now(self):
        """主动保存当前编辑器（Ctrl+S / 保存按钮）。"""
        cur = self.editor.currentWidget()
        if cur is not None and hasattr(cur, "commit"):
            cur.commit()
        self.save_status.setText(f"已保存 {datetime.now().strftime('%H:%M')}")

    def _mark_saved(self):
        self.save_status.setText(f"已保存 {datetime.now().strftime('%H:%M')}")

    def _open_by_title(self, title: str):
        nid = self.note_service.resolve(title)
        if nid:
            self.noteSelected.emit(nid)

    def _create_task_from_selection(self, text: str):
        """笔记选中文本 → 任务（W10）：编辑器右键菜单接线 note_service.create_task_from_selection。"""
        if not self._current_note or not (text or "").strip():
            return
        ts = getattr(self, "task_service", None)
        if ts is not None and self.note_service is not None \
                and hasattr(self.note_service, "create_task_from_selection"):
            try:
                self.note_service.create_task_from_selection(self._current_note.id, text, ts)
            except Exception:
                pass
        self.taskCreateRequested.emit(text)

    def _create_task_from_selection_block(self, text: str, block_key: str):
        """v0.15 P0-1：选文 → 任务并落「段落定位键」（右键菜单二级动作）。"""
        if not self._current_note or not (text or "").strip():
            return
        ts = getattr(self, "task_service", None)
        if ts is not None and self.note_service is not None \
                and hasattr(self.note_service, "create_task_from_selection"):
            try:
                self.note_service.create_task_from_selection(
                    self._current_note.id, text, ts, block_key=block_key, snippet=text)
                self.taskCreateRequested.emit("")   # 通知主窗刷新（无文本，仅表示已建）
            except Exception:
                pass
            return
        self.taskCreateRequested.emit(text)

    def locate_in_note(self, note_id: int, block_key: str = ""):
        """v0.15 P0-1：跳转定位到笔记内某段落（block_key 指纹；md 编辑器滚动高亮）。

        供任务/图谱/深链调用：打开（或切到）该笔记后定位；找不到段落只打开笔记。
        """
        self.select_note(note_id)
        if self._current_note and block_key and \
                getattr(self._current_note, "format", "markdown") == "markdown":
            try:
                cur = self.editor.currentWidget()
                if cur is self.md_editor:
                    self.md_editor.set_mode("edit")   # 定位需编辑态可见
                    self.md_editor.locate_block(block_key)
            except Exception:  # noqa: BLE001
                pass

    def _open_backlink(self, href: str):
        """反链面板锚点：href 为 note:<id>，直接定位来源笔记。"""
        if not href.startswith("note:"):
            return
        try:
            nid = int(href[5:])
        except ValueError:
            return
        if nid:
            self.noteSelected.emit(nid)

    def toggle_preview(self):
        """切换 Markdown 编辑/双栏/只预览（Ctrl+E）。"""
        if self.editor.currentWidget() is not self.md_editor:
            return
        self.md_editor.cycle_mode()

    def _create_from_template(self, index: int):
        """按模板新建笔记（F2-6）。"""
        name = self.template_combo.itemData(index)
        if not name or not self.note_service:
            self.template_combo.setCurrentIndex(0)
            return
        note = self.note_service.create_from_template(name)
        self.template_combo.setCurrentIndex(0)
        if note:
            self._reload_tree()
            self.noteSelected.emit(note.id)

    def _open_revisions(self):
        """版本历史对话框（F2-9）。"""
        if not self._current_note:
            return
        from ..components.note_tools import NoteRevisionDialog
        dlg = NoteRevisionDialog(self.note_service, self._current_note.id, self)
        if dlg.exec():
            self._reload_tree()
            self.select_note(self._current_note.id)

    def _open_find_replace(self):
        """编辑器查找替换（F7-4）；仅 Markdown/富文本编辑器支持。"""
        if not self._current_note:
            return
        cur = self.editor.currentWidget()
        if cur is self.md_editor:
            editor = self.md_editor.editor
        elif cur is self.rt_editor:
            editor = self.rt_editor.edit
        else:
            return
        from ..components.note_tools import NoteFindReplaceDialog
        dlg = NoteFindReplaceDialog(editor, self)
        dlg.exec()

    def _open_orphans(self):
        """孤儿笔记清单（F3-8）。"""
        from ..components.note_tools import OrphanNotesDialog
        dlg = OrphanNotesDialog(self.note_service, self)
        dlg.openNote.connect(self.noteSelected.emit)
        dlg.exec()

    # ================= 链接面板（引用 / 反链 / 归属） =================
    def _token(self, key: str, default: str) -> str:
        eng = ThemeEngine.instance()
        return eng.t(key, default) if eng else default

    @staticmethod
    def _safe_call(fn, fallback):
        try:
            r = fn()
            return r if r is not None else fallback
        except Exception:  # noqa: BLE001 —— 兼容无新接口的假服务/异常不崩面板
            return fallback

    def _reload_backlinks(self, note_id: int):
        """刷新链接面板：引用（正向出链，含悬空待建）/ 反链 / 归属（任务 + 文件夹）。"""
        accent = self._token("accent", "#0D9488")
        fg2 = self._token("fg2", "#6B7280")
        fg3 = self._token("fg3", "#A8AEB6")
        svc = self.note_service
        if svc is None:
            return
        items = self._safe_call(lambda: svc.backlinks(note_id), [])
        out = self._safe_call(lambda: svc.outgoing_links(note_id), [])
        tasks = self._safe_call(lambda: svc.attached_tasks(note_id), [])
        note = self._safe_call(lambda: svc.get(note_id), None)
        folder = None
        if note is not None and note.folder_id:
            for fld in self._safe_call(svc.folder_titles, []) or []:
                if getattr(fld, "id", None) == note.folder_id:
                    folder = fld
                    break

        # —— 引用（正向）：真实笔记可点击跳转；悬空「待建」点击给创建/搜索菜单 ——
        parts = []
        for link in out:
            safe = _html.escape(link.dst_title)
            if link.dst_note_id:
                parts.append(
                    f'<a href="fwd:{link.dst_note_id}" '
                    f'style="color:{accent};text-decoration:none;">[{safe}]</a>')
            else:
                enc = quote(link.dst_title, safe="")
                parts.append(
                    f'<a href="dangle:{enc}" style="color:{fg3};text-decoration:none;'
                    f'border-bottom:1px dashed {fg3};">[{safe}]</a> '
                    f'<span style="color:{fg3};">待建</span>')
        if not parts:
            self.out_body.setText(
                f'<span style="color:{fg2};">还没有主动引用的笔记。'
                f'点右上「引用」选择目标，或在正文输入 [[标题]] 建立链接</span>')
        else:
            self.out_body.setText("<br>".join(parts))

        # —— 反链：谁链接到我（沿用原样式，保留既有跳转 note:<id>）——
        parts = []
        for it in items:
            safe_title = _html.escape(it.src_title)
            safe_snippet = _html.escape(it.snippet)
            parts.append(f'<a href="note:{it.src_note_id}" style="color:{accent};'
                         f'text-decoration:none;">[{safe_title}]</a> '
                         f'<span style="color:{fg2};">{safe_snippet}</span>')
        if not parts:
            self.backlink_body.setText(
                f'<span style="color:{fg2};">还没有笔记链接到这里，'
                f'在别处输入 [[标题]] 即可建立连接</span>')
        else:
            self.backlink_body.setText("<br>".join(parts))

        # —— 归属：所在文件夹（可跳转）+ 关联任务（展示）——
        parts = []
        if folder is not None:
            parts.append(
                f'<a href="folder:{folder.id}" style="color:{accent};'
                f'text-decoration:none;" title="跳转到该文件夹">'
                f'[文件夹 · {_html.escape(folder.name)}]</a>')
        else:
            parts.append(f'<span style="color:{fg3};">[未归属文件夹]</span>')
        for t in tasks:
            parts.append(
                f'<span style="color:{fg2};">任务 · {_html.escape(t.title)}'
                f'</span> <span style="color:{fg3};">（本笔记被其关联）</span>')
        if not tasks and folder is None:
            self.owner_body.setText(
                f'<span style="color:{fg2};">尚未归属：点右上「归属」把本笔记挂到'
                f'某任务（关联）或某文件夹（移动）</span>')
        else:
            self.owner_body.setText("<br>".join(parts))

        self.link_tabs.setTabText(0, f"引用（{len(out)}）")
        self.link_tabs.setTabText(1, f"反链（{len(items)}）")
        self.link_tabs.setTabText(2, f"归属（{len(tasks) + (1 if folder else 0)}）")

    def _reset_links_panel(self):
        """关闭当前笔记（删除/清空）时清空链接面板。"""
        if not hasattr(self, "link_tabs"):
            return
        for i, txt in enumerate(("引用（0）", "反链（0）", "归属（0）")):
            self.link_tabs.setTabText(i, txt)
        for lbl in (self.out_body, self.backlink_body, self.owner_body):
            lbl.setText("")

    def _panel_feedback(self, msg: str, ok: bool = True):
        """操作反馈：改用 InfoBar 浮动提示（原 links_hint 已移除，避免占位空白）。"""
        try:
            
            if ok:
                InfoBar.success("完成", msg, duration=2500,
                                position=InfoBarPosition.BOTTOM, parent=self)
            else:
                InfoBar.warning("提示", msg, duration=2500,
                                position=InfoBarPosition.BOTTOM, parent=self)
        except Exception:  # noqa: BLE001
            pass

    def _open_links_anchor(self, href: str):
        """面板富文本锚点统一分发：note:/fwd: 跳笔记，dangle: 待建菜单，folder: 定位文件夹。"""
        if href.startswith("note:"):
            self._open_backlink(href)
            return
        if href.startswith("fwd:"):
            try:
                nid = int(href[4:])
            except ValueError:
                return
            if nid:
                self.noteSelected.emit(nid)
            return
        if href.startswith("dangle:"):
            try:
                title = unquote(href[7:])
            except Exception:  # noqa: BLE001
                return
            self._dangling_menu(title)
            return
        if href.startswith("folder:"):
            try:
                fid = int(href[7:])
            except ValueError:
                return
            if fid:
                self.select_folder(fid)

    def _dangling_menu(self, title: str):
        """悬空「待建」链接点击：可选「创建该笔记」或「维持跳转搜索」。"""
        if not self._current_note or not title or self.note_service is None:
            return
        svc = self.note_service
        if not hasattr(svc, "materialize_dangling"):
            return
        menu = QMenu(self)
        act_create = menu.addAction(f"创建笔记「{title}」并建立链接")
        act_search = menu.addAction(f"按标题搜索「{title}」")
        chosen = menu.exec(QCursor.pos())
        if chosen is act_create:
            nid = self._safe_call(
                lambda: svc.materialize_dangling(self._current_note.id, title), None)
            if nid:
                self._reload_tree()
                self._reload_backlinks(self._current_note.id)
                self._panel_feedback(f"已创建「{title}」并建立引用", ok=True)
                self.noteSelected.emit(nid)
            else:
                self._panel_feedback("创建失败：同名笔记已存在或写入出错", ok=False)
        elif chosen is act_search:
            self.search.setText(title)
            self.search.setFocus()
            self._panel_feedback(f"已在笔记树搜索「{title}」", ok=True)

    # ---------- 主动添加 ----------
    def _prompt_reference(self):
        """「+ 引用」：选择既有笔记建引用，或输入不存在的标题建「待建」悬空链接。"""
        if not self._current_note or self.note_service is None:
            return
        svc = self.note_service
        if not hasattr(svc, "add_reference_link"):
            return
        dlg = _LinkPickDialog(svc, self._current_note.id, parent=self)
        try:
            if not dlg.exec():
                return
            pick = dlg.choice()
        finally:
            dlg.deleteLater()
        if not pick:
            return
        kind, ref, title = pick   # ("note", id, 标题) / ("dangle", None, 标题)
        status = self._safe_call(
            lambda: svc.add_reference_link(self._current_note.id,
                                           int(ref) if kind == "note" else title),
            "invalid")
        if status == "added":
            self._panel_feedback(f"已建立引用 →「{title}」", ok=True)
        elif status == "dangling":
            self._panel_feedback(f"已建「待建」链接「{title}」：点击它可创建同名笔记", ok=True)
        elif status == "bound":
            self._panel_feedback(f"引用已转正 →「{title}」", ok=True)
        elif status == "duplicate":
            self._panel_feedback(f"已存在指向「{title}」的引用，未重复添加", ok=False)
        elif status == "self":
            self._panel_feedback("不能链接到笔记自身", ok=False)
        else:
            self._panel_feedback("目标不可用（不存在或已删除）", ok=False)
        self._reload_backlinks(self._current_note.id)

    def _prompt_attach(self):
        """「+ 归属」：选任务（建 task_note_link 关联）或文件夹（移动 note.folder_id）。"""
        if not self._current_note or self.note_service is None:
            return
        svc = self.note_service
        if not (hasattr(svc, "attach_note_to_task")
                and hasattr(svc, "attach_note_to_folder")):
            return
        dlg = _AttachOwnershipDialog(svc, self._current_note.id, parent=self)
        try:
            if not dlg.exec():
                return
            pick = dlg.choice()
        finally:
            dlg.deleteLater()
        if not pick:
            return
        kind, ref, name = pick    # ("task", task_id, 标题) / ("folder", folder_id|None, 名称)
        note_id = self._current_note.id
        if kind == "task":
            status = self._safe_call(lambda: svc.attach_note_to_task(int(ref), note_id),
                                     "invalid")
            if status == "attached":
                self._panel_feedback(f"已把本笔记关联到任务「{name}」", ok=True)
            elif status == "duplicate":
                self._panel_feedback(f"本笔记已关联任务「{name}」，未重复归属", ok=False)
            else:
                self._panel_feedback("归属失败：任务不存在或已删除", ok=False)
        else:
            status = self._safe_call(lambda: svc.attach_note_to_folder(note_id, ref),
                                     "invalid")
            if status == "attached":
                self._panel_feedback(f"已把本笔记移入文件夹「{name}」", ok=True)
            elif status == "unchanged":
                self._panel_feedback(f"本笔记已在文件夹「{name}」", ok=False)
            else:
                self._panel_feedback("归属失败：目标文件夹不存在（可能已被删除）", ok=False)
            self._reload_tree()   # 文件夹归属=移动，树分组需刷新
        self._reload_backlinks(note_id)

    def _restyle(self):
        eng = ThemeEngine.instance()
        if eng:
            self.setStyleSheet(
                f"QLabel {{ background: transparent; }}"
                f"QTreeView {{ background: {eng.t('layer', '#FFFFFF')};"
                f"color: {eng.t('fg', '#1A1A1A')}; border: none; }}"
                f"QTreeView::item:selected, QTreeView::item:selected:active, "
                f"QTreeView::item:selected:!active {{ "
                f"background: transparent; color: {eng.t('fg', '#1A1A1A')}; }}"
                f"QTreeView::item:hover {{ background: transparent; }}")
            if hasattr(self, "save_status"):
                self.save_status.setStyleSheet(
                    f"color: {eng.t('fg2', '#6B7280')}; font-size:12px; background: transparent;")
            # 链接面板动作按钮图标随主题刷新
            if hasattr(self, "btn_ref_add") and hasattr(self, "btn_attach_add"):
                accent = eng.t("accent", "#0D9488")
                fg2 = eng.t("fg2", "#6B7280")
                self.btn_ref_add.setIcon(icon("link.link", accent, 15))
                self.btn_attach_add.setIcon(icon("folder.plus", fg2, 15))


# ================= 链接面板弹窗（主动添加） =================

class _LinkPickDialog(UDialog):
    """「+ 引用」目标选择：模糊搜索既有笔记；输入不存在的标题可建「待建」悬空链接。

    回车/双击/「添加引用」确认：选中项或精确同名 → 引用该笔记；无同名 → 建待建链接。
    """

    def __init__(self, note_service, src_note_id, parent=None):
        super().__init__("添加引用链接", parent=parent, dialog_type=DialogType.INPUT,
                         icon_name="link.link", width=500, height=430)
        self.svc = note_service
        self.src_id = src_note_id
        self._choice = None

        self.search = QLineEdit()
        self.search.setPlaceholderText(
            "搜索已有笔记标题；输入不存在的标题回车即可建「待建」链接")
        self.search.textChanged.connect(self._reload)
        self.search.returnPressed.connect(self._commit)
        self.body_layout.addWidget(self.search, 0)

        self.list = QListWidget()
        self.list.setMinimumHeight(150)
        self.list.itemClicked.connect(lambda _it: self._sync())
        self.list.itemDoubleClicked.connect(lambda _it: self._commit())
        self.body_layout.addWidget(self.list, 1)

        self.hint = QLabel("")
        self.hint.setWordWrap(True)
        self.body_layout.addWidget(self.hint, 0)

        row = QHBoxLayout()
        row.addStretch(1)
        self.cancel_btn = UButton("取消", tone="default", kind="ghost")
        self.cancel_btn.clicked.connect(self.reject)
        self.ok_btn = UButton("添加引用", tone="accent", kind="solid")
        self.ok_btn.clicked.connect(self._commit)
        row.addWidget(self.cancel_btn)
        row.addWidget(self.ok_btn)
        self.body_layout.addLayout(row, 0)

        self._reload()
        self.search.setFocus()

    # ---------- 查询 ----------
    def _candidates(self) -> list:
        q = self.search.text().strip()
        try:
            notes = self.svc.list(q=q) or []
        except Exception:  # noqa: BLE001
            notes = []
        out = []
        for n in notes:
            if getattr(n, "id", None) == self.src_id or getattr(n, "deleted_at", None):
                continue
            out.append((int(n.id), n.title or ""))
        return out

    def _exact_id(self, q: str):
        try:
            nid = self.svc.resolve(q)
        except Exception:  # noqa: BLE001
            return None
        return nid if (nid and nid != self.src_id) else None

    def _reload(self):
        self.list.clear()
        q = self.search.text().strip()
        for nid, title in self._candidates():
            item = QListWidgetItem(title)
            item.setData(Qt.UserRole, ("note", nid, title))
            self.list.addItem(item)
        self._sync()

    def _sync(self):
        q = self.search.text().strip()
        item = self.list.currentItem()
        exact = None if item else self._exact_id(q)
        if item is not None:
            self.ok_btn.setText("添加引用")
            self.ok_btn.setEnabled(True)
            self.hint.setText("回车 / 双击确认添加所选笔记的引用")
        elif exact:
            self.ok_btn.setText("添加引用")
            self.ok_btn.setEnabled(True)
            self.hint.setText("回车将引用同名笔记")
        elif q and self.list.count() == 0:
            self.ok_btn.setText("建「待建」链接")
            self.ok_btn.setEnabled(True)
            self.hint.setText(f"没有同名笔记：确认后建立指向「{q}」的待建链接（不会新建笔记）")
        else:
            self.ok_btn.setText("添加引用")
            self.ok_btn.setEnabled(False)
            if q:
                self.hint.setText(
                    f"匹配 {self.list.count()} 条：先从列表点选，或输入完整标题回车精确引用")
            else:
                self.hint.setText("输入标题过滤已有笔记；输入不存在的标题可建「待建」链接")

    def _commit(self):
        q = self.search.text().strip()
        item = self.list.currentItem()
        exact = None if item else self._exact_id(q)
        if item is not None:
            self._choice = item.data(Qt.UserRole)          # ("note", nid, title)
        elif exact:
            self._choice = ("note", exact, q)
        elif q and self.list.count() == 0:
            self._choice = ("dangle", None, q)             # 待建悬空
        else:
            return
        self.accept()

    def choice(self):
        return self._choice


class _AttachOwnershipDialog(UDialog):
    """「+ 归属」目标选择：任务（task→note 关联）或文件夹（移动 note.folder_id）。

    文件夹页首行提供「移出 → 全部笔记」（folder_id=None）。
    """

    def __init__(self, note_service, note_id, parent=None):
        super().__init__("把笔记归属到…", parent=parent, dialog_type=DialogType.INPUT,
                         icon_name="folder.plus", width=500, height=440)
        self.svc = note_service
        self.note_id = note_id
        self._choice = None

        self.search = QLineEdit()
        self.search.setPlaceholderText("输入关键词过滤（回车确认当前选中/唯一项）")
        self.search.textChanged.connect(self._reload)
        self.search.returnPressed.connect(self._commit)
        self.body_layout.addWidget(self.search, 0)

        self.tabs = QTabWidget()
        self.tabs.setDocumentMode(True)
        self.task_list = QListWidget()
        self.task_list.setMinimumHeight(150)
        self.folder_list = QListWidget()
        self.folder_list.setMinimumHeight(150)
        self.tabs.addTab(self.task_list, "任务（关联）")
        self.tabs.addTab(self.folder_list, "文件夹（移动）")
        self.tabs.currentChanged.connect(lambda _i: self._reload())
        for lst in (self.task_list, self.folder_list):
            lst.itemClicked.connect(lambda _it: self._sync())
            lst.itemDoubleClicked.connect(lambda _it: self._commit())
        self.body_layout.addWidget(self.tabs, 1)

        self.hint = QLabel("")
        self.hint.setWordWrap(True)
        self.body_layout.addWidget(self.hint, 0)

        row = QHBoxLayout()
        row.addStretch(1)
        self.cancel_btn = UButton("取消", tone="default", kind="ghost")
        self.cancel_btn.clicked.connect(self.reject)
        self.ok_btn = UButton("归属到所选", tone="accent", kind="solid")
        self.ok_btn.clicked.connect(self._commit)
        row.addWidget(self.cancel_btn)
        row.addWidget(self.ok_btn)
        self.body_layout.addLayout(row, 0)

        self._reload()
        self.search.setFocus()

    def _active_list(self) -> QListWidget:
        return self.task_list if self.tabs.currentIndex() == 0 else self.folder_list

    def _load_tasks(self, q: str):
        self.task_list.clear()
        try:
            cands = self.svc.task_candidates(q) if hasattr(self.svc, "task_candidates") else []
        except Exception:  # noqa: BLE001
            cands = []
        for t in cands:
            if getattr(t, "id", None) is None:
                continue
            item = QListWidgetItem(t.title or "（无标题任务）")
            item.setData(Qt.UserRole, ("task", int(t.id), t.title or ""))
            self.task_list.addItem(item)
        if self.task_list.count() == 0:
            empty = QListWidgetItem("（没有匹配的未完成任务）")
            empty.setFlags(empty.flags() & ~Qt.ItemIsEnabled)
            self.task_list.addItem(empty)

    def _load_folders(self, q: str):
        self.folder_list.clear()
        try:
            folders = self.svc.folder_titles() or []
        except Exception:  # noqa: BLE001
            folders = []
        by_id = {f.id: f for f in folders}
        memo = {}

        def depth(fid):
            if fid in memo:
                return memo[fid]
            f = by_id.get(fid)
            d = 0 if (f is None or f.parent_id is None) else 1 + depth(f.parent_id)
            memo[fid] = d
            return d

        def add_item(label, payload):
            if q and q.lower() not in (label or "").lower():
                return
            item = QListWidgetItem(label)
            item.setData(Qt.UserRole, payload)
            self.folder_list.addItem(item)

        if not q:
            add_item("（移出文件夹 → 全部笔记）", ("folder", None, "全部笔记"))
        for f in folders:
            label = "　" * depth(f.id) + (f.name or "文件夹")
            add_item(label, ("folder", f.id, f.name or ""))
        if self.folder_list.count() == 0:
            empty = QListWidgetItem("（没有匹配的文件夹）")
            empty.setFlags(empty.flags() & ~Qt.ItemIsEnabled)
            self.folder_list.addItem(empty)

    def _reload(self):
        q = self.search.text().strip()
        if self.tabs.currentIndex() == 0:
            self._load_tasks(q)
        else:
            self._load_folders(q)
        self._sync()

    def _sync(self):
        lst = self._active_list()
        item = lst.currentItem()
        if item is not None and item.data(Qt.UserRole):
            self.ok_btn.setEnabled(True)
            self.ok_btn.setText("归属到所选")
            self.hint.setText("回车 / 双击确认归属")
        else:
            self.ok_btn.setEnabled(False)
            self.ok_btn.setText("归属")
            self.hint.setText("先点选一项，再确认（文件夹可选「移出 → 全部笔记」）")

    def _commit(self):
        lst = self._active_list()
        item = lst.currentItem()
        if item is None:
            rows = [lst.item(i) for i in range(lst.count())
                    if lst.item(i).data(Qt.UserRole)]
            item = rows[0] if len(rows) == 1 else None
        if item is None or not item.data(Qt.UserRole):
            return
        self._choice = item.data(Qt.UserRole)   # ("task", id, 标题) / ("folder", id|None, 名)
        self.accept()

    def choice(self):
        return self._choice
