/**
 * memoryIndex.ts
 *
 * Builds and queries a SQLite FTS5 index of all .md files under the memory root.
 * Runs server-side only (Next.js API routes / dev server).
 *
 * Database lives at: ~/Projects/tfl/memory/.studio-index.db
 * Root scanned:      ~/Projects/tfl/memory
 */

import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import os from 'os'
import { MemorySearchResult } from './types'

const MEMORY_ROOT = path.join(os.homedir(), 'Projects/tfl/memory')
const DB_PATH = path.join(MEMORY_ROOT, '.studio-index.db')

// Singleton DB connection (one per process)
let _db: Database.Database | null = null

function getDb(): Database.Database {
  if (_db) return _db
  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  return _db
}

function initSchema(db: Database.Database): void {
  // Drop and recreate on every startup (v1: full rebuild)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_files (
      path      TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      type      TEXT NOT NULL DEFAULT '',
      projects  TEXT NOT NULL DEFAULT '',
      created   TEXT NOT NULL DEFAULT '',
      updated   TEXT NOT NULL DEFAULT '',
      tags      TEXT NOT NULL DEFAULT '',
      status    TEXT NOT NULL DEFAULT 'active',
      body      TEXT NOT NULL DEFAULT ''
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      name,
      type,
      projects,
      tags,
      body,
      content=memory_files,
      content_rowid=rowid
    );
  `)
}

function collectMdFiles(dir: string, results: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    // Skip hidden files/dirs
    if (entry.name.startsWith('.')) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectMdFiles(fullPath, results)
    } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'MEMORY.md') {
      results.push(fullPath)
    }
  }
  return results
}

function normalizeProjects(raw: string | string[] | undefined): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String)
  return [String(raw)]
}

function normalizeTags(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String)
  return [String(raw)]
}

export function buildIndex(): { indexed: number } {
  const db = getDb()
  initSchema(db)

  // Clear existing data for a full rebuild
  db.exec(`DELETE FROM memory_fts; DELETE FROM memory_files;`)

  const files = collectMdFiles(MEMORY_ROOT)

  const insertFile = db.prepare(`
    INSERT OR REPLACE INTO memory_files (path, name, type, projects, created, updated, tags, status, body)
    VALUES (@path, @name, @type, @projects, @created, @updated, @tags, @status, @body)
  `)

  const insertFts = db.prepare(`
    INSERT INTO memory_fts (rowid, name, type, projects, tags, body)
    SELECT rowid, name, type, projects, tags, body FROM memory_files WHERE path = @path
  `)

  const insertMany = db.transaction((mdFiles: string[]) => {
    for (const filePath of mdFiles) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8')
        const parsed = matter(raw)
        const data = parsed.data as Record<string, unknown>

        const projects = normalizeProjects(data.projects as string | string[] | undefined)
        const tags = normalizeTags(data.tags)

        insertFile.run({
          path: filePath,
          name: String(data.name ?? path.basename(filePath, '.md')),
          type: String(data.type ?? ''),
          projects: projects.join(','),
          created: String(data.created ?? ''),
          updated: String(data.updated ?? ''),
          tags: tags.join(','),
          status: String(data.status ?? 'active'),
          body: parsed.content.trim(),
        })

        insertFts.run({ path: filePath })
      } catch {
        // Skip unreadable/unparseable files
      }
    }
  })

  insertMany(files)

  return { indexed: files.length }
}

export interface SearchOptions {
  query: string
  type?: string
  project?: string
  limit?: number
}

export function searchIndex(opts: SearchOptions): MemorySearchResult[] {
  const db = getDb()
  const { query, type, project, limit = 30 } = opts

  // Build WHERE clause for filters
  const conditions: string[] = []
  const params: Record<string, string | number> = { limit }

  if (type) {
    conditions.push(`mf.type = @type`)
    params.type = type
  }
  if (project) {
    // projects is a comma-joined string; use LIKE for simple substring match
    conditions.push(`(',' || mf.projects || ',') LIKE @project`)
    params.project = `%,${project},%`
  }

  const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : ''

  let rows: Array<Record<string, string>>

  if (query.trim()) {
    // FTS5 query — sanitize by wrapping in quotes to prevent syntax errors
    const ftsQuery = query.trim().replace(/"/g, '""')
    params.ftsQuery = `"${ftsQuery}"*`

    rows = db.prepare(`
      SELECT
        mf.path,
        mf.name,
        mf.type,
        mf.projects,
        mf.created,
        mf.updated,
        mf.tags,
        mf.status,
        snippet(memory_fts, 4, '', '', '…', 20) AS excerpt
      FROM memory_fts
      JOIN memory_files mf ON mf.rowid = memory_fts.rowid
      WHERE memory_fts MATCH @ftsQuery
      ${whereClause}
      ORDER BY rank
      LIMIT @limit
    `).all(params) as Array<Record<string, string>>
  } else if (type || project) {
    // No text query but filters active — list filtered files by updated desc
    rows = db.prepare(`
      SELECT
        mf.path,
        mf.name,
        mf.type,
        mf.projects,
        mf.created,
        mf.updated,
        mf.tags,
        mf.status,
        substr(mf.body, 1, 160) AS excerpt
      FROM memory_files mf
      WHERE 1=1 ${whereClause}
      ORDER BY mf.updated DESC
      LIMIT @limit
    `).all(params) as Array<Record<string, string>>
  } else {
    // No query, no filters — return most-recently-updated files
    rows = db.prepare(`
      SELECT
        path,
        name,
        type,
        projects,
        created,
        updated,
        tags,
        status,
        substr(body, 1, 160) AS excerpt
      FROM memory_files
      ORDER BY updated DESC
      LIMIT @limit
    `).all({ limit }) as Array<Record<string, string>>
  }

  return rows.map((row) => ({
    path: row.path,
    name: row.name,
    type: row.type,
    projects: row.projects ? row.projects.split(',').filter(Boolean) : [],
    created: row.created,
    updated: row.updated,
    tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
    status: row.status,
    excerpt: row.excerpt ?? '',
  }))
}

export function getAllTypes(): string[] {
  const db = getDb()
  const rows = db.prepare(`SELECT DISTINCT type FROM memory_files WHERE type != '' ORDER BY type`).all() as Array<{ type: string }>
  return rows.map((r) => r.type)
}

export function getAllProjects(): string[] {
  const db = getDb()
  const rows = db.prepare(`SELECT DISTINCT projects FROM memory_files WHERE projects != ''`).all() as Array<{ projects: string }>
  const all = new Set<string>()
  for (const row of rows) {
    for (const p of row.projects.split(',').filter(Boolean)) {
      all.add(p)
    }
  }
  return Array.from(all).sort()
}
