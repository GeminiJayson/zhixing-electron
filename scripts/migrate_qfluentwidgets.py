# -*- coding: utf-8 -*-
"""把 zhixing 里的 qfluentwidgets 引用换成兼容层（第三方 UI 库退场）。

只处理已接管的部分；主窗口基类 FluentWindow 需要重构，单独一轮处理。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ZHIxING = ROOT / "zhixing"
COMPAT = "zhixing.view.kit.fluent_compat"

#: 已接管的名字（换成兼容层导入）
TAKEN = {
    "InfoBar", "InfoBarPosition", "RoundMenu", "Action", "MessageBox",
    "PushButton",
}
#: 直接删除的导入（框架接管主题，不再需要第三方设主题）
DROP = {"setTheme", "setThemeColor", "Theme"}


def rewrite(text: str) -> tuple:
    moved = set()
    dropped = set()

    def handle(match: re.Match) -> str:
        names = [n.strip() for n in match.group(1).split(",") if n.strip()]
        keep = [n for n in names if n not in TAKEN and n not in DROP]
        for name in names:
            if name in TAKEN:
                moved.add(name)
            elif name in DROP:
                dropped.add(name)
        if not keep:
            return ""
        return "from qfluentwidgets import " + ", ".join(keep)

    new_text = re.sub(r"from qfluentwidgets import ([^\n]+)", handle, text)
    return new_text, moved, dropped


def main() -> int:
    apply = "--apply" in sys.argv
    touched = 0
    total_moved = total_dropped = 0
    for path in sorted(ZHIxING.rglob("*.py")):
        original = path.read_text(encoding="utf-8")
        new_text, moved, dropped = rewrite(original)
        if not moved and not dropped:
            continue
        # 插入兼容层导入（放在第三方导入之后）
        if moved:
            line = "from %s import %s" % (COMPAT, ", ".join(sorted(moved)))
            lines = new_text.split("\n")
            last = 0
            for index, text_line in enumerate(lines[:80]):
                if text_line.startswith(("import ", "from ")):
                    last = index
            lines.insert(last + 1, line)
            new_text = "\n".join(lines)
        new_text = re.sub(r"\n\n\n+", "\n\n\n", new_text)
        touched += 1
        total_moved += len(moved)
        total_dropped += len(dropped)
        print("%-52s %s%s" % (path.relative_to(ROOT),
                              ", ".join(sorted(moved)) or "-",
                              (" | 删除 " + ", ".join(sorted(dropped))) if dropped else ""))
        if apply:
            path.write_text(new_text, encoding="utf-8")
    print("-" * 70)
    print("文件 %d | 接管 %d | 删除 %d | 模式 %s" % (
        touched, total_moved, total_dropped, "APPLY" if apply else "DRY-RUN"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
