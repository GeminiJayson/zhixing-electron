/**
 * schema 迁移链：把旧版本的库逐号升到 SCHEMA_VERSION。
 *
 * 逐条对齐 Python 的 zhixing/model/infrastructure/db.py 里的 _MIGRATIONS（v1..v12）。
 * 两个客户端读写同一个 SQLite 文件，迁移结果必须一致，否则先升级的一方会
 * 让另一方读不懂库。每个迁移都必须幂等：失败重试、两个进程先后打开都可能重放。
 */
import type Database from 'better-sqlite3'

/** SQLite 没有 ADD COLUMN IF NOT EXISTS，只能先查表结构。 */
function hasColumn(c: Database.Database, table: string, column: string): boolean {
  const rows = c.prepare("PRAGMA table_info(" + table + ")").all() as { name: string }[]
  return rows.some((r) => r.name === column)
}

/** 缺列才加，重跑安全。 */
function addColumn(c: Database.Database, table: string, column: string, ddl: string): void {
  if (!hasColumn(c, table, column)) c.exec("ALTER TABLE " + table + " ADD COLUMN " + ddl)
}

/** to_version -> 升级动作。逐号升到 SCHEMA_VERSION，缺号会显式报错而不是跳级。 */
export const MIGRATIONS: Record<number, (c: Database.Database) => void> = {
  1: () => {
    // V1 占位：现库 schema 在 V1 就已正确落地，可安全幂等执行，不做 DDL。
  },
  2: (c) => addColumn(c, "task", "start_date", "start_date DATE"),
  3: (c) => addColumn(c, "note", "format", "format TEXT NOT NULL DEFAULT 'markdown'"),
  4: (c) => {
    // V4：笔记版本历史表（create_all 会建；这里对历史库兜底）。
    c.exec(
      "CREATE TABLE IF NOT EXISTS note_revision (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "note_id INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE, " +
        "title VARCHAR DEFAULT '', content_md TEXT DEFAULT '', " +
        "format VARCHAR DEFAULT 'markdown', created_at DATETIME)"
    )
  },
  5: (c) => addColumn(c, "task", "repeat_rule", "repeat_rule VARCHAR"),
  6: (c) => {
    // V6：历史遗留的 NULL / 空 format 归一为 markdown，避免新视图读到空值。
    c.exec("UPDATE note SET format='markdown' WHERE format IS NULL OR format=''")
    c.exec("UPDATE note_revision SET format='markdown' WHERE format IS NULL OR format=''")
  },
  7: (c) => {
    // V7：WAITING 任务自动恢复 + 任务↔笔记段落级上下文。
    addColumn(c, "task", "resume_at", "resume_at DATE")
    c.exec(
      "CREATE TABLE IF NOT EXISTS task_note_context (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE, " +
        "note_id INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE, " +
        "block_key VARCHAR NOT NULL, snippet TEXT DEFAULT '', created_at DATETIME, " +
        "CONSTRAINT uq_task_note_block UNIQUE (task_id, note_id, block_key))"
    )
  },
  8: (c) => {
    // V8：优先级 4 级 → 8 级（数字越大越高）。倒序分步，避免 1→2 后被 2→5 再扫到。
    if (!hasColumn(c, "task", "priority")) return
    c.exec("UPDATE task SET priority=8 WHERE priority=3")
    c.exec("UPDATE task SET priority=5 WHERE priority=2")
    c.exec("UPDATE task SET priority=2 WHERE priority=1")
  },
  9: (c) => {
    // V9：任务↔笔记「引用」关系（与归属并存）。
    c.exec(
      "CREATE TABLE IF NOT EXISTS task_note_ref (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE, " +
        "note_id INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE, " +
        "created_at DATETIME, " +
        "CONSTRAINT uq_task_note_ref UNIQUE (task_id, note_id))"
    )
  },
  10: (c) => {
    // V10：工作流模块（模板 / 节点 / 实例 / 步骤↔任务绑定）。
    c.exec(
      "CREATE TABLE IF NOT EXISTS workflow_template (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, " +
        "start_policy TEXT DEFAULT 'first', created_at DATETIME, updated_at DATETIME)"
    )
    c.exec(
      "CREATE TABLE IF NOT EXISTS workflow_node (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "template_id INTEGER NOT NULL REFERENCES workflow_template(id) ON DELETE CASCADE, " +
        "title TEXT NOT NULL, detail TEXT, order_index INTEGER DEFAULT 0, " +
        "note_id INTEGER REFERENCES note(id) ON DELETE SET NULL, " +
        "action_kind TEXT DEFAULT 'none', action_value TEXT, condition TEXT, " +
        "branch_node_id INTEGER REFERENCES workflow_node(id) ON DELETE SET NULL, " +
        "created_at DATETIME)"
    )
    c.exec(
      "CREATE TABLE IF NOT EXISTS workflow_instance (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "template_id INTEGER NOT NULL REFERENCES workflow_template(id) ON DELETE CASCADE, " +
        "title TEXT, status TEXT DEFAULT 'running', " +
        "current_node_id INTEGER REFERENCES workflow_node(id) ON DELETE SET NULL, " +
        "origin_task_id INTEGER REFERENCES task(id) ON DELETE SET NULL, " +
        "created_at DATETIME, finished_at DATETIME)"
    )
    c.exec(
      "CREATE TABLE IF NOT EXISTS workflow_step_task (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "instance_id INTEGER NOT NULL REFERENCES workflow_instance(id) ON DELETE CASCADE, " +
        "node_id INTEGER NOT NULL REFERENCES workflow_node(id) ON DELETE CASCADE, " +
        "task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE, " +
        "created_at DATETIME, " +
        "CONSTRAINT uq_wf_step_node UNIQUE (instance_id, node_id))"
    )
  },
  11: (c) => {
    // V11：工作流节点画布坐标，旧节点为 NULL（视图层回退默认纵向排布）。
    addColumn(c, "workflow_node", "pos_x", "pos_x FLOAT")
    addColumn(c, "workflow_node", "pos_y", "pos_y FLOAT")
  },
  12: (c) => {
    // V12：note_link.dst_title 建索引，加速笔记重命名时的目标同步。
    c.exec("CREATE INDEX IF NOT EXISTS idx_note_link_dst_title ON note_link(dst_title)")
  },
}
