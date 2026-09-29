import { describe, expect, it } from 'vitest'
import { looksLikeHtml, plainTextOfHtml, titleFromContent } from './html-text'

/**
 * 快速笔记的富文本条目与收件箱的纯文本条目共用 flash 这一张表，
 * flashToNote 只能靠内容本身判断该建成 markdown 还是 richtext 笔记。
 * 判错的后果：HTML 以 markdown 落库 → 打开笔记满屏标签源码。
 */
describe('闪念内容形态识别', () => {
  it('识别富文本编辑器产出的 HTML', () => {
    expect(looksLikeHtml('<p>一段话</p>')).toBe(true)
    expect(looksLikeHtml('<h2>标题</h2><p>正文</p>')).toBe(true)
    expect(looksLikeHtml('<ul><li>项</li></ul>')).toBe(true)
    expect(looksLikeHtml('<pre data-language="sql">SELECT 1</pre>')).toBe(true)
    expect(looksLikeHtml('  \n<p>前导空白也算</p>')).toBe(true)
  })

  it('纯文本不会被误判', () => {
    expect(looksLikeHtml('随手记一句')).toBe(false)
    expect(looksLikeHtml('明天要问 API 的事')).toBe(false)
    // 小于号出现在文中（数学比较）不该被当成标签
    expect(looksLikeHtml('1 < 2 而 3 > 2')).toBe(false)
    expect(looksLikeHtml('')).toBe(false)
  })

  it('剥标签取标题：块级之间补空格，不黏成一串', () => {
    expect(plainTextOfHtml('<p>第一段</p><p>第二段</p>')).toBe('第一段 第二段')
    expect(plainTextOfHtml('<h2>标题</h2><p>正文</p>')).toBe('标题 正文')
    expect(plainTextOfHtml('<ul><li>甲</li><li>乙</li></ul>')).toBe('甲 乙')
  })

  it('行内标签不留空格（否则会把词切开）', () => {
    expect(plainTextOfHtml('<p>加<strong>粗</strong>的字</p>')).toBe('加粗的字')
  })

  it('实体被还原', () => {
    expect(plainTextOfHtml('<p>a &amp; b &lt; c</p>')).toBe('a & b < c')
    expect(plainTextOfHtml('<p>x&nbsp;y</p>')).toBe('x y')
  })

  it('空内容得到空串（调用方据此回退到「来自闪念」）', () => {
    expect(plainTextOfHtml('<p></p>')).toBe('')
    expect(plainTextOfHtml('')).toBe('')
  })

  it('取标题：HTML 先剥标签再截断', () => {
    expect(titleFromContent('<p>这是标题</p><p>正文</p>')).toBe('这是标题')
    expect(titleFromContent('纯文本标题\n第二行')).toBe('纯文本标题')
    expect(titleFromContent('<p>' + 'x'.repeat(80) + '</p>')).toHaveLength(40)
    expect(titleFromContent('<p></p>')).toBe('')
  })
})
