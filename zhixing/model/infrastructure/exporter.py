# -*- coding: utf-8 -*-
"""导入导出：全量 JSON 归档、笔记 Markdown zip、任务 CSV。"""
import csv
import io
import json
import zipfile
from datetime import date, datetime
from pathlib import Path
from typing import List

from sqlalchemy import select

from .db import Database
from .models import (
    AttachmentRow, FlashRow, FlashTagRow, ListFolderRow, NoteFolderRow, NoteLinkRow,
    NoteRevisionRow, NoteRow, NoteTagRow, PomodoroRow, SettingRow, TagRow, TaskNoteLinkRow,
    TaskRow, TaskTagRow,
)


class Exporter:
    def __init__(self, db: Database):
        self.db = db

    def export_json(self, path: Path):
        s = self.db.session()
        try:
            data = {
                "app": "zhixing", "version": 1,
                "list_folder": [_row_dict(r) for r in s.scalars(select(ListFolderRow))],
                "task": [_row_dict(r) for r in s.scalars(select(TaskRow))],
                "task_tag": [_row_dict(r) for r in s.scalars(select(TaskTagRow))],
                "note_folder": [_row_dict(r) for r in s.scalars(select(NoteFolderRow))],
                "note": [_row_dict(r) for r in s.scalars(select(NoteRow))],
                "note_tag": [_row_dict(r) for r in s.scalars(select(NoteTagRow))],
                "note_link": [_row_dict(r) for r in s.scalars(select(NoteLinkRow))],
                "task_note_link": [_row_dict(r) for r in s.scalars(select(TaskNoteLinkRow))],
                "flash": [_row_dict(r) for r in s.scalars(select(FlashRow))],
                "flash_tag": [_row_dict(r) for r in s.scalars(select(FlashTagRow))],
                "note_revision": [_row_dict(r) for r in s.scalars(select(NoteRevisionRow))],
                "attachment": [_row_dict(r) for r in s.scalars(select(AttachmentRow))],
                "pomodoro_session": [_row_dict(r) for r in s.scalars(select(PomodoroRow))],
                "tag": [_row_dict(r) for r in s.scalars(select(TagRow))],
                "settings": [_row_dict(r) for r in s.scalars(select(SettingRow))],
            }
        finally:
            s.close()
        path.write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str), encoding="utf-8")

    def export_notes_markdown(self, path: Path):
        s = self.db.session()
        try:
            notes = s.scalars(select(NoteRow).where(NoteRow.deleted_at.is_(None))).all()
        finally:
            s.close()
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
            for n in notes:
                folder = f"folder-{n.folder_id}" if n.folder_id else "root"
                safe = "".join(c for c in n.title if c not in '\\/:*?"<>|').strip() or f"note-{n.id}"
                zf.writestr(f"{folder}/{safe}.md", f"# {n.title}\n\n{n.content_md or ''}")

    def export_notes_folder(self, folder: Path, note_repo) -> int:
        """把全部未删笔记导出为 Markdown 文件夹镜像（子目录按 note_folder 名映射）。

        用于 Obsidian 等外部工具互操作：每篇笔记一个 .md 文件，首行为 ``# 标题``，
        目录结构按笔记文件夹名递归映射；重名追加 id 防覆盖。返回导出的文件数。
        """
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=True)
        s = self.db.session()
        try:
            folders = {f.id: f for f in s.scalars(select(NoteFolderRow))}
            notes = s.scalars(select(NoteRow).where(NoteRow.deleted_at.is_(None))).all()
        finally:
            s.close()

        def _safe(name: str, fallback: str) -> str:
            return "".join(c for c in name if c not in '\\/:*?"<>|').strip() or fallback

        # 文件夹名 → 路径（处理嵌套：沿 parent_id 递归拼目录）
        def _dir_path(fid) -> Path:
            parts = []
            cur = fid
            seen = set()
            while cur is not None and cur not in seen:
                seen.add(cur)
                f = folders.get(cur)
                if not f:
                    break
                parts.append(_safe(f.name, f"folder-{f.id}"))
                cur = f.parent_id
            return folder.joinpath(*reversed(parts)) if parts else folder

        used = set()
        count = 0
        for n in notes:
            base = _safe(n.title, f"note-{n.id}")
            name = f"{base}.md"
            i = 2
            while name in used:
                name = f"{base}-{i}.md"
                i += 1
            used.add(name)
            dest = _dir_path(n.folder_id) / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(f"# {n.title}\n\n{n.content_md or ''}", encoding="utf-8")
            count += 1
        return count

    def export_tasks_csv(self, path: Path):
        s = self.db.session()
        try:
            tasks = s.scalars(select(TaskRow)).all()
        finally:
            s.close()
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["id", "标题", "状态", "优先级", "截止日期", "列表", "父任务", "循环", "备注"])
        for t in tasks:
            w.writerow([t.id, t.title, t.status, int(t.priority or 0),
                        t.due_date.strftime("%Y-%m-%d") if t.due_date else "",
                        t.list_id or "", t.parent_id or "", t.repeat_period,
                        (t.notes_md or "").replace("\n", " ")])
        path.write_text("\ufeff" + buf.getvalue(), encoding="utf-8-sig")


class Importer:
    def __init__(self, db: Database):
        self.db = db

    def import_json(self, path: Path) -> dict:
        """全量恢复（覆盖式）：导入前应已执行备份。"""
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if data.get("app") != "zhixing":
            raise ValueError("不是「知行」的导出文件")
        s = self.db.session()
        id_maps = {}
        try:
            for table, model, cols in [
                ("list_folder", ListFolderRow, ["id", "parent_id", "kind", "name", "icon",
                                              "collapsed", "sort", "created_at"]),
                ("task", TaskRow, ["id", "title", "notes_md", "status", "priority", "due_date",
                                   "start_date", "reminder_at", "list_id", "parent_id",
                                   "repeat_period", "repeat_rule", "streak", "last_reset_date",
                                   "sort_key", "completed_at", "deleted_at", "created_at",
                                   "updated_at"]),
                ("note_folder", NoteFolderRow, ["id", "parent_id", "name", "sort"]),
                ("note", NoteRow, ["id", "folder_id", "title", "content_md", "format", "pinned",
                                   "word_count", "deleted_at", "created_at", "updated_at"]),
                ("flash", FlashRow, ["id", "content", "remark", "source_app", "source_url",
                                     "status", "converted_type", "converted_id", "deleted_at",
                                     "created_at"]),
                ("tag", TagRow, ["id", "name", "color"]),
            ]:
                s.query(model).delete()
                s.flush()
                id_maps[table] = _insert_rows(s, model, cols, data.get(table, []))
            for table, model, cols, keycols in [
                ("task_tag", TaskTagRow, ["task_id", "tag_id"], ["task_id", "tag_id"]),
                ("note_tag", NoteTagRow, ["note_id", "tag_id"], ["note_id", "tag_id"]),
                ("flash_tag", FlashTagRow, ["flash_id", "tag_id"], ["flash_id", "tag_id"]),
                ("task_note_link", TaskNoteLinkRow, ["task_id", "note_id"], ["task_id", "note_id"]),
            ]:
                s.query(model).delete()
                s.flush()
                for row in data.get(table, []):
                    kw = {k: id_maps[_src_table(k)].get(row.get(k)) for k in keycols}
                    if all(v is not None for v in kw.values()):
                        s.add(model(**kw))
            # 带外键的从表：note_revision / attachment / pomodoro_session（F8-2/F8-3 补全）
            for table, model, fk_col, src_table, nullable, extra_cols in [
                ("note_revision", NoteRevisionRow, "note_id", "note", False,
                 ["title", "content_md", "format", "created_at"]),
                ("attachment", AttachmentRow, "note_id", "note", False,
                 ["path", "kind", "created_at"]),
                ("pomodoro_session", PomodoroRow, "task_id", "task", True,
                 ["started_at", "minutes", "completed", "reason"]),
            ]:
                s.query(model).delete()
                s.flush()
                for row in data.get(table, []):
                    raw_fk = row.get(fk_col)
                    fk = id_maps[src_table].get(raw_fk) if raw_fk is not None else None
                    if raw_fk is None and not nullable:
                        continue
                    if raw_fk is not None and fk is None:
                        continue
                    kw = {fk_col: fk}
                    for c in extra_cols:
                        v = row.get(c)
                        if c.endswith("_date"):
                            v = _parse_date_value(v)
                        elif c.endswith("_at"):
                            v = _parse_dt_value(v)
                        kw[c] = v
                    s.add(model(**kw))
            s.query(NoteLinkRow).delete()
            s.flush()
            for row in data.get("note_link", []):
                src = id_maps["note"].get(row.get("src_note_id"))
                dst = id_maps["note"].get(row.get("dst_note_id"))
                if src:
                    s.add(NoteLinkRow(src_note_id=src, dst_note_id=dst,
                                      dst_title=row.get("dst_title", "")))
            for row in data.get("settings", []):
                key, value = row.get("key"), row.get("value")
                if key and key != "schema_version":
                    r = s.get(SettingRow, key)
                    if r:
                        r.value = value
                    else:
                        s.add(SettingRow(key=key, value=value))
            s.commit()
        except Exception:
            s.rollback()
            raise
        finally:
            s.close()
        return {"tasks": len(id_maps.get("task", {})), "notes": len(id_maps.get("note", {}))}

    def import_markdown_folder(self, folder: Path, note_repo) -> int:
        """把一个文件夹里的 .md 导入为笔记（按子文件夹映射 folder_id 暂略，统一入根）。"""
        count = 0
        for md in sorted(Path(folder).rglob("*.md")):
            text = md.read_text(encoding="utf-8", errors="ignore")
            title, body = md.stem, text
            if text.startswith("# "):
                first_nl = text.find("\n")
                title = text[2:first_nl].strip() if first_nl > 0 else title
                body = text[first_nl + 1:].lstrip("\n")
            from ...model.domain.entities import Note
            s = self.db.session()
            try:
                note_repo.create(s, Note(title=title[:120] or md.stem, content_md=body))
                s.commit()
            finally:
                s.close()
            count += 1
        return count


def _row_dict(row) -> dict:
    d = {}
    for c in row.__table__.columns:
        v = getattr(row, c.name)
        d[c.name] = v.isoformat() if hasattr(v, "isoformat") else v
    return d


def _parse_date_value(v):
    """导入侧把 ISO 日期字符串还原为 date 对象（SQLAlchemy Date 列要求）。"""
    if isinstance(v, str) and v:
        try:
            return date.fromisoformat(v[:10])
        except ValueError:
            return None
    return v


def _parse_dt_value(v):
    """导入侧把 ISO 时间字符串还原为 datetime 对象（SQLAlchemy DateTime 列要求）。"""
    if isinstance(v, str) and v:
        try:
            return datetime.fromisoformat(v.replace("T", " ")[:19])
        except ValueError:
            return None
    return v


def _insert_rows(s, model, cols: List[str], rows: list) -> dict:
    id_map = {}
    for raw in rows:
        kw = {}
        for c in cols:
            v = raw.get(c)
            if c.endswith("_date"):
                v = _parse_date_value(v)
            elif c.endswith("_at"):
                v = _parse_dt_value(v)
            kw[c] = v
        obj = model(**kw)
        s.add(obj)
        s.flush()
        id_map[raw.get("id")] = obj.id
    return id_map


def _src_table(col: str) -> str:
    return {"task_id": "task", "note_id": "note", "tag_id": "tag",
            "flash_id": "flash"}.get(col, col.rsplit("_id", 1)[0])
