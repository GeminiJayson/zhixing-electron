# -*- coding: utf-8 -*-
"""Markdown 编辑器：语法高亮 + [[补全]] + 预览 + 1s 防抖自动保存信号。"""
import re
from typing import List, Optional

from PySide6.QtCore import Qt, QTimer, Signal, QUrl
from PySide6.QtGui import (
    QColor, QFont, QSyntaxHighlighter, QTextCharFormat, QTextCursor,
)
from PySide6.QtWidgets import (QHBoxLayout, QSplitter, QTextBrowser, QVBoxLayout, QWidget)

from ..kit import icons
from qfluent_core import ThemeManager as ThemeEngine
from zhixing.view.kit.fluent_compat import QLabel, QPlainTextEdit, QTextEdit
from zhixing.view.kit.fluent_compat import QToolButton


class _MdHighlighter(QSyntaxHighlighter):
    _FENCE = re.compile(r"^\s*(```|~~~)\s*([A-Za-z0-9_+\-]*)\s*$")

    def __init__(self, doc, tokens: dict):
        super().__init__(doc)
        self.t = tokens
        self._lang_ids = {}
        self._id_langs = {}

    def _fmt(self, color=None, bold=False, italic=False, strike=False, mono=False):
        f = QTextCharFormat()
        if color:
            f.setForeground(QColor(color))
        if bold:
            f.setFontWeight(QFont.Bold)
        if italic:
            f.setFontItalic(True)
        if strike:
            f.setFontStrikeOut(True)
        if mono:
            f.setFontFamilies(["Menlo", "Consolas", "Monaco", "monospace"])
        return f

    def _lang_id(self, lang: str) -> int:
        lang = (lang or "text").lower()
        if lang not in self._lang_ids:
            i = len(self._lang_ids) + 1
            self._lang_ids[lang] = i
            self._id_langs[i] = lang
        return self._lang_ids[lang]

    def _token_fmt(self, tok):
        from pygments.token import Token
        if tok in Token.Keyword:
            return self._fmt(self.t.get("accent"), bold=True)
        if tok in Token.String:
            return self._fmt(self.t.get("success", "#16A34A"))
        if tok in Token.Comment:
            return self._fmt(self.t.get("fg3", "#A8AEB6"), italic=True)
        if tok in Token.Number:
            return self._fmt(self.t.get("warm", "#EA580C"))
        if tok in Token.Name.Function or tok in Token.Name.Class:
            return self._fmt(self.t.get("accent_hover", self.t.get("accent")), bold=True)
        if tok in Token.Operator:
            return self._fmt(self.t.get("fg2", "#6B7280"))
        return self._fmt(self.t.get("fg", "#1A1A1A"), mono=True)

    def _highlight_code(self, text: str, lang: str):
        """fenced code 按语言 pygments 着色（F2-8/W9）。"""
        from pygments import lex
        from pygments.lexers import TextLexer, get_lexer_by_name
        try:
            lexer = get_lexer_by_name(lang)
        except Exception:
            lexer = TextLexer()
        self.setFormat(0, len(text), self._fmt(mono=True))
        try:
            pos = 0
            for tok, value in lex(text, lexer):
                if value:
                    self.setFormat(pos, len(value), self._token_fmt(tok))
                    pos += len(value)
        except Exception:
            pass

    def highlightBlock(self, text):  # noqa: N802
        prev = self.previousBlockState()
        m = self._FENCE.match(text)
        fence_fmt = self._fmt(self.t.get("warm"), bold=True, mono=True)
        if m and not prev:
            # 打开 fenced code
            self.setFormat(0, len(text), fence_fmt)
            self.setCurrentBlockState(self._lang_id(m.group(2)))
            return
        if prev:
            if m:
                # 关闭 fenced code
                self.setFormat(0, len(text), fence_fmt)
                self.setCurrentBlockState(0)
                return
            self._highlight_code(text, self._id_langs.get(prev, "text"))
            self.setCurrentBlockState(prev)
            return
        rules = [
            (re.compile(r"^#{1,6}\s.*$"), self._fmt(self.t.get("accent"), bold=True)),
            (re.compile(r"\*\*[^*\n]+\*\*"), self._fmt(bold=True)),
            (re.compile(r"(?<!\*)\*[^*\n]+\*(?!\*)"), self._fmt(italic=True)),
            (re.compile(r"~~[^~\n]+~~"), self._fmt(strike=True, color=self.t.get("fg2"))),
            (re.compile(r"`[^`\n]+`"), self._fmt(self.t.get("warm"))),
            (re.compile(r"^>.*$"), self._fmt(color=self.t.get("fg2"), italic=True)),
            (re.compile(r"\[\[[^\[\]\n]+\]\]"), self._fmt(self.t.get("accent"), bold=True)),
            (re.compile(r"^(\s*)[-*+] \[( |x|X)\] .*$"), self._fmt()),
        ]
        for pat, fmt in rules:
            for m in pat.finditer(text):
                self.setFormat(m.start(), m.end() - m.start(), fmt)


class WikiSuggestPopup(QWidget):
    """[[ 补全候选列表（自绘轻量浮层）。"""

    picked = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent, Qt.ToolTip | Qt.FramelessWindowHint)
        self.setFixedWidth(260)
        self._titles: List[str] = []

    def show_titles(self, titles: List[str]):
        from PySide6.QtWidgets import QVBoxLayout
        self._titles = titles
        lay = QVBoxLayout(self)
        lay.setContentsMargins(6, 6, 6, 6)
        lay.setSpacing(2)
        for w in self.findChildren(QLabel):
            w.deleteLater()
        if not titles:
            self.hide()
            return
        for t in titles[:8]:
            lbl = QLabel(t)
            lbl.setStyleSheet("padding: 4px 8px; border-radius: 6px;")
            lbl.mousePressEvent = lambda ev, title=t: self._pick(title)
            lay.addWidget(lbl)
        self.show()
        self.raise_()

    def _pick(self, title: str):
        self.hide()
        self.picked.emit(title)


class MarkdownEditor(QWidget):
    """编辑 + 预览双栏（可切单栏）。编辑器保存防抖 1s。"""

    saveRequested = Signal(str, str)        # (title占位, content_md)：title 不再按首行推导，恒为空串
    linkClicked = Signal(str)               # [[标题]]
    taskCreateRequested = Signal(str)       # 选中文本（W10：笔记转任务）
    taskCreateBlockRequested = Signal(str, str)  # v0.15 P0-1: (选中文本, block_key)

    def __init__(self, note_service=None, parent=None):
        super().__init__(parent)
        self.note_service = note_service
        self._last_titles: List[str] = []
        self._dirty = False
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)

        self.toolbar = QWidget()
        tb = QHBoxLayout(self.toolbar)
        tb.setContentsMargins(0, 0, 0, 0)
        tb.setSpacing(4)
        self._build_toolbar(tb)
        lay.addWidget(self.toolbar)

        self.splitter = QSplitter(Qt.Horizontal)
        lay.addWidget(self.splitter, 1)   # 编辑/预览区占满剩余高度

        self.editor = QPlainTextEdit()
        self.editor.setFrameShape(QPlainTextEdit.NoFrame)
        self.editor.setPlaceholderText("从这里开始记录… 输入 [[ 链接其他笔记")
        f = QFont()
        f.setPixelSize(14)
        self.editor.setFont(f)
        self.splitter.addWidget(self.editor)

        self.preview = QTextBrowser()
        self.preview.setFrameShape(QTextBrowser.NoFrame)
        self.preview.setOpenLinks(False)
        self.preview.anchorClicked.connect(self._on_anchor)
        self.splitter.addWidget(self.preview)
        self.splitter.setSizes([1, 1])
        self.set_preview_visible(False)

        eng = ThemeEngine.instance()
        tokens = eng.tokens if eng else {"accent": "#0D9488", "fg2": "#6B7280", "warm": "#EA580C"}
        self._hl = _MdHighlighter(self.editor.document(), tokens)

        self.popup = WikiSuggestPopup(self)
        self.popup.picked.connect(self._insert_wiki_title)

        self._save_timer = QTimer(self)
        self._save_timer.setSingleShot(True)
        self._save_timer.setInterval(1000)
        self._save_timer.timeout.connect(self._emit_save)
        self.editor.textChanged.connect(self._on_changed)
        self.editor.setContextMenuPolicy(Qt.CustomContextMenu)
        self.editor.customContextMenuRequested.connect(self._show_context_menu)

        self.preview.setStyleSheet(f"QTextBrowser {{ background: transparent; }}")

    # ---------- 公共 ----------
    def set_content(self, content: str):
        self.editor.blockSignals(True)
        self.editor.setPlainText(content or "")
        self.editor.blockSignals(False)
        self._dirty = False
        self._render_preview(content or "")

    def content(self) -> str:
        return self.editor.toPlainText()

    def _current_mode(self) -> str:
        pv = self.preview.isVisible()
        ev = self.editor.isVisible()
        if pv and not ev:
            return "preview"
        if pv and ev:
            return "split"
        return "edit"

    def set_mode(self, mode: str):
        """三态预览：edit=编辑源码 / split=双栏预览 / preview=只渲染预览。"""
        if mode == "edit":
            self.editor.setVisible(True)
            self.preview.setVisible(False)
        elif mode == "split":
            self.editor.setVisible(True)
            self.preview.setVisible(True)
            self._render_preview(self.editor.toPlainText())
        else:
            self.editor.setVisible(False)
            self.preview.setVisible(True)
            self._render_preview(self.editor.toPlainText())

    def cycle_mode(self):
        """循环切换 edit → split → preview → edit。"""
        self.set_mode({"edit": "split", "split": "preview", "preview": "edit"}[self._current_mode()])

    def set_preview_visible(self, visible: bool):
        """兼容旧接口：显示/隐藏双栏预览。"""
        self.set_mode("split" if visible else "edit")

    def is_preview_visible(self) -> bool:
        return self.preview.isVisible()

    def toggle_preview(self):
        self.cycle_mode()

    def set_preview_only(self, preview_only: bool):
        self.set_mode("preview" if preview_only else "edit")

    def is_preview_only(self) -> bool:
        return self.preview.isVisible() and not self.editor.isVisible()

    def set_readonly(self, ro: bool):
        self.editor.setReadOnly(ro)

    def is_dirty(self) -> bool:
        return self._dirty

    def commit(self):
        """切走前落盘未防抖完成的内容（若有）。"""
        self._save_timer.stop()
        if self._dirty:
            self._emit_save()

    def cancel_pending(self):
        self._save_timer.stop()
        self._dirty = False

    # ---------- 格式工具栏 ----------
    @staticmethod
    def make_toolbar_button(label: str, slot=None, tip: str = "") -> QToolButton:
        """工具栏按钮工厂：与格式按钮（B/I/H1…）完全同款。

        宿主注入的「保存/版本历史/查找替换」也用它创建，保证工具区样式统一
        （此前注入的是 UButton，圆角/内边距/高度都与左侧格式按钮不一致）。
        """
        b = QToolButton()
        b.setText(label)
        b.setToolTip(tip or label)
        b.setCursor(Qt.PointingHandCursor)
        b.setFixedHeight(28)   # 与格式按钮一致，各主题/字号下高度恒定
        if slot is not None:
            b.clicked.connect(slot)
        return b

    def _build_toolbar(self, tb: QHBoxLayout):
        def add(label: str, slot, tip: str = "") -> QToolButton:
            b = self.make_toolbar_button(label, slot, tip)
            tb.addWidget(b)
            return b

        add("B", self.insert_bold, "加粗")
        add("I", self.insert_italic, "斜体")
        tb.addSpacing(6)
        add("H1", lambda: self.insert_heading(1), "一级标题")
        add("H2", lambda: self.insert_heading(2), "二级标题")
        add("H3", lambda: self.insert_heading(3), "三级标题")
        tb.addSpacing(6)
        add("• 列表", self.insert_unordered_list, "无序列表")
        add("1. 列表", self.insert_ordered_list, "有序列表")
        tb.addSpacing(6)
        add("链接", self.insert_link, "插入链接")
        add("代码块", self.insert_code_block, "插入代码块")
        tb.addStretch(1)
        # 保存状态 + 宿主注入的动作（保存/版本历史/查找替换）都落在工具栏右端：
        # 原先它们在编辑器下方的独立工具行，占一整行高度且与工具栏功能重复。
        self.save_status = QLabel("")
        self.save_status.setStyleSheet("font-size:12px; background: transparent;")
        tb.addWidget(self.save_status)
        self._extra_slot = QHBoxLayout()
        self._extra_slot.setContentsMargins(0, 0, 0, 0)
        self._extra_slot.setSpacing(4)
        tb.addLayout(self._extra_slot)
        add("预览", self.toggle_preview, "切换 编辑 / 双栏预览 / 只预览")

    def add_toolbar_action(self, widget) -> None:
        """向工具栏右端注入动作控件（宿主用于放 保存/版本历史/查找替换）。"""
        self._extra_slot.addWidget(widget)

    def _wrap_selection(self, before: str, after: str, placeholder: str):
        """选中文本时前后包裹；无选中时插入占位语法并选中占位词。"""
        cur = self.editor.textCursor()
        if cur.hasSelection():
            text = cur.selectedText()
            cur.insertText(before + text + after)
        else:
            cur.insertText(before + placeholder + after)
            for _ in range(len(after)):
                cur.movePosition(QTextCursor.Left)
            for _ in range(len(placeholder)):
                cur.movePosition(QTextCursor.Left, QTextCursor.KeepAnchor)
            self.editor.setTextCursor(cur)
        self.editor.setFocus()

    def _prefix_block(self, prefix: str):
        """在光标所在块（行）开头插入前缀（标题/列表语法）。"""
        cur = self.editor.textCursor()
        cur.movePosition(QTextCursor.StartOfBlock)
        cur.insertText(prefix)
        self.editor.setFocus()

    def insert_bold(self):
        self._wrap_selection("**", "**", "加粗")

    def insert_italic(self):
        self._wrap_selection("*", "*", "斜体")

    def insert_heading(self, level: int = 1):
        self._prefix_block("#" * max(1, min(6, level)) + " ")

    def insert_unordered_list(self):
        self._prefix_block("- ")

    def insert_ordered_list(self):
        self._prefix_block("1. ")

    def insert_link(self):
        self._wrap_selection("[", "](url)", "文字")

    def insert_code_block(self):
        cur = self.editor.textCursor()
        if cur.hasSelection():
            text = cur.selectedText()
            cur.insertText("```\n" + text + "\n```")
        else:
            cur.insertText("```\n代码\n```")
            for _ in range(len("```")):
                cur.movePosition(QTextCursor.Left)
            for _ in range(len("代码")):
                cur.movePosition(QTextCursor.Left, QTextCursor.KeepAnchor)
            self.editor.setTextCursor(cur)
        self.editor.setFocus()

    # ---------- 内部 ----------
    def _on_changed(self):
        self._dirty = True
        self._save_timer.start()
        cur = self.editor.textCursor()
        block = cur.block().text()
        pos = cur.positionInBlock()
        if pos >= 2 and block[:pos].endswith("[["):
            self._maybe_complete(block[:pos])
        if "[[" in block and pos > 0:
            self._maybe_complete(block[:pos])
        self._render_preview(self.editor.toPlainText())

    def _maybe_complete(self, text_before: str):
        if not self.note_service:
            return
        prefix = text_before[text_before.rfind("[[") + 2:]
        if "]" in prefix or "\n" in prefix:
            self.popup.hide()
            return
        titles = [n.title for n in self.note_service.list(q=prefix)][:8]
        if not titles and not prefix:
            titles = [n.title for n in self.note_service.recent(8)]
        if titles:
            self._last_titles = titles
            geo = self.editor.cursorRect()
            top = self.editor.viewport().mapTo(self, geo.topLeft())
            self.popup.move(self.mapToGlobal(top + self.editor.cursorRect().topLeft() * 0)
                            if False else self.mapToGlobal(top))
            self.popup.show_titles(titles)
        else:
            self.popup.hide()

    def _insert_wiki_title(self, title: str):
        cur = self.editor.textCursor()
        block = cur.block().text()
        start = block.rfind("[[", 0, cur.positionInBlock())
        if start >= 0:
            cur.movePosition(QTextCursor.Left, QTextCursor.KeepAnchor,
                             cur.positionInBlock() - start)
            cur.removeSelectedText()
        cur.insertText(f"[[{title}]]")
        self.popup.hide()

    def _emit_save(self):
        self._dirty = False
        text = self.editor.toPlainText()
        # 需求④：不再按内容首行自动改写标题；标题由「新建/重命名笔记」弹窗的用户输入决定。
        # 这里仅外发正文，标题字段传空串，由 NotePage._auto_save 忽略（不覆盖已输入标题）。
        self.saveRequested.emit("", text)
        if self.note_service:
            self.note_service.save_pending_titles = self._last_titles

    def _render_preview(self, md: str):
        eng = ThemeEngine.instance()
        fg = eng.t("fg", "#1A1A1A") if eng else "#1A1A1A"
        fg2 = eng.t("fg2", "#6B7280") if eng else "#6B7280"
        accent = eng.t("accent", "#0D9488") if eng else "#0D9488"
        soft = eng.t("accent_soft", "#D9F2EE") if eng else "#D9F2EE"
        border = eng.t("border", "#E5E5E5") if eng else "#E5E5E5"
        import html as _html
        # 先摘出 [[wiki 标题]] 占位，交给 markdown 后再回填已转义 <a>：
        # 否则 markdown 会先把标题里的 & < > 转义，导致标题二次转义或 `**加粗**` 被误渲染。
        wiki_tokens: dict = {}

        def _wiki_token(m):
            title = m.group(1).strip()
            key = f"\uE000WIKI{len(wiki_tokens)}\uE001"
            wiki_tokens[key] = title
            return key

        md = re.sub(r"\[\[([^\[\]\n]+?)\]\]", _wiki_token, md or "")
        try:
            import markdown as md_lib
            html = md_lib.markdown(
                md, extensions=["fenced_code", "tables", "codehilite", "nl2br"],
                extension_configs={"codehilite": {"guess_lang": False, "noclasses": True}})
        except Exception:
            html = f"<pre>{md}</pre>"

        pending_titles = set()

        def _wiki_repl(m):
            title = wiki_tokens[m.group(0)]
            safe = _html.escape(title)
            nid = self.note_service.resolve(title) if self.note_service else None
            if nid:
                return f'<a href="wiki:{safe}">{safe}</a>'
            pending_titles.add(title)
            return (f'<a href="wiki:{safe}" style="color:{fg2};'
                    f'text-decoration:none;">{safe}</a>')

        if wiki_tokens:
            html = re.sub("|".join(map(re.escape, wiki_tokens)), _wiki_repl, html)
        self.preview.setHtml(
            f"<style>body{{color:{fg};font-size:14px;line-height:1.65;}} "
            f"a{{color:{accent};text-decoration:none;}} "
            f"code{{background:{soft};padding:1px 5px;border-radius:4px;}} "
            f"pre{{background:{soft};padding:10px;border-radius:8px;}} "
            f"blockquote{{border-left:3px solid {border};margin-left:0;padding-left:12px;"
            f"color:{fg2};}} h1,h2,h3{{line-height:1.3;}} table{{border-collapse:collapse;}} "
            f"td,th{{border:1px solid {border};padding:4px 8px;}}</style>" + html)
        self._style_pending_links(pending_titles, fg2)

    def _style_pending_links(self, pending_titles, fg2: str):
        """待建链接虚线态：QTextDocument 不支持 border-bottom 虚线，改用 DashUnderline 字符格式。"""
        if not pending_titles:
            return
        doc = self.preview.document()
        cur = QTextCursor(doc)
        cur.movePosition(QTextCursor.Start)
        try:
            while not cur.atEnd():
                cur.movePosition(QTextCursor.NextCharacter, QTextCursor.KeepAnchor)
                href = cur.charFormat().anchorHref()
                if href.startswith("wiki:"):
                    title = QUrl.fromPercentEncoding(href[5:].encode("utf-8"))
                    if title in pending_titles:
                        fmt = QTextCharFormat()
                        fmt.setUnderlineStyle(QTextCharFormat.UnderlineStyle.DashUnderline)
                        fmt.setUnderlineColor(QColor(fg2))
                        cur.mergeCharFormat(fmt)
        finally:
            cur.clearSelection()

    def _on_anchor(self, url: QUrl):
        s = url.toString()
        if s.startswith("wiki:"):
            # QUrl 会把引号等字符百分号编码，这里还原成原始标题再解析。
            title = QUrl.fromPercentEncoding(s[5:].encode("utf-8"))
            self.linkClicked.emit(title)

    def _show_context_menu(self, pos):
        """右键菜单：追加「转为任务」（F4-2/W10）。"""
        from PySide6.QtWidgets import QMenu
        menu = self.editor.createStandardContextMenu()
        sel = self.editor.textCursor().selectedText()
        if sel.strip():
            act = menu.addAction("转为任务")
            act.triggered.connect(lambda _=False, s=sel: self.taskCreateRequested.emit(s))
            # v0.15 P0-1: 同时提供「定位键」（snippet 首行指纹），任务落库后可跳回本段
            act2 = menu.addAction("转为任务并关联段落")
            first_line = sel.split("\n")[0]
            act2.triggered.connect(
                lambda _=False, s=sel, fl=first_line:
                self.taskCreateBlockRequested.emit(s, self._block_fingerprint(fl)))
        menu.exec(self.editor.viewport().mapToGlobal(pos))

    # ---------- v0.15 P0-1: 段落指纹与定位 ----------
    @staticmethod
    def _block_fingerprint(text: str, length: int = 12) -> str:
        """把一段文本归一化为定位键（sha1 前缀）：段落内容微调会失效，重定位时回退纯文本搜。"""
        import hashlib
        norm = re.sub(r"\s+", " ", (text or "")).strip().lower()
        if not norm:
            return ""
        return "fp:" + hashlib.sha1(norm.encode("utf-8")).hexdigest()[:length]

    def _jump_editor_to_text(self, needle: str) -> bool:
        """在编辑器中定位含 needle 的段落并滚动到可见（不修改内容）。"""
        if not needle:
            return False
        doc = self.editor.document()
        norm_needle = re.sub(r"\s+", " ", needle).strip()
        block = doc.findBlock(0)
        while block.isValid():
            if norm_needle and re.sub(r"\s+", " ", block.text()).find(norm_needle[:40]) >= 0:
                cur = QTextCursor(block)
                self.editor.setTextCursor(cur)
                self.editor.centerCursor()
                # 高亮 1.2s：匹配到的文本段淡出
                self.editor.setFocus()
                self._flash_block(cur, norm_needle[:40])
                return True
            block = block.next()
        return False

    def _flash_block(self, cur: "QTextCursor", needle: str):
        """临时高亮目标段落（ExtraSelection 背景），约 1.4s 后自动清除。"""
        from PySide6.QtGui import QTextCharFormat, QTextCursor
        c = QTextCursor(cur)
        # 先定位段落首行全文（needle 可能截断），高亮整段
        block = c.block()
        hit_start = block.position()
        hit_end = block.position() + max(0, len(block.text()))
        cur2 = QTextCursor(c.document())
        cur2.setPosition(hit_start)
        cur2.setPosition(hit_end, QTextCursor.KeepAnchor)
        if cur2.isNull():
            return
        sel = self.editor.extraSelections()
        
        es = QTextEdit.ExtraSelection()
        fmt = QTextCharFormat()
        eng = ThemeEngine.instance()
        color = eng.t("accent_soft", "#D9F2EE") if eng else "#D9F2EE"
        fmt.setBackground(QColor(color))
        es.format = fmt
        es.cursor = cur2
        sel.append(es)
        self.editor.setExtraSelections(sel)
        QTimer.singleShot(1400, lambda: self.editor.setExtraSelections([]))

    def locate_block(self, block_key: str) -> bool:
        """按 block_key（fp:xxxx）或纯文本回退定位并高亮段落；找不到返回 False。"""
        if not block_key:
            return False
        # 内容未变 → 指纹匹配（全文各段指纹）
        doc = self.editor.document()
        prefix = block_key.replace("fp:", "", 1).lower()
        block = doc.findBlock(0)
        while block.isValid():
            txt = re.sub(r"\s+", " ", block.text()).strip().lower()
            import hashlib
            if txt and prefix and hashlib.sha1(txt.encode("utf-8")).hexdigest().startswith(prefix):
                cur = QTextCursor(block)
                self.editor.setTextCursor(cur)
                self.editor.centerCursor()
                self.editor.setFocus()
                self._flash_block(cur, block.text())
                return True
            block = block.next()
        return False
