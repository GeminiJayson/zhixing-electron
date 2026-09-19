/**
 * 读取「当前选中的文字」。
 *
 * Electron 没有跨应用的选区 API，通用的办法只有一条：**模拟一次 Ctrl+C 再读剪贴板**。
 * 这里把这件事做成对用户无痕的：
 *   1. 先记下剪贴板原内容（用完还回去，不打扰用户的剪贴板）；
 *   2. 写入一个哨兵值再复制 —— 这样「当前什么都没选中」不会误读成上一轮的旧内容；
 *   3. 用 PowerShell 的 SendKeys 模拟 Ctrl+C（Windows 自带，不需要原生依赖）；
 *   4. 稍等片刻读回文本与 HTML；
 *   5. 还原剪贴板。
 *
 * **调用方必须先取文本、后显示窗口**：一旦把主窗口带到前台，焦点就离开目标应用，
 * 这时候再模拟复制只会复制到自己的界面。
 *
 * 非 Windows 平台没有这条通路，退回剪贴板内容（与改造前的行为一致）。
 */
import { spawn } from 'node:child_process'
import { clipboard } from 'electron'
import { setTimeout as sleep } from 'node:timers/promises'

export interface SelectedText {
  text: string
  html: string
}

/** 模拟 Ctrl+C：SendKeys 必须跑在 STA 线程里（powershell.exe -STA） */
function simulateCopy(): Promise<void> {
  return new Promise((resolve) => {
    const script =
      'Add-Type -AssemblyName System.Windows.Forms; ' +
      '[System.Windows.Forms.SendKeys]::SendWait("^c")'
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 已经退出就无所谓
      }
      resolve()
    }, 4000)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export async function readSelectedText(): Promise<SelectedText> {
  if (process.platform !== 'win32') {
    return { text: clipboard.readText(), html: clipboard.readHTML() }
  }
  const prevText = clipboard.readText()
  const prevHtml = clipboard.readHTML()
  const sentinel = `__zhixing_noselect_${Date.now()}__`

  clipboard.writeText(sentinel)
  await simulateCopy()
  // SendKeys 是异步的：给它一点时间把内容写进剪贴板
  await sleep(120)
  const text = clipboard.readText()
  const html = clipboard.readHTML()

  // 还原用户的剪贴板（不管读到什么都没有理由把它留在我们这儿）
  try {
    if (prevText || prevHtml) clipboard.write({ text: prevText, html: prevHtml })
    else clipboard.clear()
  } catch (err) {
    console.error('[selection] 还原剪贴板失败', err)
  }

  const got = text && text !== sentinel ? text : ''
  return { text: got, html: got ? html : '' }
}
