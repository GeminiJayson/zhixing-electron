# -*- coding: utf-8 -*-
"""显示材质：窗口层透明与平台合成（macOS Vibrancy / Windows Mica·Acrylic）。

分工：
- 「面」的颜色与透明度由 ThemeManager.material_tokens() 统一给出（控件与窗口共用同一观感）；
- 本模块只管窗口层：是否透明、以及是否需要平台合成。

原则：材质是观感增强，不是功能。任何平台 API 失败都静默退化（solid -> 半透明 -> 实色），
绝不抛异常、绝不让窗口无法显示。effective_material() 会如实报告最终生效的档位。
"""
from __future__ import annotations

import os
import sys
from typing import Dict, Optional

from PySide6.QtCore import Qt

__all__ = ["MATERIALS", "MATERIAL_LABELS", "platform_support", "effective_material",
           "apply_window_material", "is_translucent", "macos_native_enabled"]

MATERIALS = ("solid", "translucent", "frosted", "mica", "acrylic")
#: 旧名别名（glass 已改名为 frosted 的毛玻璃观感）
_ALIAS: Dict[str, str] = {"glass": "frosted"}

#: UI 显示用文案
MATERIAL_LABELS: Dict[str, str] = {
    "solid": "实色",
    "translucent": "半透明",
    "frosted": "毛玻璃",
    "mica": "Mica（系统材质）",
    "acrylic": "Acrylic（系统材质）",
}

#: 平台特效不可用时的退化目标
_FALLBACK: Dict[str, str] = {"mica": "translucent", "acrylic": "frosted"}


def is_translucent(material: str) -> bool:
    """该材质是否要求窗口层透明（否则看不到宿主/桌面背景）。"""
    return _ALIAS.get(material, material) in ("translucent", "frosted", "mica", "acrylic")


def _appkit_available() -> bool:
    try:
        import objc  # noqa: F401
        from AppKit import NSVisualEffectView  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def macos_native_enabled() -> bool:
    """macOS 系统材质是否允许启用（默认否，需显式 opt-in）。

    往 Qt 管理的 contentView 里插入 NSVisualEffectView 会与 Qt 的 Cocoa 集成相互影响，
    在实测中出现过进程级 Abort（try/except 拦不住的 native 崩溃）。系统材质只是观感
    增强，因此默认关闭：UI 里对应的档位灰显并退化到纯 Qt 观感；确实要试的人设置
    环境变量 QFLUENT_MACOS_VIBRANCY=1 再自行评估。
    """
    return os.environ.get("QFLUENT_MACOS_VIBRANCY", "").lower() in ("1", "true", "yes")


def platform_support() -> Dict[str, bool]:
    """各材质在当前平台是否可用（UI 据此禁用不可用项）。"""
    native = False
    if sys.platform == "darwin":
        native = _appkit_available() and macos_native_enabled()
    elif sys.platform.startswith("win"):
        native = True
    return {"solid": True, "translucent": True, "glass": True,
            "mica": native, "acrylic": native}


def effective_material(material: str) -> str:
    """实际会生效的材质名（平台特效不可用时退化到纯 Qt 观感）。"""
    material = _ALIAS.get(material, material)
    if material not in MATERIALS:
        return "solid"
    if material in _FALLBACK and not platform_support().get(material, False):
        return _FALLBACK[material]
    return material


def _macos_ns_window(window):
    """按尺寸匹配取回窗口的 NSWindow（不用 winId 桥接，避免非法指针）。"""
    try:
        from AppKit import NSApp
        ns_app = NSApp()
        if ns_app is None:
            return None
        width, height = window.width(), window.height()
        for ns_window in ns_app.windows():
            if not ns_window.isVisible():
                continue
            frame = ns_window.frame()
            if (abs(frame.size.width - width) < 6
                    and abs(frame.size.height - height) < 6):
                return ns_window
    except Exception:  # noqa: BLE001
        return None
    return None


def _apply_macos(window, material: str) -> bool:
    """用 NSVisualEffectView 铺一层窗口材质（仅在显式 opt-in 且插到 Qt 视图之下时）。"""
    if not macos_native_enabled():
        return False
    try:
        from AppKit import (NSVisualEffectMaterialHUDWindow,
                            NSVisualEffectMaterialSidebar, NSVisualEffectView)
    except Exception:  # noqa: BLE001
        return False
    ns_window = _macos_ns_window(window)
    if ns_window is None:
        return False
    try:
        content = ns_window.contentView()
        effect = NSVisualEffectView.alloc().initWithFrame_(content.bounds())
        effect.setAutoresizingMask_(18)          # WidthSizable | HeightSizable
        effect.setBlendingMode_(0)               # BehindWindow
        effect.setMaterial_(NSVisualEffectMaterialHUDWindow if material == "acrylic"
                            else NSVisualEffectMaterialSidebar)
        effect.setState_(1)                      # Active
        # NSWindowBelow(-1)：必须垫在 Qt 视图之下，否则会截断 Qt 的绘制与事件
        content.addSubview_positioned_relativeTo_(effect, -1, None)
        return True
    except Exception:  # noqa: BLE001
        return False


def _apply_windows(window, material: str) -> bool:
    """用 DWMWA_SYSTEMBACKDROP_TYPE 请求系统背景材质（Win11 22H2+）。"""
    try:
        import ctypes
        hwnd = ctypes.c_void_p(int(window.winId()))
        backdrop = ctypes.c_int(2 if material == "mica" else 3)  # MAINWINDOW / TRANSIENTWINDOW
        ctypes.windll.dwmapi.DwmSetWindowAttribute(
            hwnd, ctypes.c_int(38), ctypes.byref(backdrop), ctypes.sizeof(backdrop))
        return True
    except Exception:  # noqa: BLE001
        return False


def apply_window_material(window, material: str, *,
                          keep_translucent: bool = False) -> str:
    """把材质应用到顶层窗口，返回实际生效的材质名。

    keep_translucent=True 用于无边框圆角窗口：它的四角必须透明才能看到圆角，
    因此不能因为 material=solid 就把 WA_TranslucentBackground 关掉。
    """
    effective = effective_material(material)
    if sys.platform.startswith("win"):
        # Windows 上圆角由 DWM 负责（系统真正裁掉四角），**不能**再开透明背景：
        # 它会让边缘出现锯齿、丢掉系统阴影、拖动时闪烁，而且合成器并不按
        # QSS 的 border-radius 裁剪窗口 —— 那正是「Windows 上没圆角」的原因。
        want = False
    else:
        want = True if keep_translucent else is_translucent(effective)
    try:
        window.setAttribute(Qt.WA_TranslucentBackground, want)
    except Exception:  # noqa: BLE001
        pass
    if effective in ("mica", "acrylic"):
        applied = False
        if sys.platform == "darwin":
            applied = _apply_macos(window, effective)
        elif sys.platform.startswith("win"):
            applied = _apply_windows(window, effective)
        if not applied:
            effective = _FALLBACK[effective]
    return effective


def apply_window_corners(window) -> bool:
    """Windows 11：请求 DWM 圆角。返回是否成功。

    为什么需要它：无边框窗口在 Windows 上**不会**自动获得圆角，
    而 QSS 的 border-radius 只影响自绘内容 —— 合成器并不会按圆角裁剪窗口。
    macOS 那边靠 WA_TranslucentBackground 就能透出圆角，Windows 不行：
    透明背景在 Windows 上还会带来边缘锯齿、丢系统阴影、拖动闪烁等问题。

    所以在 Windows 上改用 DWM 圆角 + **不设透明背景**：由系统真正裁掉四角，
    观感和原生窗口一致。（Windows 10 及更早没有这个能力，返回 False，
    调用方可以退回透明背景方案。）
    """
    if not sys.platform.startswith("win"):
        return False
    try:
        import ctypes
        from ctypes import wintypes

        hwnd = wintypes.HWND(int(window.winId()))
        corner_preference = ctypes.c_int(2)      # DWMWCP_ROUND
        DWMWA_WINDOW_CORNER_PREFERENCE = 33
        result = ctypes.windll.dwmapi.DwmSetWindowAttribute(
            hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
            ctypes.byref(corner_preference), ctypes.sizeof(corner_preference))
        return result == 0
    except Exception:  # noqa: BLE001 —— 平台 API 不可用属预期，不影响可用性
        return False
