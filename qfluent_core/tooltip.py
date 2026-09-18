# -*- coding: utf-8 -*-
"""QToolTip 补丁：提示框是 Qt 自己创建的顶层窗口，QSS 管不到两个关键点。

两条都是实测出来的硬限制（不是猜的）：

1. **`border-radius` 画不出圆角** —— 提示是顶层窗口，窗口不透明时圆角四角会被
   窗口底色填满，看起来仍是直角。必须给它 `WA_TranslucentBackground`。
2. **`padding` 不可用** —— 实测 `0` 与 `2px 6px` 都被忽略（都是 40x19），
   一到 `4px 10px` 直接跳到 80x47（Qt 判定这条规则要自带 frame，于是套了一套
   默认的大边距）。所以内边距改为 `setContentsMargins()` 直接设。

另有第三条：圆角必须**小于等于半高**，否则 Qt 整个丢弃圆角（见 theme.control_tokens）。
"""
from __future__ import annotations

from typing import Optional

from PySide6.QtCore import QEvent, QObject, Qt
from PySide6.QtWidgets import QApplication

__all__ = ["install", "DEFAULT_PADDING_H", "DEFAULT_PADDING_V"]

# 内边距兜底值（正常路径由 token 提供：横向 space-3 / 纵向 space-1）
DEFAULT_PADDING_H = 12
DEFAULT_PADDING_V = 4

_MARK = "_qfluent_tooltip_polisher"


class _TipPolisher(QObject):
    """应用级事件过滤器：QTipLabel 每次显示时补上圆角与内边距。"""

    def eventFilter(self, obj, event) -> bool:  # noqa: N802
        # 挂在 QApplication 上会看到所有事件 —— 先按最便宜的两个条件短路
        if event.type() == QEvent.Show and obj.metaObject().className() == "QTipLabel":
            self._polish(obj)
        return False

    @staticmethod
    def _polish(tip) -> None:
        from .theme import ThemeManager
        manager = ThemeManager.instance()
        horizontal = manager.px("space-3", DEFAULT_PADDING_H) if manager else DEFAULT_PADDING_H
        vertical = manager.px("space-1", DEFAULT_PADDING_V) if manager else DEFAULT_PADDING_V
        tip.setAttribute(Qt.WA_TranslucentBackground, True)
        tip.setContentsMargins(horizontal, vertical, horizontal, vertical)
        tip.adjustSize()


def install(app: Optional[QApplication] = None) -> bool:
    """给 QApplication 装上提示框补丁。幂等：重复调用是空操作，返回是否新装。"""
    app = app or QApplication.instance()
    if app is None or getattr(app, _MARK, None) is not None:
        return False
    polisher = _TipPolisher(app)
    app.installEventFilter(polisher)
    setattr(app, _MARK, polisher)      # 持有引用：局部变量会被 GC，过滤器随即失效
    return True
