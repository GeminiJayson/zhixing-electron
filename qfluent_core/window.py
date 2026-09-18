# -*- coding: utf-8 -*-
"""FluentTemplateWindow —— 框架层窗口壳：纯视觉，不含任何业务逻辑。

解耦契约对照：
  §1 只管皮肤 / 绘制 / 动画 / 基础信号 / 纯 UI 状态（是否展开、当前页、是否最大化）。
  §2 直接继承 QWidget：宿主原有的 QVBoxLayout / QHBoxLayout 无需推倒重来即可嵌入。
  §3 皮肤全部位于 resources/qss/*.qss 模板，代码内不写死样式。
  §4 颜色 / 圆角 / 字号一律取 ThemeManager token；渲染时按 UISettings 注入 overrides。
  §5 全量 Type Hints，便于直接在旧项目里实例化替换。
  §6 主题 / 字号 / 控件高度 / 圆角 / 动效开关来自 UISettings。
  §7 自订阅 UISettings.changed 与 ThemeManager.changed，配置一变界面自愈，无需重启。

生命周期约定：本窗口不注册任何全局表；所有订阅都是「应用级单例 sender -> 本窗口
receiver」的 Qt 连接，窗口销毁时 Qt 自动断开，不会造成已关闭界面被残留引用。
"""
from __future__ import annotations

import sys

from typing import Dict, List, Optional, Tuple

from PySide6.QtCore import (
    Property, QPoint, QRect, QSize, Qt, QTimer, Signal,
)
from PySide6.QtCore import QEvent
from PySide6.QtGui import QIcon, QMouseEvent
from PySide6.QtWidgets import (
    QFrame, QHBoxLayout, QLabel, QPushButton, QSizePolicy, QStackedWidget,
    QToolButton, QVBoxLayout, QWidget,
)

from . import icons, motion
from .components.base import token_px
from .platform import (corner_strategy, is_windows, shortcut_hint,
                       window_shadow)
from .settings import K, UISettings
from .theme import ThemeManager

__all__ = ["FluentTemplateWindow", "TitleBar", "NavPanel", "NavButton", "NavPage"]


class NavPage(object):
    """一个导航页的纯 UI 描述（不持有业务语义）。"""

    def __init__(self, widget: QWidget, title: str, key: Optional[str] = None,
                 icon: Optional[QIcon] = None, position: str = "top",
                 tooltip: str = "") -> None:
        self.widget: QWidget = widget
        self.title: str = title
        self.key: Optional[str] = key
        self.icon: Optional[QIcon] = icon
        self.position: str = position if position in ("top", "bottom") else "top"
        self.tooltip: str = tooltip or title


class NavButton(QToolButton):
    """侧边导航按钮：展开态「图标 + 文字」，折叠态仅图标（无图标则取标题首字）。"""

    def __init__(self, index: int, title: str, icon: Optional[QIcon] = None,
                 parent: Optional[QWidget] = None, tooltip: str = "",
                 icon_text: str = "", icon_name: str = "") -> None:
        super().__init__(parent)
        self.setObjectName("FCNavButton")
        self.index: int = index
        self._title: str = title
        self._icon: Optional[QIcon] = icon
        # 记住图标名：QIcon 是静态 pixmap，换主题色后只能按名字重渲染
        self._icon_name: str = icon_name
        # 折叠态显示的字形；不给就用标题首字（业务可以传符号当图标用）
        self._icon_text: str = icon_text
        self.setCheckable(True)
        self.setAutoRaise(True)
        self.setCursor(Qt.PointingHandCursor)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setIconSize(QSize(18, 18))
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.setToolTip(tooltip or title)
        self.setAccessibleName(title)          # 无障碍：读屏可念出导航项
        if icon is not None and not icon.isNull():
            self.setIcon(icon)
        self.set_expanded(True)

    def refresh_icon(self, icon=None) -> None:
        # 主题色变了 QIcon 不会自动更新（它是静态 pixmap），所以要能重设。
        if icon is None and self._icon_name:
            icon = self._icon_name
        if isinstance(icon, str):
            icon = icons.icon(icon, size=18)
        if icon is None or icon.isNull():
            return
        self._icon = icon
        self.setIcon(icon)

    def set_expanded(self, expanded: bool) -> None:
        """纯 UI 状态切换：折叠时把文字转成图标块（不改变任何业务语义）。

        有 QIcon 时直接用图标；没有图标时用 icon_text / 标题首字作为字形，
        并由 QSS 的 [collapsed="true"] 把它收成居中的方形图标块。
        """
        has_icon = self._icon is not None and not self._icon.isNull()
        self.setProperty("collapsed", "false" if expanded else "true")
        if has_icon:
            self.setToolButtonStyle(Qt.ToolButtonTextBesideIcon if expanded
                                    else Qt.ToolButtonIconOnly)
            self.setText(self._title)
        else:
            self.setToolButtonStyle(Qt.ToolButtonTextOnly)
            glyph = self._icon_text or self._title[:1]
            self.setText(self._title if expanded else glyph)
        self.setToolTip(self._title)
        style = self.style()
        style.unpolish(self)
        style.polish(self)


class NavPanel(QFrame):
    """侧边导航面板：按钮分组（top/bottom）+ 选中指示条动画。"""

    def __init__(self, parent: Optional[QWidget] = None, *,
                 width: int = 200, collapsed_width: int = 48) -> None:
        super().__init__(parent)
        self.setObjectName("FCNavPanel")
        self.expanded_width: int = width
        self.collapsed_width: int = collapsed_width
        self._expanded: bool = True
        self.setFixedWidth(width)
        root = QVBoxLayout(self)
        root.setContentsMargins(6, 8, 6, 8)
        root.setSpacing(2)
        self._top = QVBoxLayout()
        self._top.setSpacing(2)
        self._bottom = QVBoxLayout()
        self._bottom.setSpacing(2)
        self._footer = QVBoxLayout()
        self._footer.setSpacing(4)
        root.addLayout(self._top)
        root.addStretch(1)
        root.addLayout(self._footer)      # 吸附式按钮（如折叠开关）的落点
        root.addLayout(self._bottom)
        self._indicator = QFrame(self)
        self._indicator.setObjectName("FCNavIndicator")
        self._indicator.setFixedWidth(token_px(self, 'indicator-w', 3))
        self._indicator.hide()

    def add_footer(self, widget: QWidget) -> QWidget:
        """把吸附式控件挂到导航栏底部（不占用标题行）。"""
        self._footer.addWidget(widget)
        return widget

    def add_button(self, button: NavButton, position: str = "top") -> None:
        target = self._bottom if position == "bottom" else self._top
        target.addWidget(button)

    def set_expanded(self, expanded: bool) -> None:
        if expanded == self._expanded:
            return
        self._expanded = expanded
        for btn in self.findChildren(NavButton):
            btn.set_expanded(expanded)
        QTimer.singleShot(0, lambda: self.sync_indicator(animate=False))

    @property
    def expanded(self) -> bool:
        return self._expanded

    def sync_indicator(self, button: Optional[QToolButton] = None,
                       animate: bool = True) -> None:
        """把选中指示条对齐到按钮（纯视觉动画）。"""
        if button is None:
            button = self._checked_button()
        if button is None:
            self._indicator.hide()
            return
        target = QRect(2, button.y() + 4, 3, max(12, button.height() - 8))
        if not self._indicator.isVisible():
            self._indicator.setGeometry(target)
            self._indicator.show()
            self._indicator.raise_()
            return
        if not animate or self._indicator.geometry() == target:
            self._indicator.setGeometry(target)
            return
        motion.animate(self._indicator, "geometry", self._indicator.geometry(),
                       target, dur="panel", easing="panel")

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        self.sync_indicator(animate=False)

    def _checked_button(self) -> Optional[NavButton]:
        for btn in self.findChildren(NavButton):
            if btn.isChecked():
                return btn
        return None


class TitleBar(QFrame):
    """自绘标题栏（纯视觉）：应用名 + 签名 + 命令胶囊 + 窗口按钮 + 拖动/双击。"""

    commandRequested = Signal()
    minimizeRequested = Signal()
    maximizeRequested = Signal()
    closeRequested = Signal()
    doubleClicked = Signal()

    def __init__(self, parent: QWidget, *, title: str = "", signature: str = "",
                 command_placeholder: Optional[str] = None,
                 height: int = 48, capsule_height: int = 26,
                 show_window_buttons: bool = True,
                 show_nav_toggle: bool = True) -> None:
        super().__init__(parent)
        self.setObjectName("FCTitleBar")
        self.setFixedHeight(height)
        self.capsule_height: int = capsule_height
        self._drag_offset: Optional[QPoint] = None

        layout = QHBoxLayout(self)
        layout.setContentsMargins(8, 0, 8, 0)
        layout.setSpacing(4)

        self.nav_toggle: Optional[QToolButton] = None
        if show_nav_toggle:
            self.nav_toggle = QToolButton(self)
            self.nav_toggle.setObjectName("FCNavToggle")
            self.nav_toggle.setIcon(icons.icon("menu", size=16))
            self.nav_toggle.setIconSize(QSize(16, 16))
            self.nav_toggle.setCursor(Qt.PointingHandCursor)
            self.nav_toggle.setToolTip("展开/折叠导航")
            self.nav_toggle.setAccessibleName("展开或折叠侧边导航")
            layout.addWidget(self.nav_toggle)

        self.title_label = QLabel(title, self)

        self.titleLabel = self.title_label
        self.title_label.setObjectName("FCTitleLabel")
        layout.addWidget(self.title_label, 0, Qt.AlignLeft | Qt.AlignVCenter)

        self.signature_label = QLabel(signature, self)
        self.signature_label.setObjectName("FCSignatureLabel")
        self.signature_label.setVisible(bool(signature))
        layout.addWidget(self.signature_label, 0, Qt.AlignLeft | Qt.AlignVCenter)

        self.command_button: Optional[QPushButton] = None
        # 提示里的修饰符必须按平台生成：写死 ⌘ 在 Windows 上就是错的。
        #   None -> 不显示胶囊（保持原有语义）
        #   ""   -> 用平台默认文案（⌘K / Ctrl+K）
        #   其它  -> 原样使用
        hint = command_placeholder
        if hint == "":
            hint = "搜索任务、笔记、命令… " + shortcut_hint("K")
        if hint:
            layout.addStretch(1)
            self.command_button = QPushButton(hint, self)
            self.command_button.setObjectName("FCCommandCapsule")
            self.command_button.setCursor(Qt.PointingHandCursor)
            self.command_button.setFixedHeight(capsule_height)
            self.command_button.setAccessibleName(
                "命令搜索（" + shortcut_hint("K") + "）")
            self.command_button.clicked.connect(self.commandRequested.emit)
            layout.addWidget(self.command_button, 0, Qt.AlignCenter)

        layout.addStretch(1)

        self._toolbar = QHBoxLayout()
        self._toolbar.setSpacing(4)
        layout.addLayout(self._toolbar)

        self.min_button: Optional[QToolButton] = None
        self.max_button: Optional[QToolButton] = None
        self.close_button: Optional[QToolButton] = None
        if show_window_buttons:
            self.min_button = self._make_win_button("win-minimize", "最小化", layout)
            self.min_button.clicked.connect(self.minimizeRequested.emit)
            self.max_button = self._make_win_button("win-maximize", "最大化/还原", layout)
            self.max_button.clicked.connect(self.maximizeRequested.emit)
            self.close_button = self._make_win_button("close", "关闭", layout,
                                                      close=True)
            self.close_button.clicked.connect(self.closeRequested.emit)


    def _make_win_button(self, icon_name: str, tip: str, layout: QHBoxLayout,
                         close: bool = False) -> QToolButton:
        btn = QToolButton(self)
        btn.setObjectName("FCWinButtonClose" if close else "FCWinButton")
        # 用 SVG 图标而不是 – □ ✕ 字符：字符的字面宽度/基线随字体变化，
        # 而且跟随不了主题色。关闭按钮还需要 Active 态 —— QSS 会让它 hover
        # 时变红，静态色图标会糊在红底里看不见。
        btn.setIcon(icons.icon(icon_name, size=16,
                                active_color="#FFFFFF" if close else None))
        btn.setIconSize(QSize(16, 16))
        btn.setToolTip(tip)
        btn.setAccessibleName(tip)
        btn.setCursor(Qt.PointingHandCursor)
        btn.setFocusPolicy(Qt.TabFocus)
        layout.addWidget(btn)
        return btn

    # ---------- 标题栏扩展位（业务注入自己的工具按钮，如设置/帮助） ----------
    def add_toolbar_widget(self, widget: QWidget) -> QWidget:
        self._toolbar.addWidget(widget)
        return widget

    def set_title(self, text: str) -> None:
        self.title_label.setText(text)

    def set_signature(self, text: str) -> None:
        self.signature_label.setText(text)
        self.signature_label.setVisible(bool(text))

    # ---------- 拖动 / 双击（原生优先，跨平台兜底） ----------
    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if event.button() == Qt.LeftButton:
            window = self.window()
            handle = window.windowHandle()
            if handle is not None:
                try:
                    if handle.startSystemMove():       # 原生拖动（含系统贴边行为）
                        return
                except Exception:  # noqa: BLE001 —— 平台不支持时回退手写位移
                    pass
            self._drag_offset = (event.globalPosition().toPoint()
                                 - window.frameGeometry().topLeft())
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._drag_offset is not None and (event.buttons() & Qt.LeftButton):
            self.window().move(event.globalPosition().toPoint() - self._drag_offset)
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        self._drag_offset = None
        super().mouseReleaseEvent(event)

    def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        self.doubleClicked.emit()
        super().mouseDoubleClickEvent(event)


class FluentTemplateWindow(QWidget):
    """无边框窗口模板：自绘标题栏 + 侧边导航 + 内容栈，纯 UI。

    业务层只需连接信号，不必重写任何绘制逻辑：

        win = FluentTemplateWindow(None, "知行 ZhiXing", command_placeholder=" 搜索… ")
        win.add_page(task_widget, "任务")
        win.commandRequested.connect(self.open_command_palette)   # 框架 -> 业务
        win.closeRequested.connect(self.persist_before_close)
        UISettings.instance().fontChanged.connect(self.reflow_business_rows)
    """

    # ---- 基础交互信号（业务层连接点） ----
    pageChangeRequested = Signal(int)     # 用户点击导航（切换发生前）
    pageChanged = Signal(int)             # 页面已切换
    navigationToggled = Signal(bool)      # 侧边栏展开(True)/折叠(False)
    commandRequested = Signal()           # 标题栏命令行胶囊被点击
    closeRequested = Signal()             # 关闭按钮被点击（业务可先处理再关）
    minimizeRequested = Signal()
    maximizeToggled = Signal(bool)        # True = 已最大化
    titleChanged = Signal(str)

    # Windows 上窗口边缘还带系统阴影/DPI 缩放，6px 抓不住；换宽一点。
    # Windows 上窗口边缘还带系统阴影/DPI 缩放，6px 抓不住；换宽一点。
    _RESIZE_MARGIN = 8 if is_windows() else 6

    def __init__(self, parent: Optional[QWidget] = None, title: str = "",
                 *, signature: str = "",
                 command_placeholder: Optional[str] = None,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None,
                 nav_width: int = 200, nav_collapsed_width: int = 48,
                 nav_collapsible: bool = True,
                 content_margins: Tuple[int, int, int, int] = (0, 0, 0, 0),
                 title_bar_height: int = 48, capsule_height: int = 26,
                 size: Tuple[int, int] = (1280, 820),
                 min_size: Tuple[int, int] = (960, 640),
                 frameless: bool = True, resizable: bool = True,
                 window_buttons: Optional[bool] = None) -> None:
        super().__init__(parent)
        self.setObjectName("FluentTemplateWindow")
        self._settings: UISettings = settings or UISettings.instance()
        self._theme: ThemeManager = theme or ThemeManager.instance()
        self._pages: List[NavPage] = []
        self._buttons: Dict[int, NavButton] = {}
        self._nav_width: int = nav_width
        self._nav_expanded_width: int = nav_width
        self._nav_collapsed_width: int = nav_collapsed_width
        self._nav_collapsible: bool = nav_collapsible
        self._resizable: bool = resizable
        self._auto_close_on_request: bool = True
        self._auto_switch_on_request: bool = True
        self._resize_edge: Qt.Edge = Qt.Edge(0)
        self._resize_geo: QRect = QRect()
        self._resize_global: QPoint = QPoint()
        self._maximized: bool = False
        self._material_effective: str = "solid"

        self.setMinimumSize(*min_size)
        self.resize(*size)
        self.setMouseTracking(True)
        self._frameless = bool(frameless)
        if frameless:
            self.setWindowFlag(Qt.FramelessWindowHint, True)
            # 圆角方案按平台分两种：
            #  macOS/Linux：root 透明，四角由标题栏/导航/内容区各自拼出；
            #    子块背景不透明，不会透出桌面（solid 材质下与实色窗口一致）。
            #  Windows：**不能用透明背景** —— 它会让边缘锯齿、丢系统阴影、
            #    拖动时闪烁；而且合成器不会按 QSS 圆角裁剪窗口。改用 DWM 圆角
            #    （见 showEvent 里的 apply_window_corners），由系统真正裁掉四角。
            self._use_native_corners = corner_strategy() == "dwm"
            if not self._use_native_corners:
                self.setAttribute(Qt.WA_TranslucentBackground, True)

        # ---- 壳体布局：标题栏 + （侧边导航 | 内容栈） ----
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        show_buttons = frameless if window_buttons is None else window_buttons
        self._title_bar = TitleBar(
            self, title=title, signature=signature,
            command_placeholder=command_placeholder,
            height=title_bar_height, capsule_height=capsule_height,
            show_window_buttons=show_buttons,
            show_nav_toggle=False)      # 折叠按钮不占标题行，改挂到导航栏底部
        root.addWidget(self._title_bar)

        body = QHBoxLayout()
        body.setContentsMargins(*content_margins)
        body.setSpacing(0)
        root.addLayout(body, 1)

        self._nav = NavPanel(self, width=nav_width, collapsed_width=nav_collapsed_width)
        body.addWidget(self._nav)
        # 折叠按钮吸附在导航栏的右边界上（跨在侧边栏与内容区的交界处）。
        # 父级必须是窗口而不是导航栏：子控件会被父级裁剪，跨不出边界。
        self._nav_toggle: Optional[QToolButton] = None
        if self._nav_collapsible:
            self._nav_toggle = QToolButton(self)
            self._nav_toggle.setObjectName("FCNavToggle")
            self._nav_toggle.setText("«")
            self._nav_toggle.setCursor(Qt.PointingHandCursor)
            self._nav_toggle.setFocusPolicy(Qt.TabFocus)
            toggle_size = self._theme.px("control-h-sm", 22)
            self._nav_toggle.setFixedSize(toggle_size, toggle_size)
            self._nav_toggle.setToolTip("折叠导航")
            self._nav_toggle.setAccessibleName("折叠或展开侧边导航")
            self._nav_toggle.clicked.connect(self.toggle_navigation)

        self._stack = QStackedWidget(self)
        self._stack.setObjectName("FCContentStack")
        content = QFrame(self)
        content.setObjectName("FCContent")
        content_layout = QVBoxLayout(content)
        content_layout.setContentsMargins(0, 0, 0, 0)
        content_layout.addWidget(self._stack)
        body.addWidget(content, 1)

        # ---- 信号接线：框架内部默认行为 ----
        self._title_bar.doubleClicked.connect(self.toggle_maximize)
        self._title_bar.minimizeRequested.connect(self.showMinimized)
        self._title_bar.maximizeRequested.connect(self.toggle_maximize)
        self._title_bar.closeRequested.connect(self._on_close_clicked)
        self._title_bar.commandRequested.connect(self.commandRequested.emit)

        # ---- 配置 / 主题变更自愈（契约 §7） ----
        self._settings.changed.connect(self._on_setting_changed)
        self._theme.changed.connect(self._on_theme_changed)
        motion.bind_settings(self._settings)
        # 主题包 / 强调色跟着 UISettings 走：改设置即换肤，不需要业务接线
        self._theme.bind_settings(self._settings)

        self._restyle()
        self._apply_material()

    # =============== 页面管理（纯 UI 装配） ===============
    def add_page(self, widget: QWidget, title: str, key: Optional[str] = None,
                 icon=None, position: str = "top",
                 tooltip: str = "") -> int:
        """挂载一个页面并生成对应导航项，返回页面索引。

        icon 既可以是 QIcon，也可以是**框架图标名**（str）—— 后者更常用，
        而且会跟随主题色。导航项有图标时，折叠态显示图标而不是首字。
        """
        icon_name = icon if isinstance(icon, str) else ""
        if isinstance(icon, str):
            icon = icons.icon(icon, size=18) if icon else None
        page = NavPage(widget, title, key, icon, position, tooltip)
        self._pages.append(page)
        index = self._stack.addWidget(widget)
        button = NavButton(index, title, icon, self._nav, tooltip=page.tooltip,
                           icon_name=icon_name)
        button.clicked.connect(lambda _checked=False, i=index: self._on_nav_clicked(i))
        button.set_expanded(self._nav.expanded)
        self._nav.add_button(button, page.position)
        self._buttons[index] = button
        if index == 0:
            self.set_current_index(0, animate=False)
        return index

    def content_stack(self):
        # 内容区容器（页面栈）。业务需要它的几何做浮层定位时用这个，
        # 而不是去访问私有属性。
        return self._stack

    def page(self, index: int) -> Optional[QWidget]:
        if 0 <= index < self._stack.count():
            return self._stack.widget(index)
        return None

    def page_index(self, key: str) -> int:
        """按业务 key 查页面索引；不存在返回 -1（导航与业务解耦的桥）。"""
        for i, page in enumerate(self._pages):
            if page.key == key:
                return i
        return -1

    def page_count(self) -> int:
        return self._stack.count()

    def current_index(self) -> int:
        return self._stack.currentIndex()

    def set_current_index(self, index: int, *, animate: bool = True) -> None:
        """程序化切页：不发 pageChangeRequested（那是用户意图），只发 pageChanged。"""
        if not (0 <= index < self._stack.count()):
            return
        changed = index != self._stack.currentIndex()
        self._stack.setCurrentIndex(index)
        self._sync_checked()
        self._sync_indicator()
        if changed and animate:
            motion.fade_in(self._stack.currentWidget(), "page", 4)
        if changed:
            self.pageChanged.emit(index)

    def _on_nav_clicked(self, index: int) -> None:
        self.pageChangeRequested.emit(index)
        if self._auto_switch_on_request:
            self.set_current_index(index)

    def _sync_checked(self) -> None:
        current = self._stack.currentIndex()
        for index, button in self._buttons.items():
            button.setChecked(index == current)

    def _sync_indicator(self) -> None:
        button = self._buttons.get(self._stack.currentIndex())
        if button is not None:
            self._nav.sync_indicator(button, animate=True)

    # =============== 侧边导航折叠（纯视觉动画） ===============
    @property
    def navigation_expanded(self) -> bool:
        return self._nav_width > self._nav_collapsed_width + 16

    def get_nav_width(self) -> int:
        return self._nav_width

    def set_nav_width(self, value: int) -> None:
        self._nav_width = int(value)
        self._nav.setFixedWidth(self._nav_width)
        self._nav.set_expanded(self.navigation_expanded)
        if self._nav_toggle is not None:
            expanded = self.navigation_expanded
            self._nav_toggle.setText("‹" if expanded else "›")
            self._nav_toggle.setToolTip("折叠导航" if expanded else "展开导航")
        self._position_nav_toggle()

    #: 供 QPropertyAnimation 驱动的纯 UI 属性（折叠动画）
    navWidth = Property(int, get_nav_width, set_nav_width)

    def set_navigation_expanded(self, expanded: bool, *, animate: bool = True) -> None:
        if not self._nav_collapsible:
            return
        target = self._nav_expanded_width if expanded else self._nav_collapsed_width
        if target == self._nav_width:
            return
        if not animate:
            self.set_nav_width(target)
            self.navigationToggled.emit(expanded)
            return

        def _done() -> None:
            self.set_nav_width(target)
            self.navigationToggled.emit(self.navigation_expanded)

        motion.animate(self, "navWidth", self._nav_width, target,
                       dur="panel", easing="panel", on_done=_done)

    def _position_nav_toggle(self) -> None:
        """把折叠按钮钉在导航栏右边界的中点上（一半在导航上、一半在内容区）。"""
        if self._nav_toggle is None:
            return
        width = self._nav_toggle.width()
        height = self._nav_toggle.height()
        nav_geo = self._nav.geometry()
        # 水平：钉在右边界中点（一半压住导航、一半露在内容区）
        x = nav_geo.x() + nav_geo.width() - width // 2
        # 垂直：在导航栏内居中（用高度算，不是宽度）
        y = nav_geo.y() + max(8, (nav_geo.height() - height) // 2)
        self._nav_toggle.move(x, y)
        self._nav_toggle.raise_()

    def toggle_navigation(self) -> None:
        self.set_navigation_expanded(not self.navigation_expanded)

    # =============== 标题栏（纯 UI 转发） ===============
    @property
    def title_bar(self) -> TitleBar:
        return self._title_bar

    def set_title(self, text: str) -> None:
        self._title_bar.set_title(text)
        self.titleChanged.emit(text)

    def title(self) -> str:
        return self._title_bar.title_label.text()

    def set_signature(self, text: str) -> None:
        """标题栏签名文本（业务文案由外部注入，框架不含任何写死文本）。"""
        self._title_bar.set_signature(text)

    def add_title_tool(self, widget: QWidget) -> QWidget:
        """往标题栏右侧扩展位注入业务控件（设置/帮助/账号等）。"""
        return self._title_bar.add_toolbar_widget(widget)

    def set_auto_close_on_request(self, enabled: bool) -> None:
        """关闭按钮是否自动 close()。业务需要完全接管（如最小化到托盘）时置 False。"""
        self._auto_close_on_request = enabled

    def set_auto_switch_on_request(self, enabled: bool) -> None:
        """点导航后是否自动切页。业务需要做进入闸门（校验/准备）时置 False，
        然后自行调用 set_current_index() 放行。"""
        self._auto_switch_on_request = enabled

    def _on_close_clicked(self) -> None:
        self.closeRequested.emit()
        if self._auto_close_on_request:
            self.close()

    # =============== 窗口控制（无边框） ===============
    def toggle_maximize(self) -> None:
        if self.isMaximized():
            self.showNormal()
        else:
            self.showMaximized()
        self._maximized = self.isMaximized()
        if self._title_bar.max_button is not None:
            self._title_bar.max_button.setIcon(
                icons.icon("win-restore" if self._maximized else "win-maximize",
                           size=16))
        self.maximizeToggled.emit(self._maximized)

    def _edge_at(self, pos: QPoint) -> Qt.Edge:
        margin = self._RESIZE_MARGIN
        edge = Qt.Edge(0)
        if pos.x() <= margin:
            edge |= Qt.LeftEdge
        if pos.x() >= self.width() - margin:
            edge |= Qt.RightEdge
        if pos.y() <= margin:
            edge |= Qt.TopEdge
        if pos.y() >= self.height() - margin:
            edge |= Qt.BottomEdge
        return edge

    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._resizable and event.button() == Qt.LeftButton:
            edge = self._edge_at(event.position().toPoint())
            if edge:
                handle = self.windowHandle()
                started = False
                if handle is not None:
                    try:
                        started = bool(handle.startSystemResize(edge))
                    except Exception:  # noqa: BLE001 —— 平台不支持则手写回退
                        started = False
                if started:
                    return
                self._resize_edge = edge
                self._resize_geo = self.geometry()
                self._resize_global = event.globalPosition().toPoint()
                event.accept()
                return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._resize_edge:
            self._apply_resize(event.globalPosition().toPoint())
            event.accept()
            return
        if self._resizable:
            self._update_resize_cursor(event.position().toPoint())
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._resize_edge:
            self._resize_edge = Qt.Edge(0)
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def leaveEvent(self, event: QEvent) -> None:  # noqa: N802
        if self._resizable:
            self.unsetCursor()
        super().leaveEvent(event)

    def _apply_resize(self, global_pos: QPoint) -> None:
        delta = global_pos - self._resize_global
        geo = QRect(self._resize_geo)
        edge = self._resize_edge
        min_w, min_h = self.minimumWidth(), self.minimumHeight()
        if edge & Qt.LeftEdge:
            geo.setLeft(min(geo.left() + delta.x(), geo.right() - min_w))
        if edge & Qt.RightEdge:
            geo.setRight(max(geo.right() + delta.x(), geo.left() + min_w))
        if edge & Qt.TopEdge:
            geo.setTop(min(geo.top() + delta.y(), geo.bottom() - min_h))
        if edge & Qt.BottomEdge:
            geo.setBottom(max(geo.bottom() + delta.y(), geo.top() + min_h))
        self.setGeometry(geo)

    def _update_resize_cursor(self, pos: QPoint) -> None:
        edge = self._edge_at(pos)
        if edge in (Qt.LeftEdge | Qt.TopEdge, Qt.RightEdge | Qt.BottomEdge):
            self.setCursor(Qt.SizeFDiagCursor)
        elif edge in (Qt.RightEdge | Qt.TopEdge, Qt.LeftEdge | Qt.BottomEdge):
            self.setCursor(Qt.SizeBDiagCursor)
        elif edge in (Qt.TopEdge, Qt.BottomEdge):
            self.setCursor(Qt.SizeVerCursor)
        elif edge in (Qt.LeftEdge, Qt.RightEdge):
            self.setCursor(Qt.SizeHorCursor)
        else:
            self.unsetCursor()

    # =============== 皮肤 / 配置自愈 ===============
    def render_tokens(self) -> Dict[str, str]:
        """本次渲染注入的 UI 配置覆盖（圆角 / 字号 / 控件高度 / 显示材质）。

        统一走 ThemeManager.render_tokens()：圆角一次派生 sm/ctl/md/lg 四档，
        材质一次改写所有「面」token —— 避免窗口与组件各写一份而出现不统一。
        """
        overrides = self._theme.render_tokens(self._settings)
        overrides["capsule-radius"] = f"{self._title_bar.capsule_height // 2}px"
        return overrides

    def _restyle(self) -> None:
        """按当前 token + UI 配置重建窗口皮肤（QSS 模板 -> 样式表）。"""
        # 提示框是 Qt 自建的顶层窗口，不在本窗口样式表的作用域里，单装补丁
        from .tooltip import install as install_tooltip
        install_tooltip()
        self.setStyleSheet(self._theme.style_sheet(
            "base", "components", "window", overrides=self.render_tokens()))
        self._sync_checked()
        self._sync_indicator()

    def _on_theme_changed(self) -> None:
        # 导航图标是按主题色渲染的静态 pixmap，换肤后必须重渲染，否则停留在旧色
        for button in self._buttons.values():
            button.refresh_icon()
        self._restyle()
        self.update()

    def _apply_material(self) -> None:
        """显示材质：窗口层透明 + 平台合成（Mica/Acrylic 不可用时自动退化）。"""
        from . import material as material_mod
        chosen = str(self._settings.get(K.MATERIAL, "solid"))
        self._material_effective = material_mod.apply_window_material(
            self, chosen, keep_translucent=getattr(self, "_frameless", False))

    @property
    def material(self) -> str:
        """当前实际生效的材质名（可能是退化后的档位）。"""
        return self._material_effective

    def available_materials(self) -> Dict[str, bool]:
        """各材质在当前平台的可用性（UI 据此禁用不可用项）。"""
        from . import material as material_mod
        return material_mod.platform_support()

    def _on_setting_changed(self, key: str, _value: object) -> None:
        """UI 配置变更 -> 即时刷新（契约 §6/§7，无需重启）。"""
        if key in (K.FONT_SIZE, K.CONTROL_HEIGHT, K.RADIUS):
            self._restyle()
        elif key == K.THEME_MODE:
            mode = str(_value)
            # "system" 由业务真源解析；已被外部真源接管时框架不抢方向盘
            if mode in ("light", "dark") and not self._theme.is_external:
                self._theme.set_mode(mode)
        elif key == K.MATERIAL:
            self._apply_material()          # 窗口层透明 + 平台合成
            self._restyle()                 # 面 token 同步换材质

    # =============== Qt 事件 ===============
    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        self._position_nav_toggle()

    def showEvent(self, event) -> None:  # noqa: N802
        super().showEvent(event)
        QTimer.singleShot(0, lambda: self._nav.sync_indicator(animate=False))
        QTimer.singleShot(0, lambda: self._nav.set_expanded(self.navigation_expanded))
        # 平台材质需要有效的 windowHandle，首次显示后再应用一次
        QTimer.singleShot(0, self._apply_material)
        if not getattr(self, "_use_native_corners", False):
            # macOS 的无边框窗口没有系统阴影，不补就比原生窗口「扁」。
            # Windows 由 DWM 自带，不需要这一步。
            QTimer.singleShot(0, lambda: window_shadow(self))
        if getattr(self, "_use_native_corners", False):
            # Windows 11：DWM 圆角。winId 必须等窗口创建后才有效，
            # 所以放在 showEvent 而不是 __init__。
            from .material import apply_window_corners
            QTimer.singleShot(0, lambda: apply_window_corners(self))
        QTimer.singleShot(0, self._position_nav_toggle)

