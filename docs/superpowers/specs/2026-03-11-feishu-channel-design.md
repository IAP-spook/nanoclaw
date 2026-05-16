# Feishu Channel Design

## Overview

Add Feishu (飞书/Lark) as a messaging channel for NanoClaw, following the existing channel plugin architecture.

## Architecture

Feishu channel uses the official `@larksuiteoapi/node-sdk` with WebSocket long connection mode. No public IP required.

```
Feishu Server ←→ WebSocket (lark.ws) ←→ FeishuChannel
                                           ↓ onMessage()
                                     NanoClaw Core
                                           ↓ sendMessage()
                                     Feishu REST API
```

## Components

### `src/channels/feishu.ts`

Implements the `Channel` interface:

- **`connect()`**: Creates Lark SDK client, starts WebSocket event dispatcher subscribing to `im.message.receive_v1`
- **`sendMessage(jid, text)`**: Calls Feishu `im.v1.message.create` API to send text messages
- **`ownsJid(jid)`**: Returns true for JIDs ending with `@feishu`
- **`isConnected()`**: Tracks WebSocket connection state
- **`disconnect()`**: Closes WebSocket connection
- **`setTyping()`**: Not implemented (Feishu has no typing indicator API)

### JID Format

- Group chat: `oc_xxxxx@feishu` (chat_id from Feishu)
- Private chat: `ou_xxxxx@feishu` (open_id of the user)

### Credentials (`.env`)

```
FEISHU_APP_ID=cli_xxxx
FEISHU_APP_SECRET=xxxx
```

### Self-Registration

```typescript
registerChannel('feishu', (opts) => {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;
  return new FeishuChannel(opts, appId, appSecret);
});
```

### Message Handling

**Inbound:**
1. WebSocket receives `im.message.receive_v1` event
2. Extract message content (text only; other types → `[unsupported message type]`)
3. Extract sender info via Feishu user API (cache user names)
4. Build `NewMessage` and call `onMessage()` callback
5. Call `onChatMetadata()` for chat/group metadata

**Outbound:**
1. Parse JID to get chat_id or open_id
2. Call `im.v1.message.create` with `receive_id_type` = `chat_id` or `open_id`
3. Send as text content type

### Group Chat Behavior

- In group chats, the bot responds when @mentioned (Feishu provides mention info in the event)
- NanoClaw's `trigger_pattern` handles additional filtering
- Bot messages (from self) are filtered out to avoid loops

### Dependencies

- `@larksuiteoapi/node-sdk` — Official Feishu/Lark Node.js SDK

## Files Changed

| File | Change |
|------|--------|
| `src/channels/feishu.ts` | New: Channel implementation |
| `src/channels/index.ts` | Add `import './feishu.js'` |
| `package.json` | Add `@larksuiteoapi/node-sdk` dependency |
