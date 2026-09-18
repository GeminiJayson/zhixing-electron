/**
 * 主进程文件日志（对齐 Python 的 loguru 配置：logs/zhixing.log，1MB × 3 份滚动）。
 *
 * 此前 Electron 只有零散 console.warn/error，线上问题无痕可查。
 * 这里用 hook console 的方式覆盖全仓调用点，不必逐个替换。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './db/connection'

const MAX_BYTES = 1024 * 1024
const KEEP = 3

function format(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? String(arg)
  if (typeof arg === 'string') return arg
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

function rotate(file: string): void {
  try {
    if (!existsSync(file) || statSync(file).size < MAX_BYTES) return
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = i === 1 ? file : file + '.' + (i - 1)
      const to = file + '.' + i
      if (existsSync(from)) renameSync(from, to)
    }
  } catch {
    // 滚动失败不应影响写入
  }
}

/** 挂上文件 sink（幂等）。主进程启动时调用一次。 */
export function initFileLog(): void {
  const dir = join(dataDir(), 'logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return
  }
  const file = join(dir, 'zhixing.log')
  const write = (level: string, args: unknown[]): void => {
    try {
      rotate(file)
      appendFileSync(file, new Date().toISOString() + ' [' + level + '] ' + args.map(format).join(' ') + '\n')
    } catch {
      // 日志失败不能影响主流程
    }
  }
  const origError = console.error.bind(console)
  const origWarn = console.warn.bind(console)
  console.error = (...a: unknown[]): void => {
    write('ERROR', a)
    origError(...a)
  }
  console.warn = (...a: unknown[]): void => {
    write('WARN', a)
    origWarn(...a)
  }
}
