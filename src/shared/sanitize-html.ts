/**
 * HTML 白名单清洗（主进程与渲染层共用）。
 *
 * 为什么放在 shared：Office 预览（主进程 `db/preview.ts`）与富文本笔记预览（渲染层
 * `pages/NotesPage.tsx`）都需要清洗用户提供的 HTML。两边各写一套必然漂移——R7 把主进程
 * 改成白名单后，渲染层那份黑名单正则就与注释所称的「同口径」不再一致。
 *
 * 本模块是**纯字符串处理**，不依赖 DOM，因此两个进程都能用。
 *
 * 设计取向：**默认拒绝**。黑名单漏掉任何一个标签或写法就等于没拦（大小写变形、属性引号
 * 变体、插入控制字符都能绕过）；这里逐 token 解析，不在白名单的标签整个丢弃，
 * 事件属性 / style / class / id 与 javascript:、vbscript: 等危险 URL 直接剔除，
 * script/style 等标签连同内容一起移除。
 */

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 允许保留的标签白名单（mammoth / xlsx / 富文本编辑器会产出的安全结构标签）。 */
const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'del',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'hr', 'i', 'img', 'ins', 'li', 'mark', 'ol', 'p', 'pre', 's', 'small',
  'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'u', 'ul',
  // Markdown 任务列表（marked 的 GFM 输出）是 <input type="checkbox" disabled>；
  // 不放行它，笔记预览里的勾选框会整片消失。属性白名单见 TAG_ATTRS。
  'input',
])

/**
 * 这些标签连同**内容**一起丢弃：只扔标签还不够 —— 脚本正文会作为普通文本
 * 留在页面上，既难看又可能被下游误用。
 */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template',
  'svg', 'math', 'form', 'link', 'meta', 'base', 'head', 'title', 'textarea',
  'select', 'button', 'audio', 'video', 'source', 'track', 'applet', 'frame',
  'frameset', 'xml',
])

const VOID_TAGS = new Set(['br', 'hr', 'img', 'col', 'area', 'input'])

/** 每个标签额外允许的属性；所有标签都另有 GLOBAL_ATTRS。 */
const TAG_ATTRS: Record<string, string[]> = {
  a: ['href', 'name'],
  img: ['src', 'alt', 'width', 'height'],
  table: ['border', 'cellpadding', 'cellspacing', 'width', 'align'],
  td: ['colspan', 'rowspan', 'align', 'valign', 'width', 'height'],
  th: ['colspan', 'rowspan', 'align', 'valign', 'width', 'height'],
  col: ['span', 'width'],
  colgroup: ['span', 'width'],
  ol: ['start', 'type'],
  ul: ['type'],
  li: ['value'],
  // 只放行这三样：type / checked / disabled 都不会发起请求，也不会提交表单。
  // src、formaction 这类必须挡在外面。
  input: ['type', 'checked', 'disabled'],
}
const GLOBAL_ATTRS = new Set(['title', 'dir', 'lang'])

/**
 * 取 URL 的协议名：只认第一个冒号之前、去掉所有非字母数字后的结果。
 * 这样插入空白或控制字符的 java script: 与大小写变形都会被识别成 javascript 并拒绝。
 * 没有冒号返回空串，交给调用方按「相对路径 / 页内锚点」放行。
 */
function schemeOf(value: string): string {
  const idx = value.indexOf(':')
  if (idx < 0) return ''
  return value.slice(0, idx).replace(/[^a-z0-9+.-]/gi, '').toLowerCase()
}

/** 普通链接允许的协议（含相对路径与页内锚点）；src 额外允许 data:image。 */
function safeUrl(name: string, value: string): boolean {
  const v = value.trim().toLowerCase()
  const scheme = schemeOf(v)
  if (!scheme) return true
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'zhixing-note') {
    return true
  }
  return name === 'src' && v.startsWith('data:image/')
}

/** 过滤单标签的属性：只留白名单属性，事件 / style / class / id 与危险 URL 一律丢弃。 */
function filterAttrs(tag: string, raw: string): string {
  const allowed = new Set([...GLOBAL_ATTRS, ...(TAG_ATTRS[tag] ?? [])])
  const out: string[] = []
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase()
    if (name.startsWith('on') || !allowed.has(name)) continue
    const value = m[3] ?? m[4] ?? m[5] ?? ''
    if ((name === 'href' || name === 'src') && !safeUrl(name, value)) continue
    out.push(' ' + name + '="' + escapeHtml(value) + '"')
  }
  return out.join('')
}

/** 白名单清洗入口：不在白名单的标签与属性一律剥掉，危险标签连内容一起丢弃。 */
export function sanitizeHtml(html: string): string {
  const src = html ?? ''
  const lower = src.toLowerCase()
  let out = ''
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      out += src.slice(i)
      break
    }
    out += src.slice(i, lt)
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      i = end < 0 ? src.length : end + 3
      continue
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt)
      i = end < 0 ? src.length : end + 1
      continue
    }
    const close = src.indexOf('>', lt)
    if (close < 0) {
      out += src.slice(lt)
      break
    }
    const inner = src.slice(lt + 1, close)
    const m = /^(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([\s\S]*)$/.exec(inner)
    if (!m) {
      out += '&lt;'
      i = lt + 1
      continue
    }
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    const attrs = m[3] ?? ''
    if (DROP_WITH_CONTENT.has(tag)) {
      if (closing) {
        i = close + 1
        continue
      }
      const end = lower.indexOf('</' + tag, close + 1)
      if (end < 0) {
        i = src.length
      } else {
        const gt = src.indexOf('>', end)
        i = gt < 0 ? src.length : gt + 1
      }
      continue
    }
    i = close + 1
    if (!ALLOWED_TAGS.has(tag)) continue
    if (closing) out += '</' + tag + '>'
    else if (VOID_TAGS.has(tag)) out += '<' + tag + filterAttrs(tag, attrs) + '/>'
    else out += '<' + tag + filterAttrs(tag, attrs) + '>'
  }
  return out
}
