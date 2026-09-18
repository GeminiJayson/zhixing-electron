# -*- coding: utf-8 -*-
"""入口：High-DPI、单实例锁、主题先于建窗、异常兜底。"""
import os
import sys


def main():
    # Windows windowed 冻结：sys.stdout/sys.stderr 为 None，任何 print/traceback
    # 都会静默丢弃。先重定向到数据目录 logs/stdout.log、stderr.log，
    # 让早期错误（含 QApplication 创建失败）与 setup_logging 都有真实 sink 可用。
    from zhixing.model.infrastructure.db import data_dir
    from zhixing.core.logging_util import ensure_std_streams
    ensure_std_streams(data_dir() / "logs")

    # 静默 Qt 内部噪音（QtCharts accessibility 表格越界等），不刷屏
    os.environ.setdefault(
        "QT_LOGGING_RULES",
        "qt.accessibility.table.warning=false;qt.accessibility.table.debug=false")

    from PySide6.QtCore import Qt, QCoreApplication, QLockFile
    from PySide6.QtWidgets import QApplication, QMessageBox
    from PySide6.QtGui import QFont

    app = QApplication(sys.argv)
    try:
        app.setStyle("Fusion")  # 让自定义 palette/QSS 生效（否则 macOS 原生样式用系统高亮黑）
    except Exception:
        pass
    app.setApplicationName("知行 ZhiXing")
    app.setOrganizationName("ZhiXing")
    app.setApplicationDisplayName("知行 ZhiXing")

    # 单实例锁：锁失败（已在运行）时把深链转发给主实例后退出
    from PySide6.QtCore import QDir
    from PySide6.QtNetwork import QLocalSocket
    from zhixing.core.deep_link import extract_argv
    deep_url = extract_argv(sys.argv)
    lock = QLockFile(QDir.tempPath() + "/zhixing.lock")
    lock.setStaleLockTime(0)
    if not lock.tryLock(100):
        if deep_url:
            try:
                from zhixing.controller.app_controller import AppController
                sock = QLocalSocket()
                sock.connectToServer(AppController._ipc_server_name())
                if sock.waitForConnected(300):
                    sock.write(f"deep-link:{deep_url}".encode("utf-8"))
                    sock.waitForBytesWritten(300)
            except Exception:
                pass
        QMessageBox.information(None, "知行", "「知行」已经在运行了（查看系统托盘）。")
        return 0

    # 统一日志（先于 Model/异常兜底）：数据目录 logs/zhixing.log
    from zhixing.core.logging_util import setup_logging, install_excepthooks
    setup_logging(data_dir())
    install_excepthooks()

    # High-DPI
    try:
        app.setHighDpiScaleFactorRoundingPolicy(
            Qt.HighDpiScaleFactorRoundingPolicy.PassThrough)
    except AttributeError:
        pass

    # 默认字体（平台相关中文栈，避免 macOS 缺 Segoe UI 等告警）
    if sys.platform == "darwin":
        families = ["PingFang SC", "Helvetica Neue", "Arial Unicode MS"]
    elif sys.platform == "win32":
        families = ["Segoe UI", "Microsoft YaHei", "SimHei"]
    else:
        families = ["Noto Sans CJK SC", "WenQuanYi Micro Hei", "Sans Serif"]
    f = QFont()
    f.setFamilies(families)
    f.setPixelSize(13)
    app.setFont(f)
    # 字体族由 app.setFont() 统一控制（上面已设），第三方 UI 库的字体栈已随其退场。

    # 装配：主题引擎（轻量，先建供 splash 着色）→ 欢迎页 → 数据 → 控制器 → 初始化
    from zhixing.core.context import AppContext
    from zhixing.core.errors import ZhiXingError
    from qfluent_core import ThemeManager as ThemeEngine
    from zhixing.controller.app_controller import AppController
    from zhixing.view.shell.splash import SplashScreen

    theme = ThemeEngine()
    ThemeEngine.install(theme)   # 装成进程级单例，供各处 ThemeEngine.instance() 取用

    # 启动欢迎页：所有初始化在此阶段完成，主窗口打开即完全可操作
    splash = SplashScreen()
    splash.show()
    app.processEvents()

    # 应用图标：SVG 换色渲染（与启动页同源矢量图标）
    from zhixing.view.shell.splash import APP_ICON_SVG, render_svg_pixmap
    from PySide6.QtGui import QIcon
    app.setWindowIcon(QIcon(render_svg_pixmap(APP_ICON_SVG, theme.accent or "#0D9488", 128)))

    splash.set_progress(10)
    try:
        ctx = AppContext()
        ctx.theme_engine = theme
    except ZhiXingError as e:
        splash.close()
        QMessageBox.critical(None, "知行", f"{e.message}\n{e.hint}")
        return 1
    splash.set_message("加载数据…")
    splash.set_progress(35)
    app.processEvents()

    controller = AppController(ctx, theme)
    if deep_url:
        controller._pending_deep_links.append(deep_url)   # v0.15 P1-4: 启动时 argv 深链
    splash.set_message("构建界面…")
    splash.set_progress(60)
    app.processEvents()
    app.aboutToQuit.connect(controller.shutdown)

    # 初始化全部数据（seed/循环重置/各页刷新），但不显示主窗口
    controller.startup(show=False)
    splash.set_message("启动完成")
    splash.set_progress(100)

    # 关键：强制处理 pending 的 layout/paint/timer 事件，让今日待办树展开、
    # 图表渲染、图表生长动画等全部在欢迎页阶段完成，主窗口显示后无需再排队
    # 渲染（消除「打开主页面后今日待办还在加载/界面卡顿」）。
    from PySide6.QtCore import QEventLoop
    for _ in range(10):
        app.processEvents(QEventLoop.AllEvents)

    # 完成：300ms 淡出后关闭欢迎页并显示主窗口（打开即可操作）
    splash.fade_out(lambda: (splash.close(), controller.show_main()))

    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
