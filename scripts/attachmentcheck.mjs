import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

// 老脚本里的 root 一律指向仓库根，原样保留的自有声明就能继续用
const root = ROOT

const tmpHome = join(ROOT, '.screenshots', 'attach-home')
const PORT = 9371

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()
try {
  console.log('【就绪】等待界面稳定…')
for (let i = 0; i < 7; i++) { await sleep(500); if (i % 2 === 1) console.log('  ' + Math.round((i + 1) * 0.5) + 's') }
  // 1x1 的透明 PNG，最小的合法图片
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const noteId = await app.evaluate("window.zhixing.db.notes().then((n) => n[0]?.id ?? null)")
  check('拿到了第一篇文章的 id', typeof noteId === 'number', J({ noteId }))
  const saved = await app.evaluate("window.zhixing.db.saveAttachmentData(" + noteId + ", 'thumb-test.png', '" + png + "')")
  check('saveAttachmentData 成功返回落盘路径', saved?.ok === true && typeof saved.path === 'string', J(saved))
  if (saved?.path) {
    check('落盘路径在 attachments 目录下', String(saved.path).includes('attachment'), J({ path: saved.path }))
    check('文件确实写到了磁盘', existsSync(saved.path), J({ exists: existsSync(saved.path) }))
  }
  // ---- 工具栏：用的是项目的 Toolbar（panel 形态）+ text-btn，不是我临时写的那套
  await app.evaluate("document.querySelector('[data-nav-item=\"notes\"]')?.click()")
  await sleep(2200)
  const tree = await app.evaluate("document.querySelectorAll('.ntree__note').length")
  let rich = false
  let bar = null
  for (let i = 0; i < Math.min(tree, 8); i++) {
    await app.evaluate("document.querySelectorAll('.ntree__note')[" + i + "]?.click()")
    await sleep(1300)
    if (await app.evaluate("!!document.querySelector('.rt-editor .ProseMirror')")) {
      rich = true
      bar = await app.evaluate(
        "(() => { const t = document.querySelector('.rt-editor .toolbar, .rt-editor .tb, .rt-editor .toolbar__bar');" +
          "const btns = document.querySelectorAll('.rt-editor .text-btn');" +
          "return { textBtns: btns.length, labels: [...btns].map((b) => b.textContent.trim()), hasBar: !!t }; })()"
      )
      break
    }
  }
  // ---- 树标题：宽度不足时换行（而不是省略号），行内元素仍垂直居中
  const treeCss = await app.evaluate(
    "(() => { const t = document.querySelector('.ntree__title'); const f = document.querySelector('.ntree__foldername');" +
      "if (!t) return { found: false };" +
      "const cs = getComputedStyle(t);" +
      "const row = t.closest('.ntree__note');" +
      "const rowCs = row ? getComputedStyle(row) : null;" +
      "return { found: true, titleWhite: cs.whiteSpace, titleWrap: cs.overflowWrap, folderWhite: f ? getComputedStyle(f).whiteSpace : null, rowAlign: rowCs ? rowCs.alignItems : null }; })()"
  )
  check('笔记标题改为换行（white-space: normal）', treeCss.titleWhite === 'normal', J(treeCss))
  const icons = await app.evaluate(
    "(() => { const t = [...document.querySelectorAll('.ntree__type')];" +
      "const tones = [...new Set(t.map((x) => [...x.classList].find((c) => c.startsWith('ntree__type--'))))];" +
      "return { count: t.length, tones }; })()"
  )
  check('笔记项按类型显示图标', (icons.count ?? 0) > 0, J(icons))
  check('类型图标带色阶（可区分类型）', (icons.tones ?? []).length >= 1 && !(icons.tones ?? []).includes(undefined), J(icons))
  check('长词也能断行（overflow-wrap: anywhere）', String(treeCss.titleWrap).includes('anywhere'), J({ wrap: treeCss.titleWrap }))
  check('文件夹名同样换行', treeCss.folderWhite === 'normal', J(treeCss))
  check('行内元素垂直居中（align-items: center）', treeCss.rowAlign === 'center', J({ align: treeCss.rowAlign }))
  check('找到富文本笔记', rich, J({ rich }))
  check('工具栏用的是项目的 text-btn 按钮', (bar?.textBtns ?? 0) >= 14, J(bar))
  // Toolbar 会额外渲染一份「隐藏测量行」用于算宽度，所以标签会重复出现 —— 只看包含关系即可
  check('工具栏含加粗 / 图片 / 文件按钮', ['B', '图片', '文件'].every((x) => (bar?.labels ?? []).includes(x)), J({ labels: bar?.labels }))

  const list2 = await app.evaluate("window.zhixing.db.attachments().then((a) => a.filter((x) => String(x.path).includes('thumb-test'))) ")
  check('附件表里有这条记录', Array.isArray(list2) && list2.length >= 1, J({ n: Array.isArray(list2) ? list2.length : null }))
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
await app.close()
process.exit(finish())