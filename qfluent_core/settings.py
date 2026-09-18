# -*- coding: utf-8 -*-
"""框架层 UI 配置：颜色 / 尺寸 / 动效 / 材质的唯一设置源。

设计要点：
- **schema 驱动**：SCHEMA_SPECS 声明每一项设置（键、标签、类型、范围、分组），
  USettingsPanel 据此自动生成界面 —— 新增一项设置只改这里，不用碰面板代码；
- 值变化即广播：所有界面各自订阅，立即生效、无需重启；
- 持久化注入：框架不依赖数据库，业务用 set_persister() 接自己的存储。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from PySide6.QtCore import QObject, Signal

__all__ = ["UISettings", "K", "DEFAULTS", "RANGES", "SPACING_SCALES", "Spec",
           "SCHEMA_SPECS", "clamp", "spacing_tokens"]


class K:
    """配置键（取值与既有项目 zhixing.core.constants 保持一致，便于桥接）。"""

    THEME_MODE = "theme_mode"            # light/dark/system
    THEME_PACK = "theme_pack"            # 主题包名
    ACCENT = "accent_color"              # hex
    FONT_SIZE = "font_size"              # px
    CONTROL_HEIGHT = "control_height"    # px
    RADIUS = "radius"                    # px（基准，派生 xs..lg）
    SPACING = "spacing_scale"            # 间距档位：compact / standard / relaxed
    BORDER_WIDTH = "border_width"        # px
    SCROLLBAR_WIDTH = "scrollbar_width"  # px
    ICON_SIZE = "icon_size"              # px
    ANIMATIONS = "animations_enabled"    # bool
    MOTION_STYLE = "motion_style"        # snappy / standard / relaxed
    MATERIAL = "material"                # solid / translucent / frosted / mica / acrylic
    MATERIAL_OPACITY = "material_opacity"  # 百分比


#: 数值配置的取值范围（框架校验与界面控件同源，避免两处漂移）
RANGES: Dict[str, tuple] = {
    K.FONT_SIZE: (9, 20),
    K.CONTROL_HEIGHT: (24, 52),
    K.RADIUS: (0, 20),
    K.MATERIAL_OPACITY: (30, 100),
    K.BORDER_WIDTH: (1, 3),
    K.SCROLLBAR_WIDTH: (5, 14),
    K.ICON_SIZE: (12, 28),
}

DEFAULTS: Dict[str, Any] = {
    K.THEME_MODE: "system",
    K.THEME_PACK: "默认",
    K.ACCENT: "#0D9488",
    K.FONT_SIZE: 14,
    K.CONTROL_HEIGHT: 34,
    K.RADIUS: 8,
    K.SPACING: "standard",
    K.BORDER_WIDTH: 1,
    K.SCROLLBAR_WIDTH: 9,
    K.ICON_SIZE: 18,
    K.ANIMATIONS: True,
    K.MOTION_STYLE: "standard",
    K.MATERIAL: "solid",
    K.MATERIAL_OPACITY: 86,
}

#: 间距档位 -> 缩放系数（space-1..6 由基准节奏乘它得到）
SPACING_SCALES: Dict[str, float] = {"compact": 0.8, "standard": 1.0, "relaxed": 1.25}


@dataclass(frozen=True)
class Spec:
    """一条设置项的描述（供设置面板自动生成控件）。"""

    key: str
    label: str
    kind: str                                  # choice | int | bool | color
    group: str = "外观"
    choices: Sequence[Tuple[str, Any]] = field(default_factory=tuple)
    minimum: int = 0
    maximum: int = 100
    step: int = 1
    suffix: str = ""
    help: str = ""


#: 全部可设置项。设置面板按 group 分组渲染；新增设置只需在这里加一条。
SCHEMA_SPECS: Tuple[Spec, ...] = (
    Spec(K.THEME_MODE, "亮暗模式", "choice", "外观",
         (("跟随系统", "system"), ("浅色", "light"), ("深色", "dark")),
         help="跟随系统时会读取当前系统配色方案"),
    Spec(K.THEME_PACK, "主题包", "choice", "外观", (),
         help="换主题包会同时换掉整套中性色与该包的默认强调色"),
    Spec(K.ACCENT, "强调色", "color", "外观",
         help="只换强调色家族，中性色仍来自当前主题包"),
    Spec(K.RADIUS, "圆角", "int", "外观", minimum=0, maximum=20, suffix="px",
         help="一个基准值派生 xs / sm / ctl / md / lg 五档，控件与窗口统一"),
    Spec(K.BORDER_WIDTH, "描边粗细", "int", "外观", minimum=1, maximum=3, suffix="px"),
    Spec(K.SCROLLBAR_WIDTH, "滚动条粗细", "int", "外观", minimum=5, maximum=14,
         suffix="px"),

    Spec(K.FONT_SIZE, "全局字号", "int", "排版", minimum=9, maximum=20, suffix="px"),
    Spec(K.CONTROL_HEIGHT, "控件高度", "int", "排版", minimum=24, maximum=52,
         suffix="px", help="所有可交互控件统一高度；控件内字号会被它约束"),
    Spec(K.SPACING, "间距档位", "choice", "排版",
         (("紧凑", "compact"), ("标准", "standard"), ("宽松", "relaxed")),
         help="缩放全部 space-1..6，影响内边距与控件间距"),
    Spec(K.ICON_SIZE, "图标尺寸", "int", "排版", minimum=12, maximum=28, suffix="px"),

    Spec(K.ANIMATIONS, "界面动效", "bool", "动效",
         help="关闭后所有动画立即停（含正在播放的）"),
    Spec(K.MOTION_STYLE, "动效档位", "choice", "动效",
         (("迅捷", "snappy"), ("标准", "standard"), ("舒缓", "relaxed")),
         help="整体缩放动画时长并切换缓动风格"),

    Spec(K.MATERIAL, "显示材质", "choice", "材质", (),
         help="控件面与窗口层一起换；系统材质不可用时自动退化"),
    Spec(K.MATERIAL_OPACITY, "材质不透明度", "int", "材质", minimum=30, maximum=100,
         suffix="%", help="对半透明 / 毛玻璃 / 系统材质生效，实色忽略此项"),
)

_UNSET = object()


def clamp(key: str, value: Any) -> Any:
    """按 RANGES 夹取数值配置；非法值退回默认；非数值键原样返回。"""
    limits = RANGES.get(key)
    if not limits:
        return value
    try:
        return max(limits[0], min(limits[1], int(value)))
    except (TypeError, ValueError):
        return DEFAULTS.get(key, value)


def spacing_tokens(scale_name: str) -> Dict[str, str]:
    """间距档位 -> space-1..6（4px 节奏按档位缩放）。"""
    scale = SPACING_SCALES.get(str(scale_name), 1.0)
    base = (4, 8, 12, 16, 20, 24)
    return {"space-%d" % (index + 1): "%dpx" % max(2, round(value * scale))
            for index, value in enumerate(base)}


class UISettings(QObject):
    """框架配置中心：所有界面只从这里取值 / 改值。"""

    changed = Signal(str, object)          # key, value（统一入口）
    themeChanged = Signal(str)
    themePackChanged = Signal(str)
    accentChanged = Signal(str)
    fontChanged = Signal(int)
    controlHeightChanged = Signal(int)
    radiusChanged = Signal(int)
    spacingChanged = Signal(str)
    geometryChanged = Signal(str, int)      # border_width / scrollbar_width / icon_size
    animationChanged = Signal(bool)
    motionStyleChanged = Signal(str)
    materialChanged = Signal(str)
    materialOpacityChanged = Signal(int)

    _SIGNAL_BY_KEY = {
        K.THEME_MODE: "themeChanged",
        K.THEME_PACK: "themePackChanged",
        K.ACCENT: "accentChanged",
        K.FONT_SIZE: "fontChanged",
        K.CONTROL_HEIGHT: "controlHeightChanged",
        K.RADIUS: "radiusChanged",
        K.SPACING: "spacingChanged",
        K.ANIMATIONS: "animationChanged",
        K.MOTION_STYLE: "motionStyleChanged",
        K.MATERIAL: "materialChanged",
        K.MATERIAL_OPACITY: "materialOpacityChanged",
    }
    #: 这三个键共用 geometryChanged 信号
    _GEOMETRY_KEYS = (K.BORDER_WIDTH, K.SCROLLBAR_WIDTH, K.ICON_SIZE)

    _instance: Optional["UISettings"] = None

    def __init__(self, values: Optional[Dict[str, Any]] = None,
                 parent: Optional[QObject] = None) -> None:
        super().__init__(parent)
        self._values: Dict[str, Any] = dict(DEFAULTS)
        if values:
            self._values.update(values)
        self._save: Optional[Callable[[str, Any], None]] = None

    # ---------- 单例 ----------
    @classmethod
    def instance(cls) -> "UISettings":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def install(cls, settings: "UISettings") -> Optional["UISettings"]:
        old = cls._instance
        cls._instance = settings
        return old

    # ---------- schema ----------
    @staticmethod
    def schema() -> Tuple[Spec, ...]:
        """全部可设置项的声明（设置面板据此生成界面）。"""
        return SCHEMA_SPECS

    @staticmethod
    def groups() -> List[str]:
        """按声明顺序返回分组名。"""
        seen: List[str] = []
        for spec in SCHEMA_SPECS:
            if spec.group not in seen:
                seen.append(spec.group)
        return seen

    # ---------- 持久化 ----------
    def set_persister(self, save: Optional[Callable[[str, Any], None]]) -> None:
        self._save = save

    def load(self, values: Dict[str, Any]) -> None:
        for key, value in (values or {}).items():
            if key in DEFAULTS:
                self.set(key, value)

    # ---------- 读写 ----------
    def get(self, key: str, default: Any = None) -> Any:
        if key in self._values:
            return self._values[key]
        return DEFAULTS.get(key, default)

    def get_int(self, key: str, default: int = 0) -> int:
        try:
            return int(self.get(key, default))
        except (TypeError, ValueError):
            return default

    def get_bool(self, key: str, default: bool = False) -> bool:
        value = self.get(key, default)
        if isinstance(value, str):
            return value in ("1", "true", "True", "yes")
        return bool(value)

    def set(self, key: str, value: Any) -> bool:
        """写入一项配置；值没变则不发信号。返回是否真的变了。"""
        value = clamp(key, value)
        if self._values.get(key, _UNSET) == value:
            return False
        self._values[key] = value
        if self._save is not None:
            try:
                self._save(key, value)
            except Exception:  # noqa: BLE001  持久化失败不该影响界面
                pass
        self.changed.emit(key, value)
        name = self._SIGNAL_BY_KEY.get(key)
        if name:
            getattr(self, name).emit(value)
        elif key in self._GEOMETRY_KEYS:
            self.geometryChanged.emit(key, int(value))
        return True

    def update(self, values: Dict[str, Any]) -> None:
        for key, value in values.items():
            self.set(key, value)

    def reset(self) -> None:
        self.update(dict(DEFAULTS))

    def snapshot(self) -> Dict[str, Any]:
        return dict(self._values)

    def on(self, key: str, handler: Callable[[Any], None]) -> Callable[[], None]:
        """订阅单个键：handler(value)。返回取消订阅函数。"""

        def _slot(changed_key: str, value: Any) -> None:
            if changed_key == key:
                handler(value)

        self.changed.connect(_slot)
        return lambda: self.changed.disconnect(_slot)

