/**
 * HTTP API handler for NanoClaw memory system.
 * Mounted on the credential proxy server at /memory/* routes.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type Database from 'better-sqlite3';
import {
  memorySave,
  memorySearch,
  memoryList,
  memoryDelete,
} from './memory-db.js';
import {
  syncMemoryFile,
  deleteMemoryFile,
  rebuildIndex,
} from './memory-files.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params: Record<string, string> = {};
  for (const part of url.slice(idx + 1).split('&')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined)
      params[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return params;
}

/**
 * Creates an HTTP request handler for memory API routes.
 * Returns true if the request was handled, false if not a /memory/* route.
 */
export function createMemoryHandler(
  db: Database.Database,
  groupsDir?: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req, res) => {
    const url = req.url || '';
    const method = req.method || 'GET';

    try {
      // POST /memory/save
      if (method === 'POST' && url.startsWith('/memory/save')) {
        const body = JSON.parse(await readBody(req));
        const { group_folder, title, content, tags, source } = body;

        if (!group_folder || !title || content === undefined) {
          return json(res, 400, {
            error: 'Missing required fields: group_folder, title, content',
          });
        }

        const result = memorySave(db, {
          groupFolder: group_folder,
          title,
          content,
          tags: tags || [],
          source,
        });

        // Sync file and index if groupsDir is configured
        if (groupsDir) {
          try {
            // Fetch the full entry to get timestamps
            const row = db
              .prepare(
                'SELECT created_at, updated_at FROM memory_entries WHERE id = ?',
              )
              .get(result.id) as { created_at: string; updated_at: string };
            syncMemoryFile(groupsDir, {
              id: result.id,
              group_folder,
              title,
              content,
              tags: tags || [],
              source: source || 'manual',
              created_at: row.created_at,
              updated_at: row.updated_at,
            });
            rebuildIndex(db, groupsDir, group_folder);
          } catch {
            // File sync is best-effort — don't fail the API call
          }
        }

        return json(res, 200, result);
      }

      // POST /memory/search
      if (method === 'POST' && url.startsWith('/memory/search')) {
        const body = JSON.parse(await readBody(req));
        const { group_folder, query, tags, limit } = body;

        if (!group_folder || !query) {
          return json(res, 400, {
            error: 'Missing required fields: group_folder, query',
          });
        }

        const results = memorySearch(db, {
          groupFolder: group_folder,
          query,
          tags,
          limit,
        });

        // Map to snake_case for API consistency
        return json(
          res,
          200,
          results.map((r) => ({
            id: r.id,
            group_folder: r.groupFolder,
            title: r.title,
            content: r.content,
            tags: r.tags,
            source: r.source,
            updated_at: r.updatedAt,
          })),
        );
      }

      // GET /memory/list?group_folder=...&tags=...
      if (method === 'GET' && /^\/memory\/list(\?|$)/.test(url)) {
        const query = parseQuery(url);

        if (!query.group_folder) {
          return json(res, 400, {
            error: 'Missing required query param: group_folder',
          });
        }

        const tags = query.tags ? query.tags.split(',') : undefined;
        const results = memoryList(db, {
          groupFolder: query.group_folder,
          tags,
        });

        return json(
          res,
          200,
          results.map((r) => ({
            id: r.id,
            group_folder: r.groupFolder,
            title: r.title,
            tags: r.tags,
            source: r.source,
            updated_at: r.updatedAt,
          })),
        );
      }

      // DELETE /memory/:id?group_folder=...
      const deleteMatch = url.match(/^\/memory\/(\d+)(\?|$)/);
      if (method === 'DELETE' && deleteMatch) {
        const id = parseInt(deleteMatch[1], 10);
        const query = parseQuery(url);

        if (!query.group_folder) {
          return json(res, 400, {
            error: 'Missing required query param: group_folder',
          });
        }

        // Fetch title before delete (for file cleanup)
        const entryRow = db
          .prepare(
            'SELECT title, group_folder FROM memory_entries WHERE id = ?',
          )
          .get(id) as { title: string; group_folder: string } | undefined;

        const deleted = memoryDelete(db, {
          id,
          groupFolder: query.group_folder,
        });

        if (!deleted) {
          if (entryRow) {
            return json(res, 403, {
              error: 'Not authorized to delete this entry',
            });
          }
          return json(res, 404, { error: 'Entry not found' });
        }

        // Sync file deletion and rebuild index
        if (groupsDir && entryRow) {
          try {
            deleteMemoryFile(groupsDir, entryRow.group_folder, entryRow.title);
            rebuildIndex(db, groupsDir, entryRow.group_folder);
          } catch {
            // Best-effort
          }
        }

        return json(res, 200, { deleted: true });
      }

      // No matching route
      json(res, 404, { error: 'Not found' });
    } catch (err) {
      json(res, 500, { error: 'Internal server error' });
    }
  };
}
