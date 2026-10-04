import { BrowserWindow, ipcMain, nativeTheme, screen } from 'electron'
import { join } from 'node:path'
import { hardenWindow } from './security'
import { parseDeepLink } from '../shared/deep-link'

/** 主窗与欢迎页的状态。放在 index.ts 里（别处大量读），这里只借用引用。 */
export interface WindowState {
  main: BrowserWindow | null
  splash: BrowserWindow | null
  ready: boolean
  pendingDeepLink: string | null
}

export interface WindowDeps {
  state: WindowState
  currentSettings: () => { accent_color?: string | null; close_to_widget?: boolean; widget_enabled?: boolean }
  isDev: boolean
  /** 浮窗模块：主窗显示后要联动它的显隐 */
  widget: {
    syncWidgetVisibility: () => void
    setManualOpen: (v: boolean) => void
  }
  /** 是否正在真正退出（关闭拦截要用） */
  isQuitting: () => boolean
  /** 托盘模块（主窗关闭时刷新 tooltip） */
  tray: { updateTrayTooltip: () => void; appIconPath: (kind: 'app' | 'tray') => string }
}

/**
 * 主窗口与启动欢迎页。
 *
 * 从 main/index.ts 抽出来（约 250 行）。与前三组不同的是：**状态不搬进来** ——
 * winState 留在 index.ts，因为主进程别处大量读它（bubbleAvailable 判断提醒走气泡
 * 还是卡片、tray 的 getMainWindow、sendRemindersTo 往主窗推，共 34 处引用）。
 * 搬进来会让那 34 处都得反过来依赖本模块。
 */
export function createWindowModule(deps: WindowDeps) {
  const { state, currentSettings, isDev, isQuitting, tray } = deps

  /**
   * 材质 + 实际下发的取值。数据变更钩子每次写库都会跑，带着窗口引用去重：
   * 既省掉无谓的重复调用，又能保证窗口重建后一定重新下发一次。
   */

  /**
   * 启动欢迎页：
   * 无边框、居中、置顶，直到渲染层报告「首屏数据已就绪」才关闭并显示主窗，
   * 避免主窗先露出半成品界面。HTML 内联为 data: URL —— 启动页只有几十行，
   * 不值得为它单独增加一个渲染产物入口。
   */
  function createSplash(): void {
    const dark = nativeTheme.shouldUseDarkColors
    const s = currentSettings()
    const bg = dark ? '#1F1F1F' : '#F3F3F3'
    const fg = dark ? '#F2F2F2' : '#1A1A1A'
    const accent = s.accent_color || '#0D9488'
    state.splash = new BrowserWindow({
      width: 400,
      height: 300,
      frame: false,
      resizable: false,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;font-family:"PingFang SC","Microsoft YaHei UI",system-ui,sans-serif}
  .s{box-sizing:border-box;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:28px;background:${bg};color:${fg};border-radius:14px;border:1px solid rgba(128,128,128,.20)}
  .n{font-size:24px;font-weight:600}
  .sub{font-size:13px;opacity:.6}
  .bar{width:70%;height:4px;border-radius:2px;background:rgba(128,128,128,.18);overflow:hidden;margin-top:12px}
  .bar>i{display:block;height:100%;width:40%;border-radius:2px;background:${accent};animation:p 1.1s ease-in-out infinite}
  .st{font-size:12px;opacity:.6}
  @keyframes p{0%{margin-left:-40%}100%{margin-left:100%}}
  </style></head><body><div class="s">
  <svg width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="${accent}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="18" cy="17" r="6.2"/><circle cx="46" cy="17" r="6.2"/><circle cx="32" cy="44" r="6.2"/>
  <path d="M23.6 18.6 40.4 18.6"/><path d="M18.4 23.2 27.4 38.4"/><path d="M45.6 23.2 36.6 38.4"/>
  <path d="M27.2 44.2l3.4 3.4 6.4-6.4"/></svg>
  <div class="n">知行 ZhiXing</div><div class="sub">本地优先的个人待办与知识图谱</div>
  <div class="bar"><i></i></div><div class="st">正在启动…</div>
  </div></body></html>`
    void state.splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    state.splash.on('ready-to-show', () => state.splash?.show())
    state.splash.on('closed', () => {
      state.splash = null
    })
  }


  /** 关闭欢迎页并显示主窗。 */
  function revealMain(): void {
    if (state.ready) return
    state.ready = true
    if (state.splash && !state.splash.isDestroyed()) state.splash.close()
    state.splash = null
    if (state.main && !state.main.isDestroyed()) {
      state.main.show()
      state.main.focus()
    }
    deps.widget.syncWidgetVisibility()
  }


  function createWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      // 尺寸 1280x820，最小尺寸 1024x700
      minWidth: 1024,
      minHeight: 700,
      show: false,
      frame: false,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 },
      /**
       * **窗口透明**，这样页面里的半透明才能透到桌面。
       *
       * 原先这里是实色底（#1F1F1F / #F3F3F3），理由是"CDP 与系统截图都不含原生材质，
       * 实色才能保证看到的即真实"。那条在"不需要透视"时是对的，但它同时锁死了一件事：
       * 页面里所有半透明最终都叠在这个实色上 —— 玻璃拟态只能透出同窗口内的画布色，
       * 永远到不了桌面。
       *
       * **窗口真透明**（不用 backgroundMaterial）。
       *
       * 截图对比之后确认的事实：backgroundMaterial 由 DWM 绘制，会**铺满整个窗口矩形**，
       * 而 frame:false 的无边框窗口在 Windows 上拿不到 DWM 圆角 —— 于是四个角露出材质本身
       * （亮色下浅灰、暗色下黑），看着就是用户说的"矩形边框"。页面里 .app 的圆角盖不住它，
       * 因为材质在页面**下面**。
       *
       * 两者不可兼得：
       *   · backgroundMaterial → 桌面被模糊，但窗口是直角；
       *   · transparent        → 窗口能圆角、能透桌面，但桌面不被模糊。
       * 选了后者（圆角与"没有边框"是更硬的诉求），并用 thickFrame:false 去掉
       * WS_THICKFRAME 那圈描边 —— 项目里其余六个浮窗都是这个组合。
       */
      transparent: true,
      backgroundColor: '#00000000',
      /**
       * 去掉 WS_THICKFRAME —— 透明窗口在 Windows 上会因此多出一圈矩形描边
       * （亮色下是浅灰、暗色下是黑），圆角外那圈方角就是它。
       * 捕获窗 / 条件窗 / 快速笔记窗都设了这条，主窗口原先漏了。
       */
      thickFrame: false,
      /**
       * 去掉 DWM 的系统投影。透明窗口上它会沿窗口矩形边缘留下一圈描边
       * （亮色主题下浅灰、暗色下偏黑）—— 页面里的圆角盖不住它，因为它画在页面**外面**。
       * 截图对比确认：初始亮色与"亮→暗→亮"之后都有这圈边，说明它不是切换造成的。
       */
      hasShadow: false,
      // 窗口图标 = 任务栏图标：跟随当前强调色（换色时由 tray.refreshTrayIcon 调 setIcon）
      icon: tray.appIconPath('app'),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    // 关闭到托盘：拦截关闭改为隐藏，浮窗仍在运行。
    // 托盘「退出」走 app.quit → before-quit 已置 isQuitting()，这里放行。
    win.on('close', (e) => {
      if (isQuitting()) return
      if (currentSettings().close_to_widget) {
        e.preventDefault()
        win.hide()
      }
    })
    // 主窗显隐 → 浮窗显隐联动。主窗显示时收起浮窗，隐藏/最小化时放出浮窗。
    const onMainVisibility = (): void => {
      deps.widget.setManualOpen(false)
      deps.widget.syncWidgetVisibility()
    }
    /**
     * **最大化后把窗口收进工作区**。
     *
     * 无边框 + 透明的窗口在 Windows 上最大化时会盖住任务栏：Chromium 按"整个屏幕"
     * 算最大化区域，而普通窗口由 DWM 帮忙让出工作区，透明窗口没有这一步。
     * 所以最大化后手动 setBounds 到显示器的工作区。
     */
    /**
     * **重新确认窗口透明**。
     *
     * Windows 上的透明窗口有一个反复出现的毛病：只要合成器被重建，逐像素透明就丢了 ——
     * 触发时机包括 resize、最大化 / 还原，**以及页面自己切换主题**（Chromium 会重建
     * 合成层）。丢了之后：
     *   · 窗口变成不透明矩形 → 圆角外露出底色，看着就是"多了个矩形边框"；
     *   · 页面里那些半透明叠在一个不透明底上 → 层次全没了，看着就是"玻璃失效"。
     *
     * 实测证据：反复切换亮暗主题四次之后，页面里所有 CSS 值都还是对的
     *（--glass-alpha 80%、主区 alpha 0.736 与初始完全一致），但画面已经不对 ——
     * 所以问题一定在窗口层，不在样式层。
     *
     * 修法是重新设一次背景色，并抖一下 opacity 逼合成器重建。
     */
    const reassertTransparency = (): void => {
      if (process.platform !== 'win32' || win.isDestroyed()) return
      win.setBackgroundColor('#00000000')
      win.setOpacity(0.99)
      setTimeout(() => {
        if (!win.isDestroyed()) win.setOpacity(1)
      }, 30)
    }
    /** 渲染层切完主题会通知一次（合成器在那时被重建） */
    ipcMain.handle('window:reassertTransparency', () => {
      reassertTransparency()
      return true
    })
    win.on('resize', reassertTransparency)
    win.on('maximize', () => {
      if (win.isDestroyed()) return
      const { workArea } = screen.getDisplayMatching(win.getBounds())
      win.setBounds(workArea)
      // setBounds 之后表面会重建，等它处理完再补一次
      setTimeout(reassertTransparency, 60)
    })
    win.on('unmaximize', () => setTimeout(reassertTransparency, 60))
    win.on('show', onMainVisibility)
    win.on('hide', onMainVisibility)
    win.on('minimize', onMainVisibility)
    win.on('restore', onMainVisibility)
    state.main = win
    win.on('closed', () => {
      if (state.main === win) state.main = null
      if (!isQuitting()) deps.widget.syncWidgetVisibility()
    })

    // 双保险：捏合缩放禁用，且启动时把 zoom 归位（清掉 profile 里的历史缩放）
    void win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined)
    win.webContents.setZoomLevel(0)
    win.webContents.on('did-finish-load', () => {
      win.webContents.setZoomLevel(0)
      // 冷启动深链在这里补发（那时窗口还不存在）
      if (state.pendingDeepLink) {
        const url = state.pendingDeepLink
        state.pendingDeepLink = null
        win.webContents.send('app:deeplink', parseDeepLink(url))
      }
    })

    // 导航、弹窗、webview 三道出口统一收口（见 main/security.ts）
    hardenWindow(win)

    if (isDev) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL as string)
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'))
    }

    return win
  }

  return { createSplash, revealMain, createWindow }
}
