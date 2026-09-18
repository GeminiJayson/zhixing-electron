# -*- coding: utf-8 -*-
"""主动链接（链接面板需求）：正向引用/悬空待建/幂等/归属（任务+文件夹）的数据层单测。"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


class _ActiveLinksBase(unittest.TestCase):
    """内存库全链路：NoteService + EventBus 事件探针。"""

    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        from zhixing.core.event_bus import EventBus
        from zhixing.model.application.note_service import NoteService
        from zhixing.model.domain.entities import Task
        from zhixing.model.infrastructure.db import Database
        from zhixing.model.infrastructure.fts import FTSService
        from zhixing.model.infrastructure.repositories import (
            NoteLinkRepository, NoteRepository, TagRepository, TaskRepository,
        )
        self.db = Database()
        self.fts = FTSService(self.db)
        self.bus = EventBus()
        self.notes_repo = NoteRepository(self.db, self.fts)
        self.tasks_repo = TaskRepository(self.db, self.fts)
        self.svc = NoteService(self.db, self.bus, self.notes_repo,
                               NoteLinkRepository(self.db), TagRepository(self.db))
        self.events = {"links": [], "tasks": [], "structure": []}
        self.bus.note_links_changed.connect(lambda n: self.events["links"].append(n))
        self.bus.task_changed.connect(lambda tid, r: self.events["tasks"].append((tid, r)))
        self.bus.note_structure_changed.connect(
            lambda cid, op: self.events["structure"].append((cid, op)))

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    # ---------- helpers ----------
    def make_note(self, title, content=""):
        return self.svc.create(title=title, content_md=content)

    def make_task(self, title):
        from zhixing.model.domain.entities import Task
        s = self.db.session()
        try:
            t = self.tasks_repo.create(s, Task(title=title))
            s.commit()
        finally:
            s.close()
        return t


class TestOutgoingReferences(_ActiveLinksBase):

    def test_add_reference_by_id_and_idempotent(self):
        a = self.make_note("源笔记", "内容")
        b = self.make_note("目标笔记")
        self.assertEqual(self.svc.add_reference_link(a.id, b.id), "added")
        out = self.svc.outgoing_links(a.id)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].dst_note_id, b.id)
        self.assertEqual(out[0].dst_title, "目标笔记")
        self.assertEqual(len(self.svc.out_links(a.id)), 1, "旧名 out_links 应兼容")
        # 反向列表应能看到来源
        bl = self.svc.backlinks(b.id)
        self.assertEqual(len(bl), 1)
        self.assertEqual(bl[0].src_note_id, a.id)
        # 事件：note_links_changed(src)
        self.assertEqual(self.events["links"], [a.id])
        # 幂等：重复引用不建行、不发事件
        self.assertEqual(self.svc.add_reference_link(a.id, b.id), "duplicate")
        self.assertEqual(len(self.svc.outgoing_links(a.id)), 1)
        self.assertEqual(self.events["links"], [a.id])

    def test_self_and_invalid_targets(self):
        a = self.make_note("A")
        self.assertEqual(self.svc.add_reference_link(a.id, a.id), "self")
        self.assertEqual(self.svc.add_reference_link(a.id, "A"), "self")
        self.assertEqual(self.svc.add_reference_link(a.id, 99999), "invalid")
        self.assertEqual(self.svc.add_reference_link(a.id, "  "), "invalid")
        self.assertEqual(self.svc.add_reference_link(0, 1), "invalid")
        # 软删笔记不可被引用（回收站语义）
        b = self.make_note("B")
        self.svc.delete(b.id)
        self.assertEqual(self.svc.add_reference_link(a.id, b.id), "invalid")
        self.assertEqual(len(self.svc.outgoing_links(a.id)), 0)

    def test_by_title_links_existing_note(self):
        a = self.make_note("源")
        b = self.make_note("既存标题")
        self.assertEqual(self.svc.add_reference_link(a.id, "既存标题"), "added")
        out = self.svc.outgoing_links(a.id)
        self.assertEqual(out[0].dst_note_id, b.id)


class TestDanglingLinks(_ActiveLinksBase):

    def test_dangling_create_and_duplicate(self):
        a = self.make_note("源")
        self.assertEqual(self.svc.add_reference_link(a.id, "尚不存在的标题"), "dangling")
        row = self.svc.outgoing_links(a.id)[0]
        self.assertIsNone(row.dst_note_id, "未解析标题应存为悬空待建（dst_note_id=NULL）")
        self.assertEqual(row.dst_title, "尚不存在的标题")
        # 再次同标题：幂等提示，不重复建行
        self.assertEqual(self.svc.add_reference_link(a.id, "尚不存在的标题"), "duplicate")
        self.assertEqual(len(self.svc.outgoing_links(a.id)), 1)

    def test_dangling_binds_when_note_appears(self):
        a = self.make_note("源")
        self.svc.add_reference_link(a.id, "稍后创建的标题")
        b = self.make_note("稍后创建的标题")
        self.assertEqual(self.svc.add_reference_link(a.id, "稍后创建的标题"), "bound",
                         "悬空行遇到真实同名笔记应转正")
        out = self.svc.outgoing_links(a.id)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].dst_note_id, b.id)

    def test_materialize_dangling_creates_note(self):
        a = self.make_note("源")
        self.svc.add_reference_link(a.id, "全新主题")
        nid = self.svc.materialize_dangling(a.id, "全新主题")
        self.assertIsNotNone(nid)
        note = self.svc.get(nid)
        self.assertEqual(note.title, "全新主题")
        out = self.svc.outgoing_links(a.id)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].dst_note_id, nid, "转正后应绑定新建笔记 id")
        # dangling + bound 各一次链接事件
        self.assertEqual(self.events["links"].count(a.id), 2)

    def test_materialize_dangling_idempotent(self):
        a = self.make_note("源")
        b = self.make_note("已有笔记")
        self.assertEqual(self.svc.add_reference_link(a.id, "已有笔记"), "added")
        nid = self.svc.materialize_dangling(a.id, "已有笔记")
        self.assertEqual(nid, b.id, "同名笔记已存在时不新建，仅绑定")
        self.assertEqual(len(self.svc.outgoing_links(a.id)), 1)

    def test_broken_links_detects_dangling(self):
        a = self.make_note("源")
        self.svc.add_reference_link(a.id, "不存在的目标")
        broken = self.svc.broken_links()
        self.assertIn((a.id, "不存在的目标"), broken)

    def test_broken_links_excludes_resolvable_titles(self):
        a = self.make_note("源")
        self.make_note("真实目标")
        # dst_title 可解析到现存笔记时不应算失效（即便 dst_note_id 暂为 NULL）
        self.svc.add_reference_link(a.id, "真实目标")
        broken = self.svc.broken_links()
        self.assertNotIn((a.id, "真实目标"), broken)


class TestOwnershipAttach(_ActiveLinksBase):

    def test_attach_note_to_task_idempotent(self):
        a = self.make_note("笔记")
        t = self.make_task("跟进任务")
        self.assertEqual(self.svc.attach_note_to_task(t.id, a.id), "attached")
        self.assertEqual(self.svc.attach_note_to_task(t.id, a.id), "duplicate")
        owners = self.svc.attached_tasks(a.id)
        self.assertEqual(len(owners), 1)
        self.assertEqual(owners[0].id, t.id)
        self.assertEqual(self.events["tasks"].count((t.id, "updated")), 1,
                         "首次归属发 task_changed；重复归属不再发")

    def test_attach_note_to_task_invalid(self):
        a = self.make_note("笔记")
        t = self.make_task("任务")
        self.assertEqual(self.svc.attach_note_to_task(99999, a.id), "invalid")
        self.assertEqual(self.svc.attach_note_to_task(t.id, 99999), "invalid")

    def test_task_candidates(self):
        self.make_note("x")          # 笔记不是任务候选
        t1 = self.make_task("候选甲")
        t2 = self.make_task("候选乙")
        cands = self.svc.task_candidates("候选")
        self.assertEqual({c.title for c in cands}, {"候选甲", "候选乙"},
                         "只应命中标题含关键词的未完成任务")
        self.assertEqual([c.title for c in self.svc.task_candidates("甲")], ["候选甲"])

    def test_attach_note_to_folder_moves_and_detaches(self):
        a = self.make_note("待归档")
        f = self.svc.create_folder("归档夹")
        self.assertEqual(self.svc.attach_note_to_folder(a.id, f.id), "attached")
        self.assertEqual(self.svc.get(a.id).folder_id, f.id)
        self.assertEqual(self.svc.attach_note_to_folder(a.id, f.id), "unchanged")
        self.assertEqual(self.svc.attach_note_to_folder(a.id, 99999), "invalid",
                         "文件夹删除约束：目标不存在应拒绝")
        self.assertEqual(self.svc.attach_note_to_folder(a.id, None), "attached",
                         "folder_id=None 即移回「全部笔记」")
        self.assertIsNone(self.svc.get(a.id).folder_id)
        self.assertIn((a.id, "note_moved"), self.events["structure"])

    def test_attach_note_to_folder_validates_note(self):
        f = self.svc.create_folder("夹")
        self.assertEqual(self.svc.attach_note_to_folder(99999, f.id), "invalid")


class TestPipelineUnbroken(_ActiveLinksBase):

    def test_wiki_pipeline_and_manual_link_coexist(self):
        a = self.make_note("甲")
        b = self.make_note("乙")
        # 正文 [[甲]] 自动管线成链（保存链路不变）
        self.svc.save(b.id, content_md="参考 [[甲]] 来写")
        bl = self.svc.backlinks(a.id)
        self.assertEqual(len(bl), 1)
        self.assertEqual(bl[0].src_note_id, b.id)
        # 再手动补一条 a→乙：不与 uq_src_dst_title 冲突
        self.assertEqual(self.svc.add_reference_link(a.id, b.id), "added")
        self.assertEqual(len(self.svc.outgoing_links(a.id)), 1)
        # 再次保存正文（管线 replace）不崩、手动行不受影响（标题未出现在正文里也不删除）
        self.svc.save(b.id, content_md="参考 [[甲]] 来写")
        self.assertEqual(len(self.svc.backlinks(a.id)), 1)


class TestLinksPanelSmoke(unittest.TestCase):
    """链接面板 UI 冒烟：真实 NoteService + NotePage（offscreen）。"""

    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        from PySide6.QtWidgets import QApplication
        QApplication.instance() or QApplication([])
        from qfluent_core import ThemeManager as ThemeEngine
        eng = ThemeEngine()
        eng.apply("青竹", "light", "#0D9488")
        ThemeEngine.install(eng)   # 装成单例（原为属性赋值）
        from zhixing.core.event_bus import EventBus
        from zhixing.model.application.note_service import NoteService
        from zhixing.model.domain.entities import Task
        from zhixing.model.infrastructure.db import Database
        from zhixing.model.infrastructure.fts import FTSService
        from zhixing.model.infrastructure.repositories import (
            NoteLinkRepository, NoteRepository, TagRepository, TaskRepository,
        )
        self.db = Database()
        fts = FTSService(self.db)
        self.tasks_repo = TaskRepository(self.db, fts)
        self.svc = NoteService(self.db, EventBus(), NoteRepository(self.db, fts),
                               NoteLinkRepository(self.db), TagRepository(self.db))
        self.a = self.svc.create(title="源笔记", content_md="源正文")
        self.b = self.svc.create(title="目标笔记", content_md="目标正文")

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    def _open_page(self):
        from zhixing.view.pages.note_page import NotePage
        page = NotePage(self.svc, None)
        try:
            page.reload_folders()
            page.select_note(self.a.id)
            return page
        except Exception:
            page.deleteLater()
            raise

    def test_panel_shows_forward_back_and_ownership(self):
        page = self._open_page()
        try:
            self.assertEqual(page.link_tabs.tabText(0), "引用（0）")
            self.assertEqual(page.link_tabs.tabText(1), "反链（0）")
            self.assertEqual(page.link_tabs.tabText(2), "归属（0）")
            self.assertIn("还没有主动引用", page.out_body.text())

            # 手动加引用 → 正向列表 + 计数刷新
            self.assertEqual(self.svc.add_reference_link(self.a.id, self.b.id), "added")
            page._reload_backlinks(self.a.id)
            self.assertEqual(page.link_tabs.tabText(0), "引用（1）")
            self.assertIn("目标笔记", page.out_body.text())

            # 反链方向：目标笔记应显示来源
            page.select_note(self.b.id)
            self.assertEqual(page.link_tabs.tabText(1), "反链（1）")
            self.assertIn("源笔记", page.backlink_body.text())

            # 归属任务 → 归属分组出现任务行
            from zhixing.model.domain.entities import Task
            s = self.db.session()
            try:
                t = self.tasks_repo.create(s, Task(title="我的任务"))
                s.commit()
            finally:
                s.close()
            self.assertEqual(self.svc.attach_note_to_task(t.id, self.a.id), "attached")
            page.select_note(self.a.id)
            self.assertIn("我的任务", page.owner_body.text())
            self.assertEqual(page.link_tabs.tabText(2), "归属（1）")
        finally:
            page.deleteLater()

    def test_forward_anchor_emits_open(self):
        page = self._open_page()
        try:
            self.svc.add_reference_link(self.a.id, self.b.id)
            page._reload_backlinks(self.a.id)
            captured = []
            page.noteSelected.connect(captured.append)
            page._open_links_anchor(f"fwd:{self.b.id}")
            self.assertEqual(captured, [self.b.id], "正向真实链接点击应跳转到目标笔记")
        finally:
            page.deleteLater()


if __name__ == "__main__":
    unittest.main(verbosity=2)
