import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { Readable } from 'stream';
import { feishuFileType } from './feishu.js';

// We'll test the sendImage logic by importing the channel after it's implemented.
// For now, test the Feishu image upload+send flow via a minimal harness.

describe('FeishuChannel.sendImage', () => {
  // Mock createReadStream to avoid race condition where stream open fires
  // after temp file cleanup, triggering uncaught ENOENT in logger's exit handler
  const createReadStreamSpy = vi.spyOn(fs, 'createReadStream');

  beforeEach(() => {
    createReadStreamSpy.mockReturnValue(
      Readable.from(Buffer.from('fake-png-data')) as any,
    );
  });

  it('uploads image file and sends image message', async () => {
    const { createFeishuChannel } = await import('./feishu.js');

    const mockImageCreate = vi.fn().mockResolvedValue({
      data: { image_key: 'img_v3_test_key_123' },
    });
    const mockMessageCreate = vi.fn().mockResolvedValue({ code: 0 });

    const mockClient = {
      im: {
        v1: {
          image: { create: mockImageCreate },
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

    // Create a temp file so existsSync passes
    const tmpPath = '/tmp/nanoclaw-test-feishu-img.png';
    fs.writeFileSync(tmpPath, Buffer.from('fake-png-data'));

    try {
      await channel.sendImage!('oc_abc123@feishu', tmpPath);

      // Verify image upload was called
      expect(mockImageCreate).toHaveBeenCalledOnce();
      const uploadCall = mockImageCreate.mock.calls[0][0];
      expect(uploadCall.data.image_type).toBe('message');

      // Verify message send was called with image_key
      expect(mockMessageCreate).toHaveBeenCalledOnce();
      const sendCall = mockMessageCreate.mock.calls[0][0];
      expect(sendCall.data.msg_type).toBe('image');
      expect(sendCall.data.receive_id).toBe('oc_abc123');
      expect(JSON.parse(sendCall.data.content)).toEqual({
        image_key: 'img_v3_test_key_123',
      });
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('sends caption as follow-up text message', async () => {
    const { createFeishuChannel } = await import('./feishu.js');

    const mockImageCreate = vi.fn().mockResolvedValue({
      data: { image_key: 'img_key_456' },
    });
    const mockMessageCreate = vi.fn().mockResolvedValue({ code: 0 });

    const mockClient = {
      im: {
        v1: {
          image: { create: mockImageCreate },
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

    const tmpPath = '/tmp/nanoclaw-test-feishu-caption.png';
    fs.writeFileSync(tmpPath, Buffer.from('fake-png-data'));

    try {
      await channel.sendImage!(
        'oc_abc123@feishu',
        tmpPath,
        'Here is the screenshot',
      );

      // Should have 2 calls: image + caption text
      expect(mockMessageCreate).toHaveBeenCalledTimes(2);
      const captionCall = mockMessageCreate.mock.calls[1][0];
      expect(captionCall.data.msg_type).toBe('text');
      expect(JSON.parse(captionCall.data.content)).toEqual({
        text: 'Here is the screenshot',
      });
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('throws when image file does not exist', async () => {
    const { createFeishuChannel } = await import('./feishu.js');

    const mockClient = {
      im: {
        v1: {
          image: { create: vi.fn() },
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
      channel.sendImage!('oc_abc123@feishu', '/nonexistent/file.png'),
    ).rejects.toThrow();
  });
});

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
    fs.writeFileSync(tmpPath, Buffer.alloc(100));

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
