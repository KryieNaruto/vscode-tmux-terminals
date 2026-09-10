import * as assert from 'assert';
import { parseAvailableModels, parseDefaultModel } from '../../src/core/models';

const real = JSON.stringify({
  env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3460' },
  model: 'deepseek-v4-flash',
  availableModels: ['claude-opus-4-8[1m]', 'deepseek-v4-pro', 'qwen3.7-max'],
});

describe('parseAvailableModels', () => {
  it('读出清单', () => {
    assert.deepStrictEqual(parseAvailableModels(real), ['claude-opus-4-8[1m]', 'deepseek-v4-pro', 'qwen3.7-max']);
  });

  it('没有该字段 → 空数组', () => {
    assert.deepStrictEqual(parseAvailableModels('{}'), []);
  });

  it('坏 JSON / 非字符串项 → 宽容处理，不抛', () => {
    assert.deepStrictEqual(parseAvailableModels('{oops'), []);
    assert.deepStrictEqual(parseAvailableModels('{"availableModels":[1,"a",null]}'), ['a']);
  });
});

describe('parseDefaultModel', () => {
  it('读出默认模型', () => {
    assert.strictEqual(parseDefaultModel(real), 'deepseek-v4-flash');
  });

  it('缺失或非字符串 → undefined', () => {
    assert.strictEqual(parseDefaultModel('{}'), undefined);
    assert.strictEqual(parseDefaultModel('{"model":42}'), undefined);
    assert.strictEqual(parseDefaultModel('{oops'), undefined);
  });
});
