/**
 * 附件管理。
 *
 * `attachment` 表在 schema 里存在已久但**零业务代码**，这个模块把它用起来，
 * 语义保持最小：把用户选中的文件**复制进数据目录**（`<dataDir>/attachments/<noteId>/`）
 * 并落库，笔记正文只引用这份副本 —— 原文件被移动或删除后，笔记依然打得开。
 *
 * 只做四件事：导入 / 列出 / 删除 / 清理；不做预览、不改写正文。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
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
  } catch {
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
  if (existsSync(base)) {
    for (const noteDir of readdirSync(base, { withFileTypes: true })) {
      if (!noteDir.isDirectory()) continue
      const dir = join(base, noteDir.name)
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
