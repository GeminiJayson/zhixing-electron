import { describe, expect, it } from 'vitest'
import { absolutizeClipImages } from './clip-html'

const PAGE = 'https://news.example.com/a/b/post.html'

describe('absolutizeClipImages', () => {
  it('相对 src 变绝对', () => {
    expect(absolutizeClipImages('<img src="/uploads/p.png">', PAGE)).toContain('src="https://news.example.com/uploads/p.png"')
    expect(absolutizeClipImages('<img src="pic.png">', PAGE)).toContain('src="https://news.example.com/a/b/pic.png"')
  })
  it('已经是绝对 / data: 的不动', () => {
    const html = '<img src="https://cdn.x/y.png"><img src="data:image/png;base64,AAA">'
    expect(absolutizeClipImages(html, PAGE)).toBe(html)
  })
  it('懒加载：占位 src 换成 data-src 的真图', () => {
    const out = absolutizeClipImages('<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/real.jpg">', PAGE)
    expect(out).toContain('src="https://news.example.com/real.jpg"')
  })
  it('srcset 里每一段都绝对化', () => {
    const out = absolutizeClipImages('<img srcset="/a.png 1x, /b.png 2x">', PAGE)
    expect(out).toContain('https://news.example.com/a.png 1x')
    expect(out).toContain('https://news.example.com/b.png 2x')
  })
  it('页面地址非法时原样返回（不抛）', () => {
    const html = '<img src="/a.png">'
    expect(absolutizeClipImages(html, 'not-a-url')).toBe(html)
    expect(absolutizeClipImages(html, '')).toBe(html)
  })
  it('正文里没有图片时不做无谓改动', () => {
    const html = '<p>只有文字</p>'
    expect(absolutizeClipImages(html, PAGE)).toBe(html)
  })
})
