import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_TIMEOUT, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface HostRunnerInput {
  prompt: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  sessionId?: string;
  isScheduledTask?: boolean;
}

export interface HostRunnerOutput {
  status: 'success' | 'error';
  result: string | null;
  sessionId?: string;
  error?: string;
}

export function validateClaudeCli(): boolean {
  try {
    execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    logger.warn('claude CLI not found on host — host execution will not work');
    return false;
  }
}

export async function runHostAgent(
  group: RegisteredGroup,
  input: HostRunnerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: HostRunnerOutput) => Promise<void>,
): Promise<HostRunnerOutput> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, input.groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const processName = `host-${group.folder}-${Date.now()}`;

  const args = [
    '-p',
    input.prompt,
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--verbose',
  ];

  if (input.sessionId) {
    args.push('--resume', input.sessionId);
  }

  logger.info(
    { group: group.name, processName, hasSession: !!input.sessionId },
    'Spawning host Claude Code agent',
  );

  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      cwd: groupDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(proc, processName);

    let stderr = '';
    let resultText: string | null = null;
    let sessionId: string | undefined;
    let timedOut = false;
    let outputChain = Promise.resolve();

    const timeoutMs = CONTAINER_TIMEOUT;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Host agent timeout, sending SIGTERM',
      );
      proc.kill('SIGTERM');

      setTimeout(() => {
        if (!proc.killed) {
          logger.warn(
            { processName },
            'SIGTERM did not stop host agent, sending SIGKILL',
          );
          proc.kill('SIGKILL');
        }
      }, 5000);
    }, timeoutMs);

    let lineBuffer = '';

    proc.stdout.on('data', (data) => {
      lineBuffer += data.toString();

      let newlineIdx: number;
      while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, newlineIdx).trim();
        lineBuffer = lineBuffer.slice(newlineIdx + 1);

        if (!line) continue;

        try {
          const event = JSON.parse(line);

          if (event.type === 'result') {
            resultText = event.result || null;
            sessionId = event.session_id;

            if (onOutput) {
              const output: HostRunnerOutput = {
                status: 'success',
                result: resultText,
                sessionId,
              };
              outputChain = outputChain.then(() => onOutput(output));
            }
          }
        } catch {
          // Non-JSON line, skip
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutTimer);
      const duration = Date.now() - startTime;

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `host-${timestamp}.log`);
      fs.writeFileSync(
        logFile,
        [
          `=== Host Agent Run Log ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Process: ${processName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Timed Out: ${timedOut}`,
          `Has Result: ${!!resultText}`,
          `Session ID: ${sessionId || 'none'}`,
          ``,
          `=== Stderr ===`,
          stderr.slice(-2000),
        ].join('\n'),
      );

      if (timedOut) {
        logger.error(
          { group: group.name, processName, duration },
          'Host agent timed out',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Host agent timed out after ${timeoutMs}ms`,
        });
        return;
      }

      if (code !== 0) {
        logger.error(
          { group: group.name, processName, code, duration },
          'Host agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Host agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      outputChain.then(() => {
        logger.info(
          { group: group.name, processName, duration, sessionId },
          'Host agent completed',
        );
        resolve({
          status: 'success',
          result: resultText,
          sessionId,
        });
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutTimer);
      logger.error(
        { group: group.name, processName, error: err },
        'Host agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Host agent spawn error: ${err.message}`,
      });
    });
  });
}
