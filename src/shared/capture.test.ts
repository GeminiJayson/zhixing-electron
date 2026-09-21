import { describe, expect, it } from 'vitest'
import { parseCapture, parseNaturalDate } from '@shared/capture'

const TODAY = '2026-09-16' // 周三

describe('快速捕获语法糖', () => {
  it('完整语法：优先级 + 列表 + 标签 + 日期', () => {
    const p = parseCapture('周五前 交付方案 !2 @工作 #客户', TODAY)
    // 日期词后的「前/之前/以内」等连接词一并清掉（对齐 capture_grammar 的后处理）
    expect(p.title).toBe('交付方案')
    expect(p.priority).toBe(5)
    expect(p.listName).toBe('工作')
    expect(p.tags).toEqual(['客户'])
  })

  it('语法糖从标题中剔除', () => {
    const p = parseCapture('写方案 !2 @验证 #标签 明天', TODAY)
    expect(p.title).toBe('写方案')
    expect(p.dueDate).toBe('2026-09-17')
    expect(p.listName).toBe('验证')
    expect(p.tags).toEqual(['标签'])
  })

  it('老快捷：!1 最高、!3 最低', () => {
    expect(parseCapture('!1 紧急', TODAY).priority).toBe(8)
    expect(parseCapture('!2 中', TODAY).priority).toBe(5)
    expect(parseCapture('!3 低', TODAY).priority).toBe(2)
    expect(parseCapture('!!! 紧急', TODAY).priority).toBe(8)
  })

  it('无日期词不设截止（由调用方补今天）', () => {
    expect(parseCapture('随手记一下', TODAY).dueDate).toBeNull()
  })

  it('多个标签都收集，且不重复', () => {
    expect(parseCapture('#a #b #a 标题', TODAY).tags).toEqual(['a', 'b'])
  })

  it('空白输入解析出空标题', () => {
    expect(parseCapture('   ', TODAY).title).toBe('')
  })
})

describe('自然日期词', () => {
  it('相对日', () => {
    expect(parseNaturalDate('今天', TODAY).date).toBe('2026-09-16')
    expect(parseNaturalDate('明天', TODAY).date).toBe('2026-09-17')
    expect(parseNaturalDate('后天', TODAY).date).toBe('2026-09-18')
    expect(parseNaturalDate('大后天', TODAY).date).toBe('2026-09-19')
  })

  it('周几：本周内取当周，已过的顺延', () => {
    expect(parseNaturalDate('周五', TODAY).date).toBe('2026-09-18')
    expect(parseNaturalDate('周三', TODAY).date).toBe('2026-09-16')
    expect(parseNaturalDate('周一', TODAY).date).toBe('2026-09-21') // 本周一已过 → 下周一
  })

  it('下周X 落在下一周（按字面语义）', () => {
    expect(parseNaturalDate('下周一', TODAY).date).toBe('2026-09-21')
    expect(parseNaturalDate('下周五', TODAY).date).toBe('2026-09-25')
  })

  it('绝对日期', () => {
    expect(parseNaturalDate('2026-12-31', TODAY).date).toBe('2026-12-31')
    expect(parseNaturalDate('10月1日', TODAY).date).toBe('2026-10-01')
    expect(parseNaturalDate('12-25', TODAY).date).toBe('2026-12-25')
  })

  it('已过的月日顺延到明年', () => {
    expect(parseNaturalDate('1月5日', TODAY).date).toBe('2027-01-05')
  })

  it('时刻解析（中文与 24h）', () => {
    // 无修饰的 1-6 点按口语「下午」处理（对齐 _resolve_hour：3点 → 15:00）
    expect(parseNaturalDate('明天3点', TODAY).clock).toEqual([15, 0])
    expect(parseNaturalDate('明天下午3点', TODAY).clock).toEqual([15, 0])
    expect(parseNaturalDate('明天3点半', TODAY).clock).toEqual([15, 30])
    expect(parseNaturalDate('明天 14:30', TODAY).clock).toEqual([14, 30])
    // 20 点属于无修饰但不落入 1-6，保持字面
    expect(parseNaturalDate('明天20点', TODAY).clock).toEqual([20, 0])
  })

  it('非法时刻 / 非法日期一律丢弃（对齐 parse_clock 与 parse_natural_date）', () => {
    expect(parseNaturalDate('明天25:99', TODAY).clock).toBeNull()
    // 注意不能用带后缀的整串（正则要求 ^...$，那样会因「不匹配」而返回 null，测不到非法日期检测）
    expect(parseNaturalDate('2月30日', TODAY).date).toBeNull()
    expect(parseNaturalDate('2/29', TODAY).date).toBeNull()
    // TODAY = 2026-09-16，2 月已过 → 合法则顺延到明年（对齐「已过的月日顺延」）
    expect(parseNaturalDate('2月28日', TODAY).date).toBe('2027-02-28')
  })

  it('标题残留修饰词与首尾标点被清掉（对齐 capture_grammar）', () => {
    expect(parseCapture('周五前 交付方案', TODAY).title).toBe('交付方案')
    expect(parseCapture('- 买菜', TODAY).title).toBe('买菜')
  })
})

/**
 * 周短语必须走**整串**才测得出来。
 *
 * 上面单独测 parseNaturalDate('下周五') 是通过的 —— 缺陷恰恰藏在「词法」那一层：
 * parseCapture 的 DATE_WORDS 里写的是 \`下下周?[一二三四五六日天]\`，\`下下周?\` 需要**两个**「下」，
 * 所以「下周五」匹配不到，退而匹配到「周五」：日期被算成本周五，且「下」留在标题里。
 * 而「下下周五」词法能匹配、解析层的 /^(下)?周X$/ 又不认 —— 日期词被整段删掉却不解析。
 * 两处各写一套表达，必然分叉。
 */
describe('整串里的周短语', () => {
  it('「下周五」落在下一周，标题不留残字', () => {
    const p = parseCapture('下周五交报告', TODAY)
    expect(p.dueDate).toBe('2026-09-25')
    expect(p.title).toBe('交报告')
    expect(p.title).not.toContain('下')
  })

  it('「下下周五」不能把日期词吃掉却不解析', () => {
    const p = parseCapture('下下周五交报告', TODAY)
    expect(p.dueDate).toBe('2026-10-02')
    expect(p.title).toBe('交报告')
  })

  it('无前缀的「周五」仍是本周五，已过则顺延', () => {
    expect(parseCapture('周五交报告', TODAY)).toMatchObject({ dueDate: '2026-09-18', title: '交报告' })
    // 2026-09-19 是周六，本周五已过 → 顺延到 09-25
    expect(parseCapture('周五交报告', '2026-09-19').dueDate).toBe('2026-09-25')
  })

  it('三种前缀各自相差一周', () => {
    expect(parseCapture('周五交', TODAY).dueDate).toBe('2026-09-18')
    expect(parseCapture('下周五交', TODAY).dueDate).toBe('2026-09-25')
    expect(parseCapture('下下周五交', TODAY).dueDate).toBe('2026-10-02')
  })
})
