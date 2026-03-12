/**
 * Memory database layer for NanoClaw long-term memory system.
 * Provides CRUD operations and FTS5 full-text search for memory entries.
 */
import type Database from 'better-sqlite3';

export interface MemoryEntry {
  id: number;
  groupFolder: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEntrySummary {
  id: number;
  groupFolder: string;
  title: string;
  tags: string[];
  source: string;
  updatedAt: string;
}

export interface MemorySaveInput {
  groupFolder: string;
  title: string;
  content: string;
  tags: string[];
  source?: string;
}

export interface MemorySearchInput {
  groupFolder: string;
  query: string;
  tags?: string[];
  limit?: number;
}

export interface MemoryListInput {
  groupFolder: string;
  tags?: string[];
}

export interface MemoryDeleteInput {
  id: number;
  groupFolder: string;
}

/** Create memory_entries table, FTS5 virtual table, and sync triggers. */
export function initMemorySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(group_folder, title)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_group ON memory_entries(group_folder);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      title, content, tags,
      content=memory_entries,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, title, content, tags)
      VALUES ('delete', old.id, old.title, old.content, old.tags);
      INSERT INTO memory_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, title, content, tags)
      VALUES ('delete', old.id, old.title, old.content, old.tags);
    END;
  `);
}

/** Save or update a memory entry. Returns the entry id. */
export function memorySave(
  db: Database.Database,
  input: MemorySaveInput,
): { id: number } {
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(input.tags);
  const source = input.source ?? 'manual';

  const stmt = db.prepare(`
    INSERT INTO memory_entries (group_folder, title, content, tags, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_folder, title) DO UPDATE SET
      content = excluded.content,
      tags = excluded.tags,
      source = excluded.source,
      updated_at = excluded.updated_at
  `);

  const result = stmt.run(
    input.groupFolder,
    input.title,
    input.content,
    tagsJson,
    source,
    now,
    now,
  );

  // For upserts, lastInsertRowid is 0 on update — fetch the actual id
  if (result.lastInsertRowid === 0) {
    const row = db
      .prepare(
        'SELECT id FROM memory_entries WHERE group_folder = ? AND title = ?',
      )
      .get(input.groupFolder, input.title) as { id: number };
    return { id: row.id };
  }

  return { id: Number(result.lastInsertRowid) };
}

/** Search memory entries using FTS5 full-text search. */
export function memorySearch(
  db: Database.Database,
  input: MemorySearchInput,
): MemoryEntry[] {
  const limit = input.limit ?? 10;
  const allowedGroups = [input.groupFolder, 'global'];

  const placeholders = allowedGroups.map(() => '?').join(', ');

  let sql: string;
  let params: unknown[];

  if (input.tags && input.tags.length > 0) {
    // FTS match + tag filter using json_each
    const tagPlaceholders = input.tags.map(() => '?').join(', ');
    sql = `
      SELECT me.id, me.group_folder, me.title, me.content, me.tags, me.source,
             me.created_at, me.updated_at
      FROM memory_entries me
      JOIN memory_fts ON me.id = memory_fts.rowid
      WHERE memory_fts MATCH ?
        AND me.group_folder IN (${placeholders})
        AND EXISTS (
          SELECT 1 FROM json_each(me.tags) je
          WHERE je.value IN (${tagPlaceholders})
        )
      ORDER BY rank
      LIMIT ?
    `;
    params = [input.query, ...allowedGroups, ...input.tags, limit];
  } else {
    sql = `
      SELECT me.id, me.group_folder, me.title, me.content, me.tags, me.source,
             me.created_at, me.updated_at
      FROM memory_entries me
      JOIN memory_fts ON me.id = memory_fts.rowid
      WHERE memory_fts MATCH ?
        AND me.group_folder IN (${placeholders})
      ORDER BY rank
      LIMIT ?
    `;
    params = [input.query, ...allowedGroups, limit];
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    group_folder: string;
    title: string;
    content: string;
    tags: string;
    source: string;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    groupFolder: row.group_folder,
    title: row.title,
    content: row.content,
    tags: JSON.parse(row.tags),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** List memory entries (summaries without content). */
export function memoryList(
  db: Database.Database,
  input: MemoryListInput,
): MemoryEntrySummary[] {
  const allowedGroups = [input.groupFolder, 'global'];
  const placeholders = allowedGroups.map(() => '?').join(', ');

  let sql: string;
  let params: unknown[];

  if (input.tags && input.tags.length > 0) {
    const tagPlaceholders = input.tags.map(() => '?').join(', ');
    sql = `
      SELECT id, group_folder, title, tags, source, updated_at
      FROM memory_entries
      WHERE group_folder IN (${placeholders})
        AND EXISTS (
          SELECT 1 FROM json_each(tags) je
          WHERE je.value IN (${tagPlaceholders})
        )
      ORDER BY updated_at DESC
    `;
    params = [...allowedGroups, ...input.tags];
  } else {
    sql = `
      SELECT id, group_folder, title, tags, source, updated_at
      FROM memory_entries
      WHERE group_folder IN (${placeholders})
      ORDER BY updated_at DESC
    `;
    params = [...allowedGroups];
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    group_folder: string;
    title: string;
    tags: string;
    source: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    groupFolder: row.group_folder,
    title: row.title,
    tags: JSON.parse(row.tags),
    source: row.source,
    updatedAt: row.updated_at,
  }));
}

/** Delete a memory entry. Enforces group isolation. */
export function memoryDelete(
  db: Database.Database,
  input: MemoryDeleteInput,
): boolean {
  // Check entry exists and authorization
  const row = db
    .prepare('SELECT group_folder FROM memory_entries WHERE id = ?')
    .get(input.id) as { group_folder: string } | undefined;

  if (!row) return false;

  // Allow: own group, or main deleting global
  const isOwn = row.group_folder === input.groupFolder;
  const isMainDeletingGlobal =
    input.groupFolder === 'main' && row.group_folder === 'global';

  if (!isOwn && !isMainDeletingGlobal) return false;

  db.prepare('DELETE FROM memory_entries WHERE id = ?').run(input.id);
  return true;
}

/** Rebuild FTS index from source table. */
export function rebuildMemoryFts(db: Database.Database): void {
  db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
}
