import { app } from 'electron'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema'
import { MIGRATIONS } from './migrate'
import type {
  Task,
} from '../../shared/types'


export const APP_DIR_NAME = 'ZhiXing'

/**
 * 数据目录：ZHIXING_HOME 环境变量优先，
 * 否则按平台标准位置。这既是便携模式，也让写入验证可以跑在副本库上。
 */
export function dataDir(): string {
  const override = process.env.ZHIXING_HOME
  if (override) return override
  if (process.platform === 'darwin') {
    return join(app.getPath('home'), 'Library', 'Application Support', APP_DIR_NAME)
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(app.getPath('home'), 'AppData', 'Roaming'), APP_DIR_NAME)
  }
  return join(app.getPath('home'), '.zhixing')
}

export function dbPath(): string {
  return join(dataDir(), 'zhixing.db')
}

export let db: Database.Database | null = null
export let openedPath = ''

export const TASK_COLUMNS = `id, title, notes_md, status, priority, due_date, start_date, start_time, due_time, reminder_at,
  reminder_fired, reminder_base,
  list_id, parent_id, repeat_period, repeat_rule, streak, sort_key, resume_at, last_reset_date,
  completed_at, created_at, updated_at`

/** 最近一次打开/建库失败的原因：给出可操作的中文，而不是笼统的「不可用」。 */
let openError = ''

/**
 * 只读模式原因。
 * 迁移失败时连接照常打开并记录原因，应用不崩、显示只读横幅 + 恢复备份入口。
 * 空字符串表示正常可写。
 */
let readonlyReason = ''

/**
 * 首次运行建库：执行完整 DDL（业务表 + FTS 表）并写入 settings.schema_version。
 */
function initSchema(d: Database.Database): void {
  d.transaction(() => {
    d.exec(SCHEMA_SQL)
    d.prepare('INSERT INTO settings(key, value) VALUES(?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION)
    )
  })()
}

/** 迁移前强制备份。 */
function backupBeforeMigrate(d: Database.Database): string | null {
  try {
    const dir = join(dataDir(), 'backups')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 14)
    const file = join(dir, `zhixing-before-migrate-${stamp}.db`)
    d.prepare('VACUUM INTO ?').run(file)
    return file
  } catch (err) {
    console.error('[db] 迁移前备份失败', err)
    return null
  }
}

/**
 * 打开已有库时的 schema 维护：
 *   1. 先补建缺失的表（DDL 已带 IF NOT EXISTS，只建缺表）
 *   2. 读 settings.schema_version；连这个键都没有就按「全新安装」直接置为当前版本
 *   3. 版本低于当前才迁移：先备份，再逐号执行，每步成功才写回版本号
 * 此前这里什么都不做，于是打开旧库会直接跑 v12 的查询并报「no such column」。
 */
function upgradeSchema(d: Database.Database): void {
  d.exec(SCHEMA_SQL)
  const row = d
    .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined
  if (row?.value === undefined) {
    d.prepare('INSERT INTO settings(key, value) VALUES(?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION)
    )
    return
  }
  const current = Number(row.value)
  if (!Number.isFinite(current) || current >= SCHEMA_VERSION) return
  const missing: number[] = []
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) if (!MIGRATIONS[v]) missing.push(v)
  if (missing.length) {
    throw new Error(`数据库迁移链不完整：缺 v${missing.join(', v')}，请补全后再打开`)
  }
  if (!backupBeforeMigrate(d)) {
    throw new Error('迁移前备份失败，已中止以避免破坏既有数据')
  }
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    d.transaction(() => {
      MIGRATIONS[v](d)
      d.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(v), 'schema_version')
    })()
  }
}

/**
 * 本应用私有的附加列 —— **不属于** schema 迁移链（MIGRATIONS / SCHEMA_VERSION）。
 *
 * 为什么不并进 MIGRATIONS：那是一条按版本号递增的链，在这里插号会让版本号与链的
 * 定义对不上。
 * 这几列是纯粹的 Electron 侧功能（多绑 SOP、自动步骤的期望值、上一步结果），
 * 全部可空，SELECT 也都是显式列名，多出来的列不会被读。
 *
 * 幂等：先看列在不在，缺了才 ALTER；列齐时连一次写事务都不产生。
 */
function ensureAppExtensions(d: Database.Database): void {
  const has = (table: string, column: string): boolean =>
    (d.prepare('PRAGMA table_info(' + table + ')').all() as { name: string }[]).some(
      (r) => r.name === column
    )
  const add = (table: string, column: string, ddl: string): void => {
    if (!has(table, column)) d.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl)
  }
  // 表可能不存在（更老的库早于工作流模块）——SCHEMA_SQL 已带 IF NOT EXISTS 补建，这里直接加列
  add('workflow_node', 'note_ids', 'note_ids TEXT')
  add('workflow_node', 'action_expect', 'action_expect TEXT')
  add('workflow_node', 'action_runtime', 'action_runtime TEXT')
  // 条件节点的「不成立」出边：与 branch_node_id（成立）配成一对，
  // 条件节点因此能在画布上拉出「满足 / 不满足」两条分支。
  add('workflow_node', 'branch_false_node_id', 'branch_false_node_id INTEGER')
  // 步骤的日志规则：关键字匹配（决定这一步算成功还是失败、命中「等待输入」时回什么）。
  // 存 JSON 字符串，结构与语义见 shared/workflow-log-rules.ts
  add('workflow_node', 'log_rules', 'log_rules TEXT')
  // 模板级的「什么时候自己跑起来」：定时计划与触发条件（见 shared/workflow-trigger.ts）
  add('workflow_template', 'schedule', 'schedule TEXT')
  add('workflow_template', 'triggers', 'triggers TEXT')
  // 子工作流：节点接续另一个模板时，记下"这个实例是谁的子流程、挂在哪个节点上"，
  // 子流程跑完才能把结果回传给父流程的对应节点。
  add('workflow_instance', 'parent_instance_id', 'parent_instance_id INTEGER')
  add('workflow_instance', 'parent_node_id', 'parent_node_id INTEGER')
  // 这个实例是被什么拉起来的：manual / schedule / task_status / http / subflow。
  // 它既是给用户看的（"这条是定时跑出来的"），也是调度器的账本 ——
  // "今天这次定时跑过了没有"直接查最近一次 schedule 触发的实例，不必另存一份内存状态
  // （内存状态一重启就丢，daily 计划会在同一天里补跑一次）。
  add('workflow_instance', 'trigger_kind', 'trigger_kind TEXT')
  add('workflow_instance', 'last_result', 'last_result TEXT')
  // 外部任务来源：靠 (source, id) 幂等认领，重复同步不会造出重复任务
  // 开始 / 截止的**时刻**（HH:MM，空 = 全天）。
  // 日期仍留在 start_date / due_date —— 那两列是 DATE，
  // 往里面塞带时间的字符串会让它的 Date 解析出问题；时刻另开一列，互不干扰。
  add('task', 'start_time', 'start_time TEXT')
  add('task', 'due_time', 'due_time TEXT')
  add('task', 'external_source', 'external_source TEXT')
  add('task', 'external_id', 'external_id TEXT')
  // 标记「这条任务是**认领**来的」（同名匹配后贴上的外部身份），而不是外部自建的。
  // 同步时两者待遇不同：认领来的只补空字段，否则用户手写的标题/备注会被外部数据抹掉。
  add('task', 'external_linked', 'external_linked INTEGER')
  // 提醒的记账：已提醒次数，以及计数所依据的基准时刻。
  // 有了它，一条任务才能「提醒 N 次、每 M 分钟一次」；基准变了就自动重新计数，
  // 所以改了截止日期不会被旧计数卡住，也不必在每个写入路径上挂钩子。
  add('task', 'reminder_fired', 'reminder_fired INTEGER')
  add('task', 'reminder_base', 'reminder_base TEXT')
  // 笔记的结构化属性（JSON 对象：{ "来源": "书籍", "评分": "5" }）
  add('note', 'props', 'props TEXT')
  // 任务↔笔记关联的**来源**：'wiki' = 从正文 [[标题]] 派生，'manual' = 用户手动拉的边。
  // 没有它，正文里删掉 [[标题]] 时无法判断这一行该不该跟着消失 ——
  // 一律删会误伤手动关联，一律留则 ⇄N 计数与图谱边永远不消失。
  add('task_note_link', 'source', 'source TEXT')
  // 历史行补来源：能从正文里证实是派生的才算 wiki，其余按 manual 保守保留（绝不误删用户的手动关联）。
  // 判据用 instr 而不是 LIKE，省得标题里的 % 或 _ 被当成通配符。
  d.exec(
    `UPDATE task_note_link SET source = 'wiki'
       WHERE source IS NULL
         AND EXISTS (
           SELECT 1 FROM task t JOIN note n ON n.id = task_note_link.note_id
            WHERE t.id = task_note_link.task_id
              AND instr(t.notes_md, '[[' || n.title || ']]') > 0
         )`
  )
  d.exec(`UPDATE task_note_link SET source = 'manual' WHERE source IS NULL`)
  // 工作流模板分类
  add('workflow_template', 'group_id', 'group_id INTEGER')
  // 保存的查询（智能清单）：把「我要看什么」固化成一条表达式
  d.exec(
    `CREATE TABLE IF NOT EXISTS saved_query (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       kind TEXT NOT NULL DEFAULT 'task',
       expr TEXT NOT NULL,
       sort_key TEXT NOT NULL DEFAULT '',
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`
  )
  d.exec(
    `CREATE TABLE IF NOT EXISTS workflow_group (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       parent_id INTEGER,
       name TEXT NOT NULL,
       sort_key TEXT NOT NULL DEFAULT '',
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`
  )
  d.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_task_external ' +
      'ON task(external_source, external_id) WHERE external_id IS NOT NULL'
  )
}

/** 建库失败时别把半成品留在数据目录，否则下次会被当成「已有库」直接用。 */
function removeDatabaseFiles(p: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(p + suffix, { force: true })
    } catch {
      // 清理失败不掩盖原始错误
    }
  }
}

export function open(): Database.Database | null {
  if (db) return db
  const p = dbPath()
  openedPath = p
  // 建库前先确保数据目录存在（递归创建）：
  // 首次运行时连数据目录都还不存在。
  try {
    mkdirSync(dirname(p), { recursive: true })
  } catch (err) {
    openError = `数据目录不可创建或不可写：${dirname(p)}（${(err as Error).message}）`
    console.error('[db]', openError)
    return null
  }
  const existed = existsSync(p)
  let creating = false
  try {
    db = new Database(p)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 4000')
    // 一张表都没有 = 全新安装（或名存实亡的 0 字节文件）：自己建库。
    // 只看文件是否存在不够——空文件一样会让整个应用只会报「no such table」。
    const tables = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
      .get() as { n: number }
    creating = tables.n === 0
    // 全新库自己建；已有库补缺表并迁移到当前 schema 版本
    if (creating) initSchema(db)
    else upgradeSchema(db)
    // 两条路径都要补：全新库的 DDL 里没有这几列，旧库也不会为它们升版本号
    ensureAppExtensions(db)
    openError = ''
    readonlyReason = ''
    return db
  } catch (err) {
    const message = (err as Error).message
    // 迁移失败 ≠ 库不可用：Database 构造期捕获 migrate_error，
    // 连接保持打开，App 进入只读模式并显示横幅 + 恢复备份入口，而不是整个应用瘫痪。
    if (!creating && db) {
      readonlyReason = message
      openError = ''
      console.error('[db] 迁移失败，进入只读模式', p, err)
      return db
    }
    console.error('[db] 打开失败', p, err)
    try {
      db?.close()
    } catch {
      // 关闭失败无关紧要
    }
    db = null
    // 只清理「本来不存在、由我们刚创建」的文件：绝不动用户已有的库
    if (creating && !existed) removeDatabaseFiles(p)
    openError = creating ? `数据库初始化失败：${p}（${message}）` : `数据库打开失败：${p}（${message}）。若库正被其它进程占用，请先关闭它再重试。`
    return null
  }
}

/** 只读模式原因（库能打开但迁移失败）；空字符串表示正常。app:info / 横幅的数据源。 */
export function dbReadonlyReason(): string {
  open()
  return readonlyReason
}

/** 最近一次打开/建库失败的中文原因（库完全不可用时非空）。 */
export function dbOpenError(): string {
  open()
  return openError
}

export function conn(): Database.Database {
  const c = open()
  if (!c) throw new Error(openError || '数据库不可用: ' + dbPath())
  return c
}

/**
 * 把任意时刻格式化成与 `nowStamp()` 相同的字符串形态。
 * 固定宽度 + 固定字段顺序 ⇒ 字典序即时间序，可直接和 DATETIME 列做字符串比较，
 * 避免解析 6 位微秒。
 */
export function stampOf(d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    pad(d.getMilliseconds() * 1000, 6)
  )
}

/**
 * 时间戳格式：`YYYY-MM-DD HH:MM:SS.ffffff`（微秒 6 位），
 * 使字符串比较与时间先后一致。
 */
export function nowStamp(): string {
  return stampOf(new Date())
}

export const today = (): string => new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD

/** 当前时刻 HH:MM（24 小时制）—— start_time / due_time 那一对的格式。 */
export const nowClock = (): string =>
  new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })

/** 关闭连接（应用退出时调用）；连接状态由 connection.ts 独占管理。 */
export function closeDb(): void {
  db?.close()
  db = null
  openedPath = ''
  // 下次打开会重新推导只读状态（恢复备份后可能已正常）
  readonlyReason = ''
  openError = ''
}

export const getTask = (id: number): Task | null =>
  (conn().prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE id = ?`).get(id) as Task | undefined) ?? null
