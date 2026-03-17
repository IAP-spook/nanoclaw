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
