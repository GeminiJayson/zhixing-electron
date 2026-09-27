import { useCallback, useEffect, useState } from 'react'

/**
 * 一棵树的「哪些节点收起了」：`Set<number>` + localStorage 持久化。
 *
 * 为什么抽出来共用：应用里有三棵树（笔记树 / 任务清单树 / 工作流模板树），
 * 行为必须一致 —— 收起某个文件夹、切到别的页、切回来、重启应用，状态都该还在。
 * 各写一份的话，序列化格式、坏数据容错、写回时机这三处一定会走样。
 *
 * 存 localStorage 而不是库表：与「笔记树宽度」「清单树是否收起」「工作流布局方向」
 * 同一个口径 —— 纯界面偏好，不跟着数据导出/同步走。
 *
 * 节点被删除后它的 id 会留在集合里，不影响显示（再也不会被查到），所以不做清理。
 */
export function useCollapsedSet(storageKey: string): {
  collapsed: Set<number>
  toggle: (id: number) => void
  setCollapsed: React.Dispatch<React.SetStateAction<Set<number>>>
} {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return new Set()
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return new Set()
      // 只收正整数：坏数据（字符串、null、对象）就地丢掉，不让它把整棵树搞崩
      return new Set(parsed.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0))
    } catch {
      return new Set()
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...collapsed]))
    } catch {
      // 隐私模式 / 配额满：记忆失败不该影响用树本身
    }
  }, [storageKey, collapsed])

  const toggle = useCallback((id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return { collapsed, toggle, setCollapsed }
}
