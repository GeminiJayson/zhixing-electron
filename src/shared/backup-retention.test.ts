import { describe, expect, it } from 'vitest'
import { parseBackupStamp, pickBackupsToDelete } from './backup-retention'

/**
 * 备份保留策略。
 *
 * 原实现是 \`readdirSync().filter(.db).sort().reverse().slice(keep)\` —— 对文件名整体做字典序排序。
 * 而文件名形如 \`<reason>-<YYYYMMDDhhmmss>.db\`，于是排序**先按 reason 分组**：
 * \`auto-*\` 永远排在 \`pre-restore-*\` 前面（reverse 后就在后面，正好落进要删的那一段）。
 *
 * 后果：只要 pre-* 类备份攒够 keep 份，**所有自动备份都会被删掉 —— 哪怕它们是最新的**。
 * 自动备份才是日常那份（每次启动 + 跨天），pre-* 只是某一刻的手动动作快照。
 */
describe('parseBackupStamp —— 从文件名取出时间戳', () => {
  it('认得出三种 reason 前缀', () => {
    expect(parseBackupStamp('auto-20260101120000.db')).toBe('20260101120000')
    expect(parseBackupStamp('pre-restore-20260101120000.db')).toBe('20260101120000')
    expect(parseBackupStamp('pre-import-20260101120000.db')).toBe('20260101120000')
  })

  it('认不出的命名返回空串，不硬凑', () => {
    expect(parseBackupStamp('backup.db')).toBe('')
    expect(parseBackupStamp('zhixing.db')).toBe('')
  })
})

describe('pickBackupsToDelete —— 保的必须是「最近 N 份」', () => {
  it('最新的自动备份不能被较老的 pre-* 挤掉（这正是原实现的缺陷）', () => {
    const files = [
      'pre-restore-20260101000000.db',
      'pre-restore-20260102000000.db',
      'pre-restore-20260103000000.db',
      'auto-20260110000000.db',
      'auto-20260111000000.db',
      'auto-20260112000000.db',
    ]
    const del = pickBackupsToDelete(files, 3)
    // 该删的是最老的三份（全是 pre-restore），而不是更新的 auto
    expect(del.sort()).toEqual([
      'pre-restore-20260101000000.db',
      'pre-restore-20260102000000.db',
      'pre-restore-20260103000000.db',
    ])
  })

  it('把原实现的行为写进对照，说明缺陷确实存在', () => {
    const files = [
      'pre-restore-20260101000000.db',
      'pre-restore-20260102000000.db',
      'pre-restore-20260103000000.db',
      'auto-20260110000000.db',
      'auto-20260111000000.db',
      'auto-20260112000000.db',
    ]
    const legacy = files.slice().sort().reverse().slice(3)
    // 旧的按整串字典序：保留的全是 pre-*，被删的全是更新的 auto-*
    expect(legacy.every((f) => f.startsWith('auto-'))).toBe(true)
  })

  it('混合命名时按时间戳统一排序', () => {
    const files = [
      'auto-20260105000000.db',
      'pre-import-20260103000000.db',
      'pre-restore-20260104000000.db',
      'auto-20260106000000.db',
    ]
    expect(pickBackupsToDelete(files, 2).sort()).toEqual([
      'pre-import-20260103000000.db',
      'pre-restore-20260104000000.db',
    ])
  })

  it('数量不超过 keep 时一份都不删', () => {
    const files = ['auto-20260101000000.db', 'auto-20260102000000.db']
    expect(pickBackupsToDelete(files, 10)).toEqual([])
    expect(pickBackupsToDelete([], 10)).toEqual([])
  })

  it('认不出时间戳的文件按 mtime 兜底，且排在有时戳的之后', () => {
    const files = ['auto-20260101000000.db', 'legacy-backup.db', 'auto-20260102000000.db']
    // legacy 认不出时间戳；给它的 mtime 设为最老
    const del = pickBackupsToDelete(files, 2, { 'legacy-backup.db': 1000 })
    expect(del).toEqual(['legacy-backup.db'])
  })

  it('只认 .db，目录里的其它文件不参与裁剪', () => {
    const files = ['auto-20260101000000.db', 'notes.txt', 'auto-20260102000000.db']
    expect(pickBackupsToDelete(files, 1)).toEqual(['auto-20260101000000.db'])
  })
})
