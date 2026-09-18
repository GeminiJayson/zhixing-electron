# -*- coding: utf-8 -*-
"""SQLAlchemy ORM 模型：与 domain 实体一一对应（互转在 repositories 完成）。"""
from datetime import datetime

from sqlalchemy import (
    Boolean, Column, Date, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint,
)
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class ListFolderRow(Base):
    __tablename__ = "list_folder"
    id = Column(Integer, primary_key=True, autoincrement=True)
    parent_id = Column(Integer, ForeignKey("list_folder.id"), nullable=True)
    kind = Column(String, default="list")          # group | list
    name = Column(String, nullable=False)
    icon = Column(String, default="folder")
    collapsed = Column(Boolean, default=False)
    sort = Column(Float, default=0.0)
    created_at = Column(DateTime, default=datetime.now)


class TaskRow(Base):
    __tablename__ = "task"
    id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String, nullable=False)
    notes_md = Column(Text, default="")
    status = Column(String, default="todo")        # todo|doing|waiting|done|abandoned
    priority = Column(Integer, default=0)          # 0..8（NONE=0, P1..P8）
    due_date = Column(Date, nullable=True)
    start_date = Column(Date, nullable=True)
    reminder_at = Column(DateTime, nullable=True)
    resume_at = Column(Date, nullable=True)        # v0.15 waiting：自动恢复进行中的日期
    list_id = Column(Integer, ForeignKey("list_folder.id"), nullable=True)
    parent_id = Column(Integer, ForeignKey("task.id"), nullable=True)
    repeat_period = Column(String, default="none") # none|daily|weekly|monthly|custom
    repeat_rule = Column(String, nullable=True)     # 自定义 RRULE 子集（custom 时）
    streak = Column(Integer, default=0)
    last_reset_date = Column(Date, nullable=True)
    sort_key = Column(Float, default=0.0)
    completed_at = Column(DateTime, nullable=True)
    deleted_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)
    __table_args__ = ({"sqlite_autoincrement": True},)


class NoteFolderRow(Base):
    __tablename__ = "note_folder"
    id = Column(Integer, primary_key=True, autoincrement=True)
    parent_id = Column(Integer, ForeignKey("note_folder.id"), nullable=True)
    name = Column(String, nullable=False)
    sort = Column(Float, default=0.0)


class NoteRow(Base):
    __tablename__ = "note"
    id = Column(Integer, primary_key=True, autoincrement=True)
    folder_id = Column(Integer, ForeignKey("note_folder.id"), nullable=True)
    title = Column(String, nullable=False, default="未命名笔记")
    content_md = Column(Text, default="")
    format = Column(String, nullable=False, default="markdown")  # markdown | richtext | word | excel | link
    pinned = Column(Boolean, default=False)
    word_count = Column(Integer, default=0)
    deleted_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)


class FlashRow(Base):
    __tablename__ = "flash"
    id = Column(Integer, primary_key=True, autoincrement=True)
    content = Column(Text, nullable=False)
    remark = Column(String, default="")
    source_app = Column(String, default="")
    source_url = Column(String, default="")
    status = Column(String, default="inbox")       # inbox|archived|converted
    converted_type = Column(String, default="")
    converted_id = Column(Integer, default=0)
    deleted_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.now)


class TagRow(Base):
    __tablename__ = "tag"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False, unique=True)
    color = Column(String, default="#0D9488")


class TaskTagRow(Base):
    __tablename__ = "task_tag"
    task_id = Column(Integer, ForeignKey("task.id", ondelete="CASCADE"), primary_key=True)
    tag_id = Column(Integer, ForeignKey("tag.id", ondelete="CASCADE"), primary_key=True)


class NoteTagRow(Base):
    __tablename__ = "note_tag"
    note_id = Column(Integer, ForeignKey("note.id", ondelete="CASCADE"), primary_key=True)
    tag_id = Column(Integer, ForeignKey("tag.id", ondelete="CASCADE"), primary_key=True)


class FlashTagRow(Base):
    __tablename__ = "flash_tag"
    flash_id = Column(Integer, ForeignKey("flash.id", ondelete="CASCADE"), primary_key=True)
    tag_id = Column(Integer, ForeignKey("tag.id", ondelete="CASCADE"), primary_key=True)


class TaskNoteLinkRow(Base):
    __tablename__ = "task_note_link"
    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(Integer, ForeignKey("task.id", ondelete="CASCADE"), nullable=False)
    note_id = Column(Integer, ForeignKey("note.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime, default=datetime.now)
    __table_args__ = (UniqueConstraint("task_id", "note_id", name="uq_task_note"),)


class TaskNoteContextRow(Base):
    """任务↔笔记「段落级」上下文（v0.15 P0-1）：任务关联笔记内某段落的块定位 + 引文快照。

    与 task_note_link（整篇关联）并存且相互独立；同一 (task,note,block_key) 唯一。
    """
    __tablename__ = "task_note_context"
    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(Integer, ForeignKey("task.id", ondelete="CASCADE"), nullable=False)
    note_id = Column(Integer, ForeignKey("note.id", ondelete="CASCADE"), nullable=False)
    block_key = Column(String, nullable=False)          # 段落块键（见 TaskNoteContext.block_key）
    snippet = Column(Text, default="")                   # 引文快照（定位兜底 + 预览）
    created_at = Column(DateTime, default=datetime.now)
    __table_args__ = (UniqueConstraint("task_id", "note_id", "block_key",
                                       name="uq_task_note_block"),)


class TaskNoteRefRow(Base):
    """任务↔笔记「引用」关系（与 task_note_link 的归属关系并存）。

    语义区分：
    - 归属（task_note_link）：任务「拥有/关联」这篇笔记，图谱实线，无环 DAG；
    - 引用（本表）：任务「提到/引用了」这篇笔记，图谱虚线，允许成环。
    同一对 (task, note) 可同时存在两种关系（归属 + 引用），互不影响。
    """
    __tablename__ = "task_note_ref"
    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(Integer, ForeignKey("task.id", ondelete="CASCADE"), nullable=False)
    note_id = Column(Integer, ForeignKey("note.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime, default=datetime.now)
    __table_args__ = (UniqueConstraint("task_id", "note_id", name="uq_task_note_ref"),)


# ===================== 工作流（Workflow，v10） =====================
# 语义：模板（Template）定义「怎么做」，实例（Instance）是一次具体运行。
# 与任务双向绑定：任务可引用模板启动实例；实例的每个待办步骤又回指对应任务。


class WorkflowTemplateRow(Base):
    """工作流模板（定义态）：一张节点图，描述步骤顺序与条件分支。"""
    __tablename__ = "workflow_template"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    description = Column(Text, default="")
    # 启动策略：first=实例化时只生成第一步待办；all=一次性生成全部步骤待办
    start_policy = Column(String, default="first")   # first | all
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, nullable=True)


class WorkflowNodeRow(Base):
    """模板中的节点（步骤）：顺序、条件分支与「这一步做什么」。

    - order_index/next_node_id：线性顺序与条件跳转；
    - note_id：绑定知识库文档（SOP 指导）；
    - action_kind/action_value：可执行动作（none/open_note/open_url/run_command）；
    - condition：进入本节点的条件（可选，空即无条件）。
    """
    __tablename__ = "workflow_node"
    id = Column(Integer, primary_key=True, autoincrement=True)
    template_id = Column(Integer, ForeignKey("workflow_template.id", ondelete="CASCADE"),
                         nullable=False)
    title = Column(String, nullable=False)
    detail = Column(Text, default="")
    order_index = Column(Integer, default=0)          # 展示/执行顺序
    note_id = Column(Integer, ForeignKey("note.id", ondelete="SET NULL"), nullable=True)
    action_kind = Column(String, default="none")      # none|open_note|open_url|run_command
    action_value = Column(Text, default="")           # URL / 命令 / 参数
    condition = Column(String, default="")            # 进入条件（自由文本，供人工判断）
    # 条件分支：满足 condition 时走这里；为空则走 order_index 的下一步
    branch_node_id = Column(Integer, ForeignKey("workflow_node.id", ondelete="SET NULL"),
                            nullable=True)
    # 画布坐标（v11）：持久化节点位置，使「新增节点/其它操作后布局不变化」
    pos_x = Column(Float, nullable=True)
    pos_y = Column(Float, nullable=True)
    created_at = Column(DateTime, default=datetime.now)


class WorkflowInstanceRow(Base):
    """工作流实例（运行态）：一次具体运行，进度与来源任务。"""
    __tablename__ = "workflow_instance"
    id = Column(Integer, primary_key=True, autoincrement=True)
    template_id = Column(Integer, ForeignKey("workflow_template.id", ondelete="CASCADE"),
                         nullable=False)
    title = Column(String, default="")             # 实例名（默认取模板名 + 时间）
    status = Column(String, default="running")     # running|done|aborted
    current_node_id = Column(Integer, ForeignKey("workflow_node.id", ondelete="SET NULL"),
                             nullable=True)
    origin_task_id = Column(Integer, ForeignKey("task.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=datetime.now)
    finished_at = Column(DateTime, nullable=True)


class WorkflowStepTaskRow(Base):
    """实例步骤 ↔ 任务 的绑定（双向）：步骤下发为待办，完成后回推流程。

    与 task 双向绑定：
    - 流程 → 任务：实例化/推进时按步骤生成待办；
    - 任务 → 流程：该待办完成时自动推进实例到下一节点。
    """
    __tablename__ = "workflow_step_task"
    id = Column(Integer, primary_key=True, autoincrement=True)
    instance_id = Column(Integer, ForeignKey("workflow_instance.id", ondelete="CASCADE"),
                         nullable=False)
    node_id = Column(Integer, ForeignKey("workflow_node.id", ondelete="CASCADE"),
                     nullable=False)
    task_id = Column(Integer, ForeignKey("task.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime, default=datetime.now)
    __table_args__ = (UniqueConstraint("instance_id", "node_id", name="uq_wf_step_node"),)


class NoteLinkRow(Base):
    __tablename__ = "note_link"
    id = Column(Integer, primary_key=True, autoincrement=True)
    src_note_id = Column(Integer, ForeignKey("note.id", ondelete="CASCADE"), nullable=False)
    dst_note_id = Column(Integer, ForeignKey("note.id", ondelete="CASCADE"), nullable=True)  # NULL=待建
    dst_title = Column(String, nullable=False, default="")
    __table_args__ = (UniqueConstraint("src_note_id", "dst_title", name="uq_src_dst_title"),)


class PomodoroRow(Base):
    __tablename__ = "pomodoro_session"
    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(Integer, ForeignKey("task.id", ondelete="SET NULL"), nullable=True)
    started_at = Column(DateTime, default=datetime.now)
    minutes = Column(Integer, default=25)
    completed = Column(Boolean, default=False)
    reason = Column(String, nullable=True)          # 中断原因（F5-2）


class AttachmentRow(Base):
    __tablename__ = "attachment"
    id = Column(Integer, primary_key=True, autoincrement=True)
    note_id = Column(Integer, ForeignKey("note.id", ondelete="CASCADE"), nullable=False)
    path = Column(String, nullable=False)
    kind = Column(String, default="file")
    created_at = Column(DateTime, default=datetime.now)


class NoteRevisionRow(Base):
    """笔记版本历史快照（F2-9，保留最近 20 版）。"""
    __tablename__ = "note_revision"
    id = Column(Integer, primary_key=True, autoincrement=True)
    note_id = Column(Integer, ForeignKey("note.id", ondelete="CASCADE"), nullable=False)
    title = Column(String, default="")
    content_md = Column(Text, default="")
    format = Column(String, default="markdown")
    created_at = Column(DateTime, default=datetime.now)


class SettingRow(Base):
    __tablename__ = "settings"
    key = Column(String, primary_key=True)
    value = Column(Text, default="")

SCHEMA_VERSION = 12
