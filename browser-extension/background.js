/**
 * 与「知行 ZhiXing」桌面应用的本地端点通信。
 *
 * 这里**只连 127.0.0.1** —— host_permissions 也限定在这个范围，
 * 这个扩展没有任何能力把数据发到网络上。
 *
 * 端口由应用那边固定（默认 47821，被占用会顺延），扩展扫描一段找它。
 * 找到之后要先有令牌才能写入；令牌由用户在应用的设置页复制、粘到本扩展的设置里。
 */

const PORT_START = 47821
const PORT_END = 47831
const DEDUPE_MS = 30000

let cachedPort = null

/** 依次探测端口，用 /vault/ping 确认对面确实是知行（而不是别的程序占了这个端口）。 */
async function findPort() {
  if (cachedPort !== null) return cachedPort
  for (let p = PORT_START; p <= PORT_END; p++) {
    try {
      const r = await fetch('http://127.0.0.1:' + p + '/vault/ping', {
        signal: AbortSignal.timeout(600),
      })
      if (!r.ok) continue
      const j = await r.json()
      if (j && j.app === 'zhixing') {
        cachedPort = p
        return p
      }
    } catch {
      // 端口没人听、或者对面不是知行：继续试下一个
    }
  }
  return null
}

async function getToken() {
  const stored = await chrome.storage.local.get('token')
  return stored.token || ''
}

function notify(title, message) {
  // 通知失败不该影响主流程（用户可能没给通知权限，也可能没有图标文件）
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon128.png',
      title: title,
      message: message,
    })
  } catch {
    chrome.action.setBadgeText({ text: '!' })
    chrome.action.setBadgeBackgroundColor({ color: '#0E7490' })
    setTimeout(function () {
      chrome.action.setBadgeText({ text: '' })
    }, 4000)
  }
  console.log('[知行]', title, message)
}

async function capture(payload) {
  const port = await findPort()
  if (port === null) {
    notify('知行未在运行', '请先启动知行 ZhiXing 桌面应用')
    return
  }
  const token = await getToken()
  if (!token) {
    notify('还没配置令牌', '在扩展的设置页填入知行应用里显示的令牌')
    return
  }
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/vault/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vault-token': token },
      body: JSON.stringify(payload),
    })
    const j = await r.json().catch(function () {
      return {}
    })
    if (r.status === 401) {
      notify('令牌不对', '请在扩展设置页重新粘贴知行应用里显示的令牌')
      return
    }
    if (r.status === 423) {
      // 锁定状态下应用**拒收**凭据，这是设计要求：不能绕过主密码
      notify('保险箱已锁定', '请先在知行应用里解锁保险箱，再提交一次')
      return
    }
    if (!r.ok || !j.ok) {
      notify('保存失败', j.error || 'HTTP ' + r.status)
      return
    }
    notify(j.action === 'updated' ? '已更新' : '已保存', j.title || payload.url || '')
  } catch (e) {
    notify('连不上知行', String(e && e.message ? e.message : e))
  }
}

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (msg && msg.kind === 'capture') {
    capture(msg).then(function () {
      sendResponse({ ok: true })
    })
    return true // 异步响应
  }
  if (msg && msg.kind === 'probe') {
    findPort().then(function (p) {
      sendResponse({ port: p })
    })
    return true
  }
  return false
})

// 设置页改过令牌之后，端口缓存要失效
chrome.storage.onChanged.addListener(function () {
  cachedPort = null
})
