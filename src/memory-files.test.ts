/**
 * Tests for memory file sync — writes markdown files and INDEX.md
 * from memory entries in the database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { initMemorySchema, memorySave } from './memory-db.js';
import {
  syncMemoryFile,
  deleteMemoryFile,
  rebuildIndex,
  slugify,
} from './memory-files.js';

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  initMemorySchema(db);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-files-'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('slugify', () => {
  it('converts title to filename-safe slug', () => {
    expect(slugify('Feishu API image_key')).toBe('feishu-api-image-key');
  });

  it('handles CJK characters', () => {
    expect(slugify('飞书接口调试')).toBe('飞书接口调试');
  });

  it('collapses multiple separators', () => {
    expect(slugify('a -- b  c')).toBe('a-b-c');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugify('--hello--')).toBe('hello');
  });
});

describe('syncMemoryFile', () => {
  it('writes a markdown file with frontmatter', () => {
    const entry = memorySave(db, {
      groupFolder: 'main',
      title: 'PyTorch Training Tips',
      content: 'Use cosine annealing for LR scheduling.',
      tags: ['ml', 'pytorch'],
      source: 'manual',
    });

    syncMemoryFile(tmpDir, {
      id: entry.id,
      group_folder: 'main',
      title: 'PyTorch Training Tips',
      content: 'Use cosine annealing for LR scheduling.',
      tags: ['ml', 'pytorch'],
      source: 'manual',
      created_at: '2026-03-12T14:00:00',
      updated_at: '2026-03-12T14:00:00',
    });

    const memDir = path.join(tmpDir, 'main', 'memory');
    const files = fs.readdirSync(memDir).filter((f) => f !== 'INDEX.md');
    expect(files.length).toBe(1);
    expect(files[0]).toBe('pytorch-training-tips.md');

    const content = fs.readFileSync(path.join(memDir, files[0]), 'utf-8');
    expect(content).toContain('title: PyTorch Training Tips');
    expect(content).toContain('tags: [ml, pytorch]');
    expect(content).toContain('source: manual');
    expect(content).toContain('Use cosine annealing for LR scheduling.');
  });

  it('overwrites existing file on update', () => {
    const memDir = path.join(tmpDir, 'main', 'memory');

    syncMemoryFile(tmpDir, {
      id: 1,
      group_folder: 'main',
      title: 'Test Entry',
      content: 'Version 1',
      tags: [],
      source: 'manual',
      created_at: '2026-03-12T14:00:00',
      updated_at: '2026-03-12T14:00:00',
    });

    syncMemoryFile(tmpDir, {
      id: 1,
      group_folder: 'main',
      title: 'Test Entry',
      content: 'Version 2',
      tags: ['updated'],
      source: 'manual',
      created_at: '2026-03-12T14:00:00',
      updated_at: '2026-03-12T15:00:00',
    });

    const content = fs.readFileSync(
      path.join(memDir, 'test-entry.md'),
      'utf-8',
    );
    expect(content).toContain('Version 2');
    expect(content).toContain('tags: [updated]');
  });

  it('creates group memory directory if missing', () => {
    syncMemoryFile(tmpDir, {
      id: 1,
      group_folder: 'new-group',
      title: 'First Memory',
      content: 'Content',
      tags: [],
      source: 'auto',
      created_at: '2026-03-12T14:00:00',
      updated_at: '2026-03-12T14:00:00',
    });

    expect(
      fs.existsSync(
        path.join(tmpDir, 'new-group', 'memory', 'first-memory.md'),
      ),
    ).toBe(true);
  });
});

describe('deleteMemoryFile', () => {
  it('removes the markdown file', () => {
    const memDir = path.join(tmpDir, 'main', 'memory');

    syncMemoryFile(tmpDir, {
      id: 1,
      group_folder: 'main',
      title: 'To Delete',
      content: 'Will be removed',
      tags: [],
      source: 'manual',
      created_at: '2026-03-12T14:00:00',
      updated_at: '2026-03-12T14:00:00',
    });

    expect(fs.existsSync(path.join(memDir, 'to-delete.md'))).toBe(true);

    deleteMemoryFile(tmpDir, 'main', 'To Delete');

    expect(fs.existsSync(path.join(memDir, 'to-delete.md'))).toBe(false);
  });

  it('does nothing if file does not exist', () => {
    // Should not throw
    deleteMemoryFile(tmpDir, 'main', 'Nonexistent');
  });
});

describe('rebuildIndex', () => {
  it('generates INDEX.md from all memory entries', () => {
    memorySave(db, {
      groupFolder: 'main',
      title: 'PyTorch Tips',
      content: 'Use cosine annealing',
      tags: ['ml', 'pytorch'],
    });
    memorySave(db, {
      groupFolder: 'main',
      title: 'Docker Debugging',
      content: 'Check logs with docker logs -f',
      tags: ['docker', 'debugging'],
    });

    rebuildIndex(db, tmpDir, 'main');

    const indexPath = path.join(tmpDir, 'main', 'memory', 'INDEX.md');
    expect(fs.existsSync(indexPath)).toBe(true);

    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content).toContain('PyTorch Tips');
    expect(content).toContain('Docker Debugging');
    expect(content).toContain('ml, pytorch');
    expect(content).toContain('docker, debugging');
  });

  it('creates empty INDEX.md when no entries', () => {
    rebuildIndex(db, tmpDir, 'main');

    const indexPath = path.join(tmpDir, 'main', 'memory', 'INDEX.md');
    expect(fs.existsSync(indexPath)).toBe(true);

    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content).toContain('# Memory Index');
    // No entries listed
    expect(content).not.toContain('|');
  });

  it('only includes entries for the specified group', () => {
    memorySave(db, {
      groupFolder: 'main',
      title: 'Main Memory',
      content: 'For main',
      tags: [],
    });
    memorySave(db, {
      groupFolder: 'other',
      title: 'Other Memory',
      content: 'For other',
      tags: [],
    });

    rebuildIndex(db, tmpDir, 'main');

    const content = fs.readFileSync(
      path.join(tmpDir, 'main', 'memory', 'INDEX.md'),
      'utf-8',
    );
    expect(content).toContain('Main Memory');
    expect(content).not.toContain('Other Memory');
  });
});
