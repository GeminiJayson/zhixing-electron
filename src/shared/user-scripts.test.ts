import { describe, expect, it } from 'vitest'
import {
  describeScript,
  isSafeScriptFile,
  lintBatch,
  parseCheckOutput,
  scriptFileFor,
  scriptFileFromInput,
  scriptTemplate,
  runtimeOf,
  scriptNameOf,
  sortScripts,
  type UserScript,
} from './user-scripts'

describe('runtimeOf', () => {
  it('按扩展名给运行环境', () => {
    expect(runtimeOf('a.ps1')).toBe('powershell')
    expect(runtimeOf('a.CMD')).toBe('cmd')
    expect(runtimeOf('a.bat')).toBe('cmd')
    expect(runtimeOf('a.py')).toBe('python')
    expect(runtimeOf('a.js')).toBe('node')
    expect(runtimeOf('a.mjs')).toBe('node')
  })

  it('不认识的一律 null（不猜）', () => {
    expect(runtimeOf('a.exe')).toBeNull()
    expect(runtimeOf('a.txt')).toBeNull()
    expect(runtimeOf('没有扩展名')).toBeNull()
    expect(runtimeOf('')).toBeNull()
  })
})

describe('scriptNameOf', () => {
  it('去掉最后一个扩展名', () => {
    expect(scriptNameOf('归档发票.ps1')).toBe('归档发票')
    expect(scriptNameOf('a.b.c.py')).toBe('a.b.c')
  })

  it('以点开头的隐藏文件不去扩展名', () => {
    expect(scriptNameOf('.env.py')).toBe('.env')
    expect(scriptNameOf('.hidden')).toBe('.hidden')
  })
})

describe('isSafeScriptFile —— 只收纯文件名', () => {
  it('正常文件名通过', () => {
    expect(isSafeScriptFile('归档发票.ps1')).toBe(true)
    expect(isSafeScriptFile('backup.mjs')).toBe(true)
  })

  it.each(['..\\x.ps1', 'a/b.py', 'C:\\Windows\\x.cmd', 'a..b.py', '', 'a|b.py', 'a*b.py'])(
    '%s 不通过',
    (f) => expect(isSafeScriptFile(f)).toBe(false)
  )

  it('超长名字不通过', () => {
    expect(isSafeScriptFile('x'.repeat(201) + '.py')).toBe(false)
  })
})

describe('describeScript', () => {
  it('优先取 desc:', () => {
    const text = ['# 这是第一行普通注释', '# desc: 归档下载目录里的发票', 'Write-Host 1'].join('\n')
    expect(describeScript(text)).toBe('归档下载目录里的发票')
  })

  it('没有 desc: 时取第一条注释', () => {
    expect(describeScript('# 把桌面截图归到年月文件夹\n$x=1')).toBe('把桌面截图归到年月文件夹')
    expect(describeScript('// 生成周报\nconsole.log(1)')).toBe('生成周报')
  })

  it('cmd 脚本的 REM 注释也算', () => {
    expect(describeScript('@echo off\r\nREM desc: 归档下载目录\r\necho hi')).toBe('归档下载目录')
    expect(describeScript(':: 备份数据库\r\nexit /b 0')).toBe('备份数据库')
  })

  it('接受中文冒号', () => {
    expect(describeScript('# desc：导出本周完成的任务')).toBe('导出本周完成的任务')
  })

  it('没有注释就是空串', () => {
    expect(describeScript('Write-Host 1\nWrite-Host 2')).toBe('')
  })

  it('只看前 30 行 —— 正文深处的注释不算说明', () => {
    const text = Array.from({ length: 40 }, (_, i) => (i === 35 ? '# 很靠后的注释' : '$x = ' + i)).join('\n')
    expect(describeScript(text)).toBe('')
  })
})

describe('sortScripts', () => {
  it('按修改时间倒序，同时间按文件名', () => {
    const s = (file: string, mtime: string): UserScript => ({
      file,
      name: file,
      runtime: 'node',
      description: '',
      mtime,
    })
    const list = sortScripts([s('b.js', '2026-10-01 09:00'), s('a.js', '2026-10-03 09:00'), s('c.js', '2026-10-01 09:00')])
    expect(list.map((x) => x.file)).toEqual(['a.js', 'b.js', 'c.js'])
  })
})


describe('scriptFileFor —— 名字 + 运行时 → 文件名', () => {
  it('按运行时给扩展名', () => {
    expect(scriptFileFor('备份数据库', 'powershell')).toBe('备份数据库.ps1')
    expect(scriptFileFor('cleanup', 'cmd')).toBe('cleanup.cmd')
    expect(scriptFileFor('report', 'python')).toBe('report.py')
    expect(scriptFileFor('sync', 'node')).toBe('sync.js')
  })

  it('去掉路径分隔符与 Windows 保留字符', () => {
    expect(scriptFileFor('a/b\\c:d*e?f', 'node')).toBe('abcdef.js')
  })

  it('自己写了扩展名就不叠一层', () => {
    expect(scriptFileFor('备份.py', 'python')).toBe('备份.py')
    expect(scriptFileFor('x.PS1', 'powershell')).toBe('x.ps1')
  })

  it('空名字与纯空白给兜底名', () => {
    expect(scriptFileFor('   ', 'node')).toBe('script.js')
    expect(scriptFileFor('', 'cmd')).toBe('script.cmd')
  })

  it('过长的名字截断', () => {
    expect(scriptFileFor('x'.repeat(200), 'node').length).toBeLessThanOrEqual(63)
  })
})

describe('scriptTemplate —— 新建脚本的骨架', () => {
  it('四种运行时的第一行都是 desc 注释', () => {
    expect(scriptTemplate('powershell', '归档发票').split('\n')[0]).toBe('# desc: 归档发票')
    expect(scriptTemplate('cmd', '归档发票').split('\r\n')[0]).toBe('@echo off')
    expect(scriptTemplate('cmd', '归档发票')).toContain('REM desc: 归档发票')
    expect(scriptTemplate('python', '生成周报')).toContain('# desc: 生成周报')
    expect(scriptTemplate('node', '生成周报')).toContain('// desc: 生成周报')
  })

  it('骨架自己能被 describeScript 读回说明', () => {
    for (const r of ['powershell', 'cmd', 'python', 'node'] as const) {
      expect(describeScript(scriptTemplate(r, '干这个'))).toBe('干这个')
    }
  })
})

describe('lintBatch —— cmd 的启发式检查', () => {
  it('正常脚本没有意见', () => {
    expect(lintBatch('@echo off\r\nREM 说明\r\necho "hello"\r\nexit /b 0')).toEqual([])
  })

  it('引号不成对报在哪一行', () => {
    const p = lintBatch('@echo off\necho "没关\nexit /b 0')
    expect(p).toHaveLength(1)
    expect(p[0].line).toBe(2)
  })

  it('右括号多了就报', () => {
    expect(lintBatch('if exist a (\n  echo x\n)\n)').some((x) => x.message.includes('右括号'))).toBe(true)
  })

  it('左括号没闭合报在整体（line 0）', () => {
    expect(lintBatch('if exist a (\n  echo x').some((x) => x.line === 0)).toBe(true)
  })

  it('注释行不参与括号配平', () => {
    expect(lintBatch('REM 这是个 （中文括号\necho ok')).toEqual([])
  })

  it('行尾的 ^ 是续行符，那一行的引号不闭合不算错', () => {
    expect(lintBatch('echo "继续 ^\n  下一行"')).toEqual([])
  })
})

describe('parseCheckOutput —— 解析器输出 → 行号 + 消息', () => {
  it('空输出 = 没有错误', () => {
    expect(parseCheckOutput('')).toEqual([])
    expect(parseCheckOutput('   \n  ')).toEqual([])
  })

  it('PowerShell 的「行号:消息」', () => {
    expect(parseCheckOutput('3:缺少表达式或语句')).toEqual([{ line: 3, message: '缺少表达式或语句' }])
  })

  it('Python 的 File "...", line N', () => {
    const out = '  File "<unknown>", line 7\n    x = (\n        ^\nSyntaxError: \'(\' was never closed'
    const p = parseCheckOutput(out)
    expect(p[0].line).toBe(7)
    expect(p[0].message).toContain('SyntaxError')
  })

  it('Node 的 路径:N', () => {
    const out = '/tmp/zx-check.js:4\nx = (\n    ^\n\nSyntaxError: Invalid or unexpected token'
    const p = parseCheckOutput(out)
    expect(p[0].line).toBe(4)
    expect(p[0].message).toContain('SyntaxError')
  })

  it('认不出来的输出退化成整体一条，绝不假装没错误', () => {
    const p = parseCheckOutput('something went terribly wrong')
    expect(p).toHaveLength(1)
    expect(p[0].line).toBe(0)
    expect(p[0].message).toContain('terribly')
  })
})


describe('scriptFileFromInput —— 树上内联输入 → 文件名', () => {
  it('不写扩展名就按默认的 PowerShell', () => {
    expect(scriptFileFromInput('备份')).toBe('备份.ps1')
    expect(scriptFileFromInput('  cleanup  ')).toBe('cleanup.ps1')
  })

  it('写了扩展名就按扩展名走（运行时不需要再选一次）', () => {
    expect(scriptFileFromInput('x.py')).toBe('x.py')
    expect(scriptFileFromInput('x.cmd')).toBe('x.cmd')
    expect(scriptFileFromInput('x.mjs')).toBe('x.mjs')
  })

  it('路径分隔符与保留字符照样被摘掉', () => {
    expect(scriptFileFromInput('a/b:c.js')).toBe('abc.js')
  })

  it('空输入返回空串（调用方据此不创建）', () => {
    expect(scriptFileFromInput('   ')).toBe('')
    expect(scriptFileFromInput('')).toBe('')
  })
})
