import { describe, expect, it } from 'vitest'
import { KNOWLEDGE_TEMPLATES, templateFor } from './knowledge-templates'

describe('templateFor', () => {
  it('三类给了固定结构', () => {
    for (const k of ['concept', 'method', 'pitfall']) expect(templateFor(k)).toBeTruthy()
  })

  it('另外几类返回 null —— 自由格式，不强加模板', () => {
    for (const k of ['summary', 'synthesis', 'output', 'note', 'project']) expect(templateFor(k)).toBeNull()
  })

  it('未知类型返回 null 而不是抛异常', () => {
    expect(templateFor('')).toBeNull()
    expect(templateFor('不存在')).toBeNull()
  })
})

describe('模板要挡住各自最容易漏的那一项', () => {
  // 这三条是模板存在的理由（见文件头注释），漏了模板就退化成空表单
  it('概念必须有「它不是什么」——否则望文生义', () => {
    expect(KNOWLEDGE_TEMPLATES.concept).toContain('它不是什么')
  })

  it('方法论必须有「什么时候别用」——否则到处硬套', () => {
    expect(KNOWLEDGE_TEMPLATES.method).toContain('什么时候别用')
  })

  it('踩坑必须把「排查过程」排在「根因」前面 ——价值在路径不在结论', () => {
    const t = KNOWLEDGE_TEMPLATES.pitfall
    expect(t).toContain('排查过程')
    expect(t).toContain('根因')
    expect(t.indexOf('排查过程')).toBeLessThan(t.indexOf('根因'))
  })
})

describe('模板本身的形状', () => {
  it('每个模板都以二级标题开头、以换行结尾（接进正文时不粘连）', () => {
    for (const [k, t] of Object.entries(KNOWLEDGE_TEMPLATES)) {
      expect(t.startsWith('## '), k + ' 应以二级标题开头').toBe(true)
      expect(t.endsWith('\n'), k + ' 应以换行结尾').toBe(true)
    }
  })

  it('没有用字面量 \\n 转义拼字符串（那样读起来更差）', () => {
    for (const t of Object.values(KNOWLEDGE_TEMPLATES)) expect(t).not.toContain('\\n')
  })
})
