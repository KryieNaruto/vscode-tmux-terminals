import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { LivenessSnapshot, liveSessionIn, readLiveness } from '../src/liveSessions';

/**
 * 用**临时 home** 造 `~/.claude/sessions/<pid>.json`，**绝不碰用户真实的
 * ~/.claude**（照 test/conversationFiles.test.ts 的 makeHome 写法）。
 */
async function makeHome(files: Record<string, string>): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxterm-live-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(home, '.claude', 'sessions', rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, text, 'utf8');
  }
  return home;
}

const rec = (pid: number, sessionId: string, startedAt: number, cwd = '/a') =>
  JSON.stringify({ pid, sessionId, startedAt, cwd, status: 'busy', name: 'x', nameSource: 'derived' });

describe('readLiveness', () => {
  const homes: string[] = [];
  const mk = async (files: Record<string, string>) => {
    const h = await makeHome(files);
    homes.push(h);
    return h;
  };
  after(async () => {
    for (const h of homes) await fs.rm(h, { recursive: true, force: true });
  });

  it('注册表按 pid 索引', async () => {
    const home = await mk({ '111.json': rec(111, 's1', 10), '222.json': rec(222, 's2', 20) });
    const snap = await readLiveness(home);
    assert.strictEqual(snap.sessions.size, 2);
    assert.strictEqual(snap.sessions.get(111)?.sessionId, 's1');
    assert.strictEqual(snap.sessions.get(222)?.sessionId, 's2');
  });

  it('注册表目录不存在 → 空 sessions，不抛', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxterm-live-none-'));
    homes.push(home);
    const snap = await readLiveness(home);
    assert.strictEqual(snap.sessions.size, 0);
  });

  it('损坏 / 不合规的文件被跳过，其余照常读到', async () => {
    const home = await mk({
      '111.json': rec(111, 's1', 10),
      '222.json': '{oooo',
      '333.json': rec(333, '   ', 10),
    });
    const snap = await readLiveness(home);
    assert.deepStrictEqual([...snap.sessions.keys()], [111]);
  });

  it('走的是真实 `ps`：进程表里至少解析得出本进程', async () => {
    const home = await mk({});
    const snap = await readLiveness(home);
    assert.ok(snap.procs.some((n) => n.pid === process.pid), '进程表里应有本进程');
    assert.ok(snap.procs.length > 0);
  });
});

describe('liveSessionIn —— 从快照解析某个 pane 下「最后用过的会话」', () => {
  const snap = (
    procs: Array<[number, number]>,
    sessions: Array<[number, string, number]>,
  ): LivenessSnapshot => ({
    procs: procs.map(([pid, ppid]) => ({ pid, ppid })),
    sessions: new Map(
      sessions.map(([pid, sessionId, startedAt]) => [pid, { pid, sessionId, startedAt, cwd: '/a' }]),
    ),
  });

  it('命中：pane_pid 的直接子进程在注册表里', () => {
    assert.strictEqual(liveSessionIn(snap([[100, 1], [200, 100]], [[200, 'sess', 10]]), 100)?.sessionId, 'sess');
  });

  it('多层后代也命中（pane_pid → shell → 更深的 claude）', () => {
    const s = snap([[100, 1], [150, 100], [200, 150]], [[200, 'sess', 10]]);
    assert.strictEqual(liveSessionIn(s, 100)?.sessionId, 'sess');
  });

  it('★ 同一 pane 下两个 claude → 取 startedAt 最新', () => {
    const s = snap([[100, 1], [200, 100], [201, 100]], [[200, '旧', 10], [201, '新', 20]]);
    assert.strictEqual(liveSessionIn(s, 100)?.sessionId, '新');
  });

  it('pane 无后代 → undefined', () => {
    assert.strictEqual(liveSessionIn(snap([[100, 1]], [[200, 'sess', 10]]), 100), undefined);
  });

  it('后代与注册表无交集 → undefined（解析不出就是解析不出，不猜）', () => {
    assert.strictEqual(liveSessionIn(snap([[100, 1], [200, 100]], [[999, 'sess', 10]]), 100), undefined);
  });

  it('pane_pid 不在进程表里 → undefined', () => {
    assert.strictEqual(liveSessionIn(snap([[200, 100]], [[200, 'sess', 10]]), 999), undefined);
  });
});
