import * as assert from 'assert';
import { ActivityTracker, PaneTitleReader } from '../src/activityTracker';

function fakeTmux(titles: Record<string, string>): PaneTitleReader {
  return {
    async paneTitle(session: string): Promise<string> {
      return titles[session] ?? '';
    },
  };
}

describe('ActivityTracker.poll', () => {
  it('无存活条目时不调用 paneTitle，仍触发一次变化通知', async () => {
    let calls = 0;
    const tmux: PaneTitleReader = { async paneTitle() { calls++; return ''; } };
    const tracker = new ActivityTracker(tmux);
    let fired = 0;
    tracker.onDidChange(() => fired++);
    await tracker.poll([]);
    assert.strictEqual(calls, 0);
    assert.strictEqual(fired, 1);
  });

  it('首次轮询：运行中的会话状态为 running，任务名解析正确', async () => {
    const tmux = fakeTmux({ 'tmuxterm-a': '⠐ 编译内核' });
    const tracker = new ActivityTracker(tmux);
    await tracker.poll(['a']);
    assert.deepStrictEqual(tracker.activityFor('a'), { state: 'running', taskName: '编译内核' });
  });

  it('首次轮询：空闲会话状态为 idle（不能是 done-unseen）', async () => {
    const tmux = fakeTmux({ 'tmuxterm-a': '✳ Claude Code' });
    const tracker = new ActivityTracker(tmux);
    await tracker.poll(['a']);
    assert.deepStrictEqual(tracker.activityFor('a'), { state: 'idle', taskName: '' });
  });

  it('运行中 → 停止运行：下一次 poll 后变成 done-unseen', async () => {
    const titles: Record<string, string> = { 'tmuxterm-a': '⠐ 编译内核' };
    const tmux = fakeTmux(titles);
    const tracker = new ActivityTracker(tmux);
    await tracker.poll(['a']);
    titles['tmuxterm-a'] = '✳ 编译内核';
    await tracker.poll(['a']);
    assert.deepStrictEqual(tracker.activityFor('a'), { state: 'done-unseen', taskName: '编译内核' });
  });

  it('会话消失后状态被清空；重新出现按首次观测处理（不是 done-unseen）', async () => {
    const titles: Record<string, string> = { 'tmuxterm-a': '⠐ 编译内核' };
    const tmux = fakeTmux(titles);
    const tracker = new ActivityTracker(tmux);
    await tracker.poll(['a']);
    await tracker.poll([]); // 会话消失
    assert.strictEqual(tracker.activityFor('a'), undefined);
    titles['tmuxterm-a'] = '✳ 编译内核';
    await tracker.poll(['a']); // 重新出现，且此刻已是空闲
    assert.deepStrictEqual(tracker.activityFor('a'), { state: 'idle', taskName: '编译内核' });
  });

  it('每次 poll 都触发一次变化通知', async () => {
    const tmux = fakeTmux({ 'tmuxterm-a': '✳ Claude Code' });
    const tracker = new ActivityTracker(tmux);
    let fired = 0;
    tracker.onDidChange(() => fired++);
    await tracker.poll(['a']);
    await tracker.poll(['a']);
    assert.strictEqual(fired, 2);
  });
});

describe('ActivityTracker.blinkOn', () => {
  it('running 态随每次 poll 在 true/false 之间切换', async () => {
    const tmux = fakeTmux({ 'tmuxterm-a': '⠐ 任务' });
    const tracker = new ActivityTracker(tmux);
    await tracker.poll(['a']);
    const first = tracker.blinkOn('a');
    await tracker.poll(['a']);
    const second = tracker.blinkOn('a');
    assert.notStrictEqual(first, second);
  });
  it('非 running 态恒为 true（不闪）', async () => {
    const tmux = fakeTmux({ 'tmuxterm-a': '✳ Claude Code' });
    const tracker = new ActivityTracker(tmux);
    await tracker.poll(['a']);
    assert.strictEqual(tracker.blinkOn('a'), true);
    await tracker.poll(['a']);
    assert.strictEqual(tracker.blinkOn('a'), true);
  });
  it('未知条目恒为 true', () => {
    const tracker = new ActivityTracker(fakeTmux({}));
    assert.strictEqual(tracker.blinkOn('unknown'), true);
  });
});

describe('ActivityTracker.markSeen', () => {
  it('done-unseen → idle，并触发一次变化通知', async () => {
    const titles: Record<string, string> = { 'tmuxterm-a': '⠐ 任务' };
    const tmux = fakeTmux(titles);
    const tracker = new ActivityTracker(tmux);
    await tracker.poll(['a']);
    titles['tmuxterm-a'] = '✳ 任务';
    await tracker.poll(['a']);
    assert.strictEqual(tracker.activityFor('a')?.state, 'done-unseen');

    let fired = 0;
    tracker.onDidChange(() => fired++);
    tracker.markSeen('a');
    assert.strictEqual(tracker.activityFor('a')?.state, 'idle');
    assert.strictEqual(fired, 1);
  });
  it('非 done-unseen 状态调用 markSeen 是 no-op，不触发通知', async () => {
    const tmux = fakeTmux({ 'tmuxterm-a': '⠐ 任务' });
    const tracker = new ActivityTracker(tmux);
    await tracker.poll(['a']);
    let fired = 0;
    tracker.onDidChange(() => fired++);
    tracker.markSeen('a');
    assert.strictEqual(fired, 0);
  });
  it('未知条目调用 markSeen 是 no-op，不抛异常', () => {
    const tracker = new ActivityTracker(fakeTmux({}));
    assert.doesNotThrow(() => tracker.markSeen('unknown'));
  });
});
