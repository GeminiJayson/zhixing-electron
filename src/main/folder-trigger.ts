/**
 * 目录变化触发：盯住模板指定的目录，出现新文件就启动流程（trigger_kind='folder'）。
 *
 * 用 fs.watch 而不是轮询：目录是用户的真实目录（下载、收件箱、扫描件落盘处），
 * 轮询整个目录既慢又吵；fs.watch 在 Windows/macOS 上是系统事件，代价接近零。
 * 代价是它不保证事件不重复、也可能给不出文件名 —— 这两点分别由
 * folder-watch-plan 的去抖与"没文件名就不猜"挡住。
 *
 * 目录不存在（外接盘没插、路径写错）不该拦住应用启动：记一行日志，跳过这个目录，
 * 下次 refresh 时它要是又在了，会重新被盯上。
 */
import { watch, type FSWatcher } from 'node:fs'
import { instantiateWorkflow } from './db/workflow'
import { groupByDir, planFolderHits, watchSignature, type FolderTarget } from './folder-watch-plan'

let watchers: FSWatcher[] = []
let signature = ''
/** 文件 -> 上次触发时刻，跨 refresh 保留（重建 watcher 不该让去抖失效） */
const seen = new Map<string, number>()

/** 按最新目标集合重建 watcher。目标没变时什么都不做（每分钟调一次也安全）。 */
export function refreshFolderWatches(targets: FolderTarget[]): void {
  const sig = watchSignature(targets)
  if (sig === signature) return
  signature = sig
  for (const w of watchers) {
    try {
      w.close()
    } catch {
      // 目录已经被删掉时 close 可能抛，忽略：我们要的是"不再有 watcher"
    }
  }
  watchers = []
  for (const { dir, targets: list } of groupByDir(targets)) {
    try {
      const w = watch(dir, { persistent: false }, (_event, fileName) => {
        fire(list, fileName ?? null)
      })
      w.on('error', (err) => {
        console.error(`[wf] 目录监视中断：${dir}`, err)
      })
      watchers.push(w)
    } catch (err) {
      console.error(`[wf] 目录监视启动失败：${dir}`, err)
    }
  }
  if (targets.length) console.log(`[wf] 目录触发：盯住 ${watchers.length} 个目录`)
}

function fire(targets: FolderTarget[], fileName: string | null): void {
  try {
    const hits = planFolderHits(targets, fileName, Date.now(), seen)
    for (const hit of hits) {
      // 不 await：流程可能跑很久，watcher 的回调不该被它堵住
      void instantiateWorkflow(hit.id, null, null, undefined, 'folder').then((inst) => {
        if (inst) console.log(`[wf] 目录里出现 ${fileName} → 启动「${hit.name}」→ 实例 #${inst.id}`)
      })
    }
  } catch (err) {
    // 一次事件处理失败不能把 watcher 打死
    console.error('[wf] 目录触发处理失败', err)
  }
}

export function stopFolderWatches(): void {
  for (const w of watchers) {
    try {
      w.close()
    } catch {
      // 同上：已经关掉的再关一次无所谓
    }
  }
  watchers = []
  signature = ''
}
