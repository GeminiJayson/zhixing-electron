import { describe, expect, it } from 'vitest'
import {
  decodeReply,
  describeLogRules,
  matchLogRules,
  parseLogRules,
  serializeLogRules,
} from './workflow-log-rules'
import type { LogRule, LogRules } from './workflow-log-rules'

const mk = (rules: LogRule[], judge: LogRules['judge'] = 'both'): LogRules => ({ rules, judge })

describe('日志规则 · 解析', () => {
  it('空值退回「只认退出码」', () => {
    expect(parseLogRules('')).toEqual({ rules: [], judge: 'exit' })
    expect(parseLogRules(null)).toEqual({ rules: [], judge: 'exit' })
    expect(parseLogRules('{ 坏 json')).toEqual({ rules: [], judge: 'exit' })
    expect(parseLogRules('[]')).toEqual({ rules: [], judge: 'exit' })
  })

  it('丢掉没有关键字的规则，保留合法的', () => {
    const r = parseLogRules(
      JSON.stringify({ judge: 'log', rules: [{ pattern: '' }, { pattern: 'ERROR' }, null] })
    )
    expect(r.judge).toBe('log')
    expect(r.rules.map((x: { pattern: string }) => x.pattern)).toEqual(['ERROR'])
  })

  it('非法 mode / result 落回默认值', () => {
    const r = parseLogRules(JSON.stringify({ rules: [{ pattern: 'x', mode: 'nope', result: 'nope' }] }))
    expect(r.rules[0].mode).toBe('contains')
    expect(r.rules[0].result).toBe('fail')
  })

  it('全空配置序列化成空串（与「从没配过」同构）', () => {
    expect(serializeLogRules({ rules: [], judge: 'exit' })).toBe('')
    expect(serializeLogRules(mk([{ pattern: 'a', mode: 'contains', result: 'ok' }]))).toContain('"a"')
  })

  it('往返一致', () => {
    // 两条都写全字段：解析器会把缺的 message / reply 补成空串，
    // 只写一半的话 toEqual 会在"多出来的键"上失败 —— 那是格式归一，不是 bug。
    const src = mk(
      [
        { pattern: 'ERROR', mode: 'contains', result: 'fail', message: '出错了', reply: '' },
        { pattern: 'y/n', mode: 'regex', result: 'wait_input', message: '', reply: 'y\\n' },
      ],
      'log'
    )
    expect(parseLogRules(serializeLogRules(src))).toEqual(src)
  })
})

describe('日志规则 · 匹配', () => {
  it('contains 不区分大小写', () => {
    const m = matchLogRules(mk([{ pattern: 'error', mode: 'contains', result: 'fail' }]), 'xx ERROR yy')
    expect(m?.hit).toBe('ERROR')
  })

  it('顺序即优先级：先 ERROR 后 SUCCESS 时同时出现按失败算', () => {
    const m = matchLogRules(
      mk([
        { pattern: 'ERROR', mode: 'contains', result: 'fail' },
        { pattern: 'SUCCESS', mode: 'contains', result: 'ok' },
      ]),
      'ERROR ... SUCCESS'
    )
    expect(m?.rule.result).toBe('fail')
  })

  it('regex 命中并回传实际匹配到的文本', () => {
    const m = matchLogRules(mk([{ pattern: 'code=(\\d+)', mode: 'regex', result: 'fail' }]), 'exit code=42!')
    expect(m?.hit).toBe('code=42')
  })

  it('正则写坏时跳过这一条，后面的仍能命中', () => {
    const m = matchLogRules(
      mk([
        { pattern: '([', mode: 'regex', result: 'fail' },
        { pattern: 'done', mode: 'contains', result: 'ok' },
      ]),
      'all done'
    )
    expect(m?.rule.pattern).toBe('done')
  })

  it('没有日志或没有规则时返回 null', () => {
    expect(matchLogRules(mk([{ pattern: 'a', mode: 'contains', result: 'ok' }]), '')).toBeNull()
    expect(matchLogRules({ rules: [], judge: 'both' }, 'anything')).toBeNull()
  })
})

describe('日志规则 · 说明与输入解码', () => {
  it('没配规则时不产出说明（调用方据此隐藏这一行）', () => {
    expect(describeLogRules({ rules: [], judge: 'exit' })).toBe('')
  })

  it('说明里带判定口径与条数', () => {
    const d = describeLogRules(mk([{ pattern: 'a', mode: 'contains', result: 'ok' }], 'log'))
    expect(d).toContain('只看日志')
    expect(d).toContain('1 条关键字')
  })

  it('字面 \\n / \\r 还原成真换行（用户没法在单行输入框里敲回车）', () => {
    expect(decodeReply('y\\nn\\r\\n')).toBe('y\nn\r\n')
    expect(decodeReply(undefined)).toBe('')
    expect(decodeReply('原样')).toBe('原样')
  })
})
