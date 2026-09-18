# -*- coding: utf-8 -*-
"""FTS5 全文检索：jieba 入库分词 + 缺省按字切分（ADR-3）。"""
import re as _re
from typing import Dict, List, Optional, Tuple

from sqlalchemy import text as sql_text

try:
    import jieba
    jieba.setLogLevel(60)
    _HAS_JIEBA = True
except Exception:  # pragma: no cover
    _HAS_JIEBA = False


# FTS5 词法：双引号配对、`*` 结尾前缀、`OR/AND/NOT`、括号、`col:`
# 为避免用户输入里的这些字符把 MATCH 表达式变成非法语法/静默查空，
# 拆分 word 时按非 token 字符切（数字/字母/视觉字面字保留，符号当成分隔符）。
_TOKEN_PAT = _re.compile(r"[0-9A-Za-z\u4e00-\u9fff]+")


def _fts_terms(text: str) -> List[str]:
    """把原始查询拆成安全的 FTS 词（转义 FTS5 语法字符）。"""
    t = (text or "").strip()
    if not t:
        return []
    if _HAS_JIEBA:
        raw = [w.strip() for w in jieba.cut(t) if w.strip()]
    else:
        raw = [c for c in t]
    out: List[str] = []
    for w in raw:
        out.extend(_TOKEN_PAT.findall(w))
    return out[:8] or ([_TOKEN_PAT.search(t).group(0)] if _TOKEN_PAT.search(t) else [])

_TABLES = {
    "task": ("task_fts", "task_id"),
    "note": ("note_fts", "note_id"),
    "flash": ("flash_fts", "flash_id"),
}


def tokenize(text: str) -> str:
    """把中文文本切成空格分隔的 token 供 unicode61 索引。"""
    t = (text or "").strip()
    if not t:
        return ""
    if _HAS_JIEBA:
        return " ".join(w for w in jieba.cut_for_search(t) if w.strip())
    return " ".join(t)  # 按字回退


def query_terms(q: str) -> str:
    """把用户搜索词转为 FTS5 匹配表达式：前缀匹配 AND 组合。

    先剥离会把 MATCH 语法搞坏的字符（引号/冒号/括号/AND 等），保证
    含特殊字符的中文/英文查询不会因非法语法被 fts.search 静默吞成空结果。
    """
    tokens = _fts_terms(q)
    if not tokens:
        return ""
    return " AND ".join(f'"{w}"*' for w in tokens)


class FTSService:
    def __init__(self, database):
        self.db = database

    def index_task(self, conn, task_id: int, title: str, notes: str):
        self.db.fts_replace(conn, "task_fts", "task_id", task_id,
                            {"title": tokenize(title), "notes": tokenize(notes or "")})

    def index_note(self, conn, note_id: int, title: str, content: str):
        self.db.fts_replace(conn, "note_fts", "note_id", note_id,
                            {"title": tokenize(title), "content": tokenize(content or "")})

    def index_flash(self, conn, flash_id: int, content: str, remark: str = ""):
        self.db.fts_replace(conn, "flash_fts", "flash_id", flash_id,
                            {"content": tokenize(content or ""), "remark": tokenize(remark or "")})

    def remove(self, conn, kind: str, row_id: int):
        table, id_col = _TABLES[kind]
        self.db.fts_remove(conn, table, id_col, row_id)

    def search(self, session, kind: str, q: str, limit: int = 50) -> List[Tuple[int, float]]:
        """返回 [(row_id, rank)]，rank 越小越相关。"""
        expr = query_terms(q)
        if not expr:
            return []
        table, id_col = _TABLES[kind]
        try:
            rows = session.execute(
                sql_text(f"SELECT {id_col}, bm25({table}) AS r FROM {table} WHERE {table} MATCH :q "
                         f"ORDER BY r LIMIT :n"), {"q": expr, "n": limit}).all()
        except Exception:
            return []
        return [(r[0], r[1]) for r in rows]
