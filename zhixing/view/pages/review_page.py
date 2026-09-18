# -*- coding: utf-8 -*-
"""回顾页：周趋势折线、番茄钟柱状、标签环形（QtCharts）+ 完成热力图（自绘）。"""
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QPainter
from PySide6.QtWidgets import (QFrame, QGridLayout, QHBoxLayout, QSizePolicy, QVBoxLayout, QWidget)

from ..components.general import EmptyState, IconWidget, SectionHeader
from ..kit import motion
from ..kit.flow_layout import FlowLayout
from qfluent_core import ThemeManager as ThemeEngine
from ..ui import UCard, UTitle, PageHeader
from zhixing.view.kit.fluent_compat import QLabel

try:
    from PySide6.QtCharts import (
        QChart, QChartView, QLineSeries, QBarSeries, QBarSet, QPieSeries,
        QDateTimeAxis, QValueAxis, QBarCategoryAxis,
    )
    HAS_CHARTS = True
except ImportError:  # QtCharts 可能未随安装
    HAS_CHARTS = False


class ReviewPage(QWidget):
    def __init__(self, review_service, settings, parent=None):
        super().__init__(parent)
        self.review_service = review_service
        self.settings = settings
        self._build()
        self._restyle()
        ThemeEngine.instance() and ThemeEngine.instance().changed.connect(self._restyle)

    def _build(self):
        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 18, 28, 18)
        lay.setSpacing(12)
        self.header = PageHeader("回顾", "查看完成趋势、番茄钟专注与热力图")
        lay.addWidget(self.header)

        streak_row = QHBoxLayout()
        streak_row.setSpacing(6)
        self.streak_icon = IconWidget("task.flag", 16, None)
        streak_row.addWidget(self.streak_icon)
        self.streak_label = UTitle("连续完成 0 天", role="sub")
        streak_row.addWidget(self.streak_label)
        streak_row.addStretch(1)
        lay.addLayout(streak_row)

        # 热力图卡片：先创建，图表可用时与「标签分布」同排显示
        self.heat_card = UCard("完成热力（近 12 周）")
        hh = QWidget()
        hh_lay = QVBoxLayout(hh)
        hh_lay.setContentsMargins(0, 0, 0, 0)
        self.heatmap = HeatmapWidget()
        self.heatmap.setMinimumHeight(110)
        self.heatmap.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        hh_lay.addWidget(self.heatmap, 1)
        self.heat_card.add_widget(hh, 1)

        if HAS_CHARTS:
            charts = QGridLayout()
            charts.setSpacing(10)
            self.line_view = QChartView()
            self.bar_view = QChartView()
            self.pie_view = QChartView()
            self._chart_views = [self.line_view, self.bar_view, self.pie_view]
            for v in (self.line_view, self.bar_view, self.pie_view):
                v.setRenderHint(QPainter.Antialiasing)
                # 图表随 card 缩放：最小高度需容纳 X/Y 轴标签与图例，
                # 过低会把绘图区压扁并把轴标签压成省略号。
                v.setMinimumHeight(200)
                v.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
                v.setStyleSheet("QChartView { background: transparent; border: none; }")
            charts.addWidget(self._titled(self.line_view, "本周完成任务趋势"), 0, 0)
            charts.addWidget(self._titled(self.bar_view, "番茄钟专注时长（分钟）"), 0, 1)
            charts.addWidget(self._titled(self.pie_view, "标签分布"), 1, 0)
            charts.addWidget(self.heat_card, 1, 1)
            charts.setColumnStretch(0, 1)
            charts.setColumnStretch(1, 1)
            charts.setRowStretch(0, 1)
            charts.setRowStretch(1, 1)
            lay.addLayout(charts, 1)
        else:
            hint = QLabel("（QtCharts 不可用，已降级为表格视图）")
            lay.addWidget(hint)
            self.table_lay = QVBoxLayout()
            lay.addLayout(self.table_lay, 1)
            lay.addWidget(self.heat_card)

        self.achieve_card = UCard("成就")
        ah = QWidget()
        # 成就块用 FlowLayout 流式排列（自动换行），替代纵向列表
        self.achieve_body = FlowLayout(ah, margin=4, hspacing=10, vspacing=10)
        self.achieve_card.add_widget(ah, 1)
        lay.addWidget(self.achieve_card)

        self.empty_state = EmptyState("nav.review", "暂无回顾数据，完成任务后这里会出现趋势", "", self)
        self.empty_state.setVisible(False)
        lay.addWidget(self.empty_state, 1)

    def _titled(self, w, text):
        """图表栏 = 沉浸 UCard(text)，图本体直接铺体内；不另加边框/嵌套。"""
        card = UCard(text)
        # 高度方向可扩展：卡片随行拉伸，避免被 QGridLayout 压到最小高度
        card.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        card.add_widget(w, 1)
        return card

    def reload(self):
        if self.review_service is None:
            self.streak_label.setText("连续完成 0 天")
            self.empty_state.setVisible(True)
            for v in getattr(self, "_chart_views", []):
                v.setVisible(False)
            return
        stats = self.review_service.week_stats()
        dist = self.review_service.tag_distribution()
        streak = self.review_service.streak_days()
        self.streak_label.setText(f"连续完成 {streak} 天")
        accent = ThemeEngine.instance().t("accent", "#0D9488") if ThemeEngine.instance() else "#0D9488"
        warm = ThemeEngine.instance().t("warm", "#EA580C") if ThemeEngine.instance() else "#EA580C"
        if HAS_CHARTS:
            # 折线
            line = QLineSeries()
            for i, v in enumerate(stats["completed"]):
                line.append(i, v)
            line.setName("完成")
            chart = QChart()
            chart.addSeries(line)
            chart.legend().hide()
            axis_x = QBarCategoryAxis()
            axis_x.append(stats["labels"])
            chart.setAxisX(axis_x, line)
            axis_y = QValueAxis()
            axis_y.setTickCount(5)
            chart.setAxisY(axis_y, line)
            _style_chart(chart)
            self.line_view.setChart(chart)
            # 柱状
            bar_set = QBarSet("番茄分钟")
            bar_set.setColor(QColor(warm))
            bar_set.append(stats["pomodoro"])
            bar_series = QBarSeries()
            bar_series.append(bar_set)
            bchart = QChart()
            bchart.addSeries(bar_series)
            bchart.legend().hide()
            baxis_x = QBarCategoryAxis()
            baxis_x.append(stats["labels"])
            bchart.setAxisX(baxis_x, bar_series)
            # 显式 Y 轴：否则 QChart 自动创建时不为数值标签留足空间，标签会被裁剪
            baxis_y = QValueAxis()
            baxis_y.setRange(0, max(max(stats["pomodoro"], default=0), 5))
            baxis_y.setTickCount(5)
            baxis_y.applyNiceNumbers()
            bchart.setAxisY(baxis_y, bar_series)
            _style_chart(bchart)
            self.bar_view.setChart(bchart)
            # 环形
            pie = QPieSeries()
            for name, color, count in dist:
                sl = pie.append(f"#{name}", count)
                sl.setBrush(QColor(color))
                sl.setLabelVisible(False)
            pchart = QChart()
            pchart.addSeries(pie)
            pchart.legend().setVisible(True)
            _style_chart(pchart)
            self.pie_view.setChart(pchart)
            self._animate_growth(line, bar_set, pie, stats["completed"], stats["pomodoro"], dist)
        else:
            _fill_table(self, stats)
        has_data = bool(any(stats["completed"]) or any(stats["pomodoro"]) or any(stats["notes"]) or dist)
        self.empty_state.setVisible(not has_data)
        for v in getattr(self, "_chart_views", []):
            v.setVisible(has_data)
        self.heatmap.set_grid(self.review_service.heatmap(12))
        self._reload_achievements()

    def _animate_growth(self, line, bar_set, pie, line_final, bar_final, pie_final):
        """图表「生长」进场动画（9d）：数值从 0 生长到终值，终值不变。"""
        if not motion.motion_enabled():
            return
        from PySide6.QtCore import QTimer
        steps = 12
        holder = {"i": 0}

        def update(v):
            try:
                for i, val in enumerate(line_final):
                    line.replace(i, i, val * v)
                bar_set.remove(0, bar_set.count())
                bar_set.append([val * v for val in bar_final])
                slices = pie.slices()
                for j, (_n, _c, cnt) in enumerate(pie_final):
                    if j < len(slices):
                        slices[j].setValue(cnt * v)
            except Exception:
                pass

        def tick():
            holder["i"] += 1
            update(holder["i"] / steps)
            if holder["i"] >= steps:
                update(1.0)
                timer.stop()

        timer = QTimer(self)
        timer.setInterval(max(1, int(motion.DURATION.get("normal", 250) / steps)))
        timer.timeout.connect(tick)
        self._growth_timers = getattr(self, "_growth_timers", [])
        self._growth_timers.append(timer)
        timer.start()

    def _reload_achievements(self):
        """成就/连续打卡（F6-4）：SVG 图标卡片块，FlowLayout 流式排列，未解锁灰显。"""
        while self.achieve_body.count():
            item = self.achieve_body.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()
        try:
            items = self.review_service.achievements()
        except Exception:
            items = []
        icon_map = {
            "初试锋芒": "achieve.first", "持之以恒": "achieve.streak",
            "三十而立": "achieve.month", "任务收割机": "achieve.harvest",
            "笔耕不辍": "achieve.pen", "织网者": "achieve.web",
        }
        for a in items:
            tile = AchievementTile(
                icon_map.get(a["name"], "achieve.first"),
                a["name"], a["desc"], bool(a["unlocked"]))
            self.achieve_body.addWidget(tile)

    def _restyle(self):
        eng = ThemeEngine.instance()
        if eng:
            self.setStyleSheet("QLabel { background: transparent; }")
            for view in getattr(self, "_chart_views", []):
                eh = getattr(view, "chart", None)
                ch = eh() if callable(eh) else None
                if ch is not None:
                    _style_chart(ch)


def _style_chart(chart):
    """让 QtCharts 背景/轴/图例随主题（QSS 管不到 QChart 渲染）。

    ⑥ 图表背景改为透明（由 UCard 面底承载），并内收 6px 边距，避免 QChart
    以直角不透明底色绘制到卡片圆角之外造成「图表溢出 card」。
    """
    from PySide6.QtCore import QMargins
    from PySide6.QtGui import QColor
    eng = ThemeEngine.instance()
    if eng:
        from PySide6.QtCharts import QChart
        is_dark = getattr(eng, "mode", "light") == "dark"
        chart.setTheme(QChart.ChartThemeDark if is_dark else QChart.ChartThemeLight)
        chart.setBackgroundVisible(False)
        chart.setPlotAreaBackgroundVisible(False)
        chart.setBackgroundRoundness(0)
        # 底部多留边距：X 轴日期标签不贴卡片底边，图表（表单）底部与 card 保持间距
        chart.setMargins(QMargins(6, 6, 6, 14))
        fg = eng.t("fg", "#1A1A1A")
        fg2 = eng.t("fg2", "#6B7280")
        grid = eng.t("border", "#E4EDE8")
        chart.setTitleBrush(QColor(fg))
        for ax in chart.axes():
            ax.setLabelsColor(QColor(fg2))
            ax.setGridLineColor(QColor(grid))
        try:
            chart.legend().setLabelColor(QColor(fg))
        except Exception:
            pass


def _fill_table(page, stats):
    from PySide6.QtWidgets import QVBoxLayout
    for child in list(page.findChildren(QLabel)):
        if child.objectName() == "statline":
            child.deleteLater()
    lbl = QLabel(" | ".join(
        f"{d}: 完成{c} 专注{p}分 笔记{n}"
        for d, c, p, n in zip(stats["labels"], stats["completed"],
                              stats["pomodoro"], stats["notes"])))
    lbl.setObjectName("statline")
    lbl.setWordWrap(True)
    page.layout().insertWidget(3, lbl)


class AchievementTile(QFrame):
    """成就卡片块：SVG 图标 + 名称 + 描述 + 达成状态，供 FlowLayout 流式排列。"""

    def __init__(self, icon_name: str, name: str, desc: str, unlocked: bool, parent=None):
        super().__init__(parent)
        self.icon_name = icon_name
        self._name = name
        self._desc = desc
        self._unlocked = bool(unlocked)
        self.setObjectName("achieve_tile")
        self.setFixedWidth(168)
        self._build()
        self._restyle()
        ThemeEngine.instance() and ThemeEngine.instance().changed.connect(self._restyle)

    def _build(self):
        lay = QVBoxLayout(self)
        lay.setContentsMargins(12, 14, 12, 12)
        lay.setSpacing(6)
        self.icon = IconWidget(self.icon_name, 26, None)
        lay.addWidget(self.icon, 0, Qt.AlignHCenter)
        self.name_lbl = QLabel(self._name)
        self.name_lbl.setAlignment(Qt.AlignCenter)
        lay.addWidget(self.name_lbl)
        self.desc_lbl = QLabel(self._desc)
        self.desc_lbl.setAlignment(Qt.AlignCenter)
        self.desc_lbl.setWordWrap(True)
        lay.addWidget(self.desc_lbl)
        self.badge = QLabel("已达成" if self._unlocked else "未达成")
        self.badge.setAlignment(Qt.AlignCenter)
        lay.addWidget(self.badge)

    def _restyle(self):
        eng = ThemeEngine.instance()
        accent = eng.t("accent", "#0D9488") if eng else "#0D9488"
        fg2 = eng.t("fg2", "#6B7280") if eng else "#6B7280"
        border = eng.t("border", "#E5E5E5") if eng else "#E5E5E5"
        hover = eng.t("hover", "#F5F5F5") if eng else "#F5F5F5"
        color = accent if self._unlocked else fg2
        self.icon.set_color(color)
        self.name_lbl.setStyleSheet(
            f"color: {color}; font-weight: 600; background: transparent;")
        self.desc_lbl.setStyleSheet(f"color: {fg2}; font-size:12px; background: transparent;")
        self.badge.setStyleSheet(
            f"color: {color}; background: transparent; font-size:12px;"
            f"border: 1px solid {color}; border-radius: 8px; padding: 2px 0;")
        self.setStyleSheet(
            f"QFrame#achieve_tile {{ background: {hover}; border: 1px solid {border};"
            f"border-radius: 10px; }}")


class HeatmapWidget(QWidget):
    """GitHub 风格完成热力图：[weeks][7]，-1=未来日期。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.grid = []

    def set_grid(self, grid):
        self.grid = grid
        self.update()

    def paintEvent(self, ev):  # noqa: N802
        if not self.grid:
            return
        eng = ThemeEngine.instance()
        accent = QColor(eng.t("accent", "#0D9488") if eng else "#0D9488")
        base = QColor(eng.t("hover", "#F0F0F0") if eng else "#F0F0F0")
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        cols = len(self.grid)
        rows = 7
        gap = max(2, min(5, self.height() // 36))
        # 底部留白：热力图（表单）底部与卡片底边保持间距
        bottom_pad = 12
        # 横向平铺卡片：格子宽度按可用宽度均匀分布（不再居中留白），纵向按剩余高度铺开
        cell_w = max(6, (self.width() - (cols - 1) * gap) // cols)
        cell_h = max(6, (self.height() - bottom_pad - (rows - 1) * gap) // rows)
        max_v = max((max(col) for col in self.grid if col), default=1) or 1
        rad = max(2, min(cell_w, cell_h) // 4)
        for w, col in enumerate(self.grid):
            for d, v in enumerate(col):
                if v < 0:
                    continue
                r = accent.redF() * (v / max_v) + base.redF() * (1 - v / max_v)
                g = accent.greenF() * (v / max_v) + base.greenF() * (1 - v / max_v)
                b = accent.blueF() * (v / max_v) + base.blueF() * (1 - v / max_v)
                p.setBrush(QColor(int(r * 255), int(g * 255), int(b * 255)))
                p.setPen(Qt.NoPen)
                p.drawRoundedRect(w * (cell_w + gap), d * (cell_h + gap), cell_w, cell_h, rad, rad)
        p.end()
