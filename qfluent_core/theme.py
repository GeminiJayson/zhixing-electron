# -*- coding: utf-8 -*-
"""框架层主题管理：语义 token 容器 + .qss 模板渲染 + 变更广播。

职责边界（解耦契约 §1）：
- 只持有「语义 token -> 值」映射，并把 .qss 模板渲染为样式表；
- 只广播「主题变了」这一事实，不计算业务色（对比度派生、主题包算法留在
  业务侧真源，例如既有项目的 zhixing.view.kit.theme.ThemeEngine），
  业务真源通过 ThemeManager.apply_tokens() 把算好的 token 推入即可。

因此本模块可被任何 PySide6 项目独立使用，也可被既有项目接管。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Tuple

from PySide6.QtCore import QObject, Signal
from PySide6.QtGui import QColor

__all__ = [
    "ThemeManager", "ThemePack", "LIGHT_TOKENS", "DARK_TOKENS", "BUILTIN_PACKS",
    "QSS_DIR", "MATERIALS", "pack_palette", "radius_tokens", "control_tokens", "chevron_icon", "material_tokens",
    "resolve_mode", "mix", "adjust",
]

#: 显示材质：前三种纯 Qt 实现（全平台），后两种走平台合成（不支持时自动退化）
MATERIALS = ("solid", "translucent", "frosted", "mica", "acrylic")
MATERIAL_ALIAS: Dict[str, str] = {"glass": "frosted"}
#: 平台特效不可用时的退化目标（UI 可据此提示）
MATERIAL_FALLBACK: Dict[str, str] = {"mica": "translucent", "acrylic": "frosted"}

QSS_DIR: Path = Path(__file__).parent / "resources" / "qss"

# ---- 语义 token 真源（亮/暗各一套）------------------------------------------
# 角色映射对齐 Fluent 主题规范：表面 / 文字 / 描边 / 控件填充 / 强调 / 状态 / 度量。
# 字段名与既有项目 zhixing 的主题包 JSON 保持兼容，使 ThemeEngine.tokens 可直接推入；
# 旧名（hover / hover2 / warm / accent_soft / accent_on）保留为别名，不破坏既有调用点。
_COMMON: Dict[str, str] = {
    # 度量：4px 节奏 + 圆角角色 + 控件高度档位 + 文字阶梯（跨主题恒定）
    "space-1": "4px", "space-2": "8px", "space-3": "12px",
    "space-4": "16px", "space-5": "20px", "space-6": "24px",
    "radius-xs": "2px", "radius-sm": "4px", "radius-ctl": "6px", "radius-md": "8px",
    "radius-lg": "12px",
    # 全圆角半径由 control_tokens() 按控件高度算（Qt 对超限圆角是直接失效而非 clamp）
    "radius-pill": "11px",
    # 复选/单选指示器：默认值，运行时同样由 control_tokens() 按控件高度覆盖。
    # 半径必须恰为半宽 —— 超半宽 Qt 会把圆角整个丢弃，渲染成方块。
    "indicator-size": "16px",
    "radius-indicator": "8px",
    # 控件高度档位（默认值；运行时由 control_tokens() 按设置覆盖）
    "control-h": "32px", "control-h-compact": "28px", "control-h-large": "36px",
    # ---- 几何：原先散落在 QSS 与组件代码里的魔法数字，统一成可配置 token ----
    "border-w": "1px",            # 常规描边
    "divider-w": "1px",           # 分隔线
    "scrollbar-w": "9px",         # 滚动条粗细
    "groove-h": "4px",            # 滑块 / 进度轨道厚度
    "progress-h": "6px",          # 进度条高度
    "switch-w": "40px",           # 开关宽度
    "switch-h": "22px",           # 开关高度
    "switch-knob-inset": "2px",   # 开关圆点内缩
    "indicator-w": "3px",         # 导航选中指示条
    "icon-box": "20px",           # 图标容器（提示 / 状态）
    "avatar-size": "44px",        # 头像 / 空态图标
    "chevron-w": "12px",          # 下拉箭头
    "spin-arrow-w": "10px",       # 数字框箭头
    "drop-btn-w": "26px",         # 下拉按钮区宽度
    "pagination-gap": "4px",
    "underline-h": "2px",         # 标签页下划线
    "seg-thumb-inset": "2px",
    "split-handle": "6px",      # 分栏把手命中宽度（默认 1~2px 抓不住）
    "check-gap": "6px",          # 勾选框文字与指示器的间距
    "tab-gap": "4px",
    # 按压内缩：QSS 没有 transform，用减少左右内边距模拟。三项都可配置。
    "pad-press-sm": "7px", "pad-press-md": "11px", "pad-press-lg": "15px",
    "control-h-sm": "22px", "control-h-icon": "26px",
    "control-content-h": "30px", "control-content-compact": "26px",
    "control-content-large": "34px", "control-font-size": "14px",
    "slider-handle": "16px", "slider-handle-radius": "8px", "slider-handle-offset": "6px",
    "title-bar-h": "44px",
    "font-size": "14px", "font-size-sm": "12px", "font-size-lg": "16px",
    "font-size-title": "20px", "line-height": "20px",
    "font-weight-strong": "600",
    "icon-size": "18px", "icon-size-sm": "16px",
    "focus-ring": "2px",
    # 标题栏搜索胶囊半径（恒为半高，窗口按 capsule_height 覆盖）
    "capsule-radius": "13px",
    # 默认强调色家族（外部真源可整体覆盖；一个区域只允许一个 accent 主动作）
    "accent": "#0D9488", "accent-hover": "#0FAA9C", "accent-pressed": "#0B7F76",
    "accent-soft": "#D7F0EB", "accent-subtle": "#EAF6F3", "accent-disabled": "#A9CFCA",
    "accent-solid": "#0D9488", "accent-solid-hover": "#0FAA9C",
    "accent-solid-pressed": "#0B7F76", "accent-on": "#FFFFFF",
}

_LIGHT_BASE: Dict[str, str] = {
    # 表面：canvas 最安静，layer 承载内容，layer-alt 用于侧栏/检查器，surface 用于浮层
    "canvas": "#F2F4F6", "layer": "#FFFFFF", "layer-alt": "#E9EDF0",
    "surface": "#FFFFFF", "scrim": "rgba(15,23,32,0.28)",
    # 文字：一主一辅一弱，外加禁用与占位
    "fg": "#1A1D21", "fg2": "#5A6570", "fg3": "#8B949E",
    "fg-disabled": "#AFB6BD", "fg-placeholder": "#8B949E",
    # 描边：divider（border）< secondary（border2）< strong
    "border": "#E3E7EB", "border2": "#C9D1D8", "border-strong": "#9AA5AE",
    "stroke-card": "#E8ECEF",
    # 控件填充
    "control": "#FFFFFF", "control-hover": "#F1F5F3", "control-pressed": "#E8EFEB",
    "control-disabled": "#F2F3F5",
    # 轨道底色（进度条 / 滑块 / 节点链 / 分段控件共用同一语义色）
    "track": "#E8EFEB",
    "input": "rgba(255,255,255,0.72)", "scroll": "#C4C8CC",
    # 状态：语义前景 + 低饱和软底（成对出现，避免只靠色相表达）
    "danger": "#D92D20", "danger-soft": "#FDE9E7",
    "warn": "#C2410C", "warn-soft": "#FCEFE6",
    "success": "#12874B", "success-soft": "#E4F5EC",
    "info": "#1D4ED8", "info-soft": "#E7EDFD",
}

_DARK_BASE: Dict[str, str] = {
    "canvas": "#1B201E", "layer": "#262D29", "layer-alt": "#202623",
    "surface": "#2C3430", "scrim": "rgba(0,0,0,0.45)",
    "fg": "#EEF2EF", "fg2": "#A3B2A8", "fg3": "#77877E",
    "fg-disabled": "#5D6B63", "fg-placeholder": "#77877E",
    "border": "#333B36", "border2": "#465148", "border-strong": "#5E6C63",
    "stroke-card": "#333B36",
    "control": "#2C3430", "control-hover": "#333B36", "control-pressed": "#3B453F",
    "control-disabled": "#242A26",
    "track": "#333B36",
    "input": "rgba(44,52,48,0.85)", "scroll": "#465148",
    "danger": "#F97066", "danger-soft": "#3A2523",
    "warn": "#FB923C", "warn-soft": "#3A2B1F",
    "success": "#4ADE80", "success-soft": "#1F3226",
    "info": "#7EA6F8", "info-soft": "#1F2A3F",
}

#: 兼容别名：旧 token 名 <-> 新角色名双向同步。
# 既有项目（zhixing）的主题包给的是下划线旧名，框架内部与 QSS 模板统一用连字符新名；
# 双向同步保证两边都能取到，不产生「取不到就退回硬编码兜底色」的老问题。
_ALIASES: Dict[str, str] = {
    "hover": "control-hover",
    "hover2": "control-pressed",
    "warm": "warn",
    "accent_hover": "accent-hover",
    "accent_pressed": "accent-pressed",
    "accent_soft": "accent-soft",
    "accent_solid": "accent-solid",
    "accent_solid_hover": "accent-solid-hover",
    "accent_solid_pressed": "accent-solid-pressed",
    "accent_on": "accent-on",
    "accent_fg": "accent-on",
    "fg_placeholder": "fg-placeholder",
}

LIGHT_TOKENS: Dict[str, str] = dict(_COMMON, **_LIGHT_BASE)
DARK_TOKENS: Dict[str, str] = dict(_COMMON, **_DARK_BASE)

#: 圆角档位：基准值 -> 各档位（sm/ctl/md/lg 全部同源，保证控件与窗口圆角一致）
RADIUS_STEPS: Tuple[Tuple[str, int], ...] = (
    ("radius-xs", -6), ("radius-sm", -4), ("radius-ctl", -2),
    ("radius-md", 0), ("radius-lg", 4),
)


def radius_tokens(base: int) -> Dict[str, str]:
    """从一个基准圆角派生整套档位 —— 全局统一圆角的唯一入口。

    base=8 得到 4 / 6 / 8 / 12，与既有观感一致。窗口与组件都必须走这里，
    否则会出现「改了设置但卡片还是老圆角」。胶囊恒为全圆角（等于半高）。
    """
    try:
        base = int(base)
    except (TypeError, ValueError):
        base = 8
    base = max(0, min(24, base))
    # radius-pill 不在这里给：它必须等于控件高度的一半，由 control_tokens() 派生
    return {key: "%dpx" % max(0, base + delta) for key, delta in RADIUS_STEPS}


def _indicator_size(base: int) -> int:
    """复选/单选指示器边长（随控件高度缩放，偶数便于取半作圆形半径）。"""
    size = max(14, min(20, base - 16))
    return size if size % 2 == 0 else size + 1


def _slider_handle(base: int) -> int:
    """滑块手柄直径：随控件高度缩放（14px @ 32，16px @ 34）。"""
    return max(12, (max(18, base - 10)) * 2 // 3)


def control_tokens(base: int, font_size: int = 14) -> Dict[str, str]:
    """统一控件高度档位（含控件内字号）。

    关键点：QSS 的 min-height 作用于内容区，而各控件 padding/border 不同；
    若都写 min-height = 控件总高，渲染出来就高矮不一（按钮 34 / 菜单项 51）。
    这里按盒模型折算成内容区高度，让所有控件的渲染高度等于同一个值：

        有边框控件     min-height = control-content-h        （总高 = base）
        无边框自绘控件 min-height = control-h                （总高 = base）
        紧凑 / 宽大档  control-content-compact / -large
        小圆钮、徽标   control-h-sm
        图标按钮命中区 control-h-icon

    control-font-size 让控件内文字跟着全局字号走、但以控件高度为准：
    字号大到放不下时按控件高度截断，而不是把控件撑变形。
    """
    try:
        base = int(base)
    except (TypeError, ValueError):
        base = 32
    base = max(24, min(56, base))
    try:
        font_size = int(font_size)
    except (TypeError, ValueError):
        font_size = 14
    fit = max(9, min(font_size, base - 10))
    return {
        "control-h": "%dpx" % base,
        "control-h-compact": "%dpx" % max(20, base - 4),
        "control-h-large": "%dpx" % (base + 4),
        "control-h-sm": "%dpx" % max(18, base - 10),
        "control-h-icon": "%dpx" % max(24, base - 6),
        "control-content-h": "%dpx" % max(16, base - 2),
        "control-content-compact": "%dpx" % max(14, base - 6),
        "control-content-large": "%dpx" % max(18, base + 2),
        "control-font-size": "%dpx" % fit,
        # 全圆角 = 胶囊高度的一半。注意 Qt 对超过高度一半的 border-radius
        # 不是 clamp 而是直接不画圆角，所以这里必须算准，不能给一个大值。
        "radius-pill": "%dpx" % max(8, (max(18, base - 10)) // 2),
        # 选中类指示器（复选/单选）：Qt 的 ::indicator 只认 min/max-* 尺寸，
        # 且圆角一旦超过半宽就被整个丢弃（16px 配 11px 圆角渲染出来是方块），
        # 所以尺寸与半径必须成对派生，半径恒等于半宽。
        "indicator-size": "%dpx" % _indicator_size(base),
        "radius-indicator": "%dpx" % (_indicator_size(base) // 2),
        # 滑块手柄：尺寸随控件高度缩放，圆角必须等于半径（超限 Qt 会直接丢弃圆角）
        "slider-handle": "%dpx" % _slider_handle(base),
        "slider-handle-radius": "%dpx" % (_slider_handle(base) // 2),
        "slider-handle-offset": "%dpx" % max(4, (_slider_handle(base) - 4) // 2),
        # 跟随控件高度缩放的那几项几何
        "switch-h": "%dpx" % max(18, base - 10),
        "icon-box": "%dpx" % max(18, base - 10),
        "groove-h": "%dpx" % max(3, round(base / 8)),
        "indicator-w": "%dpx" % max(2, round(base / 11)),
        "chevron-w": "%dpx" % max(10, round(base / 3)),
        "spin-arrow-w": "%dpx" % max(8, round(base / 3.4)),
        "progress-h": "%dpx" % max(4, round(base / 5.5)),
    }


def chevron_icon(color: str, direction: str = "down") -> str:
    """下拉箭头 SVG 的文件路径（给 QSS 的 image: url() 用）。

    实现已统一到 icons 模块：路径定义、缓存目录（平台缓存目录，不再写 /tmp）、
    颜色哈希命名与旧文件清理都在那里；这里只保留旧 API 的薄封装。
    """
    from .icons import file_url
    name = "chevron-up" if str(direction) == "up" else "chevron-down"
    return file_url(name, color)

def _with_icons(tokens: Dict[str, str]) -> Dict[str, str]:
    """补齐图标类 token（下拉箭头）。颜色跟随当前主题的次要文字色。"""
    color = tokens.get("fg2", "#8B949E")
    down = chevron_icon(color, "down")
    up = chevron_icon(color, "up")
    if down:
        tokens["chevron-down"] = down
    if up:
        tokens["chevron-up"] = up
    return tokens


#: 既有项目的 token 名 -> 框架 token 名（下划线转连字符之外还需要改名的那些）
EXTERNAL_ALIASES: Dict[str, str] = {
    "hover": "control-hover",
    "hover2": "control-pressed",
    "warm": "warn",
    "accent-fg": "accent-on",
    "accent-solid-hover": "accent-solid-hover",
}


def hex_to_rgba(color: str, alpha: float) -> str:
    """#RRGGBB -> rgba(r,g,b,a)；已带 alpha 或是非 hex（如 rgba 字符串）则原样返回。"""
    if not isinstance(color, str) or not color.startswith("#") or len(color) != 7:
        return color
    c = QColor(color)
    if not c.isValid():
        return color
    return "rgba(%d,%d,%d,%.2f)" % (c.red(), c.green(), c.blue(),
                                    max(0.0, min(1.0, float(alpha))))


def mix(color_a: str, color_b: str, ratio: float) -> str:
    """按通道线性混合：ratio 为 color_a 权重（1.0 纯 a，0.0 纯 b）。"""
    a, b = QColor(color_a), QColor(color_b)
    if not a.isValid():
        return color_b
    if not b.isValid():
        return color_a
    return QColor(
        round(a.red() * ratio + b.red() * (1 - ratio)),
        round(a.green() * ratio + b.green() * (1 - ratio)),
        round(a.blue() * ratio + b.blue() * (1 - ratio)),
    ).name()


def adjust(color: str, factor: float, lighten: bool = True) -> str:
    """保持色相/饱和度调整明度（用于 accent hover/pressed）。"""
    c = QColor(color)
    if not c.isValid():
        return color
    h, s, v, _ = c.getHsvF()
    v = min(1.0, v + factor) if lighten else max(0.0, v - factor)
    c.setHsvF(h, s, v)
    return c.name()

_TOKEN_RE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_-]*)")


def material_tokens(material: str, tokens: Mapping[str, str],
                    opacity: float = 0.86) -> Dict[str, str]:
    """显示材质 -> 面填充 token 覆盖。

    控件与窗口共用同一套观感：solid 实色；translucent 面半透明（露出宿主背景）；
    glass 更透明并带上高光描边。mica / acrylic 由平台合成负责窗口背景，
    这里的「面」按 translucent / glass 处理。
    """
    effective = MATERIAL_FALLBACK.get(MATERIAL_ALIAS.get(material, material),
                                      MATERIAL_ALIAS.get(material, material))
    if effective not in ("translucent", "frosted"):
        return {}
    alpha = max(0.2, min(1.0, float(opacity)))
    if effective == "frosted":
        alpha = max(0.22, alpha * 0.82)
    out: Dict[str, str] = {}
    for key in ("layer", "surface", "layer-alt", "control"):
        value = tokens.get(key)
        if isinstance(value, str) and value.startswith("#"):
            out[key] = hex_to_rgba(value, alpha)
    if effective == "frosted":
        layer = tokens.get("layer", "#FFFFFF")
        # 没有真背景模糊时，用高光描边 + 半透明细边逼近毛玻璃观感
        out["stroke-card"] = mix(tokens.get("fg", "#1A1D21"), layer, 0.22)
        out["border"] = hex_to_rgba(mix("#FFFFFF", layer, 0.55), 0.55)
    return out


def resolve_mode(mode: str) -> str:
    """light / dark / system -> light / dark（system 读系统颜色方案）。"""
    if mode in ("light", "dark"):
        return mode
    try:
        from PySide6.QtCore import Qt
        from PySide6.QtGui import QGuiApplication
        app = QGuiApplication.instance()
        if app is not None:
            dark = app.styleHints().colorScheme() == Qt.ColorScheme.Dark
            return "dark" if dark else "light"
    except Exception:  # noqa: BLE001 —— 探测失败就当亮色
        pass
    return "light"


def _with_aliases(tokens: Mapping[str, str]) -> Dict[str, str]:
    """补全旧 token 名 <-> 新角色名的双向映射（内置表用，不做色值重算）。"""
    t = dict(tokens)
    for old, new in _ALIASES.items():
        if old not in t and new in t:
            t[old] = t[new]
        elif new not in t and old in t:
            t[new] = t[old]
    return _with_icons(t)


def _derive(tokens: Dict[str, str], ext: Mapping[str, str], dark: bool) -> Dict[str, str]:
    """把「基线 + 外部」的 token 表补成完整角色映射。

    只填空缺角色，绝不覆盖外部真源显式给出的值；依赖 accent 的派生角色在外部
    未显式提供时一律按当前 accent 重算（避免残留内置青绿与大红）。
    """
    t = _with_aliases(tokens)              # 先无条件补齐「旧名 <-> 新角色名」
    given = set(ext)                       # 外部显式给出的键（含旧名展开）
    for old, new in _ALIASES.items():
        if old in ext:
            given.add(new)
            t[new] = ext[old]
        elif new in ext:
            given.add(old)
            t[old] = ext[new]

    accent = t.get("accent", "#0D9488")
    layer = t.get("layer", "#FFFFFF")
    derived = {
        "accent-hover": adjust(accent, 0.08, True),
        "accent-pressed": adjust(accent, 0.12, False),
        "accent-soft": mix(accent, layer, 0.18),
        "accent-subtle": mix(accent, layer, 0.08),
        "accent-disabled": mix(accent, layer, 0.35),
    }
    for key, value in derived.items():
        if key not in given:
            t[key] = value
    if "accent-solid" not in given:
        t["accent-solid"] = accent
    if "accent-solid-hover" not in given:
        t["accent-solid-hover"] = adjust(t["accent-solid"], 0.06, True)
    if "accent-solid-pressed" not in given:
        t["accent-solid-pressed"] = adjust(t["accent-solid"], 0.10, False)
    if not ({"accent-on", "accent_fg"} & given):
        t["accent-on"] = mix(accent, "#FFFFFF", 0.35) if dark else "#FFFFFF"
    t["accent_fg"] = t["accent-on"]

    # 状态色：外部只给了前景色时，按当前面派生低饱和软底
    for name in ("danger", "warn", "success", "info"):
        key = f"{name}-soft"
        if name in given and key not in given:
            t[key] = mix(t[name], layer, 0.14 if dark else 0.10)
        t.setdefault(key, mix(t.get(name, "#888888"), layer, 0.12))

    t.setdefault("layer-alt", mix(t.get("canvas", layer), layer, 0.5))
    t.setdefault("surface", t.get("layer", layer))
    t.setdefault("stroke-card", t.get("border", "#E3E7EB"))
    t.setdefault("border-strong", t.get("border2", "#9AA5AE"))
    t.setdefault("fg-placeholder", t.get("fg3", "#8B949E"))
    t.setdefault("fg-disabled", t.get("fg3", "#AFB6BD"))
    return _with_icons(t)


# ============================== 主题包 ==============================
@dataclass
class ThemePack:
    """主题包：只需给出锚点色，其余语义角色由 pack_palette() 派生。

    light / dark 各至少要 canvas / layer / fg 三个锚点；也可以直接写完整色板
    （与既有项目 zhixing 的主题包 JSON 完全兼容：name / accent / light / dark）。
    """

    name: str
    accent: str = "#0D9488"
    light: Dict[str, str] = field(default_factory=dict)
    dark: Dict[str, str] = field(default_factory=dict)

    @staticmethod
    def from_dict(data: Mapping[str, Any], name: Optional[str] = None) -> "ThemePack":
        light = dict(data.get("light") or {})
        dark = dict(data.get("dark") or {})
        return ThemePack(
            name=str(name or data.get("name") or "未命名"),
            accent=str(data.get("accent") or light.get("accent") or "#0D9488"),
            light=light,
            dark=dark,
        )


#: 内置主题包。「默认」直接复用 _LIGHT_BASE/_DARK_BASE 的完整字面表（零行为漂移），
#: 其余包只给锚点色，由 pack_palette 派生整套角色。
BUILTIN_PACKS: Dict[str, ThemePack] = {
    "默认": ThemePack("默认", "#0D9488", dict(_LIGHT_BASE), dict(_DARK_BASE)),
    "墨黑": ThemePack("墨黑", "#2563EB",
                     {"canvas": "#F4F5F7", "layer": "#FFFFFF", "fg": "#14171A"},
                     {"canvas": "#141618", "layer": "#1D2023", "fg": "#E6E9EC"}),
    "樱花粉": ThemePack("樱花粉", "#DB2777",
                      {"canvas": "#FBF2F5", "layer": "#FFFFFF", "fg": "#261A20"},
                      {"canvas": "#1F191C", "layer": "#2A2126", "fg": "#F2E7EC"}),
    "奶咖棕": ThemePack("奶咖棕", "#C2410C",
                      {"canvas": "#F7F3EE", "layer": "#FFFFFF", "fg": "#221C16"},
                      {"canvas": "#1E1A16", "layer": "#292420", "fg": "#EFE8E1"}),
    "青竹": ThemePack("青竹", "#0D9488",
                     {"canvas": "#F1F7F4", "layer": "#FFFFFF", "fg": "#17201C"},
                     {"canvas": "#18201C", "layer": "#232C27", "fg": "#E8F0EB"}),
}

#: 状态色跨主题包保持语义稳定（只在亮/暗下换明度，不随主题色漂移）
_STATUS_BASE: Dict[str, Tuple[str, str]] = {
    "danger": ("#D92D20", "#F97066"),
    "warn": ("#C2410C", "#FB923C"),
    "success": ("#12874B", "#4ADE80"),
    "info": ("#1D4ED8", "#7EA6F8"),
}


def pack_palette(pack: ThemePack, mode: str, accent: Optional[str] = None
                 ) -> Dict[str, str]:
    """把「主题包 + 模式 + 强调色」展开成完整语义 token 表。

    中性角色由 canvas / layer / fg 三个锚点派生（对亮色与暗色同样成立），
    状态色按模式取语义稳定的一组，最后用包自身的字面值覆盖 —— 因此既能
    「只给锚点」快速造包，也能承载 zhixing 那种整表主题包。
    """
    dark = mode == "dark"
    anchor = pack.dark if dark else pack.light
    canvas = str(anchor.get("canvas") or ("#1B201E" if dark else "#F2F4F6"))
    layer = str(anchor.get("layer") or ("#262D29" if dark else "#FFFFFF"))
    fg = str(anchor.get("fg") or ("#EEF2EF" if dark else "#1A1D21"))

    def on_layer(ratio: float) -> str:
        return mix(fg, layer, ratio)

    def on_canvas(ratio: float) -> str:
        return mix(fg, canvas, ratio)

    tokens: Dict[str, str] = dict(_COMMON)
    tokens.update({
        "canvas": canvas, "layer": layer, "fg": fg,
        "layer-alt": on_canvas(0.05),
        "surface": on_layer(0.03) if dark else layer,
        "scrim": "rgba(0,0,0,0.45)" if dark else "rgba(15,23,32,0.28)",
        "fg2": on_layer(0.62), "fg3": on_layer(0.42),
        "fg-disabled": on_layer(0.26), "fg-placeholder": on_layer(0.42),
        "border": on_layer(0.10), "border2": on_layer(0.22),
        "border-strong": on_layer(0.40), "stroke-card": on_layer(0.08),
        "control": layer, "control-hover": on_layer(0.05),
        "control-pressed": on_layer(0.10), "control-disabled": on_canvas(0.05),
        "track": on_layer(0.10),      # 与 control-pressed 同值，但语义独立：轨道类元素都用它
        "input": layer, "scroll": on_layer(0.26),
        "accent": accent or pack.accent,
    })
    for name, (light_color, dark_color) in _STATUS_BASE.items():
        color = dark_color if dark else light_color
        tokens[name] = color
        tokens["%s-soft" % name] = mix(color, layer, 0.16 if dark else 0.12)
    # 包的字面值最后覆盖（zhixing 的整表主题包走这条路径）
    tokens.update({k: v for k, v in anchor.items() if isinstance(v, str) and v})
    return _derive(tokens, anchor, dark=dark)


class ThemeManager(QObject):
    """框架层主题状态机：mode（light/dark） x tokens（语义色值）。

    单例访问：ThemeManager.instance()；业务可 install() 自己的实例，
    使框架控件与既有主题真源共用同一份 token。
    """

    changed = Signal()            # 任意主题变化（控件统一订阅它重建样式）
    modeChanged = Signal(str)     # "light" / "dark"
    packChanged = Signal(str)     # 主题包名（整体色板）
    accentChanged = Signal(str)   # 强调色 hex（只换强调色家族）
    tokensChanged = Signal()      # token 表被外部真源替换

    _instance: Optional["ThemeManager"] = None

    def __init__(self, parent: Optional[QObject] = None, *,
                 mode: str = "light",
                 pack: str = "默认",
                 accent: Optional[str] = None,
                 tokens: Optional[Mapping[str, str]] = None,
                 qss_dir: Optional[Path] = None) -> None:
        super().__init__(parent)
        self._mode: str = mode if mode in ("light", "dark") else "light"
        self._packs: Dict[str, ThemePack] = dict(BUILTIN_PACKS)
        self._pack_name: str = pack if pack in self._packs else next(iter(self._packs))
        self._accent: str = str(accent or self._packs[self._pack_name].accent)
        self._bound = None
        self._tokens: Dict[str, str] = _with_aliases(
            self._palette() if tokens is None else tokens)
        self._qss_dir: Path = Path(qss_dir) if qss_dir else QSS_DIR
        self._qss_cache: Dict[str, str] = {}
        self._extra: Dict[str, str] = {}
        self._external: bool = False
        self._missing: Tuple[str, ...] = ()

    # ---------- 单例 ----------
    @classmethod
    def instance(cls) -> "ThemeManager":
        """返回进程级主题管理器（惰性创建，首次调用即用内置亮色 token）。"""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def install(cls, manager: "ThemeManager") -> Optional["ThemeManager"]:
        """替换单例：让框架控件跟随业务侧真源。返回被替换下的旧实例。"""
        old = cls._instance
        cls._instance = manager
        return old

    # ---------- token ----------
    @staticmethod
    def _builtin(mode: str) -> Dict[str, str]:
        return dict(DARK_TOKENS if mode == "dark" else LIGHT_TOKENS)

    @property
    def mode(self) -> str:
        return self._mode

    @property
    def is_external(self) -> bool:
        """token 是否已由外部主题真源接管（接管后框架不再自行切换内置 token 表）。"""
        return self._external

    @property
    def tokens(self) -> Dict[str, str]:
        """当前 token 表（外部真源请用 apply_tokens 整体替换，而非直接改）。"""
        return self._tokens

    def t(self, key: str, default: str = "") -> str:
        """取语义 token；缺失时返回 default（默认值也缺则空串）。"""
        return self._tokens.get(key, default)

    def px(self, key: str, default: int = 0) -> int:
        """取以 px 结尾的 token 整数值（如 radius-md -> 8）。"""
        m = re.match(r"\s*(-?\d+)", self.t(key, ""))
        return int(m.group(1)) if m else default

    def set_token(self, key: str, value: str) -> None:
        if self._tokens.get(key) == value:
            return
        self._tokens[key] = value
        self.changed.emit()

    def _palette(self) -> Dict[str, str]:
        """当前（主题包 x 模式 x 强调色）展开出的完整 token 表。"""
        return pack_palette(self._packs[self._pack_name], self._mode, self._accent)

    def _refresh(self) -> None:
        """按当前三轴重算 token 表。

        曾经这里会因为「已被外部真源接管」而直接返回 —— 那是给宿主项目自己握着
        主题引擎时用的，框架不抢方向盘。但宿主改用框架主题引擎后，就没人负责
        重算了：set_pack / set_mode / set_accent 全部失效（实测切了包样式不变）。
        现在 adopt_tokens 只做一次性导入，不锁死刷新。
        """
        self._tokens = self._palette()

    def set_mode(self, mode: str) -> None:
        """切亮/暗；未被外部真源接管时按主题包重算 token 表。"""
        mode = mode if mode in ("light", "dark") else "light"
        if mode == self._mode:
            return
        self._mode = mode
        self._refresh()
        self.modeChanged.emit(mode)
        self.changed.emit()

    # ---------- 主题包 / 强调色 ----------
    @property
    def packs(self) -> Dict[str, ThemePack]:
        return self._packs

    @property
    def pack_name(self) -> str:
        return self._pack_name

    @property
    def accent(self) -> str:
        return self._accent

    def register_pack(self, pack: ThemePack) -> None:
        """注册（或替换同名）主题包。"""
        self._packs[pack.name] = pack

    def load_packs(self, directory) -> int:
        """从目录加载 *.json 主题包（格式同既有项目 zhixing），返回加载数量。"""
        import json
        import os
        loaded = 0
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            return 0
        for filename in names:
            if not filename.endswith(".json"):
                continue
            try:
                raw = Path(directory, filename).read_text(encoding="utf-8")
                self.register_pack(ThemePack.from_dict(json.loads(raw)))
                loaded += 1
            except (OSError, ValueError, KeyError):
                continue
        return loaded

    def set_pack(self, name: str) -> None:
        """切主题包：中性色板与该包的默认强调色一起生效。"""
        if name not in self._packs or name == self._pack_name:
            return
        self._pack_name = name
        self._accent = self._packs[name].accent
        self._refresh()
        self.packChanged.emit(name)
        self.accentChanged.emit(self._accent)
        self.changed.emit()

    def set_accent(self, color: str) -> None:
        """只换强调色家族，中性色仍来自当前主题包。"""
        if not color or color == self._accent:
            return
        self._accent = str(color)
        self._refresh()
        self.accentChanged.emit(self._accent)
        self.changed.emit()

    def apply(self, pack_name: Optional[str] = None, mode: Optional[str] = None,
              accent: Optional[str] = None, *, settings=None) -> None:
        """一次设定三轴（兼容既有项目 ThemeEngine.apply 的调用习惯）。

        settings 是本框架自己的配置源：传入后 style_sheet() 会用它的
        控件高度 / 字号等覆盖来渲染（不传则沿用上一次绑定的）。
        """
        if settings is not None:
            self._render_settings = settings
        changed = False
        if pack_name and pack_name in self._packs and pack_name != self._pack_name:
            self._pack_name = pack_name
            self._accent = self._packs[pack_name].accent
            changed = True
        if mode in ("light", "dark") and mode != self._mode:
            self._mode = str(mode)
            changed = True
        if accent and accent != self._accent:
            self._accent = str(accent)
            changed = True
        # 不再因「已被外部真源接管」跳过重算：宿主改用框架主题引擎后，
        # 这里是唯一的重算点，跳过就等于切包/切模式静默失效。
        palette = self._palette()
        if palette != self._tokens:
            self._tokens = palette
            changed = True
        if changed:
            self.changed.emit()

    def bind_settings(self, settings) -> None:
        """把 UISettings 的「模式 / 主题包 / 强调色」接到本管理器（幂等）。

        接上之后：设置里改主题包或强调色 -> 所有打开的界面立即换肤，无需重启。
        """
        from .settings import K, spacing_tokens, spacing_tokens
        if getattr(self, "_bound", None) is settings:
            return
        self._bound = settings
        settings.themeChanged.connect(lambda mode: self.set_mode(resolve_mode(str(mode))))
        settings.themePackChanged.connect(self.set_pack)
        settings.accentChanged.connect(self.set_accent)
        mode = resolve_mode(str(settings.get(K.THEME_MODE, "light")))
        pack = str(settings.get(K.THEME_PACK, ""))
        accent = str(settings.get(K.ACCENT, ""))
        self._mode = mode
        if pack in self._packs:
            self._pack_name = pack
        self._accent = accent or self._packs[self._pack_name].accent
        self._refresh()
        self.changed.emit()

    def render_tokens(self, settings, extra: Optional[Mapping[str, str]] = None
                      ) -> Dict[str, str]:
        """UISettings -> 渲染期覆盖（圆角 / 字号 / 控件高度 / 显示材质）。

        窗口与组件都必须走这一个入口，否则会出现「改了圆角或材质但某个面没跟上」。
        """
        from .settings import K, spacing_tokens
        font_size = settings.get_int(K.FONT_SIZE, 14)
        overrides = radius_tokens(settings.get_int(K.RADIUS, 8))
        overrides["font-size"] = "%dpx" % font_size
        # 控件高度与控件内字号一起派生（后者受前者约束）
        overrides.update(control_tokens(settings.get_int(K.CONTROL_HEIGHT, 32),
                                        font_size))
        # ---- 间距与几何：全部来自设置，模板里没有任何写死的 px ----
        overrides.update(spacing_tokens(str(settings.get(K.SPACING, "standard"))))
        border_w = settings.get_int(K.BORDER_WIDTH, 1)
        overrides["border-w"] = "%dpx" % border_w
        overrides["divider-w"] = "%dpx" % border_w
        overrides["scrollbar-w"] = "%dpx" % settings.get_int(K.SCROLLBAR_WIDTH, 9)
        # icon-size 放在 control_tokens 之后：设置里的值优先于按控件高度派生的值。
        # icon-box（图标容器，如提示条左侧图标块）与图标同源，避免两处尺寸漂移。
        overrides["icon-size"] = "%dpx" % settings.get_int(K.ICON_SIZE, 18)
        overrides["icon-box"] = overrides["icon-size"]
        overrides.update(material_tokens(
            str(settings.get(K.MATERIAL, "solid")), self._tokens,
            settings.get_int(K.MATERIAL_OPACITY, 86) / 100.0))
        if extra:
            overrides.update(extra)
        return overrides

    def radius_tokens(self, base: int) -> Dict[str, str]:
        """便捷代理：见模块级 radius_tokens()。"""
        return radius_tokens(base)

    def apply_tokens(self, tokens: Mapping[str, str], mode: Optional[str] = None,
                     *, full: bool = False) -> None:
        """由外部主题真源推入 token（既有项目 ThemeEngine 的对接点）。

        默认是「补全」语义：外部表覆盖同名 token，未提供的角色由内置基线补齐并按
        当前 accent 重新派生。这样业务侧不完整的 token 表也不会让组件退化成
        硬编码兜底色。full=True 表示外部真源接管全部角色（不做基线合并）。
        """
        self._external = True
        if mode in ("light", "dark"):
            self._mode = str(mode)
        ext = {k: v for k, v in tokens.items() if v is not None}
        merged = dict(ext) if full else dict(self._builtin(self._mode))
        if not full:
            merged.update(ext)
        self._tokens = _derive(merged, ext, dark=self._mode == "dark")
        self.tokensChanged.emit()
        self.changed.emit()

    # ---------- QSS 模板 ----------
# ---------- 外部主题接入 ----------
    def adopt_tokens(self, tokens: Mapping[str, str], *,
                     normalize: bool = True) -> int:
        """接受既有项目的 token 表并作为渲染真源。

        用途：把既有项目的主题引擎接进框架 —— 它的 token 名与框架不完全一致
        （下划线命名、少类别名），这里做一次归一化后**覆盖**框架默认值，
        再由框架的模板渲染。这样「项目主题」与「框架组件」用同一套皮。

        返回被采纳的 token 数。
        """
        if not tokens:
            return 0
        merged: Dict[str, str] = dict(self._tokens)
        adopted = 0
        for key, value in tokens.items():
            if not isinstance(value, str) or not value:
                continue
            name = str(key).replace("_", "-") if normalize else str(key)
            name = EXTERNAL_ALIASES.get(name, name)
            if merged.get(name) != value:
                merged[name] = value
                adopted += 1
        # 图标类 token 依赖颜色，必须在采纳之后再派生一次 ——
        # 否则外部主题换了文字色，下拉箭头还停在旧颜色上
        self._tokens = _with_icons(merged)
        self._external = dict(tokens)
        return adopted

    def external_tokens(self) -> Dict[str, str]:
        """最近一次接入的外部 token（没有则为空）。"""
        return dict(getattr(self, "_external", {}) or {})


    def qss_text(self, name: str = "base",
                overrides: Optional[Mapping[str, str]] = None) -> str:
        """读取并渲染 resources/qss/<name>.qss；文件缺失返回空串。

        overrides 用于一次性覆盖 token（如窗口按 UISettings 注入字号/控件高度），
        不会写回 token 表，因此不会污染业务侧主题真源。
        """
        if name in self._extra:
            return self._render(self._extra[name], overrides)
        if name not in self._qss_cache:
            try:
                self._qss_cache[name] = (self._qss_dir / f"{name}.qss").read_text(
                    encoding="utf-8")
            except OSError:
                self._qss_cache[name] = ""
        return self._render(self._qss_cache[name], overrides)

    def register_qss(self, name: str, text: str) -> None:
        """注册/覆盖一份模板（业务追加自定义皮肤时用，不必改框架文件）。"""
        self._extra[name] = text

    def style_sheet(self, *names: str,
                    overrides: Optional[Mapping[str, str]] = None) -> str:
        """渲染并拼接多份模板，默认 base + components + window。"""
        names = names or ("base", "components", "window")
        if overrides is None:
            bound = getattr(self, "_render_settings", None)
            if bound is not None:
                overrides = self.render_tokens(bound)
        parts = [self.qss_text(n, overrides) for n in names]
        return "\n".join(p for p in parts if p)

    def missing_tokens(self) -> Tuple[str, ...]:
        """上次渲染中未被任何 token 满足的占位符名（自检用，不参与运行逻辑）。"""
        return self._missing

    def _render(self, text: str,
                overrides: Optional[Mapping[str, str]] = None) -> str:
        missing = []
        table = self._tokens if not overrides else dict(self._tokens, **overrides)

        def _sub(match: "re.Match[str]") -> str:
            key = match.group(1)
            if key in table:
                return str(table[key])
            missing.append(key)
            return ""

        out = _TOKEN_RE.sub(_sub, text)
        self._missing = tuple(sorted(set(missing)))
        return out

    # ---------- 落到应用 ----------
    def apply_to_app(self, app=None, *, extra: str = "") -> str:
        """把基础样式表应用到 QApplication（业务侧调用；返回实际应用的文本）。"""
        from PySide6.QtWidgets import QApplication
        app = app or QApplication.instance()
        if app is None:
            return ""
        sheet = self.style_sheet("base", "components")
        if extra:
            sheet = sheet + "\n" + extra
        app.setStyleSheet(sheet)
        return sheet
