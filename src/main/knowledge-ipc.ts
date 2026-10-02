import { ipcMain } from 'electron'
import {
  type CreateKnowledgeInput,
  type KnowledgeFilter,
  archiveKnowledge,
  canDeleteSource,
  createKnowledge,
  derivedFrom,
  knowledgeCounts,
  isKnowledgeKind,
  isLinkKind,
  knowledgeMeta,
  linkKnowledge,
  listKnowledge,
  searchSourceCandidates,
  setKnowledgeKind,
  unlinkKnowledge,
  outgoingSources,
  unarchiveKnowledge,
  unverifyKnowledge,
  verifyKnowledge,
} from './db/knowledge'

/**
 * 知识库的 IPC 通道。
 *
 * 这里**没有"直接创建可用知识"的通道** —— createKnowledge 一律产出待确认，
 * 想变可用只能走 knowledge:verify，而它会对知识类条目检查来源。
 * 这条规则在 IPC 层也不开后门（方案 §4 第 2 步）。
 */
export function registerKnowledgeIpc(): void {
  ipcMain.handle('knowledge:list', (_e, filter: KnowledgeFilter) => listKnowledge(filter ?? {}))
  ipcMain.handle('knowledge:counts', () => knowledgeCounts())
  ipcMain.handle('knowledge:meta', (_e, id: number) => knowledgeMeta(id))
  ipcMain.handle('knowledge:create', (_e, input: CreateKnowledgeInput) => createKnowledge(input))
  ipcMain.handle('knowledge:verify', (_e, id: number, note: string) => verifyKnowledge(id, note))
  ipcMain.handle('knowledge:unverify', (_e, id: number, reason: string) => unverifyKnowledge(id, reason))
  ipcMain.handle('knowledge:archive', (_e, id: number) => {
    archiveKnowledge(id)
    return true
  })
  ipcMain.handle('knowledge:unarchive', (_e, id: number) => {
    unarchiveKnowledge(id)
    return true
  })
  ipcMain.handle('knowledge:setKind', (_e, id: number, kind: string) =>
    isKnowledgeKind(kind) ? setKnowledgeKind(id, kind) : { ok: false }
  )
  ipcMain.handle('knowledge:sources', (_e, id: number) => outgoingSources(id))
  ipcMain.handle('knowledge:link', (_e, id: number, sourceId: number, kind: string) => {
    linkKnowledge(id, sourceId, isLinkKind(kind) ? kind : 'derived_from')
    return true
  })
  ipcMain.handle('knowledge:unlink', (_e, id: number, title: string) => {
    unlinkKnowledge(id, title)
    return true
  })
  ipcMain.handle('knowledge:searchSources', (_e, query: string) => searchSourceCandidates(query))
  ipcMain.handle('knowledge:derivedFrom', (_e, sourceId: number) => derivedFrom(sourceId))
  ipcMain.handle('knowledge:canDelete', (_e, sourceId: number) => canDeleteSource(sourceId))
}
