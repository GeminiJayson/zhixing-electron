# -*- coding: utf-8 -*-
"""翻页时钟：标题栏中间 HH:MM:SS（含秒），高度固定 25；仅变化位做上下翻页动画。"""
from datetime import datetime

from PySide6.QtCore import Qt, QRect, QRectF, QTimer
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import QWidget

from . import motion
from qfluent_core import ThemeManager as ThemeEngine


class FlipClock(QWidget):
    """极简翻页时钟：卡片式 HH:MM:SS，高度固定 25；时间变化时只有变化的位上下翻页。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._text = ""
        self._progress = {}          # 字符位置 -> 翻页进度 0..1
        self._anims = {}             # 字符位置 -> QVariantAnimation（保活）
        self.setFixedSize(150, 25)
        self._restyle()
        ThemeEngine.instance() and ThemeEngine.instance().changed.connect(self._restyle)
        self._timer = QTimer(self)
        self._timer.setInterval(1000)
        self._timer.timeout.connect(self._tick)
        self._timer.start()
        self._tick()

    def _restyle(self):
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        self._fg = QColor(t.get("fg", "#1A1A1A"))
        self._accent = QColor(t.get("accent", "#0D9488"))
        self._layer = QColor(t.get("layer", "#FFFFFF"))
        self._border = QColor(t.get("border", "#E4EDE8"))
        self.update()

    def _tick(self):
        now = datetime.now().strftime("%H:%M:%S")
        if now != self._text:
            old = self._text or "00:00:00"
            # 只对变化的字符位启动翻页动画
            for i, (a, b) in enumerate(zip(old, now)):
                if a != b:
                    self._progress[i] = 0.0
                    self._animate(i)
            self._text = now
        self.update()

    def _animate(self, index: int):
        old_anim = self._anims.get(index)
        if old_anim is not None:
            try:
                old_anim.stop()
            except Exception:
                pass
        anim = motion.animate_value(
            0.0, 1.0, dur="fast", easing="decelerate",
            on_update=lambda v, i=index: self._set_progress(i, v))
        if anim is not None:
            self._anims[index] = anim

    def _set_progress(self, index: int, v: float):
        # 动画回调可能在控件已销毁后触发（测试/切主题/关窗时对象先 deleteLater），
        # 此时访问 C++ 对象会抛 RuntimeError。存活检查后直接跳过。
        try:
            self._progress[index] = v
            self.update()
        except RuntimeError:
            pass

    def stop_anims(self):
        """停止全部翻页动画（销毁前调用，避免回调打到已删对象）。"""
        for a in list(getattr(self, "_anims", {}).values()):
            try:
                a.stop()
            except Exception:  # noqa: BLE001
                pass
        self._anims = {}

    def paintEvent(self, ev):  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        chars = list(self._text or "00:00:00")
        w = self.width()
        dig_w = 19
        colon_w = 8
        widths = [colon_w if ch == ":" else dig_w for ch in chars]
        total = sum(widths)
        gap = 2
        total += gap * (len(chars) - 1)
        x = (w - total) // 2
        f = QFont(self.font())
        f.setBold(True)
        f.setPixelSize(13)
        p.setFont(f)

        for i, ch in enumerate(chars):
            cw = widths[i]
            if ch == ":":
                cy = self.height() // 2
                p.setPen(Qt.NoPen)
                p.setBrush(self._accent)
                p.drawEllipse(QRect(x + 1, cy - 4, 5, 5))
                p.drawEllipse(QRect(x + 1, cy + 1, 5, 5))
            else:
                rect = QRect(x, 1, cw, self.height() - 2)
                p.setPen(QPen(self._border, 1))
                p.setBrush(self._layer)
                p.drawRoundedRect(rect, 4, 4)
                p.setPen(self._fg)
                self._draw_digit(p, ch, rect, i)
            x += cw + gap
        p.end()

    def _draw_digit(self, p, ch, rect, index):
        """翻页（上下效果）：新数字从上方滑入到中心。"""
        progress = max(0.0, min(1.0, self._progress.get(index, 1.0)))
        if progress >= 1.0:
            p.drawText(rect, Qt.AlignCenter, ch)
            return
        # 新数字从上方滑入（progress 0→1 时从上移到中心）
        offset = int((1.0 - progress) * rect.height())
        new_rect = QRect(rect.x(), rect.y() - offset, rect.width(), rect.height())
        p.save()
        p.setClipRect(rect)
        p.drawText(new_rect, Qt.AlignCenter, ch)
        p.restore()
