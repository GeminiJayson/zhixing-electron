# -*- coding: utf-8 -*-
"""设置页：外观（主题包/强调色/Mica/动效）、任务、番茄钟、捕获、浮窗、数据、快捷键、关于。"""
from pathlib import Path

from PySide6.QtCore import Qt, QUrl, Signal
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (QDialog, QFileDialog, QFormLayout, QFrame, QGridLayout, QHBoxLayout, QLayout, QScrollArea, QVBoxLayout, QWidget)

from ...core import settings_keys as K
from ...core.constants import (
    CONTROL_HEIGHT_MAX, CONTROL_HEIGHT_MIN, FONT_SIZE_MAX, FONT_SIZE_MIN,
)
from ...core.async_task import run_in_background
from ..kit import icons
from ..kit.control_style import (
    clear_fixed_height, restyle_spinbox, restyle_switch_button,
)
from ..kit.flow_layout import FlowLayout
from qfluent_core import ThemeManager as ThemeEngine
from ..ui import UCard, UTitle, BusySpinner, PageHeader
from zhixing.view.kit.fluent_compat import QLabel, QPushButton, QSlider, QTabWidget
from zhixing.view.kit.fluent_compat import InfoBar, InfoBarPosition, MessageBox

#: 强调色预设（原先定义在 kit/theme.py，随其退场迁到这里）
ACCENT_CHOICES = [
    ("青", "#0D9488"), ("蓝", "#2563EB"), ("紫", "#7C3AED"), ("粉", "#DB2777"),
    ("红", "#DC2626"), ("橙", "#EA580C"), ("琥珀", "#D97706"), ("绿", "#16A34A"),
]

# 第三方 UI 库已退场：这些名字现在由兼容层提供（指向框架组件）。
from zhixing.view.kit.fluent_compat import (
    ComboBox, LineEdit, PrimaryPushButton, SpinBox, SwitchButton,
)


def _fg2() -> str:
    eng = ThemeEngine.instance()
    return eng.t("fg2", "#6B7280") if eng else "#6B7280"


class SettingsPage(QWidget):
    themeChanged = Signal(str, str, str)     # pack, mode, accent
    restartWidgets = Signal()
    hotkeyRebindStartRequested = Signal()    # 改键开始：请求注销旧热键（避免 EventTap 拦截按键捕获）
    hotkeyRebindRequested = Signal()         # 热键改键后请求重新注册

    def __init__(self, context, parent=None):
        super().__init__(parent)
        self.ctx = context
        self._bg = []  # 后台 Worker 引用，防止中途被 GC
        lay = QVBoxLayout(self)
        lay.setContentsMargins(24, 18, 24, 12)
        lay.setSpacing(12)

        self.header = PageHeader("设置", "在此处配置应用的外观、行为及快捷键偏好")
        lay.addWidget(self.header)

        tabs = QTabWidget()
        tabs.setDocumentMode(False)
        tabs.addTab(self._make_tab([("外观", self._build_appearance())]), "外观")
        tabs.addTab(self._make_tab([
            ("任务与提醒", self._build_tasks()),
            ("番茄钟", self._build_pomodoro()),
            ("标签管理", self._build_tags()),
        ]), "任务与番茄钟")
        tabs.addTab(self._make_tab([
            ("捕获", self._build_capture()),
            ("桌面浮窗", self._build_widget()),
        ]), "捕获与浮窗")
        tabs.addTab(self._make_tab([("快捷键一览", self._build_hotkeys())]), "快捷键")
        tabs.addTab(self._make_tab([
            ("数据", self._build_data()),
            ("关于", self._build_about()),
        ]), "数据与关于")
        from ..kit.motion import attach_tab_fade
        attach_tab_fade(tabs)
        lay.addWidget(tabs, 1)
        tabs.currentChanged.connect(lambda _i: self.header.play_enter())

        # 控件高度随「控件高度」设置项即时刷新：qfluentwidgets 的 SpinBox/LineEdit
        # 内部 setFixedHeight(33)，会锁死设置页控件高度，这里在构造后移除上限并读设置重设。
        if ThemeEngine.instance() is not None:
            ThemeEngine.instance().changed.connect(self._apply_control_heights)
        self._apply_control_heights()

    # ================= Tab 结构 =================
    def _make_tab(self, cards):
        """cards: [(title, layout), ...] → 可滚动的 Tab 页，内部垂直堆叠 UCard。"""
        page = QWidget()
        lay = QVBoxLayout(page)
        lay.setContentsMargins(20, 16, 20, 16)
        lay.setSpacing(14)
        for title, inner in cards:
            lay.addWidget(_card(title, inner))
        lay.addStretch(1)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.NoFrame)
        # 第12项：设置页不出现横向滚动——内容宽度限制在视口内，字段放不下时由
        # 内部网格/流式布局换行承接，绝不横向溢出（窄窗时表单列可收缩）。
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setWidget(page)
        return scroll

    def _form(self):
        """统一 QFormLayout：标签右对齐 + 垂直居中，控件左对齐，形成隐形对齐线。"""
        form = QFormLayout()
        form.setHorizontalSpacing(18)
        form.setVerticalSpacing(10)
        form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)
        form.setFormAlignment(Qt.AlignTop)
        return form

    # ================= 分区 =================
    def _apply_control_heights(self):
        # 原先要给 qfluentwidgets 的控件逐个解除 setFixedHeight(33) ——
        # 那些控件已换成框架组件，高度由 token 统一控制，这里不再需要做什么。
        return

    def _build_appearance(self):
        """外观：QFormLayout 表单布局（标签 + 控件逐行，主题包/强调色用 FlowLayout 换行）。"""
        form = self._form()

        s = self.ctx.settings

        mode_combo = ComboBox()
        mode_combo.addItems(["跟随系统", "浅色", "深色"])
        mode_combo.setCurrentIndex({"system": 0, "light": 1, "dark": 2}.get(
            s.get(K.K_THEME_MODE, "system"), 0))
        mode_combo.currentIndexChanged.connect(
            lambda i: self._set_theme(mode_key=["system", "light", "dark"][i]))
        form.addRow("模式", mode_combo)

        pack_row = FlowLayout(hspacing=6, vspacing=4)
        for name in self.ctx.theme_engine.packs:
            b = QPushButton(name)
            b.setCheckable(True)
            b.setChecked(name == self.ctx.theme_engine.pack_name)
            b.clicked.connect(lambda _=False, n=name: self._set_theme(pack=n))
            pack_row.addWidget(b)
        form.addRow("主题包", pack_row)

        accent_row = FlowLayout(hspacing=6, vspacing=4)
        for label, color in ACCENT_CHOICES:
            b = QPushButton(label)
            b.setFixedWidth(52)
            b.setStyleSheet(f"QPushButton {{ background: {color}; color: white;"
                            f"border-radius: 6px; }}"
                            f"QPushButton:checked {{ border: 2px solid white; }}")
            b.clicked.connect(lambda _=False, c=color: self._set_theme(accent=c))
            accent_row.addWidget(b)
        form.addRow("强调色", accent_row)

        mica = SwitchButton()
        mica.setChecked(s.get_bool(K.K_MICA, True))
        mica.checkedChanged.connect(lambda v: s.set_bool(K.K_MICA, v))
        form.addRow("Mica 材质", mica)

        motion_combo = ComboBox()
        motion_combo.addItems(["完整", "减弱"])
        motion_combo.setCurrentIndex(0 if s.get(K.K_MOTION, "full") == "full" else 1)
        motion_combo.currentIndexChanged.connect(
            lambda i: s.set(K.K_MOTION, "full" if i == 0 else "reduced"))
        form.addRow("动效", motion_combo)

        control_h = SpinBox()
        control_h.setObjectName("controlHeightSpin")
        control_h.setRange(CONTROL_HEIGHT_MIN, CONTROL_HEIGHT_MAX)
        control_h.setValue(s.get_int(K.K_CONTROL_HEIGHT, 32))
        control_h.valueChanged.connect(lambda v: s.set(K.K_CONTROL_HEIGHT, str(v)))
        form.addRow("控件高度（px）", control_h)

        font_size = SpinBox()
        font_size.setObjectName("fontSizeSpin")
        font_size.setRange(FONT_SIZE_MIN, FONT_SIZE_MAX)
        font_size.setValue(s.get_int(K.K_FONT_SIZE, 14))
        font_size.valueChanged.connect(lambda v: s.set(K.K_FONT_SIZE, str(v)))
        form.addRow("字号（px）", font_size)

        signature = LineEdit()
        signature.setPlaceholderText("如：知行合一")
        signature.setText(s.get(K.K_SIGNATURE, "知行合一"))
        signature.textChanged.connect(lambda t: s.set(K.K_SIGNATURE, t))
        # 与其他设置项控件统一高度（解除 qfluentwidgets 内部 setFixedHeight）
        clear_fixed_height(signature, s.get_int(K.K_CONTROL_HEIGHT, 32))
        form.addRow("标题栏签名", signature)

        return form

    def _build_tasks(self):
        form = self._form()
        s = self.ctx.settings

        rem = SwitchButton()
        rem.setChecked(s.get_bool(K.K_REMINDER_ENABLED, True))
        rem.checkedChanged.connect(lambda v: s.set_bool(K.K_REMINDER_ENABLED, v))
        form.addRow("到期提醒", rem)

        row_h = SpinBox()
        row_h.setRange(24, 72)
        row_h.setValue(s.get_int(K.K_TASK_ROW_HEIGHT, 38))
        row_h.valueChanged.connect(lambda v: s.set(K.K_TASK_ROW_HEIGHT, str(v)))
        form.addRow("任务行高（px）", row_h)

        indent = SpinBox()
        indent.setRange(8, 48)
        indent.setValue(s.get_int(K.K_TASK_INDENT, 20))
        indent.valueChanged.connect(lambda v: s.set(K.K_TASK_INDENT, str(v)))
        form.addRow("子任务缩进（px）", indent)

        show_done = SwitchButton()
        show_done.setChecked(s.get_bool(K.K_CALENDAR_SHOW_DONE, False))
        show_done.checkedChanged.connect(lambda v: s.set_bool(K.K_CALENDAR_SHOW_DONE, v))
        form.addRow("日历显示已完成任务", show_done)

        return form

    def _build_tags(self):
        """标签管理（F1-6/#5）：增删改/重命名/合并入口。"""
        form = self._form()
        open_btn = QPushButton("打开标签管理…")
        open_btn.clicked.connect(self._open_tag_manager)
        hint = QLabel("重命名、合并、删除与新增标签；作用于任务与笔记。")
        hint.setStyleSheet(f"color: {_fg2()};")
        row = QHBoxLayout()
        row.addWidget(open_btn)
        row.addWidget(hint)
        row.addStretch(1)
        form.addRow("标签", row)
        return form

    def _open_tag_manager(self):
        from ..components.tag_manager import TagManagerDialog
        if not getattr(self.ctx, "note_service", None):
            _toast(self, "笔记服务未就绪，无法管理标签")
            return
        dlg = TagManagerDialog(self.ctx.note_service, self.window())
        dlg.exec()

    def _build_pomodoro(self):
        form = self._form()
        s = self.ctx.settings

        focus = SpinBox()
        focus.setRange(5, 90)
        focus.setValue(s.get_int(K.K_POMO_FOCUS, 25))
        focus.valueChanged.connect(lambda v: s.set_int(K.K_POMO_FOCUS, v) if hasattr(
            s, "set_int") else s.set(K.K_POMO_FOCUS, str(v)))
        form.addRow("专注时长（分钟）", focus)

        brk = SpinBox()
        brk.setRange(1, 30)
        brk.setValue(s.get_int(K.K_POMO_BREAK, 5))
        brk.valueChanged.connect(lambda v: s.set(K.K_POMO_BREAK, str(v)))
        form.addRow("休息时长（分钟）", brk)

        auto = SwitchButton()
        auto.setChecked(s.get_bool(K.K_AUTO_START_BREAK, False))
        auto.checkedChanged.connect(lambda v: s.set_bool(K.K_AUTO_START_BREAK, v))
        form.addRow("专注结束自动休息", auto)

        return form

    def _build_capture(self):
        form = self._form()
        s = self.ctx.settings
        self._hotkey_edits = {}
        self._hotkey_state_labels = {}
        for label, key in [
                ("划词捕获热键", K.K_CAPTURE_HOTKEY),
                ("读取选中并速记热键", K.K_SELECT_HOTKEY),
                ("快速任务热键", K.K_QUICK_HOTKEY),
                ("浮窗显隐热键", K.K_WIDGET_HOTKEY)]:
            edit = LineEdit()
            # 创建处立刻解除 qfluentwidgets 内部固定高（与其他设置项输入框一致；
            # 即便控件随后进入只读态也不影响高度，见 _apply_control_heights）
            clear_fixed_height(edit, s.get_int(K.K_CONTROL_HEIGHT, 32))
            edit.setText(s.get(key, ""))
            edit.setReadOnly(True)
            self._hotkey_edits[key] = edit
            rebind = QPushButton("改键")
            rebind.clicked.connect(lambda _=False, k=key: self._rebind_hotkey(k))
            # 状态 QLabel：仅有实际状态文本（如「✓ 已注册」）时才占用行内空间，
            # 无状态时隐藏，避免悬空显示占位符 "—"
            text = (getattr(self.ctx, "hotkey_status", None) or {}).get(key, "").strip()
            state = QLabel(text)
            state.setStyleSheet(f"color: {_fg2()};")
            state.setVisible(bool(text))
            self._hotkey_state_labels[key] = state
            row = QHBoxLayout()
            row.addWidget(edit, 1)
            row.addWidget(rebind)
            row.addWidget(state)
            form.addRow(label, row)

        clip = SwitchButton()
        clip.setChecked(s.get_bool(K.K_CLIPBOARD_MONITOR, False))
        clip.checkedChanged.connect(lambda v: s.set_bool(K.K_CLIPBOARD_MONITOR, v))
        form.addRow("剪贴板监听", clip)

        hint = QLabel("检测到新复制文本时轻提示「捕获？」（默认关）。macOS 需在 系统设置→隐私与安全性→辅助功能 中授权，未授权时划词自动降级为「剪贴板捕获」。")
        hint.setWordWrap(True)
        hint.setStyleSheet(f"color: {_fg2()}; font-size: 12px;")
        form.addRow("", hint)

        return form

    def _rebind_hotkey(self, key):
        # 改键期间先注销旧热键，避免旧 EventTap 拦截组合键捕获（导致对话框收不到按键）
        self.hotkeyRebindStartRequested.emit()
        dlg = HotkeyCaptureDialog(self)
        if dlg.exec() and dlg.captured:
            hk = dlg.captured
            self.ctx.settings.set(key, hk)
            if key in self._hotkey_edits:
                self._hotkey_edits[key].setText(hk)
        # 无论成功/取消，都重新注册热键（恢复）
        self.hotkeyRebindRequested.emit()
        # 重注册后控制器会同步更新 hotkey_status，这里刷新状态标签
        self._refresh_hotkey_status()

    def _refresh_hotkey_status(self):
        """按 context.hotkey_status 刷新热键行状态 QLabel（有文本才显示）。"""
        status = getattr(self.ctx, "hotkey_status", None) or {}
        for key, lbl in getattr(self, "_hotkey_state_labels", {}).items():
            text = status.get(key, "").strip()
            lbl.setText(text)
            lbl.setVisible(bool(text))

    def _build_widget(self):
        form = self._form()
        s = self.ctx.settings

        w = SwitchButton()
        w.setChecked(s.get_bool(K.K_WIDGET_ENABLED, True))
        w.checkedChanged.connect(lambda v: (s.set_bool(K.K_WIDGET_ENABLED, v),
                                            self.restartWidgets.emit()))
        form.addRow("启用桌面浮窗", w)

        
        slider = QSlider(Qt.Horizontal)
        slider.setRange(60, 100)
        slider.setValue(s.get_int(K.K_WIDGET_OPACITY, 85))
        slider.valueChanged.connect(lambda v: s.set(K.K_WIDGET_OPACITY, str(v)))
        form.addRow("透明度", slider)

        c = SwitchButton()
        c.setChecked(s.get_bool(K.K_CLOSE_TO_WIDGET, True))
        c.checkedChanged.connect(lambda v: s.set_bool(K.K_CLOSE_TO_WIDGET, v))
        form.addRow("关闭主窗口时缩到浮窗", c)

        ct = SwitchButton()
        ct.setChecked(s.get_bool(K.K_WIDGET_CLICK_THROUGH, False))
        ct.checkedChanged.connect(lambda v: s.set_bool(K.K_WIDGET_CLICK_THROUGH, v))
        form.addRow("鼠标穿透", ct)

        auto = SwitchButton()
        auto.setChecked(s.get_bool(K.K_AUTO_START, False))
        auto.checkedChanged.connect(lambda v: s.set_bool(K.K_AUTO_START, v))
        form.addRow("开机自启", auto)

        return form

    def _build_data(self):
        form = self._form()
        s = self.ctx.settings
        from ...model.infrastructure.db import db_path

        path_lbl = QLabel(str(db_path()))
        path_lbl.setStyleSheet(f"color: {_fg2()};")
        open_dir = QPushButton("打开目录")
        open_dir.clicked.connect(
            lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(str(db_path().parent))))
        path_row = QHBoxLayout()
        path_row.addWidget(path_lbl, 1)
        path_row.addWidget(open_dir)
        form.addRow("数据位置", path_row)

        btns = [
            (QPushButton("立即备份"), self._do_backup),
            (QPushButton("恢复备份…"), self._do_restore),
            (QPushButton("导出 JSON"), self._export_json),
            (QPushButton("导出笔记 MD"), self._export_md),
            (QPushButton("导出任务 CSV"), self._export_csv),
            (QPushButton("导入 MD 文件夹…"), self._import_md),
            (QPushButton("导入 JSON 备份…"), self._import_json),
            (QPushButton("回收站…"), self._open_recycle),
        ]
        btn_flow = FlowLayout(hspacing=8, vspacing=8)
        for b, fn in btns:
            b.clicked.connect(fn)
            btn_flow.addWidget(b)
        form.addRow("备份与恢复", btn_flow)

        retention = SpinBox()
        retention.setRange(1, 365)
        retention.setValue(s.get_int(K.K_RECYCLE_RETENTION, 30))
        retention.valueChanged.connect(lambda v: s.set(K.K_RECYCLE_RETENTION, str(v)))
        form.addRow("回收站保留天数", retention)

        # 骨架屏/自转圈（#11）：后台耗时操作期间显示
        self.busy = BusySpinner()
        self.busy.setVisible(False)
        form.addRow("", self.busy)

        return form

    def _import_json(self):
        path, _ = QFileDialog.getOpenFileName(self, "导入全量 JSON 备份", "",
                                              "JSON (*.json)")
        if not path:
            return
        
        box = MessageBox("导入 JSON", "导入将覆盖当前全部数据，且会先自动备份。是否继续？",
                         self.window())
        box.yesButton.setText("导入")
        box.cancelButton.setText("取消")
        if not box.exec():
            return
        try:
            self.ctx.backup.backup(reason="pre-import")
            result = self.ctx.importer.import_json(Path(path))
            self.ctx.bus.backup_restored.emit()
            _toast(self, f"已导入：任务 {result.get('tasks', 0)} · 笔记 {result.get('notes', 0)}")
        except Exception as e:  # noqa: BLE001
            _toast(self, f"导入失败：{e}")

    def _open_recycle(self):
        from ..components.recycle_bin import RecycleBinDialog
        dlg = RecycleBinDialog(self.ctx, self.window())
        dlg.exec()

    def _build_hotkeys(self):
        """快捷键一览：左列功能名称、右列快捷键组合（键盘边框视觉封装）。"""
        grid = QGridLayout()
        grid.setHorizontalSpacing(16)
        grid.setVerticalSpacing(8)
        rows = [
            ("命令面板 / 全局搜索", "Ctrl+K"),
            ("快速捕获", "Ctrl+N"),
            ("新建笔记", "Ctrl+Shift+N"),
            ("编辑 / 预览切换", "Ctrl+E"),
            ("打开设置", "Ctrl+,"),
            ("最近两页切换", "Ctrl+Tab"),
            ("页内搜索聚焦", "Ctrl+F"),
            ("折叠侧栏", "Ctrl+B"),
            ("切换页面", "Ctrl+1..6"),
            ("撤销最近完成 / 恢复", "Ctrl+Z"),
            ("划词捕获（全局）", "Ctrl+Shift+S"),
            ("读取选中并速记（全局）", "Ctrl+Shift+U"),
            ("快速任务（全局）", "Ctrl+Alt+N"),
            ("桌面浮窗显隐（全局）", "Ctrl+Shift+D"),
            ("列表完成 / 取消", "Space"),
            ("子任务折叠 / 展开", "←/→"),
            ("移动任务排序", "Ctrl+↑/↓"),
            ("重命名选中项", "F2"),
        ]
        eng = ThemeEngine.instance()
        kbd_bg = eng.t("hover", "#F1F5F3") if eng else "#F1F5F3"
        kbd_fg = eng.t("fg", "#1A1A1A") if eng else "#1A1A1A"
        kbd_border = eng.t("border2", "#CBD8D0") if eng else "#CBD8D0"
        for r, (desc, key) in enumerate(rows):
            d = QLabel(desc)
            d.setAlignment(Qt.AlignLeft | Qt.AlignVCenter)
            k = QLabel(key)
            k.setAlignment(Qt.AlignLeft | Qt.AlignVCenter)
            k.setStyleSheet(
                f"QLabel {{ background: {kbd_bg}; color: {kbd_fg};"
                f"border: 1px solid {kbd_border}; border-radius: 4px;"
                f"padding: 2px 8px; font-weight: bold; }}")
            grid.addWidget(d, r, 0)
            grid.addWidget(k, r, 1)
        grid.setColumnStretch(0, 1)
        grid.setColumnStretch(1, 1)
        return grid

    def _build_about(self):
        from ... import __version__
        grid = QGridLayout()
        grid.addWidget(QLabel(f"知行 ZhiXing v{__version__} · 本地优先的个人待办与知识图谱"
                              " · 数据 100% 存于本机"), 0, 0)
        return grid

    # ================= 动作 =================
    def _set_theme(self, pack=None, mode_key=None, accent=None):
        eng = self.ctx.theme_engine
        pack = pack or eng.pack_name
        accent = accent or eng.accent
        mode_key = mode_key or ("dark" if eng.mode == "dark" else "light")
        if mode_key == "system":
            mode_key = "system"
        self.ctx.settings.set(K.K_THEME_PACK, pack)
        self.ctx.settings.set(K.K_THEME_MODE, mode_key)
        self.ctx.settings.set(K.K_ACCENT, accent)
        self.themeChanged.emit(pack, mode_key, accent)

    def _set_busy(self, busy: bool):
        if hasattr(self, "busy"):
            self.busy.setVisible(busy)

    def _do_backup(self):
        def _run():
            path = self.ctx.backup.backup(reason="manual")
            return f"已备份：{path.name}" if path else "备份失败"

        self._set_busy(True)
        run_in_background(_run,
                          on_done=lambda m: (self._set_busy(False), _toast(self, m)),
                          holder=self._bg,
                          on_error=lambda e: (self._set_busy(False), _toast(self, f"备份失败：{e}")))

    def _do_restore(self):
        backups = self.ctx.backup.list_backups()
        if not backups:
            _toast(self, "暂无备份文件")
            return
        
        names = "\n".join(f"· {b.name}" for b in backups[:10])
        box = MessageBox("恢复备份", f"将恢复：\n{names}\n\n当前数据会先自动备份。",
                         self.window())
        box.yesButton.setText("恢复")
        box.cancelButton.setText("取消")
        if box.exec():
            self.ctx.backup.restore(backups[0])
            self.ctx.bus.backup_restored.emit()
            _toast(self, "已恢复，界面已刷新")

    def _export_json(self):
        path, _ = QFileDialog.getSaveFileName(self, "导出全量 JSON", "zhixing-export.json",
                                              "JSON (*.json)")
        if path:
            def _run():
                self.ctx.exporter.export_json(Path(path))
                return f"已导出 JSON"

            run_in_background(_run,
                              on_done=lambda m: _toast(self, m),
                              holder=self._bg,
                              on_error=lambda e: _toast(self, f"导出失败：{e}"))

    def _export_md(self):
        path, _ = QFileDialog.getSaveFileName(self, "导出笔记 Markdown", "notes.zip",
                                              "ZIP (*.zip)")
        if path:
            def _run():
                self.ctx.exporter.export_notes_markdown(Path(path))
                return "已导出 Markdown 压缩包"

            run_in_background(_run,
                              on_done=lambda m: _toast(self, m),
                              holder=self._bg,
                              on_error=lambda e: _toast(self, f"导出失败：{e}"))

    def _export_csv(self):
        path, _ = QFileDialog.getSaveFileName(self, "导出任务 CSV", "tasks.csv", "CSV (*.csv)")
        if path:
            def _run():
                self.ctx.exporter.export_tasks_csv(Path(path))
                return "已导出任务 CSV"

            run_in_background(_run,
                              on_done=lambda m: _toast(self, m),
                              holder=self._bg,
                              on_error=lambda e: _toast(self, f"导出失败：{e}"))

    def _import_md(self):
        folder = QFileDialog.getExistingDirectory(self, "选择 Markdown 文件夹")
        if folder:
            count = self.ctx.importer.import_markdown_folder(Path(folder), self.ctx.note_service)
            self.ctx.bus.note_structure_changed.emit(0, "note_imported")
            _toast(self, f"已导入 {count} 篇笔记")


def _title(text):
    lbl = QLabel(text)
    f = lbl.font()
    f.setPixelSize(15)
    f.setBold(True)
    lbl.setFont(f)
    return lbl


def _card(title: str, inner):
    """设置分类 = 沉浸 UCard（title + 内容）。inner 可为 QWidget 或布局。"""
    c = UCard(title)
    if isinstance(inner, QLayout):
        w = QWidget()
        w.setLayout(inner)
        c.add_widget(w, 1)
    else:
        c.add_widget(inner, 1)
    return c


def _section(inner: QWidget):
    frame = QFrame()
    lay = QVBoxLayout(frame)
    lay.setContentsMargins(14, 10, 14, 10)
    if isinstance(inner, QLayout):
        wrap = QWidget()
        wrap.setLayout(inner)
        lay.addWidget(wrap)
    else:
        lay.addWidget(inner)
    return frame


def _toast(parent, text):
    
    InfoBar.success("完成", text, duration=2200, position=InfoBarPosition.BOTTOM,
                    parent=parent.window())


class HotkeyCaptureDialog(QDialog):
    """监听用户按下的组合键并自动识别（无需手动输入）。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.captured = None
        self.setWindowTitle("按下组合键")
        self.setModal(True)
        self.setFixedSize(380, 160)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(22, 20, 22, 16)
        lay.setSpacing(10)
        tip = QLabel("请按下要设置的组合键（如 Ctrl+Shift+S）")
        tip.setAlignment(Qt.AlignCenter)
        lay.addWidget(tip)
        self.result = QLabel("等待按键…")
        self.result.setAlignment(Qt.AlignCenter)
        self.result.setStyleSheet("font-size: 18px; font-weight: bold; background: transparent;")
        lay.addWidget(self.result)
        cancel = QPushButton("取消")
        cancel.clicked.connect(self.reject)
        lay.addWidget(cancel)

    def keyPressEvent(self, event):
        combo = _key_event_to_string(event)
        if combo:
            self.captured = combo
            self.result.setText(combo)
            self.accept()
        else:
            self.result.setText("需包含至少一个修饰键（Ctrl/Shift/Alt/Cmd）")


def _key_event_to_string(event):
    """把 QKeyEvent 转成小写组合键字符串（如 ctrl+shift+s）。"""
    mods = event.modifiers()
    parts = []
    if mods & Qt.ControlModifier:
        parts.append("ctrl")
    if mods & Qt.ShiftModifier:
        parts.append("shift")
    if mods & Qt.AltModifier:
        parts.append("alt")
    if mods & Qt.MetaModifier:
        parts.append("cmd")
    key = event.key()
    # 纯修饰键不算组合键
    if key in (Qt.Key_Control, Qt.Key_Shift, Qt.Key_Alt, Qt.Key_Meta):
        return None
    key_text = _qt_key_to_text(key)
    if not key_text or not parts:
        return None
    return "+".join(parts + [key_text])


def _qt_key_to_text(key):
    """Qt.Key → 小写键名字符串。"""
    if Qt.Key_A <= key <= Qt.Key_Z:
        return chr(key).lower()
    if Qt.Key_0 <= key <= Qt.Key_9:
        return chr(key)
    special = {
        Qt.Key_Space: "space", Qt.Key_Return: "return", Qt.Key_Enter: "return",
        Qt.Key_Tab: "tab", Qt.Key_Escape: "esc", Qt.Key_Backspace: "backspace",
        Qt.Key_Delete: "delete", Qt.Key_Up: "up", Qt.Key_Down: "down",
        Qt.Key_Left: "left", Qt.Key_Right: "right",
    }
    if key in special:
        return special[key]
    if Qt.Key_F1 <= key <= Qt.Key_F12:
        return f"f{key - Qt.Key_F1 + 1}"
    return None
