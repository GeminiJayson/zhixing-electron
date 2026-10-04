# 文档与代码差异审计 · 优化项（2026-10-04）

> 范围：`README.md`、`CONTEXT.md`、`docs/01`–`03`、`docs/MAINTENANCE.md` 与 `src/**` 的逐项对照。
> 方法：**先机械核对**（路径、符号、通道名、数字都能脚本查），**再人工判断语义**。

---

## 一、本轮已修的差异

### 1. 31 个表格单元格被清空（我自己造成的）

`docs/02` 20 格、`docs/03` 11 格。**根因**：清「空反引号对」时用的规则是「连续两个反引号删掉」，
而表格里有一批**只写行号的引用**（形如 ``:28-33``，承接的是章节标题里的文件名）——
它们被替换成空反引号对，随后被清理规则整格删掉。

**已按新规则补回符号名**，例如：

| 行 | 改前 | 改后 |
| --- | --- | --- |
| 悬浮球 | *（空）* | `widget.ts` 的 `getMode` |
| 主窗口 | *（空）* | `window.ts` 的 `createWindow` |
| 全局热键 | *（空）* | `hotkey.ts` 的 `registerHotkeys` |
| `db`（preload 键） | *（空）* | `preload/api/`（7 个域文件） |

### 2. 行数口径不一致（数字是错的）

`docs/02` §2.1 与 `release-notes-v1.20.0` 都写「`index.ts` 从 **2445** 行降到 **1320** 行，-46%」。

**实测**（`git show <commit>:src/main/index.ts` 后数总行数）：

| 时点 | 总行数 | 非空行 |
| --- | ---: | ---: |
| 拆分前 `c255a59` | **2496** | 2365 |
| 现在 `HEAD` | **1579** | 1493 |

**真实降幅是 -917 行（-37%），不是 -46%。** 两个数用了不同口径（一个是旧读数、一个是非空行数）。
已改为 **2496 → 1579（-37%，口径为文件总行数）**，并在文档里注明口径。

### 3. 符号漂移

| 位置 | 问题 | 处理 |
| --- | --- | --- |
| `docs/02` §2.1 | 「形态（`widgetMode`）与位置解耦」—— `widgetMode` 已随 widget 拆分改名为访问器 | 改为 `widget.ts` 的 `getMode`（`'full'` / `'ball'`） |
| `docs/02` §8 | 把 `PomodoroBar` 列为**关键基础组件** —— 它已删除（改成独立小窗） | 从组件清单移除 |
| `docs/02` §10 | 提到已删的 `scripts/upload-release.mjs` | 改为指向 `npm run release` |

### 4. 发布渠道（Gitee → GitHub）

`README` §7 教人用 `scripts/upload-release.mjs` 发 **Gitee** Release，**而远程是 GitHub**。
实际路径是 `npm run release` → `scripts/release.mjs` → **GitHub Releases**。

**整条 Gitee 渠道已删除**：脚本本体（143 行）+ `docs/windows-build.md` 的对应章节。

---

## 二、有意保留的差异（不是遗漏）

| 位置 | 内容 | 为什么保留 |
| --- | --- | --- |
| `docs/03` 3 处 | `components/PomodoroBar.tsx` | 都是「**原 … 已删除**」的历史说明，有意留的 |
| `docs/motion-visual-upgrade-plan.md` | 行号引用、`394 项` 等旧数字 | 文件头声明「**已实施，方案原文保留不动** —— 价值在于当时为什么这么判断」 |
| `docs/audit/design-review-2026-09-21.md` | 3 处 Gitee 引用 | **2026-09-21 的快照**，结论不回改；已在文件头加补注说明脚本已删 |
| `README` §15 | 「Markdown 导入」不在「不做」列表 | 该项**实际已实现**（`collectMarkdownFiles`），移出是修正而非遗漏 |

---

## 三、优化项

### A. 重复实现（**优先**，其中一项有静默失效风险）

**`blockFingerprint` / `sha1Hex` 有两份独立实现**：

| 位置 | 使用者 |
| --- | --- |
| `src/shared/block-fingerprint.ts` | `src/main/db/note-assoc.ts`（主进程） |
| `src/renderer/src/lib/block-fingerprint.ts` | `MarkdownEditor.tsx`、`TaskEditor.tsx`（渲染层） |

**两份各有自己的单测。** 实测**今天逻辑一致**（`normalizeBlockText` 就是那个正则 + `?? ''`；
`sha1Hex` 57 行逐字相同），**所以现在没有 bug**。

**但这是静默失效风险**：`shared` 那份的注释写着「**键必须与 `task_note_context` 表里的键逐字一致，
才能互相定位**」。**任何一处归一化规则改动、忘了同步另一处，段落锚定位就会失效，而且不会报错。**

**建议**：渲染层改从 `@shared/block-fingerprint` 导入，删掉 `renderer/lib/` 那份与它的测试。

**其余重复**：

| 函数 | 位置 | 说明 |
| --- | --- | --- |
| `crc32` | `db/export.ts` + `db/preview.ts` | 5 行各一份，**数学等价但表名与写法不同** |
| `readTokenMs` | `RecycleBin.tsx` / `NotesPage.tsx` / `TodayPage.tsx` / `WorkflowPage.tsx` | **四份**，应提到 `lib/` |
| `makeThumb` / `readAsDataUrl` | `components/RichTextEditor.tsx` + `lib/rich-media.ts` | 组件里应 import lib |
| `readBody` / `json` / `onRequest` | `main/http-trigger.ts` + `main/vault/server.ts` | 两个独立 HTTP server；**可能合理**，待判断 |

### B. 大文件（继续拆的候选）

| 文件 | 行数 | 备注 |
| --- | ---: | --- |
| `src/renderer/src/pages/NotesPage.tsx` | 2335 | 已拆 8 个模块，仍最大 |
| `src/renderer/src/pages/WorkflowPage.tsx` | 2036 | 未拆过 |
| `src/main/db/workflow.ts` | 1928 | 未拆过 |
| `src/renderer/src/pages/TasksPage.tsx` | 1829 | 未拆过 |
| `src/renderer/src/pages/SettingsPage.tsx` | 1713 | 未拆过 |
| `src/main/index.ts` | 1579 | 已拆四模块；剩下的是 `winState` + IPC 注册 + 菜单 |

### C. 测试盲区

**`src/shared/` 里没有单测的模块**（纯函数，本该最容易测）：

| 模块 | 行数 | 导出 | 备注 |
| --- | ---: | ---: | --- |
| `workflow-trigger.ts` | 165 | 10 | **最大盲区** |
| `knowledge-templates.ts` | 79 | 2 | 知识库模板结构 |
| `knowledge-check.ts` | 72 | 5 | **知识库三条硬规则之一**（`verify_note` 的结构化清单） |
| `events.ts` | 44 | 4 | 域订阅表 |

**`src/main/db/` 的 31 个文件全部无单测** —— `better-sqlite3` 是按 Electron ABI 编译的，
在 vitest（纯 Node）里加载不了。**这是已知的基础设施限制，不是遗漏。**

`src/main/` 里有单测的只有 4 个：`accent`、`security`、`task-sync-plan`、`widget-geometry`。

### D. 其它

- **`docs/03` 开头两块预览图未归位** —— 在标题之后、`§1` 之前，没有小节标题。
  它们本该在 `§3 布局框架` 与 `§8.1`（**移动时反复破坏结构，先停在安全状态**）。
- **`docs/02` §12「已知架构债」第 1 条**说「README 与代码可能不一致」——
  **这条本轮之后基本不成立了**（README 的数字与正文都已对齐），可以改成更具体的东西。

---

## 四、机械核对的结果（作为下一次审计的基线）

| 检查项 | 结果 |
| --- | --- |
| 文档里的路径引用（273 个） | **1 个不存在**：`components/PomodoroBar.tsx`（有意保留的历史说明） |
| 文档里的 IPC 通道名（14 个） | **全部存在** |
| 驼峰符号引用（157 个） | 7 个不在 `src`：5 个是 `electron-builder.yml` 的配置键（**合理**）、1 个 `widgetMode`（**已修**）、1 个是文档小节名 |
| `TODO` / `FIXME` / `HACK` / `XXX` | **0 处** |
| 代码块配对（58 份 md） | **全部正常** |
| 空表格单元格 | 修 31 格后**剩 1 格**（冻结的方案文档，说明列本就为空） |

---

## 五、下次审计可以直接复用的做法

1. **先列符号，再对照文档** —— 按文档里写的名字 grep 会误判（`duplicateWorkflowTemplate` 曾被当成不存在）。
2. **数字要现算，不要沿用** —— 本次 6 处数字里 3 处是错的，且**同一份文档里两处口径不一致**。
3. **改完看渲染，不只看编译** —— 清空反引号对这类错误，`tsc` 与单测**一个都查不出来**。
4. **大规模替换后必做三项抽查**：命中数对不对、有没有改到字符串字面量或代码块标记、**文档能不能正常渲染**。
