# -*- coding: utf-8 -*-
"""业务组合层（外壳）示范：在既有项目里使用 qfluent_core.FluentTemplateWindow。

本文件里的所有代码都属于「业务层」，可直接抄进既有项目的 MainWindow：
  1. 导入框架控件 -> 组装页面（不改动任何原有布局代码，框架窗口就是 QWidget）；
  2. 用框架暴露的 Signal 重新绑定原本散落在窗口里的业务处理函数；
  3. 订阅 UISettings 的配置信号，实现不重启即可刷新字体 / 皮肤 / 业务数据；
  4. 业务自定义信号：把框架的配置事件桥接成业务事件（不只是处理 UI 变化）。

运行：
    .venv/bin/python -m examples.fluent_business_shell            # 打开界面
    .venv/bin/python -m examples.fluent_business_shell --selftest # 无界面自检
"""
from __future__ import annotations

import sys
from typing import Dict, List, Optional

from PySide6.QtCore import QSize, Qt, Signal
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QApplication, QLabel, QListWidget, QListWidgetItem, QVBoxLayout, QWidget,
)

from qfluent_core import FluentTemplateWindow, K, ThemeManager, UISettings

__all__ = ["DemoTaskService", "BusinessThemeSource", "TaskListPage", "MainWindow",
           "main", "selftest"]


class DemoTaskService(object):
    """假业务数据源（真实项目里换成 task_service / note_service）。"""

    ROWS: List[tuple] = [("修复登录超时", "高"), ("整理周会纪要", "中"),
                         ("回访客户 A", "低"), ("补充单元测试", "中")]

    def load(self) -> List[tuple]:
        return list(self.ROWS)


class BusinessThemeSource(object):
    """业务侧主题真源（真实项目里就是 zhixing.view.kit.theme.ThemeEngine）。

    职责：把业务配置（亮/暗、强调色）算成语义 token 推给框架层；框架只消费。
    这样「皮肤算法」留在业务项目，「绘制」留在框架，两边都不重复实现。
    """

    def __init__(self, ui: UISettings, theme: ThemeManager) -> None:
        self._ui = ui
        self._theme = theme
        ui.themeChanged.connect(self.sync)
        ui.accentChanged.connect(self.sync)
        self.sync()

    def sync(self, *_args) -> None:
        mode = str(self._ui.get(K.THEME_MODE, "light"))
        if mode not in ("light", "dark"):
            mode = "light"
        self._theme.set_mode(mode)
        self._theme.set_token("accent", str(self._ui.get(K.ACCENT, "#0D9488")))


class TaskListPage(QWidget):
    """业务页面：自带主题 / 字号自愈，用来演示「不重启实时刷新」。"""

    def __init__(self, service: DemoTaskService, ui: UISettings,
                 theme: ThemeManager, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._service = service
        self._ui = ui
        self._theme = theme
        self.head = QLabel("任务", self)
        self.hint = QLabel("", self)
        self.list = QListWidget(self)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 20, 24, 20)
        layout.setSpacing(10)
        layout.addWidget(self.head)
        layout.addWidget(self.hint)
        layout.addWidget(self.list, 1)

        self._reload()
        # 业务自己订阅配置信号：不依赖窗口转发，控件级自愈
        ui.fontChanged.connect(self.reflow)
        theme.changed.connect(self.repaint_business_skin)
        self.reflow(ui.get_int(K.FONT_SIZE, 14))
        self.repaint_business_skin()

    def _reload(self) -> None:
        self.list.clear()
        for title, priority in self._service.load():
            item = QListWidgetItem(title)
            item.setData(Qt.UserRole, priority)
            self.list.addItem(item)

    def reflow(self, font_size: int) -> None:
        """字号变化 -> 业务侧重算行高（业务逻辑，不重启即时生效）。"""
        row_h = int(font_size) + 18
        for i in range(self.list.count()):
            self.list.item(i).setSizeHint(QSize(0, row_h))
        self.hint.setText(f"字号 {font_size}px / 行高 {row_h}px（业务侧实时重算）")

    def repaint_business_skin(self) -> None:
        """主题变化 -> 业务侧按语义 token 重新上色（业务自己的绘制逻辑）。"""
        t = self._theme
        self.list.setStyleSheet(
            "QListWidget { background: %s; border: 1px solid %s; border-radius: %s; }"
            % (t.t("layer", "#FFFFFF"), t.t("border", "#E4E7EA"), t.t("radius-md", "8px")))
        tone = {"高": t.t("danger"), "中": t.t("warm")}
        for i in range(self.list.count()):
            item = self.list.item(i)
            item.setForeground(QColor(tone.get(str(item.data(Qt.UserRole)),
                                               t.t("fg2", "#6B7280"))))


class MainWindow(FluentTemplateWindow):
    """业务外壳：只做接线与业务编排，零皮肤代码。"""

    # ---- 业务自定义信号（信号槽链接的信号系统：UI 事件 -> 业务事件再广播） ----
    commandPaletteOpened = Signal(str)
    configChanged = Signal(str, object)

    def __init__(self, service: Optional[DemoTaskService] = None,
                 parent: Optional[QWidget] = None,
                 settings: Optional[UISettings] = None,
                 theme: Optional[ThemeManager] = None) -> None:
        self._service = service or DemoTaskService()
        # 业务侧装配配置源：真实项目里这里就是 SettingsService 适配后的 UISettings
        self._settings = settings or UISettings.instance()
        super().__init__(parent, "知行 ZhiXing", signature="知行合一",
                         command_placeholder=" 搜索任务、笔记、命令… ",
                         settings=self._settings,
                         theme=theme,
                         nav_width=180, nav_collapsed_width=48)
        # 业务侧主题真源：把配置算成 token 推给框架
        self._theme_source = BusinessThemeSource(self._settings, self._theme)
        self._history: List[str] = []
        self._ui_state: Dict[str, object] = {"nav_expanded": True}
        self._build_pages()
        self._connect_framework_signals()
        self._connect_ui_settings()

    # ================= 装配 =================
    def _build_pages(self) -> None:
        self.task_page = TaskListPage(self._service, self._settings, self._theme)
        self.review_page = QLabel("回顾：尚未加载", self)
        self.settings_page = QLabel("设置：由业务页承载", self)
        self.add_page(self.task_page, "任务", key="tasks")
        self.add_page(self.review_page, "回顾", key="review")
        self.add_page(self.settings_page, "设置", key="settings", position="bottom")
        # 框架提供的标题栏扩展位：业务状态显示
        self.status = QLabel("就绪", self)
        self.status.setObjectName("BizStatus")
        self.add_title_tool(self.status)

    def _key_at(self, index: int) -> str:
        if not (0 <= index < len(self._pages)):
            return ""
        return self._pages[index].key or ""

    # ================= 框架信号 -> 业务函数（契约 §1/§2） =================
    def _connect_framework_signals(self) -> None:
        self.commandRequested.connect(self.open_command_palette)
        self.closeRequested.connect(self.on_close_requested)
        self.minimizeRequested.connect(self.on_minimize_requested)
        self.pageChangeRequested.connect(self.on_page_change_requested)
        self.pageChanged.connect(self.on_page_changed)
        self.navigationToggled.connect(self.on_navigation_toggled)

    def open_command_palette(self) -> None:
        """原本写在窗口里的业务函数，现在通过框架信号触发。"""
        self._history.append("command-palette")
        self.commandPaletteOpened.emit("⌘K")
        self.set_status("命令面板已唤起（业务逻辑）")

    def on_close_requested(self) -> None:
        """业务先落盘，再让框架执行默认关闭（也可 set_auto_close_on_request(False)
        改成最小化到托盘）。"""
        self._history.append("close")
        self.set_status("关闭前保存业务数据…")

    def on_minimize_requested(self) -> None:
        self._history.append("minimize")

    def on_page_change_requested(self, index: int) -> None:
        """进入闸门：框架只发信号，是否放行由业务决定。"""
        key = self._key_at(index)
        if key == "review" and not self._ui_state.get("review_unlocked"):
            self.set_auto_switch_on_request(False)
            self.set_status("回顾页需先解锁（业务拦截，不切页）")
            return
        self.set_auto_switch_on_request(True)
        self.set_status("准备进入 %s" % (key or index))

    def on_page_changed(self, index: int) -> None:
        """页面已切换 -> 业务懒加载（只在需要时查询数据）。"""
        key = self._key_at(index)
        if key == "review":
            self.review_page.setText("回顾：%d 条待回顾" % len(self._service.load()))
            self.set_status("回顾数据已就绪")
        else:
            self.set_status("已进入 %s" % (key or index))

    def on_navigation_toggled(self, expanded: bool) -> None:
        """纯 UI 状态 -> 业务持久化（框架不碰存储）。"""
        self._ui_state["nav_expanded"] = expanded

    def unlock_review(self, unlocked: bool = True) -> None:
        self._ui_state["review_unlocked"] = unlocked
        self.set_auto_switch_on_request(True)

    def set_status(self, text: str) -> None:
        self.status.setText(text)
        self.status.adjustSize()

    # ================= UI 配置信号 -> 业务刷新（契约 §7/§8） =================
    def _connect_ui_settings(self) -> None:
        ui = self._settings
        ui.changed.connect(self.on_ui_config_changed)      # 统一入口 -> 桥成业务事件
        ui.fontChanged.connect(self.on_font_changed)       # 字号 -> 业务行高
        ui.themePackChanged.connect(self.reload_business_data)  # 主题包 -> 重新查询

    def on_ui_config_changed(self, key: str, value: object) -> None:
        """把框架的配置信号桥接成业务事件，业务可再转发给其它子系统。"""
        self.configChanged.emit(key, value)

    def on_font_changed(self, size: int) -> None:
        self.task_page.reflow(size)
        self.set_status("字号 %dpx 已实时生效（未重启）" % size)

    def reload_business_data(self, pack: str = "") -> None:
        self.task_page._reload()
        self.task_page.repaint_business_skin()
        self.task_page.reflow(self._settings.get_int(K.FONT_SIZE, 14))
        self.set_status("主题包切换为 %s，业务数据已重载" % pack)


def main(argv: Optional[List[str]] = None) -> int:
    argv = list(sys.argv if argv is None else argv)
    app = QApplication.instance() or QApplication(argv)
    ui = UISettings()
    ui.set_persister(lambda key, value: None)   # 真实项目：接 SettingsService.set
    UISettings.install(ui)                      # 让所有打开的界面共用同一配置源
    window = MainWindow(settings=ui, theme=ThemeManager())
    window.resize(1180, 760)
    window.show()
    return app.exec()


def selftest() -> Dict[str, bool]:
    """无界面自检：验证框架信号真的接到了业务函数、配置真的能热刷新。"""
    app = QApplication.instance() or QApplication([])
    ui = UISettings()
    UISettings.install(ui)
    window = MainWindow(settings=ui, theme=ThemeManager())
    results: Dict[str, bool] = {}
    rows_before = window.task_page.list.item(0).sizeHint().height()
    style_before = window.task_page.list.styleSheet()

    # 1) 框架信号 -> 业务函数
    window.title_bar.command_button.click()
    results["commandRequested -> 业务函数"] = "command-palette" in window._history

    # 2) 业务闸门：拦截切页
    window.unlock_review(False)
    window._buttons[window.page_index("review")].click()
    results["业务闸门拦截"] = window.current_index() != window.page_index("review")

    # 3) 放行后：信号触发业务懒加载
    window.unlock_review(True)
    window._buttons[window.page_index("review")].click()
    results["放行后业务懒加载"] = window.current_index() == window.page_index("review") \
        and "条待回顾" in window.review_page.text()

    # 4) 字号变更 -> 业务行高实时重算（不重启）
    ui.set(K.FONT_SIZE, 18)
    results["字号变更实时广播"] = window.task_page.list.item(0).sizeHint().height() != rows_before

    # 5) 亮暗切换 -> token 变化 -> 业务皮肤实时刷新
    ui.set(K.THEME_MODE, "dark")
    results["亮暗切换实时刷新皮肤"] = (window._theme.mode == "dark"
                                       and window.task_page.list.styleSheet() != style_before)

    # 6) 关闭信号仍由业务先处理
    window.title_bar.close_button.click()
    results["closeRequested -> 业务函数"] = "close" in window._history

    # 7) 框架窗口是 QWidget，可直接被原有布局器接纳
    results["框架窗口继承 QWidget"] = isinstance(window, QWidget)
    window.deleteLater()
    app.processEvents()
    return results


def _run_selftest() -> int:
    results = selftest()
    for name, ok in results.items():
        print(("  [OK]   " if ok else "  [FAIL] ") + name)
    failed = [n for n, ok in results.items() if not ok]
    print("自检结果: %d/%d 通过" % (len(results) - len(failed), len(results)))
    return 1 if failed else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_run_selftest())
    sys.exit(main())
