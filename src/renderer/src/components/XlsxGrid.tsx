/**
 * Excel 网格：用 ag-grid 社区版（MIT）替换原来手写的 <table contentEditable>。
 *
 * 为什么值得换：
 * - ag-grid 自带**虚拟滚动** —— 几千行的表格只渲染可见那几十行，这正是「编辑不能卡顿」的解药；
 *   原来那个 table 会把每一格都塞进 DOM，行数一多就必然卡。
 * - 单元格可以用 cellRenderer 画任意内容，所以「单元格里放图片」是天然的：
 *   约定图片单元格的值写成 img:<附件路径>，渲染成缩略图，双击看原图。
 *
 * 它的代价是体积（解压 21 MB，打包后仍可观），所以**这个文件必须懒加载**：
 * 调用方用 React.lazy(() => import('./XlsxGrid'))，只有真的打开 Excel 笔记才会下载。
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { AgGridReact } from 'ag-grid-react'
import type { CellValueChangedEvent, ColDef, ICellRendererParams } from 'ag-grid-community'
import { themeQuartz } from 'ag-grid-community'
import { attachmentUrl } from '@shared/attachment-url'

interface Props {
  rows: string[][]
  onChange: (rows: string[][]) => void
  readOnly?: boolean
}

/** 图片单元格的约定前缀：值是 img:<绝对路径> 时按图片渲染、缩略图展示、双击看原图。 */
export const IMG_PREFIX = 'img:'

export function isImageCell(v: string): boolean {
  return typeof v === 'string' && v.startsWith(IMG_PREFIX)
}

function ImageCell({ value }: ICellRendererParams): JSX.Element | null {
  const [big, setBig] = useState(false)
  if (typeof value !== 'string' || !isImageCell(value)) return null
  const path = value.slice(IMG_PREFIX.length)
  // 路径 → file URL 的拼装收在 shared/attachment-url.ts：原先这里和 RichTextEditor 各写一份，
  // 且都在 Windows 反斜杠路径下产出无效 URL（file://C%3A%5C...）
  const url = attachmentUrl(path)
  return (
    <>
      <img
        className="xlsx-cell-img"
        src={url}
        alt="单元格图片"
        title="双击查看原图"
        onDoubleClick={() => setBig(true)}
      />
      {big && (
        <div className="rt-preview" role="dialog" aria-label="图片预览" onClick={() => setBig(false)}>
          <img className="rt-preview__img" src={url} alt="原图预览" />
        </div>
      )}
    </>
  )
}

export default function XlsxGrid({ rows, onChange, readOnly = false }: Props): JSX.Element {
  const gridRef = useRef<AgGridReact>(null)
  // 第一行当表头（xlsx 的惯例），其余是数据行。
  // 原来这里用列字母 A/B/C 当表头，是因为我没把首行当表头 —— 那样用户在网格里
  // 看不到自己的列名。
  const header = rows[0] ?? []
  const body = useMemo(() => rows.slice(1), [rows])
  // ag-grid 要的是对象数组，这里把二维数组映射成 {c0,c1,...}；列数取最长的一行
  const width = useMemo(() => rows.reduce((m, r) => Math.max(m, r.length), 0) || 1, [rows])
  const rowData = useMemo(
    () => body.map((r, i) => { const o: Record<string, string> = { __row: String(i) }; r.forEach((c, j) => { o['c' + j] = c ?? '' }); return o }),
    [body]
  )
  const colDefs = useMemo<ColDef[]>(
    () => Array.from({ length: width }, (_, j) => ({
      field: 'c' + j,
      // 首行有值就用它当列名，没有才退回列字母
      headerName:
        (header[j] ?? '').trim() ||
        String.fromCharCode(65 + (j % 26)) + (j >= 26 ? String(Math.floor(j / 26)) : ''),
      editable: !readOnly,
      resizable: true,
      flex: 1,
      minWidth: 90,
      cellRenderer: (p: ICellRendererParams) => (isImageCell(String(p.value ?? '')) ? <ImageCell {...p} /> : String(p.value ?? '')),
    })),
    [width, readOnly, header]
  )
  const onCellValueChanged = useCallback(
    (e: CellValueChangedEvent) => {
      const ri = Number(e.data.__row)
      const ci = Number(String(e.colDef.field).slice(1))
      // 改的是数据行（表头另存），拼回去时把表头补上，免得写回 .xlsx 时丢一行
      const nextBody = body.map((r) => [...r])
      while (nextBody[ri].length <= ci) nextBody[ri].push('')
      nextBody[ri][ci] = String(e.newValue ?? '')
      onChange([header, ...nextBody])
    },
    [body, header, onChange]
  )

  return (
    <div className="xlsx-ag" style={{ height: '100%', width: '100%' }}>
      <AgGridReact
        ref={gridRef}
        theme={themeQuartz}
        rowData={rowData}
        columnDefs={colDefs}
        defaultColDef={{ sortable: true, filter: true, editable: !readOnly }}
        onCellValueChanged={onCellValueChanged}
        stopEditingWhenCellsLoseFocus
        singleClickEdit={false}
        rowHeight={28}
        headerHeight={30}
      />
    </div>
  )
}
