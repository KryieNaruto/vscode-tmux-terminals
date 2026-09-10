import * as assert from 'assert';
import { isClaudeCommand } from '../../src/core/claude';

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
