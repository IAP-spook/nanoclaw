import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

export interface RunOptions {
  taskId: string;
  groupFolder: string;
  command: string;
  workingDir: string;
  background: boolean;
}

interface TaskMeta {
  command: string;
  pid: number;
  started_at: string;
  finished_at?: string;
  exit_code?: number | null;
}

export class HostExecutor {
  private baseDir: string;
  private processes: Map<string, ChildProcess> = new Map();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private taskDir(groupFolder: string, taskId: string): string {
    return path.join(this.baseDir, groupFolder, taskId);
  }

  private processKey(groupFolder: string, taskId: string): string {
    return `${groupFolder}/${taskId}`;
  }

  run(opts: RunOptions): void {
    const { taskId, groupFolder, command, workingDir, background } = opts;
    const dir = this.taskDir(groupFolder, taskId);
    fs.mkdirSync(dir, { recursive: true });

    // Write initial status
    fs.writeFileSync(path.join(dir, 'status'), 'running');

    const child = spawn(command, { shell: true, cwd: workingDir });

    const meta: TaskMeta = {
      command,
      pid: child.pid!,
      started_at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

    // Pipe stdout/stderr to log files
    const stdoutStream = fs.createWriteStream(path.join(dir, 'stdout.log'), { flags: 'a' });
    const stderrStream = fs.createWriteStream(path.join(dir, 'stderr.log'), { flags: 'a' });

    child.stdout?.pipe(stdoutStream);
    child.stderr?.pipe(stderrStream);

    const key = this.processKey(groupFolder, taskId);
    this.processes.set(key, child);

    child.on('close', (code, signal) => {
      this.processes.delete(key);

      // Check if this was killed
      const currentStatus = fs.readFileSync(path.join(dir, 'status'), 'utf-8').trim();
      if (currentStatus === 'killed') {
        // Already marked as killed, just update meta
        meta.finished_at = new Date().toISOString();
        meta.exit_code = code;
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
        return;
      }

      const finalStatus = code === 0 ? 'completed' : 'failed';
      fs.writeFileSync(path.join(dir, 'status'), finalStatus);

      meta.finished_at = new Date().toISOString();
      meta.exit_code = code;
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

      logger.debug({ taskId, groupFolder, code }, 'host task finished');
    });

    child.on('error', (err) => {
      this.processes.delete(key);
      fs.writeFileSync(path.join(dir, 'status'), 'failed');
      meta.finished_at = new Date().toISOString();
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
      logger.error({ taskId, err }, 'host task error');
    });
  }

  kill(taskId: string, groupFolder: string): boolean {
    const key = this.processKey(groupFolder, taskId);
    const child = this.processes.get(key);
    if (!child) return false;

    const dir = this.taskDir(groupFolder, taskId);
    fs.writeFileSync(path.join(dir, 'status'), 'killed');
    child.kill('SIGTERM');
    return true;
  }

  killAll(): void {
    for (const [key, child] of this.processes.entries()) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    this.processes.clear();
  }

  recover(): void {
    if (!fs.existsSync(this.baseDir)) return;

    const groups = fs.readdirSync(this.baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const group of groups) {
      const groupDir = path.join(this.baseDir, group);
      const tasks = fs.readdirSync(groupDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      for (const taskId of tasks) {
        const dir = path.join(groupDir, taskId);
        const statusFile = path.join(dir, 'status');
        const metaFile = path.join(dir, 'meta.json');

        if (!fs.existsSync(statusFile) || !fs.existsSync(metaFile)) continue;

        const status = fs.readFileSync(statusFile, 'utf-8').trim();
        if (status !== 'running') continue;

        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));

        // Check if pid is still alive
        let alive = false;
        try {
          process.kill(meta.pid, 0);
          alive = true;
        } catch {
          alive = false;
        }

        if (!alive) {
          fs.writeFileSync(statusFile, 'failed');
          meta.finished_at = new Date().toISOString();
          fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
          logger.info({ taskId, group, pid: meta.pid }, 'recovered dead host task');
        }
      }
    }
  }
}
