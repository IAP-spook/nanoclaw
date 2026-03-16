# Host Claude Code Execution Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route tasks requiring host capabilities (conda, GPU, training) to a host-side Claude Code CLI process instead of a container, with keyword-based routing and IPC reverse communication.

**Architecture:** A host-router decides per-prompt whether to run in container or on host. A host-runner spawns `claude` CLI processes with `--dangerously-skip-permissions --output-format stream-json`, parsing streaming output for results and session IDs. Both runners share GroupQueue's slot mechanism. An IPC error cleanup task runs at startup and daily.

**Tech Stack:** Node.js, TypeScript, `child_process.spawn`, Vitest

**Spec:** `docs/superpowers/specs/2026-03-16-host-claude-code-execution-design.md`

---

## Chunk 1: Host Router and Host Runner

### Task 1: Host Router (`src/host-router.ts`)

Pure routing logic — no I/O, no process spawning. Decides container vs host based on keywords and manual override prefixes.

**Files:**
- Create: `src/host-router.ts`
- Create: `src/host-router.test.ts`

- [ ] **Step 1: Write failing tests for `shouldRunOnHost`**

Create `src/host-router.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { shouldRunOnHost, loadHostConfig, HostRouteConfig } from './host-router.js';

const defaultConfig: HostRouteConfig = {
  enabled: true,
  keywords: ['训练', 'train', 'conda', 'GPU', '模型', 'model', 'python', '系统', 'pip', 'pytorch'],
  forceHostPrefix: '在主机上',
  forceContainerPrefix: '用容器',
};

describe('host-router', () => {
  describe('shouldRunOnHost', () => {
    it('returns false when disabled', () => {
      const config = { ...defaultConfig, enabled: false };
      expect(shouldRunOnHost('请训练模型', config)).toBe(false);
    });

    it('returns false for prompts without keywords', () => {
      expect(shouldRunOnHost('你好，今天天气怎么样', defaultConfig)).toBe(false);
    });

    it('returns true when prompt contains a keyword', () => {
      expect(shouldRunOnHost('请帮我训练一下这个模型', defaultConfig)).toBe(true);
    });

    it('keyword matching is case-insensitive', () => {
      expect(shouldRunOnHost('Install gpu drivers', defaultConfig)).toBe(true);
    });

    it('forceHostPrefix overrides keywords', () => {
      expect(shouldRunOnHost('在主机上 查看文件', defaultConfig)).toBe(true);
    });

    it('forceContainerPrefix overrides keywords', () => {
      expect(shouldRunOnHost('用容器 训练模型', defaultConfig)).toBe(false);
    });

    it('forceContainerPrefix takes priority over forceHostPrefix', () => {
      // Edge case: both prefixes present — container wins (safer default)
      expect(shouldRunOnHost('用容器 在主机上 训练', defaultConfig)).toBe(false);
    });

    it('returns false with empty keywords list', () => {
      const config = { ...defaultConfig, keywords: [] };
      expect(shouldRunOnHost('请训练模型', config)).toBe(false);
    });

    it('handles missing prefix fields', () => {
      const config: HostRouteConfig = { enabled: true, keywords: ['train'] };
      expect(shouldRunOnHost('train the model', config)).toBe(true);
      expect(shouldRunOnHost('hello world', config)).toBe(false);
    });
  });

  describe('loadHostConfig', () => {
    it('returns default config when file does not exist', () => {
      const config = loadHostConfig('nonexistent-group-folder-xyz');
      expect(config.enabled).toBe(true);
      expect(config.keywords).toContain('训练');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/host-router.test.ts`
Expected: FAIL — module `./host-router.js` not found

- [ ] **Step 3: Implement `src/host-router.ts`**

```typescript
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

export interface HostRouteConfig {
  enabled: boolean;
  keywords: string[];
  forceHostPrefix?: string;
  forceContainerPrefix?: string;
}

const DEFAULT_CONFIG: HostRouteConfig = {
  enabled: true,
  keywords: ['训练', 'train', 'conda', 'GPU', '模型', 'model', 'python', '系统', 'pip', 'pytorch'],
  forceHostPrefix: '在主机上',
  forceContainerPrefix: '用容器',
};

export function shouldRunOnHost(prompt: string, config: HostRouteConfig): boolean {
  if (!config.enabled) return false;

  const trimmed = prompt.trim();

  // Manual override prefixes (container prefix wins if both present)
  if (config.forceContainerPrefix && trimmed.startsWith(config.forceContainerPrefix)) {
    return false;
  }
  if (config.forceHostPrefix && trimmed.startsWith(config.forceHostPrefix)) {
    return true;
  }

  // Keyword matching (case-insensitive)
  const lower = trimmed.toLowerCase();
  return config.keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

export function loadHostConfig(groupFolder: string): HostRouteConfig {
  const configPath = path.join(GROUPS_DIR, groupFolder, 'host-rules.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
      keywords: parsed.keywords ?? DEFAULT_CONFIG.keywords,
      forceHostPrefix: parsed.forceHostPrefix ?? DEFAULT_CONFIG.forceHostPrefix,
      forceContainerPrefix: parsed.forceContainerPrefix ?? DEFAULT_CONFIG.forceContainerPrefix,
    };
  } catch {
    logger.debug({ groupFolder }, 'No host-rules.json found, using defaults');
    return { ...DEFAULT_CONFIG };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/host-router.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/host-router.ts src/host-router.test.ts
git commit -m "feat: add host-router for keyword-based container/host routing"
```

---

### Task 2: Host Runner (`src/host-runner.ts`)

Spawns `claude` CLI on the host, parses `stream-json` output, manages timeouts, and integrates with GroupQueue slots.

**Files:**
- Create: `src/host-runner.ts`
- Create: `src/host-runner.test.ts`

**Context for implementer:**
- Mirror the pattern from `src/container-runner.ts` (lines 292-671) — same signature shape: `(group, input, onProcess, onOutput?) => Promise<Output>`
- The `stream-json` format from `claude` CLI emits one JSON object per line on stdout. The final event has `type: "result"` with fields `result` (text) and `session_id` (string).
- Host processes use SIGTERM for shutdown (not sentinel files like containers).
- The `onProcess` callback is called with `(proc, name)` so GroupQueue can register the process.

- [ ] **Step 1: Write failing tests for host runner**

Create `src/host-runner.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  CONTAINER_TIMEOUT: 1800000,
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

// Create fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    killed: boolean;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn(() => { proc.killed = true; });
  proc.pid = 54321;
  proc.killed = false;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    execSync: vi.fn(() => Buffer.from('claude 1.0.0\n')),
  };
});

import { runHostAgent, validateClaudeCli, HostRunnerOutput } from './host-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: '训练模型',
  groupFolder: 'test-group',
  chatJid: 'test@feishu',
  isMain: false,
};

describe('host-runner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('validateClaudeCli', () => {
    it('returns true when claude is available', () => {
      expect(validateClaudeCli()).toBe(true);
    });

    it('returns false when claude is not available', async () => {
      const { execSync } = await import('child_process');
      (execSync as any).mockImplementationOnce(() => { throw new Error('not found'); });
      expect(validateClaudeCli()).toBe(false);
    });
  });

  describe('runHostAgent', () => {
    it('spawns claude with correct args for single-turn mode', async () => {
      const { spawn } = await import('child_process');
      const onProcess = vi.fn();

      const resultPromise = runHostAgent(testGroup, testInput, onProcess);

      await vi.advanceTimersByTimeAsync(10);

      // Verify spawn was called with correct args
      const spawnCalls = (spawn as any).mock.calls;
      const lastCall = spawnCalls[spawnCalls.length - 1];
      const [cmd, args, opts] = lastCall;
      expect(cmd).toBe('claude');
      expect(args).toContain('-p');
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).not.toContain('--resume');
      // Working directory is the group folder
      expect(opts.cwd).toContain('test-group');

      // Verify onProcess was called
      expect(onProcess).toHaveBeenCalledWith(fakeProc, expect.stringContaining('host-test-group'));

      // Emit result event and close
      fakeProc.stdout.push(JSON.stringify({
        type: 'result',
        result: '模型训练完成',
        session_id: 'sess-abc-123',
      }) + '\n');
      fakeProc.emit('close', 0);

      await vi.advanceTimersByTimeAsync(10);

      const result = await resultPromise;
      expect(result.status).toBe('success');
      expect(result.result).toBe('模型训练完成');
      expect(result.sessionId).toBe('sess-abc-123');
    });

    it('spawns claude with --resume for session mode', async () => {
      const { spawn } = await import('child_process');

      const sessionInput = { ...testInput, sessionId: 'existing-session' };
      const resultPromise = runHostAgent(testGroup, sessionInput, vi.fn());

      await vi.advanceTimersByTimeAsync(10);

      const spawnCalls = (spawn as any).mock.calls;
      const lastCall = spawnCalls[spawnCalls.length - 1];
      const args: string[] = lastCall[1];
      expect(args).toContain('--resume');
      expect(args).toContain('existing-session');

      fakeProc.stdout.push(JSON.stringify({ type: 'result', result: 'done', session_id: 'existing-session' }) + '\n');
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);
      await resultPromise;
    });

    it('handles non-zero exit code as error', async () => {
      const resultPromise = runHostAgent(testGroup, testInput, vi.fn());
      await vi.advanceTimersByTimeAsync(10);

      fakeProc.stderr.push('Error: something went wrong\n');
      fakeProc.emit('close', 1);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultPromise;
      expect(result.status).toBe('error');
      expect(result.error).toContain('exited with code 1');
    });

    it('calls onOutput callback with parsed result', async () => {
      const onOutput = vi.fn(async () => {});
      const resultPromise = runHostAgent(testGroup, testInput, vi.fn(), onOutput);

      await vi.advanceTimersByTimeAsync(10);

      fakeProc.stdout.push(JSON.stringify({
        type: 'result',
        result: 'Training complete',
        session_id: 'sess-1',
      }) + '\n');
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultPromise;
      expect(onOutput).toHaveBeenCalledWith(expect.objectContaining({
        status: 'success',
        result: 'Training complete',
        sessionId: 'sess-1',
      }));
      expect(result.status).toBe('success');
    });

    it('handles timeout by killing process', async () => {
      const resultPromise = runHostAgent(testGroup, testInput, vi.fn());
      await vi.advanceTimersByTimeAsync(10);

      // Advance past default timeout (30 minutes = 1800000ms)
      await vi.advanceTimersByTimeAsync(1800000);

      // Process should have been killed
      expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');

      // Simulate process exit after SIGTERM
      fakeProc.emit('close', 143);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultPromise;
      expect(result.status).toBe('error');
      expect(result.error).toContain('timed out');
    });

    it('handles spawn error', async () => {
      const resultPromise = runHostAgent(testGroup, testInput, vi.fn());
      await vi.advanceTimersByTimeAsync(10);

      fakeProc.emit('error', new Error('spawn ENOENT'));
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultPromise;
      expect(result.status).toBe('error');
      expect(result.error).toContain('spawn error');
    });

    it('ignores non-result stream-json lines', async () => {
      const onOutput = vi.fn(async () => {});
      const resultPromise = runHostAgent(testGroup, testInput, vi.fn(), onOutput);
      await vi.advanceTimersByTimeAsync(10);

      // Emit various non-result events
      fakeProc.stdout.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking...' }] } }) + '\n');
      fakeProc.stdout.push(JSON.stringify({ type: 'content_block_start' }) + '\n');

      // Then emit the result
      fakeProc.stdout.push(JSON.stringify({ type: 'result', result: 'Final answer', session_id: 'sess-2' }) + '\n');
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultPromise;
      expect(result.result).toBe('Final answer');
      // onOutput called once for the result event
      expect(onOutput).toHaveBeenCalledTimes(1);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/host-runner.test.ts`
Expected: FAIL — module `./host-runner.js` not found

- [ ] **Step 3: Implement `src/host-runner.ts`**

```typescript
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_TIMEOUT, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface HostRunnerInput {
  prompt: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  sessionId?: string;
  isScheduledTask?: boolean;
}

export interface HostRunnerOutput {
  status: 'success' | 'error';
  result: string | null;
  sessionId?: string;
  error?: string;
}

/**
 * Check if the `claude` CLI is available on the host.
 * Called at startup; logs a warning if missing.
 */
export function validateClaudeCli(): boolean {
  try {
    execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    logger.warn('claude CLI not found on host — host execution will not work');
    return false;
  }
}

/**
 * Spawn a Claude Code CLI process on the host.
 * Mirrors runContainerAgent's interface for easy caller switching.
 */
export async function runHostAgent(
  group: RegisteredGroup,
  input: HostRunnerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: HostRunnerOutput) => Promise<void>,
): Promise<HostRunnerOutput> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, input.groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const processName = `host-${group.folder}-${Date.now()}`;

  // Build CLI args
  const args = [
    '-p', input.prompt,
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
  ];

  if (input.sessionId) {
    args.push('--resume', input.sessionId);
  }

  logger.info(
    { group: group.name, processName, hasSession: !!input.sessionId },
    'Spawning host Claude Code agent',
  );

  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      cwd: groupDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(proc, processName);

    let stderr = '';
    let resultText: string | null = null;
    let sessionId: string | undefined;
    let timedOut = false;
    let outputChain = Promise.resolve();

    // Timeout handling
    const timeoutMs = CONTAINER_TIMEOUT;
    let timeoutTimer = setTimeout(() => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Host agent timeout, sending SIGTERM',
      );
      proc.kill('SIGTERM');

      // Force kill after 5 seconds if SIGTERM doesn't work
      setTimeout(() => {
        if (!proc.killed) {
          logger.warn({ processName }, 'SIGTERM did not stop host agent, sending SIGKILL');
          proc.kill('SIGKILL');
        }
      }, 5000);
    }, timeoutMs);

    // Parse stream-json output (one JSON object per line)
    let lineBuffer = '';

    proc.stdout.on('data', (data) => {
      lineBuffer += data.toString();

      let newlineIdx: number;
      while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, newlineIdx).trim();
        lineBuffer = lineBuffer.slice(newlineIdx + 1);

        if (!line) continue;

        try {
          const event = JSON.parse(line);

          if (event.type === 'result') {
            resultText = event.result || null;
            sessionId = event.session_id;

            // Reset timeout on result (activity detected)
            clearTimeout(timeoutTimer);
            timeoutTimer = setTimeout(() => {
              timedOut = true;
              proc.kill('SIGTERM');
            }, timeoutMs);

            if (onOutput) {
              const output: HostRunnerOutput = {
                status: 'success',
                result: resultText,
                sessionId,
              };
              outputChain = outputChain.then(() => onOutput(output));
            }
          }
        } catch {
          // Non-JSON line, skip
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutTimer);
      const duration = Date.now() - startTime;

      // Write log
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `host-${timestamp}.log`);
      fs.writeFileSync(logFile, [
        `=== Host Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `Process: ${processName}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Timed Out: ${timedOut}`,
        `Has Result: ${!!resultText}`,
        `Session ID: ${sessionId || 'none'}`,
        ``,
        `=== Stderr ===`,
        stderr.slice(-2000),
      ].join('\n'));

      if (timedOut) {
        logger.error({ group: group.name, processName, duration }, 'Host agent timed out');
        resolve({
          status: 'error',
          result: null,
          error: `Host agent timed out after ${timeoutMs}ms`,
        });
        return;
      }

      if (code !== 0) {
        logger.error({ group: group.name, processName, code, duration }, 'Host agent exited with error');
        resolve({
          status: 'error',
          result: null,
          error: `Host agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      outputChain.then(() => {
        logger.info({ group: group.name, processName, duration, sessionId }, 'Host agent completed');
        resolve({
          status: 'success',
          result: resultText,
          sessionId,
        });
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutTimer);
      logger.error({ group: group.name, processName, error: err }, 'Host agent spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Host agent spawn error: ${err.message}`,
      });
    });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/host-runner.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/host-runner.ts src/host-runner.test.ts
git commit -m "feat: add host-runner to spawn Claude Code CLI on host"
```

---

## Chunk 2: IPC Cleanup, Integration, and Config

### Task 3: IPC Error Directory Cleanup (`src/ipc.ts`)

Add periodic cleanup of `data/ipc/errors/` — delete files older than 7 days. Run at startup and once per day.

**Files:**
- Modify: `src/ipc.ts`
- Create: `src/ipc-cleanup.test.ts`

- [ ] **Step 1: Write failing test for `cleanupIpcErrors`**

Create `src/ipc-cleanup.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { cleanupIpcErrors } from './ipc.js';

describe('cleanupIpcErrors', () => {
  const errorsDir = '/tmp/nanoclaw-test-data/ipc/errors';
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('deletes files older than 7 days', () => {
    const now = Date.now();
    const oldTime = new Date(now - SEVEN_DAYS_MS - 1000); // 7 days + 1 second ago
    const recentTime = new Date(now - 1000); // 1 second ago

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue([
      'old-error.json' as any,
      'recent-error.json' as any,
    ]);
    vi.spyOn(fs, 'statSync').mockImplementation((filePath) => {
      const name = path.basename(filePath as string);
      return {
        mtime: name === 'old-error.json' ? oldTime : recentTime,
      } as fs.Stats;
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    cleanupIpcErrors();

    expect(unlinkSpy).toHaveBeenCalledTimes(1);
    expect(unlinkSpy).toHaveBeenCalledWith(path.join(errorsDir, 'old-error.json'));
  });

  it('does nothing when errors directory does not exist', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const readdirSpy = vi.spyOn(fs, 'readdirSync');

    cleanupIpcErrors();

    expect(readdirSpy).not.toHaveBeenCalled();
  });

  it('handles errors gracefully', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('permission denied'); });

    // Should not throw
    expect(() => cleanupIpcErrors()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ipc-cleanup.test.ts`
Expected: FAIL — `cleanupIpcErrors` not exported from `./ipc.js`

- [ ] **Step 3: Add `cleanupIpcErrors` to `src/ipc.ts`**

Add to the end of `src/ipc.ts` (before the closing of the file):

```typescript
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete IPC error files older than 7 days.
 * Called at startup and periodically thereafter.
 */
export function cleanupIpcErrors(): void {
  const errorsDir = path.join(DATA_DIR, 'ipc', 'errors');
  try {
    if (!fs.existsSync(errorsDir)) return;

    const now = Date.now();
    const files = fs.readdirSync(errorsDir);
    let deleted = 0;

    for (const file of files) {
      const filePath = path.join(errorsDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtime.getTime() > SEVEN_DAYS_MS) {
          fs.unlinkSync(filePath);
          deleted++;
        }
      } catch (err) {
        logger.warn({ file, err }, 'Error cleaning up IPC error file');
      }
    }

    if (deleted > 0) {
      logger.info({ deleted }, 'Cleaned up old IPC error files');
    }
  } catch (err) {
    logger.error({ err }, 'Error during IPC error cleanup');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ipc-cleanup.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts src/ipc-cleanup.test.ts
git commit -m "feat: add IPC error directory cleanup (7-day retention)"
```

---

### Task 4: Integration in `src/index.ts`

Route messages through host-router, dispatch to host-runner or container-runner accordingly. Add startup validation and IPC cleanup.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add imports**

At the top of `src/index.ts`:

1. Add new imports after the existing imports:
```typescript
import { shouldRunOnHost, loadHostConfig } from './host-router.js';
import { runHostAgent, validateClaudeCli, HostRunnerOutput } from './host-runner.js';
```

2. Modify the existing `import { startIpcWatcher } from './ipc.js';` (line 51) to also import `cleanupIpcErrors`:
```typescript
import { cleanupIpcErrors, startIpcWatcher } from './ipc.js';
```

- [ ] **Step 2: Add host session tracking**

After `let sessions: Record<string, string> = {};` (line 67), add:

```typescript
let hostSessions: Record<string, string> = {};
```

- [ ] **Step 3: Modify `runAgent` to support host routing**

Replace the `runAgent` function (lines 267-352) with a version that checks `shouldRunOnHost` and dispatches accordingly:

```typescript
async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Check if this prompt should run on host
  const hostConfig = loadHostConfig(group.folder);
  const useHost = shouldRunOnHost(prompt, hostConfig);

  if (useHost) {
    return runAgentOnHost(group, prompt, chatJid, isMain, onOutput);
  }

  // Container path (existing behavior)
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(
          chatJid,
          proc,
          containerName,
          group.folder,
          'message',
        ),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function runAgentOnHost(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  isMain: boolean,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const hostSessionId = hostSessions[group.folder];

  // Wrap onOutput to bridge HostRunnerOutput → ContainerOutput
  const wrappedOnOutput = onOutput
    ? async (hostOutput: HostRunnerOutput) => {
        if (hostOutput.sessionId) {
          hostSessions[group.folder] = hostOutput.sessionId;
        }
        // Bridge to ContainerOutput format
        await onOutput({
          status: hostOutput.status,
          result: hostOutput.result,
          newSessionId: hostOutput.sessionId,
          error: hostOutput.error,
        });
      }
    : undefined;

  try {
    const output = await runHostAgent(
      group,
      {
        prompt,
        groupFolder: group.folder,
        chatJid,
        isMain,
        sessionId: hostSessionId,
      },
      (proc, name) =>
        queue.registerProcess(chatJid, proc, name, group.folder, 'message'),
      wrappedOnOutput,
    );

    if (output.sessionId) {
      hostSessions[group.folder] = output.sessionId;
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Host agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Host agent error');
    return 'error';
  }
}
```

- [ ] **Step 4: Add startup calls in `main()`**

In the `main()` function, after `loadState();` (line 484), add:

```typescript
  // Validate claude CLI availability for host execution
  validateClaudeCli();

  // Clean up old IPC error files (7-day retention)
  cleanupIpcErrors();
  setInterval(cleanupIpcErrors, 24 * 60 * 60 * 1000); // Daily cleanup
```

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS (existing tests should not break since host routing defaults to container when no keywords match)

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: integrate host routing into message processing pipeline"
```

---

### Task 5: Integration in `src/task-scheduler.ts`

Add host routing for scheduled tasks. Same pattern as index.ts — check `shouldRunOnHost`, dispatch to `runHostAgent` or `runContainerAgent`.

**Files:**
- Modify: `src/task-scheduler.ts`

- [ ] **Step 1: Add imports**

At the top of `src/task-scheduler.ts`, add:

```typescript
import { shouldRunOnHost, loadHostConfig } from './host-router.js';
import { runHostAgent, HostRunnerOutput } from './host-runner.js';
```

- [ ] **Step 2: Add hostSessions to SchedulerDependencies**

The scheduler needs access to host sessions. Add to the `SchedulerDependencies` interface:

```typescript
export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  getHostSessions?: () => Record<string, string>;  // Optional: only needed for host routing
  setHostSession?: (groupFolder: string, sessionId: string) => void;  // Optional: only needed for host routing
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}
```

- [ ] **Step 3: Modify `runTask` to support host routing**

In the `runTask` function, after the session ID lookup (around line 154), add host routing logic. Replace the `try { const output = await runContainerAgent(...)` block (lines 171-200) with:

```typescript
  const hostConfig = loadHostConfig(task.group_folder);
  const useHost = shouldRunOnHost(task.prompt, hostConfig);

  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return;
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      if (!useHost) {
        deps.queue.closeStdin(task.chat_jid, 'task');
      }
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    if (useHost) {
      const hostSessionId = task.context_mode === 'group'
        ? deps.getHostSessions?.()[task.group_folder]
        : undefined;

      await runHostAgent(
        group,
        {
          prompt: task.prompt,
          groupFolder: task.group_folder,
          chatJid: task.chat_jid,
          isMain,
          sessionId: hostSessionId,
          isScheduledTask: true,
        },
        (proc, name) =>
          deps.onProcess(task.chat_jid, proc, name, task.group_folder),
        async (hostOutput: HostRunnerOutput) => {
          if (hostOutput.sessionId) {
            deps.setHostSession?.(task.group_folder, hostOutput.sessionId);
          }
          if (hostOutput.result) {
            result = hostOutput.result;
            await deps.sendMessage(task.chat_jid, hostOutput.result);
            scheduleClose();
          }
          if (hostOutput.status === 'success') {
            deps.queue.notifyIdle(task.chat_jid, 'task');
            scheduleClose();
          }
          if (hostOutput.status === 'error') {
            error = hostOutput.error || 'Unknown error';
          }
        },
      );
    } else {
      const output = await runContainerAgent(
        group,
        {
          prompt: task.prompt,
          sessionId,
          groupFolder: task.group_folder,
          chatJid: task.chat_jid,
          isMain,
          isScheduledTask: true,
          assistantName: ASSISTANT_NAME,
        },
        (proc, containerName) =>
          deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
        async (streamedOutput: ContainerOutput) => {
          if (streamedOutput.result) {
            result = streamedOutput.result;
            await deps.sendMessage(task.chat_jid, streamedOutput.result);
            scheduleClose();
          }
          if (streamedOutput.status === 'success') {
            deps.queue.notifyIdle(task.chat_jid, 'task');
            scheduleClose();
          }
          if (streamedOutput.status === 'error') {
            error = streamedOutput.error || 'Unknown error';
          }
        },
      );

      if (closeTimer) clearTimeout(closeTimer);

      if (output.status === 'error') {
        error = output.error || 'Unknown error';
      } else if (output.result) {
        result = output.result;
      }
    }

    if (closeTimer) clearTimeout(closeTimer);

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime, useHost },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }
```

- [ ] **Step 4: Update scheduler deps in `index.ts`**

In `src/index.ts`, update the `startSchedulerLoop` call (around line 558) to include host session deps:

```typescript
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    getHostSessions: () => hostSessions,
    setHostSession: (groupFolder, sessionId) => {
      hostSessions[groupFolder] = sessionId;
    },
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder, 'task'),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
```

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/task-scheduler.ts src/index.ts
git commit -m "feat: add host routing for scheduled tasks"
```

---

### Task 6: Default Config and CLAUDE.md

Create default host-rules config and document IPC reverse communication in CLAUDE.md.

**Files:**
- Create: `groups/main/host-rules.json`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Create default host-rules.json**

Create `groups/main/host-rules.json`:

```json
{
  "enabled": true,
  "keywords": ["训练", "train", "conda", "GPU", "模型", "model", "python", "系统", "pip", "pytorch"],
  "forceHostPrefix": "在主机上",
  "forceContainerPrefix": "用容器"
}
```

- [ ] **Step 2: Add IPC documentation to CLAUDE.md**

Add a new section to `CLAUDE.md` after the "Container Build Cache" section:

```markdown
## IPC Reverse Communication

Host-side Claude Code instances can send messages back to Feishu by writing JSON files to the IPC messages directory. NanoClaw's IPC watcher picks them up automatically.

**Path:** `data/ipc/{group}/messages/msg-{timestamp}.json`

**Format:**
```json
{
  "type": "message",
  "chatJid": "oc_xxx@feishu",
  "text": "Your message here"
}
```

- `type` must be `"message"`
- `chatJid` is the Feishu group JID (find it in `groups/{name}/` config)
- Non-main groups can only send to their own `chatJid`
- Files are deleted after processing

**Note:** The IPC directory is relative to the NanoClaw project root, not the group folder. Host Claude Code processes run with `cwd` set to the group folder, so use the absolute project root path.

**Example (Bash — from any working directory):**
```bash
NANOCLAW_ROOT="/home/dell/nanoclaw"
IPC_DIR="$NANOCLAW_ROOT/data/ipc/main/messages"
mkdir -p "$IPC_DIR"
echo '{"type":"message","chatJid":"oc_xxx@feishu","text":"Hello from host!"}' > "$IPC_DIR/msg-$(date +%s).json"
```
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add groups/main/host-rules.json CLAUDE.md
git commit -m "feat: add default host-rules config and IPC documentation"
```

---

### Task 7: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Build the project**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 3: Verify no regressions with existing functionality**

Run: `npx vitest run src/group-queue.test.ts src/container-runner.test.ts src/task-scheduler.test.ts`
Expected: All existing tests PASS unchanged
