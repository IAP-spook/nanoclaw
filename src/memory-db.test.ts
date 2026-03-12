import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initMemorySchema,
  memorySave,
  memorySearch,
  memoryList,
  memoryDelete,
  rebuildMemoryFts,
  type MemoryEntry,
  type MemoryEntrySummary,
} from './memory-db.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initMemorySchema(db);
});

afterEach(() => {
  db.close();
});

describe('initMemorySchema', () => {
  it('creates memory_entries table with correct columns', () => {
    const columns = db
      .prepare("PRAGMA table_info('memory_entries')")
      .all() as { name: string }[];
    const names = columns.map((c) => c.name);
    expect(names).toContain('id');
    expect(names).toContain('group_folder');
    expect(names).toContain('title');
    expect(names).toContain('content');
    expect(names).toContain('tags');
    expect(names).toContain('source');
    expect(names).toContain('created_at');
    expect(names).toContain('updated_at');
  });

  it('creates memory_fts virtual table', () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'",
      )
      .all() as { name: string }[];
    expect(tables.length).toBe(1);
  });

  it('enforces unique constraint on group_folder + title', () => {
    db.prepare(
      `INSERT INTO memory_entries (group_folder, title, content, tags, source, created_at, updated_at)
       VALUES ('main', 'Test', 'content1', '[]', 'manual', '2026-01-01', '2026-01-01')`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO memory_entries (group_folder, title, content, tags, source, created_at, updated_at)
         VALUES ('main', 'Test', 'content2', '[]', 'manual', '2026-01-01', '2026-01-01')`,
        )
        .run(),
    ).toThrow();
  });

  it('allows same title in different groups', () => {
    db.prepare(
      `INSERT INTO memory_entries (group_folder, title, content, tags, source, created_at, updated_at)
       VALUES ('main', 'Test', 'content1', '[]', 'manual', '2026-01-01', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO memory_entries (group_folder, title, content, tags, source, created_at, updated_at)
       VALUES ('other', 'Test', 'content2', '[]', 'manual', '2026-01-01', '2026-01-01')`,
    ).run();

    const count = db
      .prepare('SELECT COUNT(*) as c FROM memory_entries')
      .get() as { c: number };
    expect(count.c).toBe(2);
  });
});

describe('memorySave', () => {
  it('inserts a new memory entry and returns id', () => {
    const result = memorySave(db, {
      groupFolder: 'main',
      title: 'Feishu API quirks',
      content: 'The image_key field can be nested or flat.',
      tags: ['feishu', 'api'],
      source: 'manual',
    });

    expect(result.id).toBeGreaterThan(0);

    const row = db
      .prepare('SELECT * FROM memory_entries WHERE id = ?')
      .get(result.id) as any;
    expect(row.title).toBe('Feishu API quirks');
    expect(row.group_folder).toBe('main');
    expect(row.content).toContain('image_key');
    expect(JSON.parse(row.tags)).toEqual(['feishu', 'api']);
    expect(row.source).toBe('manual');
  });

  it('upserts when title already exists in same group', () => {
    memorySave(db, {
      groupFolder: 'main',
      title: 'TDD principles',
      content: 'Original content',
      tags: ['dev'],
    });
    const result = memorySave(db, {
      groupFolder: 'main',
      title: 'TDD principles',
      content: 'Updated content with more detail',
      tags: ['dev', 'testing'],
    });

    const count = db
      .prepare(
        "SELECT COUNT(*) as c FROM memory_entries WHERE group_folder = 'main'",
      )
      .get() as { c: number };
    expect(count.c).toBe(1);

    const row = db
      .prepare('SELECT * FROM memory_entries WHERE id = ?')
      .get(result.id) as any;
    expect(row.content).toBe('Updated content with more detail');
    expect(JSON.parse(row.tags)).toEqual(['dev', 'testing']);
  });

  it('defaults source to manual when not provided', () => {
    const result = memorySave(db, {
      groupFolder: 'main',
      title: 'No source',
      content: 'Content',
      tags: [],
    });
    const row = db
      .prepare('SELECT source FROM memory_entries WHERE id = ?')
      .get(result.id) as any;
    expect(row.source).toBe('manual');
  });
});

describe('memorySearch', () => {
  beforeEach(() => {
    memorySave(db, {
      groupFolder: 'main',
      title: 'PyTorch training tips',
      content:
        'Use cosine annealing scheduler for better convergence. Gradient clipping at 1.0.',
      tags: ['ml', 'pytorch'],
    });
    memorySave(db, {
      groupFolder: 'main',
      title: 'Feishu webhook debugging',
      content:
        'The Feishu event subscription requires challenge verification first.',
      tags: ['feishu', 'debugging'],
    });
    memorySave(db, {
      groupFolder: 'global',
      title: 'Shared coding standards',
      content: 'Always use TDD. Write tests first.',
      tags: ['dev', 'standards'],
    });
    memorySave(db, {
      groupFolder: 'other-group',
      title: 'Secret other group data',
      content: 'This should not be visible to main.',
      tags: ['private'],
    });
  });

  it('finds entries by keyword in content', () => {
    const results = memorySearch(db, {
      groupFolder: 'main',
      query: 'cosine annealing',
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('PyTorch training tips');
  });

  it('finds entries by keyword in title', () => {
    const results = memorySearch(db, {
      groupFolder: 'main',
      query: 'Feishu webhook',
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Feishu webhook debugging');
  });

  it('includes global entries for non-main groups', () => {
    const results = memorySearch(db, {
      groupFolder: 'other-group',
      query: 'TDD',
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Shared coding standards');
    expect(results[0].groupFolder).toBe('global');
  });

  it('includes own group + global entries for main', () => {
    const results = memorySearch(db, {
      groupFolder: 'main',
      query: 'TDD OR pytorch',
    });
    expect(results.length).toBe(2);
    const titles = results.map((r) => r.title);
    expect(titles).toContain('PyTorch training tips');
    expect(titles).toContain('Shared coding standards');
  });

  it('excludes other groups entries', () => {
    const results = memorySearch(db, {
      groupFolder: 'main',
      query: 'Secret',
    });
    expect(results.length).toBe(0);
  });

  it('filters by tags using exact match', () => {
    const results = memorySearch(db, {
      groupFolder: 'main',
      query: 'training',
      tags: ['pytorch'],
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('PyTorch training tips');
  });

  it('tag filter does not match substrings', () => {
    // Searching for tag 'ml' should not match a hypothetical 'html' tag
    memorySave(db, {
      groupFolder: 'main',
      title: 'HTML rendering',
      content: 'Some HTML rendering notes',
      tags: ['html', 'frontend'],
    });
    const results = memorySearch(db, {
      groupFolder: 'main',
      query: 'rendering OR training',
      tags: ['ml'],
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('PyTorch training tips');
  });

  it('respects limit parameter', () => {
    const results = memorySearch(db, {
      groupFolder: 'main',
      query: 'Feishu OR PyTorch',
      limit: 1,
    });
    expect(results.length).toBe(1);
  });

  it('returns empty array for no matches', () => {
    const results = memorySearch(db, {
      groupFolder: 'main',
      query: 'nonexistent topic xyz',
    });
    expect(results.length).toBe(0);
  });
});

describe('memoryList', () => {
  beforeEach(() => {
    memorySave(db, {
      groupFolder: 'main',
      title: 'Entry A',
      content: 'Content A',
      tags: ['alpha'],
    });
    memorySave(db, {
      groupFolder: 'main',
      title: 'Entry B',
      content: 'Content B',
      tags: ['beta'],
    });
    memorySave(db, {
      groupFolder: 'global',
      title: 'Global Entry',
      content: 'Global content',
      tags: ['shared'],
    });
  });

  it('lists entries for own group + global', () => {
    const results = memoryList(db, { groupFolder: 'main' });
    expect(results.length).toBe(3);
  });

  it('returns summaries without content', () => {
    const results = memoryList(db, { groupFolder: 'main' });
    const first = results[0] as any;
    expect(first.title).toBeDefined();
    expect(first.tags).toBeDefined();
    expect(first.content).toBeUndefined();
  });

  it('filters by tags', () => {
    const results = memoryList(db, {
      groupFolder: 'main',
      tags: ['alpha'],
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Entry A');
  });

  it('returns sorted by updated_at descending', () => {
    // Force different timestamps
    db.prepare(
      "UPDATE memory_entries SET updated_at = '2026-01-01' WHERE title = 'Entry A'",
    ).run();
    db.prepare(
      "UPDATE memory_entries SET updated_at = '2026-03-01' WHERE title = 'Entry B'",
    ).run();

    const results = memoryList(db, { groupFolder: 'main' });
    const mainEntries = results.filter((r) => r.groupFolder !== 'global');
    expect(mainEntries[0].title).toBe('Entry B');
    expect(mainEntries[1].title).toBe('Entry A');
  });
});

describe('memoryDelete', () => {
  it('deletes an existing entry and returns true', () => {
    const { id } = memorySave(db, {
      groupFolder: 'main',
      title: 'To delete',
      content: 'Will be deleted',
      tags: [],
    });

    const deleted = memoryDelete(db, { id, groupFolder: 'main' });
    expect(deleted).toBe(true);

    const row = db
      .prepare('SELECT * FROM memory_entries WHERE id = ?')
      .get(id);
    expect(row).toBeUndefined();
  });

  it('returns false for non-existent entry', () => {
    const deleted = memoryDelete(db, { id: 99999, groupFolder: 'main' });
    expect(deleted).toBe(false);
  });

  it('refuses to delete entry from another group', () => {
    const { id } = memorySave(db, {
      groupFolder: 'other',
      title: 'Other group entry',
      content: 'Not yours',
      tags: [],
    });

    const deleted = memoryDelete(db, { id, groupFolder: 'main' });
    expect(deleted).toBe(false);

    // Entry still exists
    const row = db
      .prepare('SELECT * FROM memory_entries WHERE id = ?')
      .get(id);
    expect(row).toBeDefined();
  });

  it('main can delete global entries', () => {
    const { id } = memorySave(db, {
      groupFolder: 'global',
      title: 'Global to delete',
      content: 'Will be deleted by main',
      tags: [],
    });

    const deleted = memoryDelete(db, { id, groupFolder: 'main' });
    expect(deleted).toBe(true);
  });

  it('non-main cannot delete global entries', () => {
    const { id } = memorySave(db, {
      groupFolder: 'global',
      title: 'Protected global',
      content: 'Should not be deleted',
      tags: [],
    });

    const deleted = memoryDelete(db, { id, groupFolder: 'other' });
    expect(deleted).toBe(false);
  });

  it('removes entry from FTS index after delete', () => {
    const { id } = memorySave(db, {
      groupFolder: 'main',
      title: 'FTS cleanup test',
      content: 'Unique searchable content xyzzy',
      tags: [],
    });

    memoryDelete(db, { id, groupFolder: 'main' });

    // FTS should no longer find it
    const ftsResults = db
      .prepare(
        "SELECT * FROM memory_fts WHERE memory_fts MATCH 'xyzzy'",
      )
      .all();
    expect(ftsResults.length).toBe(0);
  });
});

describe('rebuildMemoryFts', () => {
  it('rebuilds FTS index from source table', () => {
    memorySave(db, {
      groupFolder: 'main',
      title: 'Rebuild test',
      content: 'Unique rebuild content qwerty',
      tags: ['rebuild'],
    });

    // Verify FTS works before
    let results = db
      .prepare("SELECT * FROM memory_fts WHERE memory_fts MATCH 'qwerty'")
      .all();
    expect(results.length).toBe(1);

    // Corrupt FTS by dropping and recreating without triggers
    db.exec('DROP TABLE memory_fts');
    db.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(
      title, content, tags,
      content=memory_entries,
      content_rowid=id
    )`);

    // FTS is now empty
    results = db
      .prepare("SELECT * FROM memory_fts WHERE memory_fts MATCH 'qwerty'")
      .all();
    expect(results.length).toBe(0);

    // Rebuild
    rebuildMemoryFts(db);

    // FTS works again
    results = db
      .prepare("SELECT * FROM memory_fts WHERE memory_fts MATCH 'qwerty'")
      .all();
    expect(results.length).toBe(1);
  });
});
