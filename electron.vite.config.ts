import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react()],
    server: {
      watch: {
        /**
         * 忽略编辑工具留下的临时目录。
         *
         * 编辑器/工具写文件时会先落一个 `.<name>.<pid>.<hash>.tmpdir` 再改名，
         * 而 Vite 的 watcher 会去监听它 —— 那个目录可能已被删掉或仍被占用，
         * 于是 watch 报 EBUSY 直接把 dev 进程带崩（实测就是这么挂的）。
         */
        ignored: ['**/*.tmpdir/**', '**/.*.tmp', '**/*.tmpdir'],
      },
    },
  },
})
