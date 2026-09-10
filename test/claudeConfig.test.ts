import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readProfileConfig } from '../src/claudeConfig';

/**
 * readProfileConfig 用真实临时文件测试：home 参数指向临时目录，
 * 内含 `.claude/settings.json`，不触碰真实 home。
 *
 * 三个关键行为：
 * 1. 有效配置 → 读出 models 与 defaultModel
 * 2. 文件缺失 → 返回空清单，不抛
 * 3. JSON 损坏 → 返回空清单，不抛
 */
describe('readProfileConfig', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'claudeConfig-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('有效配置文件 → 返回 models 数组与 defaultModel', async () => {
    const settings = {
      model: 'deepseek-v4-flash',
      availableModels: ['claude-opus-4-8[1m]', 'deepseek-v4-pro', 'qwen3.7-max'],
    };
    await fs.mkdir(path.join(tmp, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.claude', 'settings.json'),
      JSON.stringify(settings),
      'utf8',
    );

    const r = await readProfileConfig('ccr', tmp);
    assert.deepStrictEqual(r.models, [
      'claude-opus-4-8[1m]',
      'deepseek-v4-pro',
      'qwen3.7-max',
    ]);
    assert.strictEqual(r.defaultModel, 'deepseek-v4-flash');
  });

  it('文件不存在 → 返回 { models: [] } 且不抛', async () => {
    const r = await readProfileConfig('ccr', path.join(tmp, 'no-such-home'));
    assert.deepStrictEqual(r.models, []);
    assert.strictEqual(r.defaultModel, undefined);
  });

  it('文件存在但 JSON 损坏 → 返回 { models: [] } 且不抛', async () => {
    await fs.mkdir(path.join(tmp, '.claude'), { recursive: true });
    await fs.writeFile(path.join(tmp, '.claude', 'settings.json'), '{oops', 'utf8');

    const r = await readProfileConfig('ccr', tmp);
    assert.deepStrictEqual(r.models, []);
    assert.strictEqual(r.defaultModel, undefined);
  });
});
