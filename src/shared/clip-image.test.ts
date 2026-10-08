import { describe, expect, it } from 'vitest'
import { attachUrl, collectImageUrls, imageExt, parseAttachUrl, replaceImageUrl } from './clip-image'

describe('collectImageUrls', () => {
  it('取出所有 http(s) 图片、去重、保序', () => {
    const html = '<img src="https://a/1.png"><img src="https://b/2.jpg"><img src="https://a/1.png">'
    expect(collectImageUrls(html)).toEqual(['https://a/1.png', 'https://b/2.jpg'])
  })
  it('跳过 data: 与相对地址（相对地址该在绝对化那一步处理完）', () => {
    expect(collectImageUrls('<img src="data:image/png;base64,AAA"><img src="/a.png">')).toEqual([])
  })
})

describe('imageExt', () => {
  it('优先按 content-type', () => {
    expect(imageExt('image/png', 'https://a/x.jpg')).toBe('png')
    expect(imageExt('image/jpeg; charset=binary', 'https://a/x')).toBe('jpg')
  })
  it('没有 content-type 时看 URL 扩展名', () => {
    expect(imageExt('', 'https://a/x.webp')).toBe('webp')
    expect(imageExt('', 'https://a/x.unknown')).toBe('img')
    expect(imageExt('', 'not-a-url')).toBe('img')
  })
})

describe('replaceImageUrl', () => {
  it('src 与 srcset 里的那一份都换掉，别的图不受影响', () => {
    const html = '<img src="https://a/1.png"><img srcset="https://a/1.png 1x, https://a/2.png 2x">'
    const out = replaceImageUrl(html, 'https://a/1.png', 'zx-attach://d/1.png')
    expect(out).toBe('<img src="zx-attach://d/1.png"><img srcset="zx-attach://d/1.png 1x, https://a/2.png 2x">')
  })
  it('URL 里的正则元字符按字面处理（不会误伤其它图）', () => {
    const html = '<img src="https://a/x.png?v=1"><img src="https://a/xYpng?v=1">'
    const out = replaceImageUrl(html, 'https://a/x.png?v=1', 'zx-attach://d/x.png')
    expect(out).toContain('src="zx-attach://d/x.png"')
    expect(out).toContain('https://a/xYpng?v=1')
  })
})

describe('parseAttachUrl（安全边界）', () => {
  it('正常路径解析出目录与文件名', () => {
    expect(parseAttachUrl('zx-attach://clip-ab12/a.png')).toEqual({ dir: 'clip-ab12', file: 'a.png' })
    expect(parseAttachUrl(attachUrl('clip-ab12', 'a.png'))).toEqual({ dir: 'clip-ab12', file: 'a.png' })
  })
  it('挡掉路径穿越与斜杠', () => {
    expect(parseAttachUrl('zx-attach://../etc/passwd')).toBe(null)
    expect(parseAttachUrl('zx-attach://a/..%2Fsecret')).toBe(null)
    expect(parseAttachUrl('zx-attach://a/b/c.png')).toBe(null)
    expect(parseAttachUrl('file:///C:/Windows/win.ini')).toBe(null)
    expect(parseAttachUrl('')).toBe(null)
  })
})
