# -*- coding: utf-8 -*-
"""统一设置入口：按 UISettings.schema() 自动生成设置界面。

为什么做成 schema 驱动：框架里的颜色 / 尺寸 / 动效 / 材质全部是可配置项，
如果每加一项就要手写一个控件，很快会漂移（有人加了设置却忘了加界面）。
这里唯一的真相是 settings.SCHEMA_SPECS —— 面板只是它的渲染器。
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QFrame, QGridLayout, QHBoxLayout, QLabel, QSizePolicy, QVBoxLayout, QWidget,
)

from ..settings import UISettings
from ..theme import ThemeManager
from .actions import UButton, USegmentedControl, UToggleSwitch
from .base import ThemedMixin
from .forms import UComboBox, USlider
from .surfaces import UCard
from .text import UTitle

__all__ = ["USettingsPanel", "ACCENT_PRESETS"]

#: 强调色预设（与画廊一致）
ACCENT_PRESETS: Sequence[str] = (
    "#0D9488", "#2563EB", "#7C3AED", "#DB2777", "#DC2626",
    "#EA580C", "#16A34A", "#475569",
)


class _AccentSwatch(ThemedMixin, QFrame):
    """一个可点击的强调色块。"""

    picked = Signal(str)

    def __init__(self, color: str, parent: Optional[QWidget] = None, *,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent)
        self.setObjectName("UAccentSwatch")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self._color = color
        self.setFixedSize(24, 24)
        self.setCursor(Qt.PointingHandCursor)
        self.setFocusPolicy(Qt.TabFocus)
        self.setToolTip(color)
        self.setAccessibleName("强调色 %s" % color)
        self._init_theme(settings, theme)
        self._apply()

    def color(self) -> str:
        return self._color

    def _apply(self) -> None:
        self.setStyleSheet(
            "QFrame#UAccentSwatch { background: %s; border: %s solid %s;"
            " border-radius: 12px; }" % (
                self._color,
                self.tokens().get("border-w", "1px")
                if hasattr(self, "tokens") else "1px",
                self.theme_tokens().get("border", "#E3E7EB")))

    def set_active(self, active: bool) -> None:
        self.setProperty("active", "true" if active else "false")
        self._apply()

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.LeftButton:
            self.picked.emit(self._color)
        super().mouseReleaseEvent(event)

    def keyPressEvent(self, event) -> None:  # noqa: N802
        if event.key() in (Qt.Key_Space, Qt.Key_Return, Qt.Key_Enter):
            self.picked.emit(self._color)
        super().keyPressEvent(event)

    def restyle(self) -> None:
        self._apply()


class USettingsPanel(ThemedMixin, QWidget):
    """所有可配置项的集中入口。

    用法：
        panel = USettingsPanel(settings=ui, theme=theme)
        layout.addWidget(panel)          # 改任何一项都会立刻广播到全界面

    新增设置项：只在 settings.SCHEMA_SPECS 里加一条，这个面板会自动出现对应控件。
    """

    changed = Signal(str, object)

    def __init__(self, parent: Optional[QWidget] = None, *,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None,
                 groups: Optional[Sequence[str]] = None,
                 show_reset: bool = True) -> None:
        super().__init__(parent)
        self.setObjectName("USettingsPanel")
        self._init_theme(settings, theme)
        self._settings = self._ui_settings
        self._theme = self._ui_theme
        self._controls: Dict[str, object] = {}
        self._swatches: List[_AccentSwatch] = []
        self._guard = False

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(12)

        wanted = list(groups) if groups else UISettings.groups()
        for group in UISettings.groups():
            if group not in wanted:
                continue
            specs = [s for s in UISettings.schema() if s.group == group]
            if not specs:
                continue
            card = UCard(group, self._group_hint(group), settings=self._settings,
                         theme=self._theme)
            for spec in specs:
                card.add_widget(self._build_row(spec))
            root.addWidget(card)

        if show_reset:
            reset_row = QHBoxLayout()
            reset_row.addStretch(1)
            reset = UButton("恢复默认", tone="subtle", size="compact",
                            settings=self._settings, theme=self._theme)
            reset.clicked.connect(self.reset)
            reset_row.addWidget(reset)
            root.addLayout(reset_row)
        root.addStretch(1)

        self._settings.changed.connect(self._on_setting_changed)

    # ---------- 构建 ----------
    @staticmethod
    def _group_hint(group: str) -> str:
        return {
            "外观": "主题、强调色、圆角与描边 —— 框架里所有颜色都来自这些语义 token",
            "排版": "字号、控件高度、间距与图标尺寸 —— 控件内字号会被控件高度约束",
            "动效": "全局开关与档位；十个动效组件共用同一套时长与缓动",
            "材质": "控件面与窗口层使用同一套材质；系统材质不可用时自动退化",
        }.get(group, "")

    def _build_row(self, spec) -> QWidget:
        row = QWidget()
        box = QVBoxLayout(row)
        box.setContentsMargins(0, 0, 0, 0)
        box.setSpacing(6)

        header = QHBoxLayout()
        header.setSpacing(8)
        # 单位拼进标签：滑块本身只是数值控件，显示单位属于文案
        text = spec.label if not spec.suffix else "%s（%s）" % (spec.label, spec.suffix)
        label = QLabel(text)
        label.setObjectName("USettingsLabel")
        header.addWidget(label)
        header.addStretch(1)
        box.addLayout(header)

        if spec.kind == "color":
            box.addWidget(self._build_colors(spec))
        elif spec.kind == "bool":
            switch = UToggleSwitch(self._settings.get_bool(spec.key), tooltip=spec.label,
                                   settings=self._settings, theme=self._theme)
            switch.toggled.connect(lambda state, k=spec.key: self._write(k, bool(state)))
            header.addWidget(switch)
            self._controls[spec.key] = switch
        elif spec.kind == "choice":
            choices = self._choices_for(spec)
            if len(choices) > 4:
                # 选项多时用下拉：分段控件塞不下，会被挤变形
                control = UComboBox([(text, str(value)) for text, value in choices],
                                    settings=self._settings, theme=self._theme)
                current = str(self._settings.get(spec.key, ""))
                for index, (_text, value) in enumerate(choices):
                    if str(value) == current:
                        control.setCurrentIndex(index)
                        break
                control.currentIndexChanged.connect(
                    lambda index, k=spec.key, c=control: self._write(k, c.currentData()))
                box.addWidget(control)
                self._controls[spec.key] = control
            else:
                control = USegmentedControl(settings=self._settings, theme=self._theme)
                for text, value in choices:
                    control.add_segment(text, str(value))
                control.segmentChanged.connect(
                    lambda _index, key, k=spec.key: self._write(k, key))
                box.addWidget(control)
                self._controls[spec.key] = control
        else:  # int
            slider = USlider(self._settings.get_int(spec.key),
                             minimum=spec.minimum, maximum=spec.maximum,
                             label=spec.label, settings=self._settings,
                             theme=self._theme)
            slider.valueChanged.connect(lambda value, k=spec.key: self._write(k, int(value)))
            box.addWidget(slider)
            self._controls[spec.key] = slider

        if spec.help:
            hint = UTitle(spec.help, role="caption", wrap=True,
                          settings=self._settings, theme=self._theme)
            box.addWidget(hint)
        return row

    def _build_colors(self, spec) -> QWidget:
        holder = QWidget()
        grid = QGridLayout(holder)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setSpacing(8)
        current = str(self._settings.get(spec.key, ACCENT_PRESETS[0])).upper()
        for index, color in enumerate(ACCENT_PRESETS):
            swatch = _AccentSwatch(color, settings=self._settings, theme=self._theme)
            swatch.set_active(color.upper() == current)
            swatch.picked.connect(lambda value, k=spec.key: self._write(k, value))
            grid.addWidget(swatch, index // 8, index % 8)
            self._swatches.append(swatch)
        return holder

    def _choices_for(self, spec) -> Sequence:
        if spec.choices:
            return spec.choices
        if spec.key == "theme_pack":
            packs = getattr(self._theme, "packs", None)
            names = list(packs.keys()) if isinstance(packs, dict) else []
            return tuple((name, name) for name in names) or (("默认", "默认"),)
        if spec.key == "material":
            try:
                from ..material import MATERIAL_LABELS, MATERIALS
                return tuple((MATERIAL_LABELS.get(m, m), m) for m in MATERIALS)
            except Exception:  # noqa: BLE001
                return (("实色", "solid"),)
        return ()

    # ---------- 读写 ----------
    def _write(self, key: str, value) -> None:
        if self._guard:
            return
        self._settings.set(key, value)
        self.changed.emit(key, value)

    def _on_setting_changed(self, key: str, value) -> None:
        """外部（或其它面板）改值时把界面同步过来。"""
        if self._guard:
            return
        self._guard = True
        try:
            control = self._controls.get(key)
            if control is not None:
                if isinstance(control, UToggleSwitch):
                    control.setChecked(bool(value))
                elif isinstance(control, USlider):
                    control.setValue(int(value))
                elif isinstance(control, USegmentedControl):
                    for index, (_, segment_key) in enumerate(self._choices_for_by_key(key)):
                        if str(segment_key) == str(value):
                            control.set_current_index(index)
                            break
                elif isinstance(control, UComboBox):
                    for index, (_, value_key) in enumerate(self._choices_for_by_key(key)):
                        if str(value_key) == str(value):
                            control.setCurrentIndex(index)
                            break
            if key == "accent_color":
                wanted = str(value).upper()
                for swatch in self._swatches:
                    swatch.set_active(swatch.color().upper() == wanted)
        finally:
            self._guard = False

    def _choices_for_by_key(self, key: str) -> Sequence:
        for spec in UISettings.schema():
            if spec.key == key:
                return self._choices_for(spec)
        return ()

    def reset(self) -> None:
        self._guard = True
        try:
            self._settings.reset()
        finally:
            self._guard = False
        for key, control in self._controls.items():
            value = self._settings.get(key)
            if isinstance(control, UToggleSwitch):
                control.setChecked(bool(value))
            elif isinstance(control, USlider):
                control.setValue(int(value))
            elif isinstance(control, USegmentedControl):
                for index, (_, segment_key) in enumerate(self._choices_for_by_key(key)):
                    if str(segment_key) == str(value):
                        control.set_current_index(index)
                        break
        wanted = str(self._settings.get("accent_color", "")).upper()
        for swatch in self._swatches:
            swatch.set_active(swatch.color().upper() == wanted)
        self.changed.emit("*", None)

    def control_for(self, key: str):
        """取某项设置对应的控件（测试与外部联动用）。"""
        return self._controls.get(key)

    def group_cards(self) -> List[UCard]:
        return self.findChildren(UCard)
