import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { processTaskIpc } from './ipc.js';

describe('IPC image message handling', () => {
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
    }),
    registerGroup: vi.fn(),
    syncGroups: vi.fn(),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes image IPC message and calls sendImage', async () => {
    const data = {
      type: 'send_image',
      chatJid: 'oc_abc@feishu',
      filePath: '/workspace/group/screenshot.png',
      caption: 'Here it is',
    };

    await processTaskIpc(data as any, 'main', true, baseDeps as any);

    expect(baseDeps.sendImage).toHaveBeenCalledWith(
      'oc_abc@feishu',
      expect.stringContaining('screenshot.png'),
      'Here it is',
    );
  });

  it('processes image IPC message without caption', async () => {
    const data = {
      type: 'send_image',
      chatJid: 'oc_abc@feishu',
      filePath: '/workspace/group/chart.png',
    };

    await processTaskIpc(data as any, 'main', true, baseDeps as any);

    expect(baseDeps.sendImage).toHaveBeenCalledWith(
      'oc_abc@feishu',
      expect.stringContaining('chart.png'),
      undefined,
    );
  });

  it('blocks unauthorized image send from non-main group', async () => {
    const data = {
      type: 'send_image',
      chatJid: 'oc_abc@feishu',
      filePath: '/workspace/group/screenshot.png',
    };

    await processTaskIpc(data as any, 'other-group', false, baseDeps as any);

    expect(baseDeps.sendImage).not.toHaveBeenCalled();
  });
});
