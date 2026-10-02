/**
 * 与「知行 ZhiXing」桌面应用的本地端点通信。
 *
 * 只连 127.0.0.1 —— host_permissions 也限定在这个范围，
 * 这个扩展没有任何能力把数据发到网络上。
 *
 * **顶层的写法有约束**：MV3 的 service worker 一旦在顶层抛错就注册失败
 *（chrome://extensions 里显示 Service worker registration failed），
 * 而那个报错不会告诉你具体是哪一行。所以这里：
 *   · 顶层只放 addListener，别的一律进函数；
 *   · 每个顶层监听都用 try/catch 包住 —— 宁可少一个功能，也不要整个扩展装不上。
 */

const PORT_START = 47821
const PORT_END = 47831

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
  try {
    chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title: title, message: message })
  } catch {
    // 没有图标文件或没给通知权限时 Chrome 会拒绝，用角标兜底
    try {
      chrome.action.setBadgeText({ text: '!' })
      chrome.action.setBadgeBackgroundColor({ color: '#0E7490' })
      setTimeout(function () {
        chrome.action.setBadgeText({ text: '' })
      }, 4000)
    } catch {
      // 角标也不行就算了，界面里还有文字反馈
    }
  }
  console.log('[知行]', title, message)
}

/** 把提取结果发到本地端点。返回可显示的结果，同时弹一条通知。 */
async function postClip(article) {
  const port = await findPort()
  if (port === null) return { ok: false, message: '知行应用没在运行' }
  const token = await getToken()
  if (!token) return { ok: false, message: '还没配置令牌 —— 去设置里粘贴一次' }
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/clip', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vault-token': token },
      body: JSON.stringify(article),
    })
    const j = await r.json().catch(function () {
      return {}
    })
    if (r.status === 401) return { ok: false, message: '令牌不对，去设置里重新粘贴' }
    if (!j.ok) return { ok: false, message: j.error || 'HTTP ' + r.status }
    if (j.action === 'duplicated') return { ok: true, message: '这一页已经在收件箱里了' }
    return {
      ok: true,
      message: article.mode === 'fallback' ? '已存入收件箱（只取到整页文字，可能含导航广告）' : '已存入收件箱',
    }
  } catch (e) {
    return { ok: false, message: '连不上知行：' + String(e && e.message ? e.message : e) }
  }
}

/** popup 点「剪藏这一页」时走这里。 */
async function clipActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = tabs[0]
  if (!tab || tab.id === undefined) return { ok: false, message: '拿不到当前标签页' }
  if (/^(chrome|edge|about|devtools):/i.test(tab.url || '')) {
    return { ok: false, message: '浏览器内部页面不允许扩展读取' }
  }
  let article
  try {
    article = await chrome.tabs.sendMessage(tab.id, { kind: 'extract' })
  } catch {
    // content script 没注入：最常见的是扩展刚重载、页面还没刷新
    return { ok: false, message: '这一页的脚本还没就绪 —— 刷新一下页面再试' }
  }
  if (!article || !article.ok || !article.text) {
    return { ok: false, message: '没提取到正文，这一页可能是纯应用界面' }
  }
  const r = await postClip(article)
  notify(r.ok ? '已剪藏' : '剪藏失败', r.message || '')
  return r
}

/** 表单捕获：登录时把账号密码发过去。 */
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

/** 逐步自检，把链路拆成可观察的几步。 */
async function diagnose() {
  const steps = []
  const { token } = await chrome.storage.local.get('token')
  steps.push({ name: '令牌已配置', ok: !!token, detail: token ? token.slice(0, 8) + '…' : '还没填，请在下面粘贴' })

  cachedPort = null
  const port = await findPort()
  steps.push({
    name: '找到知行应用',
    ok: port !== null,
    detail: port !== null ? '127.0.0.1:' + port : '扫描 47821–47830 都没回应，应用没在运行？',
  })

  if (port !== null && token) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/vault/ping', { signal: AbortSignal.timeout(1500) })
      const j = await r.json()
      steps.push({ name: '端点应答', ok: !!j.ok, detail: 'vault=' + j.vault })
    } catch (e) {
      steps.push({ name: '端点应答', ok: false, detail: String(e && e.message ? e.message : e) })
    }
    try {
      // 用一个必然被拒的空正文请求：400 = 令牌对，401 = 令牌不对
      const r = await fetch('http://127.0.0.1:' + port + '/clip', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vault-token': token },
        body: JSON.stringify({ text: '' }),
      })
      const ok = r.status === 400
      steps.push({
        name: '令牌有效',
        ok: ok,
        detail: ok ? '通过' : r.status === 401 ? '令牌不对，重新从应用里复制' : 'HTTP ' + r.status,
      })
    } catch (e) {
      steps.push({ name: '令牌有效', ok: false, detail: String(e && e.message ? e.message : e) })
    }
  }
  return steps
}

// ---------------------------------------------------------------- 顶层监听
// 只有这三段在顶层。每一段都包 try/catch：
// 某个 API 在这个 Chrome 版本上不可用时，失去那一项功能，而不是整个 worker 注册失败。

try {
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg && msg.kind === 'capture') {
      capture(msg).then(function () {
        sendResponse({ ok: true })
      })
      return true
    }
    if (msg && msg.kind === 'clipActive') {
      clipActiveTab().then(sendResponse)
      return true
    }
    if (msg && msg.kind === 'diagnose') {
      diagnose().then(function (steps) {
        sendResponse({ steps: steps })
      })
      return true
    }
    if (msg && msg.kind === 'probe') {
      findPort().then(function (p) {
        sendResponse({ port: p })
      })
      return true
    }
    return false
  })
} catch (e) {
  console.error('[知行] 注册消息监听失败', e)
}

try {
  chrome.storage.onChanged.addListener(function () {
    cachedPort = null
  })
} catch (e) {
  console.error('[知行] 注册存储监听失败', e)
}
