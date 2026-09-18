# 图谱重构 · 需求契约与拓扑约束方案（researcher · t1 产出）

> 生成：graph-redesign 团队 · 需求轮（round 1）
> 调研范围：`zhixing/model/application/graph_service.py`、`zhixing/view/pages/graph_page.py`、`zhixing/core/event_bus.py`、`zhixing/model/infrastructure/models.py`、`zhixing/model/infrastructure/repositories.py`、`zhixing/model/domain/entities.py`、`zhixing/model/application/{note,task,flash}_service.py`、`zhixing/controller/app_controller.py`。
> 性质：需求契约 + 拓扑约束方案，**不含实现代码**。下游实现/验证/审查据此进行。

---

## 1. 现状盘点（调研结论）

### 1.1 节点标识空间（GraphService 常量，用于稳定身份与防冲突）

| 类型 | kind | 节点 id 计算 | 底层主键 ref_id | 备注 |
| --- | --- | --- | --- | --- |
| 笔记 | note | `id = note 主键`（正整数） | ref_id = note.id | 与主键同空间 |
| 任务 | task | `id = task_id + 5_000_000` | ref_id = task.id | 高位正空间 F3-7 |
| 文件夹 | folder | `id = -folder_id - 2_000_000` | ref_id = folder.id | 负空间 |
| 闪念 | flash | `id = -flash_id - 1_000_000` | ref_id = flash.id | 负空间 |
| 待建链接 | dangling | `-1 递减`（全图）/ `-link_id - 100_000`（邻域） | ref_id = 0 | 虚线空心节点 |

> 待决点 D1：dangling 是当前第 5 类节点（note_link.dst_note_id=NULL 的悬空引用）。需求正文只提“四类节点”，需决定 dangling 视觉归属——建议保留为“引用类特殊节点”（空心虚线），不并入四类，也不参与归属 DAG。

### 1.2 现状边（已实现，但语义/视觉未区分两类）

- `folder -> folder`（层级，folder_child 实线紫）
- `folder -> note`（包含，folder_note 点线灰）
- `note -> note`（引用，note_link 实线灰；双向引用渲染成两条反向弧）
- `task -> note`（任务关联，当前被 `_edge_kind` 归为 note_link 样式，**无独立视觉**）
- 当前**没有** `task -> task`（子任务层级未入图）、**没有** 文件夹↔任务边。

### 1.3 现状刷新（关键缺口）

- `GraphPage` **未订阅 EventBus**，只在以下时机整体 `reload()`（全量 `scene().clear()` + 重建 + 重新布点）：首次 showEvent、筛选 combo 变化、主题切换、`_link_notes` 成功后。
- EventBus 已具备细粒度事件（见 §4），但图谱未消费。**这是“增量局部刷新”的主要改造点。**

### 1.4 现状拖拽连线

- 仅 `note->note`（`_finish_link` 硬性要求两端 kind == "note"），释放后 `linkRequested` -> `AppController._link_notes` -> `graph_service.link_notes` -> `note_links_changed` -> `graph_page.reload()`（全量）。
- 约束现状：自环拒绝、非正 id 拒绝、幂等（已连/反向已连不重复建行）、悬空补全。

---

## 2. 节点视觉语义契约（四类 + 待建）

| 类型 | 形状 | 颜色语义 | 交互 |
| --- | --- | --- | --- |
| 文件夹 folder | **文件夹形**（文件夹轮廓/矩形+标签页，可保留 FolderItem 矩形并加文件夹图标语义） | 紫色系（稳定色 `#7C3AED`） | 双击定位到笔记库该文件夹 |
| 笔记 note | **书本形**（书页/矩形书本轮廓，非圆形） | **按所属文件夹着色**（复用 `_FOLDER_PALETTE`）；**根目录笔记（folder_id 为 None）用独立区分色**（当前 folder_id=None 被映射为 0，与文件夹 0 共用首色，需改为专属根色，如中性灰/描边强调） | 双击打开笔记；大小随 degree（链接数）缩放 |
| 任务 task | **五角星形**（star polygon） | 绿色系（稳定色 `#16A34A`） | 双击打开任务 |
| 闪念 flash | **闪电形**（lightning bolt polygon） | 橙色系（稳定色 `#EA580C`） | 双击跳转收件箱该闪念；无连线（孤立节点） |
| 待建 dangling | 空心 + 虚线描边（保持现状，形状可同笔记但空心） | 中性灰 | 双击新建笔记 |

> 视觉语义改造点：`NodeItem` 现为 `QGraphicsEllipseItem`（圆），需按 kind 切换为不同 QGraphicsPathItem 形状（folder/book/star/bolt）；`color_hint` 语义保持 folder_id，但根目录（None）需独立色。

---

## 3. 边拓扑规则（两类边 + 连接矩阵）

### 3.1 两类边

| 类 | 视觉 | 底层数据 | 有向性 | 环路约束 |
| --- | --- | --- | --- | --- |
| 归属 OWNERSHIP | **实线** | note_folder.parent_id、note.folder_id、task_note_link、task.parent_id | **有向 DAG** | **必须无环**（§5） |
| 引用 REFERENCE | **虚线** | note_link（src_note_id -> dst_note_id） | 语义无向、存储有向 | **允许成环**（知识网络天然有环，不检测） |

### 3.2 归属边（实线，DAG）明细

| 边 | 方向 | 数据来源 |
| --- | --- | --- |
| folder -> folder | 父->子 | note_folder.parent_id |
| folder -> note | 容器->内容 | note.folder_id |
| task -> note | 任务->关联笔记 | task_note_link |
| task -> task（**待决 D2**） | 父->子 | task.parent_id（当前未入图） |

> 待决点 D2：是否把任务子任务层级（task.parent_id）纳入归属 DAG。建议**纳入**（归属语义一致、可拖拽改写），若纳入则 §5 环路检测需覆盖任务父子链。

### 3.3 引用边（虚线）明细与约束

- 仅 `note <-> note`（note_link，dst 已解析）。
- `note -> dangling`（dst=NULL）作为“待建链接”保留，视觉为引用类虚线。
- **禁止**：
  1. 文件夹 ↔ 任务（任何方向、任何边类都禁止连边）；
  2. 任务 ↔ 任务 引用（任务不引用任务，任务只“归属”笔记）；
  3. 文件夹 ↔ 文件夹 引用（层级是归属不是引用）；
  4. 闪念 ↔ 任意 引用/归属（闪念孤立）；
  5. 自环（src == dst）。

### 3.4 允许连接矩阵（src -> dst）

| src \ dst | note | folder | task | flash | dangling |
| --- | --- | --- | --- | --- | --- |
| note | 引用(虚线,双向) | — | — | — | 引用-待建(虚线) |
| folder | 归属(实线) | 归属(实线) | — | — | — |
| task | 归属(实线) | — | 归属(实线,D2 可选) | — | — |
| flash | — | — | — | — | — |
| dangling | — | — | — | — | — |

> “—” 表示禁止。归属方向固定（folder/task 为 owner，note 为被归属方）；note->note 引用按无向渲染（双向引用两条反向弧，避免重叠）。

---

## 4. 观察者模式 · 增量刷新策略

### 4.1 观察者接线

`GraphPage`（或其宿主）订阅 EventBus 信号，把“什么变了”映射为“最小受影响子图”，**避免 `scene().clear()` 全量重建与全量重新布点**。关键原则：

- 保留 `self.nodes`、`self.edges`、`_vel`（动量）、节点 pinned 状态与坐标；增量更新**不重置布局**。
- 新增节点采用“就近初始位置”（新引用边节点放在被连节点邻域；新文件夹/任务按归属就近），随后可让力导向自然散开。
- 突发/连带事件用 QTimer single-shot（约 100–150ms）合并防抖，避免同一操作触发多次重建（如 `flash_changed`+`tag_changed`、`task_changed`+`task_structure_changed` 连续发射）。

### 4.2 事件 -> 局部更新映射（契约）

| 事件（签名） | 局部更新动作 |
| --- | --- |
| `note_changed(nid, reason)` | 仅该节点：重查 note -> 更新 label(title)、color(folder_id)、tooltip；若 folder_id 变化 -> 摘除旧 folder->note 边、挂新 folder->note 边。reason=updated/restored/appended 时适用；节点不在当前图（被过滤）则 no-op。 |
| `note_structure_changed()` | 节点集合变化（新建/删除/恢复笔记、文件夹 CRUD）。**信号无 id**：① 推荐扩展为带 `note_id/folder_id/op` 载荷后做定点增删；② 降级方案=防抖后的“结构重建”（重建节点与归属边、**保留可匹配节点的坐标**，不重置布局）。 |
| `note_links_changed(nid)` | **最高价值增量**：重查 nid 的 out_links/backlinks -> 与当前引用边集 diff -> 仅增删 nid 关联的引用 EdgeItem，其余节点/边/布局不动。 |
| `task_changed(tid, reason)` | created->新增 task 节点+task->note 边；updated->更新 label(title)/样式；completed->更新完成态视觉（划线/置灰，kind 不变）；deleted->移除节点及其 task->note 边。 |
| `task_structure_changed()` | 任务树/列表结构变化 -> 只重建 task 节点与 task->note 边子图（保留 note/folder 布局）。信号无 id，可同样考虑扩展载荷。 |
| `flash_changed()` | 闪念集合变化。信号无 id：推荐扩展为 `flash_changed(fid, reason)` 后定点增删（闪念孤立，增删成本极低）；降级=防抖重建闪念节点。 |
| `theme_changed()` | **仅 restyle**（重刷形状/颜色），不重建、不重排。 |
| `backup_restored()` | 全量 reload（低频，可接受）。 |

### 4.3 需扩展的事件载荷（契约建议）

为支持真正的“事件->局部更新”，建议 EventBus 增补/细化（不改既有订阅方语义，仅新增或加参数）：

- `note_structure_changed(note_id, op)`（op ∈ created/deleted/restored/folder_created/folder_deleted/folder_renamed）
- `flash_changed(flash_id, reason)`（reason ∈ added/updated/archived/deleted/restored/converted）
- 复用现有 `task_changed`、`note_changed`、`note_links_changed`（已带 id，够用）。

> 若保持信号无载荷不变，则结构类事件只能“防抖全量/半量重建”，无法严格满足“避免全图重绘”；载荷扩展是达成该验收项的前提，请 captain 决策（D3）。

---

## 5. 归属边 DAG 环路检测算法（契约）

归属子图的无环约束只可能被**自引用父子链**破坏：

- `folder.parent_id` 链（folder->folder）
- `task.parent_id` 链（task->task，若 D2 纳入）

`folder->note`、`task->note` 单向、note 无归属出边，**不可能成环**，无需检测。

### 5.1 离线全图校验（构建/导入时）

对归属边集合做 **DFS 三色标记（白/灰/黑）**：访问中节点（灰）再次被指向 -> 检测到环，标记该节点为“疑似坏数据”，入图时**断开环上的边**（渲染层不画该条边）并提示，避免整图失败。

等价实现可选用 Kahn 拓扑排序：迭代删去入度 0 节点；结束时仍有入度 >0 的节点即处于环上，其入边即违规边。

### 5.2 增量校验（拖拽改写提交前，O(深度)）

把节点 X 改挂到新父 P 之前，执行**祖先链回溯**：

- 从 P 沿 parent_id 逐级向上，若途中命中 X -> 该改挂会成环 -> **拒绝**（不写库、Toast 提示“不能挂到自己的子孙下”）。
- folder 改挂同理（若支持 folder 拖拽）；`task->note`、`folder->note` 无需此检查。

> 增量校验优先于全图 DFS：拖拽是单点、高频操作，祖先链 O(depth) 足够；全图 DFS 仅用于构建期防御坏数据。

---

## 6. 引用边约束（契约）

- 引用边只允许 **note<->note**（含 note->dangling 待建）。
- **排除文件夹节点**、**任务之间无引用**、**文件夹↔任务无引用**（§3.3）。
- 引用边不参与 DAG 环路检测（知识网络允许双向、允许环）。
- 语义无向：渲染层对“A↔B 都存在”的双向引用画两条反向弧；底层 `note_link` 仍按有向行存储（`uq_src_dst_title` 唯一约束）。
- 自环禁止（`link_notes` 已拒绝 src==dst，拖拽层同样拒绝）。

---

## 7. 拖拽改写拓扑流程与约束检查（契约）

### 7.1 拖拽语义（按连接矩阵）

| 拖拽端点 | 动作 | 底层写入 |
| --- | --- | --- |
| note -> note | 建引用（虚线） | `graph_service.link_notes(src,dst)`（幂等/悬空补全，已存在） |
| task -> note 或 note -> task | 建归属（实线，方向归一为 task->note） | `task_service.attach_note(task_id, note_id)`（幂等，已存在） |
| folder -> note | 改归属（note 移入文件夹） | `note_service.save(note_id, folder_id=...)`（已存在，触发 note_changed） |
| folder -> folder / task -> task | 改层级（reparent） | task：`task_service.reparent`（已存在）；folder：**缺 move_folder 方法（缺口 G1）** |
| 含 folder↔task、task↔task 引用、flash/dangling 端点 | **拒绝** | — |

### 7.2 释放前约束检查顺序

1. 端点 kind 命中连接矩阵，否则拒绝（如 folder↔task、task↔task、flash 端点）。
2. 自环拒绝（src id == dst id）。
3. 归属类改挂：执行 §5.2 祖先链回溯，成环则拒绝。
4. 幂等/去重交给服务层唯一约束（uq_src_dst_title / uq_task_note）。
5. 通过 -> 调用对应 Service 写入。

### 7.3 成功/失败反馈与刷新

- 成功：Service 内部已发射领域事件（`note_links_changed` / `task_changed` / `note_changed`）-> 观察者按 §4.2 局部更新（**去掉 `_link_notes` 里的 `graph_page.reload()` 全量重刷**），并 Toast。
- 失败：Toast 具体原因（“不能挂到自己的子孙下”“文件夹与任务之间不能连线”等），**不写库、不刷新**。

---

## 8. 差距与待决项（供 captain 决策）

| 编号 | 内容 | 影响 |
| --- | --- | --- |
| G1 | NoteService 无 folder 移动/reparent 方法（仅 create/rename/delete_folder），拖拽改 folder 层级无法落地 | 决定 folder 拖拽是否在本轮范围内 |
| G2 | `flash_changed` / `note_structure_changed` / `task_structure_changed` 无 id 载荷 | 制约“事件->局部更新”，需扩载荷（D3）或降级为防抖重建 |
| G3 | task->subtask 层级未入图（task.parent_id 存在但 graph 不渲染） | 归属 DAG 是否含任务树（D2） |
| G4 | 闪念 build 查询不过滤 status（converted/archived 闪念仍入图） | 是否只显示 inbox 闪念 |
| G5 | 节点 id 空间靠魔法常量（1M/2M/5M/100K 偏移） | 建议常量收敛为一处文档，避免将来越界 |
| G6 | 根目录笔记（folder_id=None）当前与 folder 0 共色 | 需独立根色（本需求已要求，实现时确认 palette 增项） |
| D1 | dangling 第 5 类节点视觉归属 | 建议保留空心虚线、归引用类 |
| D2 | 任务父子层级是否纳入归属 DAG | 决定环路检测范围与拖拽矩阵 task->task |
| D3 | 是否扩展事件载荷 vs 保持信号签名、防抖重建 | 直接决定“避免全图重绘”验收能否严格达成 |

---

## 9. 验收标准对照（本任务 acceptance 逐条映射）

1. **节点/边拓扑规则清单（四类节点、两类边、允许连接矩阵）** -> §2（四类+待建视觉）、§3.2/§3.3/§3.4（两类边+连接矩阵）。
2. **归属边 DAG 环路检测算法** -> §5.1（DFS 三色/Kahn 离线）+ §5.2（祖先链增量）。
3. **引用边约束（排除文件夹、任务间无引用）** -> §3.3、§6。
4. **增量刷新策略（事件->局部更新，避免全图重绘）** -> §4.1/§4.2/§4.3（观察者接线 + 事件映射 + 载荷扩展）。
5. **拖拽改写约束检查与底层数据改写流程** -> §7.1/§7.2/§7.3（矩阵 + 检查顺序 + 服务写入 + 刷新反馈）。
