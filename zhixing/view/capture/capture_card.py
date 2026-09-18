# -*- coding: utf-8 -*-
"""划词捕获卡：摘录回显 + 备注 + 五去向（存闪念/转任务/存笔记/入分组/加子任务）。"""
from typing import Optional

from PySide6.QtCore import Qt, QEvent, QTimer, Signal
from PySide6.QtWidgets import (QFrame, QHBoxLayout, QVBoxLayout, QWidget, QGraphicsOpacityEffect)

from ..components.target_selector import TargetSelector
from qfluent_core import ThemeManager as ThemeEngine
from ..kit.motion import fade_in
from zhixing.view.kit.fluent_compat import QLabel, QLineEdit, QPushButton


class CaptureCard(QFrame):
    """置顶迷你捕获卡（Controller 负责定位与销毁）。"""

    # 去向：flash / task / note / group / subtask
    submitFlash = Signal(str, str)               # content, remark
    submitTask = Signal(str, str)
    submitNote = Signal(str, str)                # remark, content（存入当前笔记）
    submitGroup = Signal(str, str, int, str)     # content, remark, target_id, target_name
    submitSubtask = Signal(str, str, int, str)
    cancelled = Signal()

    def __init__(self, content: str, task_service, settings_service, parent=None, guide: str = ""):
        super().__init__(parent)
        self.content = (content or "").strip()
        self.task_service = task_service
        self.settings = settings_service
        self.guide = guide
        self._selector: Optional[TargetSelector] = None
        self.setFixedSize(400, 240 + (46 if guide else 0))
        # Qt.ToolTip 不参与焦点系统（备注框无法输入）；改用 Qt.Tool 可接收键盘焦点，
        # 配合置顶 + 无边框，仍是在鼠标附近浮出的置顶卡片。
        self.setWindowFlags(Qt.Tool | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self._build()
        self._restyle()
        ThemeEngine.instance() and ThemeEngine.instance().changed.connect(self._restyle)

    def _build(self):
        lay = QVBoxLayout(self)
        lay.setContentsMargins(14, 12, 14, 12)
        lay.setSpacing(8)

        head = QHBoxLayout()
        from ..components.general import IconWidget
        head.addWidget(IconWidget("nav.flash", 18))
        title = QLabel("捕获")
        f = title.font()
        f.setBold(True)
        title.setFont(f)
        head.addWidget(title)
        head.addStretch(1)
        esc = QLabel("Esc 取消")
        esc.setProperty("dim", True)
        head.addWidget(esc)
        lay.addLayout(head)

        excerpt = QLabel(f"「{self.content[:120]}{'…' if len(self.content) > 120 else ''}」")
        excerpt.setWordWrap(True)
        excerpt.setProperty("excerpt", True)
        lay.addWidget(excerpt)

        if self.guide:
            guide_lbl = QLabel(self.guide)
            guide_lbl.setWordWrap(True)
            guide_lbl.setProperty("guide", True)
            lay.addWidget(guide_lbl)

        self.remark = QLineEdit()
        self.remark.setPlaceholderText("一句话备注（可空）…")
        self.remark.returnPressed.connect(lambda: self._submit("flash"))
        lay.addWidget(self.remark)

        btn_row = QHBoxLayout()
        btn_row.setSpacing(6)
        self._buttons = {}
        for key, text in [("flash", "闪念 F"), ("task", "任务 T"), ("note", "笔记 N"),
                          ("group", "入分组 G"), ("subtask", "子任务 U")]:
            b = QPushButton(text)
            b.setProperty("kind", key)
            b.clicked.connect(lambda _=False, k=key: self._submit(k))
            self._buttons[key] = b
            btn_row.addWidget(b)
        lay.addLayout(btn_row)

        self.selector_slot = QVBoxLayout()
        self.selector_slot.setContentsMargins(0, 0, 0, 0)
        lay.addLayout(self.selector_slot)

        self._install_shortcuts()

    def _install_shortcuts(self):
        from PySide6.QtGui import QShortcut, QKeySequence
        for key, action in [("F", "flash"), ("T", "task"), ("N", "note"),
                            ("G", "group"), ("U", "subtask")]:
            sc = QShortcut(QKeySequence(key), self)
            sc.activated.connect(lambda k=action: self._submit(k))
            sc.setContext(Qt.ApplicationShortcut)
        esc = QShortcut(QKeySequence("Escape"), self)
        esc.activated.connect(self.cancelled.emit)

    # ---------- 提交 ----------
    def _submit(self, kind: str):
        remark = self.remark.text().strip()
        if kind == "flash":
            self.submitFlash.emit(self.content, remark)
        elif kind == "task":
            self.submitTask.emit(self.content, remark)
        elif kind == "note":
            self.submitNote.emit(remark, self.content)
        elif kind in ("group", "subtask"):
            self._open_selector(kind)

    def _open_selector(self, kind: str):
        if self._selector is not None:
            self._selector.deleteLater()
        while self.selector_slot.count():
            self.selector_slot.takeAt(0)
        mode = "group" if kind == "group" else "subtask"
        self._selector = TargetSelector(self.task_service, self.settings, mode, self)
        self._selector.picked.connect(self._on_target)
        self._selector.cancelled.connect(self._close_selector)
        self.selector_slot.addWidget(self._selector)
        self._selector.popup()
        self.setFixedHeight(240 + 235)
        self.adjustSize()

    def _close_selector(self):
        if self._selector:
            self._selector.deleteLater()
            self._selector = None
        self.setFixedHeight(240)
        self.adjustSize()

    def _on_target(self, target_id: int, target_name: str):
        remark = self.remark.text().strip()
        sel = self._selector
        mode = sel.mode if sel else "group"
        self._close_selector()
        if mode == "group":
            self.submitGroup.emit(self.content, remark, target_id, target_name)
        else:
            self.submitSubtask.emit(self.content, remark, target_id, target_name)

    # ---------- 样式 ----------
    def _restyle(self):
        eng = ThemeEngine.instance()
        if not eng:
            return
        t = eng.tokens
        # v0.16：壳统一为 16px 大圆角 + 不透明 layer 底、无外边框（与 UDialog 一致）；
        # 内部「五去向」按钮/摘录/备注 UI 保持原样，仅随主题 token 自愈。
        self.setStyleSheet(f"""
            CaptureCard {{ background: {t.get('layer', '#FFFFFF')};
                border: none; border-radius: 16px; }}
            QLabel {{ background: transparent; }}
            QLabel[dim="true"] {{ color: {t.get('fg2', '#6B7280')}; font-size:12px; }}
            QLabel[excerpt="true"] {{ color: {t.get('fg2', '#6B7280')};
                background: {t.get('hover', '#F5F5F5')}; border-radius: 8px; padding: 8px; }}
            QLabel[guide="true"] {{ color: {t.get('warm', '#EA580C')};
                background: {t.get('accent_soft', '#D9F2EE')}; border-radius: 8px; padding: 6px 8px;
                font-size:12px; }}
            QPushButton {{ background: {t.get('hover', '#F5F5F5')}; border: none;
                border-radius: 6px; padding: 5px 10px; }}
            QPushButton:hover {{ background: {t.get('accent_soft', '#D9F2EE')}; }}
        """)

    def event(self, e):
        """失去激活（点击外部 / 切到其他应用）即自动关闭，避免捕获卡残留。"""
        if e.type() in (QEvent.WindowDeactivate, QEvent.ApplicationDeactivate):
            QTimer.singleShot(0, self._close_if_unfocused)
        return super().event(e)

    def _close_if_unfocused(self):
        if self.isVisible() and not self.isActiveWindow():
            self.cancelled.emit()

    def popup(self, global_pos):
        self.move(global_pos)
        fade_in(self, "fast", 6)
        self.show()
        self.raise_()
        # 只温和激活弹窗自身，不把整个应用（主界面）带到前台。
        # activateWindow() 在 macOS 会同时激活应用导致主窗口弹出，改用 requestActivate()。
        if self.windowHandle() is not None:
            self.windowHandle().requestActivate()
        self.remark.setFocus()
