import { ChevronRight, FileText, FolderPlus, Plus, SquareCheck, X } from '@renderer/lib/icons'
import type { Backlink, Note, NoteFolder, NoteLink } from '@shared/types'

/**
 * 信息区：属性 / 反向链接 / 正向引用 / 归属 四栏。
 *
 * 从 NotesPage 抽出（那个文件 2510 行）。这块是页面里最闭合的一段 JSX ——
 * 自己没有状态（展开与否由外部给），输入是数据与回调，输出全是回调。
 *
 * **props 多（24 个）是现状的如实反映**：这些状态全在 NotesPage 顶层，
 * 任何一块 JSX 都无法独立。抽出来的价值在于信息区从此有了明确的输入契约 ——
 * 下一步该做的是把其中成组的状态收进 hook（属性一组、链接一组），
 * 那时 props 会自然降到四五个。
 */
interface Props {
  expanded: boolean
  onToggleExpanded: () => void
  propItems: { key: string; value: string }[]
  propCount: number
  propNew: string
  onPropNewChange: (v: string) => void
  onAddProp: () => void
  onRemoveProp: (key: string) => void
  backlinks: Backlink[]
  outLinks: NoteLink[]
  attachedTasks: { id: number; title: string }[]
  current: Note
  folders: NoteFolder[]
  onSelectNote: (id: number) => void
  onCreateFromLink: (title: string) => void
  onRemoveBacklink: (b: Backlink) => void
  onRemoveOutLink: (l: NoteLink) => void
  onRevealFolder: (id: number) => void
  onMoveNoteToFolder: (folderId: number | null) => void
  onOpenTask: (id: number) => void
  onDetachTask: (taskId: number) => void
  onOpenTaskPick: (x: number, y: number) => void
  onOpenMoveMenu: (x: number, y: number) => void
  onPickLinkNote: (anchor: DOMRect) => void
}

export function NoteLinksPanel({
  expanded,
  onToggleExpanded,
  propItems,
  propCount,
  propNew,
  onPropNewChange,
  onAddProp,
  onRemoveProp,
  backlinks,
  outLinks,
  attachedTasks,
  current,
  folders,
  onSelectNote,
  onCreateFromLink,
  onRemoveBacklink,
  onRemoveOutLink,
  onRevealFolder,
  onMoveNoteToFolder,
  onOpenTask,
  onDetachTask,
  onOpenTaskPick,
  onOpenMoveMenu,
  onPickLinkNote,
}: Props) {
  return (
    <>
  <aside
    className={'links' + (expanded ? ' links--open' : ' links--collapsed')}
    aria-label="链接面板"
  >
  {/*
    收起态只有这一行：信息区默认收起，正文才能拿到最大高度。

    **整条都可点**，而不是只有左边那个「信息」按钮 —— 它本来就是一条通栏的
    信息头，把可点区域限制在一小段文字上，用户得瞄准。
    「隐藏」按钮也去掉了：它和"收起"是同一件事的两种说法，
    收起本来就等价于隐藏，多一个按钮只会让人犹豫该点哪个。
  */}
  <div
    className="links__bar"
    role="button"
    tabIndex={0}
    aria-expanded={expanded}
    title={expanded ? '收起信息区' : '展开属性 / 反向链接 / 引用 / 归属'}
    onClick={() => onToggleExpanded()}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onToggleExpanded()
      }
    }}
  >
    <span className="links__toggle">
      <ChevronRight size={13} className={'links__caret' + (expanded ? ' links__caret--open' : '')} />
      信息
    </span>
    {/* 统计只在收起态显示 —— 展开后每栏标题上已经各有一个数字，
        再在顶上重复一遍是多余的（用户指出的） */}
    {!expanded && (
      <span className="links__counts">
        属性 {propCount} · 反链 {backlinks.length} · 引用 {outLinks.length} · 归属{' '}
        {attachedTasks.length + (current.folder_id ? 1 : 0)}
      </span>
    )}
    <span className="links__spacer" />
  </div>
  {/* 退场期间正文也要留着：否则抽屉还挂在屏幕上、里面却已经空了 */}
  {expanded && (
  <div className="links__body">
  {/*
    四栏并排：属性 / 反向链接 / 正向引用 / 归属。

    每栏内部是「胶囊列表（自己滚）+ 底部新增行 + 底部提示行」的三段结构，
    信息区高度固定 —— 它不该因为某栏内容变多就把正文挤上去，
    那样每加一条引用正文都会跳一下。

    胶囊承载跳转（点胶囊本体），删除图标居右（点它只删不跳）。
  */}
  <section className="links__col">
    <header className="links__head" title="每行一条，形如「来源: 书籍」">
      属性 · {propItems.length}
    </header>
    <div className="links__items">
      {propItems.length === 0 ? (
        <p className="links__empty">还没有属性</p>
      ) : (
        propItems.map((p) => (
          <span key={p.key} className="links__pill" title={p.key + ": " + p.value}>
            <span className="links__pill-text">
              <b>{p.key}</b>
              {p.value ? " " + p.value : ""}
            </span>
            <button
              type="button"
              className="links__pill-del"
              aria-label={"删除属性 " + p.key}
              title="删除"
              onClick={() => onRemoveProp(p.key)}
            >
              <X size={11} />
            </button>
          </span>
        ))
      )}
    </div>
    <div className="links__foot">
      <div className="links__add">
        <input
          className="field links__add-input"
          value={propNew}
          aria-label="新增属性"
          placeholder="键: 值"
          onChange={(e) => onPropNewChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              onAddProp()
            }
          }}
        />
        <button
          type="button"
          className="links__add-btn"
          aria-label="添加属性"
          title="添加"
          disabled={!propNew.trim()}
          onClick={onAddProp}
        >
          <Plus size={13} />
        </button>
      </div>

    </div>
  </section>

  <section className="links__col">
    <header
      className="links__head"
      title="别人引用这篇时自动出现；删除会改对方那篇的正文"
    >
      反向链接 · {backlinks.length + attachedTasks.length}
    </header>
    <div className="links__items">
      {/* 空状态只在**两种引用都没有**时出现 —— 原来只判 backlinks，
          于是任务引用了它的时候，下面明明躺着任务胶囊，上面还说"还没有引用" */}
      {backlinks.length === 0 && attachedTasks.length === 0 ? (
        <p className="links__empty">还没有笔记或任务引用它</p>
      ) : (
        backlinks.map((b) => (
          <span key={b.src_note_id} className="links__pill">
            <button
              type="button"
              className="links__pill-text"
              title={b.snippet || b.src_title}
              onClick={() => void onSelectNote(b.src_note_id)}
            >
              {/* 笔记与任务混在同一栏，靠图标区分 */}
              <FileText size={11} aria-hidden />
              <b>{b.src_title}</b>
            </button>
            <button
              type="button"
              className="links__pill-del"
              aria-label={"删除反向链接 " + b.src_title}
              title="从对方正文里删掉这条链接"
              onClick={() => void onRemoveBacklink(b)}
            >
              <X size={11} />
            </button>
          </span>
        ))
      )}
      {/*
        引用了这篇的**任务**。
        任务对笔记的关联本质是引用 —— 任务备注里写着 [[这偏的标题]]，
        改名时的修复逻辑（note-assoc.ts）就是照着这条在跑。
        原先它被摆在「归属」栏，与"属于哪个文件夹"混为一谈。
      */}
      {attachedTasks.map((task) => (
        <span key={task.id} className="links__pill">
          <button
            type="button"
            className="links__pill-text"
            title="打开这个任务"
            onClick={() => onOpenTask(task.id)}
          >
            <SquareCheck size={11} aria-hidden />
            <b>{task.title}</b>
          </button>
          <button
            type="button"
            className="links__pill-del"
            aria-label={"解除关联 " + task.title}
            title="解除关联"
            onClick={() => onDetachTask(task.id)}
          >
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
    <div className="links__foot">
      <div className="links__add">
        <button
          type="button"
          className="links__add-btn links__add-btn--wide"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            void onOpenTaskPick(r.left, r.bottom + 4)
          }}
        >
          <Plus size={13} /> 关联到任务…
        </button>
      </div>
    </div>
  </section>

  <section className="links__col">
    <header className="links__head" title="正文里的 [[链接]] 会自动出现在这里">
      正向引用 · {outLinks.length}
    </header>
    <div className="links__items">
      {outLinks.length === 0 ? (
        <p className="links__empty">正文里还没有 [[链接]]</p>
      ) : (
        outLinks.map((l) => (
          <span
            key={l.id}
            className={"links__pill" + (l.dst_note_id == null ? " links__pill--dangling" : "")}
          >
            <button
              type="button"
              className="links__pill-text"
              title={l.dst_note_id == null ? "目标还不存在，点击创建并绑定" : "打开这篇笔记"}
              onClick={() =>
                l.dst_note_id != null
                  ? void onSelectNote(l.dst_note_id)
                  : void onCreateFromLink(l.dst_title)
              }
            >
              <FileText size={11} aria-hidden />
              <b>{l.dst_title}</b>
            </button>
            <button
              type="button"
              className="links__pill-del"
              aria-label={"删除引用 " + l.dst_title}
              title="从正文里删掉这行引用"
              onClick={() => onRemoveOutLink(l)}
            >
              <X size={11} />
            </button>
          </span>
        ))
      )}
    </div>
    <div className="links__foot">
      {/*
        正向引用改用笔记选择器而不是输入框 —— 引用要选的是「已经存在的
        那一篇」，凭记忆敲标题既不精确、也容易建出重复笔记。选择器带
        文件夹层级与类型图标，与任务项编辑框里关联笔记用的是同一个组件、
        同一套摆放规则（placeAnchored：下方放不下翻上方、右侧放不下往左收，
        实测能保证完整落在视口内）。
      */}
      <button
        type="button"
        className="links__add-btn links__add-btn--wide"
        onClick={(e) => {
          onPickLinkNote((e.currentTarget as HTMLElement).getBoundingClientRect())
        }}
      >
        <Plus size={13} /> 选择笔记…
      </button>

    </div>
  </section>

  <section className="links__col">
    <header className="links__head">
      归属 · {current.folder_id ? 1 : 0}
    </header>
    <div className="links__items">
      {!current.folder_id && (
        <p className="links__empty">未归入任何文件夹</p>
      )}
      {current.folder_id ? (
        <span className="links__pill">
          <button
            type="button"
            className="links__pill-text"
            title="在笔记树里定位这个文件夹"
            onClick={() => onRevealFolder(current.folder_id as number)}
          >
            <FolderPlus size={11} />
            <b>{folders.find((f) => f.id === current.folder_id)?.name ?? "未知"}</b>
          </button>
          <button
            type="button"
            className="links__pill-del"
            aria-label="移出文件夹"
            title="移出文件夹"
            onClick={() => onMoveNoteToFolder(null)}
          >
            <X size={11} />
          </button>
        </span>
      ) : null}
    </div>
    <div className="links__foot">
      {/*
        归属栏只做一件事：把这篇放进某个文件夹/分类。
        「关联到任务」挪去反向链接栏 —— 那是引用关系，不是容器关系
        （见 docs/specs/ownership-vs-reference.md）。
      */}
      <div className="links__add">
        <button
          type="button"
          className="links__add-btn links__add-btn--wide"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            onOpenMoveMenu(r.left, r.bottom + 4)
          }}
        >
          <FolderPlus size={13} /> 移动到文件夹…
        </button>
      </div>
    </div>
  </section>
  </div>
  )}
            </aside>
    </>
  )
}
