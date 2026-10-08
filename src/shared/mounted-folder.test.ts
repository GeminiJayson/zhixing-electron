import { describe, expect, it } from 'vitest'
import { extOf, isSafeRelPath, mountNameOf, previewKindOf, shouldSkipMountEntry, sortMountEntries, type MountEntry } from './mounted-folder'

const e = (name: string, isDir = false): MountEntry => ({ relPath: name, name, isDir, size: 0, mtime: 0 })

describe('shouldSkipMountEntry', () => {
  it('跳过隐藏项与依赖目录', () => {
    expect(shouldSkipMountEntry('.git')).toBe(true)
    expect(shouldSkipMountEntry('.DS_Store')).toBe(true)
    expect(shouldSkipMountEntry('node_modules')).toBe(true)
    expect(shouldSkipMountEntry('')).toBe(true)
  })
  it('正常文件照常列出', () => {
    expect(shouldSkipMountEntry('笔记.md')).toBe(false)
    expect(shouldSkipMountEntry('reports')).toBe(false)
  })
})

describe('sortMountEntries', () => {
  it('同级目录在前，再按名字（自然序）', () => {
    const out = sortMountEntries([e('b.md'), e('a.md'), e('zdir', true), e('adir', true), e('file10.md'), e('file2.md')])
    expect(out.map((x) => x.name)).toEqual(['adir', 'zdir', 'a.md', 'b.md', 'file2.md', 'file10.md'])
  })
})

describe('isSafeRelPath（安全边界）', () => {
  it('挡掉绝对路径、盘符、穿越与反斜杠', () => {
    expect(isSafeRelPath('/etc/passwd')).toBe(false)
    expect(isSafeRelPath('C:/Windows/win.ini')).toBe(false)
    expect(isSafeRelPath('../secret')).toBe(false)
    expect(isSafeRelPath('a/../../b')).toBe(false)
    expect(isSafeRelPath('a\\b')).toBe(false)
    expect(isSafeRelPath('')).toBe(false)
    expect(isSafeRelPath('a//b')).toBe(false)
  })
  it('正常相对路径通过', () => {
    expect(isSafeRelPath('docs/readme.md')).toBe(true)
    expect(isSafeRelPath('readme.md')).toBe(true)
  })
})

describe('previewKindOf / extOf', () => {
  it('文本按扩展名认出，图片单独一类，其余不预览', () => {
    expect(previewKindOf('a.md')).toBe('text')
    expect(previewKindOf('a.PY')).toBe('text')
    expect(previewKindOf('a.png')).toBe('image')
    expect(previewKindOf('a.docx')).toBe('none')
    expect(previewKindOf('无扩展名')).toBe('none')
    expect(extOf('a.tar.gz')).toBe('gz')
  })
})

describe('mountNameOf', () => {
  it('取最后一段，兼容两种斜杠与尾斜杠', () => {
    expect(mountNameOf('D:\\Docs\\项目')).toBe('项目')
    expect(mountNameOf('D:/Docs/项目/')).toBe('项目')
    expect(mountNameOf('D:\\')).toBe('D:')
  })
})
