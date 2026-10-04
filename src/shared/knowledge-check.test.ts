import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_LABELS,
  emptyCheckNote,
  parseCheckNote,
  serializeCheckNote,
  summarizeCheckNote,
  type CheckNote,
} from './knowledge-check'

describe('emptyCheckNote', () => {
  it('默认是 v1 且 evidence 为 yes（最宽松的一档，由用户往下调）', () => {
    const c = emptyCheckNote()
    expect(c.v).toBe(1)
    expect(c.evidence).toBe('yes')
    expect([c.scope, c.conflict, c.freshness, c.extra]).toEqual(['', '', '', ''])
  })
})

describe('parseCheckNote —— 第一版的纯文本不能被当成损坏', () => {
  it.each([null, undefined, ''])('空值返回 null（%s）', (raw) => {
    expect(parseCheckNote(raw)).toBeNull()
  })

  it('纯文本返回 null —— 调用方据此按纯文本显示，而不是报错', () => {
    expect(parseCheckNote('我核对过了，应该没问题')).toBeNull()
  })

  it('格式升级不该丢数据：非 JSON 一律退化成 null，不抛异常', () => {
    expect(() => parseCheckNote('{ 不是合法 JSON')).not.toThrow()
    expect(parseCheckNote('{ 不是合法 JSON')).toBeNull()
  })
})

describe('parseCheckNote —— 结构化', () => {
  it('往返一致', () => {
    const c: CheckNote = { v: 1, evidence: 'partial', scope: '只在内网', conflict: '与 A 冲突', freshness: '半年内', extra: '备注' }
    expect(parseCheckNote(serializeCheckNote(c))).toEqual(c)
  })

  it('版本号不对返回 null（留给将来的 v2，不要误读成 v1）', () => {
    expect(parseCheckNote(JSON.stringify({ v: 2, evidence: 'yes' }))).toBeNull()
  })

  it('evidence 非法返回 null', () => {
    expect(parseCheckNote(JSON.stringify({ v: 1, evidence: 'maybe' }))).toBeNull()
    expect(parseCheckNote(JSON.stringify({ v: 1 }))).toBeNull()
  })

  it('字符串字段类型不对时归零，而不是把 undefined 漏给 UI', () => {
    const got = parseCheckNote(JSON.stringify({ v: 1, evidence: 'no', scope: 42, conflict: null }))
    expect(got).toEqual({ v: 1, evidence: 'no', scope: '', conflict: '', freshness: '', extra: '' })
  })
})

describe('summarizeCheckNote', () => {
  it('只填了 evidence 时只有那一档的文案', () => {
    expect(summarizeCheckNote(emptyCheckNote())).toBe(EVIDENCE_LABELS.yes)
  })

  it('有场景与冲突时按顺序追加，空白的节不出现', () => {
    const c = { ...emptyCheckNote(), evidence: 'partial' as const, scope: ' 内网 ', conflict: '' }
    expect(summarizeCheckNote(c)).toBe('部分有依据 · 场景：内网')
  })

  it('空白字符串不算填了（trim 后为空则省略）', () => {
    const c = { ...emptyCheckNote(), scope: '   ', conflict: '   ' }
    expect(summarizeCheckNote(c)).toBe(EVIDENCE_LABELS.yes)
  })

  it('三档文案都在表里，没有漏配', () => {
    for (const k of ['yes', 'partial', 'no'] as const) expect(EVIDENCE_LABELS[k]).toBeTruthy()
  })
})
