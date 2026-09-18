# -*- coding: utf-8 -*-
"""搜索服务：命令面板统一搜索（FTS5 + 前缀过滤语法）。"""
import re
import time
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Callable, Dict, List, Optional

from ..infrastructure.db import Database
from ..infrastructure.fts import FTSService
from ..infrastructure.repositories import (
    FlashRepository, ListFolderRepository, NoteRepository, TagRepository, TaskRepository,
)

# 过滤词（前后需单词边界，避免 due:todayx 之类误判）
_DUE_TODAY_RE = re.compile(r"\bdue:today\b")
_DUE_TOMORROW_RE = re.compile(r"\bdue:tomorrow\b")
_DUE_OVERDUE_RE = re.compile(r"\bdue:overdue\b")
_DUE_NONE_RE = re.compile(r"\bdue:none\b")
_STATUS_RE = re.compile(r"\bstatus:(todo|doing|waiting|done|abandoned)\b")
_PRIORITY_RE = re.compile(r"\bpriority:(p[1-8]|none)\b", re.I)
# folder: 名称（支持双引号包裹含空格名称）
_FOLDER_RE = re.compile(r'\bfolder:"([^"]+)"|\bfolder:(\S+)', re.I)


@dataclass
class SearchHit:
    kind: str            # command|task|note|flash|tag
    title: str
    subtitle: str = ""
    payload: object = None
    action: Optional[Callable] = None   # 无参回调


@dataclass
class SearchResult:
    command: List[SearchHit] = field(default_factory=list)
    task: List[SearchHit] = field(default_factory=list)
    note: List[SearchHit] = field(default_factory=list)
    flash: List[SearchHit] = field(default_factory=list)
    tag: List[SearchHit] = field(default_factory=list)

    def groups(self):
        out = []
        if self.command:
            out.append(("命令", self.command))
        if self.task:
            out.append(("任务", self.task))
        if self.note:
            out.append(("笔记", self.note))
        if self.flash:
            out.append(("闪念", self.flash))
        if self.tag:
            out.append(("标签", self.tag))
        return out

    def is_empty(self) -> bool:
        return not (self.command or self.task or self.note or self.flash or self.tag)


class SearchService:
    def __init__(self, db: Database, fts: FTSService, tasks: TaskRepository,
                 notes: NoteRepository, flashes: FlashRepository, tags: TagRepository,
                 folders: Optional[ListFolderRepository] = None):
        self.db, self.fts = db, fts
        self.tasks, self.notes, self.flashes, self.tags = tasks, notes, flashes, tags
        self.folders = folders
        self.commands: List[SearchHit] = []   # 由 shell 注入
        self._mru: Dict[str, float] = {}      # kind:id -> 最近命中时间戳（MRU 排序）

    def global_search(self, q: str, kind_filter: Optional[str] = None) -> SearchResult:
        q = (q or "").strip()
        result = SearchResult()
        today = date.today()

        # 到期过滤语法（F7-3 扩展）：只作用于任务，强制任务前缀。
        due_mode = None
        for pat, mode in ((_DUE_TODAY_RE, "today"), (_DUE_TOMORROW_RE, "tomorrow"),
                          (_DUE_OVERDUE_RE, "overdue"), (_DUE_NONE_RE, "none")):
            if pat.search(q):
                due_mode = mode
                q = pat.sub(" ", q).strip()
                break
        status_filter = None
        m = _STATUS_RE.search(q)
        if m:
            status_filter = m.group(1)
            q = _STATUS_RE.sub(" ", q).strip()
        priority_filter = None
        m = _PRIORITY_RE.search(q)
        if m:
            priority_filter = m.group(1).lower()
            q = _PRIORITY_RE.sub(" ", q).strip()
        # folder: 名称过滤（仅作用于任务，按分组/列表名匹配）
        folder_filter = None
        m = _FOLDER_RE.search(q)
        if m:
            folder_filter = (m.group(1) or m.group(2) or "").strip()
            q = _FOLDER_RE.sub(" ", q).strip()

        prefix = None
        if q.startswith("task:"):
            prefix, q = "task", q[5:].strip()
        elif q.startswith("note:"):
            prefix, q = "note", q[5:].strip()
        elif q.startswith("flash:"):
            prefix, q = "flash", q[6:].strip()
        elif q.startswith("tag:"):
            prefix, q = "tag", q[4:].strip()
        if kind_filter:
            prefix = kind_filter
        if due_mode or status_filter or priority_filter or folder_filter:
            prefix = "task"

        # folder 过滤映射：分组/列表名 → 包含的分组+列表 id（含后裔列表）
        folder_ids: Optional[set] = None
        if folder_filter and self.folders is not None:
            key = folder_filter.lower()
            fs = self.db.session()
            try:
                allf = self.folders.all(fs)
            finally:
                fs.close()
            matches = [f for f in allf if key in (f.name or "").lower()]
            if not matches:
                return result
            match_ids = {f.id for f in matches}
            folder_ids = set(match_ids)
            for f in allf:      # 匹配的分组：收纳其后裔列表
                if f.id in match_ids and f.kind.value == "group":
                    parent = f.id
                    for g in allf:
                        if g.parent_id == parent and g.kind.value == "list":
                            folder_ids.add(g.id)

        if not prefix or prefix == "command":
            needle = q.lower()
            for c in self.commands:
                if not q or needle in c.title.lower() or needle in c.subtitle.lower():
                    result.command.append(c)
                if len(result.command) >= 6:
                    break
        if not q and not due_mode and not status_filter and not priority_filter \
                and not folder_filter:
            return result

        def _task_matches(t) -> bool:
            if due_mode == "today" and t.due_date != today:
                return False
            if due_mode == "tomorrow" and t.due_date != today + timedelta(days=1):
                return False
            if due_mode == "overdue" and (t.due_date is None or t.due_date >= today):
                return False
            if due_mode == "none" and t.due_date is not None:
                return False
            if status_filter and t.status.value != status_filter:
                return False
            if priority_filter:
                if priority_filter == "none":
                    if int(t.priority) != 0:
                        return False
                else:
                    want = int(priority_filter[1:])
                    if int(t.priority) != want:
                        return False
            if folder_ids is not None and t.list_id not in folder_ids:
                return False
            return True

        s = self.db.session()
        try:
            if not prefix or prefix == "task":
                if (due_mode or status_filter or priority_filter or folder_filter) and not q:
                    # 纯过滤：按截止范围扫全量（过滤模式下不依赖 FTS）
                    if due_mode == "today":
                        rows = self.tasks.due_between(s, today, today)
                    elif due_mode == "tomorrow":
                        d = today + timedelta(days=1)
                        rows = self.tasks.due_between(s, d, d)
                    else:
                        rows = self.tasks.list_all(s)
                    for t in rows:
                        if t.deleted_at:
                            continue
                        if _task_matches(t):
                            result.task.append(SearchHit("task", t.title, self._task_subtitle(t), t))
                else:
                    for tid, _r in self.fts.search(s, "task", q, 20):
                        t = self.tasks.get(s, tid)
                        if not t or t.deleted_at:
                            continue
                        if _task_matches(t):
                            result.task.append(SearchHit("task", t.title, self._task_subtitle(t), t))
            if not prefix or prefix == "note":
                for nid, _r in self.fts.search(s, "note", q, 8):
                    n = self.notes.get(s, nid)
                    if n and not n.deleted_at:
                        result.note.append(SearchHit("note", n.title, (n.content_md or "")[:40], n))
            if not prefix or prefix == "flash":
                for fid, _r in self.fts.search(s, "flash", q, 6):
                    f = self.flashes.get(s, fid)
                    if f and not f.deleted_at:
                        result.flash.append(SearchHit("flash", f.content[:50], f.remark, f))
            if not prefix or prefix == "tag":
                for tid, name, color in self.tags.all(s):
                    if q.lower() in name.lower():
                        result.tag.append(SearchHit("tag", f"#{name}", "", tid))
        finally:
            s.close()
        self._apply_mru(result)
        return result

    # ---------- MRU 排序（最近访问优先，F7 交互优化） ----------
    def _hit_key(self, h: SearchHit) -> str:
        payload = h.payload
        pid = getattr(payload, "id", None)
        return f"{h.kind}:{pid}" if pid is not None else f"{h.kind}:{h.title}"

    def touch(self, kind: str, payload) -> None:
        """记一次命中（由面板/导航在选中时调用），供后续搜索按最近访问优先。"""
        pid = getattr(payload, "id", None)
        key = f"{kind}:{pid}" if pid is not None else f"{kind}:{payload}"
        self._mru[key] = time.time()

    def _apply_mru(self, result: SearchResult) -> None:
        if not self._mru:
            return
        def _sort(hits: List[SearchHit]) -> None:
            hits.sort(key=lambda h: self._mru.get(self._hit_key(h), 0.0), reverse=True)
        _sort(result.task)
        _sort(result.note)
        _sort(result.flash)

    @staticmethod
    def _task_subtitle(t) -> str:
        status = {"todo": "待办", "doing": "进行中", "waiting": "等待中", "done": "已完成",
                  "abandoned": "已放弃"}.get(t.status.value, "")
        return f"{status} · {'截止 ' + str(t.due_date) if t.due_date else ''}"
