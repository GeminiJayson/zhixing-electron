# -*- coding: utf-8 -*-
"""Qt Model 层：任务树/列表、笔记列表、闪念列表、分组树。

Model 只承载数据与 Qt Model/View 协议；动作经信号外发（Controller 连接 Service）。
"""
from datetime import date
from typing import Any, Dict, List, Optional

from PySide6.QtCore import (
    QAbstractItemModel, QAbstractListModel, QModelIndex, Qt, Signal, QSortFilterProxyModel,
)
from PySide6.QtGui import QFont

from ..domain.entities import Flash, ListFolder, Note, Task, TaskStatus, Priority
from ..domain.task_rules import effective_done_map

# 自定义角色
RoleTitle = Qt.UserRole + 1
RoleChecked = Qt.UserRole + 2
RolePriority = Qt.UserRole + 3
RoleDue = Qt.UserRole + 4
RoleRepeat = Qt.UserRole + 5
RoleStreak = Qt.UserRole + 6
RoleNoteCount = Qt.UserRole + 7
RoleTaskId = Qt.UserRole + 8
RoleOverdue = Qt.UserRole + 9
RoleKind = Qt.UserRole + 10       # 分组树节点类型 group/list/smart/tag
RoleCount = Qt.UserRole + 11
RoleColor = Qt.UserRole + 12
RoleTags = Qt.UserRole + 13       # [(tag_id, name, color), ...]
RoleStartDate = Qt.UserRole + 14  # 开始日期（date，可空）
RoleStatus = Qt.UserRole + 15     # v0.15: TaskStatus.value（waiting 暂停态可见用）


# ============================== 任务树 ==============================
class _TNode:
    __slots__ = ("task", "parent", "children")

    def __init__(self, task: Task, parent=None):
        self.task = task
        self.parent = parent
        self.children: List["_TNode"] = []


class TaskTreeModel(QAbstractItemModel):
    """展示 Task 树（list_id / 智能清单 / 今日）。"""

    toggleRequested = Signal(int)            # task_id：勾选/取消
    openRequested = Signal(int)              # task_id：打开详情
    moved = Signal(int, int, bool)           # task_id, anchor_id, below：重排

    def __init__(self, parent=None, tag_provider=None):
        super().__init__(parent)
        self._roots: List[_TNode] = []
        self._by_id: Dict[int, _TNode] = {}
        self._flat: List[_TNode] = []
        self._tag_provider = tag_provider     # task_ids -> {task_id: [(tag_id,name,color),...]}
        self._tags_by_id: Dict[int, List] = {}
        self._effective_done: Dict[int, bool] = {}

    # ---------- 数据装载 ----------
    def reload(self, roots: List[Task]):
        self.beginResetModel()
        try:
            self._roots, self._by_id, self._flat = [], {}, []
            # 有效完成 roll-up 在 reload 时一次性算好并缓存，paint/delegate 不再递归查
            self._effective_done = effective_done_map(roots or [])
            for t in roots:
                node = self._build(t, None)
                self._roots.append(node)

            def flatten(nodes):
                for n in nodes:
                    self._flat.append(n)
                    flatten(n.children)
            flatten(self._roots)
            self._load_tags()
        finally:
            # 构建期任何异常也要成对收尾，避免 reset 悬挂导致视图永久卡死
            self.endResetModel()

    def _load_tags(self):
        """批量装配标签（一次查询，避免 delegate/paint 逐任务查库造成 N+1）。"""
        self._tags_by_id = {}
        if not self._tag_provider:
            return
        ids = [n.task.id for n in self._flat if n.task.id is not None]
        if not ids:
            return
        try:
            self._tags_by_id = self._tag_provider(ids) or {}
        except Exception:
            self._tags_by_id = {}

    def _build(self, task: Task, parent_node) -> _TNode:
        node = _TNode(task, parent_node)
        self._by_id[task.id] = node
        for c in task.children:
            node.children.append(self._build(c, node))
        return node

    def refresh_task(self, task_id: int):
        """单行数据变化（完成/编辑）→ 局部刷新，禁止全量重建。"""
        node = self._by_id.get(task_id)
        if not node:
            return
        idx = self.index_of(task_id)
        if idx.isValid():
            self.dataChanged.emit(idx, idx)

    # ---------- Qt 协议 ----------
    def rowCount(self, parent=QModelIndex()) -> int:
        if not parent.isValid():
            return len(self._roots)
        node = parent.internalPointer()
        return len(node.children)

    def columnCount(self, parent=QModelIndex()) -> int:
        return 1

    def index(self, row: int, col: int, parent=QModelIndex()) -> QModelIndex:
        if not parent.isValid():
            if 0 <= row < len(self._roots):
                return self.createIndex(row, col, self._roots[row])
            return QModelIndex()
        node = parent.internalPointer()
        if 0 <= row < len(node.children):
            return self.createIndex(row, col, node.children[row])
        return QModelIndex()

    def parent(self, index: QModelIndex) -> QModelIndex:
        if not index.isValid():
            return QModelIndex()
        node = index.internalPointer()
        if node.parent is None:
            return QModelIndex()
        sibs = node.parent.children
        row = sibs.index(node) if node in sibs else 0
        return self.createIndex(row, 0, node.parent)

    def data(self, index: QModelIndex, role=Qt.DisplayRole) -> Any:
        if not index.isValid():
            return None
        t: Task = index.internalPointer().task
        if role == Qt.DisplayRole or role == RoleTitle:
            return t.title
        if role == RoleChecked:
            return self._effective_done.get(t.id, t.status == TaskStatus.DONE)
        if role == RolePriority:
            return int(t.priority or 0)   # v0.17.1: None 防护（新增子任务瞬间 priority 可能 None）
        if role == RoleDue:
            return t.due_date
        if role == RoleStartDate:
            return t.start_date
        if role == RoleRepeat:
            return t.repeat_period.value
        if role == RoleStreak:
            return t.streak
        if role == RoleNoteCount:
            return t.note_count
        if role == RoleTaskId:
            return t.id
        if role == RoleOverdue:
            return (t.due_date is not None
                    and not self._effective_done.get(t.id, t.status == TaskStatus.DONE)
                    and t.due_date < date.today())
        if role == RoleTags:
            return self._tags_by_id.get(t.id, [])
        if role == RoleStatus:
            return t.status.value
        if role == Qt.FontRole:
            f = QFont()
            if t.status == TaskStatus.DONE:
                f.setStrikeOut(True)
            return f
        return None

    def flags(self, index: QModelIndex):
        return Qt.ItemIsEnabled | Qt.ItemIsSelectable | Qt.ItemIsEditable

    def index_of(self, task_id: int) -> QModelIndex:
        node = self._by_id.get(task_id)
        if not node:
            return QModelIndex()
        if node.parent is None:
            row = self._roots.index(node)
        else:
            row = node.parent.children.index(node)
        return self.createIndex(row, 0, node)

    def node_at(self, task_id: int) -> Optional[Task]:
        node = self._by_id.get(task_id)
        return node.task if node else None


class TaskFilterProxy(QSortFilterProxyModel):
    """按文本与状态过滤；保持树形与原排序。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.text = ""
        self.hide_done = False
        self.tag_filter = None

    def set_text(self, t: str):
        self.text = (t or "").lower()
        self.invalidateFilter()

    def set_hide_done(self, v: bool):
        self.hide_done = v
        self.invalidateFilter()

    def set_tag_filter(self, tag_id):
        self.tag_filter = tag_id
        self.invalidateFilter()

    def acceptRow(self, src_row: int, src_parent: QModelIndex) -> bool:
        model: TaskTreeModel = self.sourceModel()
        idx = model.index(src_row, 0, src_parent)
        if not idx.isValid():
            return False
        title = (idx.data(RoleTitle) or "").lower()
        hit = self.text in title
        done = idx.data(RoleChecked)
        tag_ok = True
        if self.tag_filter is not None:
            tags = idx.data(RoleTags) or []
            tag_ok = any(tid == self.tag_filter for tid, *_ in tags)
        ok = (hit if self.text else True) and (not done if self.hide_done else True) and tag_ok
        # 有子孙命中的行也保留（树形过滤）
        if ok:
            return True
        for r in range(model.rowCount(idx)):
            if self.acceptRow(r, idx):
                return True
        return False


# ============================== 笔记列表 ==============================
class NoteListModel(QAbstractListModel):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._items: List[Note] = []

    def reload(self, items: List[Note]):
        self.beginResetModel()
        self._items = list(items)
        self.endResetModel()

    def rowCount(self, parent=QModelIndex()) -> int:
        return 0 if parent.isValid() else len(self._items)

    def data(self, index: QModelIndex, role=Qt.DisplayRole) -> Any:
        if not index.isValid() or not (0 <= index.row() < len(self._items)):
            return None
        n = self._items[index.row()]
        if role == Qt.DisplayRole:
            return n.title
        if role == RoleTitle:
            return n.title
        if role == RoleChecked:
            return n.pinned
        if role == RoleTaskId:
            return n.id
        if role == Qt.UserRole + 20:     # 摘录
            return (n.content_md or "").strip()[:60].replace("\n", " ")
        if role == Qt.UserRole + 21:     # 更新时间
            return n.updated_at
        return None

    def note_at(self, row: int) -> Optional[Note]:
        return self._items[row] if 0 <= row < len(self._items) else None


# ============================== 闪念列表 ==============================
class FlashListModel(QAbstractListModel):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._items: List[Flash] = []

    def reload(self, items: List[Flash]):
        self.beginResetModel()
        self._items = list(items)
        self.endResetModel()

    def rowCount(self, parent=QModelIndex()) -> int:
        return 0 if parent.isValid() else len(self._items)

    def data(self, index: QModelIndex, role=Qt.DisplayRole) -> Any:
        if not index.isValid() or not (0 <= index.row() < len(self._items)):
            return None
        f = self._items[index.row()]
        if role == Qt.DisplayRole or role == RoleTitle:
            return f.content
        if role == Qt.UserRole + 30:
            return f.remark
        if role == Qt.UserRole + 31:
            return f.source_app
        if role == Qt.UserRole + 32:
            return f.created_at
        if role == RoleTaskId:
            return f.id
        return None

    def flash_at(self, row: int) -> Optional[Flash]:
        return self._items[row] if 0 <= row < len(self._items) else None


# ============================== 分组树（任务页侧栏） ==============================
class GroupTreeModel(QAbstractItemModel):
    """分组/列表 + 智能清单 + 标签 三段式侧栏。"""

    class _Node:
        __slots__ = ("kind", "label", "payload", "children", "parent", "count")

        def __init__(self, kind, label, payload=None, parent=None):
            self.kind, self.label, self.payload = kind, label, payload
            self.children: List["GroupTreeModel._Node"] = []
            self.parent = parent
            self.count = 0

    selectRequested = Signal(str, object)   # kind, payload

    def __init__(self, parent=None):
        super().__init__(parent)
        self._root = self._Node("root", "")
        self._smart = self._Node("smart-header", "智能清单", parent=self._root)
        self._root.children.append(self._smart)
        self._group_header = self._Node("group-header", "分组与列表", parent=self._root)
        self._root.children.append(self._group_header)
        self._tag_header = self._Node("tag-header", "标签", parent=self._root)
        self._root.children.append(self._tag_header)

    def reload(self, folders: List[ListFolder], smart_counts: Dict[str, int],
               tags: List, task_counts: Dict[Optional[int], int]):
        self.beginResetModel()
        self._smart.children.clear()
        self._group_header.children.clear()
        self._tag_header.children.clear()
        for key, label in [("today", "今天"), ("overdue", "已逾期"), ("doing", "进行中"),
                           ("all", "全部"), ("inbox", "收件箱")]:
            n = self._Node("smart", label, key, parent=self._smart)
            n.count = smart_counts.get(key, 0)
            self._smart.children.append(n)
        by_parent: Dict[Optional[int], List[ListFolder]] = {}
        for f in folders:
            by_parent.setdefault(f.parent_id, []).append(f)
        for v in by_parent.values():
            v.sort(key=lambda x: (x.sort, x.id or 0))

        def build(parent_id, parent_node):
            for f in by_parent.get(parent_id, []):
                n = self._Node(f.kind.value, f.name, f, parent=parent_node)
                n.count = task_counts.get(f.id, 0)
                parent_node.children.append(n)
                build(f.id, n)
        build(None, self._group_header)
        for tid, name, color in tags:
            n = self._Node("tag", "#" + name, (tid, name, color), parent=self._tag_header)
            self._tag_header.children.append(n)
        self.endResetModel()

    def rowCount(self, parent=QModelIndex()) -> int:
        if not parent.isValid():
            return len(self._root.children)
        node = parent.internalPointer()
        return len(node.children)

    def columnCount(self, parent=QModelIndex()) -> int:
        return 1

    def index(self, row, col, parent=QModelIndex()):
        if not parent.isValid():
            if 0 <= row < len(self._root.children):
                return self.createIndex(row, col, self._root.children[row])
            return QModelIndex()
        node = parent.internalPointer()
        if 0 <= row < len(node.children):
            return self.createIndex(row, col, node.children[row])
        return QModelIndex()

    def parent(self, index: QModelIndex):
        if not index.isValid():
            return QModelIndex()
        node = index.internalPointer()
        if node.parent is self._root or node.parent is None:
            return QModelIndex()
        row = node.parent.children.index(node)
        if node.parent.parent is None:
            return QModelIndex()
        return self.createIndex(node.parent.parent.children.index(node.parent), 0, node.parent)

    def data(self, index: QModelIndex, role=Qt.DisplayRole):
        if not index.isValid():
            return None
        n: GroupTreeModel._Node = index.internalPointer()
        if role == Qt.DisplayRole or role == RoleTitle:
            return n.label
        if role == RoleKind:
            return n.kind
        if role == RoleCount:
            return n.count
        if role == RoleColor and n.kind == "tag":
            return (n.payload or ("", "", "#0D9488"))[2]
        return None

    def flags(self, index: QModelIndex):
        return Qt.ItemIsEnabled | Qt.ItemIsSelectable

    def node(self, index: QModelIndex):
        return index.internalPointer() if index.isValid() else None
