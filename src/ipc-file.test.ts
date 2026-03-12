import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

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
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const statSpy = vi
      .spyOn(fs, 'statSync')
      .mockReturnValue({ size: 100 } as any);

    try {
      const data = {
        type: 'send_file',
        chatJid: 'oc_abc@feishu',
        filePath: '/workspace/group/report.pdf',
      };

      await processTaskIpc(data as any, 'main', true, baseDeps as any);

      expect(baseDeps.sendFile).toHaveBeenCalledWith(
        'oc_abc@feishu',
        expect.stringContaining('report.pdf'),
        undefined,
      );
    } finally {
      existsSpy.mockRestore();
      statSpy.mockRestore();
    }
  });

  it('sends file with caption', async () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const statSpy = vi
      .spyOn(fs, 'statSync')
      .mockReturnValue({ size: 100 } as any);

    try {
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
    } finally {
      existsSpy.mockRestore();
      statSpy.mockRestore();
    }
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

  it('skips when file does not exist', async () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    try {
      const data = {
        type: 'send_file',
        chatJid: 'oc_abc@feishu',
        filePath: '/workspace/group/missing.pdf',
      };

      await processTaskIpc(data as any, 'main', true, baseDeps as any);

      expect(baseDeps.sendFile).not.toHaveBeenCalled();
    } finally {
      existsSpy.mockRestore();
    }
  });
});
