import { describe, expect, it } from 'vitest'
import { declLineCount, migrateSource, renameRefs, SELF_TESTS } from '../../scripts/lib/migrate-cdp.mjs'

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

  // 真实失败：flashhotkeycheck 里页面侧的「if (host) host.focus()」被改成了 app.focus()，
  // 浏览器上下文里没有 app，报错只有一句 ReferenceError: app is not defined（堆栈全在 <anonymous>）。
  it('字符串里的名字一律不动', () => {
    expect(renameRefs("evaluate('if (host) host.focus()')")).toBe("app.evaluate('if (host) host.focus()')")
  })

  it('模板串里的名字一律不动', () => {
    const bt = String.fromCharCode(96)
    const src = 'evaluate(' + bt + 'host.focus()' + bt + ')'
    expect(renameRefs(src)).toBe('app.evaluate(' + bt + 'host.focus()' + bt + ')')
  })

  it('注释里的名字一律不动', () => {
    expect(renameRefs('// conn.send(1)\nconn.send(2)')).toBe('// conn.send(1)\napp.send(2)')
  })

  // 正文里调脚手架版的 list() 时改到 lib 的 app.targets()，否则运行时 list is not defined
  it('脚手架的 list() 改到 app.targets()', () => {
    expect(renameRefs('const pages = await list()')).toBe('const pages = await app.targets()')
    expect(renameRefs('blacklist(1)')).toBe('blacklist(1)')
  })
})

// 真实失败：importcheck 的夹具目录从没被建出来，断言里读文件直接 ENOENT。
// 根因不是「过滤太宽」，而是这件事机械迁移**做不到**：lib 的 launchApp 会先 rmSync(home)
// 再重建，脚本提早写进 home 的夹具必然被清掉。所以迁移器的正确行为是拒绝迁移，
// 让人来手工把它挪到 launchApp 之后 —— importcheck / officecheck / wfdialog / wflinkcheck 同族。
describe('迁移器 · 样板区段的夹具准备必须拒绝迁移', () => {
  const legacy = [
    "import { spawn } from 'node:child_process'",
    "import { join } from 'node:path'",
    'const PORT = 9999',
    "const tmpHome = join(root, '.screenshots', 'synthetic-home')",
    'rmSync(tmpHome, { recursive: true, force: true })',
    "mkdirSync(join(tmpHome, 'fixtures'), { recursive: true })",
    "writeFileSync(join(tmpHome, 'fixtures', 'good.json'), '{}')",
    "const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')",
    "copyFileSync(realDb, join(tmpHome, 'zhixing.db'))",
    '',
    'const results = []',
    "const check = (name, ok, detail = '') => results.push([name, ok, detail])",
    'const J = (v) => JSON.stringify(v)',
    'const before = 1',
    'const after = 2',
    'const failed = results.filter(([, ok]) => !ok)',
    "console.log('done')",
    'process.exit(failed.length ? 1 : 0)'
  ]

  it('样板区段有脚本自己的夹具准备时，拒绝迁移而不是产出一个会 ENOENT 的脚本', () => {
    const r = migrateSource(legacy)
    expect('skip' in r ? r.skip : '').toContain('手工迁移')
  })
})
