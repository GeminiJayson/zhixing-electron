# -*- coding: utf-8 -*-
"""P0 缺陷回归测试：挂笔记装配、命令面板导航、删除笔记悬空化引用。"""
import os
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


def _mk_app():
    """创建（或复用）offscreen QApplication，并装配 ThemeEngine.instance。"""
    from PySide6.QtWidgets import QApplication
    from qfluent_core import ThemeManager as ThemeEngine
    app = QApplication.instance() or QApplication([])
    inst = getattr(ThemeEngine, "instance", None)
    if not isinstance(inst, ThemeEngine):
        eng = ThemeEngine()
        eng.apply("青竹", "light", "#0D9488")
        ThemeEngine.install(eng)   # 装成单例（原为属性赋值）
    return app


def _make_note_service(db):
    from zhixing.core.event_bus import EventBus
    from zhixing.model.application.note_service import NoteService
    from zhixing.model.infrastructure.fts import FTSService
    from zhixing.model.infrastructure.repositories import (
        NoteLinkRepository, NoteRepository, TagRepository,
    )
    fts = FTSService(db)
    return NoteService(db, EventBus(), NoteRepository(db, fts),
                       NoteLinkRepository(db), TagRepository(db))


class TestTaskPageWiresNoteService(unittest.TestCase):
    def test_editor_receives_real_note_service(self):
        _mk_app()
        from zhixing.view.pages.task_page import TaskPage

        class _Dummy:
            pass

        task_service = _Dummy()
        note_service = _Dummy()
        page = TaskPage(task_service, note_service, None)
        try:
            self.assertIs(page.note_service, note_service)
            self.assertIs(page.editor.note_service, note_service,
                          "任务详情抽屉必须拿到真实 note_service，挂笔记才不早退")
        finally:
            page.deleteLater()


class TestCommandPaletteNavigation(unittest.TestCase):
    def test_non_command_hit_emits_activated(self):
        _mk_app()
        from PySide6.QtCore import Qt
        from PySide6.QtWidgets import QListWidgetItem
        from zhixing.model.application.search_service import SearchHit
        from zhixing.view.components.command_palette import CommandPalette

        palette = CommandPalette()
        try:
            seen = []
            palette.activated.connect(lambda kind, payload: seen.append((kind, payload)))
            hit = SearchHit("note", "某笔记", payload=123)
            palette._hits = [hit]
            item = QListWidgetItem(hit.title)
            item.setData(Qt.UserRole, 0)
            palette.list.addItem(item)
            palette.list.setCurrentRow(0)

            palette._run_current()
            self.assertEqual(seen, [("note", 123)],
                             "非命令命中应发出导航信号而不是静默无操作")
        finally:
            palette.deleteLater()


class TestNoteDeleteDanglesLinks(unittest.TestCase):
    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        from zhixing.model.infrastructure.db import Database
        self.db = Database()
        self.svc = _make_note_service(self.db)

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    def test_delete_note_turns_reference_into_dangling(self):
        target = self.svc.create(title="目标笔记", content_md="正文")
        src = self.svc.create(title="源笔记", content_md="见 [[目标笔记]]")

        s = self.db.session()
        try:
            links = self.svc.links.out_links(s, src.id)
        finally:
            s.close()
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0].dst_note_id, target.id)
        self.assertEqual(links[0].dst_title, "目标笔记")

        self.svc.delete(target.id)

        s = self.db.session()
        try:
            links = self.svc.links.out_links(s, src.id)
        finally:
            s.close()
        self.assertEqual(links[0].dst_note_id, None,
                         "删除目标笔记后，指向它的 note_link.dst_note_id 应悬空为 NULL")
        self.assertEqual(links[0].dst_title, "目标笔记",
                         "悬空后仍保留 dst_title，成「待建链接」态")

        from zhixing.model.application.graph_service import GraphService
        graph = GraphService(self.db, self.svc)
        data = graph.build()
        dangling_labels = [n.label for n in data.dangling]
        self.assertIn("目标笔记", dangling_labels,
                      "图谱应把失效引用渲染成待建链接节点，而不是丢弃")


if __name__ == "__main__":
    unittest.main(verbosity=2)
