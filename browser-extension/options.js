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

load()
