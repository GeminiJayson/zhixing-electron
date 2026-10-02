import { db } from '../db/connection'
import {
  KDF_DEFAULTS,
  type KdfParams,
  checkVerifier,
  decryptField,
  deriveKey,
  encryptField,
  fieldAad,
  makeVerifier,
  newSalt,
} from './crypto'

/**
 * 密码保险箱的数据层与会话。
 *
 * 设计见 docs/specs/vault-design.md。三条硬约束在这里落地：
 *   1. **密文落库**：所有文本字段以 (密文, IV) 存储，标题也不例外；
 *   2. **主密钥只在内存**：不出这个模块，不进数据库，渲染层拿不到；
 *   3. **不碰 FTS / 回收站 / 版本历史**：这三处都会让明文或历史副本留在地上。
 */

export interface VaultEntryInput {
  title: string
  username: string
  password: string
  url: string
  notes: string
  tags: string[]
}

export interface VaultEntry extends VaultEntryInput {
  id: number
  created_at: string
  updated_at: string
}

export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked'

export interface VaultResult {
  ok: boolean
  message?: string
}

interface MetaRow {
  kdf_salt: Buffer
  kdf_params: string
  verifier_ct: Buffer
  verifier_iv: Buffer
}

/**
 * 主密钥。**只在这个模块里存在** —— 没有 getter，没有导出。
 * 锁定 = 置 null，配合下面的缓存一起丢弃。
 */
let sessionKey: Buffer | null = null

/**
 * 解锁后的明文缓存。
 *
 * 每次读列表都全表解密是可行的（条目量级几十到几百），但排序 + 搜索会让它
 * 变成每次按键一次全解，所以缓存一份。生命周期**严格等于解锁会话**。
 */
let cache: VaultEntry[] | null = null

/** 最近一次交互时间，用于自动锁定。 */
let lastActivity = 0

function requireDb(): NonNullable<typeof db> {
  if (!db) throw new Error('数据库未就绪')
  return db
}

export function status(): VaultStatus {
  const c = requireDb()
  const row = c.prepare('SELECT id FROM vault_meta WHERE id = 1').get()
  if (!row) return 'uninitialized'
  return sessionKey ? 'unlocked' : 'locked'
}

function readMeta(): MetaRow | undefined {
  return requireDb()
    .prepare('SELECT kdf_salt, kdf_params, verifier_ct, verifier_iv FROM vault_meta WHERE id = 1')
    .get() as MetaRow | undefined
}

function parseParams(raw: string): KdfParams {
  try {
    const p = JSON.parse(raw) as Partial<KdfParams>
    if (
      typeof p.N === 'number' &&
      typeof p.r === 'number' &&
      typeof p.p === 'number' &&
      typeof p.keylen === 'number'
    ) {
      return { N: p.N, r: p.r, p: p.p, keylen: p.keylen }
    }
  } catch {
    // 参数坏掉时退回默认值：宁可解锁慢一点，也不要让库打不开
  }
  return KDF_DEFAULTS
}

// ---------------------------------------------------------------- 生命周期

/** 首次设置主密码。已经初始化过就拒绝，避免误操作覆盖掉整库。 */
export function setup(password: string): VaultResult {
  const c = requireDb()
  if (c.prepare('SELECT id FROM vault_meta WHERE id = 1').get()) {
    return { ok: false, message: '保险箱已经初始化过了' }
  }
  const salt = newSalt()
  const key = deriveKey(password, salt, KDF_DEFAULTS)
  const verifier = makeVerifier(key)
  c.prepare(
    'INSERT INTO vault_meta (id, kdf_salt, kdf_params, verifier_ct, verifier_iv, created_at) ' +
      'VALUES (1, ?, ?, ?, ?, ?)'
  ).run(salt, JSON.stringify(KDF_DEFAULTS), verifier.ct, verifier.iv, new Date().toISOString())
  sessionKey = key
  cache = []
  touch()
  return { ok: true }
}

/**
 * 解锁。密码错误一律返回同一句话，不区分"密码不对"与"数据损坏" ——
 * 区分开来只会给试探者提供信息（见方案 §7.2）。
 */
export function unlock(password: string): VaultResult {
  const meta = readMeta()
  if (!meta) return { ok: false, message: '保险箱还没有初始化' }
  const key = deriveKey(password, meta.kdf_salt, parseParams(meta.kdf_params))
  if (!checkVerifier(key, meta.verifier_ct, meta.verifier_iv)) {
    return { ok: false, message: '主密码不正确' }
  }
  sessionKey = key
  cache = null
  touch()
  return { ok: true }
}

/** 锁定：主密钥与缓存一起丢弃。这是"锁定"这件事的全部含义。 */
export function lock(): void {
  if (sessionKey) sessionKey.fill(0)
  sessionKey = null
  cache = null
}

/** 刷新活动时间。渲染层每次操作都会调。 */
export function touch(): void {
  lastActivity = Date.now()
}

export function idleMs(): number {
  return lastActivity === 0 ? 0 : Date.now() - lastActivity
}

/**
 * 清空保险箱并重设主密码。
 * 这是忘记主密码后**唯一**的出路 —— 数据一并删掉，不做任何"尝试恢复"。
 */
export function destroy(): VaultResult {
  const c = requireDb()
  const tx = c.transaction(() => {
    c.prepare('DELETE FROM vault_entry').run()
    c.prepare('DELETE FROM vault_meta').run()
  })
  tx()
  lock()
  return { ok: true }
}

// ---------------------------------------------------------------- 条目读写

function requireKey(): Buffer {
  if (!sessionKey) throw new Error('保险箱未解锁')
  return sessionKey
}

function enc(key: Buffer, id: number | 'new', field: string, value: string): { ct: Buffer; iv: Buffer } {
  return encryptField(key, value, fieldAad(id, field))
}

function dec(key: Buffer, id: number, field: string, ct: Buffer | null, iv: Buffer | null): string {
  if (!ct || !iv) return ''
  return decryptField(key, ct, iv, fieldAad(id, field)) ?? ''
}

interface EntryRow {
  id: number
  title_ct: Buffer
  title_iv: Buffer
  username_ct: Buffer | null
  username_iv: Buffer | null
  password_ct: Buffer
  password_iv: Buffer
  url_ct: Buffer | null
  url_iv: Buffer | null
  notes_ct: Buffer | null
  notes_iv: Buffer | null
  tags_ct: Buffer | null
  tags_iv: Buffer | null
  created_at: string
  updated_at: string
}

function rowToEntry(key: Buffer, r: EntryRow): VaultEntry {
  let tags: string[] = []
  const rawTags = dec(key, r.id, 'tags', r.tags_ct, r.tags_iv)
  if (rawTags) {
    try {
      const parsed = JSON.parse(rawTags) as unknown
      if (Array.isArray(parsed)) tags = parsed.filter((x): x is string => typeof x === 'string')
    } catch {
      // 标签解出来不是 JSON：当作没有标签，不让一条坏数据毁掉整个列表
    }
  }
  return {
    id: r.id,
    title: dec(key, r.id, 'title', r.title_ct, r.title_iv),
    username: dec(key, r.id, 'username', r.username_ct, r.username_iv),
    password: dec(key, r.id, 'password', r.password_ct, r.password_iv),
    url: dec(key, r.id, 'url', r.url_ct, r.url_iv),
    notes: dec(key, r.id, 'notes', r.notes_ct, r.notes_iv),
    tags,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

/** 列表。走缓存；缓存为空时全表解密一次并填入。 */
export function list(): VaultEntry[] {
  const key = requireKey()
  if (cache) return cache
  const rows = requireDb()
    .prepare('SELECT * FROM vault_entry ORDER BY updated_at DESC, id DESC')
    .all() as EntryRow[]
  cache = rows.map((r) => rowToEntry(key, r))
  return cache
}

/**
 * 新建。
 *
 * **为什么要"先插占位再更新"**：AAD 绑定了条目 id，而 id 在插入前是未知的。
 * 所以在一个事务里先插入一行空密文拿到 id，再用真实 id 作为 AAD 加密并回填。
 * 两件事必须在同一事务里，否则中途失败会留下一条打不开的条目。
 */
export function create(input: VaultEntryInput): VaultEntry {
  const c = requireDb()
  const key = requireKey()
  const now = new Date().toISOString()
  const placeholder = Buffer.alloc(0)

  const entry = c.transaction((): VaultEntry => {
    const info = c
      .prepare(
        'INSERT INTO vault_entry (title_ct, title_iv, password_ct, password_iv, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(placeholder, placeholder, placeholder, placeholder, now, now)
    const id = Number(info.lastInsertRowid)
    writeFields(key, id, input, now)
    return { id, ...input, created_at: now, updated_at: now }
  })()

  cache = null
  touch()
  return entry
}

/** 更新。字段整体重写（明文→新密文），不做字段级 diff。 */
export function update(id: number, input: VaultEntryInput): VaultResult {
  const c = requireDb()
  const key = requireKey()
  const exists = c.prepare('SELECT id FROM vault_entry WHERE id = ?').get(id)
  if (!exists) return { ok: false, message: '条目不存在' }
  const now = new Date().toISOString()
  c.transaction(() => writeFields(key, id, input, now))()
  cache = null
  touch()
  return { ok: true }
}

/** 把明文字段整体加密写回一行。id 必须是已经存在的。 */
function writeFields(key: Buffer, id: number, input: VaultEntryInput, now: string): void {
  const t = enc(key, id, 'title', input.title)
  const u = enc(key, id, 'username', input.username)
  const p = enc(key, id, 'password', input.password)
  const l = enc(key, id, 'url', input.url)
  const n = enc(key, id, 'notes', input.notes)
  const g = enc(key, id, 'tags', JSON.stringify(input.tags))
  requireDb()
    .prepare(
      'UPDATE vault_entry SET title_ct=?, title_iv=?, username_ct=?, username_iv=?, ' +
        'password_ct=?, password_iv=?, url_ct=?, url_iv=?, notes_ct=?, notes_iv=?, ' +
        'tags_ct=?, tags_iv=?, updated_at=? WHERE id=?'
    )
    .run(t.ct, t.iv, u.ct, u.iv, p.ct, p.iv, l.ct, l.iv, n.ct, n.iv, g.ct, g.iv, now, id)
}

/**
 * 删除。**真删**，不进回收站 —— 回收站会留下密文副本，
 * 虽然解不开，但会让"删掉了"这件事变得不成立。
 */
export function remove(id: number): VaultResult {
  const info = requireDb().prepare('DELETE FROM vault_entry WHERE id = ?').run(id)
  cache = null
  touch()
  return info.changes > 0 ? { ok: true } : { ok: false, message: '条目不存在' }
}

/**
 * 批量导入（来自浏览器密码库）。
 *
 * **每条都走 create()，也就是用保险箱自己的 AES-GCM 重新加密一遍** ——
 * 浏览器那边的 DPAPI 密文不会被搬进来，导入后原文不再以任何形式存在。
 *
 * 导入前会跳过标题重复的条目（同一个站点重复导入不该产生一堆副本）；
 * 判重只看标题，因为标题是"站点的可读名字"，那正是用户判断重复的依据。
 */
export function importEntries(items: { title: string; username: string; password: string; url: string }[]): {
  imported: number
  skipped: number
} {
  const existing = new Set(list().map((e) => e.title))
  let imported = 0
  let skipped = 0
  for (const it of items) {
    const title = it.title.trim() || it.url || '(无标题)'
    if (existing.has(title)) {
      skipped++
      continue
    }
    create({
      title,
      username: it.username,
      password: it.password,
      url: it.url,
      notes: '',
      tags: ['导入'],
    })
    existing.add(title)
    imported++
  }
  return { imported, skipped }
}

/** 仅测试用：把会话状态清干净，避免用例之间互相影响。 */
export function resetForTest(): void {
  lock()
  lastActivity = 0
}
