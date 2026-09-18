# -*- coding: utf-8 -*-
"""t1 后端数据层整改回归：JSON 全量、snooze、自定义 RRULE、归档、merge、番茄钟原因、
四象限/改期服务、任务 [[链接]] 解析。"""
import json
import os
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from zhixing.core.context import AppContext
from zhixing.model.domain.entities import FlashStatus, Priority, RepeatPeriod
from zhixing.model.domain.task_rules import next_due, next_recurrence, parse_rrule
from zhixing.model.infrastructure.db import Database
from zhixing.model.infrastructure.exporter import Importer
from zhixing.model.infrastructure.fts import FTSService
from zhixing.model.infrastructure.models import (
    AttachmentRow, FlashTagRow, NoteRevisionRow, PomodoroRow,
)
from zhixing.model.infrastructure.repositories import FlashRepository


class _Base(unittest.TestCase):
    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        self.ctx = AppContext()
        # 模拟控制器组合根接线（F4-3）：任务 notes_md [[链接]] 解析需要 note 解析器
        self.ctx.task_service.notes = self.ctx.note_repo

    def tearDown(self):
        try:
            self.ctx.db.engine.dispose()
        except Exception:
            pass


class TestJsonRoundtrip(_Base):
    def test_export_import_preserves_four_tables_and_note_meta(self):
        n = self.ctx.note_service.create(title="富文本", content_md="<p>你好</p>",
                                         format="richtext")
        self.ctx.note_service.save(n.id, content_md="<p>v2</p>")
        t = self.ctx.task_service.create("任务")
        self.ctx.task_service.set_tags(t.id, ["工作"])
        f = self.ctx.flash_service.add("闪念", source_url="https://example.com")
        self.ctx.flash_service.tag(f.id, ["资料"])

        s = self.ctx.db.session()
        try:
            s.add(AttachmentRow(note_id=n.id, path="/tmp/a.png", kind="image"))
            s.add(PomodoroRow(task_id=t.id, minutes=25, completed=True))
            s.commit()
        finally:
            s.close()

        path = Path(self.ctx.db.path).parent / "export.json"
        self.ctx.exporter.export_json(path)
        data = json.loads(path.read_text(encoding="utf-8"))
        for key in ("flash_tag", "note_revision", "attachment", "pomodoro_session"):
            self.assertIn(key, data, f"导出应包含 {key} 表")
            self.assertTrue(data[key], f"{key} 表应有数据")

        # 「清库 → 导入」：导入到全新空库，等价于清库后导入
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        db2 = Database()
        try:
            Importer(db2).import_json(path)
            s2 = db2.session()
            try:
                self.assertEqual(s2.query(FlashTagRow).count(), 1)
                self.assertEqual(s2.query(NoteRevisionRow).count(), 1)
                self.assertEqual(s2.query(AttachmentRow).count(), 1)
                self.assertEqual(s2.query(PomodoroRow).count(), 1)
                from zhixing.model.infrastructure.models import NoteRow
                imported = s2.query(NoteRow).filter(NoteRow.title == "富文本").first()
                self.assertIsNotNone(imported)
                self.assertEqual(imported.format, "richtext")
                self.assertIsNotNone(imported.created_at, "note.created_at 应在导入后保留")
                self.assertIsNotNone(imported.updated_at, "note.updated_at 应在导入后保留")
            finally:
                s2.close()
        finally:
            db2.engine.dispose()


class TestSnooze(_Base):
    def test_snooze_extends_reminder_by_minutes(self):
        t = self.ctx.task_service.create("提醒")
        self.ctx.task_service.update(t.id, reminder_at=datetime.now())
        self.ctx.task_service.snooze(t.id, 15)
        after = self.ctx.task_service.get(t.id)
        self.assertIsNotNone(after.reminder_at)
        self.assertGreater(after.reminder_at, datetime.now() + timedelta(minutes=14))


class TestCustomRrule(_Base):
    def test_parse_rrule_subset(self):
        info = parse_rrule("FREQ=DAILY;INTERVAL=2;COUNT=3;UNTIL=20260910")
        self.assertEqual(info["freq"], RepeatPeriod.DAILY)
        self.assertEqual(info["interval"], 2)
        self.assertEqual(info["count"], 3)
        self.assertEqual(info["until"], date(2026, 9, 10))
        self.assertIsNone(parse_rrule(""))

    def test_next_due_custom_interval_and_until(self):
        self.assertEqual(next_due(date(2026, 9, 2), RepeatPeriod.CUSTOM,
                                  "FREQ=DAILY;INTERVAL=2"), date(2026, 9, 4))
        self.assertIsNone(next_due(date(2026, 9, 2), RepeatPeriod.CUSTOM,
                                   "FREQ=DAILY;UNTIL=20260902"),
                          "until 已到/超限应终止循环")

    def test_toggle_complete_clones_fields_tags_and_subtasks(self):
        t = self.ctx.task_service.create("每日站会", repeat=RepeatPeriod.DAILY,
                                         due=date.today())
        self.ctx.task_service.update(t.id, start_date=date.today(),
                                     reminder_at=datetime.now())
        self.ctx.task_service.set_tags(t.id, ["例行"])
        sub = self.ctx.task_service.add_subtask(t.id, "准备议程")
        self.ctx.task_service.set_tags(sub.id, ["准备"])

        self.ctx.task_service.toggle_complete(t.id)
        roots = [x for x in self.ctx.task_service.all_tree() if x.title == "每日站会"]
        self.assertEqual(len(roots), 2, "完成后应克隆出一个新的循环任务")
        clone = next(x for x in roots if not x.is_done)
        self.assertNotEqual(clone.id, t.id)
        self.assertEqual(clone.start_date, date.today(), "克隆应补全 start_date")
        self.assertIsNotNone(clone.reminder_at, "克隆应补全 reminder_at")
        tag_map = self.ctx.task_service.tag_map([clone.id])
        self.assertEqual([n for (_tid, n, _c) in tag_map.get(clone.id, [])], ["例行"],
                         "克隆应补全标签")
        self.assertEqual([c.title for c in clone.children], ["准备议程"],
                         "克隆应补全子任务")

    def test_custom_rrule_count_terminates_chain(self):
        t = self.ctx.task_service.create("隔天任务", repeat=RepeatPeriod.CUSTOM,
                                         repeat_rule="FREQ=DAILY;INTERVAL=2;COUNT=2",
                                         due=date.today())
        self.ctx.task_service.toggle_complete(t.id)
        clones = [x for x in self.ctx.task_service.all_tree()
                  if x.title == "隔天任务" and not x.is_done]
        self.assertEqual(len(clones), 1)
        clone = clones[0]
        self.assertEqual(clone.repeat_rule, "FREQ=DAILY;INTERVAL=2;COUNT=1")
        self.assertEqual(clone.due_date, date.today() + timedelta(days=2))
        self.ctx.task_service.toggle_complete(clone.id)
        remaining = [x for x in self.ctx.task_service.all_tree()
                     if x.title == "隔天任务" and not x.is_done]
        self.assertEqual(remaining, [], "COUNT 耗尽后不应再克隆")


class TestFlashArchive(_Base):
    def test_archive_write_path_and_query(self):
        f = self.ctx.flash_service.add("闪念")
        self.ctx.flash_service.archive(f.id)
        self.assertEqual(self.ctx.flash_service.get(f.id).status, FlashStatus.ARCHIVED)
        self.assertIn(f.id, [x.id for x in self.ctx.flash_service.archived()])
        self.assertNotIn(f.id, [x.id for x in self.ctx.flash_service.list(FlashStatus.INBOX)])
        self.ctx.flash_service.unarchive(f.id)
        self.assertEqual(self.ctx.flash_service.get(f.id).status, FlashStatus.INBOX)


class TestFlashMerge(_Base):
    def test_merge_combines_tags_and_source_url_and_soft_deletes(self):
        a = self.ctx.flash_service.add("A", source_url="https://a.example")
        b = self.ctx.flash_service.add("B", source_url="https://b.example")
        self.ctx.flash_service.tag(a.id, ["甲"])
        self.ctx.flash_service.tag(b.id, ["乙"])
        m = self.ctx.flash_service.merge([a.id, b.id])
        self.assertEqual(m.source_url, "https://a.example", "合并应保留首个非空 source_url")
        s = self.ctx.db.session()
        try:
            ids = self.ctx.flash_repo.tag_ids(s, m.id)
            names = sorted(name for (tid, name, _c) in self.ctx.tag_repo.all(s)
                           if tid in set(ids))
        finally:
            s.close()
        self.assertEqual(names, ["乙", "甲"], "合并应并集所有标签")
        self.assertIsNotNone(self.ctx.flash_service.get(a.id).deleted_at,
                             "被合并的源闪念应软删除")
        self.assertIsNotNone(self.ctx.flash_service.get(b.id).deleted_at)


class TestPomodoroReason(_Base):
    def test_pomodoro_reason_persisted(self):
        t = self.ctx.task_service.create("专注")
        s = self.ctx.db.session()
        try:
            self.ctx.pomodoro_repo.add(s, t.id, 25, False, "被打断")
            s.commit()
        finally:
            s.close()
        s = self.ctx.db.session()
        try:
            row = s.query(PomodoroRow).first()
            self.assertEqual(row.reason, "被打断")
            self.assertFalse(row.completed)
        finally:
            s.close()


class TestDragServices(_Base):
    def test_change_quadrant_and_reschedule(self):
        t = self.ctx.task_service.create("任务")
        self.ctx.task_service.change_quadrant(t.id, Priority.HIGH,
                                              date.today() + timedelta(days=2))
        after = self.ctx.task_service.get(t.id)
        self.assertEqual(after.priority, Priority.HIGH)
        self.assertEqual(after.due_date, date.today() + timedelta(days=2))
        self.ctx.task_service.reschedule(t.id, date.today() + timedelta(days=5))
        self.assertEqual(self.ctx.task_service.get(t.id).due_date,
                         date.today() + timedelta(days=5))


class TestTaskWikiLinks(_Base):
    def test_task_notes_md_resolves_wiki_links(self):
        n = self.ctx.note_service.create(title="周报模板", content_md="模板")
        t = self.ctx.task_service.create("写周报", notes_md="参考 [[周报模板]]")
        self.assertIn(n.id, [x.id for x in self.ctx.task_service.linked_notes(t.id)],
                      "任务 notes_md 的 [[链接]] 应落链到对应笔记")

        n2 = self.ctx.note_service.create(title="会议记录", content_md="记录")
        self.ctx.task_service.update(t.id, notes_md="参考 [[周报模板]] 和 [[会议记录]]")
        linked = {x.id for x in self.ctx.task_service.linked_notes(t.id)}
        self.assertIn(n2.id, linked, "更新 notes_md 后应增量解析新 [[链接]]")


if __name__ == "__main__":
    unittest.main(verbosity=2)
