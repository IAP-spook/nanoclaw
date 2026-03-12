/**
 * Tests for the memory HTTP client that runs inside containers.
 * Spins up a real memory API server and tests the client against it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { initMemorySchema } from './memory-db.js';
import { createMemoryHandler } from './memory-api.js';
import {
  memoryClientSave,
  memoryClientSearch,
  memoryClientList,
  memoryClientDelete,
} from '../container/agent-runner/src/memory-client.js';

let db: Database.Database;
let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  db = new Database(':memory:');
  initMemorySchema(db);

  const handler = createMemoryHandler(db);
  server = http.createServer(handler);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
});

describe('memoryClientSave', () => {
  it('saves a memory and returns id', async () => {
    const result = await memoryClientSave(baseUrl, {
      group_folder: 'main',
      title: 'Client test',
      content: 'Saved via client',
      tags: ['test'],
    });
    expect(result.id).toBeGreaterThan(0);
  });

  it('upserts on duplicate title', async () => {
    await memoryClientSave(baseUrl, {
      group_folder: 'main',
      title: 'Upsert',
      content: 'Version 1',
      tags: [],
    });
    const result = await memoryClientSave(baseUrl, {
      group_folder: 'main',
      title: 'Upsert',
      content: 'Version 2',
      tags: ['updated'],
    });
    expect(result.id).toBeGreaterThan(0);

    const list = await memoryClientList(baseUrl, { group_folder: 'main' });
    const matches = list.filter((e) => e.title === 'Upsert');
    expect(matches.length).toBe(1);
  });
});

describe('memoryClientSearch', () => {
  beforeEach(async () => {
    await memoryClientSave(baseUrl, {
      group_folder: 'main',
      title: 'PyTorch training',
      content: 'Use cosine annealing for learning rate',
      tags: ['ml', 'pytorch'],
    });
    await memoryClientSave(baseUrl, {
      group_folder: 'main',
      title: 'Docker tips',
      content: 'Check logs with docker logs -f',
      tags: ['docker'],
    });
  });

  it('finds entries by keyword', async () => {
    const results = await memoryClientSearch(baseUrl, {
      group_folder: 'main',
      query: 'cosine annealing',
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('PyTorch training');
  });

  it('filters by tags', async () => {
    const results = await memoryClientSearch(baseUrl, {
      group_folder: 'main',
      query: 'cosine OR docker',
      tags: ['docker'],
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Docker tips');
  });

  it('returns empty for no matches', async () => {
    const results = await memoryClientSearch(baseUrl, {
      group_folder: 'main',
      query: 'nonexistent xyz',
    });
    expect(results.length).toBe(0);
  });
});

describe('memoryClientList', () => {
  it('lists all entries for group', async () => {
    await memoryClientSave(baseUrl, {
      group_folder: 'main',
      title: 'A',
      content: 'Content A',
      tags: [],
    });
    await memoryClientSave(baseUrl, {
      group_folder: 'main',
      title: 'B',
      content: 'Content B',
      tags: ['x'],
    });

    const list = await memoryClientList(baseUrl, { group_folder: 'main' });
    expect(list.length).toBe(2);
    // Summaries have no content field
    expect((list[0] as any).content).toBeUndefined();
  });

  it('filters by tags', async () => {
    await memoryClientSave(baseUrl, {
      group_folder: 'main',
      title: 'Tagged',
      content: 'Has tag',
      tags: ['special'],
    });
    await memoryClientSave(baseUrl, {
      group_folder: 'main',
      title: 'Untagged',
      content: 'No special tag',
      tags: [],
    });

    const list = await memoryClientList(baseUrl, {
      group_folder: 'main',
      tags: ['special'],
    });
    expect(list.length).toBe(1);
    expect(list[0].title).toBe('Tagged');
  });
});

describe('memoryClientDelete', () => {
  it('deletes an entry', async () => {
    const { id } = await memoryClientSave(baseUrl, {
      group_folder: 'main',
      title: 'To delete',
      content: 'Will be removed',
      tags: [],
    });

    const result = await memoryClientDelete(baseUrl, {
      id,
      group_folder: 'main',
    });
    expect(result.deleted).toBe(true);

    const list = await memoryClientList(baseUrl, { group_folder: 'main' });
    expect(list.length).toBe(0);
  });

  it('returns deleted false for non-existent', async () => {
    const result = await memoryClientDelete(baseUrl, {
      id: 99999,
      group_folder: 'main',
    });
    expect(result.deleted).toBe(false);
  });
});
