import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
}));

// Mock fs operations used by sendMessage/closeStdin
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Single group at a time (same-type serialization) ---

  it('only runs one message container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 should be active (MAX_CONCURRENT_CONTAINERS = 2)
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Pending tasks drain in the task slot ---

  it('drains pending tasks in the task slot', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const taskFn1 = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      executionOrder.push('task-1');
    });

    const taskFn2 = vi.fn(async () => {
      executionOrder.push('task-2');
    });

    // Start first task (takes the task slot)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn1);
    await vi.advanceTimersByTimeAsync(10);

    // Queue second task while first is running
    queue.enqueueTask('group1@g.us', 'task-2', taskFn2);

    // Release the first task
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Both tasks ran in order
    expect(executionOrder).toEqual(['task-1', 'task-2']);
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms (BASE_RETRY_MS * 2^0)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms (BASE_RETRY_MS * 2^1)
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 5 retries (MAX_RETRIES = 5)
    // Initial call
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry 1: 5000ms, Retry 2: 10000ms, Retry 3: 20000ms, Retry 4: 40000ms, Retry 5: 80000ms
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    // After 5 retries (6 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000); // Wait a long time
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // --- Running task dedup ---

  it('rejects duplicate enqueue of a currently-running task', async () => {
    let resolveTask: () => void;
    let taskCallCount = 0;

    const taskFn = vi.fn(async () => {
      taskCallCount++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start the task (runs immediately — slot available)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    // Scheduler poll re-discovers the same task while it's running —
    // this must be silently dropped
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    // Duplicate was NOT queued
    expect(dupFn).not.toHaveBeenCalled();

    // Complete the original task
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    // Only one execution total
    expect(taskCallCount).toBe(1);
  });

  // --- Dual slot: task starts in its own slot while message is running ---

  it('task starts in its own slot while message container is still running', async () => {
    let resolveProcess: () => void;
    let taskStarted = false;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing (takes the message slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Enqueue a task — should start immediately in its own slot
    const taskFn = vi.fn(async () => {
      taskStarted = true;
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Task started in its own slot while message container is still running
    expect(taskStarted).toBe(true);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage returns false when no message container is active', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start a task (only task slot active, message slot inactive)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
      'task',
    );

    // sendMessage should return false — no active message container
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- New dual-slot tests ---

  it('allows message and task containers to run in parallel for same group', async () => {
    let messageRunning = false;
    let taskRunning = false;
    let bothRunning = false;
    let resolveMessage: () => void;
    let resolveTask: () => void;

    const processMessages = vi.fn(async () => {
      messageRunning = true;
      bothRunning = bothRunning || (messageRunning && taskRunning);
      await new Promise<void>((resolve) => {
        resolveMessage = resolve;
      });
      messageRunning = false;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start message container
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Start task container for same group
    const taskFn = vi.fn(async () => {
      taskRunning = true;
      bothRunning = bothRunning || (messageRunning && taskRunning);
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
      taskRunning = false;
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Both should have been running concurrently
    expect(bothRunning).toBe(true);

    resolveMessage!();
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('allows message container to start while task is running for same group', async () => {
    let resolveTask: () => void;
    let messageStarted = false;

    const processMessages = vi.fn(async () => {
      messageStarted = true;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start task first
    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Enqueue a message check — should start immediately (different slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(messageStarted).toBe(true);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('serializes two messages for same group (same-type serial)', async () => {
    let concurrentMessages = 0;
    let maxConcurrentMessages = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async () => {
      concurrentMessages++;
      maxConcurrentMessages = Math.max(
        maxConcurrentMessages,
        concurrentMessages,
      );
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      concurrentMessages--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(maxConcurrentMessages).toBe(1);

    // Complete first, second should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(2);
    expect(maxConcurrentMessages).toBe(1);
  });

  it('serializes two tasks for same group (same-type serial)', async () => {
    let concurrentTasks = 0;
    let maxConcurrentTasks = 0;
    const completionCallbacks: Array<() => void> = [];

    const taskFn1 = vi.fn(async () => {
      concurrentTasks++;
      maxConcurrentTasks = Math.max(maxConcurrentTasks, concurrentTasks);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      concurrentTasks--;
    });

    const taskFn2 = vi.fn(async () => {
      concurrentTasks++;
      maxConcurrentTasks = Math.max(maxConcurrentTasks, concurrentTasks);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      concurrentTasks--;
    });

    queue.enqueueTask('group1@g.us', 'task-1', taskFn1);
    queue.enqueueTask('group1@g.us', 'task-2', taskFn2);
    await vi.advanceTimersByTimeAsync(10);

    expect(maxConcurrentTasks).toBe(1);

    // Complete first task, second should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(taskFn2).toHaveBeenCalled();
    expect(maxConcurrentTasks).toBe(1);
  });

  it('counts both message and task containers toward global concurrency limit', async () => {
    let resolveMessage: () => void;
    let resolveTask: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveMessage = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start message for group1 (slot 1 of 2)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Start task for group1 (slot 2 of 2)
    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Now at limit (2). A third group should be queued.
    const thirdGroupStarted = vi.fn(async () => true);
    queue.setProcessMessagesFn(thirdGroupStarted);
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(thirdGroupStarted).not.toHaveBeenCalled();

    // Free one slot
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    expect(thirdGroupStarted).toHaveBeenCalled();

    resolveMessage!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('closeStdin for message writes _close to input dir', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
      'message',
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    queue.closeStdin('group1@g.us', 'message');

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);
    expect(closeWrites[0][0]).toContain('/input/_close');
    expect(closeWrites[0][0]).not.toContain('task-input');

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('closeStdin for task writes _close to task-input dir', async () => {
    const fs = await import('fs');
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
      'task',
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    queue.closeStdin('group1@g.us', 'task');

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);
    expect(closeWrites[0][0]).toContain('/task-input/_close');

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('message slot freeing drains pending messages, not tasks', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async () => {
      if (executionOrder.length === 0) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start message container
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a pending message while message container is active
    queue.enqueueMessageCheck('group1@g.us');

    // Also queue a task — this should start in its own slot immediately
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Task ran immediately in its own slot
    expect(executionOrder).toContain('task');

    // Release the first message container
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Pending message should have been drained
    const messageCount = executionOrder.filter((e) => e === 'messages').length;
    expect(messageCount).toBe(2); // first + drained
  });

  it('shutdown reports containers from both message and task slots', async () => {
    let resolveMessage: () => void;
    let resolveTask: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveMessage = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start message container
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    const mockMessageProc = { killed: false } as any;
    queue.registerProcess(
      'group1@g.us',
      mockMessageProc,
      'msg-container',
      'test-group',
      'message',
    );

    // Start task container
    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    const mockTaskProc = { killed: false } as any;
    queue.registerProcess(
      'group1@g.us',
      mockTaskProc,
      'task-container',
      'test-group',
      'task',
    );

    // Shutdown should see both containers
    await queue.shutdown(1000);

    // Verify shutdown doesn't throw and queue is in shutdown state
    // (The logger.info call in shutdown would list both containers;
    // we verify by ensuring no new enqueues are accepted)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    // processMessages was called only once (before shutdown)
    expect(processMessages).toHaveBeenCalledTimes(1);

    resolveMessage!();
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });
});
