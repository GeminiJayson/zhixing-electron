/**
 * 数据库备份与恢复。
 *
 * 备份行为：启动自动备份一次、只保留最近 10 份、恢复前先给当前库再备份一份。
 * 此前 Electron 只有「手动导出到用户指定目录」，既没有历史快照也没有一键恢复，
 * 一次误操作或库损坏就不可回滚。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseBackupStamp, pickBackupsToDelete, rankBackups } from '../../shared/backup-retention'
import { closeDb, conn, dataDir, dbPath } from './connection'

/** 保留的备份份数。 */
export const BACKUP_KEEP = 10

export interface BackupEntry {
  name: string
  path: string
  bytes: number
  mtime: number
}

/** 自动备份目录：数据目录下的 backups/。 */
export function backupDir(): string {
  return join(dataDir(), 'backups')
}

/**
 * 只保留最近 keep 份。
 *
 * 判断「最近」用的是文件名尾部的 14 位时间戳，**不是整个文件名的字典序**。
 * 字典序会先按 reason 前缀分组（auto-* 永远排在 pre-* 之前），把「保留最近 10 份」
 * 变成「优先删掉自动备份」—— 而自动备份才是每次启动 / 跨天那份日常快照。
 * 挑选逻辑在 shared/backup-retention.ts，那里有单测钉住。
 */
export function pruneBackups(dir: string, keep = BACKUP_KEEP): number {
  let removed = 0
  try {
    const files = readdirSync(dir)
    // 认不出时间戳的（旧命名 / 被手工改过）用 mtime 兜底
    const mtimes: Record<string, number> = {}
    for (const f of files) {
      if (!f.endsWith('.db') || parseBackupStamp(f)) continue
      try {
        mtimes[f] = statSync(join(dir, f)).mtimeMs
      } catch {
        mtimes[f] = 0
      }
    }
    for (const f of pickBackupsToDelete(files, keep, mtimes)) {
      try {
        rmSync(join(dir, f), { force: true })
        removed += 1
      } catch {
        // 单个文件删不掉不影响其它清理
      }
    }
  } catch {
    // 目录不存在等情况直接返回
  }
  return removed
}

/**
 * 一致性快照：VACUUM INTO（等价 sqlite backup API，WAL 下也安全），
 * 完成后按 BACKUP_KEEP 清理。返回备份文件路径，失败返回 null。
 */
export function autoBackup(reason: 'auto' | 'pre-restore' | 'pre-import' = 'auto'): string | null {
  const dir = backupDir()
  try {
    mkdirSync(dir, { recursive: true })
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 14)
    const file = join(dir, `${reason}-${stamp}.db`)
    conn().prepare('VACUUM INTO ?').run(file)
    pruneBackups(dir)
    return file
  } catch (err) {
    console.error('[backup] 自动备份失败', err)
    return null
  }
}

/** 备份列表：最新在前。 */
export function listBackups(): BackupEntry[] {
  const dir = backupDir()
  if (!existsSync(dir)) return []
  try {
    // 与 pruneBackups 用同一套排序：整串字典序会把 pre-* 排到更新的 auto-* 前面，
    // 列表里的「最新」也会指错
    return rankBackups(readdirSync(dir)).map((f) => {
      const p = join(dir, f)
      const st = statSync(p)
      return { name: f, path: p, bytes: st.size, mtime: st.mtimeMs }
    })
  } catch {
    return []
  }
}

/**
 * 用某个备份覆盖主库：
 * 先给当前库再留一份 pre-restore 备份，再覆盖并清掉 WAL 残留。
 * 恢复后连接已关闭，后续访问会自动重新打开（内容是备份里的那份）。
 */
export function restoreBackup(file: string): { ok: boolean; message: string } {
  if (!existsSync(file)) return { ok: false, message: '备份文件不存在' }
  const p = dbPath()
  if (!autoBackup('pre-restore')) {
    return { ok: false, message: '恢复前备份失败，已中止以免丢数据' }
  }
  try {
    closeDb()
    copyFileSync(file, p)
    for (const suffix of ['-wal', '-shm']) {
      try {
        rmSync(p + suffix, { force: true })
      } catch {
        // 不存在则忽略
      }
    }
    return { ok: true, message: '已从备份恢复，请重启应用以加载' }
  } catch (err) {
    return { ok: false, message: '恢复失败：' + (err as Error).message }
  }
}
