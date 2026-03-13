# Parallel Task and Message Containers

**Date:** 2026-03-13
**Status:** Draft

## Problem

GroupQueue enforces a single active container per group. When a scheduled task (e.g., 28-minute model training) is running, all user messages are queued until the task container finishes. This blocks interactive conversation during long-running tasks.

## Goal

Allow a scheduled task container and a message container to run concurrently for the same group, so users can chat with NanoClaw while tasks execute in the background.

## Design

### Core Change: Dual Container Slots

Split `GroupState`'s single set of container fields into two independent slots:

```typescript
interface ContainerSlot {
  active: boolean;
  idleWaiting: boolean;
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
}

interface GroupState {
  message: ContainerSlot;    // message container state
  task: ContainerSlot;       // task container state
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  retryCount: number;
}
```

### Separate IPC Input Directories

Both containers mount the same `data/ipc/{group}/` directory. The `_close` sentinel file creates a race condition — either container could consume it first, potentially killing the wrong container.

**Solution:** Split IPC input directories per slot type:

- Message container: `data/ipc/{group}/input/` (unchanged, backward compatible)
- Task container: `data/ipc/{group}/task-input/`

Each container type mounts its own input directory to `/workspace/ipc/input` inside the container. The agent-runner code inside the container is unchanged — it still watches `/workspace/ipc/input/_close`. But the host-side path differs, so `closeStdin` writes the `_close` file to the correct directory without affecting the other container.

This requires a small change in `container-runner.ts`: when `isScheduledTask` is true, mount `data/ipc/{group}/task-input/` instead of `data/ipc/{group}/input/` as the container's `/workspace/ipc/input`.

### Method Changes

| Method | Current | After |
|--------|---------|-------|
| `enqueueMessageCheck` | Checks `state.active` | Checks `state.message.active` only |
| `enqueueTask` | Checks `state.active`, preempts idle container | Checks `state.task.active` only, **no cross-slot preemption** |
| `registerProcess` | Writes to shared fields | Adds `type` parameter, writes to correct slot |
| `sendMessage` | Checks `state.active` + `isTaskContainer` | Checks `state.message.active`, sets `state.message.idleWaiting = false` |
| `notifyIdle` | Sets shared `idleWaiting`, preempts for pending tasks | Adds `type` parameter, sets on correct slot, **no cross-slot preemption** |
| `closeStdin` | Writes `_close` to shared IPC dir | Adds `type` parameter, writes `_close` to slot-specific IPC input dir |
| `runForGroup` | Sets `state.active = true` | Sets `state.message.active = true`, resets `state.message` fields |
| `runTask` | Sets `state.active = true` | Sets `state.task.active = true`, resets `state.task` fields |
| `drainGroup` | Single drain for both types | Split: message slot freeing drains pending messages, task slot freeing drains pending tasks. Both call `drainWaiting` when nothing pending for their type. |
| `shutdown` | Checks single `state.process` | Iterates both `state.message` and `state.task` slots to collect active containers. Behavior unchanged (log, don't kill). |

### Removed Behaviors

With dual slots, these cross-slot interactions are no longer needed:

1. **`enqueueTask` preemption** (current line 107-108): When a task arrives and the container is idle, it calls `closeStdin` to free the slot. With separate slots, the task starts in its own slot immediately — no need to preempt the message container.

2. **`notifyIdle` task preemption** (current line 151-153): When the container goes idle, it checks for pending tasks and preempts. With separate slots, pending tasks run independently.

3. **`isTaskContainer` flag**: Replaced by the slot structure itself. `sendMessage` checks `state.message.active` instead of checking `!state.isTaskContainer`.

### Concurrency Rules

- Same group, different types: **parallel** (message + task can coexist)
- Same group, same type: **serial** (two messages or two tasks queue as before)
- Global `MAX_CONCURRENT_CONTAINERS` still limits total containers across all groups
- `activeCount` counts both message and task containers (a single group with both slots active counts as 2)
- Default `MAX_CONCURRENT_CONTAINERS` is 5, which accommodates dual slots comfortably

### File Conflict Analysis

Both containers share the group folder (`groups/{name}/`). Potential conflicts:

| Resource | Message Container | Task Container | Risk |
|----------|------------------|----------------|------|
| `CLAUDE.md` | Read/write | Read/write | Low — updates are infrequent |
| `data/sessions/{group}/.claude/` | Own session ID | Own session ID | None — different session files |
| `data/ipc/{group}/input/` | Reads messages | N/A (uses `task-input/`) | None — separate dirs |
| `data/ipc/{group}/task-input/` | N/A | Single-turn, rarely reads | None — separate dirs |
| `data/ipc/{group}/messages/` | Writes outbound | Writes outbound | None — timestamped filenames |
| `data/ipc/{group}/tasks/` | Writes IPC tasks | Writes IPC tasks | None — timestamped filenames |
| Training data/models | Not accessed | Read/write | None |

### Affected Files

1. **`src/group-queue.ts`** — Core refactor: dual slots, method signatures, remove cross-slot preemption
2. **`src/group-queue.test.ts`** — Update existing tests, add parallel scenario tests
3. **`src/index.ts`** — Update `registerProcess`, `closeStdin`, `notifyIdle` calls with `'message'` type
4. **`src/task-scheduler.ts`** — Update `closeStdin`, `notifyIdle` calls with `'task'` type; update `SchedulerDependencies.onProcess` interface to include type parameter
5. **`src/container-runner.ts`** — Mount `task-input/` instead of `input/` when `isScheduledTask` is true

### Files NOT Changed

- `container/agent-runner/` — Agent runner unchanged (still watches `/workspace/ipc/input/_close`)
- `src/credential-proxy.ts` — Unchanged
- `src/ipc.ts` — Unchanged (watches `messages/` and `tasks/` dirs, not `input/`)

## Testing Strategy

1. Task container running → message enqueued → message starts immediately (not queued)
2. Message container running → task enqueued → task starts immediately (not queued)
3. Same-type still serial: message running → second message queues
4. Same-type still serial: task running → second task queues
5. Global concurrency limit still enforced across both types
6. `closeStdin('message')` only writes `_close` to message input dir
7. `closeStdin('task')` only writes `_close` to task input dir
8. `sendMessage` only targets message slot, returns false if no active message container
9. `notifyIdle('message')` does not preempt for pending tasks
10. `shutdown` reports containers from both slots
11. Drain: message slot freeing only drains pending messages
12. Drain: task slot freeing only drains pending tasks

## Rollback

Commit `94f819a` is the safe rollback point.
