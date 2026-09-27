/**
 * E2E 脚本的预加载钩子。
 *
 * 背景：这台机器上 PATH 里没有 node，E2E 脚本是用 Electron 自己的 Node 模式跑的
 * （`ELECTRON_RUN_AS_NODE=1 electron scripts/xxx.mjs`）。而脚本启动应用时普遍写的是
 * `env: { ...process.env, ... }` —— 那个变量于是被原样传给了子进程，让「被启动的应用」
 * 也以 Node 模式起来：不开窗、不开调试端口，脚本一直等到超时后报
 * 「✗ 无法连接」，日志里却没有任何报错。
 *
 * 做法：在脚本进程启动时就把父进程的这个变量摘掉。当前进程的运行模式在启动那一刻
 * 就已经确定，删环境变量不会影响它；此后 spawn 出去的应用才是真正的 GUI Electron。
 *
 * 用法：`electron --require scripts/lib/e2e-env.cjs scripts/xxx.mjs`
 * （`scripts/lib/cdp.mjs` 内部另有一道同样的防御，新脚本两条都吃得到。）
 */
delete process.env.ELECTRON_RUN_AS_NODE
