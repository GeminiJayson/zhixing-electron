# -*- coding: utf-8 -*-
"""导航类组件：侧边菜单、顶部栏、面包屑、标签页、分页器、下拉菜单。

这些组件把「窗口壳里已经验证过的导航交互」抽成可独立嵌入的控件，
因此业务可以在任意布局里使用，而不必继承 FluentTemplateWindow。
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence

from PySide6.QtCore import QRect, Qt, Signal
from PySide6.QtGui import QAction, QIcon

from .. import motion
from PySide6.QtWidgets import (
    QButtonGroup, QFrame, QHBoxLayout, QLabel, QMenu, QScrollArea, QSizePolicy,
    QTabWidget, QToolButton, QVBoxLayout, QWidget,
)

from ..settings import UISettings
from ..theme import ThemeManager
from .actions import UButton
from .base import ThemedMixin, token_px

__all__ = ["UMenu", "UTopbar", "UBreadcrumb", "UTabs", "UTabStrip",
           "UPagination", "UDropdown"]


# ============================== 侧边菜单 ==============================
class UMenu(ThemedMixin, QFrame):
    """侧边栏菜单：分组 + 选中指示条，可独立嵌入任意布局。

    itemSelected(key) 只上报被点击的 key；页面切换由使用方决定。
    """

    itemSelected = Signal(str)

    def __init__(self, parent: Optional[QWidget] = None, *, collapsed: bool = False,
                 collapsed_width: int = 48, width: int = 200,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UMenu")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self._expanded_width = width
        self._collapsed_width = collapsed_width
        self._collapsed = collapsed
        self.setFixedWidth(collapsed_width if collapsed else width)
        self._init_theme(settings, theme)

        root = QVBoxLayout(self)
        root.setContentsMargins(6, 8, 6, 8)
        root.setSpacing(2)
        self._top = QVBoxLayout()
        self._top.setSpacing(2)
        self._bottom = QVBoxLayout()
        self._bottom.setSpacing(2)
        root.addLayout(self._top)
        root.addStretch(1)
        self._toggle = QToolButton(self)
        self._toggle.setObjectName("UMenuToggle")
        self._toggle.setText("«")
        self._toggle.setCursor(Qt.PointingHandCursor)
        self._toggle.setFocusPolicy(Qt.TabFocus)
        self._toggle.setToolTip("折叠菜单")
        self._toggle.setAccessibleName("折叠或展开侧边菜单")
        self._toggle.clicked.connect(self.toggle_collapsed)
        root.addWidget(self._toggle)
        root.addLayout(self._bottom)

        self._indicator = QFrame(self)
        self._indicator.setObjectName("UMenuIndicator")
        self._apply_indicator_width()
        self._indicator.hide()
        self._buttons: Dict[str, QToolButton] = {}
        self._groups: List[QLabel] = []
        self._current = ""

    # ---------- 装配 ----------
    def add_group(self, title: str) -> QLabel:
        label = QLabel(title, self)
        label.setObjectName("UMenuGroup")
        label.setVisible(not self._collapsed)     # 折叠态没有文字，分组标题整条收起
        self._top.addWidget(label)
        self._groups.append(label)
        return label

    def add_item(self, key: str, title: str, icon: Optional[QIcon] = None,
                 position: str = "top", icon_text: str = "") -> QToolButton:
        button = QToolButton(self)
        button.setObjectName("UMenuItem")
        button.setText(title)
        button.setProperty("_iconText", icon_text or title[:1])
        button.setToolTip(title)
        button.setAccessibleName(title)
        button.setCheckable(True)
        button.setAutoRaise(True)
        button.setCursor(Qt.PointingHandCursor)
        button.setFocusPolicy(Qt.StrongFocus)
        button.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        if icon is not None and not icon.isNull():
            button.setIcon(icon)
            button.setIconSize(button.iconSize())
        button.clicked.connect(lambda _c=False, k=key: self.activate(k))
        target = self._bottom if position == "bottom" else self._top
        target.addWidget(button)
        self._buttons[str(key)] = button
        self.set_collapsed(self._collapsed)
        if not self._current:
            self.activate(str(key))
        return button

    # ---------- 状态 ----------
    def activate(self, key: str) -> None:
        """选中某项并发信号（程序化调用也会发，便于外部同步）。"""
        self.set_current(key)
        self.itemSelected.emit(str(key))

    def set_current(self, key: str) -> None:
        """只改选中态，不发信号。"""
        if key not in self._buttons:
            return
        self._current = str(key)
        for item_key, button in self._buttons.items():
            button.setChecked(item_key == self._current)
        self._sync_indicator()

    def current(self) -> str:
        return self._current

    def set_collapsed(self, collapsed: bool) -> None:
        """折叠：文字转图标块（有 icon 用图标，否则用 icon_text / 首字）。"""
        self._collapsed = bool(collapsed)
        self.setFixedWidth(self._collapsed_width if self._collapsed
                           else self._expanded_width)
        for key, button in self._buttons.items():
            title = button.toolTip()
            has_icon = not button.icon().isNull()
            button.setProperty("collapsed", "true" if self._collapsed else "false")
            if has_icon:
                button.setToolButtonStyle(Qt.ToolButtonIconOnly if self._collapsed
                                          else Qt.ToolButtonTextBesideIcon)
                button.setText(title)
            else:
                button.setToolButtonStyle(Qt.ToolButtonTextOnly)
                glyph = str(button.property("_iconText") or title[:1])
                button.setText(glyph if self._collapsed else title)
            style = button.style()
            style.unpolish(button)
            style.polish(button)
        for group in self._groups:
            group.setVisible(not self._collapsed)
        if getattr(self, "_toggle", None) is not None:
            self._toggle.setText("«" if not self._collapsed else "»")
        self._sync_indicator()

    def toggle_collapsed(self) -> None:
        self.set_collapsed(not self._collapsed)

    def _sync_indicator(self) -> None:
        button = self._buttons.get(self._current)
        if button is None:
            self._indicator.hide()
            return
        self._indicator.setGeometry(2, button.y() + 4, 3, max(12, button.height() - 8))
        self._indicator.show()
        self._indicator.raise_()

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        self._sync_indicator()


# ============================== 顶部导航 ==============================
    def _apply_indicator_width(self) -> None:
        self._indicator.setFixedWidth(token_px(self, 'indicator-w', 3))
    def restyle(self) -> None:
        self._apply_indicator_width()
        self.update()
class UTopbar(ThemedMixin, QFrame):
    """顶部导航栏：标题 + 副标题 + 左右插槽。"""

    def __init__(self, title: str = "", subtitle: str = "",
                 parent: Optional[QWidget] = None, *, height: int = 48,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UTopbar")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setFixedHeight(height)
        self._init_theme(settings, theme)

        root = QHBoxLayout(self)
        root.setContentsMargins(12, 0, 12, 0)
        root.setSpacing(8)
        self.leading = QHBoxLayout()
        self.leading.setSpacing(4)
        root.addLayout(self.leading)

        texts = QVBoxLayout()
        texts.setSpacing(0)
        self.title = QLabel(title, self)
        self.title.setObjectName("UTopbarTitle")
        texts.addWidget(self.title)
        self.subtitle = QLabel(subtitle, self)
        self.subtitle.setObjectName("UTopbarSubtitle")
        self.subtitle.setVisible(bool(subtitle))
        texts.addWidget(self.subtitle)
        root.addLayout(texts)
        root.addStretch(1)

        self.actions = QHBoxLayout()
        self.actions.setSpacing(4)
        root.addLayout(self.actions)

    def set_title(self, text: str) -> None:
        self.title.setText(text)

    def set_subtitle(self, text: str) -> None:
        self.subtitle.setText(text)
        self.subtitle.setVisible(bool(text))

    def add_leading(self, widget: QWidget) -> QWidget:
        self.leading.addWidget(widget)
        return widget

    def add_action(self, widget: QWidget) -> QWidget:
        self.actions.addWidget(widget)
        return widget


# ============================== 面包屑 ==============================
class UBreadcrumb(ThemedMixin, QFrame):
    """面包屑：表达真实层级路径，点击任一级发信号（不做装饰性路径）。"""

    itemClicked = Signal(int, str)

    def __init__(self, items: Optional[Sequence[str]] = None,
                 parent: Optional[QWidget] = None, *,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UBreadcrumb")
        self._init_theme(settings, theme)
        self._layout = QHBoxLayout(self)
        self._layout.setContentsMargins(0, 0, 0, 0)
        self._layout.setSpacing(6)
        self._items: List[str] = []
        self._buttons: List[QToolButton] = []
        self.set_items(items or [])

    def set_items(self, items: Sequence[str]) -> None:
        for button in self._buttons:
            self._layout.removeWidget(button)
            button.deleteLater()
        self._buttons = []
        self._items = [str(x) for x in items]
        for index, text in enumerate(self._items):
            if index:
                separator = QLabel("/", self)
                separator.setObjectName("UBreadcrumbSeparator")
                self._layout.addWidget(separator)
            button = QToolButton(self)
            button.setObjectName("UBreadcrumbItem")
            button.setText(text)
            button.setCursor(Qt.PointingHandCursor)
            button.setFocusPolicy(Qt.StrongFocus)
            button.setAccessibleName(text)
            last = index == len(self._items) - 1
            button.setProperty("state", "current" if last else "link")
            button.clicked.connect(
                lambda _c=False, i=index, t=text: self.itemClicked.emit(i, t))
            self._layout.addWidget(button)
            self._buttons.append(button)
        self._layout.addStretch(1)

    def push(self, text: str) -> None:
        self.set_items(self._items + [str(text)])

    def pop(self) -> None:
        if self._items:
            self.set_items(self._items[:-1])

    def current(self) -> str:
        return self._items[-1] if self._items else ""


# ============================== 标签页 ==============================
class UTabs(ThemedMixin, QTabWidget):
    """标签页：同一工作区里的平级视图切换（不是主导航，也用不着就是别用）。"""

    def __init__(self, parent: Optional[QWidget] = None, *,
                 closable: bool = False, document_mode: bool = False,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UTabs")
        self.setTabsClosable(closable)
        self.setMovable(closable)
        self.setDocumentMode(document_mode)
        self.tabBar().setCursor(Qt.PointingHandCursor)
        self.setAccessibleName("标签页")
        self._init_theme(settings, theme)

    def add_tab(self, widget: QWidget, title: str,
                icon: Optional[QIcon] = None) -> int:
        if icon is not None and not icon.isNull():
            index = self.addTab(widget, icon, title)
        else:
            index = self.addTab(widget, title)
        widget.setAccessibleName(title)
        self._sync_accessible()
        return index

    def _sync_accessible(self) -> None:
        titles = [self.tabText(i) for i in range(self.count())]
        self.setAccessibleName("标签页：%s" % "、".join(titles) if titles else "标签页")

    def set_current_title(self, title: str) -> bool:
        for index in range(self.count()):
            if self.tabText(index) == title:
                self.setCurrentIndex(index)
                return True
        return False


# ============================== 分页器 ==============================
class UPagination(ThemedMixin, QFrame):
    """分页器：上一页 / 页码 / 下一页 + 当前范围。

    set_page() 是程序化设置，不发信号；用户点击才发 pageChanged，
    因此调用方可以把 set_page 放在自己的刷新流程里而不用担心递归。
    """

    pageChanged = Signal(int)

    def __init__(self, parent: Optional[QWidget] = None, *, page_size: int = 20,
                 max_buttons: int = 7,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UPagination")
        self._init_theme(settings, theme)
        self._page_size = max(1, int(page_size))
        self._max_buttons = max(3, int(max_buttons))
        self._total = 0
        self._pages = 1
        self._page = 0
        self._buttons: List[UButton] = []

        self._layout = QHBoxLayout(self)
        self._layout.setContentsMargins(0, 0, 0, 0)
        self._layout.setSpacing(4)
        self.range_label = QLabel("", self)
        self.range_label.setObjectName("UPaginationRange")
        self._layout.addWidget(self.range_label)
        self._layout.addStretch(1)

        self.prev = UButton("上一页", tone="subtle", size="compact",
                            settings=self._ui_settings, theme=self._ui_theme)
        self.prev.clicked.connect(lambda: self._step(-1))
        self._layout.addWidget(self.prev)
        self.pages_area = QHBoxLayout()
        self.pages_area.setSpacing(4)
        self._layout.addLayout(self.pages_area)
        self.next = UButton("下一页", tone="subtle", size="compact",
                            settings=self._ui_settings, theme=self._ui_theme)
        self.next.clicked.connect(lambda: self._step(1))
        self._layout.addWidget(self.next)
        self._rebuild()
        self._sync()

    # ---------- 数据 ----------
    def set_total(self, total_rows: int) -> None:
        """按总行数计算页数（分页的语义是「有多少行」而不是「有多少页」）。"""
        self._total = max(0, int(total_rows))
        pages = max(1, (self._total + self._page_size - 1) // self._page_size)
        if pages != self._pages:
            self._pages = pages
            self._rebuild()
        self._page = min(self._page, self._pages - 1)
        self._sync()

    def set_page_size(self, size: int) -> None:
        self._page_size = max(1, int(size))
        self.set_total(self._total)

    def set_page(self, index: int) -> None:
        self._page = max(0, min(int(index), self._pages - 1))
        self._sync()

    def page(self) -> int:
        return self._page

    def page_count(self) -> int:
        return self._pages

    # ---------- 内部 ----------
    def _step(self, delta: int) -> None:
        target = self._page + delta
        if 0 <= target < self._pages and target != self._page:
            self._page = target
            self._sync()
            self.pageChanged.emit(self._page)

    def _go(self, index: int) -> None:
        if index != self._page:
            self._page = index
            self._sync()
            self.pageChanged.emit(self._page)

    def _visible_pages(self) -> List[int]:
        if self._pages <= self._max_buttons:
            return list(range(self._pages))
        half = self._max_buttons // 2
        start = max(0, min(self._page - half, self._pages - self._max_buttons))
        return list(range(start, start + self._max_buttons))

    def _rebuild(self) -> None:
        for button in self._buttons:
            self.pages_area.removeWidget(button)
            button.deleteLater()
        self._buttons = []
        for index in self._visible_pages():
            button = UButton(str(index + 1), tone="subtle", kind="ghost",
                             size="compact", settings=self._ui_settings,
                             theme=self._ui_theme)
            button.setAccessibleName("第 %d 页" % (index + 1))
            button.clicked.connect(lambda _c=False, i=index: self._go(i))
            self.pages_area.addWidget(button)
            self._buttons.append(button)

    def _sync(self) -> None:
        visible = self._visible_pages()
        if [int(b.text()) - 1 for b in self._buttons] != visible:
            self._rebuild()
        for button in self._buttons:
            current = int(button.text()) - 1 == self._page
            button.set_tone("accent" if current else "subtle")
            button.set_kind("solid" if current else "ghost")
        self.prev.setEnabled(self._page > 0)
        self.next.setEnabled(self._page < self._pages - 1)
        start = self._page * self._page_size
        end = min(start + self._page_size, self._total)
        self.range_label.setText(
            "%d-%d / %d" % (start + 1, end, self._total) if self._total else "0 条")


class UTabStrip(ThemedMixin, QFrame):
    """顶部标签页：下划线跟手位移 + 选中标签自动滚动居中。

    不用 QTabBar 的原因：它的滚动偏移是私有的，做不到「把选中标签滚到中间」。
    这里用横向滚动容器 + 自绘下划线，位置与宽度都能做动画。
    """

    currentChanged = Signal(int, str)

    def __init__(self, parent: Optional[QWidget] = None, *,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UTabStrip")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self._init_theme(settings, theme)
        self._buttons: List[QToolButton] = []
        self._keys: List[str] = []
        self._current = -1

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        self._scroll = QScrollArea(self)
        self._scroll.setObjectName("UTabStripScroll")
        self._scroll.setWidgetResizable(True)
        self._scroll.setFrameShape(QScrollArea.NoFrame)
        self._scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self._scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self._track = QWidget()
        self._track.setObjectName("UTabStripTrack")
        self._row = QHBoxLayout(self._track)
        self._row.setContentsMargins(0, 0, 0, 0)
        self._row.setSpacing(4)
        self._row.addStretch(1)
        self._scroll.setWidget(self._track)
        root.addWidget(self._scroll, 1)

        self._underline = QFrame(self._track)
        self._underline.setObjectName("UTabUnderline")
        self._underline.setAttribute(Qt.WA_StyledBackground, True)
        self._underline.hide()

    def add_tab(self, title: str, key: Optional[str] = None) -> int:
        index = len(self._buttons)
        button = QToolButton(self._track)
        button.setObjectName("UTabStripItem")
        button.setText(title)
        button.setCheckable(True)
        button.setCursor(Qt.PointingHandCursor)
        button.setFocusPolicy(Qt.StrongFocus)
        button.setToolTip(title)
        button.setAccessibleName(title)
        button.clicked.connect(lambda _c=False, i=index: self.set_current(i))
        self._row.insertWidget(index, button)
        self._buttons.append(button)
        self._keys.append(key if key is not None else title)
        if index == 0:
            self.set_current(0, animate=False)
        return index

    def count(self) -> int:
        return len(self._buttons)

    def current_index(self) -> int:
        return self._current

    def current_key(self) -> str:
        return self._keys[self._current] if 0 <= self._current < len(self._keys) else ""

    def title_at(self, index: int) -> str:
        return self._buttons[index].text() if 0 <= index < len(self._buttons) else ""

    def set_current(self, index: int, *, animate: bool = True) -> None:
        if not (0 <= index < len(self._buttons)):
            return
        changed = index != self._current
        self._current = index
        for position, button in enumerate(self._buttons):
            button.setChecked(position == index)
        self._move_underline(animate=animate)
        self._center_current()
        if changed:
            self.currentChanged.emit(index, self.current_key())

    def _move_underline(self, animate: bool = True) -> None:
        if not (0 <= self._current < len(self._buttons)):
            return
        button = self._buttons[self._current]
        target = QRect(button.x(), button.height() - 2, button.width(), 2)
        self._underline.show()
        self._underline.raise_()
        if animate:
            motion.animate(self._underline, "geometry", self._underline.geometry(),
                           target, dur="fast", easing="standard")
        else:
            self._underline.setGeometry(target)

    def _center_current(self) -> None:
        if not (0 <= self._current < len(self._buttons)):
            return
        button = self._buttons[self._current]
        bar = self._scroll.horizontalScrollBar()
        viewport = self._scroll.viewport().width()
        centered = button.x() + button.width() // 2 - viewport // 2
        bar.setValue(max(bar.minimum(), min(centered, bar.maximum())))

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        self._move_underline(animate=False)
        self._center_current()

    def restyle(self) -> None:
        self._move_underline(animate=False)


# ============================== 下拉菜单 ==============================
class UDropdown(ThemedMixin, QToolButton):
    """下拉菜单按钮：点击弹出菜单，选中项以 key 上报。

    适合「一个入口多个动作」，不适合表单选择（那用 UComboBox / UMultiComboBox）。
    """

    itemTriggered = Signal(str)

    def __init__(self, text: str = "", parent: Optional[QWidget] = None, *,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UDropdown")
        self.setText(text)
        self.setCursor(Qt.PointingHandCursor)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setPopupMode(QToolButton.InstantPopup)
        self.setToolButtonStyle(Qt.ToolButtonTextOnly)
        self._menu = QMenu(self)
        self.setMenu(self._menu)
        if text:
            self.setAccessibleName(text)
        self._init_theme(settings, theme)

    def menu(self) -> QMenu:
        return self._menu

    def add_item(self, text: str, key: Optional[str] = None, *,
                 checkable: bool = False, checked: bool = False) -> QAction:
        action = self._menu.addAction(text)
        action.setCheckable(checkable)
        action.setChecked(checked)
        action.setData(key if key is not None else text)
        action.triggered.connect(
            lambda _checked=False, a=action: self.itemTriggered.emit(str(a.data())))
        return action

    def add_separator(self) -> None:
        self._menu.addSeparator()

    def clear_items(self) -> None:
        self._menu.clear()

    def set_text(self, text: str) -> None:
        self.setText(text)
