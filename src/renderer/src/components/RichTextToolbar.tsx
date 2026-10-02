import { useEditorState, type Editor } from '@tiptap/react'
import { Toolbar } from './Toolbar'
import { TEXT_COLORS } from './rich-text-colors'
import { CODE_LANGUAGES } from './CodeBlockLanguage'

interface Props {
  editor: Editor
  /** 左侧自定义区（返回按钮之类） */
  leading?: React.ReactNode
  /** 右侧主操作区（保存按钮之类） */
  primary?: React.ReactNode
  /**
   * 链接 / 图片 / 附件这三个按钮需要宿主自己实现（图片要落盘、附件要选文件），
   * 所以做成可选回调：不传就不渲染，而不是渲染一个点了没反应的按钮。
   * 快速笔记浮窗就是"不传"的形态 —— 它只做纯文字与样式。
   */
  onInsertLink?: () => void
  onInsertImage?: () => void
  onInsertFile?: () => void
}

/**
 * 富文本工具栏 —— 字号 / 颜色 / 粗斜下删 / 标题 / 列表 / 引用 / 代码块（含语言）/
 * 对齐 / 链接 / 图片 / 附件，**一处实现两处使用**（笔记编辑器与快速笔记浮窗）。
 *
 * 抽出来的原因：快速笔记的输入区也要有全套样式操作，而这段配置有一百多行
 * （每个按钮都带 aria-pressed 与 title，还要处理"代码块语言只在光标位于代码块内时出现"）。
 * 复制一份的话，以后调样式就得改两处，迟早会不一致。
 */
export function RichTextToolbar({
  editor,
  leading,
  primary,
  onInsertLink,
  onInsertImage,
  onInsertFile,
}: Props): React.JSX.Element {
  /**
   * 工具栏的"当前状态"。
   *
   * 必须经 useEditorState 订阅：useEditor 本身**不会**在光标移动或选区变化时重渲染组件，
   * 直接调 editor.isActive('bold') 只会拿到首次渲染那一刻的值 —— 按钮的激活态会一直是灭的，
   * 字号与颜色也永远显示"未设置"。这是"工具栏看着有、状态不动"的经典原因。
   */
  const fmt = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      bold: ed?.isActive('bold') ?? false,
      italic: ed?.isActive('italic') ?? false,
      underline: ed?.isActive('underline') ?? false,
      strike: ed?.isActive('strike') ?? false,
      h1: ed?.isActive('heading', { level: 1 }) ?? false,
      h2: ed?.isActive('heading', { level: 2 }) ?? false,
      h3: ed?.isActive('heading', { level: 3 }) ?? false,
      bullet: ed?.isActive('bulletList') ?? false,
      ordered: ed?.isActive('orderedList') ?? false,
      quote: ed?.isActive('blockquote') ?? false,
      code: ed?.isActive('codeBlock') ?? false,
      left: ed?.isActive({ textAlign: 'left' }) ?? false,
      center: ed?.isActive({ textAlign: 'center' }) ?? false,
      right: ed?.isActive({ textAlign: 'right' }) ?? false,
      /** 光标处生效的字号（"16px"），空串 = 没设过 */
      fontSize: String(ed?.getAttributes('textStyle').fontSize ?? ''),
      /** 光标处生效的文字颜色（"#rrggbb" / "rgb(...)"），空串 = 没设过 */
      color: String(ed?.getAttributes('textStyle').color ?? ''),
      codeLang: String(ed?.getAttributes('codeBlock').language ?? ''),
      /** 光标是否在表格里 —— 决定工具栏显示"插入表格"还是表格的增删操作 */
      inTable: ed?.isActive('table') ?? false,
    }),
  })
  const chain = (): ReturnType<Editor['chain']> => editor.chain().focus()

  return (
    <Toolbar
      variant="panel"
      sticky={false}
      nav={leading}
      primary={primary}
      filters={[
        /**
         * 字号：受控显示光标处的实际值。
         * 旧版是 defaultValue="" + onChange 里把自己清空 —— 那是个"一次性开关"，
         * 用户看不出当前是多少号，也看不出有没有设上。空选项现在表示"清除字号"。
         */
        <select
          key="size"
          className="field field--compact"
          title="字号（当前光标处生效的值）"
          aria-label="字号"
          value={fmt.fontSize.replace('px', '')}
          onChange={(e) => {
            const v = e.target.value
            if (v) chain().setFontSize(v + 'px').run()
            else chain().unsetFontSize().run()
          }}
        >
          <option value="">默认</option>
          {[12, 13, 14, 15, 16, 18, 20, 24, 28, 32].map((sz) => (
            <option key={sz} value={String(sz)}>
              {sz}
            </option>
          ))}
        </select>,
        /**
         * 文字颜色：一排预设色直接点。
         *
         * 旧版是一个 <input type="color"> —— 在 Electron 里点开是系统取色器，
         * 选完也不知道当前是什么颜色（它同时充当显示与输入，却只在打开时同步一次）。
         * 预设色板让"选颜色"变成一次点击，最后那个 × 是清除。
         */
        <span key="color" className="rt-colors" role="group" aria-label="文字颜色">
          {TEXT_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              className={'rt-color' + (fmt.color === c.value ? ' rt-color--on' : '')}
              style={{ background: c.value }}
              title={c.label}
              aria-label={c.label}
              aria-pressed={fmt.color === c.value}
              onClick={() => chain().setColor(c.value).run()}
            />
          ))}
          <button
            type="button"
            className="rt-color rt-color--reset"
            title="清除颜色"
            aria-label="清除颜色"
            onClick={() => chain().unsetColor().run()}
          >
            ×
          </button>
        </span>,
      ]}
      /**
       * 每个按钮都带 aria-pressed —— 样式表里 `.text-btn[aria-pressed='true']` 有现成的
       * 高亮规则（accent 淡底 + 主题色文字）。以前一个都没传，所以按钮永远是灭的：
       * 光标落在加粗文字里也看不出"现在是加粗状态"。
       */
      secondary={[
        <button key="b" className="text-btn" title="加粗" aria-pressed={fmt.bold} onClick={() => chain().toggleBold().run()}>
          B
        </button>,
        <button key="i" className="text-btn" title="斜体" aria-pressed={fmt.italic} onClick={() => chain().toggleItalic().run()}>
          I
        </button>,
        <button key="u" className="text-btn" title="下划线" aria-pressed={fmt.underline} onClick={() => chain().toggleUnderline().run()}>
          U
        </button>,
        <button key="s" className="text-btn" title="删除线" aria-pressed={fmt.strike} onClick={() => chain().toggleStrike().run()}>
          S
        </button>,
        ...[1, 2, 3].map((lv) => (
          <button
            key={'h' + lv}
            className="text-btn"
            title={lv + ' 级标题'}
            aria-pressed={lv === 1 ? fmt.h1 : lv === 2 ? fmt.h2 : fmt.h3}
            onClick={() => chain().toggleHeading({ level: lv as 1 | 2 | 3 }).run()}
          >
            H{lv}
          </button>
        )),
        <button key="ul" className="text-btn" title="无序列表" aria-pressed={fmt.bullet} onClick={() => chain().toggleBulletList().run()}>
          • 列表
        </button>,
        <button key="ol" className="text-btn" title="有序列表" aria-pressed={fmt.ordered} onClick={() => chain().toggleOrderedList().run()}>
          1. 列表
        </button>,
        <button key="q" className="text-btn" title="引用" aria-pressed={fmt.quote} onClick={() => chain().toggleBlockquote().run()}>
          引用
        </button>,
        /**
         * 表格。和代码块语言一样是条件渲染，但理由不同：
         * 代码块语言是"没有对全文生效的含义"，表格则是**光标位置决定能做什么操作** ——
         * 表格外只能插入，表格内才能增删行列。
         *
         * 没有这一组的话，用户插入的表格**删不掉**（只能整段选中再按退格），
         * 列宽也调不了。这是"只能创建不能修改"的典型缺口。
         */
        ...(fmt.inTable
          ? [
              <button
                key="tbl-row"
                className="text-btn"
                title="在下方插入一行"
                onClick={() => chain().addRowAfter().run()}
              >
                +行
              </button>,
              <button
                key="tbl-col"
                className="text-btn"
                title="在右侧插入一列"
                onClick={() => chain().addColumnAfter().run()}
              >
                +列
              </button>,
              <button
                key="tbl-rmrow"
                className="text-btn"
                title="删除当前行"
                onClick={() => chain().deleteRow().run()}
              >
                −行
              </button>,
              <button
                key="tbl-rmcol"
                className="text-btn"
                title="删除当前列"
                onClick={() => chain().deleteColumn().run()}
              >
                −列
              </button>,
              <button
                key="tbl-rm"
                className="text-btn"
                title="删除整个表格"
                onClick={() => chain().deleteTable().run()}
              >
                删表格
              </button>,
            ]
          : [
              <button
                key="tbl-new"
                className="text-btn"
                title="插入 3×3 表格（带表头行）"
                onClick={() =>
                  chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
                }
              >
                表格
              </button>,
            ]),
        <button key="code" className="text-btn" title="代码块" aria-pressed={fmt.code} onClick={() => chain().toggleCodeBlock().run()}>
          代码
        </button>,
        /**
         * 代码块的语言：只在光标位于代码块内时出现 —— 它没有"对全文生效"的含义，
         * 常驻在工具栏里只会让人以为可以给普通段落选语言。
         */
        ...(fmt.code
          ? [
              <select
                key="codelang"
                className="field field--compact"
                title="代码块语言"
                aria-label="代码块语言"
                value={fmt.codeLang}
                onChange={(e) => chain().setCodeBlockLanguage(e.target.value).run()}
              >
                {CODE_LANGUAGES.map((l) => (
                  <option key={l.value || 'plain'} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>,
            ]
          : []),
        <button key="jl" className="text-btn" title="左对齐" aria-pressed={fmt.left} onClick={() => chain().setTextAlign('left').run()}>
          左
        </button>,
        <button key="jc" className="text-btn" title="居中" aria-pressed={fmt.center} onClick={() => chain().setTextAlign('center').run()}>
          中
        </button>,
        <button key="jr" className="text-btn" title="右对齐" aria-pressed={fmt.right} onClick={() => chain().setTextAlign('right').run()}>
          右
        </button>,
        ...(onInsertLink
          ? [
              <button key="link" className="text-btn" title="插入链接" onClick={onInsertLink}>
                链接
              </button>,
            ]
          : []),
        ...(onInsertImage
          ? [
              <button key="img" className="text-btn" title="插入图片" onClick={onInsertImage}>
                图片
              </button>,
            ]
          : []),
        ...(onInsertFile
          ? [
              <button key="file" className="text-btn" title="插入文件附件" onClick={onInsertFile}>
                文件
              </button>,
            ]
          : []),
      ]}
    />
  )
}
