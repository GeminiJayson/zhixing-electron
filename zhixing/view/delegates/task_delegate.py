# -*- coding: utf-8 -*-
"""任务行 delegate：优先级旗标 · 勾选圆圈 · 标题 · 标签 chip · 日期/循环/streak/笔记 chip · 悬浮动作按钮。

交互模型（全局统一）：
- 勾选圆圈 → toggleRequested
- 优先级旗标 → editPriorityRequested（点旗标快捷改优先级）
- 标签 chip → editTagsRequested（点 chip 快捷编辑标签）
- 悬浮「专注 / ＋ / 编辑 / 删除」图标按钮（仅 hover 浮出、盖在行右侧内容上，
  不预留常驻空白）→ focusRequested / addSubtaskRequested / openRequested / deleteRequested
- 其余行内标题区 → toggleExpandRequested（折叠/展开子任务；叶子项交还视图做选中）

布局与折叠：
- 右侧信息 chips（笔记/循环/streak/日期）+ 标签 chip 从行右缘向左排布；
  可用宽度不足时先折叠 chips、再折叠标签，行尾以「+N」省略胶囊表示，
  hover 胶囊展开被折叠项的逐行提示（v0.17 折叠预算）。
- 优先级为 v0.17 8 级：旗标色阶/文案统一走 kit/priority。

命中判定按此优先级，业务仍经信号外发、Service 执行。
"""
import time
from datetime import date

from PySide6.QtCore import QRect, QSize, Qt, Signal, QPointF, QTimer
from PySide6.QtGui import QColor, QCursor, QFont, QFontMetrics, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QStyle, QStyledItemDelegate, QStyleOptionViewItem, QToolTip

from ...model.qt.models import (
    RoleChecked, RoleDue, RoleNoteCount, RolePriority, RoleRepeat, RoleStartDate,
    RoleStatus, RoleStreak, RoleTags, RoleTaskId,
)
from ...model.domain.entities import TaskStatus
from ..kit import icons
from ..kit.priority import priority_color, priority_label
from qfluent_core import ThemeManager as ThemeEngine
from zhixing.view.kit.fluent_compat import QLineEdit

# 标题区最小宽度（折叠预算用）；「+N」省略胶囊计数并入所有被折叠项
_MIN_TITLE_WIDTH = 100


class TaskDelegate(QStyledItemDelegate):
    toggleRequested = Signal(int)            # 勾选圆圈：完成/取消
    openRequested = Signal(int)              # 「编辑」按钮：打开编辑页
    deleteRequested = Signal(int)            # 「删除」按钮
    toggleExpandRequested = Signal(int)      # 点击行：折叠/展开子任务
    editPriorityRequested = Signal(int)      # 点击优先级徽标
    editTagsRequested = Signal(int)          # 点击标签 chip
    addSubtaskRequested = Signal(int)        # 点击「+」按钮
    focusRequested = Signal(int)             # 点击「专注」按钮（F5-1 行内入口）
    titleEditRequested = Signal(int)         # 双击标题区：请求行内编辑
    titleCommitted = Signal(int, str)        # 行内编辑提交：task_id, 新标题

    def __init__(self, parent=None, show_actions=True, row_height=38, indent=20,
                 inline_edit=False):
        super().__init__(parent)
        self.show_actions = show_actions
        self.row_height = row_height
        self.indent = indent
        self.inline_edit = inline_edit
        self._last_action = float("-inf")   # 双击去抖：首次点击务必放行（monotonic 可能很小）
        self._press_pos = None          # v0.17.1: press 时记录的行内位置（release 悬浮判定用）
        self._click_timer = None            # 单击动作延时器（双击判定窗口内可取消）
        self._pending_click = None          # (kind, task_id)
        self._checked_state = {}            # task_id -> 上次绘制勾选态（检测切换→启动动效）
        self._strike_progress = {}          # task_id -> 划线进度 0..1（9a）
        self._check_progress = {}           # task_id -> 勾选弹簧进度 0..1（9b）
        self._reveal = {}                   # task_id -> 展开 reveal 进度 0..1（9c）
        self._anims = {}                    # task_id -> [QVariantAnimation,...] 保活
        # v0.15 P1-5: 由页面装配注入 → 返回 (note_title, snippet) 或 None（任务 hover 上下文速读）
        self.snippet_lookup = None

    def helpEvent(self, event, view, option, index):  # noqa: N802
        """v0.15 P1-5 段落速读 + v0.17 省略胶囊 hover 展开。

        - 命中「+N」省略胶囊：以多行 QToolTip 向下展开被折叠胶囊列表；
        - 其余行：若有注入 snippet_lookup 则显示关联笔记段落首行。
        """
        from PySide6.QtCore import QEvent
        if event.type() != QEvent.ToolTip:
            return super().helpEvent(event, view, option, index)
        try:
            pos = event.pos()
            lay = self._layout(option, index, actions_visible=False)
            if lay["more_rect"] is not None and lay["more_rect"].contains(pos) and lay["more_texts"]:
                lines = ["（宽度不足被折叠的胶囊）"] + [f"· {txt}" for txt in lay["more_texts"]]
                QToolTip.showText(event.globalPos(), "\n".join(lines), view)
                return True
            tid = index.data(RoleTaskId)
            if self.snippet_lookup is not None and tid:
                hit = self.snippet_lookup(tid)
                if hit:
                    title, snip = hit
                    QToolTip.showText(event.globalPos(),
                                      f"{title}\n> {snip[:60]}{'…' if len(snip) > 60 else ''}",
                                      view)
                    return True
        except Exception:
            pass
        return super().helpEvent(event, view, option, index)

    def sizeHint(self, option, index):
        return QSize(option.rect.width(), self.row_height)

    # ---------- 内联编辑（双击标题 → tree.edit） ----------
    def createEditor(self, parent, option, index):
        editor = QLineEdit(parent)
        editor.setFrame(False)
        # 覆盖全局 QSS 对 QLineEdit 的 max-height 约束（component_qss 会给
        # QLineEdit 设 max-height=control_h-12，远小于任务行高），否则行内
        # 编辑框被钳制成 20px 高、贴行顶「飘到上方」。固定为行高即可与行对齐。
        editor.setFixedHeight(self.row_height)
        return editor

    def setEditorData(self, editor, index):
        editor.setText(str(index.data(Qt.DisplayRole) or ""))
        editor.selectAll()

    def setModelData(self, editor, model, index):
        tid = index.data(RoleTaskId)
        text = (editor.text() or "").strip()
        if tid is not None and text:
            self.titleCommitted.emit(tid, text)

    def destroyEditor(self, editor, index):
        """行内编辑结束：显式关闭并销毁 editor，避免输入框残留（#③）。"""
        editor.hide()
        editor.deleteLater()

    def updateEditorGeometry(self, editor, option, index):
        lay = self._layout(option, index, actions_visible=False)
        editor.setGeometry(lay["title_rect"])

    # ---------- 字体 ----------
    def _small_font(self, option, s=1.0):
        f = QFont(option.font)
        f.setPixelSize(max(8, int(round(11 * s))))
        return f

    def _mouse_pos(self, option):
        try:
            w = option.widget
            if w is not None:
                return w.mapFromGlobal(QCursor.pos())
        except Exception:
            return None
        return None

    # ---------- 几何（paint 与 editorEvent 共用，保证命中与绘制一致） ----------
    def _depth(self, index):
        depth = 0
        parent = index.parent()
        while parent.isValid():
            depth += 1
            parent = parent.parent()
        return depth

    def _layout(self, option, index, actions_visible=True):
        """v0.17：布局恒定、chips 自带折叠预算。

        - 优先级 = 旗子（priority_color 8 档色阶，无文字），点击旗子改优先级。
        - 右侧信息 chips（笔记/循环/streak/日期）+ 标签 chip 从行右缘向左排布，
          宽度不足时折叠为行尾「+N」省略胶囊（hover 展开 QToolTip 逐行列出）。
        - 悬浮动作按钮（专注/＋/编辑/删除）仅 hover 浮出、**不占位**：
          chips/标题始终用到行右缘；按钮在 hovered 时叠加绘制在 chips 之上。
        - 标题区最小宽度 = _MIN_TITLE_WIDTH(100)，不够时优先折叠 chips。
        actions_visible 参数仅控制「按钮矩形是否给出（供 hover 绘制/命中）」，
        不再挤占 chips 布局 —— 几何恒等于 actions_visible=False 的内容排布。
        """
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        rect = option.rect

        depth = self._depth(index)
        x = rect.x() + 10 + depth * self.indent
        cy = rect.center().y()

        # 其余元素随行高等比缩放：以默认行高 38 为基准，clamp 到 [0.7, 1.4]
        s = max(0.7, min(1.4, self.row_height / 38.0))
        chip_font = self._small_font(option, s)
        chip_fm = QFontMetrics(chip_font)
        title_font = QFont(option.font)
        title_font.setPixelSize(max(10, int(round(14 * s))))
        pill_h = max(14, int(round(18 * s)))
        chip_h = max(14, int(round(20 * s)))
        btn_h = max(14, int(round(20 * s)))
        chip_pad = int(round(16 * s))
        gap = int(round(6 * s))

        priority = index.data(RolePriority)
        checked = bool(index.data(RoleChecked))
        due = index.data(RoleDue)
        start = index.data(RoleStartDate)
        repeat = index.data(RoleRepeat) or "none"
        streak = index.data(RoleStreak) or 0
        note_count = index.data(RoleNoteCount) or 0
        tags = index.data(RoleTags) or []

        accent = t.get("accent", "#0D9488")
        fg2 = t.get("fg2", "#6B7280")
        warm = t.get("warm", "#EA580C")
        danger = t.get("danger", "#DC2626")

        # 勾选圆圈：随行高缩放（14~20px），垂直居中
        d = max(14, min(20, int(self.row_height * 0.5)))
        circle = QRect(x, int(cy) - d // 2, d, d)

        # 优先级旗子（v0.17 8 级；priority=0 或已完成不画）：固定 20px 旗区，无文字
        prio_rect = None
        if int(priority or 0) > 0 and not checked:
            flag_w = max(16, int(20 * s))
            prio_rect = QRect(x + 24, int(cy) - flag_w // 2, flag_w, flag_w)

        # ---------- 右侧内容宽度预算 ----------
        # 行最右缘（按钮浮出基准）与胶囊可用右缘（hover 让位给按钮，非 hover 不占位）
        right_edge_raw = rect.right() - 8
        btn_w = btn_h + 4
        sep = int(round(6 * s))
        n_btns = 4
        right_edge = right_edge_raw
        if actions_visible:
            # 悬浮态：最右 4 个按钮浮出，右侧胶囊让位（移开后命中/绘制都不误触）
            right_edge = right_edge_raw - (btn_w * n_btns + sep * (n_btns - 1)) - 6

        # 候选胶囊：全部先按“从右往左想放置的顺序”编号（近行右缘=最先放）
        # chips 语义（越“时间关键/计数”越靠右，标签靠左）：笔记数 / 循环 / streak / 日期 / 标签
        capsule_specs = []   # (kind, icon|None, text, color, w)
        if note_count:
            capsule_specs.append(("right", "link.link", str(note_count), accent))
        if repeat != "none":
            rlabel = {"daily": "每日", "weekly": "每周", "monthly": "每月"}.get(repeat, "循环")
            capsule_specs.append(("right", None, rlabel, accent))
        if streak and repeat != "none":
            capsule_specs.append(("right", "task.flag", str(streak), warm))
        if start or due:
            today = date.today()
            if start and due:
                dlabel = f"{start.strftime('%m-%d')} ~ {due.strftime('%m-%d')}"
                dcolor = danger if due < today else (accent if due == today else fg2)
            elif due:
                due_s = due.strftime("%m-%d")
                if due == today:
                    dlabel, dcolor = "今天", accent
                elif due < today:
                    dlabel, dcolor = f"逾期 {due_s}", danger
                else:
                    dlabel, dcolor = f"截止 {due_s}", fg2
            else:
                dlabel, dcolor = f"{start.strftime('%m-%d')} 起", fg2
            capsule_specs.append(("right", None, dlabel, dcolor))
        for (_tid, name, color) in (tags or [])[:4]:
            capsule_specs.append(("tag", None, f"#{name}", color))

        def _capsule_width(kind, icon_name, text, _color):
            text_w = chip_fm.horizontalAdvance(text)
            icon_w = (chip_h - 6 + 3) if icon_name else 0
            return icon_w + text_w + chip_pad

        # 可用右区起点：标题/旗子后
        title_left0 = (prio_rect.right() + 8) if prio_rect else (x + 32)

        # 从右缘起逐项摆胶囊；任一放不下即停止，剩余全部折叠进「+N」省略胶囊。
        laid_capsules = []
        hidden_specs = []
        cursor = right_edge
        for spec in capsule_specs:
            kind, icon_name, text, color = spec
            w = _capsule_width(kind, icon_name, text, color)
            need_left = cursor - w
            if need_left >= title_left0 + _MIN_TITLE_WIDTH + (gap if laid_capsules else 0):
                laid_capsules.append(spec + (QRect(int(need_left), int(cy) - chip_h // 2, int(w), chip_h),))
                cursor = need_left - gap
            else:
                hidden_specs.append((kind, icon_name, text, color))
        folded = len(hidden_specs)

        # 省略胶囊（有折叠才出现，放在已放胶囊最左缘）
        more_rect = None
        if folded:
            more_label = f"+{folded}"
            more_w = chip_fm.horizontalAdvance(more_label) + chip_pad
            more_left = (laid_capsules[0][4].left() - gap - more_w
                         if laid_capsules else right_edge - more_w)
            if more_left >= title_left0 + _MIN_TITLE_WIDTH:
                more_rect = QRect(int(more_left), int(cy) - chip_h // 2, int(more_w), chip_h)
            else:  # 行太窄：省略胶囊也放不下 → 全部内容都挤标题区，折叠态只保留 +N
                more_rect = QRect(int(title_left0), int(cy) - chip_h // 2,
                                  int(more_w), chip_h)

        # 标题可用宽：到右侧第一项（胶囊或省略）左侧；最小 100
        right_bound = right_edge
        if laid_capsules:
            right_bound = min(right_bound, laid_capsules[0][4].left() - gap)
        if more_rect is not None:
            right_bound = min(right_bound, more_rect.left() - gap)
        title_available = max(_MIN_TITLE_WIDTH, right_bound - title_left0)
        title_rect = QRect(title_left0, rect.y(), title_available, rect.height())

        # 可视胶囊拆回两种输出结构（带精确几何，paint/命中直接消费）
        right_items = [(_ic, _txt, _color, _r) for (_k, _ic, _txt, _color, _r) in laid_capsules
                       if _k == "right"]
        tag_rects = [(_txt, _color, r)
                     for (_k, _ic, _txt, _color, r) in laid_capsules if _k == "tag"]

        # 悬浮动作按钮（v0.17：仅 hover 浮出；布局右侧已让位，按钮绘制于行最右缘）
        add_rect = edit_rect = del_rect = focus_rect = None
        if actions_visible:
            del_rect = QRect(right_edge_raw - btn_w, int(cy) - btn_h // 2, btn_w, btn_h)
            edit_rect = QRect(del_rect.left() - sep - btn_w, int(cy) - btn_h // 2, btn_w, btn_h)
            add_rect = QRect(edit_rect.left() - sep - btn_w, int(cy) - btn_h // 2, btn_w, btn_h)
            focus_rect = QRect(add_rect.left() - sep - btn_w, int(cy) - btn_h // 2, btn_w, btn_h)

        return {
            "depth": depth,
            "circle": circle,
            "prio": prio_rect,
            "tag_rects": tag_rects,
            "right_items": right_items,
            "title_rect": title_rect,
            "more_rect": more_rect,
            "more_texts": [txt for (_k, _ic, txt, _color) in hidden_specs],
            "folded_count": folded,
            "add": add_rect,
            "edit": edit_rect,
            "del": del_rect,
            "focus": focus_rect,
            "right_chips_left": (laid_capsules[0][4].left() if laid_capsules
                                 else (more_rect.left() if more_rect is not None else right_edge)),
            "chip_font": chip_font,
            "chip_fm": chip_fm,
            "title_font": title_font,
            "chip_h": chip_h,
            "chip_pad": chip_pad,
            "btn_h": btn_h,
            "pill_h": pill_h,
        }

    # ---------- 绘制 ----------
    def paint(self, p: QPainter, option, index):
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        p.save()
        p.setRenderHint(QPainter.Antialiasing)
        rect = option.rect

        checked = bool(index.data(RoleChecked))
        title = index.data(Qt.DisplayRole) or ""
        tid = index.data(RoleTaskId)

        # 勾选态切换 → 启动划线/弹簧动效（9a/9b）
        if tid is not None:
            prev = self._checked_state.get(tid)
            if prev is not None and bool(prev) != bool(checked):
                self._start_toggle_anim(tid, bool(checked))
            self._checked_state[tid] = bool(checked)

        # 子任务展开 stagger（9c）：reveal < 1 时整行淡入
        reveal = self._reveal.get(tid, 1.0) if tid is not None else 1.0
        if reveal < 1.0:
            p.setOpacity(max(0.0, min(1.0, reveal)))

        dpr = 1.0
        if option.widget is not None:
            try:
                dpr = option.widget.devicePixelRatioF()
            except Exception:
                dpr = 1.0

        # 选中/悬浮底色：圆角蒙版（选中优先于悬浮）
        selected = option.state & QStyle.State_Selected
        hovered = option.state & QStyle.State_MouseOver
        if selected or hovered:
            mask = rect.adjusted(4, 2, -4, -2)
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(t.get("accent_soft", "#D9F2EE") if selected
                              else t.get("hover", "#F5F5F5")))
            p.drawRoundedRect(mask, 8, 8)

        fg = t.get("fg", "#1A1A1A")
        fg2 = t.get("fg2", "#6B7280")
        accent = t.get("accent", "#0D9488")
        danger = t.get("danger", "#DC2626")

        # v0.17：布局恒定——标题/胶囊几何非 hover 时占满行宽（按钮不占位）；
        # 仅实际悬浮（hovered）时让位并浮出按钮，避免覆盖胶囊/误触。
        lay = self._layout(option, index, actions_visible=hovered and bool(self.show_actions))

        # 层级虚线引导线（depth>0 的缩进列 + 水平连到当前行）
        if lay["depth"] > 0:
            guide = QColor(fg2)
            guide.setAlpha(110)
            guide_pen = QPen(guide, 1, Qt.DashLine)
            p.setPen(guide_pen)
            cy = rect.center().y()
            for lvl in range(lay["depth"]):
                col_x = rect.x() + 10 + lvl * self.indent + 9
                p.drawLine(QPointF(col_x, rect.y()), QPointF(col_x, rect.bottom()))
            anchor_x = rect.x() + 10 + (lay["depth"] - 1) * self.indent + 9
            p.drawLine(QPointF(anchor_x, cy), QPointF(lay["circle"].left(), cy))

        # 勾选圆圈
        circle = lay["circle"]
        status = index.data(RoleStatus) if hasattr(index, "data") else None
        waiting = status == TaskStatus.WAITING.value if status is not None else False
        pen = QPen(QColor(accent if checked else fg2), 1.6)
        p.setPen(pen)
        p.setBrush(QColor(accent) if checked else Qt.NoBrush)
        p.drawEllipse(circle)
        if waiting and not checked:
            # v0.15 P2-8: 等待中 = 暂停符号（两条竖线），非完成勾选
            d = circle.width()
            p.setPen(QPen(QColor(t.get("accent_warm", "#EA580C") or fg2), max(1.4, d / 12.0),
                          Qt.SolidLine, Qt.RoundCap))
            for fx in (0.38, 0.62):
                p.drawLine(QPointF(circle.x() + d * fx, circle.y() + d * 0.28),
                           QPointF(circle.x() + d * fx, circle.y() + d * 0.72))
            p.setPen(pen)
        # 勾选弹簧（9b）：勾路径按进度缩放 + 淡入，OutBack 回弹
        check_prog = self._check_progress.get(tid, 1.0 if checked else 0.0)
        if checked and check_prog > 0.0:
            d = circle.width()
            scale = max(0.0, check_prog)
            p.save()
            p.translate(circle.center())
            p.scale(scale, scale)
            p.translate(-circle.center())
            p.setOpacity(min(1.0, check_prog))
            path = QPainterPath(QPointF(circle.x() + d * 0.25, circle.y() + d * 0.5278))
            path.lineTo(QPointF(circle.x() + d * 0.4444, circle.y() + d * 0.7222))
            path.lineTo(QPointF(circle.x() + d * 0.75, circle.y() + d * 0.3056))
            p.setPen(QPen(QColor("#FFFFFF"), max(1.5, d / 9.0)))
            p.drawPath(path)
            p.restore()

        # 优先级旗子（v0.17：task.flag SVG + 8 档色阶，无文字；点击旗子改优先级）
        if lay["prio"] is not None:
            pc = priority_color(int(index.data(RolePriority) or 0))
            prio_sz = max(12, lay["prio"].height() - 4)
            pm = icons.pixmap("task.flag", pc, prio_sz, dpr)
            p.drawPixmap(QRect(lay["prio"].center().x() - prio_sz // 2,
                               lay["prio"].center().y() - prio_sz // 2,
                               prio_sz, prio_sz), pm)

        # 标题（完成划线改为 200ms 进度线，替代静态 setStrikeOut）
        title_font = QFont(lay["title_font"])
        p.setFont(title_font)
        p.setPen(QColor(fg2 if checked else fg))
        elided = p.fontMetrics().elidedText(title, Qt.ElideRight, lay["title_rect"].width())
        p.drawText(lay["title_rect"], Qt.AlignVCenter | Qt.AlignLeft, elided)
        strike_prog = self._strike_progress.get(tid, 1.0 if checked else 0.0)
        if strike_prog > 0.0:
            line_w = p.fontMetrics().horizontalAdvance(elided) * max(0.0, min(1.0, strike_prog))
            line_y = lay["title_rect"].center().y()
            p.setPen(QPen(QColor(fg2), 1.2))
            p.drawLine(QPointF(lay["title_rect"].left(), line_y),
                       QPointF(lay["title_rect"].left() + line_w, line_y))

        # 标签 chip（软底彩色圆角，始终绘制）
        p.setFont(lay["chip_font"])
        for _txt, color, chip_rect in lay["tag_rects"]:
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(_soften(color, t)))
            p.drawRoundedRect(chip_rect, 10, 10)
            p.setPen(QColor(color))
            p.drawText(chip_rect, Qt.AlignCenter, _txt)

        # 右侧信息 chips（日期/循环/streak/笔记；带 SVG 图标）——几何取自 _layout（精确一致）
        icon_gap = 3
        p.setFont(lay["chip_font"])
        for icon_name, text, color, chip_rect in lay["right_items"]:
            icon_sz = max(8, lay["chip_h"] - 6) if icon_name else 0
            text_w = lay["chip_fm"].horizontalAdvance(text) if text else 0
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(_soften(color, t)))
            p.drawRoundedRect(chip_rect, 10, 10)
            p.setPen(QColor(color))
            content_x = chip_rect.left() + 6
            if icon_name:
                pm = icons.pixmap(icon_name, color, icon_sz, dpr)
                p.drawPixmap(QRect(int(content_x), int(chip_rect.center().y() - icon_sz / 2),
                                   icon_sz, icon_sz), pm)
                content_x += icon_sz + icon_gap
            p.drawText(QRect(int(content_x), chip_rect.y(), int(text_w), chip_rect.height()),
                       Qt.AlignVCenter | Qt.AlignLeft, text)

        # 「+N」省略胶囊（v0.17：行右侧放不下时折叠；hover 展开见 editorEvent/helpEvent）
        if lay["more_rect"] is not None:
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(_soften(fg2, t)))
            p.drawRoundedRect(lay["more_rect"], 10, 10)
            p.setPen(QColor(fg2))
            p.drawText(lay["more_rect"], Qt.AlignCenter, f"+{lay['folded_count']}")

        # 悬浮动作按钮（v0.17：不占位，仅悬浮时浮出叠在行右缘 chips 之上；图标化）
        if self.show_actions and hovered:
            mouse = self._mouse_pos(option)
            border = t.get("border2", t.get("border", "#E5E5E5"))
            layer = t.get("layer", "#FFFFFF")
            accent_soft = t.get("accent_soft", "#D9F2EE")
            for btn_rect, tone, icon_name in (
                    (lay["focus"], "accent", "pomo.play"),
                    (lay["add"], "accent", "action.add"),
                    (lay["edit"], "accent", "action.edit"),
                    (lay["del"], "danger", "data.trash")):
                if btn_rect is None:
                    continue
                btn_hover = mouse is not None and btn_rect.contains(mouse)
                p.setPen(QPen(QColor(border), 1))
                p.setBrush(QColor(accent_soft if btn_hover else layer))
                p.drawRoundedRect(btn_rect, 6, 6)
                p.setPen(QColor(t.get(tone, "#0D9488")))
                icon_sz = max(10, lay["btn_h"] - 8)
                pm = icons.pixmap(icon_name, t.get(tone, "#0D9488"), icon_sz, dpr)
                p.drawPixmap(QRect(btn_rect.center().x() - icon_sz // 2,
                                   btn_rect.center().y() - icon_sz // 2,
                                   icon_sz, icon_sz), pm)

        p.restore()

    # ---------- 交互 ----------
    # ---------- 命中区扩展（T8：行内胶囊/按钮垂直命中 ≥32px，水平不扩防误触） ----------
    @staticmethod
    def _hit_rect(rect: QRect, row: QRect, min_h: int = 32) -> QRect:
        """把行内小交互矩形（视觉 14-20px）的命中区垂直扩展到 ≥min_h，中心对齐、不越出行。"""
        if rect is None:
            return rect
        if rect.height() >= min_h:
            return rect
        grow = (min_h - rect.height()) // 2
        y0 = max(row.y(), rect.y() - grow)
        y1 = min(row.bottom() + 1, rect.bottom() + 1 + grow)
        if y1 - y0 < min_h:      # 越界兜底：贴行内上下缘
            y1 = min(row.bottom() + 1, y0 + min_h)
        return QRect(rect.x(), y0, rect.width(), y1 - y0)

    def editorEvent(self, event, model, option, index) -> bool:
        from PySide6.QtCore import QEvent
        if self.inline_edit and event.type() == QEvent.MouseButtonDblClick:
            tid = index.data(RoleTaskId)
            if tid is None:
                return super().editorEvent(event, model, option, index)
            pos = event.position().toPoint() if hasattr(event, "position") else event.pos()
            lay = self._layout(option, index, actions_visible=False)
            if lay["title_rect"].contains(pos):
                self._cancel_pending_click()
                self._last_action = time.monotonic()
                self.titleEditRequested.emit(tid)
                return True
            return super().editorEvent(event, model, option, index)

        # v0.17.1：记录按下位置与是否悬浮（release 常缺 MouseOver，不能依赖 state）。
        # 按下与释放都在行内（未明显移动）才按「悬浮按钮/胶囊」处理；否则按标题点击兜底。
        if event.type() == QEvent.MouseButtonPress:
            self._press_pos = None
            mouse = self._mouse_pos(option)
            if mouse is not None and option.rect.adjusted(4, 2, -4, -2).contains(mouse):
                self._press_pos = mouse
            return super().editorEvent(event, model, option, index)

        if event.type() == QEvent.MouseButtonRelease:
            now = time.monotonic()
            if now - self._last_action < 0.35:      # 双击第二拍：丢弃，防 toggle/open 双发
                self._last_action = now
                return True
            self._last_action = now

            tid = index.data(RoleTaskId)
            if tid is None:
                return False
            pos = event.position().toPoint() if hasattr(event, "position") else event.pos()
            row = option.rect
            HIT = lambda r: self._hit_rect(r, row)  # noqa: E731 T8

            # 悬浮判定：优先用 press 时记录的行内位置（真机可靠）；无 press 记录
            # （测试直接注入 release）回退到 option.state MouseOver 或光标落行内。
            press = getattr(self, "_press_pos", None)
            use_buttons = bool(self.show_actions) and (
                press is not None or bool(option.state & QStyle.State_MouseOver))
            if not use_buttons:
                mouse = self._mouse_pos(option)
                if mouse is not None and row.adjusted(4, 2, -4, -2).contains(mouse):
                    use_buttons = True
            lay = self._layout(option, index, actions_visible=use_buttons)

            if HIT(lay["circle"]).contains(pos):
                self.toggleRequested.emit(tid)
                return True
            if use_buttons:
                for btn_rect, kind in (
                        (lay["del"], "del"), (lay["edit"], "edit"),
                        (lay["add"], "add"), (lay["focus"], "focus")):
                    if btn_rect is not None and HIT(btn_rect).contains(pos):
                        if kind == "del":
                            self.deleteRequested.emit(tid)
                        elif kind == "edit":
                            self.openRequested.emit(tid)
                        elif kind == "add":
                            self.addSubtaskRequested.emit(tid)
                        else:
                            self.focusRequested.emit(tid)
                        return True
            if self.show_actions:
                # 快捷编辑命中仅在有行内动作的视图生效；旧视图点击徽标/chip 保持「打开」语义
                if lay["prio"] is not None and HIT(lay["prio"]).contains(pos):
                    self.editPriorityRequested.emit(tid)
                    return True
                for _txt, _color, chip_rect in lay["tag_rects"]:
                    if HIT(chip_rect).contains(pos):
                        self.editTagsRequested.emit(tid)
                        return True

            # 标题区：有子任务 → 折叠/展开；叶子任务 → 交还视图默认选中
            if self.show_actions:
                if model.rowCount(index) > 0:
                    self._schedule_or_emit_click(("expand", tid))
                    return True
                return False
            # 无悬浮按钮的旧视图（收件箱）保持「点击标题打开」语义
            self._schedule_or_emit_click(("open", tid))
            return True
        return super().editorEvent(event, model, option, index)

    # ---------- 单击动作：内联编辑模式下延时，双击可取消 ----------
    def _schedule_or_emit_click(self, action):
        if not self.inline_edit:
            self._flush_click_now(action)
            return
        self._cancel_pending_click()
        self._pending_click = action
        self._click_timer = QTimer(self)
        self._click_timer.setSingleShot(True)
        self._click_timer.setInterval(350)
        self._click_timer.timeout.connect(self._flush_pending_click)
        self._click_timer.start()

    def _cancel_pending_click(self):
        if self._click_timer is not None:
            self._click_timer.stop()
            self._click_timer.deleteLater()
            self._click_timer = None
        self._pending_click = None

    def _flush_pending_click(self):
        pending = self._pending_click
        self._pending_click = None
        if self._click_timer is not None:
            self._click_timer.deleteLater()
            self._click_timer = None
        if pending is not None:
            self._flush_click_now(pending)

    def _flush_click_now(self, action):
        kind, tid = action
        if kind == "expand":
            self.toggleExpandRequested.emit(tid)
        elif kind == "open":
            self.openRequested.emit(tid)

    # ---------- 动效（9a/9b/9c，复用 motion.py 工厂） ----------
    def set_reveal(self, task_id, value):
        """子任务展开 stagger：设置某行 reveal 进度并触发重绘。"""
        self._reveal[task_id] = value
        self._request_repaint()

    def clear_reveal(self):
        """reload 后清空 reveal 残留，避免动画中断导致子任务透明空白。"""
        self._reveal.clear()

    def _request_repaint(self):
        try:
            w = self.parent()
            vp = getattr(w, "viewport", None)
            if vp is not None:
                vp.update()
        except Exception:
            pass

    def _start_toggle_anim(self, task_id, checked):
        from ..kit import motion
        target = 1.0 if checked else 0.0
        self._strike_progress[task_id] = 0.0 if checked else 1.0
        self._check_progress[task_id] = 0.0 if checked else 1.0
        anims = []
        a = motion.strike_through(
            reverse=not checked,
            on_update=lambda v, k=task_id: self._set_progress("strike", k, v),
            on_done=lambda k=task_id, tv=target: self._set_progress("strike", k, tv))
        b = motion.spring_check(
            reverse=not checked,
            on_update=lambda v, k=task_id: self._set_progress("check", k, v),
            on_done=lambda k=task_id, tv=target: self._set_progress("check", k, tv))
        if a is not None:
            anims.append(a)
        if b is not None:
            anims.append(b)
        if anims:
            self._anims[task_id] = anims

    def _set_progress(self, kind, task_id, value):
        d = self._strike_progress if kind == "strike" else self._check_progress
        d[task_id] = value
        self._request_repaint()


def _soften(color: str, tokens: dict) -> str:
    c = QColor(color)
    canvas = QColor(tokens.get("canvas", "#FFFFFF"))
    dark = canvas.lightness() < 128        # 按画布明暗判主题，替代易碎的字符串前缀猜测
    base = QColor(tokens.get("layer", "#FFFFFF"))
    f = 0.14 if not dark else 0.3
    return QColor(int(c.red() * f + base.red() * (1 - f)),
                  int(c.green() * f + base.green() * (1 - f)),
                  int(c.blue() * f + base.blue() * (1 - f))).name()
