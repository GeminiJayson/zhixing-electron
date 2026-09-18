# -*- coding: utf-8 -*-
"""表单类组件：复选框、滑块、下拉选择、多选下拉、日期选择、文件上传。

这些控件都有一个共同点：Qt 原生控件已提供完整交互语义，框架只负责
「主题化外观 + 一致的 API + 状态属性」，不重写交互逻辑。
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence

from PySide6.QtCore import QDate, QMimeData, Qt, Signal, QSize
from PySide6.QtCore import QPointF, QRectF
from PySide6.QtGui import (QColor, QDragEnterEvent, QDropEvent, QPainter,
                           QPaintEvent, QPen, QStandardItem, QStandardItemModel)
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QDateEdit, QFileDialog, QFrame, QHBoxLayout, QLabel,
    QSlider, QToolButton, QVBoxLayout, QWidget,
    QRadioButton, QSpinBox,
)

from .. import icons
from ..settings import UISettings
from ..theme import ThemeManager
from .base import ThemedMixin

__all__ = ["URadioButton", "USpinBox", "UCheckbox", "USlider", "UComboBox", "UMultiComboBox", "UDatePicker",
           "UUpload"]


def style_combo_popup(combo) -> None:
    """给弹出容器 / 视图设控件级样式表，颜色仍取 token。

    为什么不用应用级 QSS：弹出窗口是独立顶层窗口，应用级 QSS 的 objectName
    选择器在它身上的匹配不稳定（实测容器边框始终不是我们设的值），
    所以这里用控件级样式表 —— 它一定生效，且主题变化时由组件的 restyle() 重刷。
    """
    view = combo.view()
    if view is None:
        return
    tokens = combo.theme_tokens()
    container = view.parentWidget()
    if container is not None:
        container.setStyleSheet(
            "#UComboPopup { background: %s; border: 1px solid %s;"
            " border-radius: %s; }" % (
                tokens.get("surface", "#FFFFFF"), tokens.get("border", "#E3E7EB"),
                tokens.get("radius-md", "8px")))
    view.setStyleSheet(
        "#UComboPopupView { background: transparent; border: none;"
        " padding: 4px; outline: 0; }")


def prepare_combo_popup(combo) -> None:
    """给下拉弹出容器一个可预测的 objectName，让 QSS 能稳定命中。

    Qt 的 QComboBoxPrivateContainer 是私有类，用类名做 QSS 选择器不可靠 ——
    实测多选下拉的弹窗就没吃到样式（背景与边框一起丢失，看起来「全透明」）。
    这里统一挂 objectName：容器负责背景与唯一一层边框，视图保持透明。
    """
    view = combo.view()
    if view is None:
        return
    container = view.parentWidget()
    view.setObjectName("UComboPopupView")
    if container is not None:
        container.setObjectName("UComboPopup")
        container.setAttribute(Qt.WA_StyledBackground, True)
    # 改完 objectName 必须 repolish：QSS 是按当时的属性匹配的，
    # 不重算就会一直用「没有 objectName 时」的样式（弹窗表现为无背景/无边框）。
    for widget in (container, view):
        if widget is None:
            continue
        style = widget.style()
        style.unpolish(widget)
        style.polish(widget)
        # 用 repaint()：QListView 重载了 update(QModelIndex)，widget.update() 会报错
        widget.repaint()


class UCheckbox(ThemedMixin, QCheckBox):
    """复选框（可选标签 + 说明文字；说明用来解释影响，不重复标签）。"""

    def __init__(self, text: str = "", parent: Optional[QWidget] = None, *,
                 checked: bool = False, tristate: bool = False,
                 description: str = "",
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(text, parent)
        self.setObjectName("UCheckBox")
        self.setTristate(tristate)
        self.setChecked(checked)
        self.setCursor(Qt.PointingHandCursor)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setProperty("state", "normal")
        if text:
            self.setAccessibleName(text)
        if description:
            self.setToolTip(description)
        tip = " · ".join(x for x in (text, description) if x)
        if tip:
            self.setAccessibleDescription(tip)
        self._init_theme(settings, theme)

    def set_error(self, error: bool) -> None:
        self._set_variant("state", "error" if error else "normal",
                          ("normal", "error"))


class USlider(ThemedMixin, QSlider):
    """滑块（单值）。带无障碍数值语义，键盘左右/上下可调。"""

    def __init__(self, value: int = 0, parent: Optional[QWidget] = None, *,
                 minimum: int = 0, maximum: int = 100, step: int = 1,
                 orientation: str = "horizontal", label: str = "",
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(Qt.Horizontal if orientation == "horizontal" else Qt.Vertical,
                         parent)
        self.setObjectName("USlider")
        self.setRange(minimum, maximum)
        self.setSingleStep(max(1, int(step)))
        self.setPageStep(max(1, int((maximum - minimum) / 10) or step))
        self.setValue(value)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setCursor(Qt.PointingHandCursor)
        if label:
            self.setAccessibleName("%s 滑块" % label)
        self.valueChanged.connect(self._sync_accessible)
        self._init_theme(settings, theme)
        self._sync_accessible(self.value())

    def _sync_accessible(self, value: int) -> None:
        self.setAccessibleDescription("当前值 %d" % value)

    # ---------- 自绘 ----------
    def _handle_diameter(self) -> float:
        raw = str(self.theme_tokens().get("slider-handle", "16px"))
        return float(max(10, int(raw.replace("px", "") or 16)))

    def paintEvent(self, event) -> None:  # noqa: N802
        """自绘轨道与手柄。

        为什么不用 QSS：Qt 对 QSlider 的 sub-control 尺寸支持不完整 ——
        实测 height / min-height / max-height 全被忽略，轨道会撑满整个控件高度
        （看起来是一条很粗的灰条，与主题割裂）。自绘后尺寸完全可控。
        """
        tokens = self.theme_tokens()
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        groove = 4.0
        handle = self._handle_diameter()
        span = self.maximum() - self.minimum()
        ratio = 0.0 if span <= 0 else (self.value() - self.minimum()) / float(span)
        track = QColor(tokens.get("track", "#E8EFEB"))
        accent = QColor(tokens.get("accent-solid", "#0D9488"))
        layer = QColor(tokens.get("layer", "#FFFFFF"))

        if self.orientation() == Qt.Horizontal:
            mid = self.height() / 2.0
            left, right = handle / 2.0, self.width() - handle / 2.0
            travel = max(1.0, right - left)
            cx = left + travel * ratio
            painter.setPen(Qt.NoPen)
            painter.setBrush(track)
            painter.drawRoundedRect(QRectF(left, mid - groove / 2.0, travel, groove),
                                    groove / 2.0, groove / 2.0)
            painter.setBrush(accent)
            painter.drawRoundedRect(
                QRectF(left, mid - groove / 2.0, max(0.0, cx - left), groove),
                groove / 2.0, groove / 2.0)
            painter.setBrush(layer)
            painter.setPen(QPen(accent, 2))
            painter.drawEllipse(QPointF(cx, mid), handle / 2.0 - 1, handle / 2.0 - 1)
        else:
            mid = self.width() / 2.0
            top, bottom = handle / 2.0, self.height() - handle / 2.0
            travel = max(1.0, bottom - top)
            cy = bottom - travel * ratio
            painter.setPen(Qt.NoPen)
            painter.setBrush(track)
            painter.drawRoundedRect(QRectF(mid - groove / 2.0, top, groove, travel),
                                    groove / 2.0, groove / 2.0)
            painter.setBrush(accent)
            painter.drawRoundedRect(
                QRectF(mid - groove / 2.0, cy, groove, max(0.0, bottom - cy)),
                groove / 2.0, groove / 2.0)
            painter.setBrush(layer)
            painter.setPen(QPen(accent, 2))
            painter.drawEllipse(QPointF(mid, cy), handle / 2.0 - 1, handle / 2.0 - 1)
        painter.end()

    def mousePressEvent(self, event) -> None:  # noqa: N802
        """点击轨道任意位置直接跳到该值（自绘后需要自己算命中）。"""
        if event.button() == Qt.LeftButton:
            self._set_from_pos(event.position())
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if event.buttons() & Qt.LeftButton:
            self._set_from_pos(event.position())
        super().mouseMoveEvent(event)

    def _set_from_pos(self, point) -> None:
        handle = self._handle_diameter()
        if self.orientation() == Qt.Horizontal:
            left, right = handle / 2.0, self.width() - handle / 2.0
            ratio = (float(point.x()) - left) / max(1.0, right - left)
        else:
            top, bottom = handle / 2.0, self.height() - handle / 2.0
            ratio = (bottom - float(point.y())) / max(1.0, bottom - top)
        ratio = max(0.0, min(1.0, ratio))
        self.setValue(int(round(self.minimum() + ratio * (self.maximum() - self.minimum()))))

    def restyle(self) -> None:
        self.update()

    def set_range(self, minimum: int, maximum: int) -> None:
        self.setRange(minimum, maximum)


class UComboBox(ThemedMixin, QComboBox):
    """单选下拉。items 支持字符串或 (显示文本, 业务值) 二元组。

    业务值只做透传，控件本身不解释其含义（下拉的语义由使用方赋予）。
    """

    def __init__(self, items: Optional[Sequence] = None,
                 parent: Optional[QWidget] = None, *, placeholder: str = "",
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UComboBox")
        self.setCursor(Qt.PointingHandCursor)
        self.setFocusPolicy(Qt.StrongFocus)
        if placeholder:
            self.setPlaceholderText(placeholder)
        self._init_theme(settings, theme)
        prepare_combo_popup(self)
        if items:
            self.set_items(items)

    def set_items(self, items: Sequence) -> None:
        self.clear()
        for item in items:
            if isinstance(item, (tuple, list)) and len(item) == 2:
                self.addItem(str(item[0]), item[1])
            else:
                self.addItem(str(item), item)

    def showPopup(self) -> None:  # noqa: N802
        """弹出前刷新弹层样式：主题变了也能立刻跟上，且不在构造期碰弹层。"""
        style_combo_popup(self)
        super().showPopup()

    def restyle(self) -> None:
        style_combo_popup(self)

    def current_value(self):
        """当前项的业务值（无选中时为 None）。"""
        index = self.currentIndex()
        return self.itemData(index) if index >= 0 else None

    def select_value(self, value) -> bool:
        index = self.findData(value)
        if index < 0:
            return False
        self.setCurrentIndex(index)
        return True


class UMultiComboBox(ThemedMixin, QComboBox):
    """多选下拉：勾选式列表，收起后显示已选摘要。

    selectionChanged(values) 给出当前勾选集合；控件不解释这些值。
    """

    selectionChanged = Signal(list)

    def __init__(self, items: Optional[Sequence[str]] = None,
                 parent: Optional[QWidget] = None, *, placeholder: str = "请选择",
                 summary_limit: int = 2,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UMultiComboBox")
        self.setCursor(Qt.PointingHandCursor)
        self.setFocusPolicy(Qt.StrongFocus)
        self._placeholder = placeholder or "请选择"
        self._summary_limit = max(1, int(summary_limit))
        self._model = QStandardItemModel(self)
        self.setModel(self._model)
        prepare_combo_popup(self)
        # 必须 editable，否则 setCurrentText 只在文本命中已有项时生效，摘要显示不出来
        self.setEditable(True)
        self.setInsertPolicy(QComboBox.NoInsert)
        self.lineEdit().setReadOnly(True)
        self.lineEdit().setCursor(Qt.PointingHandCursor)
        self.lineEdit().installEventFilter(self)
        self.view().pressed.connect(self._toggle_index)
        self._model.itemChanged.connect(lambda _item: self._refresh_summary())
        self._init_theme(settings, theme)
        if items:
            self.set_items(items)

    def set_items(self, items: Sequence[str]) -> None:
        self._model.clear()
        for text in items:
            item = QStandardItem(str(text))
            item.setFlags(Qt.ItemIsEnabled | Qt.ItemIsUserCheckable)
            item.setData(Qt.Unchecked, Qt.CheckStateRole)
            self._model.appendRow(item)
        self._refresh_summary()

    def showPopup(self) -> None:  # noqa: N802
        style_combo_popup(self)
        super().showPopup()

    def restyle(self) -> None:
        style_combo_popup(self)

    def selected(self) -> List[str]:
        return [self._model.item(row).text() for row in range(self._model.rowCount())
                if self._model.item(row).checkState() == Qt.Checked]

    def set_selected(self, values: Sequence[str]) -> None:
        wanted = {str(v) for v in values}
        for row in range(self._model.rowCount()):
            item = self._model.item(row)
            item.setCheckState(Qt.Checked if item.text() in wanted else Qt.Unchecked)
        self._refresh_summary()

    def clear_selection(self) -> None:
        for row in range(self._model.rowCount()):
            self._model.item(row).setCheckState(Qt.Unchecked)
        self._refresh_summary()

    def _toggle_index(self, index) -> None:
        item = self._model.itemFromIndex(index)
        if item is None:
            return
        item.setCheckState(Qt.Unchecked if item.checkState() == Qt.Checked
                           else Qt.Checked)

    def eventFilter(self, obj, event):  # noqa: N802
        """只读 lineEdit 会吃掉点击：转成展开弹层，保持「点一下就能选」的预期。

        按下和抬起都要吞掉：只吞按下的话，抬起会继续走 QComboBox 的逻辑，
        弹层被判定为「点了别处」而立刻收起 —— 表现就是下拉一闪而过、选不中。
        """
        from PySide6.QtCore import QEvent
        if obj is self.lineEdit():
            if event.type() == QEvent.MouseButtonPress:
                self.showPopup()
                return True
            if event.type() == QEvent.MouseButtonRelease:
                return True
        return super().eventFilter(obj, event)

    def _refresh_summary(self) -> None:
        values = self.selected()
        if not values:
            text = self._placeholder
        elif len(values) <= self._summary_limit:
            text = "、".join(values)
        else:
            text = "%s 等 %d 项" % ("、".join(values[:self._summary_limit]), len(values))
        self.lineEdit().setText(text)          # editable 模式下这就是显示文本
        self.setAccessibleName(text)
        self.selectionChanged.emit(values)


class UDatePicker(ThemedMixin, QDateEdit):
    """日期选择器（弹层日历 + 主题化）。值域可限，显示格式可配。"""

    def __init__(self, date: Optional[QDate] = None, parent: Optional[QWidget] = None, *,
                 display_format: str = "yyyy-MM-dd", calendar_popup: bool = True,
                 minimum: Optional[QDate] = None, maximum: Optional[QDate] = None,
                 label: str = "",
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UDatePicker")
        self.setCalendarPopup(calendar_popup)
        self.setDisplayFormat(display_format)
        if minimum is not None:
            self.setMinimumDate(minimum)
        if maximum is not None:
            self.setMaximumDate(maximum)
        # 默认给今天：留空会让 QDateEdit 显示 2000-01-01，用户第一眼看到的就是错值
        self.setDate(date if date is not None else QDate.currentDate())
        self.setCursor(Qt.PointingHandCursor)
        self.setFocusPolicy(Qt.StrongFocus)
        if label:
            self.setAccessibleName(label)
        self._init_theme(settings, theme)

    def text_value(self) -> str:
        return self.date().toString(self.displayFormat())


class UUpload(ThemedMixin, QFrame):
    """文件上传：拖拽区 + 已选文件列表。

    只负责「挑文件 + 展示 + 移除」，不发起任何网络请求 —— 上传行为属于业务层。
    """

    filesChanged = Signal(list)

    def __init__(self, parent: Optional[QWidget] = None, *,
                 multiple: bool = True, accept: str = "",
                 label: str = "拖拽文件到这里，或点击选择",
                 hint: str = "",
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UUpload")
        self.setAcceptDrops(True)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self._multiple = multiple
        self._accept = accept
        self._paths: List[str] = []
        self._init_theme(settings, theme)

        root = QVBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)
        root.setSpacing(8)

        self.drop = QFrame(self)
        self.drop.setObjectName("UUploadDrop")
        self.drop.setAttribute(Qt.WA_StyledBackground, True)
        drop_layout = QVBoxLayout(self.drop)
        drop_layout.setContentsMargins(16, 18, 16, 18)
        drop_layout.setSpacing(6)
        self.label = QLabel(label, self.drop)
        self.label.setObjectName("UUploadLabel")
        self.label.setAlignment(Qt.AlignCenter)
        drop_layout.addWidget(self.label)
        if hint:
            self.hint = QLabel(hint, self.drop)
            self.hint.setObjectName("UUploadHint")
            self.hint.setAlignment(Qt.AlignCenter)
            self.hint.setWordWrap(True)
            drop_layout.addWidget(self.hint)
        self.choose = QToolButton(self.drop)
        self.choose.setObjectName("UUploadChoose")
        self.choose.setText("选择文件")
        self.choose.setCursor(Qt.PointingHandCursor)
        self.choose.setToolTip("选择文件")
        self.choose.clicked.connect(self.browse)
        drop_layout.addWidget(self.choose, 0, Qt.AlignHCenter)
        self.drop.setCursor(Qt.PointingHandCursor)
        self.label.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        root.addWidget(self.drop)

        self.list_area = QVBoxLayout()
        self.list_area.setSpacing(4)
        self.list_area.setContentsMargins(0, 0, 0, 0)
        root.addLayout(self.list_area)
        self.empty_hint = QLabel("", self)
        self.empty_hint.setObjectName("UUploadEmpty")
        self.empty_hint.setVisible(False)
        root.addWidget(self.empty_hint)
        self._rows: List[QWidget] = []

    # ---------- 文件 ----------
    def files(self) -> List[str]:
        return list(self._paths)

    def add_files(self, paths: Sequence[str]) -> None:
        changed = False
        for path in paths:
            if not path or path in self._paths:
                continue
            if not self._multiple and self._paths:
                self._paths = []
            self._paths.append(str(path))
            changed = True
        if changed:
            self._rebuild_rows()
            self.filesChanged.emit(self.files())

    def clear(self) -> None:
        if not self._paths:
            return
        self._paths = []
        self._rebuild_rows()
        self.filesChanged.emit([])

    def remove_file(self, path: str) -> None:
        if path in self._paths:
            self._paths.remove(path)
            self._rebuild_rows()
            self.filesChanged.emit(self.files())

    def browse(self) -> None:
        paths, _selected = QFileDialog.getOpenFileNames(self, "选择文件", "", self._accept)
        if paths:
            self.add_files(paths)

    # ---------- 拖拽 ----------
    def _accepted(self, event) -> bool:
        data = event.mimeData()
        return isinstance(data, QMimeData) and data.hasUrls()

    def dragEnterEvent(self, event: QDragEnterEvent) -> None:  # noqa: N802
        if self._accepted(event):
            self.drop.setProperty("dragging", "true")
            self.drop.style().unpolish(self.drop)
            self.drop.style().polish(self.drop)
            event.acceptProposedAction()
        else:
            super().dragEnterEvent(event)

    def dragLeaveEvent(self, event) -> None:  # noqa: N802
        self.drop.setProperty("dragging", "false")
        self.drop.style().unpolish(self.drop)
        self.drop.style().polish(self.drop)
        super().dragLeaveEvent(event)

    def dropEvent(self, event: QDropEvent) -> None:  # noqa: N802
        self.drop.setProperty("dragging", "false")
        self.drop.style().unpolish(self.drop)
        self.drop.style().polish(self.drop)
        if self._accepted(event):
            self.add_files([url.toLocalFile() for url in event.mimeData().urls()])
            event.acceptProposedAction()
        else:
            super().dropEvent(event)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if self.drop.geometry().contains(event.position().toPoint()):
            self.browse()
        super().mousePressEvent(event)

    # ---------- 列表 ----------
    def _rebuild_rows(self) -> None:
        for row in self._rows:
            self.list_area.removeWidget(row)
            row.setParent(None)
            row.deleteLater()
        self._rows = []
        for path in self._paths:
            row = QFrame(self)
            row.setObjectName("UUploadRow")
            row.setAttribute(Qt.WA_StyledBackground, True)
            layout = QHBoxLayout(row)
            layout.setContentsMargins(10, 6, 6, 6)
            layout.setSpacing(8)
            name = QLabel(str(path).split("/")[-1], row)
            name.setObjectName("UUploadName")
            name.setToolTip(str(path))
            layout.addWidget(name, 1)
            remove = QToolButton(row)
            remove.setObjectName("UUploadRemove")
            remove.setIcon(icons.icon("close", size=14))
            remove.setIconSize(QSize(14, 14))
            remove.setToolTip("移除")
            remove.setAccessibleName("移除 %s" % name.text())
            remove.setCursor(Qt.PointingHandCursor)
            remove.clicked.connect(lambda _c=False, p=str(path): self.remove_file(p))
            layout.addWidget(remove)
            self.list_area.addWidget(row)
            self._rows.append(row)
        self.empty_hint.setVisible(not self._paths)


# ============================ 单选钮 ============================
class URadioButton(ThemedMixin, QRadioButton):
    """单选钮：与 UCheckbox 同一套尺寸与 token，但保留互斥语义。

    外观由自绘指示器承担（QSS 的 QRadioButton::indicator），
    这样它在任何主题下都与勾选框同高、同圆角，不会一个圆一个方。
    """

    def __init__(self, text: str = "", parent: Optional[QWidget] = None, *,
                 checked: bool = False, tooltip: str = "",
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(text, parent)
        self.setObjectName("URadioButton")
        self.setChecked(bool(checked))
        self.setFocusPolicy(Qt.StrongFocus)
        self.setCursor(Qt.PointingHandCursor)
        if tooltip:
            self.setToolTip(tooltip)
        self.setAccessibleName(text or tooltip or "单选")
        self._init_theme(settings, theme)


# ============================ 数字框 ============================
class USpinBox(ThemedMixin, QSpinBox):
    """数字输入框：高度、字号、箭头全部由 token 驱动。"""

    def __init__(self, value: int = 0, parent: Optional[QWidget] = None, *,
                 minimum: int = 0, maximum: int = 9999, step: int = 1,
                 suffix: str = "", tooltip: str = "",
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("USpinBox")
        self.setRange(int(minimum), int(maximum))
        self.setSingleStep(max(1, int(step)))
        self.setValue(int(value))
        if suffix:
            self.setSuffix(suffix)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setCursor(Qt.IBeamCursor)
        if tooltip:
            self.setToolTip(tooltip)
        self.setAccessibleName(tooltip or "数字输入")
        self._init_theme(settings, theme)

