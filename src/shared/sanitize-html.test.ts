import { describe, expect, it } from 'vitest'
import { sanitizeHtml } from './sanitize-html'

/**
 * 共享白名单消毒器。
 *
 * 这个模块此前**没有一行单测** —— 而它守着笔记正文、Office 预览这类不可信内容。
 * 同时渲染层还留着一套自己的黑名单实现（MarkdownView），审计指出它可被 \`java\tscript:\` 绕过
 * （浏览器解析 URL 时会剥掉 tab，于是又变回 javascript: 协议）。
 */
describe('sanitizeHtml —— 危险输入一律拦住', () => {
  const cases: [string, string][] = [
    ['javascript: 大小写变形', '<a href="JaVaScRiPt:alert(1)">x</a>'],
    ['tab 混淆', '<a href="java\tscript:alert(1)">x</a>'],
    ['换行混淆', '<a href="java\nscript:alert(1)">x</a>'],
    ['前导空白 + 控制字符', '<a href="  \u0001javascript:alert(1)">x</a>'],
    ['内联事件处理器', '<img src="x" onerror="alert(1)">'],
    ['svg/onload', '<svg onload="alert(1)"></svg>'],
    ['script 连内容一起丢', '<p>a</p><script>alert(1)</script>'],
    ['iframe', '<iframe src="https://evil"></iframe>'],
    ['data:text/html 链接', '<a href="data:text/html,x">x</a>'],
    ['内联 style 属性', '<p style="background:url(javascript:alert(1))">x</p>'],
    ['vbscript:', '<a href="vbscript:msgbox(1)">x</a>'],
  ]
  it.each(cases)('拦住：%s', (_name, html) => {
    const out = sanitizeHtml(html)
    expect(out).not.toMatch(/<script|<svg|onerror|onload|javascript:|vbscript:|<iframe|data:text\/html/i)
  })
})

describe('sanitizeHtml —— 该保留的要留住', () => {
  it('保留基础结构标签与属性', () => {
    const out = sanitizeHtml('<h1>标题</h1><p>正文<strong>粗</strong><em>斜</em></p>')
    expect(out).toContain('<h1>')
    expect(out).toContain('<strong>')
    expect(out).toContain('<em>')
  })

  it('保留 http / https / mailto 链接', () => {
    expect(sanitizeHtml('<a href="https://example.com">x</a>')).toContain('href="https://example.com"')
    expect(sanitizeHtml('<a href="mailto:a@b.c">x</a>')).toContain('mailto:a@b.c')
  })

  it('保留 data:image 的 src（笔记里的内嵌缩略图靠它）', () => {
    expect(sanitizeHtml('<img src="data:image/png;base64,AAA">')).toContain('data:image/png')
  })

  it('保留 Markdown 任务列表的勾选框 —— marked 产出的是 input', () => {
    // 换用共享白名单时最容易踩的就是这里：input 不在原白名单里，勾选框会整片消失
    const out = sanitizeHtml('<ul><li><input disabled="" type="checkbox"> todo</li></ul>')
    expect(out).toContain('<input')
    expect(out).toContain('type="checkbox"')
  })

  it('但 input 上不放行任何会发起请求或提交的属性', () => {
    const out = sanitizeHtml('<input type="checkbox" src="https://evil/x.png" formaction="https://evil">')
    expect(out).not.toContain('evil')
  })
})
