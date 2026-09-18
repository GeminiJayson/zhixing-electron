# -*- coding: utf-8 -*-
"""配置键名单测：真源只在 core/constants，且 main_window 已改用常量（无裸键）。"""
import importlib
import io
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _module_path(mod):
    rel = mod.replace(".", "/")
    return ROOT / f"{rel}.py"


class TestConstants(unittest.TestCase):
    def test_leaf_holds_true_source_values(self):
        c = importlib.import_module("zhixing.core.constants")
        self.assertEqual(c.K_MICA, "mica_enabled")
        self.assertEqual(c.K_CLOSE_TO_WIDGET, "close_to_widget")
        self.assertEqual(c.K_THEME_MODE, "theme_mode")

    def test_settings_keys_is_re_export_aligned(self):
        sk = importlib.import_module("zhixing.core.settings_keys")
        c = importlib.import_module("zhixing.core.constants")
        for name in ("K_MICA", "K_CLOSE_TO_WIDGET", "K_ACCENT", "K_THEME_PACK",
                     "K_UI_STATE", "K_WIDGET_GEOM"):
            self.assertEqual(getattr(sk, name), getattr(c, name),
                             f"settings_keys.{name} 应与 constants 一致")

    def test_core_settings_keys_has_no_model_dependency(self):
        # 反向依赖曾导致 core→model；此处校验 core/settings_keys 不再 import 任何 model 模块
        src = (_module_path("zhixing.core.settings_keys")).read_text()
        for bad in ("model.application", "model.domain", "model.infrastructure",
                    "infrastructure.repositories"):
            self.assertNotIn(bad, src, f"core/settings_keys.py 不应出现 {bad}")

    def test_main_window_uses_constants_not_naked_keys(self):
        src = (_module_path("zhixing.view.shell.main_window")).read_text()
        self.assertNotIn('get_bool("mica_enabled"', src)
        self.assertNotIn('get_bool("close_to_widget"', src)
        self.assertIn("settings_keys", src, "main_window 应引用常量模块真源")


if __name__ == "__main__":
    unittest.main(verbosity=2)
