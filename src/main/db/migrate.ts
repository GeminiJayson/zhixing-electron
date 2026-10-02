/**
 * schema 迁移链：把旧版本的库逐号升到 SCHEMA_VERSION。
 *
 * 每个迁移都必须幂等：失败重试、进程重启后重新打开都可能重放。
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
    // V4：笔记版本历史表（SCHEMA_SQL 会建；这里对历史库兜底）。
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
  13: (c) => {
    // V13：工作流实例的执行日志。
    // 原先只有 workflow_instance.last_result 一个字段，存的是**最近一次**节点结果 ——
    // 实例跑完就只剩最后一步的痕迹，没法回答「这个流程每一步什么时候跑的、结果如何」。
    // 这张表按时间追加，实例详情页据此画执行时间轴。
    c.exec(
      "CREATE TABLE IF NOT EXISTS workflow_run_log (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "instance_id INTEGER NOT NULL REFERENCES workflow_instance(id) ON DELETE CASCADE, " +
        "node_id INTEGER REFERENCES workflow_node(id) ON DELETE SET NULL, " +
        "kind VARCHAR NOT NULL, detail TEXT, created_at DATETIME)"
    )
    c.exec("CREATE INDEX IF NOT EXISTS idx_wf_run_log_instance ON workflow_run_log(instance_id, id)")
  },
  14: (c) => {
    // V14：任务活动流。
    // 提醒弹窗要能回答「这条任务被提醒过几次、每次都怎么处理的、状态为什么改」，
    // 而这些是**追加型**记录（一条任务会有几十条），塞进 task 主表会让每次读任务都拖着整段历史。
    // 任务速览的「活动记录」时间轴读的就是这张表。
    c.exec(
      "CREATE TABLE IF NOT EXISTS task_activity (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE, " +
        "kind VARCHAR NOT NULL, detail TEXT, reason TEXT, created_at DATETIME)"
    )
    c.exec("CREATE INDEX IF NOT EXISTS idx_task_activity_task ON task_activity(task_id, id)")
  },
  15: (c) => {
    // V15：密码保险箱。
    //
    // 两张表，字段全部是 (密文, IV) 成对。设计要点见 docs/specs/vault-design.md §4：
    //   · **标题也加密** —— "你有哪些账号"本身就是敏感信息；
    //   · **不建 FTS** —— 现有 *_fts 都是明文索引，密文进索引等于把明文落库；
    //   · **不做版本历史 / 回收站** —— 避免留下历史密文副本，让"删除"语义干净。
    //
    // vault_meta 是单行表（CHECK id = 1）：盐、KDF 参数、主密码校验块。
    // **主密钥本身绝不落库** —— 它只在解锁后的进程内存里存在。
    c.exec(
      "CREATE TABLE IF NOT EXISTS vault_meta (" +
        "id INTEGER PRIMARY KEY CHECK (id = 1), " +
        "kdf_salt BLOB NOT NULL, " +
        "kdf_params TEXT NOT NULL, " +
        "verifier_ct BLOB NOT NULL, " +
        "verifier_iv BLOB NOT NULL, " +
        "created_at DATETIME)"
    )
    c.exec(
      "CREATE TABLE IF NOT EXISTS vault_entry (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "title_ct BLOB NOT NULL, title_iv BLOB NOT NULL, " +
        "username_ct BLOB, username_iv BLOB, " +
        "password_ct BLOB NOT NULL, password_iv BLOB NOT NULL, " +
        "url_ct BLOB, url_iv BLOB, " +
        "notes_ct BLOB, notes_iv BLOB, " +
        "tags_ct BLOB, tags_iv BLOB, " +
        "created_at DATETIME, updated_at DATETIME)"
    )
    c.exec("CREATE INDEX IF NOT EXISTS idx_vault_entry_updated ON vault_entry (updated_at DESC)")
  },
}
