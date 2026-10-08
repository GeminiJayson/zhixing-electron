import { describe, expect, it } from 'vitest'
import { flattenFolderTree, folderWithDescendants } from './folder-tree'

const f = (id: number, parent_id: number | null, name: string): { id: number; parent_id: number | null; name: string } => ({ id, parent_id, name })

describe('flattenFolderTree', () => {
  it('父后面紧跟它的子，depth 是实际层级', () => {
    const tree = flattenFolderTree([
      f(1, null, '工作'),
      f(2, 1, '项目A'),
      f(3, 2, '周报'),
      f(4, null, '生活'),
    ])
    expect(tree.map((x) => [x.folder.name, x.depth])).toEqual([
      ['工作', 0],
      ['项目A', 1],
      ['周报', 2],
      ['生活', 0],
    ])
  })

  it('输入乱序也按树序输出', () => {
    const tree = flattenFolderTree([f(3, 2, '周报'), f(1, null, '工作'), f(2, 1, '项目A')])
    expect(tree.map((x) => x.folder.id)).toEqual([1, 2, 3])
  })

  it('孤立节点当顶层，不会从列表里消失', () => {
    // 父 99 不在集合里（父被删了）
    const tree = flattenFolderTree([f(1, null, '工作'), f(5, 99, '孤儿')])
    expect(tree.map((x) => [x.folder.name, x.depth])).toEqual([
      ['工作', 0],
      ['孤儿', 0],
    ])
  })

  it('成环时不死循环', () => {
    const tree = flattenFolderTree([f(1, 2, 'A'), f(2, 1, 'B')])
    expect(tree.length).toBeLessThanOrEqual(2)
  })

  it('空输入返回空', () => {
    expect(flattenFolderTree([])).toEqual([])
  })
  it('folderWithDescendants：自身 + 全部后代（递归）', () => {
    const all = [f(1, null, 'A'), f(2, 1, 'B'), f(3, 2, 'C'), f(4, null, 'D'), f(5, 4, 'E')]
    expect([...folderWithDescendants(all, 1)].sort()).toEqual([1, 2, 3])
    expect([...folderWithDescendants(all, 2)].sort()).toEqual([2, 3])
    expect([...folderWithDescendants(all, 4)].sort()).toEqual([4, 5])
    expect([...folderWithDescendants(all, 3)].sort()).toEqual([3])
  })

  it('folderWithDescendants：成环也不死循环', () => {
    const cyc = [f(1, 2, 'A'), f(2, 1, 'B')]
    expect([...folderWithDescendants(cyc, 1)].sort()).toEqual([1, 2])
  })
})