# -*- coding: utf-8 -*-
"""标签管理（F1-6/#5）：标签的增删改/重命名/合并，供设置页挂载。

MVC 收口（W2）：本对话框只调用 NoteService 的标签管理 facade
（tags_with_usage/create_tag/rename_tag/merge_tags/delete_tag），
不再直连 db.session / 仓储 / infrastructure 模型。
"""
from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QDialog, QHBoxLayout, QInputDialog, QListWidgetItem, QMessageBox, QVBoxLayout, QWidget)

from qfluent_core import ThemeManager as ThemeEngine
from ..ui import DialogType, UButton, UDialog
from zhixing.view.kit.fluent_compat import QLabel
from zhixing.view.kit.fluent_compat import QListWidget


def _fg2() -> str:
    eng = ThemeEngine.instance()
    return eng.t("fg2", "#6B7280") if eng else "#6B7280"


class TagManagerDialog(UDialog):
    """标签管理对话框：列出全部标签 + 使用数，支持新增/重命名/删除/合并。"""

    def __init__(self, note_service, parent=None):
        super().__init__(title="标签管理", parent=parent,
                         dialog_type=DialogType.RESIZABLE, icon_name="tag.tag",
                         width=460, height=480)
        self.note_service = note_service
        content = QWidget()
        lay = QVBoxLayout(content)
        lay.setContentsMargins(14, 14, 14, 14)
        lay.setSpacing(10)

        tip = QLabel("标签会同步作用于任务与笔记。合并后，被合并标签的所有关联会归并到目标标签。")
        tip.setWordWrap(True)
        tip.setStyleSheet(f"color: {_fg2()};")
        lay.addWidget(tip)

        self.list = QListWidget()
        self.list.setSelectionMode(QListWidget.ExtendedSelection)
        lay.addWidget(self.list, 1)

        btns = QHBoxLayout()
        add_btn = UButton("新增", tone="accent", kind="solid")
        add_btn.clicked.connect(self._create)
        rename_btn = UButton("重命名", tone="default", kind="ghost")
        rename_btn.clicked.connect(self._rename)
        merge_btn = UButton("合并选中", tone="default", kind="ghost")
        merge_btn.clicked.connect(self._merge)
        del_btn = UButton("删除", tone="danger", kind="ghost")
        del_btn.clicked.connect(self._delete)
        close_btn = UButton("关闭", tone="default", kind="ghost")
        close_btn.clicked.connect(self.accept)
        for b in (add_btn, rename_btn, merge_btn, del_btn):
            btns.addWidget(b)
        btns.addStretch(1)
        btns.addWidget(close_btn)
        lay.addLayout(btns)
        self.setContentWidget(content)

        self._reload()

    # ---------- 数据（只读 facade） ----------
    def _tags(self):
        try:
            return self.note_service.all_tags() or []
        except Exception:
            return []

    def _reload(self):
        self.list.clear()
        try:
            rows = self.note_service.tags_with_usage() or []
        except Exception:
            rows = []
        for tid, name, _color, count in rows:
            item = QListWidgetItem(f"#{name}   ·   {count} 处使用")
            item.setData(Qt.UserRole, tid)
            self.list.addItem(item)

    def _selected_ids(self):
        return [self.list.item(i).data(Qt.UserRole)
                for i in range(self.list.count()) if self.list.item(i).isSelected()]

    def _tag_name(self, tid):
        for _id, name, _c in self._tags():
            if _id == tid:
                return name
        return ""

    # ---------- 动作（写路径走 service） ----------
    def _create(self):
        text, ok = QInputDialog.getText(self, "新增标签", "标签名：")
        if not ok or not text.strip():
            return
        self.note_service.create_tag(text.strip())
        self._reload()

    def _rename(self):
        ids = self._selected_ids()
        if len(ids) != 1:
            self._warn("请选择要重命名的单个标签")
            return
        old = self._tag_name(ids[0])
        text, ok = QInputDialog.getText(self, "重命名标签", "新标签名：", text=old)
        if not ok or not text.strip():
            return
        self.note_service.rename_tag(ids[0], text.strip())
        self._reload()

    def _merge(self):
        ids = self._selected_ids()
        if len(ids) < 2:
            self._warn("请至少选择两个标签进行合并（保留第一个，其余并入）")
            return
        target = ids[0]
        sources = ids[1:]
        names = "、".join(self._tag_name(i) for i in sources)
        box = QMessageBox(self)
        box.setWindowTitle("合并标签")
        box.setText(f"将 {names} 合并到「{self._tag_name(target)}」？合并后来源标签会被删除。")
        box.setStandardButtons(QMessageBox.Yes | QMessageBox.Cancel)
        box.button(QMessageBox.Yes).setText("合并")
        box.button(QMessageBox.Cancel).setText("取消")
        if box.exec() != QMessageBox.Yes:
            return
        self.note_service.merge_tags(target, sources)
        self._reload()

    def _delete(self):
        ids = self._selected_ids()
        if not ids:
            self._warn("请选择要删除的标签")
            return
        box = QMessageBox(self)
        box.setWindowTitle("删除标签")
        box.setText("确定删除选中的标签吗？标签关联会被移除，任务与笔记本身不受影响。")
        box.setStandardButtons(QMessageBox.Yes | QMessageBox.Cancel)
        box.button(QMessageBox.Yes).setText("删除")
        box.button(QMessageBox.Cancel).setText("取消")
        if box.exec() != QMessageBox.Yes:
            return
        for tid in ids:
            self.note_service.delete_tag(tid)
        self._reload()

    def _warn(self, text):
        box = QMessageBox(self)
        box.setWindowTitle("提示")
        box.setText(text)
        box.setStandardButtons(QMessageBox.Ok)
        box.exec()
