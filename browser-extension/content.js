/**
 * 在页面里侦测"登录表单被提交了"，把账号密码交给后台脚本。
 *
 * **这个脚本只能看到自己所在页面的 DOM** —— 它拿不到别的标签页、别的窗口、
 * 别的应用里的任何东西，也不需要任何系统权限。这与"全局键盘钩子"是两回事：
 * 后者能拿到你敲的每一个键，前者只在你按下某个网站的登录按钮时读到那个表单。
 *
 * 覆盖三种提交方式，因为现代站点三种都有：
 *   1. 原生 form 提交   -> submit 事件
 *   2. 按钮 click + JS   -> click 事件（React / Vue 站点常见）
 *   3. 回车提交          -> keydown + Enter
 */

var DEDUPE_MS = 30000
var SEEN = {}

function findPasswordInput(scope) {
  var root = scope || document
  var all = root.querySelectorAll('input[type="password"]')
  for (var i = 0; i < all.length; i++) {
    if (all[i].value && all[i].value.length > 0) return all[i]
  }
  return null
}

/**
 * 提取当前页面的正文。
 *
 * **这是"抓取"这件事最该待的地方** —— content script 拿得到渲染后的 DOM、
 * 用户自己的登录态、以及浏览器已经处理好的编码。主进程 fetch 那三条一个都做不到
 *（见 docs/specs/phase3-research.md §1.2）。
 *
 * Readability 由 manifest 先加载（vendor/Readability.js 是 UMD；它在顶层用
 * function 声明定义 Readability，所以同一隔离世界里直接可用）。
 * 提取失败或正文短于 200 字符时回退到 body.innerText，并如实标注 ——
 * 那种内容会带着导航和广告，用户该知道。
 */
/**
 * 把一棵（克隆出来的）子树里的图片**变成存得住的样子**。
 *
 * 两件事：
 * 1. **相对地址变绝对**：`<img src="/a/b.png">` 存进库里就再也找不到图了 ——
 *    正文 HTML 是脱离原页面保存的，必须在这一步定死完整 URL。
 * 2. **懒加载图还原**：大量站点把真图放在 `data-src` / `data-original` / `data-lazy-src`，
 *    `src` 只是一个 1×1 占位 —— 直接存下来就是一片灰框（用户报的"图片没抓到"）。
 *    一并处理 `srcset`（每段 URL 都要绝对化）。
 */
function absolutizeImages(root) {
  if (!root || !root.querySelectorAll) return
  var imgs = root.querySelectorAll('img')
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i]
    var lazy =
      img.getAttribute('data-src') ||
      img.getAttribute('data-original') ||
      img.getAttribute('data-lazy-src') ||
      img.getAttribute('data-actualsrc') ||
      ''
    var src = img.getAttribute('src') || ''
    var placeholder = !src || /^data:image\/(gif|png);base64,[A-Za-z0-9+/=]{0,120}$/.test(src)
    if (lazy && placeholder) img.setAttribute('src', lazy)
    src = img.getAttribute('src') || ''
    if (src && !/^data:/i.test(src)) {
      try {
        img.setAttribute('src', new URL(src, location.href).href)
      } catch (e) {
        /* 相对地址都拼不出来就保持原样 */
      }
    }
    var srcset = img.getAttribute('srcset')
    if (srcset) {
      img.setAttribute(
        'srcset',
        srcset
          .split(',')
          .map(function (part) {
            var seg = part.trim().split(/\s+/)
            if (!seg[0] || /^data:/i.test(seg[0])) return part.trim()
            try {
              seg[0] = new URL(seg[0], location.href).href
            } catch (e) {
              /* 保持原样 */
            }
            return seg.join(' ')
          })
          .join(', ')
      )
    }
    // 存下来的是静态文档，留着 loading=lazy 只会让它在收件箱里永远不加载
    img.removeAttribute('loading')
  }
}

/**
 * 把页面滚到底再滚回来，触发懒加载与无限滚动。
 *
 * 为什么必须做：**没滚到的内容根本不在 DOM 里** —— 用户报的"滚动到底部的会丢失"就是这个。
 * Readability 再聪明也只能读到已经加载出来的东西。
 *
 * 代价与取舍：会让页面动一下。所以（1）只在**全文剪藏**时做，区域剪藏是用户自己看着选的，
 * 页面乱跳反而会让他选错；（2）全程有上限（默认 4 秒 / 60 步），超长页面也不会卡住；
 * （3）结束后**还原原来的滚动位置**，用户回到页面时看到的还是他刚才那一屏。
 */
function scrollToLoad(maxMs) {
  var startY = window.scrollY || document.documentElement.scrollTop || 0
  var t0 = Date.now()
  var step = 0
  var lastHeight = 0
  var still = 0
  return new Promise(function (resolve) {
    function tick() {
      var before = document.documentElement.scrollHeight
      window.scrollBy(0, Math.max(400, Math.floor(window.innerHeight * 0.9)))
      step++
      var atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4
      // 连续两次滚到底且页面高度不再增长：认定到底了（无限滚动也会在新内容加载后继续变高）
      if (before === lastHeight) still++
      else still = 0
      lastHeight = document.documentElement.scrollHeight
      if ((atBottom && still >= 2) || Date.now() - t0 > maxMs || step > 60) {
        window.scrollTo(0, startY)
        resolve()
        return
      }
      setTimeout(tick, 120)
    }
    if (document.documentElement.scrollHeight <= window.innerHeight + 8) {
      resolve()
      return
    }
    tick()
  })
}

async function extractArticle() {
  // 全文剪藏先滚一遍：懒加载与无限滚动的内容不进 DOM 就抓不到
  try {
    await scrollToLoad(4000)
  } catch (e) {
    /* 滚动失败不影响抓取 */
  }
  try {
    // 传克隆节点：Readability 会改动 DOM，不能让它动到用户正在看的页面
    var clone = document.cloneNode(true)
    // 图片在克隆上先绝对化：Readability 之后再处理会丢掉它自己剔除的节点
    absolutizeImages(clone)
    var reader = new Readability(clone)
    var a = reader.parse()
    var text = a && a.textContent ? a.textContent.trim() : ''
    if (text.length > 200) {
      var tpl = document.createElement('div')
      tpl.innerHTML = a.content || ''
      // Readability 会重写一遍结构，再走一次图片处理兜底
      absolutizeImages(tpl)
      return {
        ok: true,
        url: location.href,
        title: (a.title || document.title || '').trim(),
        // text 用于判断长度与降级；**html 才是落库的东西** ——
        // 纯文本会丢掉段落、标题层级、表格和图片，那样剪藏就没意义了
        text: text,
        html: tpl.innerHTML,
        mode: 'readability',
      }
    }
  } catch (e) {
    // 落到回退分支
  }
  return {
    ok: true,
    url: location.href,
    title: (document.title || '').trim(),
    text: document.body ? document.body.innerText.trim() : '',
    mode: 'fallback',
  }
}

/**
 * 清洗选中的那块 HTML。
 *
 * **沙箱 iframe 已经挡住了脚本执行**，所以这不是唯一防线；但两道都要有：
 * 存进去的东西本身干净，以后换渲染方式（比如导出成 markdown）时不会带着毒。
 * 只删真正危险的东西，**不碰结构与内联样式** —— 那正是用户选它的理由。
 */
function sanitize(html) {
  var tpl = document.createElement('template')
  tpl.innerHTML = html
  var drop = ['script', 'style', 'link', 'meta', 'iframe', 'object', 'embed', 'form', 'input', 'button']
  drop.forEach(function (tag) {
    var list = tpl.content.querySelectorAll(tag)
    for (var i = list.length - 1; i >= 0; i--) list[i].remove()
  })
  var all = tpl.content.querySelectorAll('*')
  for (var j = 0; j < all.length; j++) {
    var el = all[j]
    var attrs = Array.prototype.slice.call(el.attributes)
    for (var k = 0; k < attrs.length; k++) {
      var n = attrs[k].name.toLowerCase()
      // on* 事件属性；javascript: 链接；以及 srcset 里可能藏的脚本
      if (n.indexOf('on') === 0 || (n === 'href' && /^\s*javascript:/i.test(el.getAttribute('href') || ''))) {
        el.removeAttribute(attrs[k].name)
      }
    }
    // 图片的 data: 之外一律保留，它的 src 是内容的一部分
  }
  return tpl.innerHTML
}

/**
 * 元素选择模式：让用户点页面上的某一块，只取那一块。
 *
 * **这是 Readability 的互补，不是替代** —— Readability 猜"正文在哪"，
 * 猜不准时会带上导航、侧栏、推荐位。而"我只想要那个表格"这种需求，
 * 全文提取无论多聪明都做不到，只能让用户指一下。
 *
 * 用 pointer-events:none 的高亮框而不是给元素加 outline：
 * 后者会改到页面自身的样式，取消时可能还原不干净。
 */
var picker = null

/**
 * 在页面上直接显示结果。
 *
 * **不再只依赖系统通知** —— 通知在 Windows 上会被专注助手或通知设置静默拦掉，
 * 那样用户看到的就是"点了没反应"，而东西可能已经存进去了，也可能没有，
 * 他无从判断。页面内的提示由我们自己画，一定显示得出来。
 */
function flash(msg, ok) {
  try {
    var el = document.createElement('div')
    el.setAttribute(
      'style',
      'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;' +
        'padding:10px 20px;border-radius:999px;pointer-events:none;max-width:70vw;' +
        'font:14px/1.4 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;color:#fff;' +
        'box-shadow:0 4px 20px rgba(0,0,0,.32);background:' +
        (ok ? '#0e7490' : '#b91c1c')
    )
    el.textContent = msg
    document.body.appendChild(el)
    setTimeout(
      function () {
        el.remove()
      },
      ok ? 3000 : 7000
    )
  } catch (e) {
    // 提示画不出来不该影响主流程
  }
}

function stopPicker() {
  if (!picker) return
  // 两个都要移除 —— tip 是"点击要剪藏的区域"那条提示，
  // 之前只移了高亮框，于是按 Esc 或选中之后那条提示一直挂在页面上。
  picker.box.remove()
  picker.tip.remove()
  document.removeEventListener('mousemove', picker.onMove, true)
  document.removeEventListener('click', picker.onClick, true)
  document.removeEventListener('keydown', picker.onKey, true)
  document.documentElement.style.cursor = ''
  picker = null
}

function startPicker() {
  if (picker) return
  var box = document.createElement('div')
  box.setAttribute(
    'style',
    'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #0e7490;' +
      'background:rgba(14,116,144,0.12);border-radius:2px;transition:none'
  )
  var tip = document.createElement('div')
  tip.setAttribute(
    'style',
    'position:fixed;z-index:2147483647;pointer-events:none;left:50%;top:12px;transform:translateX(-50%);' +
      'padding:6px 14px;border-radius:999px;background:#0e7490;color:#fff;font:13px system-ui,sans-serif;' +
      'box-shadow:0 2px 12px rgba(0,0,0,.25)'
  )
  tip.textContent = '点击要剪藏的区域，Esc 取消'
  document.body.appendChild(box)
  document.body.appendChild(tip)
  document.documentElement.style.cursor = 'crosshair'

  var onMove = function (e) {
    var el = e.target
    if (!el || el === box || el === tip || !el.getBoundingClientRect) return
    var r = el.getBoundingClientRect()
    box.style.left = r.left + 'px'
    box.style.top = r.top + 'px'
    box.style.width = r.width + 'px'
    box.style.height = r.height + 'px'
  }

  var onClick = function (e) {
    // 拦住这次点击：选择模式下不该触发页面自己的链接或按钮
    e.preventDefault()
    e.stopPropagation()
    var el = e.target
    stopPicker()
    if (!el || !el.innerHTML) {
      flash('这块没有可取的内容', false)
      return
    }
    var html = sanitize(el.innerHTML)
    // 区域剪藏不滚动（页面跳走用户就选不准了），但图片同样要绝对化 ——
    // 相对地址存进库里就是死链
    try {
      var tpl = document.createElement('div')
      tpl.innerHTML = html
      absolutizeImages(tpl)
      html = tpl.innerHTML
    } catch (e) {
      /* 处理失败就用原样 */
    }
    var text = (el.innerText || '').trim()
    if (!html || text.length < 10) {
      flash('这块内容太短（' + text.length + ' 字），换个区域试试', false)
      return
    }
    flash('正在保存…', true)
    // 带回调：结果直接回到这里显示，不依赖系统通知
    chrome.runtime.sendMessage(
      {
        kind: 'pickResult',
        result: {
          ok: true,
          url: location.href,
          title: (document.title || '').trim(),
          text: text,
          html: html,
          mode: 'selection',
        },
      },
      function (res) {
        if (chrome.runtime.lastError) {
          flash('扩展后台没响应：' + chrome.runtime.lastError.message, false)
          return
        }
        if (res && res.ok) flash(res.message || '已存入收件箱', true)
        else flash((res && res.message) || '剪藏失败', false)
      }
    )
  }

  var onKey = function (e) {
    if (e.key === 'Escape') {
      stopPicker()
      flash('已取消', false)
    }
  }

  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKey, true)
  picker = { box: box, tip: tip, onMove: onMove, onClick: onClick, onKey: onKey }
}

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (msg && msg.kind === 'extract') {
    // 异步响应：extractArticle 会先滚动加载（见 scrollToLoad），
    // 返回 true 保持消息通道打开，否则 sendResponse 时对方已经收到 undefined
    extractArticle().then(sendResponse, function (e) {
      sendResponse({ ok: false, message: '抓取失败：' + (e && e.message ? e.message : e) })
    })
    return true
  }
  if (msg && msg.kind === 'startPicker') {
    startPicker()
    sendResponse({ ok: true })
    return true
  }
  return false
})

/** 取密码框之前、位置最近的那个文本输入框 —— 登录表单几乎都是这个排布。 */
function findUsernameInput(form, passwordEl) {
  var root = form || document
  var candidates = root.querySelectorAll(
    'input[type="text"], input[type="email"], input[type="tel"], input:not([type])'
  )
  var best = null
  for (var i = 0; i < candidates.length; i++) {
    var el = candidates[i]
    if (!el.value) continue
    if (passwordEl) {
      var pos = el.compareDocumentPosition(passwordEl)
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) best = el
      else if (!best) best = el
    } else if (!best) {
      best = el
    }
  }
  return best
}

function report(form, passwordEl) {
  var usernameEl = findUsernameInput(form, passwordEl)
  var username = usernameEl ? usernameEl.value : ''
  var password = passwordEl.value
  if (!password) return

  var key = location.host + '|' + username + '|' + password
  var now = Date.now()
  if (SEEN[key] && now - SEEN[key] < DEDUPE_MS) return
  SEEN[key] = now

  chrome.runtime.sendMessage({
    kind: 'capture',
    url: location.href,
    title: document.title,
    username: username,
    password: password,
  })
}

document.addEventListener(
  'submit',
  function (e) {
    var form = e.target
    if (!form || form.tagName !== 'FORM') return
    var pw = findPasswordInput(form)
    if (pw) report(form, pw)
  },
  true
)

document.addEventListener(
  'click',
  function (e) {
    var el = e.target
    if (!el || !el.closest) return
    var btn = el.closest('button, input[type="submit"], [role="button"]')
    if (!btn) return
    // 只在"点了按钮之后密码框里有值"时报 —— 避免把普通导航点击也当登录
    var form = btn.closest('form')
    var pw = findPasswordInput(form || document)
    if (pw) report(form, pw)
  },
  true
)

document.addEventListener(
  'keydown',
  function (e) {
    if (e.key !== 'Enter') return
    var el = e.target
    if (!el || el.tagName !== 'INPUT') return
    var form = el.closest('form')
    var pw = findPasswordInput(form || document)
    if (pw) report(form, pw)
  },
  true
)
