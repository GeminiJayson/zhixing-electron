# zhixing-electron

**知行 ZhiXing 的 Electron 重构实现**：一个本地优先的个人待办 + 知识图谱桌面客户端，与 Python（PySide6）版**共用同一个 SQLite 数据库**。

- 独立仓库：`zhixing-electron`（GitHub: [GeminiJayson/zhixing-electron](https://github.com/GeminiJayson/zhixing-electron)），当前版本 `0.1.7`（`package.json`）。
- 对照实现：**`zhixing_python`**（Python / PySide6 应用，位于 [GeminiJayson/zhixing_python](https://github.com/GeminiJayson/zhixing_python)）。本文出现的 `zhixing/...`、`zhixing.spec`、`build_windows.bat` 路径均属该仓库。
- 八页功能面已全部实现（`src/renderer/src/nav.ts` / `App.tsx`），综合完成度 **~70%**（分域数字见 [04-与Python实现的差异点](docs/04-与Python实现的差异点.md) §5）。
- 本地优先：核心功能零网络依赖、无遥测、无账号（NFR-01）。
- 定位上它是**并行的重构实现**，不是 Python 版的即时替代；两版长期共存、互不破坏数据。

> 本文是索引与入口，细节以 `docs/01`–`04` 四份主文档为准。口径排序：**代码 > `04` 文档 > 其余文档**；`docs/parity-audit.md` 的总览与 `docs/audit/*` 明细表是审计当时的快照，不作为事实源。

## 1. 与 Python 版的关系

两版**读写同一份 SQLite 文件**，因此数据目录、库结构、迁移链与中文分词被要求逐项一致：

| 项 | 约定 | 证据 |
| --- | --- | --- |
| 数据目录 | 与 Python `data_dir()` 逐条对齐，支持 `ZHIXING_HOME` 覆盖 | `src/main/db/connection.ts:18-32` |
| schema | `SCHEMA_VERSION = 12`，必须与 Python 的 `Base.metadata.create_all + _FTS_DDL` **逐字一致** | `src/main/db/schema.ts`（生成物） |
| 表规模 | 24 张 = 21 业务表 + 3 张 FTS5 虚拟表 | `docs/02` §6.1 |
| 迁移链 | v1–v12，逐号对应 | `src/main/db/migrate.ts:22-118` |
| 分词 | 与 Python `cut_for_search` 逐字一致，交 `unicode61` 索引 | `src/main/db/fts-query.ts:33-47`、`fts-query.test.ts` |
| 时间戳 | 必须写成 Python `datetime.now()` 的默认字符串形态（微秒 6 位） | `src/main/db/connection.ts:178-190` |
| 连接 | `journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=4000` | `src/main/db/connection.ts:141-143` |

Electron 侧是**读写**打开（`connection.ts:137-152`，无 `readonly`），首次运行会自建数据目录与库文件，并执行 v1–v12 迁移链。

## 2. 当前完成度（综合 ~70%）

口径：以「Python 侧该域的功能面」为 100%，按**主链可用 / 写路径接通 / UI 入口 / 护栏**四项加权，不是按条数比例。

| 域 | 完成度 | 主要缺口 |
| --- | ---: | --- |
| 任务 | ~78% | 清单「移动到清单」无 UI、任务↔笔记段落上下文、`resume_at` 不可写、子任务 list 继承、日历口径 |
| 笔记 | ~65% | 富文本无编辑器、Office 只读、附件与改格式、笔记↔任务/文件夹关联无 UI、MD 导入 |
| 图谱 / 搜索 / 回顾 | ~58% | 破环未接线、引用边与 anchor 不入图、无 delta、无过滤/图内搜索、无预览；搜索缺 MRU |
| 收件箱 / 工作流 / 捕获 | ~65% | `source_url` 无 UI、转子任务/指定目录无 UI、模板复制/重命名/删步/排序/SOP 绑定、捕获五去向 |
| 设置 / 平台 / 窗口 | ~68% | mica/浮窗开关无 UI、字号行高偏移、浮窗启动联动、边缘缩放、托盘图标、热键状态 |
| 数据 / 统计 / 维护 | ~78% | 只读模式/横幅、before-import 未 prune、导入非导出表残留、域广播不完整、番茄 reason/休息记账 |
| 打包与发布 | ~70% | 无代码签名、无自动更新、仅 Windows 目标 |
| 渲染与交互 | ~80% | 虚拟滚动、共享 pan/zoom、贝塞尔连线、对比度校正、i18n 骨架均已具备并有脚本/单测守护 |
| **综合（按域功能面加权）** | **~70%** | 三处结构性断链：段落级上下文、笔记格式体系、图谱语义完整性 |

对照 152 条审计项的复核判决：仍成立 83 / 部分修复 27 / 已修复 42（旧文档中 69 条描述已过时），另有新增域 14 条，**共 124 条差异**。

## 3. 技术选型

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 壳 | Electron `^33.3.1` | 无边框窗口 + 自定义标题栏（`titleBarStyle: hiddenInset`） |
| 构建 | electron-vite `^2.3.0` + Vite `^5.4.11` | main / preload / renderer 一次构建到 `out/` |
| UI | React `^18.3.1` + TypeScript `^5.7.2` | 无 UI 框架，样式全走 CSS 语义 token（11 个 CSS 文件） |
| 数据 | better-sqlite3 `^11.10.0` | 原生模块，直接打开与 Python 版共用的 `zhixing.db`（读写） |
| 分词 | @node-rs/jieba `^2.0.3` | 与 Python `cut_for_search` 输出逐字一致 |
| 编辑器 | CodeMirror 6（6 个包） | Markdown 高亮、`[[` 补全、撤销栈 |
| 图谱 | d3-force `^3.0.0` | 力导向布局；连线几何为自研纯函数 |
| 文档解析 | mammoth `^1.12.3`、xlsx `^0.18.5` | Office 只读预览（主进程解析 + HTML 清洗） |
| 打包 | electron-builder `^26.15.3` | NSIS + portable，`asarUnpack` 原生模块 |
| 单测 | vitest `^2.1.9` | 只覆盖 `src/**/*.test.ts` 纯函数 |

## 4. 环境要求

- **Node.js 20+**（项目在 Node 26 上开发，20 / 22 均可）。
- **Windows 优先**：打包目标当前只有 Windows；数据目录、托盘、热键、云母材质按平台分支（NFR-05）。
- **Visual Studio Build Tools**（勾选「使用 C++ 的桌面开发」）：用于编译 `better-sqlite3`。不装可改用预编译二进制 `npx prebuild-install -r electron -t <Electron版本>`（在 `node_modules/better-sqlite3` 内执行）。
- **Python 3.11+ 与 SQLAlchemy**：仅在重新生成 `src/main/db/schema.ts` 时需要（见 §8）。
- 未配置 ESLint / Prettier（**未取证**：仓库内无相关配置文件，风格靠约定与 review）。

## 5. 安装与运行

```bash
npm install --ignore-scripts          # better-sqlite3 是原生模块，需跳过自动脚本
node node_modules/electron/install.js # --ignore-scripts 会跳过 Electron 二进制下载，手动补上
npx electron-rebuild -f -w better-sqlite3   # 按 Electron ABI 重建 better-sqlite3
npm run build                         # electron-vite 构建 main/preload/renderer 到 out/
npm run dev                           # 开发模式（HMR）
```

其他入口：`npm run typecheck`（`tsc --noEmit` 双 tsconfig）、`npm test` / `npm run test:watch`（vitest）、`npm run preview`（electron-vite preview）、`npm run rebuild`（重跑 electron-rebuild）。

## 6. 验证脚本体系

`scripts/` 顶层 **28 个文件 = 27 个 `.mjs` + `export-schema.py`**（另有 `scripts/fixtures/gen-office-fixtures.py` 夹具生成器）。

统一方法论：**拷贝备份库到临时 `ZHIXING_HOME` → 启动真实 Electron（`--remote-debugging-port`）+ WebSocket/CDP → 经 IPC 操作 → 用 `sqlite3` CLI 校验落库**；多数脚本只在副本库上跑，绝不碰真实库。

最常用的几个：

| 脚本 / 入口 | 作用 |
| --- | --- |
| `node scripts/smoke.mjs` | 冒烟：主进程 → 窗口 → preload 注入 → better-sqlite3 读库 → React 渲染整链路 |
| `node scripts/writecheck.mjs` | 写入链路：任务增/改/删（IPC → db → SQLite），18 个断言点 |
| `npm run typecheck` | 三端类型检查，改动后最先跑的一条 |

按类别（断言点数为审计计数）：

| 类别 | 脚本 |
| --- | --- |
| 链路写入 | `writecheck`(18)、`notecheck`(28)、`inboxcheck`(16)、`workflowcheck`(17)、`taskopscheck`(14) |
| 口径 / 维护 | `todaycheck`(20)、`rollcheck`(25)、`recyclecheck`(18) |
| 数据安全 | `importcheck`(13)、`securitycheck`(5) |
| UI / 交互 | `dialogcheck`(10)、`editorcheck`(8)、`layoutcheck`、`vlistcheck`(8)、`officecheck`(13)、`interactioncheck`(32)、`themecheck`(18)、`graphcheck`(5) |
| 架构 / 可访问性 | `eventcheck`(8)、`contrast-audit`、`check-jieba-fallback`(4) |
| 构建 / 发布 | `ensure-jieba-win-binding`、`upload-release`、`export-schema.py` |
| 视觉诊断 | `capture`、`bigcapture`、`diag-today` |

进 `package.json` 的 npm 入口共 6 条：`typecheck` / `test` / `check:jieba` / `check:security` / `check:contrast` / `check:interaction`；其余按需手工执行。

单元测试为 vitest：**14 个测试文件 / 86 个用例**，只覆盖纯函数（`vitest.config.ts:11-19` 明确排除涉及 SQLite / IPC / 真实窗口的部分，那部分留在 `scripts/*.mjs`）。

## 7. 打包与发布

完整说明见 **[docs/windows-build.md](docs/windows-build.md)**，一条命令出包：

```bash
npm run dist:win    # 先跑 ensure-jieba-win-binding.mjs → electron-vite build → electron-builder --win --x64
```

产物落在 `dist/`：`Zhixing-<版本>-x64-setup.exe`（NSIS 安装包）与 `Zhixing-<版本>-x64-portable.exe`（免安装单文件）。只想看目录结构用 `npm run dist:dir` → `dist/win-unpacked/`。

两个前置要点：

- **`dist:win` 必须带 jieba binding**：`@node-rs/jieba` 的各平台二进制放在它自己的 `optionalDependencies` 里，npm 只装当前平台那份；另一平台出的 Windows 包缺 `jieba.win32-x64-msvc.node` 会启动即崩。`ensure-jieba-win-binding.mjs` 按包自声明版本补齐，**不要绕过 npm script 直接调 `electron-builder`**。`npm run binding:win` 可单独补齐，`npm run check:jieba` 验证运行时降级守卫。
- **dist 后必须还原本机 ABI**：`dist:*` 已接 `postdist:*` → `npm run rebuild`，否则开发模式启动即报 `better-sqlite3` 加载失败。

发布：`node scripts/upload-release.mjs v<版本>` 默认只预演，加 `--upload` 才创建 Gitee Release，token 三级回退（`--token` > `GITEE_TOKEN` > `git remote`）。当前**未配置代码签名**（SmartScreen 提示未知发布者）、**未接入 electron-updater**、**仅 Windows 目标**（macOS 需 `.icns` 与公证）。

## 8. 跨仓库依赖：`schema.ts` 由 zhixing_python 生成

Electron 侧没有 ORM，库文件不存在时必须自己建库；DDL 若手抄必然与 Python 侧漂移。因此 `src/main/db/schema.ts` 是**生成物，禁止手改**：

```powershell
# 在本仓库根目录执行（PowerShell）
$env:ZHIXING_PY_ROOT = "D:/Development/zhixing_python"
python scripts/export-schema.py
```

```bash
# bash / zsh
ZHIXING_PY_ROOT=../zhixing_python python scripts/export-schema.py
```

生成器（`scripts/export-schema.py`）需要 **`ZHIXING_PY_ROOT` 指向一份可 import 的 `zhixing_python` 检出**（须存在 `zhixing/model/infrastructure/models.py`）以及可用的 Python + SQLAlchemy；未设置或指向的目录不像该仓库时以非零码退出，绝不静默产出错误的 `schema.ts`。

变更流程（必须遵守）：Python 侧改模型 / `SCHEMA_VERSION` → 在 **Electron 仓库根**重跑生成器 → 提交新的 `src/main/db/schema.ts` → 若版本号增加，同步补 `src/main/db/migrate.ts` 的对应迁移步骤。任一侧只改一半，另一个客户端打开新库就会缺表或读不懂旧库。

> **未取证**：拆分前的单仓版本用 `Path(__file__).resolve().parents[2]` 推断仓库根、不读该变量；本仓库采用拆分后的 `ZHIXING_PY_ROOT` 版本。生成器与跨仓库路径未在拆分后的目录结构上实测。

## 9. 数据位置与「与 Python 版共存」

| 平台 | 路径 |
| --- | --- |
| Windows | `%APPDATA%/ZhiXing/zhixing.db` |
| macOS | `~/Library/Application Support/ZhiXing/zhixing.db` |
| Linux | `~/.zhixing/zhixing.db` |

`ZHIXING_HOME` 可整体覆盖数据目录（与 Python 版同语义），既是便携模式，也让写入验证跑在副本库上。

> ⚠️ 两版读写同一份 SQLite（schema v12），**不要同时打开**——避免并发写入冲突。Python 版的 `build_windows.bat` 打包脚本仍可用，互不影响。

## 10. 目录结构

```text
zhixing-electron/
├── package.json  package-lock.json  electron-builder.yml  electron.vite.config.ts
├── tsconfig.json  tsconfig.node.json  tsconfig.web.json  vitest.config.ts
├── resources/                     # icon.ico、trayTemplate.png
├── src/
│   ├── main/                      # 主进程：index.ts（窗口/托盘/热键/浮窗）、security.ts、log.ts
│   │   └── db/                    # 数据层 22 文件（connection / schema / migrate / tasks / notes / graph / …）
│   ├── preload/                   # 唯一特权入口，contextBridge 暴露 window.zhixing
│   ├── renderer/                  # React 应用：pages/（八页）components/ lib/ styles/ i18n/
│   └── shared/                    # 主/渲染共用纯函数 19 文件（types / events / settings / color / …）
├── scripts/                       # 28 个顶层验证与构建脚本
└── docs/                          # 01–04 主文档 + windows-build / parity-audit / audit/ 等
```

## 11. 已知缺口与后续行动

摘要自 [04-与Python实现的差异点](docs/04-与Python实现的差异点.md) §7：

**7.1 接线即可闭合（后端已具备，只差 UI / preload 参数）——优先做**

1. T1「移动到清单」：调用 `moveTaskToList`（`src/preload/index.ts:91` 零调用）。
2. I6 闪念转「子任务」：收件箱加入口（`src/preload/index.ts:48` 零调用）。
3. I7 转笔记指定目录：收件箱传 `folderId`。
4. N3 改笔记格式：`saveNote` 类型补 `format` + 界面入口。
5. D18 番茄中断原因：`recordPomodoro` 补第 4 参 `reason`。
6. G2 破环接线：把 `wouldCreateCycle` 接进 `buildGraph` 并输出 `cycleEdges`。
7. I1/I2 `source_url`：两处 `addFlash` 传 `source_url`。

**7.2 描述性修复（无需改逻辑）**：回填 `docs/audit/` 六份明细表的结论列；在差异审计盘点表补 `upload-release.mjs`。

**7.3 需要产品决策**：T11 日历口径、T6 子任务 list 继承、G14/G15 完成统计过滤、T12 改挂排序语义、S22 深链粒度、S6/S7 字号行高映射、D2 只读模式、D24 种子数据。

**三处结构性断链**（最影响完成度）：任务↔笔记段落级上下文（T3/N10/N11）、笔记格式体系（N4/N5/N3）、图谱语义完整性（G2/G3/G4）。

## 12. 文档导航

| 文档 | 内容 |
| --- | --- |
| [01-需求规格说明书](docs/01-需求规格说明书.md) | Electron 实现范围内的需求（R-T/N/I/G/D/S/P + NFR）、完成度快照、有意简化汇总、范围外清单、需求→验证资产映射 |
| [02-技术架构设计](docs/02-技术架构设计.md) | 三进程分层、contextBridge 暴露面、IPC 与按域广播、数据层 22 文件、schema v12 与跨仓库契约、共享层、构建链、验证体系、安全模型、架构债 |
| [03-UI-UX交互设计](docs/03-UI-UX交互设计.md) | 设计令牌体系（`tokens.css`）、布局框架、任务页四视图、侧栏/标题栏、桌面浮窗与托盘、命令面板、编辑器、交互缺口清单 |
| [04-与Python实现的差异点](docs/04-与Python实现的差异点.md) | **差异总入口**：152 条复核判决、按域权威差异清单（124 条）、Electron 独有能力、完成度评估、后续行动清单 |
| [windows-build.md](docs/windows-build.md) | Windows 出包、jieba binding 前置、Gitee 上传、数据位置、未配置项 |
| [parity-audit.md](docs/parity-audit.md) | 最初审计总览与批次 0–4 修复历史（总览数字为审计当时快照） |
| [audit/](docs/audit/) | 六份分域明细表（task / notes / graph-search-review / inbox-workflow / settings-platform / data-maintenance，**结论列未回填**） |
| [optimization-proposals.md](docs/optimization-proposals.md) | O1–O11 工程债提案，均已闭合 |
| [feature_compare_vs_dualcore_electron.md](docs/feature_compare_vs_dualcore_electron.md) | 功能对照分析 |
| [docs/agents/](docs/agents/) | 仓库协作说明（issue-tracker / triage-labels / domain） |

四份主文档的事实基准是 `src/**` 当前工作树，与代码冲突时以代码为准。

## 13. 安全模型（Electron 侧独有）

`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`（主窗与浮窗都设）；`index.html` 声明 meta CSP（`default-src 'self'`，`connect-src` 含 HMR 的 `ws:`）；`will-navigate` / `setWindowOpenHandler` / `will-attach-webview` 三道出口收口，外链仅放行 `http/https/mailto`。Python 侧没有对应的 CSP / sandbox 层，这些防线是本仓库自己的责任，不因「与 Python 对齐」而降级。

## 14. 近期能力更新（2026-09-19）

本批围绕「不打断用户、不丢内容、可回退」补了几处：

| 能力 | 说明 | 关键实现 |
| --- | --- | --- |
| 全局热键读取「当前选中的文字」 | 三个热键（划词捕获 / 读取选中并速记 / 快速任务）先模拟一次 Ctrl+C 取走选区的文本与 HTML，再把剪贴板原样还回；复制前写哨兵值，避免「什么都没选中」误读旧剪贴板 | `src/main/selection.ts`、`scripts/selectioncheck.mjs` |
| 三个热键改为独立小窗口 | 无边框 + 透明圆角卡片、置顶居中，**不显示主窗口**；高度跟着卡片内容贴合 | `captureWindow`（`src/main/index.ts`）、`CaptureWindowApp.tsx` |
| 工作流条件确认独立小窗 | 人工确认节点不再占用主窗口，「成立 / 不成立」语义与原生模态一致 | `ConditionApp.tsx`、`scripts/condwincheck.mjs` |
| 确认操作统一应用内弹框 | 15 处 `window.confirm` 全部收回，带圆形底色图标（危险=红） | `src/renderer/src/components/Dialogs.tsx` |
| 外部任务源同步 | GET 一个 JSON 接口，按 `(source, id)` 幂等 upsert；字段映射支持 JSON 路径；可开自动同步；按标题去重时「认领」本地同名任务 | `src/main/task-sync.ts`、`scripts/tasksynccheck.mjs` |
| 工作流模板分类树 | 分类 → 模板两层，行内编辑胶囊，实例可重命名 | `workflow_group` 私有表、`WorkflowPage.tsx` |
| 整库整理专用默认提示词 | 批量场景更克制：只规整排版、不重写句子 | `DEFAULT_AI_LIBRARY_PROMPT`（`src/shared/ai-note.ts`） |

全流程冒烟见 `scripts/seedmonitor.mjs`：56 步，覆盖任务 / 笔记 / 工作流 / AI / 设置 / 右键菜单 / 拖拽 / 主题包。

## 15. 已决策不做（2026-09-19）

以下项经确认**不实现**，不再计入缺口：

| 项 | 决定 |
| --- | --- |
| 自动更新（`electron-updater`） | 不做：改为手动下载新安装包，避免后台静默升级带来的不确定性 |
| 代码签名证书 | 不做（当前阶段）：Windows SmartScreen 会提示「未知发布者」，属预期行为 |
| AI 读图 / 把附件内容送模型 | 不做：模型链路保持纯文本，图片与附件只做本地存储与展示 |
| Markdown / Obsidian 导入迁移 | 不做：只保留自有格式的整库导入导出 |
| 多语言界面 | 不做：维持中文单语（`i18n` 骨架保留，便于将来接第二种语言） |
| macOS / Linux 出包 | 不做：仅 Windows 目标；「热键读取选中文字」也只在 Windows 实现，其它平台降级读剪贴板 |
| 窗口特效（mica / 亚克力）、边缘缩放、浮窗开关 UI | 不做：维持现有窗口形态 |
| 只读模式 | 不做：需要时用文件权限或只读备份代替 |

## 16. §11 缺口清单的重核结论（2026-09-19）

§11 与 [03 §12](docs/03-UI-UX交互设计.md) 列的缺口有多条**早已闭合**，逐条 grep 核实后：

- 已闭合：`window.confirm` 迁移、「移动到清单」入口、闪念转子任务/转笔记指定目录、改笔记格式、番茄中断原因、图谱破环、`source_url` 传递、日历「显示已完成」、虚拟滚动、启动 splash、图谱订阅 `flash` 域、**取消完成回到原状态**（`App.tsx:362` 用 `prevStatus`）、**子任务继承父任务清单**（`tasks.ts:302-305`）、**富文本编辑器工具栏**（字号/颜色/加粗等，`MarkdownEditor.tsx:443` 起）。
- 仍然缺：任务 ↔ 笔记的**段落级上下文**（大）、**附件管理**（中）、Word / Excel 笔记的应用内预览（本版改为「用系统应用打开」出口）。

后续讨论以本节与 `docs/04 §10` 为准，不再引用 §11 的旧清单。

## 17. 待办清单（已确认、未排期）

来自[竞品对比调研](docs/research/product-comparison-2026.md) §5 与内部讨论：

| 项 | 说明 | 状态 |
| --- | --- | --- |
| **工作流触发器（定时 / 系统事件）** | 给模板加触发器：每天定时、开机后、文件夹变化、剪贴板匹配 —— 把已有的节点编排接上「自动开始」。对标 Alfred Workflows / Apple 快捷指令的触发模型 | **未做（本轮明确推迟，落盘在此）** |
| 笔记的数据库视图 | 依赖「保存的查询」与「笔记属性」（两项均已完成），让笔记按属性筛成看板 / 表格 | 未做 |
| 块级引用 | 复用现有 `block_key` 指纹，做笔记内 `((block))` 引用与反链面板 | 未做 |
| 习惯打卡 / 按任务累计用时 | 习惯可用「重复任务 + 连续天数」近似；用时统计在 `ReviewStats` 基础上补「按任务聚合」 | 未做 |
| 用户脚本扩展点 | `<数据目录>/scripts/` 里的脚本作为命令面板 / 工作流动作（离线版 Extension API） | 未做 |

### 17.1 本轮已完成并发布（2026-09-19）

| 项 | 落点 |
| --- | --- |
| **保存的查询（智能清单）** | 任务页「智能清单…」下拉 + 「存为智能清单」按钮；表达式解析 `src/shared/query.ts`（`text:` / `tag:` / `list:` / `!done` / `priority>=n` / `due<=today` / `due=overdue` / `due=none`），存表 `saved_query`（私有表，不进 Python 迁移链） |
| **笔记结构化属性** | 笔记页右栏「属性」卡片（每行一条 `key: value`），落库 `note.props`（JSON 字符串，私有列） |
| **系统级到点提醒** | 主进程 30 秒轮询 + Electron `Notification`（设置 → 任务与提醒里可关）；此前只有窗口内提醒卡片，主窗口收进托盘就等于没有提醒 |
