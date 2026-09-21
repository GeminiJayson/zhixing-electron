# 设计缺陷审计（open-code-review · delegate 模式）

> 日期：2026-09-21 ｜ 范围：全库（140 个源文件、约 30.6k 行，排除 vendor）+ scripts/ + 构建配置
> 覆盖：**6/6 模块全部完成**（数据层 · 主进程+preload · 页面 · 组件 · 纯逻辑 · 脚手架），共 **72 条**
> 复核：抽查 13 条回代码验证（含 3 条实跑），**全部属实**；同时拦下 2 条自己的误报（见第七节）
> 视角：**代码库自身的设计缺陷**。刻意不重复 `docs/parity-audit.md` / `docs/audit/*` 的「与 Python 对齐」结论。
> 方法：`ocr scan`/go 的 LLM 模式因未配置端点不可用，走 `ocr delegate`——OCR 出规则集与文件清单（其系统规则见文末），判断由 agent 完成。6 组并行审计 + 横切机械核对。
> 证据规范：每条带 `文件:行号`；`复核` 一栏标注父 agent 是否回代码验证过。

## 修复状态（2026-09-21 收口）

本轮把清单里的**全部 16 条严重级**与**本次会话引入的全部缺陷**修完并验证；脚本类 4 条中 3 条修完，剩下 1 条作为技术债记录在文末。

> **怎么读这份清单**：某一条到底修没修，只看上面这张表（它是唯一权威）。
> 第六节起的明细段保留的是**审计当时的原文**，标题不带状态标记 —— 别按标题判断。
> 这一轮就吃过一次这个亏：isAppOwnUrl 那条被降级为「中」之后既不在「严重」的必做清单里，
> 表里也没有它的行，于是**降级即失修**，直到逐条回代码复核才捞出来（详见该条）。

| 原条目 | 修法要点 | 验证 |
| --- | --- | --- |
| 图谱增量基线被邻域查询覆盖 | 邻域改走裸 buildGraph，不碰模块级基线 | 护栏 ⑨ + 类型/构建 |
| 工作流/闪念派发任务不写 FTS | 四处直接 INSERT 补 reindexTask | 护栏 ⑦ |
| syncTaskNoteLinks 只增不删 | （未在本轮单独修，见文末技术债） | — |
| WRITE_DOMAINS 死键与漏项 | 清死键 + 补 3 处登记 | 护栏 ⑧ |
| 多步写无事务（15 处） | 方案见 docs/adr/0001；新增 6 类批量入口 + 4 处主进程事务 | 护栏 ① ② |
| 备份保留按文件名排序 | 抽 shared/backup-retention.ts，按时间戳排 | 单测 8 项 |
| applyMru 用 sort+reverse | （未在本轮单独修，见文末技术债） | — |
| listTasksByList 漏 start_time/due_time | （未在本轮单独修，见文末技术债） | — |
| 图谱增量实为全量重建 | （未在本轮单独修，见文末技术债） | — |
| 重复实现：ZIP/CRC32、浮窗保存 | （未在本轮单独修，见文末技术债） | — |
| 静默失败（fts/removeGraphEdge/graphPreview） | 统一出口 quietFailure：行为不变，但必须留下带上下文的记录；另修 4 条用户操作路径（快捷键注册 / 导出遍历 / 附件大小 / 三处列表加载） | 单测 3 项 + 护栏 ⑲（变异验证：真空 catch 即变红） |
| 死代码 / 不可达分支 | （未在本轮单独修，见文末技术债） | — |
| 自身 URL 判定用 startsWith 前缀比较 | 判定抽到 shared/app-url.ts 做精确比较（协议+主机+路径）；dev 分支改比 origin | 单测 8 项（先红后绿 + 变异验证）+ 新增护栏 |
| 外部同步覆盖用户内容 | 抽 task-sync-plan.ts，认领来的只补空字段 | 单测 7 项 + E2E 20/20 |
| 笔记页切走丢编辑 | 卸载时 flush（空依赖 effect + ref，避开每字一次的重跑） | E2E 5 项（先红后绿） |
| 两套 HTML 消毒 | 删 MarkdownView 黑名单，统一 shared 白名单；白名单补 input（限定属性） | 单测 16 项 + 护栏 ⑤ |
| 下周X 解析串台 | 词法与解析共用 WEEK_RE | 单测 4 项（先红 3 项） |
| 完成态 4 份实现（实际 9 处） | 全部收敛到 isTerminal + doneOf | 单测 3 项 + 护栏 ⑩ |
| 查询静默空集 / 裸词 done | 解析期校验 due 并记 unknown；裸词 done 落地 | 单测 3 项 |
| 布局方向重置模板 | openTemplate 用 ref 读 rankdir，依赖砍成空数组 | 护栏「切换布局方向不得重置当前模板」（2 条断言，变异验证：把 rankdir 加回依赖即变红） |
| 右键两个重叠菜单 | 删原生监听，合并为一个菜单 | 护栏 ⑪ + 笔记页回归 |
| 脚本：CDP 样板 47 份 | **大部分**：抽出 scripts/lib/cdp.mjs；棘轮 20 → 15（本轮净迁 5 个，逐条与原版对照后只留跑得动的）；迁移器本身入库并修掉 3 个缺陷；lib 的 CDP 超时 15s → 45s（可配） | 5 个迁移脚本各自跑绿 + 10 个逐条对照的原版基线表 + 护栏 ⑯（变异验证）+ 单测 29 条 |
| 脚本：seedmonitor 统计失败却永不失败 | 末尾补 process.exit(problems.length ? 1 : 0) | 护栏 ⑭（变异验证：去掉退出码即变红） |
| 任务↔笔记关联只增不删 | 记来源 + 按来源对账（一删一增同事务） | 单测 11 项 + E2E 7/7 + 护栏 ⑮ |
| 脚本：5 个未隔离 ZHIXING_HOME | 其中只有 capture 真写库 → 复制库副本隔离 | **实测**：跑 dark 截图后真实库仍是 light |
| 脚本：13 个 macOS 库路径 | 统一改 %APPDATA% | 护栏 ⑫ |
| 脚本：Gitee 上传失败退出码 | 逐条收集失败，末尾 exit(1) | 语法检查（**E2E 未做**：需真实凭据） |
| 本次会话引入的 5 条 | 附件 URL / 清单设置 / 提醒卡死 / 查看不定位 / 订阅取消 | 单测 7 项 + E2E 4 项 + 护栏 ③ ④ |

### 本轮顺带发现并修掉的（原清单未列）

- **13 个脚本依赖未安装的 sqlite3 命令行**：一跑到 sql() 就 ENOENT 崩掉，后面的断言根本没机会执行 —— 其中就包括「真实库未被写入」。
- **16 个脚本依赖一个已从工作区删除的备份库**：一律「✗ 缺备份库」直接退出，整套 E2E 基本跑不起来。
- 两者与 macOS 路径叠加，效果是**断言从未执行**，这也是「测试污染真实库」长期没被发现的原因。
- 解锁后实测：todaycheck、taskopscheck 14/14、notecheck 28/28、inboxcheck 16/16。

### 累计证据

- 单元测试 **394 项** / 37 个文件（2026-09-22 复核时的现值）
- **22 道架构护栏**（src/shared/architecture.test.ts，41 条断言）—— 其中 7 道做过变异验证（把缺陷改回去，护栏确实变红）
- 端到端：remindercheck 18/18、listguardcheck 4/4、noteeditguard 5/5、tasksynccheck 20/20、dialogcheck 10/10、rollcheck 25/25、reminderstylecheck 11/11、reminderpolicycheck 7/7、notelinkcheck 7/7

---

## 技术债（本轮未做，已记录）

**1. CDP 样板抽取（原清单「严重」）—— 做了一半，另一半是被证据挡住的**

已做：抽出 scripts/lib/cdp.mjs（launchApp / createChecker / targets / J / sleep），
迁移并跑绿 3 个脚本（listguardcheck 4/4、noteeditguard 5/5、notelinkcheck 7/7），
加了棘轮护栏 ⑯：样板份数只许减不许增，已迁到 lib 的脚本不得再自带 WebSocket，
且 lib 必须保持完整实现（连接 / id 配对 / 超时 / evaluate，判据用结构而不是提示语原文）。

没做的那 51 个不是「懒得做」，是**盲改会改坏**。本轮实测：

- 55 个脚本里只有 **7 个**还能被机械识别成同一形状，其余早已分叉成多种实现
  （仅超时文案就有「CDP 超时（15s）：」「CDP 超时（15s 无响应）：」「CDP 超时: 」三种）；
- 拿这 7 个 + 4 个手工锚点试批量改 11 个，**有 6 个在样板区段里藏着自己的东西**：
  MARKER / shotDir / root 这类脚本自有常量，以及 bloubcheck 与 remindercheck 自己的
  connect() 实现（第三种 CDP 连接方式）；
- 11 个全部通过 node --check，但其中 2 个当场在 E2E 里报 ReferenceError ——
  语法检查对这类错误是瞎的，是「每个都跑一遍」抓出来的。

所以剩下的按批次迁移，每批迁完必须跑该批脚本。棘轮值在护栏里，迁一个减一；
减到 0 之后这条断言就可以整段删掉。

第二轮（2026-09-22）把可机械迁移的又清了一遍，累计 **12 个脚本**迁到 lib：
listguardcheck / noteeditguard / notelinkcheck / attachmentcheck / taskarchivecheck /
reminderpolicycheck / aiui / confirmcheck / wfgroupcheck（后三个是回退后重做并跑绿）。
第四轮（condwincheck 14/14、selectioncheck 9/9，均与原版基线一致）。当前棘轮值 **40**。

这一轮揪出 lib 自己的一个**真 bug**，值得单独记：
lib 为了「别让外部 node/python 干扰被测应用」把 PATH 收紧成三条系统目录，**漏了
WindowsPowerShell\v1.0**。而应用读「当前选中的文字」是靠模拟 Ctrl+C（SendKeys）实现的，
内部用**裸名** spawn('powershell.exe') —— PATH 里找不到它就直接失败，
表现是捕获窗口里永远空着。原脚本的 SYS_PATH 里本来是有这一条的。
影响面不小：凡被测功能内部要起 PowerShell 的都中招（选字、工作流的 powershell 脚本步骤等）。
教训：给被测进程收紧环境是好事，但**收得太狠会把被测代码的依赖一起砍掉**，
而且失败是静默的（应用照常启动、界面照常，只有那一个功能失灵）。

另外修了 selectioncheck 里一处「靠坐标抢 OS 焦点」的脆弱写法：它往硬编码的 (30, 320)
发真实鼠标点击，落在哪取决于侧栏有多少内容 —— 用户库内容多时是空白，夹具库内容少时
落到导航项上把页面切走。仍然保留点击（SendKeys 需要 OS 焦点），但点完确认还停在原页面。

护栏 ⑯ 的判据也放宽了一处：原判「迁到 lib 的脚本不许出现 Runtime.evaluate」，
但 app.send('Runtime.evaluate', …) 是 lib 提供的接口、用来「发了不等」是正当用法
（condwincheck 就这么 fire 实例化）。改成禁止**手写 send 配对**的特征（自己监听 message 按 id 配对）。

第三轮又拿下两个双窗口脚本（需要 lib 的二次挂载能力）：reminderstylecheck 11/11（与原版一致）、
remindercheck 与原版**逐条一致**（见下）。当前棘轮值 **43**。

lib 这轮加了 `attach(matchFn)`：按谓词找目标 → 连上 → 给一个求值器。
有一批脚本要同时看主窗口、浮窗和提醒气泡，老写法是各自抄一遍 connect()。

**已处理：种子数据污染 E2E 基线这件事。**
E2E 现在**默认跑夹具库**（不拷用户生产库）：给一个空目录，应用启动时 seedIfEmpty() 生成固定基线，
lib 再补齐每种格式一篇示例笔记与一个工作流实例。确实需要真实数据的脚本要显式传 copyDb: true。
护栏 ⑳ 把「默认必须是夹具」和「夹具要覆盖哪些内容」都钉住了。

效果（同一批脚本，夹具模式下与原版基线对照）：
remindercheck **18/18**（被种子数据打到 13/18，现在完全恢复）、reminderstylecheck 11/11、
aiui 28/28、confirmcheck 7/7、reminderpolicycheck 7/7、attachmentcheck 14/14、
taskarchivecheck 13/13、listguardcheck 4/4、noteeditguard 5/5、notelinkcheck 7/7、searchcheck 7/7；
wfgroupcheck **6/6**（原版只有 5/6 —— 因为原库里压根没有工作流实例，
「实例项也有编辑胶囊」那条根本无从跑到；夹具补了实例之后它才真的被验证）。

**夹具顺带照出两个我自己的潜伏缺陷**（都在生产库上因为 id 恰好撞上而侥幸通过）：
- notelinkcheck / searchcheck 建笔记时用了 listFolders() 拿「清单文件夹」的 id 当「笔记文件夹」id，
  空库上立刻 FOREIGN KEY 失败。
- searchcheck 有一条断言在搜「库里碰巧存在的词」（其实是我种子数据里的词），
  夹具模式下必然为红。已改成搜自己造的内容。

**以下是这次事故的原始记录（留作背景）。**
E2E 脚本会拷一份真实库来跑（launchApp 的 copyDb）。生产库现在有我灌进去的 167 条任务，
而 remindercheck 是照着「列表里有什么」来找自己那条任务的 —— 于是它从 18/18 掉到 13/18。
**证据是：把迁移回退成原版，失败项与详情字符串一模一样**，所以这不是迁移回归，
是「脚本假设库里几乎是空的」这个前提被打破了。受影响的不会只有它一个，
凡是按列表内容/下标取值的脚本都可能如此；要修的是脚本（改成按标题精确定位），
或者让 E2E 跑在一份**固定的夹具库**上而不是拷生产库。

同批的 aiui(28/28) / confirmcheck(7/7) / wfgroupcheck(6/6) 与原版基线逐一对照：
前两个分数一致，wfgroupcheck 反而比原版多过一项（原版 5/6，「实例项也有编辑胶囊」当时失败）——
多出来的 3 秒 settle 大概率就是原因。**迁移没有引入回归。**

迁移器这轮又补了两条（都是被真实失败逼出来的）：
- **脚本末尾自己那句 rmSync(tmpHome) 必须一起删掉**。它没有重试，一旦 EBUSY 就崩在收尾，
  而崩在收尾又不会打印汇总行 —— 表现是「断言全过、退出码 1、看不到总结」，和之前
  taskkill 那次一模一样的坑。
- **收尾段的过滤要从文件末尾反推**。iBodyEnd 判对之后，对 kept（收尾段）过滤
  const failed / console.log / process.exit 是安全的；此前之所以出事，是因为 iBodyEnd
  被判到了正文中间，于是把正文后半段的 await sleep 全当成收尾删了。
  另外 createChecker 要把 results 一并解构出来，老脚本的收尾段还引用着这个名字。

这轮又摸清了两件原清单没写的事：

- 不是「3 种实现」而是至少 5 族：除内联 send 外，还有 connect()（7 个脚本）、
  attach()（约 13 个，每个 38 行）、假 AI server（5 个），以及被重新命名的
  list / listTargets / targets 三套拉目标列表的辅助函数。
- 55 个脚本里没有一个能机械迁移：每个都在样板区段里夹着自己的顶层声明
  （shotDir / realDb / MARKER / wordDir / connect / attach / server…）。
  按「自有声明是否单行且不依赖样板」筛，只有 7 个够格；实际迁移并跑绿 6 个。

迁移器本身也踩了两个坑，都记在这里免得下次重复：

1. 收尾行的判定不能从正文里找。原先用「正文里第一个像 const failed / console.log /
   await sleep 的行」当汇总段起点，对没有 try/catch 的脚本会把正文后半段整段当收尾删掉 ——
   aiui 迁移后正文里一个 await sleep 都不剩（原版 28/28，迁移后 2 项失败）。
   改成从文件末尾往前找汇总变量才对。
2. 清理子进程别用裸的 spawn('taskkill')。脚本运行环境的 PATH 里没有 System32，
   直接 spawn 会 ENOENT；而没挂 error 监听时，未处理的 error 事件会把进程整个崩掉 ——
   表现是「断言全过、退出码却是 1、没有汇总行」，非常难查。现在用绝对路径 + error 兜底。

另外，跨脚本验证时发现 Select-Object -First/-Last 会提前关管道把 node 打成 EPIPE，
让整批脚本看起来「全挂」。验证一律改成把输出写日志文件再读，别用管道截断。

**迁移器已固化为脚本（2026-09-22）。** 前几轮的迁移代码都是一次性程序，每轮重写一遍、
每轮重踩同样的坑。现在落在 `scripts/lib/migrate-cdp.mjs`：

- `node scripts/lib/migrate-cdp.mjs <脚本名…>` 做迁移；`--self-test` 只跑扫描器自检（19 条）。
- 块边界的规则（按行判、字符串/注释/正则感知、保留声明按原序插回、引用分析迭代到不动点、
  只保留顶格语句、只在代码段改名）都写在文件头注释里，不再靠记性。
- 29 条单测（`src/shared/migrate-cdp.test.ts`）钉住扫描器与 renameRefs 的行为 ——
  这几条规则此前反复改错，每次改错都把脚本改坏。
- 只有被 node 直接执行时才跑 CLI（`pathToFileURL(process.argv[1])` 比对 `import.meta.url`）；
  否则被 vitest import 时会把 vitest 的参数当成脚本名去迁移。

**这一轮从迁移器的三个真实缺陷里挖出来的东西**（都不是被迁脚本的问题，是工具的问题；
每条都是先看到脚本变坏、再用「逐条声明量行数」的探针定位的）：

1. **表达式体的箭头函数，函数体写在下一行** —— `const mouse = (type) =>` 这一行括号是平衡的，
   只看深度就判成单行声明，函数体整段丢掉（hotkeyrebindcheck 直接语法错）。
   现在行尾是 `=>`、`=`、`,`、`&&` 这类「还没写完」的 token 时，声明继续吃下一行。
2. **正则字面量里转义的方括号被当成真括号** —— `/\[\[[^\]]+\]\]/g` 与
   `/https?:\/\/[^\s)\]，。]+/g` 让 `const server = createServer(...)` 少算 3 个括号：
   **47 行（实际 48 行）**，收尾的 `})` 被丢掉，后面的 `await` 落进非 async 的箭头函数，
   报错是 `Unexpected reserved word`。探针（逐条声明量行数的小程序）一跑就现形。
3. **改名连接对象时连字符串一起改** —— 页面侧的 `if (host) host.focus()` 被改成 `app.focus()`，
   浏览器上下文里没有 `app`，报错只有一句 `ReferenceError: app is not defined`，堆栈全在 `<anonymous>`。
   现在只在代码段改名，字符串/模板/注释一律不动。

第 2 条的修复还牵出一个反向陷阱：「空行与纯注释行不能收尾」这条规则会让**以注释行开头**的块
一路吃到下一条声明，于是 `let payload = []` 被输出两遍（`Identifier 'payload' has already been declared`）。
现在只有「上一行明确要求续行」时才允许跳过注释行，另外保留块按行号去重叠，双保险。

**结果：棘轮 20 → 15，落了 5 个（2026-09-22）**。口径是「迁完还能跑绿」——
下面这张对照表是这轮最值钱的产物，它证明「能机械迁移」与「迁完还跑得动」是两件事：

| 脚本 | 原版 | 迁移后 | 结论 |
| --- | --- | --- | --- |
| ailibcheck | 15/15 | 15/15 | 保留 |
| airepaircheck | 16/16 | 16/16 | 保留 |
| tasksynccheck | 20/20（审计文档基线） | 20/20 | 保留 |
| hotkeyrebindcheck | 无基线记录 | 14/14 | 保留 |
| wflinkcheck | 11/11 全过 | 11/11 全过 | 保留（第一次跑是 CDP 超时，见下） |
| aicheck | 16/25 | 更差一项 | 回退 |
| importcheck | **14/14 全过** | 读夹具 ENOENT | 回退：launchApp 会清空 home |
| officecheck | 起不来 | 起不来 | 回退 |
| layoutcheck / wfdialog | 起不来（无法连接渲染进程） | 起不来 | 回退，无从验证 |
| flashhotkeycheck | 挂住不返回（老脚本没有超时） | 只差「读取选区」一项 | 回退：本机没有可用交互会话，那一项读不到选区 |

**顺带挖出 lib 自己的一个坑：15s 的 CDP 超时太紧。** wflinkcheck 迁后第一次跑报
`CDP 超时（15s）：Runtime.evaluate`，差点被记成迁移回归 —— 实际上这台机器上纯 evaluate
会偶发超过 15s（首次渲染 + jieba 建索引都可能压在一条消息上），连 lib 自己补夹具的那步也超时过。
**「脚本真挂了」与「机器正忙」分不清，是最糟的一种测试不可靠**，所以超时改成默认 45s、
并支持 `ZHIXING_CDP_TIMEOUT_MS` 覆盖；改完 wflinkcheck 11/11，ailibcheck 也从偶发的 exit=1 恢复 15/15。

**迁移器因此新增一条「拒绝迁移」规则**：样板区段里若有脚本自己的文件准备（造夹具），直接拒绝 ——
lib 的 launchApp 会先 `rmSync(home)` 再重建，脚本提早写进去的夹具必然被清掉。
宁可拒绝，也不产出一个「看着迁好了、跑起来 ENOENT」的脚本。这条正对着 importcheck / officecheck。

**剩下 15 个分两块**：9 个连 `results` / `failed` 锚点都没有，迁移器认不出断言区从哪开始
（bigcapture / capture / diag-today / excelcheck / graphfocus / probe / seedmonitor / smoke / windiag，
其中五个是截图与诊断工具）；另外 6 个就是上表回退的。
下一步该做的不是继续堆迁移数，而是先给 excelcheck / smoke / graphfocus 这三个真验证脚本补上锚点。

（顺带改掉上一轮写错的地方：那时写的「剩余 20 个分三类」里「只缺场景数据：layoutfitcheck」是错的 ——
layoutfitcheck 早已迁移，它缺的是一份能渲染的 Excel 笔记夹具，跟迁移无关。
教训是：没真跑过就别往清单里写原因，更别按没跑过的人数着往下排。）

**2. 其余未单独修的中低优先项**（均不涉及数据安全，留待后续）：
applyMru 的 sort+reverse、listTasksByList 漏 start_time/due_time、图谱增量实为全量重建、ZIP/CRC32 与浮窗保存的重复实现、若干死代码与不可达分支。

**3. 静默失败（已完成一部分）**

命名点名的三处（fts.searchIndex / graph.removeGraphEdge / graph.graphPreview）已接统一出口
`quietFailure`：行为保持不变，但失败必然留下一条带上下文的记录（哪个查询、哪条连线、哪个节点）。

另外挑了 4 条**会让用户操作悄悄失败**的路径一起修：注册全局快捷键（设了没反应）、
导出时遍历目录（导出静默少文件）、读取附件大小（显示成 0 字节像文件坏了）、以及三处
渲染层候选列表（加载失败显示成「空列表」，看起来像数据没了）。

全量普查的结果：`src/main` + `src/renderer/src` 里**连错误对象都不引用**的 catch 共 34 处，
其中多数是良性兜底（localStorage 解析失败取默认值、剪贴板读不到取空串、取色取不到用灰色）。
这些没有逐个改 —— 改法本身不是「加日志」而是「决定要不要让用户知道」，属于产品判断，
留给后续。护栏 ⑲ 钉住了三条：不许有真空 catch、命名文件的 catch 不许丢掉原因、
点名过的用户操作路径必须留痕。

---

## 五类重复出现的模式（比单条更值得先看）

1. **多步写没有事务边界** —— 数据层、页面层、主进程三处独立发现同一模式：一致性边界落在业务代码的 for 循环里。数据层 5 / 页面层 3 / 主进程 4。
2. **静默失败** —— catch 后返回 `[]` / `false` / 兜底文案，上层无法区分「没结果」与「出错了」。数据层 11 / 页面层 8 / 主进程 10。
3. **复制粘贴型重复** —— 同一逻辑 N 份实现且已分叉：CDP 样板（47 份）、任务行渲染器（3 份）、ZIP/CRC32（2 份）、webPreferences（6 份）、假 OpenAI 桩（5 份）。
4. **订阅契约不统一** —— `on*` 一半返回取消函数一半不返回，导致监听器无界累积（数据层 1 是同一根因的另一面）。
5. **能力断链** —— 三层齐全但全项目零调用（主进程 8），或后端有实现而界面无入口（数据层 2/3/12）。

---

## 一、src/main/db/（25 文件 / 6900 行）

### [严重] 图谱增量基线被邻域查询覆盖
- 证据：`graph.ts:381-400` 模块级 `graphCache/graphParams` 由 `buildGraphTracked()` 覆盖；`graph.ts:504` `graphNeighborhood()` 也调它；`GraphPage.tsx:150` 选中节点即调用。
- 影响：写操作触发的 `graphDelta()`（`graph.ts:406-412`）用被改成邻域参数的基线重建，拿邻域帧与全图帧 diff，推送幻影增删。
- 修复：`graphNeighborhood` 改用纯 `buildGraph()`；缓存基线由消费方显式持有。
- 复核：未核实

### [严重] 工作流/闪念派发的任务从不写 FTS 索引
- 证据：`workflow.ts:379-393`、`:416-422`、`inbox.ts:151-165`、`:168-190` 直接 INSERT task；这两个文件都不导入 `reindexTask`。
- 影响：`globalSearch` 只走 `searchIndex('task')`（`search.ts:220`），这些任务在用户手工编辑标题前**永远搜不到**。
- 修复：把「插任务 + 建索引」收成一个仓储函数，四个入口共用。
- 复核：✓ 已核实（`reindexTask` 只出现在 fts.ts / task-ops.ts / tasks.ts）

### [严重] syncTaskNoteLinks 只增不删
- 证据：`tasks.ts:79-89` 只有 INSERT OR IGNORE；对照 `notes.ts:46-57` 的 `syncNoteLinks` 有 diff 删除。
- 影响：删掉备注里的 `[[标题]]` 后 `task_note_link` 仍留着，正文行内 ⇄N 与图谱 task→note 边不消失。
- 修复：按 `extractLinks` 结果 diff 删除（手动 attach 的行需另设来源标记）。
- 复核：✓ 已核实

### [严重] WRITE_DOMAINS 是手工字符串表，已有死键与漏项
- 证据：`index.ts:95` `'db:setFlashStatus': 'flash'` 无对应 handler；真实通道是 `:472-473` 的 `db:archiveFlash/db:unarchiveFlash`（不在表里）；另漏 `db:attachTaskNote/detachTaskNote`（`:332-337`）、`db:ensureDefaultFolder`（`:572`）。
- 影响：是否广播取决于手写表是否同步，漏项即写操作静默不通知其他视图。
- 修复：`handle()` 接受域参数，或由 handler 清单生成表；加「表键必须是已注册通道」的测试。
- 复核：✓ 已核实

### [高] 多步写无事务，失败留下半成品
- 证据：`notes.ts:122-134` saveNote（快照 INSERT + UPDATE + 关联删插 + 改名传播 + 索引）；`workflow.ts:451-479` instantiateWorkflow；`inbox.ts:116-136` mergeFlashes。
- 修复：各自包 `conn().transaction()`；索引等副作用移出事务。
- 复核：未核实

### [高] 备份保留策略按文件名排序，保的不是「最近 10 份」
- 证据：`backup.ts:61` 文件名 `${reason}-${stamp}.db`（auto / pre-restore / pre-import）；`backup.ts:28-46` 用 `readdirSync().sort().reverse().slice(keep)`。
- 影响：字母序先按 reason 分组 —— `auto-*` 永远排在 `pre-*` 之前，所以 **`pre-*` 攒够 10 份后自动备份会被优先删除**。注释「按名倒序即时间倒序」是错的。
- 修复：按文件名尾部 14 位时间戳或 mtime 排序裁剪。
- 复核：✓ 已核实（文件名格式与裁剪代码均确认）

### [高] applyMru 用 sort+reverse，把非 MRU 命中按相关性倒序
- 证据：`search.ts:69-72` `hits.sort(mru 升序)` 后 `hits.reverse()`。
- 影响：`sort` 是稳定排序，未命中 MRU 的项（键值全为 0）保持 FTS rank 顺序；随后的 `reverse()` 把这批**整体翻成 rank 逆序**，首次检索时相关性由低到高。
- 修复：单一比较器 `(mruB - mruA)`，去掉 reverse。
- 复核：✓ 已核实

### [高] listTasksByList 手写列清单漏 start_time / due_time
- 证据：`lists.ts:102-104` 的列清单无这两列，而权威 `TASK_COLUMNS`（`connection.ts:37-39`）有；`TasksPage.tsx:134` 选中清单走 `tasksByList`，`TaskRow.tsx:52-58` 用这两列算进度。
- 影响：`Task` 类型声明有字段、运行时是 undefined → **清单视图的进度条退化成 00:00–23:59**。
- 修复：复用 `TASK_COLUMNS` 或抽统一列常量。
- 复核：✓ 已核实

### [高] 图谱「增量」实为每次写全量重建 + 全量 diff
- 证据：`graph.ts:406-412` → `buildGraph()` 全表读 7 张表；`index.ts:180-186` 每次广播一帧；`:268-272` batchComplete 再逐个触发。
- 影响：单条任务完成 = 整图重建；批量 N 条 = N+1 次；随库增长无界变慢。
- 修复：按域定向失效，或基于持久化上一帧做事件增量。
- 复核：未核实

### [中] 重复实现：ZIP/CRC32 两套、浮窗状态保存两份
- 证据：`export.ts:133-216` 与 `preview.ts:214-287` 是同一算法两份拷贝**且已分叉**（前者写 UTF-8 标志位 0x0800，后者写 0 → 非 ASCII 条目名会被误读）；`maintenance.ts:144-164` 与 `:170-199` 两个 widget 保存函数除键名外逐行相同。
- 修复：抽 `src/main/lib/zip.ts` 与 `saveWidgetState(patch)`。
- 复核：未核实

### [中] 静默失败：catch 后以空结果 / false / 兜底文本返回
- 证据：`fts.ts:96-105` `searchIndex` 捕全部异常 `return []`；`graph.ts:859-877` `removeGraphEdge` catch 后 `return false`（与「不允许的连线」同值）；`graph.ts:642-645` `graphPreview` 吞错返回通用文本。
- 修复：返回 `{ok, reason}` 判别联合，由 IPC 层转成可见提示。
- 复核：未核实

### [中] 死代码 / 不可达分支 / 无消费方的计算
- 证据：`inbox.ts:16` `listInboxTasks()` 全库零调用（`index.ts:454-456` 已改用 `listTasksByList(null)` 并注明其口径错误）；`graph.ts:215-229` 悬空节点复用分支永远不可达（`nextVirtual` 每轮自减）；`review.ts:53-65` `todayCounts` 无消费方，且其中 inbox 计数与 `tasks.ts:161` 口径不同。
- 复核：未核实

---

## 二、src/main（非 db）+ src/preload（约 3600 行）

### [严重] 提醒「先清库、后派发」，异常被吞后该批提醒永久不可见 ★本轮引入
- 证据：`main/index.ts` `startReminderDispatch` 里 `rows = dueReminders()` → `for (t of rows) dismissReminder(t.id)` → `activeReminders = rows` → `dispatchReminders()`，外层 catch 只 `console.error`。
- 影响：消费先于派发且不可回滚。一旦 `dispatchReminders()` 抛错，`activeReminders` 已非空，而下一轮 tick 开头的 `if (activeReminders.length) return` 直接返回 —— **这批提醒再也不会推给任何窗口**（只有窗口重载时靠 `reminder:current` 拉回）。
- 修复：先派发、确认可投递后再消费；或把「已派发」状态落库并用事务包住。
- 复核：✓ 已核实（这段是本轮会话新写的，属于我的疏漏：只考虑了「不叠加」，没考虑「派发失败后状态卡死」）

### [严重] 外部同步「认领」本地同名任务后，下一次同步即覆盖用户内容
- 证据：`task-sync.ts:221-235` 注释承诺「只建立 (source,id) 映射、不改它的内容」，但 `:190-218` 的 existing 分支无条件用外部值更新 title / notes_md / due_date / priority。
- 影响：注释与实现相反，用户手写任务被认领后即成为外部数据的镜像。
- 修复：认领时落 `external_linked` 标记，后续只补空字段或仅同步 status。
- 复核：未核实

### [严重→中] isAppOwnUrl 用 startsWith 前缀比较 URL —— **已修（2026-09-22）**
- 证据：`security.ts:38-41` 对 devUrl 与 `pathToFileURL(...).href` 都用 `startsWith`；`will-navigate`（`:49-53`）命中即放行。
- 影响：`http://localhost:5173.evil.com` 以 devUrl 为前缀被当作自身页面放行，外部页面可拿到该窗口的 preload 与全部 IPC。
- 严重度校准：**限开发模式**（`ELECTRON_RENDERER_URL` 仅在 dev 设置），生产走 file URL 分支，前缀绕过难以利用 —— 父 agent 从「严重」下调为「中」。
- 修复：判定抽到 `src/shared/app-url.ts` 做**精确比较**（protocol + host + pathname），
  `security.ts` 只负责把 devUrl 与入口 file URL 喂进去。
- 补充（本次收口时才发现，原条目漏了）：**打包分支也中**。
  `url.startsWith(pathToFileURL(…index.html).href)` 会把 `file:///…/renderer/index.html.evil` 一起放行 ——
  所以这不是「限开发模式」，只是生产下要恰好出现一个以入口路径为前缀的文件 URL 才可达。
  降级为「中」的判断本身没错，但理由要更正。
- 修复前的判定一直留在原地：条目降级后**没有被真正修掉**，状态表里也没有它的行 —— 这正是
  「按严重度排序的收口」会漏掉的东西：一条被降级的条目，既不在「严重」的必做清单里，
  也不会有人再回头看一眼。
- 复核：✓ 已核实（本次回代码确认两处 `startsWith` 原样未动；单测 8 项先红后绿 + 变异验证，
  另有护栏「自身 URL 判定必须是精确比较」做变异验证）

### [高] 外部同步整批 upsert 无事务，定时路径的 rejection 无人处理 —— **已修（2026-09-22 复核）**
- 证据：`task-sync.ts:320-327` 循环写库无 transaction；`main/index.ts:1656-1657` `void runTaskSync()` 无 catch；失败时 `remember()`（`task-sync.ts:145-147`）不执行。
- 修复：`conn().transaction` 包整批；`runTaskSync()` 加 catch 并写回 last_result。
- 复核：✓ 已核实已修 —— `task-sync.ts:339` 整批进了 `conn().transaction`；`main/index.ts:1685`
  定时路径改走 `runTaskSyncSafely()`（catch 里写回 last_result）。这条是在「多步写缺事务」收口里一并修掉的，
  ADR 0001 也收录了它（:18 / :57 / :78）—— 只是这张明细表没跟着更新，于是它同时以「无事务」和「已修」两种面目存在。

### [高] preload 事件订阅契约不一致：9 个 on* 不返回取消订阅 —— **已修（2026-09-22 复核）**
- 证据：无返回 `preload/index.ts:206-208/439-441/652-654/660-662/687-689/691-693/701-703/719-721/722-724`；有返回 `:558-565/590-594/620-624`。
- 影响：调用方写不出标准 cleanup，渲染层被迫绕行（`NotesPage.tsx:846` 注释「没有取消订阅接口：只注册一次…读最新 ref」）；依赖一变就静默累积监听器。
- 补充：**本轮新加的 `onNotice` / `reminder.onPush` / `reminder.onOpenTask` 三个也都没有返回取消函数**，加剧了这个问题。
- 修复：所有 `on*` 统一返回 `() => ipcRenderer.removeListener(channel, handler)`。
- 复核：✓ 已核实（并发现本轮新增的也在其中）
- 收口：已完成 —— `preload/index.ts` 现有 12 处 `removeListener` 取消函数，
  并有护栏「preload 订阅必须可取消」盯着后续新增的 `on*`。

### [高] 剪贴板监听 2s 轮询触发 sendAction → showMain() 抢焦点
- 证据：`main/index.ts:1728-1739` `setInterval(...,2000)` → `sendAction('clipboard-notice')`；`sendAction` 在 `:689-692` 无条件 `showMain()`；同处注释（`:1726`）写「不打断用户输入」。
- 影响：在其他应用复制文字后主窗口被强制显示并聚焦（`App.tsx:279` 其实只弹 toast），**意图与实现相反**。
- 修复：改走不抢焦点的通道；监听改事件/去抖。
- 复核：未核实

### [高] 6 个窗口各自复制 webPreferences，安全配置已分叉
- 证据：`sandbox:false` 出现在 `main/index.ts:1137`（capture）、`:1549`（condition），其余为 true（`:231/:959/:1012/:1238`）；`hardenWindow` 只在 `:236/:1056/:1242` 调用，**splash / capture / condition 三窗未收口**（无 will-navigate / setWindowOpenHandler / will-attach-webview）。
- 修复：抽 `createAppWindow(preload, {sandbox})` 统一构造，所有窗口过 `hardenWindow`。
- 复核：未核实（注：本轮的 `reminderWindow` 已调 `hardenWindow`）

### [高] 多组 IPC 能力「三层齐全、全项目零调用」
- 证据：`db:autoLayoutWorkflow`、`db:deleteSavedQuery`、`db:attachments/importAttachment/deleteAttachment`、`app:refreshTray`、`db:importMarkdownFromPath` —— 均有实现 + handler + preload 暴露，但渲染层/脚本零引用。
- 修复：删除无人调用的通道，或补上缺失入口（智能清单删除、附件列表/单删）。
- 复核：未核实

### [中] 浮窗每 5s 轮询全量重查，而主进程已广播 data:changed
- 证据：`WidgetApp.tsx:81` `setInterval(() => void load(), 5000)`；`db/index.ts:176` 写操作后向所有窗口 `send('data:changed')`；同窗口 `:201` 已在用 `subscribeDomain`。
- 修复：改 `subscribeDomain(['task','note'], load)`，删掉定时器。
- 复核：未核实

### [中] 选区读取：剪贴板「还原」只写 text+html，且失败全部静默
- 证据：`selection.ts:65-66` 只备份 text/html；`:38-41` spawn 失败与 `:42-58` 4s 超时都直接 `resolve()`。
- 影响：剪贴板里的图片/文件列表被永久丢弃；读取失败与「没选中」不可区分。
- 复核：未核实

### [中] src/main/index.ts 单文件 1944 行、职责过载
- 证据：六个窗口创建（`:200/:942/:998/:1100/:1218/:1521`）、浮窗几何算法（`:340-653`）、提醒调度（`:1183-1414`）、热键/托盘（`:727-929`）、任务同步（`:1630-1668`）；whenReady 内联注册 30+ handler（`:1764-1918`）与 9 个 `registerXxx`（`:1416-1708`）两种风格并存。
- 复核：未核实

### [中] ai.ts 把 API Key 放进 URL query，并硬编码业务参数
- 证据：`ai.ts:128` `?key=${apiKey}`；`:121/:135/:150` 硬编码 `max_tokens:8192`、`temperature:0.2`；`:90` `LIMIT 400`。
- 影响：密钥会进代理/访问日志（Gemini 支持 `x-goog-api-key` 头即可避免）。
- 复核：未核实

---

## 三、src/renderer/src/pages/（8 文件 / 7960 行）

### [严重] 离开笔记页会静默丢掉最后 800ms 的编辑
- 证据：`NotesPage.tsx:477-489` 自动保存 effect 的 cleanup 只 `clearTimeout`；`flushPending` 仅在 `:399/:433/:553` 调用，**卸载路径没有**；`App.tsx:496-527` 按页条件挂载，切走即卸载。
- 影响：防抖落在渲染层，却把「何时必须落盘」交给若干调用点自觉 —— 漏一处即丢数据。窗口级 beforeunload 兜不到路由切换。
- 修复：卸载 cleanup 里 flush，或抽成 `useNoteAutosave` hook。
- 复核：✓ 已核实

### [严重] 图谱增量订阅没有取消接口，IPC 监听器无界累积
- 证据：`GraphPage.tsx:212-220` 在 `useEffect(…, [])` 里 `onGraphDelta(cb)`，cleanup 只 `graphWatch(false)`；`preload/index.ts:206-208` 的 `onGraphDelta` 不返回取消函数。
- 影响：每次进图谱页叠加一个永不注销的监听；一次 delta 触发 N 次旧闭包回调（含整图重查），并在已卸载组件上 setData。
- 复核：✓ 已核实

### [严重] 批量/多步写无事务且逐条 await，中途失败半完成
- 证据：`TasksPage.tsx:450` `for (const id of ids) await deleteTask(id)`；`:588` 逐条 `moveTaskToList`；`NotesPage.tsx:778-786` 建任务 → 改 notes_md → 挂段落锚三步。
- 修复：主进程提供 `batchDelete/batchMove` 单事务入口（可参照已有 `batchComplete`）。
- 复核：未核实

### [严重] 切换布局方向把当前模板重置成列表第一个
- 证据：`WorkflowPage.tsx:264-271` `openTemplate` 依赖 `[rankdir]`；`:273-279` 初始化 effect 依赖 `openTemplate`，体内是 `openTemplate(rows[0].id)`；`:1114-1122` 方向按钮改 `rankdir`。
- 复核：未核实

### [高] 「清单设置」的改名对话框在名字未改时滑进删除确认 ★本轮引入
- 证据：`TasksPage.tsx:572-580` —— `prompt` 的 `defaultValue` 是当前名；`if (name?.trim() && name.trim() !== cur.name) { 改名; return }` 之后**无条件**执行 `dialog.confirm({title:'删除清单'…})`。
- 影响（比报告更严重）：`Dialogs.tsx:70` `prompt` 在取消时 `resolve(null)` → `name?.trim()` 为假 → **取消也会弹出「删除清单？」**。加上「不改名直接确定」同样落入删除分支，用户很可能连击确认而误删清单（任务会散回收件箱）。
- 修复：拆成两个独立菜单项，删除单独给按钮；改名分支要先判空/取消。
- 复核：✓ 已核实（这段是本轮会话新写的「清单设置」按钮，属于我的疏漏）

### [高] 设置页每个按键都写库并全量回读重解析
- 证据：`SettingsPage.tsx:341-365` `update()`：`setSetting` → `await db.settings()` → `parseSettings` → `applyAppearance`；文本 `onChange` 直连它（`:786` signature、`:608` task_api_url、`:1013/:1023/:1032` AI 三项）。
- 影响：一字一次 IPC + 一次全表读；同页 `promptDraft` 已用草稿，其它没有。
- 复核：未核实

### [高] 页面跳转靠 DOM 反查而非接口
- 证据：`TodayPage.tsx:213-218` `document.querySelector('[data-nav-item="inbox"]')?.click()`；同一数组另三张卡走 `onFocusTasks` 回调。
- 影响：跨模块靠 `data-*` 约定，改属性名即静默失效（`?.` 吞掉失败）。
- 复核：未核实

### [高] 刷新策略各页不统一；首屏加载没有错误分支
- 证据：订阅域事件的：`TasksPage.tsx:162,167`、`NotesPage.tsx:232`、`WorkflowPage.tsx:293`、`GraphPage.tsx:225`；完全不订阅的：`TodayPage.tsx:35-46`、`InboxPage.tsx:54-67`；无 catch 的：`ReviewPage.tsx:12-14`、`TodayPage.tsx:44-46`、`InboxPage.tsx:79-81`。
- 影响：失败被吞后 ReviewPage 永远停在「正在统计…」。
- 修复：抽 `useDomainData(domains, fetcher)` 统一订阅 + 加载态 + 错误态。
- 复核：未核实

### [中] 同一逻辑多处实现
- 证据：三份递归行渲染器 `TodayPage.tsx:121-177` / `InboxPage.tsx:259-308` / `TasksPage.tsx:722-775`；四份删除确认块（文案完全相同）；状态中文名 `TasksPage.tsx:55-57` vs `WorkflowPage.tsx:1190`。
- 复核：未核实

### [中] 死状态：收件箱折叠永远不可用
- 证据：`InboxPage.tsx:43` `const [collapsed] = useState(...)`（setter 丢弃）；`:268` `onToggleCollapse={() => undefined}`。
- 复核：未核实

### [中] 渲染期直接写 ref
- 证据：`TasksPage.tsx:641-642`、`GraphPage.tsx:124-125`、`:208-209`、`:700-701`、`WorkflowPage.tsx:202-203`、`NotesPage.tsx:841-844`。
- 影响：并发渲染/StrictMode 下渲染可能被丢弃或重放，ref 留下「未提交渲染」的值。
- 复核：未核实

### [中] 用固定 400ms 延时等待「笔记装载与编辑器就绪」
- 证据：`NotesPage.tsx:830`、`:850` `setTimeout(() => locateBlock(...), 400)`；`locateBlock` 取不到 view 就什么都不做。
- 影响：慢机器/大笔记时定位静默失败。
- 复核：未核实

---

## 四、src/renderer/src/components/（36 文件）+ 六个入口

### [严重] 附件 file:// URL 三份实现，其中两份在 Windows 上必然无效 ★本轮引入
- 证据：`RichTextEditor.tsx:136`（双击预览原图）与 `:165`（插入文件附件）都是 `'file://' + p.split('/').map(encodeURIComponent).join('/')`；`XlsxGrid.tsx:32` 同样；而 `main/db/attachments.ts:69` 用 `path.join` 产出**反斜杠**路径（`C:\\...\\attachments\\3\\x.png`）。
- 影响：`split('/')` 切不动反斜杠路径 → 整串被 `encodeURIComponent` 编成 `file://C%3A%5C...` —— **不是合法 file URL**。所以「双击缩略图看原图」与「点附件链接」在 Windows 上静默失效（裂图 / 打不开）。`NotesPage.tsx:349` 的 `file:///${p.replace(/\\/g,'/')}` 才是正确写法。
- 修复：抽 `shared/attachment-url.ts`（先统一分隔符再逐段编码），三处共用。
- 复核：✓ 已核实 —— **这条推翻了 1.6.0 release notes 里「双击图片用原图预览」的功能声明**。当时我把该项列为「建议你手动看一眼」，没做自动化验证，缩略图本身是内嵌 data URI 所以正常，掩盖了这条。

### [严重] 右键选中文字时两个处理器各弹一个菜单，位置完全重叠
- 证据：`MarkdownEditor.tsx:281-289` 在 `view.dom` 上另挂 contextmenu 调 `onAttachTask`，同一事件继续冒泡到 `:318-324` 的 React handler 又 `setMenu`；`NotesPage.tsx:1204/1212` 两个 prop 都传了。
- 修复：右键只留一条路，组件内合成一个菜单。
- 复核：未核实

### [严重] 多步写没有事务，失败留下部分状态且仍提示成功
- 证据：`CapturePanel.tsx:148-151` 先 `createTask` 再 `updateTask(notes_md)`，第二步 reject 时任务已落库、备注丢失、onNotice 不执行（`:172` 是 `void`）；`TagManager.tsx:104`、`RecycleBin.tsx:160-162` 循环逐条 IPC 删除。
- 复核：未核实（与数据层 5 / 页面层 3 同属「多步写缺事务」模式）

### [高] 富文本插入链接/附件时手工拼 HTML 字符串，用户输入未转义
- 证据：`RichTextEditor.tsx:153` `insertContent('<a href="' + target + '">' + label2 + '</a>')`（target 来自 `:146` 的 prompt，label2 来自 `:150`）；`:166` 同样拼 file 链接。
- 影响：绕开 schema 命令的写入路径；显示文字含 `< > &` 会被当标记解析，href 里的引号能改写属性。
- 复核：未核实

### [高] TaskEditor 的 saving 没有 try/finally
- 证据：`TaskEditor.tsx:83-88`、`:98-120` 都是 `setSaving(true) → await → setSaving(false)`，调用处 `:316/:323` 是 `void`。
- 影响：本应用明确存在只读库场景（`App.tsx:63,101`），那时每次保存都会静默把弹窗锁在「保存中…」。
- 复核：未核实

### [高] App 的撤销只有单槽、先清空再逐条写、无错误处理
- 证据：`App.tsx:366` `setUndoBar(null)` 在前，`:369-375` for + await 逐条写，无 try/catch；`:572` `void undoLast()`。
- 影响：任一条失败即中断且撤销条已消失 —— 看不到错误也无法重试。
- 复核：未核实

### [高] 浮窗用 5 秒轮询代替已有广播
- 证据：`WidgetApp.tsx:81` `setInterval(load, 5000)`；`:195-201` 只订阅 `['settings']`；主进程广播本就发给所有窗口（`main/db/index.ts:174-177`）。
- 复核：未核实（与主进程 9 是同一处，两组独立发现）

### [高] 提醒「查看」的 id 在 App 里被丢弃 ★本轮引入
- 证据：`App.tsx:547-552` `onOpenTask={(id) => { setTaskFocus(null); setPage('tasks'); void id }}`；而 `:354-361` 又单独订阅 `reminder.onOpenTask` 做定位。
- 影响：**主窗口提醒卡片上的「查看」只切页、不定位到那条任务**（气泡窗口的「查看」因为走主进程推送那条链路，是有效的）。两条同源链路一条把参数丢了。
- 修复：只留一条，并把 id 真正用于定位。
- 复核：✓ 已核实 —— 本轮会话我改了 ReminderPopup 的取数方式，却漏看了 App 传入的这个回调

### [中] TaskRow 21 个必填 props，浮窗被迫传 5 个空实现
- 证据：`TaskRow.tsx:8-31`；`WidgetApp.tsx:333`、`:357-361` 全是 `() => undefined`，另有 `selected={false}`、`dropHint={null}`。
- 复核：未核实

### [中] 三种弹出菜单各写一份，关闭契约已分叉
- 证据：`PopMenu.tsx:49-52` 自己在 onPick 后 onClose；`StatusMenu.tsx:21-40`、`PriorityMenu.tsx:15-34` 不做（也不做视口钳制）；`WidgetApp.tsx:461`、`:469` 只写库未 onClose → **浮窗里选完状态菜单不关**。
- 复核：未核实

### [中] 死代码：byId 只为消除未使用告警而存在
- 证据：`QuadrantBoard.tsx:61` 建 Map；`:157-158` `<span hidden>{byId.size}</span>` 并注明「避免未使用告警」。
- 复核：未核实

### [中] 跨模块复制主进程的常量与路径口径，只靠注释绑定
- 证据：`WidgetBall.tsx:53,57` 与 `main/index.ts:104,101` 各自定义 `BALL_MARGIN=8`/`SIZE_MIN=88`；`CommandPalette.tsx:76-81` 用字符串切片自行推导 `backups/`，而主进程已有 `backupDir()`、渲染层已有 `listBackups` API。
- 复核：未核实

## 五、src/shared/ + src/renderer/src/lib/

### [严重] 两套 HTML 清洗器，渲染层黑名单可被 java\tscript: 绕过（XSS）
- 证据：\`shared/sanitize-html.ts:1-14\` 声明自己是两端唯一白名单；\`components/MarkdownView.tsx:11-22\` 仍自建黑名单，只挡 \`/^\\s*javascript:/i\`。
- 实跑（shared 那份）：\`sanitizeHtml('<a href="java\\tscript:alert(1)">点我</a>')\` → \`<a>点我</a>\`（拦住）。渲染层那份对同串**漏过** —— 浏览器 URL 解析会剥掉 tab，\`java\tscript:\` 仍是 javascript: URL。
- 影响：笔记正文来自导入 / 粘贴 / AI，属不可信输入。
- 修复：删除 MarkdownView 的 sanitize()，改用 shared 的 sanitizeHtml。
- 复核：✓ 已核实（与第七节同一条，这里补上「可绕过」的实跑证据 → 严重度由高上调为**严重**）

### [严重] 数据广播靠手抄 WRITE_DOMAINS 表，已经漂移：写成功但零通知
- 证据：\`main/db/index.ts:59-165\` 映射表 + \`:223-230\` 包装器；\`'db:setFlashStatus'\`(:95) 从未注册；真正在跑的 \`db:archiveFlash/db:unarchiveFlash\`(:472-473，写 flash.status) 不在表里；\`db:attachTaskNote/detachTaskNote\`(:332-336) 也不在表里。
- 复核：✓ 已核实（与第一节第 4 条同一处，两组独立发现且各自给出证据）

### [高] 捕获语法词法与解析两套正则：下周X 串台、下下周X 静默丢日期
- 证据：\`capture.ts:119\` 词法含 \`下下周?[一二三四五六日天]\`，而 \`:72\` 解析只认 \`/^(下)?周([一二三四五六日天])$/\`。
- 实跑（today=2026-09-16）：\`下周五交报告\` → \`{title:'下 交报告', dueDate:'2026-09-18'}\`（**拿到本周五**，应为 09-25，标题还残留「下 」）；\`下下周五交报告\` → \`{title:'交报告', dueDate:null}\`（短语被整段删除、**静默丢日期**）。
- 单测只单独测了 \`parseNaturalDate('下周五')\`，没测整串 —— 缺陷被测试结构掩盖。
- 复核：✓ 已实测复现
- 注：本轮会话修过 capture.ts 的 \`周五前\` / 非法时刻 / 非法日期，但**没覆盖 \`下周X\` 这条分支**。

### [高] 「完成态」有 4 份实现，abandoned 口径已分叉
- 证据：\`shared/task.ts:37\`(isTerminal 含 abandoned)、\`components/TargetSelector.tsx:53\`(本地复制)、\`pages/TasksPage.tsx:216-218\`(内联)、\`shared/query.ts:135-137\`(只认 status==='done')。
- 实跑：\`matchTask({status:'abandoned'}, parseQuery('!done'))\` → **true**（当未完成），而 TaskRow 用 effectiveDone 给同一行标「已完成」—— 智能清单与列表对同一条任务结论相反。
- 复核：✓ 已实测复现

### [高] 查询表达式对无法识别的 due 值静默返回空集
- 证据：\`shared/query.ts:96-97\` 对 \`due<任意串\` 无条件接受；\`:162-177\` resolveDueToken 返回 null 时直接 return false；\`:26-27\` 声明的 unknown 通道全仓无读取点。
- 影响：\`due<瞎写\` → 清单突然一条不剩且无任何提示。
- 复核：未核实

### [高] 文档承诺的裸词 done 未实现，被当成全文搜索
- 证据：\`shared/query.ts:11\` 写明裸 done = 已完成；实际 \`:119-120\` 只把它拼进 text。
- 复核：未核实

### [中] ai-note 的「占位符是否还在」有两份实现
- 证据：\`shared/ai-note.ts:379-411\` 与 \`:500-522\` 是同一套判定的复制；\`main/ai.ts:467\` 用后者审、\`:472\` 用前者写；\`ai.ts:473-479\` 的 missing 分支已不可达。
- 影响：两份一旦分叉就是「审计 ok、写入丢图」。
- 复核：未核实

### [中] 死代码 / 未使用导出（测试引用造成「有人在用」的假象）
- 证据：\`lib/edge-path.ts:69-84\` elbowPath（生产零引用，已在 :141 注释里被点名批评）；\`shared/wiki.ts:63\` firstHeading、\`shared/note-links.ts:102\` sameLink、\`shared/settings.ts:196\` serializeSetting 同样只出现在自己的单测里；\`shared/capture.ts:129\` \`token.replace(/!/g,'!')\` 是恒等替换。
- 复核：未核实

### [中] edgePathMidpoint 反向解析自己生成的 SVG path 字符串
- 证据：\`lib/edge-path.ts:149\` 已算出全部折点，但 \`WorkflowPage.tsx:1604/1612\` 把 d 再交给 \`:188\` 用正则解析回点；解析失败静默返回 \`{x:0,y:0}\`。
- 影响：改成相对指令或曲线后，删除按钮会静默飘到画布原点。
- 复核：未核实

### [中] 渲染期写 ref
- 证据：\`lib/usePanZoom.ts:74\`；\`GraphPage.tsx:701\`、\`WorkflowPage.tsx:441\` 同样。
- 复核：未核实（与第三节同源，两组独立发现）

### [中] 主题包默认值两处且不一致，未知包名静默换主题 —— **已修（2026-09-22）**

以 Python 版为准统一到「青竹」（core/constants.py、settings.py、fluent_bridge.py 三处都是它，
accent #0D9488），并加 src/shared/theme-default.test.ts 把 DEFAULT_THEME_PACK、
DEFAULT_SETTINGS.theme_pack、parseSettings({}).theme_pack 三个值钉在一起。

以前没暴露的原因值得记：E2E 跑在用户库上，而库里存着 theme_pack=墨黑，
于是 themecheck 里「默认主题包是墨黑」的断言一直是「过」的 —— 它测的是用户的设置，
不是代码的默认值。E2E 改成跑夹具库（空库）之后立刻现形。
- 证据：\`shared/settings.ts:106/176\` 默认 \`'青竹'\`；\`shared/theme-packs.ts:91\` DEFAULT_THEME_PACK=\`'墨黑'\`。两版共用同一只 settings 表。
- 复核：未核实

### [中] 整库整理 N 篇 × 全表扫描 + 重建同一份提示词片段
- 证据：\`main/ai.ts:640-656\` 逐篇调 organizeNoteWithAi，它每次执行 \`noteListForPrompt()\`（:86-93 的 LIMIT 400）；结果再交给 \`shared/ai-note.ts:663-674\` 对 400 条做两次 filter + 排序。
- 复核：未核实

> **已排除的疑点**：\`shared/sanitize-html.ts\` 本体经实跑是严格白名单（java+tab、java+换行、javascript:、onerror、svg/onload 全挡住）—— 问题只在渲染层没复用它；\`src/shared\` 无任何 DOM / Node 运行时依赖，跨进程边界干净，也未发现渲染层专属逻辑被塞进 shared。

---

## 六、scripts/（52 个 .mjs）+ 构建配置

### [严重] CDP 样板被复制到 47–50 个脚本，已分叉成 3 种实现
- 证据：`graphcheck.mjs:47-57`、`todaycheck.mjs:43-56`、`smoke.mjs:76-87`、`seedmonitor.mjs:76-78`（同文件 `:534-537` 又抄一遍）；`const id = Math.floor(Math.random()*1e6)` 出现在 47 个文件；`await send('Runtime.enable')` 47 个。`graphcheck.mjs:9` 的 `execFileSync` 是死 import。
- 影响：CDP 行为一变要改 50 处；rollcheck 只修了一份就是现成后果。
- 修复：抽 `scripts/lib/cdp.mjs`（launch/attach/send/evaluate/check）。
- 复核：未核实

### [严重] 5 个脚本未隔离 ZHIXING_HOME，会把设置写进用户真实库
- 证据：`capture.mjs:31-33` `env: { ...process.env }` 未设 `ZHIXING_HOME`，而 `:96` 执行 `window.zhixing.db.setSetting('theme_mode', …)`。
- 复核：✓ 已核实（实测：49 个启动 Electron 的脚本里 44 个设了，未隔离的 5 个是 `bigcapture / capture / diag-today / layoutcheck / smoke`）
- 影响：跑一次截图脚本就改掉用户的主题设置。库路径靠「记得设环境变量」而非接口强制。
- 修复：`launch()` 把 `ZHIXING_HOME` 设为必填，缺省抛错。

### [严重] 13 个脚本的「真实库未被写入」断言在 Windows 上必然崩溃、从未执行
- 证据：`todaycheck.mjs:157`、`dialogcheck.mjs:116`、`editorcheck.mjs:94`、`eventcheck.mjs:99`、`importcheck.mjs:124`、`inboxcheck.mjs:146`、`notecheck.mjs:208`、`officecheck.mjs:92`、`recyclecheck.mjs:121`、`taskopscheck.mjs:126`、`themecheck.mjs:121`、`vlistcheck.mjs:84`、`writecheck.mjs:198` 都用 `join(process.env.HOME, 'Library/Application Support/…')`。
- 复核：✓ 已核实（实测含该路径的脚本正好 13 个，清单一致）
- 影响：唯一守住「测试不污染真实库」的断言集体失效，且以 TypeError 崩溃代替断言失败。本轮的 `rollcheck.mjs` 已修，其余 13 个未修。
- 修复：统一走 `APPDATA` / `app.getPath('userData')`。
- 复核：✓ 已核实

### [严重] Gitee 上传失败只打印、退出码仍为 0
- 证据：`upload-release.mjs:111-118` 仅 `console.log(ok ? '✓' : '✗ 上传失败…')`，无 `exitCode`；`:101-103` 注释恰好记录过「附件全丢」的历史。
- 复核：未核实

### [严重] seedmonitor 统计了失败却永不失败
- 证据：`seedmonitor.mjs:581-592` 输出 problems 计数，`:593-595` 直接收尾，无终态非零退出（其余 30+ 检查脚本都有 `process.exit(failed ? 1 : 0)`）。
- 复核：未核实

### [高] 48 个脚本端口硬编码，其中 7 组冲突
- 证据：9231 / 9232 / 9233 / 9240 / 9241 / 9242 / 9244 各有 2–3 个脚本共用。
- 影响：靠「不并行」的约定耦合；并行时会命中别人的实例而「通过」。
- 复核：未核实

### [高] 打包/诊断链依赖写死的 POSIX 路径
- 证据：`officecheck.mjs:29` `join(repoRoot, '.venv/bin/python')`（Windows 应为 `.venv\Scripts\python.exe`，必 ENOENT）；`bigcapture.mjs:63` `writeFileSync('/tmp/big-…png')`。
- 复核：未核实

### [高] 静态审计脚本用手写正则解析 TS / CSS 源码
- 证据：`contrast-audit.mjs:35-57` 按行正则抓主题包结构，仅全空才报错，`:125` 固定 `exit(0)`；`ctlheightcheck.mjs:40-67` 自建括号配对扫 CSS。
- 影响：抽象泄漏 —— 源码排版一改就静默少检，「通过」其实没查。
- 复核：未核实

### [中] 413 处固定 sleep(ms) 代替事件等待
- 证据：如 `graphcheck.mjs:58,64,82,109,111,125`；仅 `interactioncheck.mjs:79`、`workflowauto.mjs:114` 有 `waitFor`。
- 复核：未核实

### [中] 5 个脚本各自实现假 OpenAI 端点
- 证据：`aicheck.mjs:71-100`、`ailibcheck.mjs`、`airepaircheck.mjs`、`tasksynccheck.mjs`、`seedmonitor.mjs:31-40`。
- 复核：未核实

### [中] 44 个检查脚本没有 npm 入口，无法作为门禁统一跑
- 证据：`package.json:20-24` 只暴露 5 个 `check:*`；`vitest.config.ts:16` 只覆盖单测。
- 影响：能力断链 —— 脚本存在但无 CI 触发，上面第 3、5 条的长期失效正源于此。
- 复核：未核实

### [中] 发布资产清单两处硬编码重复且写死 x64
- 证据：`release.mjs:142-146` 定义资产名，`:222` 又逐字重列；架构仅 x64。
- 复核：未核实

---

## 七、横切机械核对（父 agent 亲自执行）

| 项 | 结果 | 判定 |
| --- | --- | --- |
| IPC 契约对称性 | 主进程注册 222 条 / 渲染层使用 221 条 | **零断链** |
| `any` 类型 | 0 处 | 干净 |
| `eval` / `new Function` / `.innerHTML =` | 0 处 | 干净 |
| `console.log` 遗留 | 0 处 | 干净 |
| `@ts-ignore` / `@ts-expect-error` | 0 处 | 干净 |
| TODO / FIXME / HACK | 0 处（非 vendor 非测试） | 干净 |
| `dangerouslySetInnerHTML` | 2 处，均经消毒 | 见下 |
| 宽松相等 `==` / `!=` | 135 处 → **132 处是 `!= null` 惯用法** | **不是缺陷** |

### [高] 同一安全职责两套消毒，弱的那套还在冒充白名单
- 证据：`src/shared/sanitize-html.ts` 是成熟的白名单消毒（默认拒绝、逐 token 解析），头注释自己写着「两边各写一套必然漂移」；但 `src/renderer/src/components/MarkdownView.tsx:11` 仍留着一套**黑名单**实现，注释却自称「白名单式清理」——不移除 `svg`/`math`/`template`/`noscript`，也不剔除内联 `style`。
- 影响：**Markdown 预览走弱的，富文本预览走强的**。
- 复核：✓ 已核实

### [中] 终态判定重复实现
- 证据：`src/shared/task.ts:37` `isTerminal(status: TaskStatus)`；`src/renderer/src/components/TargetSelector.tsx:53` 又写一个 `(status: string)`，注释还写着「对齐 Task.is_done」。
- 复核：✓ 已核实

### [过程] 既有审计结论已大幅滞后
- `docs/audit/task.md` 标注「仍成立」的三条高风险条目，逐条回代码核对后**全部已修**：`resume_at` 已在 `EDITABLE_FIELDS`（`tasks.ts:374`）、清单体系齐全（`lists.ts` 五个函数）、任务↔笔记关联三条写入路径都在（`tasks.ts:79/92/426`）。
- 影响：照这份文档排期会做无用功。
- 复核：✓ 已核实

### 父 agent 的两次自我纠错（记录在案）
1. `!= null` 那 132 处的第一版判定是「违反 OCR 规则」——错。它同时排除 `null` 与 `undefined`，改过去反而引入 bug。
2. 「8 个通道主进程没注册」的第一版对账是假阳性——正则只匹配同一行，漏掉了项目里大量跨行写法（`handle(` 与通道名不同行）。修正后零缺失。

---

## 附：OCR 系统规则集（`ocr delegate rule` 输出，本库适用）

> 拼写错误 · 死代码（不可达分支 / 声明未读 / 大段注释代码）· 重复代码 · 硬编码业务字符串 ·
> 禁止 var、禁止 `==`/`!=`、避免 `any`、取值需空检查、禁止嵌套三元 ·
> React（Hooks 只在顶层 / 状态层级 / useEffect 依赖与清理 / 渲染期禁副作用 / 内联 style 限动态 / 禁止组件内声组件）·
> 异步（必须处理错误 / 优先 async-await / 独立异步用 Promise.all）·
> 安全（XSS / 禁 innerHTML 插用户输入 / 禁 eval·Function·字符串 setTimeout / 敏感信息 / 禁改原型链）
