import { describe, expect, it } from 'vitest'
import { attachmentUrl } from './attachment-url'

/**
 * 附件路径 → file:// URL。
 *
 * 这组用例的来由：1.6.0 里三处各写了一份拼装，其中两处（RichTextEditor 的图片预览与
 * 附件链接）在 Windows 上产出 \`file://C%3A%5C...\` —— 实测 \`new URL()\` 直接报 Invalid URL。
 * 缩略图是内嵌 data URI 所以看着正常，把这条掩盖了整整一个版本。
 *
 * 所以这里最要紧的断言不是「字符串长什么样」，而是 **new URL() 必须能解析**。
 */
const parse = (u: string): URL => new URL(u)

describe('attachmentUrl —— Windows 绝对路径', () => {
  it('反斜杠路径要变成合法的 file:// URL', () => {
    const u = attachmentUrl('C:\\Users\\me\\attachments\\3\\photo.png')
    expect(u).toBe('file:///C:/Users/me/attachments/3/photo.png')
    expect(parse(u).protocol).toBe('file:')
    expect(parse(u).pathname).toBe('/C:/Users/me/attachments/3/photo.png')
  })

  it('中文与空格逐段编码（否则放进 Markdown 链接会被截断）', () => {
    const u = attachmentUrl('C:\\Users\\me\\attachments\\3\\我的 图.png')
    expect(u).toBe('file:///C:/Users/me/attachments/3/%E6%88%91%E7%9A%84%20%E5%9B%BE.png')
    expect(parse(u).protocol).toBe('file:')
  })

  it('盘符的冒号不能被编码（encodeURIComponent 会把 C: 变成 C%3A）', () => {
    expect(attachmentUrl('C:\\a\\b.png')).toContain('/C:/')
    expect(attachmentUrl('C:\\a\\b.png')).not.toContain('C%3A')
  })

  it('已经是正斜杠的路径也接受', () => {
    expect(attachmentUrl('D:/x/y.png')).toBe('file:///D:/x/y.png')
  })

  it('空输入返回空串，不抛也不产出 file:/// 这种半截 URL', () => {
    expect(attachmentUrl('')).toBe('')
    expect(attachmentUrl(null as unknown as string)).toBe('')
  })

  it('已经是 URL 形态就不重复加工', () => {
    expect(attachmentUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
  })

  it('旧写法产出的串是解析不了的（把这条缺陷钉在测试里）', () => {
    const legacy = 'file://' + 'C:\\a\\b.png'.split('/').map(encodeURIComponent).join('/')
    expect(() => parse(legacy)).toThrow()
  })
})
