# Clash Auto Failover Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically switch Clash proxy nodes when upstream requests fail, keeping NanoClaw online without manual intervention.

**Architecture:** A new `clash-switcher.ts` module communicates with Clash mihomo via Unix socket to test node latencies and switch nodes. The existing `credential-proxy.ts` is modified to call the switcher on upstream failures (connection error, 502/503/504), retry the request once, and return the result transparently to the container.

**Tech Stack:** Node.js `http.request({ socketPath })`, vitest for testing

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/clash-switcher.ts` | Create | Clash API communication: list nodes, test delay, switch node, mutex |
| `src/clash-switcher.test.ts` | Create | Unit tests for clash-switcher with mock Unix socket server |
| `src/credential-proxy.ts` | Modify | Add failover logic: detect failure, call switcher, retry request |
| `src/credential-proxy.test.ts` | Modify | Add tests for failover behavior |

---

## Task 1: Clash Switcher — Core Module

**Files:**
- Create: `src/clash-switcher.ts`
- Create: `src/clash-switcher.test.ts`

### Step 1.1: Write failing test for `isClashAvailable`

- [ ] **Write test**

Key design: env vars are read lazily inside functions (not module-level constants) so tests can override them. Tests use `vi.useFakeTimers()` to skip the 1-second stabilization delay.

```typescript
// src/clash-switcher.test.ts
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
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
  socketPath = path.join(os.tmpdir(), `clash-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
  process.env.CLASH_SOCKET_PATH = socketPath;
  process.env.CLASH_SELECTOR = '节点选择';
  process.env.CLASH_NODE_PREFIX = '日本';

  mockServer = http.createServer(handler);
  return new Promise((resolve) => {
    mockServer.listen(socketPath, resolve);
  });
}

async function cleanupMockServer(): Promise<void> {
  delete process.env.CLASH_SOCKET_PATH;
  delete process.env.CLASH_SELECTOR;
  delete process.env.CLASH_NODE_PREFIX;
  if (mockServer) {
    await new Promise<void>((r) => mockServer.close(() => r()));
  }
  try { fs.unlinkSync(socketPath); } catch {}
}

describe('isClashAvailable', () => {
  afterEach(cleanupMockServer);

  it('returns true when socket responds', async () => {
    await createMockClashServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: '节点选择',
        type: 'Selector',
        now: '日本-优化',
        all: ['日本-优化', '日本-优化2'],
      }));
    });
    expect(await isClashAvailable()).toBe(true);
  });

  it('returns false when socket does not exist', async () => {
    process.env.CLASH_SOCKET_PATH = '/tmp/nonexistent-clash.sock';
    expect(await isClashAvailable()).toBe(false);
    delete process.env.CLASH_SOCKET_PATH;
  });
});
```

- [ ] **Run test to verify it fails**

Run: `npx vitest run src/clash-switcher.test.ts`
Expected: FAIL — module `./clash-switcher.js` not found

### Step 1.2: Implement clash-switcher

- [ ] **Write implementation**

Important: all config values are read lazily via getter functions so tests can override `process.env` at runtime. The `testNodeDelay` URL path is constructed carefully to avoid double-encoding (the test URL is passed as a query parameter, and `encodeURI` is applied only to the path portion containing Chinese characters).

```typescript
// src/clash-switcher.ts
import { request, RequestOptions, IncomingMessage } from 'http';

import { logger } from './logger.js';

// Read config lazily so tests can override process.env
function getSocketPath(): string {
  return process.env.CLASH_SOCKET_PATH || '/var/tmp/verge/verge-mihomo.sock';
}
function getSelectorName(): string {
  return process.env.CLASH_SELECTOR || '节点选择';
}
function getNodePrefix(): string {
  return process.env.CLASH_NODE_PREFIX || '日本';
}

const DELAY_TEST_URL = 'https://www.gstatic.com/generate_204';
const DELAY_TIMEOUT = 3000;
const STABILIZATION_DELAY_MS = 1000;

function clashRequest(
  method: string,
  urlPath: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: RequestOptions = {
      socketPath: getSocketPath(),
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = request(opts, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Clash socket timeout'));
    });

    if (body) req.write(body);
    req.end();
  });
}

interface SelectorInfo {
  name: string;
  type: string;
  now?: string;
  all?: string[];
}

async function getSelector(): Promise<SelectorInfo | null> {
  try {
    const encoded = `/proxies/${encodeURIComponent(getSelectorName())}`;
    const { status, body } = await clashRequest('GET', encoded);
    if (status !== 200) return null;
    return JSON.parse(body);
  } catch (err) {
    logger.warn({ err }, 'Failed to reach Clash API');
    return null;
  }
}

async function testNodeDelay(nodeName: string): Promise<number> {
  try {
    const encoded = `/proxies/${encodeURIComponent(nodeName)}/delay?timeout=${DELAY_TIMEOUT}&url=${encodeURIComponent(DELAY_TEST_URL)}`;
    const { status, body } = await clashRequest('GET', encoded);
    if (status !== 200) return Infinity;
    const result = JSON.parse(body);
    return result.delay ?? Infinity;
  } catch {
    return Infinity;
  }
}

async function switchNode(nodeName: string): Promise<boolean> {
  try {
    const encoded = `/proxies/${encodeURIComponent(getSelectorName())}`;
    const { status } = await clashRequest(
      'PUT',
      encoded,
      JSON.stringify({ name: nodeName }),
    );
    return status === 204 || status === 200;
  } catch (err) {
    logger.error({ err, nodeName }, 'Failed to switch Clash node');
    return false;
  }
}

// Mutex: only one failover at a time
let pendingSwitch: Promise<string | null> | null = null;

export async function switchToFastestNode(): Promise<string | null> {
  if (pendingSwitch) return pendingSwitch;

  pendingSwitch = (async () => {
    try {
      const selector = await getSelector();
      if (!selector?.all) {
        logger.warn('Cannot get Clash selector, skipping node switch');
        return null;
      }

      const currentNode = selector.now;
      const nodePrefix = getNodePrefix();
      const candidates = selector.all.filter(
        (n) => n.startsWith(nodePrefix) && n !== currentNode,
      );

      if (candidates.length === 0) {
        logger.warn('No alternative nodes available for failover');
        return null;
      }

      logger.info(
        { currentNode, candidates: candidates.length },
        'Testing node latencies for failover',
      );

      const results = await Promise.all(
        candidates.map(async (name) => ({
          name,
          delay: await testNodeDelay(name),
        })),
      );

      results.sort((a, b) => a.delay - b.delay);
      const best = results[0];

      if (!best || best.delay === Infinity) {
        logger.error('All candidate nodes unreachable');
        return null;
      }

      logger.info(
        { from: currentNode, to: best.name, delay: best.delay },
        'Switching Clash node',
      );

      const ok = await switchNode(best.name);
      if (!ok) return null;

      await new Promise((r) => setTimeout(r, STABILIZATION_DELAY_MS));
      return best.name;
    } finally {
      pendingSwitch = null;
    }
  })();

  return pendingSwitch;
}

export async function isClashAvailable(): Promise<boolean> {
  const selector = await getSelector();
  return selector !== null;
}
```

- [ ] **Run test to verify it passes**

Run: `npx vitest run src/clash-switcher.test.ts`
Expected: PASS

- [ ] **Commit**

```bash
git add src/clash-switcher.ts src/clash-switcher.test.ts
git commit -m "feat: add clash-switcher module for proxy node failover"
```

### Step 1.3: Add `switchToFastestNode` tests

- [ ] **Write tests**

Add to `src/clash-switcher.test.ts`:

```typescript
describe('switchToFastestNode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await cleanupMockServer();
  });

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
        res.end(JSON.stringify({
          name: '节点选择',
          type: 'Selector',
          now: '日本-优化',
          all: ['日本-优化', '日本-优化2', '日本-优化3', '日本JP-HY2', '美国USLA-A'],
        }));
        return;
      }

      if (req.method === 'GET' && url.includes('/delay')) {
        const nodeName = decodeURIComponent(
          (req.url ?? '').split('/proxies/')[1].split('/delay')[0]
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

    const promise = switchToFastestNode();
    // Advance past stabilization delay
    await vi.advanceTimersByTimeAsync(STABILIZATION_DELAY_MS);
    const result = await promise;

    expect(result).toBe('日本-优化3'); // lowest delay = 80ms
    expect(switchedTo).toBe('日本-优化3');
  });

  it('returns null when no alternative Japan nodes exist', async () => {
    await createMockClashServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: '节点选择',
        type: 'Selector',
        now: '日本-优化',
        all: ['日本-优化', '美国USLA-A', '台湾-优化'],
      }));
    });

    const result = await switchToFastestNode();
    expect(result).toBeNull();
  });

  it('returns null when socket is unreachable', async () => {
    process.env.CLASH_SOCKET_PATH = '/tmp/nonexistent-clash.sock';
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
        res.end(JSON.stringify({
          name: '节点选择',
          type: 'Selector',
          now: '日本-优化',
          all: ['日本-优化', '日本-优化2'],
        }));
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

    // Fire two concurrent calls
    const p1 = switchToFastestNode();
    const p2 = switchToFastestNode();

    await vi.advanceTimersByTimeAsync(STABILIZATION_DELAY_MS);

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe('日本-优化2');
    expect(r2).toBe('日本-优化2');
    // Selector was only queried once due to mutex
    expect(selectorCallCount).toBe(1);
  });
});
```

Note: need to add `STABILIZATION_DELAY_MS` export or use the value `1000` directly. Simplest: use `1000` in tests.

- [ ] **Run tests**

Run: `npx vitest run src/clash-switcher.test.ts`
Expected: PASS

- [ ] **Commit**

```bash
git add src/clash-switcher.test.ts
git commit -m "test: add switchToFastestNode and mutex tests"
```

---

## Task 2: Credential Proxy Failover Integration

**Files:**
- Modify: `src/credential-proxy.ts:111-138`
- Modify: `src/credential-proxy.test.ts`

### Step 2.1: Write failing tests for failover

- [ ] **Write tests**

Add mock at top of `src/credential-proxy.test.ts` (after existing mocks, before imports):

```typescript
// Mock clash-switcher — default: no switch available (null).
// Tests that need a successful switch override with mockResolvedValueOnce.
vi.mock('./clash-switcher.js', () => ({
  switchToFastestNode: vi.fn().mockResolvedValue(null),
}));
```

Add `vi.clearAllMocks()` to the existing `beforeEach` in the first `describe` block.

Add these tests inside the first `describe('credential-proxy')` block:

```typescript
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
    const newPort = (upstreamServer.address() as any).port;

    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${newPort}`,
    });

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
  });

  it('returns original 503 when node switch returns null', async () => {
    // Default mock returns null — no switch available
    upstreamServer.close();
    upstreamServer = http.createServer((_req, res) => {
      res.writeHead(503);
      res.end('Service Unavailable');
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    const newPort = (upstreamServer.address() as any).port;

    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${newPort}`,
    });

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
    const newPort = (upstreamServer.address() as any).port;

    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${newPort}`,
    });

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
    (switchToFastestNode as any).mockResolvedValueOnce('日本-優化2');

    // Point proxy at dead port — first request will get connection error
    // After switch, re-create a live server on the same port for retry
    // Simpler: just verify switchToFastestNode is called on connection error
    // and 502 is returned (since retry to same dead port also fails)
    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });

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
    expect(switchToFastestNode).toHaveBeenCalledOnce();
  });
```

- [ ] **Run test to verify they fail**

Run: `npx vitest run src/credential-proxy.test.ts`
Expected: FAIL — proxy doesn't call switchToFastestNode yet

### Step 2.2: Implement failover in credential-proxy.ts

- [ ] **Modify credential-proxy.ts**

Add import at top (after existing imports):
```typescript
import { switchToFastestNode } from './clash-switcher.js';
```

Replace the upstream request block (lines 111-138, from `const upstream = makeRequest(` to `upstream.end();`) with:

```typescript
        const requestOpts: RequestOptions = {
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port || (isHttps ? 443 : 80),
          path: req.url,
          method: req.method,
          headers,
          ...(proxyAgent ? { agent: proxyAgent } : {}),
        };

        const RETRIABLE_STATUSES = new Set([502, 503, 504]);

        function sendUpstreamRequest(isRetry: boolean): void {
          const upstream = makeRequest(requestOpts, (upRes) => {
            const status = upRes.statusCode!;

            if (!isRetry && RETRIABLE_STATUSES.has(status)) {
              // Delay writeHead — consume error body, then try failover
              upRes.resume();
              upRes.on('end', () => {
                logger.warn(
                  { status, url: req.url },
                  'Upstream returned retriable status, attempting node switch',
                );
                switchToFastestNode()
                  .then((newNode) => {
                    if (newNode) {
                      logger.info({ newNode }, 'Node switched, retrying request');
                      sendUpstreamRequest(true);
                    } else {
                      if (!res.headersSent) {
                        res.writeHead(status);
                        res.end();
                      }
                    }
                  })
                  .catch(() => {
                    if (!res.headersSent) {
                      res.writeHead(status);
                      res.end();
                    }
                  });
              });
              return;
            }

            // Normal path: pipe through
            res.writeHead(status, upRes.headers);
            upRes.pipe(res);
          });

          upstream.on('error', (err) => {
            if (!isRetry) {
              logger.warn(
                { err, url: req.url },
                'Upstream connection failed, attempting node switch',
              );
              switchToFastestNode()
                .then((newNode) => {
                  if (newNode) {
                    logger.info({ newNode }, 'Node switched, retrying request');
                    sendUpstreamRequest(true);
                  } else {
                    if (!res.headersSent) {
                      res.writeHead(502);
                      res.end('Bad Gateway');
                    }
                  }
                })
                .catch(() => {
                  if (!res.headersSent) {
                    res.writeHead(502);
                    res.end('Bad Gateway');
                  }
                });
              return;
            }

            logger.error(
              { err, url: req.url },
              'Credential proxy upstream error (after retry)',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });

          upstream.write(body);
          upstream.end();
        }

        sendUpstreamRequest(false);
```

- [ ] **Run tests**

Run: `npx vitest run src/credential-proxy.test.ts`
Expected: PASS (all existing + new tests)

- [ ] **Commit**

```bash
git add src/credential-proxy.ts src/credential-proxy.test.ts
git commit -m "feat: add automatic Clash node failover in credential proxy"
```

### Step 2.3: Run full test suite and build

- [ ] **Run all tests**

Run: `npx vitest run`
Expected: All pass

- [ ] **Build**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Commit** (only if fixes were needed)

---

## Task 3: Manual Verification

- [ ] **Test with live Clash API**

```bash
npx tsx -e "
import { switchToFastestNode, isClashAvailable } from './src/clash-switcher.js';
console.log('Available:', await isClashAvailable());
console.log('Switch result:', await switchToFastestNode());
"
```

Expected: `Available: true`, switches to a Japan node, prints node name.

- [ ] **Verify current node changed in Clash**

```bash
python3 -c "
import socket, json, http.client
class U(http.client.HTTPConnection):
    def __init__(s, p):
        super().__init__('localhost')
        s.sp = p
    def connect(s):
        s.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.sock.connect(s.sp)
c = U('/var/tmp/verge/verge-mihomo.sock')
c.request('GET', '/proxies/%E8%8A%82%E7%82%B9%E9%80%89%E6%8B%A9')
r = c.getresponse()
d = json.loads(r.read())
print('Current node:', d.get('now'))
"
```
