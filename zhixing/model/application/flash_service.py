# -*- coding: utf-8 -*-
"""闪念服务：划词捕获的零散知识落点与整理闭环。"""
from datetime import datetime, timedelta
from typing import List, Optional

from ...core.event_bus import EventBus
from ..domain.entities import Flash, FlashStatus
from ..infrastructure.db import Database
from ..infrastructure.repositories import FlashRepository, TagRepository


class FlashService:
    def __init__(self, db: Database, bus: EventBus, flashes: FlashRepository,
                 tags: TagRepository):
        self.db, self.bus = db, bus
        self.flashes, self.tags = flashes, tags

    def add(self, content: str, remark: str = "", source_app: str = "",
            source_url: str = "") -> Optional[Flash]:
        content = (content or "").strip()
        if not content:
            return None
        f = Flash(content=content[:2000], remark=remark[:200], source_app=source_app,
                  source_url=source_url)
        s = self.db.session()
        try:
            self.flashes.add(s, f)
            s.commit()
        finally:
            s.close()
        self.bus.flash_changed.emit(f.id, "added")
        return f

    def get(self, fid: int) -> Optional[Flash]:
        s = self.db.session()
        try:
            return self.flashes.get(s, fid)
        finally:
            s.close()

    def list(self, status: Optional[FlashStatus] = FlashStatus.INBOX) -> List[Flash]:
        s = self.db.session()
        try:
            return self.flashes.list(s, status)
        finally:
            s.close()

    def inbox_count(self) -> int:
        return len(self.list(FlashStatus.INBOX))

    def archive(self, fid: int) -> Optional[Flash]:
        """置 archived 写路径（F11-4）：收件箱整理完成后归档。"""
        s = self.db.session()
        try:
            f = self.flashes.get(s, fid)
            if not f:
                return None
            f.status = FlashStatus.ARCHIVED
            self.flashes.update(s, f)
            s.commit()
            fresh = self.flashes.get(s, fid)
        finally:
            s.close()
        self.bus.flash_changed.emit(fid, "archived")
        return fresh

    def unarchive(self, fid: int) -> Optional[Flash]:
        """归档 → 收件箱（撤销归档）。"""
        s = self.db.session()
        try:
            f = self.flashes.get(s, fid)
            if not f:
                return None
            f.status = FlashStatus.INBOX
            self.flashes.update(s, f)
            s.commit()
            fresh = self.flashes.get(s, fid)
        finally:
            s.close()
        self.bus.flash_changed.emit(fid, "updated")
        return fresh

    def archived(self) -> List[Flash]:
        """已归档闪念查询（F11-4）。"""
        return self.list(FlashStatus.ARCHIVED)

    def update_remark(self, fid: int, remark: str):
        s = self.db.session()
        try:
            f = self.flashes.get(s, fid)
            if f:
                f.remark = remark
                self.flashes.update(s, f)
                s.commit()
        finally:
            s.close()
        self.bus.flash_changed.emit(fid, "updated")

    def tag(self, fid: int, tag_names: List[str]):
        s = self.db.session()
        try:
            ids = [self.tags.ensure(s, n.strip()) for n in tag_names if n.strip()]
            self.flashes.set_tags(s, fid, ids)
            s.commit()
        finally:
            s.close()
        self.bus.flash_changed.emit(fid, "updated")
        self.bus.tag_changed.emit()

    def merge(self, ids: List[int]) -> Optional[Flash]:
        """把多条闪念合并为一条（合并 tags/source_url，清理 fi.deleted_at 死赋值）。"""
        items = [self.get(i) for i in ids]
        items = [i for i in items if i]
        if len(items) < 2:
            return items[0] if items else None
        source_url = next((i.source_url for i in items if i.source_url), "")
        merged = Flash(content="\n\n---\n\n".join(i.content for i in items),
                       remark=items[0].remark, source_app=items[0].source_app,
                       source_url=source_url)
        s = self.db.session()
        try:
            self.flashes.add(s, merged)
            tag_ids = set()
            for i in items:
                tag_ids.update(self.flashes.tag_ids(s, i.id))
            if tag_ids:
                self.flashes.set_tags(s, merged.id, sorted(tag_ids))
            for i in items:
                self.flashes.soft_delete(s, i.id)
            s.commit()
        finally:
            s.close()
        self.bus.flash_changed.emit(merged.id if merged else 0, "merged")
        self.bus.tag_changed.emit()
        return merged

    def delete(self, fid: int):
        s = self.db.session()
        try:
            self.flashes.soft_delete(s, fid)
            s.commit()
        finally:
            s.close()
        self.bus.flash_changed.emit(fid, "deleted")

    # ---------- 回收站（F9-3） ----------
    def trash(self) -> List[Flash]:
        s = self.db.session()
        try:
            from ..infrastructure.models import FlashRow
            from ..infrastructure.repositories import _to_flash
            rows = s.query(FlashRow).filter(FlashRow.deleted_at.is_not(None))\
                .order_by(FlashRow.deleted_at.desc()).all()
            return [_to_flash(r) for r in rows]
        finally:
            s.close()

    def restore(self, fid: int):
        s = self.db.session()
        try:
            self.flashes.restore(s, fid)
            s.commit()
        finally:
            s.close()
        self.bus.flash_changed.emit(fid, "restored")

    def purge(self, fid: int):
        s = self.db.session()
        try:
            self.flashes.purge(s, fid)
            s.commit()
        finally:
            s.close()
        self.bus.flash_changed.emit(fid, "purged")

    def purge_older_than(self, days: int = 30) -> int:
        cutoff = datetime.now() - timedelta(days=days)
        stale = [f for f in self.trash()
                 if f.deleted_at is not None and f.deleted_at < cutoff]
        for f in stale:
            self.purge(f.id)
        return len(stale)

    # ---------- 整理闭环 ----------
    def to_note(self, fid: int, note_service, folder_id: Optional[int] = None) -> Optional:
        f = self.get(fid)
        if not f:
            return None
        title = (f.remark or f.content).split("\n")[0][:40] or "来自闪念"
        note = note_service.create(title=title, content_md=f.content, folder_id=folder_id)
        self._mark_converted(f, "note", note.id)
        return note

    def to_task(self, fid: int, task_service) -> Optional:
        f = self.get(fid)
        if not f:
            return None
        title = (f.content or "").split("\n")[0][:60] or "来自闪念的任务"
        task = task_service.create(title, notes_md=f"来自闪念：{f.content[:200]}")
        self._mark_converted(f, "task", task.id)
        return task

    def to_subtask(self, fid: int, parent_task_id: int, task_service) -> Optional:
        f = self.get(fid)
        if not f:
            return None
        title = (f.content or "").split("\n")[0][:60] or "来自闪念的子任务"
        task = task_service.create(title, parent_id=parent_task_id,
                                   notes_md=f"来自闪念：{f.content[:200]}")
        self._mark_converted(f, "subtask", task.id)
        return task

    def _mark_converted(self, f: Flash, kind: str, target_id: int):
        s = self.db.session()
        try:
            fresh = self.flashes.get(s, f.id)
            if fresh:
                fresh.status = FlashStatus.CONVERTED
                fresh.converted_type = kind
                fresh.converted_id = target_id
                self.flashes.update(s, fresh)
                s.commit()
        finally:
            s.close()
        self.bus.flash_changed.emit(f.id, "converted")
