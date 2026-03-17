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

      const status = fs
        .readFileSync(path.join(taskDir, 'status'), 'utf-8')
        .trim();
      expect(status).toBe('completed');

      const meta = JSON.parse(
        fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf-8'),
      );
      expect(meta.command).toBe('echo hello');
      expect(meta.exit_code).toBe(0);
      expect(meta.pid).toBeGreaterThan(0);
      expect(meta.started_at).toBeDefined();
      expect(meta.finished_at).toBeDefined();

      const stdout = fs.readFileSync(path.join(taskDir, 'stdout.log'), 'utf-8');
      expect(stdout.trim()).toBe('hello');
    });
  });

  describe('kill', () => {
    it('terminates a running process and updates status', async () => {
      const taskId = 'test-kill-001';
      executor.run({
        taskId,
        groupFolder: 'main',
        command: 'sleep 60',
        workingDir: tmpDir,
        background: true,
      });
      await new Promise((r) => setTimeout(r, 300));

      const killed = executor.kill(taskId, 'main');
      expect(killed).toBe(true);

      await new Promise((r) => setTimeout(r, 500));
      const taskDir = path.join(tmpDir, 'main', taskId);
      const status = fs
        .readFileSync(path.join(taskDir, 'status'), 'utf-8')
        .trim();
      expect(status).toBe('killed');
    });

    it('returns false for non-existent task', () => {
      expect(executor.kill('no-such-task', 'main')).toBe(false);
    });
  });

  describe('run (failure)', () => {
    it('captures stderr and writes failed status', async () => {
      const taskId = 'test-fail-001';
      executor.run({
        taskId,
        groupFolder: 'main',
        command: 'echo err >&2 && exit 1',
        workingDir: tmpDir,
        background: true,
      });
      await new Promise((r) => setTimeout(r, 1000));

      const taskDir = path.join(tmpDir, 'main', taskId);
      const status = fs
        .readFileSync(path.join(taskDir, 'status'), 'utf-8')
        .trim();
      expect(status).toBe('failed');

      const meta = JSON.parse(
        fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf-8'),
      );
      expect(meta.exit_code).toBe(1);

      const stderr = fs.readFileSync(path.join(taskDir, 'stderr.log'), 'utf-8');
      expect(stderr.trim()).toBe('err');
    });
  });

  describe('recover', () => {
    it('marks dead tasks as failed on recovery', () => {
      const taskDir = path.join(tmpDir, 'main', 'test-recover-001');
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(path.join(taskDir, 'status'), 'running');
      fs.writeFileSync(
        path.join(taskDir, 'meta.json'),
        JSON.stringify({
          command: 'sleep 999',
          pid: 999999,
          started_at: '2026-01-01T00:00:00Z',
        }),
      );

      executor.recover();

      const status = fs
        .readFileSync(path.join(taskDir, 'status'), 'utf-8')
        .trim();
      expect(status).toBe('failed');

      const meta = JSON.parse(
        fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf-8'),
      );
      expect(meta.finished_at).toBeDefined();
    });

    it('leaves completed tasks untouched', () => {
      const taskDir = path.join(tmpDir, 'main', 'test-recover-002');
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(path.join(taskDir, 'status'), 'completed');
      fs.writeFileSync(
        path.join(taskDir, 'meta.json'),
        JSON.stringify({ command: 'echo ok', pid: 1, exit_code: 0 }),
      );

      executor.recover();

      const status = fs
        .readFileSync(path.join(taskDir, 'status'), 'utf-8')
        .trim();
      expect(status).toBe('completed');
    });
  });
});
