import * as assert from 'assert';
import { isClaudeCommand, resumeFailed } from '../../src/core/claude';

describe('isClaudeCommand', () => {
  it('识别 claude 与 claude.exe', () => {
    assert.strictEqual(isClaudeCommand('claude'), true);
    assert.strictEqual(isClaudeCommand('claude.exe'), true);
  });

  it('识别带路径的形式', () => {
    assert.strictEqual(isClaudeCommand('/usr/bin/claude'), true);
    assert.strictEqual(isClaudeCommand('/usr/local/bin/claude-direct'), true);
  });

  it('允许前后空白（tmux 输出常带）', () => {
    assert.strictEqual(isClaudeCommand('  claude \n'), true);
  });

  it('★ 绝不把 node 当作 claude：用户的 build/test/dev server 大量是 node', () => {
    assert.strictEqual(isClaudeCommand('node'), false);
    assert.strictEqual(isClaudeCommand('/usr/bin/node'), false);
  });

  it('shell 与常见进程不算 claude', () => {
    for (const c of ['bash', 'zsh', 'sh', 'sleep', 'python3', 'vim', '']) {
      assert.strictEqual(isClaudeCommand(c), false, `${c} 不应判为 claude`);
    }
  });

  it('不因名字里含 claude 就误判（必须是最后一段以 claude 开头）', () => {
    assert.strictEqual(isClaudeCommand('/opt/myclaude-helper'), false);
    assert.strictEqual(isClaudeCommand('notclaude'), false);
  });
});

describe('resumeFailed —— 识别 `--resume` 没接上', () => {
  const ERR = 'No conversation found with session ID: 7af4c86a-ea5d-4f25-9d9c-8ba7e620a5a0';

  it('pane 末尾出现该报错 → true', () => {
    assert.strictEqual(resumeFailed(['$ claude --resume abc', ERR, '$ '].join('\n')), true);
  });

  it('大小写 / 前后空白不敏感', () => {
    assert.strictEqual(resumeFailed(`  no CONVERSATION found with session ID: x  `), true);
  });

  it('空 pane（capture-pane 读不到）→ false', () => {
    assert.strictEqual(resumeFailed(''), false);
    assert.strictEqual(resumeFailed('\n\n   \n'), false);
  });

  it('claude 正常启动时→ false', () => {
    assert.strictEqual(resumeFailed(['$ claude --resume abc', '╭─ Claude ─╮', '> '].join('\n')), false);
  });

  it('★ 只看末尾几行：更早的位置出现同样的字串不算（避免命中历史 scrollback / 用户自己的输出）', () => {
    const text = [
      ERR,                       // 很早以前的一行（例如用户 grep 过这句，或上一轮失败留下的）
      'line', 'line', 'line', 'line', 'line', 'line', 'line',
      '$ claude --resume abc',   // 这次其实起来了
      '╭─ Claude ─╮', '> ',
    ].join('\n');
    assert.strictEqual(resumeFailed(text), false);
  });

  it('报错正好落在倒数几行时仍能命中（报错后紧跟 shell 提示符）', () => {
    const text = ['$ claude --resume abc', ERR, '$ '].join('\n');
    assert.strictEqual(resumeFailed(text, 3), true);
  });
});
