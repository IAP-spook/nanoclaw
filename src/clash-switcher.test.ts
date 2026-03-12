import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { switchToFastestNode, isClashAvailable } from './clash-switcher.js';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

let mockServer: http.Server;
let socketPath: string;

function createMockClashServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<void> {
  socketPath = path.join(
    os.tmpdir(),
    `clash-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
  process.env.CLASH_SOCKET_PATH = socketPath;
  process.env.CLASH_SELECTOR = '节点选择';
  process.env.CLASH_NODE_PREFIX = '日本';
  process.env.CLASH_STABILIZATION_DELAY_MS = '0';

  mockServer = http.createServer(handler);
  return new Promise((resolve) => {
    mockServer.listen(socketPath, resolve);
  });
}

async function cleanupMockServer(): Promise<void> {
  delete process.env.CLASH_SOCKET_PATH;
  delete process.env.CLASH_SELECTOR;
  delete process.env.CLASH_NODE_PREFIX;
  delete process.env.CLASH_STABILIZATION_DELAY_MS;
  if (mockServer) {
    await new Promise<void>((r) => mockServer.close(() => r()));
  }
  try {
    fs.unlinkSync(socketPath);
  } catch {}
}

describe('isClashAvailable', () => {
  afterEach(cleanupMockServer);

  it('returns true when socket responds', async () => {
    await createMockClashServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          name: '节点选择',
          type: 'Selector',
          now: '日本-优化',
          all: ['日本-优化', '日本-优化2'],
        }),
      );
    });
    expect(await isClashAvailable()).toBe(true);
  });

  it('returns false when socket does not exist', async () => {
    process.env.CLASH_SOCKET_PATH = '/tmp/nonexistent-clash.sock';
    expect(await isClashAvailable()).toBe(false);
    delete process.env.CLASH_SOCKET_PATH;
  });
});

describe('switchToFastestNode', () => {
  afterEach(cleanupMockServer);

  it('switches to the fastest Japan node excluding current', async () => {
    const delays: Record<string, number> = {
      '日本-优化2': 150,
      '日本-优化3': 80,
      '日本JP-HY2': 200,
    };
    let switchedTo: string | null = null;

    await createMockClashServer((req, res) => {
      const url = decodeURIComponent(req.url ?? '');

      if (req.method === 'GET' && url === '/proxies/节点选择') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            name: '节点选择',
            type: 'Selector',
            now: '日本-优化',
            all: [
              '日本-优化',
              '日本-优化2',
              '日本-优化3',
              '日本JP-HY2',
              '美国USLA-A',
            ],
          }),
        );
        return;
      }

      if (req.method === 'GET' && url.includes('/delay')) {
        const nodeName = decodeURIComponent(
          (req.url ?? '').split('/proxies/')[1].split('/delay')[0],
        );
        const delay = delays[nodeName] ?? Infinity;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ delay }));
        return;
      }

      if (req.method === 'PUT' && url.startsWith('/proxies/')) {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          switchedTo = body.name;
          res.writeHead(204);
          res.end();
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const result = await switchToFastestNode();

    expect(result).toBe('日本-优化3');
    expect(switchedTo).toBe('日本-优化3');
  });

  it('returns null when no alternative Japan nodes exist', async () => {
    await createMockClashServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          name: '节点选择',
          type: 'Selector',
          now: '日本-优化',
          all: ['日本-优化', '美国USLA-A', '台湾-优化'],
        }),
      );
    });

    const result = await switchToFastestNode();
    expect(result).toBeNull();
  });

  it('returns null when socket is unreachable', async () => {
    process.env.CLASH_SOCKET_PATH = '/tmp/nonexistent-clash.sock';
    process.env.CLASH_STABILIZATION_DELAY_MS = '0';
    const result = await switchToFastestNode();
    expect(result).toBeNull();
    delete process.env.CLASH_SOCKET_PATH;
  });

  it('coalesces concurrent calls via mutex', async () => {
    let selectorCallCount = 0;

    await createMockClashServer((req, res) => {
      const url = decodeURIComponent(req.url ?? '');

      if (req.method === 'GET' && url === '/proxies/节点选择') {
        selectorCallCount++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            name: '节点选择',
            type: 'Selector',
            now: '日本-优化',
            all: ['日本-优化', '日本-优化2'],
          }),
        );
        return;
      }

      if (req.method === 'GET' && url.includes('/delay')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ delay: 100 }));
        return;
      }

      if (req.method === 'PUT') {
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const p1 = switchToFastestNode();
    const p2 = switchToFastestNode();

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe('日本-优化2');
    expect(r2).toBe('日本-优化2');
    expect(selectorCallCount).toBe(1);
  });
});
