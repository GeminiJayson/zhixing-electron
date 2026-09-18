# -*- coding: utf-8 -*-
"""search_service 回归：due:today 过滤语法（F7-3）。"""
import os
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from zhixing.core.event_bus import EventBus
from zhixing.model.application.search_service import SearchService
from zhixing.model.application.task_service import TaskService
from zhixing.model.domain.entities import FolderKind, ListFolder
from zhixing.model.infrastructure.db import Database
from zhixing.model.infrastructure.fts import FTSService
from zhixing.model.infrastructure.repositories import (
    FlashRepository, ListFolderRepository, NoteRepository, TagRepository, TaskRepository,
)


class TestDueTodayFilter(unittest.TestCase):
    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        self.db = Database()
        self.bus = EventBus()
        fts = FTSService(self.db)
        self.tasks = TaskRepository(self.db, fts)
        self.notes = NoteRepository(self.db, fts)
        self.flashes = FlashRepository(self.db, fts)
        self.tags = TagRepository(self.db)
        self.folders = ListFolderRepository(self.db)
        self.tsvc = TaskService(self.db, self.bus, self.tasks, self.folders, self.tags)
        self.svc = SearchService(self.db, fts, self.tasks, self.notes, self.flashes,
                                 self.tags, folders=self.folders)

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    def test_due_today_only_returns_today(self):
        self.tsvc.create("今天到期", due=date.today())
        self.tsvc.create("明天到期", due=date.today() + timedelta(days=1))
        titles = [h.title for h in self.svc.global_search("due:today").task]
        self.assertIn("今天到期", titles)
        self.assertNotIn("明天到期", titles)

    def test_due_today_with_text_filter(self):
        self.tsvc.create("今天交报告", due=date.today())
        self.tsvc.create("今天交方案", due=date.today() + timedelta(days=1))
        titles = [h.title for h in self.svc.global_search("due:today 报告").task]
        self.assertIn("今天交报告", titles)
        self.assertNotIn("今天交方案", titles)

    def test_due_today_with_task_prefix(self):
        self.tsvc.create("今天到期", due=date.today())
        self.tsvc.create("明天到期", due=date.today() + timedelta(days=1))
        titles = [h.title for h in self.svc.global_search("task:due:today").task]
        self.assertIn("今天到期", titles)
        self.assertNotIn("明天到期", titles)

    def test_due_today_suffix_is_not_filter(self):
        # due:todayx 不应被当成 due:today 过滤词，仍应按普通文本搜索其它类型。
        from zhixing.model.domain.entities import Note
        n = Note(title="due:todayx", content_md="")
        s = self.db.session()
        try:
            self.notes.create(s, n)
            s.commit()
        finally:
            s.close()
        res = self.svc.global_search("due:todayx")
        self.assertIn("due:todayx", [h.title for h in res.note],
                      "带后缀的 due:todayx 应按普通文本搜索笔记，而非强制任务过滤")


class TestFolderFilter(unittest.TestCase):
    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        self.db = Database()
        self.bus = EventBus()
        fts = FTSService(self.db)
        self.tasks = TaskRepository(self.db, fts)
        self.notes = NoteRepository(self.db, fts)
        self.flashes = FlashRepository(self.db, fts)
        self.tags = TagRepository(self.db)
        self.folders = ListFolderRepository(self.db)
        self.tsvc = TaskService(self.db, self.bus, self.tasks, self.folders, self.tags)
        self.svc = SearchService(self.db, fts, self.tasks, self.notes, self.flashes,
                                 self.tags, folders=self.folders)

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    def _mk_folder(self, name, kind=FolderKind.LIST, parent_id=None):
        s = self.db.session()
        try:
            f = self.folders.create(s, ListFolder(name=name, kind=kind, parent_id=parent_id))
            s.commit()
            return f.id
        finally:
            s.close()

    def test_folder_filter_by_list_name(self):
        lid = self._mk_folder("工作")
        self.tsvc.create("写周报", list_id=lid)
        self.tsvc.create("买菜")          # 无列表
        titles = [h.title for h in self.svc.global_search("folder:工作").task]
        self.assertIn("写周报", titles)
        self.assertNotIn("买菜", titles)

    def test_folder_filter_with_quotes(self):
        lid = self._mk_folder("我的列表")
        self.tsvc.create("里面", list_id=lid)
        titles = [h.title for h in self.svc.global_search('folder:"我的列表"').task]
        self.assertIn("里面", titles)

    def test_folder_filter_group_includes_descendant_list(self):
        gid = self._mk_folder("项目", kind=FolderKind.GROUP)
        lid = self._mk_folder("子列表", kind=FolderKind.LIST, parent_id=gid)
        self.tsvc.create("子任务", list_id=lid)
        titles = [h.title for h in self.svc.global_search("folder:项目").task]
        self.assertIn("子任务", titles)

    def test_folder_filter_no_match_returns_empty(self):
        self.tsvc.create("无列表任务")
        titles = [h.title for h in self.svc.global_search("folder:不存在").task]
        self.assertEqual(titles, [])


class TestMruOrdering(unittest.TestCase):
    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        self.db = Database()
        self.bus = EventBus()
        fts = FTSService(self.db)
        self.tasks = TaskRepository(self.db, fts)
        self.notes = NoteRepository(self.db, fts)
        self.flashes = FlashRepository(self.db, fts)
        self.tags = TagRepository(self.db)
        self.folders = ListFolderRepository(self.db)
        self.tsvc = TaskService(self.db, self.bus, self.tasks, self.folders, self.tags)
        self.svc = SearchService(self.db, fts, self.tasks, self.notes, self.flashes,
                                 self.tags, folders=self.folders)

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    def test_mru_promotes_recently_touched(self):
        a = self.tsvc.create("AAA 任务")
        b = self.tsvc.create("BBB 任务")
        self.svc.touch("task", b)
        titles = [h.title for h in self.svc.global_search("任务").task]
        self.assertEqual(titles.index("BBB 任务"), 0)
        self.assertEqual(titles.index("AAA 任务"), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
