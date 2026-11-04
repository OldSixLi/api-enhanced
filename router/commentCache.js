/**
 * 歌曲评论数缓存（基于 Node 内置 node:sqlite，无需安装任何依赖）
 *
 * 为什么需要缓存：
 * 网易云没有任何"批量拿评论数"的接口，只能逐首查 /api/v2/resource/comments，
 * 且服务端限流约 40 req/s（并发 100→200 只快 8%）。所以减少重复请求是唯一有效手段。
 *
 * 数据库文件：data/comment-count.db（WAL 模式，重启后缓存依然有效）
 */
const path = require('path')
const fs = require('fs')
const { DatabaseSync } = require('node:sqlite')

const DB_DIR = path.resolve(__dirname, '../data')
const DB_PATH = path.join(DB_DIR, 'comment-count.db')

// SQLite 单条 SQL 的绑定变量数有上限，分批查询/写入
const CHUNK = 500

let db = null

function getDb() {
  if (db) return db
  fs.mkdirSync(DB_DIR, { recursive: true })
  db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS music_comment_count (
      id INTEGER PRIMARY KEY,
      count INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_music_comment_updated ON music_comment_count(updated_at)',
  )
  return db
}

/**
 * 批量读取未过期的评论数
 * @param {number[]} ids 歌曲 ID 列表
 * @param {number} ttlMs 有效期（毫秒）
 * @returns {Map<number, number>} 只包含命中且未过期的项
 */
function getCachedCounts(ids, ttlMs) {
  const result = new Map()
  if (!Array.isArray(ids) || ids.length === 0) return result

  const d = getDb()
  const cutoff = Date.now() - ttlMs

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const stmt = d.prepare(
      `SELECT id, count FROM music_comment_count WHERE updated_at >= ? AND id IN (${placeholders})`,
    )
    const rows = stmt.all(cutoff, ...chunk)
    for (const row of rows) {
      result.set(row.id, row.count)
    }
  }

  return result
}

/**
 * 批量写入/更新评论数
 * @param {Array<[number, number]>} entries [[id, count], ...]
 */
function saveCounts(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 0

  const d = getDb()
  const stmt = d.prepare(`
    INSERT INTO music_comment_count (id, count, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at
  `)
  const now = Date.now()
  let saved = 0

  d.exec('BEGIN')
  try {
    for (const [id, count] of entries) {
      if (!Number.isFinite(id) || !Number.isFinite(count) || count < 0) continue
      stmt.run(id, count, now)
      saved++
    }
    d.exec('COMMIT')
  } catch (error) {
    d.exec('ROLLBACK')
    throw error
  }

  return saved
}

/** 清理早于指定时间的旧记录，避免数据库无限增长 */
function purgeOlderThan(maxAgeMs) {
  const d = getDb()
  const cutoff = Date.now() - maxAgeMs
  const info = d
    .prepare('DELETE FROM music_comment_count WHERE updated_at < ?')
    .run(cutoff)
  return info.changes || 0
}

/** 缓存条目总数（用于观察） */
function stats() {
  const d = getDb()
  const row = d.prepare('SELECT COUNT(*) AS n FROM music_comment_count').get()
  const size = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0
  return { rows: row ? row.n : 0, dbBytes: size, dbPath: DB_PATH }
}

function closeDb() {
  if (db) {
    try {
      db.close()
    } catch (_) {}
    db = null
  }
}

module.exports = {
  getCachedCounts,
  saveCounts,
  purgeOlderThan,
  stats,
  closeDb,
  DB_PATH,
}
