# Parallel Task & Message Containers Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow scheduled task containers and message containers to run concurrently for the same group, so users can chat while long-running tasks execute in the background.

**Architecture:** Split `GroupState`'s single active container into two independent `ContainerSlot`s (`message` and `task`). Each slot has its own `active`, `idleWaiting`, `process`, `containerName`, and `groupFolder` fields. Separate IPC input directories (`input/` vs `task-input/`) prevent `_close` sentinel race conditions between parallel containers.

**Tech Stack:** TypeScript, Vitest, Node.js child_process, Docker bind mounts

**Spec:** `docs/superpowers/specs/2026-03-13-parallel-task-message-containers-design.md`

**Rollback point:** Commit `94f819a`

---

## Chunk 1: Core GroupQueue Refactor

### Task 1: Extract ContainerSlot interface and refactor GroupState

**Files:**
- Modify: `src/group-queue.ts:8-28`
- Test: `src/group-queue.test.ts`

- [ ] **Step 1: Run existing tests to establish baseline**

Run: `npx vitest run src/group-queue.test.ts`
Expected: All 13 tests PASS

- [ ] **Step 2: Write failing test — parallel message+task containers**

Add this test to `src/group-queue.test.ts`:

```typescript
it('allows message and task containers to run in parallel for same group', async () => {
  let messageRunning = false;
  let taskRunning = false;
  let bothRunningAtOnce = false;
  let resolveMessage: () => void;
  let resolveTask: () => void;

  const processMessages = vi.fn(async () => {
    messageRunning = true;
    if (taskRunning) bothRunningAtOnce = true;
    await new Promise<void>((resolve) => { resolveMessage = resolve; });
    messageRunning = false;
    return true;
  });

  queue.setProcessMessagesFn(processMessages);

  // Start message container
  queue.enqueueMessageCheck('group1@g.us');
  await vi.advanceTimersByTimeAsync(10);

  // While message container is active, enqueue a task — should start immediately
  const taskFn = vi.fn(async () => {
    taskRunning = true;
    if (messageRunning) bothRunningAtOnce = true;
    await new Promise<void>((resolve) => { resolveTask = resolve; });
    taskRunning = false;
  });
  queue.enqueueTask('group1@g.us', 'task-1', taskFn);
  await vi.advanceTimersByTimeAsync(10);

  // Both should be running concurrently
  expect(bothRunningAtOnce).toBe(true);
  expect(taskFn).toHaveBeenCalled();

  resolveMessage!();
  resolveTask!();
  await vi.advanceTimersByTimeAsync(10);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/group-queue.test.ts`
Expected: FAIL — task is queued (not started) because `state.active` is true from message container

- [ ] **Step 4: Write failing test — task running does not block messages**

```typescript
it('allows message container to start while task is running for same group', async () => {
  let resolveTask: () => void;
  let messageStarted = false;

  const taskFn = vi.fn(async () => {
    await new Promise<void>((resolve) => { resolveTask = resolve; });
  });

  const processMessages = vi.fn(async () => {
    messageStarted = true;
    return true;
  });

  queue.setProcessMessagesFn(processMessages);

  // Start task container
  queue.enqueueTask('group1@g.us', 'task-1', taskFn);
  await vi.advanceTimersByTimeAsync(10);

  // Enqueue message while task is active — should start immediately
  queue.enqueueMessageCheck('group1@g.us');
  await vi.advanceTimersByTimeAsync(10);

  expect(messageStarted).toBe(true);

  resolveTask!();
  await vi.advanceTimersByTimeAsync(10);
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run src/group-queue.test.ts`
Expected: FAIL — message is queued because `state.active` is true from task container

- [ ] **Step 6: Write failing test — same-type still serializes**

```typescript
it('serializes two messages for same group (same-type serial)', async () => {
  let concurrentMessages = 0;
  let maxConcurrentMessages = 0;

  const processMessages = vi.fn(async () => {
    concurrentMessages++;
    maxConcurrentMessages = Math.max(maxConcurrentMessages, concurrentMessages);
    await new Promise((resolve) => setTimeout(resolve, 100));
    concurrentMessages--;
    return true;
  });

  queue.setProcessMessagesFn(processMessages);

  queue.enqueueMessageCheck('group1@g.us');
  queue.enqueueMessageCheck('group1@g.us');

  await vi.advanceTimersByTimeAsync(300);

  // Two messages for same group should NOT run in parallel
  expect(maxConcurrentMessages).toBe(1);
  expect(processMessages).toHaveBeenCalledTimes(2);
});

it('serializes two tasks for same group (same-type serial)', async () => {
  let concurrentTasks = 0;
  let maxConcurrentTasks = 0;
  const completionCallbacks: Array<() => void> = [];

  const task = async () => {
    concurrentTasks++;
    maxConcurrentTasks = Math.max(maxConcurrentTasks, concurrentTasks);
    await new Promise<void>((resolve) => completionCallbacks.push(resolve));
    concurrentTasks--;
  };

  queue.enqueueTask('group1@g.us', 'task-1', task);
  queue.enqueueTask('group1@g.us', 'task-2', vi.fn(task));
  await vi.advanceTimersByTimeAsync(10);

  expect(maxConcurrentTasks).toBe(1);

  completionCallbacks[0]();
  await vi.advanceTimersByTimeAsync(10);

  expect(maxConcurrentTasks).toBe(1);

  completionCallbacks[1]();
  await vi.advanceTimersByTimeAsync(10);
});
```

- [ ] **Step 7: Run tests — same-type serial tests should PASS (existing behavior preserved)**

Run: `npx vitest run src/group-queue.test.ts`
Expected: same-type serial tests PASS, parallel tests still FAIL

- [ ] **Step 8: Write failing test — activeCount counts both slots**

```typescript
it('counts both message and task containers toward global concurrency limit', async () => {
  // MAX_CONCURRENT_CONTAINERS = 2
  const completionCallbacks: Array<() => void> = [];

  const processMessages = vi.fn(async () => {
    await new Promise<void>((resolve) => completionCallbacks.push(resolve));
    return true;
  });

  queue.setProcessMessagesFn(processMessages);

  // Group 1: message container (slot 1)
  queue.enqueueMessageCheck('group1@g.us');
  await vi.advanceTimersByTimeAsync(10);

  // Group 1: task container (slot 2, same group but counts as separate)
  const taskFn = vi.fn(async () => {
    await new Promise<void>((resolve) => completionCallbacks.push(resolve));
  });
  queue.enqueueTask('group1@g.us', 'task-1', taskFn);
  await vi.advanceTimersByTimeAsync(10);

  // Group 2: message should be queued (at concurrency limit)
  queue.enqueueMessageCheck('group2@g.us');
  await vi.advanceTimersByTimeAsync(10);

  // Only group1 message + group1 task should be running
  expect(processMessages).toHaveBeenCalledTimes(1); // only group1 message
  expect(taskFn).toHaveBeenCalledTimes(1); // group1 task

  // Free one slot — group2 should start
  completionCallbacks[0]();
  await vi.advanceTimersByTimeAsync(10);

  expect(processMessages).toHaveBeenCalledTimes(2); // group2 message now runs
});
```

- [ ] **Step 9: Run test to verify it fails**

Run: `npx vitest run src/group-queue.test.ts`
Expected: FAIL — parallel tests still failing

- [ ] **Step 10: Implement ContainerSlot and dual-slot GroupState**

Refactor `src/group-queue.ts`:

```typescript
interface ContainerSlot {
  active: boolean;
  idleWaiting: boolean;
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
}

function createSlot(): ContainerSlot {
  return {
    active: false,
    idleWaiting: false,
    process: null,
    containerName: null,
    groupFolder: null,
  };
}

export type SlotType = 'message' | 'task';

interface GroupState {
  message: ContainerSlot;
  task: ContainerSlot;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  retryCount: number;
}
```

Update `getGroup`:
```typescript
private getGroup(groupJid: string): GroupState {
  let state = this.groups.get(groupJid);
  if (!state) {
    state = {
      message: createSlot(),
      task: createSlot(),
      runningTaskId: null,
      pendingMessages: false,
      pendingTasks: [],
      retryCount: 0,
    };
    this.groups.set(groupJid, state);
  }
  return state;
}
```

Update `enqueueMessageCheck`:
```typescript
enqueueMessageCheck(groupJid: string): void {
  if (this.shuttingDown) return;
  const state = this.getGroup(groupJid);

  if (state.message.active) {
    state.pendingMessages = true;
    logger.debug({ groupJid }, 'Message container active, message queued');
    return;
  }

  if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
    state.pendingMessages = true;
    if (!this.waitingGroups.includes(groupJid)) {
      this.waitingGroups.push(groupJid);
    }
    logger.debug({ groupJid, activeCount: this.activeCount }, 'At concurrency limit, message queued');
    return;
  }

  this.runForGroup(groupJid, 'messages').catch((err) =>
    logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
  );
}
```

Update `enqueueTask` — check `state.task.active` only, **remove cross-slot preemption**:
```typescript
enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
  if (this.shuttingDown) return;
  const state = this.getGroup(groupJid);

  if (state.runningTaskId === taskId) {
    logger.debug({ groupJid, taskId }, 'Task already running, skipping');
    return;
  }
  if (state.pendingTasks.some((t) => t.id === taskId)) {
    logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
    return;
  }

  if (state.task.active) {
    state.pendingTasks.push({ id: taskId, groupJid, fn });
    logger.debug({ groupJid, taskId }, 'Task container active, task queued');
    return;
  }

  if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
    state.pendingTasks.push({ id: taskId, groupJid, fn });
    if (!this.waitingGroups.includes(groupJid)) {
      this.waitingGroups.push(groupJid);
    }
    logger.debug({ groupJid, taskId, activeCount: this.activeCount }, 'At concurrency limit, task queued');
    return;
  }

  this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
    logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
  );
}
```

Update `registerProcess` — add `type` parameter:
```typescript
registerProcess(
  groupJid: string,
  proc: ChildProcess,
  containerName: string,
  groupFolder?: string,
  type: SlotType = 'message',
): void {
  const state = this.getGroup(groupJid);
  const slot = state[type];
  slot.process = proc;
  slot.containerName = containerName;
  if (groupFolder) slot.groupFolder = groupFolder;
}
```

Update `notifyIdle` — add `type` parameter, **no cross-slot preemption**:
```typescript
notifyIdle(groupJid: string, type: SlotType = 'message'): void {
  const state = this.getGroup(groupJid);
  state[type].idleWaiting = true;
}
```

Update `sendMessage` — check `state.message.active`:
```typescript
sendMessage(groupJid: string, text: string): boolean {
  const state = this.getGroup(groupJid);
  if (!state.message.active || !state.message.groupFolder) return false;
  state.message.idleWaiting = false;

  const inputDir = path.join(DATA_DIR, 'ipc', state.message.groupFolder, 'input');
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
    const filepath = path.join(inputDir, filename);
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
    fs.renameSync(tempPath, filepath);
    return true;
  } catch {
    return false;
  }
}
```

Update `closeStdin` — add `type` parameter, write to correct IPC dir:
```typescript
closeStdin(groupJid: string, type: SlotType = 'message'): void {
  const state = this.getGroup(groupJid);
  const slot = state[type];
  if (!slot.active || !slot.groupFolder) return;

  const subdir = type === 'task' ? 'task-input' : 'input';
  const inputDir = path.join(DATA_DIR, 'ipc', slot.groupFolder, subdir);
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, '_close'), '');
  } catch {
    // ignore
  }
}
```

Update `runForGroup` — use `state.message` slot:
```typescript
private async runForGroup(groupJid: string, reason: 'messages' | 'drain'): Promise<void> {
  const state = this.getGroup(groupJid);
  state.message.active = true;
  state.message.idleWaiting = false;
  state.pendingMessages = false;
  this.activeCount++;

  logger.debug({ groupJid, reason, activeCount: this.activeCount }, 'Starting message container for group');

  try {
    if (this.processMessagesFn) {
      const success = await this.processMessagesFn(groupJid);
      if (success) {
        state.retryCount = 0;
      } else {
        this.scheduleRetry(groupJid, state);
      }
    }
  } catch (err) {
    logger.error({ groupJid, err }, 'Error processing messages for group');
    this.scheduleRetry(groupJid, state);
  } finally {
    state.message.active = false;
    state.message.process = null;
    state.message.containerName = null;
    state.message.groupFolder = null;
    this.activeCount--;
    this.drainGroup(groupJid, 'message');
  }
}
```

Update `runTask` — use `state.task` slot:
```typescript
private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
  const state = this.getGroup(groupJid);
  state.task.active = true;
  state.task.idleWaiting = false;
  state.runningTaskId = task.id;
  this.activeCount++;

  logger.debug({ groupJid, taskId: task.id, activeCount: this.activeCount }, 'Running queued task');

  try {
    await task.fn();
  } catch (err) {
    logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
  } finally {
    state.task.active = false;
    state.runningTaskId = null;
    state.task.process = null;
    state.task.containerName = null;
    state.task.groupFolder = null;
    this.activeCount--;
    this.drainGroup(groupJid, 'task');
  }
}
```

Update `drainGroup` — split per-type:
```typescript
private drainGroup(groupJid: string, freedSlot: SlotType): void {
  if (this.shuttingDown) return;
  const state = this.getGroup(groupJid);

  if (freedSlot === 'task') {
    // Task slot freed — drain pending tasks
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error({ groupJid, taskId: task.id, err }, 'Unhandled error in runTask (drain)'),
      );
      return;
    }
  } else {
    // Message slot freed — drain pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error({ groupJid, err }, 'Unhandled error in runForGroup (drain)'),
      );
      return;
    }
  }

  // Nothing pending for this slot type; check if other groups are waiting
  this.drainWaiting();
}
```

Update `shutdown` — iterate both slots:
```typescript
async shutdown(_gracePeriodMs: number): Promise<void> {
  this.shuttingDown = true;

  const activeContainers: string[] = [];
  for (const [_jid, state] of this.groups) {
    for (const slot of [state.message, state.task]) {
      if (slot.process && !slot.process.killed && slot.containerName) {
        activeContainers.push(slot.containerName);
      }
    }
  }

  logger.info(
    { activeCount: this.activeCount, detachedContainers: activeContainers },
    'GroupQueue shutting down (containers detached, not killed)',
  );
}
```

- [ ] **Step 11: Run all tests to verify passing**

Run: `npx vitest run src/group-queue.test.ts`
Expected: ALL tests PASS (including new parallel tests)

- [ ] **Step 12: Fix any failing existing tests**

Some existing tests may need updates for the new slot-based behavior:

- "preempts idle container when task is enqueued" — this test expects cross-slot preemption which is now removed. **Delete this test** and the "preempts when idle arrives with pending tasks" test, since the preemption behavior no longer exists.
- "sendMessage resets idleWaiting so a subsequent task enqueue does not preempt" — also tests cross-slot preemption logic. **Delete this test.**
- "sendMessage returns false for task containers" — update to verify sendMessage returns false when no message container is active (task doesn't block but message slot is empty).
- Tests that call `registerProcess` without `type` — these should still work due to the `type = 'message'` default.
- Tests that call `notifyIdle` without `type` — same, defaults to `'message'`.

Updated test for "sendMessage returns false when only task container is active":
```typescript
it('sendMessage returns false when no message container is active', async () => {
  let resolveTask: () => void;

  const taskFn = vi.fn(async () => {
    await new Promise<void>((resolve) => { resolveTask = resolve; });
  });

  queue.enqueueTask('group1@g.us', 'task-1', taskFn);
  await vi.advanceTimersByTimeAsync(10);
  queue.registerProcess('group1@g.us', {} as any, 'container-1', 'test-group', 'task');

  // sendMessage should return false — no message container active
  const result = queue.sendMessage('group1@g.us', 'hello');
  expect(result).toBe(false);

  resolveTask!();
  await vi.advanceTimersByTimeAsync(10);
});
```

- [ ] **Step 13: Run all tests to confirm**

Run: `npx vitest run src/group-queue.test.ts`
Expected: ALL PASS

- [ ] **Step 14: Write test — closeStdin('message') writes to input dir**

```typescript
it('closeStdin for message writes _close to input dir', async () => {
  const fs = await import('fs');
  let resolveProcess: () => void;

  const processMessages = vi.fn(async () => {
    await new Promise<void>((resolve) => { resolveProcess = resolve; });
    return true;
  });

  queue.setProcessMessagesFn(processMessages);
  queue.enqueueMessageCheck('group1@g.us');
  await vi.advanceTimersByTimeAsync(10);
  queue.registerProcess('group1@g.us', {} as any, 'container-1', 'test-group');

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
```

- [ ] **Step 15: Write test — closeStdin('task') writes to task-input dir**

```typescript
it('closeStdin for task writes _close to task-input dir', async () => {
  const fs = await import('fs');
  let resolveTask: () => void;

  const taskFn = vi.fn(async () => {
    await new Promise<void>((resolve) => { resolveTask = resolve; });
  });

  queue.enqueueTask('group1@g.us', 'task-1', taskFn);
  await vi.advanceTimersByTimeAsync(10);
  queue.registerProcess('group1@g.us', {} as any, 'container-1', 'test-group', 'task');

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
```

- [ ] **Step 16: Run tests to verify closeStdin tests pass**

Run: `npx vitest run src/group-queue.test.ts`
Expected: ALL PASS

- [ ] **Step 17: Write test — drain: message slot freeing drains only messages**

```typescript
it('message slot freeing drains pending messages, not tasks', async () => {
  const executionOrder: string[] = [];
  const completionCallbacks: Array<() => void> = [];

  const processMessages = vi.fn(async () => {
    executionOrder.push('message');
    await new Promise<void>((resolve) => completionCallbacks.push(resolve));
    return true;
  });

  queue.setProcessMessagesFn(processMessages);

  // Start message container
  queue.enqueueMessageCheck('group1@g.us');
  await vi.advanceTimersByTimeAsync(10);

  // While message container is active, enqueue another message AND a task
  queue.enqueueMessageCheck('group1@g.us');
  queue.enqueueTask('group1@g.us', 'task-1', vi.fn(async () => {
    executionOrder.push('task');
    await new Promise<void>((resolve) => completionCallbacks.push(resolve));
  }));
  await vi.advanceTimersByTimeAsync(10);

  // Task should have started in its own slot already
  expect(executionOrder).toContain('task');

  // Complete the first message — should drain pending message, NOT task
  completionCallbacks[0]();
  await vi.advanceTimersByTimeAsync(10);

  // Should see: message, task (parallel), then second message
  expect(executionOrder.filter((e) => e === 'message')).toHaveLength(2);

  // Cleanup
  for (const cb of completionCallbacks.slice(1)) cb();
  await vi.advanceTimersByTimeAsync(10);
});
```

- [ ] **Step 18: Run all tests**

Run: `npx vitest run src/group-queue.test.ts`
Expected: ALL PASS

- [ ] **Step 19: Write test — shutdown reports containers from both slots**

```typescript
it('shutdown reports containers from both message and task slots', async () => {
  let resolveMessage: () => void;
  let resolveTask: () => void;

  const processMessages = vi.fn(async () => {
    await new Promise<void>((resolve) => { resolveMessage = resolve; });
    return true;
  });

  queue.setProcessMessagesFn(processMessages);

  // Start message container
  queue.enqueueMessageCheck('group1@g.us');
  await vi.advanceTimersByTimeAsync(10);
  queue.registerProcess('group1@g.us', { killed: false } as any, 'msg-container', 'test-group');

  // Start task container
  const taskFn = vi.fn(async () => {
    await new Promise<void>((resolve) => { resolveTask = resolve; });
  });
  queue.enqueueTask('group1@g.us', 'task-1', taskFn);
  await vi.advanceTimersByTimeAsync(10);
  queue.registerProcess('group1@g.us', { killed: false } as any, 'task-container', 'test-group', 'task');

  // Shutdown should not throw and should handle both slots
  await queue.shutdown(1000);

  // Cleanup
  resolveMessage!();
  resolveTask!();
  await vi.advanceTimersByTimeAsync(10);
});
```

- [ ] **Step 20: Run full test suite**

Run: `npx vitest run src/group-queue.test.ts`
Expected: ALL PASS

- [ ] **Step 21: Commit**

```bash
git add src/group-queue.ts src/group-queue.test.ts
git commit -m "feat: refactor GroupQueue to dual ContainerSlot for parallel task/message containers

Split GroupState's single active container into message and task slots.
Same group can now run message + task containers concurrently.
Same-type containers still serialize. Cross-slot preemption removed.
closeStdin writes to slot-specific IPC input dirs (input/ vs task-input/)."
```

---

## Chunk 2: Update Callers

### Task 2: Update index.ts callers to pass slot type

**Files:**
- Modify: `src/index.ts:206,233,324,557`

- [ ] **Step 1: Update closeStdin call in idle timer (line 206)**

Change:
```typescript
queue.closeStdin(chatJid);
```
To:
```typescript
queue.closeStdin(chatJid, 'message');
```

- [ ] **Step 2: Update notifyIdle call (line 233)**

Change:
```typescript
queue.notifyIdle(chatJid);
```
To:
```typescript
queue.notifyIdle(chatJid, 'message');
```

- [ ] **Step 3: Update registerProcess call in message path (line 324)**

Change:
```typescript
(proc, containerName) =>
  queue.registerProcess(chatJid, proc, containerName, group.folder),
```
To:
```typescript
(proc, containerName) =>
  queue.registerProcess(chatJid, proc, containerName, group.folder, 'message'),
```

- [ ] **Step 4: Update registerProcess call in scheduler startSchedulerLoop (line 556-557)**

Change:
```typescript
onProcess: (groupJid, proc, containerName, groupFolder) =>
  queue.registerProcess(groupJid, proc, containerName, groupFolder),
```
To:
```typescript
onProcess: (groupJid, proc, containerName, groupFolder) =>
  queue.registerProcess(groupJid, proc, containerName, groupFolder, 'task'),
```

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: pass slot type to GroupQueue methods in index.ts"
```

### Task 3: Update task-scheduler.ts callers

**Files:**
- Modify: `src/task-scheduler.ts:167,193`

- [ ] **Step 1: Update closeStdin call (line 167)**

Change:
```typescript
deps.queue.closeStdin(task.chat_jid);
```
To:
```typescript
deps.queue.closeStdin(task.chat_jid, 'task');
```

- [ ] **Step 2: Update notifyIdle call (line 193)**

Change:
```typescript
deps.queue.notifyIdle(task.chat_jid);
```
To:
```typescript
deps.queue.notifyIdle(task.chat_jid, 'task');
```

- [ ] **Step 3: Commit**

```bash
git add src/task-scheduler.ts
git commit -m "feat: pass 'task' slot type to GroupQueue methods in task-scheduler"
```

### Task 4: Update container-runner.ts IPC mount for task containers

**Files:**
- Modify: `src/container-runner.ts:60,167-177`
- Test: `src/container-runner.test.ts`

- [ ] **Step 1: Write failing test — task container mounts task-input as /workspace/ipc/input**

Add to `src/container-runner.test.ts`:

```typescript
it('mounts task-input dir for scheduled task containers', async () => {
  // ... setup similar to existing container-runner tests
  // Verify that when isScheduledTask=true, the container args include
  // a mount from data/ipc/{group}/task-input/ to /workspace/ipc/input
});
```

Note: The exact test depends on existing test infrastructure in container-runner.test.ts. The key assertion is that `buildVolumeMounts` (or the final container args) includes `task-input/` → `/workspace/ipc/input` when `isScheduledTask` is true.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/container-runner.test.ts`
Expected: FAIL

- [ ] **Step 3: Update buildVolumeMounts to accept isScheduledTask parameter**

In `src/container-runner.ts`, update `buildVolumeMounts` signature:
```typescript
function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  isScheduledTask = false,
): VolumeMount[] {
```

After the IPC mount block (lines 167-177), add:
```typescript
// For scheduled task containers, shadow the input dir with task-input
// so _close sentinel files don't conflict with parallel message containers
if (isScheduledTask) {
  const taskInputDir = path.join(groupIpcDir, 'task-input');
  fs.mkdirSync(taskInputDir, { recursive: true });
  mounts.push({
    hostPath: taskInputDir,
    containerPath: '/workspace/ipc/input',
    readonly: false,
  });
}
```

Update the call in `runContainerAgent` (line 288):
```typescript
const mounts = buildVolumeMounts(group, input.isMain, input.isScheduledTask);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/container-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat: mount task-input dir for task containers to isolate IPC _close sentinel"
```

---

## Chunk 3: Verification

### Task 5: Full integration verification

- [ ] **Step 1: Run entire test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: Build the project**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 3: Verify no regressions in container-runtime tests**

Run: `npx vitest run src/container-runtime.test.ts`
Expected: PASS

- [ ] **Step 4: Final commit with any remaining fixes**

If any fixes were needed, commit them.

- [ ] **Step 5: Record rollback point**

Current commit is the safe state. Previous rollback: commit `94f819a`.
