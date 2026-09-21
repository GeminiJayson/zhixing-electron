/**
 * 备份保留策略：决定「最近 N 份」里哪些该删。
 *
 * 为什么抽成独立的纯函数：原实现在 backup.ts 里，那要 \`conn()\`（better-sqlite3 是 Electron ABI），
 * vitest 里拿不到连接 —— 而这段逻辑恰恰出过一个**静默删掉用户数据**的缺陷，最需要被钉住。
 *
 * 文件名形如 \`<reason>-<YYYYMMDDhhmmss>.db\`，reason ∈ auto / pre-restore / pre-import。
 */

/** 从文件名尾部取出 14 位时间戳；认不出返回空串（不硬凑）。 */
export function parseBackupStamp(file: string): string {
  const m = /-(\d{14})\.db$/.exec(file)
  return m ? m[1] : ''
}

/**
 * 把备份文件按「最新在前」排好序。
 *
 * 关键：**不能对文件名整体做字典序排序**。那样会先按 reason 前缀分组 ——
 * \`auto-*\` 永远排在 \`pre-*\` 之前，反向取值就成了「优先删掉自动备份」，
 * 而自动备份才是每次启动 / 跨天那份日常快照，pre-* 只是某一刻手动动作的快照。
 * 旧的实现注释还写着「按名倒序即时间倒序」，那是错的。
 *
 * @param mtimes 认不出时间戳的文件用它兜底（旧的、手工改名过的备份）
 */
export function rankBackups(
  files: string[],
  mtimes: Record<string, number> = {}
): string[] {
  const dbs = files.filter((f) => f.endsWith('.db'))
  return dbs.slice().sort((a, b) => {
    const sa = parseBackupStamp(a)
    const sb = parseBackupStamp(b)
    // 有时间戳的一律排在没时间戳的前面（保留优先）
    if (sa && sb) return sa < sb ? 1 : sa > sb ? -1 : 0
    if (sa) return -1
    if (sb) return 1
    // 都认不出：按 mtime，新的在前
    return (mtimes[b] ?? 0) - (mtimes[a] ?? 0)
  })
}

/** 挑出该删除的备份：排好序之后，keep 之后的全删。 */
export function pickBackupsToDelete(
  files: string[],
  keep: number,
  mtimes: Record<string, number> = {}
): string[] {
  return rankBackups(files, mtimes).slice(Math.max(0, keep))
}
