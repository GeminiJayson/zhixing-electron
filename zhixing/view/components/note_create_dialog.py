# -*- coding: utf-8 -*-
"""新建笔记弹窗：名称 + 类型（Markdown/富文本/Word/Excel/链接）+ 目标。

需求④已把新建笔记改为弹窗输入名称，这里在同一个无边框弹窗内增加类型选择，
并为 Word/Excel/链接 提供文件路径/URL 目标输入与文件浏览，最终由 NotePage 注入
note_service.create 持久化 format 字段。
"""
from __future__ import annotations

from typing import Optional, Tuple

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QDialog, QFileDialog, QHBoxLayout, QWidget)

from ...model.application.note_service import (
    NOTE_FORMAT_EXCEL, NOTE_FORMAT_LABELS, NOTE_FORMAT_LINK, NOTE_FORMAT_MARKDOWN,
    NOTE_FORMAT_WORD,
)
from ..ui import DialogType, UButton, UDialog
from zhixing.view.kit.fluent_compat import QComboBox, QLabel, QLineEdit

_TARGET_FORMATS = {NOTE_FORMAT_WORD, NOTE_FORMAT_EXCEL, NOTE_FORMAT_LINK}


class NoteCreateDialog(UDialog):
    """新建笔记：名称 + 类型 + 目标（Word/Excel/链接时显示）。"""

    def __init__(self, parent: Optional[QWidget] = None,
                 default_title: str = "", default_format: str = NOTE_FORMAT_MARKDOWN):
        super().__init__(title="新建笔记", parent=parent, dialog_type=DialogType.INPUT,
                         icon_name="nav.notes", width=470, height=330)
        self._build(default_title, default_format)

    def _build(self, default_title: str, default_format: str):
        # 名称
        name_label = QLabel("笔记名称：")
        name_label.setObjectName("uiDialogLabel")
        self.setContentWidget(name_label)
        self.name_edit = QLineEdit(default_title)
        self.name_edit.setPlaceholderText("请输入笔记名称")
        self.name_edit.setClearButtonEnabled(True)
        self.setContentWidget(self.name_edit)

        # 类型
        type_label = QLabel("笔记类型：")
        type_label.setObjectName("uiDialogLabel")
        self.setContentWidget(type_label)
        self.type_combo = QComboBox()
        for fmt, label in NOTE_FORMAT_LABELS:
            self.type_combo.addItem(label, fmt)
        idx = self.type_combo.findData(default_format)
        self.type_combo.setCurrentIndex(max(0, idx))
        self.type_combo.currentIndexChanged.connect(self._update_target_row)
        self.setContentWidget(self.type_combo)

        # 目标（Word/Excel/链接）
        self.target_row = QWidget()
        tr = QHBoxLayout(self.target_row)
        tr.setContentsMargins(0, 0, 0, 0)
        tr.setSpacing(8)
        self.target_label = QLabel("目标：")
        self.target_label.setObjectName("uiDialogLabel")
        tr.addWidget(self.target_label, 0, Qt.AlignVCenter)
        self.target_edit = QLineEdit()
        self.target_edit.setPlaceholderText("文件路径或网页 URL")
        self.target_edit.setClearButtonEnabled(True)
        # 必须显式 AlignVCenter：行内控件高度不一致时（输入框 32、按钮更高），
        # 默认拉伸会让输入框被挤到偏上 1px，其内置清除按钮随之偏离垂直中心。
        tr.addWidget(self.target_edit, 1, Qt.AlignVCenter)
        self.browse_btn = UButton("浏览…", tone="default", kind="ghost")
        self.browse_btn.clicked.connect(self._browse)
        tr.addWidget(self.browse_btn, 0, Qt.AlignVCenter)
        self.setContentWidget(self.target_row)

        # 按钮组
        row = QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(10)
        row.addStretch(1)
        cancel = UButton("取消", tone="default", kind="ghost")
        ok = UButton("确定", tone="accent", kind="solid")
        cancel.clicked.connect(self.reject)
        ok.clicked.connect(self.accept)
        self.name_edit.returnPressed.connect(self.accept)
        self.target_edit.returnPressed.connect(self.accept)
        row.addWidget(cancel)
        row.addWidget(ok)
        self.add_layout(row)

        self._update_target_row()
        self.resize(470, 330)

    def selected_format(self) -> str:
        return self.type_combo.currentData() or NOTE_FORMAT_MARKDOWN

    def _update_target_row(self, *_):
        fmt = self.selected_format()
        show = fmt in _TARGET_FORMATS
        self.target_row.setVisible(show)
        if fmt == NOTE_FORMAT_WORD:
            self.target_label.setText("Word 文件：")
            self.target_edit.setPlaceholderText("选择或输入 .docx 文件路径")
        elif fmt == NOTE_FORMAT_EXCEL:
            self.target_label.setText("Excel 文件：")
            self.target_edit.setPlaceholderText("选择或输入 .xlsx 文件路径")
        else:
            self.target_label.setText("链接目标：")
            self.target_edit.setPlaceholderText("网页 URL 或本地文件路径")

    def _browse(self):
        fmt = self.selected_format()
        if fmt == NOTE_FORMAT_WORD:
            filters = "Word 文档 (*.docx)"
        elif fmt == NOTE_FORMAT_EXCEL:
            filters = "Excel 工作簿 (*.xlsx)"
        else:
            filters = "所有文件 (*)"
        path, _ = QFileDialog.getOpenFileName(self, "选择文件", "", filters)
        if path:
            self.target_edit.setText(path)

    def result(self) -> Tuple[str, str, str]:
        """返回 (名称, format, 目标)。"""
        return self.name_edit.text().strip(), self.selected_format(), self.target_edit.text().strip()

    @staticmethod
    def get_note(parent: Optional[QWidget] = None,
                 default_title: str = "") -> Optional[Tuple[str, str, str]]:
        """弹窗选择：返回 (名称, format, 目标) 或取消时 None。"""
        dlg = NoteCreateDialog(parent=parent, default_title=default_title)
        try:
            if dlg.exec() == QDialog.Accepted:
                return dlg.result()
            return None
        finally:
            dlg.deleteLater()
