/**
 * 图谱节点的配色与形状常量。
 *
 * 原先这些散在 `GraphPage.tsx` 里（`FOLDER_PALETTE` / `KIND_COLOR` / `colorOf` …），
 * 只有页面自己用。P1 换成 G6 之后**画布组件也要按同一套规则上色** ——
 * 如果两边各留一份，「同一张图里颜色对不上」会很难查，所以抽到这里。
 *
 * **抽出来之后页面也必须改用这里的那份** —— 否则「抽了但没接上」，
 * 两份还是各活各的（迁移收尾时发现过一次：页面仍留着自己那份，本模块只有
 * `NODE_R` 被画布引用）。现在页面 `import { KIND_CN, colorOf }`，
 * 其余（色板 / 缓存 / 分类色）都收成模块内部。
 *
 * 这些色值是**调色板数据**，不是主题令牌：文件夹色板要保证 12 个色位彼此可分辨，
 * 语义色（踩坑=警示、方法论=强调）才走 `var(--accent-*)` —— 后者跟着主题包变。
 */
import type { GraphNodePayload } from '@shared/types'

/** 文件夹色板（按首次出现的顺序分配，同一文件夹始终同色）。 */
const FOLDER_PALETTE = [
  '#0D9488', '#2563EB', '#7C3AED', '#DB2777', '#EA580C', '#16A34A',
  '#D97706', '#0891B2', '#4F46E5', '#65A30D', '#B45309', '#0EA5E9',
]
/** 根目录（未归类笔记）的颜色。 */
const ROOT_NOTE_COLOR = '#64748B'
/** 非笔记类节点的固定色。 */
const KIND_COLOR: Record<string, string> = {
  folder: '#7C3AED',
  task: '#16A34A',
  flash: '#EA580C',
  dangling: '#94A3B8',
  anchor: '#0891B2',
}

/** 六类节点的中文名。 */
export const KIND_CN: Record<string, string> = {
  note: '笔记',
  flash: '闪念',
  dangling: '待建链接',
  task: '任务',
  folder: '文件夹',
  anchor: '段落引用',
}

/**
 * 节点统一外接半径 —— **不随度数变化**。
 * 曾经用 `5 + size * 4.5`，同一个「笔记」在不同连接数下半径差出一倍，图上一眼就看出参差。
 * 度数改由标签字号与选中环表达。
 */
export const NODE_R = 9

/** hint → 颜色。同一个 hint 始终拿同一个色位（模块级缓存，跨次渲染稳定）。 */
const folderCache = new Map<string, string>()
function folderColor(hint: string): string {
  if (hint === 'root') return ROOT_NOTE_COLOR
  if (KIND_COLOR[hint]) return KIND_COLOR[hint]
  if (!folderCache.has(hint)) {
    folderCache.set(hint, FOLDER_PALETTE[folderCache.size % FOLDER_PALETTE.length])
  }
  return folderCache.get(hint)!
}

/**
 * 知识类型的色位。
 *
 * 只给知识区的几类独立颜色，且**刻意只分四档** —— 八种颜色挤在一张图上反而什么都看不出来。
 * 笔记 / 项目记录仍用文件夹色：对它们来说「属于哪个项目」比「它是什么类型」更有信息量。
 */
function knowledgeColor(sub: string | undefined): string | null {
  switch (sub) {
    case 'pitfall':
      return 'var(--danger)' // 踩坑：警示色，最该一眼认出来
    case 'method':
      return 'var(--accent)' // 方法论：能拿来做事的东西
    case 'concept':
    case 'summary':
    case 'synthesis':
      return 'var(--accent-warm)' // 三类资料型知识共用一个色位
    case 'output':
      return 'var(--accent-text)'
    default:
      return null // note / project 走文件夹色
  }
}

/** 节点的最终主色 —— 画布与侧栏共用这一个入口。 */
export function colorOf(n: GraphNodePayload): string {
  return n.kind === 'note'
    ? (knowledgeColor(n.subKind) ?? folderColor(n.colorHint))
    : (KIND_COLOR[n.kind] ?? ROOT_NOTE_COLOR)
}
