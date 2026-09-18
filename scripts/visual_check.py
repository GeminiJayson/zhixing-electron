# -*- coding: utf-8 -*-
"""离屏视觉验证：逐页截图到 /tmp/zhixing-shots/。"""
import os
import sys

if os.environ.get("ZHIXING_OFFSCREEN"):
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("ZHIXING_HOME", "/tmp/zhixing-visual")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PySide6.QtWidgets import QApplication  # noqa: E402
from PySide6.QtCore import QTimer  # noqa: E402

app = QApplication(sys.argv)

from zhixing.core.context import AppContext  # noqa: E402
from zhixing.view.kit.theme import ThemeEngine  # noqa: E402
from zhixing.controller.app_controller import AppController  # noqa: E402

ctx = AppContext()
theme = ThemeEngine()
ThemeEngine.instance = theme
ctx.theme_engine = theme
controller = AppController(ctx, theme)
ctx.seed_if_empty()
ctx.task_service.roll_recurring_today()
controller._refresh_everything()
controller.main.show()

os.makedirs("/tmp/zhixing-shots", exist_ok=True)

PAGES = [("today", controller.main.today_page), ("tasks", controller.main.task_page),
         ("inbox", controller.main.inbox_page), ("notes", controller.main.note_page),
         ("graph", controller.main.graph_page), ("review", controller.main.review_page),
         ("settings", controller.main.settings_page)]
STATE = {"i": 0}


def next_page():
    if STATE["i"] >= len(PAGES):
        # 深色主题再截两张
        controller._set_mode("dark")
        QTimer.singleShot(500, dark_shots)
        return
    name, page = PAGES[STATE["i"]]
    STATE["i"] += 1
    controller.main.switchTo(page)

    def save():
        controller.main.grab().save(f"/tmp/zhixing-shots/{STATE['i']}-{name}.png")
        print("shot", name)
        QTimer.singleShot(150, next_page)
    QTimer.singleShot(400, save)


def dark_shots():
    STATE2 = {"i": 0}
    pairs = [("dark-today", controller.main.today_page), ("dark-tasks", controller.main.task_page)]

    def step():
        if STATE2["i"] >= len(pairs):
            print("DONE")
            app.quit()
            return
        name, page = pairs[STATE2["i"]]
        STATE2["i"] += 1
        controller.main.switchTo(page)

        def save():
            controller.main.grab().save(f"/tmp/zhixing-shots/{name}.png")
            print("shot", name)
            QTimer.singleShot(150, step)
        QTimer.singleShot(400, save)
    step()


QTimer.singleShot(900, next_page)
app.exec()
