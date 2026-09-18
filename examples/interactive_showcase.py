# -*- coding: utf-8 -*-
"""交互动效演示：直接打开画廊的「交互动效」页。

用法：
    .venv/bin/python examples/interactive_showcase.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication

from examples.component_gallery import build_gallery_window
from qfluent_core import ThemeManager, UISettings

__all__ = ["main"]


def main() -> int:
    app = QApplication.instance() or QApplication(sys.argv)
    settings = UISettings()
    UISettings.install(settings)
    window = build_gallery_window(settings, ThemeManager())
    window.resize(1180, 920)
    window.show()
    # 直接停在交互动效页，省得每次手动切
    QTimer.singleShot(180, lambda: window.set_current_index(
        window.page_index("interactive"), animate=False))
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
