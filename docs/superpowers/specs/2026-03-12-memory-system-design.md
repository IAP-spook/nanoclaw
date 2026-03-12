# NanoClaw Long-Term Memory System

**Date:** 2026-03-12
**Status:** Approved
**Author:** Claude + User

## Problem

NanoClaw agents lose knowledge between sessions. The current memory mechanisms — CLAUDE.md files, session resumption, and conversation archives — are either too small (CLAUDE.md will bloat), too volatile (sessions compact away detail), or unsearchable (conversation archives are raw markdown dumps). Agents cannot learn from past successes and failures, and cannot retrieve relevant experience when facing similar problems.

## Goals

1. Agents can persist structured knowledge that survives across sessions
2. Agents can efficiently retrieve relevant memories by topic/keyword
3. Memory accumulates without bloating the context window
4. Users can explicitly instruct agents to remember things
5. Agents automatically extract insights from conversations
6. Periodic review consolidates and prunes stale memories
7. Per-group isolation is preserved; global sharing via explicit layer

## Non-Goals

- Vector/embedding-based semantic search (future upgrade path)
- Cross-group memory sharing beyond the global layer
- Real-time memory sync between running containers
- UI for memory management (agents manage their own memory)

## Architecture

### Three-Layer Model

```
L0  Identity Layer    CLAUDE.md (~2KB)           Auto-loaded by SDK
L1  Index Layer       memory/INDEX.md (~4KB)     Auto-loaded via mount
L2  Knowledge Store   memory/*.md + SQLite FTS   On-demand via MCP tools
```

**L0 — CLAUDE.md** stays small. Contains only identity, capabilities, and the instruction to use `memory_search` for knowledge retrieval. All accumulated knowledge migrates out to L2.

**L1 — INDEX.md** provides a topic directory that the agent sees on startup. Each entry is one line: topic name, brief description, tags. The agent uses this to decide whether to call `memory_search` for more detail.

**L2 — Knowledge Store** is the bulk of memory. Each memory entry exists as both:
- A markdown file in `memory/` (human-readable, Grep-able, version-controllable)
- A row in SQLite with FTS5 index (fast full-text search)

Markdown files are the source of truth. The FTS index is a derived acceleration layer that can be rebuilt from files.

### Directory Layout

```
groups/{folder}/
  CLAUDE.md              ← L0: identity + instructions (slim)
  memory/
    INDEX.md             ← L1: topic directory
    ml-training.md       ← L2: knowledge entry
    feishu-api.md        ← L2: knowledge entry
    ...
  conversations/         ← existing: raw conversation archives

groups/global/
  CLAUDE.md              ← global identity
  memory/
    INDEX.md             ← shared topic directory
    shared-knowledge.md  ← shared entries
```

### Database Schema

Added to `store/messages.db`:

```sql
CREATE TABLE IF NOT EXISTS memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_folder TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(group_folder, title)
);

CREATE INDEX IF NOT EXISTS idx_memory_group ON memory_entries(group_folder);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title, content, tags,
  content=memory_entries,
  content_rowid=id
);
```

**Fields:**
- `group_folder`: Owner group ('main', 'global', etc.)
- `title`: Short descriptive title (used as filename stem). UNIQUE per group for upsert support.
- `content`: Full memory content (markdown)
- `tags`: JSON array of topic tags (e.g., `["ml","pytorch","itransformer"]`). Stored as space-separated tokens in the FTS column (e.g., `"ml pytorch itransformer"`) to avoid substring false positives. Tag filtering for exact matches uses `json_each()` on the source table after FTS ranking.
- `source`: How the memory was created — `manual` (user asked), `auto` (extracted from conversation), `review` (periodic consolidation)
- `created_at`, `updated_at`: ISO timestamps

**FTS Rebuild:** On startup or maintenance, the FTS index can be rebuilt from source:
```sql
INSERT INTO memory_fts(memory_fts) VALUES('rebuild');
```
This is called during `initDatabase()` if a version mismatch is detected.

### FTS Sync Triggers

```sql
CREATE TRIGGER memory_fts_insert AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_fts(rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE TRIGGER memory_fts_update AFTER UPDATE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, content, tags)
  VALUES ('delete', old.id, old.title, old.content, old.tags);
  INSERT INTO memory_fts(rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE TRIGGER memory_fts_delete AFTER DELETE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, content, tags)
  VALUES ('delete', old.id, old.title, old.content, old.tags);
END;
```

## MCP Tools

Four new tools added to the NanoClaw MCP server (`container/agent-runner/src/ipc-mcp-stdio.ts`):

### memory_search

```typescript
memory_search(query: string, tags?: string[], limit?: number): MemoryEntry[]
```

Searches memory entries using FTS5 full-text search. Results ranked by relevance. Automatically scoped to the agent's own group + global entries.

**Behavior:**
- Searches both title and content via FTS5 `MATCH`
- If `tags` provided, post-filters using `json_each(tags)` for exact tag matches
- Default limit: 10
- Returns: `{ id, title, content, tags, source, updated_at }[]`
- Non-main agents see their own group + global; main sees all

### memory_save

```typescript
memory_save(title: string, content: string, tags: string[]): { id: number, file: string }
```

Creates or updates a memory entry. If an entry with the same title exists in the same group, it updates; otherwise creates new.

**Behavior:**
- Calls host memory API: `POST /memory/save`
- Host upserts row via `INSERT INTO memory_entries ... ON CONFLICT(group_folder, title) DO UPDATE SET ...`
- Host writes markdown file to `groups/{folder}/memory/{slugified-title}.md`
- Host updates `groups/{folder}/memory/INDEX.md`
- FTS index updated via triggers
- Returns the entry ID and file path

### memory_list

```typescript
memory_list(tags?: string[]): MemoryEntrySummary[]
```

Lists all memory entries for the current group (+ global), optionally filtered by tags.

**Behavior:**
- Returns: `{ id, title, tags, source, updated_at }[]` (no content — lightweight)
- Sorted by `updated_at` descending

### memory_delete

```typescript
memory_delete(id: number): { deleted: boolean }
```

Deletes a memory entry by ID. Only entries owned by the agent's group can be deleted (main can also delete global entries).

**Behavior:**
- Calls host memory API: `DELETE /memory/:id`
- Host deletes row from `memory_entries` (FTS cleaned via trigger)
- Host deletes corresponding markdown file
- Host updates `INDEX.md`
- Returns whether the entry was found and deleted

## Host Memory API

Memory tools need synchronous read/write access to the database. Rather than mounting the SQLite file into containers (which risks WAL corruption and breaks group isolation), memory operations go through the **existing credential proxy HTTP server** on the host.

### Why Not Direct SQLite Mount?

1. **WAL corruption**: SQLite WAL mode uses `-wal` and `-shm` sidecar files. Bind-mounting only the `.db` file hides these from the container, causing silent corruption.
2. **Isolation breach**: Mounting `messages.db` gives containers access to all groups' messages, tasks, and sessions — a major security regression.
3. **Container dependency**: Would require `better-sqlite3` (native module) in the container image.

### Approach: Extend Credential Proxy

The credential proxy (`src/credential-proxy.ts`) already runs an HTTP server on `CREDENTIAL_PROXY_PORT` (default 3001) that containers access via `host.docker.internal:3001`. Adding memory API routes to this server:

- Zero new infrastructure (reuses existing HTTP server)
- Host controls all database access (enforces group isolation)
- Container MCP tools make simple HTTP calls (~1ms latency)
- No new dependencies in container image
- Consistent with NanoClaw's existing architecture (containers never touch host resources directly)

### API Routes

```
POST   /memory/search   { group_folder, query, tags?, limit? }  → MemoryEntry[]
POST   /memory/save     { group_folder, title, content, tags, source? }  → { id, file }
GET    /memory/list     ?group_folder=...&tags=...  → MemoryEntrySummary[]
DELETE /memory/:id      ?group_folder=...  → { deleted }
```

All routes require `group_folder` parameter. The host enforces:
- Non-main groups can only access their own group + global (read-only)
- Main can access all groups + global (read-write)
- Global write restricted to main group

### Container MCP → Host API Flow

```
Agent calls memory_search("pytorch training")
  → MCP tool in container
  → HTTP POST http://host.docker.internal:3001/memory/search
     body: { group_folder: "main", query: "pytorch training" }
  → Host credential-proxy handles request
  → Queries SQLite FTS5
  → Returns JSON results
  → MCP tool returns to agent
```

The `group_folder` is set from the `NANOCLAW_GROUP_FOLDER` environment variable (already injected into the MCP server). The host validates that the requesting group is authorized for the requested `group_folder`.

## Memory Lifecycle

### 1. Manual Save (User-Triggered)

User says "记住：飞书 image_key 有两种返回格式" → agent calls `memory_save(title, content, tags)`.

### 2. Auto-Extract (Post-Conversation)

Enhance the existing PreCompact hook in `container/agent-runner/src/index.ts`. After archiving the conversation to `conversations/`, add a step:

```
1. Archive conversation (existing)
2. Analyze archived conversation for key learnings
3. For each insight: call memory_save(title, content, tags, source='auto')
```

The extraction prompt:
> Review this conversation and extract reusable knowledge: solutions to problems, user preferences, API behaviors, debugging techniques, or any insight that would help in future similar situations. For each item, provide a title, content, and tags.

### 3. Periodic Review (Scheduled Task)

A cron scheduled task (weekly, Sunday evening) that:
1. Lists all memories created/updated in the past week
2. Identifies duplicates or overlapping entries → merges
3. Identifies outdated entries → marks or removes
4. Rebuilds `INDEX.md` from current memory state
5. Optionally generates a "weekly learning summary" sent to the chat

Registered via IPC `schedule_task`:
```json
{
  "prompt": "Review and consolidate your memory. List recent memories, merge duplicates, remove outdated entries, and update INDEX.md.",
  "schedule_type": "cron",
  "schedule_value": "0 21 * * 0",
  "context_mode": "isolated"
}
```

## CLAUDE.md Migration

Current main CLAUDE.md is 247 lines. After migration:

**Keep in CLAUDE.md (~50 lines):**
- Identity and personality
- Communication instructions (formatting, internal tags)
- Workspace description
- Memory system instructions ("use memory_search to recall knowledge")
- Admin context (main group privileges)

**Move to memory/ entries:**
- Group management instructions → `memory/group-management.md`
- Detailed mount paths → `memory/container-mounts.md`
- Registration procedures → `memory/registration-procedures.md`

**Move to per-group preferences (already exists):**
- `preferences.md` stays as-is (already separated)

## Security

- **Per-group isolation preserved**: Host API enforces `group_folder` filtering — containers never touch the database directly
- **Global layer**: main can write `global` entries; others read-only (enforced in host API)
- **No cross-group reads**: non-main agents can only query their own group + global
- **No database mount**: containers have zero access to `messages.db` or any other SQLite file
- **No secrets in memory**: agents are already instructed not to store sensitive data
- **Host-mediated writes**: all memory mutations go through the host, which validates authorization before executing

## File Format

Each memory markdown file:

```markdown
---
title: Feishu API image_key has two response formats
tags: [feishu, api, debugging]
source: manual
created: 2026-03-12T14:00:00+08:00
updated: 2026-03-12T14:00:00+08:00
---

The Feishu SDK `im.v1.image.create()` returns `image_key` in two possible locations:
- `uploadResp.data.image_key` (documented format)
- `uploadResp.image_key` (actual observed format)

Always use fallback: `uploadResp?.data?.image_key ?? uploadResp?.image_key`
```

## Implementation Order (TDD)

Each step follows Red-Green-Refactor with tests written first.

1. **Database layer** (`src/memory-db.ts`): Schema migration, CRUD operations, FTS queries. Unit tests with in-memory SQLite — no container needed.
2. **Host memory API** (`src/memory-api.ts`): HTTP route handlers for /memory/* endpoints. Unit tests with mock db layer.
3. **Wire into credential proxy** (`src/credential-proxy.ts`): Mount memory routes on the existing HTTP server.
4. **MCP tools** (`container/agent-runner/src/ipc-mcp-stdio.ts`): memory_search, memory_save, memory_list, memory_delete — HTTP calls to host API.
5. **File sync** (`src/memory-files.ts`): markdown write + INDEX.md generation, called by the host API after DB writes. Includes startup reconciliation (rebuild FTS from files if needed).
6. **Integration test**: end-to-end container → host API → database → file roundtrip.
7. **Auto-extract**: enhance PreCompact hook to extract insights after conversation archival.
8. **CLAUDE.md migration**: slim down, move knowledge to memory entries.
9. **Review task**: register periodic consolidation scheduled task (context_mode: "isolated").

## Future Upgrade Path

- **Vector search**: Add embedding column + sqlite-vec for semantic similarity
- **Cross-group knowledge sharing**: agent-to-agent memory queries via IPC
- **Memory importance scoring**: prioritize retrieval by relevance + recency + frequency
- **Forgetting curve**: automatically decay rarely-accessed memories
