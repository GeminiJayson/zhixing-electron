/**
 * 富文本笔记里的图片验证：
 *   1. 旧笔记内嵌的**原图** data URI 在载入时被收成缩略图（并落成附件）；
 *   2. 正文图片按缩略图尺寸显示（高度封顶），预览不受这条限制；
 *   3. 双击 / 空格都能打开原图预览（旧图没有 data-attachment 时用自身 src）。
 * 用法：node scripts/richpiccheck.mjs
 */
import { join } from 'node:path'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

const app = await launchApp({ port: 9393, home: join(ROOT, '.screenshots', 'richpic-home') })
const { check, finish } = createChecker()

const IMG_STATE = `(() => {
  const img = document.querySelector('.rt-editor__body img')
  if (!img) return null
  return {
    attach: !!img.getAttribute('data-attachment'),
    kind: (img.getAttribute('src') || '').slice(0, 16),
    maxHeight: getComputedStyle(img).maxHeight,
    height: Math.round(img.getBoundingClientRect().height),
  }
})()`

try {
  for (let i = 0; i < 6; i++) await sleep(500)

  // 造一篇「老格式」的富文本笔记：正文里嵌的是原图（900x700，远超 360 的缩略图上限）
  const noteId = await app.evaluate(`(async () => {
    const c = document.createElement('canvas')
    c.width = 900
    c.height = 700
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#123456'
    ctx.fillRect(0, 0, 900, 700)
    ctx.fillStyle = '#e2e8f0'
    ctx.fillRect(40, 40, 300, 120)
    const uri = c.toDataURL('image/png')
    const html = '<p>旧笔记图片</p><img src="' + uri + '" alt="legacy">'
    const note = await window.zhixing.db.createNote('验证-旧图缩略化', null, html, 'richtext')
    return note && note.id
  })()`)
  check('造出一篇内嵌原图的旧笔记', typeof noteId === 'number' && noteId > 0, J(noteId))

  await app.evaluate(`document.querySelector('[data-nav-item="notes"]')?.click()`)
  await sleep(1500)
  await app.evaluate(`([...document.querySelectorAll('.ntree__note')].find((el) => el.textContent.includes('验证-旧图缩略化')))?.click()`)
  await sleep(3400)

  const img = await app.evaluate(IMG_STATE)
  check(
    '载入旧笔记时把内嵌原图收成缩略图 + 附件',
    !!img && img.attach === true && img.kind.startsWith('data:image/jpeg'),
    J(img)
  )
  check('正文图片按缩略图尺寸显示（高度封顶 240px）', !!img && img.maxHeight === '240px' && img.height <= 240, J(img))

  // 双击预览
  await app.evaluate(`(() => {
    const el = document.querySelector('.rt-editor__body img')
    if (el) el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    return true
  })()`)
  await sleep(500)
  const dblSrc = await app.evaluate(
    "(() => { const p = document.querySelector('.rt-preview__img'); return p ? p.getAttribute('src') : null })()"
  )
  check('双击图片能打开原图预览', typeof dblSrc === 'string' && dblSrc.startsWith('file:'), String(dblSrc).slice(0, 24))
  await app.evaluate("document.querySelector('.rt-preview')?.click()")
  await sleep(300)

  // 空格预览：先点中图片（NodeSelection），再按空格
  await app.evaluate(`(() => {
    const el = document.querySelector('.rt-editor__body img')
    if (!el) return false
    const r = el.getBoundingClientRect()
    const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }
    el.dispatchEvent(new MouseEvent('mousedown', opts))
    el.dispatchEvent(new MouseEvent('mouseup', opts))
    el.dispatchEvent(new MouseEvent('click', opts))
    return true
  })()`)
  await sleep(400)
  const selected = await app.evaluate("!!document.querySelector('.rt-editor__body .ProseMirror-selectednode')")
  await app.evaluate(`(() => {
    const dom = document.querySelector('.rt-editor__body .ProseMirror')
    if (dom) dom.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    return true
  })()`)
  await sleep(500)
  const spaceSrc = await app.evaluate(
    "(() => { const p = document.querySelector('.rt-preview__img'); return p ? p.getAttribute('src') : null })()"
  )
  check(
    '选中图片后按空格能打开原图预览',
    selected && typeof spaceSrc === 'string' && spaceSrc.startsWith('file:'),
    J({ selected, spaceSrc: String(spaceSrc).slice(0, 24) })
  )
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
await app.close()
process.exit(finish())
