import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

// Mock clash-switcher — default: no switch available (null).
// Tests that need a successful switch override with mockResolvedValueOnce.
vi.mock('./clash-switcher.js', () => ({
  switchToFastestNode: vi.fn().mockResolvedValue(null),
}));

import { startCredentialProxy } from './credential-proxy.js';
import { initMemorySchema, memorySave } from './memory-db.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    vi.clearAllMocks();
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });

  it('retries after node switch when upstream returns 502', async () => {
    const { switchToFastestNode } = await import('./clash-switcher.js');
    (switchToFastestNode as any).mockResolvedValueOnce('日本-优化2');

    let requestCount = 0;
    upstreamServer.close();
    upstreamServer = http.createServer((_req, res) => {
      requestCount++;
      if (requestCount === 1) {
        res.writeHead(502);
        res.end('Bad Gateway');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    const newPort = (upstreamServer.address() as AddressInfo).port;

    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${newPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    expect(requestCount).toBe(2);
    expect(switchToFastestNode).toHaveBeenCalledOnce();
    expect(switchToFastestNode).toHaveBeenCalledWith([]);
  });

  it('retries multiple times on consecutive failures', async () => {
    const { switchToFastestNode } = await import('./clash-switcher.js');
    (switchToFastestNode as any)
      .mockResolvedValueOnce('日本-优化2')
      .mockResolvedValueOnce('日本-优化3');

    let requestCount = 0;
    upstreamServer.close();
    upstreamServer = http.createServer((_req, res) => {
      requestCount++;
      if (requestCount <= 2) {
        res.writeHead(502);
        res.end('Bad Gateway');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    const newPort = (upstreamServer.address() as AddressInfo).port;

    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${newPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    expect(requestCount).toBe(3);
    expect(switchToFastestNode).toHaveBeenCalledTimes(2);
    // First call with empty exclude list, second excludes the first switched node
    expect(switchToFastestNode).toHaveBeenNthCalledWith(1, []);
    expect(switchToFastestNode).toHaveBeenNthCalledWith(2, ['日本-优化2']);
  });

  it('returns original 503 when node switch returns null', async () => {
    upstreamServer.close();
    upstreamServer = http.createServer((_req, res) => {
      res.writeHead(503);
      res.end('Service Unavailable');
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    const newPort = (upstreamServer.address() as AddressInfo).port;

    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${newPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(503);
  });

  it('does not trigger failover on 429', async () => {
    const { switchToFastestNode } = await import('./clash-switcher.js');

    upstreamServer.close();
    upstreamServer = http.createServer((_req, res) => {
      res.writeHead(429);
      res.end('Rate Limited');
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    const newPort = (upstreamServer.address() as AddressInfo).port;

    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${newPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(429);
    expect(switchToFastestNode).not.toHaveBeenCalled();
  });

  it('retries on upstream connection error after node switch', async () => {
    const { switchToFastestNode } = await import('./clash-switcher.js');
    // First switch succeeds, subsequent switches return null (no more nodes)
    (switchToFastestNode as any).mockResolvedValueOnce('日本-优化2');

    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    // Called twice: first attempt switches, retry also fails and tries again
    expect(switchToFastestNode).toHaveBeenCalledTimes(2);
  });
});

describe('credential-proxy memory routes', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let upstreamHit: boolean;
  let memDb: Database.Database;

  beforeEach(async () => {
    upstreamHit = false;
    memDb = new Database(':memory:');
    initMemorySchema(memDb);

    upstreamServer = http.createServer((_req, res) => {
      upstreamHit = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0, '127.0.0.1', memDb);
    proxyPort = (proxyServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    memDb.close();
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  it('handles POST /memory/save locally without hitting upstream', async () => {
    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/memory/save',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        group_folder: 'main',
        title: 'Proxy test',
        content: 'Saved through proxy',
        tags: ['test'],
      }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBeGreaterThan(0);
    expect(upstreamHit).toBe(false);
  });

  it('handles POST /memory/search locally', async () => {
    memorySave(memDb, {
      groupFolder: 'main',
      title: 'Searchable entry',
      content: 'Important knowledge about testing',
      tags: ['test'],
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/memory/search',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        group_folder: 'main',
        query: 'testing',
      }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
    expect(body[0].title).toBe('Searchable entry');
    expect(upstreamHit).toBe(false);
  });

  it('handles GET /memory/list locally', async () => {
    memorySave(memDb, {
      groupFolder: 'main',
      title: 'List entry',
      content: 'Content',
      tags: [],
    });

    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: '/memory/list?group_folder=main',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
    expect(upstreamHit).toBe(false);
  });

  it('still proxies non-memory requests to upstream', async () => {
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(upstreamHit).toBe(true);
  });
});
