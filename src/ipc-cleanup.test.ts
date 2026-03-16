import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { cleanupIpcErrors } from './ipc.js';

describe('cleanupIpcErrors', () => {
  const errorsDir = '/tmp/nanoclaw-test-data/ipc/errors';
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('deletes files older than 7 days', () => {
    const now = Date.now();
    const oldTime = new Date(now - SEVEN_DAYS_MS - 1000);
    const recentTime = new Date(now - 1000);

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue([
      'old-error.json' as any,
      'recent-error.json' as any,
    ]);
    vi.spyOn(fs, 'statSync').mockImplementation((filePath) => {
      const name = path.basename(filePath as string);
      return {
        mtime: name === 'old-error.json' ? oldTime : recentTime,
      } as fs.Stats;
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    cleanupIpcErrors();

    expect(unlinkSpy).toHaveBeenCalledTimes(1);
    expect(unlinkSpy).toHaveBeenCalledWith(path.join(errorsDir, 'old-error.json'));
  });

  it('does nothing when errors directory does not exist', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const readdirSpy = vi.spyOn(fs, 'readdirSync');

    cleanupIpcErrors();

    expect(readdirSpy).not.toHaveBeenCalled();
  });

  it('handles errors gracefully', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('permission denied'); });

    expect(() => cleanupIpcErrors()).not.toThrow();
  });
});
