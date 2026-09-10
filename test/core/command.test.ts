import * as assert from 'assert';
import { commandFor, conversationCommand } from '../../src/core/command';
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

describe('conversationCommand —— 条目 ↔ 对话绑定', () => {
  const ID = '7af4c86a-ea5d-4f25-9d9c-8ba7e620a5a0';

  it('new：首次启动时用 --session-id 开一条新对话并绑定到条目', () => {
    assert.strictEqual(
      conversationCommand(e(), { kind: 'new', conversationId: ID }),
      `claude --dangerously-skip-permissions --session-id '${ID}'`,
    );
  });

  it('★ resume：有绑定就必须 --resume 接回那条对话，绝不重开一条顶替', () => {
    assert.strictEqual(
      conversationCommand(e(), { kind: 'resume', conversationId: ID }),
      `claude --dangerously-skip-permissions --resume '${ID}'`,
    );
  });

  it('continue：未绑定的退路（接该 cwd 下最近一条）', () => {
    assert.strictEqual(
      conversationCommand(e(), { kind: 'continue' }),
      'claude --dangerously-skip-permissions --continue',
    );
  });

  it('profile 与 model 一并生效（direct + 模型 + resume）', () => {
    assert.strictEqual(
      conversationCommand(e({ profile: 'direct', model: 'claude-sonnet-5[1m]' }),
        { kind: 'resume', conversationId: ID }),
      `claude-direct --dangerously-skip-permissions --model 'claude-sonnet-5[1m]' --resume '${ID}'`,
    );
  });

  it('对话 id 必须经 shell 引用（清单被手改也可能带引号/分号）', () => {
    // 恶意 id 里的 `;` 一旦裸露，就会变成第二条 shell 命令
    const out = conversationCommand(e(), { kind: 'resume', conversationId: "x'; rm -rf /; echo '" });
    const expected = `claude --dangerously-skip-permissions --resume 'x'\\''; rm -rf /; echo '\\'''`;
    assert.strictEqual(out, expected);
  });
});
