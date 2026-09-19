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
 * 与 Python 版 db.py 的 data_dir() 逐条对齐：ZHIXING_HOME 环境变量优先，
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

export const TASK_COLUMNS = `id, title, notes_md, status, priority, due_date, start_date, reminder_at,
  list_id, parent_id, repeat_period, repeat_rule, streak, sort_key, resume_at, last_reset_date,
  completed_at, created_at, updated_at`

/** 最近一次打开/建库失败的原因：给出可操作的中文，而不是笼统的「不可用」。 */
let openError = ''

/**
 * 只读模式原因（对齐 Python 的 #12：Database.migrate_error）。
 * 迁移失败时连接照常打开并记录原因，应用不崩、显示只读横幅 + 恢复备份入口。
 * 空字符串表示正常可写。
 */
let readonlyReason = ''

/**
 * 首次运行建库：等价于 Python 版的 create_all + FTS DDL + 写 schema_version。
 * 两版因此打开的是同一套 schema，之后 Python 版再打开不会触发迁移。
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

/** 迁移前强制备份（对齐 Python：备份失败就中止，绝不冒险改主库）。 */
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
 * 打开已有库时的 schema 维护，对应 Python 的 Database.migrate()：
 *   1. 先补建缺失的表（DDL 已带 IF NOT EXISTS，等价 create_all 只建缺表）
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
 * 本应用私有的附加列 —— **不属于** Python 的迁移链（MIGRATIONS / SCHEMA_VERSION）。
 *
 * 为什么不并进 MIGRATIONS：那是一条与 Python 版逐号对齐的链，编号被两边共用；
 * 在这里插号会让先升级的一方写出另一方读不懂的 schema_version。
 * 而这几列是纯粹的 Electron 侧功能（多绑 SOP、自动步骤的期望值、上一步结果），
 * Python 端不认识它们也无害：SELECT 都是显式列名，多出来的列不会被读，且全部可空。
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
  add('workflow_instance', 'last_result', 'last_result TEXT')
  // 外部任务来源：靠 (source, id) 幂等认领，重复同步不会造出重复任务
  add('task', 'external_source', 'external_source TEXT')
  add('task', 'external_id', 'external_id TEXT')
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
  // 与 Python 版 data_dir() 的 mkdir(parents=True, exist_ok=True) 对齐：
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
    // 迁移失败 ≠ 库不可用（对齐 Python #12）：Database 构造期捕获 migrate_error，
    // 连接保持打开，App 进入只读模式并显示横幅 + 恢复备份入口，而不是整个应用瘫痪（D2）。
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
    openError = creating ? `数据库初始化失败：${p}（${message}）` : `数据库打开失败：${p}（${message}）。若同时开着 Python 版，请先关闭它。`
    return null
  }
}

/** 只读模式原因（库能打开但迁移失败）；空字符串表示正常。D2 的 app:info / 横幅数据源。 */
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
 * 避免解析 6 位微秒（对齐 D12 的 `deleted_at < now - days` 口径）。
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
 * 时间戳必须是 Python `datetime.now()` 的默认字符串形态（微秒 6 位），
 * 否则 SQLAlchemy 之后再读这一列会解析失败。
 */
export function nowStamp(): string {
  return stampOf(new Date())
}

export const today = (): string => new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD

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
