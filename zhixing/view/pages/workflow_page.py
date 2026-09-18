# -*- coding: utf-8 -*-
"""工作流页：模板编排（矩形节点图）+ 实例运行面板。

设计（对照外部设计稿，复用本项目既有基建）：
- 节点图复用图谱页的 QGraphicsScene/QGraphicsView 交互范式（拖拽移动、连线、
  滚轮缩放、中/右键平移），但节点采用**矩形**（流程步骤的通用表达）；
- 左侧模板列表 + 中间节点图 + 右侧实例面板，三栏 QSplitter；
- 与任务双向绑定：模板可「启动实例」；实例步骤即真实任务（子任务），
  任务完成时由 AppController 回推流程（见 WorkflowService.complete_step_task）。
"""
from typing import Dict, List, Optional

from PySide6.QtCore import QPoint, QPointF, QRect, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import (QDialog, QFormLayout, QGraphicsItem, QGraphicsPathItem, QGraphicsScene, QGraphicsView, QHBoxLayout, QListWidgetItem, QMenu, QMessageBox, QSplitter, QStyledItemDelegate, QStyleOptionViewItem, QVBoxLayout, QWidget)

from ...model.domain.entities import (
    StartPolicy, StepAction, WorkflowNode, WorkflowStatus, WorkflowTemplate,
)
from ..components.general import EmptyState
from ..kit import icons
from qfluent_core import ThemeManager as ThemeEngine
from ..ui import DialogType, UButton, UCard, UDialog, UInputDialog, PageHeader
from zhixing.view.kit.fluent_compat import QComboBox, QLabel, QLineEdit, QPlainTextEdit, QPushButton
from zhixing.view.kit.fluent_compat import QListWidget
from zhixing.view.kit.fluent_compat import QCheckBox, QToolButton

def _elide_multiline(fm, text: str, rect) -> str:
    """多行省略：若文本在 rect 内放不下，逐字截断并补「…」，
    保证节点信息不溢出、不堆叠（配合 TextWordWrap 使用）。
    """
    if not text:
        return ""
    w, h = int(rect.width()), int(rect.height())
    if fm.boundingRect(0, 0, w, 1000, Qt.TextWordWrap, text).height() <= h:
        return text
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        cand = text[:mid] + "…"
        if fm.boundingRect(0, 0, w, 1000, Qt.TextWordWrap, cand).height() <= h:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo] + "…"


#: 节点矩形尺寸（流程步骤：宽 × 高）——加高以容纳「序号 + 标题 + 角标」分行不堆叠
_NODE_W = 176.0
_NODE_H = 64.0


class TemplateListDelegate(QStyledItemDelegate):
    """模板列表行：悬浮时右侧浮出「重命名 / 复制 / 删除」图标胶囊按钮。

    与任务行 / 笔记树行同款交互（对齐 NoteTreeDelegate 的做法）：
    - 胶囊软底 + 圆角 + SVG 图标，仅 hover 浮出、不占位；
    - 图标按 dpr 超采样渲染（Retina 不发虚）；
    - 命中经信号外发给 WorkflowPage 处理。
    """

    renameRequested = Signal(int)      # 参数 = 模板 id
    duplicateRequested = Signal(int)
    deleteRequested = Signal(int)

    #: 行高（对齐笔记树 34px）
    ROW_H = 34

    def __init__(self, parent=None):
        super().__init__(parent)
        self._cap_h = 20   # 胶囊边长（正方形，随行高已固定 34px 配 20px）

    def paint(self, p, option, index):
        from PySide6.QtWidgets import QStyle
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        p.save()
        p.setRenderHint(QPainter.Antialiasing)
        dpr = 1.0
        if option.widget is not None:
            try:
                dpr = option.widget.devicePixelRatioF()
            except Exception:  # noqa: BLE001
                dpr = 1.0
        rect = option.rect
        selected = option.state & QStyle.State_Selected
        hovered = option.state & QStyle.State_MouseOver

        if selected or hovered:
            mask = rect.adjusted(3, 2, -3, -2)
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(t.get("accent_soft", "#D9F2EE") if selected
                              else t.get("hover", "#F1F5F3")))
            p.drawRoundedRect(mask, 8, 8)

        fg = QColor(t.get("fg", "#1A1A1A"))
        fg2 = QColor(t.get("fg2", "#6B7280"))
        title = str(index.data(Qt.DisplayRole) or "")

        # 文本区：悬浮时右侧让位给按钮组
        btns = self._buttons(option, hovered)
        right_limit = rect.right() - 8
        if btns:
            right_limit = min(r.x() for r in btns.values()) - 6
        f = QFont(option.font)
        if selected:
            f.setBold(True)
        p.setFont(f)
        p.setPen(fg if selected else fg2)
        title_rect = QRect(rect.x() + 10, rect.y(),
                           max(20, right_limit - rect.x() - 14), rect.height())
        p.drawText(title_rect, Qt.AlignVCenter | Qt.AlignLeft,
                   p.fontMetrics().elidedText(title, Qt.ElideRight,
                                              title_rect.width()))

        if hovered and btns:
            self._paint_buttons(p, option, btns, t, dpr)
        p.restore()

    # ---------- 几何 ----------
    def sizeHint(self, option, index):
        return QRect(0, 0, 120, self.ROW_H).size()

    def _buttons(self, option, hovered: bool):
        """胶囊矩形按键字典（仅悬浮时给出）。

        键：rename / dup / del —— 绘制与命中都用键取矩形，不依赖列表顺序，
        消除 zip 配对错位隐患。
        """
        if not hovered:
            return {}
        rect = option.rect
        cap = self._cap_h
        gap = 4
        top = int(rect.center().y()) - cap // 2
        right = rect.right() - 6
        out = {}
        # 从右到左：del / dup / rename
        for key in ("del", "dup", "rename"):
            out[key] = QRect(right - cap, top, cap, cap)
            right -= (cap + gap)
        return out

    def _paint_buttons(self, p, option, btns, t, dpr: float):
        mouse = self._mouse_pos(option)
        accent = t.get("accent", "#0D9488")
        danger = t.get("danger", "#DC2626")
        specs = (("rename", "action.edit", accent, "重命名"),
                 ("dup", "action.copy", accent, "复制一份"),
                 ("del", "data.trash", danger, "删除"))
        for key, icon_name, tone, _tip in specs:
            rect = btns.get(key)
            if rect is None:
                continue
            hover = mouse is not None and rect.contains(mouse)
            bg = QColor(tone)
            bg.setAlpha(46 if hover else 28)
            p.setPen(Qt.NoPen)
            p.setBrush(bg)
            p.drawRoundedRect(rect, rect.height() / 2, rect.height() / 2)
            sz = max(11, rect.height() - 8)
            pm = icons.pixmap(icon_name, tone, sz, dpr)
            p.drawPixmap(QRect(int(rect.center().x() - sz / 2),
                               int(rect.center().y() - sz / 2), sz, sz), pm)

    def _mouse_pos(self, option):
        """光标在控件（viewport）坐标系中的位置（对齐 NoteTreeDelegate）。"""
        try:
            from PySide6.QtGui import QCursor
            w = option.widget
            if w is not None:
                return w.mapFromGlobal(QCursor.pos())
        except Exception:  # noqa: BLE001
            return None
        return None

    # ---------- 交互 ----------
    def editorEvent(self, event, model, option, index):
        from PySide6.QtCore import QEvent
        from PySide6.QtWidgets import QStyle
        if event.type() != QEvent.MouseButtonRelease:
            return super().editorEvent(event, model, option, index)
        pos = event.position().toPoint() if hasattr(event, "position") else event.pos()
        mouse = self._mouse_pos(option)
        row_rect = option.rect.adjusted(2, 0, -2, 0)
        hovered = bool(option.state & QStyle.State_MouseOver)
        if not hovered and mouse is not None:
            hovered = row_rect.contains(mouse)
        if not hovered:
            return False
        tpl_id = index.data(Qt.UserRole)
        if tpl_id is None:
            return False
        btns = self._buttons(option, True)
        for key, sig in (("rename", self.renameRequested),
                         ("dup", self.duplicateRequested),
                         ("del", self.deleteRequested)):
            rect = btns.get(key)
            if rect is not None and rect.contains(pos):
                sig.emit(tpl_id)
                return True
        return False


class _StepNodeItem(QGraphicsPathItem):
    """流程步骤节点：圆角矩形 + 序号徽标 + 标题（可换行）+ 角标（文档/动作/条件/分支）。

    交互：可拖动（位置持久化到 pos_x/pos_y）、可选中、**双击打开编辑**。
    """

    def __init__(self, node: WorkflowNode, page: "WorkflowPage"):
        super().__init__()
        self.node = node
        self.page = page
        self.setFlag(QGraphicsItem.ItemIsMovable)
        self.setFlag(QGraphicsItem.ItemIsSelectable)
        self.setFlag(QGraphicsItem.ItemSendsGeometryChanges)
        self.setAcceptHoverEvents(True)
        self.setCursor(Qt.PointingHandCursor)
        self.setZValue(2)
        self._build_path()
        self._apply_style()

    def _build_path(self):
        path = QPainterPath()
        path.addRoundedRect(QRectF(-_NODE_W / 2, -_NODE_H / 2, _NODE_W, _NODE_H),
                            10.0, 10.0)
        self.setPath(path)

    def radius(self) -> float:
        return _NODE_H / 2

    def boundingRect(self) -> QRectF:
        return super().boundingRect().adjusted(-6, -6, 6, 6)

    def _apply_style(self):
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        layer = QColor(t.get("layer", "#FFFFFF"))
        accent = QColor(t.get("accent", "#0D9488"))
        border = QColor(t.get("border2", "#CBD8D0"))
        self.setBrush(layer)
        self.setPen(QPen(accent if self.isSelected() else border,
                         2.0 if self.isSelected() else 1.4))

    def itemChange(self, change, value):  # noqa: N802
        if change == QGraphicsPathItem.ItemPositionHasChanged and self.scene() is not None:
            # 内存回写坐标（不落库，落库在 mouseReleaseEvent 防抖）
            self.node.pos_x = self.pos().x()
            self.node.pos_y = self.pos().y()
            self.page.refresh_edges()
        elif change == QGraphicsPathItem.ItemSelectedHasChanged:
            self._apply_style()
        return super().itemChange(change, value)

    def mouseReleaseEvent(self, ev):  # noqa: N802
        super().mouseReleaseEvent(ev)
        self.page.persist_positions()   # 拖动结束 → 防抖静默保存坐标

    def mouseDoubleClickEvent(self, ev):  # noqa: N802
        """双击打开编辑。"""
        self.page.edit_node(self.node)
        ev.accept()

    def paint(self, p: QPainter, option, widget=None):
        super().paint(p, option, widget)
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        fg = QColor(t.get("fg", "#1A1A1A"))
        fg2 = QColor(t.get("fg2", "#6B7280"))
        accent = QColor(t.get("accent", "#0D9488"))
        p.setRenderHint(QPainter.Antialiasing)
        # ① 序号徽标：左上角小圆 + 白字
        idx = self.page.node_index(self.node)
        p.setPen(Qt.NoPen)
        p.setBrush(accent)
        p.drawEllipse(QPointF(-_NODE_W / 2 + 19, -_NODE_H / 2 + 19), 11, 11)
        p.setPen(QColor("#FFFFFF"))
        f = QFont(); f.setPixelSize(11); f.setBold(True)
        p.setFont(f)
        p.drawText(QRectF(-_NODE_W / 2 + 8, -_NODE_H / 2 + 8, 22, 22),
                   Qt.AlignCenter, str(idx + 1))
        # ② 标题：从序号右侧起，自动换行两行（不堆叠到角标，超长省略）
        p.setPen(fg)
        tf = QFont(); tf.setPixelSize(13); tf.setBold(True)
        p.setFont(tf)
        fm = p.fontMetrics()
        title_rect = QRectF(-_NODE_W / 2 + 40, -_NODE_H / 2 + 4,
                             _NODE_W - 54, _NODE_H - 26)
        title = self.node.title or "（未命名步骤）"
        # 用 TextWordWrap 自动换行；超出两行的部分用省略号截断（保证信息可读、不溢出）
        p.drawText(title_rect, Qt.AlignLeft | Qt.AlignTop | Qt.TextWordWrap,
                   _elide_multiline(fm, title, title_rect))
        # ③ 角标：底部独立一行（文档/动作/条件/分支），不占用标题区
        marks = []
        if self.node.note_id:
            marks.append("文档")
        if (self.node.action_kind or "") != StepAction.NONE.value:
            marks.append("动作")
        if self.node.condition:
            marks.append("条件")
        if self.page.is_branch_target(self.node):
            marks.append("分支")
        if marks:
            p.setPen(fg2)
            mf = QFont(); mf.setPixelSize(10)
            p.setFont(mf)
            mark_rect = QRectF(-_NODE_W / 2 + 14, _NODE_H / 2 - 19,
                               _NODE_W - 28, 15)
            p.drawText(mark_rect, Qt.AlignLeft | Qt.AlignVCenter,
                       fm.elidedText(" · ".join(marks), Qt.ElideRight,
                                     int(mark_rect.width())))


class _FlowEdgeItem(QGraphicsPathItem):
    """步骤间的连线：**三次贝塞尔曲线** + 箭头（沿终点切线方向）。

    顺序边实线、条件分支边虚线；箭头方向随节点相对位置自动变化。
    """

    #: 命中区加宽（px）：细曲线实体只有 1.6px，加宽后便于点选
    _HIT_WIDTH = 12.0

    # 弯曲量参数：克制弧线（12% 弦长，封顶 40px），随距离连续变化
    _BEND_RATIO = 0.12
    _BEND_MAX = 40.0
    # 弯曲方向过渡带宽（px）：src/dst 水平相对位置在 ±该范围内时，
    # 弯曲方向平滑从一侧过渡到另一侧（近垂直对齐时曲线几乎压平）。
    _SIDE_SOFT = 90.0

    def __init__(self, src: _StepNodeItem, dst: _StepNodeItem, dashed: bool = False,
                 label: str = ""):
        super().__init__()
        self.src, self.dst = src, dst
        self.dashed = dashed
        self.label = (label or "").strip()   # 条件分支标签（仅分支边显示）
        self._selected = False
        self.setFlag(QGraphicsItem.ItemIsSelectable)
        self.setAcceptHoverEvents(True)
        self.setZValue(1)
        self._apply_style()
        self.update_path()

    def shape(self):
        """加宽命中区：让细曲线可被可靠点选。"""
        from PySide6.QtGui import QPainterPathStroker
        stroker = QPainterPathStroker()
        stroker.setWidth(self._HIT_WIDTH)
        return stroker.createStroke(super().shape())

    def set_selected(self, on: bool):
        """选中态：加粗 + 端点手柄（用于删除/改挂）。"""
        if self._selected != on:
            self._selected = on
            self.setSelected(on)
            self._apply_style()

    def hoverEnterEvent(self, ev):  # noqa: N802
        self.setCursor(Qt.PointingHandCursor)
        super().hoverEnterEvent(ev)

    def hoverLeaveEvent(self, ev):  # noqa: N802
        self.unsetCursor()
        super().hoverLeaveEvent(ev)

    def _apply_style(self):
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        color = QColor(t.get("accent" if self.dashed else "fg2",
                             "#0D9488" if self.dashed else "#6B7280"))
        color.setAlpha(255 if self._selected else 200)
        width = 2.6 if self._selected else 1.6
        pen = QPen(color, width, Qt.DashLine if self.dashed else Qt.SolidLine)
        self.setPen(pen)
        self.setBrush(Qt.NoBrush)

    def _anchors(self):
        """返回连线的实际起止点（贴节点边缘，取两者连线方向与矩形边的交点）。"""
        p1, p2 = self.src.pos(), self.dst.pos()
        dx, dy = p2.x() - p1.x(), p2.y() - p1.y()
        dist = (dx * dx + dy * dy) ** 0.5
        if dist < 1.0:
            return p1, p2
        # 沿连线方向，从节点中心缩到矩形边缘（近似：按半宽半高夹取）
        ux, uy = dx / dist, dy / dist
        hw, hh = _NODE_W / 2 + 4, _NODE_H / 2 + 4
        # 用矩形边界求交点（简化：按方向分量的边界缩放）
        sx = hw / (abs(ux) if abs(ux) > 1e-6 else 1e-6)
        sy = hh / (abs(uy) if abs(uy) > 1e-6 else 1e-6)
        s = min(sx, sy)
        start = QPointF(p1.x() + ux * s, p1.y() + uy * s)
        end = QPointF(p2.x() - ux * s, p2.y() - uy * s)
        return start, end

    def update_path(self):
        start, end = self._anchors()
        self._c2 = end   # 默认（退化直线时切线参考即终点）
        dx, dy = end.x() - start.x(), end.y() - start.y()
        dist = (dx * dx + dy * dy) ** 0.5
        path = QPainterPath(start)
        if dist < 1.0:
            path.lineTo(end)
        else:
            # 三次贝塞尔：控制点沿连线方向分布，产生柔和曲线（自由拖动后仍自然）
            ux, uy = dx / dist, dy / dist
            bend = min(self._BEND_MAX, dist * self._BEND_RATIO)  # 弯曲量随距离连续变化
            # 弯曲方向由两节点相对水平位置连续驱动（softsign，无档位）：
            # src 在 dst 左侧 → 向上拱，右侧 → 向下拱，垂直对齐 → 近直线；
            # 拖动穿越对齐线时曲线先压平再弯向另一侧，无镜像翻转跳变。
            dxw = end.x() - start.x()
            side = dxw / ((dxw * dxw + self._SIDE_SOFT * self._SIDE_SOFT) ** 0.5)
            px, py = -uy * side, ux * side
            c1 = QPointF(start.x() + ux * dist * 0.4 + px * bend,
                         start.y() + uy * dist * 0.4 + py * bend)
            c2 = QPointF(start.x() + ux * dist * 0.6 + px * bend,
                         start.y() + uy * dist * 0.6 + py * bend)
            path.cubicTo(c1, c2, end)
            self._c2 = c2
        self._end_point = end
        # 箭头切线方向 = end - c2（三次贝塞尔末端切线），随节点相对方向变化
        self._end_dir = (end.x() - self._c2.x(), end.y() - self._c2.y())
        self.setPath(path)

    def paint(self, p: QPainter, option, widget=None):
        super().paint(p, option, widget)
        # 箭头：沿曲线终点切线方向，跟随被连接节点的方向变化
        end = getattr(self, "_end_point", None)
        if end is None:
            return
        tx, ty = getattr(self, "_end_dir", (1.0, 0.0))
        import math
        tn = math.hypot(tx, ty)
        if tn < 1e-6:
            return
        ux, uy = tx / tn, ty / tn
        size = 9.0
        left = QPointF(end.x() - ux * size - uy * size * 0.6,
                       end.y() - uy * size + ux * size * 0.6)
        right = QPointF(end.x() - ux * size + uy * size * 0.6,
                        end.y() - uy * size - ux * size * 0.6)
        p.setRenderHint(QPainter.Antialiasing)
        p.setPen(self.pen())
        p.setBrush(self.pen().color())
        tri = QPainterPath(end)
        tri.lineTo(left)
        tri.lineTo(right)
        tri.closeSubpath()
        p.drawPath(tri)
        # 条件分支标签：画在曲线中点上方（仅分支边、label 非空时）
        label = getattr(self, "label", "")
        if label:
            start_a, end_a = self._anchors()
            mx, my = (start_a.x() + end_a.x()) / 2, (start_a.y() + end_a.y()) / 2
            eng = ThemeEngine.instance()
            t = eng.tokens if eng else {}
            fg = QColor(t.get("fg2", "#6B7280"))
            font = QFont(p.font())
            font.setPointSizeF(max(8.0, font.pointSizeF() - 1.0))
            p.setFont(font)
            fm = p.fontMetrics()
            tw = fm.horizontalAdvance(label) + 10
            th = fm.height() + 4
            bg = QColor(t.get("bg", "#FFFFFF"))
            bg.setAlpha(220)
            p.setPen(QPen(fg, 1.0))
            p.setBrush(bg)
            p.drawRoundedRect(QRectF(mx - tw / 2, my - th - 6, tw, th), 4, 4)
            p.setPen(QColor(t.get("fg", "#111827")))
            p.drawText(QRectF(mx - tw / 2, my - th - 6, tw, th),
                       Qt.AlignCenter, label)
        # 选中态：绘制两端圆形手柄（可拖拽改挂，同图谱交互）
        if self._selected:
            eng = ThemeEngine.instance()
            t = eng.tokens if eng else {}
            accent = QColor(t.get("accent", "#0D9488"))
            layer = QColor(t.get("layer", "#FFFFFF"))
            start, _end2 = self._anchors()
            p.setRenderHint(QPainter.Antialiasing)
            for pt in (start, end):
                p.setPen(QPen(layer, 2.0))
                p.setBrush(accent)
                p.drawEllipse(pt, 7.0, 7.0)

class _FlowView(QGraphicsView):
    """节点图画布：拖拽移动、滚轮缩放、中/右键平移、连线模式拖拽建立分支。"""

    nodeMoved = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.page: Optional["WorkflowPage"] = None
        self.setScene(QGraphicsScene(self))
        self.setRenderHint(QPainter.Antialiasing)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.setDragMode(QGraphicsView.NoDrag)   # 左键留给选中/拖节点
        self.setFocusPolicy(Qt.StrongFocus)
        self._zoom = 1.0
        self._pan_origin = None
        self._link_src: Optional[_StepNodeItem] = None
        self._link_line = None
        self._selected_edge: Optional[_FlowEdgeItem] = None
        self._rewire_edge: Optional[_FlowEdgeItem] = None   # 正在改挂的边
        self._rewire_end: str = ""                          # "src" | "dst"
        self._rewire_line = None

    def wheelEvent(self, ev):  # noqa: N802
        factor = 1.15 if ev.angleDelta().y() > 0 else 1 / 1.15
        self._zoom = max(0.3, min(2.5, self._zoom * factor))
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setTransform(self.transform().scale(factor, factor))

    def fit_all(self):
        rect = self.scene().itemsBoundingRect().adjusted(-60, -60, 60, 60)
        if rect.isEmpty():
            return
        self.fitInView(rect, Qt.KeepAspectRatio)

    def _node_at(self, pos) -> Optional[_StepNodeItem]:
        for it in self.scene().items(self.mapToScene(pos)):
            if isinstance(it, _StepNodeItem):
                return it
        return None

    def _edge_at(self, pos) -> Optional[_FlowEdgeItem]:
        """命中连线（利用 shape() 加宽命中区）。"""
        for it in self.scene().items(self.mapToScene(pos)):
            if isinstance(it, _FlowEdgeItem):
                return it
        return None

    def clear_edge_state(self):
        """清空「选中连线 / 正在改挂」状态（场景重建前必须调用）。"""
        self._selected_edge = None
        self._clear_rewire()

    def select_edge(self, edge):
        """选中/取消选中连线（分支边可删除/改挂，顺序边仅高亮）。"""
        if self._selected_edge is edge:
            return
        if self._selected_edge is not None and self._selected_edge.scene() is not None:
            self._selected_edge.set_selected(False)
        self._selected_edge = edge
        if edge is not None:
            edge.set_selected(True)
            if self.page is not None:
                self.page._set_hint_for_edge(edge)

    def _endpoint_at(self, pos):
        """命中选中连线的端点 → (edge, "src"/"dst")。"""
        edge = self._selected_edge
        if edge is None or edge.scene() is None:
            return None, ""
        sp = self.mapToScene(pos)
        grab = 14.0 / max(0.3, self._zoom)
        start, end = edge._anchors()
        for label, pt in (("src", start), ("dst", end)):
            dx, dy = sp.x() - pt.x(), sp.y() - pt.y()
            if (dx * dx + dy * dy) ** 0.5 <= grab:
                return edge, label
        return None, ""

    def _begin_rewire(self, edge: _FlowEdgeItem, end: str):
        """开始拖动改挂：记录边与端点，画橡皮筋线。"""
        self._rewire_edge = edge
        self._rewire_end = end
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        color = QColor(t.get("accent", "#0D9488"))
        line = QGraphicsPathItem()
        line.setPen(QPen(color, 1.8, Qt.DashLine))
        line.setZValue(20)
        anchor = edge.src.pos() if end == "dst" else edge.dst.pos()
        path = QPainterPath(anchor)
        path.lineTo(anchor)
        line.setPath(path)
        self.scene().addItem(line)
        self._rewire_line = line

    def _finish_rewire(self, pos):
        """释放：落到新节点则改挂该端，否则取消。"""
        edge, end = self._rewire_edge, self._rewire_end
        self._clear_rewire()
        if edge is None or self.page is None:
            return
        target = self._node_at(pos)
        if target is None:
            return
        self.page.rewire_flow_edge(edge, end, target)

    def _clear_rewire(self):
        if self._rewire_line is not None and self._rewire_line.scene() is not None:
            self.scene().removeItem(self._rewire_line)
        self._rewire_line = None
        self._rewire_edge = None
        self._rewire_end = ""

    def delete_selected_edge(self) -> bool:
        """删除选中连线（分支边 → 清空 branch；顺序边 → 提示）。"""
        edge = self._selected_edge
        if edge is None or self.page is None:
            return False
        ok = self.page.remove_flow_edge(edge)
        if ok:
            self._selected_edge = None
        return ok

    def keyPressEvent(self, ev):  # noqa: N802
        """Delete/Backspace 删除选中连线；Esc 取消选中/连线模式。"""
        if ev.key() in (Qt.Key_Delete, Qt.Key_Backspace):
            if self.delete_selected_edge():
                ev.accept()
                return
        elif ev.key() == Qt.Key_Escape:
            if self._link_src is not None:
                self._cancel_branch()
            else:
                self.select_edge(None)
            ev.accept()
            return
        super().keyPressEvent(ev)

    def start_branch_from(self, node: _StepNodeItem):
        """进入连线模式：从该节点拖到另一节点 = 设置条件分支。"""
        self._link_src = node
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        line = QGraphicsPathItem()
        pen = QPen(QColor(t.get("accent", "#0D9488")), 1.8, Qt.DashLine)
        line.setPen(pen)
        line.setZValue(10)
        path = QPainterPath(node.pos())
        path.lineTo(node.pos())
        line.setPath(path)
        self.scene().addItem(line)
        self._link_line = line
        self.setCursor(Qt.CrossCursor)

    def _cancel_branch(self):
        if self._link_line is not None and self._link_line.scene() is not None:
            self.scene().removeItem(self._link_line)
        self._link_line = None
        self._link_src = None
        self.setCursor(Qt.ArrowCursor)

    def mousePressEvent(self, ev):  # noqa: N802
        pos = ev.position().toPoint()
        if ev.button() in (Qt.MiddleButton, Qt.RightButton):
            self._pan_origin = pos
            self.setCursor(Qt.ClosedHandCursor)
            ev.accept()
            return
        if ev.button() == Qt.LeftButton:
            self.setFocus()
            node = self._node_at(pos)
            if self._link_src is not None and node is not None and node is not self._link_src:
                src = self._link_src
                self._cancel_branch()
                if self.page is not None:
                    self.page.set_branch(src.node, node.node)
                ev.accept()
                return
            # 非连线模式：优先命中选中连线的端点 → 开始改挂
            if self._link_src is None:
                edge, end = self._endpoint_at(pos)
                if edge is not None:
                    self._begin_rewire(edge, end)
                    ev.accept()
                    return
                # 命中连线本体 → 选中
                hit_edge = self._edge_at(pos)
                if hit_edge is not None:
                    self.select_edge(hit_edge)
                    ev.accept()
                    return
            if node is None:
                # 点空白：取消选中 + 左键拖动画布（标准图编辑器行为）
                self.scene().clearSelection()
                if self._link_src is None:
                    self._pan_origin = pos
                    self.setCursor(Qt.ClosedHandCursor)
                    ev.accept()
                    return
        super().mousePressEvent(ev)

    def mouseMoveEvent(self, ev):  # noqa: N802
        pos_pt = ev.position().toPoint()
        if self._pan_origin is not None:
            delta = pos_pt - self._pan_origin
            self._pan_origin = pos_pt
            h, v = self.horizontalScrollBar(), self.verticalScrollBar()
            h.setValue(h.value() - delta.x())
            v.setValue(v.value() - delta.y())
            ev.accept()
            return
        if self._link_src is not None and self._link_line is not None:
            cur = self.mapToScene(pos_pt)
            path = QPainterPath(self._link_src.pos())
            path.lineTo(cur)
            self._link_line.setPath(path)
            ev.accept()
            return
        if self._rewire_edge is not None and self._rewire_line is not None:
            cur = self.mapToScene(pos_pt)
            anchor = (self._rewire_edge.src.pos() if self._rewire_end == "dst"
                      else self._rewire_edge.dst.pos())
            path = QPainterPath(anchor)
            path.lineTo(cur)
            self._rewire_line.setPath(path)
            ev.accept()
            return
        super().mouseMoveEvent(ev)

    def mouseReleaseEvent(self, ev):  # noqa: N802
        if self._pan_origin is not None:
            self._pan_origin = None
            self.setCursor(Qt.ArrowCursor)
            ev.accept()
            return
        if self._link_src is not None:
            self._cancel_branch()
            ev.accept()
            return
        if self._rewire_edge is not None:
            self._finish_rewire(ev.position().toPoint())
            ev.accept()
            return
        super().mouseReleaseEvent(ev)

    def keyPressEvent(self, ev):  # noqa: N802
        if ev.key() == Qt.Key_Escape and self._link_src is not None:
            self._cancel_branch()
            ev.accept()
            return
        super().keyPressEvent(ev)


class _StepEditDialog(UDialog):
    """步骤编辑：标题 / 说明 / 绑定文档 / 动作 / 条件。"""

    def __init__(self, page: "WorkflowPage", node: Optional[WorkflowNode] = None,
                 parent=None, branchable: bool = False,
                 branch_label: str = ""):
        super().__init__("编辑步骤" if node else "新增步骤", parent=parent,
                         dialog_type=DialogType.INPUT, icon_name="action.edit",
                         width=520, height=440)
        self.page = page
        self.node = node or WorkflowNode()
        body = QWidget()
        lay = QVBoxLayout(body)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(8)
        form = QFormLayout()
        form.setContentsMargins(0, 0, 0, 0)
        self.title_edit = QLineEdit(self.node.title)
        self.title_edit.setPlaceholderText("这一步要做什么（必填）")
        form.addRow("标题", self.title_edit)
        self.detail_edit = QPlainTextEdit(self.node.detail)
        self.detail_edit.setPlaceholderText("补充说明（可选）")
        self.detail_edit.setFixedHeight(70)
        form.addRow("说明", self.detail_edit)
        # 绑定知识库文档
        self.note_combo = QComboBox()
        self.note_combo.addItem("（不绑定）", None)
        for nid, title in page.note_choices():
            self.note_combo.addItem(title, nid)
        idx = self.note_combo.findData(self.node.note_id)
        self.note_combo.setCurrentIndex(max(0, idx))
        form.addRow("SOP 文档", self.note_combo)
        # 动作
        self.action_combo = QComboBox()
        for value, label in (
                (StepAction.NONE.value, "无动作"),
                (StepAction.OPEN_NOTE.value, "打开绑定文档"),
                (StepAction.OPEN_URL.value, "打开网址"),
                (StepAction.RUN_COMMAND.value, "运行本地命令（有风险）")):
            self.action_combo.addItem(label, value)
        ai = self.action_combo.findData(self.node.action_kind)
        self.action_combo.setCurrentIndex(max(0, ai))
        form.addRow("动作", self.action_combo)
        self.action_value = QLineEdit(self.node.action_value)
        self.action_value.setPlaceholderText("网址或命令（「打开绑定文档」可留空）")
        form.addRow("动作参数", self.action_value)
        self.condition_edit = QLineEdit(self.node.condition)
        self.condition_edit.setPlaceholderText("进入本步的条件（可选，供人工判断）")
        form.addRow("条件", self.condition_edit)
        # 新增时若当前选中了节点，可勾选「作为其条件分支」
        if branchable:
            
            self.branch_check = QCheckBox(f"作为「{branch_label}」的条件分支（条件满足时从其跳到此步）")
            self.branch_check.setChecked(False)
            form.addRow("分支", self.branch_check)
        else:
            self.branch_check = None
        lay.addLayout(form)
        lay.addStretch(1)
        self.setContentWidget(body, 1)
        row = QHBoxLayout()
        row.addStretch(1)
        cancel = UButton("取消", tone="default", kind="ghost")
        cancel.clicked.connect(self.reject)
        ok = UButton("确定", tone="accent", kind="solid")
        ok.clicked.connect(self._confirm)
        row.addWidget(cancel)
        row.addWidget(ok)
        self.add_layout(row)

    def _confirm(self):
        if not self.title_edit.text().strip():
            QMessageBox.warning(self, "知行", "请填写步骤标题")
            return
        if self.action_combo.currentData() == StepAction.RUN_COMMAND.value:
            if not self.action_value.text().strip():
                QMessageBox.warning(self, "知行", "请填写要运行的命令")
                return
            # 运行本地命令有安全风险：保存时也提示一次
            ans = QMessageBox.question(
                self, "风险确认",
                "该步骤配置为「运行本地命令」，执行时会启动本机进程。\n\n"
                "请确认命令来源可信。是否保存？",
                QMessageBox.Yes | QMessageBox.No, QMessageBox.No)
            if ans != QMessageBox.Yes:
                return
        self.accept()

    def result_node(self) -> WorkflowNode:
        """把表单内容写回节点对象（调用方在 exec() 接受后读取）。"""
        n = self.node
        n.title = self.title_edit.text().strip()
        n.detail = self.detail_edit.toPlainText()
        n.note_id = self.note_combo.currentData()
        n.action_kind = self.action_combo.currentData() or StepAction.NONE.value
        n.action_value = self.action_value.text().strip()
        n.condition = self.condition_edit.text().strip()
        if getattr(self, "branch_check", None) is not None:
            self.as_branch = self.branch_check.isChecked()
        return n

class WorkflowPage(QWidget):
    """工作流页：左侧模板列表 · 中间节点图 · 右侧实例运行面板。"""

    def __init__(self, workflow_service, note_service, settings=None, parent=None):
        super().__init__(parent)
        self.wf = workflow_service
        self.notes = note_service
        self.settings = settings
        self._tpl: Optional[WorkflowTemplate] = None
        self._nodes: Dict[int, _StepNodeItem] = {}
        self._edges: List[_FlowEdgeItem] = []
        self._instances: List = []
        self._templates: List = []
        self._build()
        self._restyle()
        ThemeEngine.instance() and ThemeEngine.instance().changed.connect(self._restyle)

    def _build(self):
        lay = QVBoxLayout(self)
        lay.setContentsMargins(24, 16, 24, 16)
        lay.setSpacing(10)
        self.header = PageHeader("工作流", "把重复事务沉淀为标准流程，一键启动并自动拆解为待办")
        lay.addWidget(self.header)
        split = QSplitter(Qt.Horizontal)
        lay.addWidget(split, 1)
        split.addWidget(self._build_left())
        split.addWidget(self._build_mid())
        split.addWidget(self._build_right())
        split.setSizes([260, 620, 300])

    def _build_left(self) -> UCard:
        host = QWidget()
        ll = QVBoxLayout(host)
        ll.setContentsMargins(0, 0, 0, 0)
        ll.setSpacing(6)
        self.tpl_list = QListWidget()
        self.tpl_list.currentRowChanged.connect(self._on_template_selected)
        self.tpl_list.setContextMenuPolicy(Qt.CustomContextMenu)
        self.tpl_list.customContextMenuRequested.connect(self._template_menu)
        # 悬浮胶囊按钮（重命名/复制/删除）：对齐任务行/笔记树行交互
        self.tpl_delegate = TemplateListDelegate(self.tpl_list)
        self.tpl_list.setItemDelegate(self.tpl_delegate)
        self.tpl_list.setMouseTracking(True)
        self.tpl_list.viewport().setMouseTracking(True)
        self.tpl_delegate.renameRequested.connect(self._rename_template_by_id)
        self.tpl_delegate.duplicateRequested.connect(self._duplicate_template_by_id)
        self.tpl_delegate.deleteRequested.connect(self._delete_template_by_id)
        ll.addWidget(self.tpl_list, 1)
        row = QHBoxLayout()
        row.setSpacing(6)
        self.new_btn = UButton("新建", tone="accent", kind="solid")
        self.new_btn.clicked.connect(self._new_template)
        row.addWidget(self.new_btn)
        row.addStretch(1)
        ll.addLayout(row)
        card = UCard("流程模板")
        card.add_widget(host, 1)
        return card

    def _build_mid(self) -> UCard:
        host = QWidget()
        ml = QVBoxLayout(host)
        ml.setContentsMargins(0, 0, 0, 0)
        ml.setSpacing(6)
        bar = QHBoxLayout()
        bar.setSpacing(6)
        self.add_step_btn = self._tool_button("＋ 步骤", self._add_step)
        self.edit_step_btn = self._tool_button("编辑", self._edit_step)
        self.del_step_btn = self._tool_button("删除步骤", self._delete_step)
        self.branch_btn = self._tool_button("设为条件分支", self._start_branch)
        self.up_btn = self._tool_button("上移", lambda: self._move_step(-1))
        self.down_btn = self._tool_button("下移", lambda: self._move_step(1))
        self.align_btn = self._tool_button("一键对齐", self._auto_layout)
        self.fit_btn = self._tool_button("适配视图", lambda: self.view.fit_all())
        for b in (self.add_step_btn, self.edit_step_btn, self.del_step_btn,
                  self.branch_btn, self.up_btn, self.down_btn, self.align_btn):
            bar.addWidget(b)
        bar.addStretch(1)
        bar.addWidget(self.fit_btn)
        bar.addWidget(QLabel("启动策略"))
        self.policy_combo = QComboBox()
        self.policy_combo.addItem("只生成第一步待办", StartPolicy.FIRST.value)
        self.policy_combo.addItem("一次性生成全部待办", StartPolicy.ALL.value)
        self.policy_combo.currentIndexChanged.connect(self._on_policy_changed)
        bar.addWidget(self.policy_combo)
        ml.addLayout(bar)
        self.view = _FlowView(self)
        self.view.page = self
        self.scene = self.view.scene()
        ml.addWidget(self.view, 1)
        self.hint = QLabel("")
        self.hint.setWordWrap(True)
        ml.addWidget(self.hint)
        card = UCard("流程编排")
        card.add_widget(host, 1)
        return card

    def _build_right(self) -> UCard:
        host = QWidget()
        rl = QVBoxLayout(host)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.setSpacing(6)
        self.inst_list = QListWidget()
        self.inst_list.currentRowChanged.connect(self._on_instance_selected)
        rl.addWidget(self.inst_list, 1)
        self.start_btn = UButton("启动实例", tone="accent", kind="solid")
        self.start_btn.clicked.connect(self._start_instance)
        self.abort_btn = UButton("终止", tone="danger", kind="ghost")
        self.abort_btn.clicked.connect(self._abort_instance)
        row = QHBoxLayout()
        row.setSpacing(6)
        row.addWidget(self.start_btn)
        row.addWidget(self.abort_btn)
        row.addStretch(1)
        rl.addLayout(row)
        self.steps_label = QLabel("")
        self.steps_label.setWordWrap(True)
        rl.addWidget(self.steps_label)
        card = UCard("运行实例")
        card.add_widget(host, 1)
        return card

    def _tool_button(self, text: str, slot) -> QToolButton:
        b = QToolButton()
        b.setText(text)
        b.setCursor(Qt.PointingHandCursor)
        b.setFixedHeight(28)
        b.clicked.connect(slot)
        return b

    def _restyle(self, *_):
        for n in self._nodes.values():
            n._apply_style()
        for e in self._edges:
            e._apply_style()
        self.view.viewport().update()
    # ---------- 数据 ----------
    def note_choices(self):
        """可绑定的知识库文档（笔记）：[(id, title)]。"""
        try:
            return [(n.id, n.title or "（无标题）")
                    for n in (self.notes.recent(200) if self.notes else [])]
        except Exception:  # noqa: BLE001
            return []

    def reload(self):
        self._reload_templates()
        self._reload_instances()

    def _reload_templates(self):
        cur_id = self._tpl.id if self._tpl else None
        self.tpl_list.blockSignals(True)
        self.tpl_list.clear()
        try:
            self._templates = self.wf.list_templates() if self.wf else []
        except Exception:  # noqa: BLE001
            self._templates = []
        for t in self._templates:
            item = QListWidgetItem(f"{t.name}（{len(t.nodes)} 步）")
            item.setData(Qt.UserRole, t.id)
            self.tpl_list.addItem(item)
        self.tpl_list.blockSignals(False)
        if not self._templates:
            self._tpl = None
            self._render_template(None)
            return
        row = next((i for i, t in enumerate(self._templates) if t.id == cur_id), 0)
        self.tpl_list.setCurrentRow(row)
        self._on_template_selected(row)

    def _reload_instances(self):
        self.inst_list.blockSignals(True)
        self.inst_list.clear()
        try:
            self._instances = self.wf.list_instances() if self.wf else []
        except Exception:  # noqa: BLE001
            self._instances = []
        labels = {"running": "进行中", "done": "已完成", "aborted": "已终止"}
        for inst in self._instances:
            mark = labels.get(inst.status, inst.status)
            item = QListWidgetItem(f"[{mark}] {inst.title}　{inst.progress_text}")
            item.setData(Qt.UserRole, inst.id)
            self.inst_list.addItem(item)
        self.inst_list.blockSignals(False)
        self.steps_label.setText("")

    def _on_template_selected(self, row: int):
        if not (0 <= row < len(self._templates)):
            return
        tpl = self._templates[row]
        self._tpl = self.wf.get_template(tpl.id) if self.wf else tpl
        self._render_template(self._tpl)

    def _render_template(self, tpl):
        # 场景重建前必须先清空「选中/改挂」引用，否则旧 _FlowEdgeItem 析构后
        # 视图仍持悬空引用，后续访问抛 RuntimeError（与图谱同类问题）。
        self.view.clear_edge_state()
        self.scene.clear()
        self._nodes.clear()
        self._edges.clear()
        if tpl is None:
            self.hint.setText("还没有流程模板。点左下「新建」创建第一个工作流，然后在「流程编排」里添加步骤。")
            return
        pi = self.policy_combo.findData(tpl.start_policy or StartPolicy.FIRST.value)
        self.policy_combo.blockSignals(True)
        self.policy_combo.setCurrentIndex(max(0, pi))
        self.policy_combo.blockSignals(False)
        y_gap = _NODE_H + 54
        has_pos = any(n.pos_x is not None and n.pos_y is not None
                       for n in tpl.ordered_nodes())
        for i, node in enumerate(tpl.ordered_nodes()):
            key = node.id if node.id is not None else -(i + 1)
            item = _StepNodeItem(node, self)
            # 有持久化坐标则用坐标（布局稳定）；否则默认纵向排布
            if node.pos_x is not None and node.pos_y is not None:
                item.setPos(node.pos_x, node.pos_y)
            else:
                item.setPos(QPointF(0, i * y_gap))
            self.scene.addItem(item)
            self._nodes[key] = item
        self.refresh_edges()
        # 只在首次默认排布（无持久化坐标）时自动适配视图；
        # 用户已手动拖动布局后不再打扰（布局稳定）
        if not has_pos:
            self.view.fit_all()
        problems = tpl.validate()
        if problems:
            self.hint.setText("⚠ " + "；".join(problems))
        else:
            self.hint.setText("拖动节点调整位置；选中节点后可「设为条件分支」再点目标节点；双击节点可编辑。")

    def refresh_edges(self):
        for e in self._edges:
            if e.scene() is not None:
                self.scene.removeItem(e)
        self._edges.clear()
        if self._tpl is None:
            return
        ordered = self._tpl.ordered_nodes()
        for i, node in enumerate(ordered):
            key = node.id if node.id is not None else -(i + 1)
            src = self._nodes.get(key)
            if src is None:
                continue
            # 顺序边：node -> ordered[i+1]（若该边正好也是条件分支目标，则跳过，
            # 避免同一对节点画两条重叠的线）
            nxt = ordered[i + 1] if i + 1 < len(ordered) else None
            if nxt is not None and node.branch_node_id != nxt.id:
                nkey = nxt.id if nxt.id is not None else -(i + 2)
                dst = self._nodes.get(nkey)
                if dst is not None:
                    e = _FlowEdgeItem(src, dst, dashed=False)
                    self.scene.addItem(e)
                    self._edges.append(e)
            if node.branch_node_id is not None:
                bidx = next((j for j, n in enumerate(ordered)
                             if n.id == node.branch_node_id), None)
                if bidx is not None:
                    bnode = ordered[bidx]
                    bkey = bnode.id if bnode.id is not None else -(bidx + 1)
                    bdst = self._nodes.get(bkey)
                    if bdst is not None and bdst is not src:
                        e = _FlowEdgeItem(src, bdst, dashed=True,
                                          label=(bnode.condition or "").strip())
                        self.scene.addItem(e)
                        self._edges.append(e)

    def _set_hint_for_edge(self, edge):
        """选中连线时给出操作提示（按边类型区分）。"""
        if edge.dashed:
            self.hint.setText("已选中条件分支线：按 Delete 删除该分支；拖动两端的圆点可改挂到其它节点（Esc 取消）")
        else:
            self.hint.setText("已选中顺序线：顺序由步骤列表决定，可用「上移 / 下移」调整（Delete 不作用于顺序线）")

    def remove_flow_edge(self, edge) -> bool:
        """删除连线：分支线清空 branch_node_id；顺序线提示不可删。"""
        if self._tpl is None:
            return False
        if not edge.dashed:
            self.hint.setText("顺序连线由步骤顺序决定，请用「上移 / 下移」调整")
            return False
        edge.src.node.branch_node_id = None
        self.wf.save_template(self._tpl)
        self.reload()
        self.hint.setText("已删除该条件分支")
        return True

    def rewire_flow_edge(self, edge, end: str, target):
        """改挂连线端点：分支线的 dst 端可改挂到另一节点。"""
        if self._tpl is None:
            return
        if not edge.dashed:
            self.hint.setText("顺序连线由步骤顺序决定，请用「上移 / 下移」调整")
            return
        if end == "src":
            self.hint.setText("条件分支的「源」是发起分支的步骤，请拖动另一端（分支目标）改挂")
            return
        # dst 端改挂：把分支目标改为新节点
        edge.src.node.branch_node_id = target.node.id
        if self.wf.save_template(self._tpl) is None:
            QMessageBox.warning(self, "知行", "改挂失败：会导致流程成环")
            edge.src.node.branch_node_id = edge.dst.node.id
        self.reload()
        self.hint.setText("已把分支改挂到新步骤")

    def node_index(self, node) -> int:
        if self._tpl is None:
            return 0
        for i, n in enumerate(self._tpl.ordered_nodes()):
            if n is node or (n.id is not None and n.id == node.id):
                return i
        return 0

    def _selected_node_item(self):
        for it in self.scene.selectedItems():
            if isinstance(it, _StepNodeItem):
                return it
        return None

    def edit_node(self, node):
        """双击/工具栏编辑指定节点（不依赖场景选中态，双击直接定位）。"""
        if self._tpl is None or node is None:
            return
        dlg = _StepEditDialog(self, node, self)
        if dlg.exec() != QDialog.Accepted:
            return
        dlg.result_node()
        self.wf.save_template(self._tpl)
        self.reload()

    def persist_positions(self):
        """节点拖动结束后，防抖静默保存画布坐标（不广播、不重建场景）。"""
        if self._tpl is None:
            return
        if getattr(self, "_pos_timer", None) is None:
            from PySide6.QtCore import QTimer
            self._pos_timer = QTimer(self)
            self._pos_timer.setSingleShot(True)
            self._pos_timer.setInterval(400)
            self._pos_timer.timeout.connect(self._do_persist_positions)
        self._pos_timer.start()

    def _do_persist_positions(self):
        """实际把当前节点坐标静默写库（silent，不触发整页 reload）。"""
        if self._tpl is None or self.wf is None:
            return
        try:
            self.wf.save_template(self._tpl, silent=True)
        except Exception:  # noqa: BLE001
            pass

    def is_branch_target(self, node) -> bool:
        """某节点是否为「条件分支」的目标（即有其它节点 branch 指向它）。"""
        if self._tpl is None:
            return False
        return any(n.branch_node_id is not None and n.branch_node_id == node.id
                   for n in self._tpl.ordered_nodes())

    def _auto_layout(self):
        """一键对齐：把所有节点重置为纵向网格排布并保存（覆盖手动拖动）。"""
        if self._tpl is None:
            return
        y_gap = _NODE_H + 54
        for i, n in enumerate(self._tpl.ordered_nodes()):
            n.pos_x = 0.0
            n.pos_y = i * y_gap
        self.wf.save_template(self._tpl, silent=True)
        self._render_template(self._tpl)
        self.view.fit_all()

    # ---------- 模板 / 步骤 操作 ----------
    def _new_template(self):
        name, ok = UInputDialog.get_text(
            self, "新建工作流", label="名称：", placeholder="如：新项目启动审核")
        if not ok or not name.strip():
            return
        tpl = WorkflowTemplate(name=name.strip(),
                               nodes=[WorkflowNode(title="第一步", order_index=0)])
        if self.wf.save_template(tpl) is None:
            QMessageBox.warning(self, "知行", "保存失败：请检查流程配置")
            return
        self.reload()

    def _delete_template(self):
        if self._tpl is None:
            return
        self._delete_template_by_id(self._tpl.id)

    def _delete_template_by_id(self, tpl_id):
        tpl = next((t for t in self._templates if t.id == tpl_id), None)
        if tpl is None:
            return
        ans = QMessageBox.question(
            self, "删除工作流",
            f"确定删除「{tpl.name}」？（有运行中实例的模板无法删除）",
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No)
        if ans != QMessageBox.Yes:
            return
        if not self.wf.delete_template(tpl_id):
            QMessageBox.warning(self, "知行", "删除失败：该模板还有运行中的实例")
            return
        self._tpl = None
        self.reload()

    def _rename_template_by_id(self, tpl_id):
        tpl = next((t for t in self._templates if t.id == tpl_id), None)
        if tpl is None:
            return
        name, ok = UInputDialog.get_text(
            self, "重命名工作流", label="名称：", text=tpl.name)
        if ok and name.strip():
            tpl.name = name.strip()
            self.wf.save_template(tpl)
            self.reload()

    def _duplicate_template_by_id(self, tpl_id):
        if next((t for t in self._templates if t.id == tpl_id), None) is None:
            return
        self.wf.duplicate_template(tpl_id)
        self.reload()

    def _template_menu(self, pos):
        if self._tpl is None:
            return
        menu = QMenu(self)
        act_dup = menu.addAction("复制一份")
        act_rename = menu.addAction("重命名…")
        menu.addSeparator()
        act_start = menu.addAction("启动实例")
        chosen = menu.exec(self.tpl_list.mapToGlobal(pos))
        if chosen is act_dup:
            self._duplicate_template_by_id(self._tpl.id)
        elif chosen is act_rename:
            self._rename_template_by_id(self._tpl.id)
        elif chosen is act_start:
            self._start_instance()

    def _on_policy_changed(self):
        if self._tpl is None:
            return
        self._tpl.start_policy = self.policy_combo.currentData()
        self.wf.save_template(self._tpl)

    def _add_step(self):
        if self._tpl is None:
            QMessageBox.information(self, "知行", "请先新建一个工作流模板")
            return
        sel = self._selected_node_item()
        branch_label = sel.node.title if sel is not None else ""
        dlg = _StepEditDialog(self, None, self,
                              branchable=sel is not None,
                              branch_label=branch_label)
        if dlg.exec() != QDialog.Accepted:
            return
        node = dlg.result_node()
        as_branch = dlg.as_branch
        ordered = self._tpl.ordered_nodes()
        if sel is not None:
            # 选中了节点：新节点插入到其后，后续节点顺延
            insert_at = next((i + 1 for i, n in enumerate(ordered)
                              if n is sel.node), len(ordered))
            ordered.insert(insert_at, node)
            for i, n in enumerate(ordered):
                n.order_index = i
            self._tpl.nodes = ordered
            # 可选：设为选中节点的条件分支（A 完成后条件满足跳到此新节点 B）
            if as_branch:
                # 给新节点一个临时负 id，保存时经 id_map 重映射到真实 id
                node.id = -(len(ordered) + 1)
                sel.node.branch_node_id = node.id
        else:
            node.order_index = len(ordered)
            self._tpl.nodes.append(node)
        self.wf.save_template(self._tpl)
        self.reload()

    def _edit_step(self):
        item = self._selected_node_item()
        if item is None:
            QMessageBox.information(self, "知行", "请先选中一个步骤节点（或双击节点）")
            return
        self.edit_node(item.node)

    def _delete_step(self):
        item = self._selected_node_item()
        if item is None or self._tpl is None:
            return
        self._tpl.nodes = [n for n in self._tpl.nodes if n is not item.node]
        for i, n in enumerate(self._tpl.ordered_nodes()):
            n.order_index = i
        self.wf.save_template(self._tpl)
        self.reload()

    def _move_step(self, delta: int):
        item = self._selected_node_item()
        if item is None or self._tpl is None:
            return
        ordered = self._tpl.ordered_nodes()
        idx = next((i for i, n in enumerate(ordered) if n is item.node), -1)
        tgt = idx + delta
        if idx < 0 or not (0 <= tgt < len(ordered)):
            return
        ordered[idx], ordered[tgt] = ordered[tgt], ordered[idx]
        for i, n in enumerate(ordered):
            n.order_index = i
        self._tpl.nodes = ordered
        self.wf.save_template(self._tpl)
        self.reload()

    def _start_branch(self):
        item = self._selected_node_item()
        if item is None:
            QMessageBox.information(self, "知行", "请先选中一个步骤节点")
            return
        self.view.start_branch_from(item)
        self.hint.setText("连线模式：点击另一个节点 = 设为当前步骤的条件分支；Esc 取消")

    def set_branch(self, src_node, dst_node):
        if self._tpl is None:
            return
        src_node.branch_node_id = dst_node.id
        if self.wf.save_template(self._tpl) is None:
            QMessageBox.warning(self, "知行", "设置分支失败：会导致流程成环")
            src_node.branch_node_id = None
        self.reload()

    # ---------- 实例 ----------
    def _start_instance(self):
        if self._tpl is None:
            QMessageBox.information(self, "知行", "请先选择一个工作流模板")
            return
        inst = self.wf.instantiate(self._tpl.id,
                                   policy=self.policy_combo.currentData())
        if inst is None:
            QMessageBox.warning(self, "知行", "启动失败：流程配置有误")
            return
        self._reload_instances()
        QMessageBox.information(
            self, "知行",
            f"已启动「{inst.title}」\n步骤已下发到任务列表（可在任务页查看）。")

    def _abort_instance(self):
        row = self.inst_list.currentRow()
        if not (0 <= row < len(self._instances)):
            return
        inst = self._instances[row]
        if inst.status != WorkflowStatus.RUNNING.value:
            return
        ans = QMessageBox.question(self, "终止实例", f"确定终止「{inst.title}」？",
                                   QMessageBox.Yes | QMessageBox.No, QMessageBox.No)
        if ans != QMessageBox.Yes:
            return
        self.wf.abort_instance(inst.id)
        self._reload_instances()

    def _on_instance_selected(self, row: int):
        if not (0 <= row < len(self._instances)):
            self.steps_label.setText("")
            return
        inst = self.wf.get_instance(self._instances[row].id)
        if inst is None:
            return
        lines = [f"进度：{inst.progress_text}　状态：{inst.status}"]
        for s in inst.steps:
            mark = "✅" if s.done else "⬜"
            lines.append(f"{mark} {s.title}")
        self.steps_label.setText("<br>".join(lines))