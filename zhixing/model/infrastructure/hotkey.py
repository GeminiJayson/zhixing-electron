# -*- coding: utf-8 -*-
"""全局热键平台适配：macOS 用 pyobjc Quartz EventTap；Windows 用 RegisterHotKey；
不可用/未授权时 register() 返回 False，由调用方降级为应用内 QShortcut（ADR-8 配套）。
"""
import platform
from typing import Callable, Dict

from loguru import logger
from PySide6.QtCore import QObject, Signal

_MAC_KEYS = {"s": 1, "d": 2, "u": 32, "n": 45, "k": 40, "f": 3, "j": 38, "b": 11,
             "space": 49, "return": 36, "esc": 53, "tab": 48}
_WIN_KEYS = {"s": 0x53, "d": 0x44, "u": 0x55, "n": 0x4E, "k": 0x4B, "f": 0x46, "j": 0x4A, "b": 0x42,
             "space": 0x20, "return": 0x0D, "esc": 0x1B, "tab": 0x09}


class HotkeyManager(QObject):
    """跨平台全局热键。回调经 Signal 转发，槽函数在主线程执行。"""

    triggered = Signal(str)        # hotkey_str（主线程）
    registered = Signal(str, bool)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.system = platform.system()
        self._callbacks: Dict[str, Callable] = {}
        self._tap = None
        self._runloop_source = None   # EventTap 的 runloop source（unregister 时移除）
        self._mac_hotkeys: Dict[str, tuple] = {}   # hotkey -> (want_flags, keycode)
        self._win_ids: Dict[int, str] = {}
        self._win_filter = None
        # 关键：EventTap 回调在非主线程 emit triggered(hotkey_str)，经 QueuedConnection
        # 回主线程分发到对应 callback。此前未连接，导致快捷键按下无任何反应。
        self.triggered.connect(self._on_triggered)

    def _on_triggered(self, hotkey: str):
        cb = self._callbacks.get(hotkey)
        if cb is not None:
            try:
                cb()
            except Exception:  # noqa: BLE001 —— 热键回调异常不得中断事件流
                pass

    @staticmethod
    def parse(hotkey: str):
        parts = [p.strip().lower() for p in hotkey.split("+") if p.strip()]
        mods = frozenset(p for p in parts if p in ("ctrl", "shift", "alt", "cmd"))
        key = parts[-1] if parts else ""
        return mods, key

    def register(self, hotkey: str, callback: Callable) -> bool:
        ok = False
        try:
            if self.system == "Darwin":
                ok = self._register_mac(hotkey)
            elif self.system == "Windows":
                ok = self._register_win(hotkey)
        except Exception:
            ok = False
        if ok:
            self._callbacks[hotkey] = callback
        self.registered.emit(hotkey, ok)
        return ok

    def unregister_all(self):
        if self.system == "Darwin" and self._tap is not None:
            try:
                from Quartz import (CFMachPortInvalidate, CFRunLoopRemoveSource,
                                    CFRunLoopGetMain, kCFRunLoopCommonModes)
                # 先移除 runloop source，再 invalidate tap，避免 source 累积导致
                # 改键后主线程 runloop 被旧 tap 回调反复触发而卡住。
                if getattr(self, "_runloop_source", None) is not None:
                    CFRunLoopRemoveSource(CFRunLoopGetMain(), self._runloop_source,
                                          kCFRunLoopCommonModes)
                    self._runloop_source = None
                CFMachPortInvalidate(self._tap)
            except Exception:
                pass
            self._tap = None
        self._mac_hotkeys.clear()
        if self.system == "Windows":
            try:
                import ctypes
                for wid in self._win_ids:
                    ctypes.windll.user32.UnregisterHotKey(None, wid)
            except Exception:
                pass
            self._win_ids.clear()
        self._callbacks.clear()

    # ---------------- macOS ----------------
    def _register_mac(self, hotkey: str) -> bool:
        try:
            import Quartz
        except ImportError:
            return False
        mods, key = self.parse(hotkey)
        keycode = _MAC_KEYS.get(key)
        if keycode is None:
            return False
        flag_map = {"ctrl": Quartz.kCGEventFlagMaskControl,
                    "shift": Quartz.kCGEventFlagMaskShift,
                    "alt": Quartz.kCGEventFlagMaskAlternate,
                    "cmd": Quartz.kCGEventFlagMaskCommand}
        want = 0
        for m in mods:
            want |= flag_map.get(m, 0)
        # 记录匹配规则；只创建一个共享 EventTap（避免多 tap source 累积 + 链式吞事件）
        self._mac_hotkeys[hotkey] = (want, keycode)
        if self._tap is not None:
            return True   # 已创建共享 tap，直接复用
        return self._create_mac_tap(Quartz)

    def _create_mac_tap(self, Quartz) -> bool:
        """创建唯一共享 EventTap：回调遍历全部热键规则做精确匹配。"""
        manager = self
        all_mask = Quartz.kCGEventFlagMaskControl | Quartz.kCGEventFlagMaskShift | \
            Quartz.kCGEventFlagMaskAlternate | Quartz.kCGEventFlagMaskCommand

        def _tap(_proxy, _type, event, _refcon):
            try:
                if _type == Quartz.kCGEventKeyDown:
                    flags = Quartz.CGEventGetFlags(event) & all_mask
                    keycode = Quartz.CGEventGetIntegerValueField(
                        event, Quartz.kCGKeyboardEventKeycode)
                    for hotkey_name, (want, kc) in manager._mac_hotkeys.items():
                        if flags == want and keycode == kc:
                            # 过滤系统自动重复（按住不放）：只触发一次
                            auto = Quartz.CGEventGetIntegerValueField(
                                event, Quartz.kCGKeyboardEventAutorepeat)
                            if not auto:
                                logger.debug("热键命中 {} flags={:#x} keycode={}",
                                             hotkey_name, flags, keycode)
                                manager.triggered.emit(hotkey_name)
                            return None  # 吞掉热键本身（含 autorepeat）
            except Exception:
                pass
            return event

        # CGEventTapCreate(tap, place, options, eventsOfInterest, callback, userInfo)
        # eventsOfInterest 是「事件掩码位」CGEventMask，必须用 CGEventMaskBit(kCGEventKeyDown)
        # （= 1<<10 = 1024）；直接传 kCGEventKeyDown(=10) 会被当作掩码 0b1010。
        tap = Quartz.CGEventTapCreate(
            Quartz.kCGSessionEventTap, Quartz.kCGHeadInsertEventTap,
            Quartz.kCGEventTapOptionDefault,
            Quartz.CGEventMaskBit(Quartz.kCGEventKeyDown), _tap, None)
        if tap is None:  # 无辅助功能权限等
            return False
        from Quartz import (CFMachPortCreateRunLoopSource, CFRunLoopAddSource,
                            CFRunLoopGetMain, kCFRunLoopCommonModes)
        source = CFMachPortCreateRunLoopSource(None, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes)
        Quartz.CGEventTapEnable(tap, True)
        self._tap = tap
        self._runloop_source = source   # 记录 source，供 unregister_all 移除
        return True

    # ---------------- Windows ----------------
    def _register_win(self, hotkey: str) -> bool:
        import ctypes
        mods, key = self.parse(hotkey)
        code = _WIN_KEYS.get(key)
        if code is None:
            return False
        MOD = {"alt": 0x1, "ctrl": 0x2, "shift": 0x4, "cmd": 0x8}
        wmods = sum(MOD[m] for m in mods)
        wid = 0xB000 + len(self._win_ids)
        if not ctypes.windll.user32.RegisterHotKey(None, wid, wmods, code):
            return False
        self._win_ids[wid] = hotkey
        if self._win_filter is None:
            from PySide6.QtCore import QAbstractNativeEventFilter, QCoreApplication
            manager = self

            class _Filter(QAbstractNativeEventFilter):
                def nativeEventFilter(self, event_type, message):
                    if event_type == b"windows_generic_MSG":
                        import ctypes.wintypes as wt
                        msg = wt.MSG.from_address(int(message))
                        if msg.message == 0x0312 and msg.wParam in manager._win_ids:  # WM_HOTKEY
                            manager.triggered.emit(manager._win_ids[msg.wParam])
                    return False, 0

            self._win_filter = _Filter()
            QCoreApplication.instance().installNativeEventFilter(self._win_filter)
        return True
