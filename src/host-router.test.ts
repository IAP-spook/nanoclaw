import { describe, it, expect } from 'vitest';
import {
  shouldRunOnHost,
  loadHostConfig,
  HostRouteConfig,
} from './host-router.js';

const defaultConfig: HostRouteConfig = {
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

describe('host-router', () => {
  describe('shouldRunOnHost', () => {
    it('returns false when disabled', () => {
      const config = { ...defaultConfig, enabled: false };
      expect(shouldRunOnHost('请训练模型', config)).toBe(false);
    });

    it('returns false for prompts without keywords', () => {
      expect(shouldRunOnHost('你好，今天天气怎么样', defaultConfig)).toBe(
        false,
      );
    });

    it('returns true when prompt contains a keyword', () => {
      expect(shouldRunOnHost('请帮我训练一下这个模型', defaultConfig)).toBe(
        true,
      );
    });

    it('keyword matching is case-insensitive', () => {
      expect(shouldRunOnHost('Install gpu drivers', defaultConfig)).toBe(true);
    });

    it('forceHostPrefix overrides keywords', () => {
      expect(shouldRunOnHost('在主机上 查看文件', defaultConfig)).toBe(true);
    });

    it('forceContainerPrefix overrides keywords', () => {
      expect(shouldRunOnHost('用容器 训练模型', defaultConfig)).toBe(false);
    });

    it('forceContainerPrefix takes priority over forceHostPrefix', () => {
      expect(shouldRunOnHost('用容器 在主机上 训练', defaultConfig)).toBe(
        false,
      );
    });

    it('returns false with empty keywords list', () => {
      const config = { ...defaultConfig, keywords: [] };
      expect(shouldRunOnHost('请训练模型', config)).toBe(false);
    });

    it('handles missing prefix fields', () => {
      const config: HostRouteConfig = { enabled: true, keywords: ['train'] };
      expect(shouldRunOnHost('train the model', config)).toBe(true);
      expect(shouldRunOnHost('hello world', config)).toBe(false);
    });
  });

  describe('loadHostConfig', () => {
    it('returns default config when file does not exist', () => {
      const config = loadHostConfig('nonexistent-group-folder-xyz');
      expect(config.enabled).toBe(true);
      expect(config.keywords).toContain('训练');
    });
  });
});
