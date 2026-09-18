# -*- coding: utf-8 -*-
"""任务服务：任务/分组全部用例。事务边界在此，写路径统一发领域事件。"""
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Tuple

from ...core.event_bus import EventBus
from ..domain.capture_grammar import due_from_word, parse
from ..domain.entities import (
    FolderKind, ListFolder, Priority, RepeatPeriod, Task, TaskNoteContext, TaskStatus,
)
from ..domain.link_parser import extract_links
from ..domain.task_rules import (
    effective_done_map as _effective_done_map, next_recurrence, roll_recurring_subtasks,
    today_roots,
)
from ..infrastructure.db import Database
from ..infrastructure.repositories import (
    ListFolderRepository, NoteRepository, TagRepository, TaskRepository,
)


class TaskService:
    def __init__(self, db: Database, bus: EventBus,
                 tasks: TaskRepository, folders: ListFolderRepository, tags: TagRepository,
                 notes: Optional[NoteRepository] = None):
        self.db, self.bus = db, bus
        self.tasks, self.folders, self.tags = tasks, folders, tags
        self.notes = notes   # 可选：任务 notes_md [[链接]] 解析落链（F4-3）

    # ================= 创建 =================
    def create(self, title: str, list_id: Optional[int] = None, parent_id: Optional[int] = None,
               priority: Priority = Priority.NONE, due: Optional[date] = None,
               repeat: RepeatPeriod = RepeatPeriod.NONE, notes_md: str = "",
               tag_names: Optional[List[str]] = None, start_date: Optional[date] = None,
               reminder_at=None, repeat_rule: Optional[str] = None) -> Task:
        t = Task(title=title.strip() or "新任务", list_id=list_id, parent_id=parent_id,
                 priority=priority, due_date=due, repeat_period=repeat, notes_md=notes_md,
                 start_date=start_date, reminder_at=reminder_at, repeat_rule=repeat_rule)
        s = self.db.session()
        try:
            self.tasks.create(s, t)
            for name in (tag_names or []):
                tid = self.tags.ensure(s, name.strip())
                self.tasks.set_tags(s, t.id, self.tasks.tag_ids(s, t.id) + [tid])
            if self.notes is not None:
                self._sync_wiki_links(s, t.id, notes_md)
            s.commit()
        finally:
            s.close()
        self.bus.task_changed.emit(t.id, "created")
        self._emit_structure_if(t.id, "task_created")
        return t

    def quick_create(self, text: str, default_list_id: Optional[int] = None) -> Optional[Task]:
        """快速输入语法糖创建。"""
        p = parse(text)
        if not p.title:
            return None
        list_id = default_list_id
        if p.list_name:
            s = self.db.session()
            try:
                f = self.folders.find_by_name(s, p.list_name)
                list_id = f.id if f else default_list_id
            finally:
                s.close()
        # P0-2: 「明天3点」→ due=明天 + reminder_at=明天15:00（提醒到点弹出）
        reminder_at = None
        due = due_from_word(p.due_word)
        if p.due_clock and due is not None:
            h, m = p.due_clock
            try:
                from datetime import datetime, time
                reminder_at = datetime.combine(due, time(h, m))
            except ValueError:
                reminder_at = None
        return self.create(p.title, list_id=list_id, priority=p.priority,
                           due=due or date.today(), reminder_at=reminder_at,
                           tag_names=p.tags)

    def add_subtask(self, parent_id: int, title: str) -> Optional[Task]:
        s = self.db.session()
        try:
            parent = self.tasks.get(s, parent_id)
        finally:
            s.close()
        if not parent:
            return None
        return self.create(title, list_id=parent.list_id, parent_id=parent_id)

    # ================= 更新 =================
    def update(self, task_id: int, **fields) -> Optional[Task]:
        s = self.db.session()
        try:
            t = self.tasks.get(s, task_id)
            if not t:
                return None
            for k, v in fields.items():
                if hasattr(t, k):
                    setattr(t, k, v)
            if "title" in fields and not str(t.title).strip():
                return None
            self.tasks.update(s, t)
            if "tag_ids" in fields:
                self.tasks.set_tags(s, task_id, fields["tag_ids"])
            if "notes_md" in fields and self.notes is not None:
                self._sync_wiki_links(s, task_id, fields.get("notes_md") or "")
            s.commit()
            fresh = self.tasks.get(s, task_id)
        finally:
            s.close()
        self.bus.task_changed.emit(task_id, "updated")
        if "parent_id" in fields or "list_id" in fields:
            self._emit_structure_if(task_id, "task_moved")
        return fresh

    def set_status(self, task_id: int, status: TaskStatus) -> Optional[Task]:
        kwargs = {"status": status,
                  "completed_at": datetime.now() if status == TaskStatus.DONE else None}
        if status != TaskStatus.WAITING:
            kwargs["resume_at"] = None   # 离开 waiting 即清除自动恢复计划
        t = self.update(task_id, **kwargs)
        if t and status == TaskStatus.DONE:
            self.bus.task_changed.emit(task_id, "completed")
        return t

    def toggle_complete(self, task_id: int) -> Tuple[Optional[Task], bool]:
        s = self.db.session()
        try:
            t = self.tasks.get(s, task_id)
            was_done = t.is_done if t else False
        finally:
            s.close()
        if not t:
            return None, False
        if was_done:
            return self.update(task_id, status=TaskStatus.TODO, completed_at=None), False
        new_t = self.update(task_id, status=TaskStatus.DONE, completed_at=datetime.now())
        self.bus.task_changed.emit(task_id, "completed")
        # 循环任务（父级）：完成后克隆推进截止日（补全 start_date/reminder_at/标签/子任务）
        if t.is_recurring and t.parent_id is None:
            nd, rule = next_recurrence(t)
            if nd is not None:
                self._clone_task_tree(t, None, new_due=nd, rule=rule)
                self.bus.task_structure_changed.emit(task_id, "task_cloned")
                return new_t, True
        return new_t, True

    def _clone_task_tree(self, src: Task, parent_id: Optional[int],
                         new_due: Optional[date] = None,
                         rule: Optional[str] = None) -> Task:
        """克隆任务及其子树（W14）：补全 start_date/reminder_at/标签/循环规则/子任务。"""
        s = self.db.session()
        try:
            src_tag_ids = set(self.tasks.tag_ids(s, src.id or 0))
            tag_names = [name for (tid, name, _c) in self.tags.all(s) if tid in src_tag_ids]
            children = self.tasks.children(s, src.id or 0)
        finally:
            s.close()
        clone = self.create(
            src.title, list_id=src.list_id, parent_id=parent_id, priority=src.priority,
            due=new_due if new_due is not None else src.due_date, repeat=src.repeat_period,
            notes_md=src.notes_md, start_date=src.start_date, reminder_at=src.reminder_at,
            repeat_rule=rule if rule is not None else src.repeat_rule, tag_names=tag_names)
        for child in children:
            self._clone_task_tree(child, clone.id)
        return clone

    def _sync_wiki_links(self, s, task_id: int, notes_md: str):
        """任务 notes_md 复用 link_parser：解析 [[链接]] 并按标题落 task_note_link。"""
        if self.notes is None:
            return
        for title in extract_links(notes_md or ""):
            note = self.notes.by_title(s, title)
            if note is not None:
                self.tasks.link_note(s, task_id, note.id)

    def link_wiki_notes(self, task_id: int) -> List[int]:
        """显式触发任务 notes_md 的 [[链接]] 解析（F4-3），返回新落链的 note_id 列表。"""
        if self.notes is None:
            return []
        s = self.db.session()
        try:
            t = self.tasks.get(s, task_id)
            if t is None:
                return []
            before = {n.id for n in self.tasks.linked_notes(s, task_id)}
            self._sync_wiki_links(s, task_id, t.notes_md or "")
            s.commit()
            after = {n.id for n in self.tasks.linked_notes(s, task_id)}
            return sorted(after - before)
        finally:
            s.close()

    def delete(self, task_id: int, with_children: bool = True):
        s = self.db.session()
        try:
            t = self.tasks.get(s, task_id)
            self.tasks.soft_delete(s, task_id, cascade=with_children)
            s.commit()
            pid = t.parent_id if t else None
        finally:
            s.close()
        self.bus.task_changed.emit(task_id, "deleted")
        self._emit_structure_if(task_id, "task_deleted")

    def restore(self, task_id: int):
        s = self.db.session()
        try:
            self.tasks.restore(s, task_id)
            s.commit()
        finally:
            s.close()
        self.bus.task_structure_changed.emit(task_id, "task_restored")

    # ================= 回收站（F9-3） =================
    def trash(self) -> List[Task]:
        """软删除的任务列表（回收站）。"""
        s = self.db.session()
        try:
            return [t for t in self.tasks.list_all(s, include_deleted=True)
                    if t.deleted_at is not None]
        finally:
            s.close()

    def purge(self, task_id: int):
        """硬删除（回收站清空/到期清理，不可逆）。"""
        s = self.db.session()
        try:
            self.tasks.purge(s, task_id)
            s.commit()
        finally:
            s.close()
        self.bus.task_structure_changed.emit(task_id, "task_purged")

    def purge_older_than(self, days: int = 30) -> int:
        """清理删除超过 N 天的任务（硬删除），返回清理数量。"""
        cutoff = datetime.now() - timedelta(days=days)
        stale = [t for t in self.trash()
                 if t.deleted_at is not None and t.deleted_at < cutoff]
        for t in stale:
            self.purge(t.id)
        return len(stale)

    # ================= 结构操作 =================
    def reparent(self, task_id: int, parent_id: Optional[int]):
        self.update(task_id, parent_id=parent_id)
        self.bus.task_structure_changed.emit(task_id, "task_reparented")

    def move_to_list(self, task_id: int, list_id: Optional[int]):
        self.update(task_id, list_id=list_id)
        self.bus.task_structure_changed.emit(task_id, "task_moved")

    def move_relative(self, task_id: int, delta: int):
        """同级内上移(delta=-1)/下移(delta=+1)，复用 reorder 的 sort_key 中间值算法。"""
        s = self.db.session()
        try:
            me = self.tasks.get(s, task_id)
            if not me:
                return
            all_t = self.tasks.list_all(s)
            sib = sorted([x for x in all_t if x.parent_id == me.parent_id],
                         key=lambda x: (x.sort_key, x.id or 0))
            idx = next((i for i, x in enumerate(sib) if x.id == me.id), -1)
            anchor = None
            below = True
            if delta < 0 and idx > 0:
                anchor, below = sib[idx - 1], False
            elif delta > 0 and 0 <= idx < len(sib) - 1:
                anchor, below = sib[idx + 1], True
            else:
                return
        finally:
            s.close()
        if anchor is not None:
            self.reorder(task_id, anchor.id, below=below)

    def reorder(self, task_id: int, anchor_id: int, below: bool = True):
        """拖拽排序：放到 anchor 上/下，取中间 sort_key。"""
        s = self.db.session()
        try:
            me, anchor = self.tasks.get(s, task_id), self.tasks.get(s, anchor_id)
            if not me or not anchor:
                return
            all_t = self.tasks.list_all(s)
            sib = [x for x in all_t if x.parent_id == anchor.parent_id and x.id != me.id]
            sib.sort(key=lambda x: (x.sort_key, x.id or 0))
            idx = next((i for i, x in enumerate(sib) if x.id == anchor.id), len(sib))
            if below:
                idx += 1
            prev_key = sib[idx - 1].sort_key if idx > 0 else (sib[0].sort_key - 2 if sib else 0.0)
            next_key = sib[idx].sort_key if idx < len(sib) else (sib[-1].sort_key + 2 if sib else 2.0)
            me.sort_key = (prev_key + next_key) / 2
            self.tasks.update(s, me)
            s.commit()
        finally:
            s.close()
        self.bus.task_structure_changed.emit(task_id, "task_reordered")

    def batch_complete(self, ids: List[int]):
        for tid in ids:
            s = self.db.session()
            try:
                t = self.tasks.get(s, tid)
            finally:
                s.close()
            if t and not t.is_done:
                self.set_status(tid, TaskStatus.DONE)
        self.bus.task_structure_changed.emit(0, "task_batch")

    def batch_move(self, ids: List[int], list_id: Optional[int]):
        for tid in ids:
            self.update(tid, list_id=list_id)
        self.bus.task_structure_changed.emit(0, "task_batch")

    def batch_set_due(self, ids: List[int], due: Optional[date]):
        for tid in ids:
            self.update(tid, due_date=due)
        self.bus.task_structure_changed.emit(0, "task_batch")

    # ================= 打卡与循环 =================
    def roll_recurring_today(self) -> int:
        """启动/跨天调用：重置到期循环子任务。"""
        today = date.today()
        s = self.db.session()
        try:
            tasks = self.tasks.recurring_tasks(s)
            subtasks = [t for t in tasks if t.parent_id is not None]
            # 快照重置前的完成状态：roll_recurring_subtasks 会把到期任务统一改回 TODO，
            # 因此必须在调用前记录"上一周期已勾选（打卡完成）"的事实，用于累计连续 streak。
            done_before = {t.id for t in subtasks if t.is_done}
            reset_ids = roll_recurring_subtasks(subtasks, today)
            for t in subtasks:
                if t.id in reset_ids and t.id in done_before:
                    t.streak += 1
                    self.tasks.update(s, t)
            s.commit()
        finally:
            s.close()
        if reset_ids:
            self.bus.task_structure_changed.emit(0, "task_roll")
        return len(reset_ids)

    # ================= 查询 =================
    def tree(self, s, tasks: List[Task]) -> List[Task]:
        by_parent: Dict[Optional[int], List[Task]] = {}
        for t in tasks:
            by_parent.setdefault(t.parent_id, []).append(t)
        for v in by_parent.values():
            v.sort(key=lambda x: (x.sort_key, x.id or 0))

        def attach(parent_id):
            out = []
            for t in by_parent.get(parent_id, []):
                t.children = attach(t.id)
                out.append(t)
            return out
        return attach(None)

    def all_tree(self, statuses: Optional[List[TaskStatus]] = None) -> List[Task]:
        s = self.db.session()
        try:
            tasks = self.tasks.list_all(s)
            if statuses:
                tasks = [t for t in tasks if t.status in statuses]
            counts = self.tasks.note_count_map(s, [t.id for t in tasks])
            for t in tasks:
                t.note_count = counts.get(t.id, 0)
            return self.tree(s, tasks)
        finally:
            s.close()

    def list_tree(self, list_id: Optional[int]) -> List[Task]:
        s = self.db.session()
        try:
            all_tasks = self.tasks.list_all(s)
            if list_id is None:
                # 收件箱/未归属：根=顶层 list_id=None 的任务，且必须保留其全部子孙，
                # 否则父任务的子任务即便 list_id 与父一致也会被误判为孤儿而丢失。
                roots = [t for t in all_tasks if t.list_id is None and t.parent_id is None]
            else:
                roots = [t for t in all_tasks
                         if t.list_id == list_id and t.parent_id is None]
                if not roots:
                    # 兼容：非顶层也无顶层根的异常库，直接列出该列表全部任务
                    roots = [t for t in all_tasks if t.list_id == list_id]
            # 闭包收集：保留每个根的完整后代（父子结构逐层不依赖 list_id），
            # 避免子任务因自身 list_id 与视图根不同而被误判为孤儿丢失。
            keep = {t.id for t in roots}
            added = True
            while added:
                added = False
                for t in all_tasks:
                    if t.parent_id in keep and t.id not in keep:
                        keep.add(t.id)
                        added = True
            tasks = [t for t in all_tasks if t.id in keep]
            counts = self.tasks.note_count_map(s, [t.id for t in tasks])
            for t in tasks:
                t.note_count = counts.get(t.id, 0)
            return self.tree(s, tasks)
        finally:
            s.close()

    def added_today(self) -> List[Task]:
        """今天创建的根任务（含各自子树），供「今日新增」区使用。

        单次 list_all 查询后内存过滤 + 闭包收集 + tree()，不逐任务查库（避免 N+1）。
        created_at 可能为 None（历史/异常数据），安全判空后跳过。
        """
        today = date.today()
        s = self.db.session()
        try:
            all_tasks = self.tasks.list_all(s)
            roots = [t for t in all_tasks
                     if t.parent_id is None and t.created_at is not None
                     and t.created_at.date() == today]
            keep = {t.id for t in roots}
            changed = True
            while changed:
                changed = False
                for t in all_tasks:
                    if t.parent_id in keep and t.id not in keep:
                        keep.add(t.id)
                        changed = True
            tasks = [t for t in all_tasks if t.id in keep]
            return self.tree(s, tasks)
        finally:
            s.close()

    def tag_map(self, task_ids: List[int]) -> Dict[int, List[Tuple[int, str, str]]]:
        """批量装配任务标签（一次 join 查询），返回 {task_id: [(tag_id,name,color),...]}。

        供 Qt 模型批量提供 RoleTags，避免在 paint/delegate 中逐任务查库（N+1）。
        """
        ids = [i for i in task_ids if i is not None]
        if not ids:
            return {}
        s = self.db.session()
        try:
            from sqlalchemy import select
            from ..infrastructure.models import TagRow, TaskTagRow
            rows = s.execute(
                select(TaskTagRow.task_id, TagRow.id, TagRow.name, TagRow.color)
                .join(TagRow, TagRow.id == TaskTagRow.tag_id)
                .where(TaskTagRow.task_id.in_(ids))
            ).all()
            out: Dict[int, List[Tuple[int, str, str]]] = {i: [] for i in ids}
            for task_id, tag_id, name, color in rows:
                out.setdefault(task_id, []).append((tag_id, name, color))
            return out
        finally:
            s.close()

    def effective_done_map(self, tasks: List[Task]) -> Dict[int, bool]:
        """有效完成 roll-up（派生值，实时计算不落库）：{task_id: 是否有效完成}。"""
        return _effective_done_map(tasks)

    def today_tree(self) -> List[Task]:
        today = date.today()
        s = self.db.session()
        try:
            all_t = self.tasks.list_all(s)
            # 今日待办根 = 顶层 + 有效未完成 + 未逾期（无截止 / 截止>=今天）；
            # 逾期根（截止<今天）不进今日，而进 overdue。
            roots = today_roots(all_t, today)
            keep = {t.id for t in roots}
            # 闭包保留每个今日根的完整后代（不依赖中间任务自身的 due/完成态），
            # 与 list_tree/all_tree 同构，避免多层子孙/只看父的一层而丢孙辈。
            changed = True
            while changed:
                changed = False
                for t in all_t:
                    if t.parent_id in keep and t.id not in keep:
                        keep.add(t.id)
                        changed = True
            tasks = [t for t in all_t if t.id in keep]
            counts = self.tasks.note_count_map(s, [t.id for t in tasks])
            for t in tasks:
                t.note_count = counts.get(t.id, 0)
            return self.tree(s, tasks)
        finally:
            s.close()

    def overdue(self) -> List[Task]:
        today = date.today()
        s = self.db.session()
        try:
            tasks = self.tasks.list_all(s)
            eff = self.effective_done_map(tasks)
            return [t for t in tasks
                    if t.due_date is not None and t.due_date < today
                    and not eff.get(t.id, t.status == TaskStatus.DONE)]
        finally:
            s.close()

    def task_candidates(self, q: str = "", limit: int = 20) -> List[Task]:
        """捕获卡子任务候选（target_selector 只读桥）：q 非空按标题模糊搜索，

        否则返回近期活跃顶层任务；均过滤已完成，避免 View 直连仓储/会话。
        """
        s = self.db.session()
        try:
            if q:
                return [t for t in self.tasks.search_titles(s, q, limit) if not t.is_done]
            tasks = self.tasks.due_between(
                s, date(2000, 1, 1), date.today() + timedelta(days=30))
        finally:
            s.close()
        seen, out = set(), []
        for t in tasks:
            if t.parent_id is None and t.id not in seen and not t.is_done:
                seen.add(t.id)
                out.append(t)
            if len(out) >= limit:
                break
        return out

    def reminders_due(self, now: Optional[datetime] = None) -> List[Task]:
        """已到发生时刻、仍未完成/放弃的提醒任务列表。"""
        now = now or datetime.now()
        s = self.db.session()
        try:
            return self.tasks.due_reminders(s, now)
        finally:
            s.close()

    def dismiss_reminder(self, task_id: int) -> Optional[Task]:
        """标记提醒已发出：清空 reminder_at（一次性语义，避免重复打扰）。"""
        return self.update(task_id, reminder_at=None)

    def snooze(self, task_id: int, minutes: int = 5) -> Optional[Task]:
        """稍后提醒（F5-3）：reminder_at 顺延 N 分钟（托盘「稍后」5/15/30）。"""
        t = self.get(task_id)
        if not t:
            return None
        now = datetime.now()
        base = t.reminder_at if (t.reminder_at and t.reminder_at > now) else now
        return self.update(task_id, reminder_at=base + timedelta(minutes=minutes))

    def change_quadrant(self, task_id: int, priority: Priority,
                        due: Optional[date]) -> Optional[Task]:
        """四象限拖拽换象限（F1-10）：改 priority + 截止日期。"""
        return self.update(task_id, priority=priority, due_date=due)

    def reschedule(self, task_id: int, new_due: Optional[date]) -> Optional[Task]:
        """日历拖拽改期（F1-12）：改截止日期。"""
        return self.update(task_id, due_date=new_due)

    def tasks_on_day(self, d: date) -> List[Task]:
        """某天的全部任务（日历视图）。"""
        s = self.db.session()
        try:
            return self.tasks.due_between(s, d, d)
        finally:
            s.close()

    def doing(self) -> List[Task]:
        return self.all_tree(statuses=[TaskStatus.DOING])

    def get(self, task_id: int) -> Optional[Task]:
        s = self.db.session()
        try:
            return self.tasks.get(s, task_id)
        finally:
            s.close()

    def linked_notes(self, task_id: int):
        s = self.db.session()
        try:
            return self.tasks.linked_notes(s, task_id)
        finally:
            s.close()

    def attach_note(self, task_id: int, note_id: int):
        s = self.db.session()
        try:
            self.tasks.link_note(s, task_id, note_id)
            s.commit()
        finally:
            s.close()
        self.bus.task_changed.emit(task_id, "updated")

    def detach_note(self, task_id: int, note_id: int):
        s = self.db.session()
        try:
            self.tasks.unlink_note(s, task_id, note_id)
            s.commit()
        finally:
            s.close()
        self.bus.task_changed.emit(task_id, "updated")

    # ---------- 任务↔笔记「段落级」上下文（v0.15 P0-1） ----------
    def attach_block(self, task_id: int, note_id: int, block_key: str,
                     snippet: str = "") -> Optional[Task]:
        """记录任务关联笔记内某段落（幂等）。task 须先存在。"""
        if not block_key or not task_id or not note_id:
            return None
        s = self.db.session()
        try:
            existing = self.tasks.get(s, task_id)
            if not existing:
                return None
            self.tasks.link_context(s, task_id, note_id, block_key, snippet)
            s.commit()
            fresh = self.tasks.get(s, task_id)
        finally:
            s.close()
        self.bus.task_changed.emit(task_id, "updated")
        return fresh

    def detach_block(self, task_id: int, note_id: int, block_key: str = ""):
        s = self.db.session()
        try:
            self.tasks.unlink_context(s, task_id, note_id, block_key)
            s.commit()
        finally:
            s.close()
        self.bus.task_changed.emit(task_id, "updated")

    def linked_contexts(self, task_id: int) -> List[TaskNoteContext]:
        s = self.db.session()
        try:
            return self.tasks.linked_contexts(s, task_id)
        finally:
            s.close()

    def contexts_for_note(self, note_id: int) -> List[TaskNoteContext]:
        s = self.db.session()
        try:
            return self.tasks.contexts_for_note(s, note_id)
        finally:
            s.close()

    def note_context_map(self, task_ids: List[int]) -> Dict[int, List[TaskNoteContext]]:
        s = self.db.session()
        try:
            return self.tasks.context_notes_for(s, task_ids)
        finally:
            s.close()

    # ---------- WAITING 支持（v0.15 P2-8） ----------
    def pause(self, task_id: int, resume_at: Optional[date] = None) -> Optional[Task]:
        """置为等待中（暂停）；可指定 resume_at 计划恢复日期。"""
        return self.update(task_id, status=TaskStatus.WAITING, resume_at=resume_at)

    def resume(self, task_id: int, status: TaskStatus = TaskStatus.TODO) -> Optional[Task]:
        """恢复（默认回待办；可指定 doing 等），清空 resume_at。"""
        return self.update(task_id, status=status, resume_at=None)

    def resume_due_today(self, today: Optional[date] = None) -> int:
        """把 resume_at 到期（<=today）的 waiting 任务自动恢复为待办（启动/每日收尾调用）。"""
        today = today or date.today()
        s = self.db.session()
        try:
            rows = self.tasks.with_status_resume(s, TaskStatus.WAITING.value, today)
            for r in rows:
                r.status = TaskStatus.TODO.value
                r.resume_at = None
                r.updated_at = datetime.now()
            s.commit()
            return len(rows)
        finally:
            s.close()

    def set_tags(self, task_id: int, tag_names: List[str]):
        s = self.db.session()
        try:
            ids = [self.tags.ensure(s, n.strip()) for n in tag_names if n.strip()]
            self.tasks.set_tags(s, task_id, ids)
            s.commit()
        finally:
            s.close()
        self.bus.task_changed.emit(task_id, "updated")

    # ================= 分组与列表 =================
    def folder_tree(self) -> List[ListFolder]:
        s = self.db.session()
        try:
            return self.folders.all(s)
        finally:
            s.close()

    def create_folder(self, name: str, kind: FolderKind = FolderKind.LIST,
                      parent_id: Optional[int] = None) -> ListFolder:
        f = ListFolder(name=name.strip() or "新列表", kind=kind, parent_id=parent_id)
        s = self.db.session()
        try:
            self.folders.create(s, f)
            s.commit()
        finally:
            s.close()
        self.bus.task_structure_changed.emit(f.id, "list_created")
        return f

    def rename_folder(self, fid: int, name: str):
        s = self.db.session()
        try:
            f = self.folders.get(s, fid)
            if f:
                f.name = name
                self.folders.update(s, f)
                s.commit()
        finally:
            s.close()
        self.bus.task_structure_changed.emit(fid, "list_renamed")

    def delete_folder(self, fid: int):
        s = self.db.session()
        try:
            self.folders.delete(s, fid)
            s.commit()
        finally:
            s.close()
        self.bus.task_structure_changed.emit(fid, "list_deleted")

    def default_list_id(self) -> Optional[int]:
        s = self.db.session()
        try:
            f = self.folders.find_by_name(s, "我的清单")
            if not f:
                f = self.folders.create(s, ListFolder(name="我的清单", kind=FolderKind.LIST))
                s.commit()
                f2 = self.folders.find_by_name(s, "我的清单")
            return (f or f2).id
        finally:
            s.close()

    # ================= 内部 =================
    def _emit_structure_if(self, change_id: int, op: str):
        self.bus.task_structure_changed.emit(change_id, op)
