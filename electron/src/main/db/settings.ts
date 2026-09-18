import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { conn } from './connection'
import { DEFAULT_SETTINGS } from '../../shared/settings'

// ---------------------------------------------------------------- 设置

/** settings 表是键值对，Python 版与 Electron 版共用同一份，切换客户端时偏好一致。 */
export function listSettings(): Record<string, string> {
  const rows = conn().prepare('SELECT key, value FROM settings').all() as {
    key: string
    value: string | null
  }[]
  const out: Record<string, string> = {}
  for (const r of rows) out[r.key] = r.value ?? ''
  return out
}

/**
 * 把默认设置写入 settings 表（对齐 Python 的 ensure_defaults）。
 * 只补缺失的键，绝不覆盖用户已改过的值 —— 两个客户端因此看到同一组默认。
 */
export function ensureDefaultSettings(): number {
  const c = conn()
  const stmt = c.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
  )
  const run = c.transaction(() => {
    let n = 0
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) n += stmt.run(key, value).changes
    return n
  })
  return run()
}

export function setSetting(key: string, value: string): number {
  const clean = String(key ?? '').trim()
  if (!clean) return 0
  return conn()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(clean, String(value ?? '')).changes
}

export function setSettings(entries: Record<string, string>): number {
  const c = conn()
  const stmt = c.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  const tx = c.transaction((pairs: [string, string][]) => {
    let n = 0
    for (const [k, v] of pairs) {
      if (!String(k ?? '').trim()) continue
      n += stmt.run(String(k).trim(), String(v ?? '')).changes
    }
    return n
  })
  return tx(Object.entries(entries))
}

/** 备份当前数据库到仓库内的 backups/electron/（用 SQLite 的 VACUUM INTO 保证一致性）。 */
export function backupDatabase(targetDir: string): { path: string; bytes: number } | null {
  const c = conn()
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14)
  const file = join(targetDir, `zhixing-electron-${stamp}.db`)
  mkdirSync(targetDir, { recursive: true })
  c.prepare('VACUUM INTO ?').run(file)
  return { path: file, bytes: statSync(file).size }
}
