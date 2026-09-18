# -*- coding: utf-8 -*-
"""把 zhixing 业务文件里的原生控件 import 换成兼容层 import。

只动 import 语句，不动任何调用代码：
    from PySide6.QtWidgets import (QLabel, QPushButton, QWidget)
->  from PySide6.QtWidgets import (QWidget)
    from zhixing.view.kit.fluent_compat import (QLabel, QPushButton)

用法：
    python scripts/migrate_imports.py --dry-run [--classes QLabel,QPushButton] [--limit N]
    python scripts/migrate_imports.py --apply
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ZHIxING = ROOT / "zhixing"
COMPAT = "zhixing.view.kit.fluent_compat"
SKIP = {ZHIxING / "view/kit/fluent_compat.py", ZHIxING / "view/kit/ui.py"}

#: 兼容层已接管的类
DEFAULT_CLASSES = ("QLabel", "QPushButton", "QCheckBox", "QRadioButton", "QToolButton")


def split_names(block: str) -> list:
    return [n.strip() for n in block.replace("\n", " ").split(",") if n.strip()]


def migrate_text(text: str, classes: set) -> tuple:
    """返回 (新文本, 摘出的类)。找不到就原样返回。"""
    pattern = re.compile(r"from PySide6\.QtWidgets import \(([^)]*)\)", re.S)
    picked: list = []

    def rewrite(match: re.Match) -> str:
        names = split_names(match.group(1))
        moved = [n for n in names if n in classes]
        if not moved:
            return match.group(0)
        picked.extend(moved)
        rest = [n for n in names if n not in classes]
        if not rest:
            return ""            # 整条 import 都被接管，后面删空行
        body = ", ".join(rest)
        return "from PySide6.QtWidgets import (" + body + ")"

    new_text = pattern.sub(rewrite, text)

    # 单行形式：from PySide6.QtWidgets import QLabel, QWidget
    single = re.compile(r"from PySide6\.QtWidgets import ([^(\n]+)")

    def rewrite_single(match: re.Match) -> str:
        names = split_names(match.group(1))
        moved = [n for n in names if n in classes]
        if not moved:
            return match.group(0)
        picked.extend(moved)
        rest = [n for n in names if n not in classes]
        head = "from PySide6.QtWidgets import " + ", ".join(rest) if rest else ""
        return head

    if picked:
        new_text = single.sub(rewrite_single, new_text)
        return new_text, picked

    new_text = single.sub(rewrite_single, new_text)
    return new_text, picked


def write_imports(text: str, picked: list) -> str:
    if not picked:
        return text
    unique = sorted(set(picked))
    line = "from %s import %s" % (COMPAT, ", ".join(unique))
    # 插到最后一个顶层 import 之后，保证它在 PySide6 之后
    lines = text.split("\n")
    last = 0
    for index, line_text in enumerate(lines[:80]):
        if line_text.startswith(("import ", "from ")):
            last = index
    lines.insert(last + 1, line)
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--classes", default=",".join(DEFAULT_CLASSES))
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--only", default="")
    args = parser.parse_args()

    classes = {c.strip() for c in args.classes.split(",") if c.strip()}
    files = sorted(p for p in ZHIxING.rglob("*.py") if p not in SKIP)
    if args.only:
        files = [p for p in files if args.only in str(p)]

    touched = 0
    total_moved = 0
    for path in files:
        if args.limit and touched >= args.limit:
            break
        original = path.read_text(encoding="utf-8")
        new_text, picked = migrate_text(original, classes)
        if not picked:
            continue
        new_text = write_imports(new_text, picked)
        new_text = re.sub(r"\n\n\n+", "\n\n\n", new_text)
        touched += 1
        total_moved += len(set(picked))
        rel = path.relative_to(ROOT)
        print("%-58s %s" % (rel, ", ".join(sorted(set(picked)))))
        if args.apply:
            path.write_text(new_text, encoding="utf-8")

    print("-" * 72)
    print("文件 %d 个 | 接管类 %d 个 | 模式: %s" % (
        touched, total_moved, "APPLY" if args.apply else "DRY-RUN"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
