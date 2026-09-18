# -*- coding: utf-8 -*-
"""动效系统：Motion token + 动画工厂（§2.4 / §11）。"""
from typing import Optional

from PySide6.QtCore import (
    QEasingCurve, QPropertyAnimation, QParallelAnimationGroup, QAbstractAnimation,
    QVariantAnimation, Qt,
)
from PySide6.QtWidgets import QGraphicsOpacityEffect, QWidget

DURATION = {"instant": 100, "fast": 150, "normal": 250, "slow": 400,
            "strike": 200, "page": 200, "panel": 280}

EASING = {
    "standard": QEasingCurve.OutCubic,
    "decelerate": QEasingCurve.OutCubic,
    "accelerate": QEasingCurve.InCubic,
    "spring": QEasingCurve.OutBack,
    # v0.16 P1-a: 对齐对照文档动效曲线（OutExpo 抽屉/浮层、InOutQuad 页转场）
    "panel": QEasingCurve.OutExpo,
    "page": QEasingCurve.InOutQuad,
}

_motion_enabled = True


def set_motion_enabled(v: bool):
    global _motion_enabled
    _motion_enabled = v


def attach_tab_fade(tabs) -> None:
    """v0.16 P2-c: QTabWidget 切页轻淡入（150ms opacity，无位移动效）。

    只淡入「新当前页」；尊重 reduce-motion（禁用时不动作）。
    """
    if tabs is None:
        return
    try:
        tabs.currentChanged.connect(
            lambda i: _fade_tab_page(tabs, i))
    except Exception:  # noqa: BLE001
        pass


def _fade_tab_page(tabs, index: int):
    if not _motion_enabled:
        return
    try:
        w = tabs.widget(index)
        if w is not None and w.isVisible():
            fade_in(w, "fast", 0)
    except Exception:  # noqa: BLE001
        pass


def motion_enabled() -> bool:
    return _motion_enabled


def animate(obj, prop: str, start, end, dur: str = "normal",
            easing: str = "standard", on_done=None) -> Optional[QPropertyAnimation]:
    """统一动画入口：注入 token，尊重 reduce-motion。"""
    if not _motion_enabled or start == end:
        if on_done:
            on_done()
        return None
    a = QPropertyAnimation(obj, prop.encode() if isinstance(prop, str) else prop)
    a.setDuration(DURATION.get(dur, 250))
    a.setStartValue(start)
    a.setEndValue(end)
    a.setEasingCurve(EASING.get(easing, QEasingCurve.OutCubic))
    if on_done:
        a.finished.connect(on_done)
    a.start(QAbstractAnimation.DeleteWhenStopped)
    return a


def fade_in(w: QWidget, dur: str = "fast", slide: int = 8):
    """页面/弹层进场：淡入 + 轻微上移。"""
    if not _motion_enabled:
        return
    eff = QGraphicsOpacityEffect(w)
    w.setGraphicsEffect(eff)
    eff.setOpacity(0.0)
    a = QPropertyAnimation(eff, b"opacity", w)
    a.setDuration(DURATION.get(dur, 150))
    a.setStartValue(0.0)
    a.setEndValue(1.0)
    a.setEasingCurve(QEasingCurve.OutCubic)
    a.finished.connect(lambda: w.setGraphicsEffect(None))
    a.start(QAbstractAnimation.DeleteWhenStopped)
    if slide:
        g = w.geometry()
        w.move(g.x(), g.y() + slide)
        anim = QPropertyAnimation(w, b"pos", w)
        anim.setDuration(DURATION.get(dur, 150) + 60)
        anim.setStartValue(w.pos())
        anim.setEndValue(g.topLeft())
        anim.setEasingCurve(QEasingCurve.OutCubic)
        anim.start(QAbstractAnimation.DeleteWhenStopped)


def title_enter(w: QWidget, slide: int = 15, dur_ms: int = 300, easing: str = "standard"):
    """大标题/副标题入场：淡入 + 上移（默认 OutCubic 减速），尊重 reduce-motion。"""
    if not _motion_enabled:
        return
    curve = EASING.get(easing, QEasingCurve.OutCubic)
    eff = QGraphicsOpacityEffect(w)
    w.setGraphicsEffect(eff)
    eff.setOpacity(0.0)
    fade = QPropertyAnimation(eff, b"opacity", w)
    fade.setDuration(dur_ms)
    fade.setStartValue(0.0)
    fade.setEndValue(1.0)
    fade.setEasingCurve(curve)
    fade.finished.connect(lambda: w.setGraphicsEffect(None))
    fade.start(QAbstractAnimation.DeleteWhenStopped)
    if slide:
        g = w.geometry()
        w.move(g.x(), g.y() + slide)
        slide_anim = QPropertyAnimation(w, b"pos", w)
        slide_anim.setDuration(dur_ms)
        slide_anim.setStartValue(w.pos())
        slide_anim.setEndValue(g.topLeft())
        slide_anim.setEasingCurve(curve)
        slide_anim.start(QAbstractAnimation.DeleteWhenStopped)


def number_roller(label, target: int, dur: str = "normal"):
    """数字滚动到目标值。"""
    if not _motion_enabled:
        label.setText(str(target))
        return
    try:
        current = int(label.text().replace("+", ""))
    except ValueError:
        current = 0
    if current == target:
        label.setText(str(target))
        return
    steps = 14

    def step(i):
        value = round(current + (target - current) * (i / steps))
        label.setText(str(value))

    timer_holder = {"t": None}

    from PySide6.QtCore import QTimer
    timer = QTimer(label)
    timer.setInterval(int(DURATION.get(dur, 250) * 16 / steps))

    def tick():
        step(timer_holder.get("i", 0))
        timer_holder["i"] = timer_holder.get("i", 0) + 1
        if timer_holder["i"] >= steps:
            label.setText(str(target))
            timer.stop()

    timer_holder["i"] = 0
    timer.timeout.connect(tick)
    timer.start()


# 保活注册表：QVariantAnimation 无父对象，运行期间由模块持有引用，结束自动摘除，
# 避免 Python 侧 GC 提前回收导致动画半途消失。
_active_animations = set()


def animate_value(start, end, dur: str = "normal", easing: str = "standard",
                  on_update=None, on_done=None):
    """通用数值动画（0..1 进度）：适合 delegate/paint 自绘场景（无可绑定的 QObject 属性）。

    每帧回调 ``on_update(value)``，结束回调 ``on_done()``；返回 QVariantAnimation（已托管生命周期）。
    """
    if not _motion_enabled or start == end:
        if on_update:
            on_update(end)
        if on_done:
            on_done()
        return None
    a = QVariantAnimation()
    a.setDuration(DURATION.get(dur, 250))
    a.setStartValue(float(start))
    a.setEndValue(float(end))
    a.setEasingCurve(EASING.get(easing, QEasingCurve.OutCubic))
    if on_update:
        a.valueChanged.connect(lambda v, cb=on_update: cb(float(v)))
    if on_done:
        a.finished.connect(on_done)
    _active_animations.add(a)
    a.finished.connect(lambda aa=a: _active_animations.discard(aa))
    a.start(QAbstractAnimation.DeleteWhenStopped)
    return a


def strike_through(on_update=None, on_done=None, reverse: bool = False):
    """完成划线（9a）：200ms 进度 0→1（reverse=True 则 1→0），供 TaskDelegate 复用。"""
    start, end = (1.0, 0.0) if reverse else (0.0, 1.0)
    return animate_value(start, end, dur="strike", easing="standard",
                         on_update=on_update, on_done=on_done)


def spring_check(on_update=None, on_done=None, reverse: bool = False):
    """勾选弹簧（9b）：进度 0→1，OutBack 回弹，供 TaskDelegate 复用。"""
    start, end = (1.0, 0.0) if reverse else (0.0, 1.0)
    return animate_value(start, end, dur="fast", easing="spring",
                         on_update=on_update, on_done=on_done)


def stagger(count, on_step, on_done=None, step_ms: int = 40):
    """子任务展开 stagger（9c）：按步进间隔依次回调 ``on_step(i)``。"""
    from PySide6.QtCore import QTimer
    if not _motion_enabled or count <= 1:
        for i in range(count):
            on_step(i)
        if on_done:
            on_done()
        return
    holder = {"i": 0}

    def _next():
        i = holder["i"]
        on_step(i)
        holder["i"] += 1
        if holder["i"] < count:
            QTimer.singleShot(step_ms, _next)
        elif on_done:
            on_done()

    _next()
