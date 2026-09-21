import { describe, expect, it } from 'vitest'
import { declLineCount, renameRefs, SELF_TESTS } from '../../scripts/lib/migrate-cdp.mjs'

// CDP 迁移器（scripts/lib/migrate-cdp.mjs）靠一个「按行 + 字符串/注释感知」的扫描器
// 判断一条声明跨了几行。这块的判断错过好几轮，每次都把脚本改坏，所以在这里钉死：
// 一旦扫描器的行为被改回去，这条测试先红。
describe('CDP 迁移器的块边界扫描器', () => {
  it.each(SELF_TESTS)('声明行数：%j', (src, want) => {
    expect(declLineCount(src, 0)).toBe(want)
  })

  it('字符串里的花括号不算深度', () => {
    expect(declLineCount("const a = '}}}'", 0)).toBe(1)
  })

  it('箭头函数的 ) 不让深度提前归零', () => {
    expect(declLineCount('const f = () => {\n  return 1\n}', 0)).toBe(3)
  })

  it('模板串里的插值花括号被跳过', () => {
    const bt = String.fromCharCode(96)
    const src = 'const s = ' + bt + 'a$' + '{ { x: 1 } }b' + bt
    expect(declLineCount(src, 0)).toBe(1)
  })

  it('把连接对象的引用改名到 app 上', () => {
    expect(renameRefs('conn.send(a)\nevaluate(b)\nawait ev(c)')).toBe(
      'app.send(a)\napp.evaluate(b)\nawait app.evaluate(c)'
    )
  })

  it('不误伤已经带前缀的名字', () => {
    expect(renameRefs('app.evaluate(1)\nmyconn.send(2)')).toBe('app.evaluate(1)\nmyconn.send(2)')
  })
})
