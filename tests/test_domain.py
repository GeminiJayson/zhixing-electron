# -*- coding: utf-8 -*-
"""domain 规则与 FTS/仓储 集成测试（无 GUI）。"""
import os
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from zhixing.model.domain.entities import (
    FolderKind, Priority, RepeatPeriod, Task, TaskStatus,
)
from zhixing.model.domain.task_rules import (
    advance_recurrence, effective_done_map, next_due, parse_natural_date,
    parse_clock, parse_natural_datetime,
    roll_recurring_subtasks, today_roots,
)
from zhixing.model.domain.link_parser import extract_links, snippet_around
from zhixing.model.domain.capture_grammar import parse, due_from_word


class TestTaskRules(unittest.TestCase):
    def test_next_due(self):
        d = date(2026, 9, 2)
        self.assertEqual(next_due(d, RepeatPeriod.DAILY), date(2026, 9, 3))
        self.assertEqual(next_due(d, RepeatPeriod.WEEKLY), date(2026, 9, 9))
        self.assertEqual(next_due(date(2026, 1, 31), RepeatPeriod.MONTHLY), date(2026, 2, 28))

    def test_advance_recurrence(self):
        t = Task(title="x", repeat_period=RepeatPeriod.WEEKLY, due_date=date(2026, 9, 2))
        self.assertEqual(advance_recurrence(t), date(2026, 9, 9))
        t2 = Task(title="x", repeat_period=RepeatPeriod.NONE)
        self.assertIsNone(advance_recurrence(t2))

    def test_parse_natural_date(self):
        today = date(2026, 9, 2)  # 周三
        self.assertEqual(parse_natural_date("今天", today), today)
        self.assertEqual(parse_natural_date("明天", today), date(2026, 9, 3))
        self.assertEqual(parse_natural_date("周五", today), date(2026, 9, 4))
        self.assertEqual(parse_natural_date("9月10日", today), date(2026, 9, 10))
        self.assertIsNone(parse_natural_date("随便说的", today))
        # 今日恰为该周几："周三" 应指今天，而非被推到 7 天后的下周三（回归修复）
        self.assertEqual(parse_natural_date("周三", today), today)
        self.assertEqual(parse_natural_date("周六", today), date(2026, 9, 5))

    def test_roll_recurring_subtasks(self):
        today = date(2026, 9, 2)
        done = Task(id=1, title="锻炼", parent_id=9, status=TaskStatus.DONE,
                    repeat_period=RepeatPeriod.DAILY, due_date=today - timedelta(days=1))
        fresh = Task(id=2, title="阅读", parent_id=9, status=TaskStatus.TODO,
                     repeat_period=RepeatPeriod.DAILY, last_reset_date=today)
        reset_ids = roll_recurring_subtasks([done, fresh], today)
        self.assertIn(1, reset_ids)
        self.assertEqual(done.status, TaskStatus.TODO)
        self.assertEqual(done.last_reset_date, today)
        self.assertNotIn(2, reset_ids)


class TestEffectiveDoneRollup(unittest.TestCase):
    """有效完成递归判定（roll-up）与今日待办根集合的纯领域规则。"""

    @staticmethod
    def _task(tid, status=TaskStatus.TODO, parent_id=None, children=None):
        t = Task(id=tid, title=f"t{tid}", status=status, parent_id=parent_id)
        t.children = children or []
        return t

    def test_leaf_effective_done_is_own_done(self):
        self.assertTrue(effective_done_map([self._task(1, TaskStatus.DONE)])[1])
        self.assertFalse(effective_done_map([self._task(2, TaskStatus.DOING)])[2])
        self.assertFalse(effective_done_map([self._task(3, TaskStatus.TODO)])[3])

    def test_parent_effective_done_requires_all_children(self):
        c1 = self._task(2, TaskStatus.DONE, parent_id=1)
        c2 = self._task(3, TaskStatus.TODO, parent_id=1)
        p = self._task(1, TaskStatus.DOING, children=[c1, c2])
        self.assertFalse(effective_done_map([p])[1])
        c2.status = TaskStatus.DONE
        self.assertTrue(effective_done_map([p])[1],
                        "子全完成时父应有效完成，即便父自身 status=doing")

    def test_three_level_rollup(self):
        leaf = self._task(3, TaskStatus.TODO, parent_id=2)
        mid = self._task(2, TaskStatus.TODO, parent_id=1, children=[leaf])
        top = self._task(1, TaskStatus.DOING, children=[mid])
        self.assertFalse(effective_done_map([top])[1],
                         "任一后代未完成 → 顶层父有效未完成")
        leaf.status = TaskStatus.DONE
        mid.status = TaskStatus.DONE
        self.assertTrue(effective_done_map([top])[1])

    def test_today_roots_rule(self):
        today = date(2026, 9, 2)
        no_due = self._task(1)
        done = self._task(2, TaskStatus.DONE)
        due_today = self._task(3)
        due_today.due_date = today
        overdue = self._task(4)
        overdue.due_date = today - timedelta(days=1)
        start_only = self._task(5)
        start_only.start_date = today
        roots = today_roots([no_due, done, due_today, overdue, start_only], today)
        self.assertEqual({t.id for t in roots}, {1, 3, 5},
                         "无日期/仅开始/截止今天且未完成 → 今日；已完成/逾期 → 不进今日")


class TestLinkParser(unittest.TestCase):
    def test_extract_links(self):
        md = "看 [[PySide6 信号槽]] 和 [[SQLite WAL]]，重复 [[PySide6 信号槽]]。\n`[[不解析]]`"
        self.assertEqual(extract_links(md), ["PySide6 信号槽", "SQLite WAL"])

    def test_snippet(self):
        md = "今天 " + "x" * 50 + " [[核心节点]] 在中间 " + "y" * 50
        s = snippet_around(md, "核心节点")
        self.assertIn("核心节点", s)
        self.assertTrue(s.startswith("…"))


class TestCaptureGrammar(unittest.TestCase):
    def test_full(self):
        p = parse("周五前 交付方案 !2 @工作 #客户 #重要")
        self.assertEqual(p.title, "交付方案")
        self.assertEqual(int(p.priority), 5)  # !2 → MID=P5（v0.17 8 级）
        self.assertEqual(p.list_name, "工作")
        self.assertIn("客户", p.tags)
        self.assertIn("重要", p.tags)
        self.assertIsNotNone(due_from_word(p.due_word))

    # ---- P0-2: 时刻解析（「明天3点」→ due_date + reminder clock） ----
    def test_parse_clock_24h(self):
        self.assertEqual(parse_clock("14:30"), (14, 30))
        self.assertEqual(parse_clock("9:05"), (9, 5))
        self.assertIsNone(parse_clock("25:00"))

    def test_parse_clock_chinese(self):
        self.assertEqual(parse_clock("3点"), (15, 0))            # 无修饰口语=下午
        self.assertEqual(parse_clock("3点半"), (15, 30))
        self.assertEqual(parse_clock("3点45分"), (15, 45))
        self.assertEqual(parse_clock("下午5点"), (17, 0))
        self.assertEqual(parse_clock("晚上8点"), (20, 0))
        self.assertEqual(parse_clock("中午12点半"), (12, 30))
        self.assertEqual(parse_clock("凌晨2点"), (2, 0))
        self.assertEqual(parse_clock("早上9点"), (9, 0))

    def test_parse_natural_datetime(self):
        today = date(2026, 9, 8)   # 周二
        d, clock = parse_natural_datetime("明天3点", today)
        self.assertEqual(d, date(2026, 9, 9))
        self.assertEqual(clock, (15, 0))
        d, clock = parse_natural_datetime("明天下午3点半", today)
        self.assertEqual((d, clock), (date(2026, 9, 9), (15, 30)))
        d, clock = parse_natural_datetime("周五前", today)
        self.assertEqual(d, date(2026, 9, 11))
        self.assertIsNone(clock)
        d, clock = parse_natural_datetime("明天 14:30", today)
        self.assertEqual((d, clock), (date(2026, 9, 9), (14, 30)))
        self.assertIsNone(parse_natural_datetime("随便说说", today))

    def test_capture_with_clock(self):
        today = date(2026, 9, 8)
        p = parse("明天3点 交周报 !2", today=today)
        self.assertEqual(p.title, "交周报")
        self.assertEqual(p.due_clock, (15, 0))
        self.assertEqual(due_from_word(p.due_word, today), date(2026, 9, 9))
        # 纯日期短语不带 clock
        p2 = parse("周五前 交付方案", today=today)
        self.assertIsNone(p2.due_clock)
        self.assertEqual(p2.title, "交付方案")

    def test_plain(self):
        p = parse("只是一个普通任务")
        self.assertEqual(p.title, "只是一个普通任务")
        self.assertEqual(int(p.priority), 0)
        self.assertFalse(p.has_meta)


class TestPersistence(unittest.TestCase):
    """内存库全链路：任务/笔记/链接/反链/FTS。"""

    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        from zhixing.model.infrastructure.db import Database
        from zhixing.model.infrastructure.fts import FTSService
        from zhixing.model.infrastructure.repositories import (
            FlashRepository, ListFolderRepository, NoteLinkRepository, NoteRepository,
            TagRepository, TaskRepository,
        )
        self.db = Database()
        self.fts = FTSService(self.db)
        self.tasks = TaskRepository(self.db, self.fts)
        self.notes = NoteRepository(self.db, self.fts)
        self.links = NoteLinkRepository(self.db)
        self.folders = ListFolderRepository(self.db)
        self.tags = TagRepository(self.db)

    def test_full_flow(self):
        s = self.db.session()
        try:
            f = self.folders.create(s, __import__(
                "zhixing.model.domain.entities", fromlist=["ListFolder"]).ListFolder(
                name="我的清单", kind=FolderKind.LIST))
            t = Task(title="写周报", list_id=f.id, priority=Priority.HIGH)
            self.tasks.create(s, t)
            sub = Task(title="整理要点", parent_id=t.id, list_id=f.id)
            self.tasks.create(s, sub)
            s.commit()
            # 笔记 + 链接管线
            n1 = self.notes.create(s, __import__(
                "zhixing.model.domain.entities", fromlist=["Note"]).Note(
                title="周报模板", content_md="模板内容"))
            n2 = self.notes.create(s, __import__(
                "zhixing.model.domain.entities", fromlist=["Note"]).Note(
                title="工作笔记", content_md="参考 [[周报模板]] 进行"))
            s.commit()
            self.links.replace_links(s, n2.id, extract_links(n2.content_md),
                                     lambda title: self.notes.by_title(s, title).id
                                     if self.notes.by_title(s, title) else None)
            s.commit()
            bl = self.links.backlinks(s, n1.id, self.notes)
            self.assertEqual(len(bl), 1)
            self.assertEqual(bl[0].src_title, "工作笔记")
            # FTS 中文搜索（jieba 或按字回退都应命中）
            ids = self.fts.search(s, "note", "周报模板")
            self.assertTrue(any(nid == n1.id for nid, _r in ids))
            ids2 = self.fts.search(s, "task", "周报")
            self.assertTrue(any(tid == t.id for tid, _r in ids2))
        finally:
            s.close()

    def test_soft_delete(self):
        s = self.db.session()
        try:
            t = Task(title="待删除")
            self.tasks.create(s, t)
            s.commit()
            # 软删后：list_all 不可见，get 仍返回带 deleted_at 的行
            self.tasks.soft_delete(s, t.id)
            s.commit()
            row = self.tasks.get(s, t.id)
            self.assertIsNotNone(row)
            self.assertIsNotNone(row.deleted_at)
            self.assertEqual(len(self.tasks.list_all(s)), 0)
            self.tasks.restore(s, t.id)
            s.commit()
            self.assertEqual(len(self.tasks.list_all(s)), 1)
        finally:
            s.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestDeepLink(unittest.TestCase):
    """v0.15 P1-4：zhixing:// 深链解析（纯函数）。"""

    def test_parse_kinds(self):
        from zhixing.core.deep_link import parse_url
        self.assertEqual(parse_url("zhixing://task/42"),
                         {"kind": "task", "id": 42, "block": ""})
        self.assertEqual(parse_url("zhixing://note/7?block=fp:abc123"),
                         {"kind": "note", "id": 7, "block": "fp:abc123"})
        self.assertEqual(parse_url("zhixing://flash/3")["kind"], "flash")
        self.assertEqual(parse_url("zhixing://folder/2")["kind"], "folder")
        self.assertEqual(parse_url("zhixing://note/5")["block"], "")

    def test_parse_rejects_bad(self):
        from zhixing.core.deep_link import parse_url
        for bad in ("zhixing://foo/1", "zhixing://task/0", "zhixing://task/-3",
                    "https://x/y", "", "zhixing://note/abc"):
            self.assertIsNone(parse_url(bad), bad)

    def test_extract_argv(self):
        from zhixing.core.deep_link import extract_argv
        self.assertEqual(extract_argv(["python", "-m", "zhixing", "zhixing://task/42"]),
                         "zhixing://task/42")
        self.assertIsNone(extract_argv(["python", "-m", "zhixing"]))
