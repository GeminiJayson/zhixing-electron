# -*- coding: utf-8 -*-
"""reminder_at 一次性定时提醒：到点查询、发完后清空、终态不触发。"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))

from zhixing.model.infrastructure.db import Database
from zhixing.model.infrastructure.fts import FTSService
from zhixing.model.application.task_service import TaskService
from zhixing.core.event_bus import EventBus
from zhixing.model.domain.entities import Task, TaskStatus


def _task_service(db) -> TaskService:
    fts = FTSService(db)
    from zhixing.model.infrastructure.repositories import (
        ListFolderRepository, TagRepository, TaskRepository,
    )
    return TaskService(db, EventBus(), TaskRepository(db, fts),
                       ListFolderRepository(db), TagRepository(db))


class TestReminderQuery(unittest.TestCase):
    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        self.db = Database()
        self.svc = _task_service(self.db)

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    def test_due_reminder_returned_and_dismissed(self):
        past = datetime.now() - timedelta(minutes=2)
        t = self.svc.create("下午开会", list_id=None)
        self.svc.update(t.id, reminder_at=past)
        now = datetime.now() + timedelta(seconds=1)
        due = self.svc.reminders_due(now)
        self.assertEqual([x.id for x in due], [t.id], "已到提醒应被列出")

        self.svc.dismiss_reminder(t.id)
        self.assertEqual(self.svc.reminders_due(now), [], "提醒发完后不再重复列出")
        after = self.svc.get(t.id)
        self.assertIsNone(after.reminder_at)

    def test_future_reminder_not_due(self):
        fut = datetime.now() + timedelta(hours=1)
        t = self.svc.create("明日提醒", list_id=None)
        self.svc.update(t.id, reminder_at=fut)
        self.assertEqual(self.svc.reminders_due(datetime.now() + timedelta(minutes=1)), [])

    def test_done_task_not_fired(self):
        past = datetime.now() - timedelta(minutes=2)
        t = self.svc.create("已完成也设置了提醒", list_id=None)
        self.svc.update(t.id, reminder_at=past)
        self.svc.set_status(t.id, TaskStatus.DONE)
        self.assertEqual(self.svc.reminders_due(datetime.now() + timedelta(seconds=1)), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
