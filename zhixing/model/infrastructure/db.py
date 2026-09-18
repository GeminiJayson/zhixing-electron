# -*- coding: utf-8 -*-
"""数据库会话与迁移：SQLite WAL、FTS5 虚表、schema_version 线性迁移。"""
import os
import sys
from pathlib import Path
from typing import List, Optional

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker, Session

from .models import Base, SCHEMA_VERSION
from ...core.errors import DatabaseLockedError

_APP_NAME = "ZhiXing"


def data_dir() -> Path:
    """数据目录：环境变量 ZHIXING_HOME 优先，否则按平台标准位置。

    - macOS：~/Library/Application Support/ZhiXing
    - Windows：%APPDATA%\\ZhiXing
    - Linux：~/.zhixing
    """
    env = os.environ.get("ZHIXING_HOME")
    if env:
        p = Path(env)
    elif sys.platform == "darwin":
        p = Path.home() / "Library" / "Application Support" / _APP_NAME
    elif sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        p = Path(base) / _APP_NAME
    else:
        p = Path.home() / ".zhixing"
    p.mkdir(parents=True, exist_ok=True)
    return p


def db_path() -> Path:
    return data_dir() / "zhixing.db"


_FTS_DDL = [
    "CREATE VIRTUAL TABLE IF NOT EXISTS task_fts USING fts5(title, notes, task_id UNINDEXED, tokenize='unicode61')",
    "CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(title, content, note_id UNINDEXED, tokenize='unicode61')",
    "CREATE VIRTUAL TABLE IF NOT EXISTS flash_fts USING fts5(content, remark, flash_id UNINDEXED, tokenize='unicode61')",
]

# 版本迁移链：执行后写入 schema_version
#
# 未来升级在此追加形如  _MIGRATIONS[N] 的条目（N 为“达到的版本号”，须逐号连续）。
# 标签已建模为 task_tag / note_tag / flash_tag 关联表，禁止用 tags 文本列（历史上
# 曾尝试 ADD COLUMN tags，与现 schema 冲突，属无效迁移，已移除）。结构演进一律
# 走 create_all 的新表/列 + 关联表；语义/索引级升级走下面迁移函数链。


def migrate_v1(conn) -> None:
    """占位迁移（现库 schema 已在 V1 正确落地）。可安全幂等执行，不做 DDL。"""
    return None


def migrate_v2(conn) -> None:
    """V2：任务新增「开始时间」start_date 列（可空），供开始日期与今日/日程视图使用。"""
    cols = [row[1] for row in conn.execute(text("PRAGMA table_info(task)"))]
    if "start_date" not in cols:
        conn.execute(text("ALTER TABLE task ADD COLUMN start_date DATE"))


def migrate_v3(conn) -> None:
    """V3：笔记新增「格式」format 列（默认 markdown），供笔记页在 Markdown/富文本间切换。"""
    cols = [row[1] for row in conn.execute(text("PRAGMA table_info(note)"))]
    if "format" not in cols:
        conn.execute(text("ALTER TABLE note ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown'"))


def migrate_v4(conn) -> None:
    """V4：新增笔记版本历史表 note_revision（F2-9，保留最近 20 版）。

    create_all 已在 migrate() 建出该表；这里仅对历史库兜底建表（幂等），
    避免老库升级时 create_all 时序差异导致缺表。
    """
    conn.execute(text(
        "CREATE TABLE IF NOT EXISTS note_revision ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "note_id INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE, "
        "title VARCHAR DEFAULT '', content_md TEXT DEFAULT '', "
        "format VARCHAR DEFAULT 'markdown', created_at DATETIME)"))


def migrate_v5(conn) -> None:
    """V5：任务新增「自定义循环规则」repeat_rule 列（F1-8 RRULE 子集）。"""
    cols = [row[1] for row in conn.execute(text("PRAGMA table_info(task)"))]
    if "repeat_rule" not in cols:
        conn.execute(text("ALTER TABLE task ADD COLUMN repeat_rule VARCHAR"))


def migrate_v6(conn) -> None:
    """V6：笔记类型扩展（word/excel/link）数据迁移。

    format 列已由 V3 引入，新类型只是新增取值，无需加列；这里把历史遗留的
    NULL/空 format 归一为 markdown（note 与 note_revision 两处），保证新视图
    按 format 分支时不会读到空值。幂等可重复执行。
    """
    conn.execute(text("UPDATE note SET format='markdown' WHERE format IS NULL OR format=''"))
    conn.execute(text("UPDATE note_revision SET format='markdown' WHERE format IS NULL OR format=''"))


def migrate_v7(conn) -> None:
    """V7（v0.15）：任务 WAITING 状态支持 + 任务↔笔记段落级上下文。

    - task 新增 resume_at（DATE，可空）：waiting 任务计划自动恢复的日期。
    - 建 task_note_context 表（P0-1 段落级定位；create_all 已建，此处对历史库兜底）。
    - 历史 waiting 语义不可逆迁移；仅加列/建表，幂等可重复执行。
    """
    cols = [row[1] for row in conn.execute(text("PRAGMA table_info(task)"))]
    if "resume_at" not in cols:
        conn.execute(text("ALTER TABLE task ADD COLUMN resume_at DATE"))
    conn.execute(text(
        "CREATE TABLE IF NOT EXISTS task_note_context ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE, "
        "note_id INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE, "
        "block_key VARCHAR NOT NULL, snippet TEXT DEFAULT '', created_at DATETIME, "
        "CONSTRAINT uq_task_note_block UNIQUE (task_id, note_id, block_key))"))


def migrate_v8(conn) -> None:
    """V8（v0.17）：任务优先级 4 级 → 8 级（0 无 + P1..P8）。

    - 旧值语义 1/2/3 = 低/中/高；新档位 P1(1)..P8(8)，数字越大优先级越高。
    - 兼容映射：1(低)→2(P2·LOW)、2(中)→5(P5·MID)、3(高)→8(P8·HIGH)。
      该映射使既有 ``int(priority) >= Priority.MID`` 判定语义不变（中及以上=重要）。
    - 仅 UPDATE 数值，幂等可重复执行（值 4/5/6/7/8 不会被再次改写）。
    """
    # 兼容映射：1(低)→2(P2·LOW)、2(中)→5(P5·MID)、3(高)→8(P8·HIGH)。
    # 该映射使既有 ``int(priority) >= Priority.MID`` 判定语义不变（中及以上=重要）。
    # 迁移链对每版本仅执行一次；用倒序分步更新避免「1→2 后再被 2→5 扫到」。
    cols = [row[1] for row in conn.execute(text("PRAGMA table_info(task)"))]
    if "priority" not in cols:
        return  # 极端历史库无 priority 列：无数据可迁（模型层会在后续 create_all 补列）
    conn.execute(text("UPDATE task SET priority=8 WHERE priority=3"))
    conn.execute(text("UPDATE task SET priority=5 WHERE priority=2"))
    conn.execute(text("UPDATE task SET priority=2 WHERE priority=1"))


def migrate_v9(conn) -> None:
    """V9：新增 task_note_ref（任务↔笔记「引用」关系，与归属并存）。

    仅建新表，不改既有数据 —— 旧的 task_note_link（归属）语义与数据完全不变。
    幂等：CREATE TABLE IF NOT EXISTS。
    """
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS task_note_ref (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
            note_id INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
            created_at DATETIME,
            CONSTRAINT uq_task_note_ref UNIQUE (task_id, note_id)
        )
    """))


def migrate_v10(conn) -> None:
    """V10：新增工作流模块（模板 / 节点 / 实例 / 步骤↔任务绑定）。

    仅建新表，不改既有数据。幂等：CREATE TABLE IF NOT EXISTS。
    """
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS workflow_template (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            start_policy TEXT DEFAULT 'first',
            created_at DATETIME,
            updated_at DATETIME
        )
    """))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS workflow_node (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            template_id INTEGER NOT NULL REFERENCES workflow_template(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            detail TEXT,
            order_index INTEGER DEFAULT 0,
            note_id INTEGER REFERENCES note(id) ON DELETE SET NULL,
            action_kind TEXT DEFAULT 'none',
            action_value TEXT,
            condition TEXT,
            branch_node_id INTEGER REFERENCES workflow_node(id) ON DELETE SET NULL,
            created_at DATETIME
        )
    """))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS workflow_instance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            template_id INTEGER NOT NULL REFERENCES workflow_template(id) ON DELETE CASCADE,
            title TEXT,
            status TEXT DEFAULT 'running',
            current_node_id INTEGER REFERENCES workflow_node(id) ON DELETE SET NULL,
            origin_task_id INTEGER REFERENCES task(id) ON DELETE SET NULL,
            created_at DATETIME,
            finished_at DATETIME
        )
    """))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS workflow_step_task (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            instance_id INTEGER NOT NULL REFERENCES workflow_instance(id) ON DELETE CASCADE,
            node_id INTEGER NOT NULL REFERENCES workflow_node(id) ON DELETE CASCADE,
            task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
            created_at DATETIME,
            CONSTRAINT uq_wf_step_node UNIQUE (instance_id, node_id)
        )
    """))


def migrate_v11(conn) -> None:
    """V11：workflow_node 增画布坐标列 pos_x/pos_y（布局稳定）。

    幂等：先 PRAGMA 检查列是否存在，缺则 ALTER TABLE ADD COLUMN。
    旧节点坐标为 NULL，视图层回退到默认纵向排布。
    """
    cols = [row[1] for row in conn.execute(text("PRAGMA table_info(workflow_node)"))]
    if "pos_x" not in cols:
        conn.execute(text("ALTER TABLE workflow_node ADD COLUMN pos_x FLOAT"))
    if "pos_y" not in cols:
        conn.execute(text("ALTER TABLE workflow_node ADD COLUMN pos_y FLOAT"))


def migrate_v12(conn) -> None:
    """V12：note_link.dst_title 建索引，加速笔记重命名 rename_target 的目标同步。

    rename_target 按 ``dst_title == old_title`` 全表扫是重命名卡顿的根源；
    建索引后按标题查/更走 idx，1 万级链接下重命名不再随链接总量线性变慢。
    SQLite 的 CREATE INDEX IF NOT EXISTS 天然幂等。
    """
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_note_link_dst_title ON note_link(dst_title)"))


# to_version -> upgrade(conn)。逐号升到 SCHEMA_VERSION，缺漏会显式报错而非跳级。
_MIGRATIONS = {1: migrate_v1, 2: migrate_v2, 3: migrate_v3, 4: migrate_v4, 5: migrate_v5,
               6: migrate_v6, 7: migrate_v7, 8: migrate_v8, 9: migrate_v9, 10: migrate_v10,
               11: migrate_v11, 12: migrate_v12}


class Database:
    def __init__(self, path: Optional[Path] = None):
        self.path = Path(path) if path else db_path()
        url = f"sqlite+pysqlite:///{self.path}"
        try:
            self.engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 3})
        except Exception as e:  # pragma: no cover
            raise DatabaseLockedError() from e

        @event.listens_for(self.engine, "connect")
        def _on_connect(dbapi_conn, _):  # noqa: ANN001
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.close()

        self.Session = sessionmaker(bind=self.engine, expire_on_commit=False)
        # 迁移失败不崩入口：记录原因交给上层进入只读模式（#12 入口闭环）。
        # migrate() 方法本身仍会抛 RuntimeError，供单测断言缺链报错；
        # 构造期这里只「捕获并记录」，让 AppContext 仍能装配出可只读查询的实例。
        self.migrate_error: Optional[str] = None
        try:
            self.migrate()
        except RuntimeError as e:
            self.migrate_error = str(e)

    def session(self) -> Session:
        return self.Session()

    def migrate(self) -> List[int]:
        """建表 + FTS，按需应用迁移链并返回本次实际升级到的版本号列表。

        约定：
        - 新库（无 settings.schema_version）直接置为 SCHEMA_VERSION，不做备份。
        - 老库低于 SCHEMA_VERSION → 先置迁移前备份，再逐号 _MIGRATIONS 升级，
          每步成功后才在 settings.schema_version 写回新版本（失败即回滚该步）。
        - 返回值：本次应用完成的版本号；无升级返回 []。
        """
        Base.metadata.create_all(self.engine)
        with self.engine.begin() as conn:
            for ddl in _FTS_DDL:
                conn.execute(text(ddl))
            row = conn.execute(text(
                "SELECT value FROM settings WHERE key='schema_version'")).scalar()
            if row is None:
                conn.execute(text("INSERT INTO settings(key, value) VALUES('schema_version', :v)"),
                             {"v": str(SCHEMA_VERSION)})
                return []  # 全新安装：无先前数据可迁移
            current = int(row)
        return self._apply_pending(current)

    def _apply_pending(self, current: int) -> List[int]:
        """把库从 current 逐号升到 SCHEMA_VERSION；升级前自动备份主库。"""
        if current >= SCHEMA_VERSION:
            return []
        missing = [v for v in range(current + 1, SCHEMA_VERSION + 1) if v not in _MIGRATIONS]
        if missing:
            raise RuntimeError(
                f"数据库迁移链不完整：缺 {missing}，请补全 _MIGRATIONS 再用。"
                f"（当前库 schema_version={current}，目标 {SCHEMA_VERSION}）")

        # 迁移前强制备份（WAL 一致快照），失败则中止，不改动主库
        from .backup import BackupService  # 延迟导入避免模块环
        bak = BackupService(self).backup(reason="pre-migrate")
        if bak is None:
            raise RuntimeError("迁移前备份失败，已中止以避免破坏既有数据。")

        applied: List[int] = []
        for ver in range(current + 1, SCHEMA_VERSION + 1):
            fn = _MIGRATIONS[ver]
            with self.engine.begin() as conn:  # 事务：任一迁移抛错 => 整段回滚
                fn(conn)
                conn.execute(text("UPDATE settings SET value=:v WHERE key='schema_version'"),
                             {"v": str(ver)})
            applied.append(ver)
        return applied

    # ---- FTS 同步（由仓储层在写路径调用）----
    def fts_replace(self, conn, table: str, id_col: str, row_id: int, cols: dict):
        conn.execute(text(f"DELETE FROM {table} WHERE {id_col} = :i"), {"i": row_id})
        names = ", ".join(cols.keys())
        placeholders = ", ".join([f":c{i}" for i in range(len(cols))]) + f", :{id_col}"
        params = {f"c{i}": v for i, v in enumerate(cols.values())}
        params[id_col] = row_id
        conn.execute(text(f"INSERT INTO {table}({names}, {id_col}) VALUES({placeholders})"), params)

    def fts_remove(self, conn, table: str, id_col: str, row_id: int):
        conn.execute(text(f"DELETE FROM {table} WHERE {id_col} = :i"), {"i": row_id})
