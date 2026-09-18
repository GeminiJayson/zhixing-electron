# -*- coding: utf-8 -*-
"""AppContext：依赖装配根。一次装配，处处引用。"""
from typing import Optional

from .event_bus import EventBus
from .errors import DatabaseLockedError
from ..model.infrastructure.backup import BackupService
from ..model.infrastructure.db import Database
from ..model.infrastructure.exporter import Exporter, Importer
from ..model.infrastructure.fts import FTSService
from ..model.infrastructure.repositories import (
    FlashRepository, ListFolderRepository, NoteLinkRepository, NoteRepository,
    PomodoroRepository, TagRepository, TaskRepository,
)
from ..model.application.flash_service import FlashService
from ..model.application.graph_service import GraphService
from ..model.application.note_service import NoteService
from ..model.application.review_service import ReviewService
from ..model.application.search_service import SearchService
from ..model.application.settings import SettingsService
from ..model.application.task_service import TaskService
from ..model.application.workflow_service import WorkflowService


class AppContext:
    """组合根：按依赖顺序装配 Model 层（QApplication 存在后创建）。"""

    def __init__(self, db_path: Optional[str] = None):
        try:
            self.db = Database(db_path) if db_path else Database()
        except DatabaseLockedError:
            raise
        # 迁移失败不崩入口（#12）：Database 构造期捕获 RuntimeError 并记录，
        # 这里透传为只读原因，AppController.startup 据此显示只读横幅。
        self.readonly_reason = getattr(self.db, "migrate_error", None)
        self.bus = EventBus()
        self.theme_engine = None      # 由 __main__ 在 QApplication 后注入
        self.hotkey_status: dict = {}  # 由 AppController 填充
        self.fts = FTSService(self.db)

        self.task_repo = TaskRepository(self.db, self.fts)
        self.note_repo = NoteRepository(self.db, self.fts)
        self.note_link_repo = NoteLinkRepository(self.db)
        self.flash_repo = FlashRepository(self.db, self.fts)
        self.tag_repo = TagRepository(self.db)
        self.folder_repo = ListFolderRepository(self.db)
        self.pomodoro_repo = PomodoroRepository(self.db)

        self.settings = SettingsService(self.db, self.bus)
        self.task_service = TaskService(self.db, self.bus, self.task_repo,
                                        self.folder_repo, self.tag_repo)
        self.note_service = NoteService(self.db, self.bus, self.note_repo,
                                        self.note_link_repo, self.tag_repo)
        self.flash_service = FlashService(self.db, self.bus, self.flash_repo, self.tag_repo)
        # 工作流：注入 task_service 以便实例化时把步骤下发为真实任务（双向绑定）
        self.workflow_service = WorkflowService(self.db, self.bus,
                                                task_service=self.task_service)
        self.graph_service = GraphService(self.db, self.note_service)
        self.search_service = SearchService(self.db, self.fts, self.task_repo,
                                            self.note_repo, self.flash_repo, self.tag_repo,
                                            folders=self.folder_repo)
        self.review_service = ReviewService(self.db, self.task_repo, self.flash_repo)
        self.backup = BackupService(self.db)
        self.exporter = Exporter(self.db)
        self.importer = Importer(self.db)

        # 只读模式（迁移失败）不写默认设置，避免在未迁移成功的库上落盘。
        if not self.readonly_reason:
            self.settings.ensure_defaults()

    def seed_if_empty(self):
        """首次启动：默认分组/列表与欢迎笔记。"""
        from ..model.infrastructure.models import TaskRow, NoteRow
        from ..model.domain.entities import FolderKind, Priority
        s = self.db.session()
        try:
            has_tasks = s.query(TaskRow).count() > 0
            has_notes = s.query(NoteRow).count() > 0
        finally:
            s.close()
        if not has_tasks:
            self.task_service.create_folder("工作", kind=FolderKind.GROUP)
            self.task_service.create_folder("生活", kind=FolderKind.GROUP)
            lid = self.task_service.create_folder("我的清单")
            self.task_service.create("欢迎使用知行：试试 Ctrl+Alt+N 快速添加任务",
                                     list_id=lid.id, priority=Priority.MID)
            self.task_service.create("在笔记里输入 [[ 会弹出链接补全", list_id=lid.id)
        if not has_notes:
            self.note_service.create(
                title="开始使用「知行」",
                content_md=(
                    "# 开始使用「知行」\n\n"
                    "**任务与知识，一体两面。**\n\n"
                    "- 输入 `[[` 可以链接到其他笔记，比如 [[开始使用「知行」]]\n"
                    "- 按 `Ctrl+K` 打开命令面板，搜索一切\n"
                    "- 按 `Ctrl+Alt+N` 快速捕获任务（支持 `!2 @我的清单 #标签 明天` 语法糖）\n"
                    "- 按 `Ctrl+Shift+S` 在任何应用里划词捕获闪念\n"
                    "- 打开「图谱」看你的知识网络生长\n\n"
                    "> 数据全部保存在本机，随时可在设置中备份导出。\n"),
            )
