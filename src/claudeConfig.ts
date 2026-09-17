import * as fs from 'fs/promises';
import * as path from 'path';
import { parseAvailableModels, parseDefaultModel } from './core/models';
import { Profile } from './core/types';

/**
 * 读取某个 profile 的模型配置。
 *
 * ccr    → ~/.claude/settings.json
 * direct → directFile（默认 /etc/claude/direct.json，claude-direct 包装
 *   脚本里写死的路径；参数化只是为了让单测能指向临时文件，不必读那份
 *   root 只读、全机共享的真实系统文件）
 *
 * 读不到就返回空清单，调用方据此退化为手输 —— 绝不编造候选项。
 *
 * **例外**：direct 自己的清单为空时，借用 ccr 清单里 `claude-` 前缀的条目
 * 作为候选。direct 直连端点认的是真实 Anthropic 模型 ID（如
 * `claude-sonnet-5[1m]`），而 ccr 清单里混着 `deepseek-v4-flash` 之类的
 * 第三方路由模型名——那些名字对 direct 端点没有意义，选中就会失败，所以
 * 只借用两边命名空间重叠的 `claude-*` 部分，不整份搬运。`defaultModel`
 * 永远只用 direct 自己的（ccr 的默认模型对 direct 端点同样没有意义），
 * 只有候选清单会借用；direct 一旦自己配了非空清单，则完全不借用 ccr。
 */
export async function readProfileConfig(
  profile: Profile,
  home: string,
  directFile: string = '/etc/claude/direct.json',
): Promise<{ models: string[]; defaultModel?: string }> {
  const ccrFile = path.join(home, '.claude', 'settings.json');
  if (profile !== 'direct') {
    return readOne(ccrFile);
  }
  const own = await readOne(directFile);
  if (own.models.length > 0) return own;
  const ccr = await readOne(ccrFile);
  return {
    models: ccr.models.filter((m) => /^claude-/i.test(m)),
    defaultModel: own.defaultModel,
  };
}

// parse* 目前不会抛，但「宽容」是本函数的契约：把它们放在 try 内，
// 让「读或解析失败都退化为空清单」这一点在本地一眼可见。
async function readOne(file: string): Promise<{ models: string[]; defaultModel?: string }> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return {
      models: parseAvailableModels(raw),
      defaultModel: parseDefaultModel(raw),
    };
  } catch {
    return { models: [] };
  }
}
