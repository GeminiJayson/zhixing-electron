# -*- coding: utf-8 -*-
"""看板视图（F1-11）：按状态分列（待办/进行中/已完成/已放弃），拖拽改状态。

卡片元数据：优先级 chip / 截止日期 chip / 标签 chip；列头计数；列空态；列添加入口。
v0.17：父卡片右侧「N 子」chip 可展开——该列内以缩进卡片显示其未完成子任务
（显示层展开，不做级联改动；拖拽/改状态语义保持原状）。
"""
import time
from datetime import date

from PySide6.QtCore import QEvent, QRect, QSize, Qt, Signal
from PySide6.QtGui import QColor, QFont, QFontMetrics, QPainter, QPen
from PySide6.QtWidgets import (QAbstractItemView, QApplication, QHBoxLayout, QListWidgetItem, QStyle, QStyledItemDelegate, QStyleOptionViewItem, QVBoxLayout, QWidget)

from ...model.domain.entities import Priority, TaskStatus
from ...model.domain.task_rules import effective_done_map
from qfluent_core import ThemeManager as ThemeEngine
from ..ui import UCard
from zhixing.view.kit.fluent_compat import QLabel, QPushButton
from zhixing.view.kit.fluent_compat import QListWidget

_STATUSES = [
    (TaskStatus.TODO, "待办"),
    (TaskStatus.DOING, "进行中"),
    (TaskStatus.WAITING, "等待中"),
    (TaskStatus.DONE, "已完成"),
    (TaskStatus.ABANDONED, "已放弃"),
]

_RoleTaskId = Qt.UserRole
_RolePriority = Qt.UserRole + 1
_RoleDue = Qt.UserRole + 2
_RoleTags = Qt.UserRole + 3
_RoleDepth = Qt.UserRole + 4        # 卡片层级：0=根任务，>0=展开出的子任务
_RoleChildCount = Qt.UserRole + 5   # 可见（未有效完成）直接子任务数（0=无 chip）


def _prio_color(priority: int) -> str:
    from ..kit.priority import priority_color
    return priority_color(int(priority))


def _soften(color: str, tokens: dict) -> str:
    c = QColor(color)
    base = QColor(tokens.get("layer", "#FFFFFF"))
    dark = base.lightness() < 128
    f = 0.3 if dark else 0.14
    return QColor(int(c.red() * f + base.red() * (1 - f)),
                  int(c.green() * f + base.green() * (1 - f)),
                  int(c.blue() * f + base.blue() * (1 - f))).name()


def _due_text(due, tokens: dict):
    today = date.today()
    if due == today:
        return "今天", tokens.get("accent", "#0D9488")
    if due < today:
        return f"逾期 {due.strftime('%m-%d')}", tokens.get("danger", "#DC2626")
    return f"截止 {due.strftime('%m-%d')}", tokens.get("fg2", "#6B7280")


def _row_card_rect(row: QRect, depth: int) -> QRect:
    """列表行矩形 → 卡片绘制矩形：子任务（depth>0）左侧收进形成层级缩进。"""
    r = row.adjusted(2, 2, -2, -2)
    if depth > 0:
        off = 12 + (depth - 1) * 10
        r = QRect(r.left() + off, r.top(), max(24, r.width() - off), r.height())
    return r


def _chip_rect(card: QRect) -> QRect:
    """卡片右上角「N 子」展开 chip 命中矩形（绘制与点击共用同一几何）。"""
    return QRect(card.right() - 48, card.top() + 6, 42, 18)


class _KanbanDelegate(QStyledItemDelegate):
    """看板卡片 delegate：标题 + 优先级/日期/标签 chip。"""

    def sizeHint(self, option, index):
        return QSize(option.rect.width(), 58)

    def paint(self, p: QPainter, option, index):
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        p.save()
        p.setRenderHint(QPainter.Antialiasing)
        depth = int(index.data(_RoleDepth) or 0)
        count = int(index.data(_RoleChildCount) or 0)
        rect = _row_card_rect(option.rect, depth)
        selected = option.state & QStyle.State_Selected
        hovered = option.state & QStyle.State_MouseOver
        if selected:
            bg = t.get("accent_soft", "#D9F2EE")
        elif hovered:
            bg = t.get("hover", "#F5F5F5")
        else:
            bg = t.get("layer", "#FFFFFF")
        p.setPen(QPen(QColor(t.get("border", "#E5E5E5")), 1))
        p.setBrush(QColor(bg))
        p.drawRoundedRect(rect, 8, 8)

        dpr = 1.0
        if option.widget is not None:
            try:
                dpr = option.widget.devicePixelRatioF()
            except Exception:
                dpr = 1.0

        tid = index.data(_RoleTaskId)
        title = index.data(Qt.DisplayRole) or "（无标题）"
        if depth > 0:
            title = "↳ " + title          # 子任务卡片加分支前缀，配合缩进示意层级
        prio = index.data(_RolePriority) or 0
        due = index.data(_RoleDue)
        tags = index.data(_RoleTags) or []

        # 卡片右上角「N 子」chip（仅父任务/有可见子任务的行显示）
        chip_rect = None
        if count and tid:
            expanded = False
            col = option.widget
            if isinstance(col, KanbanColumn):
                expanded = tid in getattr(col, "_expanded", set())
            chip_rect = _chip_rect(rect)
            cc = t.get("accent", "#0D9488")
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(_soften(cc, t)))
            p.drawRoundedRect(chip_rect, 9, 9)
            p.setPen(QColor(cc))
            chip_f = QFont(option.font)
            chip_f.setPixelSize(10)
            p.setFont(chip_f)
            p.drawText(chip_rect, Qt.AlignCenter,
                       ("▾" if expanded else "▸") + str(min(count, 99)))

        title_font = QFont(option.font)
        title_font.setPixelSize(14)
        title_font.setBold(True)
        p.setFont(title_font)
        p.setPen(QColor(t.get("fg", "#1A1A1A")))
        right_inset = 8 + (chip_rect.width() + 6 if chip_rect else 0)
        title_avail = max(16, rect.width() - 8 - right_inset)
        elided = p.fontMetrics().elidedText(title, Qt.ElideRight, title_avail)
        p.drawText(rect.adjusted(8, 6, -right_inset, -24),
                   Qt.AlignVCenter | Qt.AlignLeft, elided)

        # chips 行
        chip_font = QFont(option.font)
        chip_font.setPixelSize(11)
        p.setFont(chip_font)
        fm = QFontMetrics(chip_font)
        cx = rect.left() + 8
        cy = rect.bottom() - 13
        max_right = rect.right() - 6

        if prio:
            pc = _prio_color(int(prio))
            from ..kit import icons
            pm = icons.pixmap("task.flag", pc, 14, dpr)
            flag_w = 18
            chip = QRect(cx, cy - 9, flag_w, 18)
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(_soften(pc, t)))
            p.drawRoundedRect(chip, 9, 9)
            p.drawPixmap(QRect(cx + 2, cy - 7, 14, 14), pm)
            cx += flag_w + 4

        if due is not None:
            due_text, dc = _due_text(due, t)
            w = fm.horizontalAdvance(due_text) + 12
            if cx + w <= max_right:
                chip = QRect(cx, cy - 8, w, 16)
                p.setPen(Qt.NoPen)
                p.setBrush(QColor(_soften(dc, t)))
                p.drawRoundedRect(chip, 8, 8)
                p.setPen(QColor(dc))
                p.drawText(chip, Qt.AlignCenter, due_text)
                cx += w + 4

        tags = (tags or [])[:2]
        for i, (_tid, name, color) in enumerate(tags):
            tag_text = f"#{name}"
            w = fm.horizontalAdvance(tag_text) + 12
            if cx + w > max_right:
                # T9(3.4b): 溢出时显示 "+N"（剩余未展示数），不再静默截断
                remain = len(tags) - i
                plus_text = f"+{remain}"
                pw = fm.horizontalAdvance(plus_text) + 12
                if cx + pw <= max_right:
                    chip = QRect(cx, cy - 8, pw, 16)
                    p.setPen(Qt.NoPen)
                    p.setBrush(QColor(_soften(t.get("fg2", "#6B7280"), t)))
                    p.drawRoundedRect(chip, 8, 8)
                    p.setPen(QColor(t.get("fg2", "#6B7280")))
                    p.drawText(chip, Qt.AlignCenter, plus_text)
                break
            chip = QRect(cx, cy - 8, w, 16)
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(_soften(color, t)))
            p.drawRoundedRect(chip, 8, 8)
            p.setPen(QColor(color))
            p.drawText(chip, Qt.AlignCenter, tag_text)
            cx += w + 4
        p.restore()


class KanbanColumn(QListWidget):
    """单状态列，接受从其它列拖来的任务卡片；父卡片「N 子」chip 命中展开/收起。"""

    taskDropped = Signal(int, str)        # task_id, 新状态 value
    subtreeToggleRequested = Signal(int)  # 父任务展开/收起

    def __init__(self, status: TaskStatus, parent=None):
        super().__init__(parent)
        self.status = status
        self.empty_text = "拖入任务卡片"
        self.setAcceptDrops(True)
        self.setDragEnabled(True)
        self.setDragDropMode(QListWidget.DragDrop)
        self.setDefaultDropAction(Qt.MoveAction)
        self.setSelectionMode(QAbstractItemView.SingleSelection)
        self.setFrameShape(QListWidget.NoFrame)
        # v0.17: 子任务展开集合（与页面共享；load 时由 KanbanView 覆写引用）
        self._expanded = set()
        # chip 点击命中：对 viewport 事件做旁路检测（chip 区单独消费，其余交给
        # QListWidget 原生行为——选中/拖拽不受影响）
        self._press_pos = None
        self._dragged = False
        self._last_toggle_at = -1.0   # 负数哨兵：进程启动初期 monotonic≈0 时首次点击放行
        self.viewport().installEventFilter(self)

    def _chip_rect_for(self, item: QListWidgetItem) -> QRect:
        row = self.visualItemRect(item)
        depth = int(item.data(_RoleDepth) or 0)
        return _chip_rect(_row_card_rect(row, depth))

    def eventFilter(self, watched, event):
        if watched is self.viewport():
            et = event.type()
            if et == QEvent.MouseButtonPress and event.button() == Qt.LeftButton:
                self._press_pos = event.position().toPoint()
                self._dragged = False
            elif et == QEvent.MouseMove:
                if (event.buttons() & Qt.LeftButton) and self._press_pos is not None and not self._dragged:
                    pos = event.position().toPoint()
                    if (pos - self._press_pos).manhattanLength() >= QApplication.startDragDistance():
                        self._dragged = True
            elif et == QEvent.MouseButtonRelease and event.button() == Qt.LeftButton:
                if not self._dragged and self._press_pos is not None:
                    pos = event.position().toPoint()
                    item = self.itemAt(pos)
                    if item is not None:
                        tid = item.data(_RoleTaskId)
                        if tid and (item.data(_RoleChildCount) or 0):
                            if self._chip_rect_for(item).contains(pos):
                                now = time.monotonic()
                                if now - self._last_toggle_at > 0.35:   # 双击去抖
                                    self._last_toggle_at = now
                                    self.subtreeToggleRequested.emit(int(tid))
                                self._press_pos = None
                                return True
                self._press_pos = None
        return super().eventFilter(watched, event)

    def paintEvent(self, event):  # noqa: N802
        super().paintEvent(event)
        if self.count() == 0:
            p = QPainter(self.viewport())
            p.setRenderHint(QPainter.Antialiasing)
            eng = ThemeEngine.instance()
            fg3 = eng.t("fg3", "#A8AEB6") if eng else "#A8AEB6"
            p.setPen(QColor(fg3))
            f = QFont(self.font())
            f.setPixelSize(12)
            p.setFont(f)
            p.drawText(self.viewport().rect(), Qt.AlignCenter, self.empty_text)
            p.end()

    def dropEvent(self, event):
        source = event.source()
        if isinstance(source, KanbanColumn) and source is not self:
            item = source.currentItem()
            if item is not None:
                tid = item.data(Qt.UserRole)
                if tid:
                    self.taskDropped.emit(tid, self.status.value)
                    event.accept()
                    return
        super().dropEvent(event)


class KanbanView(QWidget):
    """四列看板：列=状态，卡片=根任务，拖拽到列即改状态。

    v0.17：根任务卡片右上角「N 子」chip 点击后，把其未完成子任务以缩进卡片
    展现在同一列（父卡片下方）；展开集合与四象限/日历共享（页面内存态），
    子任务仅作显示层展开，不做状态级联。
    """

    taskDropped = Signal(int, str)        # task_id, 新状态
    openTaskRequested = Signal(int)
    addRequested = Signal(str)            # 新状态 value（列添加入口）
    subtreeToggleRequested = Signal(int)  # 父任务展开/收起

    def __init__(self, parent=None, expanded_ids=None):
        super().__init__(parent)
        self.tag_provider = None
        self._expanded = expanded_ids if expanded_ids is not None else set()
        self._title_labels = {}
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(10)
        self.columns = {}
        for status, label in _STATUSES:
            col = KanbanColumn(status, self)
            col.setItemDelegate(_KanbanDelegate(col))
            col.taskDropped.connect(self.taskDropped.emit)
            col.itemDoubleClicked.connect(self._on_double_clicked)
            col.subtreeToggleRequested.connect(self.subtreeToggleRequested.emit)
            self.columns[status] = col
            card = UCard()
            title_lbl = card.header_title(f"{label} (0)")
            self._title_labels[status] = title_lbl
            card.add_widget(col, 1)
            add_btn = QPushButton("+ 添加")
            add_btn.setCursor(Qt.PointingHandCursor)
            add_btn.clicked.connect(lambda _checked=False, s=status:
                                    self.addRequested.emit(s.value))
            card.add_widget(add_btn, 0)
            lay.addWidget(card, 1)

    def _on_double_clicked(self, item: QListWidgetItem):
        tid = item.data(Qt.UserRole)
        if tid:
            self.openTaskRequested.emit(tid)

    def load(self, tasks):
        """按状态把根任务填入各列；展开的父任务子树以缩进卡片列于其下。

        列头计数=该状态「根任务」数（展开出的子任务仅展示、不并入计数）；
        子任务的完成判定沿用 roll-up（effective_done_map），已完成子树不外显。
        """
        buckets = {s: [] for s, _ in _STATUSES}
        for t in tasks or []:
            if t.parent_id is not None:
                continue
            buckets.get(t.status, buckets[TaskStatus.TODO]).append(t)

        eff = effective_done_map(list(tasks or [])) if tasks else {}

        def is_eff_done(t) -> bool:
            return bool(eff.get(t.id, t.is_done))

        def visible_kids(t):
            return [k for k in (getattr(t, "children", []) or [])
                    if not is_eff_done(k)]

        entries = {s: [] for s, _ in _STATUSES}   # status -> [(task, depth)]（树序）
        for s, _ in _STATUSES:
            def emit(t, depth, key=s):
                entries[key].append((t, depth))
                if t.id in self._expanded:
                    for k in visible_kids(t):
                        emit(k, depth + 1)
            for t in buckets[s]:
                emit(t, 0)

        all_ids = []
        for s, _ in _STATUSES:
            all_ids.extend(t.id for t, _d in entries[s] if t.id is not None)
        tags_by_id = {}
        if self.tag_provider and all_ids:
            try:
                tags_by_id = self.tag_provider(all_ids) or {}
            except Exception:
                tags_by_id = {}

        for status, label in _STATUSES:
            col = self.columns[status]
            col._expanded = self._expanded
            col.clear()
            for t, depth in entries[status]:
                item = QListWidgetItem()
                item.setText(t.title or "（无标题）")
                item.setData(_RoleTaskId, t.id)
                item.setData(_RolePriority, int(t.priority or 0))
                item.setData(_RoleDue, t.due_date)
                item.setData(_RoleTags, tags_by_id.get(t.id, []))
                item.setData(_RoleDepth, depth)
                item.setData(_RoleChildCount, len(visible_kids(t)))
                item.setSizeHint(QSize(0, 58))
                col.addItem(item)
            self._title_labels[status].setText(f"{label} ({len(buckets[status])})")
            col.viewport().update()
