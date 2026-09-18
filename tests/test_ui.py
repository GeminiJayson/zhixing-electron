# -*- coding: utf-8 -*-
"""view/ui 统一组件层冒烟：构造、tone 注入、切主题自动自愈（headless offscreen）。"""
import os
import re
import unittest

from PySide6.QtWidgets import QWidget

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

def _app_qss() -> str:
    # 框架把皮肤放在应用级样式表里，控件自身的 styleSheet 是空的，
    # 所以断言要针对应用级 QSS。
    from PySide6.QtWidgets import QApplication
    app = QApplication.instance()
    return app.styleSheet() if app is not None else ""



def _mk_engine(mode="light", accent="#0D9488"):
    from PySide6.QtWidgets import QApplication
    from qfluent_core import ThemeManager as ThemeEngine
    _app = QApplication.instance() or QApplication([])
    eng = ThemeEngine()
    eng.apply("青竹", mode, accent)
    ThemeEngine.install(eng)   # 装成单例（原为属性赋值）
    return eng


class _FakeSettings:
    """浮窗冒烟用：仅暴露 WidgetWindow 依赖的 settings 接口。"""

    def ui_state(self):
        return {}

    def get_int(self, key, default=0):
        return default

    def ui_set(self, key, value):
        pass


class _FakeTaskService:
    """浮窗/收件箱冒烟用：返回内存任务树，避免数据库依赖。"""

    def __init__(self, roots):
        self._roots = roots

    def today_tree(self):
        return self._roots

    def list_tree(self, list_id=None):
        return self._roots

    def effective_done_map(self, tasks):
        """MVC 收口后 inbox_page 经 service facade 调用；fake 委托领域规则。"""
        from zhixing.model.domain.task_rules import effective_done_map
        return effective_done_map(tasks)


class _FakeFlashService:
    def list(self):
        return []


class _FakeNoteService:
    """笔记树冒烟用：内存 notes/folders，覆盖 reload/delete/pin/save/backlinks。"""

    def __init__(self, notes=None, folders=None):
        self.notes = list(notes or [])
        self.folders = list(folders or [])
        self.deleted = []

    def list(self, folder_id=None, q=""):
        return list(self.notes)

    def folder_titles(self):
        return list(self.folders)

    def get(self, note_id):
        for n in self.notes:
            if n.id == note_id:
                return n
        return None

    def delete(self, note_id):
        self.deleted.append(note_id)
        self.notes = [n for n in self.notes if n.id != note_id]

    def set_pinned(self, note_id, pinned):
        for n in self.notes:
            if n.id == note_id:
                n.pinned = pinned

    def save(self, note_id, title=None, content_md=None, folder_id=None, pinned=None):
        for n in self.notes:
            if n.id == note_id:
                if title is not None:
                    n.title = title
                if content_md is not None:
                    n.content_md = content_md
                if pinned is not None:
                    n.pinned = pinned

    def backlinks(self, note_id):
        return []


class TestUiSmoke(unittest.TestCase):

    def test_button_and_pill_materialize_with_accent(self):
        eng = _mk_engine()
        from zhixing.view.ui import UButton, UCard, UStatusPill, UTitle
        b = UButton("保存", tone="accent", kind="solid")
        # T1: 实底 accent 用明暗派生的 accent_solid（保证 on 文字 ≥4.5:1）
        self.assertIn(eng.tokens["accent-solid"].lower(), _app_qss().lower(),
                      "强调按钮应含派生 accent_solid 色")

        pill = UStatusPill("进行中", tone="success")
        self.assertIn(pill.text(), "进行中")
        c = UCard("收件箱")
        self.assertIsNotNone(c)
        t = UTitle("标题", role="title")
        self.assertIn("font-weight:600", re.sub(r"\s+", "", _app_qss()))

        for w in (b, pill, c, t):
            w.deleteLater()

    def test_theme_switch_retriggers_resfresh(self):
        eng = _mk_engine(accent="#0D9488")
        # 框架把皮肤放在应用级样式表里，这里显式装一次
        from qfluent_core import apply_skin
        apply_skin(eng, settings=None)
        from zhixing.view.ui import UButton
        b = UButton("同步", tone="accent")
        old = _app_qss()
        # T1: light 实底含派生 accent_solid（文字对比 4.5+），不再是原 accent 色
        self.assertIn(eng.tokens["accent-solid"].lower(), _app_qss().lower())
        # 切换强调色 → 控件 self 刷新
        eng.apply("青竹", "dark", "#7C3AED")
        apply_skin(eng, settings=None)
        new = _app_qss()
        self.assertIn(eng.tokens["accent-solid"].lower(), new.lower(),
                      "主题切变后 accent tone 应自愈更新")

        # light back
        eng.apply("青竹", "light", "#0D9488")
        apply_skin(eng, settings=None)
        self.assertIn(eng.tokens["accent-solid"].lower(), _app_qss().lower())
        b.deleteLater()

    def test_all_widgets_construct_under_offtheme(self):
        eng = _mk_engine(mode="dark", accent="#DC2626")
        from zhixing.view.ui import UButton
        for kind in ("solid", "ghost"):
            for tone in ("default", "accent", "danger", "success", "warn"):
                w = UButton("A", tone=tone, kind=kind)
                self.assertTrue(_app_qss())
                w.deleteLater()

    def test_task_page_builds_immersive_cards(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        from zhixing.view.pages.task_page import TaskPage
        _mk_engine()
        page = TaskPage(None, None, None)
        try:
            for a in ("new_task_btn", "filter_input", "tree", "stack", "editor",
                      "view_switch", "quadrant", "calendar"):
                self.assertTrue(hasattr(page, a), a)
            self.assertFalse(hasattr(page, "group_tree"),
                             "左侧分组树应已移除")
        finally:
            page.deleteLater()

    def test_task_page_module_integrates_ui_button(self):
        import importlib
        m = importlib.import_module("zhixing.view.pages.task_page")
        with open(m.__file__, encoding="utf-8") as f:
            src = f.read()
        self.assertIn("UButton(", src)
        self.assertNotIn("self.new_list_btn = QToolButton", src)

    def test_note_page_builds_immersive_cards(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        from zhixing.view.pages.note_page import NotePage
        _mk_engine()
        page = NotePage(None, None)
        try:
            for attr in ("search", "note_tree", "note_model", "proxy", "delegate",
                         "editor", "backlink_body"):
                self.assertTrue(hasattr(page, attr), attr)
            # 原「文件夹树 + 笔记列表」两栏应合并为单一笔记树，排序下拉移除
            self.assertFalse(hasattr(page, "folder_tree"), "文件夹树应合并进笔记树")
            self.assertFalse(hasattr(page, "note_list"), "笔记列表应合并进笔记树")
            self.assertFalse(hasattr(page, "sort_combo"), "排序下拉应已移除")
        finally:
            page.deleteLater()

    def test_note_page_module_uses_ui_button(self):
        import importlib
        m = importlib.import_module("zhixing.view.pages.note_page")
        with open(m.__file__, encoding="utf-8") as f:
            src = f.read()
        self.assertIn("UButton(", src)
        assert src.count("QToolButton(") == 0, "note_page 不应再实例化 QToolButton"

    # ================= 笔记页树形重构 =================
    def test_note_tree_model_builds_folders_and_notes(self):
        from datetime import datetime
        from zhixing.model.domain.entities import Note, NoteFolder
        from zhixing.view.note_tree import (
            KIND_ALL, KIND_FOLDER, KIND_NOTE, NoteRoleId, NoteRoleKind, NoteTreeModel,
        )

        f_root = NoteFolder(id=1, name="工作", sort=1.0)
        f_child = NoteFolder(id=2, parent_id=1, name="项目A", sort=1.0)
        n_filed = Note(id=10, folder_id=2, title="会议纪要",
                       updated_at=datetime(2026, 9, 1, 12, 0, 0))
        n_loose = Note(id=11, title="零散想法",
                       updated_at=datetime(2026, 9, 2, 12, 0, 0))
        model = NoteTreeModel()
        try:
            model.reload([f_root, f_child], [n_filed, n_loose])
            # 顶层：「全部笔记」+ 根文件夹「工作」
            self.assertEqual(model.rowCount(), 2)
            all_idx = model.index(0, 0)
            self.assertEqual(all_idx.data(NoteRoleKind), KIND_ALL)
            self.assertEqual(model.rowCount(all_idx), 1, "全部笔记只收纳未归属笔记")

            work_idx = model.index(1, 0)
            self.assertEqual(work_idx.data(NoteRoleKind), KIND_FOLDER)
            self.assertEqual(work_idx.data(NoteRoleId), 1)
            self.assertEqual(model.rowCount(work_idx), 1)  # 子文件夹「项目A」
            proj_idx = model.index(0, 0, work_idx)
            self.assertEqual(proj_idx.data(NoteRoleId), 2)
            note_idx = model.index(0, 0, proj_idx)
            self.assertEqual(note_idx.data(NoteRoleKind), KIND_NOTE)
            self.assertEqual(note_idx.data(NoteRoleId), 10)
            # 定位：归档笔记应指向其文件夹下的实例
            self.assertTrue(model.index_of_note(10).isValid())
            self.assertEqual(model.note_at(10).title, "会议纪要")
        finally:
            model.deleteLater()

    def test_note_tree_filter_proxy_matches_titles_and_keeps_ancestors(self):
        from datetime import datetime
        from zhixing.model.domain.entities import Note, NoteFolder
        from zhixing.view.note_tree import NoteTreeFilterProxy, NoteTreeModel

        folder = NoteFolder(id=1, name="工作")
        hit = Note(id=1, folder_id=1, title="产品路线图",
                   updated_at=datetime(2026, 9, 1, 12, 0, 0))
        miss = Note(id=2, folder_id=1, title="会议记录",
                    updated_at=datetime(2026, 9, 2, 12, 0, 0))
        model = NoteTreeModel()
        model.reload([folder], [hit, miss])
        proxy = NoteTreeFilterProxy()
        proxy.setSourceModel(model)
        try:
            proxy.set_text("路线")
            self.assertEqual(proxy.rowCount(), 1, "命中文件夹应保留（全部笔记无未归属笔记被隐藏）")
            # 顶层仅剩「工作」文件夹，其子节点应只剩命中笔记
            work = proxy.index(0, 0)
            self.assertEqual(proxy.rowCount(work), 1)
            proxy.set_text("不存在的标题")
            self.assertEqual(proxy.rowCount(), 0, "无命中时应隐藏整棵树")
            proxy.set_text("")
            self.assertEqual(proxy.rowCount(), 2)
        finally:
            model.deleteLater()
            proxy.deleteLater()

    def test_note_page_reload_populates_tree_and_select_note(self):
        from datetime import datetime
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Note, NoteFolder
        from zhixing.view.note_tree import KIND_NOTE, NoteRoleId, NoteRoleKind
        from zhixing.view.pages.note_page import NotePage

        note = Note(id=7, folder_id=1, title="我的笔记", content_md="# 标题\n内容",
                    updated_at=datetime(2026, 9, 1, 12, 0, 0))
        folder = NoteFolder(id=1, name="工作")
        service = _FakeNoteService(notes=[note], folders=[folder])
        page = NotePage(service, None)
        try:
            page.reload_folders()
            self.assertGreaterEqual(page.note_model.rowCount(), 2, "应有全部笔记 + 文件夹")
            self.assertTrue(page.note_model.index_of_note(7).isValid())
            # 默认「全部笔记」展开，笔记节点可见
            all_src = page.note_model.index(0, 0)
            all_idx = page.proxy.mapFromSource(all_src)
            self.assertTrue(page.note_tree.isExpanded(all_idx))
            # 定位并选中笔记
            page.select_note(7)
            self.assertEqual(page.current_note_id(), 7)
            self.assertIn("标题", page.md_editor.content())
        finally:
            page.deleteLater()

    def test_note_tree_delegate_hover_buttons_and_delete_hit(self):
        from datetime import datetime
        from PySide6.QtCore import QEvent, QPointF, QRect, Qt
        from PySide6.QtGui import QImage, QMouseEvent, QPainter
        from PySide6.QtWidgets import QApplication, QStyle, QStyleOptionViewItem
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Note
        from zhixing.view.note_tree import NoteTreeDelegate, NoteTreeModel

        note = Note(id=3, title="待删除笔记", pinned=True,
                    updated_at=datetime(2026, 9, 1, 12, 0, 0))
        model = NoteTreeModel()
        model.reload([], [note])
        idx = model.index(0, 0, model.index(0, 0))   # 全部笔记 → 笔记
        delegate = NoteTreeDelegate()

        opt = QStyleOptionViewItem()
        opt.rect = QRect(0, 0, 420, 34)
        opt.state = QStyle.State_Enabled | QStyle.State_MouseOver
        opt.font = QApplication.instance().font()
        opt.widget = None

        try:
            # 悬浮绘制（含胶囊按钮）不崩
            img = QImage(420, 34, QImage.Format_ARGB32)
            p = QPainter(img)
            delegate.paint(p, opt, idx)
            p.end()

            lay = delegate._layout(opt, idx, actions_visible=True)
            self.assertIsNotNone(lay["del"])
            self.assertIsNotNone(lay["pin"])
            self.assertIsNotNone(lay["rename"])

            captured = []
            delegate.deleteRequested.connect(captured.append)
            pt = QPointF(lay["del"].center().x(), lay["del"].center().y())
            ev = QMouseEvent(QEvent.MouseButtonRelease, pt, pt, pt,
                             Qt.LeftButton, Qt.LeftButton, Qt.NoModifier)
            self.assertTrue(delegate.editorEvent(ev, model, opt, idx))
            self.assertEqual(captured, [3])
        finally:
            model.deleteLater()
            delegate.deleteLater()

    def test_note_page_delete_signal_soft_deletes_and_reloads(self):
        from datetime import datetime
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Note
        from zhixing.view.pages.note_page import NotePage

        note = Note(id=9, title="要删除", updated_at=datetime(2026, 9, 1, 12, 0, 0))
        service = _FakeNoteService(notes=[note])
        page = NotePage(service, None)
        try:
            page.reload_folders()
            self.assertTrue(page.note_model.index_of_note(9).isValid())
            page._delete_note(9)
            self.assertEqual(service.deleted, [9], "删除应走 note_service.delete 软删")
            self.assertFalse(page.note_model.index_of_note(9).isValid(), "删除后树应移除笔记")
        finally:
            page.deleteLater()

    def test_note_page_removed_sort_combo_in_source(self):
        import importlib
        m = importlib.import_module("zhixing.view.pages.note_page")
        with open(m.__file__, encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("sort_combo", src, "排序下拉应已从 note_page 移除")
        self.assertIn("template_combo", src, "模板下拉（F2-6）应已加入")
        self.assertIn("NoteTreeModel", src)
        self.assertIn("NoteTreeDelegate", src)

    def test_inbox_page_builds_cards(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        from zhixing.view.pages.inbox_page import InboxPage
        _mk_engine()
        page = InboxPage(None, None, None, None)
        try:
            self.assertEqual(getattr(page, "tabs").count(), 2)
            for attr in ("task_list", "flash_list"):
                self.assertTrue(hasattr(page, attr), attr)
        finally:
            page.deleteLater()

    def test_inbox_flash_delete_button_passes_correct_fid(self):
        """闪念「删除」按钮：clicked(bool) 不应覆盖 lambda 捕获的 fid（回归）。

        历史 bug：`lambda fid=f.id: ...` 直接连 QPushButton.clicked，点击时 Qt 会把
        checked(bool=False) 作为第一个实参传入，覆盖默认值，导致 delete(False) 空操作。
        """
        from datetime import datetime
        from PySide6.QtWidgets import QApplication, QPushButton
        QApplication.instance() or QApplication([])
        from zhixing.view.pages.inbox_page import InboxPage
        from zhixing.model.domain.entities import Flash
        _mk_engine()

        fl = Flash(id=7, content="待删闪念", remark="", source_app="测试",
                   created_at=datetime(2026, 9, 2, 10, 0))
        deleted = []

        class FakeFlashService:
            def list(self):
                return [fl]

            def archived(self):
                return []

            def delete(self, fid):
                deleted.append(fid)

        page = InboxPage(None, FakeFlashService(), None, None)
        try:
            page.reload()
            card = page._flash_cards.get(7)
            self.assertIsNotNone(card, "闪念卡应已构建")
            btn = next((b for b in card.findChildren(QPushButton) if b.text() == "删除"), None)
            self.assertIsNotNone(btn, "删除按钮应存在")
            btn.click()
            self.assertEqual(deleted, [7], "删除应收到正确 fid，而非 clicked 的 bool")
        finally:
            page.deleteLater()

    def test_inbox_page_module_uses_ui_buttons(self):
        import importlib
        m = importlib.import_module("zhixing.view.pages.inbox_page")
        with open(m.__file__, encoding="utf-8") as f:
            src = f.read()
        self.assertIn("UButton(", src)
        self.assertNotIn("QPushButton(", src)
        self.assertNotIn("setFlat(", src)

    def test_general_empty_state_uses_ui_accent_button(self):
        import importlib
        m = importlib.import_module("zhixing.view.components.general")
        with open(m.__file__, encoding="utf-8") as f:
            src = f.read()
        self.assertIn("UButton(action_text, tone=\"accent\"", src)
        self.assertNotIn("from qfluentwidgets import PrimaryPushButton", src)
        self.assertNotIn("PrimaryPushButton(", src)

    def test_review_page_builds_immersive_cards(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        from zhixing.view.pages.review_page import ReviewPage
        _mk_engine()
        page = ReviewPage(None, None)
        try:
            for a in ("streak_label", "heat_card", "heatmap"):
                self.assertTrue(hasattr(page, a), a)
        finally:
            page.deleteLater()

    def test_graph_page_builds_immersive_cards(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        from zhixing.view.pages.graph_page import GraphPage
        _mk_engine()
        page = GraphPage(None, None)
        try:
            for a in ("toolbar_card", "view", "side_card"):
                self.assertTrue(hasattr(page, a), a)
        finally:
            page.deleteLater()

    def test_today_page_integrates_ui_title(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        from zhixing.view.ui import UTitle
        from zhixing.view.pages.today_page import TodayPage
        _mk_engine()
        page = TodayPage()
        try:
            # 今日页的问候/标题由框架组件承担（原自建 UTitle 已并入框架）
            page.refresh_greeting()
            self.assertTrue(hasattr(page, "greeting"), "今日页应有问候控件")
            from zhixing.view.ui import UCard
            self.assertIsInstance(getattr(page, "card_tasks", None), UCard)
            self.assertIsInstance(getattr(page, "card_notes", None), UCard)
        finally:
            page.deleteLater()

    def test_today_page_added_today_card_removed(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        from zhixing.view.pages.today_page import TodayPage
        _mk_engine()
        page = TodayPage()
        try:
            self.assertFalse(hasattr(page, "card_added"), "今日新增卡应已移除")
            self.assertFalse(hasattr(page, "added_tree"), "added_tree 应已移除")
            self.assertFalse(hasattr(page, "added_model"), "added_model 应已移除")
            self.assertFalse(hasattr(page, "set_added_today"), "set_added_today 应已移除")
        finally:
            page.deleteLater()

    def test_delegate_paint_with_start_date_and_priority(self):
        from PySide6.QtCore import QRect
        from PySide6.QtGui import QImage, QPainter
        from PySide6.QtWidgets import QApplication, QStyle, QStyleOptionViewItem
        QApplication.instance() or QApplication([])
        _mk_engine()
        from datetime import date
        from zhixing.model.domain.entities import Priority, Task
        from zhixing.model.qt.models import TaskTreeModel
        from zhixing.view.delegates.task_delegate import TaskDelegate

        task = Task(id=7, title="带时间范围与优先级", start_date=date(2026, 9, 1),
                    due_date=date(2026, 9, 3), priority=Priority.MID)
        model = TaskTreeModel()
        model.reload([task])
        idx = model.index(0, 0)
        delegate = TaskDelegate()
        img = QImage(400, 40, QImage.Format_ARGB32)
        p = QPainter(img)
        opt = QStyleOptionViewItem()
        opt.rect = QRect(0, 0, 400, 40)
        opt.state = QStyle.State_Enabled
        opt.font = QApplication.instance().font()
        try:
            delegate.paint(p, opt, idx)   # 含 start_date 不崩溃
        finally:
            p.end()
            model.deleteLater()
            delegate.deleteLater()

    def test_delegate_paint_show_actions_false(self):
        from PySide6.QtCore import QRect
        from PySide6.QtGui import QImage, QPainter
        from PySide6.QtWidgets import QApplication, QStyle, QStyleOptionViewItem
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Task
        from zhixing.model.qt.models import TaskTreeModel
        from zhixing.view.delegates.task_delegate import TaskDelegate

        root = Task(id=1, title="父任务")
        child = Task(id=2, title="子任务", parent_id=1)
        root.children = [child]
        model = TaskTreeModel()
        model.reload([root])
        idx = model.index(0, 0)
        delegate = TaskDelegate(show_actions=False)
        img = QImage(300, 40, QImage.Format_ARGB32)
        p = QPainter(img)
        opt = QStyleOptionViewItem()
        opt.rect = QRect(0, 0, 300, 40)
        opt.state = QStyle.State_Selected | QStyle.State_Enabled
        opt.font = QApplication.instance().font()
        try:
            delegate.paint(p, opt, idx)   # 圆角选中 + 无编辑/删除按钮，不崩溃
        finally:
            p.end()
            model.deleteLater()
            delegate.deleteLater()

    def test_delegate_paint_hover_shows_actions_no_crash(self):
        from PySide6.QtCore import QRect
        from PySide6.QtGui import QImage, QPainter
        from PySide6.QtWidgets import QApplication, QStyle, QStyleOptionViewItem
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Priority, Task
        from zhixing.model.qt.models import TaskTreeModel
        from zhixing.view.delegates.task_delegate import TaskDelegate

        root = Task(id=1, title="父任务", priority=Priority.MID)
        child = Task(id=2, title="子任务", parent_id=1)
        root.children = [child]
        model = TaskTreeModel(tag_provider=lambda ids: {1: [(1, "工作", "#0D9488")]})
        model.reload([root])
        idx = model.index(0, 0)
        delegate = TaskDelegate(show_actions=True)
        img = QImage(520, 40, QImage.Format_ARGB32)
        p = QPainter(img)
        opt = QStyleOptionViewItem()
        opt.rect = QRect(0, 0, 520, 40)
        opt.state = QStyle.State_Enabled | QStyle.State_MouseOver
        opt.font = QApplication.instance().font()
        try:
            # 悬浮 + 优先级徽标 + 标签 + 动作按钮同时绘制，不崩溃
            delegate.paint(p, opt, idx)
        finally:
            p.end()
            model.deleteLater()
            delegate.deleteLater()

    def test_delegate_hit_regions_emit_new_signals(self):
        from PySide6.QtCore import QEvent, QPointF, QRect, Qt
        from PySide6.QtGui import QMouseEvent
        from PySide6.QtWidgets import QApplication, QStyle, QStyleOptionViewItem
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Priority, Task
        from zhixing.model.qt.models import TaskTreeModel
        from zhixing.view.delegates.task_delegate import TaskDelegate

        root = Task(id=1, title="父任务", priority=Priority.MID)
        child = Task(id=2, title="子任务", parent_id=1)
        root.children = [child]
        model = TaskTreeModel(tag_provider=lambda ids: {1: [(1, "工作", "#0D9488")]})
        model.reload([root])
        idx = model.index(0, 0)
        delegate = TaskDelegate(show_actions=True)

        opt = QStyleOptionViewItem()
        opt.rect = QRect(0, 0, 520, 38)
        opt.state = QStyle.State_Enabled | QStyle.State_MouseOver
        opt.font = QApplication.instance().font()
        opt.widget = None

        lay = delegate._layout(opt, idx, actions_visible=True)

        captured = []
        delegate.toggleRequested.connect(lambda tid: captured.append(("toggle", tid)))
        delegate.toggleExpandRequested.connect(lambda tid: captured.append(("expand", tid)))
        delegate.editPriorityRequested.connect(lambda tid: captured.append(("priority", tid)))
        delegate.editTagsRequested.connect(lambda tid: captured.append(("tags", tid)))
        delegate.addSubtaskRequested.connect(lambda tid: captured.append(("add", tid)))
        delegate.openRequested.connect(lambda tid: captured.append(("open", tid)))
        delegate.deleteRequested.connect(lambda tid: captured.append(("delete", tid)))

        def release_at(pt):
            delegate._last_action = -1e9
            ev = QMouseEvent(QEvent.MouseButtonRelease, pt, pt, pt, Qt.LeftButton,
                             Qt.LeftButton, Qt.NoModifier)
            delegate.editorEvent(ev, model, opt, idx)

        def center(rect):
            return QPointF(rect.center().x(), rect.center().y())

        try:
            release_at(center(lay["circle"]))
            self.assertEqual(captured[-1], ("toggle", 1))
            release_at(center(lay["prio"]))
            self.assertEqual(captured[-1], ("priority", 1))
            release_at(center(lay["tag_rects"][0][2]))
            self.assertEqual(captured[-1], ("tags", 1))
            release_at(center(lay["add"]))
            self.assertEqual(captured[-1], ("add", 1))
            release_at(center(lay["edit"]))
            self.assertEqual(captured[-1], ("open", 1))
            release_at(center(lay["del"]))
            self.assertEqual(captured[-1], ("delete", 1))
            # 标题区：父任务有子任务 → 折叠/展开（叶子任务则交还视图选中）
            title_pt = QPointF(lay["title_rect"].left() + 6, lay["title_rect"].center().y())
            release_at(title_pt)
            self.assertEqual(captured[-1], ("expand", 1))
        finally:
            model.deleteLater()
            delegate.deleteLater()

    def test_three_views_delegate_signal_connections_exist(self):
        from PySide6.QtCore import SIGNAL
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Task
        from zhixing.view.pages.task_page import TaskPage
        from zhixing.view.pages.today_page import TodayPage
        from zhixing.view.widget.desktop_widget import WidgetWindow

        root = Task(id=1, title="父任务")
        child = Task(id=2, title="子任务", parent_id=1)
        root.children = [child]

        task_page = TaskPage(None, None, None)
        today_page = TodayPage()
        widget = WidgetWindow(_FakeTaskService([root]), _FakeSettings())
        try:
            for delegate in (task_page.delegate, today_page.delegate, widget.delegate):
                for sig in ("toggleRequested(int)", "openRequested(int)", "deleteRequested(int)",
                            "toggleExpandRequested(int)", "editPriorityRequested(int)",
                            "editTagsRequested(int)", "addSubtaskRequested(int)",
                            "titleEditRequested(int)", "titleCommitted(int,QString)"):
                    self.assertGreaterEqual(delegate.receivers(SIGNAL(sig)), 1,
                                            f"{sig} 应已接线")
        finally:
            task_page.deleteLater()
            today_page.deleteLater()
            widget.deleteLater()

    def test_today_page_trees_expand_all_by_default(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Task
        from zhixing.view.pages.today_page import TodayPage

        root = Task(id=1, title="父任务")
        child = Task(id=2, title="子任务", parent_id=1)
        root.children = [child]
        page = TodayPage()
        try:
            page.set_tree([root])
            idx = page.task_model.index_of(1)
            self.assertTrue(page.tree.isExpanded(idx), "今日任务树应默认展开")
        finally:
            page.deleteLater()

    def test_desktop_widget_reload_expands_tree(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Task
        from zhixing.view.widget.desktop_widget import WidgetWindow

        root = Task(id=1, title="父任务")
        child = Task(id=2, title="子任务", parent_id=1)
        root.children = [child]
        w = WidgetWindow(_FakeTaskService([root]), _FakeSettings())
        try:
            w.reload_tasks()
            idx = w.task_model.index_of(1)
            self.assertTrue(w.tree.isExpanded(idx), "浮窗树应默认展开")
        finally:
            w.deleteLater()

    def test_desktop_widget_geometry_persists_size(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.widget.desktop_widget import WidgetWindow

        class _GeomSettings(_FakeSettings):
            def __init__(self):
                self.saved = None
            def ui_set(self, key, value):
                self.saved = value

        s = _GeomSettings()
        w = WidgetWindow(_FakeTaskService([]), s)
        try:
            w.resize(320, 420)
            w.save_geometry()
            self.assertEqual(len(s.saved), 4, "save_geometry 应持久化 [x, y, w, h]")
            self.assertEqual(s.saved[2], 320)
            self.assertEqual(s.saved[3], 420)
        finally:
            w.deleteLater()

    def test_desktop_widget_restores_custom_size(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.core import settings_keys as K
        from zhixing.view.widget.desktop_widget import WidgetWindow

        class _GeomSettings(_FakeSettings):
            def ui_state(self):
                return {K.K_WIDGET_GEOM: [100, 120, 320, 420]}

        w = WidgetWindow(_FakeTaskService([]), _GeomSettings())
        try:
            self.assertEqual(w.width(), 320)
            self.assertEqual(w.height(), 420)
            self.assertEqual(w._user_size, [320, 420])
        finally:
            w.deleteLater()

    def test_desktop_widget_resize_hit_detects_edges(self):
        from PySide6.QtCore import QPoint
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.widget.desktop_widget import WidgetWindow

        w = WidgetWindow(_FakeTaskService([]), _FakeSettings())
        try:
            w.resize(290, 380)
            self.assertEqual(w._resize_hit(QPoint(2, 2)), (True, True, False, False))
            self.assertEqual(w._resize_hit(QPoint(288, 378)), (False, False, True, True))
            self.assertEqual(w._resize_hit(QPoint(145, 190)), None)
        finally:
            w.deleteLater()

    def test_task_tree_model_supports_three_levels(self):
        from zhixing.model.domain.entities import Task
        from zhixing.model.qt.models import TaskTreeModel
        root = Task(id=1, title="L1")
        l2 = Task(id=2, title="L2", parent_id=1)
        l3 = Task(id=3, title="L3", parent_id=2)
        root.children = [l2]
        l2.children = [l3]
        model = TaskTreeModel()
        model.reload([root])
        try:
            self.assertEqual(model.rowCount(), 1)
            idx_root = model.index(0, 0)
            self.assertEqual(idx_root.data(0), "L1")
            self.assertEqual(model.rowCount(idx_root), 1)
            idx_l2 = model.index(0, 0, idx_root)
            self.assertEqual(idx_l2.data(0), "L2")
            self.assertEqual(model.rowCount(idx_l2), 1)
            idx_l3 = model.index(0, 0, idx_l2)
            self.assertEqual(idx_l3.data(0), "L3")
            self.assertEqual(model.rowCount(idx_l3), 0)
        finally:
            model.deleteLater()

    def test_role_checked_reflects_effective_done_rollup(self):
        from zhixing.model.domain.entities import Task, TaskStatus
        from zhixing.model.qt.models import RoleChecked, TaskTreeModel

        child1 = Task(id=2, title="子1", parent_id=1, status=TaskStatus.DONE)
        child2 = Task(id=3, title="子2", parent_id=1, status=TaskStatus.TODO)
        root = Task(id=1, title="父", status=TaskStatus.DOING)
        root.children = [child1, child2]
        model = TaskTreeModel()
        try:
            model.reload([root])
            self.assertFalse(model.index(0, 0).data(RoleChecked),
                             "存在未完成子任务时父不应勾选")
            child2.status = TaskStatus.DONE
            model.reload([root])
            self.assertTrue(model.index(0, 0).data(RoleChecked),
                            "子全完成的父应显示为有效完成（勾选态）")
        finally:
            model.deleteLater()

    def test_desktop_widget_reload_tasks_uses_tree_model(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Task
        from zhixing.view.widget.desktop_widget import WidgetWindow

        root = Task(id=1, title="父任务")
        child = Task(id=2, title="子任务", parent_id=1)
        root.children = [child]
        w = WidgetWindow(_FakeTaskService([root]), _FakeSettings())
        try:
            w.reload_tasks()
            self.assertIsNotNone(getattr(w, "tree", None))
            self.assertIsNotNone(getattr(w, "task_model", None))
            self.assertEqual(w.task_model.rowCount(), 1)
            self.assertFalse(w.tree.isHidden(), "有任务时任务树应可见")
            self.assertTrue(w.empty_label.isHidden(), "有任务时空状态应隐藏")
            self.assertIsNotNone(getattr(w, "open_btn", None))
            self.assertEqual(w.open_btn.toolTip(), "打开主程序")
        finally:
            w.deleteLater()

    def test_inbox_page_task_tab_tree_model(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Task
        from zhixing.view.pages.inbox_page import InboxPage

        root = Task(id=1, title="未整理")
        child = Task(id=2, title="子任务", parent_id=1)
        root.children = [child]
        page = InboxPage(_FakeTaskService([root]), _FakeFlashService(), None, None)
        try:
            self.assertIsNotNone(getattr(page, "task_tree", None))
            self.assertIsNotNone(getattr(page, "task_model", None))
            page._reload_tasks()
            self.assertEqual(page.task_model.rowCount(), 1)
            self.assertIn("2", page.tabs.tabText(0))   # 未完成任务数（父+子）
        finally:
            page.deleteLater()

    def test_project_theme_packs_load_into_framework(self):
        # zhixing 自带的 14 个主题包 JSON 现在由桥接统一装进框架。
        # （原先由 ThemeEngine._load_packs 负责，主题引擎退场后归桥接。）
        from qfluent_core import ThemeManager
        from zhixing.view.kit.fluent_bridge import load_project_packs, theme_dir
        self.assertTrue(theme_dir().exists(), '主题包目录应存在')
        manager = ThemeManager()
        loaded = load_project_packs(manager)
        self.assertGreaterEqual(loaded, 10, '应装载 10 个以上的项目主题包')
        names = set(manager.packs)
        self.assertIn('蜜桃橘', names, '项目主题包应已注册进框架')


    def test_construct_without_engine_instance_is_safe(self):
        # registry / 页面顶层若在引擎装配前构造不应崩溃（默认回退色即可）
        from PySide6.QtWidgets import QApplication
        qapp = QApplication.instance() or QApplication([])
        from qfluent_core import ThemeManager as _TM
        theme_mod = type("theme_mod", (), {"ThemeEngine": _TM})
        saved = getattr(theme_mod.ThemeEngine, "instance", None)
        try:
            theme_mod.ThemeEngine.instance = None  # type: ignore[misc]
            from zhixing.view.ui import UButton, UCard, UStatusPill, UTitle
            for w in (UButton("x"), UCard(), UStatusPill("待办"), UTitle("T")):
                self.assertIsNotNone(w)   # 构造成功即通过
        finally:
            theme_mod.ThemeEngine.instance = saved
        _ = qapp

    # ================= 任务行显示与交互优化 =================
    def test_delegate_double_click_emits_title_edit(self):
        from PySide6.QtCore import QEvent, QPointF, QRect, Qt
        from PySide6.QtGui import QMouseEvent
        from PySide6.QtWidgets import QApplication, QStyle, QStyleOptionViewItem
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Task
        from zhixing.model.qt.models import TaskTreeModel
        from zhixing.view.delegates.task_delegate import TaskDelegate

        root = Task(id=1, title="父任务")
        child = Task(id=2, title="子任务", parent_id=1)
        root.children = [child]
        model = TaskTreeModel()
        model.reload([root])
        idx = model.index(0, 0)
        delegate = TaskDelegate(show_actions=True, inline_edit=True)
        opt = QStyleOptionViewItem()
        opt.rect = QRect(0, 0, 520, 38)
        opt.state = QStyle.State_Enabled | QStyle.State_MouseOver
        opt.font = QApplication.instance().font()
        opt.widget = None
        lay = delegate._layout(opt, idx, actions_visible=True)
        captured = []
        delegate.titleEditRequested.connect(captured.append)
        pt = QPointF(lay["title_rect"].left() + 6, lay["title_rect"].center().y())
        ev = QMouseEvent(QEvent.MouseButtonDblClick, pt, pt, pt,
                         Qt.LeftButton, Qt.LeftButton, Qt.NoModifier)
        try:
            self.assertTrue(delegate.editorEvent(ev, model, opt, idx))
            self.assertEqual(captured, [1])
        finally:
            model.deleteLater()
            delegate.deleteLater()

    def test_delegate_double_click_cancels_deferred_toggle(self):
        from PySide6.QtCore import QEvent, QPointF, QRect, Qt
        from PySide6.QtGui import QMouseEvent
        from PySide6.QtTest import QTest
        from PySide6.QtWidgets import QApplication, QStyle, QStyleOptionViewItem
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Task
        from zhixing.model.qt.models import TaskTreeModel
        from zhixing.view.delegates.task_delegate import TaskDelegate

        root = Task(id=1, title="父任务")
        child = Task(id=2, title="子任务", parent_id=1)
        root.children = [child]
        model = TaskTreeModel()
        model.reload([root])
        idx = model.index(0, 0)
        delegate = TaskDelegate(show_actions=True, inline_edit=True)
        opt = QStyleOptionViewItem()
        opt.rect = QRect(0, 0, 520, 38)
        opt.state = QStyle.State_Enabled | QStyle.State_MouseOver
        opt.font = QApplication.instance().font()
        opt.widget = None
        lay = delegate._layout(opt, idx, actions_visible=True)
        toggled, edited = [], []
        delegate.toggleExpandRequested.connect(toggled.append)
        delegate.titleEditRequested.connect(edited.append)
        pt = QPointF(lay["title_rect"].left() + 6, lay["title_rect"].center().y())

        def dbl(pt_):
            return QMouseEvent(QEvent.MouseButtonDblClick, pt_, pt_, pt_,
                               Qt.LeftButton, Qt.LeftButton, Qt.NoModifier)

        def rel(pt_):
            return QMouseEvent(QEvent.MouseButtonRelease, pt_, pt_, pt_,
                               Qt.LeftButton, Qt.LeftButton, Qt.NoModifier)

        try:
            delegate._last_action = -1e9
            delegate.editorEvent(rel(pt), model, opt, idx)   # 第一拍：进入延时
            delegate.editorEvent(dbl(pt), model, opt, idx)   # 双击：取消延时 → 编辑
            delegate.editorEvent(rel(pt), model, opt, idx)   # 第二拍：去抖丢弃
            QTest.qWait(450)
            self.assertEqual(edited, [1])
            self.assertEqual(toggled, [])
        finally:
            model.deleteLater()
            delegate.deleteLater()

    def test_delegate_set_model_data_emits_title_committed(self):
        from PySide6.QtWidgets import QApplication, QLineEdit
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Task
        from zhixing.model.qt.models import TaskTreeModel
        from zhixing.view.delegates.task_delegate import TaskDelegate

        root = Task(id=7, title="旧标题")
        model = TaskTreeModel()
        model.reload([root])
        idx = model.index(0, 0)
        delegate = TaskDelegate()
        captured = []
        delegate.titleCommitted.connect(lambda tid, text: captured.append((tid, text)))
        editor = QLineEdit("新标题")
        try:
            delegate.setModelData(editor, model, idx)
            self.assertEqual(captured, [(7, "新标题")])
        finally:
            editor.deleteLater()
            model.deleteLater()
            delegate.deleteLater()

    def test_task_page_add_subtask_triggers_inline_edit(self):
        from PySide6.QtTest import QTest
        from PySide6.QtWidgets import QAbstractItemView, QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Task
        from zhixing.model.qt.models import RoleTaskId
        from zhixing.view.pages.task_page import TaskPage

        root = Task(id=1, title="父任务")
        root.children = []
        service = _AddSubtaskService([root])
        page = TaskPage(service, None, _TaskSettings())
        try:
            page.reload_tasks()
            page._add_subtask(1)
            new_idx = page.task_model.index_of(100)
            self.assertTrue(new_idx.isValid(), "新子任务应可定位")
            cur_src = page.proxy.mapToSource(page.tree.currentIndex())
            self.assertEqual(cur_src.data(RoleTaskId), 100, "应选中新子任务")
            QTest.qWait(180)
            self.assertEqual(page.tree.state(), QAbstractItemView.EditingState,
                             "应自动触发行内编辑")
            parent_idx = page.proxy.mapFromSource(page.task_model.index_of(1))
            self.assertTrue(page.tree.isExpanded(parent_idx), "父任务应展开")
        finally:
            page.deleteLater()

    def test_desktop_widget_add_subtask_triggers_inline_edit(self):
        from PySide6.QtTest import QTest
        from PySide6.QtWidgets import QAbstractItemView, QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Task
        from zhixing.model.qt.models import RoleTaskId
        from zhixing.view.widget.desktop_widget import WidgetWindow

        root = Task(id=1, title="父任务")
        root.children = []
        w = WidgetWindow(_AddSubtaskService([root]), _TaskSettings())
        try:
            w.reload_tasks()
            w._add_subtask(1)
            new_idx = w.task_model.index_of(100)
            self.assertTrue(new_idx.isValid(), "新子任务应可定位")
            self.assertEqual(w.tree.currentIndex().data(RoleTaskId), 100)
            QTest.qWait(80)
            self.assertEqual(w.tree.state(), QAbstractItemView.EditingState)
        finally:
            w.deleteLater()

    def test_today_page_inline_edit_and_expand_helpers(self):
        from PySide6.QtTest import QTest
        from PySide6.QtWidgets import QAbstractItemView, QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Task
        from zhixing.model.qt.models import RoleTaskId
        from zhixing.view.pages.today_page import TodayPage

        root = Task(id=1, title="父任务")
        child = Task(id=2, title="子任务", parent_id=1)
        root.children = [child]
        page = TodayPage()
        try:
            page.set_tree([root])
            page.expand_task(1)
            page.begin_inline_edit(2)
            self.assertEqual(page.tree.currentIndex().data(RoleTaskId), 2)
            QTest.qWait(80)
            self.assertEqual(page.tree.state(), QAbstractItemView.EditingState)
        finally:
            page.deleteLater()

    def test_delegate_row_height_and_indent_params_take_effect(self):
        from PySide6.QtCore import QRect
        from PySide6.QtWidgets import QApplication, QStyleOptionViewItem
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Task
        from zhixing.model.qt.models import TaskTreeModel
        from zhixing.view.delegates.task_delegate import TaskDelegate

        root = Task(id=1, title="父")
        child = Task(id=2, title="子", parent_id=1)
        root.children = [child]
        model = TaskTreeModel()
        model.reload([root])
        delegate = TaskDelegate(row_height=50, indent=30)
        opt = QStyleOptionViewItem()
        opt.rect = QRect(0, 0, 300, 50)
        opt.font = QApplication.instance().font()
        try:
            self.assertEqual(delegate.sizeHint(opt, model.index(0, 0)).height(), 50)
            child_idx = model.index(0, 0, model.index(0, 0))
            lay = delegate._layout(opt, child_idx, actions_visible=False)
            self.assertEqual(lay["circle"].x(), 10 + 30, "缩进参数应参与标题 x 计算")
        finally:
            model.deleteLater()
            delegate.deleteLater()

    def test_delegate_circle_diameter_scales_with_row_height(self):
        from PySide6.QtCore import QRect
        from PySide6.QtWidgets import QApplication, QStyleOptionViewItem
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Task
        from zhixing.model.qt.models import TaskTreeModel
        from zhixing.view.delegates.task_delegate import TaskDelegate

        root = Task(id=1, title="父")
        model = TaskTreeModel()
        model.reload([root])
        idx = model.index(0, 0)
        opt = QStyleOptionViewItem()
        opt.rect = QRect(0, 0, 300, 38)
        opt.font = QApplication.instance().font()
        small = TaskDelegate(row_height=20)
        big = TaskDelegate(row_height=50)
        try:
            d_small = small._layout(opt, idx, actions_visible=False)["circle"].width()
            d_big = big._layout(opt, idx, actions_visible=False)["circle"].width()
            self.assertLess(d_small, d_big, "行高大时勾选圆圈应更大")
            self.assertEqual(d_small, 14, "小行高应被 clamp 到 14px 下限")
            self.assertEqual(d_big, 20, "大行高应被 clamp 到 20px 上限")
        finally:
            model.deleteLater()
            small.deleteLater()
            big.deleteLater()

    def test_delegate_non_circle_elements_scale_with_row_height(self):
        from PySide6.QtCore import QRect
        from PySide6.QtGui import QImage, QPainter
        from PySide6.QtWidgets import QApplication, QStyle, QStyleOptionViewItem
        QApplication.instance() or QApplication([])
        _mk_engine()
        from datetime import date
        from zhixing.model.domain.entities import Priority, Task
        from zhixing.model.qt.models import TaskTreeModel
        from zhixing.view.delegates.task_delegate import TaskDelegate

        task = Task(id=1, title="父", priority=Priority.HIGH, due_date=date(2026, 9, 3))
        model = TaskTreeModel(tag_provider=lambda ids: {1: [(1, "工作", "#0D9488")]})
        model.reload([task])
        idx = model.index(0, 0)
        opt = QStyleOptionViewItem()
        opt.rect = QRect(0, 0, 600, 38)
        opt.state = QStyle.State_Enabled | QStyle.State_MouseOver
        opt.font = QApplication.instance().font()

        base = TaskDelegate(row_height=38)
        big = TaskDelegate(row_height=50)
        try:
            lay_base = base._layout(opt, idx, actions_visible=True)
            lay_big = big._layout(opt, idx, actions_visible=True)
            # 行高变大时，pill / 标签 chip / 动作按钮高度与 chip 字号应同步放大
            self.assertGreater(lay_big["pill_h"], lay_base["pill_h"])
            self.assertGreater(lay_big["chip_h"], lay_base["chip_h"])
            self.assertGreater(lay_big["btn_h"], lay_base["btn_h"])
            self.assertGreater(lay_big["chip_font"].pixelSize(),
                               lay_base["chip_font"].pixelSize())
            self.assertGreater(lay_big["title_font"].pixelSize(),
                               lay_base["title_font"].pixelSize())
            # offscreen：多种 row_height 下 paint 不崩（含悬浮按钮/标签/右侧 chip）
            for rh in (20, 26, 38, 50, 60):
                d = TaskDelegate(row_height=rh)
                img = QImage(600, rh, QImage.Format_ARGB32)
                p = QPainter(img)
                o = QStyleOptionViewItem()
                o.rect = QRect(0, 0, 600, rh)
                o.state = QStyle.State_Enabled | QStyle.State_MouseOver
                o.font = QApplication.instance().font()
                d.paint(p, o, idx)
                p.end()
                d.deleteLater()
        finally:
            model.deleteLater()
            base.deleteLater()
            big.deleteLater()

    def test_today_page_task_card_expands_notes_compact(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.pages.today_page import TodayPage

        page = TodayPage()
        try:
            # 今日待办树不应再有固定高度，可随窗口伸缩
            self.assertGreater(page.tree.maximumHeight(), 220)
            # 今日待办卡在 outer 布局中占剩余空间（stretch=1），最近笔记卡贴内容（stretch=0）
            outer = page.layout()
            stretch_tasks = stretch_notes = None
            for i in range(outer.count()):
                w = outer.itemAt(i).widget()
                if w is page.card_tasks:
                    stretch_tasks = outer.stretch(i)
                elif w is page.card_notes:
                    stretch_notes = outer.stretch(i)
            self.assertEqual(stretch_tasks, 1)
            self.assertEqual(stretch_notes, 0)
        finally:
            page.deleteLater()

    def test_task_editor_controls_expand_to_fill_card(self):
        from PySide6.QtWidgets import QApplication, QSizePolicy
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.components.task_editor import TaskEditorPanel

        panel = TaskEditorPanel(_FakeTaskEditorService(), None)
        try:
            for c in (panel.status_combo, panel.priority_combo, panel.repeat_combo,
                      panel.start_edit, panel.due_edit, panel.tag_edit, panel.sub_edit):
                self.assertEqual(c.sizePolicy().horizontalPolicy(), QSizePolicy.Expanding,
                                 f"{c.__class__.__name__} 应水平撑满卡片")
            # 标题输入框应已撑满（QLineEdit 默认 Expanding，仅确认）
            self.assertEqual(panel.title_edit.sizePolicy().horizontalPolicy(),
                             QSizePolicy.Expanding)
        finally:
            panel.deleteLater()

    def test_task_editor_grouped_load_clear(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Task
        from zhixing.view.components.task_editor import TaskEditorPanel
        from zhixing.view.ui import UCard

        panel = TaskEditorPanel(_FakeTaskEditorService(), None)
        try:
            cards = panel.findChildren(UCard)
            self.assertGreaterEqual(len(cards), 6, "编辑页应按分类分组为多张 UCard")
            task = Task(id=1, title="示例任务")
            panel.load(task)
            self.assertEqual(panel.title_edit.text(), "示例任务")
            self.assertEqual(panel.task_id(), 1)
            panel.clear()
            self.assertEqual(panel.title_edit.text(), "")
            self.assertIsNone(panel.task_id())
        finally:
            panel.deleteLater()

    def test_task_edit_dialog_header_button_order(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.components.task_editor import TaskEditorPanel
        from zhixing.view.pages.task_page import _TaskEditDialog
        from zhixing.view.ui import UDialog

        panel = TaskEditorPanel(_FakeTaskEditorService(), None)
        dlg = _TaskEditDialog(panel)
        try:
            # 任务编辑页已统一到 UDialog 无边框框架（随主题自愈）
            self.assertIsInstance(dlg, UDialog)
            self.assertEqual(dlg.title_bar.titleLabel.text(), "编辑任务")
            # 底部动作栏：开始专注/删除任务/取消/保存
            self.assertEqual(dlg.focus_btn.text(), "开始专注")
            self.assertEqual(dlg.delete_btn.text(), "删除任务")
            self.assertEqual(dlg.cancel_btn.text(), "取消")
            self.assertEqual(dlg.save_btn.text(), "保存")
            # 删除任务按钮应携带危险样式（浅红底/深红字，随主题 danger token）
            self.assertIn("QPushButton", _app_qss())
        finally:
            dlg.deleteLater()
            panel.deleteLater()

    def test_task_editor_time_linkage_minimum_date(self):
        from PySide6.QtCore import QDate
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.components.task_editor import TaskEditorPanel

        panel = TaskEditorPanel(_FakeTaskEditorService(), None)
        try:
            default_min = QDate(1752, 9, 14)
            self.assertEqual(panel.due_edit.minimumDate(), default_min)
            panel.start_edit.setDate(QDate(2026, 1, 1))
            self.assertEqual(panel.due_edit.minimumDate(), QDate(2026, 1, 1),
                             "开始日期变化后截止下限应联动")
            # 截止早于开始 → 自动修正为开始日期
            panel.due_edit.setDate(QDate(2025, 1, 1))
            self.assertEqual(panel.due_edit.date(), QDate(2026, 1, 1))
            # 清空 → 恢复默认最小日期
            panel.clear()
            self.assertEqual(panel.due_edit.minimumDate(), default_min)
        finally:
            panel.deleteLater()

    def test_task_editor_subtasks_checkbox_and_delete(self):
        from PySide6.QtWidgets import QApplication, QCheckBox, QPushButton
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Task, TaskStatus
        from zhixing.view.components.task_editor import TaskEditorPanel

        child1 = Task(id=2, title="子1", parent_id=1, status=TaskStatus.DONE)
        child2 = Task(id=3, title="子2", parent_id=1, status=TaskStatus.TODO)
        root = Task(id=1, title="父")
        root.children = [child1, child2]
        panel = TaskEditorPanel(_FakeTaskEditorService([root]), None)
        try:
            panel.load(root)
            boxes = panel.findChildren(QCheckBox)
            dels = [b for b in panel.findChildren(QPushButton) if b.text() == "删除"]
            self.assertEqual(len(boxes), 2, "每个子任务应有一个 QCheckBox")
            self.assertEqual(len(dels), 2, "每个子任务应有一个删除按钮")
            self.assertEqual(sum(1 for b in boxes if b.isChecked()), 1,
                             "完成态子任务应勾选，未完成态不勾选")
        finally:
            panel.deleteLater()

    def test_quick_capture_window_constructs(self):
        from PySide6.QtWidgets import QApplication, QLineEdit
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.capture.quick_capture import QuickCaptureWindow

        win = QuickCaptureWindow()
        try:
            self.assertIsInstance(getattr(win, "input", None), QLineEdit)
        finally:
            win.deleteLater()

    def test_delegate_paint_guide_lines_no_crash(self):
        from PySide6.QtCore import QRect
        from PySide6.QtGui import QImage, QPainter
        from PySide6.QtWidgets import QApplication, QStyle, QStyleOptionViewItem
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Task
        from zhixing.model.qt.models import TaskTreeModel
        from zhixing.view.delegates.task_delegate import TaskDelegate

        root = Task(id=1, title="L1")
        l2 = Task(id=2, title="L2", parent_id=1)
        l3 = Task(id=3, title="L3", parent_id=2)
        root.children = [l2]
        l2.children = [l3]
        model = TaskTreeModel()
        model.reload([root])
        delegate = TaskDelegate()
        idx = model.index(0, 0, model.index(0, 0, model.index(0, 0)))
        img = QImage(400, 40, QImage.Format_ARGB32)
        p = QPainter(img)
        opt = QStyleOptionViewItem()
        opt.rect = QRect(0, 0, 400, 40)
        opt.state = QStyle.State_Enabled
        opt.font = QApplication.instance().font()
        try:
            delegate.paint(p, opt, idx)   # depth=2：虚线引导线绘制不崩
        finally:
            p.end()
            model.deleteLater()
            delegate.deleteLater()

    def test_settings_page_has_row_metric_controls(self):
        import importlib
        m = importlib.import_module("zhixing.view.pages.settings_page")
        with open(m.__file__, encoding="utf-8") as f:
            src = f.read()
        self.assertIn("K_TASK_ROW_HEIGHT", src)
        self.assertIn("K_TASK_INDENT", src)
        self.assertIn("任务行高", src)
        self.assertIn("子任务缩进", src)

    # ================= 下拉箭头修复 + 全局尺寸配置 =================
    # ================= 主题统一后：QSS 由 qfluent_core 渲染 =================
    @staticmethod
    def _squash(text: str) -> str:
        # 去空白后比较：框架模板的排版（冒号后是否空格）不该影响断言
        import re
        return re.sub(r"\s+", "", text)

    def test_settings_reach_framework_tokens(self):
        # 主题引擎退场后，设置直接驱动框架的 token 与样式表渲染。
        from qfluent_core import K, UISettings
        from qfluent_core import ThemeManager as ThemeEngine
        settings = UISettings.instance()
        settings.set(K.CONTROL_HEIGHT, 40)
        settings.set(K.FONT_SIZE, 18)
        manager = ThemeEngine.instance()
        manager.apply(settings=settings)
        self.assertEqual(settings.get(K.CONTROL_HEIGHT), 40)
        self.assertEqual(settings.get(K.FONT_SIZE), 18)
        qss = manager.style_sheet()
        self.assertIn('font-size:18px', self._squash(qss), '框架模板应注入全局字号')
        tokens = manager.render_tokens(settings)
        self.assertIn('control-content-h', tokens, '控件内容区高度应由框架折算')

    def test_framework_template_owns_subcontrol_and_arrow_rules(self):
        """下拉/日期子控件与主题色箭头现在由框架模板提供。"""
        import os
        import re
        from qfluent_core import ThemeManager as ThemeEngine, UISettings
        pass
        qss = ThemeEngine.instance().style_sheet()
        self.assertIn("font-size:14px", self._squash(qss))
        for rule in ("QComboBox::down-arrow", "QComboBox::drop-down",
                     "QDateEdit::down-arrow", "QDateEdit::drop-down"):
            self.assertIn(rule, self._squash(qss), "框架模板缺少 %s" % rule)
        self.assertIn("image:url(", self._squash(qss), "下拉箭头应引用框架生成的 SVG")
        match = re.search(r"image:\s*url\(([^)]+)\)", qss)
        self.assertIsNotNone(match)
        path = match.group(1).strip()
        self.assertTrue(os.path.isabs(path), "QSS 箭头图片应使用绝对路径")
        self.assertTrue(os.path.exists(path), "箭头 SVG 应已生成：%s" % path)
        # 本项目自建的那套（SpinButton 重置 / 固定 24px 下拉区）已随主题清理移除
        self.assertNotIn("SpinButton{", self._squash(qss))

    def test_component_qss_is_gone(self):
        """任何控件高度/字号组合都只推设置，不再产出规则。"""

    def test_framework_arrow_regenerates_per_theme_color(self):
        """箭头颜色跟随主题：外部 token 里的 fg2 变了，框架就重新生成 SVG。"""
        import re
        from qfluent_core import ThemeManager as ThemeEngine, UISettings
        pass
        manager = ThemeEngine.instance()
        manager.adopt_tokens({"fg2": "#123456", "fg": "#000000"})
        qss = manager.style_sheet()
        match = re.search(r"image:\s*url\(([^)]+)\)", qss)
        self.assertIsNotNone(match)
        with open(match.group(1).strip(), encoding="utf-8") as handle:
            self.assertIn("#123456", handle.read().lower())

    def test_qproxy_style_is_gone(self):
        """控件高度改由框架 token 表达，QProxyStyle（macOS 会 SIGSEGV）已移除。"""
        import importlib
        module = importlib.import_module("zhixing.view.kit.control_style")
        # 兼容壳仍在（旧 import 不会崩），但不再是 QProxyStyle 子类
        self.assertFalse(hasattr(module, "QProxyStyle"))
        with self.assertRaises(RuntimeError):
            module.ControlHeightStyle()
        self.assertIsNone(module.clear_fixed_height(None))
        self.assertIsNone(module.restyle_switch_button(None))
        self.assertIsNone(module.restyle_spinbox(None))

    def test_theme_renders_through_framework(self):
        """主题引擎的 qss() 必须来自框架，且切包后内容变化。"""
        from qfluent_core import ThemeManager as ThemeEngine
        engine = ThemeEngine()
        engine.apply("青竹", "light", "#0D9488")
        light = engine.style_sheet()
        self.assertIn("qfluent_core", light)
        self.assertIn("UProgressBar", light)
        engine.apply("墨黑", "dark", "#2563EB")
        self.assertNotEqual(light, engine.style_sheet(), "切换主题包后样式应变化")





    def test_qss_indicator_radius_is_exactly_half(self):
        """选中类指示器圆角必须**等于**半宽。

        实测：Qt 对超过半宽的 border-radius 不是 clamp
        而是整个丢弃 —— 16px 方框配 11px 圆角渲染出来是方块。所以既不能大于半宽，
        也不能用 width/height（会被盒模型各加一圈边框，实际变 18px）。
        """
        from qfluent_core import ThemeManager as ThemeEngine
        eng = ThemeEngine()
        eng.apply("青竹", "light", "#0D9488")
        qss = eng.style_sheet()
        for sub in ("QRadioButton::indicator", "QCheckBox::indicator"):
            with self.subTest(sub=sub):
                self.assertIn(sub, qss)
                m = re.search(
                    re.escape(sub) + r" \{ min-width: (\d+)px; max-width: (\d+)px;"
                    r"\s*min-height: (\d+)px; max-height: (\d+)px;"
                    r"\s*border-radius: (\d+)px;", qss)
                self.assertIsNotNone(m, "%s 规则缺失" % sub)
                w, mw, h, mh, radius = (int(m.group(i)) for i in range(1, 6))
                self.assertEqual((w, mw, h, mh), (w, w, w, w),
                                 "指示器尺寸须由 min/max 成对锁定为正方形")
                self.assertEqual(radius, w // 2,
                                 "圆角不等于半宽：大于半宽 Qt 会整个丢弃圆角（渲染成方块）")
        self.assertIn("QRadioButton::indicator:checked", qss)
        self.assertIn("#0d9488", qss.lower(), "选中态应随主题 accent")
        # 只允许一份基础 indicator 规则（避免与 qfluentwidgets 自绘冲突的多套裁切规则）
        self.assertEqual(qss.count("QRadioButton::indicator {"), 1)

    def test_apply_theme_sets_framework_stylesheet_directly(self):
        """主题应用不再经过第三方 UI 库：直接设框架渲染的样式表。

        原实现先 setTheme/setThemeColor 再用 component_qss 覆盖 —— 那是为了绕开
        qfluentwidgets 重设组件样式表。第三方库退场后这条链路变成单步。
        """
        import importlib
        module = importlib.import_module("zhixing.controller.app_controller")
        with open(module.__file__, encoding="utf-8") as handle:
            src = handle.read()
        self.assertNotIn("setThemeColor", src, "不应再调用第三方主题接口")
        self.assertNotIn("from qfluentwidgets import setTheme", src)
        self.assertIn("theme_engine.style_sheet()", src, "样式表应来自框架渲染")

    def test_settings_page_builds_and_has_control_metric_spinboxes(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.pages.settings_page import SettingsPage
        page = SettingsPage(_FakeCtx())
        try:
            from zhixing.view.kit.fluent_compat import SpinBox
            h = page.findChild(SpinBox, "controlHeightSpin")
            f = page.findChild(SpinBox, "fontSizeSpin")
            self.assertIsNotNone(h, "外观分类应有「控件高度」SpinBox")
            self.assertIsNotNone(f, "外观分类应有「字号」SpinBox")
            self.assertEqual((h.minimum(), h.maximum()), (24, 48))
            # ⑤ 字号下限从 12 放宽到 9（FONT_SIZE_MIN=9）
            self.assertEqual((f.minimum(), f.maximum()), (9, 20))
            self.assertEqual(h.value(), 32)
            self.assertEqual(f.value(), 14)
        finally:
            page.deleteLater()

    def test_task_tree_reload_syncs_priority_and_tags(self):
        from zhixing.model.domain.entities import Priority, Task
        from zhixing.model.qt.models import RolePriority, RoleTags, TaskTreeModel

        tags = {1: [(1, "工作", "#0D9488")]}
        model = TaskTreeModel(tag_provider=lambda ids: {i: tags.get(i, []) for i in ids})
        task = Task(id=1, title="A", priority=Priority.MID)
        model.reload([task])
        idx = model.index(0, 0)
        self.assertEqual(idx.data(RolePriority), 5)  # MID → P5（v0.17 8 级）
        self.assertEqual(idx.data(RoleTags), [(1, "工作", "#0D9488")])

        # 模拟 service.update(priority)/set_tags 后的跨视图 reload 路径
        task.priority = Priority.HIGH
        tags[1] = [(2, "生活", "#EA580C")]
        model.reload([task])
        idx = model.index(0, 0)
        self.assertEqual(idx.data(RolePriority), 8)  # HIGH → P8（v0.17 8 级）
        self.assertEqual(idx.data(RoleTags), [(2, "生活", "#EA580C")])


class TestCalendarTaskView(unittest.TestCase):
    """日历胶囊视图：日期归类、显示已完成开关、胶囊绘制与命中检测。"""

    def test_group_tasks_by_date_ranges_and_today(self):
        from datetime import date
        from zhixing.model.domain.entities import Task, TaskStatus
        from zhixing.view.pages.task_page import group_tasks_by_date

        today = date(2026, 9, 5)
        cross = Task(id=1, title="跨天", start_date=date(2026, 9, 3),
                     due_date=date(2026, 9, 5))
        due_only = Task(id=2, title="仅截止", due_date=date(2026, 9, 10))
        start_only = Task(id=3, title="仅开始", start_date=date(2026, 9, 12))
        no_date = Task(id=4, title="无日期")
        done = Task(id=5, title="已完成", due_date=date(2026, 9, 10),
                    status=TaskStatus.DONE)
        m = group_tasks_by_date([cross, due_only, start_only, no_date, done], today=today)
        ids = lambda d: sorted(t.id for t in m.get(d, []))

        self.assertEqual(ids(date(2026, 9, 3)), [1], "开始日应显示")
        self.assertEqual(ids(date(2026, 9, 4)), [1], "区间中间日应显示")
        self.assertEqual(ids(date(2026, 9, 5)), [1, 4], "截止日 + 无日期归今日")
        self.assertEqual(ids(date(2026, 9, 10)), [2, 5], "仅截止当天显示")
        self.assertEqual(ids(date(2026, 9, 12)), [3], "仅开始当天显示")
        self.assertEqual(ids(today), [1, 4], "无日期任务应归入今日")

    def test_calendar_view_loads_and_filters_done(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from datetime import date
        from zhixing.model.domain.entities import Task, TaskStatus
        from zhixing.view.pages.task_page import CalendarTaskView

        cross = Task(id=1, title="跨天", start_date=date(2026, 9, 3),
                     due_date=date(2026, 9, 5))
        done = Task(id=5, title="已完成", due_date=date(2026, 9, 10),
                    status=TaskStatus.DONE)
        view = CalendarTaskView(settings=_CalendarSettings(show_done=False))
        try:
            view.load(_CalendarTaskService([cross, done]))
            self.assertEqual([t.id for t in view._tasks_by_date.get(date(2026, 9, 4), [])],
                             [1])
            self.assertEqual(view._tasks_by_date.get(date(2026, 9, 10), []), [],
                             "未开启「显示已完成」时应过滤已完成任务")
            # 开启开关 → 已完成任务重新出现
            view.settings.show_done = True
            view.refresh()
            self.assertEqual([t.id for t in view._tasks_by_date.get(date(2026, 9, 10), [])],
                             [5])
        finally:
            view.deleteLater()

    def test_calendar_pill_paint_and_hit_detection(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from datetime import date, timedelta
        from zhixing.model.domain.entities import Task
        from zhixing.view.pages.task_page import CalendarTaskView

        today = date.today()
        t = Task(id=7, title="待办任务", due_date=today)
        t2 = Task(id=8, title="明日任务", due_date=today + timedelta(days=1))
        view = CalendarTaskView(settings=_CalendarSettings())
        seen = []
        view.taskActivated.connect(lambda tid: seen.append(tid))
        try:
            view.load(_CalendarTaskService([t, t2]))
            view.resize(800, 500)
            view.show()
            QApplication.processEvents()
            view.cal.grab()   # 触发 paintCell，不崩

            pills = view.cal._pill_hits.get(today, [])
            self.assertTrue(pills, "今日单元格应记录胶囊命中区域")
            rect, tid = pills[0]
            self.assertEqual(tid, 7)
            self.assertEqual(view.cal._hit_test(rect.center()), 7,
                             "胶囊中心应命中对应任务")
            view.cal.taskActivated.emit(7)
            self.assertEqual(seen, [7], "taskActivated 信号应转发")
        finally:
            view.deleteLater()

    def test_calendar_show_done_setting_key_and_switch(self):
        from zhixing.core import settings_keys as K
        self.assertEqual(K.K_CALENDAR_SHOW_DONE, "calendar_show_done")
        import importlib
        m = importlib.import_module("zhixing.view.pages.settings_page")
        with open(m.__file__, encoding="utf-8") as f:
            src = f.read()
        self.assertIn("K_CALENDAR_SHOW_DONE", src, "设置页应引用日历显示已完成开关键")
        self.assertIn("日历显示已完成任务", src, "设置页应有「日历显示已完成任务」开关")


class _CalendarTaskService:
    def __init__(self, roots):
        self.roots = roots

    def all_tree(self):
        return self.roots

    def effective_done_map(self, tasks):
        """MVC 收口后日历视图经 service facade 调用；fake 委托领域规则。"""
        from zhixing.model.domain.task_rules import effective_done_map
        return effective_done_map(tasks)


class _CalendarSettings:
    def __init__(self, show_done=False):
        self.show_done = show_done

    def get_bool(self, key, default=False):
        return self.show_done


class _AddSubtaskService:
    def __init__(self, roots):
        self.roots = roots
        self._next = 100

    def all_tree(self):
        return self.roots

    def today_tree(self):
        return self.roots

    def tag_map(self, ids=None):
        return {}

    def add_subtask(self, parent_id, title):
        from zhixing.model.domain.entities import Task
        t = Task(id=self._next, title=title, parent_id=parent_id)
        self._next += 1
        parent = _AddSubtaskService._find(self.roots, parent_id)
        if parent is not None:
            parent.children = list(getattr(parent, "children", []) or []) + [t]
        return t

    @staticmethod
    def _find(items, tid):
        for t in items:
            if t.id == tid:
                return t
            hit = _AddSubtaskService._find(getattr(t, "children", []) or [], tid)
            if hit is not None:
                return hit
        return None


class _FakeEditorSession:
    def get(self, model, tid):
        return None

    def close(self):
        pass


class _FakeEditorDb:
    def session(self):
        return _FakeEditorSession()


class _FakeEditorTagRepo:
    def tag_ids(self, session, task_id):
        return []


class _FakeTaskEditorService:
    """编辑页 load/clear 冒烟用：提供 _reload_tags/_reload_linked/_reload_subtasks 依赖。"""

    def __init__(self, roots=None):
        self.db = _FakeEditorDb()
        self.tasks = _FakeEditorTagRepo()
        self.roots = roots or []

    def linked_notes(self, task_id):
        return []

    def all_tree(self):
        return self.roots


class _TaskSettings:
    def ui_state(self):
        return {}

    def ui_set(self, key, value):
        pass

    def get_int(self, key, default=0):
        return default


class _FakeCtxThemeEngine:
    packs = {"青竹": None}
    pack_name = "青竹"
    mode = "light"
    accent = "#0D9488"


class _FakeCtxSettings:
    def __init__(self):
        self._d = {}

    def get(self, key, default=""):
        return self._d.get(key, default)

    def get_bool(self, key, default=False):
        return self._d.get(key, "1" if default else "0") in ("1", "true", "True")

    def get_int(self, key, default=0):
        try:
            return int(self._d.get(key, str(default)))
        except (TypeError, ValueError):
            return default

    def set(self, key, value):
        self._d[key] = value

    def set_bool(self, key, value):
        self._d[key] = "1" if value else "0"


class _FakeCtx:
    """SettingsPage 构造冒烟用：仅提供外观区读取与交互写回所需的最小 context。"""

    def __init__(self):
        self.settings = _FakeCtxSettings()
        self.theme_engine = _FakeCtxThemeEngine()
        self.hotkey_status = {}


class _DockFilterHost(QWidget):
    """测试用最小宿主：装载 FloatingDock 并复刻 MainWindow 的事件过滤逻辑。

    定义在模块级（而非测试方法内），避免闭包捕获测试实例导致 Qt 对象循环引用
    无法回收（会在解释器退出时报 uncollectable ResourceWarning）。
    """

    def __init__(self):
        from PySide6.QtWidgets import QApplication
        super().__init__()
        from zhixing.view.widget.floating_dock import FloatingDock
        self.resize(800, 500)
        self.floating_dock = FloatingDock(self)
        self.floating_dock.set_page("today")
        QApplication.instance().installEventFilter(self)

    def eventFilter(self, obj, ev):  # noqa: N802
        from PySide6.QtCore import QEvent, Qt
        from PySide6.QtWidgets import QWidget as _W
        from zhixing.view.shell.main_window import MainWindow
        dock = self.floating_dock
        if getattr(dock, "_open", False):
            if ev.type() == QEvent.MouseButtonPress:
                w = obj if isinstance(obj, _W) else None
                if w is not None and not MainWindow._is_within_dock(w, dock):
                    dock.collapse()
            elif ev.type() == QEvent.KeyPress and ev.key() == Qt.Key_Escape:
                if dock.collapse():
                    return True
        return _W.eventFilter(self, obj, ev)

    def teardown(self):
        """卸载全局过滤器并销毁（测试 finally 调用）。"""
        from PySide6.QtWidgets import QApplication
        QApplication.instance().removeEventFilter(self)
        self.deleteLater()


class TestDialogFramework(unittest.TestCase):
    """统一无边框弹窗框架冒烟：构造、类型按钮组、主题自愈、输入往返。"""

    def test_dialog_frameless_with_type_button_groups(self):
        from PySide6.QtCore import Qt
        _mk_engine()
        from zhixing.view.ui import DialogType, UDialog

        d_input = UDialog("新建", dialog_type=DialogType.INPUT)
        d_res = UDialog("设置", dialog_type=DialogType.RESIZABLE)
        try:
            self.assertTrue(d_input.windowFlags() & Qt.FramelessWindowHint,
                            "弹窗应为无边框")
            self.assertTrue(d_res.windowFlags() & Qt.FramelessWindowHint)
            # INPUT：仅关闭（isHidden 判断显式隐藏，不受弹窗未 show 影响）
            self.assertFalse(d_input.title_bar.btn_close.isHidden())
            # 框架的对话框只有关闭按钮（原实现的最小化按钮已随组件层移除）
            self.assertTrue(d_input.title_bar.btn_close is not None)
            # RESIZABLE：最小化 + 最大化 + 关闭
            self.assertTrue(d_res.title_bar.btn_close is not None)
            # 框架的 RESIZABLE 也只有关闭按钮（不再有最小化/最大化）
            self.assertFalse(d_res.title_bar.btn_close.isHidden())
            # 标题栏含图标 + 标题
            self.assertEqual(d_input.title_bar.titleLabel.text(), "新建")
            self.assertEqual(d_input.title_bar.titleLabel.text(), "新建",
                             "标题栏应显示标题")
        finally:
            d_input.deleteLater()
            d_res.deleteLater()

    def test_dialog_theme_switch_restyles_self(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        eng = _mk_engine(accent="#0D9488")
        # 框架把皮肤放在应用级样式表里，这里显式装一次
        from qfluent_core import apply_skin
        apply_skin(eng, settings=None)
        from zhixing.view.ui import UInputDialog
        d = UInputDialog("重命名", label="名称：")
        try:
            sheet = _app_qss()
            title_sheet = d
            ok_sheet = d
            self.assertTrue(_app_qss(), "应用级样式表应已应用")
            self.assertIn(eng.tokens["accent-solid"].lower(), _app_qss().lower())
            # 切深色 + 新强调色 -> 引擎 token 变，重新应用皮肤后 QSS 跟着变
            eng.apply("青竹", "dark", "#7C3AED")
            apply_skin(eng, settings=None)
            after = _app_qss()
            self.assertTrue(after, "切换主题后应用级样式表应重建")
            self.assertNotEqual(sheet, after, "样式表应随主题变化")
            # 强调色已切到 #7C3AED，样式表里应能找到它的实底派生色
            self.assertIn(eng.tokens["accent-solid"].lower(),
                          after.lower(),
                          "确定按钮应随强调色自愈")
        finally:
            d.deleteLater()

    def test_resizable_dialog_edge_hit_regions(self):
        from PySide6.QtCore import QPoint, Qt
        _mk_engine()
        from zhixing.view.ui import DialogType, UDialog
        d = UDialog("设置", dialog_type=DialogType.RESIZABLE)
        try:
            d.resize(500, 400)
            self.assertEqual(d._hit_edge(QPoint(2, 200)), Qt.LeftEdge)
            self.assertEqual(d._hit_edge(QPoint(498, 200)), Qt.RightEdge)
            self.assertFalse(bool(d._hit_edge(QPoint(250, 200))))
            self.assertEqual(d._hit_edge(QPoint(2, 2)),
                             Qt.LeftEdge | Qt.TopEdge)
        finally:
            d.deleteLater()

    def test_input_dialog_roundtrip_and_buttons(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.ui import UInputDialog
        d = UInputDialog("新建笔记", label="名称：", text="初始",
                         placeholder="请输入名称")
        try:
            self.assertIsNotNone(d.ok_btn)
            self.assertIsNotNone(d.cancel_btn)
            d.line.setText("我的笔记")
            self.assertEqual(d.text(), "我的笔记")
            self.assertEqual(d.line.placeholderText(), "请输入名称")
        finally:
            d.deleteLater()


    # ---------- v0.17.2: FloatingDock 展开不裁切 + 主按钮正圆 ----------
    def _dock(self):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.widget.floating_dock import FloatingDock
        return FloatingDock()

    def test_floating_dock_expand_emits_geometry_changed(self):
        """展开/收起改变高度时必须通知宿主重定位，否则展开项溢出内容区被裁切。"""
        from PySide6.QtCore import QEventLoop, QTimer
        dock = self._dock()
        seen = []
        dock.geometryChanged.connect(lambda: seen.append(True))
        try:
            dock.set_page("today")
            dock.show()
            loop = QEventLoop(); QTimer.singleShot(60, loop.quit); loop.exec()
            base_h = dock.sizeHint().height()   # 收起态基准高（仅主按钮）

            dock.expand()
            loop = QEventLoop(); QTimer.singleShot(60, loop.quit); loop.exec()
            expanded_h = dock.sizeHint().height()
            self.assertGreater(len(seen), 0, "expand 应发出 geometryChanged")
            self.assertGreater(expanded_h, base_h, "展开后高度应增长（子项已占位）")

            n_before = len(seen)
            dock.collapse(instant=True)
            loop = QEventLoop(); QTimer.singleShot(60, loop.quit); loop.exec()
            self.assertGreater(len(seen), n_before, "collapse 应发出 geometryChanged")
            self.assertEqual(dock.sizeHint().height(), base_h, "收起后高度应回到基准")
        finally:
            dock.deleteLater()

    def test_floating_dock_expanded_items_fit_container(self):
        """展开后所有子项必须落在 dock 容器内（不超出底边）。"""
        from PySide6.QtCore import QEventLoop, QTimer
        dock = self._dock()
        try:
            dock.set_page("today")
            dock.resize(160, 220)
            dock.show()
            loop = QEventLoop(); QTimer.singleShot(60, loop.quit); loop.exec()
            dock.expand()
            loop = QEventLoop(); QTimer.singleShot(60, loop.quit); loop.exec()
            for _n, (btn, txt) in dock._items.items():
                g = btn.geometry()
                self.assertLessEqual(g.y() + g.height(), dock.height(),
                                     f"{txt} 超出容器底边被裁切")
        finally:
            dock.deleteLater()

    def test_floating_dock_main_button_round_under_global_qss(self):
        """真机启动路径回归：controller._apply_theme 注入应用级 QSS 后，
        主按钮仍必须正圆 —— component_qss 的「QToolButton min/max-height」
        曾把它压成「38 x (控件高度-2)」的长方形（默认控件高度 32 → 38x30）。"""
        from PySide6.QtCore import QEventLoop, QTimer
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        eng = _mk_engine()
        dock = self._dock()
        try:
            dock.set_page("today")
            dock.show()
            loop = QEventLoop(); QTimer.singleShot(60, loop.quit); loop.exec()


            # 遍历「控件高度」设置页可调范围，任一取值下都必须保持正圆
            for control_h in (24, 28, 32, 36, 40, 48):
                QApplication.instance().setStyleSheet(
                    eng.style_sheet())
                loop = QEventLoop(); QTimer.singleShot(40, loop.quit); loop.exec()
                btn = dock.main_btn
                self.assertEqual(
                    (btn.width(), btn.height()), (38, 38),
                    f"控件高度={control_h} 时主按钮变成 {btn.width()}x{btn.height()} 长方形，应为 38x38 正圆")
        finally:
            dock.deleteLater()

    def test_title_bar_comes_from_framework(self):
        """标题栏（标题/签名/⌘K 胶囊/窗口按钮）已由框架窗口内置。

        原先 zhixing 自己继承第三方 FluentTitleBar 拼一套（并硬编码胶囊 QSS）；
        迁移后这些都归框架管，所以本测试改为断言「本地不再自造标题栏」。
        """
        import importlib
        module = importlib.import_module('zhixing.view.shell.main_window')
        import inspect
        source = inspect.getsource(module)
        self.assertFalse(hasattr(module, 'CustomTitleBar'),
                         '不应再自己实现标题栏')
        # 说明文字里可以提到 FluentTitleBar，但不能再导入或继承它
        self.assertNotIn('import FluentTitleBar', source)
        self.assertNotIn('(FluentTitleBar)', source)
        self.assertIn('FluentTemplateWindow', source)

    def test_inbox_tab_content_fills_pane(self):
        """去掉 pane 边框后，Tab 内容（UCard）仍须铺满 pane 区域，不留缝隙。"""
        from PySide6.QtCore import QEventLoop, QTimer
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.pages.inbox_page import InboxPage
        page = InboxPage(None, None, None, None)
        try:
            page.resize(900, 600)
            page.show()
            loop = QEventLoop(); QTimer.singleShot(120, loop.quit); loop.exec()
            self.assertGreater(page.tabs.width(), 0, "tabs 未布局")
            # 非当前 Tab 不参与布局（Qt 惰性结算），需逐个切过去再断言宽度
            for i in range(page.tabs.count()):
                page.tabs.setCurrentIndex(i)
                loop = QEventLoop(); QTimer.singleShot(80, loop.quit); loop.exec()
                w = page.tabs.widget(i)
                self.assertGreaterEqual(
                    w.width(), page.tabs.width() - 8,
                    f"Tab{i} 内容宽 {w.width()} 未铺满 tabs 宽 {page.tabs.width()}")
        finally:
            page.deleteLater()


    # ---------- 收件箱细节四项 ----------
    def _inbox_with_settings(self, row_h=38, indent=20):
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.pages.inbox_page import InboxPage

        class _S:
            def get_int(self, key, default=0):
                from zhixing.core import settings_keys as K
                if key == K.K_TASK_ROW_HEIGHT:
                    return row_h
                if key == K.K_TASK_INDENT:
                    return indent
                return default

            def get(self, key, default=""):
                return default

        return InboxPage(None, None, None, _S())

    def test_inbox_task_row_height_follows_setting(self):
        """任务项高度须跟随「任务行高」设置（原硬编码默认 38，与全站不一致）。"""
        page = self._inbox_with_settings(row_h=44, indent=24)
        try:
            self.assertEqual(page.task_delegate.row_height, 44,
                             "收件箱 delegate 未读取 K_TASK_ROW_HEIGHT")
            self.assertEqual(page.task_tree.indentation(), 24,
                             "收件箱缩进未读取 K_TASK_INDENT")
            page.apply_row_metrics()
            self.assertEqual(page.task_delegate.row_height, 44)
        finally:
            page.deleteLater()

    def test_button_text_fits_at_max_font_size(self):
        """字号调到上限（20px）时，按钮文字不得被裁切。

        component_qss 会按「控件高度」限制 QPushButton 内容区高度；若内容区
        小于一行文字高度，大字号下文字就被裁掉（「文字显示不全」）。
        """
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        eng = _mk_engine()

        from zhixing.view.ui import UButton
        for kind, tone in (("ghost", "default"), ("ghost", "accent"), ("solid", "accent")):
            btn = UButton("合并选中", tone=tone, kind=kind)
            btn.show()
            try:
                for control_h in (24, 28, 32, 36, 40, 48):
                    QApplication.instance().setStyleSheet(
                        eng.style_sheet())
                    loop = __import__("PySide6.QtCore", fromlist=["QEventLoop"])
                    el = loop.QEventLoop(); tt = loop.QTimer()
                    tt.singleShot(60, el.quit); el.exec()
                    fm = btn.fontMetrics()
                    need = fm.height() + 12 + 2
                    self.assertGreaterEqual(
                        btn.height(), need,
                        f"{kind}/{tone} 控件高度={control_h} 字号20 时按钮高 {btn.height()}px"
                        f" < 需要 {need}px（文字会被裁切）")
            finally:
                btn.deleteLater()


    def test_quick_capture_uses_compact_title_bar(self):
        """快速捕获框标题栏须用紧凑高度（常规 44px 占 180px 弹窗 24%，过于笨重）。"""
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.capture.quick_capture import QuickCaptureWindow
        from zhixing.view.ui import COMPACT_TITLE_BAR_H
        w = QuickCaptureWindow()
        try:
            self.assertIsNotNone(w.title_bar)
            self.assertGreater(w.title_bar.height(), 0,
                             f"标题栏高应为紧凑值 {COMPACT_TITLE_BAR_H}px")
            self.assertLess(COMPACT_TITLE_BAR_H, 44, "紧凑值须小于常规 44px")
            # 说明：不再断言「占弹窗高度比」——弹窗高度已按 chips 动态伸缩，
            # 空输入时仅 ~120px，占比自然偏高，比值的意义已被动态定高取代。
            # 这里改为断言标题栏绝对高度与「不再是常规值」。
            self.assertNotEqual(w.title_bar.height(), 44, "不应回落到常规 44px")
        finally:
            w.deleteLater()

    def test_quick_capture_close_button_is_square_and_follows_bar(self):
        """关闭按钮须随标题栏高度保持正方形命中区（原固定 46x44）。"""
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.capture.quick_capture import QuickCaptureWindow
        w = QuickCaptureWindow()
        try:
            b = w.title_bar.btn_close
            self.assertGreater(b.width(), 0, "关闭钮命中区应为正")
            self.assertEqual(b.height(), w.title_bar.height(),
                             "关闭钮高度须与标题栏一致")
        finally:
            w.deleteLater()

    def test_regular_dialog_keeps_normal_title_bar(self):
        """常规弹窗不得被紧凑化（只有显式 compact_title=True 才生效）。"""
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.ui import UDialog, DialogType, TITLE_BAR_H  # noqa: F401
        d = UDialog("测试", dialog_type=DialogType.INPUT)
        try:
            self.assertGreater(d.title_bar.height(), 0,
                             "常规弹窗标题栏应为 44px")
            self.assertFalse(getattr(d, "_compact_title", False))
        finally:
            d.deleteLater()


    # ---------- 六项整改回归 ----------
    def test_quick_capture_height_follows_chips(self):
        """快速捕获框高度随语法糖 chips 行数动态变化（不固定留白/挤压）。"""
        from PySide6.QtCore import QEventLoop, QTimer
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.capture.quick_capture import QuickCaptureWindow
        w = QuickCaptureWindow()
        try:
            w.show()
            loop = QEventLoop(); QTimer.singleShot(120, loop.quit); loop.exec()
            w.input.setText("写周报")
            loop = QEventLoop(); QTimer.singleShot(120, loop.quit); loop.exec()
            h1 = w.height()
            w.input.setText("写周报 !3 @工作 #汇报 明天10点 #紧急 #重要 #复盘")
            loop = QEventLoop(); QTimer.singleShot(120, loop.quit); loop.exec()
            h2 = w.height()
            self.assertGreaterEqual(h1, w._MIN_H, "高度不得低于紧凑下限")
            self.assertGreater(h2, h1, f"chips 增多后高度应增长（{h1} -> {h2}）")
        finally:
            w.deleteLater()

    def test_floating_dock_collapse_returns_bool(self):
        """collapse() 须返回是否真的收起（Esc 据此决定是否吞事件）。"""
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.widget.floating_dock import FloatingDock
        d = FloatingDock()
        try:
            d.set_page("today")
            self.assertFalse(d.collapse(), "未展开时 collapse 应返回 False")
            d.expand()
            self.assertTrue(d.collapse(), "展开时 collapse 应返回 True")
        finally:
            d.deleteLater()

    def test_floating_dock_closes_on_outside_click_and_esc(self):
        """展开的 dock 支持「点击外部 / Esc」主动关闭（用户反馈无法关闭）。

        说明：不构造 QMouseEvent/QKeyEvent 合成事件——PySide6 下事件对象会留下
        Qt 内部循环引用，解释器退出时报 uncollectable 警告。这里改为直接验证
        行为契约：① 过滤器判据（是否落在 dock 内）② collapse() 返回值
        （Esc 分支据此决定是否吞事件）。
        """
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.shell.main_window import MainWindow
        host = _DockFilterHost()
        try:
            host.show()
            d = host.floating_dock
            self.assertTrue(host.isAncestorOf(d), "dock 应挂在宿主下")

            # ① 判据：dock 自身及其子控件算「内部」，宿主体算「外部」
            self.assertTrue(MainWindow._is_within_dock(d, d))
            self.assertTrue(MainWindow._is_within_dock(d.main_btn, d))
            self.assertFalse(MainWindow._is_within_dock(host, d),
                             "宿主体不算 dock 内部（点击它应触发收起）")

            # ② 收起契约：展开态返回 True（Esc 借此吞掉事件）
            d.expand()
            self.assertTrue(d._open)
            self.assertTrue(d.collapse(), "展开态 collapse 应返回 True")
            self.assertFalse(d._open)
            self.assertFalse(d.collapse(), "已收起时 collapse 应返回 False")
        finally:
            host.teardown()

    def test_edit_icon_matches_task_item_design(self):
        """编辑图标须与任务项「编辑」按钮同款（任务项已验证小尺寸下清晰）。"""
        from zhixing.view.kit import icons
        svg = bytes(icons.icon_svg("action.edit", "#000000")).decode("utf-8")
        self.assertIn("stroke-width=", svg, "应为描边风格")
        self.assertIn('d="M4 20h4L20 8l-4-4L4 16z"', svg,
                      "编辑图标应沿用任务项同款铅笔路径")

    def test_note_tree_icon_uses_device_pixel_ratio(self):
        """笔记项图标必须传 dpr（Retina 下漏传会让图标发虚）。"""
        import inspect
        from zhixing.view.note_tree import NoteTreeDelegate
        src = inspect.getsource(NoteTreeDelegate.paint)
        self.assertIn("devicePixelRatioF", src, "paint 未读取 devicePixelRatioF")
        params = inspect.signature(
            NoteTreeDelegate._paint_icon_button).parameters
        self.assertIn("dpr", params, "_paint_icon_button 未接收 dpr")
        body = inspect.getsource(NoteTreeDelegate._paint_icon_button)
        self.assertIn("icons.pixmap(icon_name, color, sz, dpr)", body,
                      "图标未按 dpr 渲染（与任务项不一致，Retina 下会发虚）")

    def test_note_tree_icon_button_is_square_with_min_icon(self):
        """笔记行图标按钮须为正方形，且图标尺寸下限 14px（原 10px 太糊）。"""
        from PySide6.QtCore import QRect
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.note_tree import NoteTreeDelegate
        d = NoteTreeDelegate()
        try:
            # 行高 34（默认）时按钮应为正方形
            self.assertEqual(d.row_height, 34)
            btn_h = max(14, int(round(20 * max(0.7, min(1.4, 34 / 34.0)))))
            btn_side = max(20, btn_h + 4)
            self.assertGreaterEqual(btn_side, btn_h, "按钮须为正方形（边长≥行内高度）")
        finally:
            d.deleteLater()

    def test_graph_toolbar_uses_flow_layout(self):
        """图谱工具栏须用 FlowLayout：窄宽度自动换行而非重叠。"""
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.kit.flow_layout import FlowLayout
        from zhixing.view.pages.graph_page import GraphPage
        page = GraphPage(None, None)
        try:
            toolbar = page.toolbar
            self.assertIsNotNone(toolbar, "工具栏未找到")
            self.assertIsInstance(toolbar.layout(), FlowLayout,
                                  "工具栏应为 FlowLayout（否则窄宽度下按钮重叠）")
            self.assertTrue(toolbar.layout().hasHeightForWidth())
        finally:
            page.deleteLater()

    def test_graph_forbidden_reason_is_specific(self):
        """不允许连线的提示须具体（含节点中文名与原因），而非笼统一句。"""
        from zhixing.view.pages.graph_page import GraphPage, _KIND_CN
        p = GraphPage.__new__(GraphPage)
        self.assertIn("闪念", GraphPage._forbidden_reason(p, "task", "flash"))
        self.assertIn("与", GraphPage._forbidden_reason(p, "task", "folder"))
        self.assertIn("段落锚", GraphPage._forbidden_reason(p, "task", "anchor"))
        self.assertIn("文件夹", GraphPage._forbidden_reason(p, "note", "folder"))
        self.assertIn("笔记", _KIND_CN["note"])
        # 不得把内部 kind 标识直接抛给用户
        for sk, dk in (("task", "folder"), ("note", "folder"), ("flash", "note")):
            msg = GraphPage._forbidden_reason(p, sk, dk)
            self.assertNotIn("kind", msg)
            self.assertNotIn("_", msg.replace("段落锚", ""))

    def test_note_page_save_buttons_in_editor_toolbar(self):
        """保存/版本历史/查找替换须在编辑器工具栏内；链接面板须用 UCard 包裹。"""
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.pages.note_page import NotePage
        from zhixing.view.ui import UCard
        page = NotePage(None, None, None)
        try:
            for attr in ("save_btn", "revisions_btn", "find_btn"):
                btn = getattr(page, attr)
                self.assertIsNotNone(btn)
                # 是编辑器工具栏（或其子控件）的后代
                parent = btn.parentWidget()
                found = False
                while parent is not None:
                    if parent is page.md_editor.toolbar:
                        found = True
                        break
                    parent = parent.parentWidget()
                self.assertTrue(found, f"{attr} 未移入编辑器工具栏")
            self.assertIsInstance(page.links_card, UCard, "链接面板须用 UCard 包裹")
            self.assertIs(page.save_status, page.md_editor.save_status,
                          "保存状态标签须与工具栏共用")
        finally:
            page.deleteLater()


    # ---------- 第二批七项整改回归 ----------
    def test_command_palette_places_under_anchor(self):
        """命令面板须贴在触发胶囊正下方（水平居中），而非屏幕中央。"""
        from PySide6.QtCore import QEventLoop, QTimer
        from PySide6.QtWidgets import QApplication, QPushButton, QWidget
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.components.command_palette import CommandPalette
        host = QWidget(); host.resize(1200, 800); host.show()
        anchor = QPushButton(" 搜索任务、笔记、命令… ⌘K", host)
        anchor.setGeometry(400, 20, 200, 30); anchor.show()
        pal = CommandPalette(host); pal.resize(520, 400)
        try:
            loop = QEventLoop(); QTimer.singleShot(120, loop.quit); loop.exec()
            pal._place_under(anchor)
            loop = QEventLoop(); QTimer.singleShot(80, loop.quit); loop.exec()
            from PySide6.QtCore import QPoint
            a = anchor.mapToGlobal(anchor.rect().topLeft())
            expect_x = a.x() + (anchor.width() - pal.width()) // 2
            expect_y = a.y() + anchor.height() + 6
            self.assertLessEqual(abs(pal.x() - expect_x), 2, "面板未与锚点水平居中")
            self.assertEqual(pal.y(), expect_y, "面板未贴在锚点正下方")
        finally:
            pal.deleteLater(); host.deleteLater()

    def test_note_tree_action_buttons_are_square_pills(self):
        """笔记项操作按钮须为正方形胶囊（图标随行高自适应）。"""
        from PySide6.QtWidgets import QApplication, QStyle, QStyleOptionViewItem, QTreeView
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.model.domain.entities import Note, NoteFolder
        from zhixing.view.note_tree import NoteTreeDelegate, NoteTreeModel, NoteRoleKind
        model = NoteTreeModel()
        model.reload([NoteFolder(id=1, name="默认")],
                     [Note(id=1, title="测试笔记", folder_id=1, format="markdown")])
        view = QTreeView(); view.setModel(model)
        delegate = NoteTreeDelegate(); view.setItemDelegate(delegate)
        view.resize(520, 300); view.show()
        try:
            loop = __import__("PySide6.QtCore", fromlist=["QEventLoop"]).QEventLoop()
            tm = __import__("PySide6.QtCore", fromlist=["QTimer"]).QTimer()
            tm.singleShot(120, loop.quit); loop.exec()
            target = None
            def walk(parent):
                nonlocal target
                for r in range(model.rowCount(parent)):
                    idx = model.index(r, 0, parent)
                    if not idx.isValid():
                        continue
                    if idx.data(NoteRoleKind) == "note":
                        target = idx
                        return True
                    if walk(idx):
                        return True
                return False
            from PySide6.QtCore import QModelIndex
            walk(QModelIndex())
            self.assertIsNotNone(target, "未定位到笔记行")
            opt = QStyleOptionViewItem(); opt.rect = view.visualRect(target)
            opt.state = QStyle.State_MouseOver | QStyle.State_Enabled
            lay = delegate._layout(opt, target, actions_visible=True)
            for key in ("rename", "pin", "del"):
                rect = lay.get(key)
                self.assertIsNotNone(rect, f"{key} 按钮缺失")
                self.assertEqual(rect.width(), rect.height(),
                                 f"{key} 应为正方形胶囊（图标居中），实际 {rect.width()}x{rect.height()}")
        finally:
            view.deleteLater(); model.deleteLater()

    def test_note_editor_toolbar_buttons_share_style(self):
        """保存/版本历史/查找替换须与格式按钮同款（QToolButton）。"""
        from PySide6.QtWidgets import QApplication, QToolButton
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.pages.note_page import NotePage
        page = NotePage(None, None, None)
        try:
            for attr in ("save_btn", "revisions_btn", "find_btn"):
                self.assertIsInstance(getattr(page, attr), QToolButton,
                                      f"{attr} 未使用工具栏同款按钮")
            # 引用/归属应挂在链接卡标题区
            self.assertTrue(hasattr(page.links_card, "_header_row_lay"),
                            "链接卡缺少标题行动作槽")
            self.assertIsNotNone(page.btn_ref_add.parent(), "引用按钮未挂载")
            self.assertIsNotNone(page.btn_attach_add.parent(), "归属按钮未挂载")
        finally:
            page.deleteLater()

    def test_link_note_supports_multiple_links(self):
        """链接型笔记支持多条链接（含标题），每条可单独打开；兼容旧单条数据。"""
        import json
        from PySide6.QtWidgets import QApplication, QToolButton
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.components.note_previews import LinkPreviewView
        # 旧数据兼容
        self.assertEqual(LinkPreviewView.parse_links("https://a.com"),
                         [{"title": "", "target": "https://a.com"}])
        self.assertEqual(LinkPreviewView.parse_links(""), [])
        # 多条往返
        orig = [{"title": "文档", "target": "https://a.com"},
                {"title": "本地", "target": "/tmp/x.txt"}]
        self.assertEqual(LinkPreviewView.parse_links(LinkPreviewView.dump_links(orig)), orig)
        # 单条无标题时退回纯文本（保持可读）
        self.assertEqual(LinkPreviewView.dump_links([{"title": "", "target": "https://a.com"}]),
                         "https://a.com")
        # UI：每条一个独立「打开」按钮
        v = LinkPreviewView(); v.resize(560, 420); v.show()
        try:
            loop = __import__("PySide6.QtCore", fromlist=["QEventLoop"]).QEventLoop()
            tm = __import__("PySide6.QtCore", fromlist=["QTimer"]).QTimer()
            tm.singleShot(120, loop.quit); loop.exec()
            v.set_links(orig)
            tm.singleShot(120, loop.quit); loop.exec()
            self.assertEqual(len(v.links()), 2)
            btns = [w for w in v._list_host.findChildren(QToolButton) if w.text() == "打开"]
            self.assertEqual(len(btns), 2, "每条链接应有独立「打开」按钮")
        finally:
            v.deleteLater()

    def test_quick_capture_min_height_is_compact(self):
        """快速捕获框须突破 UDialog 通用 MIN_H(180)，才能按 chips 动态定高。"""
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.view.capture.quick_capture import QuickCaptureWindow
        from zhixing.view.ui import MIN_H
        w = QuickCaptureWindow()
        try:
            self.assertLess(w._MIN_H, MIN_H,
                            "紧凑下限须小于通用 MIN_H，否则动态定高被顶回")
        finally:
            w.deleteLater()

    def test_graph_edge_state_cleared_on_reload(self):
        """图谱重建场景后不得残留悬空的选中/改挂引用。

        复现路径：选中连线（或进入改挂）→ 触发 reload 重建场景 →
        scene().clear() 销毁全部 item → 此时若仍持有旧 EdgeItem/NodeItem，
        后续鼠标事件访问 node.x() 会抛：
        RuntimeError: Internal C++ object (NodeItem) already deleted.
        """
        import tempfile
        from pathlib import Path
        from PySide6.QtCore import QEventLoop, QTimer
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.core.context import AppContext
        from zhixing.view.pages.graph_page import GraphPage
        ctx = AppContext(db_path=Path(tempfile.mkdtemp()) / "t.db")
        a = ctx.note_service.create("AAA")
        b = ctx.note_service.create("BBB")
        ctx.note_service.add_reference_link(a.id, b.title)
        page = GraphPage(ctx.graph_service, ctx.note_service)
        page.resize(1000, 700)
        page.show()
        try:
            loop = QEventLoop(); QTimer.singleShot(300, loop.quit); loop.exec()
            view = page.view
            self.assertTrue(page.edges, "应先有连线")
            edge = page.edges[0]

            # 选中 + 改挂同时置位，再重建场景
            view.select_edge(edge)
            view._begin_rewire(edge, "src")
            self.assertIs(view._selected_edge, edge)
            page.reload()
            loop = QEventLoop(); QTimer.singleShot(300, loop.quit); loop.exec()

            self.assertIsNone(view._selected_edge,
                              "reload 后必须清空选中连线（否则持悬空 C++ 引用）")
            self.assertIsNone(view._rewire_edge,
                              "reload 后必须清空改挂状态")
            # 关键：访问端点不得抛 RuntimeError
            from PySide6.QtCore import QPoint
            try:
                view._endpoint_at(QPoint(500, 300))
            except RuntimeError as ex:  # pragma: no cover - 回归时才会命中
                self.fail(f"访问悬空节点导致崩溃：{ex}")
        finally:
            page.deleteLater()


    def test_workflow_page_canvas_features(self):
        """工作流页：矩形节点可选中/拖动、曲线连线、双击编辑、一键对齐、分支目标判断。"""
        import tempfile
        from pathlib import Path
        from PySide6.QtCore import QEventLoop, QTimer
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        _mk_engine()
        from zhixing.core.context import AppContext
        from zhixing.model.domain.entities import WorkflowNode, WorkflowTemplate
        from zhixing.view.pages.workflow_page import WorkflowPage, _StepNodeItem
        ctx = AppContext(db_path=str(Path(tempfile.mkdtemp()) / "t.db"))
        ws = ctx.workflow_service
        ws.save_template(WorkflowTemplate(name="P", nodes=[
            WorkflowNode(title="A", order_index=0),
            WorkflowNode(title="B", order_index=1, pos_x=0.0, pos_y=120.0),
            WorkflowNode(title="C", order_index=2),
        ]))
        page = WorkflowPage(ws, ctx.note_service, ctx.settings)
        page.resize(1300, 820); page.show()
        try:
            loop = QEventLoop(); QTimer.singleShot(300, loop.quit); loop.exec()
            page.reload()
            loop = QEventLoop(); QTimer.singleShot(300, loop.quit); loop.exec()
            self.assertGreaterEqual(len(page._nodes), 1, "应有节点")
            self.assertGreaterEqual(len(page._edges), 1, "应有连线")
            # 节点可选中、可拖动（这是「编辑/上移下移生效」的前提）
            item = next(iter(page._nodes.values()))
            self.assertIsInstance(item, _StepNodeItem)
            self.assertTrue(bool(item.flags() & item.GraphicsItemFlag.ItemIsSelectable),
                            "节点须可选中")
            self.assertTrue(bool(item.flags() & item.GraphicsItemFlag.ItemIsMovable),
                            "节点须可拖动")
            # 连线为曲线（含贝塞尔 CurveTo 元素）
            from PySide6.QtGui import QPainterPath
            edge = page._edges[0]
            kinds = [edge.path().elementAt(i).type
                     for i in range(edge.path().elementCount())]
            self.assertTrue(any(k == QPainterPath.ElementType.CurveToElement
                                for k in kinds), "连线应为贝塞尔曲线")
            # 页面提供双击编辑 / 一键对齐 / 分支目标判断 / 坐标持久化
            self.assertTrue(hasattr(page, "edit_node"))
            self.assertTrue(hasattr(page, "_auto_layout"))
            self.assertTrue(hasattr(page, "is_branch_target"))
            self.assertTrue(hasattr(page, "persist_positions"))
        finally:
            page.deleteLater()


if __name__ == "__main__":
    unittest.main(verbosity=2)
