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
function extractArticle() {
  try {
    // 传克隆节点：Readability 会改动 DOM，不能让它动到用户正在看的页面
    var reader = new Readability(document.cloneNode(true))
    var a = reader.parse()
    var text = a && a.textContent ? a.textContent.trim() : ''
    if (text.length > 200) {
      return {
        ok: true,
        url: location.href,
        title: (a.title || document.title || '').trim(),
        text: text,
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

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (msg && msg.kind === 'extract') {
    sendResponse(extractArticle())
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
