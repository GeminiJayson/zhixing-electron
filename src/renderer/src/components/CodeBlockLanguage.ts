import { Extension } from '@tiptap/core'

/**
 * 代码块的语言标记。
 *
 * 为什么自己写而不是装 `@tiptap/extension-code-block-lowlight`：那个包会拖进
 * lowlight / highlight.js 一整棵语法高亮树，而这里要的只是**记住这段代码是什么语言**
 * 并把它写成 `data-language` 属性（配色交给 CSS，不引入高亮引擎）。
 * 目标里也写明了"在现有依赖内实现，不引入新库"。
 *
 * 挂在 codeBlock 节点上（StarterKit 已提供该节点，这里只补一个属性）。
 * 存 `data-language` 而不是 `class="language-xxx"`：class 会和样式钩子混在一起，
 * 而 data-* 只表达数据，导回 docx / markdown 时也好取。
 */
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    codeBlockLanguage: {
      /** 给当前代码块设语言（空串 = 不标） */
      setCodeBlockLanguage: (language: string) => ReturnType
    }
  }
}

export const CODE_LANGUAGES: { value: string; label: string }[] = [
  { value: '', label: '纯文本' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'cmd', label: 'cmd' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'json', label: 'JSON' },
  { value: 'sql', label: 'SQL' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'bash', label: 'Shell' },
  { value: 'yaml', label: 'YAML' },
  { value: 'markdown', label: 'Markdown' },
]

export const CodeBlockLanguage = Extension.create({
  name: 'codeBlockLanguage',

  addGlobalAttributes() {
    return [
      {
        types: ['codeBlock'],
        attributes: {
          language: {
            default: '',
            parseHTML: (el) => el.getAttribute('data-language') ?? '',
            renderHTML: (attrs) => (attrs.language ? { 'data-language': attrs.language } : {}),
          },
        },
      },
    ]
  },

  addCommands() {
    return {
      setCodeBlockLanguage:
        (language: string) =>
        ({ commands }) =>
          commands.updateAttributes('codeBlock', { language }),
    }
  },
})
