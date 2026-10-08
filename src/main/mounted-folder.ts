/**
 * 挂载本地文件夹：目录挂在笔记树上，文档**不入库**，每次从磁盘现读。
 *
 * 库里只留一条引用（note_folder.mount_path）—— 用户在外面增删文件，知识库跟着变，
 * 而知识库自己不需要搬家，也不会把几百个文件塞进 SQLite。
 */
import { existsSync, readdirSync, readFileSync, statSync, watch, type Dirent, type FSWatcher } from 'node:fs'
import { join, relative } from 'node:path'
import { conn } from './db/connection'
import { ensureMountNote } from './db/notes'
import { broadcastDataChanged } from './db'
import {
  MAX_MOUNT_DEPTH,
  MAX_MOUNT_ENTRIES,
  MAX_PREVIEW_BYTES,
  isSafeRelPath,
  mountNodeId,
  mountNameOf,
  previewKindOf,
  shouldSkipMountEntry,
  sortMountEntries,
  type MountEntry,
} from '../shared/mounted-folder'

export interface MountedFolder {
  id: number
  name: string
  path: string
}

/** 所有挂载点（mount_path 非空的 note_folder 行）。 */
export function listMountedFolders(): MountedFolder[] {
  const rows = conn()
    .prepare('SELECT id, name, mount_path FROM note_folder WHERE mount_path IS NOT NULL ORDER BY sort ASC, id ASC')
    .all() as { id: number; name: string; mount_path: string }[]
  return rows.map((r) => ({ id: r.id, name: r.name, path: r.mount_path }))
}

export function getMountPath(folderId: number): string | null {
  const row = conn().prepare('SELECT mount_path FROM note_folder WHERE id = ? AND mount_path IS NOT NULL').get(folderId) as
    | { mount_path: string }
    | undefined
  return row ? row.mount_path : null
}

/** 挂载一个目录：建一个 note_folder 行并记下路径。返回新文件夹 id。 */
export function mountFolder(absPath: string, parentId: number | null): number | null {
  const path = (absPath ?? '').trim()
  if (!path || !existsSync(path)) return null
  try {
    if (!statSync(path).isDirectory()) return null
  } catch {
    return null
  }
  // 同一个路径只挂一次：重复挂载只会在树里堆出一串同名节点
  const dup = conn().prepare('SELECT id FROM note_folder WHERE mount_path = ?').get(path) as { id: number } | undefined
  if (dup) return dup.id
  const info = conn()
    .prepare('INSERT INTO note_folder (parent_id, name, sort, mount_path) VALUES (?, ?, ?, ?)')
    .run(parentId, mountNameOf(path), Date.now(), path)
  const id = Number(info.lastInsertRowid)
  refreshMountWatches()
  return id
}

/** 卸载：删掉那个文件夹行。磁盘上的东西一个都不动。 */
export function unmountFolder(folderId: number): boolean {
  const info = conn().prepare('DELETE FROM note_folder WHERE id = ? AND mount_path IS NOT NULL').run(folderId)
  if (info.changes > 0) {
    refreshMountWatches()
    return true
  }
  return false
}

/** 递归扫描挂载目录。目录不存在（被移走/改名）时返回空数组，界面上会显示成空文件夹。 */
/**
 * 按挂载点 id 扫描。
 *
 * **目录已经不在就顺手把挂载点删掉** —— 用户在外面把整个文件夹删了/移走了，
 * 树里留一个永远空着的节点只会让人困惑（用户明确要求：外面删掉目录就同步删挂载点）。
 * 删完广播 note 域，让树自己收敛。
 */
export function scanMountById(folderId: number): MountEntry[] {
  const path = getMountPath(folderId)
  if (!path) return []
  if (!existsSync(path)) {
    unmountFolder(folderId)
    broadcastDataChanged('note')
    return []
  }
  return scanMount(path)
}

/**
 * 所有挂载点的条目，**一次给全**。
 *
 * 渲染层不能在循环里逐条 IPC（architecture.test 的硬约束：N 个挂载点就是 N 次往返，
 * 而每一次都要落回主线程重扫磁盘）—— 该循环在进程内跑完，只过一次 IPC。
 */
export function scanAllMounts(): Record<number, MountEntry[]> {
  const out: Record<number, MountEntry[]> = {}
  for (const m of listMountedFolders()) out[m.id] = scanMountById(m.id)
  return out
}

export function scanMount(root: string): MountEntry[] {
  const out: MountEntry[] = []
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > MAX_MOUNT_DEPTH || out.length >= MAX_MOUNT_ENTRIES) return
    let items: Dirent[]
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 权限不足或目录刚被删：跳过这一层，别把整次扫描搞崩
    }
    for (const it of items) {
      if (out.length >= MAX_MOUNT_ENTRIES) return
      if (shouldSkipMountEntry(it.name)) continue
      const rel = prefix ? prefix + '/' + it.name : it.name
      const full = join(dir, it.name)
      let isDir = false
      let size = 0
      let mtime = 0
      try {
        const st = statSync(full)
        isDir = st.isDirectory()
        size = st.size
        mtime = st.mtimeMs
      } catch {
        continue // 断链的符号链接之类
      }
      out.push({ relPath: rel, name: it.name, isDir, size, mtime })
      if (isDir) walk(full, rel, depth + 1)
    }
  }
  walk(root, '', 0)
  return sortMountEntries(out)
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
}

export interface MountPreview {
  kind: 'text' | 'image' | 'none'
  name: string
  size: number
  text?: string
  dataUrl?: string
  tooLarge?: boolean
}

/**
 * 读一个挂载文件用于**只读预览**。
 * 两道路径防线：isSafeRelPath 挡掉 .. 与绝对路径；拼完之后再复核结果仍在根目录内。
 */
export function readMountFile(root: string, relPath: string): MountPreview | null {
  if (!isSafeRelPath(relPath)) return null
  const full = join(root, ...relPath.split('/'))
  const rel = relative(root, full)
  if (!rel || rel.startsWith('..')) return null
  let size = 0
  try {
    const st = statSync(full)
    if (st.isDirectory()) return null
    size = st.size
  } catch {
    return null
  }
  const kind = previewKindOf(relPath)
  if (kind === 'none') return { kind, name: relPath, size }
  // 大文件不读进内存：预览是给人看的，1MB 的文本已经没人会读完
  if (size > MAX_PREVIEW_BYTES) return { kind, name: relPath, size, tooLarge: true }
  try {
    if (kind === 'text') return { kind, name: relPath, size, text: readFileSync(full, 'utf8') }
    const ext = /\.([a-z0-9]+)$/i.exec(relPath)?.[1]?.toLowerCase() ?? ''
    const mime = MIME[ext] ?? 'application/octet-stream'
    return { kind, name: relPath, size, dataUrl: 'data:' + mime + ';base64,' + readFileSync(full).toString('base64') }
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------- 监听 */

let watchers: FSWatcher[] = []
let watchSig = ''
let pending: NodeJS.Timeout | null = null

/**
 * 按当前挂载点重建 watcher（幂等：目标没变就什么都不做）。
 *
 * recursive: true —— 需求本身就是「递归包括子文件夹」。Windows 与 macOS 的原生实现支持它。
 * 事件先攒 300ms 再广播：一次解压/批量拷贝会打出几百个事件，逐个广播只会让界面反复重扫。
 */
export function refreshMountWatches(): void {
  // 先收掉**路径已经不在了**的挂载点（目录被删/移走、U 盘拔了）。
  // 放在这里而不是只放在 watcher 回调里：启动时没人给事件，只有这一趟能发现它们 ——
  // 否则树里会永远留着几个点不开的空节点。
  for (const m of listMountedFolders()) {
    if (!existsSync(m.path)) unmountFolder(m.id)
  }
  const mounts = listMountedFolders()
  const sig = mounts.map((m) => m.id + ':' + m.path).join('|')
  if (sig === watchSig) return
  watchSig = sig
  for (const w of watchers) {
    try {
      w.close()
    } catch {
      // 目录已经没了时 close 会抛：我们要的只是「不再有 watcher」
    }
  }
  watchers = []
  for (const m of mounts) {
    try {
      const w = watch(m.path, { recursive: true, persistent: false }, () => {
        // 目录被整个删掉/移走时也要收场：Windows 在这种情况下给的是一个普通事件
        //（或 watcher 报错），而不是「这里少了个挂载点」—— 所以每次动静都顺手确认根还在不在。
        // 光靠 scanMountById 不够：那是**被调用时**才检查，而目录没了之后没人会再调它。
        if (!existsSync(m.path)) {
          unmountFolder(m.id)
          broadcastDataChanged('note')
          return
        }
        scheduleBroadcast()
      })
      w.on('error', () => {
        // 监视中断（目录被删、U 盘拔出）：确认根还在不在，不在了就把挂载点收掉；
        // 无论哪种情况都不该把应用带崩，下一次 refreshMountWatches 会重建。
        if (!existsSync(m.path)) {
          unmountFolder(m.id)
          broadcastDataChanged('note')
        }
      })
      watchers.push(w)
    } catch {
      // 目录不可监视：挂载点照样显示，只是不自动刷新
    }
  }
  if (mounts.length) console.log('[mount] 监视 ' + watchers.length + ' 个挂载目录')
}

function scheduleBroadcast(): void {
  if (pending) clearTimeout(pending)
  pending = setTimeout(() => {
    pending = null
    // 走 note 域：挂载点就是 note_folder，渲染层订阅 note 后重拉树
    broadcastDataChanged('note')
  }, 300)
  pending.unref?.()
}

/** 应用退出时收掉 watcher（persistent:false 其实也会让进程退出，这里只是显式一点）。 */
export function stopMountWatches(): void {
  for (const w of watchers) {
    try {
      w.close()
    } catch {
      // 同上
    }
  }
  watchers = []
  watchSig = ''
}
/* ------------------------------------------------- 虚拟节点 ↔ 真实引用行 */

/**
 * 虚拟节点 id → 挂载文件的登记表（内存，不落库）。
 *
 * `mountNodeId` 是**稳定哈希、不可反推**（见 shared/mounted-folder 的注释），所以
 * 「负数 id → 这是哪个挂载点的哪个文件」必须靠一张表。表在生成候选项与扫描时填充 ——
 * 选择器看到的每个负数 id 都在这里，关联时就能还原成真实 note id。
 */
const nodeRegistry = new Map<number, { folderId: number; relPath: string }>()

export function resolveMountNode(nodeId: number): { folderId: number; relPath: string } | null {
  return nodeRegistry.get(nodeId) ?? null
}

/**
 * 选择器/引用面板用：所有挂载点下的**文件**（跳过目录），带虚拟 id。
 *
 * 一次给全（渲染层不许在循环里逐条 IPC），顺便把登记表填满。
 */
export function mountPickerItems(): { nodeId: number; folderId: number; relPath: string; name: string; isDir: boolean }[] {
  const out: { nodeId: number; folderId: number; relPath: string; name: string; isDir: boolean }[] = []
  for (const m of listMountedFolders()) {
    for (const e of scanMountById(m.id)) {
      const nodeId = mountNodeId(m.id, e.relPath)
      nodeRegistry.set(nodeId, { folderId: m.id, relPath: e.relPath })
      out.push({ nodeId, folderId: m.id, relPath: e.relPath, name: e.name, isDir: e.isDir })
    }
  }
  return out
}

/**
 * 把虚拟节点 id 解析成**真实的 note id**（懒建那条引用行）。
 *
 * 这是「挂载文件按正常笔记对待」的关键一步：引用表要的是真 id，而选择器给的是虚拟 id。
 */
export function ensureMountNoteByNode(nodeId: number): number | null {
  const hit = resolveMountNode(nodeId)
  if (!hit) return null
  return ensureMountNote(hit.folderId, hit.relPath)?.id ?? null
}

/** 已建好的挂载引用行里，来源已经失效的那些（挂载点已删/已卸载）。 */
export function staleMountNotes(): { id: number; title: string; mount_ref: string }[] {
  const alive = new Set(listMountedFolders().map((m) => m.id))
  const rows = conn()
    .prepare("SELECT id, title, mount_ref FROM note WHERE mount_ref IS NOT NULL AND deleted_at IS NULL")
    .all() as { id: number; title: string; mount_ref: string }[]
  return rows.filter((r) => {
    const folderId = Number((r.mount_ref || '').split(':')[0])
    return !Number.isFinite(folderId) || !alive.has(folderId)
  })
}