import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as fsx from 'node:fs'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

// 老脚本里的 root 一律指向仓库根，原样保留的自有声明就能继续用
const root = ROOT
const wordDir = join(root, '.screenshots', 'wordout')

const tmpHome = join(ROOT, '.screenshots', 'archive-home')
const PORT = 9381

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()
try {
  console.log('【就绪】等待界面稳定…')
for (let i = 0; i < 7; i++) { await sleep(500); if (i % 2 === 1) console.log('  ' + Math.round((i + 1) * 0.5) + 's') }
  console.log('【步骤】造任务数据')
  // 两步：先在页面里造数据并把 id 存到全局，再用那个全局做释放 —— 全程不做字符串插值
  const setup = await app.evaluate(`(async () => {
    const parent = await window.zhixing.db.createTask('归档父', null, null)
    const child = await window.zhixing.db.createTask('归档子', parent.id, null)
    await window.zhixing.db.setStatus(parent.id, 'done')
    const c1 = await window.zhixing.db.setStatus(child.id, 'done')
    window.__rel = { parentId: parent.id, childId: child.id }
    return { parentId: parent.id, childId: child.id, childParent: c1 && c1.parent_id, childStatus: c1 && c1.status }
  })()`)
  check('造出父子两个任务（子挂父）并标记完成', setup.childStatus === 'done' && setup.childParent === setup.parentId, J(setup))
  const freed = await app.evaluate(`(async () => {
    const f = await window.zhixing.db.restoreCompleted(window.__rel.childId, null)
    const c = await window.zhixing.db.restoreCompleted(window.__rel.childId, null)
    const p = await window.zhixing.db.setStatus(window.__rel.parentId, 'done')
    const after = await window.zhixing.db.restoreCompleted(window.__rel.childId, null)
    return { freedStatus: f && f.status, freedCompleted: f && f.completed_at, freedParent: f && f.parent_id,
      againParent: c && c.parent_id, parentBackToDone: p && p.status, lastParent: after && after.parent_id }
  })()`)
  check('释放后回到待执行（status=todo 且清空完成时间）', freed.freedStatus === 'todo' && freed.freedCompleted === null, J(freed))
  check('层级原样保留（parent_id 始终是父任务）', freed.freedParent === setup.parentId && freed.againParent === setup.parentId && freed.lastParent === setup.parentId, J(freed))
  // 把父任务重新设回完成，再释放子任务，看父是否被连带恢复
  // 真正的「连带恢复祖先」验证：把父重新设回完成，再释放子，然后查父的状态
  const cascade = await app.evaluate(`(async () => {
    await window.zhixing.db.setStatus(window.__rel.parentId, 'done')
    const before = await window.zhixing.db.getTask(window.__rel.parentId)
    await window.zhixing.db.restoreCompleted(window.__rel.childId, null)
    const after = await window.zhixing.db.getTask(window.__rel.parentId)
    return { beforeStatus: before && before.status, afterStatus: after && after.status }
  })()`)
  check(
    '连带恢复仍是终态的祖先（父任务也回到待执行）',
    cascade.beforeStatus === 'done' && cascade.afterStatus === 'todo',
    J(cascade)
  )
  console.log('【步骤】清单增改删')
  // ---- 清单分类可编辑：新建 → 改名 → 删除，走的是 UI 用的同一组 API
  const listFlow = await app.evaluate(`(async () => {
    const made = await window.zhixing.db.createListFolder('验证清单', 'list', null)
    const id = made && (made.id !== undefined ? made.id : made)
    const renamed = await window.zhixing.db.renameListFolder(id, '验证清单改名')
    const after = (await window.zhixing.db.listFolders()).find((f) => f.id === id)
    const removed = await window.zhixing.db.deleteListFolder(id)
    const gone = (await window.zhixing.db.listFolders()).find((f) => f.id === id)
    const dlg = typeof window.zhixing.db.renameListFolder
    return { id, renamedChanges: renamed, name: after && after.name, removedChanges: removed, stillThere: !!gone, apiKind: dlg }
  })()`)
  check('能新建清单', listFlow.id !== undefined && listFlow.id !== null, J(listFlow))
  check('能重命名清单', listFlow.name === '验证清单改名', J(listFlow))
  check('能删除清单', listFlow.removedChanges !== 0 && listFlow.stillThere === false, J(listFlow))

  // ---- 任务页上确实出现了管理入口
  await app.evaluate("document.querySelector('[data-nav-item=\"tasks\"]')?.click()")
  await sleep(2000)
  const ui = await app.evaluate("(() => { const btns = [...document.querySelectorAll('button')].map((b) => b.textContent.trim()); return { hasNew: btns.includes('＋ 清单'), hasEdit: btns.includes('清单设置') } })()")
  check('任务页出现「＋ 清单」与「清单设置」', ui.hasNew === true && ui.hasEdit === true, J(ui))

  console.log('【步骤】Word 导出')
  // Word 笔记的编辑区头部要有「导出 .docx」按钮（上一轮只做了通道，没有入口）
  await app.evaluate(`document.querySelector('[data-nav-item="notes"]')?.click()`)
  await sleep(2200)
  let wordBtn = null
  for (let i = 0; i < 8; i++) {
    await app.evaluate('document.querySelectorAll(\'.ntree__note\')[' + i + ']?.click()')
    await sleep(1200)
    wordBtn = await app.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '导出 .docx'); return b ? { found: true, disabled: b.disabled } : null })()`)
    if (wordBtn) break
  }
  check('Word 笔记的编辑区出现了「导出 .docx」按钮', wordBtn?.found === true && wordBtn.disabled === false, J(wordBtn))
  await app.evaluate(`document.querySelector('[data-nav-item="tasks"]')?.click()`)
  await sleep(1200)

  // ---- Word 导出：转出 .docx，且**原文件一字未动**
  const wordOut = await app.evaluate(`(async () => {
    const res = await window.zhixing.db.exportDocx('C:/tmp/知行导出验证/原文.docx', '<h1>标题</h1><p>正文<strong>加粗</strong></p><ul><li>一项</li></ul>', '我的文档')
    return res
  })()`)
  check('导出 .docx 成功', wordOut?.ok === true && typeof wordOut.path === 'string', J(wordOut))
  if (wordOut?.path) {
    check('导出的确实是 .docx 文件且已落盘', wordOut.path.endsWith('.docx') && existsSync(wordOut.path), J({ path: wordOut.path, exists: existsSync(wordOut.path) }))
    check('文件名带「编辑版」且不覆盖原件', wordOut.path.includes('编辑版') && !wordOut.path.endsWith('原文.docx'), J({ path: wordOut.path }))
    check('导出的是合法 docx（zip 头 PK）', fsx.readFileSync(wordOut.path).slice(0, 2).toString('utf8') === 'PK', 'ok')
  }

} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
await app.close()
process.exit(finish())