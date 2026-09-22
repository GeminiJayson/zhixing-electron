/**
 * 生成 officecheck.mjs 需要的 docx / xlsx 夹具。
 *
 * 用法：node gen-office-fixtures.mjs <docx 路径> <xlsx 路径>
 *
 * 放在仓库里而不是 /tmp：这个脚本原先写死在 /tmp/gen-office-fixtures.py，
 * 系统一清理临时目录，整条 Office 预览验证就再也跑不起来（表现为脚本文件找不到）。
 * 夹具生成必须跟验证脚本一起进版本库。
 * 现在改用项目已有的 docx / xlsx 造真实文档，跑 officecheck 不再依赖 Python。
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx'

// xlsx 0.18 的主入口是 CJS bundle（xlsx.js），用 require 取它最稳。
const require = createRequire(import.meta.url)
const XLSX = require('xlsx')

const [docxPath, xlsxPath] = process.argv.slice(2)
if (!docxPath || !xlsxPath) {
  console.error('用法：node gen-office-fixtures.mjs <docx 路径> <xlsx 路径>')
  process.exit(1)
}

async function makeDocx(path) {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: '知行 Office 预览验证段落' }),
          new Paragraph({ text: '第二段落内容' }),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph({ text: '单元格A' })] }),
                  new TableCell({ children: [new Paragraph({ text: '单元格B' })] }),
                ],
              }),
            ],
          }),
        ],
      },
    ],
  })
  writeFileSync(path, await Packer.toBuffer(doc))
}

function makeXlsx(path) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['名称', '数量'], ['知行', 100]]), '验证表')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['备注', '内容'], ['第二表数据', 200]]), '第二表')
  XLSX.writeFile(wb, path)
}

await makeDocx(docxPath)
makeXlsx(xlsxPath)
