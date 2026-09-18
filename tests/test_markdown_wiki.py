# -*- coding: utf-8 -*-
"""Markdown 编辑器 [[wiki]] 渲染回归：标题 HTML 只转义一次、待建链接虚线态。"""
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


def _mk_app():
    from PySide6.QtWidgets import QApplication
    from qfluent_core import ThemeManager as ThemeEngine
    app = QApplication.instance() or QApplication([])
    inst = getattr(ThemeEngine, "instance", None)
    if not isinstance(inst, ThemeEngine):
        eng = ThemeEngine()
        eng.apply("青竹", "light", "#0D9488")
        ThemeEngine.install(eng)   # 装成单例（原为属性赋值）
    return app


class TestMarkdownWikiRender(unittest.TestCase):
    def setUp(self):
        _mk_app()
        from zhixing.view.components.markdown_editor import MarkdownEditor
        self.editor = MarkdownEditor(note_service=None)

    def tearDown(self):
        self.editor.deleteLater()

    def test_title_escaped_once(self):
        self.editor.set_content("[[a & b]]")
        html = self.editor.preview.toHtml()
        self.assertIn("a &amp; b", html)
        self.assertNotIn("&amp;amp;", html, "标题内的 & 不应被二次转义")

    def test_pending_link_renders_dashed(self):
        from PySide6.QtGui import QTextCharFormat, QTextCursor
        self.editor.set_content("[[待建标题]]")
        html = self.editor.preview.toHtml()
        self.assertIn("待建标题", html)
        cur = QTextCursor(self.editor.preview.document())
        cur.movePosition(QTextCursor.Start)
        style = None
        while not cur.atEnd():
            cur.movePosition(QTextCursor.NextCharacter, QTextCursor.KeepAnchor)
            if cur.charFormat().anchorHref() == "wiki:待建标题":
                style = cur.charFormat().underlineStyle()
                break
        self.assertEqual(style, QTextCharFormat.UnderlineStyle.DashUnderline,
                         "待建链接应以 DashUnderline 虚线态呈现")


if __name__ == "__main__":
    unittest.main(verbosity=2)
