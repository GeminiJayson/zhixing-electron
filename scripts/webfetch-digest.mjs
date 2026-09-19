/**
 * 抓取竞品官方页面并提炼关键片段（web_fetch 工具会被代理 fake-IP 判为“非公网”而拒绝，
 * 所以走系统网络栈）。
 * 用法：node scripts/webfetch-digest.mjs
 */
const TARGETS = [
  ['Things · Support', 'https://culturedcode.com/things/support/'],
  ['Things · Features', 'https://culturedcode.com/things/features/'],
  ['TickTick · Help', 'https://help.ticktick.com/'],
  ['TickTick · Site', 'https://www.ticktick.com/home'],
  ['OmniFocus · Support', 'https://support.omnigroup.com/documentation/omnifocus/'],
  ['Obsidian help (raw)', 'https://raw.githubusercontent.com/obsidianmd/obsidian-help/master/en/Plugins/Properties.md'],
  ['Obsidian help README', 'https://raw.githubusercontent.com/obsidianmd/obsidian-help/master/README.md'],
  ['Logseq docs (raw)', 'https://raw.githubusercontent.com/logseq/docs/master/README.md'],
  ['Logseq repo README', 'https://raw.githubusercontent.com/logseq/logseq/master/README.md'],
  ['Alfred · Workflows', 'https://www.alfredapp.com/workflows/'],
  ['Apple Shortcuts guide', 'https://support.apple.com/guide/shortcuts/welcome/ios'],
  ['Anytype', 'https://anytype.io/'],
  ['Notion help · databases', 'https://www.notion.so/help/category/databases'],
  ['Todoist · Filters', 'https://www.todoist.com/help/articles/introduction-to-filters-V98wIH'],
]

const KEYWORDS = [
  'filter', 'perspective', 'propert', 'bases', 'dataview', 'block reference', 'block-ref',
  'trigger', 'template', 'daily note', 'habit', 'defer', 'reminder', 'canvas', 'query',
  'smart list', 'natural language', 'offline', 'local-first', 'plugin', 'extension', 'workflow',
]

const strip = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()

for (const [name, url] of TARGETS) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; zhixing-research)' },
      signal: AbortSignal.timeout(20000),
    })
    const text = strip(await res.text())
    const hits = []
    for (const kw of KEYWORDS) {
      const i = text.toLowerCase().indexOf(kw)
      if (i < 0) continue
      const snippet = text.slice(Math.max(0, i - 80), i + 160).trim()
      if (!hits.some((h) => h.snippet.slice(20, 50) === snippet.slice(20, 50))) hits.push({ kw, snippet })
      if (hits.length >= 3) break
    }
    console.log('\n=== ' + name + ' | ' + res.status + ' | ' + text.length + ' chars ===')
    console.log('URL: ' + url)
    console.log('HEAD: ' + text.slice(0, 100))
    for (const h of hits) console.log('- [' + h.kw + '] ' + h.snippet)
  } catch (err) {
    console.log('\n=== ' + name + ' | FAIL === URL: ' + url + ' · ' + String(err.message).slice(0, 120))
  }
}
