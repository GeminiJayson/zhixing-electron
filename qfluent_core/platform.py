# -*- coding: utf-8 -*-
"""平台能力：把「哪些地方必须按系统区分」集中到一处。

以前这些判断散在各文件里（material / window / …），漏一处就表现为某个系统上
功能不对，而且很难发现。这里统一收口，并额外提供两个容易被忽略的能力：

- shortcut_hint()：macOS 用 ⌘、其它系统用 Ctrl（写死 ⌘ 在 Windows 上就是错的）；
- window_shadow()：macOS 的无边框窗口**没有**系统阴影（Windows 由 DWM 提供），
  不补就永远比原生窗口「扁」；补的时候只能用 AppKit 的 hasShadow，
  不能碰 NSVisualEffectView（那个会造成进程级崩溃）。
"""
from __future__ import annotations

import sys
from typing import Dict

__all__ = [
    "is_macos", "is_windows", "is_linux", "mod_key", "mod_name",
    "shortcut_hint", "corner_strategy", "window_shadow", "capabilities",
]


def is_macos() -> bool:
    return sys.platform == "darwin"


def is_windows() -> bool:
    return sys.platform.startswith("win")


def is_linux() -> bool:
    return sys.platform.startswith("linux")


def mod_key() -> str:
    """快捷键修饰符的显示符号。"""
    return "\u2318" if is_macos() else "Ctrl"


def mod_name() -> str:
    """快捷键修饰符的完整书写形式（用于无障碍文本）。"""
    return "Command" if is_macos() else "Ctrl"


def shortcut_hint(key: str) -> str:
    """把按键转成当前平台的快捷键提示，例如 (K) -> 「⌘K」/「Ctrl+K」。"""
    key = str(key).strip()
    if not key:
        return ""
    if is_macos():
        return "\u2318" + key.upper()
    return "Ctrl+" + key.upper()


def corner_strategy() -> str:
    """窗口圆角由谁负责。

    dwm          Windows：由系统裁剪（不能开透明背景，否则会锯齿/丢阴影/拖动闪烁）
    translucent  macOS / Linux：root 透明 + QSS 圆角
    """
    return "dwm" if is_windows() else "translucent"


def window_shadow(window) -> bool:
    """给无边框窗口补系统阴影，返回是否成功。

    Windows 由 DWM 自带阴影；macOS 的无边框窗口默认没有阴影，需要用 AppKit 打开。
    只调用 setHasShadow_（安全），不碰 NSVisualEffectView（会崩）。
    """
    if not is_macos():
        return False
    try:
        from AppKit import NSApp
        ns_app = NSApp()
        if ns_app is None:
            return False
        target = None
        for ns_window in ns_app.windows():
            try:
                if int(ns_window.windowNumber()) == int(window.winId()):
                    target = ns_window
                    break
            except Exception:
                continue
        if target is None:
            return False
        target.setHasShadow_(True)
        return True
    except Exception:  # noqa: BLE001 —— 平台能力缺失属预期
        return False


def capabilities() -> Dict[str, object]:
    """当前平台的能力与策略（诊断用，也便于 UI 显示）。"""
    return {
        "platform": "macos" if is_macos() else ("windows" if is_windows() else "linux"),
        "corner_strategy": corner_strategy(),
        "mod_key": mod_key(),
        "supports_native_round_corners": is_windows(),
        "supports_system_shadow": is_windows(),
        "shadow_needs_appkit": is_macos(),
    }
