/**
 * Office 文档内嵌预览与可编辑写回。
 *
 * 只读预览解析 Word / Excel 文档；因为要把解析结果交给渲染进程，
 * 这里对外部文档产出的 HTML 做一次白名单清洗——文档是用户提供的输入，不能直接注入页面。
 *
 * 可编辑写回：
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
import { getNote, saveNote } from './notes'
import { escapeHtml, sanitizeHtml } from '../../shared/sanitize-html'
import { crc32 } from '../../shared/crc32'

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
        // 先还原代码块再清洗：清洗会把不在白名单里的属性剥掉（pre 的 data-language 已放行）
        html: sanitizeHtml(restoreCodeBlocks(res.value)),
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
    // 文件缺失时仍给出可编辑的空白骨架，用户可直接开始写
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

/** 新建空白 .docx/.xlsx。 */
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

/** 把富文本 HTML 写回笔记关联的 .docx。 */
export function saveWordNote(noteId: number, html: string): { ok: boolean; message: string } {
  const note = getNote(noteId)
  if (!note) return { ok: false, message: '笔记不存在' }
  const target = resolveOfficeTarget(noteId, note.title, note.content_md, 'word')
  if ('message' in target) return { ok: false, message: target.message }
  try {
    const path = existsSync(target.path) ? target.path : onMissingPath(target.path, '.docx')
    writeFileSync(path, buildDocx(html))
    return { ok: true, message: `已写回 ${path}` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `写回失败：${msg}` }
  }
}

/** 把单元格网格写回笔记关联的 .xlsx。 */
export function saveExcelNote(noteId: number, rows: string[][]): { ok: boolean; message: string } {
  const note = getNote(noteId)
  if (!note) return { ok: false, message: '笔记不存在' }
  const target = resolveOfficeTarget(noteId, note.title, note.content_md, 'excel')
  if ('message' in target) return { ok: false, message: target.message }
  try {
    const path = existsSync(target.path) ? target.path : onMissingPath(target.path, '.xlsx')
    const wb = existsSync(path) ? XLSX.read(readFileSync(path), { type: 'buffer' }) : XLSX.utils.book_new()
    if (!wb.SheetNames.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1')
    } else {
      const ws = wb.Sheets[wb.SheetNames[0]]
      // 只改单元格的值，不清空整表 —— 尽量保留原有格式
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

/**
 * 看起来是不是一个本地文件路径（盘符 / UNC / 含分隔符的相对路径）。
 *
 * 为什么需要这道判据：Word/Excel 笔记的 content_md 按约定存文件路径，但库里确实有
 * 存成正文的（示例数据，或者建笔记时把正文填进了「已有文件路径」那一栏）。
 * 不判断的话，一段正文会被当成路径一路走到 mkdir —— 报出来的是
 * 「ENOENT … mkdir '…整段正文….docx'」，用户既看不懂也没法处理。
 */
function looksLikeLocalPath(target: string): boolean {
  if (!target || target.length > 240 || /[\r\n]/.test(target)) return false
  if (/^[a-zA-Z]:[\\/]/.test(target)) return true
  return /[\\/]/.test(target)
}

/**
 * 解析一篇 Office 笔记关联的文件路径。
 *
 * 找不到可用的文件关联时**就地补一个空白文件并把路径登记回笔记**（一次性自愈）——
 * 否则这篇笔记永远存不上，而用户看到的只是一句「写回失败」。
 * getNote 每次都重新读库，所以自愈只发生一次，不会每存一次就多建一个文件。
 */
function resolveOfficeTarget(
  noteId: number,
  title: string,
  content: string | null | undefined,
  kind: 'word' | 'excel'
): { path: string } | { message: string } {
  const target = (content || '').trim()
  if (/^https?:\/\//i.test(target)) {
    return { message: `这篇笔记关联的是网址，不是本地 ${kind === 'word' ? 'Word' : 'Excel'} 文件` }
  }
  if (looksLikeLocalPath(target)) return { path: target }
  const created = createBlankOfficeFile(kind, title)
  if (!created.ok) return { message: created.message }
  saveNote(noteId, { content_md: created.path })
  return { path: created.path }
}

/** 目标目录不存在时补建（notes_attach 之外的路径要求目录已存在）。 */
function onMissingPath(target: string, ext: string): string {
  const path = /\.[a-z0-9]+$/i.test(target) ? target : target + ext
  // 用 lastIndexOf 定位父目录：早先的正则写法在**没有分隔符**时（`foo.docx`）会算不出父目录，
  // 把整串当成目录去 mkdir，于是报出一个路径里带着整段文字的 ENOENT。
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  if (cut > 0) {
    const dir = path.slice(0, cut)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
  return path
}

// ---------------------------------------------------------------- 最小 DOCX 生成器

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
export function htmlToDocumentXml(html: string): string {
  const body: string[] = []
  /**
   * **pre 必须排在 p 前面**：交替分支是"先匹配先赢"，而 `<` 后面紧跟的 `p`
   * 既属于 `p` 也属于 `pre`。写成 ...|p|...|pre 的话，`<pre data-language="sql">`
   * 会被当成 `<p>`（`[^>]*` 正好吞掉 `re data-language="sql"`），
   * 之后去找 `</p>` 自然找不到，整个 <pre> 块被跳过 —— 表现为"代码块凭空消失"。
   */
  const blockRe = /<(h[1-6]|pre|p|div|li)[^>]*>([\s\S]*?)<\/\1>|<br\s*\/?>/gi
  let m: RegExpExecArray | null
  let matched = false
  while ((m = blockRe.exec(html))) {
    if (m[0].toLowerCase().startsWith('<br')) {
      body.push('<w:p/>')
      continue
    }
    matched = true
    const tag = m[1].toLowerCase()
    /**
     * 代码块：**必须单独处理**，不能走下面的普通段落。
     *
     * 原先 blockRe 里没有 pre，`<pre data-language="sql">…</pre>` 整块落到末尾
     * "按换行拆段"的兜底分支：缩进被吃掉、行与行变成独立段落、等宽与底纹全丢 ——
     * 一轮 docx 往返之后代码块就散架了。
     *
     * 语言存成**第一行的可见标记** [sql]，而不是段落样式名：样式名要 mammoth
     * 配合 styleMap 才能读回来（默认丢弃），而首行文本怎么转都不会丢。
     * 代价是 Word 里能看见这行标记 —— 相对于"语言悄悄消失"，这个代价可以接受。
     * 读回方向由 restoreCodeBlocks 把它还原成 data-language。
     */
    if (tag === 'pre') {
      const lang = /data-language=["']([^"']*)["']/i.exec(m[0])?.[1]?.trim() ?? ''
      // 去掉内层 <code> 之类的标签，只留文本
      const raw = (m[2] ?? '').replace(/<[^>]*>/g, '')
      const text = (lang ? '[' + lang + ']\n' : '') + decodeEntities(raw)
      body.push(codeParagraph(text))
      continue
    }
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

/**
 * 代码块段落：等宽字体 + 浅灰底纹 + 小一号字号。
 *
 * 用底纹（w:shd）而不是边框：最小 OOXML 里加边框要动 pBdr，
 * 而 shd 一个属性就能给出"这是一块代码"的观感，mammoth 也会把它读成背景色。
 */
function codeParagraph(text: string): string {
  const pPr =
    '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F5F6F7"/>' +
    '<w:spacing w:before="120" w:after="120"/></w:pPr>'
  const rPr =
    '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' +
    '<w:sz w:val="20"/></w:rPr>'
  const segs = text
    .split('\n')
    .map((s, i) => (i ? '<w:br/>' : '') + '<w:t xml:space="preserve">' + xmlEscape(s) + '</w:t>')
    .join('')
  return '<w:p>' + pPr + '<w:r>' + rPr + segs + '</w:r></w:p>'
}

/** 把常见 HTML 实体还原成字符（为代码块文本服务）。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/**
 * 把 mammoth 读出来的「等宽段落」还原成代码块。
 *
 * mammoth 不认识代码块，它只看到一段等宽字体的普通文字，输出形如：
 *   <p><span style="font-family:Consolas">[sql]<br/>SELECT 1</span></p>
 * 我们写回 docx 时把语言放在了首行（[sql]），这里把它收回 data-language，
 * 往返因此闭环：编辑器里是 <pre data-language="sql">，存成 docx 再读回来还是它。
 *
 * 只认 font-family 里出现 consolas / monospace 的段落 —— 这正是 codeParagraph
 * 写进去的那一种，不会误伤普通正文。
 */
export function restoreCodeBlocks(html: string): string {
  return html.replace(
    /<p>\s*<span[^>]*font-family:\s*[^;"']*(?:consolas|monospace)[^>]*>([\s\S]*?)<\/span>\s*<\/p>/gi,
    (_m, inner: string) => {
      const text = decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''))
      const mm = /^\[([a-z0-9+#_-]+)\]\n?/i.exec(text)
      const lang = mm ? mm[1] : ''
      const body = mm ? text.slice(mm[0].length) : text
      return '<pre' + (lang ? ' data-language="' + lang + '"' : '') + '>' + escapeHtml(body) + '</pre>'
    }
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
