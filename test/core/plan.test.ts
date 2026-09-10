import * as assert from 'assert';
import { planRestore } from '../../src/core/plan';
import { TerminalEntry } from '../../src/core/types';

function e(model?: string): TerminalEntry {
  return {
    id: 'x', name: 'n', cwd: '/tmp', profile: 'ccr', model,
    autoRestore: true, order: 0,
  };
}

describe('planRestore', () => {
  it('会话存活 → attach 且命令必须为空（安全闸门）', () => {
    const p = planRestore(e('qwen3.7-max'), true);
    assert.strictEqual(p.mode, 'attach');
    assert.deepStrictEqual(p.commands, []);
  });

  it('会话不存在 → create 且命令来自 profile 派生', () => {
    const p = planRestore(e(), false);
    assert.strictEqual(p.mode, 'create');
    assert.deepStrictEqual(p.commands, ['claude --dangerously-skip-permissions']);
  });
});
