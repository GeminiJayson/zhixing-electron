function $(id) {
  return document.getElementById(id)
}

function show(text, kind) {
  var el = $('status')
  el.textContent = text
  el.className = 'status' + (kind ? ' ' + kind : '')
  el.hidden = false
}

async function load() {
  var stored = await chrome.storage.local.get('token')
  var token = stored.token || ''
  $('token').value = token
  if (token) show('已配置令牌。点「测试连接」确认应用在运行。')
}

$('save').addEventListener('click', async function () {
  var token = $('token').value.trim()
  if (!/^[0-9a-f]{16,}$/i.test(token)) {
    show('令牌看起来不对 —— 它应该是一串十六进制字符。', 'bad')
    return
  }
  await chrome.storage.local.set({ token: token })
  show('已保存。', 'ok')
})

$('test').addEventListener('click', function () {
  show('正在探测…')
  chrome.runtime.sendMessage({ kind: 'probe' }, function (res) {
    if (res && res.port) {
      show('连上了：应用在 127.0.0.1:' + res.port + ' 上运行。', 'ok')
    } else {
      show('没找到知行应用。请确认桌面应用正在运行（端口 47821–47830）。', 'bad')
    }
  })
})

/**
 * 逐步自检。扩展出问题时最难的是"看不到它走到哪一步"——
 * 通知不弹、请求不发，用户只能看到"没反应"。这里把每一步的结果摆出来。
 */
$('diagnose').addEventListener('click', function () {
  show('正在自检…')
  chrome.runtime.sendMessage({ kind: 'diagnose' }, function (res) {
    var box = $('diag')
    box.innerHTML = ''
    if (!res || !res.steps) {
      show('诊断没有返回结果，去 chrome://extensions 里重新加载一次扩展再试。', 'bad')
      return
    }
    var allOk = true
    res.steps.forEach(function (s) {
      if (!s.ok) allOk = false
      var row = document.createElement('div')
      row.className = 'diagrow ' + (s.ok ? 'ok' : 'bad')
      var n = document.createElement('strong')
      n.textContent = (s.ok ? '✓ ' : '✗ ') + s.name
      var d = document.createElement('span')
      d.textContent = s.detail
      row.appendChild(n)
      row.appendChild(d)
      box.appendChild(row)
    })
    show(
      allOk
        ? '全部通过。若点图标仍没反应：先在 chrome://extensions 重新加载扩展（manifest 改过就必须重载），再确认当前页不是 chrome:// 开头的内部页面。'
        : '有步骤没通过，按上面标红的那一条处理。',
      allOk ? 'ok' : 'bad'
    )
  })
})

load()
