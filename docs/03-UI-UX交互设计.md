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
        PomodoroBar、InfoBar（--z-float）
        ReminderPopup（--z-reminder）、Toast（--z-toast）
```
```text
[笔记树 ntree]  |  [notes-main / editor]              |  [links 面板]
文件夹 + 笔记 |  editor__bar（标题输入 + 动作按钮）   |  反向链接 · N
新建/格式下拉 |  find-bar（Ctrl+F，role=search）      |  引用（正向）· N
              |  正文区（编辑器 / 预览 / Office / 链接） |  失效链接
```
# 03 · UI/UX 交互设计（Electron 实现）

> **文档对象**：知行 ZhiXing 的 Electron 重构实现（拆分后仓库 `zhixing-electron`）。
> **路径约定**：代码路径相对 **Electron 项目根**（当前工作区内为 `electron/`）。
> **事实基准**：`src/renderer/src/styles/`（11 个 CSS）、`src/renderer/src/**` 组件与页面、`src/shared/{color,theme-packs,settings}.ts`。
> 本文只描述 Electron 实现自身；与 Python 版外观口径的差异见 `04-与Python实现的差异点.md`（S6/S7/S10/S30 等）。

---

## 1. 设计原则与真源

1. **唯一真源**：`src/renderer/src/styles/tokens.css` 是设计的**唯一真源**（`tokens.css:1-5`）。组件样式一律引用语义变量，**禁止写死色值与圆角**。
2. **无 UI 框架**：不引组件库，全部自绘 CSS；好处是体积、可控性，代价是每个控件的状态要自己写全。
3. **语义优先**：变量名表达用途（`--fg-secondary`、`--bg-layer`、`--z-modal`），不表达具体颜色值。
4. **交互状态统一收口**：按压/禁用/焦点环在 `global.css` 一处定义（`global.css:33-63`），组件不必各写一遍。
5. **动效可降级**：所有时长走令牌，系统或用户关闭动效时全量归零（`tokens.css:151-173`）。

---

## 2. 设计令牌体系（`src/renderer/src/styles/tokens.css`，173 行）

### 2.1 色彩：语义色浅/深两套

| 令牌 | 浅色（`:root`，`:7-118`） | 深色（`:root[data-theme='dark']`，`:120-149`） | 用途 |
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

`color-scheme` 也随主题声明（`tokens.css:10`、`:121`）：不声明时「Windows 深色系统 + 应用浅色主题」会让输入框变深底深字。

### 2.2 14 套主题包与强调色正交

主题包是**数据驱动的 token 覆盖集**（`src/shared/theme-packs.ts:30-87`），每个包含 light/dark 两套共 15 个语义色（`ThemeColors`，`:7-23`）。

包名（14，`theme-packs.ts:89`）：冰川蓝、墨黑、奶咖棕、暖沙、暮色、柠檬黄、樱花粉、海盐蓝、莓果粉、薄荷绿、薰衣草紫、蜜桃橘、青竹、香芋紫。

- **强调色与主题包正交**（`theme.ts:37-40`）：换包不动用户选的强调色；设置页提供 8 色（`SettingsPage.tsx:19`）。
- 默认主题包是**青竹**（`src/shared/settings.ts:75`、`:117`）；`theme-packs.ts:91` 的 `DEFAULT_THEME_PACK = '墨黑'` 只在包名**无法解析**时兜底（`resolveThemePack`，`:93-95`），两者不冲突。
- 主题包 token → CSS 变量的映射集中在 `TOKEN_VARS`（`theme.ts:19-35`），新增主题包只需加数据、不必改代码。

### 2.3 对比度运行时校正（WCAG 2.1）

问题：主题包的文字色是按观感调的柔和色，对 `canvas`/`layer` 的对比度大量落在 2.4–4.5 之间（实测 168 组里 74 组不达标，辅助文字最低 2.36:1）。

做法（`theme.ts:49-68`）：应用主题时按与 Python 版同一套下限做**运行时校正**，而不是手改 168 个色值。

| 目标 | 下限 | 证据 |
| --- | ---: | --- |
| 正文 `--fg-primary` | 4.5:1 | `theme.ts:53` |
| 次要 `--fg-secondary` | 4.5:1 | `theme.ts:54` |
| 辅助 `--fg-tertiary` | 4.0:1 | `theme.ts:55` |
| 强调色**当文字**（`--accent-text`） | 4.5:1（对 canvas/layer/accent-soft 三者最差者） | `theme.ts:65-68` |
| 非文本图形（边框/指示条/图标） | 3:1（约定，见 `tokens.css:88` 注释） | `tokens.css:88` |

校正算法在 `src/shared/color.ts:70-81`：`ensureTextContrast(fg, backgrounds, minRatio)` 取背景中**最差**的一组作为约束，若已达标原样返回；否则沿单一方向混向黑/白（步长 0.05）直到达标，**保留色相**。

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

（`tokens.css:45-53`，注释显式声明「与 Python 版 `theme.COMPONENT_TOKENS` 对齐」。）

### 2.5 间距：4px 节奏

`--space-1: 4px` / `2: 8px` / `3: 12px` / `4: 16px` / `5: 24px`（`tokens.css:55-60`）。

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

运行时覆盖只发生在**两处**映射（`theme.ts:176-178`）：`--control-h` ← `control_height`、`--row-h` ← `task_row_height`；`--control-h-sm` 是 calc 派生，跟着控件高度一起缩放。**此前的 `font_size + 1.5` / `task_row_height + 10` 补偿偏移已取消**（会与设置页 SpinBox 的真实值对不上）；`--hit-min` 已删除，其职责由 `--control-h` 接管（无障碍最小目标的 24px 下限由设置区间保证）。

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

（`tokens.css:80-87`；注释记录了修复前的真实事故：「页面级浮条 68/70 反而压在全屏模态 60 之上」，即模态打开时浮条会亮在遮罩上面。）

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

| 缓动 | 值 | 语义 |
| --- | --- | --- |
| `--ease-enter` | `cubic-bezier(0.16, 1, 0.3, 1)` | OutCubic 近似：进入 |
| `--ease-exit` | `cubic-bezier(0.55, 0, 1, 0.45)` | InCubic 近似：退出 |
| `--ease-panel` | `cubic-bezier(0.19, 1, 0.22, 1)` | OutExpo：面板 |
| `--ease-page` | `cubic-bezier(0.45, 0, 0.55, 1)` | InOutQuad |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 弹性 |

### 2.10 阴影四档与遮罩

| 令牌 | 浅色 | 深色（`:141-144`） |
| --- | --- | --- |
| `--shadow-sm` | `0 1px 3px rgb(0 0 0 / 12%)` | `28%` |
| `--shadow-md` | `0 8px 24px rgb(0 0 0 / 20%)` | `44%` |
| `--shadow-lg` | `0 12px 32px rgb(0 0 0 / 24%)` | `50%` |
| `--shadow-xl` | `0 24px 64px rgb(0 0 0 / 28%)` | `56%` |

深色模式必须加深（同样的黑色透明度在深底上几乎不可见，`tokens.css:140`）。遮罩见 §2.1 的 `--overlay`。

---

## 3. 布局框架



- 窗口：无边框（`frame: false`）+ `titleBarStyle: 'hiddenInset'`（`src/main/index.ts:322-338`）；初始 1280×820，最小 1040×640。
- 拖拽区靠 `-webkit-app-region`：`.drag-region` / `.no-drag`（`global.css:83-89`）；标题栏内的按钮都包在 `.no-drag`（`TitleBar.tsx:20`）。
- `html/body/#root` 100% 高、`overflow: hidden`（`global.css:9-15`）；页面内部滚动容器各自声明 `overscroll-behavior: contain`，避免子卡片滚到尽头带动父容器（`global.css:124-134`）。

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

视图切换是一个 `role="group"` 的分段控件（`.seg`），四项：**列表 / 四象限 / 日历 / 看板**（`TasksPage.tsx:26-33`、`:499-506`），按钮用 `aria-pressed` 表达选中。

### 4.1 列表视图（默认）

- 树形缩进 + 折叠；行高由 `--row-h` 决定（`TasksPage.tsx:65-71`）。
- **虚拟滚动**：`VirtualList` 固定行高、按 `count × rowHeight` 绝对定位，`overscan = 8`，容器高度用 `ResizeObserver` 实测（`components/VirtualList.tsx:21-65`）。
- 行内容（`components/TaskRow.tsx`）：勾选框（`aria-label` 随状态变化，`:101`）→ 优先级色点（`aria-label`/`title` 给出文字等级，`:109`）→ 标题 → **胶囊容器 `.trow__chips`**（循环 / `🔥N` 连续 / 日期区间 / 标签 `:157-170` / `⇄N` 笔记数 `:171`，逾期区间转 danger 色）→ **行内动作组 `.trow__actions`**（`:174-197`，开始专注 / 加子任务 / 编辑 / 删除）。
- 动作组**不是浮层**：未悬浮时收拢为 0 宽 + 透明且不接收指针事件，悬浮（或选中）时展开为内容宽度（实测 110px），胶囊容器作为普通 flex 兄弟项随之被推到它左侧 —— 即「悬浮时胶囊移到按钮组左边」。按钮与胶囊同款：20px 高、`0 6px` 内边距、`--radius-sm` 圆角、`--fg-secondary` 文字色。
- 添加行计入行数，否则虚拟列表的绝对定位会错位（`TasksPage.tsx:146` 注释）。

### 4.2 四象限

- 格子：重要且紧急 / 重要不紧急 / 紧急不重要 / 不重要不紧急（`QuadrantBoard.tsx:8-13`）。
- 归格规则：`important = isImportant(priority)`，`urgent = due_date !== null && due_date <= today`（`:65-72`）；**只有根任务归格**，父行可展开未完成的直接子任务，子任务自身优先级/日期不参与归格（`:42-45` 注释）。
- 拖拽换格写入 `priority + due_date` 组合（`:16-30`，与 Python 的 `_on_quadrant_changed` 逐值一致）。

### 4.3 日历

- 6×7 月份网格、**周一为第一列**（与 Qt `QCalendarWidget` 周首一致，`CalendarBoard.tsx:20-33`）。
- 单元格最多 3 个任务胶囊，超出显示 `+N`（`:16`、`:156-158`）。
- 拖拽胶囊到日期格即改期（`:145-151`）。
- 右侧固定「当日任务」栏（`:166-191`）。
- 已知口径差异：只看 `due_date`、丢弃无日期任务、不展开 `start_date`、恒排除已完成（`:49-58`），因此设置项 `calendar_show_done` 在 UI 上无效（详见 `01` R-T-16）。

### 4.4 看板

- 列 = 状态（`STATUS_CHOICES`），卡片 = **根任务**（列头计数也只算根任务，`KanbanBoard.tsx:19-23` 注释）。
- 拖卡片到另一列改状态（`:86-99`）；每列底部有「+ 添加」直接在该状态建任务（`:109-111`）。
- 展开的父任务把未完成子任务以缩进卡片列在下方，**不做状态级联**（`:21-22`、`:73`）。

### 4.5 工具栏与共享交互

| 交互 | 位置 | 说明 |
| --- | --- | --- |
| 按清单筛选 | `TasksPage.tsx:516-532` | 「全部清单 / 收件箱（未归属）/ 各清单」 |
| 新建清单 | `:533-544` | 应用内 `dialog.prompt`，非原生弹框 |
| 当前视图过滤 | `:545-551` | 本地过滤：自身或任一后代命中即保留（`:37-46`） |
| 多选与批量 | `:552-561` | Ctrl/Cmd 切换、Shift 选范围；批量完成/移动/改期 |
| 速览侧栏 | `:562-564`、`:637-706` | `.inspector` 常驻可切换 |
| 新建任务 | `:565-573` | 行内添加行 |
| 撤销条 | `App.tsx:438-448` | 6s 自动消失 + Ctrl+Z |

---

## 5. 侧栏与标题栏

### 5.1 侧栏（`components/Sidebar.tsx`）

- 8 项导航 + 1 个折叠按钮；分区：`top`（7 项）+ `bottom`（设置）——`nav.ts:34-43`。
- 结构标注为 `nav aria-label="主导航"`，当前项 `aria-current="page"`（`Sidebar.tsx:24`、`:39`）。
- 收件箱徽标只在未折叠且计数 > 0 时渲染（`:31-33`）。
- 折叠态 48px，只留图标并以 `title` 补文字（`:25`）；折叠仍保留 `aria-label`（`:46`）。
- 图标全部来自 lucide-react，20px/stroke 2（`:28`）。

### 5.2 标题栏（`components/TitleBar.tsx`）

- 左侧：macOS 红绿灯占位（`isMac` 时渲染 `titlebar__traffic`，`:11`、`:17`）。
- 中间：`知行 ZhiXing · <当前页名>`（i18n 取词，`App.tsx:355`）；右侧签名位来自 `settings.signature`（默认「知行合一」，`settings.ts:98`）。
- 右侧动作：明暗切换（图标与 `aria-label` 随当前主题变化，`:21-28`）；非 macOS 时追加最小化/最大化/关闭（`:29-53`），关闭按钮为危险色（`:46`）。
- 键盘折叠侧栏：Ctrl/Cmd+B（`App.tsx:288-292`）。

---

## 6. 桌面浮窗与系统托盘

### 6.1 桌面浮窗（第二个窗口，`?widget=1`）

| 能力 | 行为 | 证据 |
| --- | --- | --- |
| 尺寸与下限 | 290×380，最小 200×160 | `src/main/index.ts:47-49` |
| 窗口属性 | 无边框、透明（显式 `backgroundColor: '#00000000'`）、置顶 `floating`、不进任务栏、可缩放、无阴影 | `:88-115` |
| 不透明度 | `widget_opacity / 100`，钳在 0.3–1.0 | `:86`、`:192-194` |
| 几何持久化 | 存 `settings.ui_state.widget_geometry`，配置损坏则回退默认尺寸 | `:51-72` |
| 贴边把手 | 靠近屏幕左右边缘 8px 内缩为 10px 把手，滑出时按原宽度还原（不改变持久化值） | `:145-182` |
| 悬停/双击滑出 | 监听 `mouseenter` / `dblclick` → `widget:undock` | `WidgetApp.tsx:32-40` |
| 右键菜单 | 今日视图 / 取消贴边 / 隐藏浮窗 | `src/main/index.ts:471-480` |
| 鼠标穿透 | `setIgnoreMouseEvents(enabled, { forward: true })` | `:196-199` |
| 内容 | 顶部快速输入（回车即建）+ 今日待办（含子树）+ 底部「打开主程序 / 隐藏」 | `WidgetApp.tsx:138-178` |
| 数据同步 | 5s 轮询重查今日任务；`settings` 域广播触发外观重铺 | `WidgetApp.tsx:24-29`、`:53-60` |

**降级说明**：浮窗内的优先级（`:106`）、标签（`:107`）、更多操作（`:108`）、编辑（`:122`）只提示「请到主窗口」，删除用原生 `confirm` 且无撤销（`:124`）。边缘缩放未实现（`01` R-S-07）。

### 6.2 系统托盘

- 菜单 5 项：显示主窗口 / 快速添加任务 / 划词捕获 / 显示·隐藏浮窗 /（分隔）退出（`src/main/index.ts:288-302`）。
- tooltip 动态显示「今天待办 N」，并在任何写操作后刷新（`:271-279`、`:442`）。
- 单击托盘图标 = 显示主窗口（`:303`）；macOS 用模板图（`:285`）。

---

## 7. 命令面板（`components/CommandPalette.tsx`）

- 打开：Ctrl/Cmd+K（`App.tsx:271-275`）；打开时清空查询、聚焦输入框（`:53-59`）。
- 检索：输入后 **120ms 防抖** call `db.globalSearch`（跨类型一次返回；支持 `task:`/`note:`/`flash:`/`tag:` 前缀与 `due:`/`status:`/`priority:`/`folder:` 过滤，`Search` 分档 20/8/6）。
- 结果结构：先「新建任务」动作 → 页面跳转命令 → 四类命中（任务/笔记/闪念/标签），每组有图标；总计最多 30 项（`:144`）。
- 键盘：↑/↓ 移动、Enter 执行、Esc 关闭（`:175-189`）；鼠标悬停同步高亮（`:201`）。
- 语义：`role="dialog"` + `aria-modal` + `role="listbox"` + `role="option"` + `aria-selected`（`:158`、`:161`、`:192`、`:198-199`）。
- 缺口：命令集仅「导航 + 新建任务」，无 MRU、无「开始番茄钟」等命令（`01` R-S-19）。

---

## 8. 编辑器与笔记交互

### 8.1 三栏布局（`NotesPage.tsx`）



链接面板可整体开关（`linksOpen`），三栏均在 `global.css:126-134` 的 `overscroll-behavior: contain` 名单内。

### 8.2 CodeMirror 6 编辑器（`components/MarkdownEditor.tsx`）

- 扩展：`history`、`drawSelection`、`highlightActiveLine`、`closeBrackets`、`markdown()`、`syntaxHighlighting(mdHighlight)`、`[[` 补全、placeholder、行宽换行、`completionKeymap + defaultKeymap + historyKeymap + indentWithTab`（`:105-120`）。
- 高亮配色**全部取自设计令牌**（`:27-37`）：标题用 `--accent`、行内代码用 `--accent-solid`、引用用 `--fg-secondary`。
- 编辑区主题：字体走 `--font-ui`、行高 1.75、内边距 `--space-4`、活动行 `--bg-hover`、选区 `--accent-soft`、光标 `--accent`、补全浮层 `--bg-layer-solid` + `--radius-md`（`:39-62`）。
- `[[` 补全按前缀过滤标题，最多 20 项（`:83-99`）。
- 外部改正文（切笔记、回滚版本）时替换文档且不触发 onChange 回环（`:133-140`）。

### 8.3 保存与查找

- 自动保存**防抖**；切换笔记前先 `flushPending`（8 处入口都走 `selectNote`，`NotesPage.tsx:140-163`）；Ctrl/Cmd+S 立即保存（`:165-184`）。
- 查找栏 `role="search"`（`:501`）：Enter 找下一个、Esc 关闭；按钮只有「下一个 / 全部替换 / 关闭」（`:520-528`）——无单处替换、无全部命中高亮。
- **残留风险**：无 `beforeunload`/关窗钩子，直接关窗会丢掉防抖窗口内的编辑（`01` R-N-20）。

### 8.4 正文区的四种形态

| 条件 | 形态 | 证据 |
| --- | --- | --- |
| `format === 'link'` | 链接行（支持 JSON 数组或多 URL）+「用系统应用打开」 | `NotesPage.tsx:390-424` |
| word / excel 且有解析结果 | Office 只读预览（`dangerouslySetInnerHTML`，内容已清洗） | `:425-447` |
| word / excel 无解析结果 | 引用路径 + 「用系统默认应用打开」 | `:448-471` |
| markdown / richtext 且预览开 | `MarkdownView`（`[[` 可点，悬空可一键新建） | `:472-480` |
| markdown / richtext 且预览关 | `MarkdownEditor` | `:481-494` |

注意 `richtext` 与 `markdown` **一起**落到 Markdown 编辑器分支（`:425`、`:482`），这是最大的交互降级项（`01` R-N-11）。

---

## 9. 对话框与反馈规范

### 9.1 应用内对话框（`components/Dialogs.tsx`）

存在理由写在文件头（`:3-9`）：Electron **不实现** `window.prompt`——调用不报错、永远返回 `null`，于是新建标签/文件夹/工作流、重命名在打包版里会静默失败。

| 规范 | 实现 |
| --- | --- |
| API | `dialog.prompt({title,label,defaultValue,placeholder,confirmText})` / `dialog.confirm(options 或 string)` |
| 队列 | 用数组 + ref 承载，并存请求不会互相覆盖（`:43-57`） |
| 结算时机 | 先更新界面再 `resolve`（`:59-67` 注释记录了「resolve 写进 setState updater 导致 await 后代码永不执行」的真实 bug） |
| 焦点 | 打开后 30ms 选中输入框内容（`:83-88`） |
| 键盘 | Enter 确认、Escape 取消（`:118-121`） |
| 遮罩 | 点击遮罩 = 取消（`:99`）；对话框本体阻止冒泡（`:104`） |
| 语义 | `role="dialog"` + `aria-modal="true"`（`:102-103`） |
| 危险动作 | `danger: true` → 确认按钮转危险色（`:94`、`:134-138`） |

**缺口（本轮实测）**：`window.confirm` 仍有 **15 处**未迁移（TasksPage 2、InboxPage 2、WidgetApp 1、NotesPage 1、SettingsPage 2、WorkflowPage 3、TodayPage 1、RecycleBin 2、TagManager 1），会弹原生框、与自绘界面风格割裂；应用内 `dialog.prompt/confirm` 调用点 10 处。

### 9.2 反馈三件套

| 组件 | 层级 / 语义 | 行为 | 证据 |
| --- | --- | --- | --- |
| `Toast` | `--z-toast`，`role="status" aria-live="polite"` | 单一文案，2600ms 自动消失 | `components/Toast.tsx:4`、`App.tsx:344-347` |
| 撤销条 InfoBar | `--z-float`，`role="status"` | 6s 自动消失；「撤销」按钮 + Ctrl+Z；删除类撤销走回收站 restore | `App.tsx:438-448`、`:249-261` |
| `ReminderPopup` | `--z-reminder`，`role="alertdialog"` | 30s 轮询；正文含提醒时刻与截止；动作：稍后 5/15/30 分、查看、知道了 | `components/ReminderPopup.tsx:24`、`:47-79` |

`PomodoroBar`（`--z-float`，`role="status"`）显示阶段、`mm:ss`、任务名、进度条、暂停/继续、结束；休息阶段换成 `pomo--break` 皮肤（`PomodoroBar.tsx:82-92`）。

### 9.3 模态与浮层规范

- 遮罩统一 `.modal-mask` + `--overlay`，弹层用 `--shadow-lg`/`--shadow-xl` + `--radius-lg`/`--radius-xl`。
- 模态内的输入用 `.field`；`.field:focus-visible` 关掉全局焦点环，改由边框变色表达，避免两层焦点效果（`global.css:60-63`）。
- 速览面板（`.inspector`）、图谱侧栏（`.graph-side`）、工作流侧栏（`.wf-side`）都用 `<aside aria-label>` 标注。

---

## 10. 可访问性

| 项目 | 规定 | 证据 |
| --- | --- | --- |
| 焦点环 | **永远可见、不可删**；`:focus-visible` 用 `--focus-w` + `--focus-ring`，`outline-offset: 1px` | `global.css:53-58` |
| 输入焦点 | 输入/下拉改用边框变色，避免双重焦点环 | `global.css:60-63` |
| 文字对比度 | 正文/次要 ≥4.5:1、辅助 ≥4.0:1；应用主题时**运行时校正** | `theme.ts:49-68`、`color.ts:70-81` |
| 非文本对比 | 边框/指示条/图标对相邻底 ≥3:1（约定） | `tokens.css:88` 注释 |
| 对比度实测 | `scripts/contrast-audit.mjs` 对 14 主题包 × 双模式逐组测 WCAG 相对亮度（报告 168 组） | `package.json:20` |
| 键盘可达 | Ctrl+K/N/Shift+N/B/E/F/,/Tab/1..6/Z；输入框/文本域/contentEditable 内不劫持 | `App.tsx:264-342` |
| 语义标注 | `nav aria-label`、`aria-current`、`role="group"` + `aria-pressed`、`role="dialog" aria-modal`、`role="listbox"`/`option`、`role="search"`、`role="status"`、`role="alertdialog"`、`aria-label` 于图标按钮 | 见 §3–§9 各条 |
| 图标按钮 | 一律带 `aria-label`（或 `title`），纯装饰图标 `aria-hidden` | 如 `Sidebar.tsx:46`、`TitleBar.tsx:24`、`CommandPalette.tsx:165` |
| 减弱动效 | `@media (prefers-reduced-motion: reduce)` 把 7 档时长全归零 | `tokens.css:163-173` |

**未取证**：本轮未做屏幕阅读器实机测试；以上为代码级证据（语义属性与对比度算法），不等价于无障碍验收通过。

---

## 11. 动效规范与降级

1. **统一时长/缓动**：所有过渡引用 `--dur-*` / `--ease-*`，不允许裸毫秒值。
2. **交互反馈不改变布局**：按压用独立 `translate` 属性下移 1px（而非 `transform`，避免覆盖组件自身 transform，如 `.toast` 的 `translateX(-50%)`），禁用用 `opacity: .45` + `cursor: not-allowed`（`global.css:33-45`）。
3. **两级降级**：
   - 用户在设置里选 `motion_level = none` → `root.dataset.motion = 'none'` → `--dur-*` 全归零（`theme.ts:86`、`tokens.css:151-160`）；
   - 系统「减少动态效果」→ 同一份归零规则（`tokens.css:163-173`）。
4. **悬停聚焦淡化**：与当前悬停对象无关的图元淡到 `opacity: .05`（Obsidian 取值，保留一丝轮廓当上下文），图谱/工作流共用（`global.css:112-122`）。
5. **未取证**：无统一的帧率/性能预算实测（`layoutcheck.mjs` 只量化「视口变高时主工作区是否跟随」，不断言 FPS）。

---

## 12. 交互缺口清单（按可闭合成本排序）

| 优先级 | 缺口 | 现状证据 | 影响 |
| --- | --- | --- | --- |
| 高 | 完成撤销无 `prev_status` | `App.tsx:257` 盲目 `toggleTask` | 从 done 撤销会落到 todo，不是原状态 |
| 高 | 关窗前不落盘 | `NotesPage.tsx` 无关窗钩子 | 防抖窗口内编辑丢失 |
| 高 | `window.confirm` 15 处未迁移 | 见 §9.1 | 原生框与自绘界面割裂 |
| 中 | 「移动到清单」无入口 | `preload/index.ts:91-92` 零调用 | 清单体系半可用 |
| 中 | 闪念转子任务 / 转笔记指定目录无入口 | `preload/index.ts:48-49`、`InboxPage.tsx:86` | 后端能力浪费 |
| 中 | 无 MRU、命令集少 | `CommandPalette.tsx:81-104` | 高频操作多两步 |
| 中 | `calendar_show_done` 在日历无效 | `CalendarBoard.tsx:49-58` | 设置项失效 |
| 中 | 富文本无编辑器、Office 只读 | `NotesPage.tsx:425`、`:482` | 格式体系半可用 |
| 低 | 边缘缩放、FloatingDock、splash | `src/main/index.ts:149-182`；全仓无 dock/splash | 平台体验细节 |
| 低 | 换主题不改托盘图标 | `src/main/index.ts:283-285` | 视觉不一致 |
| 低 | 图谱页未订阅 `flash` 域 | `GraphPage.tsx:119` | 闪念变化不刷新图谱 |

---

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
