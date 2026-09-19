import { describe, expect, it } from 'vitest'
import {
  AI_DEFAULT_TIMEOUT_SEC,
  AI_PROMPT_VARS,
  auditLinkAssignment,
  DEFAULT_AI_PROMPT,
  auditOrganizedNote,
  describeFolders,
  describePlaceholders,
  extractNotePlaceholders,
  flattenFolders,
  normalizeAiProtocol,
  parseAiResult,
  renderAiPrompt,
  restoreNotePlaceholders,
  splitFolderPath,
  urlsIn,
  wikiLinks,
} from './ai-note'

describe('附件占位符 —— 图片与文件不进请求，只留标记', () => {
  const md = [
    '# 标题',
    '',
    '看这张图 ![架构图](assets/arch.png) 和这张 ![截图](C:/tmp/shot.jpg "截")',
    '',
    '方案在 [设计文档](docs/design.md) 里，外链见 [官网](https://example.com) 与 [[另一篇笔记]]。',
    '',
    '<img src="images/inline.png" alt="内联图">',
  ].join('\n')

  it('图片与本地文件被抽成占位符，外链与双链原样留下', () => {
    const { text, items } = extractNotePlaceholders(md)
    expect(items.map((p) => p.token)).toEqual(['@@IMG1@@', '@@IMG2@@', '@@FILE1@@', '@@IMG3@@'])
    expect(items[0]).toMatchObject({ kind: 'image', label: '架构图', target: 'assets/arch.png' })
    expect(items[2]).toMatchObject({ kind: 'file', label: '设计文档', target: 'docs/design.md' })
    expect(text).toContain('@@IMG1@@')
    expect(text).toContain('https://example.com')
    expect(text).toContain('[[另一篇笔记]]')
    // 原始片段要留住，才能原样填回
    expect(items[1].raw).toBe('![截图](C:/tmp/shot.jpg "截")')
  })

  it('填回后与原文一致（位置可以变，内容不能变）', () => {
    const { text, items } = extractNotePlaceholders(md)
    const reordered = text.split('\n').reverse().join('\n')
    const { text: restored, missing } = restoreNotePlaceholders(reordered, items)
    expect(missing).toEqual([])
    for (const p of items) expect(restored).toContain(p.raw)
  })

  it('模型弄丢占位符 / 自造标记都能被发现', () => {
    const { items } = extractNotePlaceholders(md)
    const r = restoreNotePlaceholders('只剩 @@IMG1@@ 和 @@IMG9@@', items)
    expect(r.missing.map((p) => p.token)).toEqual(['@@IMG2@@', '@@FILE1@@', '@@IMG3@@'])
    expect(r.leftover).toEqual(['@@IMG9@@'])
  })

  it('占位符说明写进提示词，供模型知道标记代表什么', () => {
    const { items } = extractNotePlaceholders(md)
    const text = describePlaceholders(items)
    expect(text).toContain('@@IMG1@@ → 图片：架构图')
    expect(text).toContain('@@FILE1@@ → 文件：设计文档')
    expect(describePlaceholders([])).toContain('没有图片或附件')
  })
})

describe('审计 —— 写库前的最后一道闸', () => {
  const original = [
    '# 会议纪要',
    '',
    '结论见 [[需求评审]]，参考 [文档](https://example.com/doc) 与 [附图](assets/a.png)。',
    '',
    '还有一张 ![流程图](assets/b.png)',
  ].join('\n')
  const { items } = extractNotePlaceholders(original)
  const placeholders = items.map((p) => p.token).join(' ')

  it('内容完整、链接与占位符都在 → 放行', () => {
    const next = `# 会议纪要\n\n## 结论\n\n见 [[需求评审]]，参考 [文档](https://example.com/doc) 与 ${placeholders}`
    const r = auditOrganizedNote({ original, next, items })
    expect(r.ok).toBe(true)
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([])
  })

  it('丢了双链 → 拦住', () => {
    const r = auditOrganizedNote({ original, next: `见 ${placeholders}`, items })
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.message.includes('丢失双链'))).toBe(true)
  })

  it('丢了外链 → 拦住', () => {
    const r = auditOrganizedNote({
      original,
      next: `见 [[需求评审]] ${placeholders}`,
      items,
    })
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.message.includes('丢失链接'))).toBe(true)
  })

  it('丢了图片占位符 → 拦住，并说清丢的是哪一张', () => {
    // 原文顺序是 [附图](assets/a.png)=@@FILE1@@、![流程图](assets/b.png)=@@IMG1@@
    const r = auditOrganizedNote({
      original,
      next: '见 [[需求评审]] 与 [文档](https://example.com/doc) 和 @@FILE1@@',
      items,
    })
    expect(r.ok).toBe(false)
    const hit = r.issues.find((i) => i.message.includes('@@IMG1@@'))
    expect(hit?.message).toContain('图片')
  })

  it('结果为空 / 篇幅骤减 → 拦住；大幅膨胀 → 只警告', () => {
    expect(auditOrganizedNote({ original, next: '   ', items }).ok).toBe(false)
    const long = '# 标题\n' + '内容'.repeat(5000)
    const big = auditOrganizedNote({ original: long, next: '# 标题\n短', items: [] })
    expect(big.ok).toBe(false)
    const fat = auditOrganizedNote({ original: long, next: long.repeat(8), items: [] })
    expect(fat.ok).toBe(true)
    expect(fat.issues.some((i) => i.level === 'warn')).toBe(true)
  })
})

describe('模型输出解析与提示词渲染', () => {
  it('剥掉代码围栏与多余说明后仍能解析', () => {
    const r = parseAiResult('好的，结果如下：\n\n```json\n{"folder":"技术","title":"T","summary":"s","content":"# T"}\n```\n希望有帮助')
    expect(r).toMatchObject({ folder: '技术', title: 'T', content: '# T' })
  })

  it('坏 JSON / 什么都没给 → null；只有 folder 是合法的（Word 只归类）', () => {
    expect(parseAiResult('不是 JSON')).toBeNull()
    expect(parseAiResult('')).toBeNull()
    expect(parseAiResult('{"summary":"只有摘要"}')).toBeNull()
    expect(parseAiResult('{"folder":"a"}')).toMatchObject({ folder: 'a', content: '' })
  })

  it('链接笔记：links 会被解析出来，坏项被丢掉', () => {
    const r = parseAiResult(
      JSON.stringify({
        folder: '资料',
        content: '',
        links: [
          { title: '知乎', url: 'https://zhihu.com', into: '阅读' },
          { title: '缺 url' },
          { url: 'https://b.com' },
        ],
      })
    )
    expect(r?.links).toEqual([
      { title: '知乎', url: 'https://zhihu.com', into: '阅读' },
      { title: '', url: 'https://b.com', into: '' },
    ])
  })

  it('链接审计：漏掉一条就拦下，多出来的只提醒', () => {
    const original = [
      { title: 'A', target: 'https://a.com' },
      { title: 'B', target: 'https://b.com' },
    ]
    expect(
      auditLinkAssignment({
        original,
        returned: [
          { title: 'A', url: 'https://a.com', into: '' },
          { title: 'B', url: 'https://b.com', into: '阅读' },
        ],
      }).ok
    ).toBe(true)
    const bad = auditLinkAssignment({
      original,
      returned: [{ title: 'A', url: 'https://a.com', into: '' }],
    })
    expect(bad.ok).toBe(false)
    expect(bad.issues[0].message).toContain('B')
    const extra = auditLinkAssignment({
      original,
      returned: [
        { title: 'A', url: 'https://a.com', into: '' },
        { title: 'B', url: 'https://b.com', into: '' },
        { title: 'X', url: 'https://x.com', into: '' },
      ],
    })
    expect(extra.ok).toBe(true)
    expect(extra.issues.some((i) => i.level === 'warn')).toBe(true)
  })

  it('提示词渲染：变量被替换，缺 CONTENT 时判为不可用', () => {
    const tpl = '文件夹：{{FOLDERS}}\n标题：{{TITLE}}\n正文：\n{{CONTENT}}'
    const r = renderAiPrompt(tpl, {
      folders: 'A/B',
      notes: '- 已有笔记',
      title: 'T',
      format: 'markdown',
      kind: 'Markdown 笔记',
      attachments: '',
      content: 'C',
    })
    expect(r.ok).toBe(true)
    expect(r.prompt).toContain('A/B')
    expect(r.prompt).toContain('C')
    const vars = { folders: '', notes: '', title: '', format: '', kind: '', attachments: '', content: 'x' }
    expect(renderAiPrompt('只有正文：{{CONTENT}}', vars).ok).toBe(true)
    expect(renderAiPrompt('没有正文变量', vars).ok).toBe(false)
    // 模板为空时回落到默认提示词
    const fallback = renderAiPrompt('', vars)
    expect(fallback.prompt).toContain('x')
    expect(fallback.ok).toBe(true)
  })

  it('协议归一：不认识的回落 OpenAI 兼容', () => {
    expect(normalizeAiProtocol('anthropic')).toBe('anthropic')
    expect(normalizeAiProtocol('gemini')).toBe('gemini')
    expect(normalizeAiProtocol('')).toBe('openai')
    expect(normalizeAiProtocol('随便')).toBe('openai')
  })

  it('默认提示词包含全部变量，且明确写了「链接不丢」与两件事', () => {
    for (const v of AI_PROMPT_VARS) expect(DEFAULT_AI_PROMPT).toContain(v)
    expect(DEFAULT_AI_PROMPT).toContain('不得删除任何信息')
    expect(DEFAULT_AI_PROMPT).toContain('归类')
    expect(DEFAULT_AI_PROMPT).toContain('排版')
    expect(AI_DEFAULT_TIMEOUT_SEC).toBeGreaterThan(30)
  })
})

describe('文件夹路径处理', () => {
  it('切分路径：容忍 / \\ > 与多余空白', () => {
    expect(splitFolderPath('技术/数据库')).toEqual(['技术', '数据库'])
    expect(splitFolderPath('A > B > C')).toEqual(['A', 'B', 'C'])
    expect(splitFolderPath('单层')).toEqual(['单层'])
    expect(splitFolderPath('')).toEqual([])
  })

  it('摊平文件夹树 → 完整路径表', () => {
    const map = flattenFolders([
      { id: 1, parent_id: null, name: '技术' },
      { id: 2, parent_id: 1, name: '数据库' },
      { id: 3, parent_id: null, name: '生活' },
    ])
    expect(map.get('技术/数据库')).toBe(2)
    expect(map.get('生活')).toBe(3)
    expect(map.get('技术')).toBe(1)
    expect(describeFolders(['技术/数据库'])).toContain('- 技术/数据库')
    expect(describeFolders([])).toContain('还没有任何文件夹')
  })

  it('抽链接：双链去重、URL 去掉尾部标点', () => {
    expect(wikiLinks('[[A]] 与 [[B]] 再来 [[A]]')).toEqual(['A', 'B'])
    expect(urlsIn('见 https://a.com/x。还有 (https://b.com/y)')).toEqual(['https://a.com/x', 'https://b.com/y'])
  })
})
