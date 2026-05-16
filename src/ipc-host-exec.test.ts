import { describe, it, expect, vi, beforeEach } from 'vitest';

import { processHostExecIpc } from './ipc.js';

describe('IPC host-exec handling', () => {
  let mockExecutor: {
    run: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  };

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
