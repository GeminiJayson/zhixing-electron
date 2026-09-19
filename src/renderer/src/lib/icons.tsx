import type { ReactElement } from 'react'
import { MorphIcon, type MorphIconProps, type ReducedMotionMode } from 'morphicons/react'
import type { IconNode } from 'morphicons'
import {
  AppWindow as NAppWindow,
  Archive as NArchive,
  ArchiveRestore as NArchiveRestore,
  ArrowDown as NArrowDown,
  ArrowLeft as NArrowLeft,
  ArrowUp as NArrowUp,
  Award as NAward,
  Bell as NBell,
  CalendarCheck as NCalendarCheck,
  CalendarClock as NCalendarClock,
  Check as NCheck,
  CheckCircle2 as NCheckCircle2,
  ChevronDown as NChevronDown,
  ChevronLeft as NChevronLeft,
  ChevronRight as NChevronRight,
  CircleAlert as NCircleAlert,
  CircleUser as NCircleUser,
  ClipboardList as NClipboardList,
  Copy as NCopy,
  Database as NDatabase,
  Diamond as NDiamond,
  Download as NDownload,
  Eye as NEye,
  FilePlus2 as NFilePlus2,
  FileText as NFileText,
  FolderInput as NFolderInput,
  FolderPlus as NFolderPlus,
  FolderTree as NFolderTree,
  GitBranch as NGitBranch,
  Hash as NHash,
  Inbox as NInbox,
  Info as NInfo,
  LayoutGrid as NLayoutGrid,
  Link2 as NLink2,
  List as NList,
  ListPlus as NListPlus,
  Maximize2 as NMaximize2,
  Moon as NMoon,
  MoreHorizontal as NMoreHorizontal,
  NotebookPen as NNotebookPen,
  Palette as NPalette,
  PanelLeftClose as NPanelLeftClose,
  PanelLeftOpen as NPanelLeftOpen,
  Pause as NPause,
  Pencil as NPencil,
  Pin as NPin,
  Play as NPlay,
  Plus as NPlus,
  RefreshCw as NRefreshCw,
  RotateCcw as NRotateCcw,
  Search as NSearch,
  SlidersHorizontal as NSlidersHorizontal,
  Sparkles as NSparkles,
  Square as NSquare,
  SquareCheck as NSquareCheck,
  Sun as NSun,
  Tag as NTag,
  TerminalSquare as NTerminalSquare,
  Timer as NTimer,
  Trash2 as NTrash2,
  Undo2 as NUndo2,
  UserPlus as NUserPlus,
  Waypoints as NWaypoints,
  X as NX,
} from 'lucide'

/**
 * 应用图标统一入口：**形状数据来自 lucide（数据包），渲染与形变交给 morphicons**。
 *
 * 为什么要这一层：
 * 1. lucide 主入口导出的是 [svg, attrs, children] 包装，而 morphicons 的输入契约是
 *    [tag, attrs][] 且只认 path / line / circle / ellipse / rect / polyline / polygon ——
 *    直接传会报 'morphicons: unsupported tag <svg>'（实测）。这里统一解包成 IconNode。
 * 2. 导出与 lucide-react **同签名**的组件，业务代码只换 import 源、不必改用法。
 * 3. 统一注入动效策略：应用关掉动效（html[data-motion='none']）时直接切换，否则跟随系统的
 *    「减少动态效果」。morphicons 默认是 never（无视系统设置），这里不用它的默认值。
 *
 * 想让图标在「同一位置换图标」时平滑形变，用 <Morph icon={IconData.A} /> 换成
 * icon={IconData.B}；受控形变用 <Morph from={..} to={..} progress={..} />。
 *
 * 本文件由 npm run gen:icons（scripts/gen-icons.mjs）生成，请勿手改图标清单。
 */

/** lucide 的图标是 [svg, attrs, children]；morphicons 要的是 children 那层（不解包会抛错） */
const unpack = (icon: unknown): IconNode => (icon as unknown[])[2] as IconNode

/** 动效策略：应用关闭动效 → 直接切换；否则尊重系统的「减少动态效果」 */
export const motionPolicy = (): ReducedMotionMode =>
  typeof document !== 'undefined' && document.documentElement.dataset.motion === 'none'
    ? 'always'
    : 'user'

/** 与 lucide-react 同签名（size / strokeWidth / absoluteStrokeWidth / color / className 直通 svg） */
export type LucideIcon = (props: MorphIconProps) => ReactElement

const make = (data: unknown): LucideIcon => {
  const node = unpack(data)
  return function Icon(props: MorphIconProps): ReactElement {
    return <MorphIcon icon={node} reducedMotion={motionPolicy()} {...props} />
  }
}

/**
 * 形变图标：同一位置换 icon 就带弹簧飞过去；也支持 from / to / progress 受控形变。
 * 用法同 MorphIcon，只是已按本应用的动效策略配置好。
 */
export function Morph(props: MorphIconProps): ReactElement {
  return <MorphIcon reducedMotion={motionPolicy()} {...props} />
}

/** 已解包的形状数据：形变的两端从这里取，不要再用 lucide 的原始导出 */
export const IconData = {
  AppWindow: unpack(NAppWindow),
  Archive: unpack(NArchive),
  ArchiveRestore: unpack(NArchiveRestore),
  ArrowDown: unpack(NArrowDown),
  ArrowLeft: unpack(NArrowLeft),
  ArrowUp: unpack(NArrowUp),
  Award: unpack(NAward),
  Bell: unpack(NBell),
  CalendarCheck: unpack(NCalendarCheck),
  CalendarClock: unpack(NCalendarClock),
  Check: unpack(NCheck),
  CheckCircle2: unpack(NCheckCircle2),
  ChevronDown: unpack(NChevronDown),
  ChevronLeft: unpack(NChevronLeft),
  ChevronRight: unpack(NChevronRight),
  CircleAlert: unpack(NCircleAlert),
  CircleUser: unpack(NCircleUser),
  ClipboardList: unpack(NClipboardList),
  Copy: unpack(NCopy),
  Database: unpack(NDatabase),
  Diamond: unpack(NDiamond),
  Download: unpack(NDownload),
  Eye: unpack(NEye),
  FilePlus2: unpack(NFilePlus2),
  FileText: unpack(NFileText),
  FolderInput: unpack(NFolderInput),
  FolderPlus: unpack(NFolderPlus),
  FolderTree: unpack(NFolderTree),
  GitBranch: unpack(NGitBranch),
  Hash: unpack(NHash),
  Inbox: unpack(NInbox),
  Info: unpack(NInfo),
  LayoutGrid: unpack(NLayoutGrid),
  Link2: unpack(NLink2),
  List: unpack(NList),
  ListPlus: unpack(NListPlus),
  Maximize2: unpack(NMaximize2),
  Moon: unpack(NMoon),
  MoreHorizontal: unpack(NMoreHorizontal),
  NotebookPen: unpack(NNotebookPen),
  Palette: unpack(NPalette),
  PanelLeftClose: unpack(NPanelLeftClose),
  PanelLeftOpen: unpack(NPanelLeftOpen),
  Pause: unpack(NPause),
  Pencil: unpack(NPencil),
  Pin: unpack(NPin),
  Play: unpack(NPlay),
  Plus: unpack(NPlus),
  RefreshCw: unpack(NRefreshCw),
  RotateCcw: unpack(NRotateCcw),
  Search: unpack(NSearch),
  SlidersHorizontal: unpack(NSlidersHorizontal),
  Sparkles: unpack(NSparkles),
  Square: unpack(NSquare),
  SquareCheck: unpack(NSquareCheck),
  Sun: unpack(NSun),
  Tag: unpack(NTag),
  TerminalSquare: unpack(NTerminalSquare),
  Timer: unpack(NTimer),
  Trash2: unpack(NTrash2),
  Undo2: unpack(NUndo2),
  UserPlus: unpack(NUserPlus),
  Waypoints: unpack(NWaypoints),
  X: unpack(NX),
} satisfies Record<string, IconNode>

export { MorphIcon }
export type { MorphIconProps, MorphHandle, ReducedMotionMode } from 'morphicons/react'
export type { IconInput, IconNode } from 'morphicons'

export const AppWindow = make(NAppWindow)
export const Archive = make(NArchive)
export const ArchiveRestore = make(NArchiveRestore)
export const ArrowDown = make(NArrowDown)
export const ArrowLeft = make(NArrowLeft)
export const ArrowUp = make(NArrowUp)
export const Award = make(NAward)
export const Bell = make(NBell)
export const CalendarCheck = make(NCalendarCheck)
export const CalendarClock = make(NCalendarClock)
export const Check = make(NCheck)
export const CheckCircle2 = make(NCheckCircle2)
export const ChevronDown = make(NChevronDown)
export const ChevronLeft = make(NChevronLeft)
export const ChevronRight = make(NChevronRight)
export const CircleAlert = make(NCircleAlert)
export const CircleUser = make(NCircleUser)
export const ClipboardList = make(NClipboardList)
export const Copy = make(NCopy)
export const Database = make(NDatabase)
export const Diamond = make(NDiamond)
export const Download = make(NDownload)
export const Eye = make(NEye)
export const FilePlus2 = make(NFilePlus2)
export const FileText = make(NFileText)
export const FolderInput = make(NFolderInput)
export const FolderPlus = make(NFolderPlus)
export const FolderTree = make(NFolderTree)
export const GitBranch = make(NGitBranch)
export const Hash = make(NHash)
export const Inbox = make(NInbox)
export const Info = make(NInfo)
export const LayoutGrid = make(NLayoutGrid)
export const Link2 = make(NLink2)
export const List = make(NList)
export const ListPlus = make(NListPlus)
export const Maximize2 = make(NMaximize2)
export const Moon = make(NMoon)
export const MoreHorizontal = make(NMoreHorizontal)
export const NotebookPen = make(NNotebookPen)
export const Palette = make(NPalette)
export const PanelLeftClose = make(NPanelLeftClose)
export const PanelLeftOpen = make(NPanelLeftOpen)
export const Pause = make(NPause)
export const Pencil = make(NPencil)
export const Pin = make(NPin)
export const Play = make(NPlay)
export const Plus = make(NPlus)
export const RefreshCw = make(NRefreshCw)
export const RotateCcw = make(NRotateCcw)
export const Search = make(NSearch)
export const SlidersHorizontal = make(NSlidersHorizontal)
export const Sparkles = make(NSparkles)
export const Square = make(NSquare)
export const SquareCheck = make(NSquareCheck)
export const Sun = make(NSun)
export const Tag = make(NTag)
export const TerminalSquare = make(NTerminalSquare)
export const Timer = make(NTimer)
export const Trash2 = make(NTrash2)
export const Undo2 = make(NUndo2)
export const UserPlus = make(NUserPlus)
export const Waypoints = make(NWaypoints)
export const X = make(NX)
