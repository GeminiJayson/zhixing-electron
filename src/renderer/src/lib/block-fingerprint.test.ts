import { describe, expect, it } from 'vitest'
import { blockFingerprint, cellKey, isCellRef, isSheetName, listNoteBlocks, sha1Hex } from './block-fingerprint'

describe('段落指纹', () => {
  it('规范化：空白折叠 + 去首尾 + 小写', () => {
    // 三种写法指向同一段，必须算出同一个键 —— 否则关联完了跳不过去
    const a = blockFingerprint('  今天   要做的 事 ')
    const b = blockFingerprint('今天 要做的 事')
    const c = blockFingerprint('今天 要做的 事'.toUpperCase())
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('前缀 fp: 且长度固定（sha1 前 12 位）', () => {
    const k = blockFingerprint('一段话')
    expect(k.startsWith('fp:')).toBe(true)
    expect(k).toHaveLength(3 + 12)
  })

  it('空内容不产键', () => {
    expect(blockFingerprint('')).toBe('')
    expect(blockFingerprint('   \n\t ')).toBe('')
  })

  it('不同内容给出不同键', () => {
    expect(blockFingerprint('甲')).not.toBe(blockFingerprint('乙'))
  })

  it('sha1 与标准实现一致（空串与 abc 的已知向量）', () => {
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709')
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
  })
})

describe('Excel 单元格定位', () => {
  it('cellKey：带工作表用 ! 连接，不带就只有坐标', () => {
    expect(cellKey('Sheet1', 'B3')).toBe('cell:Sheet1!B3')
    expect(cellKey('', 'B3')).toBe('cell:B3')
    // 坐标统一大写、去空白
    expect(cellKey('数据', ' b3 ')).toBe('cell:数据!B3')
  })

  it('cellKey：空坐标给出空键（调用方据此禁用按钮）', () => {
    expect(cellKey('Sheet1', '   ')).toBe('')
  })

  it('isCellRef：接受常见写法，拒绝乱写', () => {
    for (const ok of ['A1', 'b3', '$B$3', 'AA10', 'XFD1048576']) expect(isCellRef(ok)).toBe(true)
    for (const bad of ['', '3B', 'B', '1', 'B3:C5', '单元格']) expect(isCellRef(bad)).toBe(false)
  })

  it('isSheetName：挡住 Excel 不允许的字符与超长名', () => {
    expect(isSheetName('Sheet1')).toBe(true)
    expect(isSheetName('2026 数据')).toBe(true)
    for (const bad of ['', 'a/b', 'a:b', 'a[b]', 'a?b', 'a*b', 'x'.repeat(32)]) {
      expect(isSheetName(bad)).toBe(false)
    }
  })
})

describe('笔记段落切分 · markdown', () => {
  it('一行一段，空白行跳过，序号连续', () => {
    const blocks = listNoteBlocks('markdown', '第一段\n\n第二段\n   \n第三段')
    expect(blocks.map((b) => b.text)).toEqual(['第一段', '第二段', '第三段'])
    expect(blocks.map((b) => b.index)).toEqual([1, 2, 3])
  })

  it('键与 blockFingerprint 一致（同一份实现，不能各算各的）', () => {
    const blocks = listNoteBlocks('markdown', '# 标题\n\n正文')
    expect(blocks[0].key).toBe(blockFingerprint('# 标题'))
    expect(blocks[1].key).toBe(blockFingerprint('正文'))
  })

  it('首尾空白与空内容都安全', () => {
    expect(listNoteBlocks('markdown', '')).toEqual([])
    expect(listNoteBlocks('markdown', '\n\n\n')).toEqual([])
  })

  it('链接笔记：一条链接一项，标题与链接拼在一起展示', () => {
    const md = JSON.stringify([
      { title: '竞品 A', target: 'https://a.example.com' },
      { title: '', target: 'https://b.example.com' },
    ])
    const blocks = listNoteBlocks('link', md)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].text).toBe('竞品 A — https://a.example.com')
    // 没写标题时不留下孤零零的分隔符
    expect(blocks[1].text).toBe('https://b.example.com')
  })

  it('链接笔记的键按 URL 算 —— 改标题不会让关联失效', () => {
    const before = listNoteBlocks('link', JSON.stringify([{ title: '旧标题', target: 'https://x.example.com' }]))
    const after = listNoteBlocks('link', JSON.stringify([{ title: '新标题', target: 'https://x.example.com' }]))
    expect(after[0].key).toBe(before[0].key)
  })

  it('链接笔记：没有 target 的条目跳过，坏 JSON 退回按行', () => {
    const md = JSON.stringify([{ title: '只有标题' }, { title: 'B', target: 'https://b.example.com' }])
    expect(listNoteBlocks('link', md).map((b) => b.text)).toEqual(['B — https://b.example.com'])
    // 历史数据可能存成纯文本
    const plain = listNoteBlocks('link', 'https://c.example.com')
    expect(plain.length).toBeGreaterThan(0)
  })

  it('富文本内容在无 DOMParser 的环境下退回按行处理（不抛错）', () => {
    // node 环境没有 DOMParser；实现里的 try/catch 应当让它退回按行
    const blocks = listNoteBlocks('richtext', '<p>甲</p>\n<p>乙</p>')
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.every((b) => b.key.startsWith('fp:'))).toBe(true)
  })
})
