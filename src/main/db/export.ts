import { getNote } from './notes'
import { BrowserWindow, app, dialog, shell } from 'electron'
import { openExternalSafely } from '../security'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { conn, nowStamp, dataDir } from './connection'

// ---------------------------------------------------------------- 导出

/** 与 exporter.export_json 相同的表集合与外壳字段。 */
export const EXPORT_TABLES = [
  'list_folder',
  'task',
  'task_tag',
  'note_folder',
  'note',
  'note_tag',
  'note_link',
  'task_note_link',
  'flash',
  'flash_tag',
  'note_revision',
  'attachment',
  'pomodoro_session',
  'tag',
  'settings',
] as const

/**
 * 关联表/从表的外键清理（等价的「目标缺失即跳过」）。
 * 顺序无关：每条只删除自身引用了不存在目标的行，不会波及正常数据。
 */
const ORPHAN_CLEANUP: string[] = [
  'DELETE FROM task_tag WHERE task_id NOT IN (SELECT id FROM task) OR tag_id NOT IN (SELECT id FROM tag)',
  'DELETE FROM note_tag WHERE note_id NOT IN (SELECT id FROM note) OR tag_id NOT IN (SELECT id FROM tag)',
  'DELETE FROM flash_tag WHERE flash_id NOT IN (SELECT id FROM flash) OR tag_id NOT IN (SELECT id FROM tag)',
  'DELETE FROM task_note_link WHERE task_id NOT IN (SELECT id FROM task) OR note_id NOT IN (SELECT id FROM note)',
  'DELETE FROM note_link WHERE src_note_id NOT IN (SELECT id FROM note)',
  'DELETE FROM note_revision WHERE note_id NOT IN (SELECT id FROM note)',
  'DELETE FROM attachment WHERE note_id NOT IN (SELECT id FROM note)',
  'DELETE FROM pomodoro_session WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM task)',
]

/** 导出 JSON 的完整内容（与 exporter.export_json 的外壳与表集合一致）。 */
export function buildExportJson(): { data: Record<string, unknown>; count: number } {
  const c = conn()
  const data: Record<string, unknown> = { app: 'zhixing', version: 1 }
  let count = 0
  for (const table of EXPORT_TABLES) {
    const rows = c.prepare(`SELECT * FROM ${table}`).all()
    data[table] = rows
    count += rows.length
  }
  return { data, count }
}

/** 导出任务 CSV 文本（带 BOM 前缀，列与 exporter.export_tasks_csv 一致）。 */
export function buildTasksCsv(): { text: string; count: number } {
  const rows = conn()
    .prepare(
      `SELECT id, title, status, priority, due_date, list_id, parent_id, repeat_period, notes_md
         FROM task ORDER BY id`
    )
    .all() as Record<string, unknown>[]
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v).replace(/\n/g, ' ')
    return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = ['id', '标题', '状态', '优先级', '截止日期', '列表', '父任务', '循环', '备注']
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push(
      [r.id, r.title, r.status, r.priority, r.due_date, r.list_id, r.parent_id, r.repeat_period, r.notes_md]
        .map(esc)
        .join(',')
    )
  }
  return { text: '\ufeff' + lines.join('\n'), count: rows.length }
}

/** 待导出笔记清单（未删除，按文件夹分组）。 */
export function buildNotesExport(): { id: number; folder: string; name: string; content: string }[] {
  const safeName = (title: string, id: number): string => {
    const cleaned = (title || '').replace(/[\\/:*?"<>|]/g, '').trim()
    return (cleaned || `note-${id}`) + '.md'
  }
  return (
    conn()
      .prepare('SELECT id, folder_id, title, content_md FROM note WHERE deleted_at IS NULL')
      .all() as { id: number; folder_id: number | null; title: string; content_md: string }[]
  ).map((n) => ({
    id: n.id,
    folder: n.folder_id ? `folder-${n.folder_id}` : 'root',
    name: safeName(n.title, n.id),
    content: `# ${n.title}\n\n${n.content_md ?? ''}`,
  }))
}

export async function exportData(
  sender: Electron.WebContents,
  kind: 'json' | 'csv' | 'markdown'
): Promise<{ path: string; count: number } | null> {
  const win = BrowserWindow.fromWebContents(sender) ?? undefined

  if (kind === 'json') {
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: '导出全部数据（JSON）',
      defaultPath: 'zhixing-export.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePath) return null
    const { data, count } = buildExportJson()
    writeFileSync(filePath, JSON.stringify(data, null, 1), 'utf-8')
    return { path: filePath, count }
  }

  if (kind === 'csv') {
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: '导出任务（CSV）',
      defaultPath: 'zhixing-tasks.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (canceled || !filePath) return null
    const { text, count } = buildTasksCsv()
    writeFileSync(filePath, text, 'utf-8')
    return { path: filePath, count }
  }

  const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
    title: '选择导出笔记的目录',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (canceled || !filePaths[0]) return null
  const baseDir = filePaths[0]
  const notes = buildNotesExport()
  for (const n of notes) {
    const dir = join(baseDir, n.folder)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, n.name), n.content, 'utf-8')
  }
  return { path: baseDir, count: notes.length }
}

// ---------------------------------------------------------------- 导入（覆盖式）

/**
 * 覆盖式导入 JSON 导出文件（对齐 Importer.import_json）。
 * 安全措施：校验文件外壳、**导入前自动 VACUUM INTO 备份当前库**、
 * 整个导入在一个事务里完成；渲染进程还会先做二次确认。
 */
export function importFromJsonFile(filePath: string): {
  ok: boolean
  message: string
  rows?: number
  backup?: string
} {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `读取失败：${msg}` }
  }
  if (data.app !== 'zhixing') return { ok: false, message: '不是「知行」的导出文件' }

  // 导入前自动备份（用户数据安全的第一道闸）
  const stamp = nowStamp().replace(/[-: .]/g, '')
  const backupDir = join(dataDir(), 'backups', 'before-import')
  const backupFile = join(backupDir, `zhixing-${stamp}.db`)
  try {
    mkdirSync(backupDir, { recursive: true })
    conn().prepare('VACUUM INTO ?').run(backupFile)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `备份失败，已中止导入：${msg}` }
  }

  const c = conn()
  try {
    c.pragma('foreign_keys = OFF')
    const run = c.transaction(() => {
      let total = 0
      for (const table of [...EXPORT_TABLES].reverse()) {
        // settings 不走「清空重建」：它是一组配置键，清空会把导出文件里没有的键一并抹掉，
        // 其中就包含 schema_version —— 导入旧文件会让版本号回退，随后 Python 版打开会
        // 误判需要迁移。对齐 exporter._import_json：逐键 upsert，且跳过 schema_version。
        if (table === 'settings') continue
        c.prepare(`DELETE FROM ${table}`).run()
      }
      for (const table of EXPORT_TABLES) {
        const rows = data[table] as Record<string, unknown>[] | undefined
        if (!Array.isArray(rows) || rows.length === 0) continue
        if (table === 'settings') {
          const upsert = c.prepare(
            'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
          )
          for (const row of rows) {
            const key = String(row.key ?? '').trim()
            if (!key || key === 'schema_version') continue
            upsert.run(key, row.value == null ? '' : String(row.value))
            total += 1
          }
          continue
        }
        for (const row of rows) {
          const cols = Object.keys(row)
          if (!cols.length) continue
          // 列名加引号：settings 的 key / value 等是 SQL 保留字
          const sql = `INSERT INTO ${table} (${cols.map((k) => `"${k}"`).join(', ')}) VALUES (${cols
            .map(() => '?')
            .join(', ')})`
          c.prepare(sql).run(...cols.map((k) => row[k] as never))
          total += 1
        }
      }
      // 外键完整性：导入文件内部可能引用不存在的行（手工编辑过、或来自不完整的备份）。
      // Python 侧是「目标缺失即跳过」，这里在插入后等价地清掉孤儿，避免留下指向空气的关联。
      for (const sql of ORPHAN_CLEANUP) c.prepare(sql).run()
      return total
    })
    const rows = run()
    return { ok: true, message: `已导入 ${rows} 条记录`, rows, backup: backupFile }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `导入失败（已保留备份）：${msg}`, backup: backupFile }
  } finally {
    c.pragma('foreign_keys = ON')
  }
}

/** 走系统文件对话框的导入入口。 */
export async function importData(sender: Electron.WebContents): Promise<{
  ok: boolean
  message: string
  rows?: number
  backup?: string
}> {
  const win = BrowserWindow.fromWebContents(sender) ?? undefined
  const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
    title: '选择要导入的 JSON 导出文件',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths[0]) return { ok: false, message: '已取消' }
  return importFromJsonFile(filePaths[0])
}

/** 非 Markdown 笔记（word/excel/link）用系统默认应用打开，并回传路径信息。 */
export function openNoteFile(noteId: number): { ok: boolean; message: string; path: string } {
  const note = getNote(noteId)
  if (!note) return { ok: false, message: '笔记不存在', path: '' }
  const target = (note.content_md || '').trim()
  if (!target) return { ok: false, message: '这篇笔记没有关联外部文件', path: '' }
  if (/^https?:\/\//i.test(target)) {
    openExternalSafely(target)
    return { ok: true, message: '已在浏览器打开链接', path: target }
  }
  if (!existsSync(target)) return { ok: false, message: '关联文件已不存在', path: target }
  void shell.openPath(target)
  return { ok: true, message: '已用系统默认应用打开', path: target }
}
