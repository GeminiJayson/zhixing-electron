# -*- coding: utf-8 -*-
"""框架层动效：时长/缓动 token、动画工厂、全局开关。

对外保留既有项目的函数名（set_motion_enabled / motion_enabled）作为兼容别名，
老项目迁移时旧调用点不会崩（解耦契约 §2 无破坏性重命名）。
"""
from __future__ import annotations

from typing import Callable, Optional, Set

from PySide6.QtCore import (
    QAbstractAnimation, QEasingCurve, QObject, QPropertyAnimation, QVariantAnimation,
)

__all__ = [
    "DURATION", "EASING", "set_motion_enabled", "motion_enabled", "enabled",
    "animate", "animate_value", "fade_in", "stagger", "number_roller",
    "bind_settings", "duration", "set_profile", "profile", "MOTION_PROFILES",
]

DURATION = {"instant": 100, "fast": 150, "normal": 250, "slow": 400,
            "page": 200, "panel": 280}

EASING = {
    "standard": QEasingCurve.OutCubic,
    "decelerate": QEasingCurve.OutCubic,
    "accelerate": QEasingCurve.InCubic,
    "spring": QEasingCurve.OutBack,
    "quart": QEasingCurve.OutQuart,
    "inout": QEasingCurve.InOutCubic,
    "panel": QEasingCurve.OutExpo,
    "page": QEasingCurve.InOutQuad,
}

#: 动效档位：整体时长缩放 + "standard" 缓动风格。切换后所有后续动画立即按新档位。
MOTION_PROFILES: Dict[str, Dict[str, object]] = {
    "snappy": {"scale": 0.6, "easing": "quart", "label": "迅捷"},
    "standard": {"scale": 1.0, "easing": "standard", "label": "标准"},
    "relaxed": {"scale": 1.7, "easing": "inout", "label": "舒缓"},
}

_profile: str = "standard"
_enabled: bool = True


def set_profile(name: str) -> None:
    """切换动效档位（snappy / standard / relaxed）；未知档位回落到 standard。"""
    global _profile
    _profile = name if name in MOTION_PROFILES else "standard"


def profile() -> str:
    return _profile


def _scale() -> float:
    return float(MOTION_PROFILES.get(_profile, {}).get("scale", 1.0))


def duration(name: str = "normal") -> int:
    """取档位缩放后的时长（毫秒）。所有动画都必须经这里取时长。"""
    base = DURATION.get(name, 250)
    scale = float(MOTION_PROFILES.get(_profile, {}).get("scale", 1.0))
    return max(30, int(round(base * scale)))


def _easing(name: str) -> QEasingCurve:
    if name == "standard":
        name = str(MOTION_PROFILES.get(_profile, {}).get("easing", "standard"))
    return EASING.get(name, QEasingCurve.OutCubic)
#: 无父动画保活表：Python 侧持引用，结束后自动摘除，避免被 GC 提前回收。
_active: Set[QVariantAnimation] = set()


def set_motion_enabled(value: bool) -> None:
    global _enabled
    _enabled = bool(value)


def motion_enabled() -> bool:
    """兼容别名（与既有项目 zhixing.view.kit.motion 同名）。"""
    return _enabled


def enabled() -> bool:
    return _enabled


def bind_settings(ui_settings) -> None:
    """把 UISettings 的动效开关与档位接到本模块（单向依赖：motion -> settings）。"""
    try:
        ui_settings.animationChanged.connect(set_motion_enabled)
        ui_settings.motionStyleChanged.connect(set_profile)
        set_motion_enabled(ui_settings.get_bool("animations_enabled", True))
        set_profile(str(ui_settings.get("motion_style", "standard")))
    except Exception:  # noqa: BLE001
        pass


def animate(obj: QObject, prop: str, start, end, dur: str = "normal",
            easing: str = "standard", on_done: Optional[Callable[[], None]] = None
            ) -> Optional[QPropertyAnimation]:
    """属性动画；动效关闭或起止值相同时直接落到终值并回调。"""
    if not _enabled or start == end:
        if on_done:
            on_done()
        return None
    anim = QPropertyAnimation(obj, prop.encode() if isinstance(prop, str) else prop)
    # 必须挂到目标对象上并登记保活：否则函数返回后没有任何 Python/Qt 引用，
    # 动画对象会被 GC 回收，动画静默失效（属性停在起点）。
    if isinstance(obj, QObject) and anim.parent() is None:
        anim.setParent(obj)
    anim.setDuration(duration(dur))
    anim.setStartValue(start)
    anim.setEndValue(end)
    anim.setEasingCurve(_easing(easing))
    if on_done:
        anim.finished.connect(on_done)
    _active.add(anim)
    anim.finished.connect(lambda a=anim: _active.discard(a))
    anim.start(QAbstractAnimation.DeleteWhenStopped)
    return anim


def animate_value(start: float, end: float, dur: str = "normal",
                  easing: str = "standard",
                  on_update: Optional[Callable[[float], None]] = None,
                  on_done: Optional[Callable[[], None]] = None,
                  parent: Optional[QObject] = None) -> Optional[QVariantAnimation]:
    """数值动画（自绘场景用）：每帧回调 on_update(v)。"""
    if not _enabled or start == end:
        if on_update:
            on_update(end)
        if on_done:
            on_done()
        return None
    anim = QVariantAnimation(parent)
    anim.setDuration(duration(dur))
    anim.setStartValue(float(start))
    anim.setEndValue(float(end))
    anim.setEasingCurve(_easing(easing))
    if on_update:
        anim.valueChanged.connect(lambda v, cb=on_update: cb(float(v)))
    if on_done:
        anim.finished.connect(on_done)
    if parent is None:
        _active.add(anim)
        anim.finished.connect(lambda a=anim: _active.discard(a))
    anim.start(QAbstractAnimation.DeleteWhenStopped)
    return anim


def stagger(count: int, on_step: Callable[[int], None],
            on_done: Optional[Callable[[], None]] = None, step_ms: int = 40,
            parent: Optional[QObject] = None) -> Optional[QTimer]:
    """依次入场：按 step_ms 间隔回调 on_step(i)，用于列表/卡片逐条出现。

    动效关闭或只有一项时立即全部回调（不改语义，只是没有时间展开）。
    返回的 QTimer 会被保活；不传 parent 时由模块持有到结束。
    """
    from PySide6.QtCore import QTimer
    if not _enabled or count <= 1:
        for index in range(count):
            on_step(index)
        if on_done:
            on_done()
        return None
    holder = {"i": 0}
    timer = QTimer(parent)
    timer.setInterval(max(1, int(round(step_ms * _scale()))))

    def _tick() -> None:
        index = holder["i"]
        on_step(index)
        holder["i"] = index + 1
        if holder["i"] >= count:
            timer.stop()
            _active.discard(timer)
            if on_done:
                on_done()

    timer.timeout.connect(_tick)
    if parent is None:
        _active.add(timer)
    timer.start()
    return timer


def number_roller(label, target: int, dur: str = "normal",
                  parent: Optional[QObject] = None) -> Optional[QVariantAnimation]:
    """数字滚动到目标值（仪表/统计数字）；动效关闭时直接落值。"""
    try:
        current = int(str(label.text()).replace("+", "").strip() or 0)
    except (TypeError, ValueError):
        current = 0
    if current == target or not _enabled:
        label.setText(str(target))
        return None
    return animate_value(current, target, dur=dur, parent=parent,
                         on_update=lambda value: label.setText("%d" % round(value)))


def fade_in(widget, dur: str = "fast", slide: int = 0) -> None:
    """进场：淡入（可选轻微上移）；动效关闭时保持现状。"""
    if not _enabled or widget is None:
        return
    from PySide6.QtWidgets import QGraphicsOpacityEffect
    eff = QGraphicsOpacityEffect(widget)
    widget.setGraphicsEffect(eff)
    eff.setOpacity(0.0)
    anim = QPropertyAnimation(eff, b"opacity", widget)
    anim.setDuration(duration(dur))
    anim.setStartValue(0.0)
    anim.setEndValue(1.0)
    anim.setEasingCurve(QEasingCurve.OutCubic)
    anim.finished.connect(lambda: widget.setGraphicsEffect(None))
    anim.start(QAbstractAnimation.DeleteWhenStopped)
    if slide:
        geo = widget.geometry()
        widget.move(geo.x(), geo.y() + slide)
        move = QPropertyAnimation(widget, b"pos", widget)
        move.setDuration(duration(dur) + 60)
        move.setStartValue(widget.pos())
        move.setEndValue(geo.topLeft())
        move.setEasingCurve(QEasingCurve.OutCubic)
        move.start(QAbstractAnimation.DeleteWhenStopped)
