# -*- coding: utf-8 -*-
"""富文本编辑器：QTextEdit + 顶部格式工具栏 + 1s 防抖自动保存。

- 工具栏用 QTextCursor / QTextCharFormat / QTextBlockFormat / QTextListFormat 实现，
  不加粗体/斜体/下划线、H1-H3、无序/有序列表、左/中/右对齐。
- 内容以 HTML 片段在外部读写（content_md 字段承载），提供 set_html/to_html。
- 自动保存沿用「停止输入 1s 防抖」，经 saveRequested(title, html) 外发。
"""
from pathlib import Path

from PySide6.QtCore import QBuffer, QByteArray, QIODevice, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import (
    QColor, QDesktopServices, QFont, QImage, QPixmap, QTextBlockFormat,
    QTextCharFormat, QTextCursor, QTextImageFormat, QTextListFormat,
)
from PySide6.QtWidgets import (QApplication, QColorDialog, QDialog, QFileDialog, QHBoxLayout, QVBoxLayout, QWidget)

from qfluent_core import ThemeManager as ThemeEngine
from zhixing.view.kit.fluent_compat import QComboBox, QLabel, QTextEdit
from zhixing.view.kit.fluent_compat import QToolButton

_MAX_IMG_W = 800  # 贴图/插图的最大宽度，超出等比缩放，避免撑爆编辑器


def _image_to_data_uri(img: QImage) -> str:
    """把 QImage 转成 PNG base64 data URI，内嵌进 HTML，随笔记一起保存/导出。"""
    if img.width() > _MAX_IMG_W:
        img = img.scaledToWidth(_MAX_IMG_W, Qt.SmoothTransformation)
    ba = QByteArray()
    buf = QBuffer(ba)
    buf.open(QIODevice.WriteOnly)
    img.save(buf, "PNG")
    buf.close()
    return "data:image/png;base64," + bytes(ba.toBase64()).decode("ascii")


class _ImageTextEdit(QTextEdit):
    """支持粘贴/插入图片（缩略图显示）+ 附件链接的富文本编辑框。"""

    imagePreviewRequested = Signal(str)   # 单击图片缩略图 → 预览（data URI 或文件路径）

    def canInsertFromMimeData(self, source):
        return bool(source.hasImage()) or super().canInsertFromMimeData(source)

    def insertFromMimeData(self, source):
        img = self._extract_image(source)
        if img is not None:
            self.insert_image(img)
            return
        super().insertFromMimeData(source)

    @staticmethod
    def _extract_image(source):
        if not source.hasImage():
            return None
        try:
            v = source.imageData()
            img = v.value() if hasattr(v, "value") else v
            return img if isinstance(img, QImage) and not img.isNull() else None
        except Exception:
            return None

    def insert_image(self, img: QImage):
        """插入图片：缩略图显示（width=200），单击可预览原图。"""
        uri = _image_to_data_uri(img)
        cur = self.textCursor()
        cur.insertHtml(f'<img src="{uri}" width="200" />')
        self.setTextCursor(cur)
        self.setFocus()

    def insert_file(self, path: str):
        """插入文件附件：图标 + 标题链接，双击打开。"""
        name = Path(path).name
        url = QUrl.fromLocalFile(path).toString()
        # T4: SVG 图标渲染为 PNG data URI 内嵌（随笔记 HTML 持久化），不再用 📄 emoji
        from ..kit import icons
        from qfluent_core import ThemeManager as ThemeEngine
        eng = ThemeEngine.instance()
        fg2 = eng.t("fg2", "#6B7280") if eng else "#6B7280"
        icon_uri = icons.data_uri("action.attach", fg2, 14)
        cur = self.textCursor()
        cur.insertHtml(f'<img src="{icon_uri}" width="14" height="14" '
                       f'style="vertical-align:middle;margin-right:3px">'
                       f'<a href="{url}">{name}</a> ')
        self.setTextCursor(cur)
        self.setFocus()

    def mousePressEvent(self, ev):
        if ev.button() == Qt.LeftButton:
            # Ctrl+单击链接 → 系统浏览器/打开文件（避免误触，普通点击不改光标）
            if ev.modifiers() & Qt.ControlModifier:
                anchor = self.anchorAt(ev.position().toPoint())
                if anchor:
                    QDesktopServices.openUrl(QUrl(anchor))
                    ev.accept()
                    return
            # 单击图片缩略图 → 预览
            cur = self.cursorForPosition(ev.position().toPoint())
            fmt = cur.charFormat()
            if fmt.isImageFormat():
                img_fmt = fmt.toImageFormat()
                if img_fmt.isValid():
                    self.imagePreviewRequested.emit(img_fmt.name())
                    ev.accept()
                    return
        super().mousePressEvent(ev)

    def mouseDoubleClickEvent(self, ev):
        # 双击附件链接 → 打开文件
        anchor = self.anchorAt(ev.position().toPoint())
        if anchor:
            QDesktopServices.openUrl(QUrl(anchor))
            ev.accept()
            return
        super().mouseDoubleClickEvent(ev)


class RichTextEditor(QWidget):
    """所见即所得富文本编辑器，接口对齐 MarkdownEditor（saveRequested / set_content / content）。"""

    saveRequested = Signal(str, str)        # title(首行纯文本), html 片段
    taskCreateRequested = Signal(str)        # 选中文本（W10：笔记转任务）

    def __init__(self, note_service=None, parent=None):
        super().__init__(parent)
        self.note_service = note_service
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

        self.edit = _ImageTextEdit()
        self.edit.setFrameShape(QTextEdit.NoFrame)
        self.edit.setPlaceholderText("从这里开始记录富文本…")
        f = QFont()
        f.setPixelSize(14)
        self.edit.setFont(f)
        lay.addWidget(self.edit, 1)

        self._save_timer = QTimer(self)
        self._save_timer.setSingleShot(True)
        self._save_timer.setInterval(1000)
        self._save_timer.timeout.connect(self._emit_save)
        self.edit.textChanged.connect(self._on_changed)
        self.edit.imagePreviewRequested.connect(self._preview_image)
        self.edit.setContextMenuPolicy(Qt.CustomContextMenu)
        self.edit.customContextMenuRequested.connect(self._show_context_menu)

        self._restyle()
        ThemeEngine.instance() and ThemeEngine.instance().changed.connect(self._restyle)

    # ---------- 工具栏 ----------
    def _build_toolbar(self, tb: QHBoxLayout):
        def add(label: str, slot, tip: str = "") -> QToolButton:
            b = QToolButton()
            b.setText(label)
            b.setToolTip(tip or label)
            b.setCursor(Qt.PointingHandCursor)
            b.clicked.connect(slot)
            tb.addWidget(b)
            return b

        add("B", self.toggle_bold, "加粗")
        add("I", self.toggle_italic, "斜体")
        add("U", self.toggle_underline, "下划线")
        tb.addSpacing(6)
        add("H1", lambda: self.set_heading(1), "一级标题")
        add("H2", lambda: self.set_heading(2), "二级标题")
        add("H3", lambda: self.set_heading(3), "三级标题")
        tb.addSpacing(6)
        add("• 列表", lambda: self.toggle_list(False), "无序列表")
        add("1. 列表", lambda: self.toggle_list(True), "有序列表")
        tb.addSpacing(6)
        add("左", lambda: self.set_alignment(Qt.AlignLeft), "左对齐")
        add("中", lambda: self.set_alignment(Qt.AlignCenter), "居中")
        add("右", lambda: self.set_alignment(Qt.AlignRight), "右对齐")
        tb.addSpacing(6)
        add("链接", self.insert_link, "插入超链接（Ctrl+单击打开）")
        add("图片", self.insert_image_file, "插入图片")
        add("文件", self.insert_file, "插入文件附件")
        tb.addSpacing(6)
        self.font_size_combo = QComboBox()
        self.font_size_combo.setEditable(False)
        for sz in (12, 14, 16, 18, 20, 24, 28):
            self.font_size_combo.addItem(str(sz), sz)
        self.font_size_combo.setCurrentText("16")
        self.font_size_combo.currentIndexChanged.connect(
            lambda _i: self.set_font_size(self.font_size_combo.currentData()))
        self.font_size_combo.setToolTip("字号")
        tb.addWidget(self.font_size_combo)
        add("颜色", self.set_text_color, "文字颜色")
        tb.addStretch(1)

    # ---------- 格式操作 ----------
    def toggle_bold(self):
        cur = self.edit.textCursor()
        fmt = QTextCharFormat()
        cur_fmt = cur.charFormat()
        bold = cur_fmt.fontWeight() == QFont.Bold
        fmt.setFontWeight(QFont.Normal if bold else QFont.Bold)
        cur.mergeCharFormat(fmt)
        self.edit.mergeCurrentCharFormat(fmt)
        self.edit.setFocus()

    def toggle_italic(self):
        cur = self.edit.textCursor()
        fmt = QTextCharFormat()
        fmt.setFontItalic(not cur.charFormat().fontItalic())
        cur.mergeCharFormat(fmt)
        self.edit.mergeCurrentCharFormat(fmt)
        self.edit.setFocus()

    def toggle_underline(self):
        cur = self.edit.textCursor()
        fmt = QTextCharFormat()
        fmt.setFontUnderline(not cur.charFormat().fontUnderline())
        cur.mergeCharFormat(fmt)
        self.edit.mergeCurrentCharFormat(fmt)
        self.edit.setFocus()

    def set_heading(self, level: int):
        cur = self.edit.textCursor()
        bf = QTextBlockFormat()
        bf.setHeadingLevel(max(1, min(6, level)))
        cur.mergeBlockFormat(bf)
        self.edit.setFocus()

    def toggle_list(self, ordered: bool = False):
        cur = self.edit.textCursor()
        style = QTextListFormat.ListDecimal if ordered else QTextListFormat.ListDisc
        lst = cur.currentList()
        if lst is not None and lst.format().style() == style:
            # 已在同型列表 → 退出列表（把选区内的块移出）
            for blk in self._blocks_in_selection(cur):
                lst.remove(blk)
        else:
            lf = QTextListFormat()
            lf.setStyle(style)
            cur.createList(lf)
        self.edit.setFocus()

    def set_alignment(self, alignment):
        cur = self.edit.textCursor()
        bf = QTextBlockFormat()
        bf.setAlignment(alignment)
        cur.mergeBlockFormat(bf)
        self.edit.setFocus()

    def insert_image_file(self):
        """从文件选择图片并插入到光标处（内嵌 base64）。"""
        path, _ = QFileDialog.getOpenFileName(
            self, "插入图片", "", "图片 (*.png *.jpg *.jpeg *.gif *.bmp *.webp)")
        if not path:
            return
        img = QImage(path)
        if img.isNull():
            return
        self.edit.insert_image(img)

    def insert_file(self):
        """插入文件附件（图标 + 标题，双击打开）。"""
        path, _ = QFileDialog.getOpenFileName(self, "插入文件", "", "所有文件 (*)")
        if not path:
            return
        self.edit.insert_file(path)

    def insert_link(self):
        """插入超链接：先填网址，再填显示文本（可空，默认显示网址本身）。

        插入后 Ctrl+单击即可在系统浏览器打开（见 _ImageTextEdit.mousePressEvent）。
        """
        from ..ui import UInputDialog
        url, ok = UInputDialog.get_text(
            self, "插入链接", label="网址：", placeholder="https://… 或本地文件路径")
        if not ok or not url.strip():
            return
        url = url.strip()
        if not (url.startswith("http://") or url.startswith("https://")
                or url.startswith("file://")):
            url = "https://" + url
        text, ok2 = UInputDialog.get_text(
            self, "插入链接", label="显示文字：", text=url,
            placeholder="留空则显示网址本身")
        if not ok2:
            return
        display = text.strip() or url
        cur = self.edit.textCursor()
        cur.insertHtml(f'<a href="{url}">{display}</a>')
        self.edit.setTextCursor(cur)
        self.edit.setFocus()
        self._on_changed()

    def _preview_image(self, data_uri: str):
        """弹出图片预览对话框（缩放显示原图）。"""
        img = QImage()
        if data_uri.startswith("data:image"):
            import base64
            try:
                payload = data_uri.split(",", 1)[1]
                img.loadFromData(base64.b64decode(payload))
            except Exception:
                img = QImage()
        elif Path(data_uri).exists():
            img = QImage(data_uri)
        if img.isNull():
            return
        dlg = QDialog(self)
        dlg.setWindowTitle("图片预览")
        dlg.setModal(True)
        lay = QVBoxLayout(dlg)
        lbl = QLabel()
        lbl.setAlignment(Qt.AlignCenter)
        screen = QApplication.primaryScreen().availableGeometry()
        scaled = img.scaled(int(screen.width() * 0.7), int(screen.height() * 0.7),
                            Qt.KeepAspectRatio, Qt.SmoothTransformation)
        lbl.setPixmap(QPixmap.fromImage(scaled))
        lay.addWidget(lbl)
        dlg.resize(scaled.width() + 20, scaled.height() + 20)
        dlg.exec()
        dlg.deleteLater()

    def set_font_size(self, size: int):
        """设置选区字号（pt）。"""
        cur = self.edit.textCursor()
        fmt = QTextCharFormat()
        fmt.setFontPointSize(float(size))
        cur.mergeCharFormat(fmt)
        self.edit.mergeCurrentCharFormat(fmt)
        self.edit.setFocus()

    def set_text_color(self):
        """设置选区文字颜色。"""
        cur = self.edit.textCursor()
        init = cur.charFormat().foreground().color()
        color = QColorDialog.getColor(init, self, "文字颜色")
        if not color.isValid():
            return
        fmt = QTextCharFormat()
        fmt.setForeground(color)
        cur.mergeCharFormat(fmt)
        self.edit.mergeCurrentCharFormat(fmt)
        self.edit.setFocus()

    @staticmethod
    def _blocks_in_selection(cur: QTextCursor):
        doc = cur.document()
        start, end = cur.selectionStart(), cur.selectionEnd()
        blk = doc.findBlock(start)
        out = []
        while blk.isValid() and blk.position() <= end:
            out.append(blk)
            blk = blk.next()
        return out

    # ---------- 公共接口 ----------
    def set_html(self, html: str):
        self.edit.blockSignals(True)
        self.edit.setHtml(html or "")
        self.edit.blockSignals(False)
        self._dirty = False

    def to_html(self) -> str:
        return self.edit.toHtml()

    def set_content(self, content: str):
        """兼容 MarkdownEditor 的 set_content：入参为 HTML。"""
        self.set_html(content)

    def content(self) -> str:
        return self.to_html()

    def set_readonly(self, ro: bool):
        self.edit.setReadOnly(ro)

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

    # ---------- 自动保存 ----------
    def _on_changed(self):
        self._dirty = True
        self._save_timer.start()

    def _emit_save(self):
        self._dirty = False
        html = self.edit.toHtml()
        self.saveRequested.emit(self._derive_title(), html)

    def _show_context_menu(self, pos):
        """右键菜单：追加「转为任务」（F4-2/W10）。"""
        from PySide6.QtWidgets import QMenu
        menu = self.edit.createStandardContextMenu()
        sel = self.edit.textCursor().selectedText()
        if sel.strip():
            act = menu.addAction("转为任务")
            act.triggered.connect(lambda _=False, s=sel: self.taskCreateRequested.emit(s))
        menu.exec(self.edit.viewport().mapToGlobal(pos))

    def _derive_title(self) -> str:
        text = (self.edit.toPlainText() or "").strip()
        if not text:
            return "无标题"
        return text.split("\n")[0].strip()[:60] or "无标题"

    # ---------- 主题 ----------
    def _restyle(self):
        eng = ThemeEngine.instance()
        if not eng:
            return
        fg = eng.t("fg", "#1A1A1A")
        fg2 = eng.t("fg2", "#6B7280")
        hover = eng.t("hover", "#F5F5F5")
        border = eng.t("border", "#E4EDE8")
        accent = eng.t("accent", "#0D9488")
        self.setStyleSheet(
            f"QToolButton {{ background: {hover}; color: {fg}; border: 1px solid {border};"
            f"border-radius: 6px; padding: 3px 8px; }}"
            f"QToolButton:hover {{ background: {hover}; border-color: {accent}; color: {accent}; }}"
            f"QToolButton:pressed {{ background: {hover}; }}"
            f"QTextEdit {{ background: transparent; color: {fg}; border: none; }}")
