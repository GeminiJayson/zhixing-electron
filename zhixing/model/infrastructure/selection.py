# -*- coding: utf-8 -*-
"""划词抓取：模拟 Cmd/Ctrl+C 读取前台应用选中文本，剪贴板备份-恢复（ADR-8）。

流程异步化（QTimer 链），全程不打断用户焦点；无权限/失败返回降级模式。
"""
import platform
from typing import Callable, Optional

from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtGui import QClipboard, QGuiApplication

_GRAB_DELAY_MS = 220      # 模拟复制后等系统写剪贴板
_RESTORE_DELAY_MS = 600   # 读完恢复剪贴板


class SelectionGrabber(QObject):
    """grab(callback) → callback(text: str|None, mode: 'ok'|'clipboard_fallback'|'unsupported')"""

    finished = Signal(str, str)  # text, mode

    def __init__(self, parent=None):
        super().__init__(parent)
        self.system = platform.system()
        self._backup = None
        self._stage = 0

    # ---------- 对外 ----------
    def grab(self, done: Callable[[Optional[str], str], None]):
        cb = done
        try:
            ok = self._post_copy_shortcut()
        except Exception:
            ok = False
        if not ok:
            # 无辅助功能权限 / 平台不支持：自动降级为「剪贴板捕获」模式（F11-5），
            # 用户先复制再按热键即可。
            self.grab_clipboard(cb)
            return
        clip = QGuiApplication.clipboard()
        self._backup = clip.text(mode=QClipboard.Mode.Clipboard) or ""
        self._stage = 0
        QTimer.singleShot(_GRAB_DELAY_MS, lambda: self._read(cb))
        QTimer.singleShot(_GRAB_DELAY_MS + _RESTORE_DELAY_MS, self._restore)

    def grab_clipboard(self, done: Callable[[Optional[str], str], None]):
        """降级模式：直接读当前剪贴板。"""
        text = QGuiApplication.clipboard().text()
        done(text or None, "clipboard_fallback" if text else "unsupported")

    def frontmost_app_name(self) -> str:
        """当前前台应用名（划词来源）。失败返回空串，由调用方兜底。"""
        if self.system == "Darwin":
            try:
                from AppKit import NSWorkspace
                return NSWorkspace.sharedWorkspace().frontmostApplication().localizedName() or ""
            except Exception:
                return ""
        if self.system == "Windows":
            try:
                import ctypes
                hwnd = ctypes.windll.user32.GetForegroundWindow()
                length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
                buf = ctypes.create_unicode_buffer(length + 1)
                ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
                return buf.value or ""
            except Exception:
                return ""
        return ""

    # ---------- 内部 ----------
    def _post_copy_shortcut(self) -> bool:
        if self.system == "Darwin":
            try:
                import Quartz
                for down in (True, False):
                    ev = Quartz.CGEventCreateKeyboardEvent(None, 8, down)  # 8 = kVK_ANSI_C（7 是 X=剪切）
                    flag = Quartz.kCGEventFlagMaskCommand
                    if down:
                        Quartz.CGEventSetFlags(ev, flag)
                    Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
                return True
            except Exception:
                return False
        if self.system == "Windows":
            try:
                import ctypes
                PUL = ctypes.POINTER(ctypes.c_ulong)

                class _KINPUT(ctypes.Structure):
                    _fields_ = [("wVk", ctypes.c_ushort), ("wScan", ctypes.c_ushort),
                                ("dwFlags", ctypes.c_ulong), ("time", ctypes.c_ulong),
                                ("dwExtraInfo", PUL)]

                class _INPUTS(ctypes.Structure):
                    _fields_ = [("type", ctypes.c_ulong), ("ki", _KINPUT),
                                ("padding", ctypes.c_ubyte * 8)]

                def _key(vk, up=False):
                    i = _INPUTS()
                    i.type = 1
                    i.ki = _KINPUT(vk, 0, 2 if up else 0, 0, None)
                    ctypes.windll.user32.SendInput(1, ctypes.byref(i), ctypes.sizeof(i))

                _key(0x11)            # Ctrl down
                _key(0x43)            # C down
                _key(0x43, up=True)
                _key(0x11, up=True)
                return True
            except Exception:
                return False
        return False

    def _read(self, cb):
        text = QGuiApplication.clipboard().text()
        if text and text != self._backup:
            cb(text, "ok")
        else:
            cb(text or None, "ok" if text else "clipboard_fallback")

    def _restore(self):
        if self._backup is not None:
            QGuiApplication.clipboard().setText(self._backup)
            self._backup = None
