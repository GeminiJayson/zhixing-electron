import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

import { shell } from 'electron'
import { isSafeExternalUrl, openExternalSafely } from './security'

/**
 * 渲染进程能出现的链接全部来自用户内容（笔记正文、导入数据），
 * 不校验就交给 shell.openExternal 等于把任意系统协议处理器暴露给内容层。
 */
describe('对外打开链接的协议白名单', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('放行 http / https / mailto（协议大小写不敏感）', () => {
    expect(isSafeExternalUrl('https://example.com/a?b=1')).toBe(true)
    expect(isSafeExternalUrl('http://localhost:5173/')).toBe(true)
    expect(isSafeExternalUrl('mailto:someone@example.com')).toBe(true)
    expect(isSafeExternalUrl('HTTPS://EXAMPLE.COM')).toBe(true)
  })

  it('拦下能借系统协议处理器逃逸的写法', () => {
    const blocked = [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ms-msdt:/id PCWDiagnostic',
      'smb://host/share',
      'data:text/html,<script>alert(1)</script>',
      'not a url',
      '',
    ]
    for (const url of blocked) {
      expect(isSafeExternalUrl(url), url).toBe(false)
    }
  })

  it('非法 URL 绝不落到 shell.openExternal', () => {
    openExternalSafely('file:///etc/passwd')
    expect(shell.openExternal).not.toHaveBeenCalled()

    openExternalSafely('https://example.com')
    expect(shell.openExternal).toHaveBeenCalledTimes(1)
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com')
  })
})
