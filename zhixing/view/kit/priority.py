# -*- coding: utf-8 -*-
"""优先级 8 档的共享 UI 语义（v0.17 起）：标签、色阶、颜色取值。

- 档位 = int(priority)：NONE(0) 无 · P1..P8（数字越大优先级越高）。
- 历史兼容：LOW/MID/HIGH 别名 = P2/P5/P8，见 entities.Priority。
- 颜色策略（v0.17.1 重绘）：8 档采用「绿 → 黄绿 → 黄 → 橙 → 橙红 → 红」的
  高辨识固定色阶（P1 绿为最低、P8 深红为最高），保证任意主题/深浅下都可一眼
  看出档位高低；不再从 accent/warm 语义 token 混合（teal-accent 会让低档偏青、
  色阶看不出绿→红）。固定色取中等饱和值，浅/深底色上都可读。
"""
from typing import Dict, Optional

from ...model.domain.entities import Priority

# 8 档展示标签：无 + P1..P8（编辑菜单/速览/提示文案用）
_PRIORITY_LABELS: Dict[int, str] = {
    0: "无", 1: "P1", 2: "P2", 3: "P3", 4: "P4",
    5: "P5", 6: "P6", 7: "P7", 8: "P8",
}

# 8 档固定色阶（低绿 → 高红，逐级 hue 递进、明度略降，深/浅底皆可读）
# 取色原则：P1-P3 绿系（低危害）、P4-P5 橄榄黄/琥珀（中）、P6-P8 橙→红（高）。
# 黄系刻意取偏深（非亮黄）以保证浅色 UI 上文字/描边仍有足够对比。
_PRIORITY_SCALE: list = [None,
    "#2E9E5B",  # P1 绿
    "#2BAE4F",  # P2 亮绿
    "#5BA83A",  # P3 草绿
    "#8F9E1D",  # P4 橄榄黄绿
    "#C08A00",  # P5 深琥珀（偏深黄）
    "#E67E00",  # P6 橙
    "#E8402E",  # P7 红橙
    "#C81E1E",  # P8 深红
]

# 无主题 token 环境也直接用固定色板（本模块色阶与主题解耦）
_FALLBACK_SCALE = _PRIORITY_SCALE


def _mix_hex(c1: str, c2: str, t: float) -> str:
    """线性混合两 hex 色，t∈[0,1]（0=c1 全量）。"""
    from PySide6.QtGui import QColor
    a, b = QColor(c1), QColor(c2)
    r = int(a.red() + (b.red() - a.red()) * t)
    g = int(a.green() + (b.green() - a.green()) * t)
    bl = int(a.blue() + (b.blue() - a.blue()) * t)
    return f"#{r:02X}{g:02X}{bl:02X}"


def priority_label(priority) -> str:
    """档位显示名：无 / P1..P8（转调 domain 纯函数，view 层统一入口）。"""
    from ...model.domain.entities import priority_label as _domain_label
    return _domain_label(priority)


def priority_color(priority, tokens: Optional[dict] = None) -> str:
    """8 档色阶色（v0.17.1：绿 → 黄 → 橙 → 红，档位越高越醒目）。

    NONE(0) 返回灰（调用方也可自行决定不显示）。tokens 参数保留签名兼容，
    色阶本身为固定高辨识值（不再随 accent 混合而丢失绿→红）。
    """
    v = int(priority) if priority is not None else 0
    if v <= 0:
        return "#8A9BA8"   # NONE 灰
    if v >= 8:
        return _PRIORITY_SCALE[8]
    return _PRIORITY_SCALE[v]


def priority_choices() -> list:
    """编辑菜单用的 (Priority, label) 列表：无 → P1..P8（P1 低 → P8 高）。"""
    out = [(Priority.NONE, "无")]
    for i in range(1, 9):
        out.append((Priority(i), f"P{i}"))
    return out


def priority_label_map() -> Dict[Priority, str]:
    """{Priority 对象 → 显示名}：兼容旧 UI 按对象查表的写法。"""
    return {Priority(i): _PRIORITY_LABELS[i] for i in range(0, 9)}


def is_important(priority) -> bool:
    """Eisenhower「重要」判定：≥ P5（中及以上，含旧 MID=5 / HIGH=8 语义）。"""
    from ...model.domain.entities import priority_is_important
    return priority_is_important(priority)
