import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 单元测试只覆盖 src/shared 下的纯函数（settings / capture / deep-link / priority /
 * recurrence / task / wiki / theme-packs）。
 *
 * 涉及 SQLite、IPC 与真实窗口的检查仍留在 scripts/*.mjs —— 那些要在 Electron 里
 * 跑 CDP 并落到副本库上验证，用 vitest 包一层只会更难调试。
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
