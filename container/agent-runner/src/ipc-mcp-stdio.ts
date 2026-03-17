/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import {
  memoryClientSave,
  memoryClientSearch,
  memoryClientList,
  memoryClientDelete,
} from './memory-client.js';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// ---------------------------------------------------------------------------
// Media sending tools — write IPC task JSON for host to process
// ---------------------------------------------------------------------------

server.tool(
  'send_file',
  'Send a file to the chat. Supports PDFs, documents, archives, audio, and other file types. The file must exist in your workspace.',
  {
    file_path: z.string().describe('Absolute path to the file (e.g., /workspace/group/report.pdf)'),
    caption: z.string().optional().describe('Optional caption text sent with the file'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'send_file',
      chatJid,
      filePath: args.file_path,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'File queued for sending.' }] };
  },
);

server.tool(
  'send_image',
  'Send an image file to the chat. Use for screenshots, charts, plots, and other images.',
  {
    file_path: z.string().describe('Absolute path to the image file (e.g., /workspace/group/screenshot.png)'),
    caption: z.string().optional().describe('Optional caption text sent with the image'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'send_image',
      chatJid,
      filePath: args.file_path,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Image queued for sending.' }] };
  },
);

// ---------------------------------------------------------------------------
// Memory tools — talk to the host memory API via the credential proxy
// ---------------------------------------------------------------------------

const memoryBaseUrl = process.env.ANTHROPIC_BASE_URL || 'http://127.0.0.1:3001';

server.tool(
  'memory_save',
  `Save a piece of knowledge to long-term memory. Memories persist across conversations.
Use this to remember facts, preferences, decisions, lessons learned, or anything worth recalling later.
If a memory with the same title already exists in this group, it will be updated (upserted).`,
  {
    title: z.string().describe('Short descriptive title (used as unique key within the group)'),
    content: z.string().describe('The knowledge to remember — be specific and self-contained'),
    tags: z.array(z.string()).default([]).describe('Optional tags for categorization (e.g., ["preference", "coding"])'),
    source: z.string().optional().describe('Where this knowledge came from (e.g., "user request", "conversation")'),
  },
  async (args) => {
    try {
      const result = await memoryClientSave(memoryBaseUrl, {
        group_folder: groupFolder,
        title: args.title,
        content: args.content,
        tags: args.tags,
        source: args.source,
      });
      return {
        content: [{ type: 'text' as const, text: `Memory saved (id: ${result.id}): "${args.title}"` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to save memory: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_search',
  `Search long-term memory for relevant knowledge. Uses full-text search.
Returns matching memories with content. Use this before answering questions that might benefit from prior knowledge.`,
  {
    query: z.string().describe('Search query — keywords or phrases to find'),
    tags: z.array(z.string()).optional().describe('Optional: filter to memories with ALL of these tags'),
    limit: z.number().optional().describe('Max results to return (default: 20)'),
  },
  async (args) => {
    try {
      const results = await memoryClientSearch(memoryBaseUrl, {
        group_folder: groupFolder,
        query: args.query,
        tags: args.tags,
        limit: args.limit,
      });
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matching memories found.' }] };
      }
      const formatted = results
        .map(
          (r) =>
            `[${r.id}] ${r.title}\n  Tags: ${r.tags.join(', ') || 'none'}\n  Updated: ${r.updated_at}\n  ${r.content}`,
        )
        .join('\n\n');
      return { content: [{ type: 'text' as const, text: `Found ${results.length} memor${results.length === 1 ? 'y' : 'ies'}:\n\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Memory search failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_list',
  `List all memories in this group (summaries without full content). Use memory_search for content-based lookup.`,
  {
    tags: z.array(z.string()).optional().describe('Optional: filter to memories with ALL of these tags'),
  },
  async (args) => {
    try {
      const results = await memoryClientList(memoryBaseUrl, {
        group_folder: groupFolder,
        tags: args.tags,
      });
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No memories stored yet.' }] };
      }
      const formatted = results
        .map(
          (r) => `[${r.id}] ${r.title}  (tags: ${r.tags.join(', ') || 'none'}, updated: ${r.updated_at})`,
        )
        .join('\n');
      return { content: [{ type: 'text' as const, text: `${results.length} memor${results.length === 1 ? 'y' : 'ies'}:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Memory list failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_delete',
  `Delete a memory by ID. You can only delete memories belonging to your own group (main group can also delete global memories).`,
  {
    id: z.number().describe('The memory ID to delete (from memory_list or memory_search results)'),
  },
  async (args) => {
    try {
      const result = await memoryClientDelete(memoryBaseUrl, {
        id: args.id,
        group_folder: groupFolder,
      });
      if (result.deleted) {
        return { content: [{ type: 'text' as const, text: `Memory ${args.id} deleted.` }] };
      }
      return { content: [{ type: 'text' as const, text: `Memory ${args.id} not found or not authorized to delete.` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Memory delete failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Host terminal tools — execute commands on the host machine
// ---------------------------------------------------------------------------

const HOST_EXEC_DIR = path.join(IPC_DIR, 'host-exec');
const HOST_TASKS_DIR = '/workspace/host-tasks';
const hostGroupPath = process.env.NANOCLAW_HOST_GROUP_PATH || '/workspace/group';

server.tool(
  'host_exec',
  `Execute a shell command on the HOST machine (outside the container). Use for tasks needing GPU, conda environments, host filesystem access, or long-running processes.

IMPORTANT: You must obtain explicit user authorization before using this tool. Explain what you need to do and ask permission. Operate only within the granted scope.

Modes:
• background=false (default): Blocks up to 30s, returns stdout/stderr directly. Use for quick commands.
• background=true: Returns task_id immediately. Use host_task_status to check progress later.

If a sync command times out at 30s, the process keeps running. You'll get a task_id to follow up.`,
  {
    command: z.string().describe('Shell command to execute on the host'),
    working_dir: z.string().optional().describe('Working directory (default: group directory on host)'),
    background: z.boolean().optional().describe('true=async (returns task_id), false=sync (waits up to 30s)'),
  },
  async (args) => {
    const taskId = `host-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const background = args.background ?? false;

    writeIpcFile(HOST_EXEC_DIR, {
      type: 'host_exec',
      task_id: taskId,
      groupFolder,
      command: args.command,
      working_dir: args.working_dir || hostGroupPath,
      background,
      timestamp: Date.now(),
    });

    if (background) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ task_id: taskId }) }],
      };
    }

    // Sync mode: poll for completion
    const statusFile = path.join(HOST_TASKS_DIR, taskId, 'status');
    const timeout = 30_000;
    const pollInterval = 200;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, pollInterval));

      try {
        if (!fs.existsSync(statusFile)) continue; // pending
        const status = fs.readFileSync(statusFile, 'utf-8').trim();
        if (status === 'running') continue;

        // completed or failed
        const taskDir = path.join(HOST_TASKS_DIR, taskId);
        const stdout = fs.existsSync(path.join(taskDir, 'stdout.log'))
          ? fs.readFileSync(path.join(taskDir, 'stdout.log'), 'utf-8')
          : '';
        const stderr = fs.existsSync(path.join(taskDir, 'stderr.log'))
          ? fs.readFileSync(path.join(taskDir, 'stderr.log'), 'utf-8')
          : '';
        const meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf-8'));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ exit_code: meta.exit_code, stdout, stderr }),
          }],
        };
      } catch { /* retry */ }
    }

    // Timeout
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'timeout', task_id: taskId }),
      }],
    };
  },
);

server.tool(
  'host_task_status',
  'Check status and output of a host task started with host_exec(background=true).',
  {
    task_id: z.string().describe('The task ID returned by host_exec'),
    tail: z.number().optional().describe('Lines from end of output (default 50, -1 for all)'),
  },
  async (args) => {
    const taskDir = path.join(HOST_TASKS_DIR, args.task_id);

    if (!fs.existsSync(taskDir)) {
      return { content: [{ type: 'text' as const, text: `Task ${args.task_id} not found.` }], isError: true };
    }

    const status = fs.existsSync(path.join(taskDir, 'status'))
      ? fs.readFileSync(path.join(taskDir, 'status'), 'utf-8').trim()
      : 'unknown';

    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf-8'));
    } catch { /* best effort */ }

    const tailN = args.tail ?? 50;

    const readTail = (file: string): string => {
      const fullPath = path.join(taskDir, file);
      if (!fs.existsSync(fullPath)) return '';
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (tailN === -1) return content;
      const lines = content.split('\n');
      return lines.slice(-tailN).join('\n');
    };

    const result = {
      status,
      exit_code: meta.exit_code ?? null,
      stdout_tail: readTail('stdout.log'),
      stderr_tail: readTail('stderr.log'),
      started_at: meta.started_at || null,
      finished_at: meta.finished_at || null,
    };

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'host_task_kill',
  'Terminate a running host task.',
  {
    task_id: z.string().describe('The task ID to kill'),
  },
  async (args) => {
    writeIpcFile(HOST_EXEC_DIR, {
      type: 'host_kill',
      task_id: args.task_id,
      groupFolder,
      timestamp: Date.now(),
    });

    return { content: [{ type: 'text' as const, text: `Kill requested for task ${args.task_id}.` }] };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
