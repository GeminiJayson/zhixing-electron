import { describe, expect, it } from 'vitest'
import { htmlToDocumentXml, restoreCodeBlocks } from './preview'

/**
 * Word 笔记的代码块往返。
 *
 * 这两条合起来才是闭环：写回时把 <pre data-language> 转成等宽的 Word 段落
 * （语言放首行 [sql]），读回时再把等宽段落还原成 <pre data-language>。
 * 少了任何一边，用户看到的都是"存一次代码块就没了"。
 */
describe('Word 代码块 · 写回 docx', () => {
  it('pre 变成等宽段落，语言进首行', () => {
    const xml = htmlToDocumentXml('<pre data-language="sql">SELECT 1</pre>')
    expect(xml).toContain('Consolas')
    expect(xml).toContain('[sql]')
    expect(xml).toContain('SELECT 1')
  })

  it('没有语言时不留下空的方括号', () => {
    const xml = htmlToDocumentXml('<pre>plain</pre>')
    expect(xml).toContain('plain')
    expect(xml).not.toContain('[]')
  })

  it('多行代码用 br 保留换行，而不是拆成多个段落', () => {
    const xml = htmlToDocumentXml('<pre data-language="js">a\nb</pre>')
    // 整块只应产生一个 <w:p>
    expect(xml.match(/<w:p>/g)?.length).toBe(1)
    expect(xml).toContain('<w:br/>')
  })

  it('内层 code 标签被剥掉，实体被还原', () => {
    const xml = htmlToDocumentXml('<pre data-language="html"><code>&lt;div&gt;</code></pre>')
    // xmlEscape 会再转义一次，所以 XML 里应当是 &lt;div&gt;
    expect(xml).toContain('&lt;div&gt;')
    expect(xml).not.toContain('&amp;lt;')
  })

  it('普通段落的处理不受影响', () => {
    const xml = htmlToDocumentXml('<p>正文</p><pre data-language="py">x=1</pre><p>结尾</p>')
    expect(xml.match(/<w:p>/g)?.length).toBe(3)
    expect(xml).toContain('正文')
    expect(xml).toContain('结尾')
  })
})

describe('Word 代码块 · 读回 HTML', () => {
  it('mammoth 的等宽段落还原成 pre + data-language', () => {
    const html = '<p><span style="font-family:Consolas">[sql]<br/>SELECT 1</span></p>'
    expect(restoreCodeBlocks(html)).toBe('<pre data-language="sql">SELECT 1</pre>')
  })

  it('没有语言标记的等宽段落也还原（只是没有 data-language）', () => {
    expect(restoreCodeBlocks('<p><span style="font-family:Consolas">x=1</span></p>')).toBe('<pre>x=1</pre>')
  })

  it('monospace 也认（不同 Word 版本写出的字体名不一样）', () => {
    const html = '<p><span style="font-family: monospace">[py]<br/>x=1</span></p>'
    expect(restoreCodeBlocks(html)).toContain('data-language="py"')
  })

  it('普通段落原样保留', () => {
    const html = '<p>正文</p><p><span style="color:red">红字</span></p>'
    expect(restoreCodeBlocks(html)).toBe(html)
  })

  it('往返一致：写回再读回，语言与内容都还在', () => {
    const src = '<pre data-language="sql">SELECT 1</pre>'
    // 写回方向的产物里含 [sql] 与 Consolas；模拟 mammoth 把它读成等宽段落
    const back = restoreCodeBlocks('<p><span style="font-family:Consolas">[sql]<br/>SELECT 1</span></p>')
    expect(back).toBe(src)
  })
})
