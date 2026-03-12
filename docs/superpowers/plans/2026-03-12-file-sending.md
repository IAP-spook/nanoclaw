# File Sending Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow agents to send arbitrary files (PDFs, docs, archives) to chats via a new `send_file` MCP tool, using the same IPC pipeline as image sending.

**Architecture:** New `sendFile?()` optional method on Channel interface, implemented in Feishu via `im.v1.file.create` + `msg_type:"file"`. Host IPC handler validates authorization, file existence, size (30MB limit), and path traversal. Container MCP tool writes IPC task JSON. Also adds the missing `send_image` MCP tool.

**Tech Stack:** TypeScript, Vitest, Feishu SDK (`@larksuiteoapi/node-sdk`), MCP SDK

**Spec:** `docs/superpowers/specs/2026-03-12-file-sending-design.md`

---

## Chunk 1: Channel Interface + Feishu Implementation

### Task 1: Add `sendFile?()` to Channel interface

**Files:**
- Modify: `src/types.ts:95` (after `sendImage?` line)

- [ ] **Step 1: Add the optional method to the Channel interface**

In `src/types.ts`, after line 95 (`sendImage?(...)`), add:

```typescript
  // Optional: send a file. Channels that support it implement it.
  sendFile?(jid: string, filePath: string, caption?: string): Promise<void>;
```

- [ ] **Step 2: Build to verify no type errors**

Run: `npm run build`
Expected: Clean build (no existing code calls sendFile yet)

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add sendFile to Channel interface"
```

### Task 2: Implement `feishuFileType()` utility

**Files:**
- Modify: `src/channels/feishu.ts` (add function before class)
- Modify: `src/channels/feishu.test.ts` (add test block)

- [ ] **Step 1: Write failing test for feishuFileType**

Add to `src/channels/feishu.test.ts`:

```typescript
import { feishuFileType } from './feishu.js';

describe('feishuFileType', () => {
  it('maps pdf extension', () => {
    expect(feishuFileType('.pdf')).toBe('pdf');
  });

  it('maps doc/docx to doc', () => {
    expect(feishuFileType('.doc')).toBe('doc');
    expect(feishuFileType('.docx')).toBe('doc');
  });

  it('maps xls/xlsx to xls', () => {
    expect(feishuFileType('.xls')).toBe('xls');
    expect(feishuFileType('.xlsx')).toBe('xls');
  });

  it('maps ppt/pptx to ppt', () => {
    expect(feishuFileType('.ppt')).toBe('ppt');
    expect(feishuFileType('.pptx')).toBe('ppt');
  });

  it('maps mp4', () => {
    expect(feishuFileType('.mp4')).toBe('mp4');
  });

  it('maps opus', () => {
    expect(feishuFileType('.opus')).toBe('opus');
  });

  it('defaults to stream for unknown extensions', () => {
    expect(feishuFileType('.zip')).toBe('stream');
    expect(feishuFileType('.txt')).toBe('stream');
    expect(feishuFileType('')).toBe('stream');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/channels/feishu.test.ts`
Expected: FAIL — `feishuFileType` is not exported

- [ ] **Step 3: Implement feishuFileType**

Add to `src/channels/feishu.ts`, before the `FeishuChannel` class definition (after line 9):

```typescript
const FILE_TYPE_MAP: Record<string, string> = {
  '.opus': 'opus',
  '.mp4': 'mp4',
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'doc',
  '.xls': 'xls',
  '.xlsx': 'xls',
  '.ppt': 'ppt',
  '.pptx': 'ppt',
};

/** Map file extension to Feishu im.v1.file file_type. */
export function feishuFileType(ext: string): string {
  return FILE_TYPE_MAP[ext.toLowerCase()] || 'stream';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/channels/feishu.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat: add feishuFileType utility for file type mapping"
```

### Task 3: Implement Feishu `sendFile()`

**Files:**
- Modify: `src/channels/feishu.ts` (add sendFile method to FeishuChannel class)
- Modify: `src/channels/feishu.test.ts` (add sendFile tests)

- [ ] **Step 1: Write failing tests for sendFile**

Add to `src/channels/feishu.test.ts`:

```typescript
describe('FeishuChannel.sendFile', () => {
  const createReadStreamSpy = vi.spyOn(fs, 'createReadStream');

  beforeEach(() => {
    createReadStreamSpy.mockReturnValue(
      Readable.from(Buffer.from('fake-file-data')) as any,
    );
  });

  it('uploads file and sends file message', async () => {
    const { createFeishuChannel } = await import('./feishu.js');

    const mockFileCreate = vi.fn().mockResolvedValue({
      data: { file_key: 'file_v3_test_key_789' },
    });
    const mockMessageCreate = vi.fn().mockResolvedValue({ code: 0 });

    const mockClient = {
      im: {
        v1: {
          image: { create: vi.fn() },
          file: { create: mockFileCreate },
          message: { create: mockMessageCreate },
        },
      },
    };

    const channel = createFeishuChannel(
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      },
      mockClient as any,
    );

    const tmpPath = '/tmp/nanoclaw-test-feishu-file.pdf';
    fs.writeFileSync(tmpPath, Buffer.alloc(100)); // small file

    try {
      await channel.sendFile!('oc_abc123@feishu', tmpPath);

      expect(mockFileCreate).toHaveBeenCalledOnce();
      const uploadCall = mockFileCreate.mock.calls[0][0];
      expect(uploadCall.data.file_type).toBe('pdf');
      expect(uploadCall.data.file_name).toBe('nanoclaw-test-feishu-file.pdf');

      expect(mockMessageCreate).toHaveBeenCalledOnce();
      const sendCall = mockMessageCreate.mock.calls[0][0];
      expect(sendCall.data.msg_type).toBe('file');
      expect(JSON.parse(sendCall.data.content)).toEqual({
        file_key: 'file_v3_test_key_789',
      });
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('sends caption as follow-up text message', async () => {
    const { createFeishuChannel } = await import('./feishu.js');

    const mockFileCreate = vi.fn().mockResolvedValue({
      data: { file_key: 'file_key_cap' },
    });
    const mockMessageCreate = vi.fn().mockResolvedValue({ code: 0 });

    const mockClient = {
      im: {
        v1: {
          image: { create: vi.fn() },
          file: { create: mockFileCreate },
          message: { create: mockMessageCreate },
        },
      },
    };

    const channel = createFeishuChannel(
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      },
      mockClient as any,
    );

    const tmpPath = '/tmp/nanoclaw-test-feishu-file-cap.xlsx';
    fs.writeFileSync(tmpPath, Buffer.alloc(100));

    try {
      await channel.sendFile!('oc_abc123@feishu', tmpPath, 'Monthly report');

      expect(mockMessageCreate).toHaveBeenCalledTimes(2);
      const captionCall = mockMessageCreate.mock.calls[1][0];
      expect(captionCall.data.msg_type).toBe('text');
      expect(JSON.parse(captionCall.data.content)).toEqual({
        text: 'Monthly report',
      });
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('throws when file does not exist', async () => {
    const { createFeishuChannel } = await import('./feishu.js');

    const mockClient = {
      im: {
        v1: {
          image: { create: vi.fn() },
          file: { create: vi.fn() },
          message: { create: vi.fn() },
        },
      },
    };

    const channel = createFeishuChannel(
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      },
      mockClient as any,
    );

    await expect(
      channel.sendFile!('oc_abc123@feishu', '/nonexistent/file.pdf'),
    ).rejects.toThrow('File not found');
  });

  it('throws when file exceeds 30MB', async () => {
    const { createFeishuChannel } = await import('./feishu.js');

    const mockClient = {
      im: {
        v1: {
          image: { create: vi.fn() },
          file: { create: vi.fn() },
          message: { create: vi.fn() },
        },
      },
    };

    const channel = createFeishuChannel(
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      },
      mockClient as any,
    );

    // Mock statSync to return a large file
    const statSyncSpy = vi.spyOn(fs, 'statSync').mockReturnValue({
      size: 32_000_000,
    } as any);
    const existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    try {
      await expect(
        channel.sendFile!('oc_abc123@feishu', '/tmp/huge-file.zip'),
      ).rejects.toThrow('exceeds');
    } finally {
      statSyncSpy.mockRestore();
      existsSyncSpy.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/channels/feishu.test.ts`
Expected: FAIL — `sendFile` is not a function

- [ ] **Step 3: Implement sendFile in FeishuChannel**

Add this method to `FeishuChannel` class in `src/channels/feishu.ts`, after the `sendImage` method (after line 124):

```typescript
  async sendFile(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    const MAX_FILE_SIZE = 31_457_280; // 30MB
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(
        `File exceeds 30MB limit: ${(stat.size / 1_048_576).toFixed(1)}MB`,
      );
    }

    const rawId = jid.replace(JID_SUFFIX, '');
    const receiveIdType = rawId.startsWith('oc_') ? 'chat_id' : 'open_id';
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);

    // Upload file
    const uploadResp = await this.client.im.v1.file.create({
      data: {
        file_type: feishuFileType(ext),
        file_name: fileName,
        file: fs.createReadStream(filePath),
      },
    });

    const fileKey = uploadResp?.data?.file_key ?? uploadResp?.file_key;
    if (!fileKey) {
      logger.error({ uploadResp }, 'Feishu file upload returned no file_key');
      throw new Error('Failed to upload file: no file_key returned');
    }

    // Send file message
    await this.client.im.v1.message.create({
      data: {
        receive_id: rawId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
      params: {
        receive_id_type: receiveIdType as any,
      },
    });

    // Send caption as follow-up text if provided
    if (caption) {
      await this.client.im.v1.message.create({
        data: {
          receive_id: rawId,
          msg_type: 'text',
          content: JSON.stringify({ text: caption }),
        },
        params: {
          receive_id_type: receiveIdType as any,
        },
      });
    }

    logger.info({ jid, filePath, fileName }, 'File sent');
  }
```

Note: Add `import path from 'path';` at top of file if not already present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/channels/feishu.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/feishu.ts src/channels/feishu.test.ts
git commit -m "feat: implement Feishu sendFile with upload, size check, and caption"
```

---

## Chunk 2: IPC Handler + Wiring + MCP Tools

### Task 4: Add `send_file` IPC handler

**Files:**
- Modify: `src/ipc.ts:13-30` (IpcDeps interface) and `src/ipc.ts:460-481` (after send_image case)
- Create: `src/ipc-file.test.ts`

- [ ] **Step 1: Write failing tests for send_file IPC**

Create `src/ipc-file.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { processTaskIpc } from './ipc.js';

describe('IPC file message handling', () => {
  const baseDeps = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendImage: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    registeredGroups: () => ({
      'oc_abc@feishu': {
        name: 'Test',
        folder: 'main',
        trigger: '',
        added_at: '2026-01-01T00:00:00Z',
        isMain: true,
      },
      'oc_other@feishu': {
        name: 'Other',
        folder: 'team-a',
        trigger: '@Bot',
        added_at: '2026-01-01T00:00:00Z',
      },
    }),
    registerGroup: vi.fn(),
    syncGroups: vi.fn(),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends file from main group', async () => {
    // Create a temp file so existence check passes
    const tmpDir = fs.mkdtempSync('/tmp/ipc-file-test-');
    const tmpFile = path.join(tmpDir, 'report.pdf');
    fs.writeFileSync(tmpFile, Buffer.alloc(100));

    try {
      const data = {
        type: 'send_file',
        chatJid: 'oc_abc@feishu',
        filePath: `/workspace/group/report.pdf`,
      };

      await processTaskIpc(data as any, 'main', true, baseDeps as any);

      expect(baseDeps.sendFile).toHaveBeenCalledWith(
        'oc_abc@feishu',
        expect.stringContaining('report.pdf'),
        undefined,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('sends file with caption', async () => {
    const data = {
      type: 'send_file',
      chatJid: 'oc_abc@feishu',
      filePath: '/workspace/group/doc.pdf',
      caption: 'Monthly report',
    };

    await processTaskIpc(data as any, 'main', true, baseDeps as any);

    expect(baseDeps.sendFile).toHaveBeenCalledWith(
      'oc_abc@feishu',
      expect.stringContaining('doc.pdf'),
      'Monthly report',
    );
  });

  it('blocks unauthorized file send from non-main group', async () => {
    const data = {
      type: 'send_file',
      chatJid: 'oc_abc@feishu',
      filePath: '/workspace/group/secret.pdf',
    };

    await processTaskIpc(data as any, 'team-a', false, baseDeps as any);

    expect(baseDeps.sendFile).not.toHaveBeenCalled();
  });

  it('blocks path traversal attempts', async () => {
    const data = {
      type: 'send_file',
      chatJid: 'oc_abc@feishu',
      filePath: '/workspace/group/../../etc/passwd',
    };

    await processTaskIpc(data as any, 'main', true, baseDeps as any);

    expect(baseDeps.sendFile).not.toHaveBeenCalled();
  });

  it('blocks file exceeding 30MB', async () => {
    // Mock statSync to return large file size
    const statSpy = vi.spyOn(fs, 'statSync').mockReturnValue({
      size: 32_000_000,
    } as any);
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    try {
      const data = {
        type: 'send_file',
        chatJid: 'oc_abc@feishu',
        filePath: '/workspace/group/huge.zip',
      };

      await processTaskIpc(data as any, 'main', true, baseDeps as any);

      expect(baseDeps.sendFile).not.toHaveBeenCalled();
    } finally {
      statSpy.mockRestore();
      existsSpy.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ipc-file.test.ts`
Expected: FAIL — `sendFile` not in IpcDeps / no `send_file` case

- [ ] **Step 3: Add sendFile to IpcDeps interface**

In `src/ipc.ts`, after line 19 (after the `sendImage` property), add:

```typescript
  sendFile: (
    jid: string,
    filePath: string,
    caption?: string,
  ) => Promise<void>;
```

- [ ] **Step 4: Add send_file case to processTaskIpc**

In `src/ipc.ts`, after the `send_image` case (after line 481, before `default:`), add:

```typescript
    case 'send_file': {
      if (!data.chatJid || !data.filePath) break;

      const targetGroup = registeredGroups[data.chatJid];
      if (!isMain && !(targetGroup && targetGroup.folder === sourceGroup)) {
        logger.warn(
          { chatJid: data.chatJid, sourceGroup },
          'Unauthorized IPC send_file attempt blocked',
        );
        break;
      }

      // Map container path to host path
      const hostFilePath = data.filePath.replace(
        /^\/workspace\/group\//,
        path.join(GROUPS_DIR, sourceGroup) + '/',
      );

      // Path traversal guard
      const resolved = path.resolve(hostFilePath);
      const groupPrefix = path.resolve(path.join(GROUPS_DIR, sourceGroup));
      if (!resolved.startsWith(groupPrefix + path.sep) && resolved !== groupPrefix) {
        logger.warn(
          { filePath: data.filePath, resolved, groupPrefix },
          'IPC send_file path traversal blocked',
        );
        break;
      }

      // File existence check
      if (!fs.existsSync(resolved)) {
        logger.warn(
          { filePath: resolved },
          'IPC send_file file not found',
        );
        break;
      }

      // File size check (30MB)
      const MAX_FILE_SIZE = 31_457_280;
      const stat = fs.statSync(resolved);
      if (stat.size > MAX_FILE_SIZE) {
        logger.warn(
          { filePath: resolved, size: stat.size, maxSize: MAX_FILE_SIZE },
          'IPC send_file exceeds size limit',
        );
        break;
      }

      await deps.sendFile(data.chatJid, resolved, data.caption);
      logger.info(
        { chatJid: data.chatJid, sourceGroup, filePath: resolved },
        'IPC file sent',
      );
      break;
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/ipc-file.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS (ipc-image tests need `sendFile` added to their `baseDeps`)

If ipc-image.test.ts fails, add `sendFile: vi.fn().mockResolvedValue(undefined)` to `baseDeps` in that file.

- [ ] **Step 7: Commit**

```bash
git add src/ipc.ts src/ipc-file.test.ts src/ipc-image.test.ts
git commit -m "feat: add send_file IPC handler with size/traversal guards"
```

### Task 5: Wire sendFile into index.ts

**Files:**
- Modify: `src/index.ts:574-581` (after sendImage in IPC deps)

- [ ] **Step 1: Add sendFile to IPC deps**

In `src/index.ts`, after the `sendImage` dep (after line 581), add:

```typescript
    sendFile: async (jid, filePath, caption) => {
      const channel = findChannel(channels, jid);
      if (channel?.sendFile) {
        await channel.sendFile(jid, filePath, caption);
      } else {
        logger.warn({ jid }, 'No file-capable channel for JID');
      }
    },
```

- [ ] **Step 2: Build to verify no errors**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire sendFile into IPC deps"
```

### Task 6: Add send_file and send_image MCP tools

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts` (add two tools)

- [ ] **Step 1: Add send_file MCP tool**

In `container/agent-runner/src/ipc-mcp-stdio.ts`, after the `register_group` tool (before the memory tools section), add:

```typescript
server.tool(
  'send_file',
  'Send a file to the chat. Supports PDFs, documents, archives, audio, and other file types. The file must exist in your workspace.',
  {
    file_path: z.string().describe('Absolute path to the file (e.g., /workspace/group/report.pdf)'),
    caption: z.string().optional().describe('Optional caption text sent with the file'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'send_file',
      chatJid,
      filePath: args.file_path,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'File queued for sending.' }] };
  },
);

server.tool(
  'send_image',
  'Send an image file to the chat. Use for screenshots, charts, plots, and other images.',
  {
    file_path: z.string().describe('Absolute path to the image file (e.g., /workspace/group/screenshot.png)'),
    caption: z.string().optional().describe('Optional caption text sent with the image'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'send_image',
      chatJid,
      filePath: args.file_path,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Image queued for sending.' }] };
  },
);
```

- [ ] **Step 2: Build to verify no errors**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat: add send_file and send_image MCP tools for container agents"
```

### Task 7: Final verification and deploy

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: Clean

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Rebuild container image**

Run: `./container/build.sh`
Expected: Image builds successfully (new MCP tools included)

- [ ] **Step 4: Restart service**

Run: `systemctl --user restart nanoclaw`
Expected: Service restarts and connects

- [ ] **Step 5: Verify in logs**

Run: `tail -20 logs/nanoclaw.log`
Expected: Startup log shows "Database initialized", "Credential proxy started"
