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
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  proc.pid = 54321;
  proc.killed = false;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    execSync: vi.fn(() => Buffer.from('claude 1.0.0\n')),
  };
});

import {
  runHostAgent,
  validateClaudeCli,
  HostRunnerOutput,
} from './host-runner.js';
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
      (execSync as any).mockImplementationOnce(() => {
        throw new Error('not found');
      });
      expect(validateClaudeCli()).toBe(false);
    });
  });

  describe('runHostAgent', () => {
    it('spawns claude with correct args for single-turn mode', async () => {
      const { spawn } = await import('child_process');
      const onProcess = vi.fn();

      const resultPromise = runHostAgent(testGroup, testInput, onProcess);

      await vi.advanceTimersByTimeAsync(10);

      const spawnCalls = (spawn as any).mock.calls;
      const lastCall = spawnCalls[spawnCalls.length - 1];
      const [cmd, args, opts] = lastCall;
      expect(cmd).toBe('claude');
      expect(args).toContain('-p');
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).not.toContain('--resume');
      expect(opts.cwd).toContain('test-group');

      expect(onProcess).toHaveBeenCalledWith(
        fakeProc,
        expect.stringContaining('host-test-group'),
      );

      fakeProc.stdout.push(
        JSON.stringify({
          type: 'result',
          result: '模型训练完成',
          session_id: 'sess-abc-123',
        }) + '\n',
      );
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

      fakeProc.stdout.push(
        JSON.stringify({
          type: 'result',
          result: 'done',
          session_id: 'existing-session',
        }) + '\n',
      );
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
      const resultPromise = runHostAgent(
        testGroup,
        testInput,
        vi.fn(),
        onOutput,
      );

      await vi.advanceTimersByTimeAsync(10);

      fakeProc.stdout.push(
        JSON.stringify({
          type: 'result',
          result: 'Training complete',
          session_id: 'sess-1',
        }) + '\n',
      );
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultPromise;
      expect(onOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          result: 'Training complete',
          sessionId: 'sess-1',
        }),
      );
      expect(result.status).toBe('success');
    });

    it('handles timeout by killing process', async () => {
      const resultPromise = runHostAgent(testGroup, testInput, vi.fn());
      await vi.advanceTimersByTimeAsync(10);

      // Advance past default timeout (30 minutes = 1800000ms)
      await vi.advanceTimersByTimeAsync(1800000);

      expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');

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
      const resultPromise = runHostAgent(
        testGroup,
        testInput,
        vi.fn(),
        onOutput,
      );
      await vi.advanceTimersByTimeAsync(10);

      fakeProc.stdout.push(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'thinking...' }] },
        }) + '\n',
      );
      fakeProc.stdout.push(
        JSON.stringify({ type: 'content_block_start' }) + '\n',
      );
      fakeProc.stdout.push(
        JSON.stringify({
          type: 'result',
          result: 'Final answer',
          session_id: 'sess-2',
        }) + '\n',
      );
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultPromise;
      expect(result.result).toBe('Final answer');
      expect(onOutput).toHaveBeenCalledTimes(1);
    });
  });
});
