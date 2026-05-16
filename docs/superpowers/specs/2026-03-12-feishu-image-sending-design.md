# Feishu Image Sending Design

## Overview

Enable NanoClaw's container agent to send images to users via Feishu. Images can come from agent-browser screenshots or code-generated files (matplotlib, mermaid, etc.).

## Architecture

```
Agent generates image → writes IPC {type:"image"} → host reads file
→ Feishu im.v1.image.create (upload) → gets image_key
→ Feishu im.v1.message.create (msg_type:"image") → user sees image
```

## Changes

### 1. Channel Interface (`src/types.ts`)

Add optional method to Channel interface:

```typescript
sendImage?(jid: string, imagePath: string, caption?: string): Promise<void>;
```

Channels that don't implement it simply skip image messages. No breaking change to existing channels.

### 2. Feishu Channel (`src/channels/feishu.ts`)

Implement `sendImage`:

1. Read image file from host path as `fs.ReadStream`
2. Upload via `client.im.v1.image.create({ data: { image_type: 'message', image: stream } })`
3. Extract `image_key` from response
4. Send via `client.im.v1.message.create({ data: { receive_id, msg_type: 'image', content: JSON.stringify({ image_key }) } })`
5. If caption provided, send as follow-up text message

### 3. IPC Message Type (`src/ipc.ts`)

Add handling for `type: "image"`:

```typescript
if (data.type === 'image' && data.chatJid && data.filePath) {
  const hostPath = mapContainerPath(data.filePath, sourceGroup);
  await deps.sendImage(data.chatJid, hostPath, data.caption);
}
```

Container path mapping: `/workspace/group/foo.png` → `groups/{folder}/foo.png` on host.

### 4. IPC Dependencies (`src/index.ts`)

Add `sendImage` to IPC deps:

```typescript
sendImage: async (jid: string, imagePath: string, caption?: string) => {
  const channel = findChannel(channels, jid);
  if (channel?.sendImage) {
    await channel.sendImage(jid, imagePath, caption);
  }
}
```

### 5. Router (`src/router.ts`)

Add `routeImage` function:

```typescript
export function routeImage(
  channels: Channel[], jid: string, imagePath: string, caption?: string
): Promise<void> {
  const channel = channels.find(c => c.ownsJid(jid) && c.isConnected());
  if (!channel?.sendImage) throw new Error(`No image-capable channel for JID: ${jid}`);
  return channel.sendImage(jid, imagePath, caption);
}
```

## Path Mapping

Container paths map to host paths:
- `/workspace/group/screenshot.png` → `{projectRoot}/groups/{folder}/screenshot.png`
- `/workspace/extra/dell/file.png` → `/home/dell/file.png` (via mount mapping)

## Error Handling

- File not found: log warning, skip (don't crash the message flow)
- Upload failure: log error, send text fallback "[Image failed to send]"
- Unsupported channel: silently skip (channel has no sendImage method)

## Testing

- Unit: IPC image message parsing, container-to-host path mapping
- Unit: sendImage parameter validation, Feishu API call structure
- Integration: mock Feishu SDK, verify upload→send flow
- Regression: existing text sendMessage unaffected

## Files Modified

| File | Change |
|------|--------|
| `src/types.ts` | Add `sendImage?` to Channel interface |
| `src/channels/feishu.ts` | Implement `sendImage` |
| `src/ipc.ts` | Handle `type: "image"` messages |
| `src/router.ts` | Add `routeImage` function |
| `src/index.ts` | Wire `sendImage` into IPC deps |
