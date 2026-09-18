# -*- coding: utf-8 -*-
"""设置服务：settings 表的强类型封装 + ui_state JSON 便捷读写。"""
import json
from typing import Any

from ..infrastructure.db import Database
from ..infrastructure.repositories import SettingRepository
from ...core.event_bus import EventBus
# 配置键名真源已下沉至 core/constants；此处仅聚焦 SettingsService。
# 为兼容既有 leaf（core/settings_keys 等）仍借道暴露同名键。
from ...core.constants import *  # noqa: F401,F403
from ...core import constants as _k


def __getattr__(name: str):
    """使本模块可作为值源兼容旧代码: 让 x = settings.K_FOO 仍可用。"""
    if name.startswith("K_") and hasattr(_k, name):
        return getattr(_k, name)
    raise AttributeError(name)


class SettingsService:
    def __init__(self, db: Database, bus: EventBus):
        self.repo = SettingRepository(db)
        self.db = db
        self.bus = bus

    def get(self, key: str, default: str = "") -> str:
        s = self.db.session()
        try:
            return self.repo.get(s, key, default)
        finally:
            s.close()

    def set(self, key: str, value: str):
        s = self.db.session()
        try:
            self.repo.set(s, key, value)
            s.commit()
        finally:
            s.close()
        self.bus.settings_changed.emit(key)

    # ---- 便捷类型 ----
    def get_bool(self, key: str, default: bool = False) -> bool:
        v = self.get(key, "1" if default else "0")
        return v in ("1", "true", "True")

    def set_bool(self, key: str, v: bool):
        self.set(key, "1" if v else "0")

    def get_int(self, key: str, default: int = 0) -> int:
        try:
            return int(self.get(key, str(default)))
        except ValueError:
            return default

    # ---- ui_state JSON ----
    def ui_state(self) -> dict:
        raw = self.get(K_UI_STATE, "{}")
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return {}

    def ui_set(self, key: str, value: Any):
        state = self.ui_state()
        state[key] = value
        s = self.db.session()
        try:
            self.repo.set(s, K_UI_STATE, json.dumps(state, ensure_ascii=False))
            s.commit()
        finally:
            s.close()

    # 业务默认值
    def ensure_defaults(self):
        defaults = {
            K_THEME_MODE: "system", K_THEME_PACK: "青竹", K_ACCENT: "#0D9488",
            K_MICA: "1", K_MOTION: "full", K_POMO_FOCUS: "25", K_POMO_BREAK: "5",
            K_REMINDER_ENABLED: "1", K_CAPTURE_HOTKEY: "ctrl+shift+s",
            K_QUICK_HOTKEY: "ctrl+alt+n", K_WIDGET_HOTKEY: "ctrl+shift+d",
            K_WIDGET_ENABLED: "1", K_WIDGET_OPACITY: "85", K_CLOSE_TO_WIDGET: "1",
            K_CLIPBOARD_MONITOR: "0", K_AUTO_START: "0",
            K_WIDGET_CLICK_THROUGH: "0", K_RECYCLE_RETENTION: "30",
            K_SIGNATURE: "知行合一",
        }
        s = self.db.session()
        try:
            for k, v in defaults.items():
                if not self.repo.get(s, k):
                    self.repo.set(s, k, v)
            s.commit()
        finally:
            s.close()
