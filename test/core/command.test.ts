import * as assert from 'assert';
import { commandFor, conversationCommand } from '../../src/core/command';
import { TerminalEntry } from '../../src/core/types';

function e(patch: Partial<TerminalEntry> = {}): TerminalEntry {
  return {
    id: 'abc123', name: 'n', cwd: '/tmp',
    profile: 'ccr', autoRestore: true, order: 0,
    // 夹具补 `sessions`：本文件验的是**命令派生**，与槽无关，给个合法空槽即可
    // （`[]` 是 v3 的合法状态）。断言一个字没动。
    sessions: [],
    ...patch,
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

  it('★ fresh：首启是裸 claude，既不带 --session-id 也不带 --resume', () => {
    const out = conversationCommand(e(), { kind: 'fresh' });
    assert.strictEqual(out, 'claude --dangerously-skip-permissions');
    assert.ok(!out.includes('--session-id'), `不该带 --session-id：${out}`);
    assert.ok(!out.includes('--resume'), `不该带 --resume：${out}`);
  });

  it('fresh 与 new/resume 共用同一套 profile/model 派生（direct + 模型）', () => {
    assert.strictEqual(
      conversationCommand(e({ profile: 'direct', model: 'claude-sonnet-5[1m]' }), { kind: 'fresh' }),
      `claude-direct --dangerously-skip-permissions --model 'claude-sonnet-5[1m]'`,
    );
  });

  it('fresh 逐字节等于 commandFor（除 profile/model 外没有第二个来源）', () => {
    // 边界：模型名需要 shell 引用时，fresh 也必须走同一条 shellQuote 路径 ——
    // 「不加后缀」不能顺手绕开引用（那是注入面）。
    const tricky = e({ profile: 'direct', model: "a b'c" });
    assert.strictEqual(conversationCommand(tricky, { kind: 'fresh' }), commandFor(tricky));
    assert.ok(conversationCommand(tricky, { kind: 'fresh' }).includes("'a b'\\''c'"));
  });

  it('★ resume：有绑定就必须 --resume 接回那条对话，绝不重开一条顶替', () => {
    assert.strictEqual(
      conversationCommand(e(), { kind: 'resume', conversationId: ID }),
      `claude --dangerously-skip-permissions --resume '${ID}'`,
    );
  });

  it('★ 不存在 continue 这条退路：共用 cwd 下会一起接到同一条最新对话上去', () => {
    // 规格已删掉该分支（类型层面也没有了）。这里以运行时兜底守住回归：
    // 一旦有人把 `--continue` 加回来，这条会失败。
    assert.throws(
      () => conversationCommand(e(), { kind: 'continue' } as never),
      /未知的 LaunchSpec/,
      '--continue 分支必须已从 conversationCommand 中删除',
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
