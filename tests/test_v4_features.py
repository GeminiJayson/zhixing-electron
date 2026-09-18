# -*- coding: utf-8 -*-
"""v4 功能回归：版本历史 / 模板 / 孤儿笔记 / 回收站 / 成就 / 任务入图 / 排序移动。"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from zhixing.core.context import AppContext


class TestV4Features(unittest.TestCase):
    def setUp(self):
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()
        self.ctx = AppContext()

    def tearDown(self):
        try:
            self.ctx.db.engine.dispose()
        except Exception:
            pass

    def test_note_revision_history(self):
        n = self.ctx.note_service.create(title="t", content_md="# v1")
        self.ctx.note_service.save(n.id, content_md="# v2")
        self.ctx.note_service.save(n.id, content_md="# v3")
        revs = self.ctx.note_service.revisions(n.id)
        self.assertEqual([r["content_md"] for r in revs], ["# v2", "# v1"])
        self.ctx.note_service.restore_revision(n.id, revs[1]["id"])
        self.assertEqual(self.ctx.note_service.get(n.id).content_md, "# v1")

    def test_note_template(self):
        t = self.ctx.note_service.create_from_template("每日笔记")
        self.assertIsNotNone(t)
        self.assertTrue((t.content_md or "").startswith("# 每日笔记"))

    def test_orphan_notes(self):
        n = self.ctx.note_service.create(title="孤立", content_md="无链接")
        self.assertIn(n.id, [x.id for x in self.ctx.note_service.orphans()])

    def test_trash_restore_purge(self):
        tid = self.ctx.task_service.create("回收").id
        self.ctx.task_service.delete(tid)
        self.assertEqual(len(self.ctx.task_service.trash()), 1)
        self.ctx.task_service.restore(tid)
        self.assertEqual(len(self.ctx.task_service.trash()), 0)

        nid = self.ctx.note_service.create(title="n").id
        self.ctx.note_service.delete(nid)
        self.assertEqual(len(self.ctx.note_service.trash()), 1)
        self.ctx.note_service.purge(nid)
        self.assertEqual(len(self.ctx.note_service.trash()), 0)

        fid = self.ctx.flash_service.add("闪念").id
        self.ctx.flash_service.delete(fid)
        self.assertEqual(len(self.ctx.flash_service.trash()), 1)
        self.ctx.flash_service.restore(fid)
        self.assertEqual(len(self.ctx.flash_service.trash()), 0)

    def test_purge_parent_task_with_subtasks(self):
        """回收站清空/到期清理：硬删父任务前先解除子任务归属，避免外键约束失败。"""
        parent = self.ctx.task_service.create("父任务").id
        child = self.ctx.task_service.add_subtask(parent, "子任务").id
        # 软删父（cascade 一并软删子）
        self.ctx.task_service.delete(parent)
        trash_ids = {t.id for t in self.ctx.task_service.trash()}
        self.assertIn(parent, trash_ids)
        self.assertIn(child, trash_ids)
        # 硬删父不应抛 FOREIGN KEY constraint failed；子仍在回收站且 parent_id 已置空
        self.ctx.task_service.purge(parent)
        remaining = {t.id: t for t in self.ctx.task_service.trash()}
        self.assertNotIn(parent, remaining)
        self.assertIn(child, remaining)
        self.assertIsNone(remaining[child].parent_id)
        # 再清子应成功（回收站清空闭环）
        self.ctx.task_service.purge(child)
        self.assertEqual(self.ctx.task_service.trash(), [])

    def test_achievements(self):
        items = self.ctx.review_service.achievements()
        self.assertTrue(any(x["name"] == "初试锋芒" for x in items))
        self.assertTrue(all("unlocked" in x for x in items))

    def test_graph_task_nodes(self):
        n = self.ctx.note_service.create(title="关联")
        t = self.ctx.task_service.create("任务")
        self.ctx.task_service.attach_note(t.id, n.id)
        g = self.ctx.graph_service.build(include_tasks=True)
        self.assertTrue(any(x.kind == "task" for x in g.nodes))

    def test_move_relative(self):
        a = self.ctx.task_service.create("A")
        b = self.ctx.task_service.create("B")
        self.ctx.task_service.move_relative(b.id, -1)
        roots = self.ctx.task_service.all_tree()
        self.assertEqual(roots[0].id, b.id)


if __name__ == "__main__":
    unittest.main()
