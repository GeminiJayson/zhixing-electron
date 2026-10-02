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

/**
 * 选择区域剪藏。
 *
 * 和「剪藏这一页」的分工：那个交给 Readability 猜正文在哪，猜不准时会带上
 * 导航与侧栏；这个让你直接指一块 —— "我只想要那个表格"这种需求，
 * 全文提取无论多聪明都做不到。
 *
 * **面板关掉之后选择模式还在**：选择器跑在页面里（content script），
 * 不依赖 popup 存活。所以这里的提示要告诉用户"去页面上点"。
 */
document.getElementById('pick').addEventListener('click', function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs[0]
    if (!tab || tab.id === undefined) return
    if (/^(chrome|edge|about|devtools):/i.test(tab.url || '')) {
      say('浏览器内部页面不允许扩展读取', 'bad')
      return
    }
    chrome.tabs.sendMessage(tab.id, { kind: 'startPicker' }, function () {
      if (chrome.runtime.lastError) {
        say('这一页的脚本还没就绪 —— 刷新一下页面再试', 'bad')
        return
      }
      window.close()
    })
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
