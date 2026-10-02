/**
 * 点扩展图标弹出的面板。
 *
 * **为什么用 popup 而不是 action.onClicked**：onClicked 依赖 service worker 醒着 ——
 * 而 MV3 的 service worker 会被回收，冷启动时第一次点击可能什么都没发生。
 * 用户看到的现象就是"点了没反应"，而且没有任何日志可查。
 * popup 由浏览器直接渲染，点了必定有东西出现，这是可诊断性上的巨大差别。
 */

const msg = document.getElementById('msg')

function say(text, kind) {
  msg.textContent = text
  msg.className = kind || ''
}

document.getElementById('opts').addEventListener('click', function () {
  chrome.runtime.openOptionsPage()
})

document.getElementById('clip').addEventListener('click', function () {
  const btn = document.getElementById('clip')
  btn.disabled = true
  say('正在提取正文…')
  chrome.runtime.sendMessage({ kind: 'clipActive' }, function (res) {
    btn.disabled = false
    if (!res) {
      say('后台没有响应。去「设置 → 运行诊断」看看卡在哪一步。', 'bad')
      return
    }
    if (res.ok) {
      say(res.message || '已剪藏到收件箱', 'ok')
    } else {
      say(res.message || '剪藏失败', 'bad')
    }
  })
})

// 打开面板时先看一眼配置状态，缺令牌就别让用户白点
chrome.storage.local.get('token', function (s) {
  if (!s.token) {
    say('还没配置令牌 —— 点下面的「设置」粘贴一次。', 'bad')
  } else {
    say('准备好了。')
  }
})
