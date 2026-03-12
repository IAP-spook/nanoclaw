/**
 * Integration test: memory save via HTTP API → database → file sync → search roundtrip.
 * Verifies the full chain without containers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { initMemorySchema } from './memory-db.js';
import { createMemoryHandler } from './memory-api.js';

let db: Database.Database;
let server: http.Server;
let baseUrl: string;
let groupsDir: string;

function request(
  method: string,
  urlPath: string,
  body?: object,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode!, data: JSON.parse(raw) });
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
  groupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-int-'));

  const handler = createMemoryHandler(db, groupsDir);
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
  fs.rmSync(groupsDir, { recursive: true, force: true });
});

describe('full roundtrip: API → DB → files → search', () => {
  it('save creates DB entry, markdown file, and INDEX.md', async () => {
    const { status, data } = await request('POST', '/memory/save', {
      group_folder: 'main',
      title: 'Feishu Image Key',
      content: 'The image_key has two formats: data.image_key or root image_key.',
      tags: ['feishu', 'api'],
      source: 'manual',
    });

    expect(status).toBe(200);
    expect(data.id).toBeGreaterThan(0);

    // Verify markdown file
    const mdPath = path.join(groupsDir, 'main', 'memory', 'feishu-image-key.md');
    expect(fs.existsSync(mdPath)).toBe(true);
    const md = fs.readFileSync(mdPath, 'utf-8');
    expect(md).toContain('title: Feishu Image Key');
    expect(md).toContain('tags: [feishu, api]');
    expect(md).toContain('two formats');

    // Verify INDEX.md
    const indexPath = path.join(groupsDir, 'main', 'memory', 'INDEX.md');
    expect(fs.existsSync(indexPath)).toBe(true);
    const index = fs.readFileSync(indexPath, 'utf-8');
    expect(index).toContain('Feishu Image Key');
    expect(index).toContain('feishu, api');
  });

  it('search returns saved entries', async () => {
    await request('POST', '/memory/save', {
      group_folder: 'main',
      title: 'PyTorch LR',
      content: 'Use cosine annealing learning rate scheduler.',
      tags: ['ml'],
    });

    const { status, data } = await request('POST', '/memory/search', {
      group_folder: 'main',
      query: 'cosine annealing',
    });

    expect(status).toBe(200);
    expect(data.length).toBe(1);
    expect(data[0].title).toBe('PyTorch LR');
    expect(data[0].content).toContain('cosine annealing');
  });

  it('upsert updates file content', async () => {
    await request('POST', '/memory/save', {
      group_folder: 'main',
      title: 'Docker Tips',
      content: 'Version 1',
      tags: [],
    });

    await request('POST', '/memory/save', {
      group_folder: 'main',
      title: 'Docker Tips',
      content: 'Version 2 — improved',
      tags: ['docker'],
    });

    const mdPath = path.join(groupsDir, 'main', 'memory', 'docker-tips.md');
    const md = fs.readFileSync(mdPath, 'utf-8');
    expect(md).toContain('Version 2 — improved');
    expect(md).not.toContain('Version 1');

    // Only one entry in list
    const { data: list } = await request(
      'GET',
      '/memory/list?group_folder=main',
    );
    const dockerEntries = list.filter(
      (e: { title: string }) => e.title === 'Docker Tips',
    );
    expect(dockerEntries.length).toBe(1);
  });

  it('delete removes file and updates INDEX.md', async () => {
    const { data: saved } = await request('POST', '/memory/save', {
      group_folder: 'main',
      title: 'Temp Note',
      content: 'Will be deleted',
      tags: [],
    });

    const mdPath = path.join(groupsDir, 'main', 'memory', 'temp-note.md');
    expect(fs.existsSync(mdPath)).toBe(true);

    const { status } = await request(
      'DELETE',
      `/memory/${saved.id}?group_folder=main`,
    );
    expect(status).toBe(200);

    // File removed
    expect(fs.existsSync(mdPath)).toBe(false);

    // INDEX.md updated (no entries)
    const index = fs.readFileSync(
      path.join(groupsDir, 'main', 'memory', 'INDEX.md'),
      'utf-8',
    );
    expect(index).not.toContain('Temp Note');
  });

  it('multiple groups have isolated files', async () => {
    await request('POST', '/memory/save', {
      group_folder: 'main',
      title: 'Main Only',
      content: 'For main group',
      tags: [],
    });

    await request('POST', '/memory/save', {
      group_folder: 'team-a',
      title: 'Team A Only',
      content: 'For team A',
      tags: [],
    });

    // Each group has its own directory
    expect(
      fs.existsSync(path.join(groupsDir, 'main', 'memory', 'main-only.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(groupsDir, 'team-a', 'memory', 'team-a-only.md')),
    ).toBe(true);

    // INDEX.md is per-group
    const mainIndex = fs.readFileSync(
      path.join(groupsDir, 'main', 'memory', 'INDEX.md'),
      'utf-8',
    );
    expect(mainIndex).toContain('Main Only');
    expect(mainIndex).not.toContain('Team A Only');
  });
});
