import * as assert from 'assert';
import { commandFor } from '../../src/core/command';
import { TerminalEntry } from '../../src/core/types';

function e(patch: Partial<TerminalEntry> = {}): TerminalEntry {
  return {
    id: 'abc123', name: 'n', cwd: '/tmp',
    profile: 'ccr', autoRestore: true, order: 0, ...patch,
  };
}

describe('commandFor', () => {
  it('ccr profile 用 claude', () => {
    assert.strictEqual(commandFor(e({ profile: 'ccr' })), 'claude --dangerously-skip-permissions');
  });

  it('direct profile 用 claude-direct', () => {
    assert.strictEqual(commandFor(e({ profile: 'direct' })), 'claude-direct --dangerously-skip-permissions');
  });

  it('指定模型时带 --model', () => {
    assert.strictEqual(
      commandFor(e({ profile: 'direct', model: 'claude-sonnet-5[1m]' })),
      'claude-direct --dangerously-skip-permissions --model \'claude-sonnet-5[1m]\'',
    );
  });

  it('模型名含空格与引号时仍安全（必须经 shell 引用）', () => {
    const out = commandFor(e({ model: "a b'c" }));
    assert.ok(out.includes(`'a b'\\''c'`), `实际：${out}`);
  });

  it('空字符串模型视为未指定', () => {
    assert.strictEqual(commandFor(e({ model: '' })), 'claude --dangerously-skip-permissions');
  });
});
