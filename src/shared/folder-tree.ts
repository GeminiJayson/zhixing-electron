/**
 * 把文件夹按**树序**铺平：父后面紧跟它的子，depth 是**实际层级**。
 *
 * 为什么需要它（两种错法都踩过）：
 * 1. 直接 `folders.map` → 平铺列表，看不出谁属于谁（「弹窗没有层级」）；
 * 2. 「顶层全列完、再把所有子文件夹堆在后面并统一缩进一格」→ 深层文件夹看起来
 *    挂在最后一个顶层下面，归属完全是错的（用户报的「文件夹路径不对」）。
 *
 * 笔记文件夹与任务清单是同一种树（都是 parent_id 自引用），所以这一份两边共用。
 */
export interface FolderLike {
  id: number
  parent_id?: number | null
  name: string
}

export interface FlatFolder<T> {
  folder: T
  depth: number
}

/**
 * 树序铺平。**孤立节点当顶层**：父文件夹被删（或数据里 parent_id 指向不存在的行）时，
 * 若只从 null 开始递归，它会在列表里彻底消失 —— 用户会以为文件夹丢了。
 * 成环时靠 seen 兜底，数据异常也不至于把弹层卡死。
 */
export function flattenFolderTree<T extends FolderLike>(folders: T[]): FlatFolder<T>[] {
  const ids = new Set(folders.map((f) => f.id))
  const byParent = new Map<number | null, T[]>()
  for (const f of folders) {
    const key = f.parent_id != null && ids.has(f.parent_id) ? f.parent_id : null
    const list = byParent.get(key) ?? []
    list.push(f)
    byParent.set(key, list)
  }
  const out: FlatFolder<T>[] = []
  const seen = new Set<number>()
  const walk = (parent: number | null, depth: number): void => {
    for (const f of byParent.get(parent) ?? []) {
      if (seen.has(f.id)) continue
      seen.add(f.id)
      out.push({ folder: f, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/**
 * 某个文件夹**自身 + 全部后代**的 id 集合。
 *
 * 「任务关联一个文件夹 → 自动引用它下面所有笔记（**递归子文件夹**）」用的就是它。
 * 与 flattenFolderTree 一样用「反复扫到没有新增」而不是递归：文件夹树很浅，
 * 而且这样天然不会因为坏数据（成环）卡死。
 */
export function folderWithDescendants<T extends FolderLike>(folders: T[], rootId: number): Set<number> {
  const out = new Set<number>([rootId])
  for (let changed = true; changed; ) {
    changed = false
    for (const f of folders) {
      if (f.parent_id != null && out.has(f.parent_id) && !out.has(f.id)) {
        out.add(f.id)
        changed = true
      }
    }
  }
  return out
}