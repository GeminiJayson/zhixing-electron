import { describe, expect, it } from 'vitest'
import { FOLDER_DEBOUNCE_MS, folderTargetsOf, groupByDir, planFolderHits, watchSignature, type FolderTarget } from './folder-watch-plan'
import type { WorkflowTrigger } from '../shared/workflow-trigger'

const t = (o: Partial<FolderTarget>): FolderTarget => ({ id: 1, name: '模板', dir: 'D:\\收件箱', pattern: '', ...o })

describe('folderTargetsOf —— 从模板的触发器里挑出目录触发', () => {
  it('只认 folder，别的类型忽略', () => {
    const triggers: WorkflowTrigger[] = [
      { kind: 'http', token: 'a' },
      { kind: 'folder', path: 'D:\\a', pattern: '*.md' },
      { kind: 'clipboard', pattern: 'x', mode: 'contains' },
    ]
    expect(folderTargetsOf([{ id: 3, name: '流程', triggers }])).toEqual([
      { id: 3, name: '流程', dir: 'D:\\a', pattern: '*.md' },
    ])
  })

  it('一个模板盯两个目录就是两条', () => {
    const triggers: WorkflowTrigger[] = [
      { kind: 'folder', path: 'D:\\a', pattern: '' },
      { kind: 'folder', path: 'D:\\b', pattern: '*.pdf' },
    ]
    expect(folderTargetsOf([{ id: 1, name: 'x', triggers }])).toHaveLength(2)
  })

  it('没有路径的目录触发（不该出现，但库里的旧数据可能有）跳过', () => {
    expect(folderTargetsOf([{ id: 1, name: 'x', triggers: [{ kind: 'folder', path: '  ' }] }])).toEqual([])
  })
})

describe('groupByDir —— 同一目录只开一个 watcher', () => {
  it('两个模板盯同一目录时并到一组', () => {
    const groups = groupByDir([t({ id: 1 }), t({ id: 2 }), t({ id: 3, dir: 'D:\\b' })])
    expect(groups).toHaveLength(2)
    expect(groups.find((g) => g.dir === 'D:\\收件箱')?.targets.map((x) => x.id)).toEqual([1, 2])
  })
})

describe('watchSignature —— 变了才重建', () => {
  it('顺序无关', () => {
    const a = watchSignature([t({ id: 1, dir: 'D:\\a' }), t({ id: 2, dir: 'D:\\b' })])
    const b = watchSignature([t({ id: 2, dir: 'D:\\b' }), t({ id: 1, dir: 'D:\\a' })])
    expect(a).toBe(b)
  })

  it('模式或目录改了签名就变', () => {
    const base = watchSignature([t({ pattern: '' })])
    expect(watchSignature([t({ pattern: '*.md' })])).not.toBe(base)
    expect(watchSignature([t({ dir: 'D:\\别处' })])).not.toBe(base)
    expect(watchSignature([])).not.toBe(base)
  })
})

describe('planFolderHits —— 该不该为这个文件启动', () => {
  it('拿不到文件名时不猜', () => {
    expect(planFolderHits([t({})], null, 1000, new Map())).toEqual([])
  })

  it('中间文件与隐藏文件不触发', () => {
    const seen = new Map<string, number>()
    expect(planFolderHits([t({})], '~$报告.docx', 1000, seen)).toEqual([])
    expect(planFolderHits([t({})], '.gitignore', 1000, seen)).toEqual([])
    expect(planFolderHits([t({})], '草稿.tmp', 1000, seen)).toEqual([])
  })

  it('模式不匹配就不触发，空模式则任何文件都算', () => {
    const seen = new Map<string, number>()
    expect(planFolderHits([t({ pattern: '*.md' })], 'a.txt', 1000, seen)).toEqual([])
    expect(planFolderHits([t({ pattern: '*.md' })], 'a.md', 1000, seen)).toHaveLength(1)
    expect(planFolderHits([t({ pattern: '' })], '随便什么.bin', 1000, new Map())).toHaveLength(1)
  })

  it('同一个文件在去抖窗口内只算一次，窗口过了才算下一次', () => {
    const seen = new Map<string, number>()
    const one = t({})
    expect(planFolderHits([one], 'a.md', 1000, seen)).toHaveLength(1)
    expect(planFolderHits([one], 'a.md', 1000 + FOLDER_DEBOUNCE_MS - 1, seen)).toHaveLength(0)
    expect(planFolderHits([one], 'a.md', 1000 + FOLDER_DEBOUNCE_MS, seen)).toHaveLength(1)
  })

  it('去抖按「模板 + 文件」记账：A 模板刚触发不影响 B 模板', () => {
    const seen = new Map<string, number>()
    const a = t({ id: 1 })
    const b = t({ id: 2 })
    expect(planFolderHits([a, b], 'x.md', 1000, seen)).toHaveLength(2)
    expect(planFolderHits([a, b], 'x.md', 1100, seen)).toHaveLength(0)
    expect(planFolderHits([a], 'y.md', 1100, seen)).toHaveLength(1)
  })

  it('账本不会无限长', () => {
    const seen = new Map<string, number>()
    for (let i = 0; i < 600; i++) planFolderHits([t({})], `f${i}.md`, 1000 + i, seen)
    expect(seen.size).toBeLessThanOrEqual(500 + 1)
  })
})
