# 知行 ZhiXing · v0.14 视觉精修审计报告

> 产出：UI 取证子代理（只读，全量 13,195 行）+ 离屏渲染 9 张截图视觉审查（3 个独立视觉代理）+ 像素级复核
> 数据源：`zhixing/view/**`、`docs/03-UI-UX交互设计.md`、`docs/ui_audit_final_report.md`（v0.10 合规审计，33 项已清零，本报告不重复其范围）
> 方法：所有对比度数值按 WCAG 相对亮度**实测计算**（非估算）；渲染缺陷来自 `/tmp/zhixing-shots/*.png` 真渲染，仅截图为证
> 结论：**无 P0**（无功能/崩溃级）；P1 集中在「对比度不达标」与「双色并存不一致」；P2 面较广但均低风险局部整改

---

## 0.5 整改执行状态（v0.14 已按本报告 Top 10 实施完毕）

> 实施日期：2026-09-08 · 全量测试 **215 项转绿**（`.venv/bin/python -m unittest discover -s tests -q` → OK）
> 离屏渲染复核：改后截图 `/tmp/zhixing-shots/*.png`，视觉代理复核今日/任务/回顾页 **通过**（无叠压/错位/溢出，accent 派生、SVG 图标、对比度均生效）；改前基线 `/tmp/zhixing-baseline/`
> 像素 diff：浅色页差异 0.05-0.1%（预期微调量级）；回顾页 3.4% 经结构量化确认为「下部内容 4-8px 垂直回流 + 11→12px 字形/对比度变化」，无结构回归

| 项 | 整改内容 | 状态 | 主要落点 |
| --- | --- | --- | --- |
| T1 | accent 明暗派生 + on-accent 双模式 ≥4.5:1（light 白字/近黑自选，dark 升 V/混白）；修复 `_mix` 0..1 通道 bug | ✅ | theme.py `_accent_solid/_best_on/_contrast/_ensure_text_contrast/apply`；widgets.py UButton（solid 底+ghost 前景都走派生） |
| T2 | fg2 校正 ≥4.5、fg3 温和 4.0（14 主题包×双模式一次覆盖）；11px 辅助文字 13 处全部提至 12px | ✅ | theme.py `apply`；capture_card/splash/task_editor/note_page/inbox/today/review/widgets |
| T3 | 低优先级青色统一 accent token（`#0891B2` → accent，三处同源） | ✅ | task_page.py/kanban.py `_priority_color`（delegate 本就同源） |
| T4 | Unicode/emoji 图标 → SVG：⚠/✕/✓ 改 info 行 SVG 图标+`_set_info`；📄 附件改 data-URI PNG；← 返回箭头改 `action.back`；新增 `icons.data_uri` | ✅ | graph_page.py、richtext_editor.py、target_selector.py、icons.py |
| T5 | 导航 idle 图标 `#888` → fg2 token，主题切换自愈（`setIcon`） | ✅ | main_window.py `_add_navigation/_on_theme/_nav_icon_color` |
| T6 | 焦点可见性：UButton 全 tone/kind 补 `:focus` 边框（实底 2px ring / ghost 1px accent+soft 底，尺寸零跳动）；ItemView 选中态即焦点态维持设计决策 | ✅ | widgets.py UButton `_restyle_ui`（实测 focus Δ=0） |
| T7 | radius 收敛文档化：新增 `radius-ctl` 6px（UButton 对齐全局控件）；大弹层 12px 统一读 `radius-lg`；docs/03 §2.2 同步层级 | ✅ | theme.py COMPONENT_TOKENS、widgets.py、dialog/command_palette/capture_card/quick_capture、docs/03 |
| T8 | 命中区 ≥32px：task delegate/note tree 行内按钮垂直命中扩展（水平不扩防误触）；桌面浮窗入口 28→32；图谱节点标题 9→10pt | ✅ | task_delegate.py `_hit_rect`、note_tree.py `hit`、desktop_widget.py、graph_page.py `_TITLE_FONT_PT` |
| T9 | 截断与稳定：日历当日清单长标题省略号+tooltip；看板 tag 溢出 +N 计数；task 行 hover 不再挤压文本（布局恒定、hover 仅切按钮可见性） | ✅ | task_page.py `show_day_tasks`、kanban.py chips、task_delegate.py paint |
| T10 | 动效/空态一致性：UDialog 族统一 fade_in 进场；回收站三 Tab 空态（QStackedWidget+EmptyState）；导入保留同步（覆盖全库写，后台化有并发风险，README 有意设计） | ✅ | dialog.py showEvent、recycle_bin.py；BusySpinner 已有备份/导出后台接入 |

**新增/修改文件**：theme.py、widgets.py、icons.py、main_window.py、dialog.py、task_delegate.py、note_tree.py、graph_page.py、task_page.py、kanban.py、desktop_widget.py、richtext_editor.py、target_selector.py、recycle_bin.py、command_palette.py、capture_card.py、quick_capture.py、tests/test_ui.py（3 个断言改随 accent_solid 派生）、docs/03-UI-UX交互设计.md。

**待真机复核项**：UButton focus 环真机观感；深色 accent 混白档（紫/蓝）色相观感；任务行恒定按钮预留区的视觉留白是否可接受（可调 `actions_visible` 布局策略）。

---

## 0. 审计方法（三路交叉，防臆造）

1. **代码取证**：只读审计 `zhixing/view` 全部 84 个 Python 文件 13,195 行，逐条附【文件:行号】证据。
2. **渲染取证**：`scripts/visual_check.py` 离屏渲染 7 页浅色 + 2 页深色，3 个视觉代理独立审查，输出逐页缺陷清单。
3. **像素复核**：对视觉代理疑似误报（"标题栏彩色条带"）做像素级复核。

**复核排除的误报**：标题栏中部"彩色数字条带 2 2 5 4 1 6"经像素分析（彩色像素占比 <0.25%，青绿 accent 系集中于 y≈40-60px）= **翻页时钟 FlipClock**（截图时刻 22:54:1x，HH:MM:SS 数字 + accent 着色），属 v0.11 特性，非缺陷，不进整改清单。

---

## 1. 实测对比度矩阵（P1 · 最高优先）

对照 §2.1「对比度 ≥ 4.5:1」设计规约与 WCAG AA。以下均为白字/灰字对真实面底色的实测值：

| Token/用法 | 实测对比度 | 位置 | 判定 |
| --- | --- | --- | --- |
| accent `#0D9488` + 白字（实心主按钮） | **3.74:1** | theme.py:100-105 | ❌ 亮色不达标（大字号 18px+ 才豁免 3:1） |
| light `fg3` `#A8AEB6`（辅助文字） | **2.24:1** | 主题包定义 | ❌ 严重不达标 |
| dark `fg3` | **3.56:1** | 主题包定义 | ❌ 不达标 |
| success 绿 `#16A34A` + 白字 | 3.30:1 | theme.py | ❌ 不达标 |
| warm 橙 `#EA580C` + 白字 | 3.56:1 | theme.py | ❌ 不达标 |
| accent_soft 选中底 + fg 字 | 8.5:1 | 派生 | ✅ 达标（无黑底残留） |

**根因**：`apply()` 中 `accent` 取强调色原值、明暗**同值不派生**（theme.py:100-105），且 `accent_fg` 恒为白（:105）。暗色下青绿不自动提亮 → 按钮/选中态文字在深色面仍用同一深青。

> 对照 ui-ux-pro-max 可访问性 P1「文字对比 ≥4.5:1」与 pro-rules「Light/Dark 双模式独立测量」。

---

## 2. P1 · 一致性与 token 纪律

| # | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| 2.1 | **低优先级青色双色并存**：`#0891B2`（task_page.py:1017 / kanban.py:41）vs `#0D9488`（task_delegate.py:27） | 同语义（低优先级）两套色值 | 提为语义 token `priority-low`，两处同源 |
| 2.2 | **导航图标硬编码 `#888`** | main_window.py:138-151 七处 `icons.icon(..., "#888", ...)` | 改读 `fg2` token；hover/选中换色由图标引擎接管 |
| 2.3 | **11px 文字 13 处** + fg3 辅助文字体系性不达标 | 全 view | 辅助文字 ≥12px 且用修亮后的 fg3；禁用级可用 11px+40% 透明（pro-rules 禁用态纪律） |
| 2.4 | **Unicode 当图标**：`⚠`（graph_page.py:880）、`✕✓`（graph_page.py:1199）、`📄`（richtext_editor.py:77）、`←`（target_selector.py:40）、工具栏「•列表/＋文件夹」文本符号 | 见证据 | 全部换 SVG 图标（项目已有 `graph.*`/`action.*` 图标资产与 `icons.icon()`） |
| 2.5 | **兜底字面量约 150 处**：`eng.t(key, "#RRGGBB")` 写死兜底色 | 全 view | 兜底统一收敛到常量/主题包缺省，避免散落十六进制（架构级，低危但值得收） |

---

## 3. P2 · 细节打磨清单（按 ui-ux-pro-max 优先级表归类）

### 3.1 可访问性
| # | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| 3.1a | ItemView 焦点不可见：`outline:0` | theme.py:346、380 | ItemView 键盘导航靠 `item:selected` accent_soft 可辨，但纯键盘 tab 到列表时整体无焦点提示 → 保留 outline:0 但补 QSS `QTreeView:focus` 可选项或文档声明选中态即焦点态 |
| 3.1b | 局部 setStyleSheet 按钮吞全局焦点环 | settings swatch、task_page 危险钮（自绘 QSS 无 `:focus` 规则） | UButton 已带 focus 规则，散落裸按钮统一收编或补 focus |
| 3.1c | 仅 desktop_widget.py:116 一处 accessibleName | 全 view | 悬浮胶囊按钮为 paint 自绘非真 widget（读屏不可达），保持现状但纯图标 QToolButton 补 setAccessibleName |

### 3.2 几何/密度一致性（对照 §2.2：卡片 8 / 控件 6 / 弹层 10）
| # | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| 3.2a | 弹层类 12px vs 规范 10px | dialog.py / command_palette / capture_card / quick_capture | 收敛：明确「弹层 12px 为 UDialog 新规」并改文档，或统一回 10px |
| 3.2b | 卡片圆角 8/12 混用 | UCard(radius-lg=12) vs theme radius-md=8 | 定义卡片族 = 12（沉浸卡）vs 内容内嵌 = 8，文档写明 |
| 3.2c | 行高 34（笔记树 theme.py:142 QSS min-height:34）vs 38（任务行） | theme.py:142、delegates | 同类列表行高收敛 |

### 3.3 命中区（对照 §2.2 命中区 ≥32px、pro-rules touch target）
| # | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| 3.3a | 悬浮胶囊按钮/优先级 pill 14-20px、看板 chip 16px、桌面浮窗入口 28px | task_delegate.py / kanban / desktop_widget.py | 桌面鼠标场景 ≤32 亦可辨，但建议 pill 视觉 20px + 扩展透明命中区到 28-32px（hit 区与视觉分离） |
| 3.3b | 图谱节点标题 9pt | graph_page.py:154 | 最低 10-11pt |

### 3.4 排版与布局稳定性
| # | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| 3.4a | 日历当日清单裸 QLabel 无省略号截断（240px 固定面板） | task_page.py:1398-1401 | 加 elide/换行 + tooltip |
| 3.4b | 看板 chip 溢出静默截断无 +N | kanban | 末尾 +N 计数 |
| 3.4c | hover 浮出按钮致行内容**左移跳变**（hover 显示 3 按钮时文本让位） | task_delegate.py:177 | 内容区固定宽度 / 按钮层叠于行右侧不挤压文本（布局稳定性，pro-rules「layout-shifting 禁止」） |

### 3.5 动效一致性（对照 §2.4 动效 token）
| # | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| 3.5a | 弹层/浮窗全部**瞬时出现**：`motion.fade_in` 仅 task_editor 使用 | 全 view | 统一 `fade_in(fast)`：UDialog、命令面板、捕获卡、QuickCapture、回收站、设置改键弹窗 |
| 3.5b | Skeleton 零实例、BusySpinner 仅设置页 | 全 view | 图谱首载/全量导入/备份等长任务挂 BusySpinner 或 Skeleton |

### 3.6 空态/加载态缺口
| # | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| 3.6a | 回收站三 Tab 无空态 | recycle_bin | EmptyState 组件已全铺 6 主页面（亮点），补齐此三 Tab |
| 3.6b | 回顾页图表空数据无提示（渲染取证：四卡全空无「暂无数据」） | review_page（渲染确认） | 空数据时显示轻量「完成第一个任务解锁统计」占位或图内提示 |

---

## 4. 渲染取证补充发现（截图真渲染，非代码推断）

### 4.1 需真机复核项（离屏降采样 999px 级无法 100% 确认）
- 设置页表单区「疑似文字叠印/残影」于 控件高度/字号 行值列左缘（视觉代理 A 报，x≈205 预览位）；**像素复核未见明确双重字形，判定为降采样伪影概率高，待真机目检**。
- 强调色 chip「青」字疑似镜像（同源降采样伪影，待复核）。
- 深色「快速添加」输入框上缘高亮、侧缘弱 → 疑为 focus 态边框正常表现，待复核。

### 4.2 已确认的渲染观感（跨页共性）
- **卡片层次偏「平」**：UCard 羽影+顶部受光在渲染中偏弱，卡片主要靠极浅填充/淡边框区分（视觉代理 A/B/C 三组一致）；设计基准为「无边框+羽影+顶部受光」沉浸卡。对照 hallmark「materiality：用 elevation 表达真实层级」，建议**微增羽影峰值/顶部受光**并真机校准，勿加描边（避免回到描边卡观感）。
- **空数据页空洞**：回顾页 4 图全空无空态提示（见 3.6b）；任务/今日大卡仅 1-2 条时下方留白大，属正常（非缺陷），但 0 条时应确保 EmptyState 触发（任务树已具备）。
- 三张主清单页右上的小数字串（渲染误读为彩色条带）经像素复核=翻页时钟，见 §0。

### 4.3 渲染确认的「精致」保持点（勿在整改中回退）
- 标题/副标题三级字阶（17-20px/12px）灰度正确（全页一致）。
- 编辑工具栏胶囊组节奏统一（B/I/H1/H2/H3/列表/链接/代码块）。
- 成就卡 6 枚 FlowLayout + Lucide 线条图标族完整度高。
- 左导航选中态：图标 accent + 左缘指示条，克制清晰。

---

## 5. 亮点（审计确认，保持不动）

- U 系列组件库（UButton/UCard/UStatusPill/UTitle）+ token QSS 分层已统一主工作面；settings 少量裸 qfluentwidgets 属 A 路线「保留基础元件」有意为之。
- EmptyState 已全铺 6 主页面；动效（划线/弹簧/stagger/图表生长/翻页/数字滚动）已落地并接 reduce-motion 与 OS 探测。
- SVG 图标体系（Lucide 风格、currentColor 运行时着色）无 emoji 混入主界面；TaskDelegate 四处复用。

---

## 6. Top 10 优先修（建议 v0.14 批次顺序）

| 序 | 整改项 | 级别 | 预计改动面 |
| --- | --- | --- | --- |
| 1 | accent 明暗派生 + on-accent 文字双模式 ≥4.5:1（重点 dark） | P1 | theme.py apply() 派生 |
| 2 | fg3 提亮 + 11px 辅助文字 → ≥12px 且对比达标 | P1 | 主题包定义 + 13 处字号 |
| 3 | 低优先级青色统一 token（#0891B2 → 同源） | P1 | task_page/kanban/delegate |
| 4 | Unicode/emoji 图标 → SVG（⚠✕✓📄← 及工具栏文本符号） | P1 | graph_page/richtext/target_selector/工具栏 |
| 5 | 导航图标 #888 → fg2 token | P2 | main_window 七处 |
| 6 | ItemView/局部按钮焦点可见性补强 | P2 | theme QSS + 散落按钮 |
| 7 | radius 收敛并文档化（卡片 12 / 内容 8 / 控件 6） | P2 | UCard/dialog + 文档 |
| 8 | 命中区 ≥32px（视觉 20px + 透明命中扩展） | P2 | delegate/kanban/desktop_widget |
| 9 | 日历/看板截断修复 + hover 不挤压行内容（防左移跳变） | P2 | task_page/kanban/task_delegate |
| 10 | 动效一致性（弹层族 fade_in）+ Skeleton/BusySpinner 长任务 + 回收站空态 | P2 | dialog/pages/recycle_bin |

---

## 7. 验收方式

1. 全量测试保持绿：`.venv/bin/python -m unittest discover -s tests -q`（当前 215 项）。
2. `scripts/visual_check.py` 离屏渲染 + 人工复核 9 张截图（浅/深各 4 页 + 设置）。
3. 重点真机目检：accent 按钮在亮/暗/8 主题包下的文字对比、卡片羽影层次、hover 任务行是否位移、弹层进场动效、回收站空态。
4. 本批为纯视觉整改，不应新增功能面；改动不触碰 Model/Service 层。

---

*报告由本会话审计流程产出；整改批次按用户确认范围执行后再回写本文件逐项标注。*
