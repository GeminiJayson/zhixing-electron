# -*- coding: utf-8 -*-
"""底部快捷新建 FloatingDock（v0.16 P0-3）。

主窗口内容区右下角的「+」胶囊：点击向上展开「新建任务 / 新建笔记 / 记闪念」，
panel(OutExpo) 展开 + fast 淡出收起、随主题 token 自愈。只在高频新建页
（今日/任务）可见——遵循「一件事一个主入口」原则，其余页已有各自新建入口。

信号：
  taskRequested()  快速添加任务（QuickCapture 速记窗）
  noteRequested()  新建笔记（NoteCreateDialog）
  flashRequested() 记闪念（切收件箱「闪念」Tab）
"""
from PySide6.QtCore import QSize, Qt, Signal
from PySide6.QtWidgets import (QGraphicsOpacityEffect, QVBoxLayout, QWidget)

from ..kit import icons
from qfluent_core import ThemeManager as ThemeEngine
from ..kit import motion
from zhixing.view.kit.fluent_compat import QToolButton

#: 主「+」按钮边长（px）。圆角半径恒取其半高，尺寸是「圆形」的唯一来源：
#: 改这个值不会再出现「半径与半高脱节 → 变成圆角方」的问题。
_MAIN_BTN_SIZE = 38

_ACTIONS = (
    ("新建任务", "action.add", "taskRequested"),
    ("新建笔记", "action.edit", "noteRequested"),
    ("记闪念", "nav.flash", "flashRequested"),
)


class FloatingDock(QWidget):
    taskRequested = Signal()
    noteRequested = Signal()
    flashRequested = Signal()
    #: 展开/收起导致自身高度变化时发出，宿主（MainWindow）据此重新贴右下定位。
    #: 否则按收起高度算好的 y 坐标不再适用，展开项会溢出内容区底边被裁切。
    geometryChanged = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._open = False
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setFixedWidth(160)

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(6)
        root.setAlignment(Qt.AlignHCenter | Qt.AlignBottom)

        # 展开项容器（仅此层做淡入淡出，主按钮常显）
        self.items_host = QWidget(self)
        host_lay = QVBoxLayout(self.items_host)
        host_lay.setContentsMargins(0, 0, 0, 0)
        host_lay.setSpacing(4)
        root.addWidget(self.items_host, alignment=Qt.AlignHCenter)
        self._items: dict = {}
        for text, icon_name, attr in _ACTIONS:
            b = QToolButton()
            b.setText(text)
            b.setToolButtonStyle(Qt.ToolButtonTextBesideIcon)
            b.setCursor(Qt.PointingHandCursor)
            b.setObjectName("dockItem")
            sig = getattr(self, attr)
            b.clicked.connect(lambda _=False, s=sig: (self.collapse(), s.emit()))
            host_lay.addWidget(b, alignment=Qt.AlignHCenter)
            self._items[icon_name] = (b, text)
        # 主「+」胶囊
        self.main_btn = QToolButton()
        self.main_btn.setObjectName("dockMain")
        self.main_btn.setCursor(Qt.PointingHandCursor)
        self.main_btn.setCheckable(True)
        self.main_btn.setFixedSize(_MAIN_BTN_SIZE, _MAIN_BTN_SIZE)
        self.main_btn.clicked.connect(self.toggle)
        root.addWidget(self.main_btn, alignment=Qt.AlignHCenter)

        self.items_widgets = [self._items[n][0] for n in ("action.add", "action.edit", "nav.flash")]
        self._eff = None
        self.collapse(instant=True)
        ThemeEngine.instance() and ThemeEngine.instance().changed.connect(self._restyle)
        self._restyle()

    def _restyle(self):
        eng = ThemeEngine.instance()
        if eng is None:
            return
        t = eng.tokens
        accent = t.get("accent", "#0D9488")
        fg = t.get("fg", "#1A1A1A")
        fg2 = t.get("fg2", "#6B7280")
        layer = t.get("layer", "#FFFFFF")
        hover = t.get("hover", "#F1F5F3")
        border = t.get("border", "#E4EDE8")
        self.main_btn.setIcon(icons.icon("action.add", "#FFFFFF", 18))
        self.main_btn.setIconSize(QSize(18, 18))
        # 圆角 = 边长/2 恒为「正圆」。直接取自常量而非控件 width()，避免依赖
        # 构造/布局时序（_restyle 若在固定尺寸前被调用，width() 会取到默认值）。
        radius = _MAIN_BTN_SIZE // 2
        # 必须显式写死 min/max-width/height：应用级 component_qss 的
        # 「QToolButton { min-height；max-height }」会覆盖 setFixedSize 的高度，
        # 把主按钮压成「宽 38 × 高(控件高度-2)」的长方形（默认控件高度 32 → 38×30）。
        # 这里用 objectName 选择器 + 四向 min/max 锁死，任何控件高度下都保持正圆。
        self.main_btn.setStyleSheet(
            f"QToolButton#dockMain {{ background: {accent}; border: none;"
            f" border-radius: {radius}px; padding: 0;"
            f" min-width: {_MAIN_BTN_SIZE}px; max-width: {_MAIN_BTN_SIZE}px;"
            f" min-height: {_MAIN_BTN_SIZE}px; max-height: {_MAIN_BTN_SIZE}px; }}"
            f"QToolButton#dockMain:hover {{ background: {t.get('accent_solid_hover', accent)}; }}"
            f"QToolButton#dockMain:pressed {{ background: {t.get('accent_solid_pressed', accent)}; }}"
            f"QToolButton#dockMain:checked {{ background: {t.get('accent_solid', accent)}; }}")
        self._style_items(layer, fg, border, hover, accent)
        for n, (b, _txt) in self._items.items():
            b.setIcon(icons.icon(n, fg2, 14))
            b.setIconSize(QSize(14, 14))

    def _style_items(self, layer: str, fg: str, border: str,
                     hover: str, accent: str):
        """子项样式：胶囊形态（圆角 = 高度的一半），随「控件高度」设置自适应。

        子项高度由全局 component_qss 的 QToolButton min/max-height 决定
        （控件高度-2），因此圆角必须按实际高度动态推导：
        硬编码会让「控件高度≠32」时退化成圆角矩形或被 clamp 成异形。
        """
        for b in self.items_widgets:
            h = b.height() or b.sizeHint().height()
            radius = max(1, h // 2) if h > 0 else 15
            b.setStyleSheet(
                f"QToolButton#dockItem {{ background: {layer}; color: {fg};"
                f" border: 1px solid {border}; border-radius: {radius}px;"
                f" padding: 3px 10px; font-size: 12px; }}"
                f"QToolButton#dockItem:hover {{ background: {hover}; color: {accent}; }}")

    # ---------- 展开/收起 ----------
    def toggle(self):
        if self._open:
            self.collapse()
        else:
            self.expand()

    def expand(self):
        if self._open:
            return
        self._open = True
        self.main_btn.setChecked(True)
        self.items_host.show()
        eff = QGraphicsOpacityEffect(self.items_host)
        self.items_host.setGraphicsEffect(eff)   # 仅展开列表淡入
        motion.fade_in(self.items_host, "panel", 4)
        # 展开时高度才由全局 QSS 落定，此时按真实高度重算胶囊半径。
        self._restyle()
        # 高度已增长：先让布局结算出新 sizeHint，再请宿主重贴右下。
        self._notify_geometry_changed()

    def collapse(self, instant: bool = False) -> bool:
        """收起展开项。返回 True 表示本次确实执行了收起（供 Esc 决定是否吞掉事件）。"""
        if not self._open and not instant:
            return False
        self._open = False
        self.main_btn.setChecked(False)
        if instant:
            self.items_host.hide()
            self.items_host.setGraphicsEffect(None)
            self._notify_geometry_changed()
            return True
        # 收起：淡出展开列表后隐藏
        def _hide():
            self.items_host.hide()
            self.items_host.setGraphicsEffect(None)
            self._notify_geometry_changed()
        eff = QGraphicsOpacityEffect(self.items_host)
        self.items_host.setGraphicsEffect(eff)
        a = motion.animate(eff, "opacity", 1.0, 0.0, dur="fast", easing="standard",
                           on_done=_hide)
        if a is None:
            _hide()
        return True

    def _notify_geometry_changed(self):
        """高度变化后通知宿主重新定位（布局结算 → 定位，需等一帧 sizeHint 才准确）。"""
        self.updateGeometry()
        self.adjustSize()
        self.geometryChanged.emit()

    def set_page(self, key: str):
        """今日/任务页显示；其余页隐藏（避免与页内新建入口重复）。"""
        visible = key in ("today", "tasks")
        if not visible and self._open:
            self.collapse(instant=True)
        self.setVisible(visible)

