import { describe, expect, it } from 'vitest'
import {
  COMMAND_KIND,
  DEFAULT_EXPECT_CODE,
  LEGACY_ACTION_LABELS,
  SCRIPT_KIND,
  STEP_ACTION_KINDS,
  TASK_KIND,
  actionKindLabel,
  isAutoActionKind,
  isLegacyActionKind,
  normalizeActionKind,
  parseExpectCode,
} from './workflow-action'

describe('步骤动作 —— 三类 + 历史值归一', () => {
  it('三类动作各自的归一值原样返回', () => {
    expect(normalizeActionKind(TASK_KIND)).toBe('task')
    expect(normalizeActionKind(COMMAND_KIND)).toBe('command')
    expect(normalizeActionKind(SCRIPT_KIND)).toBe('script')
  })

  it('历史值与空值一律归到「任务」—— 它们此前的行为就是派待办', () => {
    for (const raw of ['', '   ', null, undefined, 'none', 'open_url', 'open_note', 'run_command', 'wat']) {
      expect(normalizeActionKind(raw)).toBe('task')
    }
  })

  it('只有命令与脚本是自动执行型', () => {
    expect(isAutoActionKind(COMMAND_KIND)).toBe(true)
    expect(isAutoActionKind(SCRIPT_KIND)).toBe(true)
    expect(isAutoActionKind(TASK_KIND)).toBe(false)
    expect(isAutoActionKind('none')).toBe(false)
    expect(isAutoActionKind(null)).toBe(false)
  })

  it('历史值能被识别出来（编辑器据此显示只读项，不静默改数据）', () => {
    expect(isLegacyActionKind('open_url')).toBe(true)
    expect(isLegacyActionKind('open_note')).toBe(true)
    expect(isLegacyActionKind('run_command')).toBe(true)
    // 'none' / 空值就是「任务」，不该被标成历史 —— 否则几乎每个旧步骤都会挂一条提示
    expect(isLegacyActionKind('none')).toBe(false)
    expect(isLegacyActionKind('')).toBe(false)
    expect(isLegacyActionKind('   ')).toBe(false)
    for (const k of [TASK_KIND, COMMAND_KIND, SCRIPT_KIND]) expect(isLegacyActionKind(k)).toBe(false)
  })

  it('期望退出码：空 / 非数字都回落到 0，数字原样', () => {
    expect(parseExpectCode('')).toBe(DEFAULT_EXPECT_CODE)
    expect(parseExpectCode(null)).toBe(DEFAULT_EXPECT_CODE)
    expect(parseExpectCode(undefined)).toBe(DEFAULT_EXPECT_CODE)
    expect(parseExpectCode('abc')).toBe(DEFAULT_EXPECT_CODE)
    expect(parseExpectCode('2')).toBe(2)
    expect(parseExpectCode(-1)).toBe(-1)
    // '0' 必须被认成 0，而不是「没填」
    expect(parseExpectCode('0')).toBe(0)
  })

  it('动作类型都有中文名，条件节点单独标注', () => {
    expect(actionKindLabel(COMMAND_KIND)).toBe('命令')
    expect(actionKindLabel(SCRIPT_KIND)).toBe('脚本')
    expect(actionKindLabel(TASK_KIND)).toBe('任务')
    expect(actionKindLabel('condition')).toBe('条件')
    expect(actionKindLabel('open_url')).toBe(LEGACY_ACTION_LABELS.open_url)
  })

  it('三类动作的清单与联合类型一一对应，且都有说明', () => {
    expect(STEP_ACTION_KINDS.map((a) => a.value)).toEqual(['task', 'command', 'script'])
    for (const a of STEP_ACTION_KINDS) expect(a.hint.length).toBeGreaterThan(0)
  })
})
