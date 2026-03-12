/**
 * HTTP client for NanoClaw memory API.
 * Used by container-side MCP tools to communicate with the host memory service.
 */
import http from 'http';

interface SaveInput {
  group_folder: string;
  title: string;
  content: string;
  tags: string[];
  source?: string;
}

interface SearchInput {
  group_folder: string;
  query: string;
  tags?: string[];
  limit?: number;
}

interface ListInput {
  group_folder: string;
  tags?: string[];
}

interface DeleteInput {
  id: number;
  group_folder: string;
}

export interface MemorySearchResult {
  id: number;
  group_folder: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  updated_at: string;
}

export interface MemoryListResult {
  id: number;
  group_folder: string;
  title: string;
  tags: string[];
  source: string;
  updated_at: string;
}

function httpRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: object,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
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
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode!, data: parsed });
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export async function memoryClientSave(
  baseUrl: string,
  input: SaveInput,
): Promise<{ id: number }> {
  const { status, data } = await httpRequest(
    baseUrl,
    'POST',
    '/memory/save',
    input,
  );
  if (status !== 200) {
    throw new Error(`memory_save failed (${status}): ${JSON.stringify(data)}`);
  }
  return data;
}

export async function memoryClientSearch(
  baseUrl: string,
  input: SearchInput,
): Promise<MemorySearchResult[]> {
  const { status, data } = await httpRequest(
    baseUrl,
    'POST',
    '/memory/search',
    input,
  );
  if (status !== 200) {
    throw new Error(
      `memory_search failed (${status}): ${JSON.stringify(data)}`,
    );
  }
  return data;
}

export async function memoryClientList(
  baseUrl: string,
  input: ListInput,
): Promise<MemoryListResult[]> {
  const params = new URLSearchParams({
    group_folder: input.group_folder,
  });
  if (input.tags && input.tags.length > 0) {
    params.set('tags', input.tags.join(','));
  }
  const { status, data } = await httpRequest(
    baseUrl,
    'GET',
    `/memory/list?${params.toString()}`,
  );
  if (status !== 200) {
    throw new Error(
      `memory_list failed (${status}): ${JSON.stringify(data)}`,
    );
  }
  return data;
}

export async function memoryClientDelete(
  baseUrl: string,
  input: DeleteInput,
): Promise<{ deleted: boolean }> {
  const params = new URLSearchParams({
    group_folder: input.group_folder,
  });
  const { status, data } = await httpRequest(
    baseUrl,
    'DELETE',
    `/memory/${input.id}?${params.toString()}`,
  );
  if (status === 200) return data;
  if (status === 404) return { deleted: false };
  if (status === 403) return { deleted: false };
  throw new Error(
    `memory_delete failed (${status}): ${JSON.stringify(data)}`,
  );
}
