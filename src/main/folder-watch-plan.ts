/**
 * 目录触发的「该不该启动」判断 —— 纯函数，定时器与 fs.watch 只负责喂它数据。
 *
 * 分开的理由与 workflow-scheduler 一样：判断本身（文件名匹不匹配、这条事件是不是
 * 同一个文件在几百毫秒内的重复事件）是逻辑，而 fs.watch 是环境。
 * 混在一起只能靠"手动往目录里丢个文件看看"来测。
 */
import { isWatchedFileName, matchFileName, type WorkflowTrigger } from '../shared/workflow-trigger'

export interface FolderTarget {
  /** 模板 id */
  id: number
  name: string
  /** 盯的目录（绝对路径） */
  dir: string
  /** 文件名通配，空 = 任何文件 */
  pattern: string
}

/** 同一次保存会来好几个事件（change + rename，甚至每个写块一次）；这段时间内只算一次 */
export const FOLDER_DEBOUNCE_MS = 1500

/** 从模板的触发器数组里挑出目录触发，展平成"一个目录一条"的清单。 */
export function folderTargetsOf(
  templates: { id: number; name: string; triggers: WorkflowTrigger[] }[]
): FolderTarget[] {
  const out: FolderTarget[] = []
  for (const t of templates) {
    for (const tr of t.triggers) {
      if (tr.kind !== 'folder') continue
      const dir = (tr.path ?? '').trim()
      if (!dir) continue
      out.push({ id: t.id, name: t.name, dir, pattern: (tr.pattern ?? '').trim() })
    }
  }
  return out
}

/** 按目录聚合：同一个目录被多个模板盯着时，只开一个 watcher。 */
export function groupByDir(targets: FolderTarget[]): { dir: string; targets: FolderTarget[] }[] {
  const byDir = new Map<string, FolderTarget[]>()
  for (const t of targets) {
    const list = byDir.get(t.dir)
    if (list) list.push(t)
    else byDir.set(t.dir, [t])
  }
  return [...byDir].map(([dir, list]) => ({ dir, targets: list }))
}

/** 重建 watcher 前比对的签名：模板/目录/模式变了才重建，否则每次都重建会漏事件。 */
export function watchSignature(targets: FolderTarget[]): string {
  return targets
    .map((t) => `${t.id}\u0000${t.dir}\u0000${t.pattern}`)
    .sort()
    .join('\u0001')
}

/**
 * 这次文件事件该启动哪些模板。
 *
 * seen 是"文件 -> 上次触发时刻"的账本，由调用方持有（跨事件）。
 * 不在这个函数里存模块级状态：那样单测之间会互相污染，也没法假装时间流逝。
 */
export function planFolderHits(
  targets: FolderTarget[],
  fileName: string | null,
  now: number,
  seen: Map<string, number>
): FolderTarget[] {
  // fs.watch 在某些平台上不给文件名（filename 为 null）——那就不猜，直接不触发
  if (!fileName) return []
  if (!isWatchedFileName(fileName)) return []
  const hits: FolderTarget[] = []
  for (const t of targets) {
    if (!matchFileName(fileName, t.pattern)) continue
    const key = `${t.id}\u0000${t.dir}\u0000${fileName}`
    const last = seen.get(key)
    if (last !== undefined && now - last < FOLDER_DEBOUNCE_MS) continue
    seen.set(key, now)
    hits.push(t)
  }
  if (seen.size > 500) {
    // 账本别无限长：按时刻排序，砍掉最旧的一半
    const sorted = [...seen].sort((a, b) => a[1] - b[1])
    for (const [k] of sorted.slice(0, sorted.length - 250)) seen.delete(k)
  }
  return hits
}
