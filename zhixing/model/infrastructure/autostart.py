# -*- coding: utf-8 -*-
"""开机自启（F9-5）：跨平台注册/注销随系统启动。

- macOS：~/Library/LaunchAgents/com.zhixing.zhixing.plist（launchd）
- Windows：HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run
- Linux：~/.config/autostart/zhixing.desktop（XDG）
全部失败静默返回 False，由调用方降级为设置页提示（不阻塞主流程）。
"""
import platform
import sys
from pathlib import Path

_APP_LABEL = "知行 ZhiXing"
_PLIST_PATH = Path.home() / "Library" / "LaunchAgents" / "com.zhixing.zhixing.plist"
_DESKTOP_PATH = Path.home() / ".config" / "autostart" / "zhixing.desktop"
_NL = chr(10)


def _launch_command() -> list:
    """构造启动命令。打包后为可执行文件本身；开发态为 python -m zhixing。"""
    if getattr(sys, "frozen", False):
        return [sys.executable]
    return [sys.executable, "-m", "zhixing"]


def is_enabled() -> bool:
    try:
        if platform.system() == "Darwin":
            return _PLIST_PATH.exists()
        if platform.system() == "Windows":
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"Software\Microsoft\Windows\CurrentVersion\Run",
                                0, winreg.KEY_READ) as k:
                winreg.QueryValueEx(k, "ZhiXing")
            return True
        return _DESKTOP_PATH.exists()
    except Exception:
        return False


def set_enabled(enabled: bool) -> bool:
    try:
        if platform.system() == "Darwin":
            return _set_macos(enabled)
        if platform.system() == "Windows":
            return _set_windows(enabled)
        return _set_linux(enabled)
    except Exception:
        return False


def _set_macos(enabled: bool) -> bool:
    if not enabled:
        if _PLIST_PATH.exists():
            _PLIST_PATH.unlink()
        return True
    _PLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    argv = _launch_command()
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict>',
        '    <key>Label</key><string>com.zhixing.zhixing</string>',
        '    <key>ProgramArguments</key><array>',
    ]
    lines += [f'    <string>{a}</string>' for a in argv]
    lines += [
        '    </array>',
        f'    <key>WorkingDirectory</key><string>{Path(__file__).resolve().parents[3]}</string>',
        '    <key>RunAtLoad</key><true/>',
        '    <key>ProcessType</key><string>Interactive</string>',
        '</dict></plist>',
    ]
    _PLIST_PATH.write_text(_NL.join(lines), encoding="utf-8")
    return True


def _set_windows(enabled: bool) -> bool:
    import winreg
    key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                         r"Software\Microsoft\Windows\CurrentVersion\Run",
                         0, winreg.KEY_SET_VALUE)
    if enabled:
        cmd = ('"' + sys.executable + '"' if getattr(sys, "frozen", False)
               else f'"{sys.executable}" -m zhixing')
        winreg.SetValueEx(key, "ZhiXing", 0, winreg.REG_SZ, cmd)
    else:
        try:
            winreg.DeleteValue(key, "ZhiXing")
        except FileNotFoundError:
            pass
    winreg.CloseKey(key)
    return True


def _set_linux(enabled: bool) -> bool:
    if not enabled:
        if _DESKTOP_PATH.exists():
            _DESKTOP_PATH.unlink()
        return True
    _DESKTOP_PATH.parent.mkdir(parents=True, exist_ok=True)
    argv = _launch_command()
    exec_line = " ".join(f'"{a}"' for a in argv)
    lines = [
        "[Desktop Entry]",
        "Type=Application",
        f"Name={_APP_LABEL}",
        f"Exec={exec_line}",
        f"Path={Path(__file__).resolve().parents[3]}",
        "X-GNOME-Autostart-enabled=true",
    ]
    _DESKTOP_PATH.write_text(_NL.join(lines) + _NL, encoding="utf-8")
    return True
