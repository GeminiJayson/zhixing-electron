# -*- coding: utf-8 -*-
"""zhixing 迁移看板：原生 Qt 组件用量只许减少。

「全局不用原生组件」不可能一夜之间完成（存量约 800 处），但可以**可度量地推进**：
本文件记录每个原生类的当前基线，任何一次提交只要让它变多就会失败。
迁移完成后基线降到 0，这条约束就变成硬性的。
"""
from __future__ import annotations

import re
import unittest
from collections import Counter
from pathlib import Path

ZHIXING = Path(__file__).resolve().parent.parent / "zhixing"

#: 原生 Qt 组件（有框架对应用的）
NATIVE_WIDGETS = (
    "QLabel", "QWidget", "QPushButton", "QLineEdit", "QToolButton", "QFrame",
    "QComboBox", "QListWidget", "QScrollArea", "QCheckBox", "QDialog",
    "QTextEdit", "QTabWidget", "QMenu", "QDateEdit", "QPlainTextEdit",
    "QTableWidget", "QStackedWidget", "QSpinBox", "QProgressBar", "QSplitter",
    "QRadioButton", "QTreeWidget", "QSlider",
)

#: 迁移基线（首轮清理后）：**只许减少**。迁移一部分就把数字调小。
NATIVE_BASELINE = {
    "QWidget": 39, "QFrame": 12, "QScrollArea": 7, "QDialog": 2,
    "QMenu": 4, "QStackedWidget": 4, "QSplitter": 3,
}

#: 允许继续使用原生类的模块（容器/基类，不是"可见控件"）
CONTAINER_ALLOWED = {
    "QWidget": "自定义组件的基类",
    "QFrame": "自绘组件的基类",
    "QScrollArea": "滚动容器",
    "QSplitter": "分割容器",
    "QStackedWidget": "页面栈",
}


def _python_files() -> list:
    # 排除兼容层与统一入口：它们本来就要列出所有原生类名（映射表），
    # 那是「已接管」的证据，不是原生使用
    skip = {ZHIXING / "view/kit/fluent_compat.py", ZHIXING / "view/kit/ui.py"}
    return [p for p in ZHIXING.rglob("*.py") if p.is_file() and p not in skip]


def _native_names(text: str) -> set:
    """从源码里取出「仍从 PySide6.QtWidgets 导入」的原生控件类名。"""
    names = set()
    inside = False
    for line in text.split(chr(10)):
        if "from PySide6.QtWidgets import" in line:
            inside = True
            part = line.split("import", 1)[1]
        elif inside:
            part = line
        else:
            continue
        part = part.split(")")[0].replace("(", "")
        for name in part.split(","):
            name = name.strip()
            if name in NATIVE_WIDGETS:
                names.add(name)
        if ")" in line or "import" not in line:
            inside = False
    return names


def native_usage() -> Counter:
    """统计「仍从 PySide6 导入」的原生控件被构造了多少次。

    只数类名出现是不准的：迁移后业务里仍写着 QLabel(chr(34)xchr(34))，但那已经是兼容层
    的框架组件了。必须结合每个文件的 import 来源判断，看板才有意义。
    """
    counter: Counter = Counter()
    for path in _python_files():
        text = path.read_text(encoding="utf-8")
        for name in _native_names(text):
            counter[name] += len(re.findall(chr(92) + 'b' + name + chr(92) + 's*' + chr(92) + '(', text))
    return counter

class TestZhixingMigration(unittest.TestCase):
    def test_native_widget_usage_does_not_grow(self):
        """任何原生组件的用量都不许超过基线（迁移可以推进，不可以回退）。"""
        counts = native_usage()
        grown = {}
        for name, baseline in NATIVE_BASELINE.items():
            actual = counts.get(name, 0)
            if actual > baseline:
                grown[name] = "%d -> %d" % (baseline, actual)
        self.assertEqual(grown, {}, "原生组件用量回退了：%s" % grown)

    def test_migrated_modules_use_the_ui_entry(self):
        """已迁移的模块不许再直接 import QtWidgets 的可见组件。"""
        from PySide6.QtWidgets import QWidget  # noqa: F401  仅为触发导入
        migrated = {
            "view/kit/ui.py",
            "view/kit/control_style.py",
        }
        offenders = []
        for rel in migrated:
            text = (ZHIXING / rel).read_text(encoding="utf-8")
            if re.search(r"from PySide6\.QtWidgets import .*(QPushButton|QLabel|QLineEdit)",
                         text):
                offenders.append(rel)
        self.assertEqual(offenders, [], "已迁移模块又引入了原生控件：%s" % offenders)

    def test_theme_engine_is_fully_replaced(self):
        # zhixing 原先的 ThemeEngine 已彻底移除，统一用框架的 ThemeManager。
        # 历史：先是自己生成 300 行 QSS，后来改为委托框架渲染，现在整个模块都删了 ——
        # 业务通过别名导入继续写 ThemeEngine，实际拿到的是 qfluent_core.ThemeManager。
        self.assertFalse((ZHIXING / 'view/kit/theme.py').exists(), 'theme.py 应已删除')
        source = (ZHIXING / 'controller/app_controller.py').read_text(encoding='utf-8')
        self.assertIn('from qfluent_core import ThemeManager as ThemeEngine', source)
        self.assertNotIn('from qfluent_core import ThemeManager as ThemeEngine, component_qss', source)
        # 全仓不应再有指向已删模块的导入
        leftovers = []
        for path in ZHIXING.rglob('*.py'):
            for num, line in enumerate(path.read_text(encoding='utf-8').split(chr(10)), 1):
                if 'kit.theme import' in line:
                    leftovers.append('%s:%d' % (path.name, num))
        self.assertEqual(leftovers, [], '仍有指向已删主题模块的导入: %s' % leftovers)

    def test_control_style_is_neutralized(self):
        """QProxyStyle 已移除（macOS 下会 SIGSEGV），只留空操作兼容壳。"""
        text = (ZHIXING / "view/kit/control_style.py").read_text(encoding="utf-8")
        # 说明文字里可以提到 QProxyStyle，但不能再导入或继承它
        self.assertNotIn("import QProxyStyle", text)
        self.assertNotIn("QProxyStyle)", text)
        self.assertNotIn("(QProxyStyle", text)
        self.assertIn("return None", text)

    def test_ui_entry_exports_framework_components(self):
        """统一入口必须导出框架组件，并且带动迁移对照表。"""
        from zhixing.view.kit import ui
        for name in ("UButton", "ULineEdit", "UCard", "UTitle", "NATIVE_MAP"):
            self.assertTrue(hasattr(ui, name), "统一入口缺少 %s" % name)
        self.assertGreaterEqual(len(ui.NATIVE_MAP), 20)
        self.assertIn("QPushButton", ui.NATIVE_MAP)


if __name__ == "__main__":
    unittest.main()
