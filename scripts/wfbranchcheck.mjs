/**
 * 工作流：条件节点的「满足 / 不满足」两条分支 + 实例再次运行/删除 + 模板栏宽度可调。
 *
 * 覆盖：
 *   1. branch_false_node_id 落库并能读回
 *   2. 推进：条件不成立走 false 分支、成立走 true 分支
 *   3. 实例：rerunWorkflowInstance 新开一个实例；deleteWorkflowInstance 只删该实例，
 *      模板与已生成的任务都不动
 *   4. 画布：条件节点下方有内容条、两个分支端口、两条分支标签（满足 / 不满足）
 *   5. 模板栏：分隔条存在，拖动改宽度并记进 localStorage
 *
 * 用法：node scripts/wfbranchcheck.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

const root = ROOT
const require = createRequire(import.meta.url)
const tmpHome = join(ROOT, '.screenshots', 'wfbranch-home')
const PORT = 9257

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish, results } = createChecker()
const STAMP = 'WB' + Date.now().toString(36)

try {
  // ------------------------------------------------ 1. 建模板：条件节点两条分支
  // 新节点用负临时 id，saveWorkflowTemplate 会把分支引用重映射成真实 id
  const task = await app.evaluate(`window.zhixing.db.createTask(${J(STAMP + ' 条件任务')})`)
  const actionValue = JSON.stringify({ kind: 'task', taskId: task.id, expectDone: true })
  const tpl = await app.evaluate(
    `window.zhixing.db.saveWorkflowTemplate({ name: ${J(STAMP + ' 双分支')}, start_policy: 'first', nodes: [
        { id: -1, title: '判断', order_index: 0, action_kind: 'condition', action_value: ${J(actionValue)}, branch_node_id: -2, branch_false_node_id: -3 },
        { id: -2, title: '满足目标', order_index: 1 },
        { id: -3, title: '不满足目标', order_index: 2 }
      ] }).then((r) => (r.ok ? window.zhixing.db.workflowTemplate(r.templateId) : r))`
  )
  const cond = tpl?.nodes?.find((n) => n.action_kind === 'condition')
  const yesNode = tpl?.nodes?.find((n) => n.title === '满足目标')
  const noNode = tpl?.nodes?.find((n) => n.title === '不满足目标')
  check('测试模板已建立', tpl?.nodes?.length === 3, J(tpl?.problems ?? ''))
  check(
    'branch_false_node_id 落库并能读回',
    cond?.branch_node_id === yesNode?.id && cond?.branch_false_node_id === noNode?.id,
    J(cond && { t: cond.branch_node_id, f: cond.branch_false_node_id })
  )

  // ------------------------------------------------ 2. 推进：不成立走 false、成立走 true
  const instFalse = await app.evaluate(
    `window.zhixing.db.instantiateWorkflow(${tpl.id}, ${J(STAMP + ' 不成立')}, null, 'first')`
  )
  check(
    '条件不成立 → 走「不满足」分支',
    instFalse?.steps?.[0]?.title === '不满足目标',
    J(instFalse?.steps?.map((s) => s.title))
  )

  await app.evaluate(`window.zhixing.db.toggleTask(${task.id})`)
  const instTrue = await app.evaluate(
    `window.zhixing.db.instantiateWorkflow(${tpl.id}, ${J(STAMP + ' 成立')}, null, 'first')`
  )
  check(
    '条件成立 → 走「满足」分支',
    instTrue?.steps?.[0]?.title === '满足目标',
    J(instTrue?.steps?.map((s) => s.title))
  )

  // ------------------------------------------------ 3. 实例再次运行 / 删除
  const rerun = await app.evaluate(`window.zhixing.db.rerunWorkflowInstance(${instFalse.id})`)
  check(
    '再次运行新开一个实例（旧实例保留）',
    Boolean(rerun) && rerun.id !== instFalse.id,
    J({ old: instFalse.id, next: rerun?.id })
  )
  const stillOld = await app.evaluate(`window.zhixing.db.workflowInstance(${instFalse.id})`)
  check('旧实例记录仍在', stillOld?.id === instFalse.id)

  const rerunTaskId = rerun?.steps?.[0]?.task_id ?? 0
  const delOk = await app.evaluate(`window.zhixing.db.deleteWorkflowInstance(${rerun.id})`)
  const gone = await app.evaluate(`window.zhixing.db.workflowInstance(${rerun.id})`)
  const tplAlive = await app.evaluate(`window.zhixing.db.workflowTemplate(${tpl.id})`)
  check('删除实例：实例没了、模板还在', delOk === true && gone === null && tplAlive?.id === tpl.id)
  const taskAlive = await app.evaluate(
    `window.zhixing.db.tasks(500).then((rows) => rows.some((t) => t.id === ${rerunTaskId}))`
  )
  check('删除实例不删已生成的任务', taskAlive === true, J(rerunTaskId))

  // ------------------------------------------------ 4. 画布 UI
  await app.evaluate(`document.querySelector('[data-nav-item="workflow"]').click()`)
  await sleep(1400)
  const ui = await app.evaluate(
    `(() => {
       const on = document.querySelector('.wf-node--template.wf-node--on strong')
       const strip = document.querySelector('.wf-node__cond text')
       return {
         template: on ? on.textContent : '',
         strip: strip ? strip.textContent : '',
         ports: document.querySelectorAll('.wf-port--true, .wf-port--false').length,
         jumpPorts: document.querySelectorAll('.wf-port--jump').length,
         labels: [...document.querySelectorAll('.wf-port__label')].map((e) => e.textContent),
         instBtns: document.querySelectorAll('[aria-label="再次运行实例"],[aria-label="删除实例"]').length,
         splitter: document.querySelectorAll('.wf-splitter').length
       }
     })()`
  )
  check('打开的是刚建的模板', String(ui.template).includes('双分支'), J(ui.template))
  check('条件节点上显示了条件内容', String(ui.strip).includes('任务'), J(ui.strip))
  check('条件节点的两条分支端口都在', ui.ports === 2, J(ui.ports))
  check('普通步骤也各有「跳到」端口', ui.jumpPorts === 2, J(ui.jumpPorts))
  // 「满足 / 不满足」写在条件节点两个端口旁，不是画在虚线上
  check(
    '两个端口分别标着满足 / 不满足',
    ui.labels.includes('满足') && ui.labels.includes('不满足'),
    J(ui.labels)
  )
  check('实例行有「再次运行 / 删除」入口', ui.instBtns >= 2, J(ui.instBtns))
  check('模板栏分隔条存在', ui.splitter === 1, J(ui.splitter))

  // ------------------------------------------------ 5. 拖动分隔条改宽度
  const drag = await app.evaluate(
    `(async () => {
       const el = document.querySelector('.wf-splitter')
       const aside = document.querySelector('.wf-side')
       if (!el || !aside) return null
       const before = Math.round(aside.getBoundingClientRect().width)
       const opts = { bubbles: true, pointerId: 7, isPrimary: true, clientY: 320 }
       el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, opts, { clientX: 240 })))
       el.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, opts, { clientX: 330 })))
       el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts, { clientX: 330 })))
       await new Promise((r) => setTimeout(r, 150))
       return {
         before,
         after: Math.round(aside.getBoundingClientRect().width),
         stored: Number(localStorage.getItem('wf.sideWidth'))
       }
     })()`
  )
  check(
    '拖动分隔条能加宽模板栏并记进 localStorage',
    Boolean(drag) && drag.after > drag.before + 40 && drag.stored === drag.after,
    J(drag)
  )
  // ------------------------------------------------ 6. 条件节点上「加一步」必须是分支步骤
  // 换一个「条件节点还没配任何分支」的模板：这时条件只有兜底出边
  const tpl2 = await app.evaluate(
    `window.zhixing.db.saveWorkflowTemplate({ name: ${J(STAMP + ' 加步骤')}, start_policy: 'first', nodes: [
        { title: '判断', order_index: 0, action_kind: 'condition', action_value: JSON.stringify({ kind: 'confirm', prompt: '继续吗？' }) },
        { title: '原有下一步', order_index: 1 },
        { title: '收尾', order_index: 2 }
      ] }).then((r) => (r.ok ? window.zhixing.db.workflowTemplate(r.templateId) : r))`
  )
  check('第二个模板已建立', tpl2?.nodes?.length === 3, J(tpl2?.problems ?? ''))

  // 回到任务页再切回来，强制工作流页重新挂载并打开最新模板
  await app.evaluate(`document.querySelector('[data-nav-item="tasks"]').click()`)
  await sleep(400)
  await app.evaluate(`document.querySelector('[data-nav-item="workflow"]').click()`)
  await sleep(1300)

  const draft = await app.evaluate(
    `(async () => {
       const wait = (ms) => new Promise((r) => setTimeout(r, ms))
       const svg = document.querySelector('.wf-canvas')
       const cond = document.querySelector('g.wf-node .wf-node__diamond')?.closest('g.wf-node')
       if (!svg || !cond) return { error: '找不到条件节点' }
       const rect = cond.getBoundingClientRect()
       const opts = { bubbles: true, pointerId: 11, isPrimary: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }
       cond.dispatchEvent(new PointerEvent('pointerdown', opts))
       svg.dispatchEvent(new PointerEvent('pointerup', opts))
       await wait(120)
       const addBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('加一步'))
       if (!addBtn) return { error: '找不到「加一步」' }
       addBtn.click()
       await wait(200)
       const modal = document.querySelector('.modal')
       if (!modal) return { error: '编辑弹窗没出现' }
       const row = [...modal.querySelectorAll('.form-row')].find((r) => r.textContent.includes('挂到'))
       const sel = row ? row.querySelector('select') : null
       const save = [...modal.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存')
       const info = {
         hasBranchPicker: Boolean(sel),
         optionLabels: sel ? [...sel.options].map((o) => o.textContent.trim()) : [],
         disabledOptions: sel ? [...sel.options].filter((o) => o.disabled).map((o) => o.value) : [],
         saveDisabledBefore: save ? save.disabled : null
       }
       if (!sel || !save) return { ...info, error: '没有分支选择器或保存按钮' }
       const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
       setter.call(sel, 'true')
       sel.dispatchEvent(new Event('change', { bubbles: true }))
       await wait(150)
       const saveDisabledAfter = save.disabled
       const titleInput = modal.querySelector('input.field')
       if (titleInput) {
         const tsetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
         tsetter.call(titleInput, '新增分支步骤')
         titleInput.dispatchEvent(new Event('input', { bubbles: true }))
       }
       await wait(100)
       save.click()
       await wait(1200)
       return { ...info, saveDisabledAfter, saved: !document.querySelector('.modal') }
     })()`
  )

  if (draft?.error) {
    check('条件节点上「加一步」走分支流程', false, J(draft))
  } else {
    check('条件节点上「加一步」出现分支选择器', draft.hasBranchPicker === true, J(draft.optionLabels))
    check(
      '分支选择器没有「不挂分支」这一项',
      !draft.optionLabels.some((t) => t.includes('不挂')),
      J(draft.optionLabels)
    )
    check(
      '没选分支时保存不可点',
      draft.saveDisabledBefore === true && draft.saveDisabledAfter === false,
      J({ before: draft.saveDisabledBefore, after: draft.saveDisabledAfter })
    )
    check('选了「满足」后保存成功', draft.saved === true)
  }

  // ------------------------------------------------ 7. 连线几何：垂直入边、不贴边、不穿节点
  await sleep(600)
  const geo = await app.evaluate(
    `(() => {
       const m = (g) => { const r = /translate\\(([-\\d.]+),([-\\d.]+)\\)/.exec(g.getAttribute('transform') || ''); return r ? { x: +r[1], y: +r[2] } : { x: 0, y: 0 } }
       return {
         nodes: [...document.querySelectorAll('g.wf-node[data-wf-node]')].map((g) => ({
           id: +g.getAttribute('data-wf-node'),
           title: g.querySelector('.wf-node__title')?.textContent ?? '',
           kind: g.querySelector('.wf-node__diamond') ? 'condition' : 'step',
           ...m(g)
         })),
         paths: [...document.querySelectorAll('path.wf-edge')].map((p) => ({
           cls: p.getAttribute('class') || '', d: p.getAttribute('d') || ''
         }))
       }
     })()`
  )

  const W = 150
  const H = 56
  const pts = (d) => [...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((x) => ({ x: +x[1], y: +x[2] }))
  const aligned = (ps) =>
    ps.every((p, i) => i === 0 || Math.abs(p.x - ps[i - 1].x) < 0.01 || Math.abs(p.y - ps[i - 1].y) < 0.01)
  const atEdgeMidpoint = (p, n) =>
    (p.x === n.x + W / 2 && (p.y === n.y || p.y === n.y + H)) ||
    (p.y === n.y + H / 2 && (p.x === n.x || p.x === n.x + W))
  /** 末段必须垂直于所进入的那条边，并且落点在该边中点上（不是沿着边框走）。 */
  const entersPerpendicular = (d, nodes) => {
    const ps = pts(d)
    if (ps.length < 2) return false
    const last = ps[ps.length - 1]
    const prev = ps[ps.length - 2]
    const n = nodes.find((x) => atEdgeMidpoint(last, x))
    if (!n) return false
    const onTopOrBottom = last.y === n.y || last.y === n.y + H
    return onTopOrBottom ? prev.x === last.x : prev.y === last.y
  }

  console.log('[geo] ' + J(geo))

  const branches = geo.paths.filter((p) => p.cls.includes('wf-edge--branch'))
  check(
    '只配了「满足」时：一条分支虚线 + 一条兜底出边',
    branches.length === 1 &&
      branches[0].cls.includes('wf-edge--branch-true') &&
      geo.paths.filter((p) => p.cls.includes('wf-edge--fallback')).length === 1,
    J(geo.paths.map((p) => p.cls))
  )
  check(
    '每条连线都是轴对齐折线（没有斜线）',
    geo.paths.every((p) => aligned(pts(p.d))),
    J(geo.paths.map((p) => p.d))
  )
  check(
    '每条连线都垂直进入目标节点的边中点，不沿边框走',
    geo.paths.every((p) => entersPerpendicular(p.d, geo.nodes)),
    J(geo.paths.map((p) => p.d))
  )

  const condNode = geo.nodes.find((n) => n.kind === 'condition')
  const newStep = geo.nodes.find((n) => n.title.includes('新增分支步骤'))
  check('条件节点上新增的步骤已落到画布', Boolean(newStep), J(geo.nodes.map((n) => n.title)))
  check(
    '新步骤是「满足」分支的目标（绿色虚线从右尖角连过去）',
    Boolean(newStep) &&
      branches.some(
        (b) =>
          b.cls.includes('wf-edge--branch-true') &&
          pts(b.d)[0].x === condNode.x + W &&
          pts(b.d)[0].y === condNode.y + H / 2 &&
          (() => {
            const last = pts(b.d).slice(-1)[0]
            return last.x === newStep.x + W / 2 && last.y === newStep.y
          })()
      ),
    J(branches.map((b) => b.d))
  )
  check(
    '条件节点没有到新步骤的常规顺序连线',
    !geo.paths.some(
      (p) =>
        !p.cls.includes('wf-edge--branch') &&
        !p.cls.includes('wf-edge--fallback') &&
        (() => {
          const last = pts(p.d).slice(-1)[0]
          return newStep ? last.x === newStep.x + W / 2 && last.y === newStep.y : false
        })()
    ),
    J(geo.paths.map((p) => p.cls + ' ' + p.d))
  )
} catch (err) {
  check('脚本执行完成', false, err instanceof Error ? err.message : String(err))
}
await app.close()
process.exit(finish())