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

function getStabilizationDelay(): number {
  const val = process.env.CLASH_STABILIZATION_DELAY_MS;
  return val !== undefined ? parseInt(val, 10) : 1000;
}

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

      const delay = getStabilizationDelay();
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
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
