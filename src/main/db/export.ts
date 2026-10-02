import { getNote, createNote } from './notes'
import { BrowserWindow, app, dialog, shell } from 'electron'
import { openExternalSafely } from '../security'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { quietFailure } from '../../shared/quiet-failure'
import { deflateRawSync } from 'node:zlib'
import { conn } from './connection'
import { autoBackup } from './backup'

// ---------------------------------------------------------------- 导出

/**
 * 导出使用的表集合与外壳字段。
 *
 * 顺序同时是**插入顺序**（导入按此顺序写库），从表必须排在主表之后：
 *   task/note → task_note_context/task_note_ref/workflow_*；
 *   工作流四表按 template → node → instance → step_task 的依赖序。
 * 此前缺 task_note_context / task_note_ref / workflow_*，导入后这些表
 * 仍留着旧 id，指向已不存在的任务/笔记。
 */
export const EXPORT_TABLES = [
  /*
    **这个列表刻意不含 vault_meta / vault_entry**（密码保险箱）。
    
    它是显式白名单，所以保险箱默认就不会被导出 —— 这正是我们要的默认值。
    即便将来有人想加，也请先看 docs/specs/vault-design.md §6.1：
    导出的只能是**密文**，绝不能在这里把它解密成明文再序列化，
    那会让"导出"变成一条绕过主密码的路径。
    
    当前不做"导出时可勾选包含保险箱" —— 换机场景走整库备份更合适，
    那条路径同样是密文（见 backup.ts 的 autoBackup，整库拷贝）。
  */
  'list_folder',
  'task',
  'task_tag',
  'note_folder',
  'note',
  'note_tag',
  'note_link',
  'task_note_link',
  'task_note_context',
  'task_note_ref',
  'flash',
  'flash_tag',
  'note_revision',
  'attachment',
  'workflow_template',
  'workflow_node',
  'workflow_instance',
  'workflow_step_task',
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
  'DELETE FROM task_note_context WHERE task_id NOT IN (SELECT id FROM task) OR note_id NOT IN (SELECT id FROM note)',
  'DELETE FROM task_note_ref WHERE task_id NOT IN (SELECT id FROM task) OR note_id NOT IN (SELECT id FROM note)',
  'DELETE FROM workflow_node WHERE template_id NOT IN (SELECT id FROM workflow_template)',
  'UPDATE workflow_node SET branch_node_id = NULL WHERE branch_node_id IS NOT NULL AND branch_node_id NOT IN (SELECT id FROM workflow_node)',
  'UPDATE workflow_node SET branch_false_node_id = NULL WHERE branch_false_node_id IS NOT NULL AND branch_false_node_id NOT IN (SELECT id FROM workflow_node)',
  'DELETE FROM workflow_instance WHERE template_id NOT IN (SELECT id FROM workflow_template)',
  'UPDATE workflow_instance SET current_node_id = NULL WHERE current_node_id IS NOT NULL AND current_node_id NOT IN (SELECT id FROM workflow_node)',
  'DELETE FROM workflow_step_task WHERE instance_id NOT IN (SELECT id FROM workflow_instance) OR node_id NOT IN (SELECT id FROM workflow_node) OR task_id NOT IN (SELECT id FROM task)',
]

/** 导出 JSON 的完整内容（含外壳字段与全部导出表）。 */
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

/** 导出任务 CSV 文本（带 BOM 前缀）。 */
export function buildTasksCsv(): { text: string; count: number } {
  const rows = conn()
    .prepare(
      `SELECT id, title, status, priority, due_date, list_id, parent_id, repeat_period, notes_md
         FROM task ORDER BY id`
    )
    .all() as Record<string, unknown>[]
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v).replace(/\n/g, ' ')
    // CSV 引号规则：字段含分隔符/引号/行结束符才加引号
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
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
  // CSV 方言：行结束符为 \r\n，且最后一行也带换行。
  // 若用 '\n' join 且无结尾换行，Excel 打开时换行符/行数会不对。
  return { text: '\ufeff' + lines.join('\r\n') + '\r\n', count: rows.length }
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

// ---------------------------------------------------------------- 极简 ZIP 写入

/**
 * CRC-32（IEEE 802.3），ZIP 条目校验用。
 * 自己实现而不是用 node:zlib.crc32：后者在 Node 20.15 才加入，Electron 运行时不一定有。
 */
const CRC32_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC32_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ 0xffffffff) >>> 0
}

/** ZIP 条目的 DOS 时间/日期（本地时区），默认取「当前时间」。 */
function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f)
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

/**
 * 打包成 ZIP。
 * 不引第三方依赖：本地文件头 + 中央目录 + EOCD，UTF-8 文件名（通用标志位 bit 11）。
 */
export function buildZip(entries: { name: string; content: string }[]): Buffer {
  const { time, date } = dosDateTime(new Date())
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf-8')
    const raw = Buffer.from(e.content, 'utf-8')
    const packed = deflateRawSync(raw)
    const sum = crc32(raw)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0800, 6)
    lh.writeUInt16LE(8, 8)
    lh.writeUInt16LE(time, 10)
    lh.writeUInt16LE(date, 12)
    lh.writeUInt32LE(sum, 14)
    lh.writeUInt32LE(packed.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(0, 28)
    local.push(lh, name, packed)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(8, 10)
    ch.writeUInt16LE(time, 12)
    ch.writeUInt16LE(date, 14)
    ch.writeUInt32LE(sum, 16)
    ch.writeUInt32LE(packed.length, 20)
    ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt16LE(0, 30)
    ch.writeUInt16LE(0, 32)
    ch.writeUInt16LE(0, 34)
    ch.writeUInt16LE(0, 36)
    ch.writeUInt32LE(0, 38)
    ch.writeUInt32LE(offset, 42)
    central.push(ch, name)
    offset += lh.length + name.length + packed.length
  }
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...local, centralBuf, end])
}

export async function exportData(
  sender: Electron.WebContents,
  kind: 'json' | 'csv' | 'markdown' | 'markdown-zip'
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

  if (kind === 'markdown-zip') {
    // 「导出笔记 Markdown」打包成 ZIP
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: '导出笔记 Markdown',
      defaultPath: 'notes.zip',
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    })
    if (canceled || !filePath) return null
    const notes = buildNotesExport()
    const entries = notes.map((n) => ({ name: `${n.folder}/${n.name}`, content: n.content }))
    writeFileSync(filePath, buildZip(entries))
    return { path: filePath, count: notes.length }
  }

  const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
    title: '选择导出笔记的目录',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (canceled || !filePaths[0]) return null
  const baseDir = filePaths[0]
  const notes = buildNotesExport()
  // 同名去重：
  // 同题笔记按 -2/-3 递增改名，而不是直接覆盖已有文件。
  // 去重集合是「本次导出全局集合」（跨目录也算重名）。
  const used = new Set<string>()
  let written = 0
  for (const n of notes) {
    const base = n.name.replace(/\.md$/i, '')
    let name = `${base}.md`
    let i = 2
    while (used.has(name)) {
      name = `${base}-${i}.md`
      i += 1
    }
    used.add(name)
    const dir = join(baseDir, n.folder)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), n.content, 'utf-8')
    written += 1
  }
  return { path: baseDir, count: written }
}

// ---------------------------------------------------------------- 导入（覆盖式）

/**
 * 覆盖式导入 JSON 导出文件。
 * 安全措施：校验文件外壳、**导入前自动 VACUUM INTO 备份当前库**、
 * 整个导入在一个事务里完成；渲染进程还会先做二次确认。
 */
export function importFromJsonFile(filePath: string): {
  ok: boolean
  message: string
  rows?: number
  /** 返回值分别是任务数与笔记数。 */
  tasks?: number
  notes?: number
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

  // 导入前自动备份（用户数据安全的第一道闸）：改走 BackupService.autoBackup，
  // 与启动备份/恢复前备份落在同一个 backups/ 目录并一起纳入 10 份 prune；
  // 此前写进 backups/before-import/ 子目录，既不 prune 也没走备份服务。
  // 备份文件名以 pre-import 为前缀（与 autoBackup 的 reason 一致）。
  const backupFile = autoBackup('pre-import')
  if (!backupFile) return { ok: false, message: '备份失败，已中止导入（详见日志）' }

  const c = conn()
  try {
    c.pragma('foreign_keys = OFF')
    const run = c.transaction(() => {
      let total = 0
      const inserted: Record<string, number> = {}
      for (const table of [...EXPORT_TABLES].reverse()) {
        // settings 不走「清空重建」：它是一组配置键，清空会把导出文件里没有的键一并抹掉，
        // 其中就包含 schema_version —— 导入旧文件会让版本号回退，之后打开会误判需要迁移。
        // 逐键 upsert，且跳过 schema_version。
        if (table === 'settings') continue
        // 导出文件里没有这张表就整表保留：
        // 旧导出文件的 JSON 不含 workflow_* / task_note_context 等表，
        // 无条件 DELETE 会把库里现存的这些关联清空。
        if (!Array.isArray(data[table])) continue
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
          inserted[table] = (inserted[table] ?? 0) + 1
        }
      }
      // 外键完整性：导入文件内部可能引用不存在的行（手工编辑过、或来自不完整的备份）。
      // 插入后清掉目标缺失的孤儿关联，避免留下指向空气的外键。
      for (const sql of ORPHAN_CLEANUP) c.prepare(sql).run()
      return { total, inserted }
    })
    const { total, inserted } = run()
    // 提示文案：「已导入：任务 N · 笔记 M」
    const tasks = inserted.task ?? 0
    const notes = inserted.note ?? 0
    return {
      ok: true,
      message: `已导入：任务 ${tasks} · 笔记 ${notes}`,
      rows: total,
      tasks,
      notes,
      backup: backupFile,
    }
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
  tasks?: number
  notes?: number
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

// ---------------------------------------------------------------- Markdown 文件夹导入

/** 递归收集 *.md，按路径不区分大小写排序。 */
function collectMarkdownFiles(dir: string): string[] {
  const found: string[] = []
  const walk = (cur: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch (e) {
      // 读不了的目录会被整段跳过：导出会**静默少文件**，用户以为导全了
      quietFailure('导出时遍历目录', e, cur)
      return
    }
    for (const ent of entries) {
      const full = join(cur, ent.name)
      if (ent.isDirectory()) walk(full)
      // Windows 上文件名匹配大小写不敏感，这里同样忽略大小写
      else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) found.push(full)
    }
  }
  walk(dir)
  return found.sort((a, b) => {
    const x = a.toLowerCase()
    const y = b.toLowerCase()
    return x < y ? -1 : x > y ? 1 : 0
  })
}

/**
 * 导入 Markdown 文件夹：
 * 递归取 *.md，首行 `# 标题` 作标题、其余作正文，标题截断 120 字，统一入根目录。
 * 返回导入的笔记数。
 */
export function importMarkdownFolder(folder: string): {
  ok: boolean
  count: number
  message: string
} {
  if (!existsSync(folder)) return { ok: false, count: 0, message: '文件夹不存在' }
  let count = 0
  for (const file of collectMarkdownFiles(folder)) {
    const stem = (file.split(/[\\/]/).pop() ?? '').replace(/\.md$/i, '')
    try {
      const text = readFileSync(file, 'utf-8')
      let title = stem
      let body = text
      if (text.startsWith('# ')) {
        const firstNl = text.indexOf('\n')
        if (firstNl > 0) {
          title = text.slice(2, firstNl).trim()
          body = text.slice(firstNl + 1).replace(/^\n+/, '')
        }
      }
      createNote(title.slice(0, 120) || stem, null, body)
      count += 1
    } catch (err) {
      console.error('[import] 导入 Markdown 失败', file, err)
    }
  }
  return { ok: true, count, message: `已导入 ${count} 篇笔记` }
}

/** 选文件夹导入 Markdown。 */
export async function importMarkdownFolderDialog(sender: Electron.WebContents): Promise<{
  ok: boolean
  count: number
  message: string
}> {
  const win = BrowserWindow.fromWebContents(sender) ?? undefined
  const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
    title: '选择 Markdown 文件夹',
    properties: ['openDirectory'],
  })
  if (canceled || !filePaths[0]) return { ok: false, count: 0, message: '已取消' }
  return importMarkdownFolder(filePaths[0])
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
