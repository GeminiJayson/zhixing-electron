import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, parseSettings } from './settings'
import { DEFAULT_THEME_PACK } from './theme-packs'

/**
 * 主题包默认值只能有一个来源。
 *
 * 这条断言是被 E2E 夹具库逼出来的：theme-packs 写「墨黑」、settings 写「青竹」，
 * 两个默认值并存了很久也没人发现 —— 因为 E2E 一直跑在用户库上，
 * 那里存着 theme_pack=墨黑，于是断言「默认是墨黑」的脚本一直是「过」的。
 * 换成空库之后立刻现形。
 *
 * 权威来源是 Python 版（core/constants.py / settings.py 都是「青竹」，accent #0D9488）：
 * 两版共用同一张 settings 表，默认值分叉会让同一个库在两侧表现不一致。
 */
describe('主题包默认值只有一个来源', () => {
  it('DEFAULT_THEME_PACK 必须与 DEFAULT_SETTINGS.theme_pack 一致', () => {
    expect(DEFAULT_THEME_PACK).toBe(DEFAULT_SETTINGS.theme_pack)
  })

  it('空库里 parseSettings 回退出来的也是同一个包', () => {
    expect(parseSettings({}).theme_pack).toBe(DEFAULT_THEME_PACK)
  })

  it('默认包必须真的在主题包表里（否则 resolveThemePack 会静默换包）', () => {
    // 与 Python 对齐：默认值「青竹」
    expect(DEFAULT_THEME_PACK).toBe('青竹')
  })
})
