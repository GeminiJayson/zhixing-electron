/**
 * 极简 i18n 入口（O10）：t(key) 取文案，支持 {name} 占位符替换。
 *
 * 没有引 i18next 这类库：当前只有一种语言、没有复数与日期格式化的需求，
 * 一个对象查表 + 占位符替换就是完整实现；真要多语言复杂化时再换库也不迟。
 */
import { zh } from './zh'

export type MessageKey = keyof typeof zh
export type Locale = 'zh'

const TABLES: Record<Locale, Partial<Record<MessageKey, string>>> = { zh }

let current: Locale = 'zh'

export function setLocale(next: Locale): void {
  current = next
}

export function getLocale(): Locale {
  return current
}

/** 取文案；缺 key 时回退到 key 本身，便于发现漏抽。 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const text = TABLES[current][key] ?? key
  if (!vars) return text
  return Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), text)
}
