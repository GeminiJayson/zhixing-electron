# -*- coding: utf-8 -*-
"""组件库画廊：qfluent_core 全部组件的可视化验收面，也是迁移时的抄写参考。

运行：
    .venv/bin/python -m examples.component_gallery
"""
from __future__ import annotations

import sys
from typing import List, Optional

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QApplication, QFrame, QGridLayout, QHBoxLayout, QScrollArea,
    QStackedWidget, QVBoxLayout, QWidget,
)

from qfluent_core import (
    K, MATERIAL_LABELS, MATERIALS, FluentTemplateWindow, ThemeManager,
    UActionCard, UBottomBar, UCollapseCard, UFilterChips, UFlipCard, USettingsPanel,
    UMaskedInput, UProgressCard, USwipeConfirm, UTabStrip,
    UAlert, UAvatar, UBadge, UBreadcrumb, UButton, UCard, UCheckbox,
    UColorSwatch, UComboBox, UConfirmDialog, UConsole, UDataTable,
    UDatePicker, UDialog, UDivider, UDropdown, UEmptyState, UExpander,
    UField, UIconButton, UImageCompare, UInfoBar, ULineEdit, UMenu,
    UMultiComboBox, UPageHeader, UPagination, UProgressBar, UProgressRing,
    USearchBox, USegmentedControl, USkeleton, USlider, UStatusPill, UTable,
    UTabs, UTitle, UToggleSwitch, UTopbar, UUpload, UISettings, motion,
)

__all__ = ["build_gallery_window", "main"]

MARGIN = 20


def _page(content: QWidget) -> QWidget:
    """统一内边距 + 纵向滚动（长内容不裁切、不压缩）。"""
    holder = QWidget()
    outer = QVBoxLayout(holder)
    outer.setContentsMargins(0, 0, 0, 0)
    scroll = QScrollArea(holder)
    scroll.setWidgetResizable(True)
    scroll.setFrameShape(QScrollArea.NoFrame)
    scroll.setWidget(content)
    outer.addWidget(scroll)
    return holder


def _column(parent: QWidget, spacing: int = 16) -> QVBoxLayout:
    layout = QVBoxLayout(parent)          # 必须挂到 widget 上，否则控件成无父顶层窗口
    layout.setContentsMargins(MARGIN, MARGIN, MARGIN, MARGIN)
    layout.setSpacing(spacing)
    return layout


def _actions_page(settings: UISettings, theme: ThemeManager) -> QWidget:
    content = QWidget()
    layout = _column(content)
    layout.addWidget(UPageHeader("动作", "一个区域只允许一个 accent 主动作",
                                 settings=settings, theme=theme))

    row = QHBoxLayout()
    row.setSpacing(8)
    for tone in ("standard", "accent", "subtle", "danger"):
        row.addWidget(UButton(tone.capitalize(), tone=tone,
                              settings=settings, theme=theme))
    row.addWidget(UButton("Ghost", kind="ghost", settings=settings, theme=theme))
    row.addWidget(UButton("Compact", size="compact", settings=settings, theme=theme))
    row.addWidget(UButton("Large", size="large", settings=settings, theme=theme))
    row.addStretch(1)
    row.addWidget(UIconButton(None, "设置", text="\u2699",
                              settings=settings, theme=theme))
    row.addWidget(UIconButton(None, "关闭", text="\u2715", role="close",
                              settings=settings, theme=theme))
    layout.addLayout(row)

    row2 = QHBoxLayout()
    row2.setSpacing(12)
    disabled = UButton("已禁用", settings=settings, theme=theme)
    disabled.setEnabled(False)
    row2.addWidget(disabled)
    row2.addWidget(UToggleSwitch(True, tooltip="启用提醒",
                                 settings=settings, theme=theme))
    row2.addWidget(UToggleSwitch(False, tooltip="仅显示未完成",
                                 settings=settings, theme=theme))
    segmented = USegmentedControl(settings=settings, theme=theme)
    for text, key in (("列表", "list"), ("看板", "board"), ("日历", "calendar")):
        segmented.add_segment(text, key)
    row2.addWidget(segmented)
    row2.addStretch(1)
    layout.addLayout(row2)

    layout.addWidget(UDivider())
    layout.addWidget(UPageHeader("输入", "错误就近显示，不用顶部汇总",
                                 settings=settings, theme=theme))
    card = UCard(settings=settings, theme=theme)
    card.add_widget(UField(
        "任务标题", ULineEdit("", "输入标题…", settings=settings, theme=theme),
        help_text="最长 80 个字符", settings=settings, theme=theme))
    error_field = UField("截止日期",
                         ULineEdit("2026-02-31", settings=settings, theme=theme),
                         settings=settings, theme=theme)
    error_field.set_error("日期无效，请检查月份天数")
    card.add_widget(error_field)
    card.add_widget(USearchBox("搜索任务、笔记…", settings=settings, theme=theme))
    layout.addWidget(card)
    layout.addStretch(1)
    return _page(content)


def _surfaces_page(settings: UISettings, theme: ThemeManager) -> QWidget:
    content = QWidget()
    layout = _column(content)
    layout.addWidget(UPageHeader("容器与层级", "先靠间距与排版建立层次，卡片只在有独立面时使用",
                                 settings=settings, theme=theme))

    grid = QGridLayout()
    grid.setSpacing(12)
    for column, (title, subtitle, variant) in enumerate((
            ("Raised", "独立内容面", "raised"),
            ("Sunken", "内嵌面板", "sunken"),
            ("Plain", "无填充，仅分组", "plain"))):
        card = UCard(title, subtitle, variant=variant, settings=settings, theme=theme)
        card.add_widget(UTitle("卡片正文", role="body", settings=settings, theme=theme))
        grid.addWidget(card, 0, column)
    layout.addLayout(grid)

    expander = UExpander("高级选项", settings=settings, theme=theme)
    expander.add_widget(UField("工作目录", ULineEdit("~/Documents",
                                                     settings=settings, theme=theme),
                               settings=settings, theme=theme))
    layout.addWidget(expander)

    layout.addWidget(UTitle("文字层级", role="subtitle", settings=settings, theme=theme))
    for role in ("title", "subtitle", "body", "caption", "muted"):
        layout.addWidget(UTitle("role=%s · 知行合一 ZhiXing" % role, role=role,
                                settings=settings, theme=theme))
    layout.addStretch(1)
    return _page(content)


def _status_page(settings: UISettings, theme: ThemeManager) -> QWidget:
    content = QWidget()
    layout = _column(content)
    layout.addWidget(UPageHeader("状态与反馈", "状态色成对使用：语义前景 + 低饱和软底",
                                 settings=settings, theme=theme))

    pills = QHBoxLayout()
    pills.setSpacing(8)
    for text, tone in (("待处理", "standard"), ("进行中", "accent"), ("已完成", "success"),
                       ("已逾期", "danger"), ("待确认", "warn"), ("已归档", "info")):
        pills.addWidget(UStatusPill(text, tone=tone, settings=settings, theme=theme))
    pills.addWidget(UStatusPill("实底", tone="accent", kind="solid",
                                settings=settings, theme=theme))
    pills.addWidget(UStatusPill("描边", tone="danger", kind="outline",
                               settings=settings, theme=theme))
    pills.addStretch(1)
    pills.addWidget(UBadge(3, settings=settings, theme=theme))
    pills.addWidget(UBadge(120, tone="danger", settings=settings, theme=theme))
    layout.addLayout(pills)

    layout.addWidget(UInfoBar("已同步 12 条任务", tone="success",
                              settings=settings, theme=theme))
    retry_bar = UInfoBar("同步失败，稍后自动重试", tone="danger",
                         settings=settings, theme=theme)
    retry_bar.add_action("立即重试")
    layout.addWidget(retry_bar)
    layout.addWidget(UInfoBar("首次使用？可以先看快速上手", tone="info",
                              settings=settings, theme=theme))

    layout.addWidget(UTitle("进度", role="caption", settings=settings, theme=theme))
    for tone in ("accent", "success", "warn", "danger"):
        layout.addWidget(UProgressBar(40, tone=tone, settings=settings, theme=theme))

    rings = QHBoxLayout()
    rings.setSpacing(16)
    rings.addWidget(UProgressRing(indeterminate=True, settings=settings, theme=theme))
    determinate = UProgressRing(settings=settings, theme=theme)
    determinate.set_range(0, 100)
    determinate.set_value(65)
    rings.addWidget(determinate)
    rings.addStretch(1)
    layout.addLayout(rings)

    skeletons = QHBoxLayout()
    skeletons.setSpacing(8)
    for width in (180, 120, 60):
        skeletons.addWidget(USkeleton(width=width, settings=settings, theme=theme))
    skeletons.addStretch(1)
    layout.addLayout(skeletons)

    empty = UEmptyState("还没有任务", "用 ⌘K 或下面的按钮创建第一条任务",
                        settings=settings, theme=theme)
    empty.add_action("新建任务")
    layout.addWidget(empty, 1)
    return _page(content)


def _overlays_page(settings: UISettings, theme: ThemeManager,
                   window: FluentTemplateWindow) -> QWidget:
    content = QWidget()
    layout = _column(content)
    layout.addWidget(UPageHeader("浮层", "一次性浮层用完即走；破坏性动作要有明确措辞与状态",
                                 settings=settings, theme=theme))

    def open_dialog() -> None:
        dialog = UDialog("编辑任务", window, settings=settings, theme=theme)
        dialog.add_widget(ULineEdit("修复登录超时", settings=settings, theme=theme))
        dialog.set_cancel_action()
        dialog.set_primary_action("保存")
        dialog.exec()

    def open_confirm() -> None:
        UConfirmDialog.ask(window, "删除任务", "删除后可在回收站恢复，确定删除吗？",
                           danger=True, confirm_text="删除",
                           settings=settings, theme=theme)

    open_button = UButton("打开对话框", tone="accent", settings=settings, theme=theme)
    open_button.clicked.connect(open_dialog)
    confirm_button = UButton("危险确认", tone="danger", settings=settings, theme=theme)
    confirm_button.clicked.connect(open_confirm)
    row = QHBoxLayout()
    row.setSpacing(8)
    row.addWidget(open_button)
    row.addWidget(confirm_button)
    row.addStretch(1)
    layout.addLayout(row)
    layout.addStretch(1)
    return _page(content)


    def _theme_page(settings: UISettings, theme: ThemeManager,
                    window: FluentTemplateWindow) -> QWidget:
        """主题与材质页：所有换肤/圆角/动效档位/材质的操作入口（也是验收面）。"""
        from PySide6.QtWidgets import QHBoxLayout as _Row
    
        content = QWidget()
        layout = _column(content)
        layout.addWidget(UPageHeader(
            "主题与材质", "主题包换整体配色，强调色单独换；圆角、字号、动效档位、材质全局统一",
            settings=settings, theme=theme))
    
        # ---------- 主题包 ----------
        pack_card = UCard("主题包", "切包会同时换上该包的默认强调色；窗口与所有控件一起换",
                          settings=settings, theme=theme)
        pack_row = _Row()
        pack_row.setSpacing(6)
        pack_state = UStatusPill(str(settings.get(K.THEME_PACK, "默认")), tone="accent",
                                 settings=settings, theme=theme)
        pack_buttons: Dict[str, UButton] = {}
    
        def choose_pack(name: str) -> None:
            settings.set(K.THEME_PACK, name)
            pack_state.set_status(name, "accent")
            for key, button in pack_buttons.items():
                button.set_kind("solid" if key == name else "ghost")
                button.set_tone("accent" if key == name else "standard")
    
        for pack_name in theme.packs:
            button = UButton(pack_name, tone="standard", kind="ghost", size="compact",
                             settings=settings, theme=theme)
            button.clicked.connect(lambda _c=False, n=pack_name: choose_pack(n))
            pack_buttons[pack_name] = button
            pack_row.addWidget(button)
        pack_row.addStretch(1)
        pack_row.addWidget(pack_state)
        pack_card.add_layout(pack_row)
        choose_pack(str(settings.get(K.THEME_PACK, "默认")))
        layout.addWidget(pack_card)
    
        # ---------- 强调色 ----------
        color_card = UCard("强调色", "只换强调色家族（hover / pressed / 软底 / 实底自动派生）",
                           settings=settings, theme=theme)
        color_row = _Row()
        color_row.setSpacing(8)
        swatches: List[UColorSwatch] = []
    
        def choose_accent(color: str) -> None:
            settings.set(K.ACCENT, color)
            for swatch in swatches:
                swatch.setChecked(swatch.color().lower() == color.lower())
    
        for color, label in (("#0D9488", "青"), ("#2563EB", "蓝"), ("#7C3AED", "紫"),
                             ("#DB2777", "粉"), ("#DC2626", "红"), ("#EA580C", "橙"),
                             ("#16A34A", "绿"), ("#475569", "石墨")):
            swatch = UColorSwatch(color, tooltip=label, settings=settings, theme=theme)
            swatch.clicked.connect(lambda _c=False, col=color: choose_accent(col))
            swatches.append(swatch)
            color_row.addWidget(swatch)
        color_row.addStretch(1)
        color_card.add_layout(color_row)
        choose_accent(str(settings.get(K.ACCENT, "#0D9488")))
        layout.addWidget(color_card)
    
        # ---------- 圆角 / 字号 / 动效档位 ----------
        tuning = UCard("圆角与密度", "圆角一次派生 xs/sm/ctl/md/lg 四档，控件与窗口共用同一套",
                       settings=settings, theme=theme)
    
        radius_seg = USegmentedControl(settings=settings, theme=theme)
        for label, value in (("紧凑 4", 4), ("标准 8", 8), ("圆润 14", 14)):
            radius_seg.add_segment(label, str(value))
        radius_seg.set_current_index({"4": 0, "8": 1, "14": 2}.get(
            str(settings.get_int(K.RADIUS, 8)), 1))
        radius_seg.segmentChanged.connect(
            lambda _index, key: settings.set(K.RADIUS, int(key)))
        tuning.add_widget(UField("圆角", radius_seg, settings=settings, theme=theme))
    
        font_seg = USegmentedControl(settings=settings, theme=theme)
        for label, value in (("小 12", 12), ("标准 14", 14), ("大 17", 17)):
            font_seg.add_segment(label, str(value))
        font_seg.set_current_index({"12": 0, "14": 1, "17": 2}.get(
            str(settings.get_int(K.FONT_SIZE, 14)), 1))
        font_seg.segmentChanged.connect(
            lambda _index, key: settings.set(K.FONT_SIZE, int(key)))
        tuning.add_widget(UField("字号", font_seg, settings=settings, theme=theme))
        height_seg = USegmentedControl(settings=settings, theme=theme)
        for label, value in (("紧凑 28", 28), ("标准 34", 34), ("宽大 42", 42)):
            height_seg.add_segment(label, str(value))
        height_seg.set_current_index(
            {"28": 0, "34": 1, "42": 2}.get(str(settings.get_int(K.CONTROL_HEIGHT, 34)), 1))
        height_seg.segmentChanged.connect(
            lambda _index, key: settings.set(K.CONTROL_HEIGHT, int(key)))
        tuning.add_widget(UField(
            "控件高度", height_seg,
            help_text="所有控件统一高度；控件内文字跟着字号走，但以控件高度为准",
            settings=settings, theme=theme))
        layout.addWidget(tuning)
    
        # ---------- 动效档位 ----------
        motion_card = UCard("动效档位", "整体缩放动画时长并换缓动风格，切换后立即生效",
                            settings=settings, theme=theme)
        motion_seg = USegmentedControl(settings=settings, theme=theme)
        for key in ("snappy", "standard", "relaxed"):
            motion_seg.add_segment(str(motion.MOTION_PROFILES[key]["label"]), key)
        order = ("snappy", "standard", "relaxed")
        motion_seg.set_current_index(order.index(str(settings.get(K.MOTION_STYLE, "standard")))
                                     if str(settings.get(K.MOTION_STYLE, "standard")) in order
                                     else 1)
        motion_seg.segmentChanged.connect(
            lambda _index, key: settings.set(K.MOTION_STYLE, key))
        motion_note = UTitle("", role="caption", settings=settings, theme=theme)
    
        def refresh_motion_note(*_args) -> None:
            motion_note.setText("normal %d ms · panel %d ms · 缓动 %s" % (
                motion.duration("normal"), motion.duration("panel"),
                motion.MOTION_PROFILES[motion.profile()]["easing"]))
    
        settings.motionStyleChanged.connect(refresh_motion_note)
        refresh_motion_note()
        replay = UButton("重播页面切换动效", tone="standard", size="compact",
                         settings=settings, theme=theme)
        replay.clicked.connect(lambda: window.set_current_index(
            (window.current_index() + 1) % window.page_count()))
        motion_row = _Row()
        motion_row.setSpacing(8)
        motion_row.addWidget(replay)
        motion_row.addStretch(1)
        motion_card.add_widget(UField("档位", motion_seg, settings=settings, theme=theme))
        motion_card.add_widget(motion_note)
        motion_card.add_layout(motion_row)
        layout.addWidget(motion_card)
    
        # ---------- 显示材质 ----------
        material_card = UCard("显示材质", "控件面与窗口层一起换；系统材质不可用的档位会标灰",
                              settings=settings, theme=theme)
        support = window.available_materials()
        material_row = _Row()
        material_row.setSpacing(6)
        material_buttons: Dict[str, UButton] = {}
        material_state = UStatusPill("", tone="standard", settings=settings, theme=theme)
    
        def choose_material(name: str) -> None:
            settings.set(K.MATERIAL, name)
            for key, button in material_buttons.items():
                button.set_kind("solid" if key == name else "ghost")
                button.set_tone("accent" if key == name else "standard")
            effective = window.material
            material_state.set_status(
                "生效：%s" % MATERIAL_LABELS.get(effective, effective),
                "success" if effective == name else "warn")
    
        for material in MATERIALS:
            button = UButton(MATERIAL_LABELS[material], size="compact",
                             settings=settings, theme=theme)
            if not support.get(material, False):
                button.setEnabled(False)
                button.setToolTip("当前平台不支持该系统材质，会自动退化为纯 Qt 观感")
            button.clicked.connect(lambda _c=False, m=material: choose_material(m))
            material_buttons[material] = button
            material_row.addWidget(button)
        material_row.addStretch(1)
        material_row.addWidget(material_state)
        material_card.add_layout(material_row)
        choose_material(str(settings.get(K.MATERIAL, "solid")))
        layout.addWidget(material_card)
    
        # ---------- 预览 ----------
        preview = UCard("预览", "上面任何一项变化都会立刻反映到这里与整个窗口",
                        settings=settings, theme=theme)
        preview_row = _Row()
        preview_row.setSpacing(8)
        preview_row.addWidget(UButton("主动作", tone="accent", settings=settings, theme=theme))
        preview_row.addWidget(UButton("次要", tone="standard", settings=settings, theme=theme))
        preview_row.addWidget(UButton("危险", tone="danger", settings=settings, theme=theme))
        preview_row.addWidget(UStatusPill("进行中", tone="accent", settings=settings, theme=theme))
        preview_row.addWidget(UStatusPill("已完成", tone="success", settings=settings, theme=theme))
        preview_row.addWidget(ULineEdit("", "输入框", settings=settings, theme=theme))
        preview_row.addStretch(1)
        preview.add_layout(preview_row)
        layout.addWidget(preview)
    
        layout.addStretch(1)
        return _page(content)


def _theme_page(settings: UISettings, theme: ThemeManager,
                window: FluentTemplateWindow) -> QWidget:
    """主题与材质页：所有换肤/圆角/动效档位/材质的操作入口（也是验收面）。"""
    from PySide6.QtWidgets import QHBoxLayout as _Row

    content = QWidget()
    layout = _column(content)
    layout.addWidget(UPageHeader(
        "主题与材质", "主题包换整体配色，强调色单独换；圆角、字号、动效档位、材质全局统一",
        settings=settings, theme=theme))

    # ---------- 主题包 ----------
    pack_card = UCard("主题包", "切包会同时换上该包的默认强调色；窗口与所有控件一起换",
                      settings=settings, theme=theme)
    pack_row = _Row()
    pack_row.setSpacing(6)
    pack_state = UStatusPill(str(settings.get(K.THEME_PACK, "默认")), tone="accent",
                             settings=settings, theme=theme)
    pack_buttons: Dict[str, UButton] = {}

    def choose_pack(name: str) -> None:
        settings.set(K.THEME_PACK, name)
        pack_state.set_status(name, "accent")
        for key, button in pack_buttons.items():
            button.set_kind("solid" if key == name else "ghost")
            button.set_tone("accent" if key == name else "standard")

    for pack_name in theme.packs:
        button = UButton(pack_name, tone="standard", kind="ghost", size="compact",
                         settings=settings, theme=theme)
        button.clicked.connect(lambda _c=False, n=pack_name: choose_pack(n))
        pack_buttons[pack_name] = button
        pack_row.addWidget(button)
    pack_row.addStretch(1)
    pack_row.addWidget(pack_state)
    pack_card.add_layout(pack_row)
    choose_pack(str(settings.get(K.THEME_PACK, "默认")))
    layout.addWidget(pack_card)

    # ---------- 强调色 ----------
    color_card = UCard("强调色", "只换强调色家族（hover / pressed / 软底 / 实底自动派生）",
                       settings=settings, theme=theme)
    color_row = _Row()
    color_row.setSpacing(8)
    swatches: List[UColorSwatch] = []

    def choose_accent(color: str) -> None:
        settings.set(K.ACCENT, color)
        for swatch in swatches:
            swatch.setChecked(swatch.color().lower() == color.lower())

    for color, label in (("#0D9488", "青"), ("#2563EB", "蓝"), ("#7C3AED", "紫"),
                         ("#DB2777", "粉"), ("#DC2626", "红"), ("#EA580C", "橙"),
                         ("#16A34A", "绿"), ("#475569", "石墨")):
        swatch = UColorSwatch(color, tooltip=label, settings=settings, theme=theme)
        swatch.clicked.connect(lambda _c=False, col=color: choose_accent(col))
        swatches.append(swatch)
        color_row.addWidget(swatch)
    color_row.addStretch(1)
    color_card.add_layout(color_row)
    choose_accent(str(settings.get(K.ACCENT, "#0D9488")))
    layout.addWidget(color_card)

    # ---------- 圆角 / 字号 / 动效档位 ----------
    tuning = UCard("圆角与密度", "圆角一次派生 xs/sm/ctl/md/lg 四档，控件与窗口共用同一套",
                   settings=settings, theme=theme)

    radius_seg = USegmentedControl(settings=settings, theme=theme)
    for label, value in (("紧凑 4", 4), ("标准 8", 8), ("圆润 14", 14)):
        radius_seg.add_segment(label, str(value))
    radius_seg.set_current_index({"4": 0, "8": 1, "14": 2}.get(
        str(settings.get_int(K.RADIUS, 8)), 1))
    radius_seg.segmentChanged.connect(
        lambda _index, key: settings.set(K.RADIUS, int(key)))
    tuning.add_widget(UField("圆角", radius_seg, settings=settings, theme=theme))

    font_seg = USegmentedControl(settings=settings, theme=theme)
    for label, value in (("小 12", 12), ("标准 14", 14), ("大 17", 17)):
        font_seg.add_segment(label, str(value))
    font_seg.set_current_index({"12": 0, "14": 1, "17": 2}.get(
        str(settings.get_int(K.FONT_SIZE, 14)), 1))
    font_seg.segmentChanged.connect(
        lambda _index, key: settings.set(K.FONT_SIZE, int(key)))
    tuning.add_widget(UField("字号", font_seg, settings=settings, theme=theme))
    layout.addWidget(tuning)

    # ---------- 动效档位 ----------
    motion_card = UCard("动效档位", "整体缩放动画时长并换缓动风格，切换后立即生效",
                        settings=settings, theme=theme)
    motion_seg = USegmentedControl(settings=settings, theme=theme)
    for key in ("snappy", "standard", "relaxed"):
        motion_seg.add_segment(str(motion.MOTION_PROFILES[key]["label"]), key)
    order = ("snappy", "standard", "relaxed")
    motion_seg.set_current_index(order.index(str(settings.get(K.MOTION_STYLE, "standard")))
                                 if str(settings.get(K.MOTION_STYLE, "standard")) in order
                                 else 1)
    motion_seg.segmentChanged.connect(
        lambda _index, key: settings.set(K.MOTION_STYLE, key))
    motion_note = UTitle("", role="caption", settings=settings, theme=theme)

    def refresh_motion_note(*_args) -> None:
        motion_note.setText("normal %d ms · panel %d ms · 缓动 %s" % (
            motion.duration("normal"), motion.duration("panel"),
            motion.MOTION_PROFILES[motion.profile()]["easing"]))

    settings.motionStyleChanged.connect(refresh_motion_note)
    refresh_motion_note()
    replay = UButton("重播页面切换动效", tone="standard", size="compact",
                     settings=settings, theme=theme)
    replay.clicked.connect(lambda: window.set_current_index(
        (window.current_index() + 1) % window.page_count()))
    motion_row = _Row()
    motion_row.setSpacing(8)
    motion_row.addWidget(replay)
    motion_row.addStretch(1)
    motion_card.add_widget(UField("档位", motion_seg, settings=settings, theme=theme))
    motion_card.add_widget(motion_note)
    motion_card.add_layout(motion_row)
    layout.addWidget(motion_card)

    # ---------- 显示材质 ----------
    material_card = UCard("显示材质", "控件面与窗口层一起换；系统材质不可用的档位会标灰",
                          settings=settings, theme=theme)
    support = window.available_materials()
    material_row = _Row()
    material_row.setSpacing(6)
    material_buttons: Dict[str, UButton] = {}
    material_state = UStatusPill("", tone="standard", settings=settings, theme=theme)

    def choose_material(name: str) -> None:
        settings.set(K.MATERIAL, name)
        for key, button in material_buttons.items():
            button.set_kind("solid" if key == name else "ghost")
            button.set_tone("accent" if key == name else "standard")
        effective = window.material
        material_state.set_status(
            "生效：%s" % MATERIAL_LABELS.get(effective, effective),
            "success" if effective == name else "warn")

    for material in MATERIALS:
        button = UButton(MATERIAL_LABELS[material], size="compact",
                         settings=settings, theme=theme)
        if not support.get(material, False):
            button.setEnabled(False)
            button.setToolTip("当前平台不支持该系统材质，会自动退化为纯 Qt 观感")
        button.clicked.connect(lambda _c=False, m=material: choose_material(m))
        material_buttons[material] = button
        material_row.addWidget(button)
    material_row.addStretch(1)
    material_row.addWidget(material_state)
    material_card.add_layout(material_row)
    opacity = USlider(settings.get_int(K.MATERIAL_OPACITY, 86), minimum=30,
                      maximum=100, label="材质不透明度",
                      settings=settings, theme=theme)
    opacity.valueChanged.connect(
        lambda value: settings.set(K.MATERIAL_OPACITY, value))
    material_card.add_widget(UField(
        "材质不透明度", opacity, help_text="对半透明 / 毛玻璃 / 系统材质生效，实色忽略此项",
        settings=settings, theme=theme))
    choose_material(str(settings.get(K.MATERIAL, "solid")))
    layout.addWidget(material_card)

    # ---------- 预览 ----------
    preview = UCard("预览", "上面任何一项变化都会立刻反映到这里与整个窗口",
                    settings=settings, theme=theme)
    preview_row = _Row()
    preview_row.setSpacing(8)
    preview_row.addWidget(UButton("主动作", tone="accent", settings=settings, theme=theme))
    preview_row.addWidget(UButton("次要", tone="standard", settings=settings, theme=theme))
    preview_row.addWidget(UButton("危险", tone="danger", settings=settings, theme=theme))
    preview_row.addWidget(UStatusPill("进行中", tone="accent", settings=settings, theme=theme))
    preview_row.addWidget(UStatusPill("已完成", tone="success", settings=settings, theme=theme))
    preview_row.addWidget(ULineEdit("", "输入框", settings=settings, theme=theme))
    preview_row.addStretch(1)
    preview.add_layout(preview_row)
    layout.addWidget(preview)

    layout.addStretch(1)
    return _page(content)


def _forms_page(settings: UISettings, theme: ThemeManager) -> QWidget:
    """表单与反馈：复选框 / 滑块 / 单选与多选下拉 / 日期 / 上传 / 警告提示。"""
    content = QWidget()
    layout = _column(content)
    layout.addWidget(UPageHeader("表单与反馈", "Qt 原控件提供交互语义，框架只负责主题化外观与一致的 API",
                                 settings=settings, theme=theme))

    basic = UCard("选择与输入", settings=settings, theme=theme)
    basic.add_widget(UCheckbox("启用每日提醒", description="每天 9:00 推送今日待办",
                               checked=True, settings=settings, theme=theme))
    basic.add_widget(UCheckbox("仅工作日提醒", description="周末不打扰",
                               settings=settings, theme=theme))
    basic.add_widget(USlider(60, minimum=0, maximum=100, label="提醒强度",
                             settings=settings, theme=theme))
    basic.add_widget(UField("优先级", UComboBox(
        [("高", 3), ("中", 2), ("低", 1)], placeholder="选择优先级",
        settings=settings, theme=theme), settings=settings, theme=theme))
    basic.add_widget(UField("标签", UMultiComboBox(
        ["工作", "生活", "学习", "健康", "阅读"], settings=settings, theme=theme),
        help_text="可多选，收起后显示已选摘要", settings=settings, theme=theme))
    basic.add_widget(UField("截止日期", UDatePicker(settings=settings, theme=theme),
                            settings=settings, theme=theme))
    layout.addWidget(basic)

    upload_card = UCard("文件上传", "拖拽或点选；只负责挑文件与展示，上传行为属于业务",
                        settings=settings, theme=theme)
    upload_card.add_widget(UUpload(hint="支持多选，也可以直接把文件拖进来",
                                   settings=settings, theme=theme))
    layout.addWidget(upload_card)

    alerts = UCard("警告提示", "带标题的提示用于解释原因；一行状态请用 UInfoBar",
                   settings=settings, theme=theme)
    alerts.add_widget(UAlert("数据库迁移失败，已切换到只读模式，可恢复备份后重试",
                             tone="danger", title="同步异常", closable=True,
                             settings=settings, theme=theme))
    alerts.add_widget(UAlert("已保存到本地，联网后会自动同步",
                             tone="success", title="保存成功",
                             settings=settings, theme=theme))
    warn = UAlert("5 分钟后将锁定编辑", tone="warn", title="即将锁定",
                  settings=settings, theme=theme)
    warn.add_action("立即保存")
    alerts.add_widget(warn)
    info = UAlert("首次使用？可以先看快速上手", tone="info", closable=True,
                  settings=settings, theme=theme)
    info.add_action("查看引导")
    alerts.add_widget(info)
    layout.addWidget(alerts)

    layout.addStretch(1)
    return _page(content)


def _demo_pixmap(width: int, height: int, color_a: str, color_b: str):
    """造两张渐变图给图像对比组件用（不依赖外部图片文件）。"""
    from PySide6.QtGui import QColor, QImage, QLinearGradient, QPainter, QPixmap
    image = QImage(width, height, QImage.Format_RGB32)
    painter = QPainter(image)
    gradient = QLinearGradient(0, 0, width, height)
    gradient.setColorAt(0.0, QColor(color_a))
    gradient.setColorAt(1.0, QColor(color_b))
    painter.fillRect(image.rect(), gradient)
    painter.end()
    return QPixmap.fromImage(image)


def _data_page(settings: UISettings, theme: ThemeManager) -> QWidget:
    """数据展示：头像 / 基础表格 / 高级表格 / 图像对比 / 控制台。"""
    content = QWidget()
    layout = _column(content)
    layout.addWidget(UPageHeader("数据展示", "表格分两档：静态小表用 UTable，需要搜索排序分页用 UDataTable",
                                 settings=settings, theme=theme))

    avatars = UCard("头像", settings=settings, theme=theme)
    avatar_row = QHBoxLayout()
    avatar_row.setSpacing(10)
    for name, status in (("知行", "success"), ("李雷", "warn"), ("韩梅梅", ""),
                         ("A", ""), ("B", "danger")):
        avatar_row.addWidget(UAvatar(name, status=status, settings=settings, theme=theme))
    avatar_row.addStretch(1)
    avatars.add_layout(avatar_row)
    layout.addWidget(avatars)

    compare = UCard("图像对比", "拖动中间分割线左右对比（也支持键盘左右方向）",
                    settings=settings, theme=theme)
    viewer = UImageCompare(position=0.5, settings=settings, theme=theme)
    viewer.setFixedHeight(180)
    viewer.set_images(_demo_pixmap(640, 360, "#0D9488", "#1D4ED8"),
                      _demo_pixmap(640, 360, "#DB2777", "#EA580C"))
    compare.add_widget(viewer)
    layout.addWidget(compare)

    simple = UCard("基础表格", "静态小表：一次性填充，默认只读、整行选择",
                   settings=settings, theme=theme)
    table = UTable(["任务", "优先级", "状态"], settings=settings, theme=theme)
    table.setFixedHeight(180)
    table.set_rows([["修复登录超时", "高", "进行中"],
                    ["整理周会纪要", "中", "待处理"],
                    ["回访客户 A", "低", "已完成"],
                    ["补充单元测试", "中", "待处理"]])
    simple.add_widget(table)
    layout.addWidget(simple)

    advanced = UCard("高级表格", "搜索 + 点表头排序 + 分页；只把当前页交给视图，行数恒定",
                     settings=settings, theme=theme)
    data_table = UDataTable(["名称", "所属", "进度", "状态"], page_size=6,
                            settings=settings, theme=theme)
    data_table.setMinimumHeight(340)
    data_table.set_data([["需求梳理", "产品", 100, "已完成"],
                         ["接口设计", "后端", 80, "进行中"],
                         ["界面走查", "设计", 60, "进行中"],
                         ["登录联调", "前端", 45, "进行中"],
                         ["埋点方案", "数据", 20, "待处理"],
                         ["性能压测", "测试", 10, "待处理"],
                         ["文档补全", "产品", 0, "待处理"],
                         ["灰度发布", "运维", 0, "待处理"],
                         ["回归用例", "测试", 90, "已完成"],
                         ["监控看板", "运维", 70, "进行中"],
                         ["权限梳理", "后端", 30, "进行中"],
                         ["文案校对", "设计", 15, "待处理"]])
    advanced.add_widget(data_table)
    layout.addWidget(advanced)

    console_card = UCard("控制台日志", "分级别着色，超过上限自动丢弃最旧的行",
                         settings=settings, theme=theme)
    console = UConsole(max_lines=200, settings=settings, theme=theme)
    console.setFixedHeight(180)
    for text, level in (("正在加载配置…", "debug"),
                        ("数据库连接就绪", "success"),
                        ("同步 12 条任务", "info"),
                        ("磁盘占用 82%，建议清理", "warn"),
                        ("同步失败：connection reset by peer", "error")):
        console.append(text, level)
    console_card.add_widget(console)
    layout.addWidget(console_card)

    layout.addStretch(1)
    return _page(content)


def _navigation_page(settings: UISettings, theme: ThemeManager) -> QWidget:
    """导航组件：侧边菜单 / 顶部栏 / 面包屑 / 标签页 / 分页器 / 下拉菜单。"""
    content = QWidget()
    layout = _column(content)
    layout.addWidget(UPageHeader("导航组件", "这些能力已从窗口壳里抽出来，可嵌进任意布局",
                                 settings=settings, theme=theme))

    top = UCard("顶部栏与面包屑", settings=settings, theme=theme)
    topbar = UTopbar("工作区", "3 个成员 · 同步中", settings=settings, theme=theme)
    topbar.add_action(UDropdown("更多操作", settings=settings, theme=theme))
    topbar.add_action(UButton("新建", tone="accent", size="compact",
                              settings=settings, theme=theme))
    top.add_widget(topbar)
    crumb = UBreadcrumb(["项目", "任务", "修复登录超时"],
                        settings=settings, theme=theme)
    top.add_widget(crumb)
    layout.addWidget(top)

    menu_card = UCard("侧边菜单", "分组 + 选中指示条；可折叠，独立于窗口",
                      settings=settings, theme=theme)
    menu = UMenu(width=170, settings=settings, theme=theme)
    menu.add_group("主导航")
    for key, title in (("today", "今日"), ("tasks", "任务"), ("notes", "笔记")):
        menu.add_item(key, title)
    menu.add_group("其他")
    menu.add_item("settings", "设置", position="bottom")
    menu.setFixedHeight(240)
    menu_card.add_widget(menu)
    menu_card.add_widget(UTitle("折叠按钮已内置在菜单底部（吸附式），点它即可切换",
                               role="caption", settings=settings, theme=theme))
    layout.addWidget(menu_card)

    tabs_card = UCard("标签页", "同一工作区里的平级视图", settings=settings, theme=theme)
    tabs = UTabs(settings=settings, theme=theme)
    tabs.setFixedHeight(160)
    tabs.add_tab(UTitle("概览内容", role="body", settings=settings, theme=theme), "概览")
    tabs.add_tab(UTitle("设置内容", role="body", settings=settings, theme=theme), "设置")
    tabs.add_tab(UTitle("日志内容", role="body", settings=settings, theme=theme), "日志")
    tabs_card.add_widget(tabs)
    layout.addWidget(tabs_card)

    pager_card = UCard("分页器", "程序化 set_page 不发信号，避免刷新递归",
                       settings=settings, theme=theme)
    pager = UPagination(page_size=10, settings=settings, theme=theme)
    pager.set_total(87)
    pager_card.add_widget(pager)
    layout.addWidget(pager_card)

    layout.addStretch(1)
    return _page(content)



def _interactive_page(settings: UISettings, theme: ThemeManager) -> QWidget:
    """交互动效页：10 个带动效的复合组件。"""
    content = QWidget()
    layout = _column(content)
    layout.addWidget(UPageHeader(
        "交互动效", "十个带动效的复合组件；动画统一走 motion，尊重动效开关与档位",
        settings=settings, theme=theme))

    # 1 折叠卡片
    collapse = UCollapseCard("① 折叠卡片", settings=settings, theme=theme)
    collapse.add_widget(UTitle("高度、内容透明度、箭头角度共用同一条缓动曲线 —— "
                               "不会出现「高度到了箭头还在转」的错位。",
                               role="body", wrap=True, settings=settings, theme=theme))
    layout.addWidget(collapse)

    # 2 分段控件 + 内容横向切换
    segment_card = UCard("② 分段控件", "选中块跟随位移，内容区同步横向切换",
                         settings=settings, theme=theme)
    segment = USegmentedControl(settings=settings, theme=theme)
    stack = QStackedWidget()
    stack.setMinimumHeight(72)
    for text in ("列表视图内容", "看板视图内容", "日历视图内容"):
        page_widget = QWidget()
        box = QVBoxLayout(page_widget)
        box.setContentsMargins(12, 12, 12, 12)
        box.addWidget(UTitle(text, role="body", settings=settings, theme=theme))
        stack.addWidget(page_widget)
    for text in ("列表", "看板", "日历"):
        segment.add_segment(text, text)
    segment.bind_stack(stack)
    segment_card.add_widget(segment)
    segment_card.add_widget(stack)
    layout.addWidget(segment_card)

    # 3 滑动确认条
    swipe_card = UCard("③ 滑动确认条", "滑过八成才触发，不到就回弹",
                       settings=settings, theme=theme)
    swipe = USwipeConfirm("滑动以删除这条记录", threshold=0.8, settings=settings,
                          theme=theme)
    swipe_card.add_widget(swipe)
    swipe_hint = UTitle("", role="caption", settings=settings, theme=theme)
    swipe.confirmed.connect(lambda: swipe_hint.setText("已确认（滑够了）"))
    swipe_card.add_widget(swipe_hint)
    layout.addWidget(swipe_card)

    # 4 翻转卡片
    flip = UFlipCard(settings=settings, theme=theme)
    flip.setMinimumHeight(120)
    front = QFrame()
    front_box = QVBoxLayout(front)
    front_box.addWidget(UTitle("④ 翻转卡片 · 正面", role="subtitle",
                               settings=settings, theme=theme))
    front_box.addWidget(UTitle("核心信息放这里", role="body", settings=settings,
                               theme=theme))
    back = QFrame()
    back_box = QVBoxLayout(back)
    back_box.addWidget(UTitle("背面 · 规则说明", role="subtitle",
                              settings=settings, theme=theme))
    back_box.addWidget(UTitle("翻转会在最窄处换面，而不是突然跳变", role="caption",
                              wrap=True, settings=settings, theme=theme))
    flip.front = front
    flip.back = back
    for face, name in ((front, "UFlipFront"), (back, "UFlipBack")):
        face.setParent(flip)
        face.setObjectName(name)
        face.setAttribute(Qt.WA_StyledBackground, True)
    flip.front.setVisible(True)
    flip.back.setVisible(False)
    flip_card = UCard("④ 翻转卡片", "点按钮翻转，中途换面", settings=settings, theme=theme)
    flip_button = UButton("翻转", tone="accent", size="compact", settings=settings,
                          theme=theme)
    flip_button.clicked.connect(flip.flip)
    flip_card.add_widget(flip_button)
    flip_card.add_widget(flip)
    layout.addWidget(flip_card)

    # 5 操作型卡片
    action = UActionCard("⑤ 操作型卡片", "加减 / 开关 / 滑块就地生效，并回显结果",
                         settings=settings, theme=theme)
    action.add_stepper("count", "数量", 3, maximum=10)
    action.add_switch("notify", "启用提醒", True)
    action.add_slider("volume", "音量", 40)
    layout.addWidget(action)

    # 6 筛选胶囊
    chips_card = UCard("⑥ 筛选胶囊", "选中态实底，超出宽度横向滚动",
                       settings=settings, theme=theme)
    chips = UFilterChips(settings=settings, theme=theme)
    for text in ("全部", "今天", "本周", "已完成", "高优先级", "带附件", "已归档",
                 "我负责的", "有截止日期"):
        chips.add_chip(text)
    chips_card.add_widget(chips)
    chips_hint = UTitle("", role="caption", settings=settings, theme=theme)
    chips.selectionChanged.connect(
        lambda keys: chips_hint.setText("已选：" + ("、".join(keys) or "无")))
    chips_card.add_widget(chips_hint)
    layout.addWidget(chips_card)

    # 7 进度卡片
    progress = UProgressCard("⑦ 进度卡片", settings=settings, theme=theme)
    progress.set_steps([("需求评审", "确认范围与验收标准，输出评审结论"),
                        ("开发完成", "自测通过并提测，附变更说明"),
                        ("测试通过", "回归无阻断缺陷，性能达标"),
                        ("已发布", "灰度 10%，观察 24 小时无异常后全量")])
    layout.addWidget(progress)

    # 8 吸底操作栏
    bottom_card = UCard("⑧ 吸底操作栏", "左边关键信息，右边主按钮，底部留安全区",
                        settings=settings, theme=theme)
    bottom = UBottomBar("合计 ¥128.00", "含运费 · 7 天无理由", action_text="提交订单",
                        safe_margin=8, settings=settings, theme=theme)
    bottom.actionTriggered.connect(
        lambda: bottom.set_subtitle("已提交（演示）"))
    bottom_card.add_widget(bottom)
    layout.addWidget(bottom_card)

    # 9 格式化输入框
    masked_card = UCard("⑨ 格式化输入框", "日期与时间自动分隔，右侧常驻单位与字数",
                        settings=settings, theme=theme)
    masked_card.add_widget(UField(
        "日期", UMaskedInput("####-##-##", placeholder="20260913", unit="日",
                             max_length=8, label="日期", settings=settings, theme=theme),
        help_text="输入 8 位数字会自动补成 2026-09-13", settings=settings, theme=theme))
    masked_card.add_widget(UField(
        "时间", UMaskedInput("##:##", placeholder="0930", unit="UTC+8", max_length=4,
                             label="时间", settings=settings, theme=theme),
        settings=settings, theme=theme))
    masked_card.add_widget(UField(
        "金额", UMaskedInput("####.##", placeholder="0.00", unit="元", max_length=6,
                             label="金额", settings=settings, theme=theme),
        settings=settings, theme=theme))
    layout.addWidget(masked_card)

    # 10 顶部标签页
    tabs_card = UCard("⑩ 顶部标签页", "下划线跟手位移，选中标签自动滚动居中",
                      settings=settings, theme=theme)
    strip = UTabStrip(settings=settings, theme=theme)
    for index in range(9):
        strip.add_tab("标签 %d" % (index + 1))
    tabs_card.add_widget(strip)
    tabs_hint = UTitle("", role="caption", settings=settings, theme=theme)
    strip.currentChanged.connect(
        lambda index, key: tabs_hint.setText("当前：%s" % key))
    tabs_card.add_widget(tabs_hint)
    layout.addWidget(tabs_card)

    layout.addStretch(1)
    return _page(content)



def _settings_page(settings: UISettings, theme: ThemeManager) -> QWidget:
    """全部设置页：框架所有可配置项的唯一入口（由 schema 自动生成）。"""
    content = QWidget()
    layout = _column(content)
    layout.addWidget(UPageHeader(
        "全部设置",
        "框架里没有任何硬编码的颜色 / 尺寸 / 时长 —— 这里改的每一项都会立即生效",
        settings=settings, theme=theme))

    hint = UTitle(
        "下面每一组都由 UISettings.schema() 声明、USettingsPanel 自动生成："
        "新增一项设置只需在 SCHEMA_SPECS 里加一条，这个页面不用改。",
        role="body", wrap=True, settings=settings, theme=theme)
    layout.addWidget(hint)

    panel = USettingsPanel(settings=settings, theme=theme)
    layout.addWidget(panel)

    live = UTitle("", role="caption", settings=settings, theme=theme)
    panel.changed.connect(
        lambda key, value: live.setText("最近改动：%s = %s" % (key, value)))
    layout.addWidget(live)
    return _page(content)



def build_gallery_window(settings: Optional[UISettings] = None,
                        theme: Optional[ThemeManager] = None) -> FluentTemplateWindow:
    """构造画廊窗口（main 用于显示，测试直接调用做结构校验）。"""
    settings = settings or UISettings()
    theme = theme or ThemeManager()
    window = FluentTemplateWindow(None, "qfluent_core 组件库", signature="组件画廊",
                                 command_placeholder=" 搜索组件… ",
                                 settings=settings, theme=theme,
                                 nav_width=200, nav_collapsed_width=48)
    window.add_page(_theme_page(settings, theme, window), "主题与材质", key="theme")
    window.add_page(_actions_page(settings, theme), "动作与输入", key="actions")
    window.add_page(_surfaces_page(settings, theme), "容器与层级", key="surfaces")
    window.add_page(_status_page(settings, theme), "状态与反馈", key="status")
    window.add_page(_forms_page(settings, theme), "表单与反馈", key="forms")
    window.add_page(_interactive_page(settings, theme), "交互动效", key="interactive")
    window.add_page(_settings_page(settings, theme), "全部设置", key="settings")
    window.add_page(_data_page(settings, theme), "数据展示", key="data")
    window.add_page(_navigation_page(settings, theme), "导航组件", key="nav")
    window.add_page(_overlays_page(settings, theme, window), "浮层", key="overlays",
                    position="bottom")
    return window


def main(argv: Optional[List[str]] = None) -> int:
    argv = list(sys.argv if argv is None else argv)
    app = QApplication.instance() or QApplication(argv)
    settings = UISettings()
    UISettings.install(settings)
    window = build_gallery_window(settings)
    window.resize(1180, 780)
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
