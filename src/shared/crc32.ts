/**
 * CRC-32（IEEE 802.3），ZIP 条目校验用。
 *
 * **自己实现而不是用 `node:zlib.crc32`**：后者在 Node 20.15 才加入，
 * Electron 运行时不一定有 —— 打包产物的校验不能依赖一个可能缺席的内置方法。
 *
 * 原先 `db/export.ts`（写 ZIP）与 `db/preview.ts`（读 xlsx）各写了一份：
 * 表名一个叫 `CRC32_TABLE` 一个叫 `CRC_TABLE`，循环体一个先移后查表一个先查表后移。
 * 数学上等价，但**两份独立实现**意味着改一处忘另一处时不会报错，只会校验出不一致的结论。
 */

/** 256 项查表。多项式 0xEDB88320（IEEE 802.3 的反转形式）。 */
const TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

/** 算一段字节的 CRC-32（返回无符号 32 位整数）。 */
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ 0xffffffff) >>> 0
}
