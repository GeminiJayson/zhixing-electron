# 文档与代码差异审计 · 优化项（2026-10-04）

> 范围：`README.md`、`CONTEXT.md`、`docs/01`–`03`、`docs/MAINTENANCE.md` 与 `src/**` 的逐项对照。
> 方法：**先机械核对**（路径、符号、通道名、数字都能脚本查），**再人工判断语义**。
>
> **修复进展（2026-10-04 当日）**：**A 项**（重复实现）已全部处理；**C 项**（测试盲区）4 个模块已补齐；
> **D 项**（`docs/03` 预览图归位）已完成。测试从 **49 文件 / 547 用例**增至 **53 文件 / 630 用例**。
> **只剩 B 项**（五个 1700 行以上的大文件未拆）与 `db/` 的 ABI 单测限制。
> 详见文末「修复记录」，**其中包含对本文一处结论的更正**。

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

**⚠️ 本文原判有误（已更正）**：初稿写的是「两份独立实现」，实际比对导出后是 ——

| | 导出 |
| --- | --- |
| **两份共有** | `sha1Hex`、`blockFingerprint` ← **真重复** |
| 仅 renderer/lib | `NoteBlock`、`cellKey`、`isCellRef`、`isSheetName`、`listNoteBlocks`（Office 表格的键） |
| 仅 shared | `normalizeBlockText`、`LineMatch`、`findBestLine`（段落匹配） |

**所以不是整个文件重复，而是两个函数重复。** 已按此修复：`renderer/lib/block-fingerprint.ts`
**从 `@shared/block-fingerprint` 导入并再导出**那两个函数（185 → 127 行），保留自己的 Office 部分。

**另一处值得记的**：两份的注释**都写着「这是唯一实现」** —— 一份自称唯一实现的同时自己是第二份。
这类「注释与事实相反」比没有注释更危险：**它让人不去检查。**

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
---

## 六、修复记录（2026-10-04 当日完成）

### A. 重复实现 —— 4 组已消除

| 组 | 处理 | 效果 |
| --- | --- | --- |
| `sha1Hex` + `blockFingerprint` | `renderer/lib/block-fingerprint.ts` 改为从 `@shared` **导入并再导出** | 185 → 127 行；段落指纹从此**只有一份实现** |
| `readTokenMs` | **四份**合成 `src/renderer/src/lib/motion-tokens.ts` | 4 个文件各删 7–12 行 |
| `crc32` | 合成 `src/shared/crc32.ts`（表 + 函数），`db/export.ts` 与 `db/preview.ts` 改为导入 | 两份表（`CRC32_TABLE` / `CRC_TABLE`）合一 |
| `makeThumb` / `readAsDataUrl` | `RichTextEditor.tsx` 改为从 `lib/rich-media.ts` 导入（调用处显式传 `THUMB_MAX`） | 顺带修掉一处行为差异：组件那份**出错会抛**，lib 那份返回 `''` |

**同名函数从 12 组降到 7 组，剩下 7 组逐条看过，都是合理的**：

- `isAppOwnUrl` —— main 那份是**薄包装**（把 `__dirname` / 环境变量注入给 shared 的纯函数），正确的分层
- `stamp` —— main 返回 ISO 时间戳，渲染层把 ISO 切成 `HH:MM:SS`，**同名但不同函数**
- `readBody` / `json` / `onRequest` —— 两个彼此独立的 HTTP server（工作流触发端点 / 保险箱本地服务）
- `mixHex` —— 一份在 `renderer/src/vendor/bloub`（vendor 代码不动）
- `pick` —— 通用工具名

### C. 测试盲区 —— 4 个模块已补齐（**新增 83 个用例**）

| 新增测试 | 用例数 | 覆盖的关键契约 |
| --- | ---: | --- |
| `src/shared/workflow-trigger.test.ts` | **51** | **坏输入一律退回手动**（interval < 1 分钟会让调度器忙等）；**没有令牌的 HTTP 触发直接丢掉**（否则谁都能启动流程）；`dueByDaily` **只认当前这一分钟、错过不补跑** |
| `src/shared/knowledge-check.test.ts` | **19** | **第一版的纯文本不能被当成损坏**（返回 null 而非抛异常）；版本号不对不误读；字符串字段类型不对时归零而不是把 `undefined` 漏给 UI |
| `src/shared/knowledge-templates.test.ts` | **9** | 三类模板**各自挡住最容易漏的那一项**（概念→「它不是什么」、方法论→「什么时候别用」、踩坑→**「排查过程」必须排在「根因」前面**） |
| `src/shared/events.test.ts` | **12** | 订阅表是 `Set`：**同一函数订阅两次只收一次**；`emit` 遍历快照，**回调里退订不影响本轮** |

**其中一条测试是我自己写错的**：初稿断言「同一函数订阅两次收两次」，跑出来 1 次 ——
**是我对代码的理解错了，不是代码错了**（`listeners` 是 `Set`）。已把该用例改成记录真实契约。

### D. `docs/03` 两块预览图归位 —— 已完成

两块图原先挤在标题与 `§1` 之间（**没有任何小节标题**），与它们各自的主题脱节：

| 块 | 内容 | 移到 |
| --- | --- | --- |
| 块1 | 应用整体布局（TitleBar / Sidebar / 页面 / 叠加层） | **`§3 布局框架`** 之下 |
| 块2 | 笔记页三栏布局 | **`§8.1 布局`** 之下 |

**为什么值得单独记一笔**：这一步我**失败了三次**（拼接下标算错，把框图插进过 `§2.12` 的列表中间）。
这次改了做法 —— **先断言、再写入**：

```js
if (L[6].trim() !== '---') fail('第 7 行不是 ---')
if (rest.filter((l) => /^## 3\./.test(l)).length !== 1) fail('锚点不唯一')
// …全部断言通过后才 writeFileSync
```

**断言当场抓到了我自己的 off-by-one**（把 `---` 写成 `L[7]`，实际是 `L[6]`）——
**文件没被写坏，因为守卫在写入前就中止了。** 这是这轮唯一一次「先验证再动手」奏效的地方，
前面几次失败都是「先写了再说」。

### 顺带发现并修掉的一处行为差异

`RichTextEditor` 自己那份 `makeThumb` **没有 try/catch**（出错会抛），而 `lib/rich-media.ts` 那份
**catch 后返回空串**。合并后走的是后者 —— **这是行为变化，方向是变安全**（调用方本来就按字符串处理）。

---

## 七、还没做的

| 项 | 说明 |
| --- | --- |
| **B. 大文件** | `NotesPage.tsx` 2335 / `WorkflowPage.tsx` 2036 / `db/workflow.ts` 1928 / `TasksPage.tsx` 1829 / `SettingsPage.tsx` 1713 —— **五个都在 1700 行以上，未拆** |
| **D. `docs/03` 两块预览图归位** | 它们在标题之后、`§1` 之前，本该在 `§3 布局框架` 与 `§8.1`。**移动时反复破坏结构，停在安全状态** |
| **`db/` 的 31 个文件无单测** | `better-sqlite3` 是 Electron ABI，vitest 加载不了。**基础设施限制**，要解得换测试运行器或做 ABI 双份 |
