# -*- coding: utf-8 -*-
"""SVG 图标系统：路径定义 + 主题色 + 尺寸/DPI，统一缓存。

为什么自己管图标而不是引图标库：框架要保持零第三方依赖，
而且图标必须能跟着主题色走（写死的彩色图标在多主题下必然割裂）。

两条输出路径，因为用途不同（这是实测得出的结论，别合并）：

- icon() / pixmap() —— 给控件的 QIcon/QPixmap，**纯内存渲染**
  （QSvgRenderer），按 (name, color, size, dpr) 缓存，不落盘；
- file_url() —— 给 QSS 的 image: url(...)，**必须落盘**：
  实测 Qt 的 QSS **不支持 data URI**（用 data URI 设 border-image 渲染出 0 像素），
  所以只能写文件。文件写到平台缓存目录（不是 /tmp），文件名含颜色哈希，
  写入前会清理旧文件，避免颜色一变就无限增长。

用法：

    icon("search")                        # 跟随主题的 fg2 色
    icon("check", color="#16A34A", size=16)
    button.setIcon(icon("plus"))
    set_icon(button, "trash")             # 一步到位
    register("biz.thing", "<path .../>")  # 业务扩展自己的图标
"""
from __future__ import annotations

import hashlib
import os
import sys
import tempfile
from pathlib import Path
from typing import Dict, Mapping, Optional, Tuple

from PySide6.QtCore import QByteArray, QSize, Qt
from PySide6.QtGui import QAction, QIcon, QPainter, QPixmap
from PySide6.QtSvg import QSvgRenderer

__all__ = [
    "icon", "pixmap", "svg_bytes", "file_url", "set_icon", "register",
    "register_many", "names", "has", "clear_cache", "ICON_NAMES",
    "DEFAULT_SIZE",
]

#: 默认图标边长（px）
DEFAULT_SIZE = 18
#: 控件渲染的超采样倍数：小尺寸描边图标必须超采样才不糊
_SUPERSAMPLE = 4

#: 内置通用图标（stroke 风格，颜色由 currentColor 注入）。
#: 业务图标请用 register() 注册，不要往这里塞业务语义。
_ICONS: Dict[str, str] = {
    "chevron-down": '<path d="M3 4.5 6 7.5 9 4.5"/>',
    "chevron-up": '<path d="M3 7.5 6 4.5 9 7.5"/>',
    "chevron-left": '<path d="M7.5 3 4.5 6 7.5 9"/>',
    "chevron-right": '<path d="M4.5 3 7.5 6 4.5 9"/>',
    "expand": '<path d="M7 10l5 5 5-5"/>',
    "collapse": '<path d="M7 14l5-5 5 5"/>',
    "fullscreen": '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    "check": '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    "close": '<path d="M6 6l12 12M18 6 6 18"/>',
    "plus": '<path d="M12 5v14M5 12h14"/>',
    "minus": '<path d="M5 12h14"/>',
    "more": ('<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/>'
             '<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>'
             '<circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/>'),
    "search": '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>',
    "edit": '<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    "copy": '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
    "trash": '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
    "refresh": '<path d="M20 12a8 8 0 1 1-2.3-5.1M20 3.5V8h-4.5"/>',
    "filter": '<path d="M4 5h16l-6.2 7.2V19l-3.6-2.2v-4.6z"/>',
    "back": '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    "forward": '<path d="M5 12h14M12 5l7 7-7 7"/>',
    "download": '<path d="M12 4v11M7.5 11 12 15.5 16.5 11M5 20h14"/>',
    "upload": '<path d="M12 20V9M7.5 13 12 8.5 16.5 13M5 4h14"/>',
    "attach": ('<path d="M21 12.5 12.5 21a5.7 5.7 0 0 1-8-8L13.5 4a3.8 3.8 0 0 1 5.4 5.4'
               'l-8.9 8.9a1.9 1.9 0 0 1-2.7-2.7L16 7"/>'),
    "info": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.8v.4"/>',
    "warning": '<path d="M12 3.5 21 19.5H3z"/><path d="M12 10v4M12 16.6v.4"/>',
    "error": '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    "success": '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.3 2.4 2.4 4.6-4.9"/>',
    "settings": ('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v3M12 18.2v3'
                 'M4.1 7.4l2.6 1.5M17.3 15.1l2.6 1.5M4.1 16.6l2.6-1.5M17.3 8.9l2.6-1.5"/>'),
    "sun": ('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4'
            'M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    "moon": '<path d="M20 13.2A8 8 0 1 1 10.8 4a6.5 6.5 0 0 0 9.2 9.2z"/>',
    "palette": ('<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-.9 2-2s-.9-2-2-2h-1a2 2 0 0 1 0-4'
                'h4.5A4.5 4.5 0 0 0 21 8.5C21 5.5 17 3 12 3z"/>'
                '<circle cx="8" cy="10" r="1.2" fill="currentColor" stroke="none"/>'),
    "folder": ('<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2'
               'h-13a2 2 0 0 1-2-2z"/>'),
    "file": '<path d="M6 3.5h9.5L20 8v12.5H6z"/><path d="M15 3.5V8h5"/>',
    "link": ('<path d="M9.5 14.5 14.5 9.5"/><path d="M11 6.5 13 4.5a4 4 0 0 1 5.6 5.6'
             'L16.5 12"/><path d="M13 17.5l-2 2a4 4 0 0 1-5.6-5.6l2-2"/>'),
    "tag": ('<path d="M3.5 12.6V5.5a2 2 0 0 1 2-2h7.1a2 2 0 0 1 1.4.6l6 6a2 2 0 0 1 0 2.8'
            'l-7.1 7.1a2 2 0 0 1-2.8 0l-6-6a2 2 0 0 1-.6-1.4z"/>'
            '<circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" stroke="none"/>'),
}

_pixmap_cache: Dict[Tuple[str, str, int, int], QPixmap] = {}
_icon_cache: Dict[Tuple[str, str, int], QIcon] = {}
_file_cache: Dict[Tuple[str, str], str] = {}
_icon_dir: Optional[Path] = None


def _icon_dir_path() -> Path:
    """QSS 图标文件的落盘目录（平台缓存目录，不是 /tmp）。

    必须**真的试写一次**：目录存在不等于可写（受限环境下 mkdir 会成功、
    写入却被拒绝），只看 mkdir 的异常会误判，导致后面每次写图标都失败。
    """
    global _icon_dir
    if _icon_dir is not None:
        return _icon_dir
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches"
    elif sys.platform.startswith("win"):
        base = Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir())
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache"))
    candidates = [base / "qfluent_core" / "icons",
                  Path(tempfile.gettempdir()) / "qfluent_core_icons"]
    for candidate in candidates:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            probe = candidate / ".write-probe"
            probe.write_text("", encoding="utf-8")
            probe.unlink()
            _icon_dir = candidate
            return _icon_dir
        except OSError:
            continue
    _icon_dir = Path(tempfile.gettempdir())
    return _icon_dir

def _purge_stale_files(keep: int = 400) -> None:
    """清理缓存目录里的旧图标文件。

    文件名里带颜色哈希，颜色一变就会产生新文件 —— 不清理会无限增长。
    """
    try:
        files = sorted(_icon_dir_path().glob("*.svg"),
                       key=lambda p: p.stat().st_mtime, reverse=True)
        for path in files[keep:]:
            try:
                path.unlink()
            except OSError:
                continue
    except OSError:
        pass


def _theme_color(role: str = "fg2") -> str:
    """从主题取颜色（拿不到就退回中性灰，保证不崩）。"""
    try:
        from .theme import ThemeManager
        tokens = ThemeManager.instance().tokens
        return str(tokens.get(role) or tokens.get("fg2") or "#6B7280")
    except Exception:  # noqa: BLE001
        return "#6B7280"


def _device_ratio() -> float:
    try:
        from PySide6.QtWidgets import QApplication
        app = QApplication.instance()
        if app is not None and app.primaryScreen() is not None:
            return float(app.primaryScreen().devicePixelRatio())
    except Exception:  # noqa: BLE001
        pass
    return 1.0


def _svg_markup(name: str, color: str, size: int) -> str:
    """把路径包装成完整 SVG（描边与 currentColor 都用传入颜色）。"""
    body = _ICONS.get(name) or _ICONS["info"]
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="{s}" height="{s}" '
        'viewBox="0 0 24 24" fill="none" stroke="{c}" stroke-width="1.7" '
        'stroke-linecap="round" stroke-linejoin="round" '
        'color="{c}">{b}</svg>'
    ).format(s=size, c=color, b=body)


def svg_bytes(name: str, color: Optional[str] = None, size: int = 24) -> QByteArray:
    """图标的 SVG 字节（便于自行渲染或测试）。"""
    return QByteArray(_svg_markup(name, color or _theme_color(), size).encode("utf-8"))


def pixmap(name: str, color: Optional[str] = None, size: Optional[int] = None,
           dpr: Optional[float] = None) -> QPixmap:
    """渲染成 QPixmap（内存，超采样保证小尺寸清晰）。"""
    size = int(size or DEFAULT_SIZE)
    color = color or _theme_color()
    ratio = float(dpr if dpr is not None else _device_ratio())
    key = (name, color.lower(), size, round(ratio, 2))
    cached = _pixmap_cache.get(key)
    if cached is not None:
        return cached

    # 物理像素 = 逻辑尺寸 x 屏幕DPR x 超采样；devicePixelRatio 同步设成
    # (屏幕DPR x 超采样)，这样 Qt 认为它的**逻辑**尺寸正好是 size。
    # 只设超采样倍数是错的：逻辑尺寸会跟着放大（20px 图标变成 80px）。
    scale = max(1.0, ratio) * _SUPERSAMPLE
    physical = max(1, int(round(size * scale)))
    renderer = QSvgRenderer(QByteArray(_svg_markup(name, color, physical).encode("utf-8")))
    pm = QPixmap(QSize(physical, physical))
    pm.fill(Qt.transparent)
    painter = QPainter(pm)
    painter.setRenderHint(QPainter.Antialiasing, True)
    renderer.render(painter)
    painter.end()
    pm.setDevicePixelRatio(scale)
    _pixmap_cache[key] = pm
    return pm


def icon(name: str, color: Optional[str] = None, size: Optional[int] = None, *,
         active_color: Optional[str] = None) -> QIcon:
    """渲染成 QIcon（跟随主题色；不传 color 用 token 的 fg2）。

    active_color 是**悬停/按下**时用的颜色。这很关键：QToolButton 的 hover 往往
    会换背景色（例如关闭按钮变红），图标若是静态色就会糊在背景里看不见。
    Qt 的做法是给同一条路径注册一个 Active 态的 pixmap，由控件自行切换。
    """
    resolved = color or _theme_color()
    active = active_color or ""
    key = (name, resolved.lower(), int(size or DEFAULT_SIZE))
    cached = _icon_cache.get(key)
    if cached is not None and not active:
        return cached
    result = QIcon(pixmap(name, resolved, size))
    if active:
        result.addPixmap(pixmap(name, active, size), QIcon.Active)
        result.addPixmap(pixmap(name, active, size), QIcon.Selected)
    else:
        _icon_cache[key] = result
    return result


def file_url(name: str, color: Optional[str] = None) -> str:
    """给 QSS 用的图标文件路径（image: url(<返回值>)）。

    只用于 QSS —— 控件请用 icon()/pixmap()，那是内存渲染、不产生文件。
    Qt 的 QSS 实测不支持 data URI，所以这里必须落盘。
    """
    resolved = color or _theme_color()
    key = (name, resolved.lower())
    cached = _file_cache.get(key)
    if cached and Path(cached).exists():
        return cached

    markup = _svg_markup(name, resolved, 48)
    digest = hashlib.sha1(markup.encode("utf-8")).hexdigest()[:16]
    path = _icon_dir_path() / ("%s-%s.svg" % (name.replace(".", "_"), digest))
    try:
        if not path.exists():
            _purge_stale_files()
            path.write_text(markup, encoding="utf-8")
    except OSError:
        return ""
    _file_cache[key] = path.as_posix()
    return path.as_posix()


def set_icon(widget, name: str, color: Optional[str] = None,
             size: Optional[int] = None) -> bool:
    """给按钮/动作一步设置图标。返回是否成功。"""
    target = widget
    try:
        action = widget.defaultAction() if hasattr(widget, "defaultAction") else None
        if isinstance(action, QAction):
            target = action
    except Exception:  # noqa: BLE001
        pass
    try:
        target.setIcon(icon(name, color, size))
        return True
    except Exception:  # noqa: BLE001
        return False


def register(name: str, body: str) -> None:
    """注册一个图标（body 是 viewBox 24x24 内的 SVG 片段，不含 svg 外壳）。"""
    _ICONS[str(name)] = str(body)
    clear_cache()


def register_many(mapping: Mapping[str, str]) -> int:
    """批量注册，返回注册数量。"""
    for name, body in (mapping or {}).items():
        _ICONS[str(name)] = str(body)
    clear_cache()
    return len(mapping or {})


def has(name: str) -> bool:
    return name in _ICONS


def names(prefix: str = "") -> Tuple[str, ...]:
    """已注册的图标名（可按前缀过滤，如 nav.）。"""
    return tuple(sorted(n for n in _ICONS if n.startswith(prefix)))


def clear_cache() -> None:
    """清空内存缓存（注册新图标或主题色变化后调用）。"""
    _pixmap_cache.clear()
    _icon_cache.clear()


#: 交互需要的第二批图标：窗口控件、编辑、视图、媒体、通用。
#: 按「组件真的会用」来加，不为了凑数堆图标。
_ICONS.update({
    # ---- 窗口控件（替代原来的 – □ ✕ 字符，字符在不同字体下大小/基线不一致）----
    "win-minimize": '<path d="M6 12h12"/>',
    "win-maximize": '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    "win-restore": ('<rect x="8" y="5" width="11" height="11" rx="1.5"/>'
                    '<path d="M5 8v9.5A1.5 1.5 0 0 0 6.5 19H16"/>'),
    "menu": '<path d="M4 7h16M4 12h16M4 17h16"/>',
    # ---- 编辑 ----
    "bold": '<path d="M7 5h6.5a3.5 3.5 0 0 1 0 7H7zM7 12h7.5a3.5 3.5 0 0 1 0 7H7z"/>',
    "italic": '<path d="M15 5h-5M14 19H9M14 5 10 19"/>',
    "underline": '<path d="M7 5v7a5 5 0 0 0 10 0V5M5 20h14"/>',
    "strike": '<path d="M5 12h14M8.5 8.5C9 6.8 10.3 5.8 12 5.8c2 0 3.4 1 3.4 2.6M15.5 15.4'
              'c-.5 1.7-1.9 2.8-3.7 2.8-2.2 0-3.6-1.1-3.6-2.8"/>',
    "code": '<path d="M9 8 5.5 12 9 16M15 8l3.5 4L15 16"/>',
    "list": ('<circle cx="5" cy="7" r="1.2" fill="currentColor" stroke="none"/>'
             '<circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none"/>'
             '<circle cx="5" cy="17" r="1.2" fill="currentColor" stroke="none"/>'
             '<path d="M9 7h10M9 12h10M9 17h10"/>'),
    "ordered-list": '<path d="M10 7h9M10 12h9M10 17h9M4.5 5.5 6 5v3M4 17.2c0-.7.6-1.2 1.3-1.2'
                    '.8 0 1.3.5 1.3 1.2 0 1.1-2.6 1.6-2.6 2.8h2.8"/>',
    "quote": '<path d="M6 8h4v4a4 4 0 0 1-4 4M14 8h4v4a4 4 0 0 1-4 4"/>',
    "heading": '<path d="M6 5v14M18 5v14M6 12h12"/>',
    "highlight": '<path d="M9 20h11M14.5 4 5 13.5l2.5 2.5L17 6.5z"/>',
    "undo": '<path d="M9 7H16a5 5 0 0 1 0 10h-6M9 3 5 7l4 4"/>',
    "redo": '<path d="M15 7H8a5 5 0 0 0 0 10h6M15 3l4 4-4 4"/>',
    # ---- 视图 / 表格 ----
    "eye": '<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z"/>'
           '<circle cx="12" cy="12" r="3"/>',
    "eye-off": '<path d="M4 4l16 16M9.5 9.6A3 3 0 0 0 12 15c.8 0 1.6-.3 2.1-.9M6.3 6.9'
               'C4 8.5 2.5 12 2.5 12s3.5 5.5 9.5 5.5c1.6 0 3-.4 4.2-1.1M9.9 6.7A9 9 0 0 1 12 6.5'
               'c6 0 9.5 5.5 9.5 5.5a17 17 0 0 1-3 3.3"/>',
    "zoom-in": '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8M11 8.5v5M8.5 11h5"/>',
    "zoom-out": '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8M8.5 11h5"/>',
    "columns": '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M12 4.5v15"/>',
    "sort-asc": '<path d="M7 18V6M4 9l3-3 3 3M12 8h8M12 12h6M12 16h4"/>',
    "sort-desc": '<path d="M7 6v12M4 15l3 3 3-3M12 8h4M12 12h6M12 16h8"/>',
    "expand-all": '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    "collapse-all": '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    "drag-handle": ('<circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none"/>'
                    '<circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none"/>'
                    '<circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/>'
                    '<circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/>'
                    '<circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none"/>'
                    '<circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none"/>'),
    # ---- 媒体 / 时间 ----
    "play": '<path d="M8 5.5 18.5 12 8 18.5z"/>',
    "pause": '<path d="M9 5v14M15 5v14"/>',
    "stop": '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
    "skip-back": '<path d="M18.5 6v12L9 12zM6 5.5v13"/>',
    "skip-forward": '<path d="M5.5 6v12L15 12zM18 5.5v13"/>',
    "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/>',
    "calendar": '<rect x="3" y="4.5" width="18" height="16.5" rx="3"/>'
                '<path d="M8 2.5v4M16 2.5v4M3 10h18"/>',
    "timer": '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 1.5M9 2.5h6"/>',
    # ---- 通用对象 ----
    "user": '<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    "star": ('<path d="m12 3.8 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8'
             'L3.5 10l5.9-.9z"/>'),
    "heart": ('<path d="M12 20s-7.5-4.3-7.5-9.3A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7.5 2.7'
              'C19.5 15.7 12 20 12 20z"/>'),
    "pin": '<path d="M12 21v-6M8.5 4h7l-1 6 3 3H5.5l3-3z"/>',
    "lock": '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
    "unlock": '<rect x="5" y="10.5" width="14" height="10" rx="2"/>'
              '<path d="M8 10.5V8a4 4 0 0 1 7.5-2"/>',
    "image": '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/>'
             '<circle cx="9" cy="10" r="1.6"/><path d="m5 18 5-5 4 4 2.5-2.5L20 18"/>',
    "database": '<ellipse cx="12" cy="6.5" rx="7.5" ry="3"/>'
                '<path d="M4.5 6.5v11c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-11M4.5 12c0 1.7 3.4 3 7.5 3'
                's7.5-1.3 7.5-3"/>',
    "cloud": '<path d="M7 18.5a4 4 0 0 1-.4-8A5.5 5.5 0 0 1 17 9.6a4.5 4.5 0 0 1 .8 8.9z"/>',
    "chart": '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
    "keyboard": '<rect x="2.5" y="6.5" width="19" height="11" rx="2"/>'
                '<path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M8 14h8"/>',
    "help": '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.7'
            'M12 16.6v.4"/>',
})

#: 导航类通用图标：侧边栏等「一个入口一项」的场景用。
#: 只放通用语义（home/inbox/file…），业务专属的图标由业务注册。
_ICONS.update({
    "home": '<path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/>'
            '<path d="M9.5 20.5v-6h5v6"/>',
    "check-square": '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/>'
                    '<path d="m8 12.2 2.6 2.6L16.2 9"/>',
    "inbox": '<path d="M4 13.5 6.5 5.5h11L20 13.5v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>'
             '<path d="M4 13.5h4.5a3.5 3.5 0 0 0 7 0H20"/>',
    "file-text": '<path d="M6 3.5h9.5L20 8v12.5H6z"/><path d="M15 3.5V8h5M9 12h7M9 16h5"/>',
    "workflow": '<rect x="3" y="3" width="7" height="6" rx="1.6"/>'
                '<rect x="14" y="15" width="7" height="6" rx="1.6"/>'
                '<path d="M6.5 9v4.5a2 2 0 0 0 2 2H14"/>',
    "share": ('<circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="6" r="2.6"/>'
              '<circle cx="18" cy="18" r="2.6"/><path d="m8.4 10.7 7.2-3.4M8.4 13.3l7.2 3.4"/>'),
    "history": '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4.5V9H8"/>'
               '<path d="M12 8v4.5l3 1.8"/>',
    "dashboard": '<rect x="3.5" y="3.5" width="7" height="8" rx="1.6"/>'
                 '<rect x="13.5" y="3.5" width="7" height="5" rx="1.6"/>'
                 '<rect x="3.5" y="14.5" width="7" height="6" rx="1.6"/>'
                 '<rect x="13.5" y="11.5" width="7" height="9" rx="1.6"/>',
})

#: 只读快照，便于测试与文档
ICON_NAMES: Tuple[str, ...] = tuple(sorted(_ICONS))
