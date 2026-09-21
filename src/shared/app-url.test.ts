import { describe, expect, it } from 'vitest'
import { isAppOwnUrl } from './app-url'

// 这条判定守着 will-navigate：命中即放行，未命中就 preventDefault 并把链接交给系统浏览器。
// 原实现是 url.startsWith(自身 URL)，于是
//   http://localhost:5173.evil.com/      以 devUrl 为前缀被放行（dev 模式）
//   file:///…/renderer/index.html.evil   以 index.html 为前缀被放行（生产也中）
// 都会把外部页面放进一个带着 preload 和全部 IPC 的窗口里。
const DEV = 'http://localhost:5173'
const HTML = 'file:///C:/app/res/renderer/index.html'
const own = (url: string, devUrl?: string) => isAppOwnUrl(url, { devUrl, htmlHref: HTML })

describe('应用自身 URL 判定', () => {
  it('dev：同一 origin 放行', () => {
    expect(own(DEV + '/', DEV)).toBe(true)
    expect(own(DEV + '/index.html', DEV)).toBe(true)
    expect(own(DEV + '/#/notes', DEV)).toBe(true)
  })

  it('dev：把自身地址当前缀的其它主机不放行', () => {
    expect(own('http://localhost:5173.evil.com/', DEV)).toBe(false)
    expect(own('http://localhost:51730/', DEV)).toBe(false)
    expect(own('https://localhost:5173/', DEV)).toBe(false)
  })

  it('dev：把自身地址塞进查询串/路径的其它来源不放行', () => {
    expect(own('http://evil.com/?u=' + DEV, DEV)).toBe(false)
    expect(own('http://evil.com/' + DEV, DEV)).toBe(false)
  })

  it('dev：没配 devUrl 时根本不认 http', () => {
    expect(own(DEV + '/')).toBe(false)
    expect(own('http://evil.com/', DEV + '.evil.com')).toBe(false)
  })

  it('打包：入口本身及其 hash/查询放行', () => {
    expect(own(HTML)).toBe(true)
    expect(own(HTML + '#/notes')).toBe(true)
    expect(own(HTML + '?a=1')).toBe(true)
  })

  it('打包：以入口路径为前缀的别的文件不放行', () => {
    expect(own(HTML + '.evil')).toBe(false)
    expect(own('file:///C:/app/res/renderer/index.html.bak')).toBe(false)
  })

  it('打包：别的目录/别的盘不放行', () => {
    expect(own('file:///C:/app/res/renderer/other.html')).toBe(false)
    expect(own('file:///D:/app/res/renderer/index.html')).toBe(false)
    expect(own('file:///C:/app/res/renderer/index.html/../secret')).toBe(false)
  })

  it('非 file 协议与解析不了的一律不放行', () => {
    expect(own('about:blank')).toBe(false)
    expect(own('javascript:alert(1)')).toBe(false)
    expect(own('data:text/html,x')).toBe(false)
    expect(own('not a url')).toBe(false)
    expect(own('')).toBe(false)
  })
})
