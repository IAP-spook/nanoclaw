import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
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
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Control GPU detection via execSync mock (isGpuAvailable calls nvidia-smi via execSync)
const mockExecSync = vi.fn();

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn + execSync (for GPU detection in container-runtime)
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    execSync: (...args: unknown[]) => mockExecSync(...args),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import { resetGpuCache } from './container-runtime.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('container-runner GPU passthrough', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    resetGpuCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('includes --gpus all when gpu: true and GPU available', async () => {
    // Make nvidia-smi succeed so isGpuAvailable() returns true
    mockExecSync.mockReturnValue('Quadro RTX 5000\n');
    const { spawn } = await import('child_process');

    const gpuGroup: RegisteredGroup = {
      ...testGroup,
      containerConfig: { gpu: true },
    };

    const resultPromise = runContainerAgent(
      gpuGroup,
      testInput,
      () => {},
      async () => {},
    );

    // Let it start
    await vi.advanceTimersByTimeAsync(10);

    // Check the last spawn call (previous tests may have also called spawn)
    const spawnCalls = (spawn as any).mock.calls;
    const spawnCall = spawnCalls[spawnCalls.length - 1];
    const args: string[] = spawnCall[1];
    expect(args).toContain('--gpus');
    const gpuIdx = args.indexOf('--gpus');
    expect(args[gpuIdx + 1]).toBe('all');

    // Also check NVIDIA_DRIVER_CAPABILITIES env var
    const envIdx = args.indexOf('NVIDIA_DRIVER_CAPABILITIES=compute,utility');
    expect(envIdx).toBeGreaterThan(-1);
    expect(args[envIdx - 1]).toBe('-e');

    // Clean up
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('omits --gpus when gpu: true but GPU not available', async () => {
    // Make nvidia-smi fail so isGpuAvailable() returns false
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    const { spawn } = await import('child_process');

    const gpuGroup: RegisteredGroup = {
      ...testGroup,
      containerConfig: { gpu: true },
    };

    const resultPromise = runContainerAgent(
      gpuGroup,
      testInput,
      () => {},
      async () => {},
    );

    await vi.advanceTimersByTimeAsync(10);

    const spawnCalls2 = (spawn as any).mock.calls;
    const spawnCall2 = spawnCalls2[spawnCalls2.length - 1];
    const args2: string[] = spawnCall2[1];
    expect(args2).not.toContain('--gpus');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('omits --gpus when gpu not configured', async () => {
    // GPU available but not configured
    mockExecSync.mockReturnValue('Quadro RTX 5000\n');
    const { spawn } = await import('child_process');

    const resultPromise = runContainerAgent(
      testGroup, // no containerConfig.gpu
      testInput,
      () => {},
      async () => {},
    );

    await vi.advanceTimersByTimeAsync(10);

    const spawnCalls3 = (spawn as any).mock.calls;
    const spawnCall3 = spawnCalls3[spawnCalls3.length - 1];
    const args3: string[] = spawnCall3[1];
    expect(args3).not.toContain('--gpus');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});
