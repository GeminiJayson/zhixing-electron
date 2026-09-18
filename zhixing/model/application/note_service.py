# -*- coding: utf-8 -*-
"""笔记服务：CRUD + [[链接]] 管线 + 反链 + 文件夹 + 版本历史 + 模板 + 孤儿笔记。"""
from datetime import date, datetime, timedelta
from typing import List, Optional, Tuple

from ...core.event_bus import EventBus
from ..domain.entities import BacklinkItem, Note, NoteFolder, NoteLink, Task
from ..domain.link_parser import extract_links
from ..infrastructure.db import Database
from ..infrastructure.repositories import NoteLinkRepository, NoteRepository, TagRepository

NOTE_FORMAT_MARKDOWN = "markdown"
NOTE_FORMAT_RICHTEXT = "richtext"
NOTE_FORMAT_WORD = "word"          # Word(.docx)：content_md 存本地文件路径
NOTE_FORMAT_EXCEL = "excel"        # Excel(.xlsx)：content_md 存本地文件路径
NOTE_FORMAT_LINK = "link"          # 链接：content_md 存网页 URL 或本地文件路径
NOTE_FORMATS = (
    NOTE_FORMAT_MARKDOWN, NOTE_FORMAT_RICHTEXT, NOTE_FORMAT_WORD, NOTE_FORMAT_EXCEL, NOTE_FORMAT_LINK,
)
NOTE_FORMAT_LABELS = [
    (NOTE_FORMAT_MARKDOWN, "Markdown"),
    (NOTE_FORMAT_RICHTEXT, "富文本"),
    (NOTE_FORMAT_WORD, "Word"),
    (NOTE_FORMAT_EXCEL, "Excel"),
    (NOTE_FORMAT_LINK, "链接"),
]

# 空名称回退（需求④）：标题以用户输入为准，空输入统一回退该值
DEFAULT_NOTE_TITLE = "未命名笔记"

# 笔记模板（F2-6）：标题前缀 + 内容骨架
NOTE_TEMPLATES = {
    "每日笔记": {
        "title": "每日笔记 ",
        "content": "# 每日笔记\n\n## 今日计划\n\n- \n\n## 今日回顾\n\n",
    },
    "会议记录": {
        "title": "会议记录 ",
        "content": "# 会议记录\n\n- 时间：\n- 参与人：\n- 议题：\n\n## 结论\n\n## 待办\n\n",
    },
    "读书笔记": {
        "title": "读书笔记 ",
        "content": "# 读书笔记\n\n- 书名：\n- 作者：\n\n## 摘录\n\n## 思考\n\n",
    },
}

_NOTE_REVISION_LIMIT = 20   # 版本历史保留最近 20 版（F2-9）


def format_from_label(label: str) -> str:
    """新建笔记格式选择标签 → 持久化 format 值（默认 Markdown）。"""
    s = str(label or "")
    if "富文本" in s:
        return NOTE_FORMAT_RICHTEXT
    if "Word" in s or "word" in s:
        return NOTE_FORMAT_WORD
    if "Excel" in s or "excel" in s:
        return NOTE_FORMAT_EXCEL
    if "链接" in s:
        return NOTE_FORMAT_LINK
    return NOTE_FORMAT_MARKDOWN


def format_label(fmt: str) -> str:
    return {
        NOTE_FORMAT_MARKDOWN: "Markdown",
        NOTE_FORMAT_RICHTEXT: "富文本",
        NOTE_FORMAT_WORD: "Word",
        NOTE_FORMAT_EXCEL: "Excel",
        NOTE_FORMAT_LINK: "链接",
    }.get(fmt, "Markdown")


class NoteService:
    def __init__(self, db: Database, bus: EventBus, notes: NoteRepository,
                 links: NoteLinkRepository, tags: TagRepository):
        self.db, self.bus = db, bus
        self.notes, self.links, self.tags = notes, links, tags

    # ---------- 基础 ----------
    def create(self, title: str = "", content_md: str = "",
               folder_id: Optional[int] = None, tag_names: Optional[List[str]] = None,
               format: str = NOTE_FORMAT_MARKDOWN) -> Note:
        n = Note(title=title or DEFAULT_NOTE_TITLE, content_md=content_md, folder_id=folder_id,
                 format=format if format in NOTE_FORMATS else NOTE_FORMAT_MARKDOWN)
        s = self.db.session()
        try:
            self.notes.create(s, n)
            for name in (tag_names or []):
                tid = self.tags.ensure(s, name.strip())
                self.notes.set_tags(s, n.id, self.notes.tag_ids(s, n.id) + [tid])
            s.commit()
        finally:
            s.close()
        self._pipeline(safe=False, note=n)
        self.bus.note_structure_changed.emit(n.id, "note_created")
        return n

    def save(self, note_id: int, title: Optional[str] = None,
             content_md: Optional[str] = None, folder_id=None, pinned=None) -> Optional[Note]:
        s0 = self.db.session()
        try:
            old = self.notes.get(s0, note_id)
            old_title = old.title if old else None
        finally:
            s0.close()
        s = self.db.session()
        try:
            n = self.notes.get(s, note_id)
            if not n:
                return None
            if content_md is not None:
                self._snapshot(s, note_id)
            if title is not None:
                n.title = title or DEFAULT_NOTE_TITLE
            if content_md is not None:
                n.content_md = content_md
            if folder_id is not None:
                n.folder_id = folder_id
            if pinned is not None:
                n.pinned = pinned
            self.notes.update(s, n)
            s.commit()
            fresh = self.notes.get(s, note_id)
        finally:
            s.close()
        # 链接管线（diff note_link + FTS 已在仓储同步）
        self._pipeline(safe=True, note=fresh, old_title=old_title)
        if old_title and old_title != (fresh.title if fresh else ""):
            s = self.db.session()
            try:
                self.links.rename_target(s, old_title, fresh.title)
                s.commit()
            finally:
                s.close()
        self.bus.note_changed.emit(note_id, "updated")
        return fresh

    def get(self, note_id: int) -> Optional[Note]:
        s = self.db.session()
        try:
            return self.notes.get(s, note_id)
        finally:
            s.close()

    def resolve(self, title: str) -> Optional[int]:
        s = self.db.session()
        try:
            n = self.notes.by_title(s, title)
            return n.id if n else None
        finally:
            s.close()

    def delete(self, note_id: int):
        s = self.db.session()
        try:
            self.notes.soft_delete(s, note_id)
            # 指向它的出链悬空化：dst_note_id→NULL，保留 dst_title 成「待建链接」，
            # 否则图谱会因 dst 已删除而整条丢弃引用。
            self.links.dangle_links_to(s, note_id)
            s.commit()
        finally:
            s.close()
        self.bus.note_structure_changed.emit(note_id, "note_deleted")
        self.bus.note_links_changed.emit(note_id)

    def restore(self, note_id: int):
        s = self.db.session()
        try:
            self.notes.restore(s, note_id)
            s.commit()
        finally:
            s.close()
        self.bus.note_structure_changed.emit(note_id, "note_restored")

    # ---------- 回收站（F9-3） ----------
    def trash(self) -> List[Note]:
        s = self.db.session()
        try:
            return self.notes.all(s, include_deleted=True)
        finally:
            s.close()
        return []

    def purge(self, note_id: int):
        s = self.db.session()
        try:
            self.notes.purge(s, note_id)
            s.commit()
        finally:
            s.close()
        self.bus.note_structure_changed.emit(note_id, "note_purged")
        self.bus.note_links_changed.emit(note_id)

    def purge_older_than(self, days: int = 30) -> int:
        cutoff = datetime.now() - timedelta(days=days)
        stale = [n for n in self.trash()
                 if n.deleted_at is not None and n.deleted_at < cutoff]
        for n in stale:
            self.purge(n.id)
        return len(stale)

    def set_pinned(self, note_id: int, pinned: bool):
        self.save(note_id, pinned=pinned)

    def set_tags(self, note_id: int, tag_names: List[str]):
        s = self.db.session()
        try:
            ids = [self.tags.ensure(s, x.strip()) for x in tag_names if x.strip()]
            self.notes.set_tags(s, note_id, ids)
            s.commit()
        finally:
            s.close()
        self.bus.note_changed.emit(note_id, "updated")

    # ---------- 查询 ----------
    def list(self, folder_id: Optional[int] = None, q: str = "") -> List[Note]:
        s = self.db.session()
        try:
            return self.notes.all(s, folder_id=folder_id, q=q)
        finally:
            s.close()

    def recent(self, limit: int = 5) -> List[Note]:
        s = self.db.session()
        try:
            return self.notes.recent(s, limit)
        finally:
            s.close()

    def all_tags(self) -> List[tuple]:
        """全部标签 [(id, name, color)]，供图谱/搜索筛选。"""
        s = self.db.session()
        try:
            return self.tags.all(s)
        finally:
            s.close()

    # ---------- 标签管理（F1-6/#5，收口 View 直连仓储） ----------
    def tags_with_usage(self) -> List[tuple]:
        """全部标签 + 使用数 [(id, name, color, count)]，供标签管理对话框。"""
        s = self.db.session()
        try:
            out = []
            for tid, name, color in self.tags.all(s):
                out.append((tid, name, color, self.tags.usage_count(s, tid)))
            return out
        finally:
            s.close()

    def create_tag(self, name: str) -> Optional[int]:
        """新增标签（去重），返回标签 id。"""
        name = (name or "").strip()
        if not name:
            return None
        s = self.db.session()
        try:
            tid = self.tags.ensure(s, name)
            s.commit()
        finally:
            s.close()
        return tid

    def rename_tag(self, tid: int, name: str):
        name = (name or "").strip()
        if not name:
            return
        s = self.db.session()
        try:
            self.tags.rename(s, tid, name)
            s.commit()
        finally:
            s.close()

    def delete_tag(self, tid: int):
        s = self.db.session()
        try:
            self.tags.delete(s, tid)
            s.commit()
        finally:
            s.close()

    def merge_tags(self, target: int, sources: List[int]):
        """合并标签：sources 的关联重挂到 target，随后删除来源标签。"""
        sources = [i for i in sources if i and i != target]
        if not sources:
            return
        s = self.db.session()
        try:
            self.tags.merge(s, target, sources)
            for src in sources:
                self.tags.delete(s, src)
            s.commit()
        finally:
            s.close()

    def folder_titles(self) -> List[NoteFolder]:
        s = self.db.session()
        try:
            from ..infrastructure.models import NoteFolderRow
            rows = s.query(NoteFolderRow).order_by(NoteFolderRow.sort).all()
            return [NoteFolder(id=r.id, parent_id=r.parent_id, name=r.name, sort=r.sort)
                    for r in rows]
        finally:
            s.close()

    def ensure_default_folder(self) -> Optional[NoteFolder]:
        """笔记文件夹为空时自动新建一个默认列表，避免笔记无处归属。"""
        from ..infrastructure.models import NoteFolderRow
        s = self.db.session()
        try:
            if s.query(NoteFolderRow).count() > 0:
                return None
            r = NoteFolderRow(name="我的笔记")
            s.add(r)
            s.commit()
            return NoteFolder(id=r.id, name=r.name, parent_id=r.parent_id, sort=r.sort)
        finally:
            s.close()

    def create_from_template(self, kind: str, folder_id: Optional[int] = None) -> Optional[Note]:
        """按模板新建笔记（F2-6）。"""
        tpl = NOTE_TEMPLATES.get(kind)
        if not tpl:
            return None
        return self.create(title=tpl["title"] + date.today().strftime("%m-%d"),
                           content_md=tpl["content"], folder_id=folder_id)

    # ---------- 版本历史（F2-9） ----------
    def revisions(self, note_id: int) -> List[dict]:
        s = self.db.session()
        try:
            from ..infrastructure.models import NoteRevisionRow
            rows = s.query(NoteRevisionRow).filter(NoteRevisionRow.note_id == note_id)\
                .order_by(NoteRevisionRow.created_at.desc(), NoteRevisionRow.id.desc()).all()
            return [{"id": r.id, "title": r.title or "", "content_md": r.content_md or "",
                     "format": r.format or "markdown", "created_at": r.created_at} for r in rows]
        finally:
            s.close()

    def restore_revision(self, note_id: int, rev_id: int) -> Optional[Note]:
        """回滚到某版快照（先给当前内容留一份快照，避免回滚不可逆）。"""
        s = self.db.session()
        try:
            from ..infrastructure.models import NoteRevisionRow
            r = s.get(NoteRevisionRow, rev_id)
            if not r or r.note_id != note_id:
                return None
            n = self.notes.get(s, note_id)
            if not n:
                return None
            self._snapshot(s, note_id)
            n.title, n.content_md = r.title, r.content_md
            n.format = r.format or "markdown"
            self.notes.update(s, n)
            s.commit()
            fresh = self.notes.get(s, note_id)
        finally:
            s.close()
        self._pipeline(safe=True, note=fresh, old_title=r.title)
        self.bus.note_changed.emit(note_id, "restored")
        return fresh

    def _snapshot(self, s, note_id: int):
        """保存/回滚前把当前内容写进版本历史（去重 + 上限 20 版）。"""
        from ..infrastructure.models import NoteRevisionRow
        n = self.notes.get(s, note_id)
        if n is None:
            return
        content = n.content_md or ""
        last = s.query(NoteRevisionRow).filter(NoteRevisionRow.note_id == note_id)\
            .order_by(NoteRevisionRow.id.desc()).first()
        if last is not None and last.content_md == content:
            return
        s.add(NoteRevisionRow(note_id=note_id, title=n.title or "", content_md=content,
                              format=n.format or "markdown"))
        s.flush()
        stale = s.query(NoteRevisionRow).filter(NoteRevisionRow.note_id == note_id)\
            .order_by(NoteRevisionRow.id.desc()).offset(_NOTE_REVISION_LIMIT).all()
        for r in stale:
            s.delete(r)

    def broken_links(self) -> List[Tuple[int, str]]:
        """失效链接检测（F2 交互优化）：src_note_id 引用但目标已不存在的悬空链接。

        返回 [(src_note_id, dst_title)]，供笔记页「链接失效」提示与修复跳转。
        """
        s = self.db.session()
        try:
            return self.links.broken_links(s)
        finally:
            s.close()

    # ---------- 孤儿笔记（F3-8） ----------
    def orphans(self) -> List[Note]:
        """既无出链也无入链的笔记（鼓励建立连接）。"""
        s = self.db.session()
        try:
            from ..infrastructure.models import NoteLinkRow, NoteRow
            rows = s.query(NoteRow).filter(NoteRow.deleted_at.is_(None)).all()
            linked = set()
            for src, dst in s.query(NoteLinkRow.src_note_id, NoteLinkRow.dst_note_id).all():
                linked.add(src)
                if dst:
                    linked.add(dst)
            return [Note(id=r.id, folder_id=r.folder_id, title=r.title,
                         content_md=r.content_md or "", format=r.format or "markdown",
                         pinned=bool(r.pinned), word_count=r.word_count or 0,
                         deleted_at=r.deleted_at, created_at=r.created_at, updated_at=r.updated_at)
                    for r in rows if r.id not in linked]
        finally:
            s.close()

    def create_folder(self, name: str, parent_id: Optional[int] = None) -> NoteFolder:
        from ..infrastructure.models import NoteFolderRow
        s = self.db.session()
        try:
            r = NoteFolderRow(name=name.strip() or "新文件夹", parent_id=parent_id)
            s.add(r)
            s.commit()
            f = NoteFolder(id=r.id, name=r.name, parent_id=r.parent_id)
        finally:
            s.close()
        self.bus.note_structure_changed.emit(f.id, "folder_created")
        return f

    def rename_folder(self, folder_id: int, name: str) -> Optional[NoteFolder]:
        """重命名笔记文件夹。"""
        from ..infrastructure.models import NoteFolderRow
        name = (name or "").strip()
        if not name:
            return None
        s = self.db.session()
        try:
            r = s.query(NoteFolderRow).filter(NoteFolderRow.id == folder_id).first()
            if not r:
                return None
            r.name = name
            s.commit()
            f = NoteFolder(id=r.id, name=r.name, parent_id=r.parent_id, sort=r.sort)
        finally:
            s.close()
        self.bus.note_structure_changed.emit(folder_id, "folder_renamed")
        return f

    def move_folder(self, folder_id: int, new_parent_id: Optional[int]) -> Optional[NoteFolder]:
        """移动笔记文件夹到新父级（G1）：提交前做祖先链环路校验。

        拒绝挂到自身或其子孙下（A 属 B 且 B 属 A 等循环归属）；成环时返回 None 且不写库。
        """
        from ..infrastructure.models import NoteFolderRow
        s = self.db.session()
        try:
            folders = s.query(NoteFolderRow).all()
            parent_map = {f.id: f.parent_id for f in folders}
            r = s.query(NoteFolderRow).filter(NoteFolderRow.id == folder_id).first()
            if not r:
                return None
            if new_parent_id is not None and new_parent_id not in parent_map:
                return None
            # 祖先链回溯：new_parent 不能是 folder_id 自身或其子孙（否则成环）
            seen = set()
            cur = new_parent_id
            while cur is not None:
                if cur == folder_id:
                    return None
                if cur in seen:
                    return None   # 既有坏环数据，保守拒绝
                seen.add(cur)
                cur = parent_map.get(cur)
            r.parent_id = new_parent_id
            s.commit()
            f = NoteFolder(id=r.id, name=r.name, parent_id=r.parent_id, sort=r.sort)
        finally:
            s.close()
        self.bus.note_structure_changed.emit(folder_id, "folder_moved")
        return f

    def delete_folder(self, folder_id: int):
        """删除笔记文件夹：其下笔记回落「全部笔记」，子文件夹上移一级。"""
        from ..infrastructure.models import NoteFolderRow, NoteRow
        s = self.db.session()
        try:
            r = s.query(NoteFolderRow).filter(NoteFolderRow.id == folder_id).first()
            if not r:
                return
            parent_id = r.parent_id
            # 所有笔记（含已软删的回收站笔记）都要解除 folder_id 外键引用，
            # 否则删除文件夹会触发 FOREIGN KEY constraint failed。
            s.query(NoteRow).filter(NoteRow.folder_id == folder_id)\
                .update({"folder_id": None}, synchronize_session=False)
            s.query(NoteFolderRow).filter(NoteFolderRow.parent_id == folder_id)\
                .update({"parent_id": parent_id}, synchronize_session=False)
            s.query(NoteFolderRow).filter(NoteFolderRow.id == folder_id)\
                .delete(synchronize_session=False)
            s.commit()
        finally:
            s.close()
        self.bus.note_structure_changed.emit(folder_id, "folder_deleted")

    # ---------- 链接 ----------
    def backlinks(self, note_id: int) -> List[BacklinkItem]:
        s = self.db.session()
        try:
            return self.links.backlinks(s, note_id, self.notes)
        finally:
            s.close()

    def outgoing_links(self, note_id: int) -> List[NoteLink]:
        """正向链接（我链接了谁）：src==本笔记的全部出链，含悬空「待建」（dst_note_id=None）。

        与 backlinks 相对；链接面板「引用（正向）」列表数据源。
        """
        s = self.db.session()
        try:
            return self.links.out_links(s, note_id)
        finally:
            s.close()

    def out_links(self, note_id: int) -> List[NoteLink]:
        """旧名兼容：同 outgoing_links。"""
        return self.outgoing_links(note_id)

    def add_reference_link(self, src_note_id: int, target) -> str:
        """主动建引用 note_link(src → dst)，语义与正文 ``[[标题]]`` 一致。

        - target 为笔记 id（int）→ 引用该笔记（不存在/软删 → ``invalid``）；
        - target 为标题（str）→ 精确解析到笔记则引用它；解析不到 → 建「待建」悬空链接
          （dst_note_id=None，仅记 dst_title），与输入 [[待建标题]] 语义一致；
        - 幂等：同 (src, 标题) 已存在 → ``duplicate`` 不建行；悬空行遇到真实目标 → 转正
          （``bound``）。

        返回状态串：added | dangling | bound | duplicate | invalid | self；
        仅在真正变更（added/dangling/bound）时发 ``note_links_changed``（图谱/反链刷新，
        与 ``_pipeline`` 保存链路一致）。
        """
        if not src_note_id:
            return "invalid"
        if isinstance(target, str):
            title = (target or "").strip()
            if not title:
                return "invalid"
            dst_id = self.resolve(title)
            if dst_id == src_note_id:
                return "self"
        elif isinstance(target, int):
            if target <= 0:
                return "invalid"
            if target == src_note_id:
                return "self"
            note = self.get(target)
            if note is None or note.deleted_at is not None:
                return "invalid"
            dst_id = target
            title = (note.title or "").strip() or "无标题"
        else:
            return "invalid"
        s = self.db.session()
        try:
            status = self.links.add_or_bind(s, src_note_id, title, dst_id)
            s.commit()
        finally:
            s.close()
        if status == "added":
            code = "dangling" if dst_id is None else "added"
        elif status == "bound":
            code = "bound"
        else:
            code = "duplicate"
        if code != "duplicate":
            self.bus.note_links_changed.emit(src_note_id)
        return code

    def materialize_dangling(self, src_note_id: int, title: str) -> Optional[int]:
        """把 src 的悬空「待建」引用转正：目标不存在则按标题新建笔记并绑定该行。

        返回绑定后的目标笔记 id（失败 None）；转正后发 ``note_links_changed``。
        """
        title = (title or "").strip()
        if not title or not src_note_id:
            return None
        dst_id = self.resolve(title)
        if dst_id is None:
            n = self.create(title=title)
            dst_id = n.id if n else None
        if dst_id is None:
            return None
        s = self.db.session()
        try:
            status = self.links.add_or_bind(s, src_note_id, title, dst_id)
            s.commit()
        finally:
            s.close()
        if status in ("added", "bound"):
            self.bus.note_links_changed.emit(src_note_id)
        return dst_id

    # ---------- 主动归属（笔记 → 任务 / 文件夹，链接面板「+ 归属」） ----------
    def _task_repo(self):
        """惰性 TaskRepository（仅归属相关方法用；构造与 GraphService 一致）。"""
        repo = getattr(self, "_task_repo_obj", None)
        if repo is None:
            from ..infrastructure.fts import FTSService
            from ..infrastructure.repositories import TaskRepository
            repo = self._task_repo_obj = TaskRepository(self.db, FTSService(self.db))
        return repo

    def attach_note_to_task(self, task_id: int, note_id: int) -> str:
        """把当前笔记归属到某任务（task_note_link，task→note 归属边）。

        幂等：已存在 (task, note) 行 → ``duplicate`` 不建行；任务/笔记缺失或已软删
        → ``invalid``。写库后发 ``task_changed(task_id)``（与 TaskService.attach_note /
        GraphService.attach_task_note 事件一致，图谱/任务视图据此刷新）。
        """
        if not task_id or not note_id:
            return "invalid"
        repo = self._task_repo()
        s = self.db.session()
        try:
            task = repo.get(s, task_id)
            note = self.notes.get(s, note_id)
            if task is None or note is None or task.deleted_at or note.deleted_at:
                return "invalid"
            if repo.linked_count(s, task_id, note_id):
                return "duplicate"
            repo.link_note(s, task_id, note_id)   # 幂等写入（此处已在上面判重）
            s.commit()
        finally:
            s.close()
        self.bus.task_changed.emit(task_id, "updated")
        return "attached"

    def attach_note_to_folder(self, note_id: int, folder_id: Optional[int]) -> str:
        """把当前笔记归属到某笔记文件夹（改 note.folder_id，即 graph folder→note 归属边）。

        已核实：本应用文件夹归属 = ``note.folder_id`` 字段（图谱 folder→note 实线来自它），
        故「归属文件夹」即移动笔记到该文件夹；folder_id=None 移回「全部笔记」根目录。
        文件夹不存在（可能刚被删）→ ``invalid``（删除约束提示）；目标与现属一致 →
        ``unchanged``。写库后发 ``note_structure_changed(note_moved)`` 刷新树/图谱。
        """
        if not note_id:
            return "invalid"
        folder_ids = {f.id for f in (self.folder_titles() or [])}
        if folder_id is not None and folder_id not in folder_ids:
            return "invalid"
        s = self.db.session()
        try:
            n = self.notes.get(s, note_id)
            if n is None or n.deleted_at is not None:
                return "invalid"
            if (n.folder_id or None) == (folder_id or None):
                return "unchanged"
            n.folder_id = folder_id
            self.notes.update(s, n)
            s.commit()
        finally:
            s.close()
        self.bus.note_structure_changed.emit(note_id, "note_moved")
        return "attached"

    def attached_tasks(self, note_id: int) -> List[Task]:
        """本笔记归属的任务（task_note_link 反向，未删任务），链接面板「归属」分组。"""
        s = self.db.session()
        try:
            return self._task_repo().tasks_for_note(s, note_id)
        finally:
            s.close()

    def task_candidates(self, q: str = "", limit: int = 30) -> List[Task]:
        """「+ 归属 → 选任务」候选：非删非终态任务，q 非空按标题模糊搜索。"""
        s = self.db.session()
        try:
            return self._task_repo().candidates(s, q, limit)
        finally:
            s.close()

    def create_task_from_selection(self, note_id: int, text: str, task_service,
                                   block_key: str = "", snippet: str = "") -> Optional:
        """笔记选中文本 → 任务，备注自动带回源引用。

        v0.15 P0-1：block_key 非空时把「段落定位键 + 引文快照」落 task_note_context，
        供任务侧一键跳回本段（note_page.locate_in_note）。snippet 缺省取选中文本。
        """
        s = self.db.session()
        try:
            n = self.notes.get(s, note_id)
            title = n.title if n else ""
        finally:
            s.close()
        quote = (text or "").strip()
        task = task_service.create(quote.split("\n")[0][:60] or "来自笔记的任务",
                                   notes_md=f"来自 [[{title}]]\n> {quote}")
        if block_key and task is not None and note_id:
            try:
                task_service.attach_block(task.id, note_id, block_key,
                                          snippet=(snippet or quote))
            except Exception:  # noqa: BLE001  —— 段落定位附加失败不影响任务创建
                pass
        if note_id:
            self.bus.note_changed.emit(note_id, "spawn-task")
        return task

    def append(self, note_id: int, text: str):
        s = self.db.session()
        fresh = None
        try:
            n = self.notes.get(s, note_id)
            if n:
                n.content_md = (n.content_md or "") + ("\n\n" if n.content_md else "") + text
                self.notes.update(s, n)
                s.commit()
                fresh = n
        finally:
            s.close()
        if fresh:
            self.bus.note_changed.emit(note_id, "appended")

    def _pipeline(self, safe: bool, note: Optional[Note], old_title: str = ""):
        """保存后链接解析：diff note_link 行 → 广播。"""
        if not note or note.id is None:
            return
        titles = extract_links(note.content_md or "")
        s = self.db.session()
        try:
            stats = self.links.replace_links(s, note.id, titles, self.resolve)
            s.commit()
        finally:
            s.close()
        if stats["added"] or stats["removed"]:
            self.bus.note_links_changed.emit(note.id)
