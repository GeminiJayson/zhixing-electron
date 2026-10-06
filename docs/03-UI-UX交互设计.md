# 03 · UI/UX 交互设计（Electron 实现）

> **文档对象**：知行 ZhiXing 的 Electron 重构实现（拆分后仓库 `zhixing-electron`）。
> **路径约定**：代码路径相对 **Electron 项目根**（当前工作区内为 `electron/`）。
> **事实基准**：`src/renderer/src/styles/`（16 个 CSS）、`src/renderer/src/**` 组件与页面、`src/shared/{color,theme-packs,settings}.ts`。

---

## 1. 设计原则与真源

1. **唯一真源**：`src/renderer/src/styles/tokens.css` 是设计的**唯一真源**（`tokens.css`）。组件样式一律引用语义变量，**禁止写死色值与圆角**。
2. **无 UI 框架**：不引组件库，全部自绘 CSS；好处是体积、可控性，代价是每个控件的状态要自己写全。
3. **语义优先**：变量名表达用途（`--fg-secondary`、`--bg-layer`、`--z-modal`），不表达具体颜色值。
4. **交互状态统一收口**：按压/禁用/焦点环在 `global.css` 一处定义（`global.css`），组件不必各写一遍。
5. **动效可降级**：所有时长走令牌，系统或用户关闭动效时全量归零（`tokens.css`）。

---

## 2. 设计令牌体系（`src/renderer/src/styles/tokens.css`，173 行）

### 2.1 色彩：语义色浅/深两套

| 令牌 | 浅色（`:root`，） | 深色（`:root[data-theme='dark']`，） | 用途 |
| --- | --- | --- | --- |
| `--bg-canvas` | `#f3f3f3` | `#1f1f1f` | 窗口底（实色，保证「看到的即真实」） |
| `--bg-layer` | `rgb(255 255 255 / 90%)` | `rgb(43 43 43 / 85%)` | 卡片/浮层底 |
| `--bg-layer-solid` | `#ffffff` | `#2b2b2b` | 不透明浮层（菜单、对话框） |
| `--bg-hover` / `--bg-pressed` | `#f5f5f5` / `#ebebeb` | `#383838` / `#454545` | 悬停/按压 |
| `--fg-primary` | `#1a1a1a` | `#f2f2f2` | 正文 |
| `--fg-secondary` | `#6b6b6b` | `#a0a0a0` | 次要文字（`u-aux` 用） |
| `--fg-tertiary` | `#9a9a9a` | `#7a7a7a` | 辅助/占位 |
| `--fg-on-accent` | `#ffffff` | 继承 | 强调底上的文字 |
| `--accent` | `#0d9488`（默认青） | 同 | 品牌色原值：填充/边框/`accent-color` |
| `--accent-soft` / `--accent-solid` | `color-mix` 派生 | 同 | 选中底 / 强调按钮底 |
| `--accent-text` | `#0a6f66` | 运行时校正 | **强调色当文字用**的达标变体（见 §2.3） |
| `--accent-warm` | `#ea580c` | `#fb923c` | 暖色语义（闪念） |
| `--danger` / `--success` | `#dc2626` / `#16a34a` | `#f87171` / `#4ade80` | 危险/成功 |
| `--border` / `--border-strong` | `rgb(0 0 0 / 9%)` / `18%` | `rgb(255 255 255 / 10%)` / `22%` | 描边两级 |
| `--focus-ring` | `var(--accent)` | 同 | 焦点环跟随主题包强调色 |
| `--graph-edge` | `color-mix(fg 26%)` | `#444444` | 图谱连线「隐没在背景里」 |
| `--overlay` | `rgb(0 0 0 / 32%)` | `rgb(0 0 0 / 55%)` | 模态遮罩 |

`color-scheme` 也随主题声明（`tokens.css`、）：不声明时「Windows 深色系统 + 应用浅色主题」会让输入框变深底深字。

### 2.2 14 套主题包与强调色正交

主题包是**数据驱动的 token 覆盖集**（`src/shared/theme-packs.ts`），每个包含 light/dark 两套共 15 个语义色（`ThemeColors`，）。

包名（14，`theme-packs.ts`）：冰川蓝、墨黑、奶咖棕、暖沙、暮色、柠檬黄、樱花粉、海盐蓝、莓果粉、薄荷绿、薰衣草紫、蜜桃橘、青竹、香芋紫。

- **强调色与主题包正交**（`theme.ts`）：换包不动用户选的强调色；设置页提供 8 色（`SettingsPage.tsx`）。
- 默认主题包是**青竹**（`src/shared/settings.ts`、）；`theme-packs.ts` 的 `DEFAULT_THEME_PACK = '墨黑'` 只在包名**无法解析**时兜底（`resolveThemePack`，），两者不冲突。
- 主题包 token → CSS 变量的映射集中在 `TOKEN_VARS`（`theme.ts`），新增主题包只需加数据、不必改代码。
- **玻璃拟态**（2026-09-27，实验档）是独立于主题包的开关（设置项 `glass_enabled`，默认开）：
  它只决定"底色怎么画"（半透明 + 背景模糊），不改任何语义色，因此与 14 套包、8 色强调色、明暗全部正交。
  关掉即 `html[data-glass='off']` → `--glass-filter: none`（见 §2.10 与 §11.2）。

### 2.3 对比度运行时校正（WCAG 2.1）

问题：主题包的文字色是按观感调的柔和色，对 `canvas`/`layer` 的对比度大量落在 2.4–4.5 之间（实测 168 组里 74 组不达标，辅助文字最低 2.36:1）。

做法（`theme.ts`）：应用主题时按统一下限做**运行时校正**，而不是手改 168 个色值。

| 目标 | 下限 | 证据 |
| --- | ---: | --- |
| 正文 `--fg-primary` | 4.5:1 | `theme.ts` |
| 次要 `--fg-secondary` | 4.5:1 | `theme.ts` |
| 辅助 `--fg-tertiary` | 4.0:1 | `theme.ts` |
| 强调色**当文字**（`--accent-text`） | 4.5:1（对 canvas/layer/accent-soft 三者最差者） | `theme.ts` |
| 非文本图形（边框/指示条/图标） | 3:1（约定，见 `tokens.css` 注释） | `tokens.css` |

校正算法在 `src/shared/color.ts`：`ensureTextContrast(fg, backgrounds, minRatio)` 取背景中**最差**的一组作为约束，若已达标原样返回；否则沿单一方向混向黑/白（步长 0.05）直到达标，**保留色相**。

### 2.4 形状（圆角/边框/焦点）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--radius-sm` | 4px | 小控件 / 菜单 |
| `--radius-ctl` | 6px | 按钮与全局统一控件 |
| `--radius-md` | 8px | 内容内嵌 / 输入 |
| `--radius-lg` | 12px | 卡片 / 浮层 |
| `--radius-xl` | 16px | 大弹窗 / 捕获卡 |
| `--radius-pill` | 999px | 胶囊 / 滚动条 |
| `--border-w` / `--focus-w` | 1px / 2px | 描边 / 焦点环 |



### 2.5 间距：4px 节奏

`--space-1: 4px` / `2: 8px` / `3: 12px` / `4: 16px` / `5: 24px` / `6: 32px`（`tokens.css`）。

第 6 档是 2026-09-27 补的：代码里早有 `var(--space-6)`（图片预览浮层）与手写的 `64px`（空态）在表达"整块留白"，
而令牌当时只到 5 档 —— 前者因为 `var()` 没有 fallback，整条 `padding` 一直在静默失效。
**常规布局仍然只用 1–5 档**；第 6 档只给「整块留白」（图片预览、空态）用。

### 2.6 字体与字号（5 档）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--font-ui` | PingFang SC → Microsoft YaHei UI → HarmonyOS Sans → Noto Sans CJK SC → system-ui | 界面字体栈（中文优先） |
| `--font-mono` | JetBrains Mono → SF Mono → Consolas | 等宽（代码、时间戳） |
| `--text-aux` | 12px | 辅助 |
| `--text-body` | 13.5px | 正文（**默认值**，可被设置覆盖） |
| `--text-lead` | 15px | 引导 |
| `--text-title` | 18px | 页面标题 |
| `--text-hero` | 22px | 概览大数字 |

### 2.7 尺寸令牌

| 令牌 | 值 | 管辖范围 |
| --- | ---: | --- |
| `--control-h` | 32px | **独立控件**：输入框 / 下拉 / 日期 / 按钮 / 菜单项 —— 设置页「控件高度」(24–48) |
| `--control-h-sm` | `calc(--control-h - 8px)` | 紧凑档：工具条内的下拉（`.field--mini`） |
| `--row-h` | 40px | **列表行**：任务行 / 笔记树行 / 四象限行 / 设置行 —— 设置页「行高」(24–72) |
| `--titlebar-h` / `--nav-w` / `--nav-w-collapsed` | 44 / 220 / 48px | 标题栏与侧栏固定尺寸 |

运行时覆盖只发生在**两处**映射（`theme.ts`）：`--control-h` ← `control_height`、`--row-h` ← `task_row_height`；`--control-h-sm` 是 calc 派生，跟着控件高度一起缩放。**此前的 `font_size + 1.5` / `task_row_height + 10` 补偿偏移已取消**（会与设置页 SpinBox 的真实值对不上）；`--hit-min` 已删除，其职责由 `--control-h` 接管（无障碍最小目标的 24px 下限由设置区间保证）。

**边界**（`npm run check:ctlheight` 会拦下违规）：

1. **输入类控件与按钮的高度只能来自 `--control-h` 家族**——写死 px 的那一刻就与设置页分叉了。`global.css` 对 `input`/`select`/`textarea` 有全局兜底，新页面不会又冒出一个写死高度（勾选 / 单选 / 色板 / 滑块排除在外）。
2. **刻意不跟设置的三个尺度**：行内元素（任务行的勾选框 18 / 胶囊 20 / 行内动作按钮 20 / 行内重命名框 26）、色板圆点（WCAG 24×24 固定）、浮动主操作 FAB（38px，独立尺度）——行内元素硬跟会把 24px 的行撑破、让 72px 的行显得空。
3. **列表行用 `min-height` 而非 `height`**：控件调大时行被内容撑高，不会溢出。

### 2.8 层级：z 五档（唯一的层叠尺度）

| 令牌 | 值 | 用途 |
| --- | ---: | --- |
| `--z-float` | 20 | 页面级浮条（番茄钟、信息条） |
| `--z-menu` | 40 | 弹出菜单 / 下拉 / 气泡 |
| `--z-modal` | 60 | 全屏遮罩 + 对话框 |
| `--z-reminder` | 80 | 系统级提醒弹窗 |
| `--z-toast` | 90 | 全局提示 |

（`tokens.css`；注释记录了修复前的真实事故：「页面级浮条 68/70 反而压在全屏模态 60 之上」，即模态打开时浮条会亮在遮罩上面。）

### 2.9 动效：7 档时长 + 5 条缓动

| 时长 | 值 | 用途 |
| --- | ---: | --- |
| `--dur-instant` | 100ms | 即时反馈 |
| `--dur-fast` | 150ms | 悬停/淡化 |
| `--dur-strike` | 200ms | 完成划线 |
| `--dur-page` | 200ms | 页面标题 |
| `--dur-normal` | 250ms | 常规过渡 |
| `--dur-panel` | 280ms | 面板展开 |
| `--dur-slow` | 400ms | 大范围 |
| `--dur-stagger` | 20ms | 列表交错入场：相邻两行之间的启动间隔 |
| `--dur-tick` | 1s | 数据节拍：番茄钟进度条与「每秒刷新的数据」同步推进。**不参与 `data-motion` 归零**（归零会让它每秒瞬跳），所以它不是 UI 过渡档 |

| 缓动 | 值 | 语义 |
| --- | --- | --- |
| `--ease-enter` | `cubic-bezier(0.16, 1, 0.3, 1)` | OutCubic 近似：进入 |
| `--ease-exit` | `cubic-bezier(0.55, 0, 1, 0.45)` | InCubic 近似：退出 |
| `--ease-panel` | `cubic-bezier(0.19, 1, 0.22, 1)` | OutExpo：面板 |
| `--ease-page` | `cubic-bezier(0.45, 0, 0.55, 1)` | InOutQuad |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 弹性：勾选、落位（回弹幅度 ≤ 6%） |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | Standard：双向通用（进度推进、宽度、状态色） |

> **2026-09-27 的收口**：这 7 档时长此前有 3 档是**零引用**（`--dur-slow` / `--dur-strike` / `--dur-panel`），
> 5 条缓动里有 2 条零引用（`--ease-exit` / `--ease-panel`），而 `--ease-standard` **从未被定义过** ——
> `tasks.css` 与 `workflow.css` 引用它，`var()` 没有 fallback，于是那两条 `transition` 在计算值阶段
> 整条失效（任务行时间进度条一直是瞬跳）。现在所有令牌都有消费点，并有一条测试守着
> （见 §11 的「令牌完整性」）。

### 2.10 阴影四档与遮罩

| 令牌 | 浅色 | 深色 |
| --- | --- | --- |
| `--shadow-sm` | `0 1px 3px rgb(0 0 0 / 12%)` | `28%` |
| `--shadow-md` | `0 8px 24px rgb(0 0 0 / 20%)` | `44%` |
| `--shadow-lg` | `0 12px 32px rgb(0 0 0 / 24%)` | `50%` |
| `--shadow-xl` | `0 24px 64px rgb(0 0 0 / 28%)` | `56%` |

深色模式必须加深（同样的黑色透明度在深底上几乎不可见，`tokens.css`）。遮罩见 §2.1 的 `--overlay`。

**内高光 `--edge-light`**（2026-09-27 新增）：贴在容器顶边的 1px 亮线，让"面"从画布上浮起来。
浅色 `inset 0 1px 0 rgb(255 255 255 / 55%)`，深色必须降到 `5%`（同样的 55% 在深底上是一条刺眼的白边）。
落在标题栏、内容面板、概览卡、模态、命令面板、信息条上。它与 `--shadow-*` 是两层东西，经常要一起写：
`box-shadow: var(--edge-light), var(--shadow-md)`。

**玻璃拟态 `--glass-*`**（2026-09-27 新增，实验档）：`--glass-filter`（浮层，blur 20px saturate 160%）、
`--glass-filter-bar`（吸顶工具栏，blur 10px —— 它面积大得多，模糊必须更轻）、`--glass-bg`、`--glass-border`。
只给"固定且数量少"的浮层用：标题栏、吸顶工具栏、模态、命令面板、菜单、信息条。
**列表项与滚动容器一律不准用 `backdrop-filter`** —— 它每帧都要采样背后区域，这条由 §11 的测试守着。
设置项 `glass_enabled=false` → `html[data-glass='off']` → `--glass-filter` 变成 `none`
（关键是不再建合成层，而不是把模糊半径调小）；系统 `prefers-reduced-transparency: reduce` 同理。

---

### 2.11 图标系统

图标**形状数据**来自 lucide（**数据包**，与已退役的 lucide-react 对齐在 0.468），**渲染与形变**由
morphicons 负责（MIT、零运行时依赖、约 8KB gzip、stroke-based 通用形变 + 弹簧物理）。

| 能力 | 做法 | 证据 |
| --- | --- | --- |
| 统一入口 | `src/renderer/src/lib/icons.tsx`（由 `npm run gen:icons` 生成）：63 个与 lucide-react **同签名**的组件，业务侧只换 import 源；另导出 `Morph` 与 `IconData` 供形变 | `scripts/gen-icons.mjs` |
| 为什么要这层 | lucide 主入口导出 `[svg, attrs, children]` 包装，而 morphicons 的输入契约是 `[tag, attrs][]` 且只认 path/line/circle/… —— 直接传会报 `unsupported tag <svg>`，入口统一解包 | 实测报错后加解包 |
| 形变 | 同一位置换图标即带弹簧飞过去：`<Morph icon={IconData.A} />` → `icon={IconData.B}`；已接入侧栏折叠/展开、标题栏日/夜、番茄钟播放/暂停、笔记预览/编辑、任务行子树 caret | 采样到 10~11 个中间帧，飞行中是 M/L 折线、静止才回落到曲线 |
| 动效策略 | 与 §2.9 一致：应用关闭动效（`html[data-motion='none']`）时图标直接切换，否则跟随系统的「减少动态效果」。morphicons 默认 `never`（无视系统设置），**不用**它的默认值 | `icons.tsx` 的 `motionPolicy()` |
| 无障碍 | 图标默认 `aria-hidden`；传 `label` 时才 `role="img"` + `<title>`。图标按钮仍一律自带 `aria-label` | 与 §5 的 a11y 表一致 |

> caret 的「展开」不再靠 CSS 旋转 90°：`ChevronRight ↔ ChevronDown` 的形变本身就是旋转，
> 于是 `.trow__caret--open` 与 svg 的 `transition: transform` 都已删除。

### 2.12 应用图标（exe / 窗口 / 托盘，2026-09-27 重做）

**寓意**：一本**摊开的书**（知）+ 书页上的**对勾**（行）—— 知行合一。
颜色分三层以上，不是纯色块：

| 层 | 内容 | 是否随主题 |
| --- | --- | --- |
| 底 | 深墨渐变圆角方 + 顶部一圈 9% 白内描边 | 否（固定） |
| 中 | 摊开的书：强调色三段渐变（亮一档 → 本体 → 暗一档） | **是** |
| 顶 | 左页两条文字线（知识）+ 右页粗对勾（行动），白 | 否 |
| 氛围 | 底部一层强调色径向光晕 | 是 |

**真源**：`resources/icon.svg`（应用图标）与 `resources/icon-tray.svg`（托盘版：去掉文字线与光晕、
书页与对勾都加粗，保证缩到 16px 还认得出）。两者用 `{{ACCENT}}` / `{{ACCENT_LIGHT}}` / `{{ACCENT_DARK}}` 表示"随强调色的那一层"。

**生成**：`npm run gen:app-icons`（`scripts/gen-app-icons.cjs`，靠 `@resvg/resvg-js` 光栅化，
不依赖浏览器）产出：

| 产物 | 用途 |
| --- | --- |
| `resources/icon.ico` | 打包进 exe / 快捷方式（16/24/32/48/64/128/256 七档，ICO 内嵌 PNG） |
| `resources/icon-256.png` | 运行时取不到主题图标时的兜底 |
| `resources/theme-icons/app-<hex>.png` | 窗口 / 任务栏图标，8 个预设强调色各一张 |
| `resources/theme-icons/tray-<hex>.png` | 托盘图标，同 8 色 |

**跟随强调色**：主进程 `accentIconKey()` 用当前 `accent_color` 去选对应文件，
换色时 `refreshTrayIcon()` **同时**更新窗口图标（`setIcon`）与托盘图标（`setImage`）。
设置页色板之外的**自定义色**取最接近的预设兜底（256px 位图上这点色差看不出来）。

**两处限制**（都是平台事实，不是没做）：

1. **exe 图标是静态资源** —— Windows 只在构建时读取它，所以 `icon.ico` 固定用默认的「青竹」，
   运行时跟随的只有窗口图标与托盘图标；
2. **macOS 托盘仍用模板图**（`trayTemplate.png` + `setTemplateImage`）—— 菜单栏会按明暗自动反色，
   彩色图标在菜单栏里反而是异类。

## 3. 布局框架

```text
┌──────────────────────────────────────────────────────────────┐
│ TitleBar（44px，drag-region）  标题 · 签名 ·(主题/最小化/最大化/关闭) │
├───────────┬──────────────────────────────────────────────────┤
│ Sidebar   │ <main class="app__content">                      │
│ 220 / 48  │   .page                                          │
│ 8 项导航  │     .page__head（标题 + 副标题）                  │
│ 收件箱徽标│     .page__body（工具栏 + 工作区）                 │
│ 折叠按钮  │                                                  │
└───────────┴──────────────────────────────────────────────────┘
叠加层：CapturePanel / CommandPalette / TaskEditor / Dialog（--z-modal）
        InfoBar（--z-float）
        ReminderPopup（--z-reminder）、Toast（--z-toast）
```

### 3.0 滚动驱动（2026-09-27）

页面正文（`.page__body`）滚过 24px 后，吸顶工具栏进入"抬起"态（`Toolbar.tsx` 加 `.tb--lifted`）：

| 变化 | 实现 | 为什么这样做 |
| --- | --- | --- |
| 工具栏加投影、底色变实 | `box-shadow: var(--shadow-sm)` + `background: color-mix(...)` | 与下方内容之间出现一条"分界"，滚动时不再糊在一起 |
| 副标题淡出 | `opacity: 0`（**仍占位**） | 真正收起会让标题与工具行重排，滚动中重排必然抖 |
| 标题收紧 | `transform: scale(0.94)`，`transform-origin: left center` | 用 transform 而不是字号：不动布局 |
| 标题区下内边距 4px → 0 | `padding-bottom` 过渡 | 唯一的布局变化，且发生在页面顶部，不会推动滚动锚点 |

滚动容器不是 window —— 每个页面的 `.page__body` 才是，所以监听的是**最近的可滚动祖先**。
判定跨过阈值时只 setState 一次（记 ref），滚动事件本身是 passive 的。


- 窗口：无边框（`frame: false`）+ `titleBarStyle: 'hiddenInset'`（`src/main/index.ts`）；初始 1280×820，最小 1040×640。
- 拖拽区靠 `-webkit-app-region`：`.drag-region` / `.no-drag`（`global.css`）；标题栏内的按钮都包在 `.no-drag`（`TitleBar.tsx`）。
- `html/body/#root` 100% 高、`overflow: hidden`（`global.css`）；页面内部滚动容器各自声明 `overscroll-behavior: contain`，避免子卡片滚到尽头带动父容器（`global.css`）。

---

### 3.1 统一工具栏（`components/Toolbar.tsx`）

**所有功能区共用同一个骨架**，两层：

| 分区 | 内容 |
| --- | --- |
| 标题分区 | 标题 · 副标题 —— **只放页面身份，不放任何操作**（右上角留空） |
| 工具栏分区 | 视图 / 范围 / 分区导航 · 统计 ………… 搜索 · 筛选 · 次要操作 · **主操作** |

两个分区之间由上边框分隔，各自独立：标题分区是身份，工具栏分区是全部操作。

**空间不够时逐级折叠**（判据是第二层右侧组里子项的真实宽度和 vs 可用宽度，带 48px 滞回避免抖动）：

| 级别 | 表现 |
| --- | --- |
| 0 | 全部平铺 |
| 1 | 次要操作收进 `⋯`（按钮上标数量） |
| 2 | 筛选也一起收进 `⋯` |

浮层里按「筛选 / 操作」分组——即原型阶段 C 变体的分组方案。实测：工作流页在 1280px 下收 10 项，窄到 820px 再折一层收 11 项；笔记树只有 240px 宽，格式下拉常驻浮层。

两种形态：

- `page`：页面级两层 —— 今日 / 任务 / 收件箱 / 工作流 / 图谱 / 设置。
- `panel`：只有第二层 —— 笔记树工具区（**只剩搜索框**，新建笔记 / 新建文件夹的入口下到笔记行与文件夹行上）、富文本格式条（14 个格式按钮在编辑器宽度下直接走折叠）。

主操作每页一个、位置固定在**工具栏分区最右端**（新建任务 / 收进收件箱 / 启动实例…），两种形态一致；搜索框位置统一（页面级在工具栏分区右侧首位）。收件箱原先的三条工具条（分区 tab + `.flash-new` + `.flash-toolbar`）已合并为一条；`.tasks-toolbar`、`.flash-toolbar`、`.ntree__tools`、`.rt-editor__bar`、`.quick-add` 五套旧工具区样式已删除。

---

## 4. 任务页四个视图（`TasksPage.tsx`）

视图切换是一个 `role="group"` 的分段控件（`.seg`），四项：**列表 / 四象限 / 日历 / 看板**（`TasksPage.tsx`、），按钮用 `aria-pressed` 表达选中。

### 4.1 列表视图（默认）

- 树形缩进 + 折叠；行高由 `--row-h` 决定（`TasksPage.tsx`）。
- **虚拟滚动**：`VirtualList` 固定行高、按 `count × rowHeight` 绝对定位，`overscan = 8`，容器高度用 `ResizeObserver` 实测（`components/VirtualList.tsx`）。
- 行内容（`components/TaskRow.tsx`）：勾选框（`aria-label` 随状态变化，）→ 优先级色点（`aria-label`/`title` 给出文字等级，）→ 标题 → **胶囊容器 `.trow__chips`**（循环 / `🔥N` 连续 / 日期区间 / 标签  / `⇄N` 笔记数 ，逾期区间转 danger 色）→ **行内动作组 `.trow__actions`**（，开始专注 / 加子任务 / 编辑 / 删除）。
- 动作组**不是浮层**：未悬浮时收拢为 0 宽 + 透明且不接收指针事件，悬浮（或选中）时展开为内容宽度（实测 110px），胶囊容器作为普通 flex 兄弟项随之被推到它左侧 —— 即「悬浮时胶囊移到按钮组左边」。按钮与胶囊同款：20px 高、`0 6px` 内边距、`--radius-sm` 圆角、`--fg-secondary` 文字色。
- 添加行计入行数，否则虚拟列表的绝对定位会错位（`TasksPage.tsx` 注释）。

### 4.2 四象限

- 格子：重要且紧急 / 重要不紧急 / 紧急不重要 / 不重要不紧急（`QuadrantBoard.tsx`）。
- 归格规则：`important = isImportant(priority)`，`urgent = due_date !== null && due_date <= today`；**只有根任务归格**，父行可展开未完成的直接子任务，子任务自身优先级/日期不参与归格（ 注释）。
- 拖拽换格写入 `priority + due_date` 组合。

### 4.3 日历

- 6×7 月份网格、**周一为第一列**（与 Qt `QCalendarWidget` 周首一致，`CalendarBoard.tsx`）。
- 单元格最多 3 个任务胶囊，超出显示 `+N`（、）。
- 拖拽胶囊到日期格即改期。
- 右侧固定「当日任务」栏。
- 已知口径差异：只看 `due_date`、丢弃无日期任务、不展开 `start_date`、恒排除已完成，因此设置项 `calendar_show_done` 在 UI 上无效（详见 `01` R-T-16）。

### 4.4 看板

- 列 = 状态（`STATUS_CHOICES`），卡片 = **根任务**（列头计数也只算根任务，`KanbanBoard.tsx` 注释）。
- 拖卡片到另一列改状态；每列底部有「+ 添加」直接在该状态建任务。
- 展开的父任务把未完成子任务以缩进卡片列在下方，**不做状态级联**（、）。

### 4.5 工具栏与共享交互

| 交互 | 位置 | 说明 |
| --- | --- | --- |
| 按清单筛选 | `TasksPage.tsx` | 「全部清单 / 收件箱（未归属）/ 各清单」 |
| 新建清单 | `TasksPage.tsx` | 应用内 `dialog.prompt`，非原生弹框 |
| 当前视图过滤 | `TasksPage.tsx` | 本地过滤：自身或任一后代命中即保留 |
| 多选与批量 | `TasksPage.tsx` | Ctrl/Cmd 切换、Shift 选范围；批量完成/移动/改期 |
| 速览侧栏 | 、 | `.inspector` 常驻可切换 |
| 新建任务 | `TasksPage.tsx` | 行内添加行 |
| 撤销条 | `App.tsx` | 6s 自动消失 + Ctrl+Z |

---

## 5. 侧栏与标题栏

### 5.1 侧栏（`components/Sidebar.tsx`）

- 8 项导航 + 1 个折叠按钮；分区：`top`（7 项）+ `bottom`（设置）——`nav.ts`。
- 结构标注为 `nav aria-label="主导航"`，当前项 `aria-current="page"`（`Sidebar.tsx`、）。
- 收件箱徽标只在未折叠且计数 > 0 时渲染。
- 折叠态 48px，只留图标并以 `title` 补文字；折叠仍保留 `aria-label`。
- 图标经 `lib/icons.tsx` 由 morphicons 渲染（形状数据来自 lucide 数据包），20px / stroke 2。

### 5.3 页面内的三处侧栏收放（2026-09-26）

任务页的清单树、笔记页的笔记树、工作流页的模板树统一了收放行为：**收起时整块不渲染** —— 既不是 `display: none`（藏起来的行仍会被查询与自动化脚本当成「看得见」），也不是缩成窄条（仍然占位）。三处按钮的落点按「离它管的东西最近」定：

| 位置 | 按钮落点 | 额外约束 |
| --- | --- | --- |
| 任务页 · 清单树 | 分段控件里「列表」两个字旁边（`.seg .seg__panel`） | **只在列表视图出现** —— 四象限 / 日历 / 看板不按清单组织，此时连按钮一起隐藏 |
| 笔记页 · 笔记树 | 页面副标题旁边（`.page__head-toggle`，用 `align-self: center` 抵消页头的 baseline 对齐） | 全屏编辑时页面头整体让位，树也随之不显示 |
| 工作流页 · 模板树 | 工具栏最左边（`Toolbar` 的 `nav` 槽） | 收起时**分隔条一并隐藏** —— 没有侧栏就没有可拖的边界 |

状态存 localStorage（`zhixing.tree.tasks` / `.notes` / `.workflow`），与 `wf.sideWidth`、命令面板 MRU 同一个理由：纯界面偏好，不该跟着数据一起被导出 / 同步。

任务页原先有一版 40px 的「窄条」形态（`.tasklists--rail`，只留一个展开按钮），按「收起不占位」的要求撤掉，组件里的 `rail` state 与两条 CSS 一并删除。回归：`tasklistuxcheck`（12 项，含整栏收放与「只在列表视图」）、`notesheetcheck`（44 项，含笔记树收放）、`workflowcheck`（18 项，含模板树收放与分隔条隐藏）。

### 5.2 标题栏（`components/TitleBar.tsx`）

- 左侧：macOS 红绿灯占位（`isMac` 时渲染 `titlebar__traffic`，）。
- 中间：`知行 ZhiXing · <当前页名>`（i18n 取词，`App.tsx`）；右侧签名位来自 `settings.signature`（默认「知行合一」，`settings.ts`）。
- 右侧动作：明暗切换（图标与 `aria-label` 随当前主题变化，）；非 macOS 时追加最小化/最大化/关闭，关闭按钮为危险色。
- 键盘折叠侧栏：Ctrl/Cmd+B（`App.tsx`）。

---

## 6. 桌面浮窗与系统托盘

### 6.1 桌面浮窗（第二个窗口，`?widget=1`）

| 能力 | 行为 | 证据 |
| --- | --- | --- |
| 尺寸与下限 | 290×380，最小 200×160 | `src/main/index.ts` |
| 窗口属性 | 无边框、透明（显式 `backgroundColor: '#00000000'`）、置顶 `floating`、不进任务栏、可缩放、无阴影 | `src/main/widget.ts` |
| 不透明度 | `widget_opacity / 100`，钳在 0.3–1.0 | 、 |
| 几何持久化 | 存 `settings.ui_state.widget_geometry`，配置损坏则回退默认尺寸 | `src/main/widget-geometry.ts` |
| 贴边悬浮球 | 靠近屏幕左右边缘 8px 内收成悬浮球（默认球体 96px、可调 88~160），竖直对齐原窗口中心后钳进工作区；展开按上次宽高还原，且不污染持久化的展开几何 | `src/main/index.ts` |
| 球体拖动 | 按住球拖动，松手吸附最近边缘（水平吸平、竖直只钳进工作区）。位移由主进程按屏幕光标重算（与边缘缩放同款）；**不用 `-webkit-app-region: drag`**，否则球上的点击会被一并吞掉 | `widget.ts` 的 `ballDragStart` / `ballDragTo` / `ballDragEnd` |
| 球体缩放 | 滚轮步进 8px、右键「悬浮球大小」三档；球体整比例缩放（bloub 的 viewBox 自己缩放，不再需要按球径调眼睛倍率） | `widget.ts` 的 `setBallSize` |
| 悬浮球表情 | bloub 引擎（`vendor/bloub/`，MIT）：11 个状态的随机池（刻意避开 `idle` / `sleep` / `swirl`），2.6~5.8s 一拍、停留 1.4~2.6s 回待机；指针注视走 `setLook`；150s 无交互打盹（`sleep`），互动播 `alert` 唤醒 | `WidgetBall.tsx`、`BloubAvatar.tsx` |
| 展开 / 收起 | 点球（先笑一下再展开）/ 双击 / 右键「展开浮窗」→ 浮窗朝**球所在侧的反方向**展开（球在左就向右）；浮窗底部「隐藏」= **收起成球**并落回浮窗最近侧，彻底隐藏用右键「隐藏浮窗」 | 、 |
| 右键菜单 | 今日视图 / 贴边停靠·展开浮窗（按形态二选一）/ 悬浮球大小（仅球形态）/ 隐藏浮窗 | `src/main/index.ts` 浮窗 IPC 段 |
| 鼠标穿透 | `setIgnoreMouseEvents(enabled, { forward: true })` | `widget.ts` 的 `applyWidgetClickThrough` |
| 内容 | 顶部快速输入（回车即建）+ 今日待办（含子树）+ 底部「打开主程序 / 隐藏」 | `WidgetApp.tsx` |
| 数据同步 | 5s 轮询重查今日任务（**球形态暂停**，展开时补拉一次）；`settings` 域广播触发外观重铺 | `WidgetApp.tsx`、 |

**降级说明**：浮窗内的优先级、标签、更多操作、编辑只提示「请到主窗口」，删除用原生 `confirm` 且无撤销。边缘缩放未实现（`01` R-S-07）。

### 6.1b 番茄钟（第三个独立小窗，`?pomodoro=1`，2026-09-27）

原先是主窗口右下角的一条浮条。改成独立小窗的理由不是"搬个位置"：
**它与主窗口的生命周期本来就不同** —— 主窗口关掉只是收进托盘/浮窗，而专注该继续跑，
浮条会跟着主窗口一起消失。

| 项 | 做法 |
| --- | --- |
| 窗口 | 无边框 + 透明 + `alwaysOnTop` + `skipTaskbar`，定位在工作区右下角（`screen.workArea`，多显示器按主显示器算）；高度由既有的 `window:fitHeight` 贴合 |
| 卡片 | 复用 `.modal / .modal__head / .dialog__icon / .modal__foot` —— 与全局热键的捕获窗、工作流条件确认窗**同一套骨架**，这就是"样式一致"的落点 |
| 协议 | 与捕获窗一致：主进程推 payload → 渲染层应用完主题发 `ready` → 主进程才显示（1.5s 兜底） |
| 状态宿主 | 计时 / 暂停 / 中断 / 落库**都在那个窗口里**；主窗口与桌面浮窗只是发起方（`window.zhixing.pomodoro.open({ taskId, title })`） |
| 中断原因 | 不再叠第二层浮层，在卡片里就地切换 |

> 顺带修掉的既有缺陷：桌面浮窗里的「专注」按钮原来派发的是**本窗口**的 `zhixing:pomodoro` 事件，
> 而监听者（原 PomodoroBar）在主窗口 —— 那条路径一直是哑的。现在五个入口（任务行 / 今日页 /
> 收件箱 / 命令面板 / 浮窗）统一走 IPC。原 `components/PomodoroBar.tsx` 与 `app.css` 的 `.pomo*` 段已删除。

### 6.2 系统托盘

- 菜单 5 项：显示主窗口 / 快速添加任务 / 划词捕获 / 显示·隐藏浮窗 /（分隔）退出（`src/main/index.ts`）。
- tooltip 动态显示「今天待办 N」，并在任何写操作后刷新（、）。
- 单击托盘图标 = 显示主窗口；macOS 用模板图。

---

## 7. 命令面板（`components/CommandPalette.tsx`）

- 打开：Ctrl/Cmd+K（`App.tsx`）；打开时清空查询、聚焦输入框。
- 检索：输入后 **120ms 防抖** call `db.globalSearch`（跨类型一次返回；支持 `task:`/`note:`/`flash:`/`tag:` 前缀与 `due:`/`status:`/`priority:`/`folder:` 过滤，`Search` 分档 20/8/6）。
- 结果结构：先「新建任务」动作 → 页面跳转命令 → 四类命中（任务/笔记/闪念/标签），每组有图标；总计最多 30 项。
- 键盘：↑/↓ 移动、Enter 执行、Esc 关闭；鼠标悬停同步高亮。
- 语义：`role="dialog"` + `aria-modal` + `role="listbox"` + `role="option"` + `aria-selected`（，）。
- 命令集：导航 + 新建任务 + **开始专注**（`start-pomodoro`，2026-09-27 接上，走独立小窗）+ 备份等；
  MRU 已实现（`zhixing.cmd.mru`，最近用过的命令排前面）。

---

## 8. 编辑器与笔记交互

### 8.1 布局：一张笔记纸 + 一条信息条（`NotesPage.tsx`，2026-09 重排）

```text
[笔记树 ntree]  |  [notes-main / editor]              |  [links 面板]
文件夹 + 笔记 |  editor__bar（标题输入 + 动作按钮）   |  反向链接 · N
新建/格式下拉 |  find-bar（Ctrl+F，role=search）      |  引用（正向）· N
              |  正文区（编辑器 / 预览 / Office / 链接） |  失效链接
```

```text
笔记树 240px（可拖 180–460）│ 笔记多标签页（≥2 篇打开时出现，30px；横向滚动）
                            │ 笔记纸（编辑区唯一的卡片，占满编辑区）
                            │   ├─ 标题行：标题 · 保存状态胶囊 · 标签胶囊 · 归属胶囊
                            │   ├─ 工具栏（吸附在编辑区顶部）：左端固定「预览 · AI 整理 · 链接 · 引用 · 模板 · 全屏」，
                            │   │   富文本形态下它们与格式条合成同一条（操作组在左、格式按钮在右）
                            │   └─ 正文：Markdown / 富文本 / Word / Excel / 链接 / 预览（一律无内层边框）
                            ↑ 以上三块铺满纸面，共用同一条左边缘
                                     信息条（默认收起，34px；全宽，与纸同宽）
```

- **分隔条与工作流同一套（2026-09-26）**：笔记树右缘那条分隔条（`.ntree__resizer`）改成工作流模板树分隔条（`.wf-splitter`）的规格 —— **12px 命中区 + 伪元素画的 2px 细线**（平时 `--border`，hover / 聚焦 / 拖拽中变 `--accent`），可聚焦（`tabIndex=0`，`role="separator"` + `aria-orientation` + `aria-valuenow/min/max`），← → 各 16px、Home 复位；宽度默认 240（180–460）并落 localStorage（`notes.treeWidth`）。此前是 7px 的透明块、悬停才整条泛蓝（`color-mix` 45%）、没有键盘入口，ARIA 只有 role 与 label —— 拖拽手感与可访问性都弱一档。拖拽期间根元素挂 `.ntree.is-resizing`（细线变强调色、整块禁止选中文本），与工作流的 `.wf-wrap.is-resizing` 是同一件事。两页侧栏的宽度规格（默认 / 上下界 / 键盘步长）现在取同一组数：改一边要同时改另一边。回归：`notesheetcheck` 两条断言。
- **笔记多标签页（2026-09-26）**：打开过的笔记以 tab 留在编辑区顶部一条 30px 的横条里（**≥2 篇才渲染** —— 只有一篇时不占位）。树上单击 = 新开一枚（已打开则只激活、不重复开）；上限 12，到顶挤掉最久未使用的。关掉当前那枚按「**右邻 → 左邻 → 空态**」接上，× 按钮与中键点击都能关。**装不下时**（内容宽 > 可视宽）右端固定出现一个「选择」入口（`⌄ N`），点开列出全部已打开的笔记、当前那枚带勾 —— 横向滚动是个不可见的手势，被推出视口的那几篇不能等于没有入口。切换前先 `flushPending()` 落盘，所以切走再回来内容不丢。列表与激活项存 localStorage（`zhixing.noteTabs`）—— 切页会卸载整个笔记页、重启更不用说，恢复全靠它；全屏编辑（zen）时整条让位。**正文状态仍只有一份**（方案里的路线 1）：切 tab 复用 `selectNote()` 重新读库，代价是滚动位置不记忆（切回来滚到顶部），要消除需给每枚 tab 分桶独立草稿。设计与拍板见 `docs/note-tabs-plan.md`，回归 `scripts/notetabcheck.mjs`（18 项）。
- **卡片只标记容器，不标记分区**：编辑区曾是「头部卡 + 标签卡 + 正文卡」三张独立卡片，加上信息区共 6 张带边框的矩形 + 4 段间隙，把「标题 → 正文」的连续阅读切成四段。重排后是 **1 张纸（`.sheet`）+ 1 条信息条**，分层靠留白，不新增分割线。正文各形态容器（`.md-editor` / `.rt-editor` / `.editor__preview` / `.editor__office` / `.editor__link`）统一去掉 `border`、`border-radius` 与底色。
- **铺满纸面**：标题行 / 正文一律吃满笔记纸的内容宽（`.sheet` 是 flex column，子项默认 stretch）—— 左边缘因此天然对齐，横向留白只由 `.sheet` 的内边距决定；五种形态（Markdown / 富文本 / Word / Excel / 链接）宽度一致，不再按形态分「宽体」。
- **曾用过「书写列」**（2026-09，已撤）：那一版把这三块限宽 560px 并居中，追求 43 字/行的可读行宽（对齐上游 ui-ux-pro-max 的 `Line Length` 规则）。按产品决定撤掉后，行宽重新随窗口增长 —— 1280 窗口约 54 个中文字/行、1600 窗口约 78 个，超出中文 30–45 字的舒适区，这是**已知代价**；要恢复只需在 `.sheet > .tb` / `.sheet__body` 上加回 `max-width` + `margin-inline: auto`。
- **标题行四合一（2026-09-26 重排）**：标题、保存状态胶囊、标签胶囊、归属胶囊同处一行，`.sheet__meta` 整行与其中的**格式下拉一并撤掉** —— 头部从三层（标题行 + 工具行 + 元信息行，实测 104px）收成两层（实测 29px + 32px = 61px），正文多出约 32px。笔记类型改为**只在新建时决定**：入口在笔记树的「新建笔记」格式菜单（`NoteTree.tsx` 的 `formatMenu` / `NOTE_FORMATS`），编辑区不再提供事后切换。
- **保存状态胶囊**：图标 + 文案常驻（`✓ 已保存` / `未保存`）。此前只在脏时冒出一行「未保存…」，干净态什么都不显示 —— 「没在动」和「已经存好」看起来一样。配色沿用任务页状态胶囊那套「边框与淡底都由 currentColor 派生」：已保存取 `--fg-tertiary`，未保存取 `--accent-warm`，换主题 / 换强调色时跟着走。 2026-09-26 起它同时承载 **Word / Excel 的文件写回状态**：`officePending` 与 `dirty` 分开记（`dirty` 说的是标题 / `content_md` 没落库，Word 的正文不在 `content_md` 里，混成一个会让自动保存把状态提前清掉），胶囊取两者的并集。相应地，写回成功**不再弹 toast** —— 每停一次手弹一条「已写回 …」是噪音；失败仍然提示，因为那时胶囊还停在「未保存」，用户需要知道为什么。
- **操作组并入工具栏且靠左（2026-09-26）**：那 6 个入口原来独占一行，现在挂到工具栏的**左槽**（Toolbar 的 nav 位）—— 富文本由 RichTextEditor 的 leading 接住，与格式条落在同一个 `.tb__sub` 里（左组 6 个 + 右组格式按钮），纸上因此只剩一条工具栏；其余形态没有格式条可挂，这一行自成一行，位置与对齐完全一致。左组**不参与右侧折叠**（`flex: 0 0 auto`），窄窗口放不下时由 `flex-wrap` 让格式条整组换行，而不是把这一行挤破。左组与右组的间距从通用工具栏的 38px 收到 16px。
  三点配套：① 左组**不参与右侧折叠**（`flex: 0 0 auto`），6 个入口永远可见；右组的 flex 基底改为 `0`（通用工具栏给的是 `1 1 auto`，自然宽度等于所有格式按钮之和，在可换行容器里它一定会掉到第二行）；② **编辑区窄于 920px 时左组收成纯图标**（`.sheet` 上开 `container-type: inline-size`，用容器查询按**编辑区自身宽度**判断，与窗口宽度解耦；图标都带 `title`，语义不丢），把宽度让给格式条 —— 1280 窗口下格式条因此能显示「字号 · 颜色 · B I U S H1」，不收则只剩一个「⋯ 23」；③ 字号下拉改按内容自适应（`.field--compact` 的 200px 是给输入框的，「字号 ▾」两个字不需要）。
- **工具栏融入编辑区顶部**：页面工具行与富文本格式条都改成**无边框**（`border-color: transparent` + 无底色，悬浮与选中才给底），整组向左挪回按钮自身的 8px 内边距，图标因此与标题、正文落在同一条左边缘；两条都 `position: sticky; top: 0` 并给实色底，正文再长也不跟着滚走。
- **编辑区聚焦不出边框**：标题输入、**富文本 / Word 正文**（`.rt-editor .ProseMirror`）、Excel 网格单元格、链接表格单元格聚焦时都不再画焦点框/轮廓 —— 落点统一交给光标与底色（`--accent-soft` / `--bg-hover`），编辑区里不再出现任何矩形框。两个坑：① `contenteditable`（ProseMirror）在 Chromium 里**鼠标点击也算 `:focus-visible`**，只写 `:focus` 压不住 global.css 的兜底规则，必须两条伪类都写 —— 实测点一下就会出现 2px 蓝环；② 用 `element.focus()` 的自动化测不出这一条，回归脚本改成 `Input.dispatchMouseEvent` 真实点击。
- **正文横向内边距归零**：`.cm-content` 原自带 16px 横向内边距，于是 Markdown 正文比标题右缩一格，而富文本（`.rt-editor__body`）与预览（`.editor__preview`）早已归零 —— 三种形态左边缘互不一致。横向一律交给纸面，`.sheet > .tb` / `.sheet > .sheet__body` 共用同一条左边缘（`.sheet` 是 flex column，子项默认 stretch）。
- **整块画布都可点（2026-09-26）**：可编辑元素默认只有内容高 —— `.cm-content` 与 `.ProseMirror` 下方那片空白不属于编辑器，点上去不聚焦，读起来就是「只有第一行能编辑」。现在两者都撑满各自的滚动容器（`min-height: 100%`），点空白即把光标接到最近的文档位置；`.rt-editor__body` 的内边距随之搬到 `.ProseMirror` 身上（留在容器上会变成「100% + 内边距」，凭空多一条滚动条）。Markdown / 富文本 / Word 三条链路一并覆盖（Word 走 `.editor__office-body > .rt-editor`，同一套类名）。
- **Word 与富文本共用一条工具栏（2026-09-26）**：Word 可编辑形态走的是同一个 `RichTextEditor`（挂在 `.editor__office-body` 里），那 6 个操作一并挂进它的格式条左侧 —— 此前 Word 会多出一条只放这 6 个入口的行，与富文本不一致。`usesRichToolbar` 因此覆盖 `richtext` 与 `wordEditing` 两种形态。
- **工具栏高度（2026-09-26 收紧）**：`.editor .tb__sub` 的上下内边距与上外边距全部归零、`.editor .tb` 的下外边距从 12px 收到 8px、`.rt-editor .tb--panel` 同样只留一行 —— 工具栏只占按钮本身那 24px。头部（`.editor .tb`）因此从 **73px 收到 61px**，1280 窗口下正文区占比 **77% → 82%**。 2026-09-26 之后又收了一轮：`.editor .tb` 的下外边距归零、`.sheet__body` 的上内边距 8→4px、Markdown 的 `.cm-content` 上内边距 16→8px —— **工具栏到正文首行只剩 12px**（原先富文本 24px、Markdown 32px，三层间距叠加）。
- **Word 的头部并入工具栏（2026-09-26）**：Word 可编辑原本在格式条上方另有一条 `.editor__office-head`（状态文案 + 「导出 .docx」+「用系统应用打开」，40px 高）。两个按钮进工具栏最右端的不折叠位（`RichTextEditor` 的 `primary`），那一行整块撤掉 —— 与富文本的头部结构完全一致。状态文案（「Word 可编辑（自动写回 .docx）· 已载入…」）按产品决定不再显示，`leadingMeta` 槽位随之删掉。**Excel 同款（2026-09-26）**：Excel 没有格式条可挂，「用系统应用打开」挂到页面工具栏的 `primary`（同样是最右端不折叠位），`.editor__office-head` 与「Excel 可编辑（自动写回 .xlsx）」那句状态文案一并撤掉 —— 两种 Office 形态的头部结构因此完全一致，Excel 正文多出 40px。
- **链接笔记也归位（2026-09-26）**：链接笔记原先在表格上方另有一条 `.editor__link-head`（「链接笔记 · N 条」+「添加链接」，40px 高）。现在条数收成标题行的 `链接 N 条` 胶囊（`.chip.chip--count`，**纯计数、不可点** —— 与可点的「归属」`.chip--meta` 区分开，不给 `cursor: pointer` 也不给 hover），「添加链接」挂到页面工具栏的 `primary`（最右端不折叠位，与 Word 的「导出 .docx」、Excel 的「用系统应用打开」同一落点），那一行头部整块撤掉。表格空态文案随之改成「点工具栏的『添加链接』」。非 Markdown / 富文本形态的头部结构至此完全一致。
- **工具行退出通用填充**：通用工具栏的 `.tb__subright--fill` 会把剩余宽度给第一个控件，在笔记编辑器里会把按钮整组推到右边、并把「模板 / 全屏」挤进「⋯」。笔记页用更具体的规则退出这次填充（`notes.css` 里 `.editor .tb .tb__subright.tb__subright--fill`）。
- **信息条默认收起**：`linksExpanded` 默认 `false`，收起态只显示「属性 N · 反链 N · 引用 N · 归属 N」计数，高度 34px；展开后与重排前可见性一致（三组并排、`max-height: 220px`、内部滚动）。实测正文可用高度占比由空态约 46% 升到约 74%（1280×820）。
- **窄窗口换形态**：判据是编辑区**自身**宽度（`ResizeObserver` 量 `.notes-main`）而不是窗口宽度，阈值 660px。低于阈值时展开态改为覆盖式抽屉 `.links--drawer`（`position: fixed` + `.links__scrim` 遮罩），不挤压正文 —— 1024 窗口下编辑区只剩约 480px，并排会把提示文案折成两行。
- **全屏编辑**：工具栏「全屏」把状态提到 App（`.app--zen`），页面头、笔记树、左侧主导航一起让位，**标题栏保留**（窗口按钮还在上面）；Esc 退出，离开笔记页自动复位。样式见 `notes.css` 的 `.page--zen` / `.notes-main--zen`。
- **链接体检入口在树上**：「孤儿笔记 / 失效链接」查的是整库链接健康度，不属于「这一篇怎么编辑」，2026-09 从单篇笔记工具栏移到笔记树工具行（`.ntree__topbar` 的「链接体检」）。单篇工具栏因此从 8 个控件降到 6 个，1280 窗口下不再发生折叠。
- 信息区可整体开关（`linksOpen`，默认开）；滚动容器均在 `global.css` 的 `overscroll-behavior: contain` 名单内。
- 回归：`node scripts/notesheetcheck.mjs`（43 项，含卡片收敛、铺满对齐、标题行四合一与保存状态两态、工具栏到正文首行 ≤14px、操作组落在工具栏左端与宽窄两态、富文本与 Word 操作组并入格式条、Word 写回走胶囊且不弹提示（编辑→未保存 / 写回→已保存 / 无 toast）、正文无焦点框、点正文空白可聚焦（Markdown / 富文本各一条）、工具栏无边框、数据形态全宽、信息条两态、抽屉形态、全屏、树上入口）。

### 8.2 CodeMirror 6 编辑器（`components/MarkdownEditor.tsx`）

- 扩展：`history`、`drawSelection`、`highlightActiveLine`、`closeBrackets`、`markdown()`、`syntaxHighlighting(mdHighlight)`、`[[` 补全、placeholder、行宽换行、`completionKeymap + defaultKeymap + historyKeymap + indentWithTab`。
- 高亮配色**全部取自设计令牌**：标题用 `--accent`、行内代码用 `--accent-solid`、引用用 `--fg-secondary`。
- 编辑区主题：字体走 `--font-ui`、行高 1.75、内边距纵向 `--space-4`（横向 0，交给书写列）、活动行 `--bg-hover`、选区 `--accent-soft`、光标 `--accent`、补全浮层 `--bg-layer-solid` + `--radius-md`。
- `[[` 补全按前缀过滤标题，最多 20 项。
- 外部改正文（切笔记、回滚版本）时替换文档且不触发 onChange 回环。

### 8.3 保存与查找

- 自动保存**防抖**；切换笔记前先 `flushPending`（8 处入口都走 `selectNote`，`NotesPage.tsx`）；Ctrl/Cmd+S 立即保存。
- 查找栏 `role="search"`：Enter 找下一个、Esc 关闭；按钮只有「下一个 / 全部替换 / 关闭」——无单处替换、无全部命中高亮。
- **残留风险**：无 `beforeunload`/关窗钩子，直接关窗会丢掉防抖窗口内的编辑（`01` R-N-20）。

### 8.4 正文区的四种形态

| 条件 | 形态 | 证据 |
| --- | --- | --- |
| `format === 'link'` | 链接表格（可编辑的多链接列表）；条数走标题行胶囊，动作是工具栏最右端的「添加链接」 | `NotesPage.tsx` 的 `.editor__link` 分支 |
| word / excel | **可编辑**：Word 走 `RichTextEditor` 并自动写回 `.docx`，Excel 走 `XlsxGrid` 自动写回 `.xlsx` | `.editor__office` 分支 |
| 预览开（markdown / richtext） | `MarkdownView`（`[[` 可点，悬空可一键新建） | `.editor__preview` 分支 |
| 预览关 + markdown | `MarkdownEditor`（CodeMirror 6） | `components/MarkdownEditor.tsx` |
| 预览关 + richtext | `RichTextEditor`（tiptap） | `components/RichTextEditor.tsx` |

**Office 写回的自愈（2026-09-26）**：Word/Excel 笔记的 `content_md` 按约定存文件路径，但库里确实有存成正文的数据（示例笔记，或者建笔记时把正文填进了「已有文件路径」那一栏）。读取端 `officeDocNote` 一直知道这种情况该提示「文件尚未创建，保存时会新建」，写入端却把它当路径一路走到 `mkdir` —— 报出来的是 `ENOENT … mkdir '…整段正文….docx'`，用户既看不懂也没法处理。现在两端一致：`saveWordNote` / `saveExcelNote` 先用 `looksLikeLocalPath` 判断，不是路径就地补一个空白文件、把新路径登记回笔记再写回；自愈只发生一次（`getNote` 每次重新读库），不会每存一次就多建一个文件。`onMissingPath` 的父目录计算也改用 `lastIndexOf` —— 原先的正则在**没有分隔符**时会把整串当成目录去建。

---

## 9. 对话框与反馈规范

### 9.1 应用内对话框（`components/Dialogs.tsx`）

存在理由写在文件头：Electron **不实现** `window.prompt`——调用不报错、永远返回 `null`，于是新建标签/文件夹/工作流、重命名在打包版里会静默失败。

| 规范 | 实现 |
| --- | --- |
| API | `dialog.prompt({title,label,defaultValue,placeholder,confirmText})` / `dialog.confirm(options 或 string)` |
| 队列 | 用数组 + ref 承载，并存请求不会互相覆盖 |
| 结算时机 | 先更新界面再 `resolve`（ 注释记录了「resolve 写进 setState updater 导致 await 后代码永不执行」的真实 bug） |
| 焦点 | 打开后 30ms 选中输入框内容 |
| 键盘 | Enter 确认、Escape 取消 |
| 遮罩 | 点击遮罩 = 取消；对话框本体阻止冒泡 |
| 语义 | `role="dialog"` + `aria-modal="true"` |
| 危险动作 | `danger: true` → 确认按钮转危险色（、） |

**缺口（本轮实测）**：`window.confirm` 仍有 **15 处**未迁移（TasksPage 2、InboxPage 2、WidgetApp 1、NotesPage 1、SettingsPage 2、WorkflowPage 3、TodayPage 1、RecycleBin 2、TagManager 1），会弹原生框、与自绘界面风格割裂；应用内 `dialog.prompt/confirm` 调用点 10 处。

### 9.2 反馈三件套

| 组件 | 层级 / 语义 | 行为 | 证据 |
| --- | --- | --- | --- |
| `Toast` | `--z-toast`，`role="status" aria-live="polite"` | 单一文案，2600ms 自动消失 | `components/Toast.tsx`、`App.tsx` |
| 撤销条 InfoBar | `--z-float`，`role="status"` | 6s 自动消失；「撤销」按钮 + Ctrl+Z；删除类撤销走回收站 restore | `App.tsx`、 |
| `ReminderPopup` | `--z-reminder`，`role="alertdialog"` | 30s 轮询；正文含提醒时刻与截止；动作：稍后 5/15/30 分、查看、知道了 | `components/ReminderPopup.tsx`、 |

**番茄钟**是第三个独立小窗（`?pomodoro=1`，见 §6.1b），**不是本窗口里的条状控件** ——
原来那个 `components/PomodoroBar.tsx` 已随「三个入口统一走 IPC」一起删除。
小窗自己渲染阶段（工作 / 休息）、`mm:ss`、任务名、进度条、暂停/继续、结束；
宿主是 `src/renderer/src/PomodoroWindowApp.tsx`。

### 9.2b 弹出菜单同构：状态 / 优先级 / 标签（2026-09-27 收口）

三种"点胶囊改属性"的弹层现在是**同一套骨架**：容器 `.popmenu`、每行 `.popmenu__item`
（`min-height: var(--control-h)`、hover 底色、选中态 `.popmenu__item--active`）。

| 弹层 | 每行的构成 |
| --- | --- |
| 状态（`StatusMenu`） | 状态色圆点 + 文本 |
| 优先级（`PriorityMenu`） | 优先级色点 + 文本 |
| 标签（`TagMenu`） | **标签色点 + 文本 + 选中时的 ✓** |

标签弹层此前是"色块按钮 + 勾选位 + 彩色胶囊"三件东西挤一行（用户原话："标签聚到一起，不好看"）。
现在胶囊只留在任务行/笔记树上（那是行内展示），弹层里一律"一点一名"。
"点色点改颜色"保留：调色板就地展开在所属标签行下面；「新建标签」做成列表最后一行，footer 区块已删。

> 选择器钩子：容器同时带 `.popmenu` 与 `.tagmenu`，色点按钮与名字按钮仍是 `.tagmenu__swatch` / `.tagmenu__name`
> —— `scripts/taglistcheck.mjs` 直接查它们。外观已全部继承 `.popmenu*`，这些类名不再有任何样式含义。

### 9.3 模态与浮层规范

- 遮罩统一 `.modal-mask` + `--overlay`，弹层用 `--shadow-lg`/`--shadow-xl` + `--radius-lg`/`--radius-xl`。
- 模态内的输入用 `.field`；`.field:focus-visible` 关掉全局焦点环，改由边框变色表达，避免两层焦点效果（`global.css`）。
- 速览面板（`.inspector`）、图谱侧栏（`.graph-side`）、工作流侧栏（`.wf-side`）都用 `<aside aria-label>` 标注。

---

## 10. 可访问性

| 项目 | 规定 | 证据 |
| --- | --- | --- |
| 焦点环 | **永远可见、不可删**；`:focus-visible` 用 `--focus-w` + `--focus-ring`，`outline-offset: 1px` | `global.css` |
| 输入焦点 | 输入/下拉改用边框变色，避免双重焦点环 | `global.css` |
| 文字对比度 | 正文/次要 ≥4.5:1、辅助 ≥4.0:1；应用主题时**运行时校正** | `theme.ts`、`color.ts` |
| 非文本对比 | 边框/指示条/图标对相邻底 ≥3:1（约定） | `tokens.css` 注释 |
| 对比度实测 | `scripts/contrast-audit.mjs` 对 14 主题包 × 双模式逐组测 WCAG 相对亮度（报告 168 组） | `package.json` |
| 键盘可达 | Ctrl+K/N/Shift+N/B/E/F/,/Tab/1..6/Z；输入框/文本域/contentEditable 内不劫持 | `App.tsx` |
| 语义标注 | `nav aria-label`、`aria-current`、`role="group"` + `aria-pressed`、`role="dialog" aria-modal`、`role="listbox"`/`option`、`role="search"`、`role="status"`、`role="alertdialog"`、`aria-label` 于图标按钮 | 见 §3–§9 各条 |
| 图标按钮 | 一律带 `aria-label`（或 `title`），纯装饰图标 `aria-hidden` | 如 `Sidebar.tsx`、`TitleBar.tsx`、`CommandPalette.tsx` |
| 减弱动效 | `@media (prefers-reduced-motion: reduce)` 把 7 档时长全归零 | `tokens.css` |

**未取证**：本轮未做屏幕阅读器实机测试；以上为代码级证据（语义属性与对比度算法），不等价于无障碍验收通过。

---

## 11. 动效规范与降级

> **对照演示**：`docs/motion-visual-demo.html`（浏览器直接打开）逐条演示这套规范的落地效果 ——
> 失效令牌、完成态划线、列表行进场、弹出菜单、模态进出场、Toast 生命周期、侧栏指示条滑动、卡片物理。

### 11.1 硬规则

1. **统一时长/缓动**：所有过渡引用 `--dur-*` / `--ease-*`，不允许裸毫秒值 —— 现在由测试守着（§11.6）。
2. **交互反馈不改变布局**：按压用独立 `translate` 属性下移 1px（而非 `transform`，避免覆盖组件自身 transform，
   如 `.toast` 的 `translateX(-50%)`），禁用用 `opacity: .45` + `cursor: not-allowed`（`global.css`）。
   唯一的例外是 §3.0 的"标题区下内边距"，它发生在页面顶部、幅度 4px，不会推动滚动锚点。
3. **动画属性只用 `transform` / `opacity`**（颜色、`border-color`、`box-shadow` 这类 paint 属性可以用；
   不要动 `width` / `height` / `top` / `left` / `margin`）。既有例外：侧栏宽度过渡、番茄钟进度条的宽度推进。
4. **不允许常驻 `will-change`**。
5. **列表交错有上限**：`calc(var(--i) * var(--dur-stagger))`，最多 8 行参与，且**只给"本次新增的行"**
   —— 滚动进入视口的行永远不播（虚拟列表滚动会不断重挂载，那会变成"滚动到哪都在闪"）。
6. **悬停聚焦淡化**：与当前悬停对象无关的图元淡到 `opacity: .05`（Obsidian 取值，保留一丝轮廓当上下文），
   图谱/工作流共用（`global.css`）。**这个值被 E2E 断言盯着，不许改。**

### 11.2 降级：三档 + 两类

| 档位 | 触发 | 效果 |
| --- | --- | --- |
| `full` | 默认 | 完整体验。注意 `data-motion` 写的是**空串**，不是 `'full'` |
| `essential`（仅必要） | 设置里选「仅必要」，或系统开了「减少动态效果」 | 7 档时长缩短到 80–120ms（`theme.ts` 的 `MOTION_DURATIONS` 行内铺） |
| `none` | 设置里选「关闭」 | 7 档时长全归零（`tokens.css` 的 `[data-motion='none']`） |

除动效档位外还有两类独立降级：

- **玻璃拟态**：`glass_enabled=false` → `html[data-glass='off']` → `--glass-filter: none`；
  系统 `prefers-reduced-transparency: reduce` 同理（§2.10）。
- **JS 驱动的动效**（列表交错、数字滚动、退场、滚动抬升）：无法靠 CSS 变量归零，
  必须读 `lib/presence.ts` 的 `isMotionFull()`。
  **判定一律用它，不要写 `dataset.motion === 'full'`** —— full 档存的是空串，那个条件永远为假。

### 11.3 浮层动效语言（`global.css`）

四组语义化的"进/退"配对，加上两条配套线。所有浮层都必须从这里取，不许各写一套：

| 语义 | 进入 | 退出 | 用在哪 |
| --- | --- | --- | --- |
| 弹出菜单 | `pop-in` `--dur-fast` / `--ease-enter` | `pop-out` `--dur-instant` / `--ease-exit` | 优先级、状态、标签、日期时间选择器 |
| 遮罩 | `mask-in` `--dur-fast` | `mask-out` `--dur-fast` / `--ease-exit` | `.modal-mask`（只动 opacity —— 它铺满全屏，缩放会露边） |
| 模态 / 命令面板 | `dialog-in` `--dur-normal` / `--ease-enter` | `dialog-out` `--dur-fast` / `--ease-exit` | 只给**带遮罩**的弹框；独立窗口的卡片不参与（窗口本身就是卡片，再缩放像"窗中窗"） |
| 抽屉 / 卡片 | `drawer-in` `--dur-panel` / `--ease-panel`；`card-in` `--dur-normal` | `drawer-out` / `card-out` `--dur-fast` | 窄窗抽屉、提醒卡、信息条、危险横幅、番茄钟 |

这条语言之前是不存在的：全应用只有 3 个关键帧，其中 `toast-in`（从下 8px + `translateX(-50%)`）
被 6 处共用 —— 那半个宽度是为居中 Toast 写的，套在菜单上就是"弹出来瞬间整块往左跳"。

### 11.4 退场机制（`lib/presence.ts`）

CSS 只能对仍然存在的元素播放动画，而 React 的条件渲染在 false 的那一刻就把元素摘出 DOM ——
所以在此之前**所有浮层都没有退场**（`--ease-exit` 因此零引用）。

`usePresence(present, exitMs)` 把"想不想显示"变成带退场窗口的"要不要渲染"，两条口径必须守住：

1. **动效不是 full 档时同步卸载**，不等待动画（否则关掉动效后弹层还要多留 250ms）；
2. **必须有兜底定时器**（`exitMs + 100ms`）：`duration: 0ms` 的动画不保证派发 `animationend`，
   没有兜底的话动效关闭时弹层会永久留在 DOM 里。

配套约定：所有 `.is-leaving` 规则都要带 `forwards` —— 兜底卸载比动画晚 100ms，没有终态保持的话，
那 100ms 里浮层会"淡出完又亮回来"。

### 11.5 性能预算（2026-09-27 首次量化）

| 项 | 预算 |
| --- | --- |
| 动画属性 | 只用 `transform` / `opacity`（例外见 §11.1 第 3 条） |
| 单次交互动效总时长 | ≤ 400ms（常规 150–280ms） |
| 同帧动画元素 | ≤ 40 |
| 列表 stagger | ≤ 8 项 × 20ms（总延迟 ≤ 160ms） |
| 虚拟列表滚动期间 | 不播放任何进入动画 |
| 页面帧率 | 切页后的 1.2s 采样窗口内平均 ≥ 50fps |
| 长任务 | 采样窗口内 > 50ms 的任务数 = 0 |
| `backdrop-filter` | 只允许出现在白名单选择器上（§11.6） |

采样脚本：`node scripts/motionperfcheck.mjs`（走 CDP，需先 `npm run build`）。

### 11.5b 共享元素过渡（试点，2026-09-27）

列表行的标题 → 编辑弹窗的标题输入框：打开编辑器时标题"长成"那个输入框，而不是整页淡一下。

| 项 | 做法 |
| --- | --- |
| 用在哪 | **只接一个入口**：从列表行点开编辑。看板卡 / 四象限 / 右键菜单都没有同名的源元素，强行参与只会退化成整页交叉淡化，白付一次全页快照的代价 |
| 技术 | `document.startViewTransition` + `flushSync` 分两段提交：先给源行打 `view-transition-name`（旧状态），回调里同步打开弹窗并**摘掉**源行标记（新状态） |
| 名字唯一 | `view-transition-name: task-title` 同一时刻只能有一个元素带 —— 同名两个会让浏览器直接跳过整条过渡（见 tasks.css 的 `.trow--vt-source` / `.vt-task-title`） |
| 时长 | `::view-transition-group(task-title)` 用 `--dur-normal` / `--ease-panel`；根快照的交叉淡化压到 `--dur-fast`（默认的整页 250ms 对"打开一个弹窗"太重） |
| 降级 | `isMotionFull()` 为假、或浏览器不支持时**直接 setState**，一帧动画都不播 |

### 11.6 令牌完整性（一条会红的测试）

`src/renderer/src/styles/tokens.test.ts` 钉住三件事，起因是两处**静默失效**的真实缺陷
（`--ease-standard` 从未定义、`--space-6` 从未定义，各让一整条声明在计算值阶段失效）：

1. 无 fallback 的 `var(--x)` 必须有定义（CSS 里定义，或由 JS 内联注入并登记在白名单）；
2. 白名单里的名字必须真的被 JS 注入过（否则白名单会变成掩盖缺失的废纸）；
3. `transition` / `animation` 里不许出现裸时间值；
4. `backdrop-filter` 只能出现在白名单选择器上。

变异验证：删掉 `--space-6`，第 1 条必须变红。

---

## 12. 交互缺口清单（按可闭合成本排序）

| 优先级 | 缺口 | 现状证据 | 影响 |
| --- | --- | --- | --- |
| 高 | 完成撤销无 `prev_status` | `App.tsx` 盲目 `toggleTask` | 从 done 撤销会落到 todo，不是原状态 |
| 高 | 关窗前不落盘 | `NotesPage.tsx` 无关窗钩子 | 防抖窗口内编辑丢失 |
| 高 | `window.confirm` 15 处未迁移 | 见 §9.1 | 原生框与自绘界面割裂 |
| 中 | 「移动到清单」无入口 | `preload/index.ts` 零调用 | 清单体系半可用 |
| 中 | 闪念转子任务 / 转笔记指定目录无入口 | `preload/index.ts`、`InboxPage.tsx` | 后端能力浪费 |
| 中 | 无 MRU、命令集少 | `CommandPalette.tsx` | 高频操作多两步 |
| 中 | `calendar_show_done` 在日历无效 | `CalendarBoard.tsx` | 设置项失效 |
| 中 | 富文本无编辑器、Office 只读 | `NotesPage.tsx`、 | 格式体系半可用 |
| 低 | 边缘缩放、FloatingDock、splash | `src/main/index.ts`；全仓无 dock/splash | 平台体验细节 |
| 低 | 换主题不改托盘图标 | `src/main/index.ts` | 视觉不一致 |
| 低 | 图谱页未订阅 `flash` 域 | `GraphPage.tsx` | 闪念变化不刷新图谱 |

---

## 14. 工作流画布：分层布局（对照 AntV F6 的 Dagre 流程图）

工作流的图结构是**隐式**的 —— 没有边表，只有两处约定：**顺序边**（`order_index` 相邻即先后）
与**分支边**（`node → node.branch_node_id`）。画布把它们投影成 dagre 的有向图后分层布局。

| 能力 | 行为 | 证据 |
| --- | --- | --- |
| 自动布局 | 按依赖关系分层、层内排序减少交叉、节点尺寸参与计算（所以不重叠）；条件分支会落到与主线**不同的层**。**回边（如「满足 → 回到第 1 步」）不参与分层** —— dagre 消环时会反转其中一条边，实测它反转主干边、导致整张图上下顺序与流程相反；改 `ranker` / `acyclicer` / 边的 `weight`、`minlen` 都改不动，所以布局数据里只放前进边、算完坐标再把回边补上（`syncLayout` 两趟） | `lib/workflow-layout.ts`、`npm run test` 的布局单测、端到端实读节点 y 坐标 |
| 布局方向 | 工具栏「纵向 / 横向」一键切换并立即重排；选择记在 localStorage | 纵向 5 层 / 横向 5 列，均 0 重叠（端到端实测） |
| 画布基准 | 随布局结果伸缩，并在基准变化后统一适配一次视图 | `layoutBounds` + 监听基准的 effect |
| 分支条件文案 | `condition` 画在分支**起点旁** 30px（起点附近一定是空的），单独一层画在所有节点之上（否则会被节点盒盖住）。**分支已由条件节点独立承担**，步骤编辑器不再提供「进入条件 / 条件分支到」；旧模板里遗留的 `condition` 仍照旧渲染 | 端到端截图中两个标签均清晰可读 |
| 图谱建链 | 两种方式：① **点选式**（G6 迁移后改为点起点→点终点；原先的「从节点手柄拖出」随手写 SVG 一起移除）（hover/选中时节点右侧浮现手柄，按住拖到目标节点即建链，落在空白给出回执）；② 选中后按侧栏「从此节点连线」→ 点目标。手柄是节点的子元素并 `stopPropagation`，所以「拖节点」与「拉连线」互不干扰 | 端到端：25 → 26 条边、虚线无残留 |
| 新增入口 | 工具栏「**加条件**」直达条件配置（动作预置为条件判断、标题预置「条件判断」），不必先加一步再改动作类型；图标用菱形，与画布上条件节点的形状一致 | 端到端：点击后出现条件编辑区，保存即得菱形节点 |
| **条件节点** | `action_kind='condition'`：画成**橙色菱形**，**不建任务**、到点自动求值 —— 成立走 `branch_node_id`、不成立走顺序下一个；配置存 `action_value` 的 JSON（`src/shared/workflow-condition.ts` 两端共用） | 两条推进路径均端到端验证 |
| 步骤动作三类 | **任务**（实例化时生成待办，人工勾选后推进）／**命令**（一行命令，shlex 拆 argv 后不经 shell 直接跑）／**脚本**（多行脚本，运行环境四选一，见下）。历史值（`none`/`open_url`/`open_note`/`run_command`）在编辑器里显示为只读历史项、按「任务」处理，不影响旧模板继续跑 | 端到端 26/26；弹窗下拉只列三类 |
| 脚本的运行环境 | **PowerShell / CMD 批处理 / Python / JavaScript(Node)** 四类，必须显式选（同一段内容在四类语法下含义完全不同）。除 cmd 外都把脚本文本从**标准输入**喂给解释器（PowerShell 的 `-Command -` 还顺带绕开 ExecutionPolicy 对 `.ps1` 的限制）；cmd 没有「从 stdin 读脚本」的正规做法，改写一个临时 `.cmd` 再执行。解释器按候选依次尝试（PowerShell：`powershell.exe`→`pwsh`；Python：`python`→`python3`→`py`），找不到时把「试过哪些」写进失败信息 | 四类各测一次退出码：PowerShell exit 4 / CMD exit 6 / Node exit 9 全绿；本机无 Python，验证的是「已尝试 python / python3 / py」这条报错 |
| 自动步骤的推进 | 命令 / 脚本**不生成待办**：实例跑到它们时由主进程的「泵」直接执行，**等进程退出**、核对退出码，正确才自动推进到下一步（多步连续则一路跑下去）。运行中 / 失败的实时状态写在 `workflow_instance.last_result`，由主进程主动广播刷新 | 命令 exit 7 == 期望 7 → 自动落到下一步人工任务 |
| 失败即停 | 返回值不对就**停在当前节点**（不推进、不吞错），实例仍是 `running`；页面上给出状态与「重试该步」按钮原地重跑。超时（120s）用 `taskkill /T` 收整棵进程树 | exit 3 期望 0 → failed/3、0 个后续任务 → 重试时间戳更新 |
| 结果传给下一个节点 | 每次节点执行（含人工任务完成）都把结果写进实例上下文；条件来源「**上一步结果**」读它判定：填了退出码按退出码判、没填才看成功与否。条件节点自身不产生结果，所以串联的条件看到同一个上一步 | 命令成功 → 条件「上一步成功」成立 → 走分支（跳过顺序下一步） |
| SOP 多绑定 | 一个步骤可绑**多条** SOP 文档（`note_ids` JSON 数组），下发任务时全部写成备注里的 `[[链接]]`；`note_id` 作为兼容列同步为第一条，旧单值数据读回来仍是一条 | 两条笔记 → 任务备注 2 个 wikilink |
| 注入条件的四种来源 | ① **提示确认**：主进程模态确认框；② **任务状态**：查目标任务是否已完成（下拉选真实任务）；③ **脚本返回状态**：独立进程运行并**比较退出码**（不经 shell、15s 超时）；④ **上一步结果**：读上一个执行节点的返回值（命令/脚本看退出码、人工任务看是否完成） | exit 0 → 成立；exit 1/7 → 不成立 |
| 连线走线 | **正交折线 + A\* 避障**：G6 内置 `polyline` 边配 `router: { type: 'shortest-path', enableObstacleAvoidance: true, gridSize: 10, maximumLoops: 50000 }`，在节点包围盒之间搜一条不穿节点的折线（搜不到才回退普通正交路由）。⚠️ 三个参数缺一不可：默认 `enableObstacleAvoidance` 是 **false**（障碍物只算两端节点）、默认 `gridSize: 5` 太细导致搜索在 `maximumLoops: 3000` 内走不到终点而**静默回退正交路由** —— 表现就是「线照样穿节点」。节点上**不留固定连接点**，端点由 G6 按连线方向自动取边框交点；分支语义写在**边上的标签**（满足 / 不满足 / 跳到）。知识图谱走 `cubic` 三次贝塞尔 + 方向箭头 | 端到端截图：连线绕开节点 |
| 预览框（**仅手写 SVG 时代**；G6 路径下节点是 canvas 上的 HTML，不再有 foreignObject 浮卡） | 基准尺寸要给右侧浮卡留位置 —— 否则「右边放不下就左翻」会误判、把浮卡压到节点上（看起来像两层边框）；拖动节点期间不渲染浮卡（`foreignObject` 会留拖影） | 浮卡在节点右侧；拖动中浮卡数 0 |
| 首次打开 | 用户拖过的坐标（`pos_x/pos_y`）优先，没拖过的用分层结果补齐 | `layoutOf` |
| ~~**布局飞位**（2026-09-27）~~ **已移除**：随手写 SVG 画布一起删掉；G6 路径下位置变化即时生效（切方向的重排另见下方注） | 原行为： 自动布局或切「纵向 / 横向」之后，节点在 `--dur-panel`/`--ease-panel` 内**飞**到新坐标而不是瞬移 —— 用户看得见「谁挪到了哪儿」。定位仍走 SVG 的 `transform` **属性**（`wfbranchcheck.mjs` 直接读它），所以补间用 Web Animations + `fill:'none'`：动画一结束立刻回到属性里的权威坐标，拖拽 / 平移缩放 / 命中检测全程拿到的都是最终值。拖动节点期间不插补间（跟手才是对的）；`reduced` / `none` 档直接跳过 | 端到端跑 `workflowcheck` 与 `motionperfcheck` |

> **本节中与渲染/交互有关的行描述的已是历史**（2026-10-06 完成 G6 迁移）。现在节点是 G6 内置的
> `rect` / `diamond`（角标、条件判据、标题分别走 `badges` 与 `labelText`），连线是内置 `polyline`
> 加 A\* 避障路由，拖拽 / 选中 / 悬停 / 右键菜单全部是内置行为 —— 见 `components/WorkflowCanvasG6.tsx`
> 与 `docs/specs/g6-migration-status.md`。布局用 G6 内置的 `antv-dagre`；`@dagrejs/dagre` 另用于
> 「自动布局时把新坐标落库」。本节保留的行（条件节点、动作三类、脚本环境、失败即停……）都是**业务语义**，仍然有效。

## 15. 图谱节点图标（多色分层）

节点图标原本是**单色实心**（一个 fill 的星形/闪电/便签），小尺寸下只剩一个色块，既没层次也读不出类型。
现在每类都是 2~3 个图层，颜色由节点主色**派生**而来：

| 图层 | 取色 | 作用 |
| --- | --- | --- |
| 基底 | 节点主色（由 `colorOf` 决定） | 保持既有的「文件夹调色板 / 类型固定色」语义 |
| 内层 | `mix(主色, 0.38, --bg-layer-solid)` | 折角、选项卡、内圈 —— 造出切面 |
| 细节 | `mix(主色, 0.22, --fg-primary)` | 文本线、加号、中心点 |
| 描边 | `mix(主色, 0.40, --bg-canvas)` | 深色底上也能看出形状边界 |

形状按语义强化：笔记＝便签 + 折角 + 文本线；任务＝星里嵌圆与中心点；闪念＝叠一层内闪电；
段落引用＝双菱形 + 内核；待建链接＝虚线环 + 加号；文件夹＝深浅两片。

> 这套颜色原先由 CSS 派生（`graph.css` 的 `.gnode__icon` + 组件注入的 `--gnode-c` 跑 `color-mix()`）。
> G6 迁移后节点跑在 canvas 上，**那里既不认 CSS 变量也不认 `color-mix()`**，于是公式原样搬进
> `lib/graph-icon.ts`（`mix()` + `toneAttrs()`）：颜色算好**内联进 SVG**，再转 data URL 交给节点的
> `iconSrc` —— 换主题包、换强调色、换文件夹调色板同样不需要动图标代码。
>
> canvas 特有的两条坑都踩过：① `knowledgeColor()` 返回的是 `var(--danger)` 这类 CSS 变量字符串，
> 直接写进 SVG 会解析失败并**静默变黑**（同一张图里星形是好的、文档图标全黑，就是这个差别暴露的），
> 必须先经 `resolveColor()` 解成实色；② 描边那一档必须**同时给 `fill`** —— 原来 CSS 里主图形挂的是
> `gn-stroke gn-s1` 两个类，只照字面写 stroke 的话 SVG 的缺省填充就是黑色。

## 16. 笔记 AI 整理（大模型解读 / 归纳 / 归类）

一次整理的全链路（`src/main/ai.ts` 编排，`src/shared/ai-note.ts` 定义与审计）：

| 阶段 | 行为 | 说明 |
| --- | --- | --- |
| 取数 | 读笔记正文 + 全部文件夹路径 | 只支持 Markdown / 富文本；Word/Excel/链接格式直接拒绝 |
| 占位 | 图片与本地文件引用换成 `@@IMG1@@` / `@@FILE1@@` | **二进制不上传**；模型只知道「这里有一张图」，返回后按标记原位填回 |
| 提示词 | 变量渲染：`{{FOLDERS}}` `{{TITLE}}` `{{FORMAT}}` `{{ATTACHMENTS}}` `{{CONTENT}}` | 设置页可编辑；缺 `{{CONTENT}}` 直接拒绝请求（模型拿不到正文，跑了也是白跑） |
| 请求 | 三家协议：OpenAI 兼容 / Anthropic / Gemini | 主进程发出（渲染层拿不到 Key）；超时可配，默认 120s |
| 审计 | 双链、外链、附件标记、篇幅逐项核对 | **error 一律拒绝写库**；warn 只提示（如「模型把占位符写成了原始内容」） |
| 归类 | 模型给路径 → 逐级「有就复用、没有就新建」 | 同级同名不唯一，按父级路径定位；新建的路径回给界面提示 |
| 入库 | `saveNote`：正文变更前自动留版本快照 | 整理不满意可在笔记历史里回滚 |

> **为什么审计是硬闸门**：模型有概率丢内容，而笔记是用户的唯一正本。
> 宁可这次不写、把「丢了哪一张图、丢了哪个链接」列出来，也不能悄悄少一段。
> 唯一放行模型「自作主张」的情形是它把原始片段一字不差地抄了回来 —— 内容确实没丢，
> 只记一条提醒。
>
> 提示词模板里的变量名是**契约**：设置页把它们列出来，主进程渲染时替换，
> 少了 `{{CONTENT}}` 就拒绝请求 —— 避免用户改坏提示词后拿到一个「模型在瞎聊」的结果。

### 16.1 整库整理

笔记工具栏的「整理全库」会把**所有 Markdown / 富文本笔记**逐篇交给同一套链路：

| 决策 | 原因 |
| --- | --- |
| **串行**，一篇好了再下一篇 | 并发打请求最容易撞限流，而整理本来就是慢活 |
| **文件夹每篇现读** | 前一篇新建的目录，后一篇立刻就能复用 —— 否则整库会造出一堆同义目录 |
| **每篇独立审计** | 某一篇没过审计只记它失败，不影响其余；失败清单带回去 |
| **空正文跳过** | 没必要为一次空请求花掉额度和时间 |
| **只处理 markdown / richtext** | Word / Excel / 链接笔记的正文是文件路径或 URL，交给模型没有意义 |
| **可停止** | 停止只影响「下一篇」；已经发出的那一篇会跑完入库（请求已经花掉了） |
| 启动前确认 | 对话框里给出**篇数** —— 整库可能是几百篇、要跑很久，这个数字必须先看见 |

进度通过主进程事件逐篇推给所有窗口（`ai:libraryProgress`），界面上的按钮同时兼作停止与进度显示
（`停止整理（3/42）`），每篇落库后广播 `note` 域让笔记树与图谱跟着刷新。

（按钮位置：整库整理是**树级别**的操作，所以它挂在笔记树的搜索框下方，而不是编辑器工具栏。）

### 16.2 三种笔记类型分派同一份提示词

| 类型 | 交给模型什么 | 回来后做什么 |
| --- | --- | --- |
| Markdown / 富文本 | 抽掉附件占位符后的**完整正文** | 两道审计 → 还原占位符 → 写回正文 / 标题 / 文件夹 |
| Word / Excel | **只有标题**（正文在 .docx / .xlsx 里，库里没有） | 只更新文件夹与标题，`content_md`（文件路径）一个字都不动 |
| 链接笔记 | 一组「标题 + 链接」（`[{title,target}]`，可编辑多条） | 按模型给的 `into` 逐条分配：留本笔记 / 追加到已有链接笔记 / **新建**一篇链接笔记（放在同一文件夹，同 url 去重） |

链接笔记的审计是独立的：原文里**每一条链接**都必须在返回的 `links` 里有去向，漏一条就拒绝写库。
写库顺序也刻意是「先目标、后本笔记」—— 中途失败时本笔记仍保有全部链接，不会凭空少一条。

### 16.3 整理完主动修关联

笔记被改写后，两类跨实体关联会悄悄失效，落库后必须立刻修：

| 关联 | 为什么会断 | 怎么修 |
| --- | --- | --- |
| 任务备注里的 `[[旧标题]]`（`task.notes_md`） | 标题被 AI 优化过，字面引用就悬空了 | 字面替换成新标题；同一次操作能同步多条 |
| 任务关联的段落锚（`task_note_context.block_key`） | 指纹 = 段落文本的 sha1，正文一变全部对不上 | 用旧 `snippet` 在新正文里找回最相似的一行重算指纹；找不回来就**保持原样**（宁可锚不动，也不指到无关文字上） |

> 指纹算法因此从渲染层提到了 `shared/block-fingerprint.ts`：主进程必须能算同样的值，
> 才能把锚重新对上。`note_link.dst_title`（笔记之间的双链）不在这里处理 —— `saveNote`
> 改名时已经同步过了。

### 16.4 两份提示词

| 设置项 | 用途 |
| --- | --- |
| `ai_prompt` | 单篇整理（也含整库的默认）；变量：`{{FOLDERS}}` `{{NOTES}}` `{{TITLE}}` `{{FORMAT}}` `{{KIND}}` `{{ATTACHMENTS}}` `{{CONTENT}}` |
| `ai_library_prompt` | 整库专用；**留空即表示与单篇那份相同**（想批量时更保守，就在这里单独写一份） |

## 13. 设计交付物索引

| 交付物 | 位置 |
| --- | --- |
| 令牌真源 | `src/renderer/src/styles/tokens.css` |
| 全局基础样式（重置/焦点/滚动条/原子类） | `src/renderer/src/styles/global.css` |
| 主题包数据 | `src/shared/theme-packs.ts` |
| 主题应用与对比度校正 | `src/renderer/src/theme.ts`、`src/shared/color.ts` |
| 对比度实测报告脚本 | `scripts/contrast-audit.mjs` |
| 主题/令牌回归 | `scripts/themecheck.mjs`、`src/shared/theme-packs.test.ts`、`src/renderer/src/theme.test.ts` |
| 布局回归 | `scripts/layoutcheck.mjs` |
| 交互回归 | `scripts/interactioncheck.mjs` |
| 视觉快照 | `scripts/capture.mjs`、`scripts/bigcapture.mjs` |

## 17. 独立弹窗与确认交互（2026-09-19）

- **独立小窗**：条件确认、捕获面板都跑在 `frame:false + transparent` 的独立 BrowserWindow 里，屏幕上只有一张圆角卡片：没有原生标题栏、没有窗口底、四角透明；卡片头部 `.modal__head` 设为拖拽区（`-webkit-app-region: drag`）；**不显示主窗口** —— 用户按热键时正在别的应用里选词，不该把他拽回来。
- **卡片即窗口**：窗口高度由渲染层 ResizeObserver 量出卡片高度后经 `window:fitHeight` 回传，窗口跟着内容缩胀（宽度不变），不留底部空白。
- **确认弹框**：全部收回应用内（`dialog.confirm`），标题左侧圆形底色图标（危险=红、覆盖 / 回滚 / 执行=橙、其余跟强调色）；危险操作按钮用 `text-btn--danger`。
- **工作流侧栏**：分类 → 模板两层树，行 hover / 键盘聚焦时出胶囊（分类：在此分类下新建工作流 / 新建子分类 / 重命名 / 删除；模板：重命名 / 复制 / 删除）；实例行有「重命名实例」「执行详情」胶囊。
- **外部同步卡片**：6 个 JSON 路径输入框 + 列表路径 + 「按标题去重」开关 + 「立即同步」与上次结果。
- 回归脚本：`selectioncheck.mjs`、`condwincheck.mjs`、`wfgroupcheck.mjs`、`tasksynccheck.mjs`、`aiui.mjs`、`seedmonitor.

---

## 18. 树形控件的路径跟踪（2026-09-27）

任务清单树、笔记树、工作流模板树统一有了「从父到子」的虚线跟踪：每行在自己所在的缩进区画一条**竖向点线**，并在当前层级补一小段**横向连接线**。默认开，**设置 → 外观 → 树形路径跟踪**可关。

| 项 | 做法 |
| --- | --- |
| 缩进从哪来 | 三棵树的缩进都是渲染时算的 `padding-left`，所以行上注入 `--tree-depth`（层号）与 `--tree-step`（每层多少 px：清单 12、笔记与模板 14），CSS 用 `calc(depth × step)` 反推缩进区宽度 |
| 画在哪 | `::before`（竖点线）/ `::after`（横向连接线）。**不能用行自身的背景图** —— 行的 hover 写的是 `background` 简写，会把背景图一起清掉，鼠标划过去虚线就断一节 |
| 点线怎么来 | `linear-gradient` 画 1px 竖线 + `background-size: step 4px` 纵向重复 |
| 根行 | 行上带 `data-depth`，`[data-depth='0']` 不画连接线（根没有"从父节点过来"的路径） |
| 关闭 | `html[data-tree-guide='off']` 时整套选择器不命中（与玻璃拟态同款：只在关闭时才写属性） |

## 19. 工作流实例的执行详情（2026-09-27）

实例列表每行多了「执行详情」（`History` 图标，`aria-expanded` 表示展开态）：就地展开一条**节点级时间轴** —— 每一步什么时候跑的、结果如何、实例现在停在哪、起止时间。

- **数据**：`workflow_run_log`（`SCHEMA_VERSION` 13 起）。原先只有 `workflow_instance.last_result` 一个字段，存的是**最近一次**节点结果 —— 那是给下一个节点（条件判定）读的，实例跑完就只剩最后一步的痕迹，回答不了"这次运行每一步怎么样"。
- **写入点**：`advanceInstance` 记 `enter`（进入节点，区分「已派待办」与「自动节点」）与 `finish`（流程走完）；`pumpInstance` 在执行完自动节点后记 `done`（带结果摘要，失败时带退出码）。日志写失败只打 console，不影响流程本身。
- **读取**：`db:workflowRunLog` → `listWorkflowRunLog`，按 `id` 正序（时间轴天然有序，不需要前端再排）。
- **时刻格式**：同一天只显示 `时:分`（跑一次看秒没有意义），跨天带上 `月-日`；数字列用 `font-variant-numeric: tabular-nums` 对齐。

## 20. 一轮 UI 修复（2026-09-27）

### 20.1 完成态对号居中（`.check::after`）

旧写法把 `left/top` 写死成 `(4px, 1px)`，且 `transform-origin: left center` —— 旋转中心落在勾的**左下角**，45° 转完整体偏左上，肉眼就是「对号不在正中间」。现在 `left/top: 50%`、`transform-origin: center`，`rotate` 与 `scaleX` 都绕自身中心（展开动画因此变成从中间向两端画）。

最终值 `translate(calc(-50% - 0.7px), calc(-50% - 1.2px))` 是**放大 8 倍量出来的**：纯几何居中之后，勾的包围盒中心仍比圆心右 0.67、下 1.25（L 形绕中心转 45° 的残差），减掉即正。

> **一段值得记的弯路**：中间有一版按公式加了 `+1.8px` 的"包围盒补偿"（理由是转 45° 后包围盒中心会偏），结果**方向正好相反** —— 用户看到的"偏右下"就是那一版。教训是：这种亚像素级的视觉对位，公式只能给个起点，**最终必须以放大截图的实测为准**，而且改完要回看一张新图，不能凭推导收工。

### 20.2 Word 笔记的间距与其他格式统一

| 段 | 统一前 | 统一后 |
| --- | --- | --- |
| 标题行 ↔ 工具栏 | markdown/excel/link 0、richtext 4、**word 12** | **4**（`--space-1`） |
| 工具栏 ↔ 正文首行 | markdown 12、richtext/word **26** | **12**（`.sheet__body` 4 + 编辑器 8，docs 里既有的刻意值） |

根因不是「Word 专属规则」，而是容器内边距叠加：Word 多套一层 `.editor__office-body`（`padding: 8px 0 16px`）再叠 8px；ProseMirror 的首个 `<p>` 又吃到浏览器 UA 的 `margin-block: 1em`（≈13.5px），同一条工具栏下面差出一整行。

处理：Word 变体内边距归零、`.rt-editor__body .ProseMirror > :first-child { margin-top: 0 }`、标题行那 4px 的来源从 `.tb__head` 的 padding 换成下一段的 `margin-top`（**头部总高不变、Markdown 的视觉逐像素不变**，只把原本多一档的富文本/Word 收紧 4px）。
**Excel 不跟着改**：它的 8/16px 内边距是必要的（ag-grid 没有自带内边距）。实测 Word 正文可用高 557 → 585（+28px），五种格式现在完全一致。

### 20.3 笔记类型：标题行只读胶囊

`<span class="chip chip--type">`（图标 + 名称）：外形复用 `.chip--count` 那份「只读陈述」，颜色复用笔记树的 `.ntree__type--*` 色阶，名称与图标来自同一份 `noteIcon` 映射。**不是 button、无 onClick、`tabIndex=-1`**，`title` 说明「类型在新建时决定」。编辑区里已无任何类型切换入口（新建时的格式菜单仍留在笔记树）。

### 20.4 工作流节点文字按像素自适应

SVG 的 `<text>` 既不换行也不缩放，超出的部分直接画到节点框外。旧写法按「字符数 > 10」截断 —— 一个汉字宽度约等于两个西文字母，10 个汉字加一个全角标点就能顶出框。

现在 `fitNodeText()` 按**像素**算：12px 起、放不下逐档降到 10px，仍放不下才截断加省略号；条件描述同一套（9 → 8px）。截断后 `<title>` 给原生 tooltip 看全文。

> 配套约束：`.wf-node__title` 的 `font-size` **必须从 CSS 里删掉** —— CSS 会盖过 `<text fontSize>` 属性，留着它自适应就失效（这条写进了样式文件的注释里）。

**条件节点要再收一档**：它画在**菱形**里，而菱形只有中间最宽处才有整框宽度，上下两侧迅速收窄 —— 按
`NODE_W - 22` 排出来的文字会在四个斜边处顶出去。所以条件节点另用 `COND_TEXT_W = NODE_W × 0.6`，
文字只落在菱形的"腰部"。

### 20.5b 到期提醒：不再提醒、状态与原因、活动时间轴

提醒卡现在只有一个实现：`components/ReminderCard.tsx`。它有两个宿主 —— 悬浮球旁边的气泡（`ReminderApp`，主呈现）与主窗口兜底的卡片（`ReminderPopup`）—— 原先两处各写了一遍、按钮文案还不完全一样，加功能时这种重复立刻变成两倍成本（护栏也一并改成"卡片用 `.modal`、两个宿主渲染这张卡"）。

| 能力 | 做法 |
| --- | --- |
| **不再提醒** | 与「知道了」共用同一套消费（清 `reminder_at`、把本轮计数推到用完），活动流里记 `mute` 与「知道了」区分开。**只对这一次生效**：以后重新设了提醒照样会响（按钮 title 里写明） |
| **状态设置** | 五个状态胶囊排一行，点中就地展开原因输入 —— 不叠第二层浮层（项目一贯做法）。原因可选，回车提交 |
| **改状态即处理完** | 改状态成功后顺手消费掉这条提醒：用户点「进行中」说明他已经在想这件事，再要求点一次「知道了」是多余动作 |
| **活动流** | `task_activity`（SCHEMA_VERSION 14）：`remind` / `snooze` / `dismiss` / `mute` / `status` 五类。写入点**全在主进程**（所以从哪个窗口处理都会记账），写失败只打 console —— 它是旁路，不该让提醒派发整个失败 |
| **速览的时间轴** | `.inspector` 新增「活动记录」卡，读 `db:taskActivity`（按 id 倒序，默认 5 条 + 「展开全部」）。样式 `.tl*` 与工作流执行详情的 `.wf-runlog*` 是同一套读法：左侧点线 + 「时刻 / 分类 / 说明」三列，原因另起一行加引号 |

> **一处刻意的"不一致"**：玻璃拟态只给**带遮罩的模态**上玻璃（`.modal-mask .modal`）—— 那时背后才有可模糊的页面内容。提醒气泡跑在**透明窗口**里，背后是桌面，而且透明窗口里的 `backdrop-filter` 容易在窗口边界留下残影，所以它的卡片保持**不透明底**。主窗口那张提醒卡浮在页面上、不在遮罩里，同样不走玻璃。
> `reminderstylecheck` 原先断言"提醒卡与弹框底色逐字相同"，玻璃拟态之后这条不再成立，已改成分别断言「提醒卡/气泡卡是不透明底」「对照弹框走玻璃」——
> 真正要守的是"卡片读得清"，而不是"两个不相干的层用了同一个色值"。

### 20.4b 展开 / 折叠图标：全应用一套

工作流模板树的展开图标原先与笔记树不一致：它用 `size={13}` + `--fg-tertiary`，**并且自己写了一层 `transform: rotate(90deg)`**，而笔记树 / 任务行用的是同一个 **16px 盒子** + `--fg-secondary`，靠 morphicons 在 `ChevronRight ↔ ChevronDown` 之间**形变**过去。结果有两处不对：同一屏里它看着小一号、淡一档；工作流那层 CSS rotate 还会和形变**叠加成转两次**。

现在两边完全同一套：16px 盒子、`--fg-secondary`、同一位置换图标交给形变，CSS 里不再有 rotate。

### 20.4c Markdown ↔ Word 切来切去后正文空白（bug）

**现象**：Word 笔记的正文区偶尔是空的（DOM 里只剩 `<p class="is-empty is-editor-empty">`），再点一次这篇笔记就恢复。

**根因**在 `components/RichTextEditor.tsx` 那个"外部 html → 编辑器"的同步 effect，它的第一句是：

```ts
if (!editor || editor.isFocused) return
```

这个守卫的**本意**是"别在用户打字时把内容顶掉"，但它把**外部真的换了内容**也一起挡了：切换笔记时 React 复用同一个编辑器实例、ProseMirror 的焦点仍在里面，于是新笔记的 HTML（Word 是异步从 `officeDoc` 取回来的）永远进不来。用户"再点一次能恢复"，正是因为那次重建了实例、`isFocused` 归位。

**修法**是不再拿焦点当判据，而是区分**内容是谁产生的**：加一个 `lastHtmlRef`，
`onUpdate` 里把编辑器自己产出的 HTML 记进去；同步 effect 只在 `html !== lastHtmlRef.current`（= 外部换的内容）时才写入，且**无视焦点**。这样"用户打字时不被顶掉"与"换笔记必须换内容"两件事各自成立。

### 20.5 模板树：分类与模板项的字重

`<strong>` 的浏览器默认字重是 **700**，而 `.wf-node--group > strong` 只写了 600 —— 于是「模板项比分类还粗」，用户看到的正是「没有区分」。现在模板项 / 实例名显式压到 **400**，分类 **600** 且用 `--fg-primary`。mjs`。
