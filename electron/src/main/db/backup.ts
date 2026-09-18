/**
 * 数据库备份与恢复（对齐 Python 的 model/infrastructure/backup.py）。
 *
 * Python 的行为：启动自动备份一次、只保留最近 10 份、恢复前先给当前库再备份一份。
 * 此前 Electron 只有「手动导出到用户指定目录」，既没有历史快照也没有一键恢复，
 * 一次误操作或库损坏就不可回滚。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { closeDb, conn, dataDir, dbPath } from './connection'

/** 保留的备份份数（对齐 BackupService.MAX_KEEP）。 */
export const BACKUP_KEEP = 10

export interface BackupEntry {
  name: string
  path: string
  bytes: number
  mtime: number
}

/** 自动备份目录：数据目录下的 backups/（与 Python 的 db.path.parent/'backups' 一致）。 */
export function backupDir(): string {
  return join(dataDir(), 'backups')
}

/** 只保留最近 keep 份（文件名带时间戳，按名倒序即时间倒序）。 */
export function pruneBackups(dir: string, keep = BACKUP_KEEP): number {
  let removed = 0
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.db'))
      .sort()
      .reverse()
    for (const f of files.slice(keep)) {
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
 * 一致性快照：VACUUM INTO 等价 Python 的 sqlite backup API（WAL 下也安全），
 * 完成后按 BACKUP_KEEP 清理。返回备份文件路径，失败返回 null。
 */
export function autoBackup(reason: 'auto' | 'pre-restore' | 'before-import' = 'auto'): string | null {
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
    return readdirSync(dir)
      .filter((f) => f.endsWith('.db'))
      .sort()
      .reverse()
      .map((f) => {
        const p = join(dir, f)
        const st = statSync(p)
        return { name: f, path: p, bytes: st.size, mtime: st.mtimeMs }
      })
  } catch {
    return []
  }
}

/**
 * 用某个备份覆盖主库（对齐 BackupService.restore）：
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
