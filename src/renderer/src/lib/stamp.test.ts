import { describe, expect, it } from 'vitest'
import { joinStamp, splitStamp } from './date'

/**
 * reminder_at / resume_at 存的是 DATETIME 串，界面上编辑的却是「日期 + 时刻」两个控件。
 * 这一对函数就是那道边界 —— 之前它们长在 TaskEditor 里，只有端到端脚本能碰到；
 * 拆到这里是为了让「往返不丢信息」这条能被单测钉住。
 */
describe('splitStamp —— DATETIME 拆成两个控件', () => {
  it('拆出日期与 HH:MM', () => {
    expect(splitStamp('2026-09-10 08:30:00.000000')).toEqual(['2026-09-10', '08:30'])
  })

  it('容忍 ISO 的 T 分隔符', () => {
    expect(splitStamp('2026-09-10T08:30:00.000000')).toEqual(['2026-09-10', '08:30'])
  })

  it('空值与空串都给两个空控件，不抛', () => {
    expect(splitStamp(null)).toEqual(['', ''])
    expect(splitStamp('')).toEqual(['', ''])
  })

  it('认不出的值退化成「前十个字符当日期」，不假装解析成功', () => {
    expect(splitStamp('2026-09-10')).toEqual(['2026-09-10', ''])
    expect(splitStamp('乱七八糟')).toEqual(['乱七八糟', ''])
  })
})

describe('joinStamp —— 两个控件合回 DATETIME', () => {
  it('日期 + 时刻拼成库里的格式', () => {
    expect(joinStamp('2026-09-10', '08:30', '09:00')).toBe('2026-09-10 08:30:00.000000')
  })

  it('只有日期时用兜底时刻（半夜叫人起床没有意义）', () => {
    expect(joinStamp('2026-09-10', '', '09:00')).toBe('2026-09-10 09:00:00.000000')
  })

  it('没有日期就是「不提醒」，时刻再全也不管用', () => {
    expect(joinStamp('', '08:30', '09:00')).toBeNull()
  })

  it('往返一圈不丢信息', () => {
    const src = '2026-09-10 08:30:00.000000'
    const [d, t] = splitStamp(src)
    expect(joinStamp(d, t, '09:00')).toBe(src)
  })
})
