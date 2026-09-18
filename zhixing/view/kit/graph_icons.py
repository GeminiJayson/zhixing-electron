# -*- coding: utf-8 -*-
"""图谱节点多色 SVG 图标集（现代扁平矢量 + 双色调层级）。

每个图标由多个语义分组的 <g> 元素组合而成（主体 / 核心符号 / 装饰细节），
使用具体十六进制颜色，可在任意尺寸下保持清晰辨识度；可被 CSS/代码动态改色。

图标种类：
    folder    文件夹（暖向日葵黄 + 深琥珀折角）
    markdown  Markdown 笔记（炭黑页 + 白文本线 + 青蓝绿 MD 角标）
    word      Word / 富文本（科技深蓝 + 浅天蓝斜折角）
    excel     Excel 表格（翡翠绿 + 薄荷绿 + 高亮单元格）
    pdf       PDF 文献（砖红 + 绯红 + PDF 徽章）
    media     音视频多媒体（霓虹紫 + 洋红 + 亮橙播放）
    link      网页 / 本地文件链接（电光青 + 淡水蓝链条）
    task      任务（芒果黄复选框 + 对勾绿）
    flash     闪记（紫罗兰便签 + 电光金黄闪电）

注：所有图标内容外接约 2~22（占满 24x24 视口约 83%），渲染到节点时视觉饱满、不裁切。
"""
from PySide6.QtCore import QByteArray, Qt
from PySide6.QtGui import QPainter, QPixmap
from PySide6.QtSvg import QSvgRenderer


def _svg(body: str) -> str:
    return ('<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">'
            + body + '</svg>')


# ================= 9 个多色图标 =================
GRAPH_NODE_SVGS = {
    "folder": _svg(
        '<g id="folder-back" fill="#E0A32E">'
        '<path d="M2 7a2 2 0 0 1 2-2h4.2l2.1 2H22a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/>'
        '</g>'
        '<g id="folder-front" fill="#F6C445">'
        '<path d="M2 8h20v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/>'
        '<path d="M2 8.7a2 2 0 0 1 2-2h3.5l2 2H22a2 2 0 0 1 2 2v.5H2z" fill="#FAD87A"/>'
        '</g>'
        '<g id="papers" fill="#FFFFFF">'
        '<rect x="4.5" y="11" width="15" height="6.7" rx="1.2" opacity="0.95"/>'
        '<rect x="6" y="12.3" width="12" height="1" rx="0.5" fill="#E8D08A" opacity="0.85"/>'
        '</g>'
    ),
    "markdown": _svg(
        '<g id="doc" fill="#2B2B2B">'
        '<path d="M5.5 3h9L20 8.5V20a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 20V4.5A1.5 1.5 0 0 1 5.5 3z"/>'
        '<path d="M14.5 3v5.5H20z" fill="#3F3F3F"/>'
        '</g>'
        '<g id="lines" fill="none" stroke="#FFFFFF" stroke-width="1.4" stroke-linecap="round">'
        '<path d="M8 11.5h8"/><path d="M8 14.2h5.6"/><path d="M8 16.9h6.6"/>'
        '</g>'
        '<g id="md-badge" fill="#1FB8B0">'
        '<rect x="14" y="14" width="6.5" height="6.5" rx="1.6"/>'
        '</g>'
        '<g id="md-text" fill="#FFFFFF" font-family="sans-serif" font-size="3.4" font-weight="700">'
        '<text x="17.25" y="18.8" text-anchor="middle">MD</text>'
        '</g>'
    ),
    "word": _svg(
        '<g id="doc" fill="#2B6CB0">'
        '<path d="M5 3h9.5L20 8.5V20.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>'
        '</g>'
        '<g id="fold" fill="#A8D4F0">'
        '<path d="M14.5 3L20 8.5h-4.5a1 1 0 0 1-1-1z"/>'
        '</g>'
        '<g id="lines" fill="none" stroke="#FFFFFF" stroke-width="1.3" stroke-linecap="round">'
        '<path d="M7.8 11.2h8.4"/><path d="M7.8 14h7.4"/><path d="M7.8 16.8h8.4"/><path d="M7.8 19.6h5.4"/>'
        '</g>'
    ),
    "excel": _svg(
        '<g id="doc" fill="#1E9E5A">'
        '<path d="M5 3h9.5L20 8.5V20.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>'
        '</g>'
        '<g id="fold" fill="#7BD3A0">'
        '<path d="M14.5 3L20 8.5h-4.5a1 1 0 0 1-1-1z"/>'
        '</g>'
        '<g id="grid" fill="none" stroke="#FFFFFF" stroke-width="0.8">'
        '<path d="M7.5 11h9v7.5h-9z"/><path d="M10.5 11v7.5M13.5 11v7.5M16.5 11v7.5M7.5 13.5h9M7.5 16h9"/>'
        '</g>'
        '<g id="highlight"><rect x="10.6" y="13.6" width="2.8" height="2.4" rx="0.5" fill="#FFD54F"/></g>'
    ),
    "pdf": _svg(
        '<g id="page" fill="#C0392B">'
        '<path d="M5.5 3h9L20 8.5V20a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 20V4.5A1.5 1.5 0 0 1 5.5 3z"/>'
        '<path d="M14.5 3v5.5H20z" fill="#E74C3C"/>'
        '</g>'
        '<g id="lines" fill="none" stroke="#FFFFFF" stroke-width="1.2" stroke-linecap="round" opacity="0.9">'
        '<path d="M8 11.4h8"/><path d="M8 14h6"/>'
        '</g>'
        '<g id="pdf-badge" fill="#FFFFFF">'
        '<rect x="7.4" y="16.4" width="9.2" height="3.8" rx="1.2"/>'
        '</g>'
        '<g id="pdf-text" fill="#C0392B" font-family="sans-serif" font-size="2.6" font-weight="800">'
        '<text x="12" y="19.1" text-anchor="middle">PDF</text>'
        '</g>'
    ),
    "media": _svg(
        '<g id="card" fill="#8E44AD">'
        '<rect x="3" y="4.5" width="18" height="15" rx="2.6"/>'
        '</g>'
        '<g id="screen" fill="#E91E63">'
        '<rect x="5.2" y="6.7" width="13.6" height="9.8" rx="1.3"/>'
        '</g>'
        '<g id="play" fill="#FF9800">'
        '<path d="M10 8.6v5.2l4.6-2.6z"/>'
        '</g>'
    ),
    "link": _svg(
        '<g id="chain-back" fill="none" stroke="#9BD8E8" stroke-width="2.5" stroke-linecap="round">'
        '<path d="M9 15 15 9"/><path d="M6.6 11.4 5 13a3.2 3.2 0 0 0 4.5 4.5l1.8-1.8"/>'
        '</g>'
        '<g id="chain-front" fill="none" stroke="#00C9D2" stroke-width="2.5" stroke-linecap="round">'
        '<path d="M9 15 15 9"/><path d="M17.4 12.6 19 11a3.2 3.2 0 0 0-4.5-4.5l-1.8 1.8"/>'
        '</g>'
    ),
    "task": _svg(
        '<g id="box" fill="#FFB300">'
        '<rect x="3" y="3" width="18" height="18" rx="5"/>'
        '</g>'
        '<g id="inner" fill="#FFFFFF">'
        '<rect x="4.6" y="4.6" width="14.8" height="14.8" rx="3.6"/>'
        '</g>'
        '<g id="check" fill="none" stroke="#2ECC71" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">'
        '<path d="M8 12.4l2.7 2.7 5.5-6.1"/>'
        '</g>'
    ),
    "flash": _svg(
        '<g id="note" fill="#7C3AED">'
        '<rect x="3.6" y="3.6" width="16.8" height="16.8" rx="3.2"/>'
        '<path d="M4.8 3.6c2-.9 6.8-1.6 8.4 0" fill="#8E5BE0"/>'
        '</g>'
        '<g id="bolt" fill="#FFD600">'
        '<path d="M13.4 5.8 8.4 12.6h2.7l-.6 5.6 5-6.8h-2.7z"/>'
        '</g>'
    ),
}


# note.format → 图标种类（richtext 归入 word；pdf/media 为预留格式）
_FORMAT_ICON = {
    "markdown": "markdown",
    "richtext": "word",
    "word": "word",
    "excel": "excel",
    "pdf": "pdf",
    "media": "media",
    "link": "link",
}


def icon_kind(node_kind: str, note_format: str = "markdown") -> str:
    """节点 kind + 笔记 format → 图标种类。dangling 复用 link（待建链接语义）。"""
    if node_kind == "note":
        return _FORMAT_ICON.get(note_format or "markdown", "markdown")
    if node_kind == "dangling":
        return "link"
    if node_kind in GRAPH_NODE_SVGS:
        return node_kind
    return "markdown"


_pixmap_cache = {}


def graph_node_pixmap(kind: str, size: int, dpr: float = 1.0) -> QPixmap:
    """把多色 SVG 渲染成 QPixmap（任意 size，随调用方调节），带缓存。"""
    key = (kind, size, dpr)
    cached = _pixmap_cache.get(key)
    if cached is not None:
        return cached
    svg = GRAPH_NODE_SVGS.get(kind)
    if svg is None:
        svg = GRAPH_NODE_SVGS["markdown"]
    data = QByteArray(svg.encode("utf-8"))
    renderer = QSvgRenderer(data)
    pm = QPixmap(int(size * dpr), int(size * dpr))
    pm.setDevicePixelRatio(dpr)
    pm.fill(Qt.transparent)
    painter = QPainter(pm)
    renderer.render(painter)
    painter.end()
    _pixmap_cache[key] = pm
    return pm


_renderer_cache = {}


def graph_node_renderer(kind: str) -> QSvgRenderer:
    """返回多色 SVG 的渲染器（缓存），供矢量渲染（无锯齿、任意缩放清晰）。"""
    r = _renderer_cache.get(kind)
    if r is None:
        svg = GRAPH_NODE_SVGS.get(kind) or GRAPH_NODE_SVGS["markdown"]
        r = QSvgRenderer(QByteArray(svg.encode("utf-8")))
        _renderer_cache[kind] = r
    return r
