/**
 * Office 文档内嵌预览与可编辑写回（O11 / N-§1.3#5）。
 *
 * 只读预览与 Python 的 python-docx / openpyxl 预览等价；因为要把解析结果交给渲染进程，
 * 这里对外部文档产出的 HTML 做一次白名单清洗——文档是用户提供的输入，不能直接注入页面。
 *
 * 可编辑写回对齐 Python note_previews 的 WordEditView / ExcelEditView：
 * - Word：把富文本编辑器的 HTML 重建成 .docx（保留标题层级/粗斜下划线/字号/颜色）；
 * - Excel：读原工作簿、只改单元格值再写回，尽量保留原有格式。
 * 因为不希望为一个写回能力引入新的打包依赖，.docx 的写回用 node:zlib 自实现的
 * 最小 ZIP 封装（OOXML 只需 [Content_Types].xml + _rels/.rels + word/document.xml）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import { dataDir } from './connection'
import { getNote } from './notes'
import { escapeHtml, sanitizeHtml } from '../../shared/sanitize-html'

export interface OfficePreview {
  kind: 'docx' | 'xlsx' | 'none'
  html: string
  message: string
}


/** 解析一篇 Office 笔记；非 Office 格式或文件缺失时返回 kind='none'。 */
export async function previewOfficeNote(noteId: number): Promise<OfficePreview> {
  const note = getNote(noteId)
  if (!note) return { kind: 'none', html: '', message: '笔记不存在' }
  const target = (note.content_md || '').trim()
  if (!target) return { kind: 'none', html: '', message: '这篇笔记没有关联外部文件' }
  // 链接类笔记不是文件，先区分开再谈存在性
  if (/^https?:\/\//i.test(target)) {
    return { kind: 'none', html: '', message: '链接笔记请用浏览器打开' }
  }
  if (!existsSync(target)) return { kind: 'none', html: '', message: '关联文件已不存在' }

  const ext = extname(target).toLowerCase()
  try {
    if (ext === '.docx') {
      const res = await mammoth.convertToHtml({ path: target })
      const warns = res.messages.length
      return {
        kind: 'docx',
        html: sanitizeHtml(res.value),
        message: warns ? `已解析（${warns} 处格式未能完整转换）` : '已解析全文',
      }
    }
    if (ext === '.xlsx' || ext === '.xls') {
      // 不用 XLSX.readFile：打包后 xlsx 可能被解析成 browser 版（没有该方法）。
      // 自己读字节再交给 XLSX.read，两个版本都支持。
      const wb = XLSX.read(readFileSync(target), { type: 'buffer' })
      const parts: string[] = []
      for (const name of wb.SheetNames.slice(0, 10)) {
        const table = XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' })
        const inner = table.replace(/[\s\S]*?<body>/, '').replace(/<\/body>[\s\S]*/, '')
        parts.push(`<h3>${escapeHtml(name)}</h3>${inner}`)
      }
      return {
        kind: 'xlsx',
        html: sanitizeHtml(parts.join('\n')),
        message: `${wb.SheetNames.length} 个工作表`,
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { kind: 'none', html: '', message: `解析失败：${msg}` }
  }
  return { kind: 'none', html: '', message: '仅支持 .docx / .xlsx 内嵌预览' }
}

// ---------------------------------------------------------------- 可编辑写回

export interface OfficeDoc {
  kind: 'docx' | 'xlsx' | 'none'
  /** Word：可编辑 HTML；Excel 不用 */
  html: string
  /** Excel：单元格二维数组（字符串） */
  rows: string[][]
  message: string
}

/** 取一篇 Office 笔记的可编辑内容（Word→HTML，Excel→单元格网格）。 */
export async function officeDocNote(noteId: number): Promise<OfficeDoc> {
  const note = getNote(noteId)
  if (!note) return { kind: 'none', html: '', rows: [], message: '笔记不存在' }
  const target = (note.content_md || '').trim()
  if (!target) return { kind: 'none', html: '', rows: [], message: '这篇笔记没有关联外部文件' }
  if (/^https?:\/\//i.test(target)) {
    return { kind: 'none', html: '', rows: [], message: '链接笔记请用浏览器打开' }
  }
  if (!existsSync(target)) {
    // 与 Python 一致：文件缺失时仍给出可编辑的空白骨架，用户可直接开始写
    return note.format === 'excel'
      ? { kind: 'xlsx', html: '', rows: [['', '', ''], ['', '', ''], ['', '', '']], message: '文件尚未创建，保存时会新建' }
      : { kind: 'docx', html: '<p>（新建 Word 文档，开始编辑…）</p>', rows: [], message: '文件尚未创建，保存时会新建' }
  }
  const ext = extname(target).toLowerCase()
  try {
    if (ext === '.docx') {
      const res = await mammoth.convertToHtml({ path: target })
      return { kind: 'docx', html: sanitizeHtml(res.value), rows: [], message: '已载入，可编辑并自动写回' }
    }
    if (ext === '.xlsx' || ext === '.xls') {
      const wb = XLSX.read(readFileSync(target), { type: 'buffer' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '' }) as string[][]
      return {
        kind: 'xlsx',
        html: '',
        rows: rows.length ? rows : [['', '', ''], ['', '', ''], ['', '', '']],
        message: `已载入「${wb.SheetNames[0] ?? 'Sheet1'}」，可编辑并自动写回`,
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { kind: 'none', html: '', rows: [], message: `载入失败：${msg}` }
  }
  return { kind: 'none', html: '', rows: [], message: '仅支持 .docx / .xlsx 编辑写回' }
}

/** 新建空白 .docx/.xlsx（对齐 app_controller._create_blank_office_file）。 */
export function createBlankOfficeFile(
  format: string,
  title: string
): { ok: boolean; path: string; message: string } {
  const isWord = format === 'word'
  const dir = join(dataDir(), 'notes_attach')
  try {
    mkdirSync(dir, { recursive: true })
    const safe = (title || '').replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || '未命名'
    const path = join(dir, `${safe}-${Date.now()}.${isWord ? 'docx' : 'xlsx'}`)
    if (isWord) writeFileSync(path, buildDocx(''))
    else {
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['', '', ''], ['', '', ''], ['', '', '']]), 'Sheet1')
      writeFileSync(path, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
    }
    return { ok: true, path, message: `已新建空白 ${isWord ? 'Word' : 'Excel'} 文件` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, path: '', message: `新建空白文件失败：${msg}` }
  }
}

/** 把富文本 HTML 写回笔记关联的 .docx（对齐 WordEditView.commit / html_to_docx）。 */
export function saveWordNote(noteId: number, html: string): { ok: boolean; message: string } {
  const note = getNote(noteId)
  if (!note) return { ok: false, message: '笔记不存在' }
  const target = (note.content_md || '').trim()
  if (!target || /^https?:\/\//i.test(target)) return { ok: false, message: '这篇笔记没有关联本地 Word 文件' }
  try {
    const path = existsSync(target) ? target : onMissingPath(target, '.docx')
    writeFileSync(path, buildDocx(html))
    return { ok: true, message: `已写回 ${path}` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `写回失败：${msg}` }
  }
}

/** 把单元格网格写回笔记关联的 .xlsx（对齐 ExcelEditView.commit，保留原格式）。 */
export function saveExcelNote(noteId: number, rows: string[][]): { ok: boolean; message: string } {
  const note = getNote(noteId)
  if (!note) return { ok: false, message: '笔记不存在' }
  const target = (note.content_md || '').trim()
  if (!target || /^https?:\/\//i.test(target)) return { ok: false, message: '这篇笔记没有关联本地 Excel 文件' }
  try {
    const path = existsSync(target) ? target : onMissingPath(target, '.xlsx')
    const wb = existsSync(path) ? XLSX.read(readFileSync(path), { type: 'buffer' }) : XLSX.utils.book_new()
    if (!wb.SheetNames.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1')
    } else {
      const ws = wb.Sheets[wb.SheetNames[0]]
      // 只改单元格的值，不清空整表 —— 尽量保留原有格式（对齐「保留格式」口径）
      for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < rows[i].length; j++) {
          const addr = XLSX.utils.encode_cell({ r: i, c: j })
          const value = rows[i][j]
          if (value === '') continue
          ws[addr] = { ...(ws[addr] ?? {}), t: 's', v: value }
        }
      }
      if (!ws['!ref'] && rows.length) {
        const maxCols = Math.max(1, ...rows.map((r) => r.length))
        ws['!ref'] = XLSX.utils.encode_range({
          s: { r: 0, c: 0 },
          e: { r: rows.length - 1, c: maxCols - 1 },
        })
      }
      wb.Sheets[wb.SheetNames[0]] = ws
    }
    writeFileSync(path, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
    return { ok: true, message: `已写回 ${path}` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `写回失败：${msg}` }
  }
}

/** 目标目录不存在时补建（notes_attach 之外的路径要求目录已存在）。 */
function onMissingPath(target: string, ext: string): string {
  const path = /\.[a-z0-9]+$/i.test(target) ? target : target + ext
  const dir = path.replace(/[\\/][^\\/]*$/, '')
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
  return path
}

// ---------------------------------------------------------------- 最小 DOCX 生成器

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 用 deflate 打包若干条目成 ZIP（OOXML 的 .docx 就是 ZIP）。 */
function zipPackage(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const comp = deflateRawSync(e.data)
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, comp)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)

    offset += 30 + nameBuf.length + comp.length
  }
  const centralBuf = Buffer.concat(centrals)
  const localBuf = Buffer.concat(locals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([localBuf, centralBuf, eocd])
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

interface RunFmt {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
  size?: number
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 把一段内联 HTML 拆成带格式的文本片段（加粗/斜体/下划线/字号/颜色）。 */
function parseRuns(html: string): { text: string; fmt: RunFmt }[] {
  const out: { text: string; fmt: RunFmt }[] = []
  const stack: RunFmt[] = [{}]
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^>]*)?)>/g
  let last = 0
  let m: RegExpExecArray | null
  const pushText = (raw: string): void => {
    const text = raw
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
    if (text) out.push({ text, fmt: { ...stack[stack.length - 1] } })
  }
  while ((m = tagRe.exec(html))) {
    pushText(html.slice(last, m.index))
    last = m.index + m[0].length
    const closing = m[0].startsWith('</')
    const tag = m[1].toLowerCase()
    const attrs = m[2] ?? ''
    const top = stack[stack.length - 1]
    if (tag === 'br') {
      out.push({ text: '\n', fmt: { ...top } })
      continue
    }
    if (!closing) {
      const next: RunFmt = { ...top }
      if (tag === 'b' || tag === 'strong') next.bold = true
      if (tag === 'i' || tag === 'em') next.italic = true
      if (tag === 'u') next.underline = true
      const color = /color:\s*([^;"']+)/i.exec(attrs)?.[1]
      if (color) next.color = color.trim()
      const size = /font-size:\s*([0-9.]+)(px|pt)?/i.exec(attrs)
      if (size) next.size = Math.round(Number(size[1]))
      stack.push(next)
    } else if (stack.length > 1) {
      stack.pop()
    }
  }
  pushText(html.slice(last))
  return out
}

/** HTML → word/document.xml（标题按加粗+放大呈现，无需 styles.xml 也能看出层级）。 */
function htmlToDocumentXml(html: string): string {
  const body: string[] = []
  const blockRe = /<(h[1-6]|p|div|li)[^>]*>([\s\S]*?)<\/\1>|<br\s*\/?>/gi
  let m: RegExpExecArray | null
  let matched = false
  while ((m = blockRe.exec(html))) {
    if (m[0].toLowerCase().startsWith('<br')) {
      body.push('<w:p/>')
      continue
    }
    matched = true
    const tag = m[1].toLowerCase()
    const level = tag.startsWith('h') ? Number(tag[1]) : 0
    const runs = parseRuns(m[2] ?? '')
    if (!runs.length) {
      body.push('<w:p/>')
      continue
    }
    const prefix = tag === 'li' ? '• ' : ''
    const parts = runs.map((r, i) => runXml((i === 0 && prefix ? prefix + r.text : r.text), level, r.fmt))
    const pPr = level ? '<w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>' : '<w:pPr><w:spacing w:after="120"/></w:pPr>'
    body.push(`<w:p>${pPr}${parts.join('')}</w:p>`)
  }
  if (!matched) {
    // 没有块级标签（编辑器常见的裸文本/行内 HTML）：按换行拆段
    for (const line of html.split(/\n|<br\s*\/?>/i)) {
      const runs = parseRuns(line)
      if (!runs.length) continue
      body.push(`<w:p>${runs.map((r) => runXml(r.text, 0, r.fmt)).join('')}</w:p>`)
    }
  }
  const content = body.join('') || '<w:p/>'
  return (
    XML_HEAD +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${content}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`
  )
}

function runXml(text: string, headingLevel: number, fmt: RunFmt): string {
  const props: string[] = []
  if (fmt.bold || headingLevel) props.push('<w:b/>')
  if (fmt.italic) props.push('<w:i/>')
  if (fmt.underline) props.push('<w:u w:val="single"/>')
  if (fmt.color && /^#[0-9a-f]{6}$/i.test(fmt.color)) {
    props.push(`<w:color w:val="${fmt.color.slice(1).toUpperCase()}"/>`)
  }
  const size = headingLevel ? [0, 40, 32, 28][headingLevel] ?? 24 : fmt.size ? fmt.size * 2 : 0
  if (size) props.push(`<w:sz w:val="${size}"/>`)
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : ''
  // 硬换行在 run 内用 <w:br/> 表达
  const segments = text.split('\n')
  const inner = segments
    .map((seg, i) => (i ? '<w:br/>' : '') + `<w:t xml:space="preserve">${xmlEscape(seg)}</w:t>`)
    .join('')
  return `<w:r>${rPr}${inner}</w:r>`
}

/** 由 HTML（或空串）生成一个可被 Word 打开的 .docx。 */
export function buildDocx(html: string): Buffer {
  const contentTypes =
    XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>'
  const rels =
    XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>'
  const document = htmlToDocumentXml(html || '')
  return zipPackage([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ])
}
