# -*- coding: utf-8 -*-
"""笔记类型只读预览：Word(.docx)、Excel(.xlsx)、链接（本地文件/网页）。

设计：
- 第三方库（python-docx / openpyxl）只做解析，产出 HTML 交给 QTextBrowser 只读渲染，
  不引入可编辑组件，视图随 ThemeEngine.changed 自愈（订阅 engine.changed 重建 QSS）。
- 链接笔记：content_md 存网页 URL 或本地文件路径；一键打开走 QDesktopServices，
  本地文本文件内嵌预览，网页与二进制文件仅展示目标与打开入口（不发起网络请求）。
"""
from __future__ import annotations

import html as _html
import json
from pathlib import Path
from typing import List, Optional, Tuple

from PySide6.QtCore import Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (QFrame, QHBoxLayout, QScrollArea, QTableWidgetItem, QTextBrowser, QVBoxLayout, QWidget)

from qfluent_core import ThemeManager as ThemeEngine
from ..ui import UButton
from zhixing.view.kit.fluent_compat import QLabel, QTextEdit
from zhixing.view.kit.fluent_compat import QTableWidget
from zhixing.view.kit.fluent_compat import QToolButton


def _escape(text: str) -> str:
    return _html.escape(str(text if text is not None else ""))


def _theme_css() -> str:
    """预览 HTML 的随主题样式：颜色全部来自语义 token。"""
    eng = ThemeEngine.instance()
    fg = eng.t("fg", "#1A1A1A") if eng else "#1A1A1A"
    fg2 = eng.t("fg2", "#6B7280") if eng else "#6B7280"
    border = eng.t("border", "#E4EDE8") if eng else "#E4EDE8"
    accent = eng.t("accent", "#0D9488") if eng else "#0D9488"
    soft = eng.t("accent_soft", "#D9F2EE") if eng else "#D9F2EE"
    return (
        f"body{{color:{fg};font-size:14px;line-height:1.6;}}"
        f"h1,h2,h3{{color:{accent};}}"
        f"table{{border-collapse:collapse;width:100%;}}"
        f"td,th{{border:1px solid {border};padding:4px 8px;}}"
        f"th{{background:{soft};color:{fg};}}"
        f"a{{color:{accent};text-decoration:none;}}"
        f"code{{background:{soft};padding:1px 5px;border-radius:4px;}}"
        f"p{{margin:0 0 8px 0;}}"
    )


def parse_docx_to_html(path: str) -> str:
    """把 .docx 解析为 HTML 片段（段落 + 表格），仅只读展示。"""
    path = (path or "").strip()
    if not path or not Path(path).exists():
        return ""
    try:
        from docx import Document
        doc = Document(path)
    except Exception:
        return ""
    parts = []
    try:
        for p in doc.paragraphs:
            text = (p.text or "").strip()
            if text:
                parts.append(f"<p>{_escape(text)}</p>")
        for table in doc.tables:
            rows = []
            for row in table.rows:
                cells = "".join(f"<td>{_escape(cell.text)}</td>" for cell in row.cells)
                rows.append(f"<tr>{cells}</tr>")
            parts.append(f"<table>{''.join(rows)}</table>")
    except Exception:
        pass
    return "".join(parts)


def parse_xlsx_to_html(path: str, max_rows: int = 500, max_cols: int = 60) -> str:
    """把 .xlsx 首个工作表解析为 HTML 表格，仅只读展示。"""
    path = (path or "").strip()
    if not path or not Path(path).exists():
        return ""
    try:
        from openpyxl import load_workbook
        wb = load_workbook(path, read_only=True, data_only=True)
    except Exception:
        return ""
    try:
        ws = wb.active
        rows = []
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i >= max_rows:
                break
            cells = "".join(
                f"<td>{_escape('' if v is None else str(v))}</td>"
                for v in (row[:max_cols] if row else ())
            )
            rows.append(f"<tr>{cells}</tr>")
        wb.close()
        return f"<table>{''.join(rows)}</table>" if rows else ""
    except Exception:
        try:
            wb.close()
        except Exception:
            pass
        return ""


def classify_target(target: str) -> Tuple[str, str]:
    """链接目标分类：返回 ("web"|"local", 规范化目标)。"""
    t = (target or "").strip()
    low = t.lower()
    if low.startswith(("http://", "https://", "www.")):
        return "web", t
    return "local", t


def preview_text_file(path: str, max_chars: int = 20000) -> str:
    """读取本地文本文件用于内嵌预览；二进制或不可读返回空串。"""
    p = Path((path or "").strip())
    if not p.is_file():
        return ""
    try:
        data = p.read_bytes()
    except OSError:
        return ""
    if b"\x00" in data[:4096]:
        return ""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        try:
            text = data.decode("gbk", errors="ignore")
        except Exception:
            text = data.decode("utf-8", errors="ignore")
    return text[:max_chars]


class _HtmlPreviewView(QWidget):
    """只读 HTML 预览基类：QTextBrowser + 主题自愈。"""

    def __init__(self, parent: Optional[QWidget] = None):
        super().__init__(parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)
        self.browser = QTextBrowser()
        self.browser.setOpenLinks(False)
        self.browser.setOpenExternalLinks(False)
        self.browser.setReadOnly(True)
        self.browser.setFrameShape(QTextBrowser.NoFrame)
        lay.addWidget(self.browser, 1)
        self._restyle()
        eng = ThemeEngine.instance()
        if eng is not None:
            try:
                eng.changed.connect(self._restyle)
            except Exception:
                pass

    def _set_html_body(self, body: str, empty_hint: str = ""):
        if body:
            self.browser.setHtml(f"<style>{_theme_css()}</style>{body}")
        else:
            self._set_hint(empty_hint)

    def _set_hint(self, text: str):
        eng = ThemeEngine.instance()
        fg2 = eng.t("fg2", "#6B7280") if eng else "#6B7280"
        self.browser.setHtml(
            f"<style>body{{color:{fg2};font-size:13px;line-height:1.6;}}</style>"
            f"<p>{_escape(text)}</p>"
        )

    def _restyle(self, *_):
        eng = ThemeEngine.instance()
        fg = eng.t("fg", "#1A1A1A") if eng else "#1A1A1A"
        self.setStyleSheet(
            f"QTextBrowser {{ background: transparent; color: {fg}; border: none; }}"
        )
        # 若已有内容，重建 HTML 使主题色即时生效
        if hasattr(self, "_last_body") and self._last_body:
            self.browser.setHtml(f"<style>{_theme_css()}</style>{self._last_body}")


class WordPreviewView(_HtmlPreviewView):
    """Word(.docx) 只读预览：解析为富文本段落/表格。"""

    def set_path(self, path: str):
        self._last_body = parse_docx_to_html(path)
        self._set_html_body(self._last_body, "尚未关联 Word 文件（.docx）。")

    def set_content(self, content: str):
        self.set_path(content)


class ExcelPreviewView(_HtmlPreviewView):
    """Excel(.xlsx) 只读预览：首个工作表渲染为表格。"""

    def set_path(self, path: str):
        self._last_body = parse_xlsx_to_html(path)
        self._set_html_body(self._last_body, "尚未关联 Excel 文件（.xlsx）。")

    def set_content(self, content: str):
        self.set_path(content)


class LinkPreviewView(QWidget):
    """链接笔记：支持**多条**链接（每条 = 标题 + 目标），逐条可单独打开。

    存储约定：content_md 存 JSON 数组 ``[{"title": ..., "target": ...}, ...]``。
    为兼容历史数据，若内容不是 JSON 数组，则按「单条纯文本链接」解析
    （标题留空、整段即目标）——旧笔记打开后可直接编辑为多链接。
    """

    linksChanged = Signal(str)   # 链接列表变更（发 JSON 字符串，供宿主持久化）

    def __init__(self, parent: Optional[QWidget] = None):
        super().__init__(parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(6)

        head = QHBoxLayout()
        self.add_btn = UButton("添加链接", tone="accent", kind="solid")
        self.add_btn.clicked.connect(self._on_add)
        head.addWidget(self.add_btn)
        # 编辑/删除仍针对当前选中行（点行内任意处选中）
        self._edit_btn = UButton("编辑", tone="default", kind="ghost")
        self._edit_btn.clicked.connect(self._on_edit_current)
        head.addWidget(self._edit_btn)
        self._del_btn = UButton("删除", tone="danger", kind="ghost")
        self._del_btn.clicked.connect(self._on_delete_current)
        head.addWidget(self._del_btn)
        head.addStretch(1)
        lay.addLayout(head)

        # 链接列表（每条一行：标题 + 目标 + 打开按钮；无横向滚动，
        # 标题/目标显示不下省略号截断，靠行距分组、不加重复边框）
        self._list_host = QWidget()
        self._list_lay = QVBoxLayout(self._list_host)
        self._list_lay.setContentsMargins(0, 0, 0, 0)
        self._list_lay.setSpacing(4)
        self._scroll = QScrollArea()
        self._scroll.setWidgetResizable(True)
        self._scroll.setFrameShape(QScrollArea.NoFrame)
        # 纵向滚动足够；横向禁用，宽度始终跟随卡片（内容用省略号兜底）
        self._scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self._scroll.setWidget(self._list_host)
        lay.addWidget(self._scroll, 1)

        self._links: List[dict] = []
        self._current = -1
        self._restyle()
        eng = ThemeEngine.instance()
        if eng is not None:
            try:
                eng.changed.connect(self._restyle)
            except Exception:
                pass

    # ---------- 解析 / 序列化 ----------
    @staticmethod
    def parse_links(content: str) -> List[dict]:
        """内容 → 链接列表。JSON 数组优先；否则按单条纯文本兼容解析。"""
        raw = (content or "").strip()
        if not raw:
            return []
        if raw.startswith("["):
            try:
                data = json.loads(raw)
                if isinstance(data, list):
                    out = []
                    for it in data:
                        if isinstance(it, dict):
                            out.append({"title": str(it.get("title", "")).strip(),
                                        "target": str(it.get("target", "")).strip()})
                        elif isinstance(it, str):
                            out.append({"title": "", "target": it.strip()})
                    return [x for x in out if x["target"]]
            except (ValueError, TypeError):
                pass
        # 兼容旧数据：单条纯文本（每行一个目标也算多条）
        return [{"title": "", "target": ln.strip()}
                for ln in raw.splitlines() if ln.strip()]

    @staticmethod
    def dump_links(links: List[dict]) -> str:
        """链接列表 → 存储字符串（JSON；单条且无标题时退回纯文本，保持可读）。"""
        items = [{"title": x.get("title", ""), "target": x.get("target", "")}
                 for x in (links or []) if x.get("target")]
        if not items:
            return ""
        if len(items) == 1 and not items[0]["title"]:
            return items[0]["target"]
        return json.dumps(items, ensure_ascii=False)

    # ---------- 数据 ----------
    def links(self) -> List[dict]:
        return [dict(x) for x in self._links]

    def set_target(self, target: str):
        """兼容旧接口：单条链接。"""
        self.set_links(self.parse_links(target))

    def set_content(self, content: str):
        self.set_links(self.parse_links(content))

    def set_links(self, links: List[dict]):
        self._links = [{"title": (x.get("title") or "").strip(),
                        "target": (x.get("target") or "").strip()}
                       for x in (links or []) if (x.get("target") or "").strip()]
        self._current = 0 if self._links else -1
        self._rebuild_rows()

    # ---------- 列表渲染 ----------
    def _rebuild_rows(self):
        while self._list_lay.count():
            it = self._list_lay.takeAt(0)
            w = it.widget()
            if w is not None:
                w.deleteLater()
        if not self._links:
            hint = QLabel("尚未添加链接。点「添加链接」可加入多条（每条含标题与地址）。")
            hint.setWordWrap(True)
            hint.setProperty("dim", True)
            self._list_lay.addWidget(hint)
            self._list_lay.addStretch(1)
            return
        for i, item in enumerate(self._links):
            self._list_lay.addWidget(self._make_row(i, item))
        self._list_lay.addStretch(1)

    def _make_row(self, index: int, item: dict) -> QWidget:
        # 允许收缩 + 关键词省略：宽不足时 QLabel 不撑破卡片宽（配合下方 elide）
        from PySide6.QtWidgets import QSizePolicy
        row = QWidget()
        row.setProperty("linkRow", True)
        row.setProperty("current", index == self._current)
        row.setCursor(Qt.PointingHandCursor)
        h = QHBoxLayout(row)
        h.setContentsMargins(8, 4, 8, 4)
        h.setSpacing(8)
        title = QLabel(item.get("title") or "（未命名链接）")
        title.setWordWrap(False)
        title.setSizePolicy(QSizePolicy.Maximum, QSizePolicy.Preferred)
        title.setMinimumWidth(0)
        # 超长省略：文本由 _elide_label 在空间不足时截断（QLabel 不会自动省略）
        self._register_elide(title, item.get("title") or "（未命名链接）")
        f = title.font()
        f.setBold(index == self._current)
        title.setFont(f)
        h.addWidget(title, 1)
        target = QLabel(item.get("target", ""))
        target.setProperty("dim", True)
        target.setWordWrap(False)
        target.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        target.setMinimumWidth(0)
        self._register_elide(target, item.get("target", ""))
        h.addWidget(target, 1)
        open_btn = QToolButton()
        open_btn.setText("打开")
        open_btn.setCursor(Qt.PointingHandCursor)
        open_btn.clicked.connect(lambda _=False, i=index: self.open_link(i))
        h.addWidget(open_btn, 0)
        row.mousePressEvent = lambda _e, i=index: self._select(i)  # type: ignore[method-assign]
        return row

    # ---------- 超长省略（无横向滚动） ----------
    def _register_elide(self, label: QLabel, text: str):
        """注册待省略截断的 QLabel：空间不足时以 ElideRight 截断。

        QLabel 不会自动省略；用 resizeEvent 驱动重设截断文本，
        保证卡片窄时标题/目标显示不下则以「…」收尾，不撑出横向滚动。
        """
        label._full_text = text  # type: ignore[attr-defined]
        label._elide_source = label  # type: ignore[attr-defined]

    def _apply_elides(self):
        """对列表内所有已注册 label 按当前可用宽度重算省略文本。"""
        fm = self.fontMetrics()
        for row_idx in range(self._list_lay.count()):
            it = self._list_lay.itemAt(row_idx)
            w = it.widget() if it is not None else None
            if w is None:
                continue
            for lbl in w.findChildren(QLabel):
                full = getattr(lbl, "_full_text", None)
                if full is None:
                    continue
                avail = max(24, lbl.width())
                lbl.setText(fm.elidedText(full, Qt.ElideRight, avail))

    def resizeEvent(self, ev) -> None:  # noqa: N802
        super().resizeEvent(ev)
        self._apply_elides()

    def _select(self, index: int):
        self._current = index
        self._rebuild_rows()

    # ---------- 动作 ----------
    def open_link(self, index: int):
        """打开第 index 条链接（每条可单独打开）。"""
        if not (0 <= index < len(self._links)):
            return
        target = self._links[index].get("target", "")
        if not target:
            return
        kind, path = classify_target(target)
        if kind == "web":
            url = QUrl(path)
            if url.scheme() == "":
                url = QUrl("https://" + path)
        else:
            url = QUrl.fromLocalFile(path)
        QDesktopServices.openUrl(url)

    def _open_target(self):
        """兼容旧接口：打开当前选中链接。"""
        self.open_link(self._current)

    def _on_add(self):
        self._prompt_link(None)

    def _on_edit_current(self):
        if 0 <= self._current < len(self._links):
            self._prompt_link(self._current)

    def _on_delete_current(self):
        if 0 <= self._current < len(self._links):
            self._links.pop(self._current)
            self._current = min(self._current, len(self._links) - 1)
            self._rebuild_rows()
            self.linksChanged.emit(self.dump_links(self._links))

    def _prompt_link(self, index):
        """新增/编辑一条链接（标题 + 地址）。"""
        from ..ui import UInputDialog
        cur = self._links[index] if isinstance(index, int) and 0 <= index < len(self._links) else {}
        title, ok = UInputDialog.get_text(
            self, "链接标题", label="标题：", text=cur.get("title", ""),
            placeholder="给这条链接起个名字，如「项目文档」")
        if not ok:
            return
        target, ok2 = UInputDialog.get_text(
            self, "链接地址", label="地址：", text=cur.get("target", ""),
            placeholder="网页 URL 或本地文件路径")
        if not ok2 or not target.strip():
            return
        entry = {"title": (title or "").strip(), "target": target.strip()}
        if isinstance(index, int) and 0 <= index < len(self._links):
            self._links[index] = entry
            self._current = index
        else:
            self._links.append(entry)
            self._current = len(self._links) - 1
        self._rebuild_rows()
        self.linksChanged.emit(self.dump_links(self._links))

    def _restyle(self, *_):
        eng = ThemeEngine.instance()
        fg = eng.t("fg", "#1A1A1A") if eng else "#1A1A1A"
        fg2 = eng.t("fg2", "#6B7280") if eng else "#6B7280"
        hover = eng.t("hover", "#F1F5F3") if eng else "#F1F5F3"
        layer = eng.t("layer", "#FFFFFF") if eng else "#FFFFFF"
        self.setStyleSheet(
            f"QLabel {{ background: transparent; color: {fg}; }}"
            f"QLabel[dim=\"true\"] {{ color: {fg2}; font-size: 12px; }}"
            # 行无边框：普通行透明、当前选中行仅一层软底（不加边框），
            # 悬浮行 hover 底色 —— 分组靠行距与选中底色，不靠重复边框
            f"QWidget[linkRow=\"true\"] {{ background: transparent;"
            f" border-radius: 6px; }}"
            f"QWidget[linkRow=\"true\"][current=\"true\"] {{ background: {hover}; }}"
            f"QToolButton {{ background: {layer}; border: none;"
            f" color: {fg2}; padding: 2px 8px; border-radius: 6px; }}"
        )


# ================= 编辑支持（Word / Excel，保留格式） =================
def create_blank_docx(path: str) -> bool:
    """新建一个空白 .docx 文件。"""
    try:
        from docx import Document
        Document().save(path)
        return True
    except Exception:
        return False


def create_blank_xlsx(path: str) -> bool:
    """新建一个空白 .xlsx 文件。"""
    try:
        from openpyxl import Workbook
        Workbook().save(path)
        return True
    except Exception:
        return False


def docx_to_html(path: str) -> str:
    """把 .docx 解析为 HTML（保留标题/粗体/斜体/下划线/字号/颜色）。"""
    path = (path or "").strip()
    if not path or not Path(path).exists():
        return ""
    try:
        from docx import Document
        doc = Document(path)
    except Exception:
        return ""
    parts = []
    try:
        for p in doc.paragraphs:
            style = (p.style.name or "").lower()
            if style.startswith("heading"):
                level = style.replace("heading", "").strip()
                level = int(level) if level.isdigit() else 1
                tag = f"h{min(max(level, 1), 6)}"
            else:
                tag = "p"
            runs = []
            for run in p.runs:
                text = _escape(run.text)
                if not text:
                    continue
                f = run.font
                styles = []
                if f.bold:
                    styles.append("font-weight:bold;")
                if f.italic:
                    styles.append("font-style:italic;")
                if f.underline:
                    styles.append("text-decoration:underline;")
                if f.size and f.size.pt:
                    styles.append(f"font-size:{f.size.pt}pt;")
                if f.color and f.color.rgb:
                    styles.append(f"color:#{f.color.rgb};")
                if styles:
                    runs.append(f'<span style="{"".join(styles)}">{text}</span>')
                else:
                    runs.append(text)
            content = "".join(runs) or "&nbsp;"
            parts.append(f"<{tag}>{content}</{tag}>")
    except Exception:
        pass
    return "".join(parts)


def html_to_docx(path: str, html: str) -> bool:
    """把 HTML 写回 .docx，保留标题/粗体/斜体/下划线/字号/颜色。"""
    path = (path or "").strip()
    if not path:
        return False
    try:
        from docx import Document
        from docx.shared import Pt, RGBColor
        from PySide6.QtGui import QFont, QTextDocument
        qdoc = QTextDocument()
        qdoc.setHtml(html)
        doc = Document()
        block = qdoc.begin()
        while block.isValid():
            heading = block.blockFormat().headingLevel()
            if heading > 0:
                p = doc.add_heading(level=min(int(heading), 9))
            else:
                p = doc.add_paragraph()
            it = block.begin()
            while not it.atEnd():
                frag = it.fragment()
                if frag.isValid() and frag.text():
                    cf = frag.charFormat()
                    run = p.add_run(frag.text())
                    if cf.fontWeight() >= QFont.Bold:
                        run.bold = True
                    if cf.fontItalic():
                        run.italic = True
                    if cf.fontUnderline():
                        run.underline = True
                    if cf.fontPointSize() > 0:
                        run.font.size = Pt(cf.fontPointSize())
                    col = cf.foreground().color()
                    if col.isValid():
                        run.font.color.rgb = RGBColor(col.red(), col.green(), col.blue())
                it += 1
            block = block.next()
        doc.save(path)
        return True
    except Exception:
        return False


class WordEditView(QWidget):
    """Word(.docx) 可编辑视图：复用富文本编辑器（含工具栏/字号/颜色），编辑后自动保存 + 切走时写回。"""

    saved = Signal()

    def __init__(self, parent: Optional[QWidget] = None):
        super().__init__(parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        from .richtext_editor import RichTextEditor
        self.editor = RichTextEditor()
        self.editor.saveRequested.connect(self._on_autosave)
        lay.addWidget(self.editor, 1)
        self._path = ""

    def set_path(self, path: str):
        self._path = (path or "").strip()
        html = docx_to_html(self._path) if self._path else ""
        self.editor.set_html(html if html else "<p>（新建 Word 文档，开始编辑…）</p>")

    def set_content(self, content: str):
        self.set_path(content)

    def _on_autosave(self, _title: str, html: str):
        """编辑器 1s 防抖自动保存：写回 .docx。"""
        if self._path:
            html_to_docx(self._path, html)
            self.saved.emit()

    def commit(self):
        """把编辑内容写回 .docx 文件（保留格式）。"""
        if self._path:
            html_to_docx(self._path, self.editor.to_html())
            self.saved.emit()


class ExcelEditView(QWidget):
    """Excel(.xlsx) 可编辑视图：QTableWidget + 行列工具栏，编辑后自动保存 + 切走时写回。"""

    saved = Signal()

    def __init__(self, parent: Optional[QWidget] = None):
        super().__init__(parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        tb = QHBoxLayout()
        for label, slot, tip in (("+行", self.add_row, "追加一行"),
                                 ("+列", self.add_col, "追加一列"),
                                 ("-行", self.del_row, "删除当前行"),
                                 ("-列", self.del_col, "删除当前列")):
            b = QToolButton()
            b.setText(label)
            b.setToolTip(tip)
            b.setCursor(Qt.PointingHandCursor)
            b.clicked.connect(slot)
            tb.addWidget(b)
        tb.addStretch(1)
        lay.addLayout(tb)
        self.table = QTableWidget()
        self.table.setFrameShape(QTableWidget.NoFrame)
        lay.addWidget(self.table, 1)
        self._path = ""
        self._wb = None   # 保留原 workbook（含格式），保存时只改单元格值
        self._save_timer = QTimer(self)
        self._save_timer.setSingleShot(True)
        self._save_timer.setInterval(1000)
        self._save_timer.timeout.connect(self._do_save)
        self.table.itemChanged.connect(self._on_changed)
        self._restyle()
        eng = ThemeEngine.instance()
        if eng is not None:
            try:
                eng.changed.connect(self._restyle)
            except Exception:
                pass

    def set_path(self, path: str):
        self._path = (path or "").strip()
        self._wb = None
        rows = []
        if self._path and Path(self._path).exists():
            try:
                from openpyxl import load_workbook
                self._wb = load_workbook(self._path)
                ws = self._wb.active
                rows = [["" if v is None else str(v) for v in row]
                        for row in ws.iter_rows(values_only=True)]
            except Exception:
                self._wb = None
        if not rows:
            rows = [["", "", ""], ["", "", ""], ["", "", ""]]
        ncols = max(len(r) for r in rows)
        self.table.setRowCount(len(rows))
        self.table.setColumnCount(ncols)
        for i, row in enumerate(rows):
            for j in range(ncols):
                self.table.setItem(i, j, QTableWidgetItem(row[j] if j < len(row) else ""))

    def set_content(self, content: str):
        self.set_path(content)

    def commit(self):
        """把表格内容写回 .xlsx（尽量保留原格式）。"""
        if not self._path:
            return
        try:
            from openpyxl import Workbook
            wb = self._wb if self._wb is not None else Workbook()
            ws = wb.active
            for i in range(self.table.rowCount()):
                for j in range(self.table.columnCount()):
                    item = self.table.item(i, j)
                    if item is not None and item.text() != "":
                        ws.cell(row=i + 1, column=j + 1, value=item.text())
            wb.save(self._path)
            self.saved.emit()
        except Exception:
            pass

    def _on_changed(self, *_):
        self._save_timer.start()

    def _do_save(self):
        self.commit()

    def add_row(self):
        self.table.insertRow(self.table.rowCount())

    def add_col(self):
        self.table.insertColumn(self.table.columnCount())

    def del_row(self):
        r = self.table.currentRow()
        if r >= 0:
            self.table.removeRow(r)

    def del_col(self):
        c = self.table.currentColumn()
        if c >= 0:
            self.table.removeColumn(c)

    def _restyle(self, *_):
        eng = ThemeEngine.instance()
        t = eng.tokens if eng else {}
        fg = t.get("fg", "#1A1A1A")
        fg2 = t.get("fg2", "#6B7280")
        layer = t.get("layer", "#FFFFFF")
        hover = t.get("hover", "#F1F5F3")
        border = t.get("border", "#E4EDE8")
        accent = t.get("accent", "#0D9488")
        accent_soft = t.get("accent_soft", "#D9F2EE")
        # 主题化表格 + 行列号（QHeaderView）——行列号与主题 token 保持一致
        self.setStyleSheet(
            f"QTableWidget {{ background: {layer}; color: {fg}; border: none;"
            f" gridline-color: {border}; }}"
            f"QTableWidget::item {{ padding: 4px 8px; border: none;"
            f" border-bottom: 1px solid {border}; }}"
            f"QTableWidget::item:selected {{ background: {accent_soft}; color: {fg}; }}"
            # 行列号：横向/纵向表头统一为浅底 + 次级文字色，与主题一致
            f"QHeaderView::section {{ background: {hover}; color: {fg2};"
            f" border: none; border-right: 1px solid {border};"
            f" border-bottom: 1px solid {border}; padding: 4px 6px;"
            f" font-size: 12px; }}"
            f"QHeaderView::section:hover {{ background: {accent_soft}; }}"
            f"QTableCornerButton::section {{ background: {hover}; border: none;"
            f" border-right: 1px solid {border}; border-bottom: 1px solid {border}; }}"
        )
        # 表头文字居中、格子内容可编辑（QTableWidgetItem 默认可编辑，
        # 显式放开避免外部样式影响）
        try:
            self.table.horizontalHeader().setDefaultAlignment(Qt.AlignCenter)
            self.table.verticalHeader().setDefaultAlignment(Qt.AlignCenter)
            self.table.setEditTriggers(QTableWidget.DoubleClicked
                                      | QTableWidget.EditKeyPressed
                                      | QTableWidget.AnyKeyPressed)
        except Exception:  # noqa: BLE001
            pass
