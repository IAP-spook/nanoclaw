/**
 * Auto-extract knowledge from conversation transcripts.
 * Called by the PreCompact hook after archiving.
 * Uses lightweight heuristics (no LLM call) to extract:
 *   1. Explicit "remember" requests from the user
 *   2. A conversation summary entry
 */
import { memoryClientSave } from './memory-client.js';

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Patterns that indicate the user wants something remembered.
 * Matches Chinese and English variations.
 */
const REMEMBER_PATTERNS = [
  /记住[：:]\s*(.+)/,
  /记下[：:]\s*(.+)/,
  /记录[：:]\s*(.+)/,
  /remember[：:]\s*(.+)/i,
  /note[：:]\s*(.+)/i,
  /save.*memo(?:ry)?[：:]\s*(.+)/i,
];

export interface ExtractedMemory {
  title: string;
  content: string;
  tags: string[];
  source: string;
}

/**
 * Extract explicit "remember" requests from user messages.
 */
export function extractExplicitMemories(
  messages: ParsedMessage[],
): ExtractedMemory[] {
  const memories: ExtractedMemory[] = [];

  for (const msg of messages) {
    if (msg.role !== 'user') continue;

    for (const pattern of REMEMBER_PATTERNS) {
      const match = msg.content.match(pattern);
      if (match && match[1]) {
        const rawContent = match[1].trim();
        // Use first line (up to 60 chars) as title, full text as content
        const title =
          rawContent.length > 60
            ? rawContent.slice(0, 57) + '...'
            : rawContent;
        memories.push({
          title,
          content: rawContent,
          tags: ['user-request'],
          source: 'auto',
        });
        break; // One match per message
      }
    }
  }

  return memories;
}

/**
 * Generate a brief conversation summary memory entry.
 * Only created if the conversation has substantive content (>= 4 messages).
 */
export function extractConversationSummary(
  messages: ParsedMessage[],
  sessionTitle?: string | null,
): ExtractedMemory | null {
  if (messages.length < 4) return null;

  // Collect user messages for topic hints
  const userMessages = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content.slice(0, 200));

  if (userMessages.length === 0) return null;

  const date = new Date().toISOString().split('T')[0];
  const title = sessionTitle
    ? `Session: ${sessionTitle} (${date})`
    : `Session: ${date}`;

  // Build a summary from user queries (topics discussed)
  const topics = userMessages
    .map((m, i) => `${i + 1}. ${m.length > 100 ? m.slice(0, 97) + '...' : m}`)
    .join('\n');

  const content = `Conversation on ${date} with ${messages.length} messages.\n\nTopics discussed:\n${topics}`;

  return {
    title,
    content,
    tags: ['session-summary'],
    source: 'auto',
  };
}

/**
 * Run auto-extraction on a parsed transcript and save to memory API.
 * Best-effort — errors are logged but don't propagate.
 */
export async function autoExtractAndSave(
  baseUrl: string,
  groupFolder: string,
  messages: ParsedMessage[],
  sessionTitle?: string | null,
  logFn: (msg: string) => void = console.log,
): Promise<number> {
  let saved = 0;

  const explicit = extractExplicitMemories(messages);
  const summary = extractConversationSummary(messages, sessionTitle);

  const toSave = [...explicit];
  if (summary) toSave.push(summary);

  for (const mem of toSave) {
    try {
      await memoryClientSave(baseUrl, {
        group_folder: groupFolder,
        title: mem.title,
        content: mem.content,
        tags: mem.tags,
        source: mem.source,
      });
      saved++;
      logFn(`Auto-saved memory: "${mem.title}"`);
    } catch (err) {
      logFn(
        `Failed to auto-save memory "${mem.title}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return saved;
}
