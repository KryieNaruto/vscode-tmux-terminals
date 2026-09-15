import * as assert from 'assert';
import { ActivityTracker, PaneSampleReader } from '../src/activityTracker';
import { PaneSample } from '../src/core/tmux';

/**
 * 只给标题的假 reader：前台固定是 `claude`。
 *
 * 现有用例考的是「标题 → 任务名」这条链本身，所以把前台钉成 claude，
 * 让闸门（前台不是 claude ⇒ 空任务名）不参与这些断言。闸门自己的用例
 * 用下面的 fakeSampler 显式给前台进程名。
 */
function fakeTmux(titles: Record<string, string>): PaneSampleReader {
  return {
    async paneSample(session: string): Promise<PaneSample> {
      return { foreground: 'claude', title: titles[session] ?? '' };
    },
  };
}

/** 显式给两个字段的假 reader（闸门用例用）。 */
function fakeSampler(samples: Record<string, PaneSample>): PaneSampleReader {
  return {
    async paneSample(session: string): Promise<PaneSample> {
      return samples[session] ?? { foreground: '', title: '' };
    },
  };
}

describe('ActivityTracker.poll', () => {
  it('无存活条目时不调用 paneSample，仍触发一次变化通知', async () => {
    let calls = 0;
    const tmux: PaneSampleReader = {
      async paneSample() { calls++; return { foreground: '', title: '' }; },
    };
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

describe('ActivityTracker.poll：pane title 闸门（前台不是 claude 就不采信）', () => {
  it('★ 前台是 shell + 提示符形状的标题 → 任务名为空串（改前是提示符原文）', async () => {
    // 本任务的核心断言。claude 退出后 pane 前台变回 bash，标题成了
    // `qiansenwei@H:~/workspace`：改前 taskNameFromTitle 原样保留它，
    // 于是三级显示提示符、aiTitle 回退永远轮不到；闸门把它压成空串，
    // 回退链（tree.ts 的 taskNameFor）才能接手。
    const tracker = new ActivityTracker(fakeSampler({
      'tmuxterm-a': { foreground: 'bash', title: 'qiansenwei@H:~/workspace' },
    }));
    await tracker.poll(['a']);
    assert.deepStrictEqual(tracker.activityFor('a'), { state: 'idle', taskName: '' });
  });

  it('★ 非 claude 前台的取值不止 bash：-bash / sh / nvim 同样不采信', async () => {
    const tracker = new ActivityTracker(fakeSampler({
      'tmuxterm-a': { foreground: '-bash', title: 'qiansenwei@H:~/workspace' },
      'tmuxterm-b': { foreground: 'sh', title: 'qiansenwei@H:~/workspace' },
      'tmuxterm-c': { foreground: 'nvim', title: 'qiansenwei@H:~/workspace' },
    }));
    await tracker.poll(['a', 'b', 'c']);
    for (const id of ['a', 'b', 'c']) {
      assert.strictEqual(tracker.activityFor(id)?.taskName, '', `条目 ${id} 不该有任务名`);
    }
  });

  it('前台是 claude 时照旧采信标题（含剥掉 ⠐ 指示符）', async () => {
    const tracker = new ActivityTracker(fakeSampler({
      'tmuxterm-a': { foreground: 'claude', title: '⠐ 创建多引擎版 /ask 命令并统一' },
    }));
    await tracker.poll(['a']);
    assert.deepStrictEqual(tracker.activityFor('a'),
      { state: 'running', taskName: '创建多引擎版 /ask 命令并统一' });
  });

  it('未知前台（空串）即便标题像任务名也不采信', async () => {
    const tracker = new ActivityTracker(fakeSampler({
      'tmuxterm-a': { foreground: '', title: '创建多引擎版 /ask 命令并统一' },
    }));
    await tracker.poll(['a']);
    assert.strictEqual(tracker.activityFor('a')?.taskName, '');
  });

  it('★ 每个条目每轮只采样一次（采样循环每 ≈900ms 跑一轮，翻倍是成倍开销）', async () => {
    let calls = 0;
    const reader: PaneSampleReader = {
      async paneSample() {
        calls++;
        return { foreground: 'claude', title: '⠐ 任务' };
      },
    };
    const tracker = new ActivityTracker(reader);
    await tracker.poll(['a', 'b', 'c']);
    assert.strictEqual(calls, 3, '3 个存活条目应正好 3 次采样调用');
    calls = 0;
    await tracker.poll(['a', 'b', 'c']);
    assert.strictEqual(calls, 3);
  });
});
