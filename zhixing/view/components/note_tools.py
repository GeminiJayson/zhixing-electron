# -*- coding: utf-8 -*-
"""笔记工具对话框：版本历史（F2-9）与编辑器查找替换（F7-4）。"""
import difflib

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QTextCharFormat, QTextCursor
from PySide6.QtWidgets import (QDialog, QHBoxLayout, QListWidgetItem, QMessageBox, QVBoxLayout, QWidget)

from qfluent_core import ThemeManager as ThemeEngine
from ..ui import DialogType, UButton, UDialog
from zhixing.view.kit.fluent_compat import QLabel, QLineEdit, QTextEdit
from zhixing.view.kit.fluent_compat import InfoBar, InfoBarPosition
from zhixing.view.kit.fluent_compat import QListWidget


def _fg2() -> str:
    eng = ThemeEngine.instance()
    return eng.t("fg2", "#6B7280") if eng else "#6B7280"


def _accent_soft() -> str:
    eng = ThemeEngine.instance()
    return eng.t("accent_soft", "#D9F2EE") if eng else "#D9F2EE"


def _fmt(dt):
    if dt is None:
        return ""
    try:
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return ""


class NoteRevisionDialog(UDialog):
    """版本历史：列出快照，diff 预览 + 回滚二次确认（F2-9/W21）。"""

    def __init__(self, note_service, note_id, parent=None):
        super().__init__(title="版本历史", parent=parent,
                         dialog_type=DialogType.RESIZABLE, icon_name="action.refresh",
                         width=620, height=520)
        self.note_service = note_service
        self.note_id = note_id
        self._revs = []
        content = QWidget()
        lay = QVBoxLayout(content)
        lay.setContentsMargins(14, 14, 14, 14)
        lay.setSpacing(10)

        tip = QLabel("保留最近 20 版。回滚会先把当前内容另存一份，避免误操作。")
        tip.setStyleSheet(f"color: {_fg2()};")
        lay.addWidget(tip)

        self.list = QListWidget()
        self.list.currentRowChanged.connect(self._show_diff)
        lay.addWidget(self.list, 1)

        diff_lbl = QLabel("与当前内容的差异：")
        diff_lbl.setStyleSheet(f"color: {_fg2()};")
        lay.addWidget(diff_lbl)
        self.diff = QTextEdit()
        self.diff.setReadOnly(True)
        self.diff.setMinimumHeight(110)
        self.diff.setPlaceholderText("选择左侧某个版本查看 diff 预览")
        lay.addWidget(self.diff)

        btns = QHBoxLayout()
        self.restore_btn = UButton("回滚到此版本", tone="accent", kind="solid")
        self.restore_btn.clicked.connect(self._restore)
        close_btn = UButton("关闭", tone="default", kind="ghost")
        close_btn.clicked.connect(self.reject)
        btns.addWidget(self.restore_btn)
        btns.addStretch(1)
        btns.addWidget(close_btn)
        lay.addLayout(btns)
        self.setContentWidget(content)

        self._reload()

    def _reload(self):
        self.list.clear()
        self._revs = []
        try:
            revs = self.note_service.revisions(self.note_id)
        except Exception:
            revs = []
        if not revs:
            self.list.addItem(QListWidgetItem("（暂无历史版本）"))
            self.restore_btn.setEnabled(False)
            return
        for i, r in enumerate(revs):
            title = r.get("title") or "（无标题）"
            preview = (r.get("content_md") or "").replace("\n", " ")[:60]
            item = QListWidgetItem(f"{_fmt(r.get('created_at'))}  「{title}」  {preview}")
            item.setData(Qt.UserRole, i)
            self.list.addItem(item)
            self._revs.append(r)
        self.list.setCurrentRow(0)
        self._show_diff(0)

    def _current_note_content(self) -> str:
        try:
            n = self.note_service.get(self.note_id)
            return (n.content_md if n else "") or ""
        except Exception:
            return ""

    def _show_diff(self, row: int):
        if row < 0 or row >= len(self._revs):
            self.diff.clear()
            return
        old = self._revs[row].get("content_md") or ""
        new = self._current_note_content()
        eng = ThemeEngine.instance()
        add_c = eng.t("success", "#16A34A") if eng else "#16A34A"
        del_c = eng.t("danger", "#DC2626") if eng else "#DC2626"
        fg2 = _fg2()
        if old == new:
            self.diff.setPlainText("（该版本与当前内容一致）")
            return
        html = ['<pre style="font-family:monospace; font-size:12px;">']
        for line in difflib.unified_diff(
                old.splitlines(), new.splitlines(),
                fromfile="选中版本", tofile="当前内容", lineterm=""):
            if line.startswith("---") or line.startswith("+++"):
                html.append(f'<span style="color:{fg2};">{_html_escape(line)}</span>')
            elif line.startswith("@@"):
                html.append(f'<span style="color:{fg2};font-weight:600;">{_html_escape(line)}</span>')
            elif line.startswith("+"):
                html.append(f'<span style="color:{add_c};">{_html_escape(line)}</span>')
            elif line.startswith("-"):
                html.append(f'<span style="color:{del_c};">{_html_escape(line)}</span>')
            else:
                html.append(_html_escape(line))
        html.append("</pre>")
        self.diff.setHtml("".join(html))

    def _restore(self):
        row = self.list.currentRow()
        if row < 0 or row >= len(self._revs):
            return
        rev_id = self._revs[row].get("id")
        if rev_id is None:
            return
        # 回滚二次确认（W21）
        box = QMessageBox(self)
        box.setWindowTitle("回滚确认")
        box.setText("确定回滚到选中的历史版本吗？当前内容会先另存一份快照。")
        box.setStandardButtons(QMessageBox.Yes | QMessageBox.Cancel)
        box.button(QMessageBox.Yes).setText("回滚")
        box.button(QMessageBox.Cancel).setText("取消")
        if box.exec() != QMessageBox.Yes:
            return
        self.note_service.restore_revision(self.note_id, rev_id)
        self.accept()


def _html_escape(s: str) -> str:
    import html as _html
    return _html.escape(s)


class OrphanNotesDialog(UDialog):
    """孤儿笔记清单（F3-8）：既无出链也无入链的笔记，双击打开以建立连接。"""

    openNote = Signal(int)

    def __init__(self, note_service, parent=None):
        super().__init__(title="孤儿笔记", parent=parent,
                         dialog_type=DialogType.INPUT, icon_name="nav.notes",
                         width=440, height=400)
        content = QWidget()
        lay = QVBoxLayout(content)
        lay.setContentsMargins(14, 14, 14, 14)
        lay.setSpacing(10)
        tip = QLabel("这些笔记还没有被链接，双击打开并输入 [[ 建立连接。")
        tip.setStyleSheet(f"color: {_fg2()};")
        lay.addWidget(tip)
        self.list = QListWidget()
        self.list.itemDoubleClicked.connect(self._open)
        lay.addWidget(self.list, 1)
        self.setContentWidget(content)
        self._reload(note_service)

    def _reload(self, note_service):
        self.list.clear()
        try:
            orphans = note_service.orphans()
        except Exception:
            orphans = []
        if not orphans:
            self.list.addItem(QListWidgetItem("（没有孤儿笔记，所有笔记都已建立连接）"))
            return
        for n in orphans:
            item = QListWidgetItem(n.title or "（无标题）")
            item.setData(Qt.UserRole, n.id)
            self.list.addItem(item)

    def _open(self, item):
        nid = item.data(Qt.UserRole)
        if nid:
            self.openNote.emit(nid)
            self.accept()


class NoteFindReplaceDialog(UDialog):
    """编辑器内查找替换：循环查找下一处并替换 + 全部命中高亮（F7-4/W8）。"""

    def __init__(self, editor, parent=None):
        super().__init__(title="查找替换", parent=parent,
                         dialog_type=DialogType.INPUT, icon_name="action.search",
                         width=440, height=300)
        self.editor = editor   # QPlainTextEdit 或 QTextEdit
        content = QWidget()
        lay = QVBoxLayout(content)
        lay.setContentsMargins(14, 14, 14, 14)
        lay.setSpacing(8)

        self.find_edit = QLineEdit()
        self.find_edit.setPlaceholderText("查找…")
        self.replace_edit = QLineEdit()
        self.replace_edit.setPlaceholderText("替换为…")
        lay.addWidget(self.find_edit)
        lay.addWidget(self.replace_edit)

        self.find_edit.textChanged.connect(lambda _t: self._highlight_all())
        self.replace_edit.textChanged.connect(lambda _t: self._highlight_all())

        btns = QHBoxLayout()
        b_find = UButton("查找下一个", tone="default", kind="ghost")
        b_find.clicked.connect(self._find_next)
        b_replace = UButton("查找下一处并替换", tone="default", kind="ghost")
        b_replace.clicked.connect(self._replace)
        b_all = UButton("全部替换", tone="accent", kind="solid")
        b_all.clicked.connect(self._replace_all)
        for b in (b_find, b_replace, b_all):
            btns.addWidget(b)
        lay.addLayout(btns)
        self.setContentWidget(content)

        self._highlight_all()

    def _find_next(self):
        text = self.find_edit.text()
        if not text:
            return
        from PySide6.QtGui import QTextDocument
        if not self.editor.find(text, QTextDocument.FindFlags()):
            self.editor.moveCursor(QTextCursor.Start)
            self.editor.find(text, QTextDocument.FindFlags())
        self._highlight_all()

    def _replace(self):
        """查找下一处并替换（循环）：先确保命中选中，替换后继续定位下一处。"""
        text = self.find_edit.text()
        if not text:
            return
        cur = self.editor.textCursor()
        if cur.hasSelection() and cur.selectedText() == text:
            cur.insertText(self.replace_edit.text())
        self._find_next()

    def _replace_all(self):
        text = self.find_edit.text()
        repl = self.replace_edit.text()
        if not text:
            return
        count = 0
        from PySide6.QtGui import QTextDocument
        self.editor.moveCursor(QTextCursor.Start)
        while self.editor.find(text, QTextDocument.FindFlags()):
            self.editor.textCursor().insertText(repl)
            count += 1
        self._highlight_all()
        self._toast(f"已替换 {count} 处")

    def _highlight_all(self):
        """把当前查找词的全部命中用 accent_soft 底色高亮。"""
        text = self.find_edit.text()
        try:
            if not text:
                self.editor.setExtraSelections([])
                return
            from PySide6.QtGui import QTextDocument
            doc = self.editor.document()
            sel_color = QColor(_accent_soft())
            fmt = QTextCharFormat()
            fmt.setBackground(sel_color)
            selections = []
            cursor = QTextCursor(doc)
            cursor.movePosition(QTextCursor.Start)
            while True:
                found = doc.find(text, cursor)
                if found.isNull():
                    break
                sel = self.editor.ExtraSelection()
                sel.cursor = found
                sel.format = fmt
                selections.append(sel)
            self.editor.setExtraSelections(selections)
        except Exception:
            pass

    def _toast(self, text):
        try:
            
            InfoBar.success("完成", text, duration=2000,
                            position=InfoBarPosition.BOTTOM, parent=self)
        except Exception:
            pass
