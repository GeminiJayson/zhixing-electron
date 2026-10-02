/**
 * 中文文案表。
 *
 * 现状是渐进抽取：先把「导航 + 页面标题 + 通用动作」这类高频、易变的文案收进来，
 * 其余业务文案继续写在组件里。要出英文版时，加一份 en.ts 并补全 key 即可，
 * 不需要再动组件结构。
 */
export const zh = {
  // 导航
  'nav.today': '今日',
  'nav.tasks': '任务',
  'nav.inbox': '收件箱',
  'nav.notes': '笔记',
  'nav.workflow': '工作流',
  'nav.graph': '图谱',
  'nav.review': '回顾',
  'nav.vault': '保险箱',
  'nav.settings': '设置',

  // 页面标题
  'page.today': '今日',
  'page.tasks': '任务',
  'page.inbox': '收件箱',
  'page.notes': '笔记',
  'page.workflow': '工作流',
  'page.graph': '图谱',
  'page.review': '回顾',
  'page.settings': '设置',

  // 页面副标题（显示在标题行右侧）
  'page.tasks.sub': '树 / 看板 / 象限 / 日历',
  'page.inbox.sub': '待整理的闪念',
  'page.notes.sub': 'Markdown、Office 与链接笔记',
  'page.workflow.sub': '可复用的流程模板',
  'page.graph.sub': '笔记与任务的关联',
  'page.review.sub': '完成情况与番茄记录',
  'page.settings.sub': '外观、行为与数据',

  // 通用动作
  'action.add': '添加',
  'action.cancel': '取消',
  'action.close': '关闭',
  'action.delete': '删除',
  'action.save': '保存',
  'action.undo': '撤销',
  'action.confirm': '确定',

  // 通用状态
  'state.empty': '暂无内容',
  'state.loading': '加载中…',
  'state.saved': '已保存',

  // 命令面板
  'palette.goTo': '转到{name}',
  'palette.placeholder': '输入以搜索页面、笔记，或直接建任务…',
  'palette.empty': '没有匹配项',
} as const
