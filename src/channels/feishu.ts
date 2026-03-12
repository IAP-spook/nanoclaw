import fs from 'fs';
import path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';
import { registerChannel, type ChannelOpts } from './registry.js';
import type { Channel, NewMessage } from '../types.js';
import { logger as rootLogger } from '../logger.js';

const logger = rootLogger.child({ channel: 'feishu' });

const JID_SUFFIX = '@feishu';

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

class FeishuChannel implements Channel {
  name = 'feishu';
  private wsClient: lark.WSClient | null = null;
  private dispatcher: lark.EventDispatcher | null = null;
  private connected = false;
  private userNameCache = new Map<string, string>();

  constructor(
    private opts: ChannelOpts,
    private client: any,
    private wsConfig?: { appId: string; appSecret: string },
  ) {}

  async connect(): Promise<void> {
    if (!this.wsConfig) return;

    this.dispatcher = new lark.EventDispatcher({});
    this.dispatcher.register({
      'im.message.receive_v1': async (data) => {
        logger.info(
          { eventType: 'im.message.receive_v1' },
          'Event received from Feishu',
        );
        try {
          await this.handleMessage(data);
        } catch (err) {
          logger.error({ err }, 'Failed to handle inbound message');
        }
      },
    });

    this.wsClient = new lark.WSClient({
      appId: this.wsConfig.appId,
      appSecret: this.wsConfig.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
      autoReconnect: true,
    });

    logger.info('Connecting via WebSocket long connection');
    await this.wsClient.start({ eventDispatcher: this.dispatcher });
    this.connected = true;
    logger.info('Connected');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const rawId = jid.replace(JID_SUFFIX, '');
    const receiveIdType = rawId.startsWith('oc_') ? 'chat_id' : 'open_id';

    await this.client.im.v1.message.create({
      data: {
        receive_id: rawId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
      params: {
        receive_id_type: receiveIdType as any,
      },
    });
  }

  async sendImage(
    jid: string,
    imagePath: string,
    caption?: string,
  ): Promise<void> {
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image file not found: ${imagePath}`);
    }

    const rawId = jid.replace(JID_SUFFIX, '');
    const receiveIdType = rawId.startsWith('oc_') ? 'chat_id' : 'open_id';

    // Upload image
    const uploadResp = await this.client.im.v1.image.create({
      data: {
        image_type: 'message',
        image: fs.createReadStream(imagePath),
      },
    });

    const imageKey = uploadResp?.data?.image_key ?? uploadResp?.image_key;
    if (!imageKey) {
      logger.error({ uploadResp }, 'Feishu image upload returned no image_key');
      throw new Error('Failed to upload image: no image_key returned');
    }

    // Send image message
    await this.client.im.v1.message.create({
      data: {
        receive_id: rawId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
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

    logger.info({ jid, imagePath }, 'Image sent');
  }

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

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(JID_SUFFIX);
  }

  async disconnect(): Promise<void> {
    this.wsClient?.close({});
    this.connected = false;
    logger.info('Disconnected');
  }

  private async handleMessage(data: any): Promise<void> {
    const sender = data.sender;
    const message = data.message;

    if (sender?.sender_type !== 'user') return;

    const senderOpenId = sender?.sender_id?.open_id ?? 'unknown';
    const chatId = message?.chat_id;
    const chatType = message?.chat_type;
    const messageType = message?.message_type;
    const messageId = message?.message_id;

    if (!chatId || !messageId) return;

    const jid = `${chatId}${JID_SUFFIX}`;
    const isGroup = chatType === 'group';

    let content: string;
    if (messageType === 'text') {
      try {
        const parsed = JSON.parse(message.content);
        content = parsed.text ?? '';
      } catch {
        content = message.content ?? '';
      }
    } else {
      content = `[${messageType ?? 'unknown'} message]`;
    }

    content = content.replace(/@_user_\d+/g, '').trim();

    const senderName = await this.resolveSenderName(senderOpenId);

    const timestamp = new Date(
      parseInt(message.create_time, 10) * 1000,
    ).toISOString();

    this.opts.onChatMetadata(jid, timestamp, undefined, 'feishu', isGroup);

    const msg: NewMessage = {
      id: messageId,
      chat_jid: jid,
      sender: senderOpenId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    };

    this.opts.onMessage(jid, msg);
    logger.info(
      { jid, sender: senderName, chatType },
      'Inbound message received',
    );
  }

  private async resolveSenderName(openId: string): Promise<string> {
    const cached = this.userNameCache.get(openId);
    if (cached) return cached;

    try {
      const resp = await this.client.contact.v3.user.get({
        params: { user_id_type: 'open_id' },
        path: { user_id: openId },
      });
      const name = resp.data?.user?.name ?? openId;
      this.userNameCache.set(openId, name);
      return name;
    } catch (err) {
      logger.warn({ err, openId }, 'Failed to resolve user name');
      return openId;
    }
  }
}

/** Create a FeishuChannel with an injected client (for testing). */
export function createFeishuChannel(
  opts: ChannelOpts,
  client: any,
): FeishuChannel {
  return new FeishuChannel(opts, client);
}

// Self-registration
registerChannel('feishu', (opts: ChannelOpts) => {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;
  const client = new lark.Client({ appId, appSecret });
  return new FeishuChannel(opts, client, { appId, appSecret });
});
