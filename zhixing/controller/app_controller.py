# -*- coding: utf-8 -*-
"""AppController：装配 MVC、全局动作分发、主题/提醒/备份生命周期。

View 信号 → Service 调用的全部接线集中在此（Controller 薄，规则在 Service）。
"""
from datetime import date, datetime, timedelta

from ..core.logging_util import get_logger

log = get_logger("zhixing.ctrl")

# 「读取选中并速记」全局热键默认值（新增键，默认不占用既有 ctrl+shift+s / ctrl+alt+n）。
_SELECT_QUICK_HOTKEY_DEFAULT = "ctrl+shift+u"

from PySide6.QtCore import QEvent, QObject, QPoint, Qt, QTimer, Signal
from PySide6.QtGui import QClipboard, QColor, QCursor, QGuiApplication, QKeySequence, QPalette, QShortcut
from PySide6.QtWidgets import (QApplication, QFrame, QHBoxLayout, QVBoxLayout)

from ..core import settings_keys as K
from ..core.constants import (
    CONTROL_HEIGHT_MAX, CONTROL_HEIGHT_MIN, FONT_SIZE_MAX, FONT_SIZE_MIN,
)
from ..core.async_task import run_in_background
from ..model.domain.entities import FlashStatus, RepeatPeriod, TaskStatus
from ..model.application.note_service import (
    DEFAULT_NOTE_TITLE, NOTE_FORMAT_EXCEL, NOTE_FORMAT_LINK, NOTE_FORMAT_MARKDOWN,
    NOTE_FORMAT_WORD,
)
from ..model.infrastructure.hotkey import HotkeyManager
from ..model.infrastructure.selection import SelectionGrabber
from ..view.capture.capture_card import CaptureCard
from ..view.capture.quick_capture import QuickCaptureWindow
from ..view.components.command_palette import CommandPalette
from ..view.components.note_create_dialog import NoteCreateDialog
from ..view.shell.main_window import MainWindow
from ..view.widget.desktop_widget import WidgetWindow
from qfluent_core import ThemeManager as ThemeEngine
from ..view.kit import icons
from ..view.kit.motion import set_motion_enabled
from zhixing.view.kit.fluent_compat import QComboBox, QDateEdit, QLabel, QLineEdit, QPlainTextEdit, QPushButton, QSpinBox, QTextEdit
from zhixing.view.kit.fluent_compat import Action, InfoBar, InfoBarPosition, PushButton, RoundMenu


class AppController(QObject):
    def __init__(self, context, theme_engine: ThemeEngine):
        super().__init__()
        self.ctx = context
        self.bus = context.bus
        # F4-3：任务 notes_md 的 [[链接]] 解析需要 note 解析器（组合根接线，规则仍在 model/domain）
        context.task_service.notes = context.note_repo
        self.theme_engine = theme_engine
        self.hotkeys = HotkeyManager(self)
        self.grabber = SelectionGrabber(self)
        self.hotkey_status = context.hotkey_status  # 设置页直接读取

        # 装配框架桥接：把 zhixing 的主题真源与设置接给 qfluent_core。
        # 必须在任何框架窗口/组件构造之前 —— 之后框架读的就是同一个单例。
        from ..view.kit import fluent_bridge
        fluent_bridge.install(theme_engine, context.settings)

        # ---- 视图 ----
        self.main = MainWindow(context, theme_engine)
        self.palette = CommandPalette(self.main)
        self.palette.set_engine(context.search_service)
        self.quick_capture = QuickCaptureWindow()
        self.widget = WidgetWindow(context.task_service, context.settings)
        self._capture_card = None
        self._bg = []  # 后台 Worker 引用（启动自动备份等）
        self._undo = None                 # 最近一次可撤销动作 {kind,id,prev_status,title}
        self._capturing = False           # 划词捕获进行中（抑制剪贴板监听误报）
        self._clip_last = ""              # 剪贴板监听去重
        self._init_clipboard_monitor()
        # v0.15 P1-4: 深链——第二实例经本地 socket 转发来的待处理链接队列
        self._pending_deep_links: List[str] = []

        # ---- 命令注册 ----
        context.search_service.commands = [
            _cmd("切换深色主题", lambda: self._set_mode("dark")),
            _cmd("切换浅色主题", lambda: self._set_mode("light")),
            _cmd("显隐桌面浮窗", self._toggle_widget),
            _cmd("新建笔记", self._new_note),
            _cmd("打开图谱", lambda: self.main.switch_page(4)),
            _cmd("立即备份", self._backup_now),
            _cmd("开始番茄钟（25 分钟）", lambda: self._start_pomodoro(None)),
        ]

        self._wire()
        self._apply_theme()
        # 框架设置变化 -> 重渲染（控件高度/字号/圆角/材质都靠这条链路生效）
        from qfluent_core import UISettings
        UISettings.instance().changed.connect(self._on_ui_setting_changed)
        self._register_hotkeys()
        self._start_timers()
        self._start_deep_link_server()
        # v0.16 P0-2: 聚焦发光（输入框/主按钮外光晕）
        try:
            from PySide6.QtWidgets import QApplication
            app = QApplication.instance()
            if app is not None:
                app.installEventFilter(self)
        except Exception:  # noqa: BLE001
            pass

    # ================= 接线 =================
    def _wire(self):
        ctx = self.ctx

        # 今日页
        self.main.today_page.toggleRequested.connect(self._toggle_task)
        self.main.today_page.openTaskRequested.connect(self._open_task)
        self.main.today_page.noteOpenRequested.connect(self._show_note)
        self.main.today_page.quickAddRequested.connect(
            lambda text: ctx.task_service.quick_create(text))
        self.main.today_page.jumpRequested.connect(self._jump)
        self.main.today_page.deleteRequested.connect(self._delete_task)
        self.main.today_page.editPriorityRequested.connect(self._edit_priority)
        self.main.today_page.editTagsRequested.connect(self._edit_tags)
        self.main.today_page.addSubtaskRequested.connect(self._add_subtask)
        self.main.today_page.titleEditCommitted.connect(self._set_task_title)
        self.main.today_page.focusRequested.connect(self._start_pomodoro)

        # 任务页
        self.main.task_page.toggleRequested.connect(self._toggle_task)
        self.main.task_page.openTaskRequested.connect(self._open_task)
        self.main.task_page.selectGroupRequested.connect(self.main.task_page.set_focus_list)
        self.main.task_page.quickAddRequested.connect(
            lambda text, lid: ctx.task_service.quick_create(text, lid))
        self.main.task_page.noteOpenRequested.connect(lambda nid: self._show_note(nid))
        self.main.task_page.noteBlockOpenRequested.connect(
            lambda nid, bk: self._show_note(nid, bk))
        self.main.task_page.editor.focusRequested.connect(self._start_pomodoro)
        self.main.task_page.focusRequested.connect(self._start_pomodoro)

        # W17/F9-3：任务页悬浮删除统一走 controller 撤销链路（Toast + Ctrl+Z）。
        # 断开 task_page 内部直调 task_service.delete() 的 handler，改接到 _delete_task。
        try:
            self.main.task_page.delegate.deleteRequested.disconnect()
        except Exception:
            pass
        self.main.task_page.delegate.deleteRequested.connect(self._delete_task)

        # 收件箱
        self.main.inbox_page.openTaskRequested.connect(self._open_task)
        self.main.inbox_page.toggleRequested.connect(self._toggle_task)
        self.main.inbox_page.moveTaskRequested.connect(self._move_task)
        self.main.inbox_page.flashDeleted.connect(self._on_flash_deleted)

        # 笔记页
        self.main.note_page.noteSelected.connect(self._show_note)
        self.main.note_page.noteDeleted.connect(self._on_note_deleted)

        # 图谱
        self.main.graph_page.openNoteRequested.connect(self._show_note)
        self.main.graph_page.createNoteRequested.connect(
            lambda title: (ctx.note_service.create(title=title), self._show_note(0)))
        self.main.graph_page.flashOpenRequested.connect(self._open_flash)
        self.main.graph_page.linkRequested.connect(self._link_notes)
        self.main.graph_page.openTaskRequested.connect(self._open_task)
        self.main.graph_page.folderOpenRequested.connect(self._open_folder)
        self.main.graph_page.noteBlockOpenRequested.connect(
            lambda nid, bk: self._show_note(nid, bk))   # v0.15 P1-3

        # 设置页
        self.main.settings_page.themeChanged.connect(
            lambda pack, mode, accent: self._apply_theme())
        self.main.settings_page.restartWidgets.connect(self._restart_widget)
        self.main.settings_page.hotkeyRebindStartRequested.connect(self._suspend_hotkeys)
        self.main.settings_page.hotkeyRebindRequested.connect(self._rebind_hotkeys)

        # 数据库迁移失败只读横幅 + 恢复备份入口（#12）
        self.main.restoreBackupRequested.connect(self._restore_backup_flow)

        # 全局动作
        self.main.appActionRequested.connect(self._dispatch_action)

        # 快速捕获
        self.quick_capture.submitted.connect(self._quick_submit)

        # 浮窗
        self.widget.openMainRequested.connect(self.main._show_main)
        self.widget.toggleRequested.connect(self._toggle_task)
        self.widget.openRequested.connect(self._open_task)
        self.widget.quickAddRequested.connect(self._widget_quick_add)
        self.widget.deleteRequested.connect(self._delete_task)
        self.widget.focusRequested.connect(self._start_pomodoro)
        # 主窗口显隐 ↔ 浮窗显隐联动：主窗显示→隐藏浮窗；主窗隐藏→显示浮窗
        self.main.shown.connect(self._on_main_shown)
        self.main.hidden.connect(self._on_main_hidden)

        # 事件 → 视图刷新
        self.bus.task_changed.connect(self._on_task_changed)
        self.bus.task_structure_changed.connect(self._refresh_all_tasks)
        self.bus.note_changed.connect(lambda nid, r: self.main.today_page.set_recent_notes(
            ctx.note_service.recent(5)))
        self.bus.note_structure_changed.connect(self._refresh_notes)
        self.bus.flash_changed.connect(self._refresh_flash)
        self.bus.settings_changed.connect(self._on_setting_changed)
        self.bus.theme_changed.connect(lambda: None)
        self.bus.backup_restored.connect(self._refresh_everything)
        # 工作流（v10）：模板/实例变更 → 刷新工作流页（任务侧联动见 _on_task_changed）
        self.bus.workflow_template_changed.connect(self._refresh_workflow)
        self.bus.workflow_instance_changed.connect(self._refresh_workflow)
        # 图谱观察者增量同步：GraphService 订阅总线 → graph_delta → 图谱页局部刷新
        self.ctx.graph_service.subscribe(self.bus)
        self.bus.graph_delta.connect(self._on_graph_delta)

        # 命令面板：命令自带 action，任务/笔记/闪念/标签命中由这里导航。
        self.palette.activated.connect(self._open_hit)
        self.palette.createNoteRequested.connect(self._new_note_with_title)
        self.palette.themeRequested.connect(self._set_theme_pack)

        # 命令面板打开动作
        self._palette_shortcut = QShortcut(QKeySequence("Ctrl+K"), self.main)
        self._palette_shortcut.activated.connect(self.palette.open_palette)
        self._new_task_shortcut = QShortcut(QKeySequence("Ctrl+N"), self.main)
        self._new_task_shortcut.activated.connect(lambda: self._dispatch_action("quick-capture"))
        self._new_note_shortcut = QShortcut(QKeySequence("Ctrl+Shift+N"), self.main)
        self._new_note_shortcut.activated.connect(self._new_note)
        self._sidebar_shortcut = QShortcut(QKeySequence("Ctrl+B"), self.main)
        self._sidebar_shortcut.activated.connect(
            lambda: self.main.navigationInterface.setCollapsed(
                not self.main.navigationInterface.isCollapsed()))
        self._preview_shortcut = QShortcut(QKeySequence("Ctrl+E"), self.main)
        self._preview_shortcut.activated.connect(self.main.note_page.toggle_preview)
        # 撤销最近一次「完成/取消」（文本输入框内放行原生命令，不进业务撤销）
        self._undo_shortcut = QShortcut(QKeySequence("Ctrl+Z"), self.main)
        self._undo_shortcut.activated.connect(self._undo_last)
        # 划词速记（读取选中并速记）应用内兜底：全局热键注册失败/平台不支持时，
        # 应用内仍可触发；全局热键生效时对应按键被系统层吞掉，不会双触发。
        # 键位随设置同步（见 _sync_in_app_shortcut，默认 ctrl+shift+u）。
        self._select_quick_shortcut = QShortcut(QKeySequence("Ctrl+Shift+U"), self.main)
        self._select_quick_shortcut.activated.connect(
            lambda: self._dispatch_action("select-quick"))

    # ================= 全局动作 =================
    def eventFilter(self, watched, event):   # noqa: N802 (v0.16 P0-2 focus glow)        """聚焦发光：QLineEdit/下拉/数字框/强调主按钮 聚焦时挂 accent 外发光。"""
        from PySide6.QtWidgets import (QDateTimeEdit, QDoubleSpinBox, QGraphicsDropShadowEffect)
        if event.type() == QEvent.FocusIn:
            is_input = isinstance(watched, (QLineEdit, QComboBox, QSpinBox,
                                            QDoubleSpinBox, QDateEdit, QDateTimeEdit))
            is_accent_btn = False
            try:
                is_accent_btn = (getattr(watched, "property", None) is not None
                                 and watched.property("uiTone") == "accent"
                                 and watched.property("uiKind") == "solid")
            except Exception:
                is_accent_btn = False
            if (is_input or is_accent_btn) and watched.isEnabled():
                try:
                    eng = ThemeEngine.instance()
                    accent = eng.t("accent", "#0D9488") if eng else "#0D9488"
                    eff = QGraphicsDropShadowEffect(watched)
                    eff.setBlurRadius(12)
                    eff.setOffset(0, 0)
                    c = QColor(accent)
                    c.setAlpha(90)
                    eff.setColor(c)
                    watched.setGraphicsEffect(eff)
                except Exception:
                    pass
        elif event.type() == QEvent.FocusOut:
            try:
                from PySide6.QtWidgets import (QDateTimeEdit, QDoubleSpinBox)
                is_input = isinstance(watched, (QLineEdit, QComboBox, QSpinBox,
                                                QDoubleSpinBox, QDateEdit, QDateTimeEdit))
                is_accent_btn = bool(watched.property("uiTone") == "accent"
                                     and watched.property("uiKind") == "solid") \
                    if getattr(watched, "property", None) else False
                if (is_input or is_accent_btn) and watched.graphicsEffect() is not None:
                    watched.setGraphicsEffect(None)
            except Exception:
                pass
        return super().eventFilter(watched, event)

    def _dispatch_action(self, action: str):
        if action == "command-palette":
            # v0.16 P0-1: 标题栏胶囊；传入胶囊作为锚点，使面板贴其正下方展开
            anchor = getattr(getattr(self.main, "titleBar", None), "command_btn", None)
            self.palette.open_palette(anchor)
        elif action == "quick-capture":
            self.quick_capture.popup()
        elif action == "new-note":
            self._new_note()                     # v0.16 P0-3: FloatingDock
        elif action == "flash-inbox":
            self.main.switchTo(self.main.inbox_page)
            self.main.inbox_page.tabs.setCurrentIndex(1)   # 闪念 Tab（v0.16 P0-3）
            self.main.inbox_page.raise_()
        elif action == "capture":
            self.start_word_capture()
        elif action == "select-quick":
            self.start_select_quick()
        elif action == "widget":
            self._toggle_widget()

    def _suspend_hotkeys(self):
        """改键期间注销所有全局热键，避免 EventTap 拦截按键捕获。"""
        try:
            self.hotkeys.unregister_all()
        except Exception:
            pass

    def _rebind_hotkeys(self):
        """热键改键后：注销旧键并重新注册（F11-6）。"""
        try:
            self.hotkeys.unregister_all()
        except Exception:
            pass
        s = self.ctx.settings
        for key, setting in self._hotkey_bindings():
            hk = s.get(setting, _SELECT_QUICK_HOTKEY_DEFAULT
                       if setting == K.K_SELECT_HOTKEY else "")
            if not hk:
                continue
            ok = self.hotkeys.register(hk, lambda a=key: self._dispatch_action(a))
            log.debug("热键重注册 {}({}) -> {}", key, hk, ok)
            self.hotkey_status[setting] = "✓ 已注册" if ok else "未授权/冲突（已降级为托盘菜单）"
        self._sync_in_app_shortcut(s)

    def _register_hotkeys(self):
        s = self.ctx.settings
        for key, setting in self._hotkey_bindings():
            hk = s.get(setting, _SELECT_QUICK_HOTKEY_DEFAULT
                       if setting == K.K_SELECT_HOTKEY else "")
            if not hk:
                continue
            ok = self.hotkeys.register(hk, lambda a=key: self._dispatch_action(a))
            log.debug("热键注册 {}({}) -> {}", key, hk, ok)
            self.hotkey_status[setting] = "✓ 已注册" if ok else "未授权/冲突（已降级为托盘菜单）"
        self._sync_in_app_shortcut(s)

    @staticmethod
    def _hotkey_bindings():
        """全局热键动作 ↔ 设置键 列表（注册/重注册共用，避免两处漂移）。"""
        return [("capture", K.K_CAPTURE_HOTKEY),
                ("quick-capture", K.K_QUICK_HOTKEY),
                ("widget", K.K_WIDGET_HOTKEY),
                ("select-quick", K.K_SELECT_HOTKEY)]

    @staticmethod
    def _qt_hotkey_sequence(hotkey: str) -> QKeySequence:
        """全局热键记法(ctrl+shift+u) → QKeySequence（供应用内 QShortcut）。

        macOS 上 Qt 把 Command 键报为 Control 修饰、物理 Control 报为 Meta，
        做一次换算，让应用内快捷键与全局热键按同一组物理键触发。
        """
        import sys as _sys
        try:
            parts = [p.strip().lower() for p in (hotkey or "").split("+") if p.strip()]
            if not parts or len(parts[-1]) != 1:
                return QKeySequence()
            mods, key = parts[:-1], parts[-1].upper()
            if _sys.platform == "darwin":
                names = {"ctrl": "Meta", "shift": "Shift", "alt": "Alt", "cmd": "Ctrl"}
            else:
                names = {"ctrl": "Ctrl", "shift": "Shift", "alt": "Alt", "cmd": "Ctrl"}
            tokens = [names[m] for m in mods if m in names]
            if not tokens:
                return QKeySequence()
            return QKeySequence("+".join(tokens + [key]))
        except Exception:  # noqa: BLE001
            return QKeySequence()

    def _sync_in_app_shortcut(self, s=None):
        """把「读取选中并速记」应用内兜底快捷键同步为设置键位（默认 ctrl+shift+u）。"""
        try:
            s = s or self.ctx.settings
            hk = s.get(K.K_SELECT_HOTKEY, _SELECT_QUICK_HOTKEY_DEFAULT)
            seq = self._qt_hotkey_sequence(hk)
            if seq and hasattr(self, "_select_quick_shortcut"):
                self._select_quick_shortcut.setKey(seq)
        except Exception:  # noqa: BLE001
            pass

    # ================= 划词捕获流程 =================
    def start_word_capture(self):
        self._capturing = True

        def done(text, mode):
            self._capturing = False
            if not text:
                self._toast("没有捕获到选中文本", "可先复制内容再重试，或检查辅助功能权限")
                return
            self._show_capture_card(text, mode, self.grabber.frontmost_app_name(),
                                    self._extract_source_url())
        self.grabber.grab(done)

    # ================= 划词速记（读取选中并速记，Ctrl+Shift+U） =================
    def start_select_quick(self):
        """读取前台应用的选中文字 → 预填快速捕获窗，回车即 quick_create。

        复用划词 selection 管线（模拟复制 + 剪贴板备份恢复，不破坏剪贴板）：
        - 系统允许（macOS 辅助功能 / Windows）→ 直接捕获选中文字；
        - 未授权/平台不支持 → 自动降级读当前剪贴板文本并提示；
        - 无选中且剪贴板为空 → 仅提示，不弹窗。
        抓取内容不写日志明文（沿用既有红线）。
        """
        self._capturing = True

        def done(text, mode):
            self._capturing = False
            if not text:
                self._capture_notify("未获取到选中文字", "可先复制内容再重试，或检查辅助功能权限")
                return
            self._prefill_quick_capture(text)
            if mode == "clipboard_fallback":
                self._capture_notify("未捕获到选中文字，已用剪贴板内容")

        self.grabber.grab(done)

    def _prefill_quick_capture(self, text: str):
        """唤起/复用快速捕获窗并预填选中文字（含多行正文随提交入备注）。"""
        qc = self.quick_capture
        if qc.isVisible():
            # 速记窗已在显示：原地预填并聚焦（不挪动窗口位置）
            qc.prefill(text)
        else:
            # 未显示：等价现有 Ctrl+Alt+N 行为 + 预填文本（置顶迷你速记窗）
            qc.popup()
            qc.prefill(text)

    def _capture_notify(self, msg: str, detail: str = ""):
        """划词类轻提示：主窗可见走应用内 InfoBar；后台/托盘态走系统气泡，避免提示不可见。"""
        try:
            if self.main.isVisible():
                self._toast(msg, detail)
                return
            self.main.tray.showMessage(
                "知行 ZhiXing", msg + (f" · {detail}" if detail else ""), msecs=2600)
        except Exception:  # noqa: BLE001
            pass

    def _extract_source_url(self):
        """从剪贴板 HTML 里提取来源 URL（F11-3，尽力而为，失败返回空串）。

        优先级：HTML href 显式链接 → HTML 元数据 source-url → 纯文本 URL；
        对相对路径用 ``//` 与 ``/`` 前缀尝试补齐域名；缺协议时补 https://。
        """
        try:
            md = QGuiApplication.clipboard().mimeData(QClipboard.Mode.Clipboard)
            html = md.html() if md and md.hasHtml() else ""
            if html:
                import re
                m = re.search(r'href=["\']([^"\']+)["\']', html)
                if not m:
                    m = re.search(r'(?:source-url|canonical|og:url)["\'\s:=]+([^"\'\s>]+)', html, re.I)
                if m:
                    url = m.group(1).strip()
                    if url and not url.startswith("#") and not url.startswith("javascript:"):
                        # 相对路径补齐域名
                        host = re.search(r'https?://[^/"\']+', html)
                        if url.startswith("//"):
                            url = "https:" + url
                        elif url.startswith("/") and host:
                            url = host.group(0) + url
                        if url.startswith("www."):
                            url = "https://" + url
                        if re.match(r'^https?://', url):
                            return url
            # 纯文本回退：剪贴板里含 http(s) 链接（如手动复制网址）
            text = QGuiApplication.clipboard().text() or ""
            import re as _re
            tm = _re.search(r'https?://[^\s]+', text)
            if tm:
                return tm.group(0).rstrip(".,;:!?)】」』\"'")
        except Exception:
            pass
        return ""

    def _show_capture_card(self, text: str, mode: str, source_app: str = "",
                            source_url: str = ""):
        self._dismiss_capture_card()
        guide = ("未授权辅助功能权限，已降级为「剪贴板捕获」（先复制再按热键）"
                 if mode in ("clipboard_fallback", "unsupported") else "")
        card = CaptureCard(text, self.ctx.task_service, self.ctx.settings, guide=guide)
        self._capture_card = card
        card.submitFlash.connect(lambda c, r: (
            self.ctx.flash_service.add(c, r, source_app=source_app or "划词",
                                       source_url=source_url),
            self._after_capture("已存入闪念", jump=lambda: self._jump("flash"))))
        card.submitTask.connect(lambda c, r: (
            self.ctx.task_service.create(c[:60] or "捕获任务", notes_md=f"捕获内容：{c}"),
            self._after_capture("已创建任务", jump=lambda: self.main.switchTo(self.main.task_page))))
        card.submitNote.connect(self._capture_to_note)
        card.submitGroup.connect(self._capture_to_group)
        card.submitSubtask.connect(self._capture_to_subtask)
        card.cancelled.connect(lambda c=card: self._on_capture_cancelled(c))
        cursor = QCursor.pos()   # QGuiApplication 无 cursor()，用 QCursor.pos() 取全局鼠标位置
        # v0.15 P2-7: 捕获卡定位在鼠标所在屏内钳制（副屏不再错位）
        target_screen = QGuiApplication.screenAt(cursor) or QGuiApplication.primaryScreen()
        geom = target_screen.availableGeometry() if target_screen else \
            QGuiApplication.primaryScreen().availableGeometry()
        card.popup(QPoint(min(cursor.x() + 12, geom.right() - 420),
                          min(cursor.y() + 12, geom.bottom() - 300)))

    def _capture_to_note(self, remark, content):
        """入笔记：始终新建一篇笔记（不追加到当前笔记，避免落入「全部笔记」中已存在的笔记）。"""
        note = self.ctx.note_service.create(title=(remark or content).strip()[:30],
                                            content_md=f"> {content}\n{remark}\n")
        self._after_capture("已创建笔记", jump=lambda: self._show_note(note.id))

    def _capture_to_group(self, content, remark, target_id, target_name):
        task = self.ctx.task_service.create((content or "").split("\n")[0][:60] or "捕获任务",
                                            list_id=target_id,
                                            notes_md=f"捕获内容：{content}\n{remark}")
        self._after_capture(f"已添加到「{target_name}」",
                            jump=lambda: self._jump_to_group(target_id))

    def _capture_to_subtask(self, content, remark, parent_id, parent_name):
        title = (content or "").split("\n")[0][:60] or "捕获子任务"
        task = self.ctx.task_service.create(title, parent_id=parent_id,
                                            notes_md=f"捕获内容：{content}\n{remark}")
        self._after_capture(f"已加为「{parent_name}」的子待办",
                            jump=lambda: self._open_task(parent_id))

    def _after_capture(self, msg: str, jump=None):
        self._dismiss_capture_card()
        self._toast(msg, jump=jump)
        self._refresh_flash()
        self._refresh_all_tasks()

    def _on_capture_cancelled(self, card):
        """划词捕获卡被取消/失焦关闭：先清引用再销毁，避免下次踩到已删除的 C++ 对象。"""
        if self._capture_card is card:
            self._capture_card = None
        try:
            card.deleteLater()
        except RuntimeError:
            pass

    def _dismiss_capture_card(self):
        """安全销毁当前捕获卡并清引用（幂等，可重复调用；不抛 RuntimeError）。"""
        if self._capture_card is not None:
            card, self._capture_card = self._capture_card, None
            try:
                card.deleteLater()
            except RuntimeError:
                pass

    # ================= 任务/笔记动作 =================
    def _toggle_task(self, task_id: int):
        if not (task_id and task_id > 0):
            return
        before = self.ctx.task_service.get(task_id)
        if not before:
            return
        was_done = before.is_done
        task = self.ctx.task_service.toggle_complete(task_id)[0]
        title = (task.title if task else before.title) or ""
        # 记录可撤销原状：仅在由“圆圈勾选”发起的完成/恢复上支持 Ctrl+Z
        self._undo = {"kind": "set-status", "id": task_id,
                      "prev_status": TaskStatus(before.status.value) if was_done
                      else TaskStatus.DONE, "title": title}
        if not was_done:
            self._toast(f"已完成「{title}」 · Ctrl+Z 撤销",
                        jump=lambda: self._write_note_after_done(task_id, title),
                        jump_label="写篇笔记记一下")
        else:
            self._toast(f"已恢复「{title}」")

    def _move_task(self, task_id: int, list_id):
        """收件箱任务移动到列表（方案 A 整理闭环）。"""
        if not (task_id and task_id > 0):
            return
        if self.ctx.task_service:
            self.ctx.task_service.move_to_list(task_id, list_id)
            self.main.inbox_page.reload()
            self._toast("已移动到列表")

    # ================= 今日页/浮窗上抛的快捷编辑 =================
    def _delete_task(self, task_id: int):
        if not (task_id and task_id > 0):
            return
        task = self.ctx.task_service.get(task_id)
        if not task:
            return
        ids = self._collect_subtree_ids(task_id)
        self.ctx.task_service.delete(task_id)
        self._undo = {"kind": "delete-task", "ids": ids, "title": task.title or ""}
        self._toast(f"已删除「{task.title or ''}」 · Ctrl+Z 撤销")

    def _collect_subtree_ids(self, task_id: int):
        """收集任务及其全部子孙 id（软删撤销时一并恢复）。"""
        roots = self.ctx.task_service.all_tree()

        def flatten(t):
            out = [t.id]
            for c in (t.children or []):
                out.extend(flatten(c))
            return out

        def find(items):
            for t in (items or []):
                if t.id == task_id:
                    return flatten(t)
                r = find(t.children)
                if r:
                    return r
            return []
        return find(roots) or [task_id]

    def _edit_priority(self, task_id: int):
        if not task_id:
            return
        
        from ..view.kit.priority import priority_choices
        menu = RoundMenu(parent=self.main)
        for value, label in priority_choices():
            a = Action(label, self.main)
            a.triggered.connect(lambda _checked=False, v=value, tid=task_id:
                                self.ctx.task_service.update(tid, priority=v))
            menu.addAction(a)
        menu.exec(QCursor.pos())

    def _edit_tags(self, task_id: int):
        if not task_id:
            return
        
        menu = RoundMenu(parent=self.main)
        tags = self.ctx.task_service.tag_map([task_id]).get(task_id, [])
        for _tag_id, name, _color in tags:
            a = Action(f"移除 #{name}", self.main)
            a.triggered.connect(lambda _checked=False, tid=task_id, n=name:
                                self._remove_tag(tid, n))
            menu.addAction(a)
        if tags:
            menu.addSeparator()
        add_a = Action("添加标签…", self.main)
        add_a.triggered.connect(lambda _checked=False: self._prompt_add_tag(task_id))
        menu.addAction(add_a)
        menu.exec(QCursor.pos())

    def _remove_tag(self, task_id: int, name: str):
        tag_map = self.ctx.task_service.tag_map([task_id]).get(task_id, [])
        names = [n for (_tid, n, _c) in tag_map if n != name]
        self.ctx.task_service.set_tags(task_id, names)

    def _prompt_add_tag(self, task_id: int):
        from PySide6.QtWidgets import QInputDialog
        text, ok = QInputDialog.getText(self.main, "添加标签", "标签名（逗号分隔多个）：")
        if not ok or not text.strip():
            return
        names = [x.strip().lstrip("#") for x in text.replace("，", ",").split(",") if x.strip()]
        if not names:
            return
        existing = [n for (_tid, n, _c) in self.ctx.task_service.tag_map([task_id]).get(task_id, [])]
        self.ctx.task_service.set_tags(task_id, existing + [n for n in names if n not in existing])

    def _add_subtask(self, task_id: int):
        if not task_id:
            return
        task = self.ctx.task_service.add_subtask(task_id, "新子任务")
        if not task:
            return
        # 今日页树在 task_changed 触发时已 reload；这里显式展开父任务并定位新子项触发内联编辑。
        self.main.today_page.expand_task(task_id)
        self.main.today_page.begin_inline_edit(task.id)

    def _set_task_title(self, task_id: int, text: str):
        if task_id and text.strip():
            self.ctx.task_service.update(task_id, title=text.strip())

    def _on_note_deleted(self, note_id: int, title: str):
        self._undo = {"kind": "delete-note", "id": note_id, "title": title}
        self._toast(f"已删除笔记「{title}」 · Ctrl+Z 撤销")

    def _on_flash_deleted(self, fid: int):
        f = self.ctx.flash_service.get(fid)
        title = (f.content or "").split("\n")[0][:30] if f else ""
        self._undo = {"kind": "delete-flash", "id": fid, "title": title}
        self._toast(f"已删除闪念「{title}」 · Ctrl+Z 撤销")

    def _write_note_after_done(self, task_id: int, title: str):
        """完成任务时沉淀一篇复盘笔记（F4-4）。

        若任务关联了笔记段落（task_note_context），把复盘回写为一段「结论」，
        并保留原段落的定位锚（反向沉淀闭环 F4-4-2）；无关联则新建复盘笔记。
        """
        contexts = []
        try:
            contexts = self.ctx.task_service.linked_contexts(task_id) or []
        except Exception:  # noqa: BLE001 —— 回写失败退化为普通复盘笔记
            contexts = []
        if contexts:
            ctx0 = contexts[0]
            note = self.ctx.note_service.get(ctx0.note_id)
            if note is not None:
                stamp = datetime.now().strftime("%Y-%m-%d")
                body = (f"## 结论（{stamp}）\n- ✅ 已完成：{title}\n")
                self.ctx.note_service.append(ctx0.note_id, body)
                self._refresh_notes()
                self._show_note(ctx0.note_id, ctx0.block_key)
                return
        note = self.ctx.note_service.create(
            title=f"复盘：{title}",
            content_md=f"# 复盘：{title}\n\n## 收获\n\n## 待改进\n\n")
        self._refresh_notes()
        self._show_note(note.id)

    def _undo_last(self):
        """撤销最近一次勾选完成/恢复（Ctrl+Z）；文本输入区不截获。"""
        try:
            from PySide6.QtWidgets import (QApplication)
            fw = QApplication.focusWidget()
            if isinstance(fw, (QLineEdit, QComboBox, QPlainTextEdit, QTextEdit)):
                return
        except Exception:
            pass
        u = self._undo
        if not u:
            return
        self._undo = None
        if u["kind"] == "delete-task":
            for i in u.get("ids", []):
                try:
                    self.ctx.task_service.restore(i)
                except Exception:
                    pass
            self._toast("已撤销删除")
            return
        if u["kind"] == "delete-note":
            self.ctx.note_service.restore(u["id"])
            self._toast("已撤销删除")
            return
        if u["kind"] == "delete-flash":
            self.ctx.flash_service.restore(u["id"])
            self._toast("已撤销删除")
            return
        if u["kind"] != "set-status":
            return
        cur = self.ctx.task_service.get(u["id"])
        if not cur:
            self._toast("撤销目标已不存在，跳过")
            return
        if cur.status != u["prev_status"]:
            self.ctx.task_service.set_status(u["id"], u["prev_status"])
        self._toast("已撤销上一步勾选")

    def _open_task(self, task_id: int):
        if task_id and task_id > 0:
            self.main._show_main()      # 浮窗等入口：先唤起主程序再定位
            self.main.switchTo(self.main.task_page)
            self.main.task_page.show_task(task_id)

    def _show_note(self, note_id: int, block_key: str = ""):
        """打开笔记页；block_key 非空时定位到段落（v0.15 P0-1）。"""
        self.main.switchTo(self.main.note_page)
        if note_id > 0:
            if block_key:
                self.main.note_page.locate_in_note(note_id, block_key)
            else:
                self.main.note_page.select_note(note_id)

    def _open_folder(self, folder_id: int):
        """图谱双击文件夹节点 → 切到笔记库并定位该文件夹。"""
        self.main.switchTo(self.main.note_page)
        self.main.note_page.select_folder(folder_id)

    def _open_flash(self, flash_id: int):
        """图谱双击闪念节点 → 跳到收件箱「闪念」Tab 并定位该闪念。"""
        self.main._show_main()
        self.main.switchTo(self.main.inbox_page)
        self.main.inbox_page.select_flash(flash_id)

    def _link_notes(self, src_id: int, dst_id: int):
        """图谱拉线建链：复用 note_link，成功后经 note_links_changed → graph_delta 增量刷新。"""
        ok = self.ctx.graph_service.link_notes(src_id, dst_id)
        if ok:
            self._toast("已建立连接")

    def _open_hit(self, kind: str, payload):
        """命令面板非命令命中 → 导航到对应页面/条目并定位。"""
        if kind in ("task", "note", "flash"):
            try:
                self.ctx.search_service.touch(kind, payload)
            except Exception:  # noqa: BLE001 —— MRU 记一次失败不影响导航
                pass
        if kind == "task":
            self._open_task(payload.id)
        elif kind == "note":
            self._show_note(payload.id)
        elif kind == "flash":
            self.main.switchTo(self.main.inbox_page)
            self.main.inbox_page.tabs.setCurrentIndex(1)
            self.main.inbox_page.reload()
        elif kind == "tag":
            tid = payload
            name, color = "", "#0D9488"
            # MVC 收口：标签名/色经 note_service.all_tags 只读 facade，不再直连 db.session/TagRow。
            try:
                for _id, _name, _color in (self.ctx.note_service.all_tags() or []):
                    if _id == tid:
                        name, color = _name, _color
                        break
            except Exception:
                pass
            self.main.switchTo(self.main.task_page)
            self.main.task_page.set_focus_list("tag", (tid, name, color))

    def _prompt_create_note(self, folder_id=None, default_title=""):
        """统一新建笔记入口：NoteCreateDialog（名称 + 五类型 + 目标）→ note_service.create。"""
        picked = NoteCreateDialog.get_note(self.main, default_title=default_title)
        if picked is None:
            return None
        name, fmt, target = picked
        title = (name or "").strip() or DEFAULT_NOTE_TITLE
        target = (target or "").strip()
        # Word/Excel 未选择文件时，自动新建空白文件（不必从本地载入）
        if fmt in (NOTE_FORMAT_WORD, NOTE_FORMAT_EXCEL) and not target:
            target = self._create_blank_office_file(fmt, title)
        if fmt in (NOTE_FORMAT_WORD, NOTE_FORMAT_EXCEL, NOTE_FORMAT_LINK):
            content = target
        elif fmt == NOTE_FORMAT_MARKDOWN:
            content = "（在这里开始写作…）\n"
        else:
            content = ""
        note = self.ctx.note_service.create(title=title, content_md=content,
                                            folder_id=folder_id, format=fmt)
        self._refresh_notes()
        self._show_note(note.id)
        return note

    def _create_blank_office_file(self, fmt: str, title: str) -> str:
        """新建空白 .docx/.xlsx 文件，返回路径。"""
        import time
        from ..model.infrastructure.db import data_dir
        from ..view.components.note_previews import create_blank_docx, create_blank_xlsx
        base = data_dir() / "notes_attach"
        base.mkdir(parents=True, exist_ok=True)
        safe = "".join(c for c in title if c not in '\\/:*?"<>|')[:40] or "未命名"
        ext = "docx" if fmt == NOTE_FORMAT_WORD else "xlsx"
        path = base / f"{safe}-{int(time.time())}.{ext}"
        fn = create_blank_docx if fmt == NOTE_FORMAT_WORD else create_blank_xlsx
        fn(str(path))
        return str(path)

    def _new_note(self):
        self._prompt_create_note()

    def _new_note_in_folder(self, folder_id):
        """在指定文件夹新建笔记（与笔记页「＋笔记」行为一致）。"""
        self._prompt_create_note(folder_id=folder_id)

    def _new_note_with_title(self, title: str):
        """命令面板无结果 → 预填输入词走 NoteCreateDialog 新建笔记。"""
        self._prompt_create_note(default_title=title or "")

    def _set_theme_pack(self, name: str):
        """命令面板「主题：XX」直达切换主题包。"""
        self.ctx.settings.set(K.K_THEME_PACK, name)
        self._apply_theme()

    def _quick_submit(self, text: str):
        task = self.ctx.task_service.quick_create(text)
        if not task:
            return
        # 划词速记预填：多行/超长首行的原文暂存在速记窗 pending_notes，
        # 随标题一并写入任务备注（不丢内容；单行短文本无余量则与普通快速任务一致）。
        notes = ""
        try:
            notes = (self.quick_capture.pending_notes or "").strip()
        except Exception:  # noqa: BLE001
            notes = ""
        if notes:
            try:
                self.ctx.task_service.update(task.id, notes_md=notes)
            except Exception as e:  # noqa: BLE001
                log.debug("划词速记备注写入失败: {}", e)
            self._toast(f"已添加「{task.title}」 · 原文已存备注")
        else:
            self._toast(f"已添加「{task.title}」")

    def _widget_quick_add(self, text: str):
        task = self.ctx.task_service.quick_create(text)
        self.widget.reload_tasks()

    def _start_pomodoro(self, task_id):
        self.pomodoro.start(task_id)

    def _backup_now(self):
        def _run():
            path = self.ctx.backup.backup("manual")
            return f"已备份:{path.name}" if path else "备份失败"

        run_in_background(_run,
                          on_done=lambda m: self._toast(m),
                          holder=self._bg,
                          on_error=lambda e: self._toast(f"备份失败:{e}"))

    def _toggle_widget(self):
        if self.widget.isVisible():
            self.widget.hide()
        else:
            self.widget.show()
            self.widget.reload_tasks()

    def _on_main_shown(self):
        """主窗口显示时隐藏浮窗。"""
        if self.widget.isVisible():
            self.widget.hide()

    def _on_main_hidden(self):
        """主窗口隐藏（关闭/最小化到浮窗）时显示浮窗。"""
        if not self.ctx.settings.get_bool(K.K_WIDGET_ENABLED, True):
            return
        if not self.widget.isVisible():
            self.widget.show()
        self.widget.reload_tasks()

    def _restart_widget(self):
        self.widget.reload_tasks()

    def _jump(self, key: str):
        if key == "flash":
            self.main.switch_page(2)
            self.main.inbox_page.tabs.setCurrentIndex(1)
            self.main.inbox_page.reload()
            return
        if key in ("today", "overdue", "done"):
            self.main.switch_page(1)
            self._focus_task_smart_list(key)
            return
        self.main.switch_page(0)

    def _focus_task_smart_list(self, key: str):
        """今日概览卡 → 任务页智能清单（F1-15/F6-1）：今天/已逾期/已完成各自独立定位。"""
        svc = self.ctx.task_service
        if key == "done":
            roots = svc.all_tree(statuses=[TaskStatus.DONE, TaskStatus.ABANDONED])
        elif key == "overdue":
            roots = self._overdue_tree()
        elif key == "today":
            roots = svc.today_tree()
        else:
            roots = svc.all_tree()
        self._reload_task_page(roots)

    def _overdue_tree(self):
        """已逾期智能清单：overdue() 平铺结果按父子关系还原成树。"""
        tasks = self.ctx.task_service.overdue()
        by_id = {t.id: t for t in tasks}
        roots = []
        for t in tasks:
            t.children = []
            t.note_count = getattr(t, "note_count", 0) or 0
            if t.parent_id in by_id:
                by_id[t.parent_id].children.append(t)
            else:
                roots.append(t)
        return roots

    def _jump_to_group(self, list_id):
        """捕获卡「去查看」：定位到分组/列表（W18）。"""
        self.main.switchTo(self.main.task_page)
        self._reload_task_page(self.ctx.task_service.list_tree(list_id))

    def _reload_task_page(self, roots):
        """把任务页列表视图切换为给定根集合（智能清单/分组定位复用）。"""
        page = self.main.task_page
        try:
            page.proxy.set_text("")
            page.proxy.set_hide_done(False)
            page.proxy.set_tag_filter(None)
        except Exception:
            pass
        page.task_model.reload(roots)
        empty = getattr(page, "_empty_list", None)
        if empty is not None:
            empty.setVisible(not roots)
        page.tree.setVisible(bool(roots))

    def _set_mode(self, mode: str):
        self.ctx.settings.set(K.K_THEME_MODE, mode)
        self._apply_theme()

    # ================= 主题 =================
    def _apply_theme(self):
        s = self.ctx.settings
        mode = s.get(K.K_THEME_MODE, "system")
        if mode == "system":
            hints = QGuiApplication.styleHints()
            mode = "dark" if hints.colorScheme() == Qt.ColorScheme.Dark else "light"
        pack = s.get(K.K_THEME_PACK, "青竹")
        accent = s.get(K.K_ACCENT, "#0D9488")
        control_h = max(CONTROL_HEIGHT_MIN, min(CONTROL_HEIGHT_MAX, s.get_int(K.K_CONTROL_HEIGHT, 32)))
        # ⑤ 字号下限改为 9（与设置页 SpinBox range / constants 校验同源）
        font_size = max(FONT_SIZE_MIN, min(FONT_SIZE_MAX, s.get_int(K.K_FONT_SIZE, 14)))
        # 关键：把框架的设置源绑定给渲染器。
        # style_sheet() 只有在绑定 settings 后才会把「控件高度 / 字号 / 圆角」
        # 注入渲染 —— 否则这三项设置改了也不生效（用默认 token 渲染）。
        from qfluent_core import UISettings
        self.theme_engine.apply(pack, mode, accent,
                                settings=UISettings.instance())
        app = QApplication.instance()
        # 主题与样式全部由 qfluent_core 渲染（第三方 UI 库已退场）：
        # theme_engine.style_sheet() 直接返回框架样式表，这里不再需要任何第三方主题调用。
        app.setStyleSheet(self.theme_engine.style_sheet())
        # 注：全局控件高度由 component_qss 的盒模型折算精确控制；不再使用
        # QProxyStyle（它 wrap app.style() 会在 setStyle 时留下悬空 base 样式
        # 指针，导致 macOS 下 SIGSEGV）。
        pal = app.palette()
        for grp in (QPalette.Active, QPalette.Inactive, QPalette.Disabled):
            pal.setColor(grp, QPalette.Highlight,
                         QColor(self.theme_engine.tokens.get("accent_soft", "#D9F2EE")))
            pal.setColor(grp, QPalette.HighlightedText,
                         QColor(self.theme_engine.tokens.get("fg", "#1A1A1A")))
            pal.setColor(grp, QPalette.Base,
                         QColor(self.theme_engine.tokens.get("layer", "#FFFFFF")))
            pal.setColor(grp, QPalette.Window,
                         QColor(self.theme_engine.tokens.get("canvas", "#FFFFFF")))
            pal.setColor(grp, QPalette.Text,
                         QColor(self.theme_engine.tokens.get("fg", "#1A1A1A")))
            pal.setColor(grp, QPalette.WindowText,
                         QColor(self.theme_engine.tokens.get("fg", "#1A1A1A")))
        app.setPalette(pal)
        log.debug("theme applied style={} highlight={} accent_soft={}",
                  app.style().objectName(),
                  pal.color(QPalette.Active, QPalette.Highlight).name(),
                  self.theme_engine.tokens.get("accent_soft", ""))
        for w in app.topLevelWidgets():
            w.setPalette(pal)
        icons.on_theme_change()
        AppController._apply_motion(self)
        self.main.task_page.reload_tasks()
        # 动态行（闪念卡）颜色随主题重建（避免残留旧色）
        try:
            self.main.inbox_page.reload()
        except Exception:
            pass
        try:
            self.bus.theme_changed.emit()
        except Exception:
            pass

    # ================= 动效降级（F9-6/W16） =================
    def _os_reduce_motion(self) -> bool:
        """OS 级「减少动态效果」探测：macOS NSWorkspace / Windows 关闭动画；失败降级 False。"""
        import sys
        if sys.platform == "darwin":
            try:
                from AppKit import NSWorkspace
                return bool(NSWorkspace.sharedWorkspace().accessibilityDisplayShouldReduceMotion())
            except Exception:
                return False
        if sys.platform == "win32":
            try:
                import ctypes
                # SPI_GETCLIENTAREAANIMATION = 0x1042；关闭动画时值为 0。
                val = ctypes.c_int(1)
                ok = ctypes.windll.user32.SystemParametersInfoW(0x1042, 0, ctypes.byref(val), 0)
                return bool(ok and val.value == 0)
            except Exception:
                return False
        return False

    def _motion_enabled(self) -> bool:
        manual = self.ctx.settings.get(K.K_MOTION, "full")
        return manual == "full" and not AppController._os_reduce_motion(self)

    def _apply_motion(self):
        enabled = AppController._motion_enabled(self)
        set_motion_enabled(enabled)
        AppController._degrade_graph_physics(self, not enabled)

    def _degrade_graph_physics(self, reduced: bool):
        """reduce-motion 时冻结图谱力导向物理；关闭时按需恢复（有节点才重启）。"""
        graph = getattr(self.main, "graph_page", None)
        if graph is None:
            return
        try:
            if reduced:
                graph._running = False
                graph._physics.stop()
            elif getattr(graph, "nodes", None):
                graph._running = True
                graph._physics.start()
        except Exception:
            pass

    def _on_ui_setting_changed(self, key: str, value) -> None:
        # 框架侧设置（控件高度 / 字号 / 圆角 / 材质…）变化后要重新渲染样式表。
        # 业务设置走 bus.settings_changed -> pull_setting -> UISettings.set，
        # 最终落在这里，保证「设置页改一下，界面立刻变」。
        self._apply_theme()

    def _on_setting_changed(self, key: str):
        if key in (K.K_THEME_MODE, K.K_THEME_PACK, K.K_ACCENT,
                   K.K_CONTROL_HEIGHT, K.K_FONT_SIZE):
            self._apply_theme()
        elif key == K.K_MOTION:
            self._apply_motion()
        elif key in (K.K_TASK_ROW_HEIGHT, K.K_TASK_INDENT):
            self.main.today_page.apply_row_metrics()
            self.main.task_page.apply_row_metrics()
            self.main.inbox_page.apply_row_metrics()
            self.widget.apply_row_metrics()
        elif key == K.K_WIDGET_OPACITY:
            self.widget.apply_opacity(self.ctx.settings.get_int(K.K_WIDGET_OPACITY, 85))
        elif key == K.K_WIDGET_CLICK_THROUGH:
            self.widget.set_click_through(self.ctx.settings.get_bool(K.K_WIDGET_CLICK_THROUGH, False))
        elif key == K.K_MICA:
            try:
                self.main.setMicaEffectEnabled(self.ctx.settings.get_bool(K.K_MICA, True))
            except Exception:
                pass
        elif key == K.K_AUTO_START:
            from ..model.infrastructure.autostart import set_enabled
            set_enabled(self.ctx.settings.get_bool(K.K_AUTO_START, False))

    # ================= 刷新 =================
    def _on_task_changed(self, task_id, reason):
        log.debug("task_changed id={} reason={}", task_id, reason)
        # 工作流回推（v10）：若该任务是某流程实例的步骤，完成后自动推进流程。
        # 放在刷新之前，让流程进度与任务列表在同一次事件内保持一致。
        if reason == "completed":
            self._advance_workflow_for_task(task_id)
        counts = self.ctx.review_service.today_counts()
        self.main.today_page.set_stats(counts)
        self._update_tray_count(counts.get("today_due", 0))
        self.main.today_page.set_tree(self.ctx.task_service.today_tree())
        self.main.task_page.reload_tasks()
        # 非时间字段（标题/优先级/状态/标签等）变更后，四象限/日历/看板也要刷新（#④）
        self.main.task_page.reload_alt_views()
        if self.widget.isVisible():
            self.widget.reload_tasks()

    def _refresh_workflow(self):
        """工作流页刷新（模板或实例变更时）。"""
        try:
            self.main.workflow_page.reload()
        except Exception:  # noqa: BLE001 —— 页面未就绪时忽略
            pass

    def _advance_workflow_for_task(self, task_id: int):
        """任务完成 → 若它是某工作流实例的步骤，推进该实例到下一节点。

        这是「任务 → 流程」方向的绑定；反方向（流程下发步骤为任务）在
        WorkflowService.instantiate/_spawn_step_task 中完成。
        """
        try:
            advanced = self.ctx.workflow_service.complete_step_task(task_id)
        except Exception:  # noqa: BLE001 —— 流程推进失败不应影响任务本身
            return
        if advanced:
            try:
                self.main.workflow_page.reload()
            except Exception:  # noqa: BLE001
                pass

    def _update_tray_count(self, due: int):
        try:
            self.main.tray.setToolTip(f"知行 ZhiXing · 今日待办 {due}")
        except Exception:
            pass

    def _refresh_all_tasks(self):
        self._on_task_changed(-1, "structure")

    def _refresh_notes(self):
        # reload_folders / reload_list 都走 _reload_tree，只调一次避免双重 reset 导致焦点跳
        self.main.note_page.reload_folders()
        self.main.today_page.set_recent_notes(self.ctx.note_service.recent(5))

    def _refresh_flash(self):
        self.main.inbox_page.reload()
        self.main.today_page.set_stats(self.ctx.review_service.today_counts())
        # 闪念节点纳入图谱：闪念增删后由 graph_delta 观察者局部刷新（不再全量 reload）

    def _on_graph_delta(self, delta):
        """图谱增量刷新：GraphPage.apply_delta 局部应用（保留布局/pinned，避免全图重绘）。

        apply_delta 是 GraphPage 的必需接口（t7），消费 GraphDelta 做定点增删，
        不再回退全量 page.reload()。
        """
        self.main.graph_page.apply_delta(delta)

    def _refresh_everything(self):
        """启动/恢复备份后的全量刷新：所有页面（含图谱/回顾）在欢迎页阶段同步加载完成。

        回顾 QtCharts 渲染与图谱 build + 布点较重，但放在 splash 欢迎页阶段
        （主窗口尚未显示）同步执行，主窗口打开即完全可操作，不再懒加载。
        """
        self.main.today_page.refresh_greeting()
        self._refresh_all_tasks()
        self._refresh_notes()
        self.main.inbox_page.reload()
        self.main.today_page.set_stats(self.ctx.review_service.today_counts())
        self._refresh_workflow()
        self._load_heavy_pages()

    def _load_heavy_pages(self):
        """重页（回顾 / 图谱）同步加载：splash 欢迎页阶段完成，主窗口打开即可操作。"""
        try:
            self.main.review_page.reload()
        except Exception:
            pass
        try:
            self.main.graph_page.reload()
        except Exception:
            pass

    # ================= 定时器 =================
    def _start_timers(self):
        # 提醒轮询
        self._reminder_timer = QTimer(self)
        self._reminder_timer.setInterval(30_000)
        self._reminder_timer.timeout.connect(self._check_reminders)
        self._reminder_timer.start()
        # 跨天检测（循环子任务重置）
        self._day = date.today()
        self._day_timer = QTimer(self)
        self._day_timer.setInterval(600_000)
        self._day_timer.timeout.connect(self._check_day_rollover)
        self._day_timer.start()
        # 番茄钟
        from .pomodoro import PomodoroController
        self.pomodoro = PomodoroController(self.ctx, self.main)

    def _check_reminders(self):
        if not self.ctx.settings.get_bool(K.K_REMINDER_ENABLED, True):
            return
        now = datetime.now()
        # 到点的一次性定时提醒：先 dismiss 防 30s 重复打扰，再弹「稍后 5/15/30 分钟」按钮。
        for t in self.ctx.task_service.reminders_due(now):
            when = t.reminder_at.strftime("%H:%M") if t.reminder_at else ""
            body = f"「{t.title}」{(' · ' + when) if when else ''}"
            self.ctx.task_service.dismiss_reminder(t.id)
            self._show_reminder_popup(t.id, t.title or "任务提醒", body)

    def _show_reminder_popup(self, task_id: int, title: str, body: str):
        """托盘提醒弹窗（F5-3）：稍后 5/15/30 分钟 + 查看任务。"""
        popup = _ReminderPopup(task_id, title, body)
        popup.snoozeRequested.connect(self.snooze_reminder)
        popup.openRequested.connect(self._open_task)
        if not hasattr(self, "_reminder_popups"):
            self._reminder_popups = []
        self._reminder_popups.append(popup)
        popup.closed.connect(lambda: self._cleanup_reminder_popup(popup))
        popup.show()

    def _cleanup_reminder_popup(self, popup):
        try:
            self._reminder_popups.remove(popup)
        except (ValueError, AttributeError):
            pass
        popup.deleteLater()

    def snooze_reminder(self, task_id: int, minutes: int = 5):
        """托盘「稍后」按钮接线（F5-3）：reminder_at 顺延 5/15/30 分钟。"""
        t = self.ctx.task_service.snooze(task_id, minutes)
        if t:
            self._toast(f"已稍后提醒「{t.title}」· {minutes} 分钟后")
        return t

    def _check_day_rollover(self):
        if date.today() != self._day:
            self._day = date.today()
            n = self.ctx.task_service.roll_recurring_today()
            if n:
                self._toast(f"新的一天：{n} 个打卡子任务已重置")
            r = self.ctx.task_service.resume_due_today()
            if r:
                self._toast(f"有 {r} 个等待中的任务已到期恢复")
            self.main.today_page.refresh_greeting()
            self._purge_recycle()

    def _purge_recycle(self):
        """回收站 30 天自动清理（F9-3）。"""
        days = self.ctx.settings.get_int(K.K_RECYCLE_RETENTION, 30)
        try:
            n = self.ctx.task_service.purge_older_than(days)
            n += self.ctx.note_service.purge_older_than(days)
            n += self.ctx.flash_service.purge_older_than(days)
            if n:
                self._toast(f"回收站已清理 {n} 条超过 {days} 天的记录")
        except Exception:
            log.debug("回收站清理失败", exc_info=True)

    # ================= 剪贴板监听（F11-7，默认关） =================
    def _init_clipboard_monitor(self):
        try:
            self._clip = QGuiApplication.clipboard()
            self._clip.dataChanged.connect(self._on_clipboard_changed)
        except Exception:
            self._clip = None

    def _on_clipboard_changed(self):
        if self._clip is None:
            return
        if not self.ctx.settings.get_bool(K.K_CLIPBOARD_MONITOR, False):
            return
        if self._capturing or self._capture_card is not None:
            return
        text = (self._clip.text(mode=QClipboard.Mode.Clipboard) or "").strip()
        if not text or text == self._clip_last or len(text) < 4:
            return
        self._clip_last = text
        self._toast("检测到新复制内容 · Ctrl+Shift+S 可捕获")

    def _toast(self, msg: str, detail: str = "", jump=None, jump_label: str = "去查看"):
        try:
            
            content = msg if not detail else f"{msg} · {detail}"
            bar = InfoBar.success("知行", content, duration=3000 if jump else 2200,
                                  position=InfoBarPosition.BOTTOM, parent=self.main)
            if jump is not None:
                btn = PushButton(jump_label)
                btn.clicked.connect(jump)
                bar.addWidget(btn)
        except Exception:
            self.main.tray.showMessage("知行", msg, 2000)

    # ================= 只读模式（数据库迁移失败，#12） =================
    def _enter_readonly(self, message: str):
        """数据库迁移/初始化失败：进入只读模式并显示横幅 + 恢复备份入口。"""
        log.error("进入只读模式：{}", message)
        try:
            self.main.show_readonly_banner(message)
        except Exception:
            pass

    def _restore_backup_flow(self):
        """恢复备份入口（#12）：列出备份供选择，恢复后提示重启。"""
        try:
            backups = self.ctx.backup.list_backups()
        except Exception:
            backups = []
        if not backups:
            self._toast("没有可用的备份", "请先手动备份或检查备份目录")
            return
        from PySide6.QtWidgets import QInputDialog
        names = [b.name for b in backups]
        choice, ok = QInputDialog.getItem(self.main, "恢复备份", "选择要恢复的备份：", names, 0, False)
        if not ok or not choice:
            return
        path = next((b for b in backups if b.name == choice), None)
        if path is None:
            return
        try:
            self.ctx.backup.restore(path)
        except Exception as e:
            self._toast("恢复失败", str(e))
            return
        self._toast("已恢复备份", "请重启应用使其生效")

    # ================= 生命周期 =================
    def startup(self, show: bool = True):
        """初始化全部数据；show=False 时只初始化不显示（splash 流程用）。"""
        ctx = self.ctx
        # #12 入口闭环：AppContext 构造期迁移失败 → 只读模式启动（不崩溃）
        if getattr(ctx, "readonly_reason", None):
            self._enter_readonly(f"数据库迁移失败，已进入只读模式：{ctx.readonly_reason}")
            self.main.today_page.refresh_greeting()
            try:
                self._refresh_everything()
            except Exception:
                pass
            if show:
                self.main.show()
            log.info("startup complete (readonly)")
            self.widget.hide()
            return
        try:
            ctx.seed_if_empty()
            ctx.task_service.roll_recurring_today()
            ctx.task_service.resume_due_today()
        except Exception as e:  # 迁移/库不可用 → 只读横幅
            self._enter_readonly(f"数据库迁移失败，已进入只读模式：{e}")
        else:
            # 启动自动备份后台执行，不阻塞首屏
            run_in_background(lambda: ctx.backup.backup("auto"),
                              holder=self._bg,
                              on_error=lambda e: log.warning("自动备份失败: {}", e))
        self.main.today_page.refresh_greeting()
        try:
            self._refresh_everything()
        except Exception as e:
            self._enter_readonly(f"数据库不可用，已进入只读模式：{e}")
        if show:
            self.main.show()
        log.info("startup complete")
        # 启动时只显示主窗口；浮窗在主窗口隐藏（关闭/最小化）时再显示。
        self.widget.hide()

    def show_main(self):
        """splash 流程：初始化全部完成后显示主窗口（打开即可操作）。"""
        self.main.show()
        self.main.raise_()
        self.main.activateWindow()
        # v0.15 P1-4: 主窗就绪后派发排队深链
        self._flush_deep_links()

    # ---------- 深链分发（v0.15 P1-4，zhixing://） ----------
    @staticmethod
    def _ipc_server_name() -> str:
        """本地 IPC 服务名：按数据目录散列，多用户互不串扰（QLocalServer 名限制短）。"""
        import hashlib
        try:
            from zhixing.model.infrastructure.db import data_dir
            h = hashlib.sha1(str(data_dir()).encode("utf-8")).hexdigest()[:8]
        except Exception:  # noqa: BLE001
            h = "default"
        return f"zhixing-deeplink-{h}"

    def _start_deep_link_server(self):
        """主实例监听本地 socket：第二实例启动时把 zhixing:// 转发过来。"""
        from PySide6.QtNetwork import QLocalServer
        self._ipc_server = QLocalServer(self)
        self._ipc_server.newConnection.connect(self._on_ipc_connection)
        name = self._ipc_server_name()
        # 若上一次崩溃残留 server 文件，先移除再监听
        QLocalServer.removeServer(name)
        if not self._ipc_server.listen(name):
            log.warning(f"深链 IPC 监听失败：{self._ipc_server.errorString()}")

    def _on_ipc_connection(self):
        try:
            conn = self._ipc_server.nextPendingConnection()
            if conn is None:
                return
            conn.waitForReadyRead(200)
            payload = bytes(conn.readAll()).decode("utf-8", "replace").strip()
            conn.disconnectFromServer()
            if not payload or not payload.startswith("deep-link:"):
                return
            url = payload[len("deep-link:"):].strip()
            if url:
                self._pending_deep_links.append(url)
                self._flush_deep_links()
        except Exception:  # noqa: BLE001
            log.exception("处理深链 IPC 连接异常")

    def _flush_deep_links(self):
        """主窗口就绪后派发排队深链；未就绪则保留至 show_main。"""
        if not self._pending_deep_links:
            return
        try:
            shown = self.main.isVisible()
        except Exception:  # noqa: BLE001
            shown = False
        if not shown:
            return
        while self._pending_deep_links:
            self.handle_deep_link(self._pending_deep_links.pop(0))

    def handle_deep_link(self, url: str):
        """处理 zhixing:// 深链：唤起主窗口并跳转（任务/笔记段落/闪念/文件夹）。"""
        from zhixing.core.deep_link import parse_url
        target = parse_url(url) if url else None
        if not target:
            return
        kind, nid = target["kind"], target["id"]
        if kind == "task":
            self._open_task(nid)
        elif kind == "note":
            self._show_note(nid, target.get("block", ""))
        elif kind == "flash":
            self._open_flash(nid)
        elif kind == "folder":
            self._open_folder(nid)

    def shutdown(self):
        log.info("shutdown：注销全局热键/清理后台")
        try:
            self.hotkeys.unregister_all()
        except Exception:  # noqa: BLE001
            log.exception("注销热键出错（忽略，继续退出）")


class _ReminderPopup(QFrame):
    """提醒弹窗：正文 + 「稍后 5/15/30 分钟」+「查看」按钮（F5-3）。"""
    snoozeRequested = Signal(int, int)   # task_id, minutes
    openRequested = Signal(int)
    closed = Signal()

    def __init__(self, task_id: int, title: str, body: str):
        super().__init__(None, Qt.Tool | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(14, 12, 14, 12)
        lay.setSpacing(8)
        title_lbl = QLabel(title)
        f = title_lbl.font()
        f.setBold(True)
        title_lbl.setFont(f)
        lay.addWidget(title_lbl)
        body_lbl = QLabel(body)
        body_lbl.setWordWrap(True)
        lay.addWidget(body_lbl)
        row = QHBoxLayout()
        row.setSpacing(6)
        for minutes in (5, 15, 30):
            btn = QPushButton(f"稍后 {minutes} 分")
            btn.clicked.connect(lambda _checked=False, m=minutes: (
                self.snoozeRequested.emit(task_id, m), self._close()))
            row.addWidget(btn)
        view_btn = QPushButton("查看")
        view_btn.clicked.connect(lambda: (self.openRequested.emit(task_id), self._close()))
        row.addWidget(view_btn)
        close_btn = QPushButton("关闭")
        close_btn.clicked.connect(self._close)
        row.addWidget(close_btn)
        lay.addLayout(row)
        self._restyle()
        self.adjustSize()
        screen = QGuiApplication.primaryScreen().availableGeometry()
        self.move(screen.right() - self.width() - 24,
                  screen.bottom() - self.height() - 24)

    def _close(self):
        self.closed.emit()

    def _restyle(self):
        eng = ThemeEngine.instance()
        tokens = eng.tokens if eng else {}
        layer = tokens.get("layer", "#FFFFFF")
        border = tokens.get("border", "#E5E5E5")
        hover = tokens.get("hover", "#F5F5F5")
        fg = tokens.get("fg", "#1A1A1A")
        self.setStyleSheet(
            f"_ReminderPopup {{ background: {layer}; border: 1px solid {border}; border-radius: 12px; }}"
            f"QLabel {{ color: {fg}; background: transparent; }}"
            f"QPushButton {{ background: {hover}; border: 1px solid {border};"
            f"border-radius: 6px; padding: 4px 10px; }}")


class _cmd:
    def __init__(self, title: str, action):
        self.kind = "command"
        self.title = title
        self.subtitle = "命令"
        self.payload = None
        self.action = action


def QSystemTrayIcon_Information():
    from PySide6.QtWidgets import QSystemTrayIcon
    return QSystemTrayIcon.Information
