# -*- coding: utf-8 -*-
"""[[wiki 链接]] 解析与渲染：链接按标题引用（ADR-2）。"""
import re
from typing import List, Tuple

# [[标题]]：标题内不允许出现 [ ] 和换行
_WIKI = re.compile(r"\[\[([^\[\]\n]+?)\]\]")
_MD_LINK = re.compile(r"(?<!!)\[([^\]]+)\]\(([^)]+)\)")
_CODE_FENCE = re.compile(r"```.*?```", re.S)
_INLINE_CODE = re.compile(r"`[^`\n]*`")


def extract_links(md: str) -> List[str]:
    """提取正文中全部 [[链接]] 目标标题（保持出现顺序、去重）。"""
    text = _strip_code(md)
    seen, out = set(), []
    for m in _WIKI.finditer(text):
        title = m.group(1).strip()
        if title and title not in seen:
            seen.add(title)
            out.append(title)
    return out


def _strip_code(md: str) -> str:
    return _INLINE_CODE.sub("", _CODE_FENCE.sub("", md))


def render_wiki_links(md: str, resolve, link_prefix: str = "zhixing-note://") -> str:
    """把 [[标题]] 渲染为 Markdown 链接。resolve(title)->note_id 或 None。"""
    def repl(m: re.Match) -> str:
        title = m.group(1).strip()
        nid = resolve(title)
        if nid:
            return f"[{title}]({link_prefix}{nid})"
        return f'<span class="dangling">[[{title}]]</span>'
    text = _CODE_FENCE.sub(lambda m: m.group(0).replace("[[", "\x00L\x00").replace("]]", "\x00R\x00"), md)
    text = _WIKI.sub(repl, text)
    return text.replace("\x00L\x00", "[[").replace("\x00R\x00", "]]")


def snippet_around(md: str, title: str, radius: int = 40) -> str:
    """取链接处 ±radius 字符的上下文摘录（用于反向链接面板）。"""
    text = md.replace("\n", " ")
    idx = text.find(f"[[{title}")
    if idx < 0:
        idx = text.find(title)
    if idx < 0:
        return text[: radius * 2] + ("…" if len(text) > radius * 2 else "")
    start = max(0, idx - radius)
    end = min(len(text), idx + len(title) + radius)
    return ("…" if start > 0 else "") + text[start:end] + ("…" if end < len(text) else "")


def first_heading(md: str, fallback: str = "无标题") -> str:
    for line in md.splitlines():
        s = line.strip()
        if s.startswith("# "):
            return s[2:].strip()
        if s.startswith("## "):
            return s[3:].strip()
    return fallback
