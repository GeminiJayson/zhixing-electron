/**
 * Office 文档内嵌预览（O11）：把 .docx/.xlsx 解析成 HTML 供只读展示。
 *
 * 与 Python 版的 python-docx / openpyxl 预览等价。因为要把解析结果交给渲染进程，
 * 这里对外部文档产出的 HTML 做一次白名单清洗——文档是用户提供的输入，不能直接注入页面。
 */
import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import { getNote } from './notes'

export interface OfficePreview {
  kind: 'docx' | 'xlsx' | 'none'
  html: string
  message: string
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 清洗解析结果：去掉脚本类标签、内联事件属性与 javascript: 协议。
 * mammoth 本身会转义正文文本，这层是防御性的纵深措施。
 */
function sanitize(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|form)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|form)[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '')
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
        html: sanitize(res.value),
        message: warns ? `已解析（${warns} 处格式未能完整转换）` : '已解析全文',
      }
    }
    if (ext === '.xlsx' || ext === '.xls') {
      const wb = XLSX.readFile(target)
      const parts: string[] = []
      for (const name of wb.SheetNames.slice(0, 10)) {
        const table = XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' })
        const inner = table.replace(/[\s\S]*?<body>/, '').replace(/<\/body>[\s\S]*/, '')
        parts.push(`<h3>${escapeHtml(name)}</h3>${inner}`)
      }
      return {
        kind: 'xlsx',
        html: sanitize(parts.join('\n')),
        message: `${wb.SheetNames.length} 个工作表`,
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { kind: 'none', html: '', message: `解析失败：${msg}` }
  }
  return { kind: 'none', html: '', message: '仅支持 .docx / .xlsx 内嵌预览' }
}
