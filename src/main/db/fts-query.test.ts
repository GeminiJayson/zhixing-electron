import { describe, expect, it } from 'vitest'
import { queryTerms, tokenize } from './fts-query'

/**
 * 期望值是分词器的实际输出，逐字钉住 —— 改动分词逻辑会让检索结果漂移。
 */
describe('FTS 分词与查询表达式', () => {
  it('索引分词 = jieba cut_for_search', () => {
    expect(tokenize('本地优先待办与知识库')).toBe('本地 优先 待办 与 知识 知识库')
    expect(tokenize('知识管理')).toBe('知识 管理')
    expect(tokenize('测试任务')).toBe('测试 任务')
    expect(tokenize('')).toBe('')
  })

  it('查询表达式 = query_terms（前缀匹配 AND）', () => {
    expect(queryTerms('知识管理')).toBe('"知识"* AND "管理"*')
    expect(queryTerms('知识')).toBe('"知识"*')
    expect(queryTerms('')).toBe('')
  })

  it('标点与 FTS 语法字符不会污染表达式', () => {
    expect(queryTerms('知识" OR "管理')).toBe('"知识"* AND "OR"* AND "管理"*')
  })
})
