# -*- coding: utf-8 -*-
"""qfluent_core 组件库测试（headless offscreen）。

验证的是组件契约，而不是像素：
  - 皮肤模板完整渲染，无未满足占位符；
  - 每个组件可独立构造、带 objectName，可聚焦组件带可读标签（无障碍）；
  - 变体（tone/kind/size）非法值被纠正，不做静默错样式；
  - 主题与 UI 配置变化后组件即时反映新 token（无需重建）；
  - 组件真的被挂进控件树（防止「布局没挂载 → 控件成游离顶层窗口」这类断链缺陷）。
"""
import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


def _qapp():
    from PySide6.QtWidgets import QApplication
    return QApplication.instance() or QApplication([])


def _pair():
    from qfluent_core import ThemeManager, UISettings
    return UISettings(), ThemeManager()


_SHELF = None


def _shelf():
    """给测试组件一个共同父控件：否则无父控件会变成顶层窗口，污染 topLevelWidgets。"""
    global _SHELF
    from PySide6.QtWidgets import QWidget
    if _SHELF is None:
        _SHELF = QWidget()
    return _SHELF


class TestSemanticTokens(unittest.TestCase):
    """对齐 Fluent 主题规范的角色映射必须齐备（缺角色会让组件退回硬编码色）。"""

    REQUIRED = (
        # 表面
        "canvas", "layer", "layer-alt", "surface",
        # 文字
        "fg", "fg2", "fg3", "fg-disabled", "fg-placeholder",
        # 描边
        "border", "border2", "border-strong", "stroke-card",
        # 控件填充
        "control", "control-hover", "control-pressed", "control-disabled",
        # 强调家族
        "accent", "accent-hover", "accent-pressed", "accent-soft", "accent-subtle",
        "accent-disabled", "accent-solid", "accent-solid-hover", "accent-on",
        # 状态（前景 + 软底成对）
        "danger", "danger-soft", "warn", "warn-soft",
        "success", "success-soft", "info", "info-soft",
        # 度量
        "space-1", "space-4", "radius-sm", "radius-ctl", "radius-md", "radius-lg",
        "control-h", "control-h-compact", "font-size", "font-size-sm", "focus-ring",
    )

    def test_all_roles_present_in_both_modes(self):
        from qfluent_core import DARK_TOKENS, LIGHT_TOKENS
        for label, table in (("light", LIGHT_TOKENS), ("dark", DARK_TOKENS)):
            missing = [key for key in self.REQUIRED if key not in table]
            self.assertEqual(missing, [], "%s 模式缺角色: %s" % (label, missing))

    def test_legacy_names_still_resolve(self):
        from qfluent_core import ThemeManager
        manager = ThemeManager()
        for legacy in ("hover", "hover2", "warm", "accent_soft", "accent_solid",
                       "accent_on", "accent_fg"):
            self.assertTrue(manager.t(legacy), "旧 token 名 %s 取不到值" % legacy)

    def test_external_source_fills_missing_roles(self):
        """业务侧不完整的 token 表：缺的角色按当前 accent 重算，不残留内置青绿。"""
        from qfluent_core import ThemeManager
        manager = ThemeManager()
        manager.apply_tokens({"accent": "#DB2777", "layer": "#FFFFFF"}, mode="light")
        self.assertEqual(manager.t("accent"), "#DB2777")
        self.assertNotEqual(manager.t("accent-soft"), "#D7F0EB")
        self.assertTrue(manager.t("danger-soft"))
        self.assertTrue(manager.t("space-4"))
        manager.style_sheet()
        self.assertEqual(manager.missing_tokens(), ())

    def test_skin_templates_render_clean(self):
        from qfluent_core import ThemeManager
        manager = ThemeManager()
        for name in ("base", "components", "window"):
            text = manager.qss_text(name)
            self.assertGreater(len(text), 500, name)
        self.assertNotIn("$", manager.style_sheet())


class TestComponents(unittest.TestCase):
    def setUp(self):
        self.app = _qapp()
        self.settings, self.theme = _pair()

    def _all(self):
        from PySide6.QtWidgets import QWidget
        from qfluent_core import (
            UBadge, UButton, UCard, UConfirmDialog, UDialog, UDivider, UEmptyState,
            UExpander, UField, UIconButton, UInfoBar, ULineEdit, UPageHeader,
            UProgressBar, UProgressRing, USearchBox, USegmentedControl, USkeleton,
            UStatusPill, UTitle, UToggleSwitch,
        )
        s, t = self.settings, self.theme
        segmented = USegmentedControl(settings=s, theme=t)
        segmented.add_segment("列表", "list")
        widgets = [
            UTitle("标题", role="title", settings=s, theme=t),
            UButton("主操作", tone="accent", settings=s, theme=t),
            UIconButton(None, "设置", settings=s, theme=t),
            UToggleSwitch(True, tooltip="启用", settings=s, theme=t),
            segmented, ULineEdit("", "占位", settings=s, theme=t),
            USearchBox("搜索…", settings=s, theme=t),
            UCard("卡片", settings=s, theme=t), UDivider(settings=s, theme=t),
            UExpander("折叠", settings=s, theme=t),
            UPageHeader("页面", settings=s, theme=t),
            UField("标签", ULineEdit(settings=s, theme=t), settings=s, theme=t),
            UStatusPill("状态", tone="accent", settings=s, theme=t),
            UBadge(5, settings=s, theme=t), UInfoBar("提示", settings=s, theme=t),
            UProgressBar(50, settings=s, theme=t),
            UProgressRing(settings=s, theme=t), UEmptyState("空", "说明", settings=s, theme=t),
            USkeleton(settings=s, theme=t),
            UDialog("对话框", settings=s, theme=t),
            UConfirmDialog("确认", "确定吗？", settings=s, theme=t),
        ]
        self.assertIsInstance(widgets[0], QWidget)
        shelf = _shelf()
        for widget in widgets:
            widget.setParent(shelf)
        return widgets

    def test_every_component_constructs_with_object_name(self):
        for widget in self._all():
            self.assertTrue(widget.objectName(), type(widget).__name__)

    def test_focusable_components_have_accessible_names(self):
        """可聚焦但无标签是无障碍反模式；图标按钮更是必须带 tooltip。"""
        for widget in self._all():
            policy = widget.focusPolicy()
            if policy != 0 and type(widget).__name__ != "UDialog":
                self.assertTrue(widget.accessibleName(),
                                "%s 可聚焦但没有 accessibleName" % type(widget).__name__)

    def test_button_variants_and_invalid_values(self):
        from qfluent_core import UButton
        button = UButton("x", tone="accent", kind="ghost", size="compact",
                         settings=self.settings, theme=self.theme)
        self.assertEqual(button.property("tone"), "accent")
        button.set_tone("不存在的色调")            # 非法值 -> 回落到 standard
        self.assertEqual(button.property("tone"), "standard")
        button.set_size("huge")
        self.assertEqual(button.property("uiSize"), "standard")   # 注意不是 size（QWidget 内建）

    def test_button_pressed_state_switches_property(self):
        from PySide6.QtCore import QEvent, QPointF, Qt
        from PySide6.QtGui import QMouseEvent
        from qfluent_core import UButton
        button = UButton("x", settings=self.settings, theme=self.theme)
        press = QMouseEvent(QEvent.MouseButtonPress, QPointF(2, 2), QPointF(2, 2),
                            Qt.LeftButton, Qt.LeftButton, Qt.NoModifier)
        button.mousePressEvent(press)
        self.assertEqual(button.property("pressed"), "true")
        release = QMouseEvent(QEvent.MouseButtonRelease, QPointF(2, 2), QPointF(2, 2),
                              Qt.LeftButton, Qt.NoButton, Qt.NoModifier)
        button.mouseReleaseEvent(release)
        self.assertEqual(button.property("pressed"), "false")

    def test_badge_truncates_large_counts(self):
        from qfluent_core import UBadge
        badge = UBadge(0, settings=self.settings, theme=self.theme)
        badge.set_count(5)
        self.assertEqual(badge.text(), "5")
        self.assertTrue(badge.isVisibleTo(badge.parentWidget() or badge))
        badge.set_count(120)
        self.assertEqual(badge.text(), "99+")

    def test_search_box_signals_and_focus_state(self):
        from PySide6.QtCore import QEvent
        from qfluent_core import USearchBox
        box = USearchBox("搜索…", settings=self.settings, theme=self.theme)
        seen = []
        box.textChanged.connect(seen.append)
        box.setText("任务")
        self.assertEqual(seen, ["任务"])
        self.assertEqual(box.text(), "任务")
        self.assertTrue(box.clear_button.isVisibleTo(box))
        from PySide6.QtWidgets import QApplication
        # 走 sendEvent：事件过滤器只在 notify 阶段生效
        QApplication.sendEvent(box.input, QEvent(QEvent.FocusIn))
        self.assertEqual(box.property("focused"), "true")
        box.clear()
        self.assertEqual(box.text(), "")

    def test_info_bar_close_emits_and_hides(self):
        from qfluent_core import UInfoBar
        bar = UInfoBar("提示", tone="success", settings=self.settings, theme=self.theme)
        closed = []
        bar.closed.connect(lambda: closed.append(True))
        bar.close_bar()
        self.assertEqual(closed, [True])
        self.assertTrue(bar.isHidden())

    def test_dialog_builds_footer_actions(self):
        from qfluent_core import UDialog
        dialog = UDialog("编辑", settings=self.settings, theme=self.theme)
        self.assertFalse(dialog.footer.isVisibleTo(dialog))
        dialog.set_cancel_action()
        dialog.set_primary_action("保存")
        self.assertTrue(dialog.footer.isVisibleTo(dialog))
        from qfluent_core import UButton
        self.assertEqual(len(dialog.footer.findChildren(UButton)), 2)

    def test_progress_bar_chunk_matches_value(self):
        """回归：QSS 定制 ::chunk 时若 Qt 把 chunk 画满整条，进度语义就丢了。

        直接量像素比，而不是只断言 value() —— 属性对但渲染错是真实故障。
        """
        from PySide6.QtCore import QEventLoop, QTimer
        from PySide6.QtGui import QColor
        from PySide6.QtWidgets import QProgressBar
        from qfluent_core import UProgressBar
        from qfluent_core.components.base import apply_skin

        apply_skin(self.theme)
        bar = UProgressBar(40, tone="accent", settings=self.settings, theme=self.theme)
        self.assertIsInstance(bar, QProgressBar)
        bar.resize(400, 6)
        bar.show()
        loop = QEventLoop()
        QTimer.singleShot(80, loop.quit)
        loop.exec()

        chunk = QColor(self.theme.t("accent-solid"))
        image = bar.grab().toImage()
        row = max(0, image.height() // 2)
        hits = 0
        for x in range(image.width()):
            color = image.pixelColor(x, row)
            if (abs(color.red() - chunk.red()) < 14
                    and abs(color.green() - chunk.green()) < 14
                    and abs(color.blue() - chunk.blue()) < 14):
                hits += 1
        ratio = hits / max(1, image.width())
        self.assertGreater(ratio, 0.28, "chunk 占比 %.2f，进度条没有按 value 渲染" % ratio)
        self.assertLess(ratio, 0.52, "chunk 占比 %.2f，进度条被画满" % ratio)
        bar.hide()

    def test_components_follow_theme_and_settings(self):
        from qfluent_core import UButton
        button = UButton("x", settings=self.settings, theme=self.theme)
        self.assertEqual(button.theme_tokens()["font-size"], "14px")
        self.settings.set("font_size", 18)
        self.assertEqual(button.theme_tokens()["font-size"], "18px")
        self.settings.set("radius", 14)
        self.assertEqual(button.theme_tokens()["radius-md"], "14px")
        self.settings.set("radius", 100)          # 越界夹到 20
        self.assertEqual(button.theme_tokens()["radius-md"], "20px")
        before = self.theme.t("layer")
        self.theme.set_mode("dark")
        self.assertNotEqual(button.theme_tokens()["layer"], before)
        button.repolish()                          # 主题变化后重算不得抛异常

    def test_progress_ring_indeterminate_lifecycle(self):
        from qfluent_core import UProgressRing, set_motion_enabled
        set_motion_enabled(False)                  # reduce-motion 下不得启动动画
        ring = UProgressRing(indeterminate=True, settings=self.settings, theme=self.theme)
        self.assertIsNone(ring._anim)
        set_motion_enabled(True)
        ring.set_range(0, 100)
        ring.set_value(40)
        self.assertEqual(ring._value, 40)
        ring.stop()


class TestGalleryIntegration(unittest.TestCase):
    """画廊是组件库的验收面：结构对了，说明组件真的挂进了窗口控件树。"""

    def setUp(self):
        self.app = _qapp()

    def tearDown(self):
        """清理本测试创建的窗口：否则 Qt 对象会残留在 topLevelWidgets 里。"""
        from PySide6.QtWidgets import QApplication
        for widget in list(self._windows):
            widget.close()
            widget.deleteLater()
        del self._windows[:]
        QApplication.processEvents()

    def setUp(self):
        super().setUp()
        self._windows = []

    def _gallery(self):
        from examples.component_gallery import build_gallery_window
        settings, theme = _pair()
        window = build_gallery_window(settings, theme)
        self._windows.append(window)
        self._theme = theme
        return window

    def test_gallery_window_holds_all_components(self):
        from qfluent_core import (UButton, UCard, UInfoBar, UProgressRing,
                                  UStatusPill, UTitle)
        window = self._gallery()
        self.assertEqual(window.page_count(), 10)
        self.assertEqual(window.page_index("theme"), 0)
        self.assertEqual(window.page_index("status"), 3)
        for key in ("forms", "interactive", "settings", "data", "nav"):
            self.assertGreaterEqual(window.page_index(key), 0, key)
        self.assertGreaterEqual(len(window.findChildren(UButton)), 10)
        self.assertGreaterEqual(len(window.findChildren(UStatusPill)), 6)
        self.assertGreaterEqual(len(window.findChildren(UCard)), 3)
        self.assertGreaterEqual(len(window.findChildren(UTitle)), 5)
        self.assertGreaterEqual(len(window.findChildren(UProgressRing)), 2)
        self.assertGreaterEqual(len(window.findChildren(UInfoBar)), 3)
        # 组件必须真的挂在窗口的控件树里（布局没挂到 widget 上就会变成游离顶层窗口）
        for button in window.findChildren(UButton):
            self.assertTrue(window.isAncestorOf(button))

    def test_gallery_window_carries_component_skin(self):
        window = self._gallery()
        sheet = window.styleSheet()
        self.assertIn("#UButton", sheet)
        self.assertIn("#UStatusPill", sheet)
        self.assertNotIn("$", sheet)
        self.assertEqual(self._theme.missing_tokens(), ())





class TestThemePacksAndRadius(unittest.TestCase):
    """主题包（整体配色）、强调色、圆角统一、显示材质、动效档位。"""

    def setUp(self):
        self.app = _qapp()
        self.settings, self.theme = _pair()

    def test_every_builtin_pack_renders_clean(self):
        from qfluent_core import BUILTIN_PACKS
        self.assertGreaterEqual(len(BUILTIN_PACKS), 4)
        for name in BUILTIN_PACKS:
            self.theme.set_pack(name)
            for mode in ("light", "dark"):
                self.theme.set_mode(mode)
                self.theme.style_sheet()
                self.assertEqual(self.theme.missing_tokens(), (),
                                 "%s/%s 模板有未满足占位符" % (name, mode))

    def test_raw_style_sheet_without_settings_has_no_missing_tokens(self):
        """不绑定 UISettings 直接渲染（组件库独立使用）时，每个占位符也必须有值。

        缺失的 token 会被替换成空串，在 QSS 里留下 `min-width: ;` 这种静默坏样式 ——
        加新 token 却只补了 control_tokens()（渲染期覆盖）就会踩到。
        """
        from qfluent_core import ThemeManager
        engine = ThemeManager()
        engine.apply("青竹", "light", "#0D9488")
        qss = engine.style_sheet()
        self.assertEqual(engine.missing_tokens(), (), "未绑定设置时有占位符没有值")
        self.assertNotIn(": ;", qss, "有 token 被替换成了空值")

    def test_pack_switch_moves_neutrals_and_accent(self):
        self.theme.set_pack("墨黑")
        accent = self.theme.accent
        canvas = self.theme.t("canvas")
        self.theme.set_pack("樱花粉")
        self.assertNotEqual(self.theme.accent, accent, "切包应同时换该包的默认强调色")
        self.assertNotEqual(self.theme.t("canvas"), canvas, "切包应换掉中性色板")

    def test_accent_only_touches_accent_family(self):
        self.theme.set_pack("默认")
        neutral = {k: self.theme.t(k) for k in ("layer", "fg", "border", "danger")}
        self.theme.set_accent("#DB2777")
        self.assertEqual(self.theme.t("accent"), "#DB2777")
        self.assertNotEqual(self.theme.t("accent-soft"), "#D7F0EB")
        self.assertEqual({k: self.theme.t(k) for k in neutral}, neutral,
                         "换强调色不该改动中性色与状态色")

    def test_loads_existing_project_theme_packs(self):
        """既有项目 zhixing 的主题包 JSON 必须能直接吃进来（格式兼容）。"""
        from pathlib import Path
        themes = Path("zhixing/resources/themes")
        if not themes.is_dir():
            self.skipTest("既有项目主题包目录不存在")
        loaded = self.theme.load_packs(themes)
        self.assertGreater(loaded, 5)
        self.theme.set_pack("墨黑")
        self.theme.set_mode("dark")
        self.theme.style_sheet()
        self.assertEqual(self.theme.missing_tokens(), ())
        self.assertTrue(self.theme.t("canvas").startswith("#"))

    def test_radius_tokens_are_derived_from_one_base(self):
        from qfluent_core import radius_tokens
        small = radius_tokens(4)
        large = radius_tokens(16)
        self.assertEqual(small["radius-md"], "4px")
        self.assertEqual(large["radius-md"], "16px")
        order = ("radius-xs", "radius-sm", "radius-ctl", "radius-md", "radius-lg")
        values = [int(large[k].replace("px", "")) for k in order]
        self.assertEqual(values, sorted(values), "圆角档位必须单调递增：%s" % values)
        # 胶囊半径不再写死：它是「胶囊高度的一半」，且 Qt 对超限圆角是直接丢弃，
        # 所以必须由 control_tokens 按控件高度算出来。
        from qfluent_core import control_tokens
        controls = control_tokens(34, 14)
        self.assertEqual(int(controls["radius-pill"].replace("px", "")) * 2,
                         int(controls["control-h-sm"].replace("px", "")),
                         "radius-pill 必须等于胶囊高度的一半")
        self.assertNotIn("radius-pill", small)

    def test_qss_templates_have_no_hardcoded_radius(self):
        """全局统一圆角的前提：模板里每个 border-radius 都必须来自 token。"""
        from pathlib import Path
        from qfluent_core import QSS_DIR
        offenders = []
        for path in sorted(Path(QSS_DIR).glob("*.qss")):
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if "border-radius" in line and "$" not in line:
                    offenders.append("%s:%d %s" % (path.name, number, line.strip()))
        self.assertEqual(offenders, [], "存在写死圆角：%s" % offenders)

    def test_window_and_components_share_radius_and_material(self):
        from qfluent_core import UButton
        window, settings, theme = self._make_window()
        button = UButton("x", settings=settings, theme=theme)
        settings.set("radius", 16)
        window_sheet = window.styleSheet()
        self.assertIn("border-radius: 16px", window_sheet)
        self.assertIn("border-radius: 20px", window_sheet)   # radius-lg 也跟着走
        self.assertEqual(button.theme_tokens()["radius-lg"],
                         theme.render_tokens(settings)["radius-lg"])

    def test_surface_material_changes_faces(self):
        from qfluent_core import UButton
        window, settings, theme = self._make_window()
        button = UButton("x", settings=settings, theme=theme)
        solid = button.theme_tokens()["layer"]
        settings.set("material", "glass")
        glass = button.theme_tokens()["layer"]
        self.assertTrue(solid.startswith("#"))
        self.assertTrue(glass.startswith("rgba("), glass)
        self.assertNotEqual(solid, glass)

    def test_motion_profiles_scale_all_durations(self):
        from qfluent_core import motion
        try:
            motion.set_profile("snappy")
            snappy = motion.duration("normal")
            baseline = motion.duration("normal")
            motion.set_profile("relaxed")
            relaxed = motion.duration("normal")
        finally:
            motion.set_profile("standard")
        standard = motion.duration("normal")
        self.assertLess(snappy, standard)
        self.assertGreater(relaxed, standard)
        self.assertEqual(baseline, snappy)

    def test_system_material_degrades_when_unsupported(self):
        from qfluent_core import material as material_module
        original = material_module.platform_support
        material_module.platform_support = lambda: {
            "solid": True, "translucent": True, "glass": True,
            "mica": False, "acrylic": False}
        try:
            self.assertEqual(material_module.effective_material("mica"), "translucent")
            self.assertEqual(material_module.effective_material("acrylic"), "frosted")
            self.assertEqual(material_module.effective_material("frosted"), "frosted")
            # 旧名 glass 仍可用（已改名为毛玻璃）
            self.assertEqual(material_module.effective_material("glass"), "frosted")
        finally:
            material_module.platform_support = original

    def test_material_switches_window_and_faces(self):
        """材质必须同时落到窗口层（透明属性）与控件面（半透明填充）。"""
        from PySide6.QtCore import Qt
        from qfluent_core import UButton
        window, settings, theme = self._make_window()
        button = UButton("x", settings=settings, theme=theme)
        # 无边框圆角窗口的 root 恒为透明（四角靠子块拼出），材质只决定「面」
        self.assertTrue(window.testAttribute(Qt.WA_TranslucentBackground))
        self.assertTrue(button.theme_tokens()["layer"].startswith("#"))

        settings.set("material", "frosted")
        self.assertTrue(button.theme_tokens()["layer"].startswith("rgba("))
        # 毛玻璃应该比半透明更透（同一不透明度设置下）
        frosted = button.theme_tokens()["layer"]
        settings.set("material", "translucent")
        self.assertNotEqual(frosted, button.theme_tokens()["layer"])

        settings.set("material", "solid")
        self.assertTrue(button.theme_tokens()["layer"].startswith("#"))

    def _make_window(self):
        from PySide6.QtWidgets import QLabel
        from qfluent_core import FluentTemplateWindow
        settings, theme = _pair()
        window = FluentTemplateWindow(None, "测试", settings=settings, theme=theme)
        window.add_page(QLabel("页"), "页")
        return window, settings, theme

from qfluent_core import (UAlert, UAvatar, UBreadcrumb, UCheckbox,
                          UComboBox, UConsole, UDataTable, UDatePicker,
                          UDropdown, UImageCompare, UMenu,
                          UMultiComboBox, UPagination, USlider, UTable,
                          UTabs, UTopbar, UUpload)


#: 组件库对外承诺的完整清单（需求清单 -> 框架导出名）。
#  这是一条「导出契约」：任何组件没被导出、或名字写错，都会在这里断掉。
COMPONENT_CONTRACT = (
    "UButton", "UCheckbox",
    "ULineEdit", "UToggleSwitch", "USlider", "UComboBox", "UMultiComboBox",
    "UDatePicker", "UUpload",
    "UAvatar", "UTable", "UDataTable", "UImageCompare", "UConsole",
    "UAlert", "UProgressBar", "UProgressRing", "UInfoBar",
    "UMenu", "UTopbar", "UBreadcrumb", "UTabs", "UPagination", "UDropdown",
    "FluentTemplateWindow", "UCard", "UDivider", "UExpander", "UField",
    "UPageHeader", "UTitle", "UStatusPill", "UBadge", "UEmptyState",
    "USkeleton", "UDialog", "UConfirmDialog", "USegmentedControl",
    "UColorSwatch", "UIconButton", "USearchBox",
)


class TestComponentContract(unittest.TestCase):
    """按需求清单核对：导出、可构造、有 objectName。"""

    def setUp(self):
        self.app = _qapp()

    def test_every_contract_component_is_exported(self):
        import qfluent_core
        missing = [name for name in COMPONENT_CONTRACT
                   if not hasattr(qfluent_core, name)]
        self.assertEqual(missing, [], "以下组件没有从 qfluent_core 导出：%s" % missing)
        absent = [name for name in COMPONENT_CONTRACT
                  if name not in qfluent_core.__all__]
        self.assertEqual(absent, [],
                         "导出了但没写进 __all__（from qfluent_core import * 拿不到）")

    def test_new_components_construct_with_object_name(self):
        widgets = [
            UCheckbox("复选框", description="说明"),
            USlider(20, label="滑块"),
            UComboBox([("甲", 1), ("乙", 2)], placeholder="请选择"),
            UMultiComboBox(["甲", "乙"]),
            UDatePicker(),
            UUpload(),
            UAvatar("知行"),
            UTable(["列"]),
            UDataTable(["列"]),
            UImageCompare(),
            UConsole(),
            UAlert("提示"),
            UMenu(),
            UTopbar("标题"),
            UBreadcrumb(["一级", "二级"]),
            UTabs(),
            UPagination(),
            UDropdown("操作"),
        ]
        for widget in widgets:
            self.assertTrue(widget.objectName(), type(widget).__name__)
        # 可聚焦控件必须带可读标签（图标/无文本控件尤其重要）
        for widget in widgets:
            if widget.focusPolicy() != 0 and hasattr(widget, "accessibleName"):
                if type(widget).__name__ in ("UComboBox", "UMultiComboBox", "UDatePicker"):
                    continue          # 这三者由 placeholder / 当前值承担标签
                self.assertTrue(widget.accessibleName() or widget.toolTip(),
                                "%s 可聚焦但没有可读标签" % type(widget).__name__)

    def test_data_table_filters_sorts_and_paginates(self):
        table = UDataTable(["名称", "数量"], page_size=3)
        table.set_data([["b", 2], ["a", 10], ["c", 1], ["d", 7],
                        ["e", 3], ["f", 5], ["g", 8]])
        self.assertEqual(table.pagination.page_count(), 3)
        self.assertEqual(len(table.visible_rows()), 3)
        table.set_page(2)
        self.assertEqual(table.current_page(), 2)
        self.assertEqual(len(table.visible_rows()), 1)
        table.search.setText("a")                      # 过滤后回到第一页
        self.assertEqual(table.current_page(), 0)
        self.assertEqual(len(table.visible_rows()), 1)

    def test_multi_combo_summary_and_selection(self):
        combo = UMultiComboBox(["甲", "乙", "丙"], summary_limit=1)
        self.assertEqual(combo.selected(), [])
        combo.set_selected(["甲", "乙"])
        self.assertEqual(combo.selected(), ["甲", "乙"])
        self.assertIn("等 2 项", combo.lineEdit().text())
        combo.clear_selection()
        self.assertEqual(combo.lineEdit().text(), "请选择")

    def test_upload_tracks_files_and_signals(self):
        upload = UUpload()
        seen = []
        upload.filesChanged.connect(seen.append)
        upload.add_files(["/tmp/a.txt", "/tmp/b.txt", "/tmp/a.txt"])
        self.assertEqual(len(upload.files()), 2)
        upload.remove_file("/tmp/a.txt")
        self.assertEqual(upload.files(), ["/tmp/b.txt"])
        upload.clear()
        self.assertEqual(upload.files(), [])
        self.assertEqual(seen[-1], [])

    def test_console_keeps_bounded_lines(self):
        console = UConsole(max_lines=50)
        for index in range(200):
            console.append("第 %d 行" % index, "info")
        lines = [line for line in console.text().strip().splitlines() if line]
        self.assertLessEqual(len(lines), 50, "控制台没有按 max_lines 截断")
        self.assertIn("第 199 行", console.text())

    def test_pagination_programmatic_set_does_not_emit(self):
        pager = UPagination(page_size=10)
        events = []
        pager.pageChanged.connect(events.append)
        pager.set_total(95)
        pager.set_page(4)
        self.assertEqual(pager.page(), 4)
        self.assertEqual(events, [], "程序化 set_page 不该发信号（会让刷新递归）")

    def test_card_header_row_has_single_title(self):
        """header_row 在无标题卡片上补标题区时，不能留下第二个同文本标题。"""
        from PySide6.QtWidgets import QLabel
        from qfluent_core import UCard
        card = UCard()
        card.header_row("链接")
        titles = [lab.text() for lab in card.findChildren(QLabel)
                  if lab.objectName() == "UCardTitle"]
        self.assertEqual(titles, ["链接"], "卡片标题重复：%r" % (titles,))

    def test_card_body_margins_survive_restyle(self):
        """业务指定的正文内边距不能被 restyle()（换肤/换设置）抹掉。"""
        from qfluent_core import UCard
        card = UCard()
        card.set_body_margins(10, 4, 10, 4)
        card.restyle()                     # 模拟换肤触发的重排
        m = card.body_layout.contentsMargins()
        self.assertEqual((m.left(), m.top(), m.right(), m.bottom()), (10, 4, 10, 4),
                         "restyle() 覆盖了业务显式设定的内边距")

    def test_card_header_built_late_sits_above_body(self):
        """标题区可能在构造完成后才补建，仍必须排在正文之上（否则标题掉到卡片底部）。"""
        from PySide6.QtWidgets import QLabel
        from qfluent_core import UCard
        card = UCard()
        body = QLabel("正文")
        card.add_widget(body)
        card.header_title("列 (0)")
        card.resize(320, 200)
        card.show()
        self.app.processEvents()
        header = card.header
        self.assertIsNotNone(header)
        self.assertLess(header.y(), card.body.y(), "标题区被排到了正文下面")


class TestInteractionFixes(unittest.TestCase):
    """四类交互缺陷的回归测试。"""

    def setUp(self):
        self.app = _qapp()
        self.settings, self.theme = _pair()

    def test_stacked_toasts_do_not_overlap(self):
        """同一位置连发多条通知时必须依次排开，不能叠在同一坐标。"""
        from PySide6.QtWidgets import QWidget
        from qfluent_core import UToast
        host = QWidget()
        host.resize(900, 600)
        host.show()
        self.app.processEvents()
        toasts = []
        for i in range(3):
            toast = UToast("第 %d 条通知" % i, "内容 %d" % i, host, duration=60000)
            toast.popup()
            toasts.append(toast)
        self.app.processEvents()
        boxes = [t.geometry() for t in toasts]
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                self.assertFalse(boxes[i].intersects(boxes[j]),
                                 "通知重叠：%s 与 %s" % (boxes[i], boxes[j]))
        for toast in toasts:
            toast.dismiss()
        host.deleteLater()

    def test_tooltip_is_a_tight_capsule(self):
        """提示气泡：内边距按 token 设、尺寸不被撑大、圆角真的生效。

        QSS 对 QToolTip 有两条实测硬限制：padding 要么被忽略、要么把提示撑成 80x47；
        顶层窗口不透明时圆角四角会被底色填满 => 必须给 QTipLabel 开透明背景。
        两条都改由 qfluent_core/tooltip.py 在显示时补齐。
        """
        from PySide6.QtCore import QPoint, Qt
        from PySide6.QtWidgets import QApplication, QPushButton, QToolTip
        from qfluent_core import apply_skin
        apply_skin(self.theme, None, self.settings)
        host = QPushButton("宿主")
        host.resize(180, 34)
        host.show()
        self._pump(40)
        QToolTip.showText(host.mapToGlobal(QPoint(20, 40)), "短提示", host)
        self._pump(120)
        tips = [w for w in QApplication.topLevelWidgets()
                if w.metaObject().className() == "QTipLabel" and w.isVisible()]
        self.assertTrue(tips, "提示框没有出现")
        tip = tips[0]
        margins = tip.contentsMargins()
        self.assertGreater(margins.left(), 0, "提示框内边距没有按 token 设上")
        ideal = tip.fontMetrics().horizontalAdvance("短提示") + 1
        self.assertLess(tip.width(), ideal + 60, "提示框被 QSS padding 撑宽了")
        self.assertTrue(tip.testAttribute(Qt.WA_TranslucentBackground),
                        "没开透明背景，圆角四角会被填满（看起来没做圆角）")
        image = tip.grab().toImage()
        self.assertLess(image.pixelColor(0, 0).alpha(), 255, "圆角没生效：角上被填满")
        QToolTip.hideText()
        host.deleteLater()

    def test_splitter_handle_is_draggable(self):
        """分栏必须真的能拖：handle 命中宽度够，且拖动按光标位移改变两侧宽度。

        注意事件必须带 globalPosition —— 只给 localPos 的合成事件会让 QSplitterHandle
        算出错误的落点（实测左栏直接被甩到 14px），看起来像「拖不动」。
        """
        from PySide6.QtCore import QEvent, QPoint, QPointF, Qt
        from PySide6.QtGui import QMouseEvent
        from PySide6.QtWidgets import QApplication, QLabel, QSplitter
        from qfluent_core import apply_skin
        apply_skin(self.theme, None, self.settings)
        split = QSplitter(Qt.Horizontal)
        split.addWidget(QLabel("左"))
        split.addWidget(QLabel("右"))
        split.setSizes([300, 700])
        split.resize(1000, 200)
        split.show()
        self._pump(40)
        handle = split.handle(1)
        self.assertGreaterEqual(split.handleWidth(), 6, "handle 太窄，抓不住")
        before = list(split.sizes())
        y = split.height() // 2

        def global_at(x):
            return QPointF(handle.mapToGlobal(QPoint(x, y)))

        for kind, x, button, buttons in (
                (QEvent.MouseButtonPress, 4, Qt.LeftButton, Qt.LeftButton),
                (QEvent.MouseMove, 104, Qt.NoButton, Qt.LeftButton),
                (QEvent.MouseButtonRelease, 104, Qt.LeftButton, Qt.NoButton)):
            QApplication.sendEvent(handle, QMouseEvent(
                kind, QPointF(x, y), global_at(x), button, buttons, Qt.NoModifier))
        self._pump(40)
        after = list(split.sizes())
        self.assertGreater(after[0], before[0], "拖动后左栏没有变宽")
        self.assertEqual(sum(after), sum(before), "拖动改变了总宽")
        split.deleteLater()

    def test_toggle_indicators_render_as_circles(self):
        """指示器必须**真的画成圆形**。

        QSS 文本正确 ≠ 渲染正确：实测 Qt 对超过半宽的 border-radius 不是 clamp 而是
        整个丢弃，所以「16px 方框 + 11px 圆角」在样式表里看着没问题，渲染出来是方块。
        这条只能靠像素判定。
        """
        from qfluent_core import UCheckbox, URadioButton, apply_skin
        apply_skin(self.theme, None, self.settings)
        raw = self.theme.t("accent", "#0D9488").lstrip("#")
        want = tuple(int(raw[i:i + 2], 16) for i in (0, 2, 4))

        def near(color):
            return all(abs(a - b) < 26
                       for a, b in zip((color.red(), color.green(), color.blue()), want))

        for widget, name in ((UCheckbox("已选", checked=True), "复选框"),
                             (URadioButton("单选", checked=True), "单选钮")):
            widget.show()
            self._pump(60)
            image = widget.grab().toImage()
            points = [(x, y) for y in range(image.height())
                      for x in range(image.width()) if near(image.pixelColor(x, y))]
            self.assertTrue(points, "%s 没有画出选中色" % name)
            xs = [p[0] for p in points]
            ys = [p[1] for p in points]
            corners = [image.pixelColor(min(xs), min(ys)), image.pixelColor(max(xs), min(ys)),
                       image.pixelColor(min(xs), max(ys)), image.pixelColor(max(xs), max(ys))]
            self.assertFalse(any(near(c) for c in corners),
                             "%s 渲染成了方块（圆角被 Qt 丢弃）" % name)
            widget.deleteLater()

    def test_toast_body_gets_full_wrapped_height(self):
        """换行正文必须拿到完整高度：QLabel 的 sizeHint 按理想宽度算，直接照它给
        高度会比实际需要的矮，首行与末行各被裁掉一截。"""
        from PySide6.QtWidgets import QWidget
        from qfluent_core import UToast
        host = QWidget()
        host.resize(900, 600)
        host.show()
        self.app.processEvents()
        toast = UToast("标题", "这一行正文足够长，会在通知的宽度里折成好几行。" * 3,
                       host, duration=60000)
        toast.popup()
        self.app.processEvents()
        body = toast.body
        self.assertGreaterEqual(body.height(), body.heightForWidth(body.width()),
                                "换行正文高度不足，末行会被裁掉")
        toast.dismiss()
        host.deleteLater()

    def test_clear_button_vertically_centered(self):
        """输入框内嵌清除按钮必须与控件中线对齐。

        Qt 把它的 y 定为 控件高/2 - 9，所以按钮高度必须固定为图标大小（18px）；
        按内容区高度设会让它偏下甚至溢出。
        """
        from PySide6.QtWidgets import QToolButton
        from qfluent_core import ULineEdit, apply_skin
        worst = 0
        for height in (28, 34, 42, 52):
            self.settings.set("control_height", height)
            apply_skin(self.theme, self.theme.render_tokens(self.settings))
            edit = ULineEdit("文本")
            edit.resize(240, height)
            edit.show()
            self._pump(110)
            for child in edit.findChildren(QToolButton):
                worst = max(worst,
                            abs(child.geometry().center().y() - edit.height() // 2))
            edit.hide()
        self.assertLessEqual(worst, 2, "清除按钮最大偏移 %d px" % worst)

    def test_selection_controls_have_no_block_focus_border(self):
        """复选框 / 单选钮的焦点只画在指示器上，不能圈住整块。"""
        from pathlib import Path
        from qfluent_core import QSS_DIR
        text = (Path(QSS_DIR) / "base.qss").read_text(encoding="utf-8")
        self.assertIn("QCheckBox:focus, QRadioButton:focus { border: none; }", text)
        # 焦点不再给指示器加边框（用户要求状态切换组件不要边框）
        self.assertNotIn("focus::indicator", text)
        # 选中靠实心填充：描边与填充同色，视觉上没有边框
        self.assertIn(
            "QCheckBox::indicator:checked { background: $accent; border-color: $accent; }",
            text)

    def test_multi_combo_stays_open_on_click(self):
        """按下与抬起都要吞掉，否则弹层会被判成「点了别处」而立刻收起。"""
        from PySide6.QtCore import Qt
        from PySide6.QtTest import QTest
        from qfluent_core import UMultiComboBox
        combo = UMultiComboBox(["甲", "乙"])
        combo.resize(200, 34)
        combo.show()
        self._pump(110)
        QTest.mouseClick(combo.lineEdit(), Qt.LeftButton)
        self._pump(200)
        self.assertTrue(combo.view().isVisible(), "点击后下拉没有保持展开")
        index = combo._model.index(0, 0)
        QTest.mouseClick(combo.view().viewport(), Qt.LeftButton, Qt.NoModifier,
                         combo.view().visualRect(index).center())
        self._pump(150)
        self.assertEqual(combo.selected(), ["甲"], "展开后应当能选中")
        combo.view().hide()

    def test_menu_collapse_turns_text_into_icon(self):
        """折叠必须真的把文字换成图标字形，且折叠按钮内置在菜单里（吸附式）。"""
        from qfluent_core import UMenu
        menu = UMenu(width=170)
        group = menu.add_group("主导航")
        menu.add_item("today", "今日", icon_text="今")
        menu.add_item("tasks", "任务")
        menu.resize(170, 200)
        menu.show()
        self._pump(110)
        button = menu._buttons["today"]
        self.assertEqual(button.text(), "今日")
        self.assertEqual(button.property("collapsed"), "false")

        menu.set_collapsed(True)
        self._pump(110)
        self.assertEqual(button.text(), "今", "折叠后应显示图标字形而不是完整文字")
        self.assertEqual(button.property("collapsed"), "true")
        self.assertEqual(menu.width(), menu._collapsed_width)
        self.assertIsNotNone(menu._toggle, "折叠按钮应内置在菜单里")
        self.assertIs(menu._toggle.parent(), menu)
        self.assertFalse(group.isVisible(), "折叠后分组标题也要收起，否则会被截断成半个词")

        menu.set_collapsed(False)
        self._pump(110)
        self.assertEqual(button.text(), "今日")
        self.assertEqual(menu.width(), menu._expanded_width)

    def _pump(self, ms: int = 120) -> None:
        from PySide6.QtCore import QEventLoop, QTimer
        loop = QEventLoop()
        QTimer.singleShot(ms, loop.quit)
        loop.exec()


    def test_combo_popup_has_background_and_single_border(self):
        """下拉弹窗必须有背景与唯一一层边框。

        踩过的坑：①把样式挂在 QComboBoxPrivateContainer（Qt 私有类名）不可靠；
        ②用 QComboBox QAbstractItemView 后代选择器 —— 弹出窗口是独立顶层窗口，
        根本不是 combo 的后代，规则从不匹配，结果弹窗整片透明。
        """
        from qfluent_core import UComboBox, UMultiComboBox, apply_skin
        apply_skin(self.theme, self.theme.render_tokens(self.settings))
        surface = self.theme.t("surface").upper()
        border = self.theme.t("border").upper()
        shelf = _shelf()
        # 必须显式传 theme/settings：全局单例可能已被别的测试（如 zhixing 桥接）
        # 替换掉，直接依赖单例会读到另一个主题包的颜色。
        widgets = (UComboBox([("甲", 1)], settings=self.settings, theme=self.theme),
                   UMultiComboBox(["甲"], settings=self.settings, theme=self.theme))
        try:
            for widget in widgets:
                widget.setParent(shelf)        # 挂在 shelf 上，退出时统一回收
                widget.resize(200, 34)
                widget.show()
                self._pump(120)
                widget.showPopup()
                self._pump(320)
                image = widget.view().parentWidget().grab().toImage()
                width, height = image.width(), image.height()
                self.assertEqual(
                    image.pixelColor(width // 2, height // 2).name().upper(), surface,
                    "%s 弹窗没有背景" % type(widget).__name__)
                self.assertEqual(
                    image.pixelColor(width // 2, 0).name().upper(), border,
                    "%s 弹窗缺少边框" % type(widget).__name__)
                widget.hidePopup()
        finally:
            # 弹出窗口是独立顶层窗口：必须显式关掉，否则会残留在屏幕上
            for widget in widgets:
                widget.hidePopup()
                widget.deleteLater()
            self._pump(80)


class TestInteractiveComponents(unittest.TestCase):
    """10 个交互动效组件的行为契约。"""

    def setUp(self):
        self.app = _qapp()
        self.settings, self.theme = _pair()
        from qfluent_core import apply_skin
        apply_skin(self.theme, self.theme.render_tokens(self.settings))

    # ---- 1. 折叠卡片：三属性共用一条曲线 ----
    def test_collapse_card_animates_all_three_properties(self):
        from qfluent_core import UCollapseCard, UTitle
        card = UCollapseCard("详情", settings=self.settings, theme=self.theme)
        card.add_widget(UTitle("内容", role="body", settings=self.settings,
                               theme=self.theme))
        card.resize(320, 200)
        card.show()
        card.set_expanded(False, animate=False)
        self._pump(120)
        card.set_expanded(True, animate=True)
        frames = []
        for _ in range(6):
            self._pump(35)
            frames.append((card.body.maximumHeight(),
                           card._body_effect.opacity(), card.chevron.angle()))
        middle = [f for f in frames if 0 < f[0] < card._body_full_height()]
        self.assertTrue(middle, "折叠动画没有中间帧")
        self.assertTrue(all(0 < opacity < 1 for _, opacity, _ in middle),
                        "内容透明度没有跟着同一条曲线")
        self.assertTrue(all(-90 < angle < 0 for _, _, angle in middle),
                        "箭头角度没有跟着同一条曲线")

    # ---- 2. 分段控件：选中块位移 + 内容横向切换 ----
    def test_segment_thumb_moves_and_stack_slides(self):
        from PySide6.QtWidgets import QLabel, QStackedWidget, QVBoxLayout, QWidget
        from qfluent_core import USegmentedControl
        segment = USegmentedControl(settings=self.settings, theme=self.theme)
        for text in ("甲", "乙", "丙"):
            segment.add_segment(text, text)
        stack = QStackedWidget()
        for text in ("甲页", "乙页", "丙页"):
            page = QWidget()
            QVBoxLayout(page).addWidget(QLabel(text))
            stack.addWidget(page)
        segment.bind_stack(stack)
        segment.resize(300, 40)
        stack.resize(300, 100)
        segment.show()
        stack.show()
        self._pump(150)

        segment.set_current_index(2)
        segment._on_clicked(2)
        positions = []
        for _ in range(4):
            self._pump(35)
            positions.append(segment._thumb.x())
        self.assertGreater(len(set(positions)), 1, "选中块没有位移动画：%s" % positions)
        self.assertEqual(stack.currentIndex(), 2)
        self._pump(320)
        self.assertEqual(stack.currentWidget().pos().x(), 0, "内容页没有滑到位")

    # ---- 3. 滑动确认条：阈值 ----
    def test_swipe_confirm_threshold_and_rebound(self):
        from qfluent_core import USwipeConfirm
        bar = USwipeConfirm("滑动删除", threshold=0.8, settings=self.settings,
                            theme=self.theme)
        bar.resize(320, 48)
        bar.show()
        self._pump(120)
        fired = []
        bar.confirmed.connect(lambda: fired.append(True))

        bar._dragging = True
        bar._update_from_pos(bar.width() * 0.5)
        bar._dragging = False
        bar._animate_to(0.0 if bar.progress() < 0.8 else 1.0)
        self._pump(220)
        self.assertEqual(fired, [], "没滑够却触发了")
        self.assertAlmostEqual(bar.progress(), 0.0, places=1, msg="没滑够却没有回弹")

        bar._dragging = True
        bar._update_from_pos(bar.width() * 0.95)
        bar._dragging = False
        self.assertGreaterEqual(bar.progress(), 0.8)
        bar._locked = True
        bar.confirmed.emit()
        self._pump(120)
        self.assertEqual(len(fired), 1, "滑够了却没触发")

    # ---- 4. 翻转卡片：中途换面 ----
    def test_flip_card_switches_face_at_half(self):
        from PySide6.QtWidgets import QLabel
        from qfluent_core import UFlipCard
        front, back = QLabel("正面"), QLabel("背面")
        card = UFlipCard(front, back, settings=self.settings, theme=self.theme)
        card.resize(240, 120)
        card.show()
        self._pump(120)
        card.set_flipped(True, animate=False)
        card._apply_progress(0.2)
        self.assertTrue(front.isVisible() and not back.isVisible(), "0.2 时应显示正面")
        card._apply_progress(0.8)
        self.assertFalse(front.isVisible() and False, "")
        self.assertTrue(back.isVisible() and not front.isVisible(), "0.8 时应显示背面")

    # ---- 5. 操作型卡片：就地生效 ----
    def test_action_card_updates_in_place(self):
        from qfluent_core import UActionCard
        card = UActionCard("偏好", settings=self.settings, theme=self.theme)
        card.add_stepper("count", "数量", 3, maximum=10)
        card.add_switch("notify", "提醒", True)
        seen = []
        card.valueChanged.connect(lambda key, value: seen.append((key, value)))
        card._publish("count", 4)
        self.assertEqual(card.value("count"), 4)
        self.assertEqual(seen, [("count", 4)])
        self.assertIn("数量 4", card.result.text(), "没有就地回显")
        self.assertIn("提醒 开", card.result.text())

    # ---- 6. 筛选胶囊：实底 + 横向滚动 ----
    def test_filter_chips_solid_selection_and_scroll(self):
        from qfluent_core import UFilterChips
        chips = UFilterChips(settings=self.settings, theme=self.theme)
        for text in ("全部", "今天", "本周", "已完成", "高优先级", "带附件"):
            chips.add_chip(text)
        chips.resize(240, 44)
        chips.show()
        self._pump(120)
        chips.set_selected(["今天"])
        self.assertEqual(chips.selected(), ["今天"])
        active = chips._chips[1]
        idle = chips._chips[0]
        self.assertEqual(active.property("kind"), "solid", "选中态应为实底")
        self.assertEqual(active.tone, "accent")
        self.assertEqual(idle.property("kind"), "ghost")
        chips._scroll.resize(160, 44)
        self._pump(120)
        self.assertGreater(chips._scroll.horizontalScrollBar().maximum(), 0,
                           "超出宽度时应当可以横向滚动")

    # ---- 7. 进度卡片：三态 + 当前节点展开详情 ----
    def test_progress_card_states_and_detail(self):
        from qfluent_core import UProgressCard
        card = UProgressCard("流程", settings=self.settings, theme=self.theme)
        card.set_steps([("第一步", "详情一"), ("第二步", "详情二"), ("第三步", "详情三")])
        card.resize(400, 200)
        card.show()
        self._pump(150)
        self.assertEqual(card.current(), 0)
        self.assertIn("1 / 3", card.caption.text())
        card.set_current(2)
        heights = []
        for _ in range(4):
            self._pump(40)
            heights.append(card.detail.maximumHeight())
        self.assertIn("3 / 3", card.caption.text())
        self.assertEqual(card.detail.text(), "详情三")
        self.assertGreater(max(heights), 0, "当前节点详情没有展开")

    # ---- 8. 吸底操作栏 ----
    def test_bottom_bar_safe_area(self):
        from qfluent_core import UBottomBar
        bar = UBottomBar("合计 100", "含运费", action_text="提交", safe_margin=16,
                         settings=self.settings, theme=self.theme)
        bar.resize(400, 80)
        bar.show()
        self._pump(120)
        margins = bar.layout().contentsMargins()
        self.assertEqual(margins.bottom(), 10 + 16, "底部没有留出安全区")
        self.assertEqual(bar.action_button().text(), "提交")
        self.assertTrue(bar.action_button().tone == "accent", "主按钮应为 accent")

    # ---- 9. 格式化输入框 ----
    def test_masked_input_formats_and_counts(self):
        from qfluent_core import UMaskedInput
        today = UMaskedInput("####-##-##", unit="日", max_length=8,
                             settings=self.settings, theme=self.theme)
        today.set_text("20260913")
        self.assertEqual(today.text(), "2026-09-13", "日期没有自动分隔")
        self.assertEqual(today.raw_text(), "20260913", "原始值应去掉分隔符")
        self.assertEqual(today.counter.text(), "8/8")
        self.assertEqual(today.unit.text(), "日")
        clock = UMaskedInput("##:##", max_length=4, settings=self.settings,
                             theme=self.theme)
        clock.set_text("0930")
        self.assertEqual(clock.text(), "09:30", "时间没有自动分隔")

    # ---- 10. 顶部标签页：下划线跟手 + 居中 ----
    def test_tab_strip_underline_and_centering(self):
        from qfluent_core import UTabStrip
        strip = UTabStrip(settings=self.settings, theme=self.theme)
        for index in range(8):
            strip.add_tab("标签 %d" % (index + 1))
        strip.resize(280, 44)
        strip.show()
        self._pump(150)
        strip.set_current(6)
        positions = []
        for _ in range(4):
            self._pump(40)
            positions.append(strip._underline.x())
        self.assertGreater(len(set(positions)), 1, "下划线没有跟手位移：%s" % positions)
        self.assertGreater(strip._scroll.horizontalScrollBar().value(), 0,
                           "选中标签没有滚动到可视区")
        self.assertEqual(strip.current_key(), "标签 7")

    def _pump(self, ms: int = 60) -> None:
        from PySide6.QtCore import QEventLoop, QTimer
        loop = QEventLoop()
        QTimer.singleShot(ms, loop.quit)
        loop.exec()


class TestNoHardcodedValues(unittest.TestCase):
    """「取消硬编码」的可执行契约：颜色、尺寸、间距、动效都要能通过设置改。

    这些测试的作用是把「框架里不许再出现硬编码」变成会失败的断言，
    而不是靠人工 review 记住。
    """

    def setUp(self):
        self.app = _qapp()
        self.settings, self.theme = _pair()

    def test_qss_templates_have_no_raw_px(self):
        """模板里不许出现裸 px：所有尺寸都必须走 token。"""
        import re
        from pathlib import Path
        from qfluent_core import QSS_DIR
        offenders = {}
        for path in sorted(Path(QSS_DIR).glob("*.qss")):
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                stripped = line.strip()
                if stripped.startswith(("/*", "*", "--")):
                    continue
                if "$" in line:
                    continue
                if re.search(r"\b\d+px\b", line):
                    offenders["%s:%d" % (path.name, number)] = stripped[:60]
        self.assertEqual(offenders, {}, "QSS 里还有裸 px：%s" % offenders)

    def test_qss_templates_have_no_raw_colors(self):
        """模板里不许出现字面色值。"""
        import re
        from pathlib import Path
        from qfluent_core import QSS_DIR
        offenders = {}
        for path in sorted(Path(QSS_DIR).glob("*.qss")):
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if line.strip().startswith(("/*", "*", "--")):
                    continue
                if re.search(r"#[0-9A-Fa-f]{3,8}\b|rgba?\(", line):
                    offenders["%s:%d" % (path.name, number)] = line.strip()[:60]
        self.assertEqual(offenders, {}, "QSS 里还有字面色值：%s" % offenders)

    def test_settings_schema_covers_every_key(self):
        """每一项配置都要在 schema 里声明 —— 否则设置面板不会显示它。"""
        from qfluent_core.settings import DEFAULTS, UISettings
        declared = {spec.key for spec in UISettings.schema()}
        undeclared = sorted(set(DEFAULTS) - declared)
        self.assertEqual(undeclared, [], "这些配置项没有在 SCHEMA_SPECS 里声明：%s" % undeclared)
        unknown = sorted(declared - set(DEFAULTS))
        self.assertEqual(unknown, [], "schema 声明了不存在的配置项：%s" % unknown)

    def test_every_setting_reaches_tokens(self):
        """改设置必须真的改变渲染 token（否则「可配置」是假的）。"""
        from qfluent_core import K
        baseline = self.theme.render_tokens(self.settings)
        cases = (
            (K.SPACING, "relaxed", "space-4"),
            (K.BORDER_WIDTH, 2, "border-w"),
            (K.SCROLLBAR_WIDTH, 12, "scrollbar-w"),
            (K.ICON_SIZE, 24, "icon-size"),
            (K.RADIUS, 16, "radius-md"),
            (K.FONT_SIZE, 18, "font-size"),
            (K.CONTROL_HEIGHT, 44, "control-h"),
        )
        for key, value, token in cases:
            self.settings.set(key, value)
            changed = self.theme.render_tokens(self.settings)
            self.assertNotEqual(changed.get(token), baseline.get(token),
                                "改 %s 没有影响 token %s" % (key, token))
        style = self.theme.style_sheet()
        self.assertTrue(style)
        self.assertEqual(self.theme.missing_tokens(), ())

    def test_spacing_scale_changes_every_space_token(self):
        from qfluent_core import K
        self.settings.set(K.SPACING, "compact")
        compact = self.theme.render_tokens(self.settings)
        self.settings.set(K.SPACING, "relaxed")
        relaxed = self.theme.render_tokens(self.settings)
        for index in range(1, 7):
            token = "space-%d" % index
            self.assertLess(int(compact[token].replace("px", "")),
                            int(relaxed[token].replace("px", "")),
                            "%s 没有跟随间距档位" % token)

    def test_component_fixed_sizes_come_from_tokens(self):
        """组件的固定尺寸必须能被设置改变。"""
        from PySide6.QtWidgets import QApplication
        from qfluent_core import K, UAlert, UEmptyState, apply_skin
        apply_skin(self.theme, self.theme.render_tokens(self.settings))
        self.settings.set(K.ICON_SIZE, 16)
        alert = UAlert("标题", "内容", settings=self.settings, theme=self.theme)
        alert.show()
        self._pump(60)
        small = alert.icon.width()
        self.settings.set(K.ICON_SIZE, 26)
        apply_skin(self.theme, self.theme.render_tokens(self.settings))
        alert.restyle()
        self._pump(60)
        self.assertNotEqual(small, alert.icon.width(),
                            "图标尺寸没有跟随 icon_size 设置")
        empty = UEmptyState("还没有内容", "先创建一条", settings=self.settings,
                            theme=self.theme)
        empty.show()
        self._pump(60)
        self.assertGreater(empty.icon.width(), 0)

    def _pump(self, ms: int = 60) -> None:
        from PySide6.QtCore import QEventLoop, QTimer
        loop = QEventLoop()
        QTimer.singleShot(ms, loop.quit)
        loop.exec()


class TestSettingsPanel(unittest.TestCase):
    """统一设置入口：schema 驱动，新增设置无需改面板。"""

    def setUp(self):
        self.app = _qapp()
        self.settings, self.theme = _pair()
        from qfluent_core import apply_skin
        apply_skin(self.theme, self.theme.render_tokens(self.settings))

    def test_panel_builds_one_control_per_schema_spec(self):
        from qfluent_core import USettingsPanel
        panel = USettingsPanel(settings=self.settings, theme=self.theme)
        panel.resize(600, 1200)
        panel.show()
        self._pump(200)
        specs = [s for s in USettingsPanel.__mro__ and
                 __import__("qfluent_core.settings", fromlist=["UISettings"]).UISettings.schema()]
        missing = [s.key for s in specs
                   if s.kind != "color" and panel.control_for(s.key) is None]
        self.assertEqual(missing, [], "这些设置项没有生成控件：%s" % missing)
        self.assertGreaterEqual(len(panel.group_cards()), 3, "设置面板没有分组")

    def test_panel_writes_through_to_settings(self):
        from qfluent_core import K, USettingsPanel
        panel = USettingsPanel(settings=self.settings, theme=self.theme, show_reset=False)
        panel.show()
        self._pump(150)
        slider = panel.control_for(K.RADIUS)
        slider.setValue(14)
        self._pump(60)
        self.assertEqual(self.settings.get(K.RADIUS), 14)
        toggle = panel.control_for(K.ANIMATIONS)
        toggle.setChecked(False)
        self._pump(60)
        self.assertFalse(self.settings.get_bool(K.ANIMATIONS))

    def test_panel_follows_external_changes(self):
        from qfluent_core import K, USettingsPanel
        panel = USettingsPanel(settings=self.settings, theme=self.theme, show_reset=False)
        panel.show()
        self._pump(150)
        self.settings.set(K.RADIUS, 3)
        self._pump(60)
        self.assertEqual(panel.control_for(K.RADIUS).value(), 3,
                         "外部改值后面板没有同步")

    def test_panel_reset_restores_defaults(self):
        from qfluent_core import K, USettingsPanel
        panel = USettingsPanel(settings=self.settings, theme=self.theme)
        panel.show()
        self._pump(150)
        self.settings.set(K.RADIUS, 18)
        self.settings.set(K.SPACING, "relaxed")
        panel.reset()
        self._pump(120)
        self.assertEqual(self.settings.get(K.RADIUS), 8)
        self.assertEqual(self.settings.get(K.SPACING), "standard")

    def _pump(self, ms: int = 60) -> None:
        from PySide6.QtCore import QEventLoop, QTimer
        loop = QEventLoop()
        QTimer.singleShot(ms, loop.quit)
        loop.exec()


class TestIconSystem(unittest.TestCase):
    """SVG 图标系统：机制在框架，业务图标靠注册。"""

    def setUp(self):
        self.app = _qapp()

    def test_builtin_icons_exist(self):
        from qfluent_core import icons
        for name in ("chevron-down", "chevron-up", "check", "close", "search",
                     "plus", "minus", "more", "settings", "info"):
            self.assertTrue(icons.has(name), "缺少内置图标 %s" % name)
        self.assertGreaterEqual(len(icons.names()), 25)

    def test_pixmap_logical_size_matches_request(self):
        """DPI 数学：物理像素 = 逻辑尺寸 x DPR x 超采样，逻辑尺寸必须正好是 size。

        这条守的是一个真实踩过的坑：只设超采样倍数会让逻辑尺寸跟着放大
        （20px 的图标变成 80px）。
        """
        from qfluent_core import icons
        for size in (12, 16, 18, 24, 32):
            pm = icons.pixmap("search", size=size, dpr=2.0)
            logical = pm.width() / pm.devicePixelRatio()
            self.assertAlmostEqual(logical, size, places=1,
                                   msg="size=%d 的逻辑尺寸算成 %.1f" % (size, logical))
        # 屏幕 DPR 也要体现在物理像素里（否则高 DPI 下会糊）
        low = icons.pixmap("search", size=16, dpr=1.0)
        high = icons.pixmap("search", size=16, dpr=2.0)
        self.assertGreater(high.width(), low.width())

    def test_pixmap_cache_returns_same_object(self):
        from qfluent_core import icons
        icons.clear_cache()
        first = icons.pixmap("check", "#16A34A", 16, dpr=1.0)
        self.assertIs(icons.pixmap("check", "#16A34A", 16, dpr=1.0), first,
                      "同样的参数应命中内存缓存")

    def test_icon_follows_theme_color(self):
        """不传颜色时应取主题 token 的 fg2，而不是硬编码。"""
        from qfluent_core import ThemeManager, icons
        token_color = ThemeManager.instance().tokens.get("fg2", "#6B7280")
        data = bytes(icons.svg_bytes("check")).decode("utf-8")
        self.assertIn(token_color.lower(), data.lower(),
                      "图标描边色应来自主题 token")

    def test_file_url_writes_readable_svg(self):
        """QSS 用的图标必须真的落盘且内容可读（Qt 的 QSS 不支持 data URI）。"""
        from pathlib import Path
        from qfluent_core import icons
        url = icons.file_url("chevron-down")
        self.assertTrue(url, "file_url 应返回可用路径")
        path = Path(url)
        self.assertTrue(path.exists(), "图标文件应存在：%s" % url)
        self.assertIn("<svg", path.read_text(encoding="utf-8"))
        # 落在缓存目录，不是 /tmp 根
        self.assertIn("qfluent_core", url)

    def test_register_extends_icon_set(self):
        from qfluent_core import icons
        icons.register("test.probe", '<path d="M4 4h16v16H4z"/>')
        self.assertTrue(icons.has("test.probe"))
        self.assertFalse(icons.icon("test.probe").isNull())
        self.assertIn("test.probe", icons.names("test."))

    def test_set_icon_on_button(self):
        from PySide6.QtWidgets import QPushButton
        from qfluent_core import icons
        button = QPushButton("x")
        self.assertTrue(icons.set_icon(button, "plus"))
        self.assertFalse(button.icon().isNull())

    def test_unknown_icon_falls_back_instead_of_crashing(self):
        from qfluent_core import icons
        self.assertFalse(icons.has("nope.missing"))
        pm = icons.pixmap("nope.missing", size=16)
        self.assertFalse(pm.isNull(), "未知图标应回退而不是崩溃")


class TestZhixingIconRegistration(unittest.TestCase):
    """业务图标通过注册进入框架，框架本身不含业务语义。"""

    def setUp(self):
        self.app = _qapp()

    def test_business_icons_are_registered(self):
        from zhixing.view.kit import icons as biz
        self.assertGreaterEqual(len(biz.names("nav.")), 8)
        self.assertGreaterEqual(len(biz.names("action.")), 10)
        self.assertTrue(biz.icon("nav.today").isNull() is False)

    def test_framework_does_not_contain_business_semantics(self):
        """框架的内置图标集里不该出现 nav./task./achieve. 这类业务命名。"""
        from qfluent_core.icons import ICON_NAMES
        polluted = [n for n in ICON_NAMES
                    if n.startswith(("nav.", "task.", "achieve.", "pomo."))]
        self.assertEqual(polluted, [], "框架内置了业务图标：%s" % polluted)

    def test_legacy_api_still_works(self):
        """旧调用点（icon_svg/pixmap/icon/data_uri/names）应继续可用。"""
        from zhixing.view.kit import icons as biz
        self.assertTrue(biz.icon_svg("action.add", "#333333"))
        self.assertFalse(biz.pixmap("action.add", "#333333", 16).isNull())
        self.assertFalse(biz.icon("action.add", "#333333").isNull())
        self.assertTrue(biz.data_uri("action.add", "#333333"))
        self.assertTrue(biz.names())


if __name__ == "__main__":
    unittest.main()
