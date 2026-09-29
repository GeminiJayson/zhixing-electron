/**
 * 正文文字颜色的预设色板。
 *
 * 为什么不是 <input type="color">：在 Electron 里点开是系统取色器，
 * 选完看不出当前是什么颜色（它同时充当显示与输入，却只在打开时同步一次）。
 * 预设色一排点一下就好，清除是最后一个 ×。
 *
 * 取的是深色系：这些颜色是用来给正文文字上色的，浅色在纸色背景上读不了。
 *
 * 单独成一个文件是因为笔记编辑器与快速笔记浮窗共用同一份场景（见 RichTextToolbar）。
 */
export const TEXT_COLORS = [
  { value: '#1f2329', label: '正文黑' },
  { value: '#6b7280', label: '灰' },
  { value: '#dc2626', label: '红' },
  { value: '#ea580c', label: '橙' },
  { value: '#ca8a04', label: '黄' },
  { value: '#16a34a', label: '绿' },
  { value: '#0891b2', label: '青' },
  { value: '#2563eb', label: '蓝' },
  { value: '#7c3aed', label: '紫' },
  { value: '#db2777', label: '粉' },
] as const
