# -*- coding: utf-8 -*-
"""统计回顾服务：今日概览、周报、标签分布、完成热力。"""
from datetime import date, datetime, timedelta
from typing import Dict, List

from ..domain.entities import TaskStatus
from ..domain.task_rules import effective_done_map, today_roots
from ..infrastructure.db import Database
from ..infrastructure.repositories import FlashRepository, TaskRepository


class ReviewService:
    def __init__(self, db: Database, tasks: TaskRepository, flashes: FlashRepository):
        self.db, self.tasks, self.flashes = db, tasks, flashes

    def today_counts(self) -> Dict[str, int]:
        today = date.today()
        s = self.db.session()
        try:
            tasks = self.tasks.list_all(s)
            eff = effective_done_map(tasks)
            # 今日待办 = 顶层 + 有效未完成 + 未逾期（与 task_service.today_tree 根集合一致）
            today_due = len(today_roots(tasks, today, effective=eff))
            # 有效完成 且 完成时间在今天（roll-up 派生态，父任务自身 completed_at 为空的
            # 不会被重复计入，仍按“实际在今天被勾选完成”统计）
            done_today = sum(
                1 for t in tasks
                if eff.get(t.id, t.status == TaskStatus.DONE)
                and t.completed_at is not None and t.completed_at.date() == today)
            overdue = sum(
                1 for t in tasks
                if t.due_date is not None and t.due_date < today
                and not eff.get(t.id, t.status == TaskStatus.DONE))
            inbox = len(tasks)
            flash_count = len(self.flashes.list(s))
            return {"today_due": today_due, "done_today": done_today,
                    "overdue": overdue, "inbox": inbox, "flash": flash_count}
        finally:
            s.close()

    def week_stats(self, days: int = 7) -> Dict[str, List[int]]:
        start = date.today() - timedelta(days=days - 1)
        s = self.db.session()
        try:
            completed = [0] * days
            tasks = self.tasks.completed_between(s, datetime.combine(start, datetime.min.time()),
                                                 datetime.now())
            for t in tasks:
                idx = (t.completed_at.date() - start).days
                if 0 <= idx < days:
                    completed[idx] += 1
            from ..infrastructure.repositories import PomodoroRepository
            pomo = PomodoroRepository(self.db).minutes_by_day(s, start, days)
        finally:
            s.close()
        notes_created = [0] * days
        s = self.db.session()
        try:
            from ..infrastructure.models import NoteRow
            from sqlalchemy import select
            rows = s.scalars(select(NoteRow).where(NoteRow.deleted_at.is_(None),
                                                   NoteRow.created_at >= datetime.combine(start, datetime.min.time()))).all()
            for n in rows:
                idx = (n.created_at.date() - start).days
                if 0 <= idx < days:
                    notes_created[idx] += 1
        finally:
            s.close()
        return {"completed": completed, "pomodoro": pomo, "notes": notes_created,
                "labels": [(start + timedelta(days=i)).strftime("%m-%d") for i in range(days)]}

    def tag_distribution(self, limit: int = 8):
        s = self.db.session()
        try:
            from ..infrastructure.repositories import TagRepository
            return TagRepository(self.db).distribution(s, limit)
        finally:
            s.close()

    def heatmap(self, weeks: int = 12) -> List[List[int]]:
        """近 N 周每日完成任务数，返回 [weeks][7]。"""
        today = date.today()
        start = today - timedelta(days=weeks * 7 - 1 - (6 - today.weekday()))
        s = self.db.session()
        try:
            tasks = self.tasks.completed_between(
                s, datetime.combine(start, datetime.min.time()),
                datetime.combine(today, datetime.min.time()) + timedelta(days=1))
        finally:
            s.close()
        counts: Dict[str, int] = {}
        for t in tasks:
            k = t.completed_at.date().strftime("%Y-%m-%d")
            counts[k] = counts.get(k, 0) + 1
        grid: List[List[int]] = []
        for w in range(weeks):
            col = []
            for d in range(7):
                day = start + timedelta(days=w * 7 + d)
                col.append(counts.get(day.strftime("%Y-%m-%d"), 0) if day <= today else -1)
            grid.append(col)
        return grid

    def streak_days(self) -> int:
        """连续完成天数（今日或昨天为止）。"""
        s = self.db.session()
        try:
            tasks = self.tasks.completed_between(s, datetime(2000, 1, 1), datetime.now())
        finally:
            s.close()
        days = {t.completed_at.date() for t in tasks}
        if not days:
            return 0
        today = date.today()
        cur = today if today in days else today - timedelta(days=1)
        streak = 0
        while cur in days:
            streak += 1
            cur -= timedelta(days=1)
        return streak

    def achievements(self) -> List[dict]:
        """成就/连续打卡（F6-4）：纯派生成就，供回顾页展示。"""
        s = self.db.session()
        try:
            tasks = self.tasks.list_all(s)
            from ..infrastructure.models import NoteLinkRow, NoteRow
            notes = s.query(NoteRow).filter(NoteRow.deleted_at.is_(None)).count()
            link_count = s.query(NoteLinkRow).count()
        finally:
            s.close()
        done = sum(1 for t in tasks if t.status in (TaskStatus.DONE, TaskStatus.ABANDONED))
        streak = self.streak_days()
        return [
            {"name": "初试锋芒", "desc": "完成第一个任务", "unlocked": done >= 1},
            {"name": "持之以恒", "desc": "连续完成 7 天", "unlocked": streak >= 7},
            {"name": "三十而立", "desc": "连续完成 30 天", "unlocked": streak >= 30},
            {"name": "任务收割机", "desc": "累计完成 100 项任务", "unlocked": done >= 100},
            {"name": "笔耕不辍", "desc": "创建 10 篇笔记", "unlocked": notes >= 10},
            {"name": "织网者", "desc": "建立 5 条双向链接", "unlocked": link_count >= 5},
        ]
