# -*- coding: utf-8 -*-
"""图谱数据层回归：两类边语义、归属 DAG 环路检测、引用边规则、任务层级、增量同步。"""
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


class TestGraphDataLayer(unittest.TestCase):
    def setUp(self):
        _make_app()
        os.environ["ZHIXING_HOME"] = tempfile.mkdtemp()

        from zhixing.core.event_bus import EventBus
        from zhixing.model.application.flash_service import FlashService
        from zhixing.model.application.graph_service import GraphService
        from zhixing.model.application.note_service import NoteService
        from zhixing.model.application.task_service import TaskService
        from zhixing.model.infrastructure.db import Database
        from zhixing.model.infrastructure.fts import FTSService
        from zhixing.model.infrastructure.repositories import (
            FlashRepository, ListFolderRepository, NoteLinkRepository,
            NoteRepository, TagRepository, TaskRepository,
        )

        self.db = Database()
        self.bus = EventBus()
        self.fts = FTSService(self.db)
        note_repo = NoteRepository(self.db, self.fts)
        link_repo = NoteLinkRepository(self.db)
        flash_repo = FlashRepository(self.db, self.fts)
        tag_repo = TagRepository(self.db)
        self.note_service = NoteService(self.db, self.bus, note_repo, link_repo, tag_repo)
        self.flash_service = FlashService(self.db, self.bus, flash_repo, tag_repo)
        self.task_service = TaskService(self.db, self.bus, TaskRepository(self.db, self.fts),
                                        ListFolderRepository(self.db), tag_repo, notes=note_repo)
        self.graph = GraphService(self.db, self.note_service)

    def tearDown(self):
        try:
            self.db.engine.dispose()
        except Exception:
            pass

    # ---------- 两类边语义 ----------
    def test_edge_kinds_classify_ownership_and_reference(self):
        from zhixing.model.application.graph_service import EDGE_OWNERSHIP, EDGE_REFERENCE
        folder = self.note_service.create_folder("F")
        a = self.note_service.create(title="A", folder_id=folder.id)
        b = self.note_service.create(title="B")
        self.graph.link_notes(a.id, b.id)
        task = self.task_service.create("T")
        self.task_service.attach_note(task.id, a.id)
        data = self.graph.build(include_tasks=True)
        folder_id = next(n.id for n in data.nodes if n.kind == "folder")
        task_id = next(n.id for n in data.nodes if n.kind == "task")
        # note -> note 引用
        self.assertEqual(data.edge_kinds.get((a.id, b.id)), EDGE_REFERENCE)
        # folder -> note 归属
        self.assertEqual(data.edge_kinds.get((folder_id, a.id)), EDGE_OWNERSHIP)
        # task -> note 归属
        self.assertEqual(data.edge_kinds.get((task_id, a.id)), EDGE_OWNERSHIP)

    def test_reference_edges_exclude_folder_and_task(self):
        from zhixing.model.application.graph_service import EDGE_REFERENCE
        folder = self.note_service.create_folder("F")
        a = self.note_service.create(title="A", folder_id=folder.id)
        b = self.note_service.create(title="B")
        self.graph.link_notes(a.id, b.id)
        task = self.task_service.create("T")
        self.task_service.attach_note(task.id, a.id)
        data = self.graph.build(include_tasks=True)
        folder_ids = {n.id for n in data.nodes if n.kind == "folder"}
        task_ids = {n.id for n in data.nodes if n.kind == "task"}
        ref_count = 0
        for (src, dst), kind in data.edge_kinds.items():
            if kind == EDGE_REFERENCE:
                ref_count += 1
                self.assertNotIn(src, folder_ids | task_ids,
                                 "引用边不应以文件夹/任务为源")
                self.assertNotIn(dst, folder_ids | task_ids,
                                 "引用边不应以文件夹/任务为目标")
        self.assertGreaterEqual(ref_count, 1, "应至少存在一条 note->note 引用边")

    def test_connection_allowed_matrix(self):
        from zhixing.model.application.graph_service import (
            EDGE_EITHER, EDGE_OWNERSHIP, EDGE_REFERENCE, GraphService,
        )
        self.assertEqual(GraphService.connection_allowed("note", "note"), EDGE_REFERENCE)
        self.assertEqual(GraphService.connection_allowed("folder", "note"), EDGE_OWNERSHIP)
        self.assertEqual(GraphService.connection_allowed("folder", "folder"), EDGE_OWNERSHIP)
        # v9：任务↔笔记「归属 + 引用」两种关系都合法，矩阵返回 either；
        # 最终边类由拖拽入口模式决定（见 resolve_edge_kind）。
        self.assertEqual(GraphService.connection_allowed("task", "note"), EDGE_EITHER)
        self.assertEqual(GraphService.connection_allowed("note", "task"), EDGE_EITHER)
        self.assertEqual(GraphService.resolve_edge_kind("task", "note", "ownership"),
                         EDGE_OWNERSHIP, "归属模式应落到归属边")
        self.assertEqual(GraphService.resolve_edge_kind("task", "note", "reference"),
                         EDGE_REFERENCE, "引用模式应落到引用边")
        self.assertEqual(GraphService.resolve_edge_kind("task", "note"), EDGE_OWNERSHIP,
                         "未给模式时默认归属（保持旧拖拽语义）")
        self.assertEqual(GraphService.connection_allowed("task", "task"), EDGE_OWNERSHIP)
        self.assertIsNone(GraphService.connection_allowed("folder", "task"))
        self.assertIsNone(GraphService.connection_allowed("task", "folder"))
        self.assertIsNone(GraphService.connection_allowed("flash", "note"))
        self.assertIsNone(GraphService.connection_allowed("note", "folder"))

    # ---------- v9：任务↔笔记 归属 + 引用 并存 ----------
    def test_task_note_reference_coexists_with_ownership(self):
        """任务↔笔记可同时有归属与引用；图里只画一条且呈引用（避免重叠）。"""
        from zhixing.model.application.graph_service import (
            EDGE_OWNERSHIP, EDGE_REFERENCE, _TASK_ID_OFFSET,
        )
        gs = self.graph
        note = self.note_service.create(title="引用测试笔记")
        task = self.task_service.create("引用测试任务")
        tid = task.id + _TASK_ID_OFFSET

        # 仅引用 -> 虚线
        self.assertTrue(gs.link_task_note_ref(task.id, note.id))
        d = gs.build(include_tasks=True)
        self.assertIn([tid, note.id], d.edges)
        self.assertEqual(d.edge_kinds.get((tid, note.id)), EDGE_REFERENCE)

        # 再建归属：两种关系并存，图中仍只有一条边且呈引用
        self.assertTrue(gs.attach_task_note(task.id, note.id))
        d = gs.build(include_tasks=True)
        self.assertEqual(d.edges.count([tid, note.id]), 1, "同对应只画一条边")
        self.assertEqual(d.edge_kinds.get((tid, note.id)), EDGE_REFERENCE)

        # 删引用后只剩归属 -> 实线
        self.assertTrue(gs.unlink_task_note_ref(task.id, note.id))
        d = gs.build(include_tasks=True)
        self.assertIn([tid, note.id], d.edges)
        self.assertEqual(d.edge_kinds.get((tid, note.id)), EDGE_OWNERSHIP)

        # 删归属后边消失
        self.assertTrue(gs.detach_task_note(task.id, note.id))
        d = gs.build(include_tasks=True)
        self.assertNotIn([tid, note.id], d.edges)

    def test_task_note_reference_links_are_idempotent(self):
        """重复建立引用幂等；删除不存在的引用返回 False。"""
        gs = self.graph
        note = self.note_service.create(title="幂等笔记")
        task = self.task_service.create("幂等任务")
        self.assertTrue(gs.link_task_note_ref(task.id, note.id))
        self.assertTrue(gs.link_task_note_ref(task.id, note.id), "重复建立应幂等成功")
        self.assertTrue(gs.unlink_task_note_ref(task.id, note.id))
        self.assertFalse(gs.unlink_task_note_ref(task.id, note.id),
                         "删除不存在的引用应返回 False")
        self.assertTrue(gs.link_task_note_ref(task.id, note.id))

    # ---------- 归属 DAG 环路检测 ----------
    def test_folder_ownership_cycle_broken(self):
        from zhixing.model.infrastructure.models import NoteFolderRow
        s = self.db.session()
        try:
            a = NoteFolderRow(name="A")
            b = NoteFolderRow(name="B")
            s.add_all([a, b])
            s.flush()
            a.parent_id = b.id
            b.parent_id = a.id
            s.commit()
            a_id, b_id = a.id, b.id
        finally:
            s.close()
        data = self.graph.build()
        by_ref = {n.ref_id: n.id for n in data.nodes if n.kind == "folder"}
        a_nid, b_nid = by_ref[a_id], by_ref[b_id]
        edges = {tuple(e) for e in data.edges}
        self.assertFalse((a_nid, b_nid) in edges and (b_nid, a_nid) in edges,
                         "A 属 B 且 B 属 A 的循环归属应被破环")
        self.assertTrue(data.cycle_edges, "破环时应记录被丢弃的归属边")

    def test_would_create_cycle_ancestor_chain(self):
        f1 = self.note_service.create_folder("Root")
        f2 = self.note_service.create_folder("Child", parent_id=f1.id)
        f3 = self.note_service.create_folder("Grand", parent_id=f2.id)
        data = self.graph.build()
        by_ref = {n.ref_id: n.id for n in data.nodes if n.kind == "folder"}
        nid1, nid3 = by_ref[f1.id], by_ref[f3.id]
        # 把 Root 挂到 Grand 下会成环（Root 是 Grand 的祖先）
        self.assertTrue(self.graph.would_create_cycle(nid1, nid3, kind="folder"))
        # 把 Grand 挂到 Root 下无环（原层级已如此）
        self.assertFalse(self.graph.would_create_cycle(nid3, nid1, kind="folder"))
        # 自环拒绝
        self.assertTrue(self.graph.would_create_cycle(nid1, nid1, kind="folder"))

    def test_task_ownership_cycle_broken(self):
        from zhixing.model.infrastructure.models import TaskRow
        s = self.db.session()
        try:
            a = TaskRow(title="A")
            b = TaskRow(title="B")
            s.add_all([a, b])
            s.flush()
            a.parent_id = b.id
            b.parent_id = a.id
            s.commit()
            a_id, b_id = a.id, b.id
        finally:
            s.close()
        # 让任务进入图谱：关联一张笔记
        note = self.note_service.create(title="N")
        from zhixing.model.infrastructure.models import TaskNoteLinkRow
        s = self.db.session()
        try:
            s.add(TaskNoteLinkRow(task_id=a_id, note_id=note.id))
            s.commit()
        finally:
            s.close()
        data = self.graph.build(include_tasks=True)
        task_nids = {n.ref_id: n.id for n in data.nodes if n.kind == "task"}
        a_nid, b_nid = task_nids[a_id], task_nids[b_id]
        edges = {tuple(e) for e in data.edges}
        self.assertFalse((a_nid, b_nid) in edges and (b_nid, a_nid) in edges,
                         "任务父子循环归属应被破环")

    # ---------- 任务父子层级边自动生成 ----------
    def test_task_hierarchy_edges_auto_computed(self):
        from zhixing.model.application.graph_service import EDGE_OWNERSHIP
        note = self.note_service.create(title="N")
        parent = self.task_service.create("父任务")
        child = self.task_service.create("子任务", parent_id=parent.id)
        self.task_service.attach_note(child.id, note.id)
        data = self.graph.build(include_tasks=True)
        by_ref = {n.ref_id: n.id for n in data.nodes if n.kind == "task"}
        p_nid, c_nid = by_ref[parent.id], by_ref[child.id]
        self.assertIn([p_nid, c_nid], [list(e) for e in data.edges],
                      "父→子任务层级边应由 task.parent_id 自动生成")
        self.assertEqual(data.edge_kinds.get((p_nid, c_nid)), EDGE_OWNERSHIP)
        self.assertIn([c_nid, note.id], [list(e) for e in data.edges],
                      "任务→笔记归属边应存在")

    # ---------- 观察者增量同步 ----------
    def test_delta_minimal_for_flash_add(self):
        self.note_service.create(title="A")
        self.graph.build(include_tasks=True)   # 建立缓存基线
        f = self.flash_service.add("闪念内容")
        delta = self.graph.apply_flash_changed()
        self.assertFalse(delta.full, "已有缓存时增量不应用 full 全量标记")
        added_flash = [n for n in delta.added_nodes if n.kind == "flash"]
        self.assertEqual([n.ref_id for n in added_flash], [f.id])
        self.assertEqual(delta.removed_node_ids, [])
        self.assertEqual(delta.added_edges, [])

    def test_delta_minimal_for_note_link(self):
        a = self.note_service.create(title="A")
        b = self.note_service.create(title="B")
        self.graph.build(include_tasks=True)   # 建立缓存基线
        self.graph.link_notes(a.id, b.id)      # 落 note_link（不直接改缓存）
        delta = self.graph.apply_note_links_changed(a.id)
        self.assertEqual(delta.added_edges, [[a.id, b.id]])
        self.assertEqual(delta.removed_edges, [])
        self.assertEqual(delta.added_nodes, [])

    def test_subscribe_emits_graph_delta(self):
        deltas = []
        self.graph.subscribe(self.bus)
        self.bus.graph_delta.connect(deltas.append)
        self.graph.build(include_tasks=True)
        n = self.note_service.create(title="B")   # note_structure_changed → graph_delta
        self.assertTrue(deltas, "订阅后笔记结构变化应发出 graph_delta")
        added_note_ids = [x.ref_id for d in deltas for x in d.added_nodes if x.kind == "note"]
        self.assertIn(n.id, added_note_ids)

    # ---------- G1：folder 拖拽改写归属（move_folder 环路校验） ----------
    def test_move_folder_rejects_cycle_and_moves(self):
        f1 = self.note_service.create_folder("Root")
        f2 = self.note_service.create_folder("Child", parent_id=f1.id)
        f3 = self.note_service.create_folder("Grand", parent_id=f2.id)
        # 挂到自己的子孙下 → 拒绝（否则成环）
        self.assertIsNone(self.note_service.move_folder(f1.id, f3.id))
        # 挂到自身 → 拒绝
        self.assertIsNone(self.note_service.move_folder(f1.id, f1.id))
        # 合法移动：Grand 移到 Root 下
        moved = self.note_service.move_folder(f3.id, f1.id)
        self.assertIsNotNone(moved)
        self.assertEqual(moved.parent_id, f1.id)
        # 移到根（None）合法
        moved2 = self.note_service.move_folder(f2.id, None)
        self.assertIsNotNone(moved2)
        self.assertIsNone(moved2.parent_id)

    def test_move_folder_rejects_unknown_target(self):
        f1 = self.note_service.create_folder("Root")
        self.assertIsNone(self.note_service.move_folder(f1.id, 999999))

    # ---------- D3：结构类信号带 id 载荷 ----------
    def test_structure_signal_payloads(self):
        notes, flashes, tasks = [], [], []
        self.bus.note_structure_changed.connect(lambda i, o: notes.append((i, o)))
        self.bus.flash_changed.connect(lambda i, r: flashes.append((i, r)))
        self.bus.task_structure_changed.connect(lambda i, o: tasks.append((i, o)))
        n = self.note_service.create(title="N")
        f = self.flash_service.add("闪念")
        t = self.task_service.create("T")
        self.assertIn((n.id, "note_created"), notes)
        self.assertIn((f.id, "added"), flashes)
        self.assertIn((t.id, "task_created"), tasks)

    # ---------- v0.15 P1-3：段落锚子节点 ----------
    def test_anchor_nodes_from_task_note_context(self):
        from zhixing.model.application.graph_service import EDGE_REFERENCE
        a = self.note_service.create(title="A", content_md="## 节\n\n关键段落内容。")
        task = self.task_service.create("看 A 的段落")
        self.task_service.attach_block(task.id, a.id, "fp:abcdef1234", "关键段落内容。")
        data = self.graph.build(include_tasks=True)
        anchors = [n for n in data.nodes if n.kind == "anchor"]
        self.assertEqual(len(anchors), 1, "存在 task_note_context 时应生成段落锚节点")
        anchor = anchors[0]
        self.assertEqual(anchor.ref_id, a.id)
        self.assertEqual(anchor.ref_task, task.id)
        self.assertEqual(anchor.block_key, "fp:abcdef1234")
        # note→anchor、task→anchor 均为引用虚线
        self.assertEqual(data.edge_kinds.get((a.id, anchor.id)), EDGE_REFERENCE)
        task_id = next(n.id for n in data.nodes if n.kind == "task")
        self.assertEqual(data.edge_kinds.get((task_id, anchor.id)), EDGE_REFERENCE)
        # 锚点 label 取引文首段
        self.assertIn("关键段落", anchor.label)

    def test_anchor_preview_lists_task(self):
        a = self.note_service.create(title="A", content_md="正文。")
        task = self.task_service.create("关联它的任务")
        self.task_service.attach_block(task.id, a.id, "fp:xxxx9999", "正文段落摘录")
        data = self.graph.build(include_tasks=True)
        anchor = next(n for n in data.nodes if n.kind == "anchor")
        preview = self.graph.preview_text(anchor)
        self.assertIn("关联它的任务", preview)
        self.assertIn("段落", preview)


if __name__ == "__main__":
    unittest.main(verbosity=2)
