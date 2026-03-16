import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

export interface HostRouteConfig {
  enabled: boolean;
  keywords: string[];
  forceHostPrefix?: string;
  forceContainerPrefix?: string;
}

const DEFAULT_CONFIG: HostRouteConfig = {
  enabled: true,
  keywords: [
    '训练',
    'train',
    'conda',
    'GPU',
    '模型',
    'model',
    'python',
    '系统',
    'pip',
    'pytorch',
  ],
  forceHostPrefix: '在主机上',
  forceContainerPrefix: '用容器',
};

export function shouldRunOnHost(
  prompt: string,
  config: HostRouteConfig,
): boolean {
  if (!config.enabled) return false;

  const trimmed = prompt.trim();

  // Manual override prefixes (container prefix wins if both present)
  if (
    config.forceContainerPrefix &&
    trimmed.startsWith(config.forceContainerPrefix)
  ) {
    return false;
  }
  if (config.forceHostPrefix && trimmed.startsWith(config.forceHostPrefix)) {
    return true;
  }

  // Keyword matching (case-insensitive)
  const lower = trimmed.toLowerCase();
  return config.keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

export function loadHostConfig(groupFolder: string): HostRouteConfig {
  const configPath = path.join(GROUPS_DIR, groupFolder, 'host-rules.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
      keywords: parsed.keywords ?? DEFAULT_CONFIG.keywords,
      forceHostPrefix: parsed.forceHostPrefix ?? DEFAULT_CONFIG.forceHostPrefix,
      forceContainerPrefix:
        parsed.forceContainerPrefix ?? DEFAULT_CONFIG.forceContainerPrefix,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ groupFolder }, 'No host-rules.json found, using defaults');
    } else {
      logger.warn(
        { groupFolder, err },
        'Failed to parse host-rules.json, using defaults',
      );
    }
    return { ...DEFAULT_CONFIG };
  }
}
