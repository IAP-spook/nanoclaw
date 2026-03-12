/**
 * Seed initial memory entries from the migrated CLAUDE.md content.
 * Run once during setup to populate the memory database with knowledge
 * that was previously in CLAUDE.md.
 */
import type Database from 'better-sqlite3';
import { memorySave } from './memory-db.js';
import { syncMemoryFile, rebuildIndex } from './memory-files.js';

interface SeedEntry {
  title: string;
  content: string;
  tags: string[];
}

const SEED_ENTRIES: SeedEntry[] = [
  {
    title: 'Container Mounts',
    content: `Main has read-only access to the project and read-write access to its group folder:

| Container Path | Host Path | Access |
|----------------|-----------|--------|
| \`/workspace/project\` | Project root | read-only |
| \`/workspace/group\` | \`groups/main/\` | read-write |

Key paths:
- \`/workspace/project/store/messages.db\` — SQLite database
- \`/workspace/project/store/messages.db\` (registered_groups table) — Group config
- \`/workspace/project/groups/\` — All group folders`,
    tags: ['admin', 'container', 'mounts'],
  },
  {
    title: 'Group Management — Finding Groups',
    content: `Available groups are in \`/workspace/ipc/available_groups.json\` (synced daily, ordered by activity).

If a group isn't listed, request a fresh sync:
\`\`\`bash
echo '{"type": "refresh_groups"}' > /workspace/ipc/tasks/refresh_$(date +%s).json
\`\`\`

Fallback — query SQLite directly:
\`\`\`bash
sqlite3 /workspace/project/store/messages.db "
  SELECT jid, name, last_message_time FROM chats
  WHERE jid LIKE '%@g.us' AND jid != '__group_sync__'
  ORDER BY last_message_time DESC LIMIT 10;
"
\`\`\``,
    tags: ['admin', 'group-management'],
  },
  {
    title: 'Group Management — Registration',
    content: `Groups are registered in SQLite \`registered_groups\` table. Fields:
- **jid**: Chat JID (WhatsApp, Telegram, Slack, Discord)
- **name**: Display name
- **folder**: Channel-prefixed folder (e.g., "whatsapp_family-chat", "telegram_dev-team")
- **trigger**: Trigger word (e.g., "@Andy")
- **requiresTrigger**: Default true. Set false for solo/personal chats.
- **isMain**: Main group has elevated privileges, no trigger required.

Folder naming: \`{channel}_{group-name}\` — lowercase, hyphens for group name.

To add: use \`register_group\` MCP tool with JID, name, folder, trigger.
To remove: delete from registered_groups table. Group folder remains.
To list: query registered_groups table.`,
    tags: ['admin', 'group-management', 'registration'],
  },
  {
    title: 'Group Management — Trigger Behavior',
    content: `- **Main group** (isMain: true): No trigger needed — all messages processed
- **requiresTrigger: false**: All messages processed (use for 1-on-1 chats)
- **Other groups** (default): Messages must start with @AssistantName`,
    tags: ['admin', 'group-management', 'triggers'],
  },
  {
    title: 'Group Management — Additional Mounts',
    content: `Groups can have extra directories mounted via containerConfig.additionalMounts:

\`\`\`json
{
  "containerConfig": {
    "additionalMounts": [
      { "hostPath": "~/projects/webapp", "containerPath": "webapp", "readonly": false }
    ]
  }
}
\`\`\`

Directory appears at \`/workspace/extra/webapp\` in that group's container.`,
    tags: ['admin', 'group-management', 'mounts'],
  },
  {
    title: 'Sender Allowlist',
    content: `Control who can interact via \`~/.config/nanoclaw/sender-allowlist.json\`:

\`\`\`json
{
  "default": { "allow": "*", "mode": "trigger" },
  "chats": {
    "<chat-jid>": { "allow": ["sender-id-1"], "mode": "trigger" }
  },
  "logDenied": true
}
\`\`\`

Modes: "trigger" (everyone's messages stored, only allowed can trigger) or "drop" (non-allowed messages not stored).
Own messages (is_from_me) bypass allowlist. Config on host, not in container. Invalid/missing config = allow all.`,
    tags: ['admin', 'security', 'allowlist'],
  },
  {
    title: 'Scheduling Tasks for Other Groups',
    content: `Use target_group_jid parameter with the group's JID:
\`schedule_task(prompt: "...", schedule_type: "cron", schedule_value: "0 9 * * 1", target_group_jid: "JID")\`

Task runs in that group's context with their files and memory.`,
    tags: ['admin', 'scheduling'],
  },
  {
    title: 'Global Memory',
    content: `Global memory entries (group_folder: "global") are readable by all groups but only writable by main.
Use memory_save with appropriate scope. Only save globally when explicitly asked.`,
    tags: ['admin', 'memory'],
  },
  {
    title: 'Memory Review Task',
    content: `Schedule a weekly memory review task if not already scheduled.
Use: schedule_task(prompt: "Review and consolidate your memory. List recent memories with memory_list, merge duplicates via memory_save (upsert), remove outdated entries with memory_delete, then verify INDEX.md is current. Summarize changes made.", schedule_type: "cron", schedule_value: "0 21 * * 0", context_mode: "isolated")

This runs every Sunday at 9pm local time.`,
    tags: ['admin', 'memory', 'scheduling'],
  },
];

/**
 * Seed memory entries for a group. Skips entries that already exist (upsert).
 */
export function seedMemoryEntries(
  db: Database.Database,
  groupsDir: string,
  groupFolder: string,
): number {
  let count = 0;

  for (const entry of SEED_ENTRIES) {
    const result = memorySave(db, {
      groupFolder,
      title: entry.title,
      content: entry.content,
      tags: entry.tags,
      source: 'migration',
    });

    // Sync file
    const row = db
      .prepare('SELECT created_at, updated_at FROM memory_entries WHERE id = ?')
      .get(result.id) as { created_at: string; updated_at: string };

    syncMemoryFile(groupsDir, {
      id: result.id,
      group_folder: groupFolder,
      title: entry.title,
      content: entry.content,
      tags: entry.tags,
      source: 'migration',
      created_at: row.created_at,
      updated_at: row.updated_at,
    });

    count++;
  }

  rebuildIndex(db, groupsDir, groupFolder);
  return count;
}
