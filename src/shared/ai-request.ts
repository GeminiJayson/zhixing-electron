import type { AiAuthMode, AiProtocol } from './ai-note'

/**
 * 去掉 Key 里自带的 `Bearer ` 前缀。
 *
 * 不少服务（以及中转面板）直接给你一串 "Bearer sk-…"：照拼会变成
 * `Bearer Bearer sk-…`，服务端只当你给了一个非法 token —— 报 401 却看不出原因。
 * 前后空白也一并去掉（从网页复制粘贴很容易带上）。
 */
export function bareKey(key: string | null | undefined): string {
  return (key ?? '').trim().replace(/^Bearer\s+/i, '')
}

/** 实际采用的鉴权方式：显式指定优先，否则按协议推断。 */
export function resolveAiAuth(mode: AiAuthMode | undefined, protocol: AiProtocol): Exclude<AiAuthMode, 'auto'> {
  if (mode && mode !== 'auto') return mode
  if (protocol === 'anthropic') return 'x-api-key'
  if (protocol === 'gemini') return 'query'
  return 'bearer'
}
