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

  /**
   * direct 分支：全部用第三参数 directFile 指向临时文件，绝不读真实的
   * /etc/claude/direct.json（root 只读、全机共享，测试不该依赖它）。
   */
  describe('direct 分支：清单为空时借用 ccr 的 claude-* 候选', () => {
    async function writeDirect(content: unknown): Promise<string> {
      const file = path.join(tmp, 'direct.json');
      await fs.writeFile(file, JSON.stringify(content), 'utf8');
      return file;
    }

    async function writeCcr(content: unknown): Promise<void> {
      await fs.mkdir(path.join(tmp, '.claude'), { recursive: true });
      await fs.writeFile(
        path.join(tmp, '.claude', 'settings.json'),
        JSON.stringify(content),
        'utf8',
      );
    }

    it('direct 清单为空 + ccr 混着 claude-* 与非 claude-* → 只借用 claude-* 部分，defaultModel 用 direct 自己的', async () => {
      const directFile = await writeDirect({ model: 'claude-sonnet-5[1m]' });
      await writeCcr({
        model: 'deepseek-v4-flash',
        availableModels: ['claude-opus-4-8[1m]', 'deepseek-v4-pro', 'claude-sonnet-5[1m]', 'qwen3.7-max'],
      });

      const r = await readProfileConfig('direct', tmp, directFile);
      assert.deepStrictEqual(r.models, ['claude-opus-4-8[1m]', 'claude-sonnet-5[1m]']);
      assert.strictEqual(r.defaultModel, 'claude-sonnet-5[1m]');
    });

    it('direct 自己清单非空 → 不借用 ccr，原样返回 direct 的清单', async () => {
      const directFile = await writeDirect({
        model: 'claude-sonnet-5[1m]',
        availableModels: ['claude-opus-5'],
      });
      await writeCcr({
        model: 'deepseek-v4-flash',
        availableModels: ['claude-haiku-4-5-20251001', 'deepseek-v4-pro'],
      });

      const r = await readProfileConfig('direct', tmp, directFile);
      assert.deepStrictEqual(r.models, ['claude-opus-5']);
      assert.strictEqual(r.defaultModel, 'claude-sonnet-5[1m]');
    });

    it('direct 清单为空 + ccr 的 settings.json 不存在 → 返回空清单，不抛', async () => {
      const directFile = await writeDirect({ model: 'claude-sonnet-5[1m]' });
      // 不写 ccr 的 settings.json。

      const r = await readProfileConfig('direct', tmp, directFile);
      assert.deepStrictEqual(r.models, []);
      assert.strictEqual(r.defaultModel, 'claude-sonnet-5[1m]');
    });

    it('direct 清单为空 + ccr 存在但没有一个 claude-* 前缀 → 返回空清单', async () => {
      const directFile = await writeDirect({ model: 'claude-sonnet-5[1m]' });
      await writeCcr({
        model: 'deepseek-v4-flash',
        availableModels: ['deepseek-v4-pro', 'qwen3.7-max'],
      });

      const r = await readProfileConfig('direct', tmp, directFile);
      assert.deepStrictEqual(r.models, []);
      assert.strictEqual(r.defaultModel, 'claude-sonnet-5[1m]');
    });
  });
});
