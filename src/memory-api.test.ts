import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { initMemorySchema, memorySave } from './memory-db.js';
import { createMemoryHandler } from './memory-api.js';

let db: Database.Database;
let server: http.Server;
let port: number;

function request(
  method: string,
  path: string,
  body?: object,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode!, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

beforeEach(async () => {
  db = new Database(':memory:');
  initMemorySchema(db);

  const handler = createMemoryHandler(db);
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
});

describe('POST /memory/save', () => {
  it('saves a new memory entry', async () => {
    const res = await request('POST', '/memory/save', {
      group_folder: 'main',
      title: 'Test memory',
      content: 'Some content',
      tags: ['test'],
    });

    expect(res.status).toBe(200);
    expect(res.body.id).toBeGreaterThan(0);
  });

  it('upserts existing entry', async () => {
    await request('POST', '/memory/save', {
      group_folder: 'main',
      title: 'Upsert test',
      content: 'Version 1',
      tags: [],
    });
    const res = await request('POST', '/memory/save', {
      group_folder: 'main',
      title: 'Upsert test',
      content: 'Version 2',
      tags: ['updated'],
    });

    expect(res.status).toBe(200);

    // Verify only one entry exists
    const list = await request('GET', '/memory/list?group_folder=main');
    const entries = list.body.filter((e: any) => e.title === 'Upsert test');
    expect(entries.length).toBe(1);
    expect(entries[0].tags).toEqual(['updated']);
  });

  it('returns 400 for missing required fields', async () => {
    const res = await request('POST', '/memory/save', {
      group_folder: 'main',
      // missing title and content
    });
    expect(res.status).toBe(400);
  });

  it('accepts source parameter', async () => {
    const res = await request('POST', '/memory/save', {
      group_folder: 'main',
      title: 'Auto extracted',
      content: 'From conversation',
      tags: [],
      source: 'auto',
    });
    expect(res.status).toBe(200);

    const list = await request('GET', '/memory/list?group_folder=main');
    const entry = list.body.find((e: any) => e.title === 'Auto extracted');
    expect(entry.source).toBe('auto');
  });
});

describe('POST /memory/search', () => {
  beforeEach(async () => {
    memorySave(db, {
      groupFolder: 'main',
      title: 'PyTorch tips',
      content: 'Use gradient clipping for stable training',
      tags: ['ml', 'pytorch'],
    });
    memorySave(db, {
      groupFolder: 'main',
      title: 'Docker debugging',
      content: 'Check container logs with docker logs -f',
      tags: ['docker', 'debugging'],
    });
    memorySave(db, {
      groupFolder: 'global',
      title: 'Shared standards',
      content: 'Always follow TDD methodology',
      tags: ['dev'],
    });
    memorySave(db, {
      groupFolder: 'secret-group',
      title: 'Secret data',
      content: 'Should not be visible',
      tags: ['private'],
    });
  });

  it('searches by keyword and returns matching entries', async () => {
    const res = await request('POST', '/memory/search', {
      group_folder: 'main',
      query: 'gradient clipping',
    });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].title).toBe('PyTorch tips');
    expect(res.body[0].content).toContain('gradient clipping');
  });

  it('includes global entries', async () => {
    const res = await request('POST', '/memory/search', {
      group_folder: 'main',
      query: 'TDD',
    });
    expect(res.body.length).toBe(1);
    expect(res.body[0].group_folder).toBe('global');
  });

  it('excludes other group entries', async () => {
    const res = await request('POST', '/memory/search', {
      group_folder: 'main',
      query: 'Secret',
    });
    expect(res.body.length).toBe(0);
  });

  it('filters by tags', async () => {
    const res = await request('POST', '/memory/search', {
      group_folder: 'main',
      query: 'gradient OR docker',
      tags: ['pytorch'],
    });
    expect(res.body.length).toBe(1);
    expect(res.body[0].title).toBe('PyTorch tips');
  });

  it('respects limit', async () => {
    const res = await request('POST', '/memory/search', {
      group_folder: 'main',
      query: 'gradient OR TDD',
      limit: 1,
    });
    expect(res.body.length).toBe(1);
  });

  it('returns 400 for missing query', async () => {
    const res = await request('POST', '/memory/search', {
      group_folder: 'main',
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /memory/list', () => {
  beforeEach(async () => {
    memorySave(db, {
      groupFolder: 'main',
      title: 'Entry 1',
      content: 'Content 1',
      tags: ['a'],
    });
    memorySave(db, {
      groupFolder: 'main',
      title: 'Entry 2',
      content: 'Content 2',
      tags: ['b'],
    });
    memorySave(db, {
      groupFolder: 'global',
      title: 'Global entry',
      content: 'Shared',
      tags: ['shared'],
    });
  });

  it('lists entries for group + global', async () => {
    const res = await request('GET', '/memory/list?group_folder=main');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(3);
  });

  it('returns summaries without content field', async () => {
    const res = await request('GET', '/memory/list?group_folder=main');
    for (const entry of res.body) {
      expect(entry.title).toBeDefined();
      expect(entry.content).toBeUndefined();
    }
  });

  it('filters by tags via query param', async () => {
    const res = await request('GET', '/memory/list?group_folder=main&tags=a');
    expect(res.body.length).toBe(1);
    expect(res.body[0].title).toBe('Entry 1');
  });

  it('returns 400 for missing group_folder', async () => {
    const res = await request('GET', '/memory/list');
    expect(res.status).toBe(400);
  });
});

describe('DELETE /memory/:id', () => {
  it('deletes own group entry', async () => {
    const save = await request('POST', '/memory/save', {
      group_folder: 'main',
      title: 'To delete',
      content: 'Will be removed',
      tags: [],
    });

    const res = await request(
      'DELETE',
      `/memory/${save.body.id}?group_folder=main`,
    );
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    // Verify gone from list
    const list = await request('GET', '/memory/list?group_folder=main');
    const found = list.body.find((e: any) => e.title === 'To delete');
    expect(found).toBeUndefined();
  });

  it('returns 404 for non-existent entry', async () => {
    const res = await request('DELETE', '/memory/99999?group_folder=main');
    expect(res.status).toBe(404);
  });

  it('returns 403 when deleting other group entry', async () => {
    memorySave(db, {
      groupFolder: 'secret',
      title: 'Not yours',
      content: 'Protected',
      tags: [],
    });
    const row = db
      .prepare("SELECT id FROM memory_entries WHERE title = 'Not yours'")
      .get() as { id: number };

    const res = await request('DELETE', `/memory/${row.id}?group_folder=main`);
    expect(res.status).toBe(403);
  });

  it('returns 400 for missing group_folder', async () => {
    const res = await request('DELETE', '/memory/1');
    expect(res.status).toBe(400);
  });
});

describe('unknown routes', () => {
  it('returns 404 for unmatched paths', async () => {
    const res = await request('GET', '/memory/unknown/path');
    expect(res.status).toBe(404);
  });
});
