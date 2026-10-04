# 文档地图与同步规则

这个仓库的文档**跟着代码走**。这份文件回答两个问题：**每份文档管什么**、**改了东西要动哪几份**。

---

## 一、文档地图

### 核心三份（改动的主要落点）

| 文档 | 管什么 | 什么时候必须动 |
| --- | --- | --- |
| `README.md` | **索引与入口**：数据约定、技术栈、脚本清单、目录树 | 加/删脚本、改数据目录或 schema 版本、改技术栈、动目录结构 |
| `docs/01-需求规格说明书.md` | 功能是什么、边界在哪 | 加功能、改功能行为、改可见的规则 |
| `docs/02-技术架构设计.md` | 分层、模块、数据流、表结构 | 加/拆模块、改表结构或迁移、改进程间协议 |
| `docs/03-UI-UX交互设计.md` | 界面结构、交互约定、控件规范 | 改页面布局、加/改控件、改交互反馈 |

### 专题

| 文档 | 管什么 |
| --- | --- |
| `docs/adr/*.md` | **架构决策记录**。一个决定一份，写清「为什么选它、否掉了什么」 |
| `docs/specs/*.md` | **方案与规范**。设计阶段产出，实现后作为依据保留 |
| `docs/audit/*.md` | **审计报告**。某一时点的缺口清单与结论 |
| `docs/research/*.md` | **调研**。同类产品对比、技术选型依据 |
| `docs/release-notes-v*.md` | **每个版本的发布说明** |
| `docs/windows-build.md` | Windows 构建与打包 |

### Agent 用

| 文档 | 管什么 |
| --- | --- |
| `AGENTS.md` | 给 Agent 的操作约定（调试流程、设置页分区、常见坑）。**不进版本库** |
| `docs/agents/*.md` | Agent 工作流的说明（issue 跟踪、triage 标签、领域文档） |

---

## 二、同步规则

**每次功能或 UI 优化落地后，按这张表动文档。** 不是"有空再补"——**同一次提交里做完**。

| 改了什么 | 必须同步 |
| --- | --- |
| **新增/修改功能** | `docs/01` 的对应章节；有用户可见行为变化时同时写 release notes |
| **新增/修改页面或控件** | `docs/03`（结构、交互、控件规范）；截图若在文档里则一并更新 |
| **新增/拆分模块** | `docs/02` 的模块图与职责表；`README.md` 的目录树 |
| **数据库表结构或迁移** | `docs/02` 的表结构；`README.md` 的 `SCHEMA_VERSION`；**升版本号时有 ADR** |
| **新增脚本** | `README.md` 的脚本清单与计数（**数量和目录树里都要改**） |
| **测试数量变化** | `README.md` 的「N 个测试文件 / M 个用例」 |
| **设置项新增** | `AGENTS.md` 的分区归属表 + `docs/03` 的设置页章节 |
| **发版** | `docs/release-notes-v<版本>.md`；`package.json` 的 version |

### 引用代码时**不要写行号**

**这条是实测踩出来的**：`docs/03` 里有 56 处形如 `theme.ts:19-35` 的引用，
抽查下来**全部失效** ——

| 文档写的 | 实际 |
| --- | --- |
| `theme.ts:19-35` 是 `TOKEN_VARS` | 在 **41** 行（偏 22） |
| `color.ts:70-81` 是 `ensureTextContrast` | 在 **112** 行（偏 42） |
| `theme.ts:176-178` 是运行时覆盖 | 那里是 `lastThemeKey` |

**行号必然随代码演进失效，而符号名不会。** 所以：

- ✅ **写符号名**：`theme.ts` 的 `TOKEN_VARS`、`color.ts` 的 `ensureTextContrast`
- ✅ **要指范围时**：用「函数 A 到函数 B 之间」或「`TYPE_MAP` 表」，不写数字
- ❌ **不写** `theme.ts:19-35`

**文件名可以保留**（它比较稳定，改名时会报错），**但冒号后面的数字不要写。**

### 容易忘的两处

1. **`README.md` 里的数字全是硬编码** —— 测试数、脚本数、CSS 文件数、`SCHEMA_VERSION`、
   目录树里的注释。改了对应的东西就要**全文搜一遍**这些数字。
2. **`docs/01`–`03` 是"规格"不是"日志"** —— 写的是**当前状态**，不是历史。
   改动直接改进去，不要在旁边堆"某版本改成…"的补丁说明（那是 release notes 的事）。

---

## 三、怎么核对没漏

**没有自动检查** —— 文档与代码的对应关系太松，写不出可靠的断言。所以靠**提交前自查**：

```powershell
# 1. 这次改了哪些源码？
git diff --name-only HEAD~1

# 2. 如果动到了这些，README 必查：
#    scripts/          → 脚本数与目录树
#    src/**/*.test.ts  → 测试数与用例数
#    src/main/db/schema.ts → SCHEMA_VERSION
#    src/**/*.css     → CSS 文件数

# 3. 如果动到了页面/控件，docs/03 必查；动到了功能语义，docs/01 必查。
```

**数值类的事实**（版本号、测试数、脚本数）可以直接量：

```powershell
(Get-ChildItem scripts -File -Filter *.mjs).Count                             # 脚本数
(Get-ChildItem src -Recurse -File -Include *.test.ts).Count                   # 测试文件数
node node_modules/vitest/vitest.mjs run 2>&1 | Select-String "Tests "          # 用例数
(Select-String -Path src/main/db/schema.ts -Pattern "SCHEMA_VERSION =").Line   # schema 版本
```

---

## 四、这份文件本身

新增一类文档（比如 `docs/benchmarks/`）时，**把它加进第一节的地图**，并在第二节补一行同步规则 ——
否则下一个人不知道它该在什么时候更新。
