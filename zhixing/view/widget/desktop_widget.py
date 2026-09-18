# -*- coding: utf-8 -*-
"""桌面浮窗（F10）：单形态任务卡片，可贴边半隐。

- 同进程独立 QWidget（ADR-10）：数据与主窗同源，事件驱动双向同步。
- 任务列表始终可见；拖拽记忆位置、透明度可调、贴边缩为小把手。
"""
from datetime import date
from typing import Optional

from PySide6.QtCore import QPoint, QRect, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QCursor, QPainter, QPainterPath
from PySide6.QtWidgets import (QFrame, QHBoxLayout, QTreeView, QVBoxLayout, QWidget)

from ...core import settings_keys as K
from ...model.qt.models import RoleTaskId, TaskTreeModel
from ..delegates.task_delegate import TaskDelegate
from ..kit.icons import icon
from qfluent_core import ThemeManager as ThemeEngine
from zhixing.view.kit.fluent_compat import QLabel, QLineEdit, QPushButton
from zhixing.view.kit.fluent_compat import Action, RoundMenu

EXPANDED = (290, 380)
_EDGE_SIZE = 10
_MIN_SIZE = (200, 160)       # 用户缩放下限（宽, 高）
_RESIZE_MARGIN = 8           # 边缘命中区（像素）


class WidgetWindow(QWidget):
    openMainRequested = Signal()
    toggleRequested = Signal(int)             # 勾选任务
    openRequested = Signal(int)               # 「编辑」按钮 → 主程序定位并打开编辑
    quickAddRequested = Signal(str)
    deleteRequested = Signal(int)             # 「删除」按钮 → 上抛删除
    focusRequested = Signal(int)             # 「专注」按钮 → 上抛专注

    def __init__(self, task_service, settings, parent=None):
        super().__init__(parent,
                         Qt.Tool | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint)
        self.task_service = task_service
        self.settings = settings
        self._edge = None                     # 'left' | 'right' | None（贴边半隐）
        self._drag_pos: Optional[QPoint] = None
        self._resize_dir: Optional[tuple] = None       # 命中边 (left, top, right, bottom)
        self._resize_start: Optional[QPoint] = None     # 缩放起点全局坐标
        self._resize_start_geom: Optional[QRect] = None
        self._user_size = list(EXPANDED)                # 未贴边时的用户尺寸 [w, h]
        self._tasks = []
        self.setWindowFlags(self.windowFlags() | Qt.WindowStaysOnTopHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setMouseTracking(True)
        self._build()
        self.card.setMouseTracking(True)
        self.card.installEventFilter(self)
        self._load_geometry()
        self._restyle()
        ThemeEngine.instance() and ThemeEngine.instance().changed.connect(self._restyle)

    # ================= 构建 =================
    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        self.card = QFrame()
        root.addWidget(self.card)
        self.card_lay = QVBoxLayout(self.card)
        self.card_lay.setContentsMargins(14, 12, 14, 10)
        self.card_lay.setSpacing(6)

        # 快速输入（顶部，单形态常驻）
        self.input = QLineEdit()
        self.input.setPlaceholderText("快速输入…回车即建")
        self.input.returnPressed.connect(self._quick_add)
        self.card_lay.addWidget(self.input)

        # 任务列表（树形：父任务 → 缩进子任务），占据主要空间
        self.task_model = TaskTreeModel(self, tag_provider=getattr(self.task_service, "tag_map", None))
        self.tree = QTreeView()
        self.tree.setModel(self.task_model)
        self.tree.setHeaderHidden(True)
        self.tree.setRootIsDecorated(False)
        self.tree.setIndentation(0)
        self.tree.setFrameShape(QTreeView.NoFrame)
        self.tree.setExpandsOnDoubleClick(False)
        self.delegate = TaskDelegate(
            self.tree, show_actions=True,
            row_height=self._row_height(), indent=self._indent(), inline_edit=True)
        self.tree.setItemDelegate(self.delegate)
        self.delegate.snippet_lookup = self._snippet_for_task   # v0.15 P1-5
        self.delegate.toggleRequested.connect(self.toggleRequested.emit)
        self.delegate.openRequested.connect(self.openRequested.emit)
        self.delegate.toggleExpandRequested.connect(self._toggle_expand)
        self.delegate.editPriorityRequested.connect(self._edit_priority)
        self.delegate.editTagsRequested.connect(self._edit_tags)
        self.delegate.addSubtaskRequested.connect(self._add_subtask)
        self.delegate.focusRequested.connect(self.focusRequested.emit)
        self.delegate.deleteRequested.connect(self.deleteRequested.emit)
        self.delegate.titleEditRequested.connect(self.begin_inline_edit)
        self.delegate.titleCommitted.connect(self._on_inline_title_committed)
        self.list_host = QWidget()
        host_lay = QVBoxLayout(self.list_host)
        host_lay.setContentsMargins(0, 0, 0, 0)
        host_lay.setSpacing(2)
        host_lay.addWidget(self.tree, 1)
        self.empty_label = QLabel("今天没有任务")
        self.empty_label.setAlignment(Qt.AlignCenter)
        host_lay.addWidget(self.empty_label)
        self.card_lay.addWidget(self.list_host, 1)

        # 底部图标栏（打开主程序，靠左下）
        foot = QHBoxLayout()
        foot.setContentsMargins(0, 0, 0, 0)
        foot.setSpacing(4)
        self.open_btn = QPushButton()
        self.open_btn.setFlat(True)
        self.open_btn.setCursor(Qt.PointingHandCursor)
        self.open_btn.setToolTip("打开主程序")
        self.open_btn.setAccessibleName("打开主程序")
        self.open_btn.setFixedSize(32, 32)   # T8: 命中区 ≥32px（视觉图标仍 18px）
        self.open_btn.clicked.connect(self.openMainRequested.emit)
        foot.addWidget(self.open_btn)
        foot.addStretch(1)
        self.card_lay.addLayout(foot)

    # ================= 数据 =================
    def reload_tasks(self):
        self._tasks = self.task_service.today_tree() if self.task_service else []
        # 树模型直接装载（保留父任务 → 缩进子任务层级），默认展开显示子任务
        self.task_model.reload(self._tasks)
        self.tree.expandAll()
        has = bool(self._tasks)
        self.tree.setVisible(has)
        self.empty_label.setVisible(not has)

    # ================= 行高/缩进（设置项） =================
    def _row_height(self) -> int:
        return self.settings.get_int(K.K_TASK_ROW_HEIGHT, 38) if self.settings else 38

    def _indent(self) -> int:
        return self.settings.get_int(K.K_TASK_INDENT, 20) if self.settings else 20

    def apply_row_metrics(self):
        self.delegate.row_height = self._row_height()
        self.delegate.indent = self._indent()
        self.tree.setIndentation(0)
        self.tree.doItemsLayout()
        self.tree.viewport().update()

    # ================= 行内标题编辑 =================
    def _index_for(self, task_id: int):
        return self.task_model.index_of(task_id)

    def begin_inline_edit(self, task_id: int):
        if not task_id:
            return
        idx = self._index_for(task_id)
        if not idx.isValid():
            return
        self.tree.setCurrentIndex(idx)
        QTimer.singleShot(0, lambda: self._edit_index(idx))

    def _edit_index(self, idx):
        if idx.isValid():
            self.tree.edit(idx)

    def _on_inline_title_committed(self, task_id: int, text: str):
        QTimer.singleShot(0, lambda: self._apply_title(task_id, text))

    def _apply_title(self, task_id: int, text: str):
        if self.task_service and task_id and text.strip():
            self.task_service.update(task_id, title=text.strip())

    def _snippet_for_task(self, task_id: int):
        """v0.15 P1-5: 桌面浮窗任务 hover 展示关联段落 snippet（无笔记标题服务，仅正文）。"""
        try:
            ctxs = self.task_service.linked_contexts(task_id) if self.task_service else []
        except Exception:
            return None
        if not ctxs:
            return None
        snip = (ctxs[0].snippet or "").strip().replace("\n", " ")
        return ("", snip) if snip else None

    def _toggle_expand(self, task_id: int):
        if not task_id:
            return
        idx = self.task_model.index_of(task_id)
        if idx.isValid():
            will_expand = not self.tree.isExpanded(idx)
            self.tree.setExpanded(idx, will_expand)
            if will_expand:
                self._stagger_children(idx)

    def _stagger_children(self, idx):
        """子任务展开 stagger（9c）：逐行淡入，复用 motion.py 工厂。"""
        from ..kit import motion
        count = self.task_model.rowCount(idx)

        def reveal(i):
            child = self.task_model.index(i, 0, idx)
            if not child.isValid():
                return
            tid = child.data(RoleTaskId)
            if tid is None:
                return
            self.delegate.set_reveal(tid, 0.0)
            motion.animate_value(0.0, 1.0, dur="fast", easing="standard",
                                 on_update=lambda v, k=tid: self.delegate.set_reveal(k, v))

        motion.stagger(count, reveal)

    def _edit_priority(self, task_id: int):
        if not self.task_service or not task_id:
            return
        
        from ..kit.priority import priority_choices
        menu = RoundMenu(parent=self)
        for value, label in priority_choices():
            a = Action(label, self)
            a.triggered.connect(lambda _checked=False, v=value, tid=task_id:
                                self._set_priority(tid, v))
            menu.addAction(a)
        menu.exec(QCursor.pos())

    def _set_priority(self, task_id: int, priority):
        self.task_service.update(task_id, priority=priority)
        self.reload_tasks()

    def _edit_tags(self, task_id: int):
        if not self.task_service or not task_id:
            return
        
        menu = RoundMenu(parent=self)
        tags = self.task_service.tag_map([task_id]).get(task_id, [])
        for _tag_id, name, _color in tags:
            a = Action(f"移除 #{name}", self)
            a.triggered.connect(lambda _checked=False, tid=task_id, n=name:
                                self._remove_tag(tid, n))
            menu.addAction(a)
        if tags:
            menu.addSeparator()
        add_a = Action("添加标签…", self)
        add_a.triggered.connect(lambda _checked=False: self._prompt_add_tag(task_id))
        menu.addAction(add_a)
        menu.exec(QCursor.pos())

    def _remove_tag(self, task_id: int, name: str):
        tag_map = self.task_service.tag_map([task_id]).get(task_id, [])
        names = [n for (_tid, n, _c) in tag_map if n != name]
        self.task_service.set_tags(task_id, names)
        self.reload_tasks()

    def _prompt_add_tag(self, task_id: int):
        from PySide6.QtWidgets import QInputDialog
        text, ok = QInputDialog.getText(self, "添加标签", "标签名（逗号分隔多个）：")
        if not ok or not text.strip():
            return
        names = [x.strip().lstrip("#") for x in text.replace("，", ",").split(",") if x.strip()]
        if not names:
            return
        existing = [n for (_tid, n, _c) in self.task_service.tag_map([task_id]).get(task_id, [])]
        self.task_service.set_tags(task_id, existing + [n for n in names if n not in existing])
        self.reload_tasks()

    def _add_subtask(self, task_id: int):
        if not self.task_service or not task_id:
            return
        task = self.task_service.add_subtask(task_id, "新子任务")
        if not task:
            return
        self.reload_tasks()
        idx = self._index_for(task_id)
        if idx.isValid():
            self.tree.expand(idx)
        # 定位新子任务并自动触发行内标题编辑
        self.begin_inline_edit(task.id)

    def _quick_add(self):
        text = self.input.text().strip()
        if text:
            self.quickAddRequested.emit(text)
            self.input.clear()
            QTimer_re(self.reload_tasks, 120)

    # ================= 几何 / 贴边 =================
    def _load_geometry(self):
        state = self.settings.ui_state()
        geom = state.get(K.K_WIDGET_GEOM)
        w, h = EXPANDED
        positioned = False
        if geom:
            try:
                self.move(int(geom[0]), int(geom[1]))
                positioned = True
                if len(geom) >= 4:
                    w = max(_MIN_SIZE[0], int(geom[2]))
                    h = max(_MIN_SIZE[1], int(geom[3]))
            except (ValueError, TypeError):
                positioned = False
        if not positioned:
            screen = self.screen().availableGeometry() if self.screen() else None
            if screen:
                self.move(screen.right() - EXPANDED[0] - 24, screen.top() + 120)
        self.resize(w, h)
        self._user_size = [w, h]
        opacity = self.settings.get_int(K.K_WIDGET_OPACITY, 85)
        self.setWindowOpacity(max(0.3, min(1.0, opacity / 100)))

    def save_geometry(self):
        self.settings.ui_set(K.K_WIDGET_GEOM,
                              [self.x(), self.y(), self.width(), self.height()])

    def apply_opacity(self, value: int):
        self.setWindowOpacity(max(0.3, min(1.0, value / 100)))

    def set_click_through(self, enabled: bool):
        """浮窗鼠标穿透（F10-6）：开启后不挡操作，经托盘/热键退出。"""
        self.setWindowFlag(Qt.WindowTransparentForInput, enabled)
        if self.isVisible():
            self.show()  # 重新应用窗口 flag
        self._click_through = enabled

    def _check_edge(self):
        screen = self.screen().availableGeometry() if self.screen() else None
        if not screen:
            return
        if self.x() <= screen.left() + 4:
            self._edge = "left"
        elif self.x() + self.width() >= screen.right() - 4:
            self._edge = "right"
        else:
            self._edge = None

    # ================= 事件 =================
    def paintEvent(self, ev):  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        path = QPainterPath()
        path.addRoundedRect(0.5, 0.5, self.width() - 1, self.height() - 1, 12, 12)
        p.fillPath(path, QColor(t.get("layer", "#FFFFFF")))
        p.setPen(QColor(t.get("border", "#E5E5E5")))
        p.drawPath(path)

    def mousePressEvent(self, ev):
        if ev.button() == Qt.LeftButton:
            if not self._edge:
                hit = self._resize_hit(ev.position().toPoint())
                if hit:
                    self._resize_dir = hit
                    self._resize_start = ev.globalPosition().toPoint()
                    self._resize_start_geom = self.frameGeometry()
                    ev.accept()
                    return
            self._drag_pos = ev.globalPosition().toPoint() - self.frameGeometry().topLeft()
        super().mousePressEvent(ev)

    def mouseMoveEvent(self, ev):
        if self._resize_dir and self._resize_start and ev.buttons() & Qt.LeftButton:
            self._apply_resize(ev.globalPosition().toPoint())
            return
        if self._drag_pos and ev.buttons() & Qt.LeftButton:
            self.move(ev.globalPosition().toPoint() - self._drag_pos)
            self._check_edge()
            return
        self._update_resize_cursor(ev.position().toPoint())
        super().mouseMoveEvent(ev)

    def mouseReleaseEvent(self, ev):  # noqa: N802
        if self._resize_dir:
            self._resize_dir = None
            self._resize_start = None
            self._resize_start_geom = None
            self._user_size = [self.width(), self.height()]
            self.save_geometry()
            ev.accept()
            return
        if self._drag_pos:
            self._drag_pos = None
            self._check_edge()
            if self._edge:
                self._snap_edge()
            else:
                self.save_geometry()
        super().mouseReleaseEvent(ev)

    # ---------- 缩放（边缘命中 + 尺寸钳制 + 光标反馈） ----------
    def _resize_hit(self, pos: QPoint):
        """命中窗口边缘返回 (left, top, right, bottom)，否则 None。"""
        m = _RESIZE_MARGIN
        x, y = pos.x(), pos.y()
        w, h = self.width(), self.height()
        left = x <= m
        right = x >= w - m
        top = y <= m
        bottom = y >= h - m
        if left or right or top or bottom:
            return (left, top, right, bottom)
        return None

    def _apply_resize(self, gpos: QPoint):
        """按命中边调整尺寸（最小尺寸 + 屏幕边界钳制）。"""
        left, top, right, bottom = self._resize_dir
        g = self._resize_start_geom
        dx = gpos.x() - self._resize_start.x()
        dy = gpos.y() - self._resize_start.y()
        x, y, w, h = g.x(), g.y(), g.width(), g.height()
        min_w, min_h = _MIN_SIZE
        if left:
            nw = w - dx
            if nw >= min_w:
                x = g.x() + dx
                w = nw
        elif right:
            w = max(min_w, w + dx)
        if top:
            nh = h - dy
            if nh >= min_h:
                y = g.y() + dy
                h = nh
        elif bottom:
            h = max(min_h, h + dy)
        self.setGeometry(QRect(x, y, w, h))

    def _update_resize_cursor(self, pos: QPoint):
        hit = self._resize_hit(pos) if not self._edge else None
        if not hit:
            self.unsetCursor()
            return
        left, top, right, bottom = hit
        if (left and top) or (right and bottom):
            self.setCursor(Qt.SizeFDiagCursor)
        elif (right and top) or (left and bottom):
            self.setCursor(Qt.SizeBDiagCursor)
        elif left or right:
            self.setCursor(Qt.SizeHorCursor)
        else:
            self.setCursor(Qt.SizeVerCursor)

    def eventFilter(self, obj, ev):  # noqa: N802
        from PySide6.QtCore import QEvent
        if obj is self.card and ev.type() == QEvent.MouseMove:
            self._update_resize_cursor(ev.position().toPoint())
        return super().eventFilter(obj, ev)

    def mouseDoubleClickEvent(self, ev):  # noqa: N802
        if self._edge:
            self._unsnap()
        super().mouseDoubleClickEvent(ev)

    def contextMenuEvent(self, ev):  # noqa: N802
        
        menu = RoundMenu(parent=self)

        def _add(text, cb):
            a = Action(text, self)
            a.triggered.connect(lambda _checked=False: cb())
            menu.addAction(a)

        _add("今日视图", self.openMainRequested.emit)
        _add("贴边停靠" if not self._edge else "取消贴边",
             self._snap_edge if not self._edge else self._unsnap)
        menu.addSeparator()
        _add("隐藏浮窗", self.hide)
        menu.exec(ev.globalPos())

    def _snap_edge(self):
        self._check_edge()
        side = self._edge or "right"
        self._edge = side
        self._user_size = [self.width(), self.height()]   # 记住未贴边尺寸
        screen = self.screen().availableGeometry()
        self.resize(_EDGE_SIZE, self._user_size[1])
        y = self.y()
        x = screen.left() if side == "left" else screen.right() - _EDGE_SIZE
        self.move(x, max(screen.top(), min(y, screen.bottom() - self.height())))
        self.save_geometry()

    def _unsnap(self):
        """立即展开（右键菜单/双击/取消贴边）。"""
        side = self._edge
        self._edge = None
        w, h = self._user_size
        screen = self.screen().availableGeometry()
        self.resize(w, h)
        if side == "left":
            self.move(screen.left() + 4, self.y())
        else:
            self.move(screen.right() - w - 4, self.y())

    def _animate_expand(self):
        """贴边 200ms 滑出（F10-4）：从把手宽度动画展开到完整卡片。"""
        if not self._edge:
            return
        side = self._edge
        self._edge = None
        screen = self.screen().availableGeometry()
        end_w, end_h = self._user_size
        end_x = screen.left() + 4 if side == "left" else screen.right() - end_w - 4
        end_y = self.y()
        end_geo = QRect(end_x, end_y, end_w, end_h)
        start_geo = self.geometry()
        from ..kit import motion
        if motion.motion_enabled() and start_geo != end_geo:
            self.setGeometry(end_geo)
            self.setGeometry(start_geo)
            motion.animate(self, b"geometry", start_geo, end_geo, dur="fast")
        else:
            self.setGeometry(end_geo)
        self.save_geometry()

    def enterEvent(self, ev):  # noqa: N802
        if self._edge:
            self._animate_expand()
        super().enterEvent(ev)

    def _restyle(self):
        eng = ThemeEngine.instance()
        if not eng:
            return
        t = eng.tokens
        self.card.setStyleSheet(
            f"QFrame {{ background: transparent; }}"
            f"QLabel {{ background: transparent; }}"
            f"QLineEdit {{ background: {t.get('input', 'rgba(255,255,255,0.6)')};"
            f"border: 1px solid {t.get('border', '#E5E5E5')}; border-radius: 6px;"
            f"padding: 3px 8px; }}"
            f"QPushButton {{ background: {t.get('hover', '#F5F5F5')}; border: none;"
            f"border-radius: 6px; padding: 3px 10px; }}"
            f"QTreeView {{ background: transparent; border: none; }}"
            f"QTreeView::item:selected, QTreeView::item:selected:active, "
            f"QTreeView::item:selected:!active {{ background: transparent; "
            f"color: {t.get('fg', '#1A1A1A')}; }}"
            f"QTreeView::item:hover {{ background: transparent; }}")
        self.open_btn.setIcon(icon("external.open", t.get("fg2", "#6B7280"), 18))
        self.open_btn.setIconSize(QSize(18, 18))
        self.open_btn.setStyleSheet(
            f"QPushButton {{ background: transparent; border: none;"
            f"border-radius: 6px; padding: 2px; }}"
            f"QPushButton:hover {{ background: {t.get('hover', '#F5F5F5')}; }}")


def QTimer_re(fn, ms):
    from PySide6.QtCore import QTimer
    QTimer.singleShot(ms, fn)
