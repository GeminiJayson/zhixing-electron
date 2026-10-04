import { useCallback, useEffect, useState } from 'react'
import type { AiLibraryProgress } from '@shared/ai-note'
import type { Note } from '@shared/types'

interface Options {
  current: Note | null
  onNotice: (msg: string) => void
  /** 确认框；返回 true 才继续 */
  confirm: (opts: {
    title: string
    message: string
    icon?: React.ReactNode
    tone?: 'warning'
    confirmText?: string
  }) => Promise<boolean>
  /** 把未落盘的编辑立刻冲出去（否则整理的是旧内容） */
  flushPending: () => Promise<void>
  /** 整理后重查列表 */
  onReload: () => Promise<void>
  /** 触发笔记重新装载（整理可能改了正文） */
  bumpReload: () => void
  /** 确认框里那个图钉图标 */
  icon: React.ReactNode
}

/**
 * AI 整理的两条路径：当前笔记、整个库。
 *
 * 从 NotesPage 抽出来（那个文件 2289 行）。
 *
 * 两条路的语义差别很大，放在一起是因为它们共享"忙碌/进度"这两种状态：
 *
 *   · 单篇：先把未落盘的编辑冲出去（否则整理的是旧内容），再交给主进程
 *     「取出 → 占位 → 请求 → 审计 → 归类 → 入库」。成功后才重载本地视图；
 *     失败时原笔记一个字节都没动。
 *   · 整库：串行逐篇，随时可停。进度通过主进程推送（onLibraryProgress）——
 *     所以这里要**订阅**，而不只是等一次调用的返回值。
 */
export function useNoteAi({
  current,
  onNotice,
  confirm,
  flushPending,
  onReload,
  bumpReload,
  icon,
}: Options): {
  aiBusy: boolean
  libJob: AiLibraryProgress | null
  organizeNote: () => Promise<void>
  organizeLibrary: () => Promise<void>
} {
  const [aiBusy, setAiBusy] = useState(false)
  const [libJob, setLibJob] = useState<AiLibraryProgress | null>(null)

  // 整库整理的进度订阅：主进程逐篇推进时会推过来，最后一帧 running=false 用于收尾
  useEffect(() => {
    let alive = true
    // 进页面时先问一次 —— 上次可能没跑完
    void window.zhixing.ai.libraryProgress().then((p) => {
      if (alive && p?.running) setLibJob(p)
    })
    const off = window.zhixing.ai.onLibraryProgress((p) => {
      setLibJob(p.running ? p : null)
      if (!p.running) {
        onNotice(
          '整库整理结束：成功 ' + p.ok + ' 篇' +
            (p.failed ? '，失败 ' + p.failed + ' 篇' : '') +
            (p.skipped ? '，跳过 ' + p.skipped + ' 篇' : '')
        )
        void onReload()
      }
    })
    return () => {
      alive = false
      off()
    }
  }, [onReload, onNotice])

  const organizeLibrary = useCallback(async (): Promise<void> => {
    if (libJob) {
      // 取消现在会回一句人话：没在跑时说「当前没有正在运行的整库整理」，
      // 而不是把 false 静默吞掉
      const res = await window.zhixing.ai.cancelLibrary()
      onNotice(res.message)
      return
    }
    const all = await window.zhixing.db.notes()
    if (!all.length) {
      onNotice('笔记库还是空的')
      return
    }
    const confirmed = await confirm({
      title: '整理全库',
      message:
        '将逐篇把 ' + all.length + ' 篇笔记交给大模型整理，并直接改写原笔记。\n\n' +
        '· Markdown/富文本：重排正文；Word/Excel：只归类；链接笔记：分配每条链接的去向\n' +
        '· 每篇都会先过审计，不通过就不写库\n' +
        '· 正文变更前会留一份版本快照，可在笔记历史里回滚\n' +
        '· 篇数多时要跑一阵，随时可以停止',
      icon,
      tone: 'warning',
      confirmText: '开始整理',
    })
    if (!confirmed) return
    const res = await window.zhixing.ai.organizeLibrary()
    if (!res.ok) onNotice(res.message)
    else if (res.failedTitles.length) {
      onNotice(res.message + '；失败：' + res.failedTitles.join('、'))
    }
  }, [libJob, confirm, onNotice, icon])

  const organizeNote = useCallback(async (): Promise<void> => {
    if (!current || aiBusy) return
    await flushPending()
    setAiBusy(true)
    try {
      const res = await window.zhixing.ai.organizeNote(current.id)
      if (!res.ok) {
        const errors = (res.issues ?? [])
          .filter((i) => i.level === 'error')
          .slice(0, 2)
          .map((i) => i.message)
          .join('；')
        onNotice(errors ? res.message + '：' + errors : res.message)
        return
      }
      const parts = ['AI 已整理并保存']
      if (res.summary) parts.push(res.summary)
      if (res.folderPath) {
        parts.push(
          res.createdFolders?.length
            ? '新建并归入「' + res.folderPath + '」'
            : '归入「' + res.folderPath + '」'
        )
      }
      const warns = (res.issues ?? []).filter((i) => i.level === 'warn').length
      if (warns) parts.push(warns + ' 条提醒')
      onNotice(parts.join('｜'))
      bumpReload()
      // 可能新建了文件夹，笔记树要重新拉一遍
      await onReload()
    } finally {
      setAiBusy(false)
    }
  }, [current, aiBusy, flushPending, onNotice, bumpReload, onReload])

  return { aiBusy, libJob, organizeNote, organizeLibrary }
}
