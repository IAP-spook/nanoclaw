/**
 * Tests for memory seed (CLAUDE.md migration).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { initMemorySchema, memoryList } from './memory-db.js';
import { seedMemoryEntries } from './memory-seed.js';

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  initMemorySchema(db);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-seed-'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('seedMemoryEntries', () => {
  it('seeds all entries and creates files', () => {
    const count = seedMemoryEntries(db, tmpDir, 'main');
    expect(count).toBeGreaterThan(0);

    const entries = memoryList(db, { groupFolder: 'main' });
    expect(entries.length).toBe(count);

    // Files exist
    const memDir = path.join(tmpDir, 'main', 'memory');
    const files = fs.readdirSync(memDir).filter((f) => f !== 'INDEX.md');
    expect(files.length).toBe(count);

    // INDEX.md exists and has entries
    const index = fs.readFileSync(path.join(memDir, 'INDEX.md'), 'utf-8');
    expect(index).toContain('Container Mounts');
    expect(index).toContain('Group Management');
  });

  it('is idempotent (upsert on re-run)', () => {
    seedMemoryEntries(db, tmpDir, 'main');
    const firstCount = memoryList(db, { groupFolder: 'main' }).length;

    seedMemoryEntries(db, tmpDir, 'main');
    const secondCount = memoryList(db, { groupFolder: 'main' }).length;

    expect(secondCount).toBe(firstCount);
  });

  it('all entries have source "migration"', () => {
    seedMemoryEntries(db, tmpDir, 'main');
    const entries = memoryList(db, { groupFolder: 'main' });
    for (const e of entries) {
      expect(e.source).toBe('migration');
    }
  });
});
