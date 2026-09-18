# -*- coding: utf-8 -*-
"""番茄钟控制器：idle/focus/break 状态机 + 常驻窗口角落的倒计时悬浮条。"""
from typing import Optional

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtWidgets import (QFrame, QHBoxLayout, QVBoxLayout, QWidget)

from ..core import settings_keys as K
from ..view.kit import icons
from qfluent_core import ThemeManager as ThemeEngine
from zhixing.view.kit.fluent_compat import QLabel, QPushButton


class _FloatingBar(QFrame):
    stopClicked = Signal()
    pauseClicked = Signal(bool)

    def __init__(self, parent=None):
        super().__init__(parent, Qt.Tool | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setFixedSize(300, 54)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(14, 8, 14, 8)
        # 呼吸圆点：SVG 实心圆，颜色随主题 accent（不再用 ● 字符）
        self.dot = QLabel()
        self.dot.setFixedSize(10, 10)
        lay.addWidget(self.dot)
        self.time_label = QLabel("25:00")
        f = self.time_label.font()
        f.setBold(True)
        self.time_label.setFont(f)
        self.time_label.setStyleSheet("background: transparent;")
        lay.addWidget(self.time_label)
        self.task_label = QLabel("专注中")
        self.task_label.setStyleSheet("background: transparent;")
        lay.addWidget(self.task_label, 1)
        self.pause_btn = QPushButton(" 暂停")
        self.pause_btn.setCheckable(True)
        self.pause_btn.setFlat(True)
        # clicked 的无参重载不能直连 Signal(bool)（否则 emit 无参报 TypeError），
        # 用 lambda 显式传 checked 布尔值。
        self.pause_btn.clicked.connect(lambda checked: self.pauseClicked.emit(bool(checked)))
        lay.addWidget(self.pause_btn)
        self.stop_btn = QPushButton(" 结束")
        self.stop_btn.setFlat(True)
        self.stop_btn.clicked.connect(self.stopClicked.emit)
        lay.addWidget(self.stop_btn)
        self._restyle()

    def set_time(self, remain: int, total: int):
        self.time_label.setText(f"{remain // 60:02d}:{remain % 60:02d}")
        # 呼吸：用透明度变化模拟（SVG 圆点不支持 letter-spacing hack）
        self._apply_dot(bright=(total - remain) % 4 < 2)

    def _apply_dot(self, bright: bool = True, icon_name: str = "task.circle-fill"):
        """SVG 圆点/状态图标，颜色随主题 accent，呼吸用透明度。"""
        eng = ThemeEngine.instance()
        accent = eng.t("accent", "#0D9488") if eng else "#0D9488"
        dpr = self.dot.devicePixelRatioF() or 1.0
        self.dot.setPixmap(icons.pixmap(icon_name, accent, 12, dpr))
        self.dot.setWindowOpacity(1.0 if bright else 0.5)

    def set_task(self, title: str):
        self.task_label.setText(title or "专注中")

    def _restyle(self):
        eng = ThemeEngine.instance()
        if not eng:
            return
        t = eng.tokens
        fg = t.get("fg", "#1A1A1A")
        # 按钮 SVG 图标随主题重新着色
        self.pause_btn.setIcon(icons.icon("pomo.pause", fg, 15))
        self.stop_btn.setIcon(icons.icon("pomo.stop", fg, 15))
        self.setStyleSheet(
            f"_FloatingBar {{ background: {t.get('layer', '#FFFFFF')};"
            f"border: 1px solid {t.get('border', '#E5E5E5')}; border-radius: 12px; }}"
            f"QPushButton {{ background: {t.get('hover', '#F5F5F5')}; border: none;"
            f"border-radius: 6px; padding: 3px 10px; }}")
        self._apply_dot()


class PomodoroController:
    """状态机 idle → focus → break → idle。"""

    def __init__(self, context, main_window):
        self.ctx = context
        self.main = main_window
        self.state = "idle"
        self.task_id: Optional[int] = None
        self.remain = 0
        self.total = 0
        self._paused = False
        self.bar = _FloatingBar()
        self.bar.stopClicked.connect(self._request_stop)
        self.bar.pauseClicked.connect(self._toggle_pause)
        self._timer = QTimer()
        self._timer.setInterval(1000)
        self._timer.timeout.connect(self._tick)
        # 中断需选原因（§5.5）：先简单记录，区分 completed/abandoned
        self._started_from = None

    def start(self, task_id: Optional[int]):
        if self.state != "idle":
            self.stop()
        focus_min = self.ctx.settings.get_int(K.K_POMO_FOCUS, 25)
        self.state = "focus"
        self.task_id = task_id if task_id and task_id > 0 else None
        self.remain = self.total = focus_min * 60
        self._paused = False
        task = self.ctx.task_service.get(self.task_id) if self.task_id else None
        self.bar.set_task(task.title if task else "专注中")
        self._place_bar()
        self.bar.show()
        self._timer.start()
        self.ctx.bus.pomodoro_state.emit("focus", self.remain, self.total)

    def stop(self, abandoned: bool = False, reason: Optional[str] = None):
        if self.state == "idle":
            return
        minutes = round((self.total - max(0, self.remain)) / 60)
        self._timer.stop()
        if minutes >= 1:
            s = self.ctx.db.session()
            try:
                from ..model.infrastructure.repositories import PomodoroRepository
                PomodoroRepository(self.ctx.db).add(s, self.task_id, minutes, not abandoned, reason)
                s.commit()
            finally:
                s.close()
        was_focus = self.state == "focus"
        self.state = "idle"
        self.bar.hide()
        self.ctx.bus.pomodoro_state.emit("idle", 0, 0)
        if was_focus and not abandoned:
            self.ctx.bus.pomodoro_finished.emit(minutes, self.task_id or -1)
            break_min = self.ctx.settings.get_int(K.K_POMO_BREAK, 5)
            self.main.tray.showMessage("专注完成", f"休息 {break_min} 分钟",
                                       _info(), 3000)
            if self.ctx.settings.get_bool(K.K_AUTO_START_BREAK, False):
                self._start_break(break_min)
        self._paused = False

    def _request_stop(self):
        """悬浮条「结束」：专注中手动中断先选原因（F5-2），休息/空闲直接结束。"""
        if self.state == "idle":
            return
        abandoned = self.state == "focus" and self.remain > 0
        reason = None
        if abandoned:
            reason = self._ask_interrupt_reason()
        self.stop(abandoned=abandoned, reason=reason)

    def _ask_interrupt_reason(self) -> Optional[str]:
        """中断原因选择（F5-2）：预设原因 + 允许自定义，取消返回 None。"""
        from PySide6.QtWidgets import QInputDialog
        reasons = ["被打断", "临时有事", "分心", "任务调整", "其他"]
        choice, ok = QInputDialog.getItem(
            self.bar, "专注中断", "选择中断原因：", reasons, 0, True)
        if not ok or not choice or not choice.strip():
            return None
        return choice.strip()

    def _start_break(self, minutes: int):
        self.state = "break"
        self.task_id = None
        self.remain = self.total = minutes * 60
        self.bar.set_task("休息一下")
        # 休息态：呼吸圆点换咖啡 SVG 图标
        self.bar._apply_dot(True, "pomo.coffee")
        self.bar.show()
        self._timer.start()

    def _toggle_pause(self, checked: bool):
        self._paused = checked
        self.bar.pause_btn.setText(" 继续" if checked else " 暂停")
        eng = ThemeEngine.instance()
        fg = eng.t("fg", "#1A1A1A") if eng else "#1A1A1A"
        self.bar.pause_btn.setIcon(
            icons.icon("pomo.play" if checked else "pomo.pause", fg, 15))

    def _tick(self):
        if self._paused:
            return
        self.remain -= 1
        self.bar.set_time(max(0, self.remain), self.total)
        self.ctx.bus.pomodoro_state.emit(self.state, max(0, self.remain), self.total)
        if self.remain <= 0:
            if self.state == "focus":
                self.stop(abandoned=False)
            else:
                self.state = "idle"
                self.bar.hide()
                self._timer.stop()

    def _place_bar(self):
        if self.main.isVisible():
            geo = self.main.geometry()
            self.bar.move(geo.right() - self.bar.width() - 40, geo.bottom() - 90)


def _info():
    from PySide6.QtWidgets import QSystemTrayIcon
    return QSystemTrayIcon.Information
