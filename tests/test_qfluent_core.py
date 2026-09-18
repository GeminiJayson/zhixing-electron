# -*- coding: utf-8 -*-
"""qfluent_core 框架层契约测试（headless offscreen）。

覆盖解耦契约中可自动验证的部分：
  §2  框架窗口直接继承 QWidget，宿主原有布局器无需推倒重来
  §3  QSS 模板可完整渲染，无未满足占位符（样式不写死在代码里）
  §6  UI 配置集中在 UISettings，越界值自动夹取
  §7  UISettings 变更广播给所有订阅界面
  §8  业务界面订阅配置信号后无需重启即可实时刷新字体/皮肤
"""
import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


def _qapp():
    from PySide6.QtWidgets import QApplication
    return QApplication.instance() or QApplication([])


class TestThemeManager(unittest.TestCase):
    def test_qss_templates_render_all_tokens(self):
        from qfluent_core import ThemeManager
        manager = ThemeManager()
        sheet = manager.style_sheet()
        self.assertEqual(manager.missing_tokens(), ())
        self.assertNotIn("$", sheet)
        self.assertGreater(len(sheet), 2000)

    def test_adopted_tokens_do_not_freeze_switching(self):
        from qfluent_core import ThemeManager
        # 历史：外部真源（宿主自己的主题引擎）接管后，框架刻意不重算 token，
        # 以免抢方向盘。但宿主改用框架主题引擎后没人负责重算 ——
        # set_pack / set_mode 会静默失效（实测切包后样式不变）。
        # 现在 adopt_tokens 只做一次性导入，不冻结后续切换。
        manager = ThemeManager()
        manager.adopt_tokens({'layer': '#ABCDEF', 'fg': '#000000'})
        self.assertEqual(manager.tokens.get('layer'), '#ABCDEF')
        manager.set_pack('墨黑')
        self.assertNotEqual(manager.tokens.get('layer'), '#ABCDEF',
                            '切主题包后 token 应重新派生')
        layer_before = manager.tokens.get('layer')
        manager.set_mode('dark')
        self.assertNotEqual(manager.tokens.get('layer'), layer_before,
                            '切亮暗后 token 应重新派生')
        self.assertTrue(manager.style_sheet())

    def test_render_overrides_do_not_pollute_tokens(self):
        from qfluent_core import ThemeManager
        manager = ThemeManager()
        text = manager.qss_text("base", {"font-size": "19px"})
        self.assertIn("font-size: 19px", text)
        self.assertEqual(manager.t("font-size"), "14px")


class TestUISettings(unittest.TestCase):
    def test_broadcast_and_clamp(self):
        from qfluent_core import K, UISettings
        _qapp()
        ui = UISettings()
        seen = []
        ui.changed.connect(lambda key, value: seen.append((key, value)))
        ui.fontChanged.connect(lambda value: seen.append(("font", value)))
        self.assertTrue(ui.set(K.FONT_SIZE, 99))          # 越界 -> 夹取到上限
        self.assertEqual(ui.get_int(K.FONT_SIZE), 20)
        self.assertFalse(ui.set(K.FONT_SIZE, 20))         # 值未变 -> 不重复广播
        self.assertEqual(seen, [(K.FONT_SIZE, 20), ("font", 20)])

    def test_persister_receives_changes(self):
        from qfluent_core import K, UISettings
        _qapp()
        saved = []
        ui = UISettings()
        ui.set_persister(lambda key, value: saved.append((key, value)))
        ui.set(K.THEME_MODE, "dark")
        self.assertEqual(saved, [(K.THEME_MODE, "dark")])


class TestFluentTemplateWindow(unittest.TestCase):
    def setUp(self):
        self.app = _qapp()

    def _make(self, **kwargs):
        from qfluent_core import FluentTemplateWindow, ThemeManager, UISettings
        ui = kwargs.pop("settings", None) or UISettings()
        theme = kwargs.pop("theme", None) or ThemeManager()
        win = FluentTemplateWindow(None, "测试窗口", command_placeholder=" 搜索… ",
                                   settings=ui, theme=theme, **kwargs)
        from PySide6.QtWidgets import QLabel
        win.add_page(QLabel("今日"), "今日", key="today")
        win.add_page(QLabel("任务"), "任务", key="tasks")
        win.add_page(QLabel("设置"), "设置", key="settings", position="bottom")
        return win, ui, theme

    def test_inherits_qwidget_and_fits_existing_layout(self):
        from PySide6.QtWidgets import QVBoxLayout, QWidget
        win, _ui, _theme = self._make()
        self.assertIsInstance(win, QWidget)
        host = QWidget()
        layout = QVBoxLayout(host)
        layout.addWidget(win)                     # 原有布局器直接接纳
        self.assertEqual(layout.count(), 1)

    def test_page_signals_and_key_lookup(self):
        win, _ui, _theme = self._make()
        seen = []
        win.pageChangeRequested.connect(seen.append)
        win.pageChanged.connect(lambda i: seen.append(("changed", i)))
        index = win.page_index("tasks")
        win._buttons[index].click()
        self.assertEqual(win.current_index(), index)
        self.assertEqual(seen, [index, ("changed", index)])
        self.assertEqual(win.page_index("missing"), -1)

    def test_gate_can_block_page_switch(self):
        win, _ui, _theme = self._make()
        win.pageChangeRequested.connect(lambda _i: win.set_auto_switch_on_request(False))
        win._buttons[win.page_index("tasks")].click()
        self.assertEqual(win.current_index(), 0)          # 业务闸门拦住了

    def test_navigation_toggle(self):
        win, _ui, _theme = self._make(nav_width=180, nav_collapsed_width=48,
                                      nav_collapsible=True)
        seen = []
        win.navigationToggled.connect(seen.append)
        self.assertTrue(win.navigation_expanded)
        win.set_navigation_expanded(False, animate=False)
        self.assertFalse(win.navigation_expanded)
        self.assertEqual(win._nav.width(), 48)
        self.assertEqual(seen, [False])

    def test_follows_ui_settings_without_restart(self):
        win, ui, _theme = self._make()
        before = win.styleSheet()
        ui.set("font_size", 18)
        self.assertIn("font-size: 18px", win.styleSheet())
        self.assertNotEqual(before, win.styleSheet())
        ui.set("radius", 14)
        self.assertIn("border-radius: 14px", win.styleSheet())

    def test_follows_theme_change(self):
        from qfluent_core import K, ThemeManager
        theme = ThemeManager()
        win, ui, _theme = self._make(theme=theme)
        light = win.styleSheet()
        theme.set_mode("dark")
        self.assertNotEqual(light, win.styleSheet())
        self.assertIn(theme.t("canvas"), win.styleSheet())
        ui.set(K.ANIMATIONS, False)
        from qfluent_core import motion_enabled
        self.assertFalse(motion_enabled())

    def test_property_animation_really_runs(self):
        """回归：QPropertyAnimation 无 parent 且无保活引用时会被 GC，动画静默失效。

        表现是「属性停在起点」——数字滚动看起来正常但折叠/指示条/滑轨全不动。
        这里直接按帧采样属性，而不是断言动画对象被创建。
        """
        win, _ui, _theme = self._make(nav_width=200, nav_collapsed_width=48)
        self._pump(120)
        win.toggle_navigation()
        widths = [win._nav.width()]
        for _ in range(8):
            self._pump(40)
            widths.append(win._nav.width())
        self.assertLess(min(widths), widths[0],
                        "折叠动画没有推进：%s" % widths)
        self.assertEqual(widths[-1], 48)
        self.assertEqual(widths, sorted(widths, reverse=True))

    def test_expander_animates_on_second_expand(self):
        """回归：隐藏 widget 的 height() 不归零，起点取错会让第二次展开没有动画。"""
        from PySide6.QtWidgets import QLabel
        from qfluent_core import UExpander
        win, _ui, _theme = self._make()
        expander = UExpander("高级选项", win)     # 必须有父控件，否则 sizeHint 是顶层尺寸
        expander.add_widget(QLabel("内容"))
        expander.resize(300, 200)
        expander.set_expanded(True)
        self._pump(150)
        full = expander.body.maximumHeight()      # 动画驱动的就是 maximumHeight
        expander.set_expanded(False)
        self._pump(150)
        self.assertEqual(expander.body.maximumHeight(), 0)
        expander.set_expanded(True)
        heights = [expander.body.maximumHeight()]
        for _ in range(4):
            self._pump(30)
            heights.append(expander.body.maximumHeight())
        self.assertGreater(full, 0)
        self.assertLess(min(heights), full, "第二次展开没有动画：%s" % heights)
        self.assertGreater(max(heights), 0)

    def _pump(self, ms: int) -> None:
        from PySide6.QtCore import QEventLoop, QTimer
        loop = QEventLoop()
        QTimer.singleShot(ms, loop.quit)
        loop.exec()

    def test_close_request_can_be_fully_taken_over(self):
        win, _ui, _theme = self._make()
        called = []
        win.set_auto_close_on_request(False)
        win.closeRequested.connect(lambda: called.append(True))
        win.title_bar.close_button.click()
        self.assertEqual(called, [True])
        self.assertFalse(win.isVisible())             # 未被框架关闭


class TestBusinessShellDemo(unittest.TestCase):
    """业务层示范自检：框架信号 -> 业务函数，配置变更 -> 免重启刷新。"""

    def test_selftest_all_pass(self):
        _qapp()
        from examples.fluent_business_shell import selftest
        results = selftest()
        self.assertTrue(all(results.values()), results)


class _FakeSettingsService:
    """既有项目 SettingsService 的最小替身（真实接口 + 事件总线）。"""

    def __init__(self):
        from zhixing.core.event_bus import EventBus
        self.bus = EventBus()
        self.values = {
            "theme_mode": "dark", "theme_pack": "墨黑", "accent_color": "#2563EB",
            "font_size": "16", "control_height": "34", "motion_level": "reduced",
        }

    def get(self, key, default=""):
        return self.values.get(key, default)

    def get_int(self, key, default=0):
        try:
            return int(self.values.get(key, default))
        except (TypeError, ValueError):
            return default

    def set(self, key, value):
        if self.values.get(key) == value:
            return
        self.values[key] = value
        self.bus.settings_changed.emit(key)


class TestLegacyBridge(unittest.TestCase):
    def test_install_syncs_settings_and_theme_both_ways(self):
        _qapp()
        from qfluent_core import K, ThemeManager, UISettings
        from zhixing.view.kit.fluent_bridge import install
        from qfluent_core import ThemeManager as ThemeEngine
        engine = ThemeEngine()
        engine.apply("墨黑", "dark", "#2563EB")
        ThemeEngine.install(engine)   # 装成单例（原为属性赋值）

        settings = _FakeSettingsService()
        manager, ui = install(engine, settings, ThemeManager(), UISettings())

        # 业务 -> 框架：启动即带出既有配置
        self.assertEqual(ui.get_int(K.FONT_SIZE), 16)
        self.assertFalse(ui.get_bool(K.ANIMATIONS))
        self.assertEqual(ui.get(K.THEME_MODE), "dark")
        # 业务真源 token 直接进入框架（框架不重算色值）
        self.assertEqual(manager.t("layer"), engine.tokens["layer"])
        self.assertTrue(manager.is_external)

        # 业务改设置 -> 框架界面即时更新（不重启）
        settings.set("font_size", "19")
        self.assertEqual(ui.get_int(K.FONT_SIZE), 19)

        # 框架改配置 -> 回写业务设置
        ui.set(K.ACCENT, "#16A34A")
        self.assertEqual(settings.values["accent_color"], "#16A34A")
        ui.set(K.ANIMATIONS, True)
        self.assertEqual(settings.values["motion_level"], "full")

        # 主题真源重算 -> 框架 token 跟随
        engine.apply("青竹", "light", "#16A34A")
        self.assertEqual(manager.t("layer"), engine.tokens["layer"])

    def test_pull_ignores_unrelated_keys(self):
        _qapp()
        from qfluent_core import UISettings
        from zhixing.view.kit.fluent_bridge import pull_setting
        settings = _FakeSettingsService()
        ui = UISettings()
        pull_setting(settings, ui, "auto_start")     # 无关键不得影响 UI 配置
        self.assertEqual(ui.get_int("font_size"), 14)


if __name__ == "__main__":
    unittest.main()
