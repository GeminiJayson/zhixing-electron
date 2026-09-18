# -*- coding: utf-8 -*-
"""领域事件总线：Model 层发事件，Qt Model / Controller 订阅做局部刷新。"""
from PySide6.QtCore import QObject, Signal


class EventBus(QObject):
    """全局领域事件通道（单例，挂 AppContext）。

    只承载「什么变了」，不承载数据本身；数据一律经 Service/Model 查询。

    结构类信号 op 取值（D3 扩展载荷）：
    - note_structure_changed(change_id, op): op ∈ note_created/note_deleted/note_restored/
      note_purged（change_id=note_id）、folder_created/folder_deleted/folder_renamed/
      folder_moved（change_id=folder_id）、note_imported（change_id=0 批量导入）。
    - task_structure_changed(change_id, op): op ∈ task_created/task_moved/task_deleted/
      task_restored/task_purged/task_reparented/task_reordered/task_cloned（change_id=task_id）、
      task_batch/task_roll（change_id=0）、list_created/list_deleted/list_renamed（change_id=list_id）。
    - flash_changed(flash_id, reason): reason ∈ added/updated/archived/deleted/restored/
      converted/merged（change_id=flash_id）。
    """

    task_changed = Signal(int, str)          # task_id, reason(created/updated/completed/deleted/moved)
    # D3：结构类信号带 id 载荷，支持图谱精确增量局部刷新（op 取值见下方注释）。
    task_structure_changed = Signal(int, str)  # change_id(task_id/list_id), op
    note_changed = Signal(int, str)          # note_id, reason
    note_structure_changed = Signal(int, str)  # change_id(note_id/folder_id), op
    note_links_changed = Signal(int)         # note_id（其出链/反链集合变化）
    flash_changed = Signal(int, str)         # flash_id, reason
    tag_changed = Signal()
    pomodoro_state = Signal(str, int, int)   # state(idle/focus/break), remain_seconds, total_seconds
    pomodoro_finished = Signal(int, int)     # minutes, task_id(-1 无)
    settings_changed = Signal(str)           # key
    theme_changed = Signal()
    capture_target_changed = Signal()
    backup_restored = Signal()
    # 图谱增量同步（观察者模式）：GraphService 订阅本总线，领域事件 → GraphDelta → 此信号，
    # GraphPage 据此做局部刷新（避免全图重绘）。
    graph_delta = Signal(object)             # GraphDelta
    # 工作流（v10）：模板定义变更 / 实例进度变更
    workflow_template_changed = Signal()
    workflow_instance_changed = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        try:  # 审计：所有领域事件记 DEBUG（只表名+标量，绝不含正文）
            from .logging_util import log_signal
            self.notifySignal.connect(lambda sig, *args: log_signal(sig.name, args))
        except Exception:  # noqa: BLE001
            pass
