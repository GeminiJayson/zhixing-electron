# -*- coding: utf-8 -*-
"""既有项目 <-> qfluent_core 桥接层（唯一允许两边互相感知的文件）。

装配一次即可（AppController / __main__ 启动时）::

    from zhixing.view.kit import fluent_bridge
    fluent_bridge.install(self.theme_engine, self.ctx.settings)

之后的数据流：
    设置页/命令面板 -> SettingsService.set -> bus.settings_changed
        -> 既有的 AppController._apply_theme 照旧执行（业务逻辑不动）
        -> ThemeEngine.changed -> push_theme() -> 框架 ThemeManager.apply_tokens()
        -> 所有打开的 qfluent_core 界面即时换肤（无需重启）

反向（框架层发起，例如用户直接改设置对话框）：
    UISettings.set() -> 写盘钩子 -> SettingsService.set() -> 同上链路收敛
双向写入都做「值相同即短路」，因此不会产生循环同步。
"""
from __future__ import annotations

from pathlib import Path

from typing import Any, Dict, Optional, Tuple

from qfluent_core import K as UI_K
from qfluent_core import ThemeManager, ThemePack, UISettings

from ...core import settings_keys as SK

__all__ = ["install", "push_theme", "pull_setting", "read_ui_values", "write_ui_value"]

#: 业务配置键 -> 框架 UI 配置键
_TO_UI: Dict[str, str] = {
    SK.K_THEME_MODE: UI_K.THEME_MODE,
    SK.K_THEME_PACK: UI_K.THEME_PACK,
    SK.K_ACCENT: UI_K.ACCENT,
    SK.K_FONT_SIZE: UI_K.FONT_SIZE,
    SK.K_CONTROL_HEIGHT: UI_K.CONTROL_HEIGHT,
    SK.K_MOTION: UI_K.ANIMATIONS,
}
_FROM_UI: Dict[str, str] = {v: k for k, v in _TO_UI.items()}


def _motion_to_bool(raw: Any) -> bool:
    """业务动效等级（full/reduced）-> 框架布尔开关。"""
    return str(raw) != "reduced"


def _bool_to_motion(value: Any) -> str:
    return "full" if value in (True, 1, "1", "true", "True") else "reduced"


def read_ui_values(settings) -> Dict[str, Any]:
    """业务设置 -> 框架 UI 配置（启动时一次性载入）。"""
    return {
        UI_K.THEME_MODE: settings.get(SK.K_THEME_MODE, "system"),
        UI_K.THEME_PACK: settings.get(SK.K_THEME_PACK, "青竹"),
        UI_K.ACCENT: settings.get(SK.K_ACCENT, "#0D9488"),
        UI_K.FONT_SIZE: settings.get_int(SK.K_FONT_SIZE, 14),
        UI_K.CONTROL_HEIGHT: settings.get_int(SK.K_CONTROL_HEIGHT, 32),
        UI_K.ANIMATIONS: _motion_to_bool(settings.get(SK.K_MOTION, "full")),
    }


def write_ui_value(settings, key: str, value: Any) -> None:
    """框架 UI 配置 -> 业务设置（UISettings 的写盘钩子）。"""
    target = _FROM_UI.get(key)
    if target is None:
        return
    if key == UI_K.ANIMATIONS:
        settings.set(target, _bool_to_motion(value))
    else:
        settings.set(target, str(value))


def push_theme(theme_engine: ThemeEngine, theme_manager: ThemeManager) -> None:
    """主题真源 -> 框架层（单向：框架只消费 token，不重算色值）。"""
    theme_manager.apply_tokens(theme_engine.tokens, mode=theme_engine.mode)


def pull_setting(settings, ui: UISettings, key: str) -> None:
    """业务设置变化 -> 框架 UI 配置（防止设置页改了而框架滞后）。"""
    ui_key = _TO_UI.get(key)
    if ui_key is None:
        return
    if ui_key == UI_K.ANIMATIONS:
        ui.set(ui_key, _motion_to_bool(settings.get(key, "full")))
    elif ui_key in (UI_K.FONT_SIZE, UI_K.CONTROL_HEIGHT):
        ui.set(ui_key, settings.get_int(key, ui.get_int(ui_key, 0)))
    else:
        ui.set(ui_key, settings.get(key, ui.get(ui_key, "")))


def install(theme_engine: ThemeEngine, settings,
            theme_manager: Optional[ThemeManager] = None,
            ui_settings: Optional[UISettings] = None
            ) -> Tuple[ThemeManager, UISettings]:
    """一次装配：返回 (ThemeManager, UISettings)，两者均已装成进程级单例。"""
    manager = theme_manager or ThemeManager()
    load_project_packs(manager)
    ThemeManager.install(manager)
    push_theme(theme_engine, manager)
    # 业务真源每次重算主题（切包/切模式/换强调色）都会推一次 token
    theme_engine.changed.connect(lambda: push_theme(theme_engine, manager))

    ui = ui_settings or UISettings()
    # 先载入既有配置（幂等，值相同的键不会广播），再挂钩子，避免安装瞬间反写一遍
    ui.load(read_ui_values(settings))
    ui.set_persister(lambda key, value: write_ui_value(settings, key, value))
    UISettings.install(ui)

    bus = getattr(settings, "bus", None)
    if bus is not None:
        bus.settings_changed.connect(lambda key: pull_setting(settings, ui, key))
    return manager, ui


def theme_dir() -> Path:
    # zhixing 的主题包目录（14 个 JSON）
    return Path(__file__).parent.parent.parent / "resources" / "themes"


def load_project_packs(manager: ThemeManager) -> int:
    # 把 zhixing 的主题包 JSON 注册进框架 —— 原先由 ThemeEngine._load_packs 负责，
    # 主题引擎退场后改由桥接统一装载，框架因此能直接使用项目自带的主题包。
    import json
    loaded = 0
    directory = theme_dir()
    if not directory.exists():
        return 0
    for path in sorted(directory.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            name = data.get("name") or path.stem
            pack = ThemePack.from_dict({**data, "name": name})
            manager.register_pack(pack)
            loaded += 1
        except Exception as exc:  # noqa: BLE001
            import sys
            print("主题包 %s 装载失败: %s" % (path.name, exc), file=sys.stderr)
            continue
    return loaded
