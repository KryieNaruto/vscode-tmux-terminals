import * as assert from 'assert';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { TmuxClient } from '../src/tmuxClient';

const run = promisify(execFile);
const client = new TmuxClient('tmux');
const A = 'tmuxterm-aaaa1111';
const B = 'tmuxterm-aaaa1111bbbb'; // 用来验证 A 不会前缀匹配到 B
const HELPER = 'tmuxterm-aaaahelp1'; // 借它的 pane 提供 pty，好让 tmux attach 跑起来

async function cleanup() {
  for (const n of [A, B, HELPER]) {
    try { await run('tmux', ['kill-session', '-t', `=${n}`]); } catch { /* 不存在就算了 */ }
  }
}

describe('TmuxClient（集成，需要本机有 tmux）', function () {
  this.timeout(20000);

  // 每个用例前清场。
  //
  // 原计划只有套件级的 before/after，多个用例各自 `tmux new-session -s A`
  // 却不清理，于是第二个建 A 的用例会撞上 `duplicate session` 而失败
  // （实测 9 个用例挂掉，含最关键的「前缀不误杀」回归项）。
  // 每个用例必须自己从干净状态出发，不能依赖前一个用例的遗留。
  beforeEach(async () => {
    await cleanup();
  });

  after(async () => {
    await cleanup();
  });

  it('无会话时 listSessions 返回数组且不含临时会话', async () => {
    const list = await client.listSessions();
    assert.ok(Array.isArray(list));
    assert.ok(!list.includes(A));
  });

  it('hasSession 对不存在的会话返回 false', async () => {
    assert.strictEqual(await client.hasSession(A), false);
  });

  it('建会话后 hasSession 返回 true，listSessions 能列出', async () => {
    await run('tmux', ['new-session', '-d', '-s', A]);
    assert.strictEqual(await client.hasSession(A), true);
    assert.ok((await client.listSessions()).includes(A));
  });

  it('关键：hasSession 不做前缀匹配（A 存在时 A+后缀 仍为 false）', async () => {
    await run('tmux', ['new-session', '-d', '-s', A]);
    assert.strictEqual(await client.hasSession(B), false);
  });

  it('newSession 成功建会话并返回 true', async () => {
    assert.strictEqual(await client.newSession(A, '/tmp'), true);
    assert.strictEqual(await client.hasSession(A), true);
  });

  it('newSession 在会话已存在时返回 false（不抛错，供竞态判断用）', async () => {
    await run('tmux', ['new-session', '-d', '-s', A]);
    assert.strictEqual(await client.newSession(A, '/tmp'), false);
  });

  it('newSession 的 cwd 生效（新会话默认目录为指定路径）', async () => {
    await client.newSession(A, '/tmp');
    await client.waitForShell(A, 3000);
    const { stdout } = await run('tmux', ['display-message', '-p', '-t', `=${A}:`, '#{pane_current_path}']);
    // /tmp 可能是符号链接，用 realpath 比对
    const real = await import('fs/promises').then((f) => f.realpath('/tmp'));
    assert.strictEqual(stdout.trim(), real);
  });

  it('currentCommand 对就绪会话返回 bash（验证 pane 目标带冒号）', async () => {
    await run('tmux', ['new-session', '-d', '-s', A]);
    const cmd = await client.currentCommand(A);
    assert.notStrictEqual(cmd.trim(), '', '返回空说明 pane 目标写错了');
    assert.strictEqual(cmd.trim(), 'bash');
  });

  it('waitForShell 对就绪会话返回 true', async () => {
    await run('tmux', ['new-session', '-d', '-s', A]);
    assert.strictEqual(await client.waitForShell(A, 3000), true);
  });

  it('waitForShell 对不存在的会话在超时后返回 false', async () => {
    const t0 = Date.now();
    assert.strictEqual(await client.waitForShell('tmuxterm-deadbeef', 600), false);
    assert.ok(Date.now() - t0 >= 500, '应真的等到超时');
  });

  it('sendLiteral + sendEnter 能把命令送进会话并执行', async () => {
    await run('tmux', ['new-session', '-d', '-s', A]);
    assert.strictEqual(await client.waitForShell(A, 3000), true);
    await client.sendLiteral(A, 'echo SENTINEL_XYZ');
    await client.sendEnter(A);
    await new Promise((r) => setTimeout(r, 400));
    const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', `=${A}:`]);
    assert.ok(stdout.includes('SENTINEL_XYZ'), `会话里没看到命令输出:\n${stdout}`);
  });

  it('sendLiteral 是字面量模式，特殊字符不被 shell 之外的层解释', async () => {
    await run('tmux', ['new-session', '-d', '-s', A]);
    assert.strictEqual(await client.waitForShell(A, 3000), true);
    await client.sendLiteral(A, 'echo "quoted $HOME"');
    await client.sendEnter(A);
    await new Promise((r) => setTimeout(r, 400));
    const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', `=${A}:`]);
    assert.ok(stdout.includes('quoted'), `字面量发送失败:\n${stdout}`);
  });

  it('killSession 删掉会话，且不误杀前缀相同的另一个会话', async () => {
    await run('tmux', ['new-session', '-d', '-s', A]);
    await run('tmux', ['new-session', '-d', '-s', B]);
    await client.killSession(A);
    assert.strictEqual(await client.hasSession(A), false);
    assert.strictEqual(await client.hasSession(B), true, '前缀相同的会话被误杀了');
  });
  it('killSession 对不存在的会话不抛错', async () => {
    await client.killSession('tmuxterm-cafebabe');
  });

  describe('attachedClients —— 「用户此刻看得见这个会话吗」的权威信号', () => {
    it('detached 建出的会话附着数为 0', async () => {
      await client.newSession(A, '/tmp');
      assert.strictEqual(await client.attachedClients(A), 0);
    });

    it('有客户端附着时返回 >= 1', async () => {
      await client.newSession(A, '/tmp');
      assert.strictEqual(await client.attachedClients(A), 0);
      // `tmux attach` 需要 pty；借另一个 tmux 会话的 pane 提供一个
      // （`unset TMUX` 才允许嵌套）。杀 helper 即摘掉这个客户端。
      await run('tmux', ['new-session', '-d', '-s', HELPER,
        `unset TMUX; exec tmux attach -t =${A}`]);
      await new Promise((r) => setTimeout(r, 900));
      const n = await client.attachedClients(A);
      assert.ok(n !== null && n >= 1, `附着数应 >= 1，实际 ${n}`);
      await run('tmux', ['kill-session', '-t', `=${HELPER}`]);
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(await client.attachedClients(A), 0, '摘掉客户端后应回到 0');
    });

    it('关键：会话不存在时返回 null（未知），不能是 0', async () => {
      // display-message 的 pane 目标漏冒号时 tmux 是 exit 0 + 空输出，
      // 静默失败。把「读不到」与「没人附着」混为一谈会让调用方在两种
      // 完全不同的处境下做同一个决定。
      assert.strictEqual(await client.attachedClients('tmuxterm-cafebabe'), null);
    });
  });
});
