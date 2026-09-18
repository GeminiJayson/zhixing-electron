# -*- coding: utf-8 -*-
"""业务规则单测（对齐 v0.5 MVC model/domain，不依赖 Qt / 图形环境）。

由 v0.3 时代测已删 zhixing.domain(Project/Resource/cycle_subtasks/content)
的旧版重写而来：现只引用仍存活的 domain API，覆盖点经由真实行为探针校准。
"""
import os
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import Date

from zhixing.model.domain.capture_grammar import parse, due_from_word
from zhixing.model.domain.link_parser import extract_links, snippet_around, first_heading
from zhixing.model.domain.entities import Priority, TaskStatus, RepeatPeriod, Task
from zhixing.model.domain.task_rules import (
    next_due, advance_recurrence, parse_natural_date, subtask_progress,
)
from zhixing.model.infrastructure.models import TaskRow


class TestCaptureGrammar(unittest.TestCase):
    def test_parse_tokens(self):
        r = parse("交付方案 !2 @工作 #客户 #效率")
        self.assertEqual(r.title, "交付方案")
        self.assertIs(r.priority, Priority.MID)
        self.assertEqual(r.list_name, "工作")
        self.assertEqual(r.tags, ["客户", "效率"])
        self.assertIsNone(r.due_word)
        self.assertTrue(r.has_meta)

    def test_parse_priority_end(self):
        r = parse("买牛奶 !1")
        self.assertIs(r.priority, Priority.HIGH)
        self.assertEqual(r.title, "买牛奶")

    def test_parse_date_token(self):
        r = parse("明天 交周报")
        self.assertEqual(r.due_word, "明天")
        self.assertEqual(r.title, "交周报")

    def test_parse_empty(self):
        r = parse("   ")
        self.assertEqual(r.title, "")

    def test_due_from_word_resolves_relative(self):
        d = due_from_word("明天", today=date(2026, 9, 2))
        self.assertEqual(d, date(2026, 9, 3))


class TestLinkParser(unittest.TestCase):
    def test_extract_links(self):
        md = "见 [[周报模板]] 和 [[工作/笔记]]"
        self.assertEqual(extract_links(md), ["周报模板", "工作/笔记"])

    def test_snippet_keeps_context(self):
        md = "长文" * 30 + "关键字锚点" + "其余" * 30
        snip = snippet_around(md, "关键字", radius=12)
        self.assertIn("锚点", snip)
        self.assertLessEqual(len(snip), 120)

    def test_first_heading_pick_and_fallback(self):
        self.assertEqual(first_heading("# 记得", fallback="无标题"), "记得")
        self.assertEqual(first_heading("没有标记正文", fallback="无标题"), "无标题")


class TestTaskRecurrence(unittest.TestCase):
    def test_next_due_daily(self):
        base = date(2026, 9, 2)
        self.assertEqual(next_due(base, RepeatPeriod.DAILY), date(2026, 9, 3))

    def test_next_due_weekly(self):
        base = date(2026, 9, 2)
        self.assertEqual(next_due(base, RepeatPeriod.WEEKLY), date(2026, 9, 9))

    def test_advance_recurrence_keeps_none(self):
        t = Task(id=1, title="一次性")
        self.assertIsNone(advance_recurrence(t))

    def test_natural_date_relative(self):
        self.assertEqual(parse_natural_date("明天", today=date(2026, 9, 2)), date(2026, 9, 3))
        self.assertIsNone(parse_natural_date("", today=date(2026, 9, 2)))

    def test_subtask_progress(self):
        done = Task(id=2, title="d", status=TaskStatus.DONE)
        todo = Task(id=3, title="t")
        self.assertEqual(subtask_progress([done, todo, Task(id=4, status=TaskStatus.DONE)]),
                         (2, 3))


class TestTaskStartDate(unittest.TestCase):
    """Task 实体与 TaskRow ORM 均包含可空的 start_date（V2 迁移落地的字段）。"""

    def test_domain_task_defaults_start_date_none(self):
        t = Task(title="写周报")
        self.assertIsNone(t.start_date)
        self.assertIsNone(t.due_date)

    def test_task_row_has_nullable_date_column(self):
        col = TaskRow.__table__.c.start_date
        self.assertIsInstance(col.type, Date)
        self.assertTrue(col.nullable)


if __name__ == "__main__":
    unittest.main(verbosity=2)
