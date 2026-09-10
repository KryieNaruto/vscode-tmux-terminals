import * as fs from 'fs/promises';
import * as path from 'path';
import { parseAvailableModels, parseDefaultModel } from './core/models';
import { Profile } from './core/types';

/**
 * 读取某个 profile 的模型配置。
 *
 * ccr    → ~/.claude/settings.json
 * direct → /etc/claude/direct.json（claude-direct 包装脚本里写死的路径）
 *
 * 读不到就返回空清单，调用方据此退化为手输 —— 绝不编造候选项。
 */
export async function readProfileConfig(
  profile: Profile,
  home: string,
): Promise<{ models: string[]; defaultModel?: string }> {
  const file = profile === 'direct'
    ? '/etc/claude/direct.json'
    : path.join(home, '.claude', 'settings.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    // parse* 目前不会抛，但「宽容」是本函数的契约：把它们放在 try 内，
    // 让「读或解析失败都退化为空清单」这一点在本地一眼可见。
    return {
      models: parseAvailableModels(raw),
      defaultModel: parseDefaultModel(raw),
    };
  } catch {
    return { models: [] };
  }
}
