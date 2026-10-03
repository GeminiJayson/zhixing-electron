/**
 * 附件管理。
 *
 * `attachment` 表在 schema 里存在已久但**零业务代码**，这个模块把它用起来，
 * 语义保持最小：把用户选中的文件**复制进数据目录**（`<dataDir>/attachments/<noteId>/`）
 * 并落库，笔记正文只引用这份副本 —— 原文件被移动或删除后，笔记依然打得开。
 *
 * 只做四件事：导入 / 列出 / 删除 / 清理；不做预览、不改写正文。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { quietFailure } from '../../shared/quiet-failure'
import { conn, dataDir, nowStamp } from './connection'

export interface AttachmentRow {
  id: number
  note_id: number
  note_title: string
  path: string
  kind: string
  created_at: string
  /** 字节数；文件不在时为 0 */
  size: number
  /** 记录还在、文件已经不在了 */
  missing: boolean
}

export interface AttachmentStats {
  count: number
  bytes: number
  missing: number
  dir: string
}

export function attachmentsDir(): string {
  return join(dataDir(), 'attachments')
}

/** 目标文件名：时间戳前缀 + 原名，避免同名互相覆盖；顺手去掉 Windows 非法字符 */
function safeName(src: string): string {
  const base = basename(src).replace(/[\\/:*?"<>|]/g, '_')
  return `${Date.now().toString(36)}-${base}`
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch (e) {
    // 列表里会显示成 0 字节，看起来像文件坏了；留一条能对上路径的记录
    quietFailure('读取附件大小', e, path)
    return 0
  }
}

/**
 * 导入一个附件：复制进数据目录并落库。
 * 返回归档后的绝对路径，调用方把它写进笔记正文即可。
 */
export function importAttachment(
  noteId: number,
  srcPath: string
): { ok: boolean; path?: string; message: string } {
  const src = String(srcPath ?? '').trim()
  if (!src) return { ok: false, message: '没有选择文件' }
  if (!existsSync(src)) return { ok: false, message: '源文件不存在：' + src }
  const note = conn().prepare('SELECT id FROM note WHERE id = ?').get(noteId) as { id: number } | undefined
  if (!note) return { ok: false, message: '笔记不存在' }

  const dir = join(attachmentsDir(), String(noteId))
  try {
    mkdirSync(dir, { recursive: true })
    const target = join(dir, safeName(src))
    copyFileSync(src, target)
    const kind = (extname(src).replace('.', '') || 'file').toLowerCase()
    conn()
      .prepare('INSERT INTO attachment (note_id, path, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(noteId, target, kind, nowStamp())
    return { ok: true, path: target, message: '已归档' }
  } catch (err) {
    return { ok: false, message: '导入失败：' + (err as Error).message }
  }
}

/**
 * 从内存里的二进制导入附件（粘贴的图片走这条 —— 它没有源文件路径）。
 *
 * base64 是浏览器 FileReader 的原生输出，直接当参数传过来最省事，
 * 不必把 Buffer 再包一层过 IPC。
 */
export function importAttachmentData(
  noteId: number,
  fileName: string,
  base64: string
): { ok: boolean; path?: string; message: string } {
  const note = conn().prepare('SELECT id FROM note WHERE id = ?').get(noteId) as { id: number } | undefined
  if (!note) return { ok: false, message: '笔记不存在' }
  try {
    const buf = Buffer.from(String(base64 ?? ''), 'base64')
    if (!buf.length) return { ok: false, message: '数据为空' }
    const dir = join(attachmentsDir(), String(noteId))
    mkdirSync(dir, { recursive: true })
    const target = join(dir, safeName(fileName || 'image.png'))
    writeFileSync(target, buf)
    const kind = (extname(fileName || '').replace('.', '') || 'file').toLowerCase()
    conn()
      .prepare('INSERT INTO attachment (note_id, path, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(noteId, target, kind, nowStamp())
    return { ok: true, path: target, message: '已归档' }
  } catch (err) {
    return { ok: false, message: '导入失败：' + (err as Error).message }
  }
}

/**
 * 批量导入内存附件：多图上传一次 IPC。
 *
 * 渲染层原本在循环里逐张 \`await saveAttachmentData(...)\` —— 第 N 张失败时前 N-1 张
 * 已经落盘落库。这里把**落库**收进一个事务（文件写入本身无法回滚，万一落库失败，
 * 已写下的文件成为孤儿，由 pruneAttachments 兜底清理），并逐张回报结果，
 * 让调用方能准确告诉用户哪几张没进去。
 */
export function importAttachmentDataBatch(
  noteId: number | null,
  files: { fileName: string; base64: string }[]
): { fileName: string; ok: boolean; path?: string; message: string }[] {
  const out: { fileName: string; ok: boolean; path?: string; message: string }[] = []
  /**
   * noteId 为 null：还没有归属的附件。
   *
   * 快速笔记粘贴的图片就是这种 —— 那时连 flash 都还没存下，更不会有 note。
   * **文件照样落盘**，只是暂存在 attachments/pending/ 下、不写 attachment 记录
   *（那一列的 note_id 是 NOT NULL 且外键到 note）；等它转成笔记时，
   * flashToNote 会按正文里的 data-attachment 把文件迁到该笔记的目录并补记录。
   *
   * 早先这里直接返回「笔记不存在」，于是快速笔记里的原图**被静默丢弃**，
   * 文档里只剩一张缩略图，原图再也找不回来。
   */
  if (noteId !== null) {
    const note = conn()
      .prepare('SELECT id FROM note WHERE id = ?')
      .get(noteId) as { id: number } | undefined
    if (!note) return files.map((f) => ({ fileName: f.fileName, ok: false, message: '笔记不存在' }))
  }
  const dir =
    noteId === null ? join(attachmentsDir(), 'pending') : join(attachmentsDir(), String(noteId))
  const pending: { target: string; kind: string }[] = []
  for (const f of files) {
    try {
      const buf = Buffer.from(String(f.base64 ?? ''), 'base64')
      if (!buf.length) {
        out.push({ fileName: f.fileName, ok: false, message: '数据为空' })
        continue
      }
      mkdirSync(dir, { recursive: true })
      const target = join(dir, safeName(f.fileName || 'image.png'))
      writeFileSync(target, buf)
      pending.push({ target, kind: (extname(f.fileName || '').replace('.', '') || 'file').toLowerCase() })
      out.push({ fileName: f.fileName, ok: true, path: target, message: '已归档' })
    } catch (err) {
      out.push({ fileName: f.fileName, ok: false, message: '导入失败：' + (err as Error).message })
    }
  }
  // 没有归属时只落文件、不写记录（attachment.note_id NOT NULL 且外键到 note）
  if (pending.length && noteId !== null) {
    const c = conn()
    const ins = c.prepare('INSERT INTO attachment (note_id, path, kind, created_at) VALUES (?, ?, ?, ?)')
    const tx = c.transaction((rows: { target: string; kind: string }[]) => {
      for (const r of rows) ins.run(noteId, r.target, r.kind, nowStamp())
    })
    tx(pending)
  }
  return out
}

/** 正文里 data-attachment 的取值（富文本 img 上记的附件路径）。 */
const ATTACHMENT_RE = /data-attachment="([^"]+)"/g

/**
 * 把暂存在 attachments/pending/ 下的附件迁到它所属笔记的目录，并补上记录。
 *
 * **这是 importAttachmentDataBatch 那段注释承诺过、但一直没有实现的一步。**
 * 快速笔记（连 flash 都还没存下时）粘贴的图片走的是 `noteId === null` 分支：
 * 文件落在 pending/、不写 attachment 记录（那一列 NOT NULL 且外键到 note）。
 * 承诺是"等它转成笔记时迁过去"，但 flashToNote 里从来没有这段逻辑 ——
 * 于是那些原图永远留在 pending/ 下，应用里查不到、删笔记时也不会被清理。
 *
 * 返回迁移后的正文（路径要跟着改），没有可迁的就原样返回。
 */
export function migratePendingAttachments(noteId: number, content: string): string {
  const matches = [...content.matchAll(ATTACHMENT_RE)]
  if (!matches.length) return content

  const pendingDir = join(attachmentsDir(), 'pending')
  const targetDir = join(attachmentsDir(), String(noteId))
  const c = conn()
  const ins = c.prepare('INSERT INTO attachment (note_id, path, kind, created_at) VALUES (?, ?, ?, ?)')
  const exists = c.prepare('SELECT 1 FROM attachment WHERE note_id = ? AND path = ?')

  let next = content
  for (const m of matches) {
    const oldPath = m[1]
    // 只处理确实躺在 pending/ 下的；已经在目标目录里的原样保留
    if (dirname(oldPath) !== pendingDir) continue
    if (exists.get(noteId, oldPath)) continue
    try {
      mkdirSync(targetDir, { recursive: true })
      const newPath = join(targetDir, basename(oldPath))
      renameSync(oldPath, newPath)
      ins.run(noteId, newPath, (extname(newPath).replace('.', '') || 'file').toLowerCase(), nowStamp())
      next = next.split(oldPath).join(newPath)
    } catch {
      // 文件已被移走或权限不足：保留原路径，下次再试（宁可路径旧，也不能丢正文）
    }
  }
  return next
}

export interface OrphanFile {
  name: string
  path: string
  bytes: number
}

/**
 * 列出 attachments/pending/ 下**真正没人引用**的文件。
 *
 * 这个目录是"还没有归属的附件"的暂存区（快速笔记粘贴图片时连 note 都还没有）。
 * 正常路径是 flashToNote 把它们迁走 —— 但那段逻辑此前一直缺失，所以积了货；
 * 而 flashToNote 修好之后，仍可能留下两类：**迁移之前就积下的**，以及
 * **闪念被删掉、文件却留了下来的**。
 *
 * 判断"没人引用"要同时看两处：闪念正文与笔记正文里的 data-attachment。
 * 只看其中一处会把另一处还在用的文件误报成孤儿 —— 那是删用户的东西。
 */
export function listOrphanFiles(): OrphanFile[] {
  const dir = join(attachmentsDir(), 'pending')
  if (!existsSync(dir)) return []
  const c = conn()
  // 正文里出现过的路径（两处合起来看）
  const flashBodies = (c.prepare('SELECT content FROM flash').all() as { content: string }[])
    .map((r) => r.content ?? '')
    .join('\n')
  const noteBodies = (
    c.prepare('SELECT content_md FROM note WHERE deleted_at IS NULL').all() as {
      content_md: string
    }[]
  )
    .map((r) => r.content_md ?? '')
    .join('\n')
  const haystack = flashBodies + '\n' + noteBodies

  const out: OrphanFile[] = []
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  for (const name of names) {
    const p = join(dir, name)
    let bytes = 0
    try {
      const st = statSync(p)
      if (!st.isFile()) continue
      bytes = st.size
    } catch {
      continue
    }
    const inRecord = c.prepare('SELECT 1 FROM attachment WHERE path = ?').get(p)
    if (inRecord) continue
    if (haystack.includes(name)) continue
    out.push({ name, path: p, bytes })
  }
  return out
}

/** 删掉这些孤儿文件，返回实际删掉的数量。 */
export function cleanOrphanFiles(): number {
  let n = 0
  for (const f of listOrphanFiles()) {
    try {
      rmSync(f.path, { force: true })
      n++
    } catch (err) {
      quietFailure('清理孤儿附件', err)
    }
  }
  return n
}

export function listAttachments(): AttachmentRow[] {
  const rows = conn()
    .prepare(
      `SELECT a.id, a.note_id, a.path, a.kind, a.created_at, COALESCE(n.title, '（笔记已删除）') AS note_title
         FROM attachment a LEFT JOIN note n ON n.id = a.note_id
        ORDER BY a.id DESC`
    )
    .all() as { id: number; note_id: number; path: string; kind: string; created_at: string; note_title: string }[]
  return rows.map((r) => {
    const size = sizeOf(r.path)
    return { ...r, size, missing: size === 0 }
  })
}

export function attachmentStats(): AttachmentStats {
  const rows = listAttachments()
  return {
    count: rows.length,
    bytes: rows.reduce((n, r) => n + r.size, 0),
    missing: rows.filter((r) => r.missing).length,
    dir: attachmentsDir(),
  }
}

/** 删除一条附件：文件与记录一起清掉（文件删不掉也把记录删掉，避免留下永远清不掉的条目）。 */
export function deleteAttachment(id: number): boolean {
  const row = conn().prepare('SELECT path FROM attachment WHERE id = ?').get(id) as
    | { path: string }
    | undefined
  if (!row) return false
  try {
    if (existsSync(row.path)) rmSync(row.path, { force: true })
  } catch (err) {
    console.error('[attachment] 删除文件失败', err)
  }
  conn().prepare('DELETE FROM attachment WHERE id = ?').run(id)
  return true
}

/**
 * 清理：
 *   1. 记录指向的文件已经不在了（比如用户手动删了数据目录里的文件）；
 *   2. 数据目录里存在、但没有任何记录引用的孤儿文件。
 */
export function pruneAttachments(): { removedRows: number; removedFiles: number } {
  const c = conn()
  const rows = c.prepare('SELECT id, path FROM attachment').all() as { id: number; path: string }[]
  let removedRows = 0
  const keep = new Set<string>()
  for (const r of rows) {
    if (existsSync(r.path)) keep.add(r.path)
    else {
      c.prepare('DELETE FROM attachment WHERE id = ?').run(r.id)
      removedRows += 1
    }
  }

  let removedFiles = 0
  const base = attachmentsDir()
  /*
    **必须跳过 pending/**。
    
    它是"还没有归属的附件"的暂存区 —— 那里的文件按设计就没有 attachment 记录，
    所以下面的 keep 集合里必然没有它们，会被一律当成孤儿删掉。而那些可能是
    快速笔记刚粘贴、还没转成笔记的原图：删下去就是**直接删用户数据**。
    暂存区由 listOrphanFiles 按"是否被闪念/笔记正文引用"逐个判断，不在这里扫。
  */
  const PENDING = join(base, 'pending')
  if (existsSync(base)) {
    for (const noteDir of readdirSync(base, { withFileTypes: true })) {
      if (!noteDir.isDirectory()) continue
      const dir = join(base, noteDir.name)
      if (dir === PENDING) continue
      for (const file of readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile()) continue
        const full = join(dir, file.name)
        if (keep.has(full)) continue
        try {
          rmSync(full, { force: true })
          removedFiles += 1
        } catch (err) {
          console.error('[attachment] 清理孤儿文件失败', err)
        }
      }
    }
  }
  return { removedRows, removedFiles }
}
