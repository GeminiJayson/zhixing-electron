# -*- coding: utf-8 -*-
"""领域实体：纯 Python dataclass，无 Qt / 无 SQL 依赖。"""
from dataclasses import dataclass, field
from datetime import date, datetime
from enum import Enum
from typing import List, Optional


class TaskStatus(str, Enum):
    TODO = "todo"
    DOING = "doing"
    WAITING = "waiting"   # v0.15 P2-8：等待中（暂停执行，可设 resume_at 自动恢复）
    DONE = "done"
    ABANDONED = "abandoned"


class Priority(int, Enum):
    """优先级 8 级（v0.17 起）：数字即档位，P1 最低 … P8 最高。

    兼容别名 LOW/MID/HIGH 保留旧语义（低/中/高 ≈ P2/P5/P8），使
    ``int(priority) >= Priority.MID`` 一类的旧判定在 8 级下自动成立；
    数据库历史值经 migrate_v8 映射 1→2、2→5、3→8。
    """
    NONE = 0
    P1 = 1
    P2 = 2
    P3 = 3
    P4 = 4
    P5 = 5
    P6 = 6
    P7 = 7
    P8 = 8
    # —— 兼容别名（int 值与档位一致，语义：低/中/高）——
    LOW = 2    # = P2
    MID = 5    # = P5
    HIGH = 8   # = P8


def priority_label(priority) -> str:
    """档位显示名（纯 Python，供 model/view 共用）：无 / P1..P8。

    - 兼容枚举对象（Priority.P5）与 int（5）两种入参；别名按 int 值显示（P2/P5/P8）。
    """
    v = int(priority) if priority is not None else 0
    if v <= 0:
        return "无"
    if v > 8:
        v = 8
    return f"P{v}"


def priority_is_important(priority) -> bool:
    """「重要」判定（Eisenhower 上半区）：≥ P5（中及以上，含旧 MID=5/HIGH=8）。"""
    return int(priority) >= int(Priority.MID)


class RepeatPeriod(str, Enum):
    NONE = "none"
    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"
    CUSTOM = "custom"    # 自定义 RRULE 子集（配合 repeat_rule 字符串）


class FolderKind(str, Enum):
    GROUP = "group"    # 分组（可嵌套、可收纳子节点）
    LIST = "list"      # 列表（叶子，承载任务）


class FlashStatus(str, Enum):
    INBOX = "inbox"
    ARCHIVED = "archived"
    CONVERTED = "converted"


@dataclass
class ListFolder:
    """任务侧「分组 > 列表 > 任务」结构中的分组或列表节点。"""
    id: Optional[int] = None
    parent_id: Optional[int] = None
    kind: FolderKind = FolderKind.LIST
    name: str = ""
    icon: str = "folder"
    collapsed: bool = False
    sort: float = 0.0
    created_at: Optional[datetime] = None


@dataclass
class Task:
    id: Optional[int] = None
    title: str = ""
    notes_md: str = ""
    status: TaskStatus = TaskStatus.TODO
    priority: Priority = Priority.NONE
    due_date: Optional[date] = None
    start_date: Optional[date] = None
    reminder_at: Optional[datetime] = None
    resume_at: Optional[date] = None      # v0.15 P2-8：waiting 时计划恢复日期（到期自动回 todo/doing）
    list_id: Optional[int] = None
    parent_id: Optional[int] = None
    repeat_period: RepeatPeriod = RepeatPeriod.NONE
    repeat_rule: Optional[str] = None   # 自定义 RRULE 子集（RepeatPeriod.CUSTOM 时使用）
    streak: int = 0
    last_reset_date: Optional[date] = None
    sort_key: float = 0.0
    completed_at: Optional[datetime] = None
    deleted_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    # 非持久化聚合字段（查询时填充）
    children: List["Task"] = field(default_factory=list)
    tag_ids: List[int] = field(default_factory=list)
    note_count: int = 0

    @property
    def is_done(self) -> bool:
        return self.status in (TaskStatus.DONE, TaskStatus.ABANDONED)

    @property
    def is_recurring(self) -> bool:
        return self.repeat_period != RepeatPeriod.NONE


@dataclass
class NoteFolder:
    id: Optional[int] = None
    parent_id: Optional[int] = None
    name: str = ""
    sort: float = 0.0


@dataclass
class Note:
    id: Optional[int] = None
    folder_id: Optional[int] = None
    title: str = ""
    content_md: str = ""
    format: str = "markdown"     # markdown | richtext | word | excel | link
    # markdown：正文；richtext：HTML 片段；word/excel/link：content_md 存本地文件路径或 URL
    pinned: bool = False
    word_count: int = 0
    deleted_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    tag_ids: List[int] = field(default_factory=list)


@dataclass
class Flash:
    """闪念：划词/快速捕获的零散知识。"""
    id: Optional[int] = None
    content: str = ""
    remark: str = ""
    source_app: str = ""
    source_url: str = ""
    status: FlashStatus = FlashStatus.INBOX
    converted_type: str = ""      # note / task / subtask
    converted_id: int = 0
    deleted_at: Optional[datetime] = None
    created_at: Optional[datetime] = None


@dataclass
class Tag:
    id: Optional[int] = None
    name: str = ""
    color: str = "#0D9488"


@dataclass
class NoteLink:
    id: Optional[int] = None
    src_note_id: int = 0
    dst_note_id: Optional[int] = 0   # None = 待建链接（悬空）
    dst_title: str = ""


@dataclass
class TaskNoteLink:
    id: Optional[int] = None
    task_id: int = 0
    note_id: int = 0


@dataclass
class TaskNoteContext:
    """任务↔笔记「段落级」上下文（v0.15 P0-1）：定位块键 + 引文快照。"""
    id: Optional[int] = None
    task_id: int = 0
    note_id: int = 0
    block_key: str = ""
    snippet: str = ""
    created_at: Optional[datetime] = None


@dataclass
class PomodoroSession:
    id: Optional[int] = None
    task_id: Optional[int] = None
    started_at: Optional[datetime] = None
    minutes: int = 25
    completed: bool = False
    reason: Optional[str] = None   # 中断原因（F5-2，abandoned 时落库）




# ===================== 工作流（Workflow，v10） =====================


class WorkflowStatus(str, Enum):
    """实例运行状态。"""
    RUNNING = "running"
    DONE = "done"
    ABORTED = "aborted"


class StepAction(str, Enum):
    """步骤可执行动作。

    - NONE：纯人工步骤（只下发待办）；
    - OPEN_NOTE / OPEN_URL：应用内跳转（安全，无副作用）；
    - RUN_COMMAND：运行本地命令/脚本 —— 有安全风险，执行前必须二次确认。
    """
    NONE = "none"
    OPEN_NOTE = "open_note"
    OPEN_URL = "open_url"
    RUN_COMMAND = "run_command"


class StartPolicy(str, Enum):
    """实例化时的步骤下发策略。"""
    FIRST = "first"   # 只生成第一步待办，完成后自动推进（默认，列表更干净）
    ALL = "all"       # 一次性生成全部步骤待办（一揽全局）


@dataclass
class WorkflowNode:
    """模板中的一个步骤节点。"""
    id: Optional[int] = None
    template_id: Optional[int] = None
    title: str = ""
    detail: str = ""
    order_index: int = 0
    note_id: Optional[int] = None       # 绑定的知识库文档（SOP 指导）
    action_kind: str = StepAction.NONE.value
    action_value: str = ""              # URL / 命令
    condition: str = ""                 # 进入条件（自由文本，供人工判断）
    branch_node_id: Optional[int] = None
    # 画布坐标（v11）：持久化节点位置，使布局在操作后保持不变
    pos_x: Optional[float] = None
    pos_y: Optional[float] = None

    @property
    def has_action(self) -> bool:
        return self.action_kind not in ("", StepAction.NONE.value)


@dataclass
class WorkflowTemplate:
    """工作流模板（定义态）：一张步骤图。"""
    id: Optional[int] = None
    name: str = ""
    description: str = ""
    start_policy: str = StartPolicy.FIRST.value
    nodes: List[WorkflowNode] = field(default_factory=list)
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    def ordered_nodes(self) -> List[WorkflowNode]:
        """按执行顺序返回节点（order_index 升序，其次按 id 稳定排序）。"""
        return sorted(self.nodes,
                      key=lambda n: (n.order_index or 0, n.id or 0))

    def first_node(self) -> Optional[WorkflowNode]:
        nodes = self.ordered_nodes()
        return nodes[0] if nodes else None

    def next_node(self, node_id: Optional[int]) -> Optional[WorkflowNode]:
        """某节点的下一步：优先条件分支，否则按顺序取下一个。"""
        if node_id is None:
            return self.first_node()
        nodes = self.ordered_nodes()
        idx = next((i for i, n in enumerate(nodes) if n.id == node_id), -1)
        if idx < 0:
            return None
        cur = nodes[idx]
        if cur.branch_node_id:
            branched = next((n for n in nodes if n.id == cur.branch_node_id), None)
            if branched is not None:
                return branched
        return nodes[idx + 1] if idx + 1 < len(nodes) else None

    def validate(self) -> List[str]:
        """拓扑校验：返回问题列表（空 = 无问题）。

        检查项：① 至少一个节点；② 标题非空；③ 条件分支指向的节点存在
        且不能指向自己；④ 分支不能形成环（DFS 检测，避免实例永远走不完）。
        """
        problems: List[str] = []
        nodes = self.ordered_nodes()
        if not nodes:
            problems.append("工作流至少要有一个步骤")
            return problems
        ids = {n.id for n in nodes if n.id is not None}
        for i, n in enumerate(nodes, 1):
            if not (n.title or "").strip():
                problems.append(f"第 {i} 个步骤缺少标题")
            if n.branch_node_id is not None:
                if n.branch_node_id == n.id:
                    problems.append(f"步骤「{n.title}」的分支不能指向自己")
                elif n.branch_node_id not in ids:
                    problems.append(f"步骤「{n.title}」的分支指向了不存在的步骤")
        # 分支环检测（只沿 branch 边走）
        branch = {n.id: n.branch_node_id for n in nodes if n.branch_node_id}
        for start in list(branch):
            seen, cur = set(), start
            while cur in branch:
                if cur in seen:
                    problems.append("步骤的条件分支形成了环，实例将无法结束")
                    break
                seen.add(cur)
                cur = branch[cur]
            if problems and "环" in problems[-1]:
                break
        return problems


@dataclass
class WorkflowStep:
    """实例中的一步：节点 + 已生成的任务（双向绑定的落点）。"""
    node_id: int = 0
    title: str = ""
    task_id: Optional[int] = None
    done: bool = False


@dataclass
class WorkflowInstance:
    """工作流实例（运行态）。"""
    id: Optional[int] = None
    template_id: Optional[int] = None
    title: str = ""
    status: str = WorkflowStatus.RUNNING.value
    current_node_id: Optional[int] = None
    origin_task_id: Optional[int] = None   # 由哪个任务启动（可空 = 手动启动）
    created_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    steps: List[WorkflowStep] = field(default_factory=list)

    @property
    def done_count(self) -> int:
        return sum(1 for s in self.steps if s.done)

    @property
    def progress_text(self) -> str:
        return f"{self.done_count}/{len(self.steps)}"

@dataclass
class BacklinkItem:
    """反向链接条目：来源笔记 + 上下文摘录。"""
    src_note_id: int = 0
    src_title: str = ""
    snippet: str = ""
