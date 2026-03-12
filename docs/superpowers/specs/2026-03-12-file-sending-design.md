# NanoClaw File Sending Feature

**Date:** 2026-03-12
**Status:** Approved
**Author:** Claude + User

## Problem

NanoClaw agents can send images to chats via the existing `sendImage` pipeline, but cannot send other file types (PDFs, documents, archives, audio). Users need agents to share generated reports, downloaded files, and other non-image content.

## Goals

1. Agents can send arbitrary files to chats via MCP tool
2. Follows the same IPC pattern as image sending
3. Channel interface is generic; only Feishu implemented initially
4. Host validates file size before uploading (Feishu limit: 30MB)

## Non-Goals

- Receiving files from users (separate feature)
- Modifying the existing sendImage pipeline
- Implementing sendFile for channels other than Feishu (interface only)

## Architecture

Mirrors the host-side sendImage pipeline (IPC handler + channel method). Note: `send_image` currently has no container-side MCP tool — agents trigger it via direct IPC file writes from Bash. This design adds a proper `send_file` MCP tool; a `send_image` MCP tool should also be added as part of this work (low incremental effort).

```
Agent calls send_file MCP tool
  → writes IPC task JSON to /workspace/ipc/tasks/
  → Host IPC watcher reads task
  → Host validates: authorization, file exists, size ≤ 30MB
  → Host maps container path to host path
  → Host calls channel.sendFile(jid, hostPath, caption)
  → Feishu: upload via im.v1.file.create, send via im.v1.message.create
```

## Channel Interface

```typescript
// src/types.ts — Channel interface addition
sendFile?(jid: string, filePath: string, caption?: string): Promise<void>;
```

Optional method, same pattern as `sendImage?()`. Channels that don't support file sending simply omit it. The host logs a warning if a channel lacks `sendFile`.

## Feishu Implementation

`src/channels/feishu.ts` — new `sendFile()` method:

1. Validate file exists
2. Check file size ≤ 30MB (31,457,280 bytes)
3. Determine `file_type` from extension:
   - `opus` — opus audio
   - `mp4` — mp4 video
   - `pdf` — PDF documents
   - `doc` — doc/docx
   - `xls` — xls/xlsx
   - `ppt` — ppt/pptx
   - `stream` — everything else (generic binary)
4. Upload: `this.client.im.v1.file.create({ file_type, file_name, file })`
5. Extract `file_key` from response (defensive: `data.file_key ?? root.file_key`)
6. Send: `this.client.im.v1.message.create({ msg_type: "file", content: { file_key } })`
7. If caption provided, send follow-up text message

## IPC Task Format

```json
{
  "type": "send_file",
  "chatJid": "oc_xxx@feishu",
  "filePath": "/workspace/group/report.pdf",
  "caption": "Monthly report",
  "groupFolder": "main",
  "timestamp": "2026-03-12T16:00:00.000Z"
}
```

## IPC Processing (Host)

`src/ipc.ts` — new `case 'send_file'` in `processTaskIpc`:

- Authorization: non-main groups can only send files to their own JID
- Path mapping: `/workspace/group/` → `{GROUPS_DIR}/{sourceGroup}/`, then `path.resolve()` + prefix check to prevent traversal
- File existence check: `fs.existsSync(hostPath)`, log error if missing
- File size validation: reject if > 30MB (`MAX_FILE_SIZE = 31_457_280`), log error
- Call `deps.sendFile(chatJid, hostPath, caption)`

`IpcDeps` interface needs a new property:
```typescript
sendFile: (chatJid: string, filePath: string, caption?: string) => Promise<void>;
```

## MCP Tool (Container)

`container/agent-runner/src/ipc-mcp-stdio.ts` — new `send_file` tool:

```typescript
server.tool(
  'send_file',
  'Send a file to the chat.',
  {
    file_path: z.string().describe('Path to the file'),
    caption: z.string().optional().describe('Optional caption'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'send_file',
      chatJid,
      filePath: args.file_path,
      caption: args.caption,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text', text: 'File queued for sending.' }] };
  },
);
```

## Error Handling

| Error | Where | Behavior |
|-------|-------|----------|
| File not found | Host IPC (after path mapping) | Log error, skip |
| File > 30MB | Host IPC | Log error with size, skip |
| Upload fails | Feishu channel | Log Feishu error, throw |
| No sendFile on channel | Host | Log warning, skip |
| Unauthorized JID | Host IPC | Log warning, skip |
| Path traversal | Host IPC | `path.resolve()` + prefix check, reject if outside GROUPS_DIR |

## Constants

```typescript
const MAX_FILE_SIZE = 31_457_280; // 30MB — Feishu im.v1.file.create limit
```

Defined once in `src/ipc.ts` (or a shared config), referenced by the IPC handler.

## Implementation Order (TDD)

1. **Channel interface** — add `sendFile?()` to `Channel` type in `src/types.ts`
2. **Feishu sendFile** — implement upload + send in `src/channels/feishu.ts`, tests with mock SDK. Extract `feishuFileType(ext)` as testable utility.
3. **IPC handler** — add `send_file` case to `src/ipc.ts`, with existence check, size validation, path traversal guard, tests
4. **Wire into index.ts** — add `sendFile` to IPC deps, add `sendFile` to `IpcDeps` interface
5. **MCP tools** — add `send_file` to `container/agent-runner/src/ipc-mcp-stdio.ts`. Also add `send_image` MCP tool (currently missing — agents use Bash IPC writes).
