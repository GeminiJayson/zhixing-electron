# -*- coding: utf-8 -*-
"""仓储层：全部 SQL 访问的唯一入口。UI/Service 不直接碰 ORM 模型以外的 SQL。"""
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func, select, update as sa_update, delete as sa_delete
from sqlalchemy.orm import Session

from ...core.errors import ZhiXingError
from ...model.domain.entities import (
    BacklinkItem, Flash, FlashStatus, FolderKind, ListFolder, Note, NoteFolder, NoteLink,
    PomodoroSession, RepeatPeriod, Task, TaskNoteContext, TaskStatus, Priority,
)
from .db import Database
from .models import (
    FlashRow, FlashTagRow, ListFolderRow, NoteFolderRow, NoteLinkRow, NoteRow, NoteTagRow,
    PomodoroRow, SettingRow, TagRow, TaskNoteContextRow, TaskNoteLinkRow, TaskRow, TaskTagRow,
)
from .fts import FTSService


def _to_task(r: TaskRow) -> Task:
    t = Task(
        id=r.id, title=r.title, notes_md=r.notes_md or "",
        status=TaskStatus(r.status or "todo"), priority=Priority(r.priority or 0),
        due_date=r.due_date, start_date=r.start_date, reminder_at=r.reminder_at,
        resume_at=r.resume_at, list_id=r.list_id,
        parent_id=r.parent_id, repeat_period=RepeatPeriod(r.repeat_period or "none"),
        repeat_rule=r.repeat_rule, streak=r.streak or 0, last_reset_date=r.last_reset_date,
        sort_key=r.sort_key or 0.0,
        completed_at=r.completed_at, deleted_at=r.deleted_at,
        created_at=r.created_at, updated_at=r.updated_at,
    )
    return t


def _to_note(r: NoteRow) -> Note:
    return Note(id=r.id, folder_id=r.folder_id, title=r.title, content_md=r.content_md or "",
                format=r.format or "markdown",
                pinned=bool(r.pinned), word_count=r.word_count or 0, deleted_at=r.deleted_at,
                created_at=r.created_at, updated_at=r.updated_at)


def _to_flash(r: FlashRow) -> Flash:
    return Flash(id=r.id, content=r.content, remark=r.remark or "", source_app=r.source_app or "",
                 source_url=r.source_url or "", status=FlashStatus(r.status or "inbox"),
                 converted_type=r.converted_type or "", converted_id=r.converted_id or 0,
                 deleted_at=r.deleted_at, created_at=r.created_at)


def _to_folder(r: ListFolderRow) -> ListFolder:
    return ListFolder(id=r.id, parent_id=r.parent_id, kind=FolderKind(r.kind),
                      name=r.name, icon=r.icon, collapsed=bool(r.collapsed), sort=r.sort)


def _to_context(r: TaskNoteContextRow) -> TaskNoteContext:
    return TaskNoteContext(id=r.id, task_id=r.task_id, note_id=r.note_id,
                           block_key=r.block_key, snippet=r.snippet or "",
                           created_at=r.created_at)


class TaskRepository:
    def __init__(self, db: Database, fts: FTSService):
        self.db = db
        self.fts = fts

    # ---------- 基础 CRUD ----------
    def create(self, s: Session, t: Task) -> Task:
        r = TaskRow(title=t.title, notes_md=t.notes_md, status=t.status.value,
                    priority=int(t.priority), due_date=t.due_date, start_date=t.start_date,
                    reminder_at=t.reminder_at, resume_at=t.resume_at,
                    list_id=t.list_id, parent_id=t.parent_id,
                    repeat_period=t.repeat_period.value, repeat_rule=t.repeat_rule,
                    streak=t.streak,
                    sort_key=t.sort_key or _next_sort(s, TaskRow, TaskRow.list_id, t.list_id))
        s.add(r)
        s.flush()
        self.fts.index_task(s, r.id, r.title, r.notes_md)
        t.id = r.id
        return t

    def update(self, s: Session, t: Task):
        r = s.get(TaskRow, t.id)
        if not r:
            return
        r.title, r.notes_md = t.title, t.notes_md
        r.status, r.priority = t.status.value, int(t.priority)
        r.due_date, r.start_date, r.reminder_at = t.due_date, t.start_date, t.reminder_at
        r.resume_at = t.resume_at
        r.list_id, r.parent_id = t.list_id, t.parent_id
        r.repeat_period, r.repeat_rule, r.streak, r.last_reset_date = (
            t.repeat_period.value, t.repeat_rule, t.streak, t.last_reset_date)
        r.sort_key, r.completed_at, r.deleted_at = t.sort_key, t.completed_at, t.deleted_at
        r.updated_at = datetime.now()
        self.fts.index_task(s, r.id, r.title, r.notes_md)

    def get(self, s: Session, task_id: int) -> Optional[Task]:
        r = s.get(TaskRow, task_id)
        return _to_task(r) if r else None

    def soft_delete(self, s: Session, task_id: int, cascade: bool = True):
        r = s.get(TaskRow, task_id)
        if not r:
            return
        now = datetime.now()
        r.deleted_at = now
        self.fts.remove(s, "task", task_id)
        if cascade:
            for child in s.scalars(select(TaskRow).where(TaskRow.parent_id == task_id,
                                                         TaskRow.deleted_at.is_(None))):
                self.soft_delete(s, child.id, cascade=True)

    def restore(self, s: Session, task_id: int):
        r = s.get(TaskRow, task_id)
        if r:
            r.deleted_at = None
            self.fts.index_task(s, r.id, r.title, r.notes_md)

    def purge(self, s: Session, task_id: int):
        """硬删除（回收站清空/到期清理）。

        删除前先解除所有指向本任务的外键引用：
        - task_tag / task_note_link：直接删行（虽已声明 ondelete=CASCADE，显式删更稳）；
        - 子任务（task.parent_id 自引用，无 ON DELETE）：父任务删除前把子任务 parent_id 置空
          （它们仍在回收站，随后单独 purge；避免 FOREIGN KEY constraint failed）；
        - 番茄钟记录：task_id 置空（回退「无关联任务」，不误删专注记录）。
        """
        s.execute(sa_delete(TaskTagRow).where(TaskTagRow.task_id == task_id))
        s.execute(sa_delete(TaskNoteLinkRow).where(TaskNoteLinkRow.task_id == task_id))
        s.execute(sa_delete(TaskNoteContextRow).where(TaskNoteContextRow.task_id == task_id))
        s.execute(sa_update(TaskRow).where(TaskRow.parent_id == task_id).values(parent_id=None))
        s.execute(sa_update(PomodoroRow).where(PomodoroRow.task_id == task_id).values(task_id=None))
        s.execute(sa_delete(TaskRow).where(TaskRow.id == task_id))
        self.fts.remove(s, "task", task_id)

    # ---------- 查询 ----------
    def list_all(self, s: Session, include_deleted: bool = False) -> List[Task]:
        q = select(TaskRow).order_by(TaskRow.sort_key, TaskRow.id)
        if not include_deleted:
            q = q.where(TaskRow.deleted_at.is_(None))
        return [_to_task(r) for r in s.scalars(q)]

    def children(self, s: Session, parent_id: int) -> List[Task]:
        rows = s.scalars(select(TaskRow).where(TaskRow.parent_id == parent_id,
                                               TaskRow.deleted_at.is_(None))
                         .order_by(TaskRow.sort_key, TaskRow.id))
        return [_to_task(r) for r in rows]

    def by_list(self, s: Session, list_id: int) -> List[Task]:
        rows = s.scalars(select(TaskRow).where(TaskRow.list_id == list_id,
                                               TaskRow.deleted_at.is_(None))
                         .order_by(TaskRow.sort_key, TaskRow.id))
        return [_to_task(r) for r in rows]

    def recurring_tasks(self, s: Session) -> List[Task]:
        rows = s.scalars(select(TaskRow).where(TaskRow.repeat_period != "none",
                                               TaskRow.deleted_at.is_(None)))
        return [_to_task(r) for r in rows]

    def due_between(self, s: Session, start: date, end: date) -> List[Task]:
        rows = s.scalars(select(TaskRow).where(TaskRow.deleted_at.is_(None),
                                               TaskRow.due_date >= start, TaskRow.due_date <= end)
                         .order_by(TaskRow.due_date, TaskRow.priority.desc()))
        return [_to_task(r) for r in rows]

    def due_reminders(self, s: Session, now: datetime) -> List[Task]:
        """到期待提醒任务：reminder_at 已到、且非终态/非等待中（暂停不打扰）。"""
        rows = s.scalars(select(TaskRow).where(
            TaskRow.deleted_at.is_(None),
            TaskRow.reminder_at.is_not(None),
            TaskRow.reminder_at <= now,
            TaskRow.status.not_in(("done", "abandoned", "waiting")),
        ).order_by(TaskRow.reminder_at))
        return [_to_task(r) for r in rows]

    def with_status_resume(self, s: Session, status: str, on_or_before: date) -> List[TaskRow]:
        """某状态且 resume_at 到期（<=on_or_before）的行（供自动恢复 waiting）。"""
        return list(s.scalars(select(TaskRow).where(
            TaskRow.deleted_at.is_(None),
            TaskRow.status == status,
            TaskRow.resume_at.is_not(None),
            TaskRow.resume_at <= on_or_before)))

    def search_titles(self, s: Session, q: str, limit: int = 20) -> List[Task]:
        rows = s.scalars(select(TaskRow).where(TaskRow.deleted_at.is_(None),
                                               TaskRow.title.contains(q)).limit(limit))
        return [_to_task(r) for r in rows]

    def count_by_status(self, s: Session, statuses: List[TaskStatus],
                        due_end: Optional[date] = None, due_start: Optional[date] = None) -> int:
        q = select(func.count(TaskRow.id)).where(TaskRow.deleted_at.is_(None),
                                                 TaskRow.status.in_([x.value for x in statuses]))
        if due_end is not None:
            q = q.where(TaskRow.due_date <= due_end)
        if due_start is not None:
            q = q.where(TaskRow.due_date >= due_start)
        return int(s.scalar(q) or 0)

    def completed_between(self, s: Session, start: datetime, end: datetime) -> List[Task]:
        rows = s.scalars(select(TaskRow).where(TaskRow.completed_at >= start,
                                               TaskRow.completed_at < end))
        return [_to_task(r) for r in rows]

    # ---------- 标签 ----------
    def set_tags(self, s: Session, task_id: int, tag_ids: List[int]):
        s.execute(sa_delete(TaskTagRow).where(TaskTagRow.task_id == task_id))
        for tid in tag_ids:
            s.add(TaskTagRow(task_id=task_id, tag_id=tid))

    def tag_ids(self, s: Session, task_id: int) -> List[int]:
        return list(s.scalars(select(TaskTagRow.tag_id).where(TaskTagRow.task_id == task_id)))

    # ---------- 任务-笔记关联 ----------
    def link_note(self, s: Session, task_id: int, note_id: int):
        exists = s.scalar(select(func.count(TaskNoteLinkRow.id)).where(
            TaskNoteLinkRow.task_id == task_id, TaskNoteLinkRow.note_id == note_id))
        if not exists:
            s.add(TaskNoteLinkRow(task_id=task_id, note_id=note_id))

    def unlink_note(self, s: Session, task_id: int, note_id: int):
        s.execute(sa_delete(TaskNoteLinkRow).where(TaskNoteLinkRow.task_id == task_id,
                                                   TaskNoteLinkRow.note_id == note_id))

    def linked_notes(self, s: Session, task_id: int) -> List[Note]:
        rows = s.execute(select(NoteRow).join(TaskNoteLinkRow, TaskNoteLinkRow.note_id == NoteRow.id)
                         .where(TaskNoteLinkRow.task_id == task_id, NoteRow.deleted_at.is_(None))).scalars()
        return [_to_note(r) for r in rows]

    def note_count(self, s: Session, task_id: int) -> int:
        return int(s.scalar(select(func.count(TaskNoteLinkRow.id))
                            .where(TaskNoteLinkRow.task_id == task_id)) or 0)

    def note_count_map(self, s: Session, task_ids: List[int]) -> Dict[int, int]:
        """批量装配任务关联笔记数（去 N+1）：一次 group by 查询返回 {task_id: count}。"""
        out: Dict[int, int] = {tid: 0 for tid in task_ids if tid is not None}
        if not out:
            return {}
        rows = s.execute(
            select(TaskNoteLinkRow.task_id, func.count(TaskNoteLinkRow.id))
            .where(TaskNoteLinkRow.task_id.in_(list(out)))
            .group_by(TaskNoteLinkRow.task_id)).all()
        for task_id, cnt in rows:
            out[task_id] = int(cnt or 0)
        return out

    def linked_count(self, s: Session, task_id: int, note_id: int) -> int:
        """(task,note) 是否已建归属（幂等判定）。"""
        return int(s.scalar(select(func.count(TaskNoteLinkRow.id)).where(
            TaskNoteLinkRow.task_id == task_id,
            TaskNoteLinkRow.note_id == note_id)) or 0)

    def tasks_for_note(self, s: Session, note_id: int) -> List[Task]:
        """把 note_id 列为关联笔记的全部未删任务（笔记侧归属分组展示）。"""
        rows = s.execute(
            select(TaskRow).join(TaskNoteLinkRow, TaskNoteLinkRow.task_id == TaskRow.id)
            .where(TaskNoteLinkRow.note_id == note_id, TaskRow.deleted_at.is_(None))
            .order_by(TaskRow.updated_at.desc())).scalars()
        return [_to_task(r) for r in rows]

    def candidates(self, s: Session, q: str = "", limit: int = 30) -> List[Task]:
        """活跃任务候选（主动「归属」选择器）：非删非终态；q 非空按标题模糊。"""
        stmt = select(TaskRow).where(
            TaskRow.deleted_at.is_(None),
            TaskRow.status.not_in(("done", "abandoned")))
        if q:
            stmt = stmt.where(TaskRow.title.contains(q))
        rows = s.scalars(stmt.order_by(TaskRow.updated_at.desc()).limit(limit))
        return [_to_task(r) for r in rows]

    # ---------- 任务-笔记「段落级」上下文（v0.15 P0-1） ----------
    def link_context(self, s: Session, task_id: int, note_id: int,
                     block_key: str, snippet: str = "") -> Optional[TaskNoteContext]:
        """记录任务关联笔记内某段落；同 (task,note,block_key) 幂等。"""
        if not block_key:
            return None
        exists = s.scalar(select(func.count(TaskNoteContextRow.id)).where(
            TaskNoteContextRow.task_id == task_id,
            TaskNoteContextRow.note_id == note_id,
            TaskNoteContextRow.block_key == block_key))
        if exists:
            return None
        row = TaskNoteContextRow(task_id=task_id, note_id=note_id,
                                 block_key=block_key, snippet=snippet or "")
        s.add(row)
        s.flush()
        return _to_context(row)

    def unlink_context(self, s: Session, task_id: int, note_id: int, block_key: str = ""):
        q = sa_delete(TaskNoteContextRow).where(TaskNoteContextRow.task_id == task_id,
                                                TaskNoteContextRow.note_id == note_id)
        if block_key:
            q = q.where(TaskNoteContextRow.block_key == block_key)
        s.execute(q)

    def linked_contexts(self, s: Session, task_id: int) -> List[TaskNoteContext]:
        """某任务的全部段落上下文（保留 note 删除过滤：软删 note 一并隐去）。"""
        rows = s.execute(
            select(TaskNoteContextRow).join(NoteRow, NoteRow.id == TaskNoteContextRow.note_id)
            .where(TaskNoteContextRow.task_id == task_id, NoteRow.deleted_at.is_(None))
            .order_by(TaskNoteContextRow.id)).scalars()
        return [_to_context(r) for r in rows]

    def contexts_for_note(self, s: Session, note_id: int) -> List[TaskNoteContext]:
        """某笔记的全部段落上下文（图谱反链/预览用）。"""
        rows = s.scalars(select(TaskNoteContextRow).where(
            TaskNoteContextRow.note_id == note_id).order_by(TaskNoteContextRow.id))
        return [_to_context(r) for r in rows]

    def context_notes_for(self, s: Session, task_ids: List[int]) -> Dict[int, List[TaskNoteContext]]:
        """批量取多任务的段落上下文（图谱 task→anchor 构建用）。"""
        if not task_ids:
            return {}
        rows = s.scalars(select(TaskNoteContextRow).where(
            TaskNoteContextRow.task_id.in_(task_ids)))
        out: Dict[int, List[TaskNoteContext]] = {}
        for r in rows:
            out.setdefault(r.task_id, []).append(_to_context(r))
        return out

    def sort_key_batch(self, s: Session, task_id: int, sort_key: float):
        s.execute(sa_update(TaskRow).where(TaskRow.id == task_id)
                  .values(sort_key=sort_key, updated_at=datetime.now()))


class ListFolderRepository:
    def __init__(self, db: Database):
        self.db = db

    def create(self, s: Session, f: ListFolder) -> ListFolder:
        r = ListFolderRow(parent_id=f.parent_id, kind=f.kind.value, name=f.name, icon=f.icon,
                          collapsed=f.collapsed,
                          sort=f.sort if f.sort else _next_sort(s, ListFolderRow, ListFolderRow.parent_id, f.parent_id))
        s.add(r)
        s.flush()
        f.id = r.id
        return f

    def update(self, s: Session, f: ListFolder):
        r = s.get(ListFolderRow, f.id)
        if r:
            r.name, r.icon, r.collapsed, r.sort, r.parent_id = f.name, f.icon, f.collapsed, f.sort, f.parent_id

    def get(self, s: Session, fid: int) -> Optional[ListFolder]:
        r = s.get(ListFolderRow, fid)
        return _to_folder(r) if r else None

    def all(self, s: Session) -> List[ListFolder]:
        rows = s.scalars(select(ListFolderRow).order_by(ListFolderRow.sort, ListFolderRow.id))
        return [_to_folder(r) for r in rows]

    def children(self, s: Session, parent_id: Optional[int]) -> List[ListFolder]:
        rows = s.scalars(select(ListFolderRow).where(ListFolderRow.parent_id == parent_id)
                         .order_by(ListFolderRow.sort, ListFolderRow.id))
        return [_to_folder(r) for r in rows]

    def delete(self, s: Session, fid: int):
        """删除列表：任务回落收件箱；删除分组：子节点上移一级。"""
        r = s.get(ListFolderRow, fid)
        if not r:
            return
        if r.kind == "list":
            s.execute(sa_update(TaskRow).where(TaskRow.list_id == fid).values(list_id=None))
        s.execute(sa_update(ListFolderRow).where(ListFolderRow.parent_id == fid)
                  .values(parent_id=r.parent_id))
        s.execute(sa_delete(ListFolderRow).where(ListFolderRow.id == fid))

    def find_by_name(self, s: Session, name: str) -> Optional[ListFolder]:
        r = s.scalars(select(ListFolderRow).where(ListFolderRow.name == name,
                                                  ListFolderRow.kind == "list")).first()
        return _to_folder(r) if r else None


class NoteRepository:
    def __init__(self, db: Database, fts: FTSService):
        self.db = db
        self.fts = fts

    def create(self, s: Session, n: Note) -> Note:
        r = NoteRow(folder_id=n.folder_id, title=n.title or "无标题", content_md=n.content_md,
                    format=n.format or "markdown", pinned=n.pinned,
                    word_count=len(n.content_md or ""))
        s.add(r)
        s.flush()
        self.fts.index_note(s, r.id, r.title, r.content_md)
        n.id, n.word_count = r.id, r.word_count
        return n

    def update(self, s: Session, n: Note):
        r = s.get(NoteRow, n.id)
        if not r:
            return
        r.title, r.content_md, r.folder_id = n.title, n.content_md, n.folder_id
        r.format, r.pinned = n.format or "markdown", n.pinned
        r.word_count = len(n.content_md or "")
        r.updated_at = datetime.now()
        self.fts.index_note(s, r.id, r.title, r.content_md)

    def get(self, s: Session, note_id: int) -> Optional[Note]:
        r = s.get(NoteRow, note_id)
        return _to_note(r) if r else None

    def by_title(self, s: Session, title: str) -> Optional[Note]:
        r = s.scalars(select(NoteRow).where(NoteRow.title == title, NoteRow.deleted_at.is_(None))).first()
        return _to_note(r) if r else None

    def all(self, s: Session, folder_id: Optional[int] = None, q: str = "",
            include_deleted: bool = False) -> List[Note]:
        stmt = select(NoteRow).order_by(NoteRow.pinned.desc(), NoteRow.updated_at.desc())
        conds = []
        if not include_deleted:
            conds.append(NoteRow.deleted_at.is_(None))
        if folder_id is not None:
            conds.append(NoteRow.folder_id == folder_id)
        if q:
            conds.append(NoteRow.title.contains(q))
        if conds:
            stmt = stmt.where(*conds)
        return [_to_note(r) for r in s.scalars(stmt)]

    def soft_delete(self, s: Session, note_id: int):
        r = s.get(NoteRow, note_id)
        if r:
            r.deleted_at = datetime.now()
            self.fts.remove(s, "note", note_id)

    def restore(self, s: Session, note_id: int):
        r = s.get(NoteRow, note_id)
        if r:
            r.deleted_at = None
            self.fts.index_note(s, r.id, r.title, r.content_md)

    def purge(self, s: Session, note_id: int):
        """硬删除（含版本历史、标签、链接）。"""
        s.execute(sa_delete(NoteTagRow).where(NoteTagRow.note_id == note_id))
        s.execute(sa_delete(NoteLinkRow).where(NoteLinkRow.src_note_id == note_id))
        from .models import NoteRevisionRow
        s.execute(sa_delete(NoteRevisionRow).where(NoteRevisionRow.note_id == note_id))
        s.execute(sa_delete(NoteRow).where(NoteRow.id == note_id))
        self.fts.remove(s, "note", note_id)

    def set_tags(self, s: Session, note_id: int, tag_ids: List[int]):
        s.execute(sa_delete(NoteTagRow).where(NoteTagRow.note_id == note_id))
        for tid in tag_ids:
            s.add(NoteTagRow(note_id=note_id, tag_id=tid))

    def tag_ids(self, s: Session, note_id: int) -> List[int]:
        return list(s.scalars(select(NoteTagRow.tag_id).where(NoteTagRow.note_id == note_id)))

    def recent(self, s: Session, limit: int = 5) -> List[Note]:
        rows = s.scalars(select(NoteRow).where(NoteRow.deleted_at.is_(None))
                         .order_by(NoteRow.updated_at.desc()).limit(limit))
        return [_to_note(r) for r in rows]


class NoteLinkRepository:
    def __init__(self, db: Database):
        self.db = db

    def replace_links(self, s: Session, src_note_id: int, titles: List[str],
                      resolve) -> Dict[str, int]:
        """以标题集合全量替换出链。resolve(title)->note_id|None。返回 diff 统计。"""
        old = {r.dst_title: r for r in s.scalars(select(NoteLinkRow)
                                                .where(NoteLinkRow.src_note_id == src_note_id))}
        added, removed = 0, 0
        seen = set()
        for title in titles:
            key = title
            if key in seen:
                continue
            seen.add(key)
            if key in old:
                row = old.pop(key)
                dst = resolve(title)
                if (row.dst_note_id or None) != (dst or None):
                    row.dst_note_id = dst
            else:
                s.add(NoteLinkRow(src_note_id=src_note_id, dst_title=key, dst_note_id=resolve(title)))
                added += 1
        for row in old.values():
            s.delete(row)
            removed += 1
        return {"added": added, "removed": removed}

    def rename_target(self, s: Session, old_title: str, new_title: str):
        s.execute(sa_update(NoteLinkRow).where(NoteLinkRow.dst_title == old_title)
                  .values(dst_title=new_title))

    def out_links(self, s: Session, note_id: int) -> List[NoteLink]:
        rows = s.scalars(select(NoteLinkRow).where(NoteLinkRow.src_note_id == note_id))
        return [NoteLink(id=r.id, src_note_id=r.src_note_id, dst_note_id=r.dst_note_id,
                         dst_title=r.dst_title) for r in rows]

    def add_or_bind(self, s: Session, src_note_id: int, dst_title: str,
                    dst_note_id: Optional[int]) -> str:
        """手动建引用链（主动「+引用」）：按 (src, dst_title) 维度幂等。

        - 无既有行 → 新增（dst_note_id 为 None 即「待建」悬空），返回 ``added``；
        - 既有行目标一致（含悬空 vs 悬空）→ 不建行，返回 ``unchanged``；
        - 既有行目标不同（悬空转正 / 改指同标题另一笔记）→ 更新 dst_note_id，返回 ``bound``。
        """
        if not dst_title:
            return "invalid"
        row = s.scalars(select(NoteLinkRow).where(
            NoteLinkRow.src_note_id == src_note_id,
            NoteLinkRow.dst_title == dst_title)).first()
        if row is None:
            s.add(NoteLinkRow(src_note_id=src_note_id, dst_title=dst_title,
                              dst_note_id=dst_note_id))
            return "added"
        if (row.dst_note_id or None) == (dst_note_id or None):
            return "unchanged"
        row.dst_note_id = dst_note_id
        return "bound"

    def backlinks(self, s: Session, note_id: int, note_repo: NoteRepository) -> List[BacklinkItem]:
        """链向我（按 id 或按标题）的来源笔记 + 上下文。"""
        me = note_repo.get(s, note_id)
        cond = (NoteLinkRow.dst_note_id == note_id)
        if me is not None:
            from sqlalchemy import or_
            cond = or_(cond, NoteLinkRow.dst_title == me.title)
        rows = s.execute(select(NoteLinkRow, NoteRow)
                         .join(NoteRow, NoteRow.id == NoteLinkRow.src_note_id)
                         .where(NoteRow.deleted_at.is_(None), cond)).all()
        from ...model.domain.link_parser import snippet_around
        items: List[BacklinkItem] = []
        for link, src in rows:
            items.append(BacklinkItem(src_note_id=src.id, src_title=src.title,
                                      snippet=snippet_around(src.content_md or "", link.dst_title)))
        return items

    def dangle_links_to(self, s: Session, note_id: int) -> int:
        """把指向 note_id 的出链悬空化：dst_note_id→NULL，保留 dst_title 成「待建链接」。"""
        result = s.execute(sa_update(NoteLinkRow).where(NoteLinkRow.dst_note_id == note_id)
                           .values(dst_note_id=None))
        return result.rowcount or 0

    def all_links(self, s: Session) -> List[Tuple[int, Optional[int], str]]:
        rows = s.execute(select(NoteLinkRow.src_note_id, NoteLinkRow.dst_note_id,
                                NoteLinkRow.dst_title)).all()
        return [(r[0], r[1], r[2]) for r in rows]

    def broken_links(self, s: Session) -> List[Tuple[int, str]]:
        """失效链接检测：dst_note_id 悬空（待建/目标已删）且标题尚未解析到现存笔记。

        返回 [(src_note_id, dst_title)]，供笔记侧「链接失效」面板展示与一键修复。
        含两类：dst_note_id 为 NULL（待建）与 dst_note_id 指向已软删笔记（软删后
        dangle_links_to 已置 NULL，故此处主要覆盖 NULL 待建 + 标题已不存在的历史悬空）。
        """
        rows = s.execute(
            select(NoteLinkRow.src_note_id, NoteLinkRow.dst_title)
            .where(NoteLinkRow.dst_note_id.is_(None))
            .order_by(NoteLinkRow.src_note_id)).all()
        # 过滤：标题仍能解析到现存笔记的（例如手动 [[链接]] 尚未绑定 dst_note_id）不算失效
        existing_titles = {t for (t,) in s.execute(
            select(NoteRow.title).where(NoteRow.deleted_at.is_(None))).all()}
        return [(sid, title) for sid, title in rows if title not in existing_titles]


class FlashRepository:
    def __init__(self, db: Database, fts: FTSService):
        self.db = db
        self.fts = fts

    def add(self, s: Session, f: Flash) -> Flash:
        r = FlashRow(content=f.content, remark=f.remark, source_app=f.source_app,
                     source_url=f.source_url, status=f.status.value)
        s.add(r)
        s.flush()
        self.fts.index_flash(s, r.id, r.content, r.remark)
        f.id = r.id
        return f

    def update(self, s: Session, f: Flash):
        r = s.get(FlashRow, f.id)
        if r:
            r.content, r.remark, r.status = f.content, f.remark, f.status.value
            r.converted_type, r.converted_id, r.deleted_at = f.converted_type, f.converted_id, f.deleted_at
            self.fts.index_flash(s, r.id, r.content, r.remark)

    def get(self, s: Session, fid: int) -> Optional[Flash]:
        r = s.get(FlashRow, fid)
        return _to_flash(r) if r else None

    def list(self, s: Session, status: Optional[FlashStatus] = None) -> List[Flash]:
        stmt = select(FlashRow).where(FlashRow.deleted_at.is_(None)).order_by(FlashRow.created_at.desc())
        if status is not None:
            stmt = stmt.where(FlashRow.status == status.value)
        return [_to_flash(r) for r in s.scalars(stmt)]

    def soft_delete(self, s: Session, fid: int):
        r = s.get(FlashRow, fid)
        if r:
            r.deleted_at = datetime.now()
            self.fts.remove(s, "flash", fid)

    def restore(self, s: Session, fid: int):
        r = s.get(FlashRow, fid)
        if r:
            r.deleted_at = None
            self.fts.index_flash(s, r.id, r.content, r.remark)

    def purge(self, s: Session, fid: int):
        s.execute(sa_delete(FlashTagRow).where(FlashTagRow.flash_id == fid))
        s.execute(sa_delete(FlashRow).where(FlashRow.id == fid))
        self.fts.remove(s, "flash", fid)

    def set_tags(self, s: Session, fid: int, tag_ids: List[int]):
        s.execute(sa_delete(FlashTagRow).where(FlashTagRow.flash_id == fid))
        for tid in tag_ids:
            s.add(FlashTagRow(flash_id=fid, tag_id=tid))

    def tag_ids(self, s: Session, fid: int) -> List[int]:
        return list(s.scalars(select(FlashTagRow.tag_id).where(FlashTagRow.flash_id == fid)))


class TagRepository:
    def __init__(self, db: Database):
        self.db = db

    def ensure(self, s: Session, name: str, color: str = "#0D9488") -> int:
        r = s.scalars(select(TagRow).where(TagRow.name == name)).first()
        if r:
            return r.id
        r = TagRow(name=name, color=color)
        s.add(r)
        s.flush()
        return r.id

    def all(self, s: Session) -> List[Tuple[int, str, str]]:
        rows = s.scalars(select(TagRow).order_by(TagRow.name))
        return [(r.id, r.name, r.color) for r in rows]

    def rename(self, s: Session, tid: int, name: str):
        r = s.get(TagRow, tid)
        if r:
            r.name = name

    def delete(self, s: Session, tid: int):
        s.execute(sa_delete(TagRow).where(TagRow.id == tid))

    def merge(self, s: Session, target: int, sources: List[int]):
        """把 sources 的 task_tag/note_tag/flash_tag 关联重挂到 target（F1-6 合并）。

        目标已存在同实体同标签则跳过，否则重挂；调用方负责最终 delete 来源标签。
        """
        for src in sources:
            for model, fk in ((TaskTagRow, "task_id"), (NoteTagRow, "note_id"),
                              (FlashTagRow, "flash_id")):
                rows = s.execute(
                    select(model).where(model.tag_id == src)).scalars().all()
                for r in rows:
                    dup = s.execute(
                        select(model).where(
                            model.tag_id == target,
                            getattr(model, fk) == getattr(r, fk),
                        )).scalars().first()
                    if dup is None:
                        r.tag_id = target

    def usage_count(self, s: Session, tid: int) -> int:
        a = s.scalar(select(func.count(TaskTagRow.task_id)).where(TaskTagRow.tag_id == tid)) or 0
        b = s.scalar(select(func.count(NoteTagRow.note_id)).where(NoteTagRow.tag_id == tid)) or 0
        return int(a + b)

    def distribution(self, s: Session, limit: int = 8) -> List[Tuple[str, str, int]]:
        """(name, color, count) 供环形图。"""
        counts: Dict[str, int] = {}
        colors: Dict[str, str] = {}
        for row in s.execute(select(TagRow.name, TagRow.color, TaskTagRow.task_id)
                             .join(TaskTagRow, TaskTagRow.tag_id == TagRow.id)).all():
            counts[row[0]] = counts.get(row[0], 0) + 1
            colors[row[0]] = row[1]
        for row in s.execute(select(TagRow.name, TagRow.color, NoteTagRow.note_id)
                             .join(NoteTagRow, NoteTagRow.tag_id == TagRow.id)).all():
            counts[row[0]] = counts.get(row[0], 0) + 1
            colors[row[0]] = row[1]
        items = sorted(counts.items(), key=lambda kv: -kv[1])[:limit]
        return [(n, colors.get(n, "#0D9488"), c) for n, c in items]


class PomodoroRepository:
    def __init__(self, db: Database):
        self.db = db

    def add(self, s: Session, task_id: Optional[int], minutes: int, completed: bool,
            reason: Optional[str] = None):
        s.add(PomodoroRow(task_id=task_id, started_at=datetime.now(), minutes=minutes,
                          completed=completed, reason=reason))

    def list(self, s: Session, limit: int = 50) -> List[PomodoroSession]:
        """按开始时间倒序返回番茄钟记录（含中断原因 reason）。"""
        rows = s.scalars(select(PomodoroRow).order_by(PomodoroRow.started_at.desc()).limit(limit))
        return [PomodoroSession(id=r.id, task_id=r.task_id, started_at=r.started_at,
                                minutes=r.minutes, completed=bool(r.completed),
                                reason=r.reason) for r in rows]

    def minutes_by_day(self, s: Session, start: date, days: int = 7) -> List[int]:
        rows = s.execute(
            select(func.strftime("%Y-%m-%d", PomodoroRow.started_at),
                   func.sum(PomodoroRow.minutes))
            .where(PomodoroRow.started_at >= datetime.combine(start, datetime.min.time()),
                   PomodoroRow.completed == True)  # noqa: E712
            .group_by(func.strftime("%Y-%m-%d", PomodoroRow.started_at))).all()
        m = {r[0]: int(r[1] or 0) for r in rows}
        return [m.get((start + timedelta(days=i)).strftime("%Y-%m-%d"), 0) for i in range(days)]


class SettingRepository:
    def __init__(self, db: Database):
        self.db = db

    def get(self, s: Session, key: str, default: str = "") -> str:
        return s.get(SettingRow, key).value if s.get(SettingRow, key) else default

    def set(self, s: Session, key: str, value: str):
        r = s.get(SettingRow, key)
        if r:
            r.value = value
        else:
            s.add(SettingRow(key=key, value=value))


def _next_sort(s: Session, model, col, value) -> float:
    """取最大 sort 值 + 1（兼容 sort_key / sort 两种列名；个人规模足够）。"""
    col_ref = getattr(model, "sort_key", None)
    if col_ref is None:
        col_ref = getattr(model, "sort")
    mx = s.scalar(select(func.max(col_ref))) or 0.0
    return float(mx) + 1.0
