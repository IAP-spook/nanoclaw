# Host Terminal Ability for NanoClaw

**Date:** 2026-03-17
**Status:** Approved

## Goal

Give NanoClaw agents the ability to execute commands on the host terminal. Security is ensured through conversational authorization — the agent must obtain explicit user permission before using this capability, scoped to the task at hand.

## Design

### MCP Tools (Container Side)

Three tools added to `container/agent-runner/src/ipc-mcp-stdio.ts`:

#### `host_exec`

Execute a shell command on the host machine.

```typescript
{
  name: "host_exec",
  parameters: {
    command: string,        // shell command to execute
    working_dir?: string,   // default: host group directory
    background?: boolean,   // false: sync (30s timeout), true: async (returns task_id)
  }
}
// background=false → { exit_code, stdout, stderr }
// background=false (timeout) → { error: "timeout", task_id } (process keeps running, agent can follow up)
// background=true  → { task_id }
```

- Sync mode: blocks until command completes or 30s timeout, returns output directly.
- Async mode: returns task_id immediately, output streams to disk.

#### `host_task_status`

Check status and output of an async task.

```typescript
{
  name: "host_task_status",
  parameters: {
    task_id: string,
    tail?: number,   // lines from end of stdout/stderr, default 50, -1 for all
  }
}
// → { status, exit_code, stdout_tail, stderr_tail, started_at, finished_at }
```

Container reads directly from mounted host-tasks directory (no IPC round-trip).

#### `host_task_kill`

Terminate an async task.

```typescript
{
  name: "host_task_kill",
  parameters: {
    task_id: string,
  }
}
// → { killed: boolean }
```

### IPC Protocol (Container → Host)

Container writes JSON files to `/workspace/ipc/host-exec/` (mapped to `data/ipc/{group}/host-exec/` on host).

**Run request:**
```json
{
  "type": "host_exec",
  "task_id": "20260317-143022-abc1",
  "groupFolder": "ml-lab",
  "command": "python train.py --epochs 100",
  "working_dir": "/home/dell/nanoclaw/groups/ml-lab",
  "background": true,
  "timestamp": 1710680000000
}
```

**Kill request:**
```json
{
  "type": "host_kill",
  "task_id": "20260317-143022-abc1",
  "groupFolder": "ml-lab",
  "timestamp": 1710680010000
}
```

**Sync request:** Same as run with `"background": false`. Host executor creates `data/host-tasks/{group}/{task_id}/` and writes `status: running` before spawning. Container MCP tool polls `/workspace/host-tasks/{task_id}/status` every 200ms:
- File not found → treat as `pending` (host hasn't processed the IPC file yet, ~1s delay)
- `running` → keep polling
- `completed` or `failed` → read stdout.log/stderr.log, return result
- 30s elapsed with no completion → return timeout error, process keeps running in background

Linux bind mounts ensure container reads see host writes immediately.

File naming follows existing convention: `{Date.now()}-{random}.json` with atomic temp→rename writes.

### Host Executor (`src/host-executor.ts`)

New module. Single responsibility: spawn processes and manage output.

**Both sync and async use the same storage structure.** Every task creates `data/host-tasks/{group}/{task_id}/` with meta.json, stdout.log, stderr.log, and status file. The only difference is on the container MCP tool side: sync blocks and polls, async returns immediately.

**Execution (sync and async):**
- `child_process.spawn(command, { shell: true, cwd })`
- Write `meta.json` with command, pid, started_at
- Write `status` file: `running`
- Pipe stdout/stderr to `stdout.log` and `stderr.log` via append streams
- On exit: write exit_code and finished_at to `meta.json`, update `status` to `completed` or `failed`

**Kill:**
- Verify authorization: `isMain || taskGroup === sourceGroup` (same pattern as existing task operations in ipc.ts)
- Look up ChildProcess from in-memory map by task_id
- `process.kill(pid, 'SIGTERM')`
- Update status to `killed`

**Restart recovery:**
- On NanoClaw startup, scan `data/host-tasks/{group}/{task_id}/` for tasks with `status: running`
- Read pid from `meta.json`, check `/proc/{pid}` existence and verify start time from `/proc/{pid}/stat` matches `started_at` (prevents pid recycling false positives)
- If alive and verified: re-add to in-memory map (cannot re-attach stdout pipe, but can still kill)
- If dead or pid recycled: update status to `failed`, write finished_at

### IPC Watcher Changes (`src/ipc.ts`)

Add `host-exec/` to the per-group directory scan. The `host-exec/` directory is pre-created during container setup in `container-runner.ts`, following the same pattern as `messages/`, `tasks/`, and `input/`:

```typescript
// existing:
watchDir(`data/ipc/${group}/messages/`, handleMessage);
watchDir(`data/ipc/${group}/tasks/`, handleTask);

// new:
watchDir(`data/ipc/${group}/host-exec/`, handleHostExec);
```

`handleHostExec` dispatches to `hostExecutor.run()` or `hostExecutor.kill()` based on `type` field.

### Container Runner Changes (`src/container-runner.ts`)

**New volume mount:**
```
data/host-tasks/{group}/ → /workspace/host-tasks/ (readonly)
```

This allows `host_task_status` to read task output directly without IPC round-trip.

**Pre-create host-tasks directory** in `buildVolumeMounts()` before mounting, following the same pattern as IPC directories (line 168-171):
```typescript
const hostTasksDir = path.join(DATA_DIR, 'host-tasks', group.folder);
fs.mkdirSync(hostTasksDir, { recursive: true });
```

This prevents Docker from creating it as root-owned when the directory doesn't exist.

**New environment variable** passed to MCP server:
```
NANOCLAW_HOST_GROUP_PATH=/home/dell/nanoclaw/groups/{folder}
```

Read by `host_exec` tool handler as default `working_dir`, so agent can use relative paths in commands.

### Task Storage

```
data/host-tasks/{group}/{task_id}/
  ├── meta.json    # command, pid, started_at, finished_at, exit_code
  ├── stdout.log   # append stream
  ├── stderr.log   # append stream
  └── status       # running | completed | failed | killed
```

No auto-cleanup. All output preserved permanently.

### Authorization

No mechanical permission gate. Authorization is conversational, defined in agent instructions:

```markdown
# Per-group CLAUDE.md addition
## Host Terminal
You have host_exec/host_task_status/host_task_kill tools to execute commands on the host machine.
Rules:
1. Before first use, explain what you need to do and ask user for authorization
2. User will grant a scope (e.g., "training tasks are fine")
3. Operate freely within granted scope; request again if exceeding it
4. Each new conversation requires fresh authorization
```

### Data Flow

```
User: "Train the BERT model"
  ↓
Agent decides this needs host terminal
Agent asks: "I need to run training on the host. OK?"
User: "Go ahead with training tasks"
  ↓
Agent calls host_exec("python train.py", background=true)
  → Container writes IPC file
  → Host ipc.ts picks up → hostExecutor.run()
  → Process spawned, output streaming to disk
  ← Agent receives { task_id: "..." }
  ↓
Agent replies: "Training started, I'll check on it later"
Container exits
  ↓
(Later, user asks or scheduled task fires)
  ↓
Agent calls host_task_status(task_id)
  → Reads /workspace/host-tasks/{task_id}/status → "completed"
  → Reads last 50 lines of stdout.log
  ↓
Agent replies: "Training done, final loss 0.023"
```

## File Changes

| File | Change |
|------|--------|
| `src/host-executor.ts` | **New.** Process spawn, output management, kill. |
| `src/ipc.ts` | Add `host-exec/` directory watching. |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add 3 tools: host_exec, host_task_status, host_task_kill. |
| `src/container-runner.ts` | Add readonly mount for host-tasks, add NANOCLAW_HOST_GROUP_PATH env var. |
