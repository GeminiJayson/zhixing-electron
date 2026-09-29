import { describe, expect, it } from 'vitest'
import { parseSettings, serializeSetting } from '@shared/settings'

// 这组断言的起因是一次真实事故：settings 读出来是字符串，
// `${s.font_size + 1.5}` 被拼成 "121.5px"，整屏被撑大。
describe('settings 类型层', () => {
  it('空表回退到默认值', () => {
    const s = parseSettings({})
    // 默认值以共用的 settings 表为准
    expect(s.font_size).toBe(14)
    expect(s.theme_mode).toBe('system')
    expect(s.theme_pack).toBe('青竹')
    expect(s.capture_hotkey).toBe('ctrl+shift+s')
    // 划词入闪念是本应用私有键：只在读取层回退默认值，不进共用的 DEFAULT_SETTINGS
    expect(s.flash_quick_hotkey).toBe('ctrl+shift+f')
    expect(s.widget_opacity).toBe(85)
  })

  it('数值字段是 number，能安全参与算术', () => {
    const s = parseSettings({ font_size: '12' })
    expect(typeof s.font_size).toBe('number')
    expect(`${s.font_size + 1.5}px`).toBe('13.5px')
    expect(`${parseSettings({ task_row_height: '30' }).task_row_height + 10}px`).toBe('40px')
  })

  it('非法值回退，越界值钳制', () => {
    expect(parseSettings({ font_size: 'abc' }).font_size).toBe(14)
    expect(parseSettings({ font_size: '999' }).font_size).toBe(20)
    expect(parseSettings({ widget_opacity: '10' }).widget_opacity).toBe(60)
  })

  it('空串视为缺失而不是 0（Number("") === 0 的坑）', () => {
    expect(parseSettings({ font_size: '' }).font_size).toBe(14)
  })

  it('布尔语义：0 为假、缺失用默认', () => {
    expect(parseSettings({ pomodoro_auto_break: '0' }).pomodoro_auto_break).toBe(false)
    expect(parseSettings({ pomodoro_auto_break: '1' }).pomodoro_auto_break).toBe(true)
    expect(parseSettings({}).pomodoro_auto_break).toBe(false)
    expect(parseSettings({ reminder_enabled: '' }).reminder_enabled).toBe(true)
  })

  it('枚举回退与保留', () => {
    expect(parseSettings({ theme_mode: 'weird' }).theme_mode).toBe('system')
    expect(parseSettings({ theme_mode: 'dark' }).theme_mode).toBe('dark')
    expect(parseSettings({ theme_mode: 'system' }).theme_mode).toBe('system')
    expect(parseSettings({ motion_level: 'none' }).motion_level).toBe('none')
    expect(parseSettings({ motion_level: 'x' }).motion_level).toBe('full')
    // 玻璃拟态默认开：它是「看了再决定」的实验项，默认关掉就没人会去看
    expect(parseSettings({}).glass_enabled).toBe(true)
    expect(parseSettings({ glass_enabled: '0' }).glass_enabled).toBe(false)
  })

  it('玻璃三参数的默认值与边界钳制', () => {
    const d = parseSettings({})
    expect(d.glass_blur).toBe(28)
    expect(d.glass_alpha).toBe(56)
    expect(d.glass_saturate).toBe(185)
    // 越界值钳到区间内：滑块本身不会越界，但设置文件是可以手改的
    expect(parseSettings({ glass_blur: '999' }).glass_blur).toBe(40)
    expect(parseSettings({ glass_blur: '-5' }).glass_blur).toBe(0)
    expect(parseSettings({ glass_alpha: '0' }).glass_alpha).toBe(30)
    expect(parseSettings({ glass_alpha: '500' }).glass_alpha).toBe(100)
    expect(parseSettings({ glass_saturate: '10' }).glass_saturate).toBe(100)
    // 非数字回落默认值
    expect(parseSettings({ glass_blur: 'abc' }).glass_blur).toBe(28)
  })

  it('ui_state 原样透传（嵌套 JSON 由使用方解析）', () => {
    expect(parseSettings({ ui_state: '{"a":1}' }).ui_state).toBe('{"a":1}')
  })

  it('字符串化与解析对称', () => {
    expect(serializeSetting.bool(true)).toBe('1')
    expect(serializeSetting.bool(false)).toBe('0')
    expect(serializeSetting.num(30)).toBe('30')
    expect(parseSettings({ font_size: serializeSetting.num(18) }).font_size).toBe(18)
  })
})
