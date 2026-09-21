/**
 * 工作流侧栏：模板分类 + 行内编辑胶囊。
 * 用法：node scripts/wfgroupcheck.mjs（先 npm run build）
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

// 老脚本里的 root 一律指向仓库根，原样保留的自有声明就能继续用
const root = ROOT
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')

const tmpHome = join(ROOT, '.screenshots', 'wfgroup-home')
const PORT = 9258

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish, results } = createChecker()
const STAMP = 'WFG' + Date.now().toString(36)

await app.evaluate("document.querySelector('[data-nav-item=workflow]').click()")
await sleep(1500)

// 造数据：一个分类 + 分类下一个模板 + 一个实例
const gid = await app.evaluate(`window.zhixing.db.saveWorkflowGroup({ name: ${J(STAMP + ' 分类')}, parentId: null }).then((r) => r.id)`)
const tpl = await app.evaluate(
  `window.zhixing.db.saveWorkflowTemplate({ name: ${J(STAMP + ' 模板')}, description: '', start_policy: 'first', nodes: [{ title: '第一步', order_index: 0 }] }).then((r) => r.templateId)`
)
await app.evaluate(`window.zhixing.db.moveWorkflowTemplate(${tpl}, ${gid})`)
// 切走再切回，让侧栏重新拉一次
await app.evaluate("document.querySelector('[data-nav-item=today]').click()")
await sleep(600)
await app.evaluate("document.querySelector('[data-nav-item=workflow]').click()")
await sleep(1500)

const tree = await app.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('.wf-tree .wf-node')]
  return nodes.map((n) => ({
    cls: n.className,
    text: (n.querySelector('.wf-node__label')?.innerText ?? '').split('\\n')[0].slice(0, 24),
    indent: parseInt(n.style.paddingLeft || '0', 10),
    ops: [...n.querySelectorAll('.wf-node__ops .icon-btn')].map((b) => b.getAttribute('title')),
  }))
})()`)
const groupRow = tree.find((n) => n.cls.includes('wf-node--group') && n.text.includes(STAMP))
const tplRow = tree.find((n) => n.cls.includes('wf-node--template') && n.text.includes(STAMP))
check('分类项出现在模板树里', !!groupRow, J(tree.map((t) => t.text)))
check(
  '分类项的编辑胶囊：新建模板 / 子分类 / 重命名 / 删除',
  !!groupRow && groupRow.ops.length === 4 && groupRow.ops[0].includes('新建工作流') && groupRow.ops[3].includes('删除'),
  J(groupRow?.ops)
)
check('模板项挂在分类下（有缩进）', !!tplRow && tplRow.indent > (groupRow?.indent ?? 0), J({ g: groupRow?.indent, t: tplRow?.indent }))
check(
  '模板项的编辑胶囊：重命名 / 复制 / 删除',
  !!tplRow && tplRow.ops.length === 3 && tplRow.ops[0] === '重命名' && tplRow.ops[2] === '删除',
  J(tplRow?.ops)
)
const headOps = await app.evaluate("[...document.querySelectorAll('.wf-side__head .icon-btn')].map((b) => b.getAttribute('title'))")
check('原先的「新建工作流」按钮已取消（标题行只剩新建分类）', JSON.stringify(headOps) === JSON.stringify(['新建分类']), J(headOps))

const inst = await app.evaluate(`(() => {
  const row = [...document.querySelectorAll('.wf-node--static')][0]
  if (!row) return null
  return { title: row.innerText.split('\\n')[0].slice(0, 20), ops: [...row.querySelectorAll('.wf-node__ops .icon-btn')].map((b) => b.getAttribute('title')) }
})()`)
check('实例项也有编辑胶囊', !!inst && inst.ops.includes('重命名实例'), J(inst))

const shot = await app.send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) writeFileSync(join(root, '.screenshots', 'wf-groups.png'), Buffer.from(shot.result.data, 'base64'))

// 清理
await app.evaluate(`window.zhixing.db.deleteWorkflowTemplate(${tpl})`)
await app.evaluate(`window.zhixing.db.deleteWorkflowGroup(${gid})`)

await sleep(500)
await app.close()
process.exit(finish())