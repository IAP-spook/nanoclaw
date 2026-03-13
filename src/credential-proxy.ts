/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type Database from 'better-sqlite3';

import { switchToFastestNode } from './clash-switcher.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { createMemoryHandler } from './memory-api.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
  memoryDb?: Database.Database,
  groupsDir?: string,
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  const proxyAgent =
    proxyUrl && isHttps ? new HttpsProxyAgent(proxyUrl) : undefined;
  if (proxyAgent) {
    logger.info(
      { proxy: proxyUrl },
      'Credential proxy using upstream HTTP proxy',
    );
  }

  const memoryHandler = memoryDb
    ? createMemoryHandler(memoryDb, groupsDir)
    : null;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // Intercept /memory/* requests — handle locally, don't proxy
      if (memoryHandler && req.url?.startsWith('/memory/')) {
        memoryHandler(req, res);
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const requestOpts: RequestOptions = {
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port || (isHttps ? 443 : 80),
          path: req.url,
          method: req.method,
          headers,
          ...(proxyAgent ? { agent: proxyAgent } : {}),
        };

        const RETRIABLE_STATUSES = new Set([502, 503, 504]);
        const MAX_RETRIES = 3;

        function sendUpstreamRequest(
          attempt: number,
          triedNodes: string[],
        ): void {
          const canRetry = attempt < MAX_RETRIES;

          const upstream = makeRequest(requestOpts, (upRes) => {
            const status = upRes.statusCode!;

            if (canRetry && RETRIABLE_STATUSES.has(status)) {
              // Delay writeHead — consume error body, then try failover
              upRes.resume();
              upRes.on('end', () => {
                logger.warn(
                  { status, url: req.url, attempt },
                  'Upstream returned retriable status, attempting node switch',
                );
                switchToFastestNode(triedNodes)
                  .then((newNode) => {
                    if (newNode) {
                      logger.info(
                        { newNode, attempt },
                        'Node switched, retrying request',
                      );
                      sendUpstreamRequest(attempt + 1, [
                        ...triedNodes,
                        newNode,
                      ]);
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
            if (canRetry) {
              logger.warn(
                { err, url: req.url, attempt },
                'Upstream connection failed, attempting node switch',
              );
              switchToFastestNode(triedNodes)
                .then((newNode) => {
                  if (newNode) {
                    logger.info(
                      { newNode, attempt },
                      'Node switched, retrying request',
                    );
                    sendUpstreamRequest(attempt + 1, [...triedNodes, newNode]);
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
              { err, url: req.url, attempt },
              'Credential proxy upstream error (retries exhausted)',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });

          upstream.write(body);
          upstream.end();
        }

        sendUpstreamRequest(0, []);
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
