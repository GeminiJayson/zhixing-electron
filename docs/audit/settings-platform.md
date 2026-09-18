# 设置/平台/窗口 差异清单
> 基准：Python zhixing/ ｜ 目标：electron/src/ ｜ 证据均为 file:line

| # | 差异 | Python 行为（证据） | Electron 现状（证据） | 影响 |
|---|---|---|---|---|
| 1 | theme_mode 不支持「跟随系统」 | 支持 system 并按 OS 明暗解析 `zhixing/core/constants.py:8`、`zhixing/model/application/settings.py:79`、`zhixing/controller/app_controller.py:978-981` | 仅 light/dark，非 'dark' 一律映射 light `electron/src/shared/settings.ts:61`、`electron/src/renderer/src/pages/SettingsPage.tsx:116-117` | Python 用户选「跟随系统」→ Electron 恒浅色，切换客户端外观不一致 |
| 2 | 主题包默认值不一致（且默认值非法） | 默认「青竹」`zhixing/model/application/settings.py:79`、`zhixing/controller/app_controller.py:982` | parse 默认 '默认'（不在 14 包内，回退「墨黑」）`electron/src/shared/settings.ts:62`、`electron/src/shared/theme-packs.ts:91,93-95` | 缺该键时两端铺不同主题包 |
| 3 | mica_enabled 完全缺失 | 设置项 + 改动即调材质 `zhixing/core/constants.py:11`、`zhixing/view/pages/settings_page.py:154-157`、`zhixing/controller/app_controller.py:1100-1104`、`zhixing/view/shell/main_window.py:327-332` | 全仓库未找到对应实现 | 设置项与 Mica 材质能力丢失 |
| 4 | signature 完全缺失 | 可编辑并显示在标题栏 `zhixing/core/constants.py:31`、`zhixing/view/pages/settings_page.py:180-186`、`zhixing/view/shell/main_window.py:37-40,344-346` | 未找到对应实现 `electron/src/renderer/src/components/TitleBar.tsx:11-52` | 设置项丢失，已设签名在 Electron 不可见 |
| 5 | control_height 解析但从不生效 | 默认 32、范围 24-48，驱动控件高度 `zhixing/core/constants.py:37-38`、`zhixing/view/pages/settings_page.py:166-171`、`zhixing/controller/app_controller.py:984,1079-1083` | 仅类型层，无消费点；默认 24、钳 20-48 `electron/src/shared/settings.ts:19,67` | 该设置整体失效，且默认值不符 |
| 6 | font_size 默认值与范围不一致 | 默认 14、范围 9-20、直接按像素应用 `zhixing/controller/app_controller.py:986`、`zhixing/view/pages/settings_page.py:173-178`、`zhixing/core/constants.py:35-36` | 默认 12、钳 8-32、滑杆 10-18、应用时再 +1.5px `electron/src/shared/settings.ts:64`、`electron/src/renderer/src/pages/SettingsPage.tsx:207-209`、`electron/src/renderer/src/theme.ts:61` | 同一设置值两端字号不同，9px 被抬到 10px |
| 7 | task_row_height 默认值与范围不一致 | 默认 38、范围 24-72 `zhixing/view/widget/desktop_widget.py:135`、`zhixing/view/pages/settings_page.py:199-203` | 默认 30、钳 22-80、滑杆 22-56、应用时 +10px `electron/src/shared/settings.ts:65`、`electron/src/renderer/src/pages/SettingsPage.tsx:218-219`、`electron/src/renderer/src/theme.ts:62` | 行高差 8px 且存在 +10 偏移 |
| 8 | pomodoro_auto_break 默认值相反 | 默认 False `zhixing/view/pages/settings_page.py:257-260` | 默认 true `electron/src/shared/settings.ts:71`、`electron/src/renderer/src/App.tsx:81` | 未落库时两端番茄钟行为相反 |
| 9 | capture_hotkey 默认值不一致 | ensure_defaults 写 'ctrl+shift+s' `zhixing/model/application/settings.py:81` | parse 默认 'shift+d' `electron/src/shared/settings.ts:80`（`electron/src/main/index.ts:161` 注册） | Electron 抢注单修饰键组合，与 Python 默认不同 |
| 10 | motion_level 取值集合不同 + 无 OS 减动效探测 | 仅 full/reduced，另探测系统减动效并冻结图谱物理 `zhixing/view/pages/settings_page.py:159-164`、`zhixing/controller/app_controller.py:1035-1063` | full/essential/none，仅 'none' 时置 dataset；无 OS 探测/图谱降级 `electron/src/shared/settings.ts:56,68`、`electron/src/renderer/src/theme.ts:63` | 交叉污染：'none'↔Python 关动效、'reduced'↔Electron 回退 full |
| 11 | 开机自启完全缺失 | `zhixing/model/infrastructure/autostart.py:42-114`、`zhixing/view/pages/settings_page.py:357-360`、`zhixing/controller/app_controller.py:1105-1107` | 未找到对应实现 | 设置项与能力丢失 |
| 12 | 剪贴板监听完全缺失 | `zhixing/core/constants.py:39`、`zhixing/controller/app_controller.py:1279-1297`、`zhixing/view/pages/settings_page.py:296-299` | 未找到对应实现 | 设置项与功能丢失 |
| 13 | 划词速记（select_quick_hotkey）完全缺失 | `zhixing/core/settings_keys.py:20`、`zhixing/controller/app_controller.py:334-337,231-233,388-408,410-419,852-870` | 未找到对应实现（无热键、无 select-quick 动作） | 设置项与功能丢失 |
| 14 | widget_hotkey 只解析不注册 | 4 个热键绑定之一 `zhixing/controller/app_controller.py:332-337` | 字段存在但未使用，仅注册 2 条 `electron/src/shared/settings.ts:30,78`、`electron/src/main/index.ts:156-172` | 浮窗显隐热键失效 |
| 15 | close_to_widget 缺失，关闭语义不同 | 默认 ignore+hide 到托盘并提示；关开关才退出 `zhixing/core/constants.py:24`、`zhixing/view/shell/main_window.py:308-324`、`zhixing/view/pages/settings_page.py:347-350` | 无 close 拦截，X 即 close，非 darwin 走 window-all-closed quit；主窗关后 showMain 空转 `electron/src/main/index.ts:328,337-339,129-134` | 关窗即失去托盘驻留，托盘「显示主窗口」变死项 |
| 16 | 浮窗启动可见性与主窗↔浮窗联动缺失 | 启动只显主窗并 hide 浮窗；主窗显隐联动浮窗 `zhixing/controller/app_controller.py:1382,896-907,179-188` | 启动即创建并显示浮窗；无 shown/hidden 联动 `electron/src/main/index.ts:292,98` | 启动两窗同显，且互不让位 |
| 17 | 浮窗贴边半隐/悬停滑出/双击展开/右键菜单/边缘缩放全缺 | `zhixing/view/widget/desktop_widget.py:466-514,445-448,450-464,387-437,321-330` | 仅无边框+置顶+可缩放+拖拽 `electron/src/main/index.ts:55-108` | 浮窗核心交互（F10-4/F10-5）缺失 |
| 18 | 浮窗任务行能力降级 | 可改优先级/标签/子任务/定位编辑/删除（含撤销链路）/hover 段落 `zhixing/view/widget/desktop_widget.py:210-262,171-180`、`zhixing/controller/app_controller.py:180-185` | 仅提示「请到主窗口」，删除无撤销、无 snippet `electron/src/renderer/src/WidgetApp.tsx:88-109` | 浮窗退化为只读勾选+改标题 |
| 19 | 浮窗几何持久化时机不同 | 拖拽/缩放释放、贴边时写一次 `zhixing/view/widget/desktop_widget.py:368-384,307-309` | moved/resized 事件每次写库 `electron/src/main/index.ts:90-97`、`electron/src/main/db/maintenance.ts:124-145` | 拖动过程高频提交（写入放大） |
| 20 | 热键改键与注册状态反馈缺失 | 改键流程 + hotkey_status（✓已注册/冲突降级）`zhixing/view/pages/settings_page.py:264-328`、`zhixing/controller/app_controller.py:295-329` | 无改键 UI、无状态，失败仅 console.warn `electron/src/renderer/src/pages/SettingsPage.tsx:289-291`、`electron/src/main/index.ts:166-170` | 无法改键，冲突无声失效 |
| 21 | 划词捕获不等价，且去向少两个 | 模拟复制读选区+剪贴板备份恢复、来源应用/URL、5 去向 `zhixing/model/infrastructure/selection.py:28-48,113-123`、`zhixing/controller/app_controller.py:375-408,432-467,469-513` | 只读剪贴板预填；无选区/来源/URL；去向仅 3 个 `electron/src/renderer/src/components/CapturePanel.tsx:19-39,124-133`、`electron/src/preload/index.ts:35-36` | 捕获到「上次复制」而非「当前选中」，溯源丢失 |
| 22 | 深链仅做页面级跳转 | 精确定位任务/笔记+block/具体闪念/文件夹 `zhixing/controller/app_controller.py:1445-1459`、`zhixing/core/deep_link.py:22-50` | 只切页面，link.block 未使用 `electron/src/renderer/src/App.tsx:157-168` | note?block= 与 flash/folder 深链粒度错误 |
| 23 | 托盘信息量缩减 | tooltip 显示今日待办 N，图标随主题重建 `zhixing/controller/app_controller.py:1149-1153,1118`、`zhixing/view/shell/main_window.py:281-284,334-335` | tooltip 固定，图标静态 `electron/src/main/index.ts:176-180` | 少一处待办提醒，图标不随主题 |
| 24 | 应用内快捷键大面积缺失 | Ctrl+K/N/Shift+N/B/E/Z/,/Tab/F/1..6 `zhixing/controller/app_controller.py:213-233`、`zhixing/view/shell/main_window.py:234-246` | 仅 Ctrl+K 与 Ctrl+Z `electron/src/renderer/src/App.tsx:219-246` | 切页/设置/新建/页内搜索均无快捷键 |
| 25 | 托盘/热键下发的动作集缺失 | 6 类动作 `_dispatch_action` `zhixing/controller/app_controller.py:275-293` | 仅 quick-capture/capture `electron/src/main/index.ts:147-150`、`electron/src/renderer/src/App.tsx:176-184` | 新增/闪念入口无法从主进程触发 |
| 26 | 命令面板能力缩减 | 命令 7 条 + 任务/笔记/闪念/标签命中与 MRU `zhixing/controller/app_controller.py:77-85,210,770-797` | 仅页面/笔记/新建任务 `electron/src/renderer/src/components/CommandPalette.tsx:33-79` | 命令式操作与跨类型检索缺失 |
| 27 | FloatingDock 缺失 | `zhixing/view/widget/floating_dock.py:32-186`、`zhixing/view/shell/main_window.py:76-89,158-211` | 未找到对应实现（全仓库无 dock） | 右下快捷新建入口整体缺失 |
| 28 | 日志能力缺失 | 文件日志 1MB×3 + 控制台 + 全局异常兜底 `zhixing/core/logging_util.py:44-97`、`zhixing/__main__.py:54-55` | 无日志文件/滚动/excepthook，仅 console 若干处 `electron/src/main/index.ts:169`、`electron/src/main/db/connection.ts:78,98`、`electron/src/main/db/maintenance.ts:143` | 线上问题无痕可查 |
| 29 | 启动欢迎页（splash）缺失 | splash 完成全部初始化后再显主窗 `zhixing/__main__.py:106-135`、`zhixing/view/shell/splash.py` | 直接建主窗 + ready-to-show `electron/src/main/index.ts:214-233` | 首屏可能先于数据刷新 |
| 30 | 主窗口最小尺寸不一致 | 1280x820，min 1024x700 `zhixing/view/shell/main_window.py:41-44` | 1280x820，minWidth 1040、minHeight 640 `electron/src/main/index.ts:215-218` | 可缩下限不同，窄屏布局表现不同 |
| 31 | ensure_defaults 未实现，默认值不落库 | 启动时把默认值写入 settings 表 `zhixing/core/context.py:69`、`zhixing/model/application/settings.py:77-95` | 无默认值写入逻辑，仅 parseSettings 内存回退 `electron/src/shared/settings.ts:59-83` | 两端各自回退到不同默认（见 #2/#6/#7/#8/#9） |

**该域整体完成度评估**：外观（主题包/强调色/明暗/字号/行高）可用，但设置域整体约六成——mica、签名、开机自启、剪贴板监听、划词速记、浮窗显隐热键、关闭到浮窗共 7 项在 Electron 无实现，另有 6 项默认值/取值范围不一致；平台与窗口行为（浮窗贴边交互、托盘信息、应用内快捷键、日志、splash）缺口最集中。

**风险最高的 3 条**

1. #15 关闭语义：无 close_to_widget，主窗关闭后 showMain 空转 —— 未开浮窗时 win/linux 直接退出，开了浮窗则托盘「显示主窗口」永久失效。
2. #13/#14/#20 热键链路：4 个全局热键只实现 2 个、capture 默认值不同、注册失败静默、无改键与状态 —— 划词速记与浮窗显隐热键整体不可用且无感知。
3. #2/#6/#7/#9/#31 默认值与不落库：两端共用同一 settings 表却回退不同默认（主题包、字号、行高、auto_break、capture_hotkey），切换客户端行为跳变难归因。
