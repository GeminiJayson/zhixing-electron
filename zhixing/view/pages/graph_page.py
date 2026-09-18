# -*- coding: utf-8 -*-
"""图谱页：力导向知识网络（ADR-1 QGraphicsView 自绘）。

- 布局：FR 简化力导向，QTimer 逐帧迭代、收敛自动停帧省电；拖拽节点=钉住。
- 交互：滚轮缩放（鼠标锚点）、空白拖拽平移、双击打开、悬浮高亮 1 度邻域；
  「归属连线」/「引用连线」两个入口拖拽改写拓扑（自动识别边类 + 矩阵/环路约束检查）。
"""
import math
import threading
from typing import Dict, Optional

from PySide6.QtCore import QObject, QPointF, QRectF, QRunnable, Qt, QThreadPool, QTimer, Signal
from PySide6.QtGui import QColor, QFont, QFontMetrics, QPainter, QPainterPath, QPen, QBrush
from PySide6.QtWidgets import (QFrame, QGraphicsItem, QGraphicsLineItem, QGraphicsPathItem, QGraphicsScene, QGraphicsView, QHBoxLayout, QStackedWidget, QVBoxLayout, QWidget)

from ..components.general import EmptyState

from ...model.application.graph_service import GraphData, GraphNode
from ..kit.icons import node_shape_path
from ..kit.graph_icons import icon_kind, graph_node_renderer
from qfluent_core import ThemeManager as ThemeEngine
from ..ui import UCard, UTitle, PageHeader
from zhixing.view.kit.fluent_compat import QComboBox, QLabel, QLineEdit
from zhixing.view.kit.fluent_compat import QToolButton

_REPULSION = 22000.0
_SPRING = 0.04
_SPRING_LEN = 90.0
_CENTER_PULL = 0.008
_DAMP = 0.82

# 节点色板：按文件夹区分笔记节点（F3-6 节点色 = 所属文件夹）
_FOLDER_PALETTE = [
    "#0D9488", "#2563EB", "#7C3AED", "#DB2777", "#EA580C", "#16A34A",
    "#D97706", "#0891B2", "#4F46E5", "#65A30D", "#B45309", "#0EA5E9",
]
# 根目录笔记（folder_id=None）专属中性灰，与文件夹色板明显区分
_ROOT_NOTE_COLOR = "#64748B"


class _LayoutResult(QObject):
    """后台力导向结果桥：worker 线程算完经此信号回到主线程应用。

    结果 dict 用 object 传递：跨线程 queued 连接下 Python 对象按引用安全送达。
    """

    finished = Signal(int, object)   # generation, {node_id: (x, y, vx, vy)}


class _LayoutWorker(QRunnable):
    """单帧力导向计算（QThreadPool 后台线程，带取消）。

    只做纯数值计算，不触碰 QGraphicsItem；结果经 _LayoutResult.finished 交还主线程。
    """

    def __init__(self, bridge, generation, states, edge_pairs, params):
        super().__init__()
        self.setAutoDelete(True)
        self._bridge = bridge
        self._generation = generation
        self._states = states          # {id: [x, y, vx, vy, pinned]}
        self._edge_pairs = edge_pairs  # [(a_id, b_id), ...]
        self._p = params
        self._cancel = threading.Event()

    def cancel(self):
        self._cancel.set()

    def run(self):
        if self._cancel.is_set():
            return
        try:
            self._compute()
        except Exception:
            return

    def _compute(self):
        states = self._states
        edges = self._edge_pairs
        rep = self._p["repulsion"]
        spring = self._p["spring"]
        spring_len = self._p["spring_len"]
        center = self._p["center"]
        damp = self._p["damp"]

        # 斥力：全量 O(n²)（移除旧 >500 降采样），在后台线程执行不阻塞主线程
        keys = list(states.keys())
        n = len(keys)
        for i in range(n):
            if self._cancel.is_set():
                return
            a = states[keys[i]]
            ax, ay = a[0], a[1]
            for j in range(i + 1, n):
                b = states[keys[j]]
                dx = ax - b[0]
                dy = ay - b[1]
                d2 = dx * dx + dy * dy
                if d2 < 25.0:
                    d2 = 25.0
                f = rep / d2
                d = d2 ** 0.5
                fx = dx / d * f
                fy = dy / d * f
                a[2] += fx
                a[3] += fy
                b[2] -= fx
                b[3] -= fy

        for (aid, bid) in edges:
            a = states.get(aid)
            b = states.get(bid)
            if a is None or b is None:
                continue
            dx = b[0] - a[0]
            dy = b[1] - a[1]
            d = (dx * dx + dy * dy) ** 0.5
            if d < 1.0:
                d = 1.0
            f = (d - spring_len) * spring
            a[2] += dx / d * f
            a[3] += dy / d * f
            b[2] -= dx / d * f
            b[3] -= dy / d * f

        result = {}
        for sid, s in states.items():
            if s[4]:
                continue   # pinned 不移动
            s[2] -= s[0] * center
            s[3] -= s[1] * center
            s[2] *= damp
            s[3] *= damp
            nx = s[0] + max(-12.0, min(12.0, s[2]))
            ny = s[1] + max(-12.0, min(12.0, s[3]))
            result[sid] = (nx, ny, s[2], s[3])

        self._bridge.finished.emit(self._generation, result)


class NodeItem(QGraphicsPathItem):
    """图谱节点：按 kind 渲染四类形状（folder 文件夹 / note 展开书本 / task 五角星 / flash 闪电）。

    dangling（待建链接）复用书本轮廓但空心虚线；根目录笔记形状同普通笔记、颜色独立区分。
    每个节点在形状下方绘制可换行标题（QPainter 矢量文字，缩放不模糊，主题切换自愈）。
    """

    # 标题排版：宽度上限内自动换行，换行后高度随文本增长，不溢出
    _TITLE_WIDTH = 96.0
    _TITLE_MARGIN = 4.0
    _TITLE_FONT_PT = 10   # T8: 节点标题 ≥10pt（原 9pt 过小）

    def __init__(self, node: GraphNode, page: "GraphPage"):
        self.node = node
        self.page = page
        self.vx = self.vy = 0.0
        self.pinned = False
        self._span = self._span_for(node)
        self._title_height = 0.0
        self._icon_renderer = None   # 多色 SVG 图标渲染器（矢量，无锯齿）
        super().__init__(node_shape_path(node.kind, self._span))
        self.setFlag(QGraphicsItem.ItemIsMovable)
        self.setFlag(QGraphicsItem.ItemSendsGeometryChanges)
        self.setAcceptHoverEvents(True)
        self.setCursor(Qt.PointingHandCursor)
        self._apply_style()

    @staticmethod
    def _span_for(node: GraphNode) -> float:
        if node.kind == "folder":
            return 20.0
        return 8.0 + node.size * 7.0

    def radius(self) -> float:
        """节点特征半径：边收缩到节点边缘用。"""
        return self._span

    def _title_font(self) -> QFont:
        font = QFont()
        font.setPointSize(self._TITLE_FONT_PT)
        return font

    def _measure_title_height(self) -> float:
        """按标题宽度 + 换行计算文字高度（缓存，主题字号变化时在 _apply_style 重算）。"""
        text = (self.node.label or "").strip()
        if not text:
            return 0.0
        fm = QFontMetrics(self._title_font())
        rect = fm.boundingRect(
            0, 0, int(self._TITLE_WIDTH), 1000,
            int(Qt.TextWordWrap) | int(Qt.AlignHCenter), text)
        return float(rect.height())

    def boundingRect(self) -> QRectF:
        if self._icon_renderer is not None:
            # 多色 SVG 图标：完整正方形覆盖（避免 path 外接小于图标而被裁剪）
            base = QRectF(-self._span, -self._span, self._span * 2.0, self._span * 2.0)
        else:
            base = super().boundingRect()
        if self._title_height <= 0.0:
            return base
        title_rect = QRectF(-self._TITLE_WIDTH / 2.0,
                            self._span + self._TITLE_MARGIN,
                            self._TITLE_WIDTH, self._title_height)
        return base.united(title_rect)

    def paint(self, painter: QPainter, option, widget=None):
        if self._icon_renderer is not None:
            s = self._span * 2.0
            self._icon_renderer.render(painter, QRectF(-self._span, -self._span, s, s))
        else:
            super().paint(painter, option, widget)
        text = (self.node.label or "").strip()
        if not text:
            return
        painter.save()
        painter.setFont(self._title_font())
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        painter.setPen(QPen(QColor(t.get("fg", "#1A1A1A"))))
        rect = QRectF(-self._TITLE_WIDTH / 2.0,
                      self._span + self._TITLE_MARGIN,
                      self._TITLE_WIDTH, self._title_height)
        painter.drawText(rect,
                         Qt.AlignHCenter | Qt.AlignTop | Qt.TextWordWrap, text)
        painter.restore()

    def _apply_style(self):
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        kind = self.node.kind
        if kind == "dangling":
            # 待建链接：保留空心虚线书本（"尚未创建"语义）
            self.setBrush(Qt.NoBrush)
            self.setPen(QPen(QColor(t.get("border2", "#C9C9C9")), 1.4, Qt.DashLine))
            self._icon_renderer = None
            self.setToolTip(f"{self.node.label}（待建链接）")
        elif kind == "anchor":
            # v0.15 P1-3: 段落锚 = 强调色小圆点 + 引文 tooltip，双击跳转段落
            self.setBrush(QColor(t.get("accent", "#0D9488")))
            self.setPen(QPen(QColor(t.get("accent", "#0D9488")), 0.0))
            self._icon_renderer = None
            snip = (self.node.snippet or self.node.label or "").replace("\n", " ")
            self.setToolTip(f"任务引用段落 · 双击定位\n{snip[:40]}")
        else:
            # 多色 SVG 图标：按 kind + note.format 选择，大小随 span 自由调节
            icon = icon_kind(kind, getattr(self.node, "format", "markdown"))
            self._icon_renderer = graph_node_renderer(icon)
            self.setBrush(Qt.NoBrush)
            self.setPen(Qt.NoPen)
            tips = {"folder": "文件夹 · 双击定位", "task": "任务 · 双击打开",
                    "flash": "闪念 · 双击跳转", "note": "笔记 · 双击打开"}
            self.setToolTip(f"{self.node.label}（{tips.get(kind, '节点')}）")
        # 标题高度随字体/文本重算（主题切换字号变化时自愈）
        self._title_height = self._measure_title_height()

    def hoverEnterEvent(self, ev):
        self.page.highlight_neighborhood(self.node.id)
        super().hoverEnterEvent(ev)

    def hoverLeaveEvent(self, ev):
        self.page.clear_highlight()
        super().hoverLeaveEvent(ev)

    def mouseDoubleClickEvent(self, ev):
        if self.node.kind == "note":
            self.page.openNoteRequested.emit(self.node.ref_id or self.node.id)
        elif self.node.kind == "flash":
            self.page.flashOpenRequested.emit(self.node.ref_id)
        elif self.node.kind == "task":
            self.page.openTaskRequested.emit(self.node.ref_id)
        elif self.node.kind == "folder":
            self.page.folderOpenRequested.emit(self.node.ref_id)
        elif self.node.kind == "anchor":
            # v0.15 P1-3: 双击段落锚 → 打开所属笔记并定位段落
            self.page.noteBlockOpenRequested.emit(
                self.node.ref_id, getattr(self.node, "block_key", "") or "")
        elif self.node.kind == "dangling":
            self.page.createNoteRequested.emit(self.node.label)
        super().mouseDoubleClickEvent(ev)

    def mousePressEvent(self, ev):
        if ev.button() == Qt.LeftButton:
            self.page.select_node(self.node.id)
            self._was_moved = False
        super().mousePressEvent(ev)

    def mouseMoveEvent(self, ev):
        self._was_moved = True
        self.pinned = True  # 拖拽=钉住
        super().mouseMoveEvent(ev)

    def itemChange(self, change, value):
        if change == QGraphicsItem.ItemPositionHasChanged and self.scene():
            self.page.update_edges_of(self.node.id)
        return super().itemChange(change, value)


class EdgeItem(QGraphicsPathItem):
    """极简边：细贝塞尔曲线 + 克制方向箭头；两类边（归属实线 / 引用虚线）。

    - ownership 归属：中性灰实线（fg2 token），结构/包含关系；
    - reference 引用：主题强调色虚线（accent token）+ 自定义加大 dash 间隔。
    颜色全部从 ThemeEngine 语义 token 派生（t() 取值），主题切换由 GraphPage 自愈；不写死色值。
    """

    # 虚线自定义间隔（单位 = 笔宽倍数）：dash 6 / gap 4，明显大于 Qt.DashLine 默认
    _DASH_PATTERN = [6.0, 4.0]
    _ALPHA_NORMAL = 190       # 常态：清晰可见但不喧宾夺主
    _ALPHA_HL = 255           # 悬停邻域直连边：全不透明 + 略加粗

    #: 命中区加宽（px）：细曲线实体只有 1.3px 宽，直接点几乎点不中，
    #: 故 shape() 用加粗描边路径，既保证可选中也不影响视觉粗细。
    _HIT_WIDTH = 12.0

    # 弯曲量参数（Obsidian 风：克制弧线）：
    # 普通边近直线（5% 弦长），双向边略弯（12%）便于辨识，均封顶 30px。
    _BEND_RATIO = 0.05
    _BEND_RATIO_BIDIR = 0.12
    _BEND_MAX = 30.0
    # 弯曲方向过渡带宽（px）：src/dst 水平相对位置在 ±该范围内时，
    # 弯曲方向平滑从一侧过渡到另一侧（近垂直对齐时曲线几乎压平）。
    _SIDE_SOFT = 90.0

    def __init__(self, src, dst, kind: str, bidirectional: bool = False):
        super().__init__()
        self.src, self.dst = src, dst
        self.kind = kind
        self.bidirectional = bidirectional
        self._highlighted = False
        self._selected = False
        self.setFlag(QGraphicsItem.ItemIsSelectable, True)
        self.setAcceptHoverEvents(True)
        self.setZValue(5)            # 边在节点之下、但在连线层清晰可点
        self._apply_style()
        self.update_path()

    def shape(self) -> QPainterPath:
        """加宽命中区：让 1.3px 的细曲线可被可靠点选。"""
        from PySide6.QtGui import QPainterPathStroker
        stroker = QPainterPathStroker()
        stroker.setWidth(self._HIT_WIDTH)
        return stroker.createStroke(super().shape())

    def set_selected(self, on: bool):
        """选中态：加粗 + 不透明，与 hover 高亮区分（选中用于 Delete 删除）。"""
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

    def set_highlight(self, on: bool):
        if self._highlighted != on:
            self._highlighted = on
            self._apply_style()

    def _apply_style(self):
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        if self.kind == "ownership":
            base = QColor(t.get("fg2", "#6B7280"))      # 归属：中性灰实线（结构关系）
            style = Qt.SolidLine
        else:
            base = QColor(t.get("accent", "#0D9488"))   # 引用：主题强调色虚线（知识链接）
            style = Qt.CustomDashLine
        color = QColor(base)
        emphasized = self._highlighted or self._selected
        color.setAlpha(self._ALPHA_HL if emphasized else self._ALPHA_NORMAL)
        # 选中（待删除）比 hover 更粗一档，形成明确的「已选中」反馈
        width = 2.4 if self._selected else (1.4 if self._highlighted else 1.3)
        pen = QPen(color, width, style)
        if style == Qt.CustomDashLine:
            pen.setDashPattern(self._DASH_PATTERN)      # 加大虚线间隔（dash 6 / gap 4）
        self.setPen(pen)
        self.setBrush(Qt.NoBrush)              # 无面状填充：箭头用 V 字形细线


    def _build_path(self) -> QPainterPath:
        p1 = QPointF(self.src.x(), self.src.y())
        p2 = QPointF(self.dst.x(), self.dst.y())
        r1 = self.src.radius() if hasattr(self.src, "radius") else 10.0
        r2 = self.dst.radius() if hasattr(self.dst, "radius") else 10.0
        dx, dy = p2.x() - p1.x(), p2.y() - p1.y()
        dist = (dx * dx + dy * dy) ** 0.5
        if dist < 1.0:
            return QPainterPath()
        ux, uy = dx / dist, dy / dist
        start = QPointF(p1.x() + ux * r1, p1.y() + uy * r1)
        end = QPointF(p2.x() - ux * r2, p2.y() - uy * r2)
        sx, sy = end.x() - start.x(), end.y() - start.y()
        seg = (sx * sx + sy * sy) ** 0.5
        if seg < 1.0:
            return QPainterPath()
        sux, suy = sx / seg, sy / seg
        # 弯曲方向由两节点相对水平位置连续驱动（softsign，无档位）：
        # src 在 dst 左侧 → 向上拱，右侧 → 向下拱，垂直对齐 → 近直线；
        # 拖动穿越对齐线时曲线先压平再弯向另一侧，无镜像翻转跳变。
        # 反向边（B→A）dx 反号 → side 反号 → 双向边自然分向两侧不重叠。
        dxw = p2.x() - p1.x()
        side = dxw / ((dxw * dxw + self._SIDE_SOFT * self._SIDE_SOFT) ** 0.5)
        px, py = -suy * side, sux * side
        ratio = self._BEND_RATIO_BIDIR if self.bidirectional else self._BEND_RATIO
        off = min(ratio * seg, self._BEND_MAX)   # 垂直于弦的弯曲量（连续）
        c1 = QPointF(start.x() + sux * seg * 0.3 + px * off,
                     start.y() + suy * seg * 0.3 + py * off)
        c2 = QPointF(start.x() + sux * seg * 0.7 + px * off,
                     start.y() + suy * seg * 0.7 + py * off)

        path = QPainterPath()
        path.moveTo(start)
        path.cubicTo(c1, c2, end)    # 单条贝塞尔曲线（带弧度）

        # dst 端箭头：切线取终点控制段方向
        tx, ty = end.x() - c2.x(), end.y() - c2.y()
        tn = (tx * tx + ty * ty) ** 0.5
        dirx, diry = (tx / tn, ty / tn) if tn > 1e-6 else (sux, suy)
        self._add_arrow(path, end, dirx, diry)
        if self.bidirectional:
            # src 端反向箭头：切线取起点控制段反方向
            rx, ry = start.x() - c1.x(), start.y() - c1.y()
            rn = (rx * rx + ry * ry) ** 0.5
            rdirx, rdiry = (rx / rn, ry / rn) if rn > 1e-6 else (-sux, -suy)
            self._add_arrow(path, start, rdirx, rdiry)
        return path

    @staticmethod
    def _add_arrow(path: QPainterPath, tip: QPointF, dirx: float, diry: float):
        """在 tip 处按方向 (dirx, diry) 追加实心箭头三角形。"""
        arrow_len, arrow_w = 6.0, 2.4   # 极简小箭头
        wx, wy = -diry, dirx
        basex = tip.x() - dirx * arrow_len
        basey = tip.y() - diry * arrow_len
        # V 字形细箭头（两条线构成，不填充成面，不闭合）
        path.moveTo(basex + wx * arrow_w, basey + wy * arrow_w)
        path.lineTo(tip.x(), tip.y())
        path.lineTo(basex - wx * arrow_w, basey - wy * arrow_w)

    def update_path(self):
        self.setPath(self._build_path())

    def endpoints(self):
        """返回边的实际连接点 (start, end)（节点边缘，非中心）。"""
        p1 = QPointF(self.src.x(), self.src.y())
        p2 = QPointF(self.dst.x(), self.dst.y())
        r1 = self.src.radius() if hasattr(self.src, "radius") else 10.0
        r2 = self.dst.radius() if hasattr(self.dst, "radius") else 10.0
        dx, dy = p2.x() - p1.x(), p2.y() - p1.y()
        dist = (dx * dx + dy * dy) ** 0.5
        if dist < 1.0:
            return p1, p2
        ux, uy = dx / dist, dy / dist
        start = QPointF(p1.x() + ux * r1, p1.y() + uy * r1)
        end = QPointF(p2.x() - ux * r2, p2.y() - uy * r2)
        return start, end

    def paint(self, painter: QPainter, option, widget=None):
        super().paint(painter, option, widget)
        # 选中态：绘制两个明显的端点手柄（可拖动改挂），让用户一眼看到拖点
        if not self._selected:
            return
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        accent = QColor(t.get("accent", "#0D9488"))
        layer = QColor(t.get("layer", "#FFFFFF"))
        start, end = self.endpoints()
        painter.setRenderHint(QPainter.Antialiasing)
        for pt in (start, end):
            # 外圈白描边 + 内实心，醒目且与连线色区分
            painter.setPen(QPen(layer, 2.0))
            painter.setBrush(accent)
            painter.drawEllipse(pt, 7.0, 7.0)

    def update_line(self):
        self.update_path()


class GraphView(QGraphicsView):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.page = parent
        self.setScene(QGraphicsScene(self))
        self.setRenderHint(QPainter.Antialiasing)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        # 默认 NoDrag：ScrollHandDrag 会把左键全部用于平移画布，
        # 导致连线无法被点选、端点无法拖动（用户反馈「链接不可删除/拖动」）。
        # 仅在「连线模式」下切换为 ScrollHandDrag（那时画布平移优先）。
        self.setDragMode(QGraphicsView.NoDrag)
        self._zoom = 1.0
        self.link_mode: Optional[str] = None   # None | "ownership" | "reference"
        self._link_src: Optional[NodeItem] = None
        self._link_line: Optional[QGraphicsLineItem] = None
        # 连线编辑（v9）：选中态 + 端点改挂
        self._selected_edge: Optional[EdgeItem] = None
        self._rewire_edge: Optional[EdgeItem] = None    # 正在改挂的边
        self._rewire_end: str = ""                      # "src" | "dst"
        self._rewire_line: Optional[QGraphicsLineItem] = None
        self._pan_origin = None                          # 中/右键平移起点
        self.setFocusPolicy(Qt.StrongFocus)             # 收键盘事件（Delete）

    def set_link_mode(self, mode: Optional[str]):
        self.link_mode = mode
        self.setCursor(Qt.CrossCursor if mode else Qt.ArrowCursor)
        # 连线模式：画布平移优先；普通模式：NoDrag 以便选中连线/拖端点
        self.setDragMode(QGraphicsView.ScrollHandDrag if mode
                         else QGraphicsView.NoDrag)
        if not mode:
            self.reset_link()

    def reset_link(self):
        if self._link_line is not None:
            if self._item_alive(self._link_line):
                try:
                    self.scene().removeItem(self._link_line)
                except RuntimeError:
                    pass
            self._link_line = None
        self._link_src = None

    # ---------- 连线编辑（v9）：选中 / 删除 / 端点改挂 ----------
    def _edge_at(self, pos) -> Optional["EdgeItem"]:
        """命中连线（利用 EdgeItem.shape() 的加宽命中区）。"""
        scene_pos = self.mapToScene(pos)
        for it in self.scene().items(scene_pos):
            if isinstance(it, EdgeItem):
                return it
        return None

    @staticmethod
    def _item_alive(item) -> bool:
        """Shiboken 包装的 C++ 对象是否仍存活（已析构时访问属性会抛 RuntimeError）。"""
        if item is None:
            return False
        try:
            item.scene()          # 触发一次 C++ 侧访问；已析构则抛 RuntimeError
            return True
        except RuntimeError:
            return False

    def clear_edge_edit_state(self):
        """清空「选中连线 / 正在改挂」状态（场景重建前必须调用）。

        场景重建会销毁全部 item，若继续持有旧引用，后续事件处理访问
        其 src/dst（已析构的 NodeItem）会抛 RuntimeError。
        """
        self._selected_edge = None
        self._clear_rewire()

    def select_edge(self, edge: Optional["EdgeItem"]):
        """选中/取消选中连线（选中后可按 Delete 删除）。"""
        if self._selected_edge is edge:
            return
        if self._item_alive(self._selected_edge):
            self._selected_edge.set_selected(False)
        self._selected_edge = edge
        if edge is not None:
            edge.set_selected(True)
            if self.page is not None:
                self.page._set_info(
                    "已选中连线：按 Delete 删除；拖动两端的圆点可改挂到其它节点")

    def delete_selected_edge(self) -> bool:
        """删除当前选中的连线（改写真数据；由 GraphPage 执行并给反馈）。"""
        edge = self._selected_edge
        if edge is None or self.page is None:
            return False
        if not self._item_alive(edge):
            self._selected_edge = None
            return False
        ok = self.page.remove_edge(edge)
        if ok:
            self._selected_edge = None
        return ok

    def _endpoint_at(self, pos):
        """命中选中连线的端点圆点 -> (edge, "src"/"dst")；未命中返回 (None, "")。"""
        edge = self._selected_edge
        # 图可能已被 reload 重建（旧 EdgeItem/NodeItem 全部析构），此时必须放弃
        # 悬空引用，否则下面访问 node.x() 会抛 RuntimeError（真机崩溃）。
        if not self._item_alive(edge) or not self._item_alive(edge.src) \
                or not self._item_alive(edge.dst):
            self._selected_edge = None
            return None, ""
        scene_pos = self.mapToScene(pos)
        grab = 14.0 / max(0.15, self._zoom)   # 命中半径随缩放自适应（比手柄略大）
        start, end = edge.endpoints()
        for label, pt in (("src", start), ("dst", end)):
            dx = scene_pos.x() - pt.x()
            dy = scene_pos.y() - pt.y()
            if (dx * dx + dy * dy) ** 0.5 <= grab:
                return edge, label
        return None, ""

    def _begin_rewire(self, edge: "EdgeItem", end: str):
        if not self._item_alive(edge) or not self._item_alive(edge.src) \
                or not self._item_alive(edge.dst):
            return
        self._rewire_edge = edge
        self._rewire_end = end
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        color = QColor(t.get("accent", "#0D9488"))
        line = QGraphicsLineItem()
        line.setPen(QPen(color, 1.8, Qt.DashLine))
        line.setZValue(20)
        anchor = edge.dst if end == "src" else edge.src
        line.setLine(anchor.x(), anchor.y(), anchor.x(), anchor.y())
        self.scene().addItem(line)
        self._rewire_line = line

    def _finish_rewire(self, pos):
        """释放：落到新节点则改挂该端，否则取消。"""
        edge, end = self._rewire_edge, self._rewire_end
        self._clear_rewire()
        if edge is None or self.page is None:
            return
        if not self._item_alive(edge) or not self._item_alive(edge.src) \
                or not self._item_alive(edge.dst):
            return
        target = self._node_at(pos)
        if target is None:
            self.page._set_info("未落到节点上，已取消改挂", "warn.alert", "warm")
            return
        other = edge.dst if end == "src" else edge.src
        if target is other:
            self.page._set_info("不能改挂到另一端本身", "warn.alert", "warm")
            return
        self.page.rewire_edge(edge, end, target)

    def _clear_rewire(self):
        if self._rewire_line is not None:
            # 橡皮筋线可能已随场景 clear() 一起析构，访问前先判存活
            if self._item_alive(self._rewire_line):
                try:
                    self.scene().removeItem(self._rewire_line)
                except RuntimeError:
                    pass
            self._rewire_line = None
        self._rewire_edge = None
        self._rewire_end = ""

    def keyPressEvent(self, ev):  # noqa: N802
        """Delete/Backspace 删除选中连线；Esc 取消选中/改挂。"""
        if ev.key() in (Qt.Key_Delete, Qt.Key_Backspace):
            if self.delete_selected_edge():
                ev.accept()
                return
        elif ev.key() == Qt.Key_Escape:
            self._clear_rewire()
            self.select_edge(None)
            if self.page is not None:
                self.page._set_info("")
            ev.accept()
            return
        super().keyPressEvent(ev)

    def wheelEvent(self, ev):
        factor = 1.15 if ev.angleDelta().y() > 0 else 1 / 1.15
        self._zoom *= factor
        self._zoom = max(0.15, min(4.0, self._zoom))
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setTransform(self.transform().scale(factor, factor))

    def fit_all(self):
        self.fitInView(self.scene().itemsBoundingRect().adjusted(-40, -40, 40, 40),
                       Qt.KeepAspectRatio)

    # ---------- 连线（归属/引用两个入口：从节点拖到合规节点改写拓扑） ----------
    def _node_at(self, pos) -> Optional["NodeItem"]:
        scene_pos = self.mapToScene(pos)
        for it in self.scene().items(scene_pos):
            if isinstance(it, NodeItem):
                return it
        return None

    def _begin_link(self, src: "NodeItem"):
        self._link_src = src
        if self.page is not None:
            self.page.select_node(src.node.id)
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        # 橡皮筋颜色随边类：归属实线灰 / 引用虚线主题强调色（与 EdgeItem 语义一致）
        color = QColor(t.get("accent", "#0D9488")) if self.link_mode == "reference" \
            else QColor(t.get("fg2", "#6B7280"))
        line = QGraphicsLineItem()
        line.setPen(QPen(color, 1.6, Qt.DashLine))
        line.setZValue(10)
        line.setLine(src.x(), src.y(), src.x(), src.y())
        self.scene().addItem(line)
        self._link_line = line

    def _finish_link(self, dst: Optional["NodeItem"]):
        src = self._link_src
        self._link_src = None
        if self._link_line is not None:
            if self._link_line.scene() is not None:
                self.scene().removeItem(self._link_line)
            self._link_line = None
        if (src is not None and dst is not None and dst is not src
                and self.page is not None):
            # 拖拽释放：按连接矩阵识别边类 + 约束检查 + 改写底层数据（见 GraphPage.commit_connection）
            self.page.commit_connection(src, dst, self.link_mode)

    def mousePressEvent(self, ev):
        pos = ev.position().toPoint()
        # 中键/右键平移画布（NoDrag 下保留平移能力，避免只能靠滚动条）
        if ev.button() in (Qt.MiddleButton, Qt.RightButton):
            self._pan_origin = pos
            self.setCursor(Qt.ClosedHandCursor)
            ev.accept()
            return
        if ev.button() == Qt.LeftButton:
            self.setFocus()                      # 保证后续 Delete 能到达本视图
            # 1) 连线模式：从节点起拖新建连线；点空白则平移画布
            if self.link_mode:
                node = self._node_at(pos)
                if node is not None:
                    self._begin_link(node)
                    ev.accept()
                    return
                self._pan_origin = pos
                self.setCursor(Qt.ClosedHandCursor)
                ev.accept()
                return
            else:
                # 2) 非连线模式：优先命中「选中连线的端点圆点」-> 开始改挂
                edge, end = self._endpoint_at(pos)
                if edge is not None:
                    self._begin_rewire(edge, end)
                    ev.accept()
                    return
                # 3) 命中连线本体 -> 选中（用于删除）
                hit_edge = self._edge_at(pos)
                if hit_edge is not None:
                    self.select_edge(hit_edge)
                    ev.accept()
                    return
                # 4) 点到空白处 -> 取消选中 + 左键拖动画布（标准图编辑器行为）
                if self._node_at(pos) is None:
                    self.select_edge(None)
                    self._pan_origin = pos
                    self.setCursor(Qt.ClosedHandCursor)
                    ev.accept()
                    return
        super().mousePressEvent(ev)

    def mouseMoveEvent(self, ev):
        pos_pt = ev.position().toPoint()
        # 中键/右键拖动平移
        if getattr(self, "_pan_origin", None) is not None:
            delta = pos_pt - self._pan_origin
            self._pan_origin = pos_pt
            h = self.horizontalScrollBar(); v = self.verticalScrollBar()
            h.setValue(h.value() - delta.x())
            v.setValue(v.value() - delta.y())
            ev.accept()
            return
        if self._link_src is not None and self._link_line is not None:
            pos = self.mapToScene(pos_pt)
            self._link_line.setLine(self._link_src.x(), self._link_src.y(),
                                    pos.x(), pos.y())
            ev.accept()
            return
        if self._rewire_edge is not None and self._rewire_line is not None:
            # 场景可能已被重建：悬空引用直接放弃改挂（避免访问已析构节点）
            if not self._item_alive(self._rewire_edge) \
                    or not self._item_alive(self._rewire_edge.src) \
                    or not self._item_alive(self._rewire_edge.dst):
                self._clear_rewire()
                super().mouseMoveEvent(ev)
                return
            pos = self.mapToScene(pos_pt)
            anchor = (self._rewire_edge.dst if self._rewire_end == "src"
                      else self._rewire_edge.src)
            self._rewire_line.setLine(anchor.x(), anchor.y(), pos.x(), pos.y())
            ev.accept()
            return
        super().mouseMoveEvent(ev)

    def mouseReleaseEvent(self, ev):
        if getattr(self, "_pan_origin", None) is not None:
            self._pan_origin = None
            self.setCursor(Qt.CrossCursor if self.link_mode else Qt.ArrowCursor)
            ev.accept()
            return
        if self._link_src is not None:
            node = self._node_at(ev.position().toPoint())
            self._finish_link(node)
            ev.accept()
            return
        if self._rewire_edge is not None:
            self._finish_rewire(ev.position().toPoint())
            ev.accept()
            return
        super().mouseReleaseEvent(ev)


#: 节点类型中文名（提示文案用，避免把 kind 内部标识直接抛给用户）
_KIND_CN = {
    "note": "笔记", "folder": "文件夹", "task": "任务",
    "flash": "闪念", "dangling": "待建链接", "anchor": "段落锚",
}


class GraphPage(QWidget):
    openNoteRequested = Signal(int)
    createNoteRequested = Signal(str)
    flashOpenRequested = Signal(int)
    noteBlockOpenRequested = Signal(int, str)   # v0.15 P1-3: 双击段落锚 → 定位 (note_id, block_key)
    # 保留旧 note->note 引用信号以兼容 AppController._wire 的接线（旧「连线」入口已移除，
    # 新的归属/引用连线由 commit_connection 自行改写底层数据）。
    linkRequested = Signal(int, int)
    openTaskRequested = Signal(int)
    folderOpenRequested = Signal(int)   # 双击文件夹节点 → 定位到笔记库该文件夹

    def __init__(self, graph_service, note_service, parent=None):
        super().__init__(parent)
        self.graph_service = graph_service
        self.note_service = note_service
        self.nodes: Dict[int, NodeItem] = {}
        self.edges = []
        self._data: Optional[GraphData] = None
        self._frame = 0
        self._running = False
        self._pending_reload = True        # 首次显示前不构建（启动性能优化，惰性加载）
        self._selected_id = None
        self._folder_color_cache = {}
        self._root_note_ids = set()   # 根目录笔记（folder_id=None）节点 id 集合
        self._last_cycle_warn = None   # 已提示过的循环归属签名（去重，提示一次）
        self._vel = {}               # node_id -> (vx, vy) 动量（跨帧保留）
        self._generation = 0         # 每轮 reload 递增，作废旧 worker 结果
        self._worker_active = False
        self._current_worker = None
        self._bridge = _LayoutResult()
        self._bridge.finished.connect(self._apply_layout)
        self._build()
        self._restyle()
        eng = ThemeEngine.instance()
        if eng:
            eng.changed.connect(self._on_theme_changed)

    def folder_color(self, folder_id: int) -> str:
        """文件夹 → 稳定色板颜色（F3-6 节点色 = 所属文件夹）。"""
        key = folder_id or 0
        if key not in self._folder_color_cache:
            self._folder_color_cache[key] = \
                _FOLDER_PALETTE[len(self._folder_color_cache) % len(_FOLDER_PALETTE)]
        return self._folder_color_cache[key]

    def is_root_note(self, node) -> bool:
        """根目录笔记（folder_id 为 None）：形状与普通笔记一致，颜色独立区分。"""
        return node.kind == "note" and node.id in self._root_note_ids

    def _build(self):
        lay = QVBoxLayout(self)
        lay.setContentsMargins(12, 14, 12, 10)
        lay.setSpacing(6)
        self.header = PageHeader("图谱", "可视化你的知识网络与任务关联")
        lay.addWidget(self.header)

        toolbar = QFrame()
        # 流式布局：窗口变窄时按钮自动换行，避免固定 QHBoxLayout 里控件互相重叠
        # （原横向排列 7 个控件 + stretch，窄宽度下挤压重叠）。
        from ..kit.flow_layout import FlowLayout
        tb_lay = FlowLayout(toolbar, margin=0, hspacing=8, vspacing=8)
        tb_lay.setContentsMargins(16, 10, 16, 10)
        self.scope_combo = QComboBox()
        # 限宽：内容很短，但全局 QSS 会把 QComboBox 撑到 ~150px，9 个控件累计超宽
        # 导致宽屏也提前换行。按内容设上限，宽屏保持单行、窄屏才换行。
        self.scope_combo.setMaximumWidth(132)
        self.scope_combo.addItems(["全部", "1 度邻域(选中)", "2 度邻域(选中)"])
        self.scope_combo.currentIndexChanged.connect(lambda _i: self.reload())
        tb_lay.addWidget(self.scope_combo)
        self.folder_combo = QComboBox()
        self.folder_combo.setMaximumWidth(132)
        self.folder_combo.addItem("全部文件夹", None)
        self.folder_combo.currentIndexChanged.connect(lambda _i: self.reload())
        tb_lay.addWidget(self.folder_combo)
        self.tag_combo = QComboBox()
        self.tag_combo.setMaximumWidth(132)
        self.tag_combo.addItem("全部标签", None)
        self.tag_combo.currentIndexChanged.connect(lambda _i: self.reload())
        tb_lay.addWidget(self.tag_combo)
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("搜索节点（Ctrl+F）…")
        self.search_input.setFixedWidth(150)
        self.search_input.textChanged.connect(self._focus_node_search)
        tb_lay.addWidget(self.search_input)
        self.btn_pause = QToolButton()
        self.btn_pause.setText("暂停物理")
        self.btn_pause.setCheckable(True)
        self.btn_pause.toggled.connect(self._toggle_pause)
        tb_lay.addWidget(self.btn_pause)
        self.btn_ownership = QToolButton()
        self.btn_ownership.setText("归属连线")
        self.btn_ownership.setCheckable(True)
        self.btn_ownership.toggled.connect(self._toggle_ownership_mode)
        tb_lay.addWidget(self.btn_ownership)
        self.btn_reference = QToolButton()
        self.btn_reference.setText("引用连线")
        self.btn_reference.setCheckable(True)
        self.btn_reference.toggled.connect(self._toggle_reference_mode)
        tb_lay.addWidget(self.btn_reference)
        self.fit_btn = QToolButton()
        self.fit_btn.setText("适配视图")
        self.fit_btn.clicked.connect(lambda: self.view.fit_all())
        tb_lay.addWidget(self.fit_btn)
        self.reheat_btn = QToolButton()
        self.reheat_btn.setText("重排")
        self.reheat_btn.clicked.connect(self._reheat)
        tb_lay.addWidget(self.reheat_btn)
        self._apply_toolbar_icons()
        self.toolbar = toolbar          # 供测试/后续扩展引用（布局为 FlowLayout）
        self.toolbar_card = UCard("图谱工具栏")
        self.toolbar_card.add_widget(toolbar, 0)
        lay.addWidget(self.toolbar_card)

        self.info_icon = QLabel()
        self.info_icon.setFixedSize(16, 16)
        self.info_icon.hide()
        self.info_label = QLabel("双击打开；拖拽固定位置；「归属连线」/「引用连线」后从节点拖到节点改写拓扑；悬浮高亮邻域")
        info_row = QHBoxLayout()
        info_row.setContentsMargins(0, 0, 0, 0)
        info_row.setSpacing(6)
        info_row.addWidget(self.info_icon, 0, Qt.AlignVCenter)
        info_row.addWidget(self.info_label, 1)
        lay.addLayout(info_row)

        self.view = GraphView(self)
        self.empty_state = EmptyState("nav.graph",
                                      "图谱还是空的，先去写笔记并输入 [[ 建立链接", "", self)
        self.graph_stack = QStackedWidget()
        self.graph_stack.addWidget(self.view)
        self.graph_stack.addWidget(self.empty_state)
        graph_card = UCard()
        graph_card.add_widget(self.graph_stack, 1)
        lay.addWidget(graph_card, 1)

        side = QFrame()
        side.setFixedWidth(230)
        side_lay = QVBoxLayout(side)
        side_lay.setContentsMargins(14, 12, 14, 12)
        self.side_title = QLabel("选中节点")
        f = self.side_title.font()
        f.setBold(True)
        self.side_title.setFont(f)
        side_lay.addWidget(self.side_title)
        self.side_info = QLabel("点击节点查看详情")
        self.side_info.setWordWrap(True)
        side_lay.addWidget(self.side_info)
        self.open_btn = QToolButton()
        self.open_btn.setText("打开笔记")
        self.open_btn.clicked.connect(self._open_selected)
        side_lay.addWidget(self.open_btn)
        side_lay.addStretch(1)
        self.side_card = UCard()
        self.side_card.add_widget(side, 1)
        lay.addWidget(self.side_card)

        self._physics = QTimer(self)
        self._physics.setInterval(16)
        self._physics.timeout.connect(self._tick)

    # ---------- 数据 ----------
    def _populate_filters(self):
        """刷新文件夹/标签过滤下拉（保留当前选择）。"""
        cur_folder = self.folder_combo.currentData()
        self.folder_combo.blockSignals(True)
        self.folder_combo.clear()
        self.folder_combo.addItem("全部文件夹", None)
        try:
            for f in self.note_service.folder_titles():
                self.folder_combo.addItem(f.name, f.id)
        except Exception:
            pass
        idx = self.folder_combo.findData(cur_folder)
        self.folder_combo.setCurrentIndex(idx if idx >= 0 else 0)
        self.folder_combo.blockSignals(False)

        cur_tag = self.tag_combo.currentData()
        self.tag_combo.blockSignals(True)
        self.tag_combo.clear()
        self.tag_combo.addItem("全部标签", None)
        try:
            for tid, name, _color in self.note_service.all_tags():
                self.tag_combo.addItem(name, tid)
        except Exception:
            pass
        idx = self.tag_combo.findData(cur_tag)
        self.tag_combo.setCurrentIndex(idx if idx >= 0 else 0)
        self.tag_combo.blockSignals(False)

    def reload(self):
        """图谱真实构建。首屏前由 showEvent 惰性触发，避免启动卡顿（#①）。"""
        self._pending_reload = False
        self._reload_impl()

    def showEvent(self, ev):
        super().showEvent(ev)
        if self._pending_reload:
            self.reload()

    def _reload_impl(self):
        self._generation += 1
        self._cancel_layout_worker()
        self._populate_filters()
        scope = self.scope_combo.currentIndex()
        folder_id = self.folder_combo.currentData()
        tag_id = self.tag_combo.currentData()
        self.view.reset_link()
        # 必须先清空「选中连线 / 正在改挂」引用：下面 scene().clear() 会销毁所有
        # item，若仍持有旧 EdgeItem（其 src/dst 为已析构的 NodeItem），后续鼠标
        # 事件访问 node.x() 会抛 RuntimeError: Internal C++ object already deleted。
        self.view.clear_edge_edit_state()
        self.nodes.clear()
        self.edges.clear()
        self.view.scene().clear()
        if scope == 0:
            data = self.graph_service.build(folder_id=folder_id, tag_id=tag_id,
                                            include_tasks=True)
        else:
            degree = scope if scope == 1 else 2
            seed = self._selected_id
            data = (self.graph_service.neighborhood(seed, degree)
                    if seed else self.graph_service.build(include_tasks=True))
        self._data = data
        # 空状态：无节点时显示提示，隐藏画布
        n_total = len(data.by_id) + len(data.dangling)
        self.graph_stack.setCurrentWidget(self.empty_state if n_total == 0 else self.view)
        # 防交叉初始排版：归属 DAG 分层 + 重心排序；孤立/纯引用节点环绕核心
        self._root_note_ids = self._collect_root_note_ids()
        positions = self._initial_positions(data)
        for node in data.by_id.values():
            item = NodeItem(node, self)
            item.setPos(positions.get(node.id, QPointF(0.0, 0.0)))
            self.view.scene().addItem(item)
            self.nodes[node.id] = item
        edge_set = {(s, d) for s, d in data.edges}
        processed = set()
        for src, dst in data.edges:
            if (src, dst) in processed:
                continue
            a, b = self.nodes.get(src), self.nodes.get(dst)
            if not (a and b):
                continue
            kind = data.edge_kinds.get((src, dst)) or self._edge_kind(a.node.kind, b.node.kind)
            if (dst, src) in edge_set and a.node.kind == b.node.kind == "note":
                # 双向引用：合并为单线 + 双向箭头
                edge = EdgeItem(a, b, kind, bidirectional=True)
                self.view.scene().addItem(edge)
                self.edges.append(edge)
                processed.add((src, dst))
                processed.add((dst, src))
            else:
                edge = EdgeItem(a, b, kind)
                self.view.scene().addItem(edge)
                self.edges.append(edge)
                processed.add((src, dst))
        self._frame = 0
        self._running = True
        self._vel = {}
        self._physics.start()
        self._focus_node_search(self.search_input.text())
        self._warn_cycle_edges()

    # ---------- 增量局部刷新（观察者模式 · 需求 1 闭环） ----------
    def apply_delta(self, delta) -> None:
        """消费 GraphDelta 做局部更新：保留布局/pinned，不回退全量 reload。

        契约 §4.2：added_nodes/removed_node_ids/updated_node_ids/added_edges/
        removed_edges/edge_kinds/full。结构剧变（full 或尚未构建）时才整体重建，
        并保留可匹配节点的坐标与 pinned。
        """
        if delta is None:
            return
        if delta.full or self._data is None or self._pending_reload:
            self._rebuild_preserving_positions()
            return
        cache = getattr(self.graph_service, "_cache", None)
        if cache is not None:
            self._data = cache   # 与数据层新缓存对齐（diff 已基于它计算）
        if delta.empty:
            return

        # 根目录笔记集合刷新（决定笔记节点配色）
        self._root_note_ids = self._collect_root_note_ids()

        # 1) 移除边
        removed_edges = {tuple(e) for e in delta.removed_edges}
        if removed_edges:
            kept = []
            for edge in self.edges:
                if (edge.src.node.id, edge.dst.node.id) in removed_edges:
                    if edge.scene() is not None:
                        self.view.scene().removeItem(edge)
                else:
                    kept.append(edge)
            self.edges = kept

        # 2) 移除节点（并清理其残留边）
        removed_ids = set(delta.removed_node_ids)
        if removed_ids:
            for nid in removed_ids:
                item = self.nodes.pop(nid, None)
                if item is not None and item.scene() is not None:
                    self.view.scene().removeItem(item)
            self.edges = [e for e in self.edges
                          if e.src.node.id in self.nodes and e.dst.node.id in self.nodes]

        # 3) 更新节点（label/color/kind 等，从新缓存取最新 GraphNode）
        for nid in delta.updated_node_ids:
            item = self.nodes.get(nid)
            if item is None or cache is None:
                continue
            fresh = cache.by_id.get(nid)
            if fresh is not None:
                item.node = fresh
                item._apply_style()

        # 4) 新增节点（就近初始位置，既有布局不动）
        for node in delta.added_nodes:
            if node.id in self.nodes:
                continue
            item = NodeItem(node, self)
            item.setPos(self._new_node_position(node))
            self.view.scene().addItem(item)
            self.nodes[node.id] = item

        # 5) 新增边（两类边语义由 delta.edge_kinds 提供，缺省回退本地矩阵）
        existing_keys = {(edge.src.node.id, edge.dst.node.id) for edge in self.edges}
        for e in delta.added_edges:
            key = (e[0], e[1])
            if key in existing_keys:
                continue
            a, b = self.nodes.get(e[0]), self.nodes.get(e[1])
            if not (a and b):
                continue
            kind = delta.edge_kinds.get(key) or self._edge_kind(a.node.kind, b.node.kind)
            rkey = (e[1], e[0])
            if rkey in existing_keys and a.node.kind == b.node.kind == "note":
                # 反向引用：把已有正向单线升级为双向箭头
                for edge in self.edges:
                    if (edge.src.node.id, edge.dst.node.id) == rkey:
                        edge.bidirectional = True
                        edge.update_path()
                existing_keys.add(key)
                continue
            edge = EdgeItem(a, b, kind)
            self.view.scene().addItem(edge)
            self.edges.append(edge)
            existing_keys.add(key)

        # 6) 空状态切换 + 恢复物理（新节点自然散开，不重置既有布局/pinned）
        self.graph_stack.setCurrentWidget(self.empty_state if not self.nodes else self.view)
        for edge in self.edges:
            edge.update_line()
        self._reheat()
        self._warn_cycle_edges()

    def _rebuild_preserving_positions(self) -> None:
        """结构剧变重建：整体 rebuild 后恢复可匹配节点的坐标/pinned。"""
        old_pos = {nid: (it.x(), it.y()) for nid, it in self.nodes.items()}
        old_pinned = {nid: it.pinned for nid, it in self.nodes.items()}
        self.reload()
        for nid, it in self.nodes.items():
            if nid in old_pos:
                it.setPos(old_pos[nid][0], old_pos[nid][1])
                it.pinned = old_pinned[nid]
        for edge in self.edges:
            edge.update_line()

    def _new_node_position(self, node) -> QPointF:
        """新增节点就近初始位置：优先放在已存在邻节点附近，否则环绕原点散开。"""
        data = self._data
        if data is not None:
            for s, d in data.edges:
                nb = None
                if s == node.id and d in self.nodes:
                    nb = self.nodes[d]
                elif d == node.id and s in self.nodes:
                    nb = self.nodes[s]
                if nb is not None:
                    off = (node.id % 7) - 3
                    return QPointF(nb.x() + 55.0 + off * 9.0,
                                   nb.y() + off * 11.0)
        off = (node.id % 5) * 26.0
        return QPointF(off - 52.0, off - 52.0)

    def _warn_cycle_edges(self) -> None:
        """循环归属断开提示（同一组循环边只提示一次，避免重复打扰）。"""
        data = self._data
        if data is None:
            return
        cycles = tuple(sorted(tuple(e) for e in data.cycle_edges))
        if not cycles or cycles == self._last_cycle_warn:
            return
        self._last_cycle_warn = cycles
        self._set_info(f"检测到循环归属，已断开 {len(cycles)} 条边", "warn.alert", "warm")

    @staticmethod
    def _edge_kind(a_kind: str, b_kind: str) -> str:
        """两类边：ownership（归属实线 DAG）/ reference（引用虚线）。"""
        if a_kind == "folder" and b_kind in ("folder", "note"):
            return "ownership"
        if a_kind == "task" and b_kind == "note":
            return "ownership"
        if a_kind == "note" and b_kind == "task":
            return "ownership"
        if a_kind == "task" and b_kind == "task":
            return "ownership"   # 任务父子层级（归属实线 DAG）
        return "reference"

    def _collect_root_note_ids(self):
        """收集根目录笔记（folder_id 为 None）节点 id，供独立配色。"""
        if self.note_service is None:
            return set()
        try:
            return {n.id for n in self.note_service.list() if n.folder_id is None}
        except Exception:  # noqa: BLE001
            return set()

    @staticmethod
    def _median_order(neighbors, order, fallback):
        vals = sorted(order.get(m, fallback) for m in neighbors)
        if not vals:
            return fallback
        return vals[len(vals) // 2]

    def _initial_positions(self, data: GraphData) -> Dict[int, QPointF]:
        """防交叉初始排版：归属 DAG 分层（Kahn）+ 层内重心排序；孤立/纯引用节点环绕核心。

        归属边（folder→folder / folder→note / task→note）按拓扑分层、层内按邻层重心排序，
        从源头上减少同层交叉；引用边与孤立节点（闪念/待建/纯引用笔记）环绕核心放置。
        """
        pos: Dict[int, QPointF] = {}
        nids = list(data.by_id.keys())
        if not nids:
            return pos
        children = {n: [] for n in nids}
        parents = {n: [] for n in nids}
        indeg = {n: 0 for n in nids}
        core = set()
        for s, d in data.edges:
            a, b = data.by_id.get(s), data.by_id.get(d)
            kind = data.edge_kinds.get((s, d)) or self._edge_kind(a.kind, b.kind)
            if a and b and kind == "ownership":
                children[s].append(d)
                parents[d].append(s)
                indeg[d] += 1
                core.add(s)
                core.add(d)

        layer_spacing = 150.0
        node_spacing = 110.0

        if core:
            level: Dict[int, int] = {}
            frontier = [n for n in core if indeg[n] == 0]
            lvl = 0
            while frontier:
                nxt = []
                for n in frontier:
                    level[n] = lvl
                    for c in children[n]:
                        indeg[c] -= 1
                        if indeg[c] == 0:
                            nxt.append(c)
                frontier = nxt
                lvl += 1
            for n in core:
                if n not in level:
                    level[n] = lvl  # 环防护：残留节点沉底
            layers: Dict[int, list] = {}
            for n, lv in level.items():
                layers.setdefault(lv, []).append(n)
            order = {n: float(i) for i, n in enumerate(nids)}
            for _round in range(3):
                for lv in sorted(layers.keys()):
                    layers[lv].sort(key=lambda n: self._median_order(parents[n], order, order.get(n, 0.0)))
                    for i, n in enumerate(layers[lv]):
                        order[n] = float(i)
                for lv in sorted(layers.keys(), reverse=True):
                    layers[lv].sort(key=lambda n: self._median_order(children[n], order, order.get(n, 0.0)))
                    for i, n in enumerate(layers[lv]):
                        order[n] = float(i)
            for lv in sorted(layers.keys()):
                nodes = layers[lv]
                y = lv * layer_spacing
                for i, n in enumerate(nodes):
                    x = (i - (len(nodes) - 1) / 2.0) * node_spacing
                    pos[n] = QPointF(x, y)

        # 非核心节点（孤立闪念/待建/纯引用笔记/空文件夹）环绕核心
        ring = [n for n in nids if n not in pos]
        if ring:
            if pos:
                cx = sum(p.x() for p in pos.values()) / len(pos)
                cy = sum(p.y() for p in pos.values()) / len(pos)
                spread = max(max(abs(p.x() - cx), abs(p.y() - cy)) for p in pos.values())
            else:
                cx = cy = 0.0
                spread = 0.0
            ring_radius = max(240.0, spread + 90.0)
            for i, n in enumerate(ring):
                ang = 2 * math.pi * i / max(1, len(ring))
                pos[n] = QPointF(cx + ring_radius * math.cos(ang),
                                 cy + ring_radius * math.sin(ang))
        return pos

    def _focus_node_search(self, text: str):
        """Ctrl+F 搜索节点：镜头飞入 + 高亮匹配节点（F3-5）。"""
        text = (text or "").strip().lower()
        if not text:
            self.view.fit_all()
            self.clear_highlight()
            return
        target = None
        for nid, item in self.nodes.items():
            if text in (item.node.label or "").lower():
                target = item
                break
        if target is None:
            return
        self.select_node(target.node.id)
        self.clear_highlight()
        for it in self.nodes.values():
            it.setOpacity(0.25)
        target.setOpacity(1.0)
        self.view.centerOn(target)

    def focus_node_search(self):
        """供主窗口 Ctrl+F 聚焦图谱搜索框。"""
        self.search_input.setFocus()
        self.search_input.selectAll()

    def _reheat(self):
        self._frame = 0
        self._running = True
        self._physics.start()

    # ---------- 力导向（QThreadPool 后台线程，主线程只应用结果） ----------
    def _tick(self):
        # 图谱页不可见时暂停力导向，避免后台空转占用主线程（启动性能优化）
        if not self.isVisible() or not self._running or self.btn_pause.isChecked():
            return
        if self._frame >= 400:
            self._physics.stop()
            return
        self._start_layout_worker()

    def _start_layout_worker(self):
        if self._worker_active:
            return
        states = {}
        for nid, item in self.nodes.items():
            vx, vy = self._vel.get(nid, (0.0, 0.0))
            states[nid] = [item.x(), item.y(), vx, vy, bool(item.pinned)]
        edge_pairs = [(e.src.node.id, e.dst.node.id) for e in self.edges]
        self._worker_active = True
        worker = _LayoutWorker(
            self._bridge, self._generation, states, edge_pairs,
            {"repulsion": _REPULSION, "spring": _SPRING, "spring_len": _SPRING_LEN,
             "center": _CENTER_PULL, "damp": _DAMP})
        self._current_worker = worker
        QThreadPool.globalInstance().start(worker)

    def _apply_layout(self, generation, result):
        if generation != self._generation:
            return   # 旧帧结果（reload 已换代）直接丢弃
        self._worker_active = False
        self._current_worker = None
        for nid, (x, y, vx, vy) in result.items():
            item = self.nodes.get(nid)
            if item is not None and not item.pinned:
                item.setPos(x, y)
                self._vel[nid] = (vx, vy)
        for edge in self.edges:
            edge.update_line()
        self._frame += 1
        if self._frame >= 400:
            self._running = False
            self._physics.stop()

    def _cancel_layout_worker(self):
        if self._current_worker is not None:
            self._current_worker.cancel()
        self._current_worker = None
        self._worker_active = False

    def _toggle_pause(self, checked):
        self._set_info("物理已暂停" if checked else "")

    def _toggle_ownership_mode(self, checked):
        """归属连线入口：实线 DAG（文件夹层级 / 文件夹→笔记 / 任务→笔记 / 任务父子）。"""
        if checked:
            if self.btn_reference.isChecked():
                self.btn_reference.blockSignals(True)
                self.btn_reference.setChecked(False)
                self.btn_reference.blockSignals(False)
            self.view.set_link_mode("ownership")
            self._set_info(
                "归属连线：从文件夹/任务拖到笔记或子级节点，释放后改写归属（成环自动拒绝）")
        elif not self.btn_reference.isChecked():
            self.view.set_link_mode(None)
            self._set_info("")

    def _toggle_reference_mode(self, checked):
        """引用连线入口：虚线（仅笔记↔笔记，排除文件夹与任务）。"""
        if checked:
            if self.btn_ownership.isChecked():
                self.btn_ownership.blockSignals(True)
                self.btn_ownership.setChecked(False)
                self.btn_ownership.blockSignals(False)
            self.view.set_link_mode("reference")
            self._set_info(
                "引用连线：从笔记拖到另一个笔记，释放后建立引用（虚线）")
        elif not self.btn_ownership.isChecked():
            self.view.set_link_mode(None)
            self._set_info("")

    # ---------- 拖拽连线改写拓扑（两类边 + 约束检查） ----------
    def commit_connection(self, src: "NodeItem", dst: "NodeItem", mode: Optional[str]):
        """拖拽释放：按连接矩阵自动识别边类（归属/引用）→ 约束检查 → 改写底层数据。

        检查顺序（契约 §7.2）：自环/待建端点 → 连接矩阵 → 入口边类匹配 →
        归属层级祖先链环路校验 → 服务层写入。成功后经领域事件 → graph_delta 增量刷新。
        """
        src_node, dst_node = src.node, dst.node
        src_id, dst_id = src_node.id, dst_node.id
        src_kind, dst_kind = src_node.kind, dst_node.kind
        src_ref = src_node.ref_id or src_id
        dst_ref = dst_node.ref_id or dst_id

        # 1) 自环 / 待建链接端点
        if src_id == dst_id:
            self._link_feedback("不能连接自身", error=True)
            return
        if src_kind == "dangling" or dst_kind == "dangling":
            self._link_feedback("待建链接节点不能作为连线端点", error=True)
            return

        # 2) 连接矩阵：确定边类（未命中即禁止）。
        # 任务↔笔记两种关系都合法（归属 / 引用），最终边类由入口模式决定；
        # 其余组合仍是「一种关系」，模式不匹配时给出可操作的提示。
        raw_kind = self.graph_service.connection_allowed(src_kind, dst_kind)
        if raw_kind is None:
            self._link_feedback(self._forbidden_reason(src_kind, dst_kind), error=True)
            return
        edge_kind = self.graph_service.resolve_edge_kind(src_kind, dst_kind, mode)
        if raw_kind != "either" and mode is not None and raw_kind != mode:
            kind_cn = "归属" if raw_kind == "ownership" else "引用"
            other = "归属连线" if raw_kind == "ownership" else "引用连线"
            pair = f"{_KIND_CN.get(src_kind, src_kind)} → {_KIND_CN.get(dst_kind, dst_kind)}"
            self._link_feedback(
                f"{pair} 只能建立「{kind_cn}」关系，请点上方「{other}」再拖拽",
                error=True)
            return

        # 3) 归属层级改挂（folder->folder / task->task）祖先链环路校验
        if edge_kind == "ownership" and src_kind == dst_kind and src_kind in ("folder", "task"):
            if self.graph_service.would_create_cycle(src_id, dst_id, kind=src_kind):
                self._link_feedback("不能挂到自己的子孙下（会形成环）", error=True)
                return

        # 4) 改写底层数据（成功后经领域事件 → graph_delta 增量刷新）
        ok = self._rewrite_topology(edge_kind, src_kind, dst_kind, src_ref, dst_ref)
        if ok:
            self._link_feedback(self._success_message(
                edge_kind, src_kind, dst_kind, src_node.label or "", dst_node.label or ""))
        else:
            self._link_feedback("改写失败：目标可能已删除或不可用", error=True)

    def _rewrite_topology(self, edge_kind, src_kind, dst_kind, src_ref, dst_ref) -> bool:
        """按边类与端点 kind 调用底层写入。

        笔记/文件夹走 note_service；任务归属走 graph_service.attach_task_note/
        reparent_task（数据层复用 TaskRepository.link_note 幂等语义并补发领域事件）。
        """
        if edge_kind == "reference":
            # 任务↔笔记引用（v9）：写 task_note_ref，与归属关系并存
            if {src_kind, dst_kind} == {"task", "note"}:
                task_ref, note_ref = ((src_ref, dst_ref) if src_kind == "task"
                                      else (dst_ref, src_ref))
                return self.graph_service.link_task_note_ref(task_ref, note_ref)
            # note -> note 引用：沿用 linkRequested → AppController._link_notes →
            # graph_service.link_notes（幂等写入 + note_links_changed → 增量刷新）。
            self.linkRequested.emit(src_ref, dst_ref)
            return True
        # ownership 归属
        if src_kind == "folder" and dst_kind == "note":
            # folder -> note：笔记移入文件夹（note.folder_id）
            return self.note_service.save(dst_ref, folder_id=src_ref) is not None
        if src_kind == "folder" and dst_kind == "folder":
            # folder -> folder：改层级（move_folder 内部已做祖先链校验）
            return self.note_service.move_folder(src_ref, dst_ref) is not None
        if src_kind == "task" and dst_kind == "note":
            return self.graph_service.attach_task_note(src_ref, dst_ref)
        if src_kind == "note" and dst_kind == "task":
            # note -> task：方向归一为 task -> note
            return self.graph_service.attach_task_note(dst_ref, src_ref)
        if src_kind == "task" and dst_kind == "task":
            return self.graph_service.reparent_task(src_ref, dst_ref)
        return False

    # ---------- 连线编辑（v9）：删除 / 端点改挂 ----------
    def remove_edge(self, edge) -> bool:
        """删除一条连线（改写真数据），返回是否成功。

        按边类与端点分派：
        - 任务↔笔记引用（虚线）→ 删 task_note_ref 行；
        - 任务↔笔记归属（实线）→ 删 task_note_link 行；
        - 任务↔任务归属 → 解除父子（reparent_task(None)）；
        - 笔记↔笔记引用 → 删 note_link 行；
        - 文件夹↔笔记归属 → 移出文件夹（folder_id=None）。
        删除后经领域事件触发增量刷新（图谱自动去掉该边）。
        """
        src_node, dst_node = edge.src.node, edge.dst.node
        sk, dk = src_node.kind, dst_node.kind
        src_ref = src_node.ref_id or src_node.id
        dst_ref = dst_node.ref_id or dst_node.id
        kind = getattr(edge, "kind", "ownership")
        try:
            if {sk, dk} == {"task", "note"}:
                task_ref, note_ref = ((src_ref, dst_ref) if sk == "task"
                                      else (dst_ref, src_ref))
                ok = (self.graph_service.unlink_task_note_ref(task_ref, note_ref)
                      if kind == "reference"
                      else self.graph_service.detach_task_note(task_ref, note_ref))
            elif sk == "task" and dk == "task":
                ok = self.graph_service.reparent_task(dst_ref, None)
            elif sk == "note" and dk == "note":
                ok = self._remove_note_link(src_ref, dst_ref)
            elif {sk, dk} == {"folder", "note"}:
                folder_ref, note_ref = ((src_ref, dst_ref) if sk == "folder"
                                        else (dst_ref, src_ref))
                ok = self.note_service.save(note_ref, folder_id=None) is not None
            else:
                ok = False
        except Exception:  # noqa: BLE001 —— 删除失败不应崩溃
            ok = False
        if ok:
            self._set_info("已删除该连线", "action.check", "success")
            self.reload()
        else:
            self._set_info("删除失败：该连线可能不支持删除或已被移除",
                           "warn.alert", "warm")
        return bool(ok)

    def _remove_note_link(self, src_note_id: int, dst_note_id: int) -> bool:
        """删除笔记↔笔记引用行（note_link），并发 note_links_changed 刷新。"""
        from sqlalchemy import delete as sa_delete
        from ...model.infrastructure.models import NoteLinkRow
        s = self.graph_service.db.session()
        removed = False
        try:
            res = s.execute(sa_delete(NoteLinkRow).where(
                NoteLinkRow.src_note_id == src_note_id,
                NoteLinkRow.dst_note_id == dst_note_id))
            removed = bool(res.rowcount)
            if removed:
                s.commit()
        finally:
            s.close()
        if removed:
            try:
                self.graph_service.notes.bus.note_links_changed.emit(src_note_id)
            except Exception:  # noqa: BLE001
                pass
        return removed

    def rewire_edge(self, edge, end: str, new_node) -> bool:
        """把连线的一端改挂到 new_node（先建新关系、再删旧关系）。"""
        keep = edge.dst if end == "src" else edge.src
        # 复用既有约束与写入链路：新建合法则提交，成功后删掉旧边
        before_kind = getattr(edge, "kind", "ownership")
        self.commit_connection(keep, new_node, before_kind)
        removed = self.remove_edge(edge)
        if removed:
            self._set_info(
                f"已把连线改挂到「{new_node.node.label or '（无标题）'}」",
                "action.check", "success")
        return bool(removed)

    def _forbidden_reason(self, sk: str, dk: str) -> str:
        """不允许连线时给出「为什么」+「怎么改」，而不是笼统的「不允许连线」。"""
        a, b = _KIND_CN.get(sk, sk), _KIND_CN.get(dk, dk)
        if sk == "flash" or dk == "flash":
            return "闪念是孤立节点，不能参与连线"
        if sk == "anchor" or dk == "anchor":
            return "段落锚是任务引用的产物，不能手工连线"
        if sk == "dangling" or dk == "dangling":
            return "待建链接节点不能作为连线端点"
        if sk in ("folder", "task") and dk in ("folder", "task") and sk != dk:
            return f"{a}与{b}之间不能直接连线"
        if sk == "note" and dk == "folder":
            return "笔记不能归属文件夹（请从文件夹拖到笔记）"
        if sk == "note" and dk in ("task", "folder"):
            return f"{a} 不能拖向 {b}（请从 {b} 拖到 {a}）"
        return f"{a} → {b} 不支持连线"

    def _success_message(self, edge_kind, src_kind, dst_kind, src_label, dst_label) -> str:
        if edge_kind == "reference":
            if {src_kind, dst_kind} == {"task", "note"}:
                t, n = ((src_label, dst_label) if src_kind == "task"
                        else (dst_label, src_label))
                return f"已建立引用：任务「{t}」引用了笔记「{n}」"
            return f"已建立引用：{src_label} → {dst_label}"
        if src_kind == "folder":
            if dst_kind == "note":
                return f"已把笔记「{dst_label}」移入文件夹「{src_label}」"
            return f"已把文件夹「{src_label}」挂到「{dst_label}」下"
        if dst_kind == "note":
            return f"已关联任务「{src_label}」与笔记「{dst_label}」"
        if src_kind == "note":  # note -> task 归一
            return f"已关联笔记「{src_label}」与任务「{dst_label}」"
        return f"已把任务「{src_label}」挂到「{dst_label}」下"

    def _set_info(self, msg: str = "", icon_name: Optional[str] = None,
                  tone: str = ""):
        """信息行：可选 SVG 图标 + 文本（icon_name 对应 icons 库；tone 取语义 token 色）。"""
        from ..kit import icons
        from qfluent_core import ThemeManager as ThemeEngine
        self.info_label.setText(msg)
        if icon_name and tone:
            eng = ThemeEngine.instance()
            color = eng.t(tone, "#6B7280") if eng else "#6B7280"
            self.info_icon.setPixmap(icons.pixmap(icon_name, color, 14, 1.0))
            self.info_icon.show()
        else:
            self.info_icon.hide()

    def _link_feedback(self, msg: str, error: bool = False):
        self._set_info(msg, "action.close" if error else "action.check",
                       "danger" if error else "success")

    # ---------- 交互 ----------
    def update_edges_of(self, node_id: int):
        for edge in self.edges:
            if edge.src.node.id == node_id or edge.dst.node.id == node_id:
                edge.update_line()

    def highlight_neighborhood(self, node_id: int):
        near = {node_id}
        for edge in self.edges:
            a, b = edge.src.node.id, edge.dst.node.id
            if a == node_id:
                near.add(b)
            elif b == node_id:
                near.add(a)
        for nid, item in self.nodes.items():
            item.setOpacity(1.0 if nid in near else 0.22)
        for edge in self.edges:
            connected = edge.src.node.id == node_id or edge.dst.node.id == node_id
            if connected:
                edge.set_highlight(True)   # 直连边 → 高亮深灰
                edge.setOpacity(1.0)
            else:
                edge.set_highlight(False)
                edge.setOpacity(0.08)

    def clear_highlight(self):
        for item in self.nodes.values():
            item.setOpacity(1.0)
        for edge in self.edges:
            edge.set_highlight(False)
            edge.setOpacity(1.0)

    def select_node(self, node_id: int):
        self._selected_id = node_id
        node = self._data.by_id.get(node_id) if self._data else None
        if node:
            kind_label = {"note": "笔记", "flash": "闪念",
                          "dangling": "待建链接", "task": "任务",
                          "folder": "文件夹", "anchor": "段落引用"}.get(node.kind, node.kind)
            self.side_title.setText(node.label)
            preview = ""
            try:
                preview = self.graph_service.preview_text(node)
            except Exception:  # noqa: BLE001
                preview = ""
            self.side_info.setText(preview or f"类型：{kind_label}\n链接数：{node.degree}")
            self.open_btn.setText({"note": "打开笔记", "flash": "跳转闪念",
                                   "dangling": "新建笔记",
                                   "task": "打开任务",
                                   "folder": "定位文件夹",
                                   "anchor": "定位段落"}.get(node.kind, "打开"))

    def _open_selected(self):
        node = self._data.by_id.get(self._selected_id) if self._data else None
        if node is None:
            return
        if node.kind == "flash":
            self.flashOpenRequested.emit(node.ref_id)
        elif node.kind == "note":
            self.openNoteRequested.emit(node.ref_id or node.id)
        elif node.kind == "task":
            self.openTaskRequested.emit(node.ref_id)
        elif node.kind == "folder":
            self.folderOpenRequested.emit(node.ref_id)
        elif node.kind == "anchor":
            # v0.15 P1-3: 选中侧栏「定位段落」→ 打开笔记并定位
            self.noteBlockOpenRequested.emit(node.ref_id,
                                             getattr(node, "block_key", "") or "")
        elif node.kind == "dangling":
            self.createNoteRequested.emit(node.label)

    def _apply_toolbar_icons(self):
        """图谱工具栏 SVG 图标族（F9-7）：替代旧 emoji 图标。"""
        from ..kit.icons import icon
        eng = ThemeEngine.instance()
        fg = eng.t("fg", "#1A1A1A") if eng else "#1A1A1A"
        try:
            for btn in (self.btn_pause, self.btn_ownership, self.btn_reference,
                        self.fit_btn, self.reheat_btn):
                btn.setToolButtonStyle(Qt.ToolButtonTextBesideIcon)
            self.btn_pause.setIcon(icon("pomo.pause", fg, 16))
            self.btn_ownership.setIcon(icon("folder.folder", fg, 16))
            self.btn_reference.setIcon(icon("link.link", fg, 16))
            self.fit_btn.setIcon(icon("action.full", fg, 16))
            self.reheat_btn.setIcon(icon("action.refresh", fg, 16))
        except Exception:
            pass

    def _on_theme_changed(self):
        """主题切换：刷新页面 QSS + 工具栏图标 + 节点/边样式。"""
        self._restyle()
        self._restyle_icons()

    def _restyle_icons(self):
        self._apply_toolbar_icons()
        # 首屏尚未构建时（_pending_reload）不随主题重建，避免启动期被 theme.changed 触发图谱构建
        if self._pending_reload:
            return
        # 主题切换：对现有节点/边逐一重刷样式，保留坐标/pinned；仅当确实需要重排版时才 reload。
        for item in self.nodes.values():
            item._apply_style()
        for edge in self.edges:
            edge._apply_style()

    def _restyle(self):
        eng = ThemeEngine.instance()
        if eng:
            self.setStyleSheet(
                f"QLabel {{ background: transparent; }}"
                f"QToolButton, QPushButton {{ background-color: {eng.t('hover', '#F5F5F5')};"
                f"color: {eng.t('fg', '#1A1A1A')}; border: 1px solid transparent;"
                f"border-radius: 6px; padding: 4px 10px; }}"
                f"QToolButton {{ border-color: {eng.t('border', '#E4EDE8')}; }}")
