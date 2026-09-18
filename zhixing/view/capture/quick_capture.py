# -*- coding: utf-8 -*-
"""快速任务捕获窗（Ctrl+N / Ctrl+Alt+N / Ctrl+Shift+U 划选速记预填）。

v0.17.1 第5项：改用 UDialog 框架承载（自带标题栏 + 16px 大圆角 + 主题自愈 +
失焦自动关闭），保留原信号（submitted/cancelled）、置顶 Tool 行为、鼠标所在屏
定位与语法糖 chip 实时回显。输入回车提交、Esc 取消。
"""
from PySide6.QtCore import Signal
from PySide6.QtGui import QGuiApplication, QCursor


from ...model.domain.capture_grammar import due_from_word, parse
from ..kit.motion import fade_in
from ..ui import DialogType, RESIZE_MARGIN, UDialog
from zhixing.view.kit.fluent_compat import QLabel, QLineEdit

#: 划词速记预填时输入框容纳的标题长度上限（与划词卡「转任务」标题截断一致）。
_PREFILL_TITLE_MAX = 60


class QuickCaptureWindow(UDialog):
    """快速任务捕获窗（UDialog 框架）。"""

    submitted = Signal(str)      # 原始输入文本
    cancelled = Signal()

    def __init__(self, parent=None):
        super().__init__("快速添加任务", parent=parent,
                         dialog_type=DialogType.INPUT,
                         icon_name="nav.flash",
                         width=480, height=170,
                         tool=True, sticky=True, auto_close_on_deactivate=True,
                         show_title_bar=True,
                         # 小弹层用紧凑标题栏：常规 44px 占 180px 弹窗的 24%，过于笨重
                         compact_title=True)
        self.setWindowTitle("快速添加任务")

        lay = self.body_layout
        lay.setContentsMargins(14, 12, 14, 14)
        lay.setSpacing(6)

        self.input = QLineEdit()
        self.input.setPlaceholderText("做什么？支持 !8优先级(1-8) @列表 #标签 明天3点")
        self.input.returnPressed.connect(self._submit)
        lay.addWidget(self.input)

        self.chips = QLabel("")
        self.chips.setWordWrap(True)
        lay.addWidget(self.chips)

        #: 本窗最小高度：标题栏 + 输入框 + 上下边距（无 chips 时的紧凑高度）。
        #: 不用 UDialog 的通用 MIN_H(180)——那是为常规弹窗设的，会把小窗顶高、
        #: 使动态定高失效。这里按自身内容算一个贴合的紧凑下限。
        #: 无 chips 时留一点呼吸留白（+18），避免弹窗过矮显得局促。
        self._MIN_H = ((self.title_bar.height() if self.title_bar is not None else 0)
                       + 12 + 14 + self.input.sizeHint().height() + 18
                       + 2 * RESIZE_MARGIN)

        # 划词速记预填的原文余量（多行/超长首行时保留全文），回车提交随任务写入备注
        self._pending_notes = ""
        self.input.textChanged.connect(self._echo)
        self.cancelled.connect(self.close)
        self._restyle()
        # 语法糖 chips 换行数随输入变化 → 按实际需要动态定高（避免固定高留白/挤压）
        self._fit_height()

    def _echo(self, text: str):
        p = parse(text)
        chips = []
        from ...model.domain.entities import Priority, priority_label
        if int(p.priority) != int(Priority.NONE):
            chips.append(f"优先级 {priority_label(p.priority)}")
        if p.list_name:
            chips.append(f"列表 @{p.list_name}")
        for tg in p.tags:
            chips.append(f"#{tg}")
        if p.due_word and due_from_word(p.due_word):
            if p.due_clock:
                h, m = p.due_clock
                chips.append(f"截止 {p.due_word} {h:02d}:{m:02d}")
            else:
                chips.append(f"截止 {p.due_word}")
        if chips:
            eng = self._engine_tokens()
            accent = eng.get("accent", "#0D9488") if eng else "#0D9488"
            soft = eng.get("accent_soft", "#D9F2EE") if eng else "#D9F2EE"
            self.chips.setText("  ".join(
                f'<span style="color:{accent};background:{soft};'
                f'padding:1px 6px;border-radius:8px;">{c}</span>' for c in chips))
        else:
            self.chips.clear()
        self._fit_height()

    def _engine_tokens(self):
        from qfluent_core import ThemeManager as ThemeEngine
        eng = ThemeEngine.instance()
        return eng.tokens if eng is not None else {}

    def _fit_height(self):
        """按 chips 实际行数动态调整弹窗高度。

        chips 是 wordWrap 的 QLabel：语法糖少时一行、多时换行到两三行。
        固定高度会在少糖时留下大片空白、多糖时挤压。这里按「标题栏 + 输入框 +
        chips 实际需要高度 + 边距」重算窗口高度，并保留 UDialog 的最小高度下限。
        """
        chips_h = self.chips.sizeHint().height() if self.chips.text() else 0
        margins = self.body_layout.contentsMargins()
        spacing = self.body_layout.spacing()
        body_h = (margins.top() + margins.bottom()
                  + self.input.sizeHint().height()
                  + (spacing + chips_h if chips_h else 0))
        title_h = self.title_bar.height() if self.title_bar is not None else 0
        target = max(self._MIN_H, title_h + body_h + 2 * RESIZE_MARGIN)
        if target != self.height():
            # 只调高度（宽度由布局决定）；同时更新最小高度下限，
            # 否则 UDialog 的全局 MIN_H(180) 会把窗口又顶回去、动态定高失效。
            self.setMinimumHeight(self._MIN_H)
            self.resize(self.width(), target)

    def _submit(self):
        text = self.input.text().strip()
        if text:
            self.submitted.emit(text)
            self._pending_notes = ""
            self.accept()     # UDialog 关闭

    @property
    def pending_notes(self) -> str:
        """最近一次预填留下的原文备注（多行/超长首行的全文），提交时随任务写入。"""
        return self._pending_notes

    def prefill(self, text: str):
        """把选中文字预填进输入框（划词速记 Ctrl+Shift+U）。

        输入框是单行：标题取首行（超长截断到 _PREFILL_TITLE_MAX，与划词卡
        「转任务」对齐）；余下原文暂存 pending_notes，回车提交时一并写入
        任务备注，保证选中内容不丢失。光标置于行尾，便于继续追加语法糖
        （!3 @列表 #标签 明天 等），回车走 quick_create。
        """
        text = (text or "").strip()
        if not text:
            return
        lines = text.split("\n")
        head = lines[0].strip()
        visible = head[:_PREFILL_TITLE_MAX]
        has_more = len(lines) > 1 or len(head) > _PREFILL_TITLE_MAX
        self._pending_notes = text if has_more else ""
        self.input.setText(visible)
        self.input.setCursorPosition(len(visible))
        if self.isVisible():
            self.raise_()
            if self.windowHandle() is not None:
                self.windowHandle().requestActivate()
        self.input.setFocus()

    def popup(self):
        self.input.clear()
        self.chips.clear()
        self._pending_notes = ""
        # v0.15 P2-7: 优先在「鼠标所在屏」唤出（多屏用户快捷键触发时落在当前工作屏）
        screen = QGuiApplication.screenAt(QCursor.pos()) or self.screen()
        geom = screen.availableGeometry() if screen is not None else self.screen().availableGeometry()
        center = geom.center()
        self.move(center.x() - 240, max(geom.top() + 8, center.y() - 220))
        fade_in(self, "fast", 8)
        self.show()
        self.raise_()
        # 只温和激活弹窗自身，不把整个应用（主界面）带到前台。
        if self.windowHandle() is not None:
            self.windowHandle().requestActivate()
        self.input.setFocus()
