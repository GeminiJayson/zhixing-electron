# -*- coding: utf-8 -*-
"""主窗口：Fluent 导航壳 + 应用内快捷键 + 系统托盘。业务接线在 AppController。"""
import sys

from PySide6.QtCore import QEvent, Qt, QTimer, Signal
from PySide6.QtGui import QAction, QCursor, QIcon, QKeySequence, QShortcut
from PySide6.QtWidgets import (QApplication, QFrame, QHBoxLayout, QMenu, QSystemTrayIcon, QVBoxLayout, QWidget)


from ..kit import icons
from ..kit.flip_clock import FlipClock
from qfluent_core import ThemeManager as ThemeEngine
from qfluent_core import FluentTemplateWindow
from qfluent_core.material import apply_window_material
from ...core import settings_keys as K
from ..pages.today_page import TodayPage
from ..pages.task_page import TaskPage
from ..pages.inbox_page import InboxPage
from ..pages.note_page import NotePage
from ..pages.graph_page import GraphPage
from ..pages.review_page import ReviewPage
from ..pages.settings_page import SettingsPage
from ..pages.workflow_page import WorkflowPage
from zhixing.view.kit.fluent_compat import QLabel, QPushButton
from zhixing.view.kit.fluent_compat import QToolButton


class MainWindow(FluentTemplateWindow):
    # 请求 AppController 执行全局动作：quick-capture / capture / widget
    appActionRequested = Signal(str)
    shown = Signal()     # 主窗口显示（用于隐藏浮窗）
    hidden = Signal()    # 主窗口隐藏（用于显示浮窗）
    restoreBackupRequested = Signal()   # 只读横幅「恢复备份」按钮（#12）

    def __init__(self, context, theme_engine, parent=None):
        settings = getattr(context, "settings", None)
        signature = settings.get(K.K_SIGNATURE, "知行合一") if settings else "知行合一"
        # 标题栏（标题 / 签名 / ⌘K 命令胶囊 / 窗口按钮）由框架窗口内置，
        # 不再继承第三方 FluentTitleBar 自己拼一套。
        super().__init__(parent, "知行 ZhiXing", signature=signature,
                         # 不传 zhixing 的 SettingsService —— 它是业务设置服务，
                         # 不是框架的 UISettings（没有 changed 信号）。框架侧的设置
                         # 由 fluent_bridge 建立的双向同步维护。
                         nav_width=200,
                         size=(1280, 820), min_size=(1024, 700))
        self.ctx = context
        self.theme = theme_engine
        self.commandRequested.connect(
            lambda: self.appActionRequested.emit("command-palette"))
        # 页面（View）
        self.today_page = TodayPage(
            self, settings=context.settings,
            tag_provider=context.task_service.tag_map)
        self.task_page = TaskPage(context.task_service, context.note_service,
                                  context.settings, self,
                                  workflow_service=context.workflow_service)
        self.inbox_page = InboxPage(context.task_service, context.flash_service,
                                    context.note_service, context.settings, self)
        self.note_page = NotePage(context.note_service, context.settings, self)
        self.graph_page = GraphPage(context.graph_service, context.note_service, self)
        self.review_page = ReviewPage(context.review_service, context.settings, self)
        self.workflow_page = WorkflowPage(context.workflow_service,
                                          context.note_service, context.settings, self)
        self.settings_page = SettingsPage(context, self)

        self._add_navigation()
        # 侧边栏：调窄宽度 + 顶部 APP 名称（中英文）随折叠动画；
        # 返回/折叠按钮移到标题栏（删除返回按钮，折叠按钮与标题同行）
        # 折叠/展开按钮保留在侧边栏（menuButton 随宽度动画移动），不再固定到标题栏

        # 初始按当前 displayMode 同步（避免折叠态残留展开文字）
        self._page_history = []
        self.pageChanged.connect(self._remember_page)
        self._remember_page(self.current_index())
        # v0.16 P0-3: 底部快捷新建浮条（仅今日/任务页）
        from ..widget.floating_dock import FloatingDock
        self.floating_dock = FloatingDock(self)
        self.floating_dock.raise_()
        self.floating_dock.taskRequested.connect(
            lambda: self.appActionRequested.emit("quick-capture"))
        self.floating_dock.noteRequested.connect(
            lambda: self.appActionRequested.emit("new-note"))
        self.floating_dock.flashRequested.connect(
            lambda: self.appActionRequested.emit("flash-inbox"))
        # 展开/收起改变 dock 高度 → 重贴右下，否则按收起高度算好的 y 会让展开项溢出裁切。
        self.floating_dock.geometryChanged.connect(self._layout_floating_dock_soon)
        # 主动关闭：点击 dock 之外的任何区域 / 按 Esc 均收起展开项（浮层通用交互）
        QApplication.instance().installEventFilter(self)
        self._sync_dock_page()
        self._install_shortcuts()
        self._build_tray()
        self._apply_material()
        self._build_readonly_banner()

        ThemeEngine.instance().changed.connect(self._on_theme)
        context.bus.settings_changed.connect(self._on_setting_changed)

    # ---------- 导航 ----------
    def _nav_icon_color(self) -> str:
        """导航 idle 图标色：读语义 token fg2（T5：不再硬编码 #888，随主题/模式自愈）。"""
        eng = ThemeEngine.instance()
        return eng.t("fg2", "#6B7280") if eng else "#6B7280"

    def _add_navigation(self):
        # 页面注册：框架用 add_page(widget, title, key, position)。
        # position="bottom" 把「设置」固定在侧边栏底部。
        # 图标传给框架图标名：展开态「图标 + 文字」，折叠态只留图标（用户要求）。
        # 图标由 qfluent_core.icons 按当前主题色渲染，换肤时窗口会自动重渲染。
        for key, title, page, position, icon_name in (
                ("today", "今日", self.today_page, "top", "nav.today"),
                ("tasks", "任务", self.task_page, "top", "nav.tasks"),
                ("inbox", "收件箱", self.inbox_page, "top", "nav.inbox"),
                ("notes", "笔记", self.note_page, "top", "nav.notes"),
                ("workflow", "工作流", self.workflow_page, "top", "nav.workflow"),
                ("graph", "图谱", self.graph_page, "top", "nav.graph"),
                ("review", "回顾", self.review_page, "top", "nav.review"),
                ("settings", "设置", self.settings_page, "bottom", "nav.settings")):
            self.add_page(page, title, key=key, position=position, icon=icon_name)
    # ---------- 兼容既有调用（原 FluentWindow 的 API）----------
    def switchTo(self, widget) -> None:
        # FluentWindow.switchTo(widget)：按页面对象切换。
        # 框架用索引，这里按对象反查，调用方无需改写。
        for index in range(self.page_count()):
            if self.page(index) is widget:
                self.set_current_index(index)
                return

    def setMicaEffectEnabled(self, enabled: bool) -> None:
        # FluentWindow.setMicaEffectEnabled：框架统一走材质接口。
        apply_window_material(self, "mica" if enabled else "solid")

    @property
    def navigationInterface(self):
        # 兼容导航接口：外部只用到折叠状态的读写。
        return _NavInterfaceProxy(self)


    def switch_page(self, index: int):
        pages = [self.today_page, self.task_page, self.inbox_page,
                 self.note_page, self.graph_page, self.review_page]
        if 0 <= index < len(pages):
            self.switchTo(pages[index])

    # ---------- 最近页面（Ctrl+Tab） ----------
    def _remember_page(self, index: int):
        w = self.page(index)
        # 切页时触发当前页面大标题入场动画（淡入 + 上移）
        header = getattr(w, "header", None)
        if header is not None and hasattr(header, "play_enter"):
            header.play_enter()
        self._sync_dock_page()
        if w is None or (self._page_history and self._page_history[-1] is w):
            return
        self._page_history.append(w)
        if len(self._page_history) > 20:
            self._page_history.pop(0)

    def _sync_dock_page(self):
        """v0.16 P0-3: FloatingDock 随当前页显示（今日/任务），并贴右下。"""
        dock = getattr(self, "floating_dock", None)
        if dock is None:
            return
        cur = self.page(self.current_index())
        key = getattr(cur, "objectName", lambda: "")() if cur is not None else ""
        dock.set_page(key)
        self._layout_floating_dock()

    def _layout_floating_dock_soon(self):
        """延到下一帧再定位：展开/收起后 sizeHint 需先经布局结算才是最终高度。"""
        QTimer.singleShot(0, self._layout_floating_dock)

    def eventFilter(self, obj, ev):  # noqa: N802
        """让展开的 FloatingDock 支持「点击外部 / Esc」主动收起。

        dock 是浮层：展开后点页面任何位置或按 Esc 都应关闭，否则只能再点一次
        主按钮才能收起（用户反馈「展开后无法关闭」）。
        """
        dock = getattr(self, "floating_dock", None)
        if dock is not None and getattr(dock, "_open", False):
            if ev.type() == QEvent.MouseButtonPress:
                w = obj if isinstance(obj, QWidget) else None
                if w is not None and not self._is_within_dock(w, dock):
                    dock.collapse()
            elif ev.type() == QEvent.KeyPress and ev.key() == Qt.Key_Escape:
                if dock.collapse():
                    return True
        return super().eventFilter(obj, ev)

    @staticmethod
    def _is_within_dock(widget, dock) -> bool:
        """判断 widget 是否位于 dock 内（含 dock 自身与其子控件）。"""
        w = widget
        while w is not None:
            if w is dock:
                return True
            w = w.parentWidget()
        return False

    def _layout_floating_dock(self):
        dock = getattr(self, "floating_dock", None)
        if dock is None or not dock.isVisible():
            return
        # 定位：内容区右下，距右缘 24 / 底部 14
        try:
            from PySide6.QtCore import QPoint
            stack = self.content_stack()
            tl = stack.mapTo(self, QPoint(0, 0))
            x = tl.x() + stack.width() - dock.width() - 24
            y = tl.y() + stack.height() - dock.height() - 14
            dock.move(max(tl.x(), x), max(tl.y(), y))
            dock.raise_()
        except Exception:  # noqa: BLE001
            pass

    def switch_recent(self):
        """回到上一个页面；再次按下可在最近两页间往返。"""
        if len(self._page_history) >= 2:
            self.switchTo(self._page_history[-2])

    def focus_page_search(self):
        """Ctrl+F：聚焦当前页搜索框。图谱定位节点留待后续里程碑（§11.8.8）。"""
        cur = self.page(self.current_index())
        if cur is self.task_page:
            self.task_page.filter_input.setFocus()
            self.task_page.filter_input.selectAll()
        elif cur is self.note_page:
            self.note_page.search.setFocus()
            self.note_page.search.selectAll()
        elif cur is self.graph_page:
            self.graph_page.focus_node_search()
        # 今日/收件箱/回顾/设置暂无独立搜索框：保持空操作。

    # ---------- 快捷键 ----------
    def _install_shortcuts(self):
        bindings = [
            ("Ctrl+1", lambda: self.switch_page(0)), ("Ctrl+2", lambda: self.switch_page(1)),
            ("Ctrl+3", lambda: self.switch_page(2)), ("Ctrl+4", lambda: self.switch_page(3)),
            ("Ctrl+5", lambda: self.switch_page(4)), ("Ctrl+6", lambda: self.switch_page(5)),
            ("Ctrl+,", lambda: self.switchTo(self.settings_page)),
            ("Ctrl+Tab", self.switch_recent),
            ("Ctrl+F", self.focus_page_search),
        ]
        for key, fn in bindings:
            sc = QShortcut(QKeySequence(key), self)
            sc.activated.connect(fn)

    # ---------- 托盘 ----------
    def _build_tray(self):
        self.tray = QSystemTrayIcon(self)
        self._update_tray_icon()
        self._tray_menu = self._build_tray_menu()
        if sys.platform == "darwin":
            # macOS：setContextMenu 的原生菜单在点击时会触发 Qt cocoa 的
            # [NSEvent clickCount] 崩溃（NSInternalInconsistencyException），
            # 改为通过 activated 信号手动弹出 QMenu 规避。
            self.tray.activated.connect(self._on_tray_activated)
        else:
            self.tray.setContextMenu(self._tray_menu)
            self.tray.activated.connect(self._on_tray_activated)
        self.tray.setToolTip("知行 ZhiXing")
        self.tray.show()

    def _build_tray_menu(self):
        menu = QMenu()
        act_show = QAction("显示主窗口", self)
        act_show.triggered.connect(self._show_main)
        act_quick = QAction("快速添加任务 (Ctrl+Alt+N)", self)
        act_quick.triggered.connect(lambda: self.appActionRequested.emit("quick-capture"))
        act_capture = QAction("划词捕获 (Ctrl+Shift+S)", self)
        act_capture.triggered.connect(lambda: self.appActionRequested.emit("capture"))
        act_widget = QAction("显示/隐藏浮窗", self)
        act_widget.triggered.connect(lambda: self.appActionRequested.emit("widget"))
        act_exit = QAction("退出", self)
        act_exit.triggered.connect(self._really_quit)
        for a in (act_show, act_quick, act_capture, act_widget):
            menu.addAction(a)
        menu.addSeparator()
        menu.addAction(act_exit)
        return menu

    def _update_tray_icon(self):
        eng = ThemeEngine.instance()
        color = eng.t("fg2", "#666666") if eng else "#666666"
        self.tray.setIcon(QIcon(icons.pixmap("nav.flash", color, 64, 2.0)))

    def _on_tray_activated(self, reason):
        if sys.platform == "darwin" and reason in (
                QSystemTrayIcon.Trigger, QSystemTrayIcon.Context):
            self._tray_menu.popup(QCursor.pos())
        elif reason == QSystemTrayIcon.Trigger:
            self._show_main()

    def _show_main(self):
        self.show()
        self.raise_()
        self.activateWindow()

    def showEvent(self, ev):  # noqa: N802
        super().showEvent(ev)
        # v0.16 P0-3: 首次显示后确保 FloatingDock 定位（构造期窗口未布局）
        QTimer.singleShot(0, self._sync_dock_page)
        self.shown.emit()

    def hideEvent(self, ev):  # noqa: N802
        super().hideEvent(ev)
        self.hidden.emit()

    def _really_quit(self):
        self._quitting = True
        self.tray.hide()
        QApplication.instance().quit()

    def closeEvent(self, ev):  # noqa: N802
        if getattr(self, "_quitting", False):
            super().closeEvent(ev)
            return
        if self.ctx.settings.get_bool(K.K_CLOSE_TO_WIDGET, True):
            ev.ignore()
            self.hide()
            self.tray.showMessage("知行", "已最小化到托盘，浮窗仍在运行", QSystemTrayIcon.Information,
                                  2000)
        else:
            self._really_quit()
            ev.accept()

    # ---------- 主题 ----------
    def _apply_material(self):
        try:
            if self.ctx.settings.get_bool(K.K_MICA, True):
                apply_window_material(self, "mica")
        except Exception:
            pass

    def _on_theme(self):
        self._update_tray_icon()
        # T5: 导航 idle 图标随主题 token 重建（setIcon 由 NavigationItem 提供）
        try:
            color = self._nav_icon_color()
            for item, name in getattr(self, "_nav_items", {}).values():
                item.setIcon(icons.icon(name, color, 18))
        except Exception:
            pass

    def _on_setting_changed(self, key: str):
        if key == K.K_SIGNATURE:
            self.set_signature(self.ctx.settings.get(K.K_SIGNATURE, "知行合一"))


    # ---------- 只读横幅（数据库迁移失败，#12） ----------
    def _build_readonly_banner(self):
        self.readonly_banner = QFrame(self)
        self.readonly_banner.setObjectName("readonlyBanner")
        lay = QHBoxLayout(self.readonly_banner)
        lay.setContentsMargins(14, 8, 14, 8)
        self.readonly_label = QLabel("")
        self.readonly_label.setWordWrap(True)
        lay.addWidget(self.readonly_label, 1)
        self.restore_btn = QPushButton("恢复备份")
        self.restore_btn.clicked.connect(self.restoreBackupRequested.emit)
        lay.addWidget(self.restore_btn)
        self.readonly_banner.hide()
        self._restyle_readonly_banner()

    def _restyle_readonly_banner(self):
        if getattr(self, "readonly_banner", None) is None:
            return
        eng = ThemeEngine.instance()
        tokens = eng.tokens if eng else {}
        danger = tokens.get("danger", "#DC2626")
        layer = tokens.get("layer", "#FFFFFF")
        self.readonly_banner.setStyleSheet(
            f"#readonlyBanner {{ background: {layer}; border-bottom: 2px solid {danger}; }}"
            f"QLabel {{ color: {danger}; background: transparent; }}")

    def show_readonly_banner(self, message: str):
        self.readonly_label.setText(message)
        self.readonly_banner.setVisible(True)
        self.readonly_banner.raise_()
        self._position_banner()

    def _position_banner(self):
        if getattr(self, "readonly_banner", None) is None:
            return
        h = max(40, self.readonly_banner.sizeHint().height())
        self.readonly_banner.setGeometry(0, 0, self.width(), h)

    def resizeEvent(self, ev):  # noqa: N802
        super().resizeEvent(ev)
        self._position_banner()
        self._layout_floating_dock()


class _NavInterfaceProxy:
    """FluentWindow.navigationInterface 的最小兼容替身。"""

    def __init__(self, window) -> None:
        self._window = window

    def setCollapsed(self, collapsed: bool) -> None:
        self._window.set_navigation_expanded(not collapsed, animate=True)

    def isCollapsed(self) -> bool:
        value = self._window.navigation_expanded
        return not (value() if callable(value) else value)

    def setExpandWidth(self, width: int) -> None:
        self._window.set_nav_width(width)
