# -*- coding: utf-8 -*-
"""业务图标：注册进框架的图标系统，并转发统一 API。

原先这里是 228 行的自建实现（SVG 路径表 + 4x 超采样渲染 + QIcon/QPixmap/data_uri
+ 缓存 + 主题色）。现已并入 qfluent_core.icons —— 框架负责机制，本模块只做两件事：

1. 把**业务图标**注册进框架（框架不该内置 nav./task./achieve. 这类业务语义）；
2. 转发旧 API，既有调用点一行不用改。

框架提供的机制（比原先的自建版更完整）：
- 主题色自动跟随（不传 color 就用 token 的 fg2）；
- 尺寸 + 屏幕 DPI 感知的渲染（物理像素 = 逻辑尺寸 x DPR x 超采样）；
- 两套缓存：控件走内存、QSS 走平台缓存目录（不再是 /tmp），并自动清理旧文件。

注意 Qt 的 QSS **不支持 data URI**（实测 0 像素渲染），所以给 QSS 的图标仍然落盘，
用 icon_file()/data_uri() 取路径。
"""
from __future__ import annotations

import math
from typing import Tuple

from PySide6.QtGui import QPainterPath

from qfluent_core import icons as _icons

#: 业务图标（由 zhixing 原 icons.py 迁入；框架不该内置业务语义）
_BUSINESS_ICONS = {
    "nav.today": '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 9.5h18"/><circle cx="8.5" cy="14.5" r="1.4" fill="currentColor" stroke="none"/>',
    "nav.tasks": '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8.5 12.2l2.4 2.4 4.8-5"/>',
    "nav.inbox": '<path d="M4 13.5 6.5 5.5h11L20 13.5v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 13.5h4.5a3.5 3.5 0 0 0 7 0H20"/>',
    "nav.flash": '<path d="M13 2 4.5 13.5h5.5L11 22l8.5-11.5H14z"/>',
    "nav.notes": '<path d="M6 3.5h9.5L20 8v12.5H6z"/><path d="M15 3.5V8h5M9 12h7M9 16h5"/>',
    "nav.graph": '<circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="8" r="2.6"/><circle cx="10" cy="18" r="2.6"/><path d="M8.4 7 15.5 7.7M7.5 8.4 9.3 15.6M16 9.9l-4.6 6"/>',
    "nav.workflow": '<rect x="3" y="3" width="7" height="6" rx="1.6"/><rect x="14" y="15" width="7" height="6" rx="1.6"/><path d="M6.5 9v4.5a2 2 0 0 0 2 2H14"/>',
    "nav.review": '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2" transform="translate(-1 0)"/>',
    "nav.settings": '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v3M12 18.2v3M4.1 7.4l2.6 1.5M17.3 15.1l2.6 1.5M4.1 16.6l2.6-1.5M17.3 8.9l2.6-1.5"/>',
    "action.add": '<path d="M12 5v14M5 12h14"/>',
    "action.search": '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>',
    "action.close": '<path d="M6 6l12 12M18 6 6 18"/>',
    "action.more": '<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
    "action.edit": '<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    "action.copy": '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
    "action.back": '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    "action.attach": '<path d="M21 12.5 12.5 21a5.7 5.7 0 0 1-8-8L13.5 4a3.8 3.8 0 0 1 5.4 5.4l-8.9 8.9a1.9 1.9 0 0 1-2.7-2.7L16 7"/>',
    "action.refresh": '<path d="M20 12a8 8 0 1 1-2.3-5.1M20 3.5V8h-4.5"/>',
    "action.check": '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    "action.filter": '<path d="M4 5h16l-6.2 7.2V19l-3.6-2.2v-4.6z"/>',
    "action.expand": '<path d="M7 10l5 5 5-5"/>',
    "action.collapse": '<path d="M7 14l5-5 5 5"/>',
    "action.full": '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    "task.circle": '<circle cx="12" cy="12" r="8.5"/>',
    "task.circle-fill": '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.4 2.4 4.6-4.9"/>',
    "task.repeat": '<path d="M17 2.5 20.5 6 17 9.5"/><path d="M3.5 11V9a3 3 0 0 1 3-3h14M7 21.5 3.5 18 7 14.5"/><path d="M20.5 13v2a3 3 0 0 1-3 3h-14"/>',
    "task.subtask": '<rect x="3.5" y="3.5" width="5" height="5" rx="1.4"/><path d="M11 6h9.5M11 17.5h9.5M6 8.5v9a2 2 0 0 0 2 2h3"/>',
    "task.calendar": '<rect x="3" y="4.5" width="18" height="16.5" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/>',
    "task.quadrant": '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
    "task.flag": '<path d="M5 21V4"/><path d="M5 5c3-2 6 2 9 0 2-1.4 3.5-1 5 0v9c-1.5-1-3-1.4-5 0-3 2-6-2-9 0"/>',
    "achieve.first": '<circle cx="12" cy="8.5" r="5.5"/><path d="M8.8 13.5 7.5 20.5l4.5-2.2 4.5 2.2-1.3-7"/>',
    "achieve.streak": '<path d="M12 3c1.2 3.1 4.5 4.7 4.5 8.4a4.5 4.5 0 0 1-9 0c0-1.6.6-2.8 1.7-3.9C9.4 6.5 11 4.9 12 3z"/>',
    "achieve.month": '<path d="M7 4.5h10V8a5 5 0 0 1-10 0z"/><path d="M7 5.5H4.5V7.5a3 3 0 0 0 3 3M17 5.5h2.5v2a3 3 0 0 1-3 3M12 13v3.5M8.5 20.5h7M10 16.5h4"/>',
    "achieve.harvest": '<path d="m3 12.5 4.5 4.5L18.5 5.5"/><path d="m3 18.5 4.5 4.5L18.5 11.5"/>',
    "achieve.pen": '<path d="M5 19.5c2-.5 4-2 5.5-4L19 7a2.1 2.1 0 0 0-3-3L7.5 12.5c-2 1.5-3.5 3.5-4 5.5z"/><path d="M14 6l3 3"/>',
    "achieve.web": '<circle cx="6" cy="7" r="2.6"/><circle cx="18" cy="7" r="2.6"/><circle cx="12" cy="17.5" r="2.6"/><path d="M8.3 8.3 10 14.9M15.7 8.3 14 14.9M6 9.6v4.9M18 9.6v4.9"/>',
    "tag.tag": '<path d="M3.5 12.6V5.5a2 2 0 0 1 2-2h7.1a2 2 0 0 1 1.4.6l6 6a2 2 0 0 1 0 2.8l-7.1 7.1a2 2 0 0 1-2.8 0l-6-6a2 2 0 0 1-.6-1.4z"/><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" stroke="none"/>',
    "link.link": '<path d="M9.5 14.5 14.5 9.5"/><path d="M11 6.5 13 4.5a4 4 0 0 1 5.6 5.6L16.5 12"/><path d="M13 17.5l-2 2a4 4 0 0 1-5.6-5.6l2-2"/>',
    "folder.folder": '<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    "folder.plus": '<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/>',
    "theme.sun": '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    "theme.moon": '<path d="M20 13.2A8 8 0 1 1 10.8 4a6.5 6.5 0 0 0 9.2 9.2z"/>',
    "theme.palette": '<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-.9 2-2s-.9-2-2-2h-1a2 2 0 0 1 0-4h4.5A4.5 4.5 0 0 0 21 8.5C21 5.5 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.1" fill="currentColor" stroke="none"/><circle cx="10.5" cy="7.2" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="7.2" r="1.1" fill="currentColor" stroke="none"/>',
    "pomo.play": '<path d="M7 4.5v15l12-7.5z"/>',
    "pomo.pause": '<path d="M8 4.5v15M16 4.5v15"/>',
    "pomo.stop": '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    "pomo.clock": '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    "pomo.coffee": '<path d="M4 8h12v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M16 9h2.5a2.5 2.5 0 0 1 0 5H16"/><path d="M7 3v2M11 3v2"/>',
    "data.export": '<path d="M12 15V3.5M7.5 10.5 12 15l4.5-4.5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    "data.import": '<path d="M12 3.5V15M7.5 8 12 12.5 16.5 8" transform="rotate(180 12 9.25) translate(0 5.5)"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    "data.db": '<ellipse cx="12" cy="5.5" rx="8" ry="2.8"/><path d="M4 5.5V18.5c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8V5.5M4 12c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8"/>',
    "data.trash": '<path d="M4.5 7h15M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2M6.5 7l1 12a2 2 0 0 0 2 1.8h5a2 2 0 0 0 2-1.8l1-12"/><path d="M10 11v5.5M14 11v5.5"/>',
    "warn.overdue": '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V13M12 16.2v.1"/>',
    "warn.alert": '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.3v.1"/>',
    "win.minimize": '<path d="M5 12h14"/>',
    "win.maximize": '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    "win.pin": '<path d="M12 17v4.5"/><path d="M9.5 3.5h5l1 6.5 2.5 2.5v1.5H6v-1.5L8.5 10z"/>',
    "external.open": '<path d="M14 4.5h5.5V10M19.5 4.5 12 12"/><path d="M19.5 14v4.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2H10"/>',
}

_icons.register_many(_BUSINESS_ICONS)


# ---- 框架 API 转发（保持既有调用点可用）----

#: 图标的 SVG 字节
icon_svg = _icons.svg_bytes
#: 渲染成 QPixmap（内存）
pixmap = _icons.pixmap
#: 渲染成 QIcon（跟随主题色）
icon = _icons.icon
#: 已注册的图标名
names = _icons.names
#: 主题变化后清缓存（旧名，语义等价）
on_theme_change = _icons.clear_cache


def data_uri(name: str, color: str, size: int = 16) -> str:
    """兼容旧 API：QSS 可用的图标地址。

    旧实现想返回 data URI，但实测 Qt 的 QSS **不支持**（渲染出 0 像素），
    所以这里统一返回文件路径。
    """
    return _icons.file_url(name, color)


def icon_file(name: str, color: str) -> str:
    """QSS 用：图标文件路径（平台缓存目录，带颜色哈希与自动清理）。"""
    return _icons.file_url(name, color)


def _open_book_path(path: QPainterPath, s: float):
    """展开书本轮廓（两页 + 中缝），供笔记/待建链接节点复用。"""
    path.moveTo(0, -0.9 * s)
    path.cubicTo(-0.3 * s, -0.6 * s, -0.7 * s, -0.6 * s, -s, -0.28 * s)
    path.lineTo(-s, 0.62 * s)
    path.cubicTo(-0.68 * s, 0.4 * s, -0.35 * s, 0.4 * s, 0, 0.72 * s)
    path.cubicTo(0.35 * s, 0.4 * s, 0.68 * s, 0.4 * s, s, 0.62 * s)
    path.lineTo(s, -0.28 * s)
    path.cubicTo(0.7 * s, -0.6 * s, 0.3 * s, -0.6 * s, 0, -0.9 * s)
    path.closeSubpath()


def node_shape_path(kind: str, span: float) -> QPainterPath:
    """图谱节点形状路径（四类节点视觉语义）。

    folder 文件夹 / note 展开书本 / task 五角星 / flash 闪电；
    dangling（待建链接）与 note 同形（由调用方决定空心虚线描边）。
    span 为节点特征半径（路径外接半宽）。
    """
    path = QPainterPath()
    if kind == "folder":
        body_top = -0.22 * span
        tab_top = -0.78 * span
        left, right = -span, span
        bottom = 0.72 * span
        tab_right = -0.34 * span
        tab_join = -0.04 * span
        path.moveTo(left, body_top)
        path.lineTo(left, tab_top)
        path.lineTo(tab_right, tab_top)
        path.lineTo(tab_join, body_top)
        path.lineTo(right, body_top)
        path.lineTo(right, bottom)
        path.lineTo(left, bottom)
        path.closeSubpath()
    elif kind == "task":
        for i in range(10):
            ang = -math.pi / 2 + i * math.pi / 5
            r = span if i % 2 == 0 else span * 0.45
            x, y = math.cos(ang) * r, math.sin(ang) * r
            if i == 0:
                path.moveTo(x, y)
            else:
                path.lineTo(x, y)
        path.closeSubpath()
    elif kind == "flash":
        pts = ((0.10, -0.95), (-0.68, 0.16), (-0.18, 0.16),
               (-0.10, 0.95), (0.68, -0.16), (0.18, -0.16))
        path.moveTo(pts[0][0] * span, pts[0][1] * span)
        for x, y in pts[1:]:
            path.lineTo(x * span, y * span)
        path.closeSubpath()
    elif kind == "anchor":
        # v0.15 P1-3: 段落锚 = 小圆点（引用片段，标签在下方）
        path.addEllipse(-span * 0.45, -span * 0.45, span * 0.9, span * 0.9)
    else:  # note / dangling：展开书本
        _open_book_path(path, span)
    return path
