# -*- coding: utf-8 -*-
"""显示材质探针：打开一个留白窗口并保持，供 screencapture 抓取真实窗口图像。

用法：
    .venv/bin/python scripts/material_probe.py [solid|translucent|glass|mica|acrylic]

会打印 REQUESTED（请求的材质）与 EFFECTIVE（实际生效，可能因平台不支持而退化）。
"""
from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication, QVBoxLayout, QWidget

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from qfluent_core import (FluentTemplateWindow, K, ThemeManager, UButton, UCard,
                          UISettings, UTitle)


def main() -> int:
    material = sys.argv[1] if len(sys.argv) > 1 else "mica"
    hold_ms = int(sys.argv[2]) if len(sys.argv) > 2 else 22000
    app = QApplication.instance() or QApplication(sys.argv)
    settings = UISettings()
    settings.set(K.MATERIAL, material)
    theme = ThemeManager()
    window = FluentTemplateWindow(None, "材质 %s" % material, signature="显示材质探针",
                                  settings=settings, theme=theme,
                                  nav_width=0, nav_collapsed_width=0,
                                  nav_collapsible=False)

    page = QWidget()
    layout = QVBoxLayout(page)
    layout.setContentsMargins(48, 48, 48, 48)      # 留白，露出材质
    layout.setSpacing(16)
    card = UCard("显示材质", "窗口层与控件面一起换；留白处即为窗口材质",
                 settings=settings, theme=theme)
    card.add_widget(UTitle("如果材质生效，卡片外的留白会透出桌面并带模糊",
                           role="body", settings=settings, theme=theme))
    card.add_widget(UButton("主按钮", tone="accent", settings=settings, theme=theme))
    layout.addWidget(card)
    layout.addStretch(1)
    window.add_page(page, "材质", key="material")
    window.resize(560, 400)
    window.show()

    def report() -> None:
        print("REQUESTED=%s EFFECTIVE=%s" % (material, window.material), flush=True)

    QTimer.singleShot(min(700, max(100, hold_ms // 3)), report)
    QTimer.singleShot(hold_ms, app.quit)
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
