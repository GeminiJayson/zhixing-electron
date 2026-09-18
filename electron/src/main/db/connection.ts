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
    openError = ''
    return db
  } catch (err) {
    console.error('[db] 打开失败', p, err)
    try {
      db?.close()
    } catch {
      // 关闭失败无关紧要
    }
    db = null
    // 只清理「本来不存在、由我们刚创建」的文件：绝不动用户已有的库
    if (creating && !existed) removeDatabaseFiles(p)
    openError = creating
      ? `数据库初始化失败：${p}（${(err as Error).message}）`
      : `数据库打开失败：${p}（${(err as Error).message}）。若同时开着 Python 版，请先关闭它。`
    return null
  }
}

export function conn(): Database.Database {
  const c = open()
  if (!c) throw new Error(openError || '数据库不可用: ' + dbPath())
  return c
}

/**
 * 时间戳必须是 Python `datetime.now()` 的默认字符串形态（微秒 6 位），
 * 否则 SQLAlchemy 之后再读这一列会解析失败。
 */
export function nowStamp(): string {
  const d = new Date()
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    pad(d.getMilliseconds() * 1000, 6)
  )
}

export const today = (): string => new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD

/** 关闭连接（应用退出时调用）；连接状态由 connection.ts 独占管理。 */
export function closeDb(): void {
  db?.close()
  db = null
  openedPath = ''
}

export const getTask = (id: number): Task | null =>
  (conn().prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE id = ?`).get(id) as Task | undefined) ?? null
