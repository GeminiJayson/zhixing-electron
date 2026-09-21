/**
 * 端到端脚本共用的 CDP 骨架。
 *
 * 来由：这套「拉起 Electron → 连 CDP → send → evaluate → check → 收尾退出」
 * 曾在 50 多个脚本里逐字复制，并且已经分叉成几种实现 ——
 * rollcheck 只修了其中一份，其余同款缺陷就一直留着。
 * 样板每多一份，修一处就要想「还有几份没改」；收到这里之后只有一处要改。
 *
 * 用法：
 *   import { launchApp, createChecker } from './lib/cdp.mjs'
 *   const app = await launchApp({ port: 9399, home: join(root, '.screenshots', 'xxx-home') })
 *   const { check, finish } = createChecker()
 *   ...
 *   await app.close()
 *   process.exit(finish())
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)

/** 仓库根目录（scripts/lib 往上两级）。 */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 收紧 PATH：Electron 起来时别被外部 node/python 干扰。 */
// 收紧 PATH：只留系统目录，免得外部 node/python 干扰被测应用。
// powershell.exe 住在 WindowsPowerShell\v1.0 这一层，**必须带上** ——
// 应用读「当前选中的文字」是模拟 Ctrl+C（SendKeys）实现的，而它是用裸名
// spawn('powershell.exe')：PATH 里找不到就直接失败，表现是捕获窗口里永远空着。
const SYS_PATH = [
  'C:\\Windows\\System32',
  'C:\\Windows',
  'C:\\Windows\\System32\\Wbem',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'
].join(';')

/** 独立小窗口（小组件/提醒/条件/捕获）不是主界面，默认不作为目标。 */
export const AUX_TARGET = /[?&](widget|reminder|condition|capture)=1/

export { sleep }

/**
 * 拉起应用并接上 CDP。
 *
 * @param port 调试端口；各脚本仍各自错开，避免并行时互相踩
 * @param home ZHIXING_HOME 指向的临时数据目录，会先清空
 * @param match 选哪个 CDP 目标；默认挑主界面那个 page
 * @param copyDb 是否先把真实库拷一份过去（脚本一律不该写真实库）
 * @param tries 等窗口的轮次，每轮 500ms
 * @param settle 接上目标后再等多久（毫秒），让首屏画完
 * @param env 追加/覆盖的环境变量
 * @param onWait 每轮的进度回调
 */
export async function launchApp({
  port,
  home,
  match,
  /**
   * 是否把用户**真实库**拷一份来跑。默认 false —— 原因是一次踩出来的：
   * 生产库里一旦有了真实数据（比如灌进去的种子数据），凡「照着列表里有什么来找自己那条」
   * 的脚本就会开始失败，而「绿」也不再等价于「功能正常」，只是「库恰好长得合适」。
   *
   * 默认走夹具：给一个空目录，应用启动时会跑 seedIfEmpty()，生成一份固定基线
   * （工作/生活两个分组 + 「我的清单」+ 2 条欢迎任务 + 1 篇欢迎笔记）。
   * 确定、可复现、schema 永远跟着当前代码走，不必往仓库里塞二进制库。
   *
   * 确实需要用户真实数据的脚本（截图、导入导出之类）显式传 copyDb: true。
   */
  copyDb = false,
  tries = 70,
  settle = 3000,
  env = {},
  /**
   * 生产库模式：home 是用户真实数据目录时，绝不能清空、也不能拿它当 profile。
   * 传 clean:false + copyDb:false + 独立 profile 就能与用户正在运行的实例并存 ——
   * Electron 的单实例锁按 --user-data-dir 区分，而 WAL 下两个进程读写同一只库是安全的。
   */
  clean = true,
  profile = null,
  onWait = (i) => {
    if (i % 4 === 0) console.log('【等窗口】' + Math.round(i * 0.5) + 's')
  }
}) {
  if (clean) {
    // 上一个实例可能还没完全释放 profile 目录（Electron 有好几个子进程），
    // 直接 rmSync 会 EBUSY/EPERM 把脚本崩在开头 —— 重试几次，实在不行就沿用旧目录继续跑。
    for (let i = 0; i < 6; i++) {
      try {
        rmSync(home, { recursive: true, force: true })
        break
      } catch (e) {
        if (i === 5) console.log('  · 清理临时目录失败（' + (e && e.code) + '），沿用旧目录继续')
        else await sleep(400)
      }
    }
  }
  mkdirSync(home, { recursive: true })
  if (copyDb) {
    copyFileSync(join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db'), join(home, 'zhixing.db'))
  }
  const child = spawn(
    require('electron'),
    ['.', '--remote-debugging-port=' + port, '--user-data-dir=' + (profile ?? join(home, 'profile'))],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: SYS_PATH + ';' + (process.env.PATH ?? ''),
        ZHIXING_HOME: home,
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

  const targets = async () => {
    try {
      return await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
    } catch {
      return []
    }
  }

  const pick = match ?? ((x) => x.type === 'page' && !AUX_TARGET.test(x.url))
  let send = null
  let ws = null
  for (let i = 0; i < tries && !send; i++) {
    const t = (await targets()).find(pick)
    if (t) {
      ws = new WebSocket(t.webSocketDebuggerUrl)
      await new Promise((res) => ws.addEventListener('open', res, { once: true }))
      send = makeSend(ws)
      await send('Runtime.enable')
      // 老脚本的 attach() 都顺手开了 Page 域，保持一致（截图 / 导航事件依赖它）
      await send('Page.enable')
    } else {
      onWait(i)
      await sleep(500)
    }
  }
  if (!send) {
    child.kill()
    throw new Error('等不到 CDP 目标（已等 ' + tries * 0.5 + 's）')
  }
  // 接上目标 ≠ 界面画好了：React 首屏与数据加载还要一会儿。
  // 老脚本是在各自的样板区段里 await sleep(3000)，收到这里只留一处。
  if (settle > 0) await sleep(settle)
  const evaluate = makeEvaluator(send)

  // 夹具模式：seedIfEmpty() 只给一篇 markdown 欢迎笔记，
  // 而有一批脚本要「找到一篇富文本笔记」「找到一篇 word 笔记」。
  // 这里补齐每种格式一篇，标题带「夹具」前缀，都是确定性的。
  if (!copyDb) {
    try {
      const FIXTURE = [
        '(async () => {',
        '  const db = window.zhixing.db',
        '  const have = await db.notes(500)',
        '  const missing = ["richtext", "word", "excel", "link"].filter((f) => !have.some((n) => n.format === f))',
        '  if (!missing.length) return 0',
        '  const folders = await db.noteFolders()',
        '  const fid = folders.length ? folders[0].id : null',
        '  const NAMES = { richtext: "富文本示例", word: "Word 文档示例", excel: "表格示例", link: "参考资料链接" }',
        '  const BODY = { richtext: "夹具内容：富文本笔记", word: "C:/tmp/fixture.docx", excel: "C:/tmp/fixture.xlsx", link: "https://example.com/fixture" }',
        '  for (const f of missing) await db.createNote("夹具：" + NAMES[f], fid, BODY[f], f)',
        '  // 工作流：有一批脚本要断言「实例项也有编辑胶囊」，而它必须先有一个实例',
        '  const tpls = await db.workflowTemplates()',
        '  if (!tpls.length) {',
        '    const saved = await db.saveWorkflowTemplate({',
        '      name: "夹具：发布前置检查",',
        '      description: "夹具模板：两步任务节点",',
        '      start_policy: "first",',
        '      nodes: [',
        '        { title: "夹具步骤一：校验产物", action_kind: "task", order_index: 0 },',
        '        { title: "夹具步骤二：更新说明", action_kind: "task", order_index: 1 }',
        '      ]',
        '    })',
        '    if (saved && saved.ok && saved.templateId) await db.instantiateWorkflow(saved.templateId, "夹具实例", null, "first")',
        '  }',
        '  return missing.length',
        '})()'
      ].join('\n')
      const done = await evaluate(FIXTURE, true)
      if (done) console.log('【夹具】补齐了 ' + done + ' 种格式的示例笔记')
    } catch (e) {
      console.log('【夹具】补齐示例笔记失败（不影响启动）：' + (e && e.message))
    }
  }

  return {
    child,
    ws,
    send,
    /** 当前所有 CDP 目标（脚本用它判断有没有多出/收起独立窗口）。 */
    targets,
    /** 跑一段浏览器侧表达式，返回它的值。 */
    evaluate,
    /**
     * 订阅一条 CDP 事件（例如 Runtime.consoleAPICalled）。
     * 返回取消订阅的函数。与 send 的按 id 配对互不干扰。
     */
    on: (method, handler) => {
      const h = (ev) => {
        let x
        try {
          x = JSON.parse(ev.data)
        } catch {
          return
        }
        if (x.method === method) handler(x.params ?? {})
      }
      ws.addEventListener('message', h)
      return () => ws.removeEventListener('message', h)
    },
    /**
     * 二次挂载到另一个目标（浮窗 / 提醒窗 / 条件窗…）。
     *
     * 有一批脚本要同时看主窗口和独立窗口：先把 widget 关掉让提醒走主窗口卡片，
     * 再切回 widget 去挂 reminder=1 那个页面。老写法是各自抄一遍 connect()，
     * 这里统一成「按谓词找目标 → 连上 → 给一个求值器」。
     *
     * @param matchFn 目标谓词，入参是 /json/list 的一项
     * @param settle 挂上之后再等多久（毫秒）
     */
    attach: async (matchFn, opts = {}) => {
      const t = (await targets()).find(matchFn)
      if (!t) throw new Error('找不到要挂载的 CDP 目标')
      const w = new WebSocket(t.webSocketDebuggerUrl)
      await new Promise((res) => w.addEventListener('open', res, { once: true }))
      const s = makeSend(w)
      await s('Runtime.enable')
      await s('Page.enable')
      if (opts.settle > 0) await sleep(opts.settle)
      return {
        ws: w,
        send: s,
        evaluate: makeEvaluator(s),
        close: () => {
          try {
            w.close()
          } catch {
            // 已经断了就算了
          }
        }
      }
    },
    close: async () => {
      try {
        ws.close()
      } catch {
        // 已经断了就算了
      }
      // child.kill() 只杀主进程，渲染/GPU 子进程会继续占着 profile 目录，
      // 下一个脚本开头清理临时目录就会失败。Windows 上按进程树杀干净。
      if (process.platform === 'win32') {
        // 必须用绝对路径：脚本运行环境的 PATH 里未必有 System32，
        // 直接 spawn('taskkill') 会 ENOENT —— 而且没挂 error 监听的话，
        // 未处理的 'error' 事件会把进程整个崩掉（断言全过、退出码却是 1）。
        const tk = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
        if (existsSync(tk)) {
          try {
            spawn(tk, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on(
              'error',
              () => child.kill()
            )
          } catch {
            child.kill()
          }
        } else {
          child.kill()
        }
      } else {
        child.kill()
      }
      await sleep(800)
    }
  }
}

/** 一条 send：按消息 id 配对；15s 不到就是超时，能直接看出卡在哪一条。 */
function makeSend(ws) {
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 1e6)
      const timer = setTimeout(() => {
        ws.removeEventListener('message', h)
        reject(new Error('CDP 超时（15s）：' + method))
      }, 15000)
      const h = (ev) => {
        const x = JSON.parse(ev.data)
        if (x.id !== id) return
        clearTimeout(timer)
        ws.removeEventListener('message', h)
        resolve(x)
      }
      ws.addEventListener('message', h)
      ws.send(JSON.stringify({ id, method, params }))
    })
}

/** 从一条 send 造一个求值器 —— 主连接与二次挂载共用同一套语义。 */
function makeEvaluator(send) {
  return async (expr, quiet) => {
    if (!quiet) console.log('  · eval ' + String(expr).replace(/\s+/g, ' ').slice(0, 66))
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval 失败')
    }
    return r.result?.result?.value
  }
}

/**
 * 断言收集器：只记结果，收尾统一算账。
 *
 * 原先每个脚本各写一份，还分叉成「推 ok」和「推 [名字, ok]」两种 ——
 * 只有后者能在失败时报出是哪一条。统一成后者：失败清单比一个数字有用得多。
 */
export function createChecker() {
  const results = []
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok, detail })
    console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''))
    return ok
  }
  /** 打印总账，返回进程退出码（0 = 全过）。 */
  const finish = () => {
    const failed = results.filter((r) => !r.ok)
    console.log('')
    if (failed.length) {
      console.log('✗ ' + failed.length + ' 项未通过：')
      for (const f of failed) console.log('   - ' + f.name + (f.detail ? ' — ' + f.detail : ''))
    } else {
      console.log('✓ 全部通过（' + results.length + ' 项）')
    }
    return failed.length ? 1 : 0
  }
  return {
    check,
    finish,
    results,
    get failed() {
      return results.filter((r) => !r.ok).length
    }
  }
}

/** 把值塞进浏览器侧表达式时统一转 JSON。 */
export const J = (v) => JSON.stringify(v)
