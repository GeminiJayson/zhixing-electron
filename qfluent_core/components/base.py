# -*- coding: utf-8 -*-
"""组件库公共底座：主题自愈混入 + 语义工具。

组件遵循的统一约定：
- 变体一律用 Qt 动态属性表达（tone / kind / size / state），皮肤交给
  components.qss 的属性选择器 —— 组件代码里不出现任何色值、字号、圆角；
- 自愈：订阅 ThemeManager.changed 与 UISettings.changed，主题或字号/密度一变
  立即重新 polish 并按需重绘，无需重启、无需重建控件；
- 无障碍：可交互组件一律设置 accessibleName、焦点策略与 tooltip 文本。

组件只表达「外观 + 交互状态」，不持有任何业务语义（解耦契约 §1）。
"""
from __future__ import annotations

from typing import Dict, Mapping, Optional

from PySide6.QtWidgets import QWidget

from ..settings import K, UISettings
from ..theme import ThemeManager

__all__ = ["token_px", "TONES", "KINDS", "SIZES", "TONE_FG", "tone_color", "tone_soft",
           "ThemedMixin", "apply_skin"]

def token_px(widget, key: str, default: int) -> int:
    """从 token 取像素值（如 icon-box -> 20）。

    组件的固定尺寸一律走这里，避免把 20 / 44 / 3 这类数字写死在代码里。
    """
    try:
        raw = str(widget.theme_tokens().get(key, "%dpx" % default))
        return int(float(raw.replace("px", "")) if raw else default)
    except (AttributeError, TypeError, ValueError):
        return default


#: 语义色调：standard 中性 / accent 唯一主动作 / subtle 低强调 / 状态四色
TONES = ("standard", "accent", "subtle", "danger", "warn", "success", "info")
KINDS = ("solid", "ghost")
# 每个变体表的第 0 项即默认值（_set_variant 用它兜住非法输入）
SIZES = ("standard", "compact", "large")

#: tone -> 语义前景 token 键
TONE_FG: Dict[str, str] = {
    "standard": "fg", "accent": "accent", "subtle": "fg2",
    "danger": "danger", "warn": "warn", "success": "success", "info": "info",
}

#: 影响组件几何的 UI 配置键：变化时需要重新 polish
_GEOMETRY_KEYS = (K.FONT_SIZE, K.CONTROL_HEIGHT, K.RADIUS)


def tone_color(tokens: Mapping[str, str], tone: str = "standard",
               default: str = "") -> str:
    """取语义色调的前景色；未知 tone 退回 fg。"""
    return tokens.get(TONE_FG.get(tone, "fg"), default or tokens.get("fg", "#1A1D21"))


def tone_soft(tokens: Mapping[str, str], tone: str = "standard") -> str:
    """取语义色调的软底（成对使用，避免只靠色相表达状态）。"""
    if tone == "accent":
        return tokens.get("accent-soft", tokens.get("control-hover", ""))
    if tone in ("danger", "warn", "success", "info"):
        return tokens.get(f"{tone}-soft", tokens.get("control-hover", ""))
    return tokens.get("control-hover", "")


def apply_skin(theme: Optional[ThemeManager] = None, overrides=None,
               settings: Optional[UISettings] = None, watch: bool = True):
    """把 base + components 皮肤应用到 QApplication，返回可手动重刷的函数。

    宿主若使用 FluentTemplateWindow，窗口已自带组件皮肤，无需重复调用。
    传了 settings 就自动跟随它变化（字号 / 控件高度 / 圆角 / 材质一改就重刷），
    因此独立使用组件库时控件高度等设置也能实时生效。
    """
    manager = theme or ThemeManager.instance()
    # 提示框是 Qt 自建的顶层窗口，样式表盖不到它的圆角与内边距，单装一个补丁
    from ..tooltip import install as install_tooltip
    install_tooltip()

    def refresh() -> None:
        base_overrides = dict(overrides or {})
        if settings is not None:
            base_overrides = dict(manager.render_tokens(settings), **base_overrides)
        manager.apply_to_app(extra=manager.style_sheet(
            "base", "components", overrides=base_overrides or None))

    refresh()
    if settings is not None and watch:
        settings.changed.connect(lambda *_: refresh())
    return refresh


def center_label(host, text: str = "", object_name: str = "") -> "QLabel":
    """在圆角容器（QFrame）里放一个居中标签，返回该标签。

    重要：QLabel 不参与 QSS 的 border-radius 绘制（实测圆角完全不生效），
    所以「圆角 + 背景 + 文字」的胶囊 / 徽标 / 图标必须由 QFrame 承担圆角，
    QLabel 只负责文字。
    """
    from PySide6.QtCore import Qt
    from PySide6.QtWidgets import QHBoxLayout, QLabel
    label = QLabel(text, host)
    if object_name:
        label.setObjectName(object_name)
    label.setAlignment(Qt.AlignCenter)
    label.setAttribute(Qt.WA_TransparentForMouseEvents, True)
    layout = QHBoxLayout(host)
    layout.setContentsMargins(0, 0, 0, 0)
    layout.addWidget(label)
    return label


class ThemedMixin(object):
    """主题与 UI 配置自愈混入（顺序：ThemedMixin 必须在 Qt 基类之前）。

    用法::

        class UButton(ThemedMixin, QPushButton):
            def __init__(self, ...):
                super().__init__(...)
                self._init_theme(settings, theme)

    皮肤由窗口/应用级的 components.qss 提供；本混入只负责在主题或几何配置变化时
    让 Qt 重算样式，并把「需要自绘的组件」通知到 restyle() 钩子。
    """

    _ui_settings: UISettings
    _ui_theme: ThemeManager

    def _restyle_ui(self) -> None:
        # 兼容宿主旧混入（_ThemeMixin._restyle_ui）：转发到框架的 restyle()
        self.restyle()

    def _init_theme(self, settings: Optional[UISettings] = None,
                    theme: Optional[ThemeManager] = None) -> None:
        self._ui_settings = settings or UISettings.instance()
        try:
            self._ui_theme = theme or ThemeManager.instance()
        except TypeError:
            # 单例可能被宿主或测试置空（历史上有人写 ThemeManager.instance = x）。
            # 组件构造不该因此崩，退回一个新实例即可。
            self._ui_theme = theme or ThemeManager()
        try:
            self._ui_theme.changed.connect(self._on_theme_changed)
            self._ui_settings.changed.connect(self._on_ui_setting_changed)
        except Exception:  # noqa: BLE001 —— 自愈失败不该影响组件可用性
            pass

    # ---------- token ----------
    def theme_tokens(self, extra: Optional[Mapping[str, str]] = None
                     ) -> Dict[str, str]:
        """当前 token 表 + UISettings 注入的覆盖（圆角 / 字号 / 控件高度 / 材质）。

        与窗口共用 ThemeManager.render_tokens()，保证控件与窗口的圆角、材质一致。
        """
        settings = getattr(self, "_ui_settings", None)
        tokens = dict(self._ui_theme.tokens)          # 先铺满语义 token（自绘组件要用）
        if settings is not None:
            # 再叠上 UI 配置覆盖：圆角 / 字号 / 控件高度 / 材质
            tokens.update(self._ui_theme.render_tokens(settings))
        if extra:
            tokens.update(extra)
        return tokens

    # ---------- 自愈 ----------
    def _on_theme_changed(self) -> None:
        self.repolish()
        self.restyle()

    def _on_ui_setting_changed(self, key: str, _value: object) -> None:
        if key in _GEOMETRY_KEYS:
            self.repolish()
            self.restyle()

    def repolish(self) -> None:
        """让 Qt 用当前样式表重算本控件及其子控件（token 已随样式表更新）。"""
        if not isinstance(self, QWidget):
            return
        try:
            style = self.style()
            style.unpolish(self)
            style.polish(self)
            for child in self.findChildren(QWidget):
                style.unpolish(child)
                style.polish(child)
            self.update()
        except Exception:  # noqa: BLE001
            pass

    def restyle(self) -> None:
        """子类钩子：需要自绘或运行时几何的组件在此更新（默认无操作）。"""

    # ---------- 变体工具 ----------
    def _set_variant(self, name: str, value: str, allowed: tuple) -> None:
        """设置动态属性变体并立即触发样式重算（属性选择器依赖它）。"""
        if value not in allowed:
            value = allowed[0]
        if self.property(name) == value:
            return
        self.setProperty(name, value)
        self.repolish()
