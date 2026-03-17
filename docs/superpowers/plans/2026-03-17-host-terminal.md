# Host Terminal Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give NanoClaw container agents the ability to execute shell commands on the host machine, triggered only through conversation with the user.

**Architecture:** New `src/host-executor.ts` module handles process spawning and lifecycle. Container MCP tools write IPC files to `host-exec/` directory, host watcher picks them up and dispatches to executor. Status is read directly from mounted filesystem. No changes to existing IPC message/task flows.

**Tech Stack:** Node.js child_process, vitest, existing IPC file conventions

**Spec:** `docs/superpowers/specs/2026-03-17-host-terminal-design.md`

**Key constraint:** Feature is additive only. Zero changes to existing tool behavior. All existing tests must continue passing after each task.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/host-executor.ts` | **New.** Spawn host processes, manage output files, kill, restart recovery |
| `src/host-executor.test.ts` | **New.** Tests for host executor |
| `src/ipc.ts` | **Modify.** Add `host-exec/` directory scanning in watcher loop |
| `src/ipc-host-exec.test.ts` | **New.** Tests for IPC host-exec handling |
| `src/container-runner.ts` | **Modify.** Add host-tasks readonly mount + host-exec dir creation + env var |
| `src/container-runner.test.ts` | **Modify.** Add test for new mount |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | **Modify.** Add 3 MCP tools |

---

## Chunk 1: Host Executor Core

### Task 1: Host Executor — run() async mode

**Files:**
- Create: `src/host-executor.ts`
- Create: `src/host-executor.test.ts`

- [ ] **Step 1: Write failing test for async run**

In `src/host-executor.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { HostExecutor } from './host-executor.js';

describe('HostExecutor', () => {
  let tmpDir: string;
  let executor: HostExecutor;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-exec-'));
    executor = new HostExecutor(tmpDir);
  });

  afterEach(() => {
    executor.killAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('run (async)', () => {
    it('spawns process and writes status files', async () => {
      const taskId = 'test-async-001';
      const group = 'main';

      executor.run({
        taskId,
        groupFolder: group,
        command: 'echo hello',
        workingDir: tmpDir,
        background: true,
      });

      // Wait for process to complete
      await new Promise((r) => setTimeout(r, 1000));

      const taskDir = path.join(tmpDir, group, taskId);
      expect(fs.existsSync(taskDir)).toBe(true);

      const status = fs.readFileSync(path.join(taskDir, 'status'), 'utf-8').trim();
      expect(status).toBe('completed');

      const meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf-8'));
      expect(meta.command).toBe('echo hello');
      expect(meta.exit_code).toBe(0);
      expect(meta.pid).toBeGreaterThan(0);
      expect(meta.started_at).toBeDefined();
      expect(meta.finished_at).toBeDefined();

      const stdout = fs.readFileSync(path.join(taskDir, 'stdout.log'), 'utf-8');
      expect(stdout.trim()).toBe('hello');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/host-executor.test.ts`
Expected: FAIL — `HostExecutor` not found

- [ ] **Step 3: Write minimal implementation**

In `src/host-executor.ts`:
```typescript
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export interface HostExecRequest {
  taskId: string;
  groupFolder: string;
  command: string;
  workingDir: string;
  background: boolean;
}

export class HostExecutor {
  private baseDir: string;
  private processes = new Map<string, ChildProcess>();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private taskDir(group: string, taskId: string): string {
    return path.join(this.baseDir, group, taskId);
  }

  run(req: HostExecRequest): string {
    const dir = this.taskDir(req.groupFolder, req.taskId);
    fs.mkdirSync(dir, { recursive: true });

    const meta: Record<string, unknown> = {
      command: req.command,
      started_at: new Date().toISOString(),
      pid: 0,
    };

    fs.writeFileSync(path.join(dir, 'status'), 'running');

    const child = spawn(req.command, {
      shell: true,
      cwd: req.workingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    meta.pid = child.pid || 0;
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

    this.processes.set(req.taskId, child);

    const stdoutStream = fs.createWriteStream(path.join(dir, 'stdout.log'), { flags: 'a' });
    const stderrStream = fs.createWriteStream(path.join(dir, 'stderr.log'), { flags: 'a' });

    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);

    child.on('close', (code) => {
      this.processes.delete(req.taskId);

      const exitCode = code ?? 1;
      const status = exitCode === 0 ? 'completed' : 'failed';

      meta.exit_code = exitCode;
      meta.finished_at = new Date().toISOString();
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
      fs.writeFileSync(path.join(dir, 'status'), status);

      stdoutStream.end();
      stderrStream.end();

      logger.info({ taskId: req.taskId, exitCode, status }, 'Host task completed');
    });

    child.on('error', (err) => {
      this.processes.delete(req.taskId);
      meta.exit_code = 1;
      meta.finished_at = new Date().toISOString();
      meta.error = err.message;
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
      fs.writeFileSync(path.join(dir, 'status'), 'failed');
      logger.error({ taskId: req.taskId, err }, 'Host task spawn error');
    });

    return req.taskId;
  }

  killAll(): void {
    for (const [id, proc] of this.processes) {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      this.processes.delete(id);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/host-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Run ALL existing tests to verify no regression**

Run: `npx vitest run`
Expected: All 28+ test files pass, 327+ tests pass

- [ ] **Step 6: Commit**

```bash
git add src/host-executor.ts src/host-executor.test.ts
git commit -m "feat: add HostExecutor with async run and output capture"
```

---

### Task 2: Host Executor — kill()

**Files:**
- Modify: `src/host-executor.ts`
- Modify: `src/host-executor.test.ts`

- [ ] **Step 1: Write failing test for kill**

Append to `src/host-executor.test.ts`:
```typescript
  describe('kill', () => {
    it('terminates a running process and updates status', async () => {
      const taskId = 'test-kill-001';
      const group = 'main';

      executor.run({
        taskId,
        groupFolder: group,
        command: 'sleep 60',
        workingDir: tmpDir,
        background: true,
      });

      // Give process time to start
      await new Promise((r) => setTimeout(r, 300));

      const killed = executor.kill(taskId, group);
      expect(killed).toBe(true);

      // Wait for status update
      await new Promise((r) => setTimeout(r, 500));

      const taskDir = path.join(tmpDir, group, taskId);
      const status = fs.readFileSync(path.join(taskDir, 'status'), 'utf-8').trim();
      expect(status).toBe('killed');
    });

    it('returns false for non-existent task', () => {
      expect(executor.kill('no-such-task', 'main')).toBe(false);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/host-executor.test.ts`
Expected: FAIL — `kill` method not found

- [ ] **Step 3: Implement kill method**

Add to `HostExecutor` class in `src/host-executor.ts`:
```typescript
  kill(taskId: string, groupFolder: string): boolean {
    const proc = this.processes.get(taskId);
    if (!proc) return false;

    try {
      proc.kill('SIGTERM');
    } catch {
      return false;
    }

    // Write killed status immediately (close handler will also fire)
    const dir = this.taskDir(groupFolder, taskId);
    fs.writeFileSync(path.join(dir, 'status'), 'killed');
    this.processes.delete(taskId);
    logger.info({ taskId }, 'Host task killed');
    return true;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/host-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Run ALL tests**

Run: `npx vitest run`
Expected: All pass, no regression

- [ ] **Step 6: Commit**

```bash
git add src/host-executor.ts src/host-executor.test.ts
git commit -m "feat: add HostExecutor.kill() with status update"
```

---

### Task 3: Host Executor — failed command and stderr capture

**Files:**
- Modify: `src/host-executor.test.ts`

- [ ] **Step 1: Write failing test for failed command**

```typescript
  describe('run (failure)', () => {
    it('captures stderr and writes failed status', async () => {
      const taskId = 'test-fail-001';
      const group = 'main';

      executor.run({
        taskId,
        groupFolder: group,
        command: 'echo err >&2 && exit 1',
        workingDir: tmpDir,
        background: true,
      });

      await new Promise((r) => setTimeout(r, 1000));

      const taskDir = path.join(tmpDir, group, taskId);
      const status = fs.readFileSync(path.join(taskDir, 'status'), 'utf-8').trim();
      expect(status).toBe('failed');

      const meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf-8'));
      expect(meta.exit_code).toBe(1);

      const stderr = fs.readFileSync(path.join(taskDir, 'stderr.log'), 'utf-8');
      expect(stderr.trim()).toBe('err');
    });
  });
```

- [ ] **Step 2: Run test to verify it passes (implementation already handles this)**

Run: `npx vitest run src/host-executor.test.ts`
Expected: PASS (existing implementation covers this case)

- [ ] **Step 3: Commit**

```bash
git add src/host-executor.test.ts
git commit -m "test: add HostExecutor failure and stderr capture tests"
```

---

### Task 4: Host Executor — restart recovery

**Files:**
- Modify: `src/host-executor.ts`
- Modify: `src/host-executor.test.ts`

- [ ] **Step 1: Write failing test for recover()**

```typescript
  describe('recover', () => {
    it('marks dead tasks as failed on recovery', () => {
      const group = 'main';
      const taskId = 'test-recover-001';
      const taskDir = path.join(tmpDir, group, taskId);
      fs.mkdirSync(taskDir, { recursive: true });

      // Simulate a task that was running when NanoClaw crashed
      fs.writeFileSync(path.join(taskDir, 'status'), 'running');
      fs.writeFileSync(
        path.join(taskDir, 'meta.json'),
        JSON.stringify({ command: 'sleep 999', pid: 999999, started_at: '2026-01-01T00:00:00Z' }),
      );

      executor.recover();

      const status = fs.readFileSync(path.join(taskDir, 'status'), 'utf-8').trim();
      expect(status).toBe('failed');

      const meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf-8'));
      expect(meta.finished_at).toBeDefined();
    });

    it('leaves completed tasks untouched', () => {
      const group = 'main';
      const taskId = 'test-recover-002';
      const taskDir = path.join(tmpDir, group, taskId);
      fs.mkdirSync(taskDir, { recursive: true });

      fs.writeFileSync(path.join(taskDir, 'status'), 'completed');
      fs.writeFileSync(
        path.join(taskDir, 'meta.json'),
        JSON.stringify({ command: 'echo ok', pid: 1, exit_code: 0 }),
      );

      executor.recover();

      const status = fs.readFileSync(path.join(taskDir, 'status'), 'utf-8').trim();
      expect(status).toBe('completed');
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/host-executor.test.ts`
Expected: FAIL — `recover` not found

- [ ] **Step 3: Implement recover()**

Add to `HostExecutor` class:
```typescript
  recover(): void {
    if (!fs.existsSync(this.baseDir)) return;

    for (const group of fs.readdirSync(this.baseDir)) {
      const groupDir = path.join(this.baseDir, group);
      if (!fs.statSync(groupDir).isDirectory()) continue;

      for (const taskId of fs.readdirSync(groupDir)) {
        const dir = path.join(groupDir, taskId);
        if (!fs.statSync(dir).isDirectory()) continue;

        const statusFile = path.join(dir, 'status');
        if (!fs.existsSync(statusFile)) continue;

        const status = fs.readFileSync(statusFile, 'utf-8').trim();
        if (status !== 'running') continue;

        // Check if pid is still alive
        const metaFile = path.join(dir, 'meta.json');
        let pid = 0;
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
          pid = meta.pid || 0;
        } catch { /* corrupt meta */ }

        let alive = false;
        if (pid > 0) {
          try {
            process.kill(pid, 0); // signal 0 = check existence
            alive = true;
          } catch { /* not running */ }
        }

        if (alive) {
          // Cannot re-attach stdout pipe, but record it as known
          logger.info({ taskId, pid, group }, 'Host task still alive after restart');
          // Note: we can't re-add to this.processes map since we don't have the ChildProcess
          // Agent can still check status via filesystem, and can ask user to kill manually
        } else {
          // Mark as failed
          fs.writeFileSync(statusFile, 'failed');
          try {
            const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
            meta.finished_at = new Date().toISOString();
            fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
          } catch { /* best effort */ }
          logger.info({ taskId, pid, group }, 'Host task marked failed after restart (pid dead)');
        }
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/host-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Run ALL tests**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/host-executor.ts src/host-executor.test.ts
git commit -m "feat: add HostExecutor.recover() for restart recovery"
```

---

## Chunk 2: IPC Integration

### Task 5: IPC watcher — host-exec directory handling

**Files:**
- Modify: `src/ipc.ts`
- Create: `src/ipc-host-exec.test.ts`

- [ ] **Step 1: Write failing test for host_exec IPC processing**

Create `src/ipc-host-exec.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { processHostExecIpc } from './ipc.js';
import { HostExecutor } from './host-executor.js';

describe('IPC host-exec handling', () => {
  let mockExecutor: { run: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockExecutor = {
      run: vi.fn().mockReturnValue('task-123'),
      kill: vi.fn().mockReturnValue(true),
    };
    vi.clearAllMocks();
  });

  it('dispatches host_exec to executor.run()', () => {
    const data = {
      type: 'host_exec',
      task_id: 'task-123',
      groupFolder: 'main',
      command: 'echo hello',
      working_dir: '/tmp',
      background: true,
      timestamp: Date.now(),
    };

    processHostExecIpc(data, 'main', true, mockExecutor as any);

    expect(mockExecutor.run).toHaveBeenCalledWith({
      taskId: 'task-123',
      groupFolder: 'main',
      command: 'echo hello',
      workingDir: '/tmp',
      background: true,
    });
  });

  it('dispatches host_kill to executor.kill() with auth check', () => {
    const data = {
      type: 'host_kill',
      task_id: 'task-123',
      groupFolder: 'main',
      timestamp: Date.now(),
    };

    processHostExecIpc(data, 'main', true, mockExecutor as any);

    expect(mockExecutor.kill).toHaveBeenCalledWith('task-123', 'main');
  });

  it('blocks unauthorized kill from non-main group', () => {
    const data = {
      type: 'host_kill',
      task_id: 'task-123',
      groupFolder: 'other-group',
      timestamp: Date.now(),
    };

    // sourceGroup is 'team-a' but task groupFolder is 'other-group'
    processHostExecIpc(data, 'team-a', false, mockExecutor as any);

    expect(mockExecutor.kill).not.toHaveBeenCalled();
  });

  it('allows kill from same group (non-main)', () => {
    const data = {
      type: 'host_kill',
      task_id: 'task-123',
      groupFolder: 'team-a',
      timestamp: Date.now(),
    };

    processHostExecIpc(data, 'team-a', false, mockExecutor as any);

    expect(mockExecutor.kill).toHaveBeenCalledWith('task-123', 'team-a');
  });

  it('ignores unknown type', () => {
    const data = { type: 'unknown', timestamp: Date.now() };
    processHostExecIpc(data as any, 'main', true, mockExecutor as any);
    expect(mockExecutor.run).not.toHaveBeenCalled();
    expect(mockExecutor.kill).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ipc-host-exec.test.ts`
Expected: FAIL — `processHostExecIpc` not exported

- [ ] **Step 3: Implement processHostExecIpc and wire into watcher**

Add to `src/ipc.ts` — new exported function (at end of file, before default export or at module level):

```typescript
// Import at top of file:
import { HostExecutor } from './host-executor.js';

// New function:
export function processHostExecIpc(
  data: {
    type: string;
    task_id?: string;
    groupFolder?: string;
    command?: string;
    working_dir?: string;
    background?: boolean;
    timestamp?: number;
  },
  sourceGroup: string,
  isMain: boolean,
  executor: HostExecutor,
): void {
  switch (data.type) {
    case 'host_exec':
      if (data.task_id && data.command) {
        executor.run({
          taskId: data.task_id,
          groupFolder: sourceGroup,
          command: data.command,
          workingDir: data.working_dir || process.cwd(),
          background: data.background ?? true,
        });
        logger.info({ taskId: data.task_id, sourceGroup }, 'Host exec started via IPC');
      }
      break;

    case 'host_kill':
      if (data.task_id) {
        // Authorization: only main or same group can kill
        const taskGroup = data.groupFolder || sourceGroup;
        if (!isMain && taskGroup !== sourceGroup) {
          logger.warn({ taskId: data.task_id, sourceGroup, taskGroup }, 'Unauthorized host_kill blocked');
          break;
        }
        executor.kill(data.task_id, taskGroup);
        logger.info({ taskId: data.task_id, sourceGroup }, 'Host kill requested via IPC');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown host-exec IPC type');
  }
}
```

Then wire it into the watcher loop inside `processIpcFiles()`. After the existing tasks processing block (around line 152), add:

```typescript
      // Process host-exec requests from this group's IPC directory
      const hostExecDir = path.join(ipcBaseDir, sourceGroup, 'host-exec');
      try {
        if (fs.existsSync(hostExecDir)) {
          const hostExecFiles = fs
            .readdirSync(hostExecDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of hostExecFiles) {
            const filePath = path.join(hostExecDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              processHostExecIpc(data, sourceGroup, isMain, hostExecutor);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC host-exec');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC host-exec directory');
      }
```

Update `IpcDeps` to accept `hostExecutor`:
```typescript
export interface IpcDeps {
  // ... existing fields ...
  hostExecutor?: HostExecutor;
}
```

And at the start of `startIpcWatcher`, extract it:
```typescript
const hostExecutor = deps.hostExecutor;
```

Only process host-exec files if `hostExecutor` is provided (makes it opt-in, existing callers unaffected):
```typescript
if (hostExecutor) {
  // ... host-exec processing block ...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ipc-host-exec.test.ts`
Expected: PASS

- [ ] **Step 5: Run ALL tests to verify no regression**

Run: `npx vitest run`
Expected: All existing tests still pass. The `hostExecutor` field is optional so existing IpcDeps callers are unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/ipc.ts src/ipc-host-exec.test.ts
git commit -m "feat: add host-exec IPC handling with authorization"
```

---

### Task 6: Container Runner — mount and env var changes

**Files:**
- Modify: `src/container-runner.ts`
- Modify: `src/container-runner.test.ts`

- [ ] **Step 1: Write failing test for new mount**

Append to `src/container-runner.test.ts` (check existing test patterns first):

```typescript
  it('includes host-tasks readonly mount and host-exec directory', () => {
    // This test verifies buildVolumeMounts includes the new host-tasks mount
    // and creates the host-exec IPC directory.
    // Implementation detail: check that data/host-tasks/{group}/ dir is created
    // and mount is added.
    // (Exact test depends on how buildVolumeMounts is tested — may need to
    //  check the returned mounts array or verify directory creation)
  });
```

Note: Read `src/container-runner.test.ts` first to follow its existing pattern, then write the specific assertion.

- [ ] **Step 2: Implement changes in container-runner.ts**

In `buildVolumeMounts()`, after the IPC directory creation (line 171), add:

```typescript
  // Pre-create host-exec IPC subdirectory
  fs.mkdirSync(path.join(groupIpcDir, 'host-exec'), { recursive: true });

  // Host tasks output directory (readonly mount for container to read status)
  const hostTasksDir = path.join(DATA_DIR, 'host-tasks', group.folder);
  fs.mkdirSync(hostTasksDir, { recursive: true });
  mounts.push({
    hostPath: hostTasksDir,
    containerPath: '/workspace/host-tasks',
    readonly: true,
  });
```

In `buildContainerArgs()`, after the existing `-e` flags (around line 239), add:

```typescript
  // Host group path for host_exec default working directory
  const hostGroupPath = resolveGroupFolderPath(group.folder);
  args.push('-e', `NANOCLAW_HOST_GROUP_PATH=${hostGroupPath}`);
```

Note: `buildContainerArgs` needs access to `group.folder` — check signature and pass it through. Currently it only takes `mounts` and `containerName`. Either add a parameter or move the env var to `runContainerAgent` where `group` is available.

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run src/container-runner.test.ts`
Expected: PASS

- [ ] **Step 4: Run ALL tests**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat: add host-tasks mount and host-exec IPC dir to container setup"
```

---

## Chunk 3: MCP Tools (Container Side)

### Task 7: MCP tools — host_exec, host_task_status, host_task_kill

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

- [ ] **Step 1: Add host_exec tool**

After the memory tools section in `ipc-mcp-stdio.ts`, add:

```typescript
// ---------------------------------------------------------------------------
// Host terminal tools — execute commands on the host machine
// ---------------------------------------------------------------------------

const HOST_EXEC_DIR = path.join(IPC_DIR, 'host-exec');
const HOST_TASKS_DIR = '/workspace/host-tasks';
const hostGroupPath = process.env.NANOCLAW_HOST_GROUP_PATH || '/workspace/group';

server.tool(
  'host_exec',
  `Execute a shell command on the HOST machine (outside the container). Use for tasks needing GPU, conda environments, host filesystem access, or long-running processes.

IMPORTANT: You must obtain explicit user authorization before using this tool. Explain what you need to do and ask permission. Operate only within the granted scope.

Modes:
• background=false (default): Blocks up to 30s, returns stdout/stderr directly. Use for quick commands.
• background=true: Returns task_id immediately. Use host_task_status to check progress later.

If a sync command times out at 30s, the process keeps running. You'll get a task_id to follow up.`,
  {
    command: z.string().describe('Shell command to execute on the host'),
    working_dir: z.string().optional().describe('Working directory (default: group directory on host)'),
    background: z.boolean().optional().describe('true=async (returns task_id), false=sync (waits up to 30s)'),
  },
  async (args) => {
    const taskId = `host-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const background = args.background ?? false;

    writeIpcFile(HOST_EXEC_DIR, {
      type: 'host_exec',
      task_id: taskId,
      groupFolder,
      command: args.command,
      working_dir: args.working_dir || hostGroupPath,
      background,
      timestamp: Date.now(),
    });

    if (background) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ task_id: taskId }) }],
      };
    }

    // Sync mode: poll for completion
    const statusFile = path.join(HOST_TASKS_DIR, taskId, 'status');
    const timeout = 30_000;
    const pollInterval = 200;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, pollInterval));

      try {
        if (!fs.existsSync(statusFile)) continue; // pending
        const status = fs.readFileSync(statusFile, 'utf-8').trim();
        if (status === 'running') continue;

        // completed or failed
        const taskDir = path.join(HOST_TASKS_DIR, taskId);
        const stdout = fs.existsSync(path.join(taskDir, 'stdout.log'))
          ? fs.readFileSync(path.join(taskDir, 'stdout.log'), 'utf-8')
          : '';
        const stderr = fs.existsSync(path.join(taskDir, 'stderr.log'))
          ? fs.readFileSync(path.join(taskDir, 'stderr.log'), 'utf-8')
          : '';
        const meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf-8'));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ exit_code: meta.exit_code, stdout, stderr }),
          }],
        };
      } catch { /* retry */ }
    }

    // Timeout — process keeps running
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'timeout', task_id: taskId }),
      }],
    };
  },
);
```

- [ ] **Step 2: Add host_task_status tool**

```typescript
server.tool(
  'host_task_status',
  'Check status and output of a host task started with host_exec(background=true).',
  {
    task_id: z.string().describe('The task ID returned by host_exec'),
    tail: z.number().optional().describe('Lines from end of output (default 50, -1 for all)'),
  },
  async (args) => {
    const taskDir = path.join(HOST_TASKS_DIR, args.task_id);

    if (!fs.existsSync(taskDir)) {
      return { content: [{ type: 'text' as const, text: `Task ${args.task_id} not found.` }], isError: true };
    }

    const status = fs.existsSync(path.join(taskDir, 'status'))
      ? fs.readFileSync(path.join(taskDir, 'status'), 'utf-8').trim()
      : 'unknown';

    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf-8'));
    } catch { /* best effort */ }

    const tailN = args.tail ?? 50;

    const readTail = (file: string): string => {
      const fullPath = path.join(taskDir, file);
      if (!fs.existsSync(fullPath)) return '';
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (tailN === -1) return content;
      const lines = content.split('\n');
      return lines.slice(-tailN).join('\n');
    };

    const result = {
      status,
      exit_code: meta.exit_code ?? null,
      stdout_tail: readTail('stdout.log'),
      stderr_tail: readTail('stderr.log'),
      started_at: meta.started_at || null,
      finished_at: meta.finished_at || null,
    };

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);
```

- [ ] **Step 3: Add host_task_kill tool**

```typescript
server.tool(
  'host_task_kill',
  'Terminate a running host task.',
  {
    task_id: z.string().describe('The task ID to kill'),
  },
  async (args) => {
    writeIpcFile(HOST_EXEC_DIR, {
      type: 'host_kill',
      task_id: args.task_id,
      groupFolder,
      timestamp: Date.now(),
    });

    return { content: [{ type: 'text' as const, text: `Kill requested for task ${args.task_id}.` }] };
  },
);
```

- [ ] **Step 4: Build to verify TypeScript compiles**

Run: `npm run build`
Expected: No type errors

- [ ] **Step 5: Run ALL tests**

Run: `npx vitest run`
Expected: All pass (MCP tools are only exercised at runtime, not in unit tests)

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat: add host_exec, host_task_status, host_task_kill MCP tools"
```

---

## Chunk 4: Wiring and Verification

### Task 8: Wire HostExecutor into main startup

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Read src/index.ts to find IPC watcher initialization**

Find where `startIpcWatcher(deps)` is called and where deps are constructed.

- [ ] **Step 2: Add HostExecutor initialization**

At the top of `src/index.ts`, import:
```typescript
import { HostExecutor } from './host-executor.js';
```

Before `startIpcWatcher(deps)`, create and recover:
```typescript
const hostExecutor = new HostExecutor(path.join(DATA_DIR, 'host-tasks'));
hostExecutor.recover();
```

Add to deps:
```typescript
const deps = {
  // ... existing ...
  hostExecutor,
};
```

- [ ] **Step 3: Build and run all tests**

Run: `npm run build && npx vitest run`
Expected: Build clean, all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire HostExecutor into main startup with recovery"
```

---

### Task 9: Final verification — build, test, no regression

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: Clean, no errors

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: All tests pass (previous 327+ tests plus new host-executor and ipc-host-exec tests)

- [ ] **Step 3: Verify existing test counts**

Ensure test count is >= 327 (original) + new tests. No existing test was removed or modified (except container-runner.test.ts where a test was added).

- [ ] **Step 4: Manual smoke test (optional)**

Create a test IPC file manually:
```bash
mkdir -p data/ipc/main/host-exec
echo '{"type":"host_exec","task_id":"smoke-001","groupFolder":"main","command":"echo smoke-test","working_dir":"/tmp","background":true,"timestamp":1234}' > data/ipc/main/host-exec/test.json
```

After NanoClaw processes it, check:
```bash
cat data/host-tasks/main/smoke-001/status
cat data/host-tasks/main/smoke-001/stdout.log
```

Expected: `completed` and `smoke-test`
