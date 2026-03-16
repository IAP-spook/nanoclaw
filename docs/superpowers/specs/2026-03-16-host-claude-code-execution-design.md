# Host Claude Code Execution

**Date:** 2026-03-16
**Status:** Draft

## Problem

NanoClaw's container agents use the Claude Agent SDK, which lacks skills, MCP tools, and access to the host environment (conda, GPU, filesystem). For tasks like algorithm debugging and model training, users need the full capabilities of Claude Code CLI running directly on the host.

## Goal

Enable NanoClaw to automatically route tasks to a host-side Claude Code CLI process when they require host-level capabilities, while maintaining the existing container path for standard tasks. Also enable host Claude Code to send messages back to Feishu via NanoClaw's existing IPC mechanism.

## Design

### Component Overview

Three new components, two modified files:

| Component | File | Purpose |
|-----------|------|---------|
| Host runner | `src/host-runner.ts` | Spawn and manage host `claude` CLI processes |
| Host router | `src/host-router.ts` | Keyword-based routing: container vs host |
| Route config | `groups/{name}/host-rules.json` | Per-group keywords and settings |

| Modified File | Change |
|---------------|--------|
| `src/index.ts` | Route through host-router before container-runner |
| `src/task-scheduler.ts` | Same routing for scheduled tasks |
| `src/ipc.ts` | Add 7-day cleanup for `errors/` directory |
| `CLAUDE.md` | Document IPC reverse communication path and format |

### Host Router (`src/host-router.ts`)

Keyword-based routing with manual override.

```typescript
interface HostRouteConfig {
  enabled: boolean;
  keywords: string[];        // e.g. ["训练", "conda", "GPU", "模型", "python"]
  forceHostPrefix?: string;  // e.g. "在主机上" — manual override to force host
  forceContainerPrefix?: string; // e.g. "用容器" — manual override to force container
}

function shouldRunOnHost(prompt: string, config: HostRouteConfig): boolean;
```

- Checks manual override prefixes first (highest priority)
- Then checks keyword list against the prompt
- Default: container (existing behavior preserved)
- Config loaded from `groups/{name}/host-rules.json`, falls back to defaults

### Host Runner (`src/host-runner.ts`)

Spawns `claude` CLI on the host. Two modes:

**Single-turn mode** (simple tasks):
```
claude -p "prompt" --dangerously-skip-permissions --output-format stream-json
```

**Session mode** (multi-turn, complex tasks):
```
claude -p "prompt" --dangerously-skip-permissions --output-format stream-json --resume SESSION_ID
```

**Working directory:** The `claude` process runs with `cwd` set to the group folder (`groups/{name}/`), giving it access to the group's files and CLAUDE.md.

**Startup validation:** At NanoClaw startup, check that the `claude` CLI is available by running `claude --version`. Log a warning if not found (host routing will still compile, but `runHostAgent` returns an error immediately if `claude` is missing).

**Timeout handling:** Host processes have a configurable timeout (default: 30 minutes). If the `claude` process exceeds the timeout, it is killed with SIGTERM (then SIGKILL after 5 seconds). The slot is released and an error is reported.

Key behaviors:
- Parses `stream-json` output line by line; each line is a JSON object
- Extracts `result` from events with `type: "result"` — the `result` field contains the final text output
- Extracts session ID from the `session_id` field in the `result` event for session resume capability
- Reports to Feishu at key points: task started, task completed (with result summary)
- Registers the `claude` process with GroupQueue via `registerProcess` — uses a slot like any container
- On process exit, slot is released and GroupQueue drains normally
- Session IDs stored per-group in memory (a `Map<string, string>`) for resume capability

```typescript
interface HostRunnerInput {
  prompt: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  sessionId?: string;
  isScheduledTask?: boolean;
}

interface HostRunnerOutput {
  status: 'success' | 'error';
  result: string | null;
  sessionId?: string;  // extracted from stream-json result event
  error?: string;
}

function runHostAgent(
  group: RegisteredGroup,
  input: HostRunnerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: HostRunnerOutput) => Promise<void>,
): Promise<HostRunnerOutput>;
```

The interface mirrors `runContainerAgent` intentionally — callers (index.ts, task-scheduler.ts) can switch between them with minimal code change.

### Integration with GroupQueue

Host processes share the same slot mechanism as containers:
- `registerProcess(groupJid, proc, name, folder, type)` — works identically
- **Shutdown:** `closeStdin` writes a `_close` sentinel file, which docker containers watch for. Host `claude` processes don't watch for sentinel files, so host runner uses `proc.kill('SIGTERM')` directly instead of calling `closeStdin`. The host runner stores a reference to the spawned process and exposes a `killHostProcess(groupJid, type)` method for forced shutdown.
- `notifyIdle` / `sendMessage` — for session mode, follow-up messages can be piped
- `activeCount` — host processes count toward `MAX_CONCURRENT_CONTAINERS`

No changes to GroupQueue itself. The queue doesn't know or care whether the process is docker or claude CLI.

### Routing in index.ts

```typescript
// In processGroupMessages:
const useHost = shouldRunOnHost(prompt, loadHostConfig(group.folder));

if (useHost) {
  output = await runHostAgent(group, hostInput, onProcess, onOutput);
} else {
  output = await runContainerAgent(group, containerInput, onProcess, onOutput);
}
```

Same pattern in task-scheduler.ts for scheduled tasks.

### Reverse Communication (Host Claude Code → Feishu)

Already supported by existing IPC watcher. No new code needed.

Host Claude Code writes a JSON file to `data/ipc/{group}/messages/` with a unique filename (e.g., `msg-{timestamp}-{random}.json`):

```json
{
  "type": "message",
  "chatJid": "oc_xxx@feishu",
  "text": "训练完成，准确率92%"
}
```

The `type` field must be `"message"`, and `chatJid` is the Feishu group JID. The IPC watcher picks it up, sends to Feishu, and deletes the file (`fs.unlinkSync`). Authorization rules apply: non-main groups can only send to their own chatJid.

Document the IPC path and format in the project-level `CLAUDE.md` so any Claude Code instance in the nanoclaw directory can use it.

### IPC Error Directory Cleanup

The existing IPC watcher moves failed files to `data/ipc/errors/` (a single shared directory, filenames prefixed with `{sourceGroup}-`). Add a periodic cleanup that deletes error files older than 7 days. Run during NanoClaw startup and once per day thereafter.

### Default Host Rules Config

```json
{
  "enabled": true,
  "keywords": ["训练", "train", "conda", "GPU", "模型", "model", "python", "系统", "pip", "pytorch"],
  "forceHostPrefix": "在主机上",
  "forceContainerPrefix": "用容器"
}
```

### Security

- Host Claude Code runs as `dell` user with `--dangerously-skip-permissions`
- NanoClaw main process is the gatekeeper: only routed tasks reach host execution
- No SSH keys, no Docker socket exposure, no container breakout
- Credential proxy is NOT used for host execution — Claude Code uses its own auth directly

### Affected Files

1. **`src/host-runner.ts`** — New: spawn and manage host claude CLI, startup validation, timeout handling
2. **`src/host-router.ts`** — New: keyword routing logic, config loading
3. **`src/index.ts`** — Modify: add routing before agent execution, call startup validation
4. **`src/task-scheduler.ts`** — Modify: same routing for scheduled tasks
5. **`src/ipc.ts`** — Modify: add error directory cleanup (7-day retention)
6. **`CLAUDE.md`** — Modify: document IPC reverse communication path and JSON format
7. **`groups/main/host-rules.json`** — New: default config for main group

### Files NOT Changed

- `src/group-queue.ts` — No changes needed, host processes use existing slot API
- `src/container-runner.ts` — Unchanged
- `container/agent-runner/` — Unchanged

## Testing Strategy

1. Host router: keyword matching, manual override prefixes, disabled config, missing config file fallback
2. Host runner: process spawn, stream-json output parsing (result extraction, session ID extraction), slot registration, process exit cleanup, timeout enforcement, SIGTERM shutdown, startup validation (`claude --version`)
3. Integration: routing decision → correct runner invoked, working directory set to group folder
4. IPC error cleanup: files older than 7 days deleted, newer files kept
5. Reverse communication: JSON file in messages/ dir with correct format (`{type, chatJid, text}`) picked up and sent

## Rollback

Disable host mode by setting `"enabled": false` in `host-rules.json`. All tasks fall back to container execution. No code rollback needed.
