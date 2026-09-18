# -*- coding: utf-8 -*-
"""FTS 词法安全：含特殊字符的查询不再生成会静默失败的非法 MATCH 表达式。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from zhixing.model.infrastructure import fts as fts_mod


def _tokens(expr: str):
    """提取 expr 中引号包裹的词。"""
    import re
    return re.findall(r'"([^"]+)"', expr)


class TestQueryTermsEscape(unittest.TestCase):
    def test_plain_chinese_produces_quoted_terms(self):
        expr = fts_mod.query_terms("周报")
        self.assertTrue(expr)
        toks = _tokens(expr)
        self.assertTrue(toks, "应产出被引号包裹的词")
        self.assertTrue(any("周" in t for t in toks), "应保留搜索词片段：%s" % expr)

    def test_quote_and_specials_do_not_break(self):
        # 含 `"` `:` `*` 的输入：不应产出含裸双引号/冒号的非法 MATCH 子句。
        expr = fts_mod.query_terms('SQLite"WAL -x:z*')
        self.assertTrue(expr)
        joined = _tokens(expr)
        self.assertTrue(all(t and not any(ch in t for ch in '"*():-') for t in joined),
                        "每个 token 内不得残留 FTS 语法字符：%s" % joined)

    def test_all_symbols_yields_empty(self):
        self.assertEqual(fts_mod.query_terms('"""::**..'), "",
                         "纯符号应返回空表达式，而非非法语法")


if __name__ == "__main__":
    unittest.main(verbosity=2)
