/**
 * 回归检查：中文分词原生模块缺失时，主进程必须不崩、并降级为逐字分词。
 *
 * 背景：@node-rs/jieba 的win32 binding 走 optionalDependencies，npm 只装当前平台那一份。
 * 漏带时 require 会在**模块顶层**抛错，主进程启动即挂（Windows 上是一个报错弹窗）。
 * fts-query.ts 因此把加载包进 try/catch —— 这个脚本守住那条防线：
 *
 *   1. 构建产物顶层不得出现 @node-rs/jieba 的 require
 *      （有人改回静态 import 时 rollup 会把它提到最前面，try/catch 就白写了）；
 *   2. binding 抛错时 tokenize/queryTerms 仍可用且确实退化为逐字分词。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = join(root, 'out', 'main', 'index.js')
if (!existsSync(bundle)) {
  console.error('[jieba] 找不到 ' + bundle + '，先跑 npm run build')
  process.exit(1)
}

// 断言 1：bundle 开头的 external require 区不得出现 jieba
const head = readFileSync(bundle, 'utf-8').split('\n').slice(0, 40).join('\n')
if (head.includes('@node-rs/jieba')) {
  console.error('[jieba] 构建产物顶层出现 @node-rs/jieba 的 require，try/catch 防护已失效')
  process.exit(1)
}

// 断言 2：真机行为 —— 把 fts-query 打成可解析 node_modules 的 CJS，分别跑缺失/正常两条路
const tmpCjs = join(root, '.tmp-fts-query.cjs')
const dir = mkdtempSync(join(tmpdir(), 'jieba-check-'))
const runner = join(dir, 'run.cjs')
try {
  execFileSync(
    join(root, 'node_modules', '.bin', 'esbuild'),
    [
      'src/main/db/fts-query.ts',
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--external:@node-rs/jieba',
      '--external:@node-rs/jieba/dict',
      '--outfile=' + tmpCjs
    ],
    { cwd: root, stdio: 'pipe' }
  )
  writeFileSync(
    runner,
    [
      "const Module = require('module')",
      'if (process.argv[3] === "stub") {',
      '  const orig = Module._load',
      '  Module._load = function (r, p, i) {',
      '    if (typeof r === "string" && r.startsWith("@node-rs/jieba")) {',
      '      const e = new Error("Cannot find native binding")',
      '      e.code = "MODULE_NOT_FOUND"',
      '      throw e',
      '    }',
      '    return orig.call(this, r, p, i)',
      '  }',
      '}',
      'const m = require(process.argv[2])',
      'process.stdout.write(',
      '  JSON.stringify({ tokenize: m.tokenize("知识管理"), queryTerms: m.queryTerms("知识管理") })',
      ')'
    ].join('\n')
  )
  // stderr 丢掉：打桩那条 `Cannot find native binding` 是故意抛的，不该混进检查输出
  const run = (mode) =>
    JSON.parse(
      execFileSync(process.execPath, [runner, tmpCjs, mode], {
        cwd: root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
    )
  const stubbed = run('stub')
  const normal = run('normal')
  const expect = (label, got, want) => {
    if (got !== want) {
      console.error('[jieba] ' + label + '：期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got))
      process.exit(1)
    }
  }
  expect('binding 缺失时降级分词', stubbed.tokenize, '知 识 管 理')
  expect('binding 缺失时降级查询式', stubbed.queryTerms, '"知"* AND "识"* AND "管"* AND "理"*')
  expect('binding 正常时 jieba 分词', normal.tokenize, '知识 管理')
  expect('binding 正常时 jieba 查询式', normal.queryTerms, '"知识"* AND "管理"*')
  console.log('[jieba] OK：顶层无裸 require，缺失时降级为逐字分词且不崩')
} finally {
  rmSync(tmpCjs, { force: true })
  rmSync(dir, { recursive: true, force: true })
}
