# -*- coding: utf-8 -*-
"""工作流服务：模板 CRUD + 实例化 + 步骤推进 + 与任务的双向绑定。

融合设计（对照外部设计稿，结合本项目既有能力）：
- 知识库 = 本项目「笔记」模块（已远超设计稿）：节点可绑定 note_id 作为 SOP 指导；
- 待办 = 本项目「任务」模块：实例的每一步下发为真实任务（子任务）；
- 双向绑定：① 任务可引用模板启动实例（origin_task_id）；② 步骤任务完成时
  自动推进实例到下一节点（complete_step_task）；
- 事件总线：所有写操作发对应领域事件，视图/图谱按既有约定增量刷新。
"""
from datetime import datetime
from typing import Dict, List, Optional

from ...core.event_bus import EventBus
from ..domain.entities import (
    StartPolicy, StepAction, WorkflowInstance, WorkflowNode, WorkflowStatus,
    WorkflowStep, WorkflowTemplate,
)
from ..infrastructure.db import Database


class WorkflowService:
    """工作流：模板（定义态）与实例（运行态）。"""

    def __init__(self, db: Database, bus: EventBus, task_service=None):
        self.db = db
        self.bus = bus
        self.tasks = task_service      # 延迟注入，避免与 TaskService 循环依赖

    # ==================== 模板（定义态） ====================
    def list_templates(self) -> List[WorkflowTemplate]:
        from ..infrastructure.models import WorkflowTemplateRow
        s = self.db.session()
        try:
            rows = s.query(WorkflowTemplateRow).order_by(
                WorkflowTemplateRow.updated_at.desc().nullslast(),
                WorkflowTemplateRow.id.desc()).all()
            return [self._to_template(r) for r in rows]
        finally:
            s.close()

    def get_template(self, template_id: int) -> Optional[WorkflowTemplate]:
        from ..infrastructure.models import WorkflowTemplateRow
        s = self.db.session()
        try:
            r = s.query(WorkflowTemplateRow).filter(
                WorkflowTemplateRow.id == template_id).first()
            return self._to_template(r) if r else None
        finally:
            s.close()

    def save_template(self, tpl: WorkflowTemplate,
                      silent: bool = False) -> Optional[WorkflowTemplate]:
        """新建/更新模板（含节点整体替换）。返回保存后的模板。

        ``silent=True`` 时保存但不广播 workflow_template_changed，供「拖动节点后
        静默持久化坐标」使用（避免每次拖动都触发整页重建、丢失焦点）。

        校验不通过（见 WorkflowTemplate.validate）时拒绝保存并返回 None，
        由视图层展示具体问题，避免存下无法运行的工作流。
        """
        problems = tpl.validate()
        if problems:
            return None
        from ..infrastructure.models import WorkflowNodeRow, WorkflowTemplateRow
        s = self.db.session()
        try:
            now = datetime.now()
            if tpl.id:
                row = s.query(WorkflowTemplateRow).filter(
                    WorkflowTemplateRow.id == tpl.id).first()
                if row is None:
                    return None
                row.name = tpl.name
                row.description = tpl.description
                row.start_policy = tpl.start_policy
                row.updated_at = now
            else:
                row = WorkflowTemplateRow(
                    name=tpl.name, description=tpl.description,
                    start_policy=tpl.start_policy, created_at=now, updated_at=now)
                s.add(row)
                s.flush()                       # 拿到自增 id
            tid = row.id
            # 节点整体替换（简单可靠：模板规模小，无需增量 diff）
            s.query(WorkflowNodeRow).filter(
                WorkflowNodeRow.template_id == tid).delete()
            s.flush()
            id_map: Dict[int, int] = {}         # 旧临时 id -> 新 id（供分支引用重映射）
            created = []
            for i, n in enumerate(tpl.nodes):
                nr = WorkflowNodeRow(
                    template_id=tid, title=n.title, detail=n.detail,
                    order_index=n.order_index if n.order_index else i,
                    note_id=n.note_id, action_kind=n.action_kind,
                    action_value=n.action_value, condition=n.condition,
                    pos_x=n.pos_x, pos_y=n.pos_y, created_at=now)
                s.add(nr)
                s.flush()
                if n.id is not None:
                    id_map[n.id] = nr.id
                created.append((nr, n))
            # 分支引用重映射（旧 id -> 新 id）
            for nr, n in created:
                if n.branch_node_id is not None:
                    nr.branch_node_id = id_map.get(n.branch_node_id, n.branch_node_id)
            s.commit()
            tid_saved = tid
        finally:
            s.close()
        if not silent:
            self._emit_templates_changed()
        return self.get_template(tid_saved)

    def delete_template(self, template_id: int) -> bool:
        from ..infrastructure.models import (
            WorkflowInstanceRow, WorkflowTemplateRow,
        )
        s = self.db.session()
        removed = False
        try:
            running = s.query(WorkflowInstanceRow).filter(
                WorkflowInstanceRow.template_id == template_id,
                WorkflowInstanceRow.status == WorkflowStatus.RUNNING.value).count()
            if running:
                return False                    # 有运行中实例，拒绝删除
            row = s.query(WorkflowTemplateRow).filter(
                WorkflowTemplateRow.id == template_id).first()
            if row is not None:
                s.delete(row)
                s.commit()
                removed = True
        finally:
            s.close()
        if removed:
            self._emit_templates_changed()
        return removed

    def duplicate_template(self, template_id: int) -> Optional[WorkflowTemplate]:
        """复制模板（含节点与分支重映射）——常用于「基于已有流程改一份」。"""
        src = self.get_template(template_id)
        if src is None:
            return None
        clone = WorkflowTemplate(
            name=f"{src.name} 副本", description=src.description,
            start_policy=src.start_policy,
            nodes=[WorkflowNode(
                id=n.id, title=n.title, detail=n.detail,
                order_index=n.order_index, note_id=n.note_id,
                action_kind=n.action_kind, action_value=n.action_value,
                condition=n.condition, branch_node_id=n.branch_node_id,
            ) for n in src.ordered_nodes()])
        return self.save_template(clone)

    # ==================== 实例（运行态） ====================
    def instantiate(self, template_id: int, title: str = "",
                    origin_task_id: Optional[int] = None,
                    policy: Optional[str] = None) -> Optional[WorkflowInstance]:
        """实例化：创建实例，并按策略把步骤下发为任务。

        policy=first（默认）：只生成第一步待办，完成后自动推进；
        policy=all：一次性生成全部步骤待办。
        """
        tpl = self.get_template(template_id)
        if tpl is None or not tpl.nodes:
            return None
        use_policy = policy or tpl.start_policy or StartPolicy.FIRST.value
        from ..infrastructure.models import WorkflowInstanceRow
        s = self.db.session()
        try:
            first = tpl.first_node()
            now = datetime.now()
            row = WorkflowInstanceRow(
                template_id=template_id,
                title=title or f"{tpl.name} · {now.strftime('%m-%d %H:%M')}",
                status=WorkflowStatus.RUNNING.value,
                current_node_id=first.id if first else None,
                origin_task_id=origin_task_id, created_at=now)
            s.add(row)
            s.commit()
            inst_id = row.id
        finally:
            s.close()
        nodes = tpl.ordered_nodes() if use_policy == StartPolicy.ALL.value \
            else ([tpl.first_node()] if tpl.first_node() else [])
        for n in nodes:
            self._spawn_step_task(inst_id, n, tpl)
        self._emit_instances_changed()
        return self.get_instance(inst_id)

    def get_instance(self, instance_id: int) -> Optional[WorkflowInstance]:
        from ..infrastructure.models import (
            WorkflowInstanceRow, WorkflowNodeRow, WorkflowStepTaskRow, WorkflowTemplateRow,
        )
        s = self.db.session()
        try:
            r = s.query(WorkflowInstanceRow).filter(
                WorkflowInstanceRow.id == instance_id).first()
            if r is None:
                return None
            tpl_row = s.query(WorkflowTemplateRow).filter(
                WorkflowTemplateRow.id == r.template_id).first()
            nodes = {n.id: n for n in s.query(WorkflowNodeRow).filter(
                WorkflowNodeRow.template_id == r.template_id)
                .order_by(WorkflowNodeRow.order_index).all()}
            binds = s.query(WorkflowStepTaskRow).filter(
                WorkflowStepTaskRow.instance_id == instance_id).all()
            inst = WorkflowInstance(
                id=r.id, template_id=r.template_id, title=r.title or "",
                status=r.status or WorkflowStatus.RUNNING.value,
                current_node_id=r.current_node_id, origin_task_id=r.origin_task_id,
                created_at=r.created_at, finished_at=r.finished_at)
            if tpl_row is not None:
                inst.title = inst.title or tpl_row.name
            done_map = self._task_done_map([b.task_id for b in binds])
            for b in binds:
                n = nodes.get(b.node_id)
                inst.steps.append(WorkflowStep(
                    node_id=b.node_id,
                    title=(n.title if n is not None else ""),
                    task_id=b.task_id,
                    done=bool(done_map.get(b.task_id, False))))
            return inst
        finally:
            s.close()

    def list_instances(self, status: Optional[str] = None) -> List[WorkflowInstance]:
        from ..infrastructure.models import WorkflowInstanceRow
        s = self.db.session()
        try:
            q = s.query(WorkflowInstanceRow)
            if status:
                q = q.filter(WorkflowInstanceRow.status == status)
            rows = q.order_by(WorkflowInstanceRow.id.desc()).all()
            ids = [r.id for r in rows]
        finally:
            s.close()
        return [i for i in (self.get_instance(i) for i in ids) if i is not None]

    def instances_of_task(self, task_id: int) -> List[WorkflowInstance]:
        """某任务启动/关联的所有实例（任务侧面板用）。"""
        from ..infrastructure.models import WorkflowInstanceRow
        s = self.db.session()
        try:
            ids = [r.id for r in s.query(WorkflowInstanceRow).filter(
                WorkflowInstanceRow.origin_task_id == task_id).all()]
        finally:
            s.close()
        return [i for i in (self.get_instance(i) for i in ids) if i is not None]

    # ---------- 步骤推进（任务完成 → 流程前进） ----------
    def complete_step_task(self, task_id: int) -> bool:
        """某个步骤任务完成时调用：推进其所属实例到下一节点。

        返回 True 表示确实推进了流程（调用方据此刷新视图）。
        """
        from ..infrastructure.models import (
            WorkflowInstanceRow, WorkflowStepTaskRow, WorkflowTemplateRow,
        )
        s = self.db.session()
        try:
            bind = s.query(WorkflowStepTaskRow).filter(
                WorkflowStepTaskRow.task_id == task_id).first()
            if bind is None:
                return False
            inst = s.query(WorkflowInstanceRow).filter(
                WorkflowInstanceRow.id == bind.instance_id).first()
            if inst is None or inst.status != WorkflowStatus.RUNNING.value:
                return False
            tpl_row = s.query(WorkflowTemplateRow).filter(
                WorkflowTemplateRow.id == inst.template_id).first()
            inst_id, tpl_id, cur_node = inst.id, inst.template_id, bind.node_id
        finally:
            s.close()
        tpl = self.get_template(tpl_id)
        if tpl is None:
            return False
        nxt = tpl.next_node(cur_node)
        if nxt is None:
            self._finish_instance(inst_id)      # 已是最后一步 -> 实例完成
            self._emit_instances_changed()
            return True
        # 下一步若尚未生成任务则生成（policy=first 时即在此逐级下发）
        if not self._step_has_task(inst_id, nxt.id):
            self._spawn_step_task(inst_id, nxt, tpl)
        self._set_current_node(inst_id, nxt.id)
        self._emit_instances_changed()
        return True

    def abort_instance(self, instance_id: int) -> bool:
        from ..infrastructure.models import WorkflowInstanceRow
        s = self.db.session()
        try:
            r = s.query(WorkflowInstanceRow).filter(
                WorkflowInstanceRow.id == instance_id).first()
            if r is None:
                return False
            r.status = WorkflowStatus.ABORTED.value
            r.finished_at = datetime.now()
            s.commit()
        finally:
            s.close()
        self._emit_instances_changed()
        return True

    # ==================== 步骤动作执行 ====================
    def describe_action(self, node: WorkflowNode) -> str:
        """动作的人类可读描述（用于执行前确认、以及步骤列表的提示）。"""
        kind = node.action_kind or StepAction.NONE.value
        if kind == StepAction.OPEN_NOTE.value:
            title = self._note_title(int(node.action_value)) \
                if (node.action_value or "").isdigit() else ""
            return f"打开笔记「{title}」" if title else "打开关联笔记"
        if kind == StepAction.OPEN_URL.value:
            return f"在浏览器打开 {node.action_value}"
        if kind == StepAction.RUN_COMMAND.value:
            return f"运行命令：{node.action_value}"
        return "无动作"

    def is_risky_action(self, node: WorkflowNode) -> bool:
        """是否为有副作用的动作（运行本地命令需执行前二次确认）。"""
        return (node.action_kind or "") == StepAction.RUN_COMMAND.value

    def run_step_action(self, node: WorkflowNode) -> tuple:
        """执行步骤动作，返回 (ok, message)。

        安全约定：RUN_COMMAND 会在**独立进程**中执行，且不经过 shell（避免
        注入与管道语义）；调用方（视图层）必须在执行前向用户二次确认。
        OPEN_URL/OPEN_NOTE 无副作用，由视图层直接完成（需要 Qt 组件）。
        """
        kind = node.action_kind or StepAction.NONE.value
        if kind == StepAction.RUN_COMMAND.value:
            cmd = (node.action_value or "").strip()
            if not cmd:
                return False, "未填写要运行的命令"
            import shlex
            import subprocess
            try:
                argv = shlex.split(cmd)
                if not argv:
                    return False, "命令为空"
                subprocess.Popen(argv)          # 不阻塞 UI，不经 shell
                return True, f"已启动：{argv[0]}"
            except FileNotFoundError:
                return False, f"找不到命令：{argv[0] if argv else cmd}"
            except Exception as ex:  # noqa: BLE001
                return False, f"执行失败：{ex}"
        if kind == StepAction.NONE.value:
            return False, "该步骤没有配置动作"
        # OPEN_NOTE / OPEN_URL 需 Qt 组件，交由视图层处理
        return False, "该动作需在界面中执行"

    # ==================== 内部 ====================
    def _spawn_step_task(self, instance_id: int, node: WorkflowNode,
                         tpl: WorkflowTemplate) -> Optional[int]:
        """把一步下发为真实任务，并建立 步骤↔任务 绑定。"""
        if self.tasks is None or node is None:
            return None
        from ..infrastructure.models import (
            WorkflowInstanceRow, WorkflowStepTaskRow, WorkflowTemplateRow,
        )
        s = self.db.session()
        try:
            inst = s.query(WorkflowInstanceRow).filter(
                WorkflowInstanceRow.id == instance_id).first()
            if inst is None:
                return None
            tpl_row = s.query(WorkflowTemplateRow).filter(
                WorkflowTemplateRow.id == tpl.id).first()
            tpl_name = tpl_row.name if tpl_row is not None else "工作流"
            parent_id = inst.origin_task_id
        finally:
            s.close()
        # 步骤绑定的知识库文档 -> 写入任务备注的 [[链接]]（复用既有链接管线，
        # 任务编辑页/速览面板即可直接跳转到该 SOP 文档）
        notes_md = ""
        if node.note_id:
            try:
                note_title = self._note_title(node.note_id)
                if note_title:
                    notes_md = f"[[{note_title}]]"
            except Exception:  # noqa: BLE001
                notes_md = ""
        # 任务标题带流程前缀，便于在待办列表里一眼看出「来自哪个流程的哪一步」；
        # 有来源任务时挂为其子任务，形成「任务 → 流程步骤」的层级。
        task = self.tasks.create(f"{tpl_name}：{node.title}",
                                 parent_id=parent_id, notes_md=notes_md)
        if task is None:
            return None
        s = self.db.session()
        try:
            s.add(WorkflowStepTaskRow(
                instance_id=instance_id, node_id=node.id, task_id=task.id,
                created_at=datetime.now()))
            s.commit()
        finally:
            s.close()
        return task.id

    def _step_has_task(self, instance_id: int, node_id: Optional[int]) -> bool:
        if node_id is None:
            return False
        from ..infrastructure.models import WorkflowStepTaskRow
        s = self.db.session()
        try:
            return s.query(WorkflowStepTaskRow).filter(
                WorkflowStepTaskRow.instance_id == instance_id,
                WorkflowStepTaskRow.node_id == node_id).count() > 0
        finally:
            s.close()

    def _set_current_node(self, instance_id: int, node_id: Optional[int]) -> None:
        from ..infrastructure.models import WorkflowInstanceRow
        s = self.db.session()
        try:
            r = s.query(WorkflowInstanceRow).filter(
                WorkflowInstanceRow.id == instance_id).first()
            if r is not None:
                r.current_node_id = node_id
                s.commit()
        finally:
            s.close()

    def _finish_instance(self, instance_id: int) -> None:
        from ..infrastructure.models import WorkflowInstanceRow
        s = self.db.session()
        try:
            r = s.query(WorkflowInstanceRow).filter(
                WorkflowInstanceRow.id == instance_id).first()
            if r is not None:
                r.status = WorkflowStatus.DONE.value
                r.finished_at = datetime.now()
                s.commit()
        finally:
            s.close()

    def _task_done_map(self, task_ids: List[int]) -> Dict[int, bool]:
        if not task_ids or self.tasks is None:
            return {}
        try:
            out: Dict[int, bool] = {}
            for tid in task_ids:
                t = self.tasks.get(tid)
                if t is not None:
                    out[tid] = getattr(t.status, "value", str(t.status)) == "done"
            return out
        except Exception:  # noqa: BLE001
            return {}

    def _note_title(self, note_id: int) -> Optional[str]:
        from ..infrastructure.models import NoteRow
        s = self.db.session()
        try:
            r = s.query(NoteRow).filter(NoteRow.id == note_id).first()
            return r.title if r is not None else None
        finally:
            s.close()

    def _to_template(self, row) -> WorkflowTemplate:
        from ..infrastructure.models import WorkflowNodeRow
        s = self.db.session()
        try:
            nodes = (s.query(WorkflowNodeRow)
                     .filter(WorkflowNodeRow.template_id == row.id)
                     .order_by(WorkflowNodeRow.order_index,
                               WorkflowNodeRow.id).all())
            tpl = WorkflowTemplate(
                id=row.id, name=row.name or "", description=row.description or "",
                start_policy=row.start_policy or StartPolicy.FIRST.value,
                created_at=row.created_at, updated_at=row.updated_at)
            tpl.nodes = [WorkflowNode(
                id=n.id, template_id=n.template_id, title=n.title or "",
                detail=n.detail or "", order_index=n.order_index or 0,
                note_id=n.note_id, action_kind=n.action_kind or StepAction.NONE.value,
                action_value=n.action_value or "", condition=n.condition or "",
                branch_node_id=n.branch_node_id,
                pos_x=n.pos_x, pos_y=n.pos_y) for n in nodes]
            return tpl
        finally:
            s.close()

    def _emit_templates_changed(self):
        try:
            if self.bus is not None:
                self.bus.workflow_template_changed.emit()
        except Exception:  # noqa: BLE001
            pass

    def _emit_instances_changed(self):
        try:
            if self.bus is not None:
                self.bus.workflow_instance_changed.emit()
        except Exception:  # noqa: BLE001
            pass