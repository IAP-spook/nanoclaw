/**
 * Tests for auto-extraction of knowledge from conversations.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import Database from 'better-sqlite3';
import { initMemorySchema } from './memory-db.js';
import { createMemoryHandler } from './memory-api.js';
import {
  extractExplicitMemories,
  extractConversationSummary,
  autoExtractAndSave,
} from '../container/agent-runner/src/memory-extract.js';
import { memoryClientList } from '../container/agent-runner/src/memory-client.js';

describe('extractExplicitMemories', () => {
  it('extracts Chinese "记住" pattern', () => {
    const messages = [
      { role: 'user' as const, content: '记住：飞书 image_key 有两种格式' },
      { role: 'assistant' as const, content: '好的，已记住。' },
    ];
    const result = extractExplicitMemories(messages);
    expect(result.length).toBe(1);
    expect(result[0].content).toBe('飞书 image_key 有两种格式');
    expect(result[0].tags).toContain('user-request');
    expect(result[0].source).toBe('auto');
  });

  it('extracts English "remember" pattern', () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'Remember: always use cosine annealing for LR',
      },
    ];
    const result = extractExplicitMemories(messages);
    expect(result.length).toBe(1);
    expect(result[0].content).toBe('always use cosine annealing for LR');
  });

  it('ignores assistant messages', () => {
    const messages = [
      { role: 'assistant' as const, content: '记住：这是助手说的' },
    ];
    expect(extractExplicitMemories(messages).length).toBe(0);
  });

  it('returns empty for no matches', () => {
    const messages = [{ role: 'user' as const, content: '今天天气怎么样？' }];
    expect(extractExplicitMemories(messages).length).toBe(0);
  });

  it('truncates long content for title', () => {
    const longContent = 'A'.repeat(100);
    const messages = [
      { role: 'user' as const, content: `记住：${longContent}` },
    ];
    const result = extractExplicitMemories(messages);
    expect(result[0].title.length).toBeLessThanOrEqual(60);
    expect(result[0].content).toBe(longContent);
  });
});

describe('extractConversationSummary', () => {
  it('returns null for short conversations (< 4 messages)', () => {
    const messages = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi!' },
    ];
    expect(extractConversationSummary(messages)).toBeNull();
  });

  it('creates summary for substantive conversations', () => {
    const messages = [
      { role: 'user' as const, content: 'How do I train a model?' },
      { role: 'assistant' as const, content: 'Use PyTorch...' },
      { role: 'user' as const, content: 'What about learning rate?' },
      { role: 'assistant' as const, content: 'Cosine annealing...' },
    ];
    const result = extractConversationSummary(messages, 'ML Training');
    expect(result).not.toBeNull();
    expect(result!.title).toContain('ML Training');
    expect(result!.content).toContain('How do I train a model');
    expect(result!.content).toContain('learning rate');
    expect(result!.tags).toContain('session-summary');
  });

  it('uses date-based title when no session title', () => {
    const messages = Array.from({ length: 4 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i}`,
    }));
    const result = extractConversationSummary(messages);
    expect(result!.title).toMatch(/^Session: \d{4}-\d{2}-\d{2}$/);
  });
});

describe('autoExtractAndSave (integration)', () => {
  let db: Database.Database;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    initMemorySchema(db);
    const handler = createMemoryHandler(db);
    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  });

  it('saves explicit memories and summary via API', async () => {
    const messages = [
      { role: 'user' as const, content: '记住：Docker 需要先 prune builder' },
      { role: 'assistant' as const, content: '好的' },
      { role: 'user' as const, content: '然后重新 build' },
      { role: 'assistant' as const, content: '已完成' },
    ];

    const logs: string[] = [];
    const count = await autoExtractAndSave(
      baseUrl,
      'main',
      messages,
      'Docker Build Fix',
      (msg) => logs.push(msg),
    );

    // 1 explicit + 1 summary
    expect(count).toBe(2);

    const list = await memoryClientList(baseUrl, { group_folder: 'main' });
    expect(list.length).toBe(2);

    const titles = list.map((e) => e.title);
    expect(titles.some((t) => t.includes('Docker'))).toBe(true);
    expect(titles.some((t) => t.includes('Session'))).toBe(true);
  });

  it('saves nothing for trivial conversations', async () => {
    const messages = [
      { role: 'user' as const, content: 'Hi' },
      { role: 'assistant' as const, content: 'Hello!' },
    ];

    const count = await autoExtractAndSave(
      baseUrl,
      'main',
      messages,
      null,
      () => {},
    );
    expect(count).toBe(0);
  });
});
