# 知行 ZhiXing 对照「Electron 双核个人效能系统」— 差距分析与扩展优化提案

> 产出：基于对方需求架构文档（Electron+TS+React/SQLite+Markdown 文件库、dualcore:// 深链、块级双向互联「The Bridge」）与知行 v0.13+（PySide6+Fluent+SQLite，215 测试绿）的代码实测对照
> 日期：2026-09-08 · 对照方式：逐能力点 grep 知行源码核验（非猜测）

---

## 0. 一句话结论

**对方设计的灵魂 = 「待办（行）× 知识库（知）块级双向唤醒」；这恰是知行名字的本义与路线图的初心——但知行目前实现的是「笔记级」双向关联（任务↔整篇笔记 + 图谱），而对方提出的是「块级」（任务↔笔记内某一段落 + 可点击跳转高亮）。真正值得知行吸收的差异只有 3 类：①块级锚点互联 ②外部 Markdown 文件库与变更监听 ③Markdown 内嵌动态任务查询。其余能力知行已覆盖或超出（NLP 捕获、多视图、图谱、FTS、多窗口、主题体系）。**

---

## 1. 能力对照总表（知行实测 vs 对方设计）

| 能力域 | 对方设计（Electron 双核） | 知行现状（v0.13+） | 判定 |
| --- | --- | --- | --- |
| **任务存储** | SQLite `tasks`（status: TODO/DOING/WAITING/DONE） | SQLite + 领域模型（TODO/DOING/DONE/ABANDONED + 循环 RRULE + 子任务 + 优先级 + 标签） | 知行超集 |
| **任务视图** | 列表/看板/日历 | 列表/看板/四象限/日历 + 今日页 + 收件箱 | 知行超集 |
| **知识库** | **Markdown 文件系统 + chokidar 外部监听** | SQLite 存 note（markdown/richtext/word/excel/link 五格式）+ 文件夹 + 标签 + 版本历史 + 回收站 | 架构取向不同（见 §3） |
| **双向链接** | 未详述（仅任务↔块 URI） | **`[[wiki]]` 链接 + 力导向图谱 + 反向链接** | 知行超集 |
| **任务↔笔记互联** | **块级 URI `dualcore://note/<uuid>?block=<id>`，跳转滚动高亮段落** | 笔记级：任务关联笔记列表、笔记转任务、任务备注可链接笔记（右键/搜索） | **对方块级更强 → 知行扩 P1** |
| **NLP 快速捕获** | 速记窗内解析「明天3点」时间 | 全局速记 + 捕获卡 + **语法糖 `!优先级 @列表 #标签 + 今天/明天/周X/MM-DD 日期词`** | 知行基本等同（少具体时刻「3点」） |
| **全局唤醒** | `⌥Space` + 常驻隐藏速记窗 + 毛玻璃 + 多屏定位 | 全局热键（快捕 Ctrl+Alt+N / 划词 Ctrl+Shift+S）+ 速记窗 + 捕获卡 + 桌面浮窗 | 知行已覆盖（可补多屏/材质细节） |
| **搜索** | FTS5 + utilityProcess 隔离 | SQLite FTS + jieba 全文搜索 + 命令面板 + 标签过滤 | 知行等同 |
| **图谱可视化** | 未设计 | 力导向图谱（后台线程 + 观察者增量）+ 节点多色图标 | 知行领先 |
| **URI 深链** | `dualcore://` OS 协议注册（open-url/second-instance） | **无** | 知行扩 P2 |
| **Markdown 内嵌动态查询** | ```task-query 代码块 → 活任务列表（不污染 md 文本） | **无** | 知行扩 P2（新颖、谨慎评估） |
| **跨平台壳** | Electron（chromium 重） | PySide6 原生（轻，~60MB vs 200MB+） | 知行优，无需迁移 |
| **版本/历史** | 未设计 | 笔记版本历史 + diff + 回滚；回收站 30 天 | 知行领先 |

---

## 2. 对方 5 项设计细节的借鉴价值评估

1. **块级锚点（^block-id）生成与定位** — ⭐ 最值得借鉴。段落尾附加不可见锚 + 从段落一键生成任务 + 点击任务跳转滚动高亮。知行已有「段落选文 → 生成任务」（note_service.create_task_from_selection）与「笔记→任务关联」，**缺的是锚点持久化与回跳定位**——补齐即成闭环，且天然兼容知行现有任务表（加一列 `context_block`）。
2. **``task-query`` 内嵌动态任务视图** — 理念有创见（知识库纯文本、活数据不落盘）；但知行笔记在 SQLite 非 md 文件，此特性收益有限、实现成本高（编辑器需插件化视图）。**降级采纳**：仅做「笔记编辑器中以 `/` 命令插入只读任务摘要片段」或干脆不做，列入可选。
3. **外部 Markdown 文件库 + chokidar 实时刷新** — 前提是「知识库=md 文件夹、支持 Obsidian 等多软件同库协作」。知行的知识库在 SQLite（换来全文检索/版本/回收站/五格式）。**不建议推倒重来**；可加「md 文件夹导入/导出镜像 + 增量同步」作为协作口（见 P2-b），不监听实时（冲突管理成本高）。
4. **utilityProcess 隔离重型任务** — 知行已用 QThread 后台执行器（备份/导出/图谱/导入）+ 惰性构建，原则等价，无需改。
5. **速记窗常驻+材质+多屏** — 知行速记窗已常驻可全局热键唤出；可补「激活屏居中/半屏顶部定位」与亚克力材质（macOS）细节（见 P2-c）。

---

## 3. 知行「扩展 + 优化」提案（按收益/成本排序）

### P0（建议下版做，性价比最高）

| # | 功能 | 内容 | 落地要点 |
| --- | --- | --- | --- |
| 1 | **任务 ↔ 笔记「段落级」跳转** | 任务行/任务编辑页显示「关联段落」chip；点击 → 打开对应笔记并**滚动高亮该段落**（反向：笔记段落右键「生成任务」后，任务可一键跳回） | ①note 正文加轻量锚点协议：`markdown` 用标题/行号+文本指纹，不污染可见文本或仿 `^id` 隐藏锚；②新表/列 `task_context(note_id, block_key)`；③note_page 暴露 `locate_block(note_id, key)` 滚动+高亮 1.2s 淡出 |
| 2 | **捕获时刻 NLP 增强：补「具体时刻」** | 「明天3点开会」→ 截止=明天 15:00（现在只解析日期词） | task_rules 扩展 `parse_natural_datetime`：`X点/Y点半/中午/晚上/下午 N 点` 与日期词组合；快捕/速记窗/捕获卡共用 |

### P1（中期，显著拉开与同类差异）

| # | 功能 | 内容 | 落地要点 |
| --- | --- | --- | --- |
| 3 | **任务到图谱的段落级反链** | 图谱中笔记节点展开后显示「关联任务块」锚点子节点（虚线引用边），点击任务节点定位到段落 | 复用现有 graph 增量/边模型，仅新增一种锚点节点或 tooltip 富文本跳转 |
| 4 | **URI 深链 `zhixing://`** | 注册 OS 协议：`zhixing://task/<id>` / `note/<id>?block=`，外部（浏览器/快捷指令/Alfred）唤起并定位；单实例锁 + second-instance 转发 | macOS `CFBundleURLTypes` / Windows 注册表；仿对方 open-url/second-instance 双端处理（PySide6 用 QEvent FileOpen / argv） |
| 5 | **今日页/任务页「关联上下文体」** | 任务可在卡片上直接预览所关联笔记段落的首行（hover/展开），做「为什么做这件事」的上下文速读 | 任务行 chips 旁小书本图标 + hover tooltip 拉段落摘要（对齐对方 context_uri 的信息价值，去掉跨端复杂度） |

### P2（可选，小步验证）

| # | 功能 | 内容 | 落地要点 |
| --- | --- | --- | --- |
| 6 | **Markdown 文件夹双向同步** | 「导出知识库为 md 文件夹」+「导入 md 文件夹」双向增量（冲突保留 .conflict 副本），服务 Obsidian/笔记软件互操作 | 复用 JSON 导入导出执行器模式；不引入常驻 watcher |
| 7 | **速记窗体验细节** | 激活屏水平居中靠上 1/3；macOS 亚克力材质；输入框若为任务+回车后 200ms 显示 toast 已入收件箱 | 已有 capture_card/quick_capture 样式基线，改动面小 |
| 8 | **任务状态补 WAITING（等待他人）** | 现状 TODO/DOING/DONE/ABANDONED；补 WAITING 语义（延期到某日自动回 TODO 提醒） | 枚举+迁移+看板列/象限视图联动，属功能面，需评估与现有状态机耦合 |

### 明确不建议照搬（守住知行技术底盘）

- ❌ 迁移到 Electron/Web 技术栈 — 无收益，性能与包体倒退。
- ❌ 知识库主体改为 md 文件系统实时监听 — 放弃 FTS/版本/五格式的整合收益，且双写冲突成本高。
- ❌ 引入完整块引擎（如 Logseq 式 outliner）— 超出当前产品定位（块级「跳转定位」即可，不必「以块为原子」）。

---

## 4. 建议落地节奏

1. **下版（v0.15）**：P0-1 段落级跳转 + P0-2 时刻 NLP → 直接命中对方设计灵魂，改动集中在 note/task 两层 + note_page，风险可控。
2. **随后**：P1-3 图谱段落反链、P1-5 上下文速读（同一互联闭环的深化）。
3. **再评估**：P1-4 OS 深链（跨端打包工程）、P2-6 md 同步（验证实际需求）。

---

*本提案以「吸收对方可移植的设计灵魂、守住知行原生技术优势」为原则；逐项实施后回写本文件标注。*

---

## 5. v0.15 实施完成状态（2026-09-09 回写）

> 全量测试 **232 项转绿**（基线 215 + 新增 17：NLP 时刻 4、waiting/恢复 4、段落 context 1、图谱 anchor 2、深链 3、schema v7 断言更新等）；UI 冒烟通过；离屏/真机截图 9 张正常。

| 项 | 交付 | 落点 |
| --- | --- | --- |
| P0-2 时刻 NLP | 「明天3点」→ due 明天 + reminder_at 15:00；支持 14:30/3点半/下午5点/凌晨/中午 等；捕获语法糖/速记窗 chip 显示时刻 | task_rules `parse_clock/parse_natural_datetime`、capture_grammar `due_clock`、task_service.quick_create、quick_capture 回显 |
| P0-1 段落级双向跳转 | Markdown 右键「转为任务并关联段落」→ 落 `task_note_context`（block_key=snippet 首行指纹，不污染正文）；任务编辑页「§ 首行…」按钮 → 切笔记页滚动高亮段落（extraSelection 1.4s）；内容变更失配时安全打开笔记 | 新表迁移 v7、note_service/note_page/markdown_editor/task_editor/task_page/controller |
| P1-5 上下文速读 | 任务行 hover tooltip 显示「笔记标题 > 段落首 60 字」 | TaskDelegate.helpEvent + snippet_lookup（task_page/desktop_widget 注入） |
| P1-3 图谱段落反链 | task_note_context → 图谱 anchor 子节点（accent 小圆点，note→anchor、task→anchor 虚线）；双击/侧栏「定位段落」跳转 | graph_service（负空间 3e6、classify_edge 虚线）、graph_page、icons.node_shape_path |
| P1-4 OS 深链 | `zhixing://task|note|flash|folder/<id>[?block=]` 解析（纯函数可测）；单实例 QLocalSocket IPC 转发；主实例 QLocalServer 排队→show_main 后派发；controller.handle_deep_link 路由 | zhixing/core/deep_link.py（新）、app_controller、__main__ |
| P2-8 WAITING | 状态「等待中」全链路：5 处文案 + 看板列 + delegate 暂停符号（非划线）+ 编辑页状态选择器 + 「恢复于」resume_at 日期（waiting 专属，离开自动清除）+ 启动/跨天自动恢复为待办 + waiting 不弹到点提醒 | 枚举/迁移 v7 resume_at 列/task_rules 终态语义/repositories 提醒过滤/UI 五处/app_controller 自动恢复接线 |
| P2-7 速记窗细节 | 速记窗唤出定位鼠标所在屏；捕获卡定位钳制于鼠标屏（副屏不错位）；速记窗 chip 回显时刻 | quick_capture/capture_card 定位、app_controller |

**取舍记录**：task_note_link 未加 block 列（撞唯一约束）→ 独立 task_note_context 表；P2-6 md 文件同步按用户要求剔除（坚持本地独立知识库）；markdown 正文保持纯净（定位用指纹+引文快照，不注入 `^id` 锚字符）；qframelesswindow 在 macOS offscreen 下 SIGSEGV 为既有平台限制（README 已记录），冒烟在真实 GUI 验证。
