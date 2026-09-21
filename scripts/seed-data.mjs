/**
 * 生产库种子数据的内容本体。
 *
 * 设计原则：
 *  1. **真实语义**：全部内容围绕「知行 2.0 收口」这件真事展开，
 *     不是「测试任务 1/2/3」。每条任务的标题都指向一个具体的交付物。
 *  2. **结构达标**：任务树 3 层、每层 5 条；笔记 5 种格式各 5 篇；
 *     笔记文件夹 3 层；任务↔笔记三种关联方式各有覆盖。
 *  3. **可运行**：三个工作流模板的节点全部指向真实存在的任务/笔记/脚本，
 *     实例化后能真的往下走，不是画着好看的空壳。
 *
 * 这里只放内容，不含任何数据库调用 —— 落库由 seed-production.mjs 走应用自身接口完成。
 */

/** 第三层的五套步骤模板。每个二级任务按自己的性质挑一套，再拼上主题。 */
const STEPS = {
  A: [
    '按模块列出全部写点清单',
    '标注每个写点涉及的表与执行顺序',
    '确认哪些步骤已经天然原子',
    '标出中途失败会留下半截状态的位置',
    '与审计清单逐条对照，补齐漏项'
  ],
  B: [
    '把判定逻辑从数据库壳里剥出来',
    '定义输入输出类型与边界条件',
    '覆盖正常路径的单元测试',
    '覆盖边界与异常路径的单元测试',
    '让调用方只剩取数与落库两件事'
  ],
  C: [
    '用连接的事务包裹跨表写入',
    '把异步步骤挪到事务之外',
    '确认失败时整体回滚而不是半截落库',
    '确认成功后只广播一次',
    '补一条中途失败的回滚验证'
  ],
  D: [
    '收敛成单个批量 IPC 通道',
    '在写域表里登记这条通道',
    '确保广播发生在提交之后',
    '页面订阅改为按域批量刷新',
    '补一条「广播在提交之后」的验证'
  ],
  E: [
    '写一条先红后绿的端到端验证',
    '把不变量写成架构护栏',
    '用变异验证确认护栏真的会红',
    '在真实库副本上跑一遍确认零污染',
    '把本轮的遗留与原因记进技术债'
  ]
}

/** 一级 → 二级（每级 5 条），二级带自己的步骤模板。 */
const TREE = [
  {
    title: '数据层：多步写事务收口',
    status: 'doing',
    priority: 4,
    tags: ['深度工作', '架构'],
    kids: [
      ['清点全部多步写点', 'A'],
      ['抽出纯决策函数', 'B'],
      ['用事务包裹跨表写入', 'C'],
      ['批量 IPC 通道与广播时机', 'D'],
      ['回滚与幂等验证', 'E']
    ]
  },
  {
    title: '主进程：提醒派发与广播时机',
    status: 'doing',
    priority: 4,
    tags: ['深度工作'],
    kids: [
      ['清点提醒派发链路', 'A'],
      ['抽出提醒策略纯函数', 'B'],
      ['派发与记账的顺序收口', 'C'],
      ['广播时机与写域登记', 'D'],
      ['提醒回归与兜底', 'E']
    ]
  },
  {
    title: '渲染层：页面与组件收敛',
    status: 'todo',
    priority: 3,
    tags: ['深度工作'],
    kids: [
      ['清点逐条 IPC 循环', 'A'],
      ['抽出共享判定与格式化', 'B'],
      ['合并重复的状态写入', 'C'],
      ['批量刷新替代逐条订阅', 'D'],
      ['交互回归验证', 'E']
    ]
  },
  {
    title: '质量保障：端到端基线与护栏',
    status: 'doing',
    priority: 4,
    tags: ['深度工作', '复习'],
    kids: [
      ['清点失效的验证脚本', 'A'],
      ['抽出共用 CDP 骨架', 'B'],
      ['脚本输出与退出码收口', 'C'],
      ['架构护栏与变异验证', 'D'],
      ['基线全绿与遗留登记', 'E']
    ]
  },
  {
    title: '发布：打包、发版与回滚预案',
    status: 'todo',
    priority: 3,
    tags: ['外出'],
    kids: [
      ['清点发布链路', 'A'],
      ['抽出发布脚本的纯函数', 'B'],
      ['资产上传与失败退出码', 'C'],
      ['版本号与标签对齐', 'D'],
      ['发版后校验与回滚', 'E']
    ]
  }
]

/** 收件箱（list_id 为空）的顶层任务：真实的一次性捕获。 */
const INBOX = [
  { title: '把体检预约改到下周三上午', priority: 2, due: 2, tags: ['电话'] },
  { title: '给爸妈订国庆回程的车票', priority: 3, due: 5, tags: ['外出'] },
  { title: '续交车辆保险，对比三家报价', priority: 3, due: 9, tags: ['等待他人'] },
  { title: '整理书桌，把待归档的纸质材料分类', priority: 1, tags: ['待归档'] },
  { title: '回复房东关于暖气检修的时间', priority: 2, due: 1, tags: ['电话', '等待他人'] },
  { title: '把上季度的体检报告扫描进知识库', priority: 1, tags: ['待归档'] }
]

/** 另外两张清单里的日常任务，用来覆盖状态、重复、提醒这些分支。 */
const DAILY = {
  list: '个人事务',
  tasks: [
    { title: '每周日上午回顾本周待办', status: 'todo', priority: 2, repeat: 'weekly', tags: ['复习'] },
    { title: '每月 1 号检查自动备份是否成功', status: 'todo', priority: 3, repeat: 'monthly', tags: ['待归档'] },
    { title: '交电费', status: 'done', priority: 2, tags: ['外出'] },
    { title: '等物业回复车位续租', status: 'waiting', priority: 2, resume: 7, tags: ['等待他人'] },
    { title: '清理三年前的项目归档', status: 'abandoned', priority: 1, tags: ['待归档'] },
    { title: '给相机换一块备用电池', status: 'todo', priority: 1, tags: ['外出'] }
  ]
}

/** 名词表：三个工作流模板共用的真实对象。 */
const WORKFLOWS = [
  {
    name: '每周复盘',
    description: '周日晚上跑：先收集本周事实，再决定是否当场复盘；不做就顺延到下周一。',
    start_policy: 'first',
    steps: [
      { key: 'collect', title: '收集本周完成与未完成', kind: 'task',
        detail: '从「已完成」与「等待中」两个视图各挑几条，写进下方笔记。' },
      { key: 'gate', title: '本周复盘现在开始吗', kind: 'condition',
        value: { kind: 'confirm', prompt: '现在开始写复盘？取消则顺延到下周一。' },
        yes: 'write', no: 'defer' },
      { key: 'write', title: '撰写复盘笔记并归档', kind: 'task',
        detail: '结论写进「每周复盘」笔记，并把未完成项重新排期。' },
      { key: 'defer', title: '本周暂缓，下周一并回顾', kind: 'task',
        detail: '把两件事合成一次回顾，别再拆成两回。' }
    ]
  },
  {
    name: '发布前置检查',
    description: '发版前跑：先校验产物，再按校验结果决定继续发还是回滚。',
    start_policy: 'first',
    steps: [
      { key: 'verify', title: '校验产物与标签是否一致', kind: 'script', runtime: 'node', expect: '0',
        value: 'process.exit(0)' },
      { key: 'gate', title: '校验是否通过', kind: 'condition',
        value: { kind: 'prev', expectOk: true },
        yes: 'ship', no: 'rollback' },
      { key: 'ship', title: '更新发布说明并置为最新', kind: 'task' },
      { key: 'rollback', title: '回滚：撤下资产并记录失败原因', kind: 'task' }
    ]
  },
  {
    name: '读书笔记整理',
    description: '读完一本书后跑：先提炼结论，再决定要不要单独开一篇主题笔记。',
    start_policy: 'first',
    steps: [
      { key: 'pick', title: '选出这本书的摘录段落', kind: 'task',
        detail: '只留真正改变了判断的段落，其余不抄。' },
      { key: 'digest', title: '提炼三条可执行的结论', kind: 'task' },
      { key: 'gate', title: '是否值得单独开一篇主题笔记', kind: 'condition',
        value: { kind: 'confirm', prompt: '三条结论能不能撑起一篇独立笔记？' },
        yes: 'topic', no: 'link' },
      { key: 'topic', title: '开主题笔记并回链到读书笔记', kind: 'task' },
      { key: 'link', title: '只在读书笔记里加一段小结', kind: 'task' }
    ]
  }
]

/** 闪记收件箱：真实的碎片灵感与待整理内容。 */
const FLASHES = [
  { content: '把「多步写」的判据做成一条能扫源码的护栏，而不是只写在 ADR 里 —— 约定拦不住，断言才拦得住。',
    remark: '来自本周复盘的结论', source_app: '知行', tags: ['复盘', '架构'] },
  { content: '提醒的记账基准应该跟着截止时刻走，改了截止时间就该自动重新计数，否则用户要手动清。',
    remark: '提醒策略那条缺陷的根因', tags: ['架构'] },
  { content: '端到端脚本崩掉时最容易骗人的是：断言全过、退出码却是 1 —— 收尾阶段抛错不会有汇总行。',
    remark: 'taskkill 那次排查', tags: ['复盘'] },
  { content: '验证脚本的输出不要在 PowerShell 里用 Select-Object 截断，会提前关管道把 node 打成 EPIPE。',
    tags: ['复盘'] },
  { content: '《卡片笔记写作法》第 6 章：真正的复利来自「把新笔记接进旧笔记」，而不是记了多少条。',
    remark: '待整理进读书笔记', source_app: '微信读书', source_url: 'https://weread.qq.com/', tags: ['复习'] },
  { content: '给知识库加一个「本周新增」视图，只看这七天写进去的东西，避免越攒越不敢看。',
    remark: '产品想法，先记着', tags: ['研究'] },
  { content: 'SQLite 的 WAL 允许多进程读写同一只库，但 busy_timeout 必须设，否则并发写会直接报错。',
    source_url: 'https://www.sqlite.org/wal.html', tags: ['研究', '架构'] },
  { content: '周报不要罗列做了什么，只写「判断变了几次」，剩下的让清单自己说话。',
    remark: '来自一次自我复盘', tags: ['复盘'] }
]


/** 笔记文件夹：三层嵌套（生活/学习两条线各三层，工作线最深到三层）。 */
const NOTE_FOLDERS = [
  { key: 'work', name: '工作', parent: null },
  { key: 'zx', name: '知行 2.0', parent: 'work' },
  { key: 'adr', name: '架构决策', parent: 'zx' },
  { key: 'release', name: '发布记录', parent: 'zx' },
  { key: 'meeting', name: '会议', parent: 'work' },
  { key: 'study', name: '学习', parent: null },
  { key: 'book', name: '读书笔记', parent: 'study' },
  { key: 'book2026', name: '2026', parent: 'book' },
  { key: 'tech', name: '技术参考', parent: 'study' },
  { key: 'life', name: '生活', parent: null },
  { key: 'health', name: '健康', parent: 'life' }
]

const MD_ADR = [
  '# 架构决策：多步写一律进事务',
  '',
  '## 背景',
  '审计在数据层、主进程、页面层、组件层一共点了 15 处「多步写」。它们共同的样子是：',
  '先写 A 表，再写 B 表，中间任何一步失败，库里就留下半截状态 —— 而 UI 只看到第一次广播，',
  '于是显示成功、数据是坏的。',
  '',
  '## 决策',
  '1. 跨表写入一律用连接的事务包起来；better-sqlite3 的事务是同步的，',
  '   异步步骤（如广播、文件 IO）必须挪到事务之外。',
  '2. 广播挂在 handle(通道) 包装器里，天然发生在提交之后 —— 不要在事务内手动 emit。',
  '3. 渲染层禁止在循环里逐条调 IPC：事务跨不了进程，第 N 条失败时前 N-1 条已经落库。',
  '   批量操作必须收敛成单个批量通道。',
  '',
  '## 影响',
  '约定拦不住，断言才拦得住 —— 因此这几条都配了可扫源码的架构护栏，做过变异验证。'
].join('\n')

const MD_BASELINE = [
  '# 端到端基线：哪些脚本还能跑',
  '',
  '## 为什么先做基线',
  '多数验证脚本此前根本跑不起来（依赖已删除的 sqlite3 命令行、依赖已删除的备份库、',
  'macOS 路径在 Windows 上直接抛错），于是「真实库未被写入」这类断言从未执行过。',
  '',
  '## 已确认可跑',
  'guardcheck / noteeditguard / notelinkcheck / attachmentcheck / taskarchivecheck /',
  'taskopscheck / notecheck / inboxcheck / todaycheck / remindercheck / reminderpolicycheck /',
  'taskarchivecheck / rollcheck / dialogcheck / tasksynccheck —— 逐个跑绿之后才有资格做重构。',
  '',
  '## 教训',
  '批处理里用管道截断输出（Select-Object -First / -Last）会提前关闭管道，',
  '把 node 打成 EPIPE，表现是「整批脚本全挂」，其实是假象。验证一律写日志文件再读。'
].join('\n')

const MD_CHECKLIST = [
  '# 发布检查清单',
  '',
  '- [ ] npm run typecheck 通过',
  '- [ ] npm test 全绿（当前 340 项）',
  '- [ ] 架构护栏全绿（当前 28 条）',
  '- [ ] 端到端基线脚本逐批跑绿',
  '- [ ] 版本号、tag、Release target 三者一致',
  '- [ ] 三个资产都在（setup / portable / source）',
  '- [ ] npm run rebuild 恢复原生模块',
  '',
  '相关：[[架构决策：多步写一律进事务]]、[[端到端基线：哪些脚本还能跑]]'
].join('\n')

const MD_MEETING = [
  '# 周会纪要：2.0 收口范围',
  '',
  '## 定了',
  '- 2.0 只做「收口」：把审计清单里的严重项清零，不加新功能。',
  '- 数据层优先：事务边界不清楚，后面所有改动都建在沙子上。',
  '- 每条修复先补验证再动代码，验不过就不算修完。',
  '',
  '## 没定',
  '- 中低优先项（静默失败、重复实现、死代码）是否并入 2.0 —— 待严重项清零后再评估。',
  '',
  '## 下一步',
  '端到端基线先跑绿，再谈重构；基线不绿的时候做重构，等于在雾里换车轮。'
].join('\n')

const MD_BOOK = [
  '# 《卡片笔记写作法》读书笔记',
  '',
  '## 核心判断',
  '复利不来自「记了多少条」，而来自「新笔记有没有接进旧笔记」。孤立的笔记再多也只是杂物间。',
  '',
  '## 三条可执行结论',
  '1. 每写一条新笔记，至少连一条旧笔记 —— 否则就当没写。',
  '2. 只留下「改变了判断」的段落，其余不抄。',
  '3. 定期回看连接最多的那几条，它们往往就是当前真正在思考的问题。',
  '',
  '相关：[[读书清单与进度]]'
].join('\n')

const RT_REQ = [
  '需求澄清：提醒策略的三个开关',
  '',
  '一、提前量只对「没手动设过提醒时刻」的任务生效 —— 手动设过的一律以手动为准。',
  '二、自动提醒的规则拆成两个开关加一个优先级下限：有截止时刻的默认开；',
  '    只有截止日期的默认关（打开它等于把历史任务全变成提醒，升级那一刻会炸）。',
  '三、次数与间隔可配：默认 1 次，等价于旧行为。',
  '',
  '关键取舍：默认值必须让升级前后的行为完全一致。'
].join('\n')

const RT_WEEKLY = [
  '本周复盘',
  '',
  '判断变了几次：',
  '1. 「先建基线再重构」从建议变成了硬门槛 —— 试批量改 11 个脚本，6 个在样板区段里藏着自己的东西。',
  '2. 语法检查挡不住这类错误：11 个全部 node --check 通过，其中 2 个当场 ReferenceError。',
  '3. 收尾阶段的错误最会骗人：断言全过、退出码却是 1，因为进程在 close() 里崩了。',
  '',
  '下周只做两件事：把护栏补到能抓住这三类问题；把剩余脚本按批次迁完。'
].join('\n')

const RT_WRITEPOINTS = [
  '数据层写点盘点（速记）',
  '',
  '15 处多步写，按性质分四类：',
  'A 类「同表多行」——批量删除、批量撤销；',
  'B 类「跨表」——删任务连带删标签关联与链接；',
  'C 类「写 + 派生」——写正文后重算链接与 FTS 索引；',
  'D 类「写 + 广播」——广播必须严格在提交之后。',
  '',
  '只有 B、C 两类真的需要事务，A 类本来就原子，D 类是时序问题不是原子性问题。'
].join('\n')

const RT_RENDER = [
  '渲染层页面拆分草案',
  '',
  '任务页当前承担了：清单筛选、批量操作、清单设置、终态折叠。',
  '拆分原则：把「可能失败的多步写」和「纯展示」分开。',
  '清单设置里的改名与删除必须是两个独立动作 —— 此前它们共用一个函数，',
  '取消一次重命名就会滑到删除确认，等于每取消一次就吓用户一次。'
].join('\n')

const RT_BOOKCLUB = [
  '读书会分享提纲',
  '',
  '主题：为什么「记了多少」是错的指标。',
  '一、孤立笔记的复利是 0：没有连接的笔记检索不到。',
  '二、连接的密度比条数更能预测「半年后还能不能用」。',
  '三、给每次记录设一个门槛：接不上任何旧笔记，就先不记。'
].join('\n')

const WD_PLAN = [
  '2.0 收口方案说明书',
  '',
  '范围：审计清单的严重级全部清零，中低优先项登记为技术债。',
  '节奏：数据层 → 主进程 → 渲染层 → 质量保障 → 发布，每一段都以「验证先绿」为出口。',
  '验收：单测、架构护栏、端到端基线三层都绿，且每条修复都能指出对应的验证。',
  '风险：端到端脚本本身不可靠，会给出假的绿灯 —— 因此脚本的退出码也要纳入护栏。'
].join('\n')

const WD_RELTEMPLATE = [
  '对外发布说明模板',
  '',
  '本版要点：一句话说清用户能感知到的变化，不写实现细节。',
  '另外两处：次要变化，一两行带过。',
  '兼容性：数据库版本、与 Python 版共用库的注意事项、升级是否动数据。',
  '反面例子：把「重构了 CDP 骨架」写进要点 —— 用户不关心，也没法感知。'
].join('\n')

const WD_REVIEW = [
  '架构评审材料：事务边界',
  '',
  '议题：哪些写入必须原子，哪些只需要顺序正确。',
  '结论一：跨表写入必须原子；同表多行删除本来原子，不必额外包事务。',
  '结论二：广播属于「顺序正确」问题 —— 它只需要保证在提交之后，不需要进事务。',
  '结论三：跨进程无法保证原子，所以渲染层的循环 IPC 必须改成单个批量通道。'
].join('\n')

const WD_LEARN = [
  '季度学习计划',
  '',
  '主线：把「本地优先应用的并发与一致性」搞扎实。',
  '一、SQLite 的 WAL、busy_timeout、事务隔离级别。',
  '二、Electron 主进程与渲染进程的职责边界与失败模型。',
  '三、把学到的东西落到这个项目的护栏里，而不是只写读书笔记。'
].join('\n')

const WD_HEALTH = [
  '体检报告摘要 2026',
  '',
  '结论：整体正常，两项需要跟踪。',
  '一、血脂偏高：先从饮食与作息改，三个月后复查。',
  '二、颈椎曲度变直：每小时起身一次，显示器抬到与视线平齐。',
  '下次复查：三个月后，记得提前一周预约。'
].join('\n')

const XL_WRITEPOINTS = [
  '多步写点盘点表（15 处）',
  '',
  '模块 | 写点 | 类别 | 是否已收口',
  '数据层 | batchDeleteTasks | A | 是',
  '数据层 | batchUndoLast | A | 是',
  '数据层 | syncTaskNoteLinks | C | 是',
  '数据层 | saveNote | C | 是',
  '数据层 | instantiateWorkflow | B | 是',
  '主进程 | startReminderDispatch | D | 是',
  '主进程 | runTaskSync | B | 是',
  '渲染层 | 批量移动 | D | 是'
].join('\n')

const XL_E2E = [
  'E2E 脚本健康度表',
  '',
  '脚本 | 断言数 | 状态 | 备注',
  'listguardcheck | 4 | 绿 | —',
  'noteeditguard | 5 | 绿 | 批处理里有资源竞争抖动',
  'notelinkcheck | 7 | 绿 | 掉链修复的回归验证',
  'attachmentcheck | 14 | 绿 | 附件落链与缩略图',
  'taskarchivecheck | 13 | 绿 | 导出 docx 的真实性',
  'reminderpolicycheck | 7 | 绿 | 提前量与记账'
].join('\n')

const XL_TIME = [
  '时间记录：本周深度工作时长',
  '',
  '周一 2.5h 数据层写点盘点',
  '周二 3.0h 事务收口与护栏',
  '周三 1.5h 提醒链路排查',
  '周四 3.5h CDP 骨架与迁移',
  '周五 2.0h 发版与回归',
  '合计 12.5h —— 低于目标的 15h，缺口在周三的排障上。'
].join('\n')

const XL_BOOKLIST = [
  '读书清单与进度',
  '',
  '卡片笔记写作法 | 读完 | 已出结论',
  '数据密集型应用系统设计 | 在读 40% | 重点看一致性与共识',
  'SQLite 权威指南 | 在读 25% | 配合 WAL 那章',
  '重构（第二版） | 未开始 | 排在收口之后',
  '程序员的职业素养 | 未开始 | —'
].join('\n')

const XL_EXPENSE = [
  '家庭订阅与开支盘点',
  '',
  '项目 | 周期 | 是否保留',
  '云备份 | 年 | 保留',
  '音乐订阅 | 月 | 保留',
  '网盘会员 | 年 | 降级',
  '两个已停用的开发工具 | 月 | 取消',
  '体检套餐 | 年 | 保留'
].join('\n')

const LK_WAL = ['SQLite WAL 官方说明', 'https://www.sqlite.org/wal.html',
  '并发读写的关键：WAL 允许多读者一写者；busy_timeout 必须设，否则并发写直接报错。']
const LK_BS3 = ['better-sqlite3 事务 API', 'https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md',
  '事务是同步的：把异步步骤放进 transaction 回调里，事务会提前结束，回滚也就无从谈起。']
const LK_ELECTRON = ['Electron 单实例锁与 userData', 'https://www.electronjs.org/docs/latest/api/app',
  'requestSingleInstanceLock 按 userData 区分：换一个 --user-data-dir 就能并行起第二个实例。']
const LK_VITEST = ['vitest 官方文档', 'https://vitest.dev/', '护栏测试与纯函数单测都用它，跑得够快才可能每次改动都跑。']
const LK_GH = ['GitHub Releases 资产上传', 'https://docs.github.com/en/rest/releases/assets',
  '发布脚本要逐条收集上传失败并在末尾非零退出，否则「资产没传上去」会被当成发版成功。']

const NOTES = [
  { key: 'adr', folder: 'adr', title: '架构决策：多步写一律进事务', format: 'markdown', content: MD_ADR, pinned: true },
  { key: 'baseline', folder: 'release', title: '端到端基线：哪些脚本还能跑', format: 'markdown', content: MD_BASELINE },
  { key: 'checklist', folder: 'release', title: '发布检查清单', format: 'markdown', content: MD_CHECKLIST },
  { key: 'meeting', folder: 'meeting', title: '周会纪要：2.0 收口范围', format: 'markdown', content: MD_MEETING },
  { key: 'book', folder: 'book2026', title: '《卡片笔记写作法》读书笔记', format: 'markdown', content: MD_BOOK },
  { key: 'req', folder: 'zx', title: '需求澄清：提醒策略的三个开关', format: 'richtext', content: RT_REQ },
  { key: 'weekly', folder: 'meeting', title: '本周复盘', format: 'richtext', content: RT_WEEKLY },
  { key: 'writepoints', folder: 'adr', title: '数据层写点盘点（速记）', format: 'richtext', content: RT_WRITEPOINTS },
  { key: 'render', folder: 'zx', title: '渲染层页面拆分草案', format: 'richtext', content: RT_RENDER },
  { key: 'bookclub', folder: 'book2026', title: '读书会分享提纲', format: 'richtext', content: RT_BOOKCLUB },
  { key: 'plan', folder: 'zx', title: '2.0 收口方案说明书', format: 'word', content: WD_PLAN },
  { key: 'reltemplate', folder: 'release', title: '对外发布说明模板', format: 'word', content: WD_RELTEMPLATE },
  { key: 'review', folder: 'adr', title: '架构评审材料：事务边界', format: 'word', content: WD_REVIEW },
  { key: 'learn', folder: 'study', title: '季度学习计划', format: 'word', content: WD_LEARN },
  { key: 'health', folder: 'health', title: '体检报告摘要 2026', format: 'word', content: WD_HEALTH },
  { key: 'xlwritepoints', folder: 'adr', title: '多步写点盘点表（15 处）', format: 'excel', content: XL_WRITEPOINTS },
  { key: 'xle2e', folder: 'release', title: 'E2E 脚本健康度表', format: 'excel', content: XL_E2E },
  { key: 'xltime', folder: 'meeting', title: '时间记录：本周深度工作时长', format: 'excel', content: XL_TIME },
  { key: 'xlbooks', folder: 'book2026', title: '读书清单与进度', format: 'excel', content: XL_BOOKLIST },
  { key: 'xlexpense', folder: 'health', title: '家庭订阅与开支盘点', format: 'excel', content: XL_EXPENSE },
  { key: 'lkwal', folder: 'tech', title: LK_WAL[0], format: 'link', content: LK_WAL[2], url: LK_WAL[1] },
  { key: 'lkbs3', folder: 'tech', title: LK_BS3[0], format: 'link', content: LK_BS3[2], url: LK_BS3[1] },
  { key: 'lkelectron', folder: 'tech', title: LK_ELECTRON[0], format: 'link', content: LK_ELECTRON[2], url: LK_ELECTRON[1] },
  { key: 'lkvitest', folder: 'tech', title: LK_VITEST[0], format: 'link', content: LK_VITEST[2], url: LK_VITEST[1] },
  { key: 'lkgh', folder: 'release', title: LK_GH[0], format: 'link', content: LK_GH[2], url: LK_GH[1] }
]

/** 笔记里的结构化属性（演示 props 字段）。 */
const NOTE_PROPS = {
  adr: { 类型: '架构决策', 状态: '已采纳' },
  book: { 来源: '书籍', 评分: '5', 作者: '申克·阿伦斯' },
  health: { 类型: '报告', 复查: '三个月后' },
  lkwal: { 类型: '参考资料', 主题: 'SQLite' },
  lkbs3: { 类型: '参考资料', 主题: 'SQLite' },
  lkelectron: { 类型: '参考资料', 主题: 'Electron' },
  lkvitest: { 类型: '参考资料', 主题: '测试' },
  lkgh: { 类型: '参考资料', 主题: '发布' }
}

/** 段落级关联：任务 ↔ 笔记里的某个块。 */
const NOTE_BLOCKS = [
  { task: '用事务包裹跨表写入', note: 'adr', block: '决策', snippet: '跨表写入一律用连接的事务包起来' },
  { task: '批量 IPC 通道与广播时机', note: 'adr', block: '决策-3', snippet: '渲染层禁止在循环里逐条调 IPC' },
  { task: '架构护栏与变异验证', note: 'baseline', block: '教训', snippet: '管道截断会把 node 打成 EPIPE' },
  { task: '抽出提醒策略纯函数', note: 'req', block: '二', snippet: '只有截止日期的默认关' },
  { task: '清单设置：改名与删除分开', note: 'render', block: '拆分原则', snippet: '两个动作必须是两个独立入口' }
]

export function buildSeed() {
  // 任务树：一级 5 条，每条 5 个二级，每个二级 5 个三级 —— 每层都是 5 条
  const tree = TREE.map((l1, i) => ({
    title: l1.title,
    status: l1.status,
    priority: l1.priority,
    tags: l1.tags,
    due: 14 + i * 7,
    children: l1.kids.map(([subject, kind], j) => ({
      title: subject,
      status: i === 3 && j < 2 ? 'doing' : 'todo',
      priority: j === 0 ? 3 : 2,
      tags: j === 0 ? ['深度工作'] : [],
      children: STEPS[kind].map((s, k) => ({
        title: subject + '：' + s,
        status: k < 3 && i === 0 ? 'done' : 'todo',
        priority: 1
      }))
    }))
  }))
  return { tree, inbox: INBOX, daily: DAILY, workflows: WORKFLOWS, flashes: FLASHES, noteFolders: NOTE_FOLDERS, notes: NOTES, noteProps: NOTE_PROPS, noteBlocks: NOTE_BLOCKS }
}
