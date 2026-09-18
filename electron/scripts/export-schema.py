# -*- coding: utf-8 -*-
"""从 Python 版导出权威建库 DDL，生成 Electron 侧的 src/main/db/schema.ts。

用法（仓库根目录）：
    .venv/bin/python electron/scripts/export-schema.py

为什么需要它：Electron 版没有 ORM，库文件不存在时必须自己建库，而两版共用
同一个 SQLite 文件，schema 必须与 Python 的 Base.metadata.create_all 逐字一致
——手抄必然漂移，所以导出一次固化下来。Python 侧 SCHEMA_VERSION 变化后必须
重新运行本脚本，否则新库会缺表。
"""
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from sqlalchemy import create_engine  # noqa: E402

from zhixing.model.infrastructure.models import Base, SCHEMA_VERSION  # noqa: E402
from zhixing.model.infrastructure.db import _FTS_DDL  # noqa: E402

TARGET = ROOT / "electron" / "src" / "main" / "db" / "schema.ts"
PROBE = "/tmp/zhixing-schema-probe.db"

for suffix in ("", "-wal", "-shm"):
    if os.path.exists(PROBE + suffix):
        os.remove(PROBE + suffix)

engine = create_engine("sqlite:///" + PROBE)
Base.metadata.create_all(engine)

con = sqlite3.connect(PROBE)
for ddl in _FTS_DDL:
    con.execute(ddl)
con.commit()

fts = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'")]


def is_shadow(name: str) -> bool:
    return any(name.startswith(v + "_") for v in fts)


rows = con.execute(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL "
    "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name"
).fetchall()

stmts = []
for typ, name, sql in rows:
    if name.startswith("sqlite_") or is_shadow(name):
        continue
    stmt = sql.strip().rstrip(";")
    # 统一改写成 IF NOT EXISTS：这样这份 DDL 既能建全新库，也能给旧库补缺失的表
    # （等价 Python 侧 create_all 只建缺失表的语义），迁移路径可以直接复用。
    upper = stmt.upper()
    if not upper.startswith("CREATE TABLE IF NOT EXISTS") and upper.startswith("CREATE TABLE "):
        stmt = "CREATE TABLE IF NOT EXISTS" + stmt[len("CREATE TABLE"):]
    elif not upper.startswith("CREATE VIRTUAL TABLE IF NOT EXISTS") and upper.startswith("CREATE VIRTUAL TABLE "):
        stmt = "CREATE VIRTUAL TABLE IF NOT EXISTS" + stmt[len("CREATE VIRTUAL TABLE"):]
    stmts.append(stmt + ";")

body = "\n".join(stmts)
if "`" in body or "${" in body:
    raise SystemExit("DDL 含会破坏 TS 模板字符串的字符，请改用其它拼接方式")

tables = len([1 for t, n, s in rows if t == "table" and not n.startswith("sqlite_") and not is_shadow(n)])
text = (
    "/**\n"
    " * 建库 DDL：库文件不存在时由 connection.open() 执行，效果等价于 Python 版的\n"
    " * Base.metadata.create_all + _FTS_DDL + 写入 settings.schema_version。\n"
    " *\n"
    " * 本文件是生成物，请勿手改：\n"
    " *     .venv/bin/python electron/scripts/export-schema.py\n"
    " * Python 侧 SCHEMA_VERSION 变化后必须重新生成，否则新库会缺表。\n"
    f" * 当前对应 Python 侧 SCHEMA_VERSION = {SCHEMA_VERSION}，共 {tables} 张表。\n"
    " */\n"
    f"export const SCHEMA_VERSION = {SCHEMA_VERSION}\n\n"
    "export const SCHEMA_SQL = `\n"
    f"{body}\n"
    "`\n"
)
TARGET.write_text(text, encoding="utf-8")
print(f"written {TARGET}  tables={tables} stmts={len(stmts)} schema_version={SCHEMA_VERSION}")
