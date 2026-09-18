# -*- coding: utf-8 -*-
"""工作流模块回归：模板 CRUD / 拓扑校验 / 实例化 / 步骤下发 / 任务回推。"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


def _make_app():
    from PySide6.QtWidgets import QApplication
    return QApplication.instance() or QApplication([])


class TestWorkflowDomain(unittest.TestCase):
    """领域层：顺序 / 分支 / 拓扑校验（纯 Python，无 Qt/DB）。"""

    def test_ordered_and_next_node(self):
        from zhixing.model.domain.entities import WorkflowNode, WorkflowTemplate
        tpl = WorkflowTemplate(name="T", nodes=[
            WorkflowNode(id=2, title="第二", order_index=1),
            WorkflowNode(id=1, title="第一", order_index=0),
            WorkflowNode(id=3, title="第三", order_index=2),
        ])
        self.assertEqual([n.title for n in tpl.ordered_nodes()], ["第一", "第二", "第三"])
        self.assertEqual(tpl.first_node().title, "第一")
        self.assertEqual(tpl.next_node(1).title, "第二")
        self.assertEqual(tpl.next_node(2).title, "第三")
        self.assertIsNone(tpl.next_node(3), "最后一步没有下一步")
        self.assertEqual(tpl.next_node(None).title, "第一", "空游标应回到首步")

    def test_branch_takes_precedence(self):
        from zhixing.model.domain.entities import WorkflowNode, WorkflowTemplate
        tpl = WorkflowTemplate(name="T", nodes=[
            WorkflowNode(id=1, title="A", order_index=0, branch_node_id=3),
            WorkflowNode(id=2, title="B", order_index=1),
            WorkflowNode(id=3, title="C", order_index=2),
        ])
        self.assertEqual(tpl.next_node(1).title, "C", "有条件分支时优先走分支")
        self.assertEqual(tpl.next_node(2).title, "C", "无分支则按顺序")

    def test_validate_rejects_empty_and_cycles(self):
        from zhixing.model.domain.entities import WorkflowNode, WorkflowTemplate
        self.assertTrue(WorkflowTemplate(name="空").validate(), "空模板应报错")
        bad = WorkflowTemplate(name="坏", nodes=[
            WorkflowNode(id=1, title="A", order_index=0, branch_node_id=2),
            WorkflowNode(id=2, title="B", order_index=1, branch_node_id=1),
        ])
        problems = bad.validate()
        self.assertTrue(any("环" in p for p in problems), f"应检测到分支环：{problems}")
        self_touch = WorkflowTemplate(name="自环", nodes=[
            WorkflowNode(id=1, title="A", branch_node_id=1)])
        self.assertTrue(any("自己" in p for p in self_touch.validate()))
        missing = WorkflowTemplate(name="悬空分支", nodes=[
            WorkflowNode(id=1, title="A", branch_node_id=999)])
        self.assertTrue(any("不存在" in p for p in missing.validate()))


class TestWorkflowService(unittest.TestCase):
    """服务层：模板持久化 / 实例化 / 步骤任务 / 完成回推（内存库）。"""

    def setUp(self):
        _make_app()
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        from zhixing.core.context import AppContext
        self.ctx = AppContext(db_path=str(Path(tempfile.mkdtemp()) / "wf.db"))
        self.ws = self.ctx.workflow_service
        self.ts = self.ctx.task_service
        self.ns = self.ctx.note_service

    def tearDown(self):
        try:
            self.ctx.db.engine.dispose()
        except Exception:
            pass

    def _template(self, n=3):
        from zhixing.model.domain.entities import WorkflowNode, WorkflowTemplate
        return WorkflowTemplate(name="测试流程", nodes=[
            WorkflowNode(title=f"步骤{i + 1}", order_index=i) for i in range(n)])

    def test_save_and_load_template(self):
        saved = self.ws.save_template(self._template(3))
        self.assertIsNotNone(saved)
        self.assertEqual(len(saved.nodes), 3)
        again = self.ws.get_template(saved.id)
        self.assertEqual([n.title for n in again.ordered_nodes()],
                         ["步骤1", "步骤2", "步骤3"])

    def test_invalid_template_is_rejected(self):
        from zhixing.model.domain.entities import WorkflowTemplate
        self.assertIsNone(self.ws.save_template(WorkflowTemplate(name="空")))
        self.assertEqual(self.ws.list_templates(), [], "无效模板不应入库")

    def test_template_branch_remap_on_save(self):
        """分支引用须在保存时重映射到新节点 id（节点是整体替换的）。"""
        from zhixing.model.domain.entities import WorkflowNode, WorkflowTemplate
        tpl = WorkflowTemplate(name="分支流", nodes=[
            WorkflowNode(id=-1, title="A", order_index=0, branch_node_id=-2),
            WorkflowNode(id=-2, title="B", order_index=1),
            WorkflowNode(id=-3, title="C", order_index=2),
        ])
        saved = self.ws.save_template(tpl)
        self.assertIsNotNone(saved)
        a = saved.ordered_nodes()[0]
        b = saved.ordered_nodes()[1]
        self.assertEqual(a.branch_node_id, b.id, "分支应指向重映射后的 B 节点 id")

    def test_instantiate_first_policy_spawns_only_first_step(self):
        tpl = self.ws.save_template(self._template(3))
        inst = self.ws.instantiate(tpl.id)
        self.assertIsNotNone(inst)
        self.assertEqual(inst.status, "running")
        self.assertEqual(len(inst.steps), 1, "first 策略只下发第一步")
        self.assertIsNotNone(inst.steps[0].task_id)

    def test_instantiate_all_policy_spawns_every_step(self):
        from zhixing.model.domain.entities import StartPolicy
        tpl = self.ws.save_template(self._template(3))
        inst = self.ws.instantiate(tpl.id, policy=StartPolicy.ALL.value)
        self.assertEqual(len(inst.steps), 3)

    def test_step_task_is_real_task_with_sop_link(self):
        """步骤下发须是真实任务；绑定的 SOP 文档写进任务备注的 [[链接]]。"""
        from zhixing.model.domain.entities import WorkflowNode, WorkflowTemplate
        note = self.ns.create(title="操作手册", content_md="# 手册")
        tpl = WorkflowTemplate(name="带文档", nodes=[WorkflowNode(
            title="照着手册做", order_index=0, note_id=note.id)])
        saved = self.ws.save_template(tpl)
        inst = self.ws.instantiate(saved.id)
        task = self.ts.get(inst.steps[0].task_id)
        self.assertIsNotNone(task)
        self.assertIn("操作手册", task.title + task.notes_md)
        self.assertIn("[[操作手册]]", task.notes_md, "SOP 文档应以 [[链接]] 落进备注")

    def test_step_tasks_are_children_of_origin_task(self):
        """任务启动的实例：步骤任务应挂在来源任务下（层级可见）。"""
        tpl = self.ws.save_template(self._template(2))
        origin = self.ts.create("启动流程的任务")
        inst = self.ws.instantiate(tpl.id, origin_task_id=origin.id)
        step_task = self.ts.get(inst.steps[0].task_id)
        self.assertEqual(step_task.parent_id, origin.id, "步骤应挂为来源任务的子任务")

    def test_complete_step_advances_instance(self):
        """任务 → 流程回推：完成步骤任务应推进实例到下一节点。"""
        from zhixing.model.domain.entities import TaskStatus
        tpl = self.ws.save_template(self._template(3))
        inst = self.ws.instantiate(tpl.id)
        first_task = inst.steps[0].task_id
        self.ts.set_status(first_task, TaskStatus.DONE)
        self.assertTrue(self.ws.complete_step_task(first_task), "应成功推进")
        after = self.ws.get_instance(inst.id)
        self.assertEqual(len(after.steps), 2, "第二步骤任务应被自动下发")
        self.assertEqual(after.progress_text, "1/2")

    def test_finish_instance_when_last_step_done(self):
        """走完全部步骤后实例应自动标记完成。"""
        from zhixing.model.domain.entities import TaskStatus
        tpl = self.ws.save_template(self._template(2))
        inst = self.ws.instantiate(tpl.id)
        for _ in range(5):
            cur = self.ws.get_instance(inst.id)
            if cur.status != "running":
                break
            pending = [s for s in cur.steps if not s.done]
            if not pending:
                break
            self.ts.set_status(pending[0].task_id, TaskStatus.DONE)
            self.ws.complete_step_task(pending[0].task_id)
        final = self.ws.get_instance(inst.id)
        self.assertEqual(final.status, "done")
        self.assertEqual(final.progress_text, "2/2")

    def test_complete_non_step_task_is_noop(self):
        """非步骤任务完成不应影响任何流程。"""
        plain = self.ts.create("普通任务")
        self.assertFalse(self.ws.complete_step_task(plain.id))

    def test_abort_instance(self):
        tpl = self.ws.save_template(self._template(2))
        inst = self.ws.instantiate(tpl.id)
        self.assertTrue(self.ws.abort_instance(inst.id))
        self.assertEqual(self.ws.get_instance(inst.id).status, "aborted")

    def test_delete_template_blocked_when_running(self):
        tpl = self.ws.save_template(self._template(2))
        self.ws.instantiate(tpl.id)
        self.assertFalse(self.ws.delete_template(tpl.id), "有运行中实例应拒绝删除")
        self.ws.abort_instance(self.ws.list_instances("running")[0].id)
        self.assertTrue(self.ws.delete_template(tpl.id), "终止后可删除")

    def test_duplicate_template_is_independent(self):
        tpl = self.ws.save_template(self._template(2))
        clone = self.ws.duplicate_template(tpl.id)
        self.assertIsNotNone(clone)
        self.assertNotEqual(clone.id, tpl.id)
        self.assertEqual(len(clone.nodes), 2)
        self.assertTrue(all(n.id != o.id for n, o in zip(clone.nodes, tpl.nodes)))

    def test_instances_of_task(self):
        tpl = self.ws.save_template(self._template(2))
        origin = self.ts.create("来源")
        self.ws.instantiate(tpl.id, origin_task_id=origin.id)
        got = self.ws.instances_of_task(origin.id)
        self.assertEqual(len(got), 1)
        self.assertEqual(self.ws.instances_of_task(-999), [])

    def test_node_position_persistence(self):
        """节点画布坐标 pos_x/pos_y 须随模板持久化（布局稳定的数据基础）。"""
        from zhixing.model.domain.entities import WorkflowNode, WorkflowTemplate
        tpl = WorkflowTemplate(name="坐标", nodes=[
            WorkflowNode(title="X", order_index=0, pos_x=120.5, pos_y=240.25),
            WorkflowNode(title="Y", order_index=1, pos_x=320.0, pos_y=480.0),
        ])
        saved = self.ws.save_template(tpl)
        again = self.ws.get_template(saved.id)
        nodes = again.ordered_nodes()
        self.assertEqual((nodes[0].pos_x, nodes[0].pos_y), (120.5, 240.25))
        self.assertEqual((nodes[1].pos_x, nodes[1].pos_y), (320.0, 480.0))

    def test_branch_target_identity(self):
        """分支 target 判定：A.branch=B 时，next(A)==B 且 B 是「分支目标」。"""
        from zhixing.model.domain.entities import WorkflowNode, WorkflowTemplate
        tpl = WorkflowTemplate(name="分支", nodes=[
            WorkflowNode(title="A", order_index=0),
            WorkflowNode(title="B", order_index=1),
            WorkflowNode(title="C", order_index=2),
        ])
        a, b, c = tpl.ordered_nodes()
        # 先保存拿到真实 id，再设分支（对应「选中节点 → 设为分支」的真实流程）
        tpl = self.ws.save_template(tpl)
        a, b, c = tpl.ordered_nodes()
        a.branch_node_id = b.id
        saved = self.ws.save_template(tpl)
        sa, sb, sc = saved.ordered_nodes()
        self.assertEqual(sa.branch_node_id, sb.id, "分支引用应指向 B 的新 id")
        self.assertEqual(saved.next_node(sa.id).title, "B", "条件满足走分支")
        # B 是「某节点的分支目标」
        self.assertTrue(any(n.branch_node_id == sb.id for n in saved.ordered_nodes()))

    def test_silent_save_no_broadcast(self):
        """silent 保存不应广播 workflow_template_changed（拖动坐标静默落库）。"""
        fired = []
        try:
            self.ctx.bus.workflow_template_changed.connect(lambda: fired.append(1))
        except Exception:
            pass
        tpl = self.ws.save_template(self._template(2))
        fired.clear()
        tpl.nodes[0].pos_x = 99.0
        self.ws.save_template(tpl, silent=True)
        self.assertEqual(fired, [], "silent 保存不应广播模板变更")
        # 非 silent 才广播
        tpl.nodes[0].pos_x = 88.0
        self.ws.save_template(tpl)
        self.assertEqual(len(fired), 1, "非 silent 保存应广播一次")


class TestStepActions(unittest.TestCase):
    """步骤动作：描述 / 风险判定 / 命令执行安全边界。"""

    def setUp(self):
        from zhixing.model.application.workflow_service import WorkflowService
        self.ws = WorkflowService.__new__(WorkflowService)   # 仅用纯函数

    def test_risky_action_detection(self):
        from zhixing.model.domain.entities import WorkflowNode
        self.assertTrue(self.ws.is_risky_action(
            WorkflowNode(action_kind="run_command")))
        for kind in ("none", "open_note", "open_url"):
            self.assertFalse(self.ws.is_risky_action(WorkflowNode(action_kind=kind)), kind)

    def test_describe_action(self):
        from zhixing.model.domain.entities import WorkflowNode
        d = self.ws.describe_action(WorkflowNode(
            action_kind="open_url", action_value="https://example.com"))
        self.assertIn("example.com", d)
        self.assertIn("运行命令", self.ws.describe_action(
            WorkflowNode(action_kind="run_command", action_value="echo hi")))

    def test_run_command_rejects_empty(self):
        from zhixing.model.domain.entities import WorkflowNode
        ok, msg = self.ws.run_step_action(WorkflowNode(
            action_kind="run_command", action_value="   "))
        self.assertFalse(ok)
        self.assertIn("未填写", msg)

    def test_run_command_reports_missing_binary(self):
        from zhixing.model.domain.entities import WorkflowNode
        ok, msg = self.ws.run_step_action(WorkflowNode(
            action_kind="run_command", action_value="no_such_binary_xyz"))
        self.assertFalse(ok)
        self.assertIn("找不到", msg)


if __name__ == "__main__":
    unittest.main(verbosity=2)