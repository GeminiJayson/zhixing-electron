import { describe, expect, it } from 'vitest'
import { countWords, extractLinks, firstHeading, linkifyWiki, stripCode } from '@shared/wiki'

describe('wiki 链接', () => {
  it('提取 [[标题]]，去重且保持顺序', () => {
    expect(extractLinks('见 [[甲]] 与 [[乙]]，还有 [[甲]]')).toEqual(['甲', '乙'])
  })

  it('代码块里的链接不算数', () => {
    expect(extractLinks('正文\n```\n[[不该出现]]\n```\n')).toEqual([])
  })

  it('已解析标题转成 zhixing-note:// 内链，未命中的指向待建', () => {
    const resolved = new Map([['甲', 7]])
    const out = linkifyWiki('看 [[甲]] 和 [[乙]]', resolved)
    expect(out).toContain('[甲](zhixing-note://7)')
    // 未解析的走 new/ 路径，渲染层据此显示为待建链接
    expect(out).toContain('zhixing-note://new/')
    expect(out).not.toContain('[[甲]]')
  })

  it('stripCode 移除围栏代码块与行内代码', () => {
    expect(stripCode('a `x` b')).toBe('a  b')
    expect(stripCode('```\ncode\n```')).not.toContain('code')
  })
})

describe('笔记元信息', () => {
  it('firstHeading 取首个标题，缺失时用兜底', () => {
    expect(firstHeading('# 我的标题\n正文')).toBe('我的标题')
    expect(firstHeading('只有正文')).toBe('无标题')
  })

  it('countWords 对中英混排都给出正数', () => {
    expect(countWords('hello world')).toBeGreaterThan(0)
    expect(countWords('中文内容测试')).toBeGreaterThan(0)
    expect(countWords('')).toBe(0)
  })
})
