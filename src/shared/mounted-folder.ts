/**
 * 「挂载本地文件夹」的纯逻辑。
 *
 * 语义：把一个**本地目录**挂到笔记树上，目录里的文档**不入库** —— 库里只留
 * 「这个文件夹节点指向哪个路径」这一条引用，内容每次都从磁盘现读。
 * 这样用户在外面增删文件，知识库里就能看到，而知识库不需要跟着搬家。
 *
 * 抽到 shared 是因为过滤与排序是纯函数（能单测），主进程只负责 IO。
 */
export interface MountEntry {
  /** 相对挂载根的路径，用 / 分隔（跨平台一致，也是渲染层的 key） */
  relPath: string
  name: string
  isDir: boolean
  size: number
  mtime: number
}

/** 扫描上限：一次最多列出这么多条目，防着有人挂载 C:\ 或上万个文件的目录。 */
export const MAX_MOUNT_ENTRIES = 3000
/** 预览上限：超过这个大小只显示"太大，不预览"。 */
export const MAX_PREVIEW_BYTES = 1024 * 1024
/** 递归深度上限：防符号链接成环把扫描拖死。 */
export const MAX_MOUNT_DEPTH = 12

/**
 * 这些条目**不列**：点开头的是惯例上的隐藏项（.git、.DS_Store），
 * node_modules 与系统目录一进去就是几万个文件 —— 挂载一个项目目录时，
 * 用户要的是看文档，不是看依赖树。
 */
const SKIP_NAMES = new Set(['node_modules', '__pycache__', 'System Volume Information', '$RECYCLE.BIN'])

export function shouldSkipMountEntry(name: string): boolean {
  if (!name) return true
  if (name.startsWith('.')) return true
  return SKIP_NAMES.has(name)
}

/**
 * 排序：**同级目录在前，再按名字**（不区分大小写，中文按 Unicode 序）。
 * 与资源管理器一致的直觉：先看到文件夹，再看到文件。
 */
export function sortMountEntries(entries: MountEntry[]): MountEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  })
}

/**
 * 相对路径的安全校验 —— 这是**安全边界**：读文件前必须过。
 * 挡掉绝对路径、盘符、.. 穿越、以及反斜杠（统一成 / 之后再判）。
 */
export function isSafeRelPath(rel: string): boolean {
  if (!rel) return false
  if (rel.includes('\\')) return false
  if (rel.startsWith('/') || rel.startsWith('~')) return false
  if (/^[a-zA-Z]:/.test(rel)) return false
  const parts = rel.split('/')
  return parts.every((p) => p !== '' && p !== '.' && p !== '..')
}

/** 预览方式：文本 / 图片 / 不预览（二进制、Office 之类交给系统程序打开）。 */
export type PreviewKind = 'text' | 'image' | 'none'

const TEXT_EXTS = new Set([
  'md', 'markdown', 'txt', 'log', 'json', 'yaml', 'yml', 'toml', 'ini', 'csv', 'tsv',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h',
  'cpp', 'hpp', 'cs', 'php', 'sh', 'ps1', 'bat', 'cmd', 'sql', 'html', 'htm', 'css', 'scss',
  'xml', 'vue', 'svelte', 'tex', 'rst', 'org',
])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico'])

export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name)
  return m ? m[1].toLowerCase() : ''
}

export function previewKindOf(name: string): PreviewKind {
  const ext = extOf(name)
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'none'
}

/** 挂载点的显示名：取路径最后一段，取不到就用整个路径。 */
export function mountNameOf(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  const parts = clean.split(/[\\/]/)
  return parts[parts.length - 1] || clean
}

/**
 * 挂载文件的**虚拟节点 id：负数**。
 *
 * 真实的 note / folder id 都是正数，负数只可能来自虚拟节点 —— 选中态、展开态、React key
 * 因此不会和真数据撞车。
 *
 * 用 FNV-1a 这类稳定哈希而不是递增序号：**同一路径每次扫描必须得到同一个 id**，
 * 否则重扫之后选中会跳到别的文件上（展开态同理）。
 *
 * 注意它**不可反推**（哈希不可逆）：渲染层把它当 Map 的键，反查「这是哪个挂载点的哪个文件」；
 * 与其在 id 里编码路径（长度会爆、还难读），不如让调用方持有那张表。
 */
export function mountNodeId(folderId: number, relPath: string): number {
  const key = folderId + ':' + relPath
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  // 取 31 位正整数再取负；为 0 时兜一个 -1，免得 id 变成 0（0 在别处是个哨兵值）
  const positive = h & 0x7fffffff
  return -(positive || 1)
}

/** 相对路径的缩进层级（'a/b/c.md' → 2）。挂载点的子树按它缩进显示。 */
export function depthOfRelPath(relPath: string): number {
  return relPath.split('/').length - 1
}