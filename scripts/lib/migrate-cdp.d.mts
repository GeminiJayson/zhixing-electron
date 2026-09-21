/** scripts/lib/migrate-cdp.mjs 的类型声明（TS 解析 x.mjs 时会找 x.d.mts）。 */
export declare function scanLine(
  text: string,
  from: number,
  to: number,
  state: { tpl: boolean; block: boolean; tail: string }
): number
export declare function declLineCount(text: string, startOffset: number): number
export declare function renameRefs(text: string): string
export declare function migrateSource(
  lines: string[]
): { out: string; decls: number; stmts: number } | { skip: string }
export declare const SELF_TESTS: [string, number][]
export declare function selfTest(): number
