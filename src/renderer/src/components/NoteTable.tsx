import { useCallback, useEffect, useMemo, useState } from 'react'
import { AgGridReact } from 'ag-grid-react'
import { themeQuartz } from 'ag-grid-community'
import type { ColDef, RowDoubleClickedEvent } from 'ag-grid-community'
import {
  kindLabel,
  matchNoteQuery,
  parseNoteQuery,
  propColumnsOf,
  type NoteRow,
} from '@shared/note-view'
import { LayoutGrid, Plus, Search, Trash2 } from '@renderer/lib/icons'
import { Select } from './Select'
import { useDialog } from './Dialogs'

interface Props {
  /** 双击一行时打开这篇笔记 —— 具体怎么打开（切回编辑器视图）由调用方决定 */
  onOpenNote: (id: number) => void
}

/**
 * 笔记的「数据库视图」：把笔记按属性铺成表格，用表达式筛。
 *
 * 为什么单独一条查询（db:noteTableRows）而不是复用笔记树那份 listNotes：
 * 树不需要 props / kind，表格需要，而它们都是每行都要读的列。
 *
 * 与 XlsxGrid 一样必须**懒加载**（调用方 React.lazy）：ag-grid 打包后体积可观，
 * 而"看笔记"绝大多数时候走的是编辑器，不该为一周开一次的视图付这个代价。
 */
export default function NoteTable({ onOpenNote }: Props): JSX.Element {
  const dialog = useDialog()
  const [rows, setRows] = useState<NoteRow[]>([])
  const [expr, setExpr] = useState('')
  const [views, setViews] = useState<{ id: number; name: string; kind: string; expr: string }[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    const [r, v] = await Promise.all([
      window.zhixing.db.noteTableRows(),
      window.zhixing.db.savedQueries(),
    ])
    setRows(r)
    // 任务侧的智能清单与笔记视图共用一张表，靠 kind 区分
    setViews(v.filter((x) => x.kind === 'note'))
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const query = useMemo(() => parseNoteQuery(expr), [expr])
  const filtered = useMemo(() => rows.filter((r) => matchNoteQuery(r, query)), [rows, query])
  const propCols = useMemo(() => propColumnsOf(filtered), [filtered])

  /** ag-grid 吃扁平对象，属性列在 data 上叫 p:<键> */
  const rowData = useMemo(
    () =>
      filtered.map((r) => {
        const o: Record<string, string | number> = {
          id: r.id,
          title: r.title,
          folder: r.folder,
          kindText: kindLabel(r.kind),
          tagText: r.tags.join(' / '),
          word_count: r.word_count,
          updated_at: r.updated_at.slice(0, 16).replace('T', ' '),
        }
        for (const k of propCols) o['p:' + k] = r.props[k] ?? ''
        return o
      }),
    [filtered, propCols]
  )

  const colDefs = useMemo<ColDef[]>(() => {
    const defs: ColDef[] = [
      { field: 'title', headerName: '标题', flex: 2, minWidth: 160 },
      { field: 'folder', headerName: '文件夹', flex: 1, minWidth: 90 },
      { field: 'kindText', headerName: '类型', flex: 1, minWidth: 80 },
      { field: 'tagText', headerName: '标签', flex: 1, minWidth: 90 },
    ]
    for (const k of propCols) defs.push({ field: 'p:' + k, headerName: k, flex: 1, minWidth: 80 })
    defs.push(
      { field: 'word_count', headerName: '字数', width: 90 },
      { field: 'updated_at', headerName: '更新', width: 150 }
    )
    return defs
  }, [propCols])

  const saveView = async (): Promise<void> => {
    if (!expr.trim()) {
      await dialog.confirm({ title: '还没有筛选条件', message: '先在筛选框里写点什么，再存成视图。' })
      return
    }
    const name = await dialog.prompt({
      title: '保存为视图',
      label: '名称',
      defaultValue: expr.slice(0, 24),
      placeholder: '例如：待补来源的概念卡',
    })
    if (!name || !name.trim()) return
    const res = await window.zhixing.db.saveSavedQuery({ name: name.trim(), expr: expr.trim(), kind: 'note' })
    if (!res.ok) await dialog.confirm({ title: '没保存成功', message: res.problems.join('；') })
    await load()
  }

  const removeView = async (): Promise<void> => {
    const hit = views.find((v) => v.expr === expr)
    if (!hit) return
    const ok = await dialog.confirm({
      title: '删除这个视图？',
      message: '只删掉这条保存的筛选条件，笔记本身不受影响。',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    await window.zhixing.db.deleteSavedQuery(hit.id)
    await load()
  }

  return (
    <div className="notetable">
      <div className="notetable__bar">
        <span className="notetable__title">
          <LayoutGrid size={15} /> 数据库视图
        </span>
        <span className="notetable__search">
          <Search size={13} aria-hidden />
          <input
            className="field"
            value={expr}
            placeholder="筛条件：text:关键词 tag:写作 kind:concept prop:来源=书籍"
            aria-label="筛选条件"
            onChange={(e) => setExpr(e.target.value)}
          />
        </span>
        <Select
          className="field notetable__views"
          ariaLabel="已保存的视图"
          value={views.some((v) => v.expr === expr) ? expr : ''}
          onChange={(v) => setExpr(v)}
          options={[{ value: '', label: '已保存的视图…' }, ...views.map((v) => ({ value: v.expr, label: v.name }))]}
        />
        <button className="text-btn" title="把当前筛选条件存下来" onClick={() => void saveView()}>
          <Plus size={13} /> 存为视图
        </button>
        {views.some((v) => v.expr === expr) && (
          <button
            className="icon-btn icon-btn--danger"
            title="删除这个视图"
            aria-label="删除这个视图"
            onClick={() => void removeView()}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      <p className="u-aux notetable__hint">
        {loading
          ? '正在读笔记…'
          : '共 ' + rows.length + ' 篇，命中 ' + filtered.length + ' 篇。双击一行打开笔记。'}
        {query.unknown.length > 0 && (
          <>
            {' '}
            没看懂这几个条件（笔记视图不认任务那套语法）：{query.unknown.join('、')}
          </>
        )}
      </p>

      <div className="notetable__grid">
        <AgGridReact
          theme={themeQuartz}
          rowData={rowData}
          columnDefs={colDefs}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          onRowDoubleClicked={(e: RowDoubleClickedEvent) => onOpenNote(Number(e.data?.id ?? 0))}
          rowHeight={30}
          headerHeight={32}
        />
      </div>
    </div>
  )
}
