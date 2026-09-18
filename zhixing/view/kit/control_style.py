# -*- coding: utf-8 -*-
"""控件高度/样式的历史辅助（已废弃，保留为兼容壳）。

背景：本项目原先用 QProxyStyle 折算 QSS 的盒模型来控制控件高度。
QProxyStyle 会在 setStyle 时留下悬空的 base 样式指针，macOS 下表现为 SIGSEGV；
而 qfluent_core 的 token 体系已经把「控件高度」表达成 min/max-height + 内容区
折算（control-content-h），不再需要任何 style 代理。

因此这里只保留函数签名，行为一律是空操作 —— 既有的 import 不会崩，
新增调用也不会有副作用。新代码请不要再用本模块。
"""
from __future__ import annotations

from typing import Any

__all__ = ["ControlHeightStyle", "clear_fixed_height", "restyle_switch_button",
           "restyle_spinbox"]

_DEPRECATED = ("zhixing.view.kit.control_style 已废弃：控件高度请交给 "
               "qfluent_core 的 UISettings(K.CONTROL_HEIGHT)，样式由框架模板渲染。")


class ControlHeightStyle:
    """已废弃：请改用 qfluent_core 的控件高度设置。"""

    def __new__(cls, *args: Any, **kwargs: Any):
        raise RuntimeError(_DEPRECATED)


def clear_fixed_height(widget: Any, control_h: int = 32) -> None:
    """空操作：框架模板已按 token 控制高度。"""
    return None


def restyle_switch_button(switch: Any, control_h: int = 32) -> None:
    """空操作：开关外观由框架自绘（UToggleSwitch）。"""
    return None


def restyle_spinbox(spinbox: Any, control_h: int = 32) -> None:
    """空操作：数字框外观由框架模板渲染。"""
    return None

