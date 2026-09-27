# 知行 ZhiXing · 视觉与动效升级方案

> 日期：2026-09-27 ｜ 状态：**已实施**（同日经用户批准全量落地 A+B+C+D，决策见文末「实施记录」）
> 方案原文保留不动 —— 它的价值在于「当时为什么这么判断」，而不是「最后改了什么」。
> 方法：gpt-taste（Awwwards 级设计工程）技能 ∩ 本项目既有设计规范
> 证据口径：全部结论均带 `文件:行号`，可用 grep 复现

---

## 0. 先说结论

本项目**不缺设计规范，缺的是规范的落地**：7 档时长令牌有 3 档从未被引用，5 条缓动有 2 条从未被引用，
全应用只有 3 个 `@keyframes`，所有浮层共用同一个"从下 8px 淡入"、且**没有任何退场动效**。
更严重的是有 **2 处令牌根本没定义**，导致 3 条样式声明静默失效（其中 2 条正是动效）。

所以这不是"推倒重来换个炫酷风格"，而是三件事：

1. **修**：让已经失效的动效真正跑起来（A 级，零风险）。
2. **填**：把已经定义好、却没被消费的令牌接到真实交互上（B 级）。
3. **升**：在既有"克制的桌面工具"气质内提升质感与编排（C/D 级）。

关于 gpt-taste：它面向**营销落地页**（AIDA 结构、ScrollTrigger 钉固/擦洗、bento 无缝网格、picsum 图片、
超大区块间距）。桌面生产力应用照搬会毁掉这个产品已经建立的专业感。本方案把它**逐条转译**（见 §2），
只取其中与"物理可信度、编排节奏、质感层次"有关的部分。

---

## 1. 现状体检（全部可复现）

### 1.1 动效令牌：定义了 7 档，实际只用 4 档

`transition` / `animation` 对令牌的引用次数（`grep "var\(--(dur|ease)-" src/renderer`）：

| 令牌 | 引用数 | 谁在用 |
| --- | ---: | --- |
| `--dur-instant` (100ms) | 25 | 悬停底色、描边 |
| `--dur-fast` (150ms) | 25 | 淡化、面板宽度 |
| `--dur-normal` (250ms) | 4 | 侧栏宽度、页面进入 |
| `--dur-page` (200ms) | 1 | 页面标题 |
| **`--dur-slow` (400ms)** | **0** | **从未使用** |
| **`--dur-strike` (200ms)** | **0** | **从未使用（"完成划线"专用档）** |
| **`--dur-panel` (280ms)** | **0** | **从未使用（"面板展开"专用档）** |
| `--ease-enter` | 17 | 进入 |
| `--ease-spring` | 1 | 仅桌面浮窗一处 |
| `--ease-page` | 1 | 页面标题 |
| **`--ease-exit`** | **0** | **从未使用（退场专用档）** |
| **`--ease-panel`** | **0** | **从未使用（面板专用档）** |
| `--ease-standard` | 2 | 见 1.2 —— **它没有被定义** |

证据：`src/renderer/src/styles/tokens.css:118-138`（定义），各 css 文件的 transition 站点。
结论：`docs/03-UI-UX交互设计.md` §2.9 的令牌表是**为尚未实现的动效预留的**，不是历史包袱。

### 1.2 两处令牌未定义 → 三条声明静默失效（真缺陷）

| 缺失令牌 | 引用点 | 后果 |
| --- | --- | --- |
| `--ease-standard` | `styles/tasks.css:295`（任务行时间进度条宽度）、`styles/workflow.css:88`（工作流节点位移） | `var()` 无 fallback → 整条 `transition` 声明在计算值阶段失效 → **这两处动画根本没跑**，是瞬跳 |
| `--space-6` | `styles/notes.css:1272`（图片预览浮层 `padding`） | 整条 `padding` 失效 → **图片预览贴到视口边缘，没有留白** |

（`--gnode-c` / `--link-a` / `--link-b` / `--row-indent` / `--widget-opacity` 同样"未在 CSS 中定义"，
但它们由 JS 内联注入且带 fallback：`GraphNodeIcon.tsx:53`、`NotesPage.tsx:1415`、`TaskRow.tsx:85`、
`WidgetApp.tsx:121` —— 属正常用法，不算缺陷；审计时会登记为白名单。）

### 1.3 全应用只有 3 个关键帧，且没有退场

`@keyframes` 全集：`page-enter`、`title-enter`、`toast-in`（共 3 个，`styles/app.css`）。
其中 `toast-in` 被 **6 处**声明共用（`app.css:450` Toast、`:523` InfoBar、`:677` 提醒卡、
`global.css:91` 模态遮罩、`tasks.css:534/575`），
意味着"弹出菜单""全屏模态""系统提醒"三种完全不同的浮层用同一段"从下 8px 淡入"。
（`PopMenu` 连这个都没有：`tasks.css:525` 的 `.popmenu` 无任何动画。）

退场：Toast / InfoBar / PopMenu / 模态 / 提醒卡全部是条件渲染直接卸载
（`Toast.tsx:2-3`、`PopMenu.tsx`），没有任何退场动画 —— 这就是 `--ease-exit` 零消费的原因。

弹出菜单还多一个细节问题：`PopMenu.tsx:20-25` 在 **`useEffect`**（提交后）才写 `style.left/top`，
首帧渲染在默认位置后才被挪到鼠标处 —— 快速弹出时是一帧位移（视觉上的"闪一下"）。

### 1.4 没有 JS 编排层

全仓 JS 侧动画只有 5 处（`requestAnimationFrame` / `getAnimations`）：
`App.tsx:119`（等待挂载）、`BloubAvatar.tsx:82/84`（形象动画）、`theme.ts:196`（切主题强制合成）。
**没有** FLIP、没有 stagger、没有共享元素过渡、没有滚动驱动、没有弹簧物理（除 morphicons 自带）。

### 1.5 视觉：结构清晰，但缺"深度"与"氛围"

从 `.screenshots/tb-*.png`（今日/任务/笔记/图谱/工作流/设置）：

- 好的一面：网格规整、信息层级靠字重与颜色、控件高度与行高两个尺度统一、无廉价 meta 标签。
- 平的一面：`.app__content` 与卡片都是"1px 边框 + 纯色底"；没有内高光、没有悬停抬升、
  没有氛围渐变、空态只有一行字（`NotesPage` 的"从左侧选择一篇笔记…"）、概览卡数字是静态的。
- 动的一面完全没有：勾选完成是瞬间划线（`tasks.css:326-329`）、新增/删除行是瞬间出现/消失、
  导航选中条是瞬间跳位（`app.css:130-140`）、切主题是瞬时硬切（还靠一个 `translateZ` hack 刷新合成，`theme.ts:193-202`）。

### 1.6 门禁现状：一处是刻意不设门，一处是真的缺门

- **对比度门是有的，但不是那个脚本**：`scripts/contrast-audit.mjs:118-124` 恒 `exit(0)` 是**刻意**的 ——
  它读主题包的**原始 token**，而达标依赖运行时校正（`theme.ts:56-62` 的 `ensureTextContrast`）。
  真正的门是 `src/shared/color.test.ts`（覆盖 14 包 × 双模式 × canvas/layer + 胶囊翻面文字）。
  **改视觉时必须跑的是后者。**
- **真的缺门**：令牌完整性、裸毫秒/裸色值/裸 z-index 没有任何检查（全仓无 eslint/stylelint）。
  这正是 1.2 那两处缺失能一直活着的原因 → 见 A3。

### 1.7 其他两条与本方案直接相关的既有事实

- `global.css:325-335` 的 `.is-dimmed { opacity: .05 }` 是图谱与工作流**共用**的聚焦淡化规则，
  且被 `scripts/interactioncheck.mjs:332-336` 断言为"恰好 0.05"。**本方案不得改动这个值。**
- `scripts/ctlheightcheck.mjs:21` 的 CONTROL 正则只覆盖 **13 个既有类名** ——
  新起的控件类名默认**不受保护**，新增控件必须把类名补进该正则。

---

## 2. gpt-taste 的桌面转译

| gpt-taste 原始要求 | 为什么不能照搬 | 桌面等价物（本方案落点） |
| --- | --- | --- |
| Hero 2-3 行铁律 + 超大字号 | 桌面窗口宽 1280、信息密度高，字号不能拉到 5vw | **页头编排**：标题/副标题/工具栏分组错峰进入（总时长 ≤ 260ms），取代"整块一起跳" |
| AIDA 页面结构 | 应用是**多页工具**，不是单页叙事 | 每页已有"标题 → 概览/工具条 → 主内容"的三段结构，加**分段交错进入**而非重排 |
| Bento 无缝网格 + `grid-flow-dense` | 已有规整网格（概览四卡、设置分组），不是营销 Bento | 保留网格，升级**卡片物理**（悬停抬升 + 阴影进阶 + 内高光） |
| GSAP ScrollTrigger：钉固 / 擦洗 / 堆叠 | 桌面应用没有营销页的长滚动叙事 | **面板/视图切换编排**（抽屉 280ms OutExpo）、**布局重排的飞位**（工作流纵向↔横向）、**滚动驱动的工具栏吸顶** |
| 图片资产 + `picsum` + 滤镜 | 本地应用无外部图片，且要离线可用 | **现成资产**：morphicons 图标形变、图谱节点图形、Bloub 形象、空态插画/氛围光晕 |
| 悬停物理（scale 1.05 / 700ms） | 700ms 对工具应用太慢，会让操作"黏" | **短促物理**：`--dur-fast`(150ms) 抬升 1px + 阴影进阶；`--ease-spring` 只用于落位/勾选，回弹幅度 ≤ 6% |
| 禁用 emoji / 禁用廉价 meta 标签 | 本项目本就没有 | 作为**约束保持**（方案不会引入任何 emoji 或 "SECTION 01" 类标签） |

**一句话方向：克制的深度（Restrained Depth）** —— 动效全部服务于"状态变化的因果可见性"
（东西从哪来、到哪去、为什么变），不做装饰性炫技。

---

## 3. 方案清单

编号规则：**A** 修缺陷（必做）｜**B** 动效补全｜**C** 视觉质感｜**D** 高级编排（需拍板）。
每条给出：做什么 / 改哪里 / 参数 / 降级 / 验证 / 风险。

### A 级 · 修缺陷（零风险，先做）

**A1 定义 `--ease-standard`，让 2 处失效过渡复活**
- 做法：`tokens.css` 新增 `--ease-standard: cubic-bezier(0.2, 0, 0, 1);`（Material Standard 近似：双向平稳），
  并把它补进 `docs/03` §2.9 的缓动表（语义位："标准/通用过渡"）。
- 备选：把两处改为 `--ease-enter`（不新增令牌，但丢掉"标准"这个语义位）。
- 效果：任务行时间进度条 `0% → 68%` 变成 250ms 平滑推进；工作流节点悬停真有过渡。
- 验证：CDP 读 `getComputedStyle(el).transitionDuration`（修复前是 `0s`）；跑 `npm run check:interaction`。
- 风险：极低（只影响 2 个属性、2 个元素）。

**A2 定义 `--space-6`，修图片预览贴边**
- 做法：`tokens.css` 补 `--space-6: 32px`（延续 4px 节奏），`docs/03` §2.5 补一档并注明用途
  （图片预览、空态这类"大留白"场景，不用于常规布局）。
- 验证：CDP 读 `.rt-preview` 的 computed padding（修复前 0px）＋截图。
- 风险：极低。

**A3 新增"令牌完整性"单测（防复发）**
- 新增 `src/renderer/src/styles/tokens.test.ts`（vitest，与既有 `theme.test.ts` 同层）：
  1. 抽全部 `var(--x)` 引用与全部定义点，断言**每个引用都有定义或显式 fallback**；
  2. JS 注入白名单显式登记（`--gnode-c` / `--link-a` / `--link-b` / `--row-indent` / `--widget-opacity`），
     并断言白名单里的名字确实在 JS 中被赋值（否则是死令牌）；
  3. 断言 `transition` / `animation` 中不出现裸毫秒值（规范 §11.1）。
- 验证：`npx vitest run src/renderer/src/styles/tokens.test.ts`；
  **变异验证**：故意删掉 `--space-6`，测试必须变红。
- 风险：低（纯静态检查，不动运行时）。

**A4 对比度：认准真正的门（澄清，不是"修 bug"）**
- 事实：`contrast-audit.mjs` 恒 `exit(0)` 是**刻意**的（见 §1.6），它的定位是体检报告，不是门。
- 做法：
  1. 本方案所有 C 级改动**必须跑 `npx vitest run src/shared/color.test.ts`**（真正的守门断言）；
  2. 若希望 `contrast-audit` 也能守门，正确做法是让它对 `ensureTextContrast` **之后的有效值**求值
     （约 30 行改动），而不是把 `exit(0)` 直接改成 `exit(1)` —— 后者一开就红，且红得没有意义。
- 风险：低。

### B 级 · 动效补全（把零消费令牌接到真实交互）

**B1 完成态"划线"（消费 `--dur-strike` 200ms + `--ease-spring`）**
- 现状：勾选后 `line-through` 与色变**瞬间生效**（`tasks.css:326-329`；`check--done::after` 的对勾同理）。
- 做法（纯 CSS，不改 JSX 结构）：
  1. 勾选圆：`transform: scale(.82) → 1`，200ms `--ease-spring`；
  2. 对勾：伪元素 `scaleX(0) → 1` + `transform-origin: left`，200ms `--ease-enter`（替代突现）；
  3. 标题划线：**不用** `text-decoration`（无法动画），改用 `.trow--done .trow__title::after`
     的 `transform: scaleX(0→1)` 细线（1px，`currentColor`，定位在文字基线），
     同时 `color` 过渡到 `--fg-tertiary`（`--dur-normal`）；
  4. **撤销勾选**反向播放（划线先退，`--dur-fast`）。
- 降级：`--dur-strike: 0ms` → 立即完成（等于现状）。
- 验证：勾选/撤销截图；CDP `document.getAnimations()` 应看到 3 个动画。
- 风险：中低（要盯完成态在深色主题与 24px 紧凑行高下的表现）。

**B2 列表行进场 / 离场（消费 `--dur-fast`、`--dur-normal`、`--ease-exit`）**
- 现状：新增行直接出现，删除/归档直接消失。
- 做法：
  1. 只对**本次操作产生**的行加 `--enter`（`TasksPage` 维护 `justAddedIds`，`TaskRow` 加一个可选 prop），
     动画 `opacity 0→1` + `translateY(-4px)→0`，`--dur-normal` + `--ease-enter`；
  2. 删除/移出：`opacity 1→0` + `translateY(4px)`，`--dur-fast` + `--ease-exit`，结束后卸载（见 B4）；
  3. 同批最多 8 行 stagger（`20ms × index`，总延迟 ≤ 160ms）。
- **虚拟列表红线**：滚动进入视口的行**一律不加**动画（否则每次滚动都在播）；
  只用 `transform`/`opacity`，**不得**动画 `height`（会破坏 `VirtualList` 的定高假设）。
- 风险：中（要动 `TasksPage`/`TaskRow` 的 props；跑 `npm run check:interaction` 回归）。

**B3 浮层差异化进出场（消费 `--dur-panel`、`--ease-panel`、`--ease-exit`）**
- 现状：7 处共用 `toast-in`，无退场。
- 做法：新增 4 组关键帧，按语义分配：

| 浮层 | 进入 | 退场 |
| --- | --- | --- |
| 弹出菜单 `.popmenu` | `scale(.96)` + `translateY(-4px)` + 淡入，`--dur-fast`/`--ease-enter`，`transform-origin` 指向触发点 | `--dur-instant`/`--ease-exit`（菜单要"快进快出"） |
| 模态 / 命令面板 | 遮罩淡入 `--dur-fast`；面板 `scale(.985)` + `translateY(6px)`，`--dur-normal`/`--ease-enter` | 面板 `--dur-fast`/`--ease-exit` |
| 抽屉 / 速览面板 | 侧向 16px 位移 + 淡入，`--dur-panel`/`--ease-panel` | 反向 `--dur-fast`/`--ease-exit` |
| 提醒卡 / InfoBar | 从触发方向滑入 `translateY(10px)`+`scale(.98)`，`--dur-normal`/`--ease-enter` | 淡出下沉 `--dur-fast` |

- 附带修 `PopMenu` 的首帧位移：`useEffect` → `useLayoutEffect`（提交前定位），
  `transform-origin` 由 `x/y` 与视口边界推算（菜单"从鼠标处长出来"）。
- 风险：中（依赖 B4）。

**B4 基建：`presence` 退场机制（本方案唯一新增的 lib）**
- 为什么必须：没有它，`--ease-exit` 永远用不上，退场永远做不了。
- 做法：新增 `src/renderer/src/lib/presence.ts`（零依赖，约 60 行）：
  `present=false` 时先挂 `--leaving` class 播放退场，`animationend` 后真正卸载；**100ms 兜底 timeout**。
- **降级硬约束**（容易写出 bug 的地方）：
  1. `resolveMotionState() === 'none'` → **同步卸载**，不等待动画；
  2. 监听既有 `zhixing:motion` 事件（`theme.ts:157-161` 契约）动态生效；
  3. `duration: 0ms` 的动画在部分情况下不派发 `animationend` → 兜底定时器必须有。
- 落地：`Toast.tsx`、`.infobar`、`PopMenu.tsx`、`Dialogs.tsx`、`ReminderPopup`。
- 验证：`dialogcheck` / `remindercheck` 回归；手动验"motion=关闭时不留白屏、不卡等待"。
- 风险：**本方案最高**（生命周期），所以放在第 1 期只接 2 个对象（Toast + PopMenu），跑绿再铺开。

**B5 Toast 生命周期与堆叠（消费 `--dur-slow`）**
- 现状：单条、2600ms 后直接消失，无退出、无进度感。
- 做法：进入已有（`toast-in`）；停留期顶部 2px 进度线 `scaleX(1→0)`，时长与 2600ms 同步（用户"看得见还剩多久"）；
  退场 `--dur-normal` + `--ease-exit` 下沉淡出（走 B4）；多条堆叠为底部列表，新条从下推入。
- 约束：容器**不得**因新条重建（`role="status" aria-live="polite"` 会重复播报）。
- 风险：中低。

**B6 任务页四视图切换过渡**
- 现状：列表/四象限/日历/看板 **硬切**。
- 做法：新视图容器 `key={view}` + `view-enter`（`opacity` + 6px 位移，`--dur-normal`/`--ease-enter`）；
  容器等高，避免布局跳动。
- 风险：低。

**B7 看板拖拽物理（`--ease-spring`）**
- 做法：拖起源卡 `opacity .4` + `scale .98`；目标列高亮 + 落点指示条（`--dur-fast`）；
  落位后卡片 `scale 1.02 → 1`（180ms `--ease-spring`，回弹 ≤ 6%）。
- 前置：需先确认 `KanbanBoard` 用的是 HTML5 DnD 还是 pointer 事件（决定幽灵卡归谁画）。
- 风险：中。

**B8 侧栏选中指示条"跨项滑动"**
- 现状：`.nav-item--active::before` 3px 实心条，切换导航**瞬间跳位**（`app.css:130-140`）。
- 做法：提升为一个绝对定位的 `.nav__indicator` 元素，位置/高度由当前激活项测量得出，
  `transition: transform var(--dur-normal) var(--ease-panel), height var(--dur-normal)`；
  首帧不播（`transition: none` 一帧）；侧栏折叠时同步钳制。
- 降级：`resolveMotionState()` 非 full → 瞬移。
- 风险：中（DOM 测量；滚动/折叠要同步）。

### C 级 · 视觉质感（全部走 token，深浅两套）

**C1 "深度"系统：内高光 + 悬停抬升**
- 新增 `--edge-light`：浅色 `inset 0 1px 0 rgb(255 255 255 / 55%)`，深色 `inset 0 1px 0 rgb(255 255 255 / 4%)`
  （深色必须另取值，规范 §2.10 同类要求）。
- 用在 `.app__content` / `.stat-card` / `.modal` / `.palette` —— 卡片从"贴纸"变成"浮起的面板"。
- 悬停抬升：可点卡片 `translateY(-1px)` + `--shadow-sm → --shadow-md`（`--dur-fast`/`--ease-enter`）；
  现状 `.stat-card--clickable` 只有边框变色 + 位移，缺阴影进阶。
- 风险：低。深色需单独校一次。

**C2 强调色氛围光（ambient）**
- 做法：3 处极淡径向渐变（`color-mix(in srgb, var(--accent) 7%, transparent)` → `transparent`）：
  今日概览卡区块背后、`.empty-state` 背后、设置页分组。
  因为走 `var(--accent)`，14 套主题包 × 8 强调色**自动适配**。
- 红线：光晕在最底层，卡片保持不透明底；空态文字直接落在画布上，混合比 ≤ 7% 并复核对比度（`npm run check:contrast`）。
- 风险：中低。

**C3 概览数字动效**
- 做法：首次进入用 `@property` + 计数器动画从 0 滚到目标（`--dur-slow`/`--ease-panel`）；
  后续数值变化（完成任务 2→1）用 200ms 平滑过渡 + 轻微 scale 弹跳（`--ease-spring`）。
- 前置：`@property` 在 Electron 33（Chromium 130）可用；若不想用，退化为 WAAPI 数值补间（约 15 行）。
- 风险：中。

**C4 空态视觉（Empty States）**
- 现状：纯文字 + dashed 提示。
- 做法：morphicons 图标（48px）+ C2 光晕 + 3s 呼吸（幅度 2px，`--dur-slow` 系列，仅 full 档播放）；
  **并补主操作按钮** —— 这一项与 `docs/note-editor-layout-refactor-plan.md` Batch 2 的
  "空态补『新建笔记』按钮"**合并立项，不重复**。
- 风险：低。

**C5 主题 / 密度切换过渡**
- 现状：切主题瞬时硬切，还留了 `translateZ` 强制合成 hack（`theme.ts:193-202`）。
- 做法：切换时给根元素加 `theme-transition` class（260ms 后自动移除），
  仅在窗口期内对 `background-color` / `color` / `border-color` 加 `--dur-normal`/`--ease-page` 过渡。
  **不常驻**（常驻全局过渡会拖累滚动与输入）。
- 注意：`color-scheme` 与原生滚动条颜色**无法过渡**，会在中途瞬变 —— 这属于平台限制，方案里如实标注。
- 设置页拖动字号/行高/控件高度滑块：拖动中 `transition: none`，松手后 150ms 过渡（避免每帧重启过渡）。
- 风险：中（要测性能与闪烁）。

**C6 图标形变扩展（morphicons 是现成能力，只增加接入点）**
- 现状：已接入 5 处（侧栏折叠、日/夜、番茄钟播放/暂停、预览/编辑、caret）。
- 建议新增：新建任务的 `Plus → X`（打开添加行时）、画布布局方向切换图标（纵向 ↔ 横向）、
  排序/筛选激活态。**遵守 §2.11**：`motionPolicy()` 跟随应用/系统，不用库默认 `never`。
- 风险：低。

### D 级 · 高级编排（成本高，需你拍板）

**D1 共享元素过渡（View Transitions API）**
- 场景：任务行 → 编辑弹窗；图谱节点 → 侧栏详情；笔记树项 → 编辑器。
- 做法：`document.startViewTransition`（Electron 33 支持）+ React 18 需 `flushSync` 包 setState；
  `view-transition-name` 只给"当前操作的那一个元素"（虚拟列表里重名会炸）。
- 风险：**高**。建议只做"任务行 → 编辑弹窗"一个试点，并留常量开关可一键回退。

**D2 页面切换方向感**
- 做法：`App.tsx` 记录导航 index 差 → 前进从右 12px、后退从左 12px 滑入（`--dur-normal`/`--ease-panel`）。
- 风险：中（`.page` 每次重挂载，快速连点导航需要取消/防抖）。

**D3 滚动驱动（ScrollTrigger 的桌面等价）**
- 做法：`.page__body` 滚动 > 24px 时，工具栏吸顶并出现 `--shadow-sm`，副标题淡出。
  技术优先用纯 CSS `animation-timeline: scroll()`（Chromium 115+），退化方案是 scroll + rAF 节流切 class。
- **冲突预警**：`docs/03` §3 明确规定"标题必须固定，不能跟着一起滚"。
  因此**不做页头收缩**，只做"工具栏吸顶 + 投影"这种不改变标题可见性的形式；否则需改规范。
- 风险：中高（改变滚动行为）。

**D4 图谱聚焦过渡**
- 已有 hover 聚焦淡化（无关图元 `opacity .05`）。补：聚焦节点 `scale(1.06)`（`--dur-fast`/`--ease-enter`）、
  连线 `stroke-width` 过渡、选中节点侧栏卡滑入（`--dur-panel`/`--ease-panel`）。
- d3-force 在 reduced 档降级为直接收敛（沿用 `zhixing:motion` 契约）。
- 风险：中低。

### 视觉细节补充（低成本小项，可随手带上）
- `.check` 悬停已变色（`app.css:362`）→ 补 `scale(1.06)` 与勾选涟漪。
- `.prio` 优先级色点：颜色变化过渡 `--dur-fast`（现在换优先级是瞬变）。
- `.nav-item__badge` 数字变化时 `--ease-spring` 弹一下。
- `.due--overdue` 危险色轻微呼吸（3s，幅度 2px，仅 full 档）。
- 弹出菜单项悬停：底色从左滑入（`::before` `scaleX`）。
- 对话框按钮组错峰进入（主操作延迟 60ms），引导视线。
- 拖放（任务→清单、笔记→文件夹）：源元素 `opacity .5`，目标行高亮 + 左侧 2px accent 指示条。

---

## 4. 性能预算与降级（首次量化）

本项目规范自认"无统一帧率/性能预算实测"（`docs/03` §11.5）。本方案补上，作为新增动效的准入线：

| 项 | 预算 |
| --- | --- |
| 动画属性 | 只用 `transform` / `opacity`（例外：主题切换的颜色过渡） |
| 单次交互动效总时长 | ≤ 300ms（大范围 ≤ 400ms） |
| 同帧动画元素 | ≤ 40 |
| 列表 stagger | ≤ 8 项 × 20ms（总延迟 ≤ 160ms） |
| 虚拟列表滚动期间 | **不播放**任何进入动画 |
| 主线程长任务 | 交互期间 > 50ms 的任务数 = 0 |
| `will-change` | 不常驻，只在动画期间挂 |
| reduced / none | 全部短路（CSS 由令牌归零，JS 由 `resolveMotionState()` + `zhixing:motion` 短路） |

---

## 5. 验证矩阵（按"改动类型 → 必须跑什么"）

**硬门（无需构建、秒级，每次改动都跑）**

| 检查 | 命令 | 说明 |
| --- | --- | --- |
| 类型 | `npm run typecheck` | |
| 单测 + 架构护栏 | `npm test` | 394 项 / 22 道护栏（`architecture.test.ts` 41 项） |
| 对比度（真门） | `npx vitest run src/shared/color.test.ts` | 14 包 × 双模式 × canvas/layer 全量守门 |
| 主题与降级 | `npx vitest run src/renderer/src/theme.test.ts` | 断言 `dataset.motion === 'none'`、切主题重铺变量 |
| 令牌完整性 | `npx vitest run src/renderer/src/styles/tokens.test.ts` | **本方案新增**（A3），含变异验证 |
| 控件高度 | `npm run check:ctlheight` | 新控件类名需补进 `scripts/ctlheightcheck.mjs:21` 才受保护 |

**视觉 / 布局回归（⚠ 必须先 `npm run build`，且必须串行 —— E2E 的 `killStale` 会把并行实例当残留杀掉）**

| 场景 | 命令 |
| --- | --- |
| 交互可用性（通用） | `npm run check:interaction` |
| 笔记编辑区（51 项，最全的 CSS 回归面） | `node scripts/notesheetcheck.mjs` |
| 布局成长性 + 滚动结构 | `node scripts/layoutcheck.mjs` |
| 行尾按钮组不占位 + 编辑区铺满 | `node scripts/layoutfitcheck.mjs` |
| 虚拟列表（B2 必跑） | `node scripts/vlistcheck.mjs` |
| 笔记多标签（B3/B4 若触及 tabs） | `node scripts/notetabcheck.mjs` |
| 三处侧栏收放（B8 必跑） | `node scripts/tasklistuxcheck.mjs` |
| 截图人工过目 | `node scripts/capture.mjs <输出> [light/dark] [nav]` —— 别在同一实例里切主题后截图，会截到旧帧 |

**动效专项（本方案新增，走 CDP）**

| 检查 | 做法 |
| --- | --- |
| 动效确实在跑 | `document.getAnimations().length` / `getComputedStyle(el).transitionDuration !== '0s'`（A1 修复前是 `0s`） |
| 降级确实生效 | 置 `data-motion='none'` 后重测：动画数为 0、元素仍可见（不白屏、不卡在等待） |
| 帧率 | CDP Performance 采样：交互期间 FPS ≥ 55、长任务(>50ms) = 0（本方案首次量化） |

### 5.5 实现时必须避开的 11 个坑（本仓实测盘点）

1. **`data-motion` 的 full 档是空串，不是 `'full'`**（`theme.ts:153`）。JS 侧判档一律用
   `resolveMotionState()`，**不能**写 `dataset.motion === 'full'` —— 那个条件永远为假。
2. **A1 的验收锚点**：`--ease-standard` 修好之前，那两处 transition 在 computed style 里是 `0s`。
3. **`.is-dimmed` 的 `opacity: .05` 不许动**：`interactioncheck.mjs:332-336` 断言它恰好为 `0.05`。
   D4 只加 `scale` / `stroke-width`，不改这个值。
4. **新控件类名默认不受 `ctlheightcheck` 保护**（CONTROL 正则只列了 13 个类名）。
5. **跨窗口共用的样式必须落 `global.css`**（Toast / InfoBar / 模态都可能被浮窗用到）；
   放错文件的历史事故是"浮窗里弹出来是裸框"。`reminder.css` 另有硬约束：不得引用
   `--bg-layer` / `--radius-*` / `--shadow-*`，且必须含 `box-shadow: none`
   （由 `architecture.test.ts:394-415` 守着）。
6. **按压反馈只能用独立 `translate` 属性**（`global.css:53-65`）；用 `transform` 会覆盖
   `.toast` 的 `translateX(-50%)` 这类自身变换 —— B5 的 Toast 堆叠正好踩这个点。
7. **虚拟列表红线**：B2 只动 `transform`/`opacity`，不改行高、不改行数
   （`interactioncheck.mjs:47-61` 断言"添加行必须计入行数"）。
8. **`layoutfitcheck` 断言"行尾按钮组未悬浮时收拢为 0 宽"** —— 若给行尾按钮组加过渡，
   必须保持未悬浮时宽度为 0，只过渡 `opacity`。
9. **`presence` 的卸载兜底**：`duration: 0ms` 的动画不保证派发 `animationend`，
   必须有 100ms 兜底定时器，否则动效关闭时弹层会永久留在 DOM 里。
10. **新写 E2E 必须用 `scripts/lib/cdp.mjs`**（自带 `new WebSocket` 的脚本份数有棘轮 ≤15），
    且统计了 problems 的脚本末尾必须有 `process.exit`，否则是假绿灯（`architecture.test.ts:419-437`）。
11. **本机 pwsh 里没有 `node`**（PATH 被收紧），跑脚本走 `npm run` 或 Electron 的
    `ELECTRON_RUN_AS_NODE` 模式。

---

## 6. 分期建议

**第 1 期 · 修 + 最有感知的进出场**（低风险，一次交付）
A1 / A2 / A3 / A4 + B1（完成划线） + B3（浮层差异化，先只做菜单与模态）+ B4（presence，只接 Toast/PopMenu）+ B5（Toast 生命周期）

**第 2 期 · 编排与质感**
B2（列表进出）+ B6（视图切换）+ B8（导航指示条）+ B7（看板物理）+ C1（深度）+ C4（空态）+ C6（图标形变）

**第 3 期 · 氛围与高级编排**
C2（氛围光）+ C3（数字动效）+ C5（主题过渡）+ D4（图谱）+ D2（页面方向）+ D3（滚动吸顶）+ D1（共享元素试点）

---

## 7. 需要你拍板的 6 个问题

1. **视觉力度**：保守（只做深度与物理）/ **中等（+氛围光晕、空态插画）** / 激进（更强对比 + 玻璃拟态）。我推荐中等。
2. **是否引入动画库**：我推荐**不引入**。理由：GSAP 的核心卖点 ScrollTrigger 在桌面应用没有对应场景；
   纯 CSS + WAAPI 足以覆盖本方案全部条目，且能保持"动效一律走 `--dur-*`/`--ease-*`"这条既有规范。
   若你仍想要 GSAP，建议只用于 D1/D3 的时间轴编排。
3. **D1 共享元素过渡**是否做试点（全方案风险最高的一项）。
4. **D3 滚动驱动**：只做"工具栏吸顶 + 投影"（不改标题可见性），还是连页头收缩也做（需改 `docs/03` §3）？
5. **对比度门禁**：`contrast-audit` 恒 exit 0 是刻意的（读原始 token），真门是 `color.test.ts`。
   是否要额外花约 30 行，让它对"运行时校正后的有效值"求值、从而也能守门？
6. **新增 2 个文件**是否可接受：`lib/presence.ts`（约 60 行）与 `styles/tokens.test.ts`。

---

## 附：本方案明确**不做**的事

- 不改动信息架构、导航结构、页面布局分区（避免与 `note-editor-layout-refactor-plan` Batch 2/3、
  `note-tabs-plan` 批次 3 的既有提案冲突）。
- 不引入不跟 `--control-h` / `--row-h` 走的新高度尺度（规范禁止项）。
- 不写死任何色值、圆角、毫秒数（全部走令牌）。
- 不删焦点环、不改按压位移的 `translate` 语义（规范禁止项）。
- 不用 emoji、不加廉价 meta 标签、不贴外部图片（gpt-taste 的禁用项，本项目本就遵守）。
- 不在笔记正文内层加边框/圆角/底色（规范禁止项）。

---

## 8. 实施记录（2026-09-27）

**用户决策**：全量落地 A+B+C+D；视觉力度取「中等（+氛围光、空态）+ 玻璃拟态试验版」；
做共享元素过渡试点；滚动驱动做「工具栏吸顶 + 投影 + 页头收缩」；同意新增两个文件。

**落地范围**：A1–A4、B1–B8、C1–C6、D1（试点）–D4，另有 60 余处细节与性能项。
新增两个文件：`src/renderer/src/lib/presence.ts`（退场机制）、`src/renderer/src/styles/tokens.test.ts`（令牌护栏）。

**实施过程中新发现并修掉的缺陷**（原方案里没写）：

0. **最严重的一条：`getComputedStyle` 在首屏把渲染主线程按死。**
   主题切换的过渡窗口需要知道 `--dur-normal` 有多长，最初的实现是
   `window.getComputedStyle(root).getPropertyValue('--dur-normal')`。而 `applyAppearance` 是在首屏
   （CSS 刚解析完、元素还没完成布局）被调用的 —— 这一步会强制一次全量样式重算，
   实测直接把渲染进程主线程按死：**界面白屏、CDP 的 `Runtime.evaluate` 45 秒超时**，
   主进程与渲染进程都不报任何错、CPU 也不高，排查成本极高（最后靠「整体回滚 → 按文件分组恢复」
   二分才定位到它）。
   改法：读 `root.style.getPropertyValue('--dur-normal')` —— `applyMotion` 本来就把时长写在根元素的
   **行内样式**上，行内读取不触发重算，语义仍是「跟随令牌」。
   > 教训：首屏路径上调用 `getComputedStyle` 等于强制同步布局，代价随样式表规模与元素数量放大 ——
   > 143KB CSS 的体量下，这一条足够卡死整个界面，而且不留任何日志。

1. `.tagmenu` 借用了 Toast 的 `toast-in` —— 那条关键帧自带 `translateX(-50%)`（Toast 靠它居中），
   套在菜单上就是「弹出来的瞬间整块往左跳半个宽度」。
2. 6 处浮层共用同一个「从下 8px 淡入」，其中两处是菜单（方向本来就不该一样）。
3. `.pomo__fill` 的 `transition: width 1s linear` 是裸时间值（规范 §11.1 明令禁止）。
4. `.empty-state` 的 `padding: 64px` 是裸像素值 —— 它正好是 `--space-6` 的两倍，
   说明当年写它的时候这个令牌就该存在。

**用户验收后追加的三处修复**（都是"整体看起来不统一"这一类问题，静态检查抓不到）：

1. **标题栏不该有自己的底色。** 玻璃拟态那一版给 `.titlebar` 铺了 `--glass-bg`，
   于是窗口最外层出现一条横向的色带，与下面的画布之间有一条肉眼可见的分界线（"一眼看出上下是两块"）。
   改成**完全透明**：标题栏背后就是 `--bg-canvas`，与侧栏连成一片；分隔感交给主区自己的圆角卡片。
2. **除今日页 / 笔记页外的六页，标题行背景要一致。**
   `.page__head`（今日 / 笔记 / 回顾）本来没有底色，而 `.tb--sticky`（任务 / 收件箱 / 工作流 / 图谱 / 设置）
   一上来就铺了一层半透明底 + 模糊，未滚动时也带着一条色块与下边界。
   改成**底色只在"已滚动"时出现**（`.tb--lifted`）—— 未滚动时两者是同一幅样子，
   滚起来之后内容真的会从标题行底下穿过，那时才必须挡住。
3. **设置页的标题行与分区 tab 不该参与滚动。**
   原来是"整页滚 + 工具栏 sticky 吸顶"，标题与 tab 会被推着走一段，而且吸顶后要给自己补底色，
   又变成第 2 条那种不一致。改成滚动收在 `.set-body` 内（`.page--settings .page__body { overflow: hidden }`），
   标题与 tab 一次都不动；同时把该页的 Toolbar 设为 `sticky={false}`（标题本来就固定，不需要第二套吸顶机制）。

**跳过并记录理由的项**：

- `.due--overdue` 的呼吸动画：3s 周期无法只用令牌表达（`--dur-tick` 是 1s 数据节拍且不参与归零），
  会同时踩「裸时间值」与「none 档不归零」两条；
- 删除 / 归档行的离场：要保留幽灵行就得改虚拟列表的行数结构，
  而 `interactioncheck` 的「添加行必须计入行数」正压在这套结构上；
- 四象限 / 日历的拖拽反馈：原方案未点名，两处仍自动获得 `.check` 与 `.prio` 的微交互。

**验证**：见 `docs/03` §11.5（性能预算）与 §11.6（令牌完整性护栏）；
E2E 按「先 build、再串行」跑（`lib/cdp.mjs` 的 `killStale` 让并行必然互相杀掉）。

**E2E 在 Windows 上的两个环境前提**（本轮踩出来的，与产品代码无关，但会伪装成产品 bug）：

1. **这台机器的 PATH 里没有 node**，E2E 只能用 Electron 自己的 Node 模式跑
   （`ELECTRON_RUN_AS_NODE=1 electron scripts/xxx.mjs`）。两个坑：
   - `ELECTRON_RUN_AS_NODE` 会被脚本原样传给**被启动的应用**，让它也以 Node 模式起来 ——
     不开窗、不开调试端口，脚本等到超时后报「✗ 无法连接」，日志里却什么都没有。
     解法是 `scripts/lib/e2e-env.cjs`（预加载钩子里删掉这个变量）；
   - Electron 33 自带的是 Node 20，**没有全局 `WebSocket`**（Node 22 才有），
     所以要用 `--experimental-websocket` 跑脚本。
2. **残留的 Electron 子进程会让下一个实例卡死**。`killStaleDebugInstances` 原来只
   `Stop-Process` 主进程，而 renderer / gpu / utility 的命令行里没有调试端口，于是全都活下来；
   它们占着 GPU 与共享内存，下一个实例起来后 **CDP 能连上、`Runtime.evaluate` 却 45s 超时**，
   界面白屏且不留任何日志 —— 看起来跟「产品代码卡死」一模一样。
   已改成 `taskkill /T` 收整棵进程树，并补一条「命令行里带仓库 `.screenshots` 路径的孤儿进程」兜底
   （用户自己的知行数据目录在 `%APPDATA%`，不会被误伤）。

3. **两条与实现漂移的旧断言**（顺带修掉，否则它们会一直是红的假信号）：`interactioncheck` 里
   「任务页工具栏按钮不竖排」用的是早已不存在的 `.tasks-toolbar`（工具栏统一成 `components/Toolbar` 之后
   选择器取不到任何元素，`tallest` 恒为 `null`）；「工作流连线是贝塞尔曲线」与 docs/03 §14 的
   「工作流走正交折线、曲线 0 条」正好相反。两条都改成与当前实现一致的口径后，该脚本 36 项全绿。
4. **`vlistcheck` 在本机跑不了**：它 `require('node:sqlite')`，那是 Node 22 的内置模块，
   而 Electron 33 自带 Node 20 —— 与本次改动无关，属于脚本与运行时版本的前置条件不合。

> 这几条合起来解释了本轮排查中最费时的一段：一次「应用卡死」的现场里同时有两个独立原因
> （首屏 `getComputedStyle` + 残留子进程），去掉任意一个都能让现象暂时消失 ——
> 这也是为什么最后靠「整体回滚 → 按文件分组恢复」的二分才把它们分开。

---

## 9. 第二轮：用户两点新需求（同日）

### 9.1 番茄钟改成独立小窗

**为什么值得改（不只是"搬个位置"）**：它与主窗口的**生命周期本来就不同** ——
主窗口关掉只是收进托盘/浮窗，而专注该继续跑；原来的浮条跟着主窗口一起没了。
另外，独立小窗可以贴在工作区右下角 + 置顶，不占主窗口的视线。

| 层 | 做法 |
| --- | --- |
| 主进程 | `openPomodoroWindow()`：无边框 + 透明 + `alwaysOnTop` + `skipTaskbar`，定位在工作区右下角（`screen.workArea`，多显示器按主显示器算）；高度由既有的 `window:fitHeight` 贴合 |
| 渲染层 | 新入口 `PomodoroWindowApp`（`?pomodoro=1`）。卡片复用 `.modal / .modal__head / .dialog__icon / .modal__foot` —— 与全局热键的捕获窗、工作流条件确认窗**同一套骨架**，这就是"样式一致"的落点 |
| 协议 | 与捕获窗一致：主进程推 payload → 渲染层应用完主题发 `ready` → 主进程才显示（1.5s 兜底） |
| 状态宿主 | 计时、暂停、中断、落库全在**那个窗口**里；主窗口与桌面浮窗只是发起方（`window.zhixing.pomodoro.open({ taskId, title })`） |

**顺带修掉的既有缺陷**：桌面浮窗里的「专注」按钮原来派发的是**本窗口的** `zhixing:pomodoro` 事件，
而监听者（PomodoroBar）在主窗口 —— 那条路径**一直是哑的**。现在五个入口统一走 IPC。

**删掉的死代码**：`components/PomodoroBar.tsx` 与 `app.css` 的 `.pomo*` 段。
中断原因不再叠第二层浮层，改为在卡片里就地切换（`askReason` 一个状态）。

### 9.2 标签弹层与状态弹层对齐

原实现一行里挤了三件东西：色块按钮 + 勾选位 + **彩色胶囊**（"聚到一起"的来源）。

改成与状态菜单同一套：容器 `.popmenu`、每行 `.popmenu__item`（**色点 + 标签名纯文本 + 选中时的 ✓**）、
新建入口做成列表最后一行、调色板就地展开在所属标签行下面。
刻意保留 `.tagmenu` / `.tagmenu__swatch` / `.tagmenu__name` / `.tagmenu__color` 四个类名当**选择器钩子**
（`scripts/taglistcheck.mjs` 直接查它们），外观已全部继承 `.popmenu*`，这些名字不再有任何样式含义。

**验证**：用 CDP 造了 4 个标签、给任务挂 3 个，打开菜单后读到
`{ menu: true, rows: 6, dots: 4, ticks: 3 }`（1 说明行 + 4 标签行 + 1 新建行），截图确认视觉与状态菜单一致。
