# -*- coding: utf-8 -*-
"""笔记树（文件夹 → 笔记）：模型 + 搜索代理 + 悬浮操作 delegate。

把原「文件夹树 + 笔记列表」两栏合并为单棵 QTreeView：
- 顶层「全部笔记」虚拟节点聚合所有笔记（保持旧的默认全量视图）；
- 真实文件夹可嵌套，笔记作为其子节点；
- 搜索框经 NoteTreeFilterProxy 过滤整棵树（命中笔记时保留其文件夹祖先）；
- 笔记行悬浮时在右侧绘制「重命名 / 置顶 / 删除」胶囊按钮，命中经信号外发。
"""
from PySide6.QtCore import (
    QAbstractItemModel, QModelIndex, QRect, QSize, QSortFilterProxyModel, Qt, Signal,
)
from PySide6.QtGui import QColor, QCursor, QFont, QFontMetrics, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QAbstractItemView, QStyle, QStyledItemDelegate, QStyleOptionViewItem

from qfluent_core import ThemeManager as ThemeEngine

# 自定义角色
NoteRoleKind = Qt.UserRole + 40      # "all" | "folder" | "note"
NoteRoleId = Qt.UserRole + 41        # 笔记 id 或文件夹 id
NoteRoleTitle = Qt.UserRole + 42
NoteRolePinned = Qt.UserRole + 43
NoteRoleSnippet = Qt.UserRole + 44   # 内容摘录（搜索/悬浮提示）
NoteRoleFolderId = Qt.UserRole + 45
NoteRoleFormat = Qt.UserRole + 46   # v0.17.1：笔记格式 markdown/richtext/word/excel/link

KIND_ALL = "all"
KIND_FOLDER = "folder"
KIND_NOTE = "note"


def _note_sort_key(n):
    updated = n.updated_at.timestamp() if getattr(n, "updated_at", None) else 0.0
    return (not bool(getattr(n, "pinned", False)), -updated, (n.title or ""))


class _NoteNode:
    __slots__ = ("kind", "title", "note", "folder_id", "parent", "children")

    def __init__(self, kind, title="", note=None, folder_id=None, parent=None):
        self.kind = kind
        self.title = title
        self.note = note            # Note（仅 kind == note）
        self.folder_id = folder_id  # 文件夹 id（仅 kind == folder）
        self.parent = parent
        self.children = []


class NoteTreeModel(QAbstractItemModel):
    """文件夹/笔记混合树：文件夹为父节点，笔记为子节点。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._roots = []
        self._by_note = {}
        self._by_folder = {}

    # ---------- 装载 ----------
    def reload(self, folders=None, notes=None):
        self.beginResetModel()
        try:
            self._roots = []
            self._by_note = {}
            self._by_folder = {}

            notes = sorted((notes or []), key=_note_sort_key)
            by_parent = {}
            for f in (folders or []):
                by_parent.setdefault(getattr(f, "parent_id", None), []).append(f)
            for v in by_parent.values():
                v.sort(key=lambda x: (getattr(x, "sort", 0.0) or 0.0, getattr(x, "id", 0) or 0))
            notes_by_folder = {}
            unassigned = []
            for n in notes:
                if getattr(n, "folder_id", None) is not None:
                    notes_by_folder.setdefault(n.folder_id, []).append(n)
                else:
                    unassigned.append(n)

            # 顶层「全部笔记」只是未归属（folder_id=None）笔记的普通列表，
            # 不再强制聚合其他文件夹下的笔记。
            all_node = _NoteNode(KIND_ALL, "全部笔记")
            for n in unassigned:
                child = _NoteNode(KIND_NOTE, n.title, note=n, parent=all_node)
                all_node.children.append(child)
                self._by_note[n.id] = child
            self._roots.append(all_node)

            def build(parent_id, parent_node):
                for f in by_parent.get(parent_id, []):
                    node = _NoteNode(KIND_FOLDER, f.name, folder_id=f.id, parent=parent_node)
                    self._by_folder[f.id] = node
                    if parent_node is not None:
                        parent_node.children.append(node)
                    else:
                        self._roots.append(node)
                    build(f.id, node)
                    for n in notes_by_folder.get(f.id, []):
                        cn = _NoteNode(KIND_NOTE, n.title, note=n, parent=node)
                        node.children.append(cn)
                        self._by_note[n.id] = cn

            build(None, None)
        finally:
            self.endResetModel()

    # ---------- 定位 ----------
    def index_of_note(self, note_id):
        return self._index_of(self._by_note.get(note_id))

    def index_of_folder(self, folder_id):
        return self._index_of(self._by_folder.get(folder_id))

    def note_at(self, note_id):
        node = self._by_note.get(note_id)
        return node.note if node is not None else None

    def _index_of(self, node):
        if node is None:
            return QModelIndex()
        if node.parent is None:
            try:
                row = self._roots.index(node)
            except ValueError:
                return QModelIndex()
        else:
            try:
                row = node.parent.children.index(node)
            except ValueError:
                return QModelIndex()
        return self.createIndex(row, 0, node)

    # ---------- Qt 协议 ----------
    def rowCount(self, parent=QModelIndex()):
        if not parent.isValid():
            return len(self._roots)
        node = parent.internalPointer()
        return len(node.children)

    def columnCount(self, parent=QModelIndex()):
        return 1

    def index(self, row, col, parent=QModelIndex()):
        if not parent.isValid():
            if 0 <= row < len(self._roots):
                return self.createIndex(row, col, self._roots[row])
            return QModelIndex()
        node = parent.internalPointer()
        if 0 <= row < len(node.children):
            return self.createIndex(row, col, node.children[row])
        return QModelIndex()

    def parent(self, index):
        if not index.isValid():
            return QModelIndex()
        node = index.internalPointer()
        if node.parent is None:
            return QModelIndex()
        sibs = node.parent.children
        try:
            row = sibs.index(node)
        except ValueError:
            return QModelIndex()
        return self.createIndex(row, 0, node.parent)

    def data(self, index, role=Qt.DisplayRole):
        if not index.isValid():
            return None
        node = index.internalPointer()
        if role in (Qt.DisplayRole, NoteRoleTitle):
            return node.title
        if role == NoteRoleKind:
            return node.kind
        if role == NoteRoleId:
            if node.note is not None:
                return node.note.id
            return node.folder_id
        if role == NoteRolePinned:
            return bool(node.note.pinned) if node.note is not None else False
        if role == NoteRoleFormat:
            if node.note is not None:
                return getattr(node.note, "format", None) or "markdown"
            return ""
        if role == NoteRoleSnippet:
            if node.note is not None:
                return (node.note.content_md or "").strip().replace("\n", " ")[:160]
            return ""
        if role == NoteRoleFolderId:
            if node.note is not None:
                return node.note.folder_id
            return node.folder_id
        if role == Qt.ToolTipRole:
            if node.note is not None:
                return (node.note.content_md or "").strip()[:200] or node.title
            return node.title
        return None

    def flags(self, index):
        return Qt.ItemIsEnabled | Qt.ItemIsSelectable


class NoteTreeFilterProxy(QSortFilterProxyModel):
    """按标题过滤笔记；有命中子孙的文件夹节点保留（树形过滤）。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._text = ""

    def set_text(self, text):
        self._text = (text or "").strip().lower()
        self.invalidateFilter()

    def filterAcceptsRow(self, source_row, source_parent):
        model = self.sourceModel()
        idx = model.index(source_row, 0, source_parent)
        if not idx.isValid():
            return False
        kind = idx.data(NoteRoleKind)
        if kind == KIND_NOTE:
            if not self._text:
                return True
            return self._text in (idx.data(NoteRoleTitle) or "").lower()
        if not self._text:
            return True
        # 文件夹 / 全部：任一子孙命中即保留
        for r in range(model.rowCount(idx)):
            if self.filterAcceptsRow(r, idx):
                return True
        return False


class NoteTreeDelegate(QStyledItemDelegate):
    """笔记树行 delegate：文件夹 chevron + 笔记标题 + 悬浮胶囊操作。

    命中优先级：删除 / 置顶 / 重命名按钮 → 其余标题区交还视图（选中/折叠展开）。
    """

    deleteRequested = Signal(int)        # 删除笔记（软删）
    togglePinRequested = Signal(int)     # 置顶/取消置顶
    renameRequested = Signal(int)        # 重命名笔记
    addFolderRequested = Signal(object)  # 新建文件夹：parent folder_id（None=顶级）
    addNoteRequested = Signal(object)    # 新建笔记：folder_id（None=全部笔记）
    renameFolderRequested = Signal(int)  # 重命名文件夹
    deleteFolderRequested = Signal(int)  # 删除文件夹

    def __init__(self, parent=None, row_height=34, indent=18):
        super().__init__(parent)
        self.row_height = row_height
        self.indent = indent
        # v0.16 P2-b: chevron 旋转动画状态（folder_id -> 0收起..1展开）
        self._view = parent if isinstance(parent, QAbstractItemView) else None
        self._chev = {}
        self._chev_anim = None

    def attach_view(self, view):
        self._view = view

    def animate_chevron(self, folder_id, expanded: bool):
        """展开/折叠时平滑旋转 chevron（120ms；reduce-motion 时瞬时置位）。"""
        from .kit import motion
        target = 1.0 if expanded else 0.0
        if not motion.motion_enabled():
            self._chev.pop(folder_id, None)
            return
        if self._chev_anim is not None:
            try:
                self._chev_anim.stop()
            except Exception:
                pass
        start = self._chev.get(folder_id, 1.0 if expanded else 0.0)

        def _step(v):
            self._chev[folder_id] = float(v)
            if self._view is not None:
                self._view.viewport().update()
        self._chev_anim = motion.animate_value(start, target, dur="fast",
                                               easing="standard",
                                               on_update=_step,
                                               on_done=lambda: self._chev.pop(folder_id, None))

    def sizeHint(self, option, index):
        return QSize(option.rect.width(), self.row_height)

    # ---------- 工具 ----------
    def _small_font(self, option, s=1.0):
        f = QFont(option.font)
        f.setPixelSize(max(9, int(round(11 * s))))
        return f

    def _depth(self, index):
        depth = 0
        parent = index.parent()
        while parent.isValid():
            depth += 1
            parent = parent.parent()
        return depth

    def _mouse_pos(self, option):
        try:
            w = option.widget
            if w is not None:
                return w.mapFromGlobal(QCursor.pos())
        except Exception:
            return None
        return None

    # ---------- 几何（paint 与 editorEvent 共用） ----------
    def _layout(self, option, index, actions_visible=True):
        rect = option.rect
        depth = self._depth(index)
        x = rect.x() + 8 + depth * self.indent
        cy = rect.center().y()
        kind = index.data(NoteRoleKind)

        s = max(0.7, min(1.4, self.row_height / 34.0))
        small_font = self._small_font(option, s)
        fm = QFontMetrics(small_font)
        btn_h = max(14, int(round(20 * s)))

        del_rect = pin_rect = rename_rect = add_rect = note_rect = None
        # 悬浮操作按钮：胶囊形态（对齐任务行标签 chip 的做法 —— 软底 + 圆角 +
        # 图标 + 文字）。胶囊宽由「图标 + 文字 + 内边距」决定，高度随行高自适应；
        # 图标尺寸同样随行高缩放并有下限，保证小行高下仍清晰可辨。
        # 只显示图标：胶囊边长 = 高度（正方形即圆形胶囊），随行高自适应。
        # 尺寸对齐任务行按钮（btn_h = round(20*s)），避免比任务行大一圈。
        cap_h = max(16, int(round(20 * s)))
        # 图标尺寸 = 高度 - 8（与任务行同公式）；dpr 超采样保证小尺寸仍清晰。
        icon_sz = max(11, cap_h - 8)
        cap_w = cap_h                                    # 正方形胶囊
        gap = 4                                          # 胶囊之间的间距
        top = int(cy) - cap_h // 2

        def _cap_w(_text: str = "") -> int:
            """只显示图标 -> 胶囊恒为正方形（宽 = 高）。"""
            return cap_w

        def _place(specs):
            """从右缘向左排布胶囊序列，返回 {key: QRect} 与最左缘。"""
            out = {}
            right = rect.right() - 6
            for key, text in specs:
                w = _cap_w(text)
                out[key] = QRect(right - w, top, w, cap_h)
                right -= (w + gap)
            return out, right + gap

        if kind == KIND_NOTE and actions_visible:
            placed, right_limit = _place([("del", ""), ("pin", ""), ("rename", "")])
            del_rect, pin_rect, rename_rect = placed["del"], placed["pin"], placed["rename"]
        elif kind == KIND_FOLDER and actions_visible:
            placed, right_limit = _place([("del", ""), ("rename", ""),
                                          ("add", ""), ("note", "")])
            (del_rect, rename_rect, add_rect, note_rect) = (
                placed["del"], placed["rename"], placed["add"], placed["note"])
        elif kind == KIND_ALL and actions_visible:
            placed, right_limit = _place([("add", ""), ("note", "")])
            add_rect, note_rect = placed["add"], placed["note"]
        else:
            right_limit = rect.right() - 8

        chevron = None
        if kind in (KIND_FOLDER, KIND_ALL):
            chevron = QRect(int(x), int(cy) - 8, 16, 16)

        return {
            "kind": kind,
            "depth": depth,
            "x": x,
            "right_limit": right_limit,
            "chevron": chevron,
            "del": del_rect,
            "pin": pin_rect,
            "rename": rename_rect,
            "add": add_rect,
            "note": note_rect,
            "pinned": bool(index.data(NoteRolePinned)),
            "small_font": small_font,
        }

    # ---------- 绘制 ----------
    def paint(self, p, option, index):
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        p.save()
        p.setRenderHint(QPainter.Antialiasing)
        # 高 DPI：图标须按物理像素渲染（与任务项 delegate 同做法），
        # 否则 Retina 下 1x 位图被放大导致发虚。
        dpr = 1.0
        if option.widget is not None:
            try:
                dpr = option.widget.devicePixelRatioF()
            except Exception:  # noqa: BLE001
                dpr = 1.0
        rect = option.rect
        kind = index.data(NoteRoleKind)
        selected = option.state & QStyle.State_Selected
        hovered = option.state & QStyle.State_MouseOver

        if selected or hovered:
            mask = rect.adjusted(3, 2, -3, -2)
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(t.get("accent_soft", "#D9F2EE") if selected
                              else t.get("hover", "#F5F5F5")))
            p.drawRoundedRect(mask, 8, 8)

        fg = t.get("fg", "#1A1A1A")
        fg2 = t.get("fg2", "#6B7280")
        accent = t.get("accent", "#0D9488")

        lay = self._layout(option, index, actions_visible=hovered)
        title = str(index.data(NoteRoleTitle) or "")

        if kind in (KIND_FOLDER, KIND_ALL):
            # 文件夹：chevron（有可见子节点时）+ 加粗名称
            has_children = index.model().rowCount(index) > 0
            if lay["chevron"] is not None and has_children:
                expanded = bool(option.state & QStyle.State_Open)
                fid = index.data(NoteRoleId)
                _prog = self._chev.get(fid)   # 动画进度 0..1（不覆盖 t=tokens）
                angle = 90.0 if (_prog is None and expanded) else \
                    (0.0 if _prog is None else 90.0 * max(0.0, min(1.0, _prog)))
                self._draw_chevron(p, lay["chevron"], angle, fg2)
            f = QFont(option.font)
            f.setBold(True)
            p.setFont(f)
            p.setPen(QColor(fg))
            name_x = lay["x"] + 16
            name_rect = QRect(name_x, rect.y(), max(20, lay["right_limit"] - name_x - 4), rect.height())
            p.drawText(name_rect, Qt.AlignVCenter | Qt.AlignLeft,
                       p.fontMetrics().elidedText(title, Qt.ElideRight, name_rect.width()))
            if hovered:
                self._paint_folder_buttons(p, lay, t, self._mouse_pos(option), dpr)
        else:
            # 与文件夹对齐：笔记虽无 chevron，但同样留出 16px 占位，
            # 保证同一层级的文件夹名称与笔记标题起点一致（缩进严谨）。
            tx = lay["x"] + 16
            if lay["pinned"]:
                # 置顶标记：强调色小竖条（不依赖 emoji 字体）
                bar_h = max(12, self.row_height * 2 // 5)
                bar = QRect(tx, rect.center().y() - bar_h // 2, 3, bar_h)
                p.setPen(Qt.NoPen)
                p.setBrush(QColor(accent))
                p.drawRoundedRect(bar, 1.5, 1.5)
                tx += 8
            # v0.17.1 第3项：笔记行标题前加类型小图标（markdown/富文本用书本、
            # 链接用 link.link；muted fg2，hover 不占按钮位）
            fmt_icon = index.data(NoteRoleFormat) if kind == KIND_NOTE else ""
            if fmt_icon:
                icon_name = {"link": "link.link",
                             "word": "nav.notes", "excel": "nav.notes",
                             "richtext": "nav.notes", "markdown": "nav.notes"}.get(
                                 fmt_icon, "nav.notes")
                from .kit import icons as _ik
                fsz = 14
                pm = _ik.pixmap(icon_name, fg2, fsz)
                p.drawPixmap(int(tx), int(rect.center().y() - fsz / 2), pm)
                tx += fsz + 5
            p.setFont(QFont(option.font))
            p.setPen(QColor(fg))
            title_rect = QRect(tx, rect.y(), max(20, lay["right_limit"] - tx - 4), rect.height())
            p.drawText(title_rect, Qt.AlignVCenter | Qt.AlignLeft,
                       p.fontMetrics().elidedText(title, Qt.ElideRight, title_rect.width()))

            if kind == KIND_NOTE and hovered:
                self._paint_buttons(p, lay, t, self._mouse_pos(option), dpr)

        p.restore()

    def _draw_chevron(self, p, rect, angle_deg: float, color):
        """绘制 chevron 三角：0°=朝右（收起）、90°=朝下（展开），中间角度平滑旋转。"""
        p.save()
        p.setRenderHint(QPainter.Antialiasing)
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(color))
        cx, cy = rect.center().x(), rect.center().y()
        p.translate(cx, cy)
        p.rotate(angle_deg)
        path = QPainterPath()
        path.moveTo(4, 0)
        path.lineTo(-3, -4)
        path.lineTo(-3, 4)
        path.closeSubpath()
        p.drawPath(path)
        p.restore()

    def _paint_buttons(self, p, lay, t, mouse, dpr: float = 1.0):
        """笔记行悬浮图标按钮（v0.17.1 对齐任务行）：重命名/置顶/删除 均为 SVG 图标。"""
        border = t.get("border2", t.get("border", "#E5E5E5"))
        layer = t.get("layer", "#FFFFFF")
        accent_soft = t.get("accent_soft", "#D9F2EE")
        pin_label = "取消置顶" if lay["pinned"] else "置顶"
        chip_font = lay.get("chip_font")
        for rect, icon_name, tone, tip, text in (
                (lay["rename"], "action.edit", "accent", "重命名", "重命名"),
                (lay["pin"], "win.pin", "accent", pin_label, pin_label),
                (lay["del"], "data.trash", "danger", "删除", "删除")):
            if rect is None:
                continue
            self._paint_icon_button(p, rect, icon_name, tone, tip, mouse, t,
                                    border, layer, accent_soft, label=text,
                                    font=chip_font, dpr=dpr)

    def _paint_folder_buttons(self, p, lay, t, mouse, dpr: float = 1.0):
        """文件夹/全部节点悬浮图标按钮：＋笔记 / ＋文件夹 / 重命名 / 删除。"""
        border = t.get("border2", t.get("border", "#E5E5E5"))
        layer = t.get("layer", "#FFFFFF")
        accent_soft = t.get("accent_soft", "#D9F2EE")
        buttons = []
        if lay["note"] is not None:
            buttons.append((lay["note"], "nav.notes", "accent", "新建笔记", "新建笔记"))
        if lay["add"] is not None:
            buttons.append((lay["add"], "folder.plus", "accent", "新建文件夹", "新建分组"))
        if lay["rename"] is not None:
            buttons.append((lay["rename"], "action.edit", "accent", "重命名", "重命名"))
        if lay["del"] is not None:
            buttons.append((lay["del"], "data.trash", "danger", "删除", "删除"))
        chip_font = lay.get("chip_font")
        for rect, icon_name, tone, tip, text in buttons:
            if rect is None:
                continue
            self._paint_icon_button(p, rect, icon_name, tone, tip, mouse, t,
                                    border, layer, accent_soft, label=text,
                                    font=chip_font, dpr=dpr)

    def _paint_icon_button(self, p, rect, icon_name, tone, tip, mouse, t,
                           border, layer, accent_soft, label: str = "",
                           font=None, dpr: float = 1.0):
        """胶囊按钮绘制（对齐任务行标签 chip：软底 + 圆角 + 图标 + 文字）。

        图标尺寸随胶囊高度自适应并有下限（小行高下仍清晰）；胶囊高随行高缩放，
        宽由「内边距 + 图标 + 间距 + 文字」决定（见 _layout._cap_w）。
        """
        from .kit import icons
        hover = mouse is not None and rect.contains(mouse)
        base_tone = t.get(tone, "#0D9488")
        # 软底：与任务行 chip 一致（非 hover 用强调色淡底，hover 加深）
        bg = QColor(base_tone)
        bg.setAlpha(46 if hover else 28)
        p.setPen(Qt.NoPen)
        p.setBrush(bg)
        p.drawRoundedRect(rect, rect.height() / 2, rect.height() / 2)
        color = base_tone
        # 只显示图标：图标在胶囊内水平/垂直居中。
        # 必须传 devicePixelRatio —— 任务项按钮即如此（icons.pixmap(..., dpr)）。
        # 漏传时 Retina(dpr=2) 下只按 1x 渲染再被系统放大，图标发虚（「不清晰」）。
        sz = max(11, rect.height() - 8)
        pm = icons.pixmap(icon_name, color, sz, dpr)
        # dpr 见调用方（从 option.widget.devicePixelRatioF() 取，与任务项一致）
        p.drawPixmap(QRect(int(rect.center().x() - sz / 2),
                           int(rect.center().y() - sz / 2), sz, sz), pm)
        if tip and hover:
            from PySide6.QtWidgets import QToolTip
            p_ = p  # noqa: F841

    # ---------- 交互 ----------
    def editorEvent(self, event, model, option, index):
        from PySide6.QtCore import QEvent
        if event.type() != QEvent.MouseButtonRelease:
            return super().editorEvent(event, model, option, index)
        kind = index.data(NoteRoleKind)
        pos = event.position().toPoint() if hasattr(event, "position") else event.pos()
        # v0.17.1：悬浮图标按钮仅在「光标确实落在行内」时才参与命中（release 事件
        # 常缺 MouseOver；非悬浮时右侧按钮区不可见，点击应交给视图做行选中）。
        mouse = self._mouse_pos(option)
        row_rect = option.rect.adjusted(2, 0, -2, 0)
        hovered = bool(option.state & QStyle.State_MouseOver)
        if not hovered and mouse is not None:
            hovered = row_rect.contains(mouse)
        lay = self._layout(option, index, actions_visible=hovered)

        def hit(rect):   # T8: 行内按钮垂直命中 ≥32px（中心对齐、不越行、水平不扩）
            if rect is None or rect.height() >= 32:
                return rect
            grow = (32 - rect.height()) // 2
            row = option.rect
            y0 = max(row.y(), rect.y() - grow)
            y1 = min(row.bottom() + 1, rect.bottom() + 1 + grow)
            if y1 - y0 < 32:
                y1 = min(row.bottom() + 1, y0 + 32)
            from PySide6.QtCore import QRect
            return QRect(rect.x(), y0, rect.width(), y1 - y0)

        if not hovered:
            return False   # 非悬浮：整行交还视图（选中/展开）

        if kind == KIND_NOTE:
            note_id = index.data(NoteRoleId)
            if note_id is None:
                return False
            for rect, sig in ((lay["del"], self.deleteRequested),
                              (lay["pin"], self.togglePinRequested),
                              (lay["rename"], self.renameRequested)):
                if rect is not None and hit(rect).contains(pos):
                    sig.emit(note_id)
                    return True
        elif kind == KIND_FOLDER:
            folder_id = index.data(NoteRoleId)
            if folder_id is None:
                return False
            for rect, sig in ((lay["del"], self.deleteFolderRequested),
                              (lay["rename"], self.renameFolderRequested),
                              (lay["add"], self.addFolderRequested),
                              (lay["note"], self.addNoteRequested)):
                if rect is not None and hit(rect).contains(pos):
                    sig.emit(folder_id)
                    return True
        elif kind == KIND_ALL:
            if lay["add"] is not None and hit(lay["add"]).contains(pos):
                self.addFolderRequested.emit(None)
                return True
            if lay["note"] is not None and hit(lay["note"]).contains(pos):
                self.addNoteRequested.emit(None)
                return True
        return False
