# -*- coding: utf-8 -*-
"""启动欢迎页（Splash）：无边框、居中、SVG 图标 + 线性进度条 + 300ms 淡出。

图标以「图谱网络节点连线」与「对勾」极简几何融合，寓意知识与行动的联动；
SVG 以字符串内嵌，经换色函数按主题色动态着色，再渲染为 QPixmap 显示。
"""
from PySide6.QtCore import Qt, QByteArray, QRectF, QEasingCurve, QPropertyAnimation
from PySide6.QtGui import QGuiApplication, QPainter, QPixmap, QFont
from PySide6.QtSvg import QSvgRenderer
from PySide6.QtWidgets import QVBoxLayout, QWidget

from qfluent_core import ThemeManager as ThemeEngine
from zhixing.view.kit.fluent_compat import QLabel, QProgressBar

# 应用图标（矢量）：三节点网络 + 中央对勾，{color} 占位符由换色函数注入主题色。
APP_ICON_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" '
    'stroke="{color}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">'
    '<circle cx="18" cy="17" r="6.2"/><circle cx="46" cy="17" r="6.2"/>'
    '<circle cx="32" cy="44" r="6.2"/>'
    '<path d="M23.6 18.6 40.4 18.6"/><path d="M18.4 23.2 27.4 38.4"/><path d="M45.6 23.2 36.6 38.4"/>'
    '<path d="M27.2 44.2l3.4 3.4 6.4-6.4"/></svg>'
)


def tint_svg(svg: str, color: str) -> str:
    """换色函数：把 SVG 源码中的 {color} 占位符替换为当前主题色。"""
    return svg.replace("{color}", color)


def render_svg_pixmap(svg: str, color: str, size: int) -> QPixmap:
    """把换色后的 SVG 渲染为 QPixmap（透明背景）。"""
    renderer = QSvgRenderer(QByteArray(tint_svg(svg, color).encode("utf-8")))
    pm = QPixmap(size, size)
    pm.fill(Qt.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.Antialiasing)
    renderer.render(p, QRectF(0, 0, size, size))
    p.end()
    return pm


class SplashScreen(QWidget):
    """无边框启动页：图标 / 名称+副标题 / 线性进度条，淡出后显示主窗口。"""

    def __init__(self):
        super().__init__(None, Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setFixedSize(400, 300)
        self._build()
        self._restyle()
        self._center()
        self._fade_anim = None

    def _build(self):
        lay = QVBoxLayout(self)
        lay.setContentsMargins(44, 44, 44, 44)
        lay.setSpacing(0)
        lay.setAlignment(Qt.AlignCenter)

        # 顶部图标
        self.icon_label = QLabel()
        self.icon_label.setAlignment(Qt.AlignCenter)
        self.icon_label.setFixedSize(72, 72)
        lay.addWidget(self.icon_label, 0, Qt.AlignHCenter)
        lay.addSpacing(22)

        # 名称（现代无衬线半粗体）
        self.title = QLabel("知行 ZhiXing")
        f = self.title.font()
        f.setPixelSize(27)
        f.setWeight(QFont.Weight.DemiBold)
        self.title.setFont(f)
        self.title.setAlignment(Qt.AlignCenter)
        lay.addWidget(self.title)
        lay.addSpacing(10)

        # 副标题（低对比度淡灰）
        self.sub = QLabel("本地优先的个人待办与知识图谱")
        self.sub.setAlignment(Qt.AlignCenter)
        lay.addWidget(self.sub)
        lay.addSpacing(32)

        # 线性进度条（3-4px 圆角，极简）
        self.progress = QProgressBar()
        self.progress.setTextVisible(False)
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        self.progress.setFixedHeight(4)
        lay.addWidget(self.progress)

        # 状态文案
        self.status = QLabel("正在启动…")
        self.status.setAlignment(Qt.AlignCenter)
        lay.addSpacing(12)
        lay.addWidget(self.status)

    def set_message(self, text: str):
        """更新加载状态文案。"""
        self.status.setText(text)

    def set_progress(self, value: int):
        """更新进度（0-100）。"""
        self.progress.setValue(max(0, min(100, value)))

    def fade_out(self, on_done=None, duration: int = 300):
        """300ms 淡出动画，结束后回调（关闭 + 显示主窗口）。"""
        self._fade_anim = QPropertyAnimation(self, b"windowOpacity", self)
        self._fade_anim.setDuration(duration)
        self._fade_anim.setStartValue(1.0)
        self._fade_anim.setEndValue(0.0)
        self._fade_anim.setEasingCurve(QEasingCurve.InOutQuad)
        if on_done is not None:
            self._fade_anim.finished.connect(on_done)
        self._fade_anim.start()

    def _center(self):
        screen = QGuiApplication.primaryScreen()
        if screen:
            geo = screen.availableGeometry()
            self.move(geo.center() - self.rect().center())

    def _restyle(self):
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        fg = t.get("fg", "#1A1A1A")
        fg2 = t.get("fg2", "#6B7280")
        accent = t.get("accent", "#0D9488")
        # 图标：SVG 换色后渲染
        self.icon_label.setPixmap(render_svg_pixmap(APP_ICON_SVG, accent, 72))
        self.title.setStyleSheet(f"QLabel {{ color: {fg}; background: transparent; }}")
        self.sub.setStyleSheet(f"QLabel {{ color: {fg2}; font-size: 13px; background: transparent; }}")
        self.status.setStyleSheet(f"QLabel {{ color: {fg2}; font-size:12px; background: transparent; }}")
        # 进度条：无边框，半透明淡色底，主题色滑块，两端圆角
        self.progress.setStyleSheet(
            f"QProgressBar {{ border: none; background: rgba(128,128,128,0.18);"
            f"border-radius: 2px; }}"
            f"QProgressBar::chunk {{ background: {accent}; border-radius: 2px; }}")
