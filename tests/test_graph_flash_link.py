# -*- coding: utf-8 -*-
"""图谱增强冒烟：闪念入图、双击跳转信号、拉线建链（headless offscreen）。"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


def _make_app():
    from PySide6.QtWidgets import QApplication
    from qfluent_core import ThemeManager as ThemeEngine
    app = QApplication.instance() or QApplication([])
    inst = getattr(ThemeEngine, "instance", None)
    if not isinstance(inst, ThemeEngine):
        eng = ThemeEngine()
        eng.apply("青竹", "light", "#0D9488")
        ThemeEngine.install(eng)   # 装成单例（原为属性赋值）
    return app


class TestGraphFlashAndLink(unittest.TestCase):
    def setUp(self):
        _make_app()
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()

        from zhixing.core.event_bus import EventBus
        from zhixing.model.application.flash_service import FlashService
        from zhixing.model.application.graph_service import GraphService
        from zhixing.model.application.note_service import NoteService
        from zhixing.model.application.task_service import TaskService
        from zhixing.model.infrastructure.db import Database
        from zhixing.model.infrastructure.fts import FTSService
        from zhixing.model.infrastructure.repositories import (
            FlashRepository, ListFolderRepository, NoteLinkRepository,
            NoteRepository, TagRepository, TaskRepository,
        )

        self.db = Database()
        self.bus = EventBus()
        self.fts = FTSService(self.db)
        note_repo = NoteRepository(self.db, self.fts)
        link_repo = NoteLinkRepository(self.db)
        flash_repo = FlashRepository(self.db, self.fts)
        tag_repo = TagRepository(self.db)
        self.note_service = NoteService(self.db, self.bus, note_repo, link_repo, tag_repo)
        self.flash_service = FlashService(self.db, self.bus, flash_repo, tag_repo)
        self.task_service = TaskService(self.db, self.bus,
                                        TaskRepository(self.db, self.fts),
                                        ListFolderRepository(self.db), tag_repo,
                                        notes=note_repo)
        self.graph = GraphService(self.db, self.note_service)

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    # ---------- 闪念入图 ----------
    def test_build_includes_note_and_flash_nodes(self):
        n = self.note_service.create(title="笔记甲", content_md="正文")
        f = self.flash_service.add("闪念内容第一行\n第二行")
        data = self.graph.build()
        notes = [x for x in data.nodes if x.kind == "note"]
        flashes = [x for x in data.nodes if x.kind == "flash"]
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0].label, "笔记甲")
        self.assertEqual(notes[0].ref_id, n.id)
        self.assertEqual(len(flashes), 1)
        self.assertEqual(flashes[0].label, "闪念内容第一行")
        self.assertEqual(flashes[0].ref_id, f.id)
        self.assertLess(flashes[0].id, 0, "闪念节点应落在负空间避免与笔记主键冲突")
        self.assertNotEqual(flashes[0].id, notes[0].id)

    def test_flash_label_truncates_first_line(self):
        self.flash_service.add(f"{'甲' * 60}\n第二行")
        data = self.graph.build()
        flash_node = next(x for x in data.nodes if x.kind == "flash")
        self.assertEqual(flash_node.label, "甲" * 40)

    def test_neighborhood_excludes_flash_nodes(self):
        a = self.note_service.create(title="A")
        b = self.note_service.create(title="B")
        self.graph.link_notes(a.id, b.id)
        self.flash_service.add("闪念")
        data = self.graph.neighborhood(a.id, 1)
        self.assertTrue(any(x.kind == "note" and x.ref_id == b.id for x in data.nodes))
        self.assertFalse(any(x.kind == "flash" for x in data.nodes),
                         "邻域子图是笔记中心视图，不应掺入闪念节点")

    # ---------- 拉线建链（复用 note_link） ----------
    def test_link_notes_creates_edge_and_is_idempotent(self):
        a = self.note_service.create(title="A")
        b = self.note_service.create(title="B")
        self.assertTrue(self.graph.link_notes(a.id, b.id))
        data = self.graph.build()
        self.assertIn([a.id, b.id], [list(e) for e in data.edges])
        self.assertTrue(self.graph.link_notes(a.id, b.id))
        data2 = self.graph.build()
        self.assertEqual(data2.edges.count([a.id, b.id]), 1, "重复拉线不应重复建边")

    def test_link_notes_resolves_dangling_link(self):
        a = self.note_service.create(title="A")
        b = self.note_service.create(title="B")
        s = self.db.session()
        try:
            from zhixing.model.infrastructure.models import NoteLinkRow
            s.add(NoteLinkRow(src_note_id=a.id, dst_note_id=None, dst_title="B"))
            s.commit()
        finally:
            s.close()
        self.graph.link_notes(a.id, b.id)
        data = self.graph.build()
        self.assertIn([a.id, b.id], [list(e) for e in data.edges])
        self.assertEqual([x for x in data.nodes if x.kind == "dangling"], [],
                         "手动建链应把同名悬空链接补全为真实边")

    def test_link_notes_rejects_self_and_missing(self):
        a = self.note_service.create(title="A")
        self.assertFalse(self.graph.link_notes(a.id, a.id))
        self.assertFalse(self.graph.link_notes(a.id, 999999))
        self.assertFalse(self.graph.link_notes(0, a.id))

    # ---------- 双击闪念 → flashOpenRequested ----------
    def test_graph_page_double_click_flash_emits_signal(self):
        f = self.flash_service.add("闪念标题")
        from zhixing.view.pages.graph_page import GraphPage
        page = GraphPage(self.graph, self.note_service)
        try:
            page.reload()
            flash_item = next(it for it in page.nodes.values()
                              if it.node.kind == "flash")
            got = []
            page.flashOpenRequested.connect(lambda fid: got.append(fid))
            from PySide6.QtCore import QEvent, Qt
            from PySide6.QtWidgets import QGraphicsSceneMouseEvent
            ev = QGraphicsSceneMouseEvent(QEvent.GraphicsSceneMouseDoubleClick)
            ev.setButton(Qt.LeftButton)
            flash_item.mouseDoubleClickEvent(ev)
            self.assertEqual(got, [f.id], "双击闪念节点应携带真实闪念主键发出信号")
        finally:
            page.deleteLater()

    # ---------- 拉线交互信号（view 层） ----------
    def test_graph_view_link_drag_emits_link_requested(self):
        a = self.note_service.create(title="A")
        b = self.note_service.create(title="B")
        from zhixing.view.pages.graph_page import GraphPage
        page = GraphPage(self.graph, self.note_service)
        try:
            page.reload()
            note_items = {it.node.ref_id: it for it in page.nodes.values()
                          if it.node.kind == "note"}
            got = []
            page.linkRequested.connect(lambda s, d: got.append((s, d)))
            page.view._begin_link(note_items[a.id])
            page.view._finish_link(note_items[b.id])
            self.assertEqual(got, [(a.id, b.id)], "笔记→笔记拉线应发出 linkRequested")

            # 闪念端点不建 note_link（不落地数据库）
            self.flash_service.add("闪念")
            page.reload()
            note_item = next(it for it in page.nodes.values() if it.node.kind == "note")
            flash_item = next(it for it in page.nodes.values() if it.node.kind == "flash")
            got.clear()
            page.view._begin_link(note_item)
            page.view._finish_link(flash_item)
            self.assertEqual(got, [], "闪念端点不应触发笔记建链")
        finally:
            page.deleteLater()


    # ---------- 任务↔笔记归属边渲染（需求①回归） ----------
    def test_task_note_edge_renders_ownership_solid(self):
        from PySide6.QtCore import Qt
        from zhixing.view.pages.graph_page import GraphPage
        note = self.note_service.create(title="N")
        task = self.task_service.create("T")
        self.task_service.attach_note(task.id, note.id)
        page = GraphPage(self.graph, self.note_service)
        try:
            page.reload()
            task_nid = next(it.node.id for it in page.nodes.values()
                            if it.node.kind == "task" and it.node.ref_id == task.id)
            edges = [e for e in page.edges
                     if {e.src.node.id, e.dst.node.id} == {task_nid, note.id}]
            self.assertEqual(len(edges), 1, "任务→笔记归属边应在图谱中被渲染")
            edge = edges[0]
            self.assertEqual(edge.kind, "ownership")
            self.assertEqual(edge.pen().style(), Qt.SolidLine,
                             "归属边应为实线，与引用虚线区分")
        finally:
            page.deleteLater()

    def test_edge_styles_distinguish_ownership_and_reference(self):
        from PySide6.QtCore import Qt
        from zhixing.view.pages.graph_page import GraphPage
        a = self.note_service.create(title="A")
        b = self.note_service.create(title="B")
        self.graph.link_notes(a.id, b.id)
        task = self.task_service.create("T")
        self.task_service.attach_note(task.id, a.id)
        page = GraphPage(self.graph, self.note_service)
        try:
            page.reload()
            own = next(e for e in page.edges if e.kind == "ownership")
            ref = next(e for e in page.edges if e.kind == "reference")
            self.assertEqual(own.pen().style(), Qt.SolidLine,
                             "归属边应为实线")
            self.assertEqual(ref.pen().style(), Qt.CustomDashLine,
                             "引用边应为自定义虚线")
            self.assertTrue(ref.pen().dashPattern(),
                            "引用边应带自定义虚线间隔（DashPattern 非空）")
        finally:
            page.deleteLater()


if __name__ == "__main__":
    unittest.main(verbosity=2)
