/**
 * 「静默失败」的统一出口（主进程与渲染层共用）。
 *
 * 审计把它列为中优先项：一批 catch 之后直接返回 [] / false / 兜底文案，
 * 上层因此分不清「本来就没有」和「出错了」。命名点名的三处是
 * fts.searchIndex、graph.removeGraphEdge、graph.graphPreview。
 *
 * 处理原则是**先让它可见，再谈要不要改返回类型**：
 *  - 行为保持不变（该返回 [] 还是 []、该返回 false 还是 false），否则会牵动
 *    所有调用方与渲染层分支，那是另一件事；
 *  - 但必须留下一条带上下文的记录，否则出问题时连「哪个查询、哪条连线、哪个目录」都不知道。
 *
 * 返回日志行是为了单测能直接断言这行字，不必去 spy console。
 */
export function quietFailure(scope: string, err: unknown, detail = ''): string {
  const msg = err instanceof Error ? err.message : String(err)
  const line = '[静默失败] ' + scope + (detail ? '（' + detail + '）' : '') + '：' + msg
  console.warn(line)
  return line
}
