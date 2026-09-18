import { describe, expect, it } from 'vitest'
import { getLocale, setLocale, t } from './index'
import { zh } from './zh'

describe('i18n 入口', () => {
  it('默认中文，取得到文案', () => {
    setLocale('zh')
    expect(getLocale()).toBe('zh')
    expect(t('nav.today')).toBe('今日')
    expect(t('page.settings')).toBe('设置')
  })

  it('占位符替换', () => {
    expect(t('palette.goTo', { name: '笔记' })).toBe('转到笔记')
    expect(t('palette.goTo', { name: '图谱' })).toBe('转到图谱')
  })

  it('缺 key 时回退到 key 本身，便于发现漏抽', () => {
    // 故意用一个不存在的 key
    expect(t('not.exist' as never)).toBe('not.exist')
  })

  it('导航与 8 个页面标题都有对应文案', () => {
    const keys = ['today', 'tasks', 'inbox', 'notes', 'workflow', 'graph', 'review', 'settings']
    for (const k of keys) {
      expect(zh[`nav.${k}` as keyof typeof zh], `nav.${k}`).toBeTruthy()
      expect(zh[`page.${k}` as keyof typeof zh], `page.${k}`).toBeTruthy()
    }
  })
})
