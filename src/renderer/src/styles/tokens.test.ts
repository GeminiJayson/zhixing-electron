import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 令牌完整性护栏。
 *
 * 起因（真实缺陷，本仓实测）：`tasks.css` 与 `workflow.css` 引用了从未定义过的
 * `--ease-standard`，`notes.css` 引用了从未定义过的 `--space-6`。因为 var() 没有 fallback，
 * 整条声明会在「计算值」阶段失效 —— 那两条 transition 一直没有跑，那条 padding 一直是 0，
 * 而**没有任何检查会因此变红**（全仓没有 stylelint，也没有扫硬编码值的脚本）。
 *
 * 「约定拦不住，断言才拦得住」—— 所以把这三件事钉成测试：
 * 1. 无 fallback 的 var(--x) 必须有定义（CSS 定义，或 JS 内联注入并登记在白名单里）；
 * 2. 白名单里的名字必须真的被 JS 注入过（否则白名单会变成掩盖缺失的废纸）；
 * 3. transition / animation 里不许出现裸时间值（docs/03 §11.1），时长只能来自 token。
 */

const SRC = join(process.cwd(), 'src', 'renderer')
const STYLES = join(SRC, 'src', 'styles')

/** JS 内联注入的令牌：它们不在 CSS 里定义，但由组件按元素写入。 */
const JS_INJECTED = [
  '--gnode-c', // components/GraphNodeIcon.tsx
  '--link-a', // pages/NotesPage.tsx
  '--link-b', // pages/NotesPage.tsx
  '--row-indent', // components/TaskRow.tsx
  '--widget-opacity', // WidgetApp.tsx（值由主进程推来）
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'node_modules') continue
      walk(p, out)
    } else if (/\.(ts|tsx|css)$/.test(entry.name) && !entry.name.includes('.test.')) {
      out.push(p)
    }
  }
  return out
}

const sourceFiles = (): string[] => walk(SRC)
const cssFiles = (): string[] => readdirSync(STYLES).filter((f) => f.endsWith('.css')).map((f) => join(STYLES, f))

/** CSS 自定义属性的定义：`--name:`（排除 var(--name) 这类引用）。 */
function defineInCss(source: string, out: Set<string>): void {
  for (const m of source.matchAll(/(?:^|[\s{;])(--[a-z0-9-]+)\s*:/gi)) out.add(m[1])
}

/** JS/TS 的注入方式：setProperty('--name', …) 与对象字面量 '--name': …。 */
function defineInJs(source: string, out: Set<string>): void {
  for (const m of source.matchAll(/setProperty\(\s*'(--[a-z0-9-]+)'/g)) out.add(m[1])
  for (const m of source.matchAll(/['"](--[a-z0-9-]+)['"]\s*:/g)) out.add(m[1])
}

function collects(): { defined: Set<string>; refs: { name: string; file: string; line: number; hasFallback: boolean }[] } {
  const defined = new Set<string>()
  const refs: { name: string; file: string; line: number; hasFallback: boolean }[] = []
  for (const file of [...sourceFiles(), ...cssFiles()]) {
    const text = readFileSync(file, 'utf8')
    defineInCss(text, defined)
    defineInJs(text, defined)
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/gi)) {
        refs.push({ name: m[1], file, line: i + 1, hasFallback: m[2] === ',' })
      }
    })
  }
  return { defined, refs }
}

describe('设计令牌完整性', () => {
  const { defined, refs } = collects()

  it('无 fallback 的 var() 引用必须都有定义', () => {
    const missing = refs
      .filter((r) => !r.hasFallback && !defined.has(r.name) && !JS_INJECTED.includes(r.name))
      .map((r) => `${r.name} ← ${r.file.replace(process.cwd() + '\\', '')}:${r.line}`)
    expect(missing, '未定义的令牌会让整条声明静默失效，必须在 tokens.css 里补上或加 fallback').toEqual([])
  })

  it('JS 注入白名单里的令牌必须真的被注入（白名单不许长草）', () => {
    const jsSources = sourceFiles()
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
    const stale = JS_INJECTED.filter(
      (name) => !new RegExp(`setProperty\\(\\s*'${name}'|['"]${name}['"]\\s*:`).test(jsSources)
    )
    expect(stale, '白名单里已经没人注入的名字应当删掉，否则它会掩盖真正的缺失').toEqual([])
  })

  it('transition / animation 不得出现裸时间值', () => {
    const offenders: string[] = []
    for (const file of cssFiles()) {
      const isTokens = file.endsWith('tokens.css')
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // tokens.css 是唯一允许写字面时长的地方（它负责定义 token）
          if (isTokens) return
          // 只看 transition / animation 系列声明，且属性名不能是自定义属性定义行
          if (!/^\s*(transition|animation)(-[a-z]+)?\s*:/.test(line)) return
          if (/\d+(\.\d+)?(ms|s)\b/.test(line)) {
            offenders.push(`${file.replace(process.cwd() + '\\', '')}:${i + 1} ${line.trim()}`)
          }
        })
    }
    expect(offenders, '时长只能引用 --dur-*（docs/03 §11.1）').toEqual([])
  })

  it('backdrop-filter 只能出现在白名单选择器上（性能护栏）', () => {
    // backdrop-filter 每帧采样背后区域：挂在列表项/滚动容器上会直接吃掉帧率。
    const ALLOW = ['titlebar', 'popmenu', 'tagmenu', 'modal', 'palette', 'toast', 'infobar', 'tb--sticky', 'glass-preview']
    const offenders: string[] = []
    for (const file of cssFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/backdrop-filter\s*:/.test(line)) return
        // 往回找最近的规则选择器：窗口要够大，规则的头部可能隔着一大段注释
        let selector = ''
        for (let j = i; j >= 0 && j > i - 30; j--) {
          if (!/\{\s*$/.test(lines[j])) continue
          if (/^\s*\}/.test(lines[j])) continue
          selector = lines[j].replace(/\{\s*$/, '').trim()
          break
        }
        if (!ALLOW.some((a) => selector.includes(a))) {
          offenders.push(`${file.replace(process.cwd() + '\\', '')}:${i + 1} 选择器「${selector || '(未识别)'}」`)
        }
      })
    }
    expect(offenders, '玻璃拟态只给固定且数量少的浮层用，列表与滚动容器一律不准用').toEqual([])
  })
})

/**
 * 硬编码护栏（2026-10-05 加）。
 *
 * 起因：组件 CSS 里散着 47 处裸颜色、32 处裸字重、25 处裸字号 —— 主题包改不动它们，
 * 想统一调字号也没有落点。全部收进 tokens.css 之后，这里把它们钉住。
 *
 * **为什么用「断言」而不是「约定」**：这三类值写错不会报错、也不会让任何检查变红，
 * 只会在某个主题下看着不对 —— 而这条测试每次跑都会看一遍。
 *
 * 注：这里的正则**刻意不写反斜杠**（用 [0-9] 代替 d、[ ] 代替 s、[(] 代替括号转义），
 * 因为这段代码是脚本生成的，反斜杠在多层转义里丢过一次。改动时保持这个风格。
 */
describe("组件 CSS 的硬编码护栏", () => {
  const componentCss = (): { file: string; body: string }[] =>
    readdirSync(STYLES)
      .filter((f) => f.endsWith(".css") && f !== "tokens.css")
      .map((f) => ({ file: f, body: readFileSync(join(STYLES, f), "utf8") }))

  /** 去掉块注释：注释里出现色值通常是在解释历史，不算硬编码。 */
  const strip = (s: string): string =>
    s
      .split("/*")
      .map((part) => {
        const end = part.indexOf("*/")
        return end < 0 ? part : part.slice(end + 2)
      })
      .join("")

  const collect = (re: RegExp): string[] => {
    const hits: string[] = []
    for (const { file, body } of componentCss()) {
      for (const m of strip(body).matchAll(re)) hits.push(file + " → " + m[0].slice(0, 40))
    }
    return hits
  }

  it("没有裸颜色 —— 颜色只能来自 token（否则主题包改不动它）", () => {
    const hits = collect(/#[0-9a-fA-F]{3,8}|rgba?[(]|hsla?[(]/g)
    expect(hits, "改用 tokens.css 的语义色：--fg-* / --bg-* / --accent-* / --format-* / --border / --overlay").toEqual([])
  })

  it("没有裸字重 —— 只能 --fw-normal / --fw-medium / --fw-semibold", () => {
    expect(collect(/font-weight[ ]*:[ ]*[0-9]/g)).toEqual([])
  })

  it("没有裸字号 —— 只能 --text-*", () => {
    expect(collect(/font-size[ ]*:[ ]*[0-9]/g)).toEqual([])
  })

  it("没有裸行高 —— 只能 --lh-*", () => {
    expect(collect(/line-height[ ]*:[ ]*[0-9]+([.][0-9]+)?[ ]*[;}]/g)).toEqual([])
  })
})
