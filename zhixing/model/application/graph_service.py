# -*- coding: utf-8 -*-
"""图谱服务：从 note_link/task/folder 数据构建节点与边，支持筛选、邻域与增量同步。

节点五类：
- note：笔记节点（id == 笔记主键）
- flash：闪念节点（负空间，ref_id 保存真实主键）
- dangling：待建链接节点（id < 0，ref_id == 0）
- folder：文件夹节点（负空间）
- task：任务节点（高位正空间）

边两类（视觉/约束区分）：
- ownership 归属（实线 DAG，无环约束）：folder->folder、folder->note、task->note、task->task
- reference 引用（虚线，允许成环）：仅 note<->note 与 note->dangling（排除文件夹、任务间无引用）
"""
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from ..infrastructure.db import Database

# 两类边语义
EDGE_OWNERSHIP = "ownership"   # 归属（实线 DAG，无环约束）
EDGE_REFERENCE = "reference"   # 引用（虚线，允许成环）
#: 「两种关系皆可」标记：目前仅任务↔笔记（归属 task_note_link / 引用 task_note_ref）。
#: 调用方需结合拖拽入口模式（mode）决定最终边类，见 resolve_edge_kind。
EDGE_EITHER = "either"

# 闪念节点使用独立负空间，避免与笔记主键（正整数）及悬空节点（-1 递减）冲突。
_FLASH_ID_OFFSET = 1_000_000
# 任务节点使用高位正空间（F3-7），避免与笔记主键冲突。
_TASK_ID_OFFSET = 5_000_000
# 文件夹节点使用独立负空间，避免与笔记/闪念/悬空/任务 id 冲突。
_FOLDER_ID_OFFSET = 2_000_000
# v0.15 P1-3: 段落锚点节点独立负空间（任务→笔记段落级引用锚，唯一确定性 id）。
_ANCHOR_ID_OFFSET = 3_000_000

# 允许连接矩阵（需求契约 §3.4）：(src_kind, dst_kind) -> 边类；未列出的组合禁止。
# 引用仅 note<->note / note->dangling / task->anchor（段落级反链，v0.15）；
# 归属方向固定（folder/task 为 owner）。
ALLOWED_CONNECTIONS: Dict[Tuple[str, str], str] = {
    ("note", "note"): EDGE_REFERENCE,
    ("note", "dangling"): EDGE_REFERENCE,
    ("folder", "folder"): EDGE_OWNERSHIP,
    ("folder", "note"): EDGE_OWNERSHIP,
    ("task", "task"): EDGE_OWNERSHIP,
    ("task", "note"): EDGE_OWNERSHIP,
    ("note", "task"): EDGE_OWNERSHIP,   # 拖拽方向归一为 task->note
    ("task", "anchor"): EDGE_REFERENCE,  # v0.15: 任务→其引用段落锚点（只读生成边）
    ("note", "anchor"): EDGE_REFERENCE,  # 锚点就近挂载笔记，虚线示「引用片段」
}


def _folder_node_id(folder_id: int) -> int:
    """文件夹真实主键 → 图谱负空间节点 id。"""
    return -folder_id - _FOLDER_ID_OFFSET


def _acyclic_ownership_edges(edges: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
    """DFS 三色标记：去掉回边（指向当前访问栈上节点的边），返回无环归属边。

    归属 DAG 只可能被自引用父子链（folder.parent_id / task.parent_id）破坏；
    folder->note、task->note 单向，不可能成环，无需进入本函数。
    """
    adj: Dict[int, List[int]] = {}
    for s, d in edges:
        adj.setdefault(s, []).append(d)
    white, gray, black = 0, 1, 2
    color: Dict[int, int] = {}
    bad: Set[Tuple[int, int]] = set()

    def dfs(u: int):
        color[u] = gray
        for v in adj.get(u, []):
            c = color.get(v, white)
            if c == white:
                dfs(v)
            elif c == gray:
                bad.add((u, v))
        color[u] = black

    for node in list(adj.keys()):
        if color.get(node, white) == white:
            dfs(node)
    return [e for e in edges if e not in bad]


@dataclass
class GraphNode:
    id: int
    label: str
    kind: str = "note"            # note | flash | dangling | folder | task | anchor(v0.15)
    size: float = 1.0
    degree: int = 0
    color_hint: str = ""
    format: str = "markdown"      # note 的格式：markdown/richtext/word/excel/pdf/media/link
    ref_id: int = 0              # 底层实体主键：note/flash/folder/task 的真实 id；dangling 为 0
    ref_task: int = 0            # v0.15 anchor：引用该段的任务 id
    block_key: str = ""          # v0.15 anchor：段落定位键
    snippet: str = ""            # v0.15 anchor：段落引文快照（tooltip/预览）


@dataclass
class GraphData:
    nodes: List[GraphNode] = field(default_factory=list)
    edges: List[List[int]] = field(default_factory=list)   # [src_id, dst_id]
    dangling: List[GraphNode] = field(default_factory=list)  # 待建链接节点（id<0）
    by_id: Dict[int, GraphNode] = field(default_factory=dict)
    # (src_id, dst_id) -> "ownership" | "reference"（两类边语义，供视觉层实线/虚线区分）
    edge_kinds: Dict[Tuple[int, int], str] = field(default_factory=dict)
    # 因环路被破环丢弃的归属边（诊断/提示用）
    cycle_edges: List[List[int]] = field(default_factory=list)


@dataclass
class GraphDelta:
    """增量同步结果：相对上一帧的最小变更集（供 GraphPage 局部刷新，避免全图重绘）。"""
    added_nodes: List[GraphNode] = field(default_factory=list)
    removed_node_ids: List[int] = field(default_factory=list)
    updated_node_ids: List[int] = field(default_factory=list)  # label/color/size/kind 变化
    added_edges: List[List[int]] = field(default_factory=list)
    removed_edges: List[List[int]] = field(default_factory=list)
    edge_kinds: Dict[Tuple[int, int], str] = field(default_factory=dict)  # 新增边的类别
    full: bool = False   # True=结构剧变（无载荷结构信号），建议整体重建但保留节点坐标

    @property
    def empty(self) -> bool:
        return not (self.added_nodes or self.removed_node_ids or self.updated_node_ids
                    or self.added_edges or self.removed_edges)


class GraphService:
    def __init__(self, db: Database, note_service, bus=None):
        self.db = db
        self.notes = note_service
        self.bus = bus
        if self.bus is None and note_service is not None and hasattr(note_service, "bus"):
            self.bus = note_service.bus
        self._cache: Optional[GraphData] = None
        self._cache_params: Dict[str, object] = {}
        self._subscribed = False

    # ================= 构建 =================
    def build(self, folder_id: Optional[int] = None,
              only_ids: Optional[Set[int]] = None,
              include_tasks: bool = False,
              tag_id: Optional[int] = None) -> GraphData:
        data = self._assemble(folder_id, only_ids, include_tasks, tag_id)
        self._finalize_edges(data)
        self._cache = data
        self._cache_params = {
            "folder_id": folder_id, "only_ids": only_ids,
            "include_tasks": include_tasks, "tag_id": tag_id,
        }
        return data

    def _assemble(self, folder_id, only_ids, include_tasks, tag_id) -> GraphData:
        s = self.db.session()
        try:
            from ..infrastructure.models import FlashRow, NoteRow
            stmt = s.query(NoteRow).filter(NoteRow.deleted_at.is_(None))
            notes = stmt.all()
            if folder_id is not None:
                notes = [n for n in notes if n.folder_id == folder_id]
            if tag_id is not None:
                from ..infrastructure.models import NoteTagRow
                tagged = {t for (t,) in s.query(NoteTagRow.note_id)
                          .filter(NoteTagRow.tag_id == tag_id).all()}
                notes = [n for n in notes if n.id in tagged]
            flashes = []
            # 邻域查询是笔记中心的子图（only_ids 为笔记主键集合），不掺入闪念节点。
            if only_ids is None:
                flashes = s.query(FlashRow).filter(
                    FlashRow.deleted_at.is_(None)).order_by(FlashRow.created_at.desc()).all()
            from ..infrastructure.repositories import NoteLinkRepository
            link_repo = NoteLinkRepository(self.db)
            raw_links = link_repo.all_links(s)
        finally:
            s.close()

        allowed = {n.id for n in notes}
        if only_ids:
            allowed &= set(only_ids)
        data = GraphData()
        # 文件夹：仅全图（未按文件夹/标签/邻域过滤）时展示层级节点
        folders = []
        if folder_id is None and only_ids is None and tag_id is None:
            try:
                folders = self.notes.folder_titles()
            except Exception:
                folders = []
        deg: Dict[int, int] = {}
        for src, dst, _title in raw_links:
            if src in allowed and dst in allowed:
                deg[src] = deg.get(src, 0) + 1
                deg[dst] = deg.get(dst, 0) + 1

        max_deg = max(deg.values()) if deg else 1
        for n in notes:
            node = GraphNode(id=n.id, label=n.title or "无标题", kind="note",
                             ref_id=n.id,
                             size=1.0 + (deg.get(n.id, 0) / max_deg) * 1.6,
                             degree=deg.get(n.id, 0), color_hint=str(n.folder_id or 0),
                             format=getattr(n, "format", None) or "markdown")
            data.nodes.append(node)
            data.by_id[n.id] = node

        # 文件夹节点（矩形）：层级边 folder→子folder + 包含边 folder→note（归属实线）
        if folders:
            notes_by_folder: Dict[int, List] = {}
            for n in notes:
                if n.folder_id is not None:
                    notes_by_folder.setdefault(n.folder_id, []).append(n)
            folder_by_id: Dict[int, int] = {}
            for f in folders:
                nid = _folder_node_id(f.id)
                node = GraphNode(id=nid, label=f.name or "文件夹", kind="folder",
                                 size=0.7, degree=0, color_hint="folder", ref_id=f.id)
                data.nodes.append(node)
                data.by_id[nid] = node
                folder_by_id[f.id] = nid
            for f in folders:
                if f.parent_id is not None and f.parent_id in folder_by_id:
                    data.edges.append([folder_by_id[f.parent_id], folder_by_id[f.id]])
                for n in notes_by_folder.get(f.id, []):
                    data.edges.append([folder_by_id[f.id], n.id])

        # 悬空链接节点（id 取负空间避免冲突）—— 引用类虚线边
        next_virtual = -1
        for src, dst, title in raw_links:
            if src in allowed and dst is None:
                v = data.by_id.get(next_virtual)
                if v is None or v.label != title:
                    node = GraphNode(id=next_virtual, label=title, kind="dangling",
                                     size=0.9, degree=0)
                    data.dangling.append(node)
                    data.by_id[next_virtual] = node
                data.edges.append([src, next_virtual])
                deg[src] = deg.get(src, 0) + 1
                next_virtual -= 1
            elif src in allowed and dst in allowed:
                data.edges.append([src, dst])

        # 闪念节点：独立负空间，视觉与笔记区分（无连线，仅入图可浏览/跳转）。
        for f in flashes:
            node_id = -f.id - _FLASH_ID_OFFSET
            node = GraphNode(id=node_id, label=_flash_label(f.content),
                             kind="flash", size=0.35, degree=0,
                             color_hint="flash", ref_id=f.id)
            data.nodes.append(node)
            data.by_id[node_id] = node

        # 任务节点（F3-7）：任务作为特殊节点入图，含 task→note 归属 + task→task 层级（仅全图）。
        if include_tasks and only_ids is None:
            self._attach_task_nodes(data, allowed)
        return data

    def _finalize_edges(self, data: GraphData):
        """对边分类（归属/引用），并对归属层级边（folder->folder、task->task）破环。"""
        # 1) 分类两类边。
        # 已显式标注过边类的（如 v9 的 task->note 引用，由 _attach_task_nodes 写入）
        # 予以保留 —— 否则会被按节点类型推断的默认结果覆盖，引用边退化成归属实线。
        for src, dst in data.edges:
            a = data.by_id.get(src)
            b = data.by_id.get(dst)
            if (src, dst) in data.edge_kinds:
                continue
            data.edge_kinds[(src, dst)] = self.classify_edge(
                a.kind if a else "", b.kind if b else "")

        # 2) 归属层级边破环（folder->folder / task->task）
        hier_pairs = set()
        for src, dst in data.edges:
            a = data.by_id.get(src)
            b = data.by_id.get(dst)
            if a and b and a.kind == b.kind and a.kind in ("folder", "task"):
                hier_pairs.add((src, dst))
        if not hier_pairs:
            return
        keep = set(_acyclic_ownership_edges(sorted(hier_pairs)))
        dropped = hier_pairs - keep
        if dropped:
            data.cycle_edges = [list(e) for e in sorted(dropped)]
            data.edges = [e for e in data.edges if tuple(e) not in dropped]
            for e in dropped:
                data.edge_kinds.pop(e, None)
        return data

    def _attach_task_nodes(self, data: GraphData, allowed: Set[int]):
        """把所有未删除任务作为 task 节点（五角星）挂入图谱。

        边两类：
        - task -> note（归属实线，任务与笔记的外部链接，来自 task_note_link）
        - task -> task（归属实线，父→子，由 task.parent_id 数据结构自动计算生成）
        - v0.15 P1-3: task -> anchor（引用虚线，任务→其引用的段落锚子节点）
          anchor -> note（引用虚线，段落就近挂载所属笔记）
        不再只显示「与笔记关联」的任务树——独立任务与父子层级同样入图。
        """
        s = self.db.session()
        try:
            from ..infrastructure.models import (
                TaskNoteContextRow, TaskNoteLinkRow, TaskNoteRefRow, TaskRow,
            )
            pairs = s.query(TaskNoteLinkRow.task_id, TaskNoteLinkRow.note_id).all()
            ref_pairs = s.query(TaskNoteRefRow.task_id, TaskNoteRefRow.note_id).all()
            tasks = s.query(TaskRow).filter(TaskRow.deleted_at.is_(None)).all()
            task_by_id = {r.id: r for r in tasks}
            ctx_rows = s.query(TaskNoteContextRow).all()
        finally:
            s.close()
        if not task_by_id:
            return

        # 所有任务节点（五角星）
        for tid in sorted(task_by_id):
            nid = tid + _TASK_ID_OFFSET
            if nid in data.by_id:
                continue
            r = task_by_id[tid]
            node = GraphNode(id=nid, label=r.title or "（无标题）", kind="task",
                             size=0.55, degree=0, color_hint="task", ref_id=tid)
            data.nodes.append(node)
            data.by_id[nid] = node

        # task -> note 归属边（任务与笔记的外部链接，实线）
        for task_id, note_id in pairs:
            if task_id in task_by_id and note_id in allowed:
                data.edges.append([task_id + _TASK_ID_OFFSET, note_id])

        # task -> note 引用边（v9：与归属并存，虚线；允许成环，不参与 DAG 破环）。
        # 同一对可能同时存在归属与引用：此时按「引用」呈现（虚线优先级更高）——
        # 归属语义仍保留在数据层（task_note_link 行不变），仅图谱视觉以引用为准，
        # 避免同一条边画两次重叠。
        for task_id, note_id in ref_pairs:
            if task_id in task_by_id and note_id in allowed:
                edge = [task_id + _TASK_ID_OFFSET, note_id]
                if edge not in data.edges:
                    data.edges.append(edge)
                data.edge_kinds[(task_id + _TASK_ID_OFFSET, note_id)] = EDGE_REFERENCE

        # task -> task 层级归属边（父→子，自动由 parent_id 生成）
        for tid, r in task_by_id.items():
            if r.parent_id and r.parent_id in task_by_id:
                data.edges.append([r.parent_id + _TASK_ID_OFFSET, tid + _TASK_ID_OFFSET])

        # v0.15 P1-3: 段落锚子节点——任务引用笔记内某段（task_note_context）时，
        # 在笔记下挂一个小锚点（虚线引用），锚点带定位键，图谱侧可跳转到该段。
        if ctx_rows:
            seen_anchor: Set[int] = set()
            for c in ctx_rows:
                note_id, task_id = c.note_id, c.task_id
                if note_id not in allowed or task_id not in task_by_id:
                    continue
                if note_id not in data.by_id:
                    continue
                aid = -c.id - _ANCHOR_ID_OFFSET
                if aid in seen_anchor or aid in data.by_id:
                    continue
                snippet = (c.snippet or "").strip().replace("\n", " ")
                label = (snippet[:10] + "…") if len(snippet) > 10 else (snippet or "段落引用")
                node = GraphNode(id=aid, label=label, kind="anchor", size=0.3,
                                 degree=0, color_hint="anchor", ref_id=note_id,
                                 ref_task=task_id, block_key=c.block_key,
                                 snippet=snippet)
                data.nodes.append(node)
                data.by_id[aid] = node
                seen_anchor.add(aid)
                # note→anchor（就近挂载）+ task→anchor（引用来源）
                data.edges.append([note_id, aid])
                data.edges.append([task_id + _TASK_ID_OFFSET, aid])

    # ================= 边规则 / 拓扑约束 =================
    @staticmethod
    def classify_edge(a_kind: str, b_kind: str) -> str:
        """两类边：引用（虚线：含 note/dangling/anchor 任意引用侧） vs 归属（实线，其余）。

        anchor（段落锚）是「任务→笔记片段」的引用产物，相关边一律虚线；
        纯层级边（folder/folder、task/task、folder/note、task/note 归属）实线。
        """
        if "anchor" in (a_kind, b_kind):
            return EDGE_REFERENCE
        if a_kind in ("note", "dangling") and b_kind in ("note", "dangling") \
                and not (a_kind == "dangling" and b_kind == "dangling"):
            return EDGE_REFERENCE
        return EDGE_OWNERSHIP

    @staticmethod
    def connection_allowed(src_kind: str, dst_kind: str) -> Optional[str]:
        """拖拽连线允许矩阵：返回边类（ownership/reference）或 None（禁止）。

        任务↔笔记是唯一「两种关系都可建立」的组合（v9）：
        - 归属模式 → task_note_link（实线，DAG）
        - 引用模式 → task_note_ref（虚线，可成环）
        此时按调用方传入的 mode 决定写入哪张表，故返回 None 之外的特殊标记
        ``EDGE_EITHER``；调用方需用 ``resolve_edge_kind`` 结合 mode 定夺。
        """
        pair = (src_kind, dst_kind)
        if pair in (("task", "note"), ("note", "task")):
            return EDGE_EITHER
        return ALLOWED_CONNECTIONS.get(pair)

    @staticmethod
    def resolve_edge_kind(src_kind: str, dst_kind: str,
                          mode: Optional[str] = None) -> Optional[str]:
        """结合入口模式确定最终边类。

        任务↔笔记：mode 给定时用 mode（归属/引用均可）；未给定时默认归属
        （保持旧行为，避免拖拽语义突变）。其余组合沿用矩阵结果。
        """
        kind = GraphService.connection_allowed(src_kind, dst_kind)
        if kind == EDGE_EITHER:
            return mode if mode in (EDGE_OWNERSHIP, EDGE_REFERENCE) else EDGE_OWNERSHIP
        return kind

    def ownership_parents(self, kind: Optional[str] = None) -> Dict[int, int]:
        """归属层级父子映射 {child_node_id: parent_node_id}（folder + task）。"""
        parent: Dict[int, int] = {}
        data = self._cache
        if data is not None:
            for (src, dst), k in data.edge_kinds.items():
                if k != EDGE_OWNERSHIP:
                    continue
                a = data.by_id.get(src)
                b = data.by_id.get(dst)
                if a and b and a.kind == b.kind and a.kind in ("folder", "task"):
                    if kind is None or a.kind == kind:
                        parent[dst] = src
            return parent
        return self._ownership_parents_from_db(kind)

    def _ownership_parents_from_db(self, kind: Optional[str] = None) -> Dict[int, int]:
        parent: Dict[int, int] = {}
        if kind in (None, "folder"):
            s = self.db.session()
            try:
                from ..infrastructure.models import NoteFolderRow
                for r in s.query(NoteFolderRow).all():
                    if r.parent_id is not None:
                        parent[_folder_node_id(r.id)] = _folder_node_id(r.parent_id)
            finally:
                s.close()
        if kind in (None, "task"):
            s = self.db.session()
            try:
                from ..infrastructure.models import TaskRow
                for r in s.query(TaskRow).filter(TaskRow.deleted_at.is_(None)).all():
                    if r.parent_id is not None:
                        parent[r.id + _TASK_ID_OFFSET] = r.parent_id + _TASK_ID_OFFSET
            finally:
                s.close()
        return parent

    def would_create_cycle(self, child_id: int, new_parent_id: int,
                           kind: Optional[str] = None) -> bool:
        """把 child_id 挂到 new_parent_id 下是否会成环（归属 DAG 祖先链回溯，O(深度)）。"""
        if child_id == new_parent_id:
            return True
        parents = self.ownership_parents(kind)
        seen = set()
        cur = new_parent_id
        while cur is not None:
            if cur == child_id:
                return True
            if cur in seen:
                return True   # 既有坏环数据，保守拒绝
            seen.add(cur)
            cur = parents.get(cur)
        return False

    # ================= 增量同步（观察者模式） =================
    def diff(self, new: GraphData, old: Optional[GraphData]) -> GraphDelta:
        """计算 new 相对 old 的最小变更集；old=None 时视为全量。"""
        if old is None:
            return GraphDelta(added_nodes=list(new.nodes), added_edges=list(new.edges),
                              edge_kinds=dict(new.edge_kinds), full=True)
        added_nodes = [n for nid, n in new.by_id.items() if nid not in old.by_id]
        removed_node_ids = [nid for nid in old.by_id if nid not in new.by_id]
        updated_node_ids = []
        for nid, b in new.by_id.items():
            a = old.by_id.get(nid)
            if a is not None and self._node_changed(a, b):
                updated_node_ids.append(nid)
        old_edges = {tuple(e) for e in old.edges}
        new_edges = {tuple(e) for e in new.edges}
        added_edges = [list(e) for e in new_edges - old_edges]
        removed_edges = [list(e) for e in old_edges - new_edges]
        kinds = {e: new.edge_kinds.get(e, EDGE_REFERENCE) for e in (new_edges - old_edges)}
        return GraphDelta(added_nodes=added_nodes, removed_node_ids=removed_node_ids,
                          updated_node_ids=updated_node_ids, added_edges=added_edges,
                          removed_edges=removed_edges, edge_kinds=kinds)

    @staticmethod
    def _node_changed(a: GraphNode, b: GraphNode) -> bool:
        return (a.label, a.kind, a.color_hint, a.format, a.ref_id, a.size, a.degree) != \
               (b.label, b.kind, b.color_hint, b.format, b.ref_id, b.size, b.degree)

    def apply_note_changed(self, note_id: int, reason: str = "") -> GraphDelta:
        """note_changed(nid, reason) → 定点增量（label/color/folder 归属边）。"""
        return self._sync()

    def apply_note_links_changed(self, note_id: int) -> GraphDelta:
        """note_links_changed(nid) → 仅 nid 关联引用边的增删。"""
        return self._sync()

    def apply_task_changed(self, task_id: int, reason: str = "") -> GraphDelta:
        """task_changed(tid, reason) → task 节点与其 task->note 边的增量。"""
        return self._sync()

    def apply_flash_changed(self, flash_id: int = 0, reason: str = "") -> GraphDelta:
        """flash_changed(flash_id, reason) → 闪念节点增量（孤立节点，增删成本低）。"""
        return self._sync()

    def apply_structure_changed(self, change_id: int = 0, op: str = "") -> GraphDelta:
        """note/task 结构信号（change_id, op）→ 结构重建 + 最小 diff（渲染层局部刷新）。"""
        return self._sync()

    def _sync(self) -> GraphDelta:
        """按缓存构建参数重建，diff 出最小变更集（数据层内部重建，渲染层据此局部刷新）。"""
        old = self._cache
        params = dict(self._cache_params) if self._cache_params else {}
        new = self.build(**params)
        return self.diff(new, old)

    def subscribe(self, bus=None):
        """订阅 EventBus：领域事件 → GraphDelta → bus.graph_delta（观察者增量同步）。"""
        bus = bus or self.bus
        if bus is None or self._subscribed:
            return
        bus.note_changed.connect(self._on_note_changed)
        bus.note_links_changed.connect(self._on_note_links_changed)
        bus.task_changed.connect(self._on_task_changed)
        bus.flash_changed.connect(self._on_flash_changed)
        bus.note_structure_changed.connect(self._on_structure)
        bus.task_structure_changed.connect(self._on_structure)
        self._subscribed = True

    def _on_note_changed(self, note_id, reason=""):
        self._emit(self.apply_note_changed(note_id, reason))

    def _on_note_links_changed(self, note_id):
        self._emit(self.apply_note_links_changed(note_id))

    def _on_task_changed(self, task_id, reason=""):
        self._emit(self.apply_task_changed(task_id, reason))

    def _on_flash_changed(self, flash_id=0, reason=""):
        self._emit(self.apply_flash_changed(flash_id, reason))

    def _on_structure(self, change_id=0, op=""):
        self._emit(self.apply_structure_changed(change_id, op))

    def _emit(self, delta: GraphDelta):
        if self.bus is not None and delta is not None:
            try:
                self.bus.graph_delta.emit(delta)
            except Exception:  # noqa: BLE001
                pass

    # ================= 建链 / 邻域 =================
    def link_notes(self, src_id: int, dst_id: int) -> bool:
        """在两个笔记节点间手动建立 note_link（复用 [[ ]] 标题链接语义）。

        引用边仅笔记之间：非正 id / 自环 / 非笔记实体一律拒绝。
        已有链接（含悬空链接）时仅补全 dst_note_id，避免撞 uq_src_dst_title；
        反向已连接视为已连，不重复建行（图谱按无向渲染）。
        """
        if not src_id or not dst_id or src_id <= 0 or dst_id <= 0 or src_id == dst_id:
            return False
        s = self.db.session()
        made = False
        try:
            from ..infrastructure.models import NoteLinkRow, NoteRow
            src = s.get(NoteRow, src_id)
            dst = s.get(NoteRow, dst_id)
            if not src or not dst or src.deleted_at or dst.deleted_at:
                return False
            title_src = src.title or "无标题"
            title_dst = dst.title or "无标题"
            row = None
            for a, b, t in ((src_id, dst_id, title_dst), (dst_id, src_id, title_src)):
                row = s.query(NoteLinkRow).filter(
                    NoteLinkRow.src_note_id == a, NoteLinkRow.dst_title == t).first()
                if row is not None:
                    if (row.dst_note_id or None) != b:
                        row.dst_note_id = b
                    made = True
                    break
            if row is None:
                s.add(NoteLinkRow(src_note_id=src_id, dst_note_id=dst_id,
                                  dst_title=title_dst))
                made = True
            s.commit()
        finally:
            s.close()
        if made:
            self._notify_links(src_id)
        return made

    def _notify_links(self, note_id: int):
        try:
            if self.notes is not None and hasattr(self.notes, "bus"):
                self.notes.bus.note_links_changed.emit(note_id)
        except Exception:  # noqa: BLE001
            pass

    # ================= 任务归属改写（供图谱拖拽/交互层复用） =================
    def attach_task_note(self, task_id: int, note_id: int) -> bool:
        """任务→笔记归属：复用 TaskRepository.link_note 幂等写入 + 领域事件。"""
        if not task_id or not note_id or task_id <= 0 or note_id <= 0:
            return False
        from ..infrastructure.fts import FTSService
        from ..infrastructure.repositories import TaskRepository
        repo = TaskRepository(self.db, FTSService(self.db))
        s = self.db.session()
        try:
            repo.link_note(s, task_id, note_id)   # 幂等：已存在不重复建行
            s.commit()
        finally:
            s.close()
        self._notify_task_changed(task_id)
        return True

    def link_task_note_ref(self, task_id: int, note_id: int) -> bool:
        """建立「任务引用笔记」关系（v9，与归属并存）。幂等。"""
        if not task_id or not note_id or task_id <= 0 or note_id <= 0:
            return False
        from ..infrastructure.models import TaskNoteRefRow
        s = self.db.session()
        try:
            exists = s.query(TaskNoteRefRow).filter(
                TaskNoteRefRow.task_id == task_id,
                TaskNoteRefRow.note_id == note_id).first()
            if exists is None:
                s.add(TaskNoteRefRow(task_id=task_id, note_id=note_id))
                s.commit()
        finally:
            s.close()
        self._notify_task_changed(task_id)
        return True

    def unlink_task_note_ref(self, task_id: int, note_id: int) -> bool:
        """解除「任务引用笔记」关系。返回是否确实删除了行。"""
        from ..infrastructure.models import TaskNoteRefRow
        s = self.db.session()
        removed = False
        try:
            rows = s.query(TaskNoteRefRow).filter(
                TaskNoteRefRow.task_id == task_id,
                TaskNoteRefRow.note_id == note_id).all()
            for r in rows:
                s.delete(r)
                removed = True
            if removed:
                s.commit()
        finally:
            s.close()
        if removed:
            self._notify_task_changed(task_id)
        return removed

    def detach_task_note(self, task_id: int, note_id: int) -> bool:
        """解除「任务归属笔记」关系（删除 task_note_link 行）。"""
        from ..infrastructure.models import TaskNoteLinkRow
        s = self.db.session()
        removed = False
        try:
            rows = s.query(TaskNoteLinkRow).filter(
                TaskNoteLinkRow.task_id == task_id,
                TaskNoteLinkRow.note_id == note_id).all()
            for r in rows:
                s.delete(r)
                removed = True
            if removed:
                s.commit()
        finally:
            s.close()
        if removed:
            self._notify_task_changed(task_id)
        return removed

    def reparent_task(self, task_id: int, parent_id: Optional[int]) -> bool:
        """任务父子改挂：更新 task.parent_id + 领域事件 task_structure_changed(task_reparented)。"""
        if not task_id or task_id <= 0 or task_id == parent_id:
            return False
        from ..infrastructure.models import TaskRow
        s = self.db.session()
        try:
            r = s.query(TaskRow).filter(
                TaskRow.id == task_id, TaskRow.deleted_at.is_(None)).first()
            if r is None:
                return False
            r.parent_id = parent_id
            s.commit()
        finally:
            s.close()
        self._notify_task_structure(task_id)
        return True

    def _notify_task_changed(self, task_id: int):
        try:
            if self.bus is not None:
                self.bus.task_changed.emit(task_id, "updated")
        except Exception:  # noqa: BLE001
            pass

    def _notify_task_structure(self, task_id: int):
        try:
            if self.bus is not None:
                self.bus.task_structure_changed.emit(task_id, "task_reparented")
        except Exception:  # noqa: BLE001
            pass

    def neighborhood(self, note_id: int, degree: int = 1) -> GraphData:
        """某笔记的 1~2 度邻域子图。"""
        s = self.db.session()
        try:
            from ..infrastructure.models import NoteLinkRow
            links = s.query(NoteLinkRow).all()
        finally:
            s.close()
        adj: Dict[int, Set[int]] = {}
        for l in links:
            adj.setdefault(l.src_note_id, set())
            if l.dst_note_id:
                adj.setdefault(l.dst_note_id, set())
                adj[l.src_note_id].add(l.dst_note_id)
                adj[l.dst_note_id].add(l.src_note_id)
        keep = {note_id}
        frontier = {note_id}
        for _ in range(degree):
            nxt = set()
            for nid in frontier:
                nxt |= adj.get(nid, set())
            nxt -= keep
            keep |= nxt
            frontier = nxt
        data = self.build(only_ids=keep)
        # 悬空：src 在 keep 内的悬空链接
        for l in links:
            if l.src_note_id in keep and l.dst_note_id is None:
                v = GraphNode(id=l.id * -1 - 100000, label=l.dst_title, kind="dangling",
                              size=0.9)
                data.dangling.append(v)
                data.by_id[v.id] = v
                data.edges.append([l.src_note_id, v.id])
                data.edge_kinds[(l.src_note_id, v.id)] = EDGE_REFERENCE
        return data

    # ================= 节点预览（选中面板 · 需求⑧） =================
    def preview_text(self, node: GraphNode) -> str:
        """按节点类型生成选中面板的预览文本（摘要/元数据/关联），供 GraphPage 展示。"""
        try:
            if node.kind == "note":
                return self._note_preview(node)
            if node.kind == "task":
                return self._task_preview(node)
            if node.kind == "folder":
                return self._folder_preview(node)
            if node.kind == "flash":
                return self._flash_preview(node)
            if node.kind == "dangling":
                return f"类型：待建链接\n目标：{node.label}\n双击新建笔记"
            if node.kind == "anchor":
                # v0.15 P1-3: 段落锚预览：引用任务 + 引文快照 + 定位提示
                task_title = ""
                if node.ref_task:
                    try:
                        from ..infrastructure.models import TaskRow
                        s = self.db.session()
                        try:
                            row = s.get(TaskRow, node.ref_task)
                        finally:
                            s.close()
                        task_title = row.title if row else ""
                    except Exception:  # noqa: BLE001
                        pass
                snip = (node.snippet or node.label or "").replace("\n", " ")
                lines = ["类型：段落引用"]
                if task_title:
                    lines.append(f"引用自任务：{task_title}")
                if snip:
                    lines.append(f"片段：{snip[:60]}")
                lines.append("双击跳转定位到该段落")
                return "\n".join(lines)
        except Exception:  # noqa: BLE001
            pass
        return f"类型：{node.kind}\n链接数：{node.degree}"

    def _note_preview(self, node: GraphNode) -> str:
        note = None
        if self.notes is not None:
            try:
                note = self.notes.get(node.ref_id or node.id)
            except Exception:  # noqa: BLE001
                note = None
        if note is None:
            return f"类型：笔记\n链接数：{node.degree}"
        lines = ["类型：笔记"]
        folder_name = self._note_folder_name(note.folder_id)
        if folder_name:
            lines.append(f"所属：{folder_name}")
        summary = _summarize_text(note.content_md, 140)
        if summary:
            lines.append(f"摘要：{summary}")
        lines.append(f"字数：{note.word_count} · 链接：{node.degree}")
        if note.pinned:
            lines.append("已置顶")
        return "\n".join(lines)

    def _task_preview(self, node: GraphNode) -> str:
        s = self.db.session()
        try:
            from ..infrastructure.models import TaskNoteLinkRow, TaskRow
            r = s.get(TaskRow, node.ref_id)
            if r is None or r.deleted_at is not None:
                return f"类型：任务\n链接数：{node.degree}"
            linked_note_ids = [nid for (nid,) in s.query(
                TaskNoteLinkRow.note_id).filter(
                TaskNoteLinkRow.task_id == r.id).all()]
            parent_title = None
            if r.parent_id is not None:
                p = s.get(TaskRow, r.parent_id)
                parent_title = p.title if p is not None else None
            status, priority = r.status, r.priority
            due_date, notes_md = r.due_date, r.notes_md or ""
        finally:
            s.close()
        status_label = {"todo": "待办", "doing": "进行中", "waiting": "等待中",
                        "done": "已完成", "abandoned": "已放弃"}.get(status, status)
        from ..domain.entities import priority_label
        lines = ["类型：任务", f"状态：{status_label} · 优先级：{priority_label(priority)}"]
        if due_date is not None:
            lines.append(f"截止：{due_date.isoformat()}")
        if parent_title:
            lines.append(f"父任务：{parent_title}")
        if notes_md.strip():
            lines.append(f"备注：{_summarize_text(notes_md, 80)}")
        titles = []
        for nid in linked_note_ids:
            if self.notes is None:
                break
            try:
                n = self.notes.get(nid)
                if n is not None:
                    titles.append(n.title or "无标题")
            except Exception:  # noqa: BLE001
                pass
        if titles:
            lines.append("关联笔记：" + "、".join(titles[:4]))
            if len(titles) > 4:
                lines.append(f"… 共 {len(titles)} 个")
        else:
            lines.append(f"关联笔记：{len(linked_note_ids)} 个")
        return "\n".join(lines)

    def _folder_preview(self, node: GraphNode) -> str:
        folders = []
        if self.notes is not None:
            try:
                folders = self.notes.folder_titles()
            except Exception:  # noqa: BLE001
                folders = []
        target = next((f for f in folders if f.id == node.ref_id), None)
        children = [f.name for f in folders if f.parent_id == node.ref_id]
        note_count = 0
        if self.notes is not None:
            try:
                note_count = len(self.notes.list(folder_id=node.ref_id))
            except Exception:  # noqa: BLE001
                note_count = 0
        lines = ["类型：文件夹"]
        if target is not None and target.parent_id is not None:
            parent = next((f.name for f in folders if f.id == target.parent_id), None)
            if parent:
                lines.append(f"上级：{parent}")
        lines.append(f"子文件夹：{len(children)} 个 · 笔记：{note_count} 篇")
        if children:
            lines.append("　" + "、".join(children[:5]))
        return "\n".join(lines)

    def _flash_preview(self, node: GraphNode) -> str:
        s = self.db.session()
        try:
            from ..infrastructure.models import FlashRow
            r = s.get(FlashRow, node.ref_id)
            if r is None or r.deleted_at is not None:
                return "类型：闪念"
            content, remark = r.content or "", r.remark or ""
            source_app, source_url = r.source_app or "", r.source_url or ""
        finally:
            s.close()
        lines = ["类型：闪念"]
        if content.strip():
            lines.append(f"正文：{_summarize_text(content, 140)}")
        if remark.strip():
            lines.append(f"备注：{_summarize_text(remark, 80)}")
        if source_app:
            lines.append(f"来源：{source_app}")
        if source_url:
            lines.append(f"链接：{source_url[:60]}")
        return "\n".join(lines)

    def _note_folder_name(self, folder_id) -> str:
        if folder_id is None or self.notes is None:
            return ""
        try:
            for f in self.notes.folder_titles():
                if f.id == folder_id:
                    return f.name
        except Exception:  # noqa: BLE001
            pass
        return ""


def _flash_label(content: str) -> str:
    """闪念无标题字段：取正文首行截断作为图谱节点标题。"""
    text = (content or "").strip().split("\n")[0].strip()
    return text[:40] or "闪念"


def _summarize_text(text: str, limit: int) -> str:
    """把正文压成单行摘要：折叠空白/换行后按字符截断。"""
    t = " ".join((text or "").split())
    return t if len(t) <= limit else t[:limit] + "…"
