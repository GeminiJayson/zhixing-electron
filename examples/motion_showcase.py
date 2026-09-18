# -*- coding: utf-8 -*-
"""动效测试窗口：控件 + 布局 + 动效的可视化验收面。

覆盖框架现有的全部动效能力：
    壳层 —— 侧边导航折叠（宽度 OutExpo 280ms）、页面切换淡入+上移、指示条滑动
    控件 —— 折叠面板高度动画、开关滑轨、骨架呼吸、数字滚动、进度条数值动画
    反馈 —— 按钮按压内缩、进度环旋转、对话框淡入入场、列表 stagger 逐条入场
    降级 —— 动效开关切换后所有动效立即停止（含正在播放的）

每一页进入时自动重播本页动效；顶栏 ↻ 可手动重播。

运行：
    .venv/bin/python -m examples.motion_showcase
"""
from __future__ import annotations

import sys
from typing import Dict, List, Optional

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import (
    QApplication, QHBoxLayout, QScrollArea, QVBoxLayout, QWidget,
)

from qfluent_core import (
    K, FluentTemplateWindow, ThemeManager, UBadge, UButton, UCard, UDialog,
    UDivider, UExpander, UField, UIconButton, UInfoBar, ULineEdit, UPageHeader,
    UProgressBar, UProgressRing, USkeleton, UStatusPill, UTitle, UToggleSwitch,
    UISettings, motion,
)

__all__ = ["MotionShowcase", "build_showcase", "main"]

MARGIN = 20


def _scrollable(content: QWidget) -> QWidget:
    holder = QWidget()
    outer = QVBoxLayout(holder)
    outer.setContentsMargins(0, 0, 0, 0)
    scroll = QScrollArea(holder)
    scroll.setWidgetResizable(True)
    scroll.setFrameShape(QScrollArea.NoFrame)
    scroll.setWidget(content)
    outer.addWidget(scroll)
    return holder


def _column(parent: QWidget) -> QVBoxLayout:
    layout = QVBoxLayout(parent)
    layout.setContentsMargins(MARGIN, MARGIN, MARGIN, MARGIN)
    layout.setSpacing(16)
    return layout


class MotionShowcase(FluentTemplateWindow):
    """动效测试窗口。所有触发都是公开方法，便于人工重播与脚本抓帧。"""

    def __init__(self, parent: Optional[QWidget] = None,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        super().__init__(parent, "qfluent_core 动效测试", signature="动效",
                         command_placeholder=" 重播当前页动效… ",
                         settings=settings, theme=theme,
                         nav_width=200, nav_collapsed_width=48)
        self._stagger_rows: List[QWidget] = []
        self._bars: List[UProgressBar] = []
        self._counters: List[UTitle] = []
        self._skeletons: List[USkeleton] = []
        self._expander: Optional[UExpander] = None
        self._ring: Optional[UProgressRing] = None
        self._motion_switch: Optional[UToggleSwitch] = None
        self._motion_state: Optional[UInfoBar] = None

        self.add_page(self._build_shell_page(), "壳动效", key="shell")
        self.add_page(self._build_controls_page(), "控件动效", key="controls")
        self.add_page(self._build_feedback_page(), "反馈与浮层", key="feedback")
        self.add_page(self._build_reduce_page(), "动效降级", key="reduce",
                      position="bottom")
        self.add_title_tool(UIconButton(None, "重播当前页动效", text="\u21bb",
                                        on_click=self.replay_current,
                                        settings=self._settings, theme=self._theme))
        self.pageChanged.connect(lambda _index: self.replay_current())
        QTimer.singleShot(150, self.replay_current)

    # ===================== 页 1：壳动效 =====================
    def _build_shell_page(self) -> QWidget:
        content = QWidget()
        layout = _column(content)
        layout.addWidget(UPageHeader("壳层动效", "导航折叠 / 页面切换 / 指示条，全部走 token 曲线",
                                     settings=self._settings, theme=self._theme))

        card = UCard("导航与页面", "折叠是宽度属性动画（OutExpo，panel 档 280ms）",
                     settings=self._settings, theme=self._theme)
        row = QHBoxLayout()
        row.setSpacing(8)
        toggle = UButton("折叠 / 展开导航", tone="standard",
                         settings=self._settings, theme=self._theme)
        toggle.clicked.connect(self.toggle_navigation)
        next_page = UButton("切到下一页（淡入 + 上移）", tone="accent",
                            settings=self._settings, theme=self._theme)
        next_page.clicked.connect(self.demo_page_switch)
        row.addWidget(toggle)
        row.addWidget(next_page)
        row.addStretch(1)
        card.add_layout(row)
        card.add_widget(UTitle("页面切换：新页 200ms 淡入，并带 4px 上移位移（page 档）",
                              role="caption", settings=self._settings, theme=self._theme))
        layout.addWidget(card)

        curves = UCard("动效 token", "时长与缓动集中在这里，改一处全局生效",
                       settings=self._settings, theme=self._theme)
        for name, ms in motion.DURATION.items():
            curves.add_widget(UTitle("%-8s %d ms" % (name, ms), role="caption",
                                     settings=self._settings, theme=self._theme))
        layout.addWidget(curves)
        layout.addStretch(1)
        return _scrollable(content)

    # ===================== 页 2：控件动效 =====================
    def _build_controls_page(self) -> QWidget:
        content = QWidget()
        layout = _column(content)
        layout.addWidget(UPageHeader("控件动效", "开关滑轨 / 折叠高度 / 骨架呼吸 / 数字滚动 / 进度动画",
                                     settings=self._settings, theme=self._theme))

        switches = UCard("开关与折叠", "滑轨圆点 OutCubic 150ms；折叠是 maximumHeight 动画",
                         settings=self._settings, theme=self._theme)
        row = QHBoxLayout()
        row.setSpacing(16)
        row.addWidget(UToggleSwitch(True, tooltip="启用提醒",
                                    settings=self._settings, theme=self._theme))
        row.addWidget(UToggleSwitch(False, tooltip="仅显示未完成",
                                    settings=self._settings, theme=self._theme))
        row.addStretch(1)
        switches.add_layout(row)
        self._expander = UExpander("高级选项（点我展开）",
                                   settings=self._settings, theme=self._theme)
        self._expander.add_widget(UField("工作目录",
                                        ULineEdit("~/Documents", settings=self._settings,
                                                  theme=self._theme),
                                        settings=self._settings, theme=self._theme))
        self._expander.add_widget(UField("同步间隔",
                                        ULineEdit("15", settings=self._settings,
                                                  theme=self._theme),
                                        help_text="分钟", settings=self._settings,
                                        theme=self._theme))
        switches.add_widget(self._expander)
        layout.addWidget(switches)

        loading = UCard("加载占位", "骨架屏呼吸 700ms；几何保持，加载完成不跳版",
                        settings=self._settings, theme=self._theme)
        for width in (260, 180, 90):
            skeleton = USkeleton(width=width, settings=self._settings, theme=self._theme)
            self._skeletons.append(skeleton)
            loading.add_widget(skeleton)
        layout.addWidget(loading)

        numbers = UCard("数字与进度", "数字滚动 + 进度条数值动画（都由 QVariantAnimation 驱动）",
                        settings=self._settings, theme=self._theme)
        counter = UTitle("0", role="title", settings=self._settings, theme=self._theme)
        self._counters.append(counter)
        numbers.add_widget(counter)
        bar_row = QHBoxLayout()
        bar_row.setSpacing(0)
        progress = UProgressBar(0, settings=self._settings, theme=self._theme)
        self._bars.append(progress)
        bar_row.addWidget(progress)
        numbers.add_widget(progress)
        actions = QHBoxLayout()
        actions.setSpacing(8)
        roll = UButton("滚动数字到 1280", tone="standard",
                       settings=self._settings, theme=self._theme)
        roll.clicked.connect(self.roll_numbers)
        push = UButton("推进进度", tone="accent",
                       settings=self._settings, theme=self._theme)
        push.clicked.connect(self.advance_progress)
        actions.addWidget(roll)
        actions.addWidget(push)
        actions.addStretch(1)
        numbers.add_layout(actions)
        layout.addWidget(numbers)
        layout.addStretch(1)
        return _scrollable(content)

    # ===================== 页 3：反馈与浮层 =====================
    def _build_feedback_page(self) -> QWidget:
        content = QWidget()
        layout = _column(content)
        layout.addWidget(UPageHeader("反馈与浮层", "按压内缩 / 进度环 / 对话框入场 / 逐条入场",
                                     settings=self._settings, theme=self._theme))

        press = UCard("按压反馈", "Qt QSS 没有 transform，用 1px 内缩 + 底色变化表达",
                      settings=self._settings, theme=self._theme)
        row = QHBoxLayout()
        row.setSpacing(8)
        for tone in ("standard", "accent", "subtle", "danger"):
            row.addWidget(UButton(tone.capitalize(), tone=tone,
                                  settings=self._settings, theme=self._theme))
        row.addStretch(1)
        press.add_layout(row)
        layout.addWidget(press)

        rings = UCard("进度环", "不确定进度持续旋转；确定进度按 value 画弧",
                      settings=self._settings, theme=self._theme)
        ring_row = QHBoxLayout()
        ring_row.setSpacing(16)
        ring_row.addWidget(UProgressRing(indeterminate=True, size=32,
                                         settings=self._settings, theme=self._theme))
        self._ring = UProgressRing(size=32, settings=self._settings, theme=self._theme)
        self._ring.set_range(0, 100)
        ring_row.addWidget(self._ring)
        sweep = UButton("走到 100%", tone="standard",
                        settings=self._settings, theme=self._theme)
        sweep.clicked.connect(self.ring_sweep)
        ring_row.addWidget(sweep)
        ring_row.addStretch(1)
        rings.add_layout(ring_row)
        layout.addWidget(rings)

        overlay = UCard("浮层入场", "一次性浮层 150ms 淡入 + 6px 上移",
                        settings=self._settings, theme=self._theme)
        open_dialog = UButton("打开对话框", tone="accent",
                              settings=self._settings, theme=self._theme)
        open_dialog.clicked.connect(self.open_demo_dialog)
        overlay.add_widget(open_dialog)
        layout.addWidget(overlay)

        layout.addWidget(self._build_stagger_card())
        layout.addStretch(1)
        return _scrollable(content)

    def _build_stagger_card(self) -> UCard:
        card = UCard("逐条入场", "stagger：每行间隔 60ms 淡入 + 上移",
                     settings=self._settings, theme=self._theme)
        for index in range(6):
            row = UCard("", variant="sunken", padding=8,
                        settings=self._settings, theme=self._theme)
            inner = QHBoxLayout()
            inner.setSpacing(8)
            inner.addWidget(UTitle("任务 %d · 知行合一" % (index + 1), role="body",
                                   settings=self._settings, theme=self._theme))
            inner.addStretch(1)
            inner.addWidget(UStatusPill("待处理" if index % 2 else "进行中",
                                        tone="standard" if index % 2 else "accent",
                                        settings=self._settings, theme=self._theme))
            row.add_layout(inner)
            row.setVisible(False)
            self._stagger_rows.append(row)
            card.add_widget(row)
        replay = UButton("重播入场", tone="standard", settings=self._settings,
                         theme=self._theme)
        replay.clicked.connect(self.replay_stagger)
        card.set_footer_widget(replay)
        return card

    # ===================== 页 4：动效降级 =====================
    def _build_reduce_page(self) -> QWidget:
        content = QWidget()
        layout = _column(content)
        layout.addWidget(UPageHeader("动效降级", "开关立即生效：正在播放的动画也会停",
                                     settings=self._settings, theme=self._theme))

        card = UCard("界面动效", "等价于系统的「减少动态效果」；关闭后所有动画不再启动",
                     settings=self._settings, theme=self._theme)
        enabled = self._settings.get_bool(K.ANIMATIONS, True)
        self._motion_switch = UToggleSwitch(enabled, tooltip="启用界面动效",
                                            settings=self._settings, theme=self._theme)
        self._motion_switch.toggled.connect(self._on_motion_toggled)
        card.add_widget(UField("启用界面动效", self._motion_switch,
                               help_text="关闭后导航折叠、页面淡入、滑轨、骨架、数字滚动、逐条入场全部即时停",
                               settings=self._settings, theme=self._theme))
        self._motion_state = UInfoBar(
            "动效已启用" if enabled else "动效已关闭（reduce-motion）",
            tone="success" if enabled else "standard",
            settings=self._settings, theme=self._theme)
        card.add_widget(self._motion_state)
        layout.addWidget(card)

        observe = UCard("观察点", "关闭动效后仍能重播：动画会直接落到终值，界面不会卡住",
                        settings=self._settings, theme=self._theme)
        push = UButton("推进进度（关闭动效后应瞬间到 100%）", tone="standard",
                       settings=self._settings, theme=self._theme)
        push.clicked.connect(self.advance_progress)
        stagger = UButton("逐条入场（关闭后应一次全部出现）", tone="standard",
                          settings=self._settings, theme=self._theme)
        stagger.clicked.connect(self.replay_stagger)
        observe.add_widget(push)
        observe.add_widget(stagger)
        layout.addWidget(observe)
        layout.addStretch(1)
        return _scrollable(content)

    # ===================== 触发（公开方法） =====================
    def replay_current(self) -> None:
        """重播当前页的动效（进入页面时自动调用，顶栏 ↻ 也可手动触发）。"""
        key = self._key_at(self.current_index())
        if key == "controls":
            if self._expander is not None and not self._expander.is_expanded():
                self._expander.set_expanded(True)
            self.roll_numbers()
            self.advance_progress()
        elif key == "feedback":
            self.replay_stagger()
            self.ring_sweep()

    def demo_page_switch(self) -> None:
        count = self.page_count()
        self.set_current_index((self.current_index() + 1) % count)

    def replay_stagger(self) -> None:
        """列表逐条入场：先全部隐藏，再按 60ms 间隔依次淡入。"""
        rows = self._stagger_rows
        for row in rows:
            row.setVisible(False)

        def step(index: int) -> None:
            rows[index].setVisible(True)
            motion.fade_in(rows[index], "fast", 6)

        motion.stagger(len(rows), step, step_ms=60)

    def roll_numbers(self, target: int = 1280) -> None:
        for label in self._counters:
            label.setText("0")
            motion.number_roller(label, target, dur="slow")

    def advance_progress(self) -> None:
        for bar in self._bars:
            bar.setValue(0)
            motion.animate_value(0, 100, dur="slow", parent=bar,
                                 on_update=lambda value, b=bar: b.setValue(int(value)))

    def ring_sweep(self) -> None:
        if self._ring is None:
            return
        self._ring.set_range(0, 100)
        self._ring.set_value(0)
        motion.animate_value(0, 100, dur="slow", parent=self._ring,
                             on_update=lambda value: self._ring.set_value(int(value)))

    def open_demo_dialog(self) -> None:
        dialog = UDialog("动效：浮层入场", self, width=420, height=240,
                         settings=self._settings, theme=self._theme)
        dialog.add_widget(UTitle("这个对话框是 150ms 淡入 + 6px 上移进来的",
                                 role="body", settings=self._settings, theme=self._theme))
        dialog.add_widget(ULineEdit("", "试着输入点什么…", settings=self._settings,
                                    theme=self._theme))
        dialog.set_cancel_action()
        dialog.set_primary_action("知道了", dialog.accept)
        dialog.exec()

    # ===================== 内部 =====================
    def _on_motion_toggled(self, enabled: bool) -> None:
        self._settings.set(K.ANIMATIONS, enabled)      # 广播 -> motion 立即生效
        if self._motion_state is not None:
            self._motion_state.set_text("动效已启用" if enabled
                                        else "动效已关闭（reduce-motion）")
            self._motion_state.set_tone("success" if enabled else "standard")

    def _key_at(self, index: int) -> str:
        if not (0 <= index < len(self._pages)):
            return ""
        return self._pages[index].key or ""


def build_showcase(settings: Optional[UISettings] = None,
                   theme: Optional[ThemeManager] = None) -> MotionShowcase:
    return MotionShowcase(None, settings, theme)


def main(argv: Optional[List[str]] = None) -> int:
    argv = list(sys.argv if argv is None else argv)
    app = QApplication.instance() or QApplication(argv)
    settings = UISettings()
    UISettings.install(settings)
    window = build_showcase(settings, ThemeManager())
    window.resize(1180, 780)
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
