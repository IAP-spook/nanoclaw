# Clash Auto Failover Design

## Date: 2026-03-12

## Problem

NanoClaw uses a proxy (Clash Verge / mihomo) to reach the Claude API. When the selected proxy node becomes slow or unresponsive, the credential proxy returns 502 and the container agent fails. The group queue retries with exponential backoff up to 5 times, then drops the message. During this time NanoClaw is effectively offline.

## Solution

Add automatic proxy node switching to the credential proxy layer. When an upstream request fails due to a connectivity issue, the system tests all available Japan nodes via the Clash API, switches to the fastest one, and retries the request once — all transparent to the container.

## Architecture

```
Container (Claude SDK)
  → credential-proxy.ts (HTTP proxy on host)
    → upstream request via Clash proxy
      → SUCCESS: return response to container
      → FAIL (connection error / 502 / 503 / 504):
        → clash-switcher.ts: test Japan node latencies
        → switch to fastest node
        → retry upstream request once
          → SUCCESS: return response to container
          → FAIL: return error to container (normal retry path)
```

## Components

### `src/clash-switcher.ts` (new)

Communicates with Clash mihomo via Unix socket (`/var/tmp/verge/verge-mihomo.sock`).

Exports:
- `switchToFastestNode(): Promise<string | null>` — gets current selector state, filters nodes by prefix (`日本`), tests latency on all candidates in parallel, switches to the fastest one. Returns new node name or null on failure. Includes a mutex so only one failover runs at a time; concurrent callers wait for the in-progress result.
- `isClashAvailable(): Promise<boolean>` — checks if the socket is reachable.

Implementation details:
- Uses Node.js `http.request({ socketPath })` for proper HTTP parsing (handles chunked encoding etc.)
- No authentication required (local Unix socket)
- Latency test via Clash API: `GET /proxies/:name/delay?timeout=3000&url=...`
- Node switch via: `PUT /proxies/节点选择` with `{"name": "..."}`
- 1 second pause after switch for connection stabilization
- If only one Japan node exists (or zero alternatives), returns null immediately

### `src/credential-proxy.ts` (modified)

Add failover logic to the upstream request handler. Key change: **delay `res.writeHead()` for error status codes** so the response can be replaced by a retry.

Modified response flow:
1. On upstream response callback, check `upRes.statusCode` first
2. If 502/503/504: consume and discard the error response body, then trigger failover
3. If success or non-retriable error: call `writeHead` + `pipe` as today (no change)
4. On `upstream.on('error')` (connection refused/timeout): trigger failover directly

Failover logic:
1. Call `switchToFastestNode()`
2. If switch succeeded: replay the same request (body is already buffered in `chunks`)
3. If retry succeeds: write retry response to client
4. If switch failed or retry failed: return original error (502 for connection errors, original status for HTTP errors)

Concurrency: `switchToFastestNode()` has an internal mutex, so multiple simultaneous failures will coalesce into a single switch operation.

Does NOT trigger on:
- HTTP 429 (rate limiting — node switch won't help)
- Other 4xx/5xx (API-level errors, not connectivity)

## Edge Cases

- **Clash unavailable** (mihomo not running): `switchToFastestNode()` returns null, original error returned to container. Logged as warning, not error — running without Clash is valid.
- **All Japan nodes unreachable**: returns null, original error returned.
- **Single Japan node**: no alternatives to switch to, returns null immediately.
- **Concurrent failures**: mutex ensures one switch at a time; others wait for the result.

## Configuration

Environment variables with defaults (read from `process.env`, not `.env` — these are not secrets):

| Variable | Default | Description |
|----------|---------|-------------|
| `CLASH_SOCKET_PATH` | `/var/tmp/verge/verge-mihomo.sock` | Clash API Unix socket path |
| `CLASH_SELECTOR` | `节点选择` | Proxy selector group name |
| `CLASH_NODE_PREFIX` | `日本` | Only switch among nodes with this name prefix |

## Retry Strategy

- Test all Japan nodes (excluding current) in parallel for latency
- Switch to the single fastest node
- Retry the failed request exactly once
- If still fails, return error (let existing group-queue retry handle it)

This avoids excessive delays: one switch + one retry, then fall through to normal error handling.

## Files Changed

- `src/clash-switcher.ts` — new file
- `src/credential-proxy.ts` — add failover logic in upstream error/response handler
