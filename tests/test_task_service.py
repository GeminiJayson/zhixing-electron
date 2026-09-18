# -*- coding: utf-8 -*-
"""task_service 业务回归：打卡 streak 累计、列表树孤儿、reorder 稳定。"""
import os
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from zhixing.core.event_bus import EventBus
from zhixing.model.application.task_service import TaskService
from zhixing.model.domain.entities import (
    FolderKind, ListFolder, RepeatPeriod, Task, TaskStatus,
)
from zhixing.model.infrastructure.db import Database
from zhixing.model.infrastructure.fts import FTSService
from zhixing.model.infrastructure.models import TaskRow
from zhixing.model.infrastructure.repositories import (
    ListFolderRepository, TagRepository, TaskRepository,
)


def _make_service(db) -> TaskService:
    fts = FTSService(db)
    return TaskService(db, EventBus(), TaskRepository(db, fts),
                       ListFolderRepository(db), TagRepository(db))


def _make_list(svc, name="工作") -> int:
    f = ListFolder(name=name, kind=FolderKind.LIST)
    return svc.create_folder(name, kind=FolderKind.LIST).id


class TestCheckinStreak(unittest.TestCase):
    """循环子任务「昨日已勾选 → 今早重置」应累计连续 streak（回归修复）。"""

    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        self.db = Database()
        self.svc = _make_service(self.db)

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    def _make_checkin_sub(self, label: str):
        """父清单 + 一个昨天已完成、前天为重置基线的每日循环子任务。"""
        lid = _make_list(self.svc)
        parent = self.svc.create("晨间流程", list_id=lid)
        t = self.svc.create(label, list_id=lid, parent_id=parent.id,
                            repeat=RepeatPeriod.DAILY)
        today = date.today()
        # 前天已做、昨完成 → 今 early 应把昨完成计入 streak 并重置回 待办。
        self.svc.update(t.id, status=TaskStatus.DONE,
                        last_reset_date=today - timedelta(days=1),
                        due_date=today - timedelta(days=1) or today)
        return t

    def test_completed_prev_day_adds_streak(self):
        t = self._make_checkin_sub("喝水")
        self.assertEqual(t.streak, 0)
        # 触发 roll（内部用 date.today()），应把「昨日已勾选」+1 并重置为待办。
        self.svc.roll_recurring_today()
        after = self.svc.get(t.id)
        self.assertEqual(after.streak, 1,
                         "昨日勾选的打卡子任务重置后应累计连续 streak")
        self.assertEqual(after.status, TaskStatus.TODO, "到期应重置回待办")

    def test_same_day_already_reset_no_double(self):
        t = self._make_checkin_sub("锻炼")
        self.svc.update(t.id, status=TaskStatus.DONE,
                        last_reset_date=date.today())
        self.svc.roll_recurring_today()
        after = self.svc.get(t.id)
        self.assertEqual(after.streak, 0, "当天已重置过不应重复累加")


class TestListTreeTree(unittest.TestCase):
    """列表树不应把子任务误判为孤儿（回归修复）。"""

    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        self.db = Database()
        self.svc = _make_service(self.db)

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    def test_list_keeps_child_even_if_child_moved_elsewhere(self):
        lid = _make_list(self.svc)
        parent = self.svc.create("带子任务", list_id=lid)
        child = self.svc.add_subtask(parent.id, "真实子任务")
        # 子任务被单独移到未归属（list_id=None）。
        self.svc.update(child.id, list_id=None)

        tree = self.svc.list_tree(lid)
        self.assertEqual(len(tree), 1, "列表视图应只含一个顶层任务")
        self.assertEqual(tree[0].id, parent.id)
        child_ids = {c.id for c in tree[0].children}
        self.assertIn(child.id, child_ids,
                      "子任务即使自身 list_id 变更也应保留在其父下，不得成孤儿")


class TestReorderStable(unittest.TestCase):
    """reorder 拖拽排序稳定、无多余死 session（回归修复）。"""

    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        self.db = Database()
        self.svc = _make_service(self.db)

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    def test_reorder_persists_relative_order(self):
        lid = _make_list(self.svc)
        a, b, c = (self.svc.create(n, list_id=lid) for n in ("A", "B", "C"))
        # 把 C 放到 A 下方 → 期望顺序 A, C, B。
        self.svc.reorder(c.id, a.id, below=True)
        ids = [t.id for t in self.svc.list_tree(lid)]
        self.assertEqual(ids, [a.id, c.id, b.id], "重排后相对顺序应持久化")


class TestTodayTreeDeep(unittest.TestCase):
    """今日树应保留完整后代（多层孙辈），不因中间任务无 due 而丢失（回归修复）。"""

    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        self.db = Database()
        self.svc = _make_service(self.db)

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    def test_grandchild_kept_under_today_parent(self):
        from datetime import date
        lid = _make_list(self.svc)
        a = self.svc.create("今天到期A", list_id=lid, due=date.today())
        b = self.svc.add_subtask(a.id, "随从B(无due)")
        c = self.svc.add_subtask(b.id, "孙C(无due)")
        tree = self.svc.today_tree()
        self.assertEqual(len(tree), 1, "只有 today 的 A 是根")
        self.assertEqual(tree[0].id, a.id)
        b_nodes = tree[0].children
        self.assertEqual([t.id for t in b_nodes], [b.id])
        self.assertEqual([t.id for t in b_nodes[0].children], [c.id],
                         "孙 C 不得因中间 B 无 due 而丢失")


class TestQuickCreateDefaultDue(unittest.TestCase):
    """quick_create 无日期词时默认截止今天；显式日期词仍按原义解析。"""

    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        self.db = Database()
        self.svc = _make_service(self.db)

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    def test_plain_quick_create_defaults_due_today(self):
        t = self.svc.quick_create("买牛奶")
        self.assertIsNotNone(t)
        self.assertEqual(t.due_date, date.today(),
                         "无日期词时 quick_create 应默认截止今天")

    def test_explicit_tomorrow_still_parses(self):
        t = self.svc.quick_create("明天 交周报")
        self.assertIsNotNone(t)
        self.assertEqual(t.due_date, date.today() + timedelta(days=1),
                         "显式「明天」应解析为明天，而非被默认值覆盖")

    # ---- P0-2: 带时刻捕获「明天3点」→ due_date + reminder_at ----
    def test_clock_sets_reminder_at(self):
        t = self.svc.quick_create("明天3点 交周报")
        self.assertIsNotNone(t)
        self.assertEqual(t.due_date, date.today() + timedelta(days=1))
        self.assertIsNotNone(t.reminder_at, "带时刻短语应生成 reminder_at")
        self.assertEqual(t.reminder_at.hour, 15)
        self.assertEqual(t.reminder_at.minute, 0)
        self.assertEqual(t.reminder_at.date(), t.due_date)

    def test_clock_24h_sets_reminder(self):
        t = self.svc.quick_create("后天 14:30 复诊")
        self.assertIsNotNone(t)
        self.assertEqual(t.due_date, date.today() + timedelta(days=2))
        self.assertIsNotNone(t.reminder_at)
        self.assertEqual((t.reminder_at.hour, t.reminder_at.minute), (14, 30))

    def test_no_clock_keeps_reminder_none(self):
        t = self.svc.quick_create("周五前 交付方案")
        self.assertIsNotNone(t)
        self.assertIsNone(t.reminder_at, "纯日期短语不应生成提醒时刻")


class TestAddedToday(unittest.TestCase):
    """added_today 只返回今天创建的根任务（含其子树），不把旧根下的新子任务算作今日新增。"""

    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        self.db = Database()
        self.svc = _make_service(self.db)

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    def _set_created_at(self, task_id: int, dt: datetime):
        s = self.db.session()
        try:
            row = s.get(TaskRow, task_id)
            row.created_at = dt
            s.commit()
        finally:
            s.close()

    def test_today_root_with_subtree_included_old_root_excluded(self):
        root = self.svc.create("今日新增根")
        child = self.svc.add_subtask(root.id, "今日根的子任务")
        old = self.svc.create("昨日旧任务")
        self._set_created_at(old.id, datetime.now() - timedelta(days=1))

        tree = self.svc.added_today()
        self.assertEqual([t.id for t in tree], [root.id],
                         "仅今天创建的根任务应出现在今日新增")
        self.assertEqual([c.id for c in tree[0].children], [child.id],
                         "今日新增根的子任务应随树一并返回")

    def test_today_subtask_under_old_root_not_returned(self):
        old = self.svc.create("旧根")
        self._set_created_at(old.id, datetime.now() - timedelta(days=1))
        self.svc.add_subtask(old.id, "今天建在旧根下的子任务")

        self.assertEqual(self.svc.added_today(), [],
                         "旧根下的新子任务不是根任务，不应进入今日新增")


class TestTodayEffectiveDone(unittest.TestCase):
    """今日待办 = 有效未完成且未逾期；逾期/完成/父链 roll-up 口径回归。"""

    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        self.db = Database()
        self.svc = _make_service(self.db)

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    def _all_tasks(self):
        s = self.db.session()
        try:
            return self.svc.tasks.list_all(s)
        finally:
            s.close()

    def _today_ids(self):
        return {t.id for t in self.svc.today_tree()}

    def test_no_due_undone_in_today_done_excluded(self):
        t = self.svc.create("无日期未完成")
        self.assertIn(t.id, self._today_ids(), "无日期未完成任务应进今日待办")
        self.svc.set_status(t.id, TaskStatus.DONE)
        self.assertNotIn(t.id, self._today_ids(), "完成后应移出今日待办")

    def test_due_today_future_in_today_overdue_excluded(self):
        a = self.svc.create("截止今天", due=date.today())
        b = self.svc.create("截止未来", due=date.today() + timedelta(days=3))
        c = self.svc.create("截止昨天", due=date.today() - timedelta(days=1))
        ids = self._today_ids()
        self.assertIn(a.id, ids)
        self.assertIn(b.id, ids)
        self.assertNotIn(c.id, ids, "逾期任务不进今日")
        over = {t.id for t in self.svc.overdue()}
        self.assertIn(c.id, over, "逾期任务应进已逾期")
        self.assertNotIn(a.id, over)
        self.assertNotIn(b.id, over)

    def test_start_only_undone_in_today(self):
        t = self.svc.create("仅开始无截止")
        self.svc.update(t.id, start_date=date.today() + timedelta(days=1))
        self.assertIn(t.id, self._today_ids(), "仅开始无截止未完成应进今日待办")

    def test_parent_two_children_rollup(self):
        parent = self.svc.create("父任务")
        c1 = self.svc.add_subtask(parent.id, "子1")
        c2 = self.svc.add_subtask(parent.id, "子2")
        # 父自身 doing，模拟“父未勾选”；一子完成一子未完成 → 父有效未完成
        self.svc.update(parent.id, status=TaskStatus.DOING)
        self.svc.set_status(c1.id, TaskStatus.DONE)
        self.assertIn(parent.id, self._today_ids(), "一子未完成 → 父有效未完成，应进今日")
        eff = self.svc.effective_done_map(self._all_tasks())
        self.assertFalse(eff[parent.id])
        # 两子全完成 → 父有效完成（即便父自身仍 doing），移出今日
        self.svc.set_status(c2.id, TaskStatus.DONE)
        self.assertNotIn(parent.id, self._today_ids(),
                         "子全完成 → 父有效完成，即便父自身 status=doing")
        eff2 = self.svc.effective_done_map(self._all_tasks())
        self.assertTrue(eff2[parent.id])

    def test_three_level_nested_rollup(self):
        top = self.svc.create("顶层")
        mid = self.svc.add_subtask(top.id, "中层")
        leaf = self.svc.add_subtask(mid.id, "曾孙")
        self.assertIn(top.id, self._today_ids(), "任一后代未完成 → 顶层父有效未完成")
        eff = self.svc.effective_done_map(self._all_tasks())
        self.assertFalse(eff[top.id])
        # 中层与曾孙全完成 → 顶层有效完成
        self.svc.set_status(leaf.id, TaskStatus.DONE)
        self.svc.set_status(mid.id, TaskStatus.DONE)
        eff2 = self.svc.effective_done_map(self._all_tasks())
        self.assertTrue(eff2[top.id])
        self.assertNotIn(top.id, self._today_ids())

    def test_overdue_uses_effective_done(self):
        parent = self.svc.create("逾期父", due=date.today() - timedelta(days=1))
        c1 = self.svc.add_subtask(parent.id, "子1")
        c2 = self.svc.add_subtask(parent.id, "子2")
        self.svc.set_status(c1.id, TaskStatus.DONE)
        self.assertIn(parent.id, {t.id for t in self.svc.overdue()},
                      "逾期且一子未完成 → 父有效未完成，应计入逾期")
        self.svc.set_status(c2.id, TaskStatus.DONE)
        self.assertNotIn(parent.id, {t.id for t in self.svc.overdue()},
                         "子全完成 → 父有效完成，即便逾期也不再计入")


class TestWaitingResume(unittest.TestCase):
    """v0.15 P2-8：waiting 暂停/恢复 + resume_at 自动恢复。"""

    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        self.db = Database()
        self.svc = _make_service(self.db)

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    def test_pause_and_resume(self):
        t = self.svc.create("等采购到货")
        paused = self.svc.pause(t.id, resume_at=date.today() + timedelta(days=2))
        self.assertEqual(paused.status, TaskStatus.WAITING)
        self.assertEqual(paused.resume_at, date.today() + timedelta(days=2))
        resumed = self.svc.resume(t.id)
        self.assertEqual(resumed.status, TaskStatus.TODO)
        self.assertIsNone(resumed.resume_at)

    def test_resume_due_today_auto_restores(self):
        t = self.svc.create("今日到期的等待任务")
        self.svc.pause(t.id, resume_at=date.today())
        n = self.svc.resume_due_today()
        self.assertGreaterEqual(n, 1)
        fresh = self.svc.get(t.id)
        self.assertEqual(fresh.status, TaskStatus.TODO)
        self.assertIsNone(fresh.resume_at)

    def test_set_status_away_waiting_clears_resume(self):
        t = self.svc.create("切换状态清恢复")
        self.svc.pause(t.id, resume_at=date.today() + timedelta(days=5))
        moved = self.svc.set_status(t.id, TaskStatus.DOING)
        self.assertEqual(moved.status, TaskStatus.DOING)
        self.assertIsNone(moved.resume_at)

    def test_waiting_not_reminded(self):
        """等待中不弹提醒：reminder_at 到点但状态 waiting → 不进 due_reminders。"""
        t = self.svc.create("暂停任务不提醒")
        self.svc.update(t.id, reminder_at=datetime.now() - timedelta(minutes=1))
        self.svc.pause(t.id)
        self.assertEqual(self.svc.reminders_due(), [], "waiting 任务不应触发到点提醒")


class TestTaskNoteContext(unittest.TestCase):
    """v0.15 P0-1：任务↔笔记段落级上下文（block_key + snippet）。"""

    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        self.db = Database()
        self.svc = _make_service(self.db)

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    def test_attach_and_query_block(self):
        t = self.svc.create("看 §2.1")
        from zhixing.model.infrastructure.repositories import NoteRepository
        from zhixing.model.infrastructure.models import NoteRow
        fts = FTSService(self.db)
        notes = NoteRepository(self.db, fts)
        s = self.db.session()
        try:
            nrow = NoteRow(title="测试笔记", content_md="## 标题\n\n这是正文段落。")
            s.add(nrow)
            s.commit()
            note_id = nrow.id
        finally:
            s.close()
        ret = self.svc.attach_block(t.id, note_id, "h2:标题#1", "这是正文段落。")
        self.assertIsNotNone(ret)
        ctxs = self.svc.linked_contexts(t.id)
        self.assertEqual(len(ctxs), 1)
        self.assertEqual(ctxs[0].block_key, "h2:标题#1")
        self.assertEqual(ctxs[0].snippet, "这是正文段落。")
        # 幂等
        self.svc.attach_block(t.id, note_id, "h2:标题#1", "这是正文段落。")
        self.assertEqual(len(self.svc.linked_contexts(t.id)), 1)
        # detach
        self.svc.detach_block(t.id, note_id, "h2:标题#1")
        self.assertEqual(self.svc.linked_contexts(t.id), [])
        # note 维度查询
        self.svc.attach_block(t.id, note_id, "h2:标题#1", "这是正文段落。")
        self.assertEqual(len(self.svc.contexts_for_note(note_id)), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
