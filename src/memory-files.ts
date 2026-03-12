/**
 * Memory file sync — writes markdown files and INDEX.md from memory entries.
 * Called by the memory API after DB writes to keep the file layer in sync.
 */
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { memoryList } from './memory-db.js';

/** Convert a title to a filename-safe slug. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-') // non-letter/non-number → hyphen
    .replace(/-{2,}/g, '-') // collapse runs
    .replace(/^-|-$/g, ''); // trim edges
}

export interface MemoryFileEntry {
  id: number;
  group_folder: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  created_at: string;
  updated_at: string;
}

/**
 * Write (or overwrite) a memory entry as a markdown file.
 * Creates `{groupsDir}/{group_folder}/memory/{slug}.md`.
 */
export function syncMemoryFile(
  groupsDir: string,
  entry: MemoryFileEntry,
): void {
  const memDir = path.join(groupsDir, entry.group_folder, 'memory');
  fs.mkdirSync(memDir, { recursive: true });

  const slug = slugify(entry.title);
  const filepath = path.join(memDir, `${slug}.md`);

  const tagsLine = entry.tags.length > 0 ? entry.tags.join(', ') : '';
  const frontmatter = [
    '---',
    `title: ${entry.title}`,
    `tags: [${tagsLine}]`,
    `source: ${entry.source}`,
    `created: ${entry.created_at}`,
    `updated: ${entry.updated_at}`,
    '---',
  ].join('\n');

  const fileContent = `${frontmatter}\n\n${entry.content}\n`;
  fs.writeFileSync(filepath, fileContent, 'utf-8');
}

/**
 * Delete a memory markdown file by title.
 * No-op if the file does not exist.
 */
export function deleteMemoryFile(
  groupsDir: string,
  groupFolder: string,
  title: string,
): void {
  const slug = slugify(title);
  const filepath = path.join(groupsDir, groupFolder, 'memory', `${slug}.md`);
  try {
    fs.unlinkSync(filepath);
  } catch {
    // File didn't exist — fine
  }
}

/**
 * Rebuild INDEX.md for a group from all its memory entries in the database.
 */
export function rebuildIndex(
  db: Database.Database,
  groupsDir: string,
  groupFolder: string,
): void {
  const memDir = path.join(groupsDir, groupFolder, 'memory');
  fs.mkdirSync(memDir, { recursive: true });

  const entries = memoryList(db, { groupFolder });

  let content = '# Memory Index\n\n';
  content += `_${entries.length} memories for group \`${groupFolder}\`._\n`;

  if (entries.length > 0) {
    content += '\n| Title | Tags | Updated |\n|-------|------|--------|\n';
    for (const e of entries) {
      const tags = e.tags.join(', ') || '-';
      content += `| ${e.title} | ${tags} | ${e.updatedAt} |\n`;
    }
  }

  fs.writeFileSync(path.join(memDir, 'INDEX.md'), content, 'utf-8');
}
