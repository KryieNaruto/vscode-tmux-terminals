import * as assert from 'assert';
import { ActivityTracker, PaneSampleReader } from '../src/activityTracker';
import { PaneSample } from '../src/core/tmux';

/**
 * 本文件里的 id **一律是会话槽 id**，不是条目 id。
 *
 * 采样层把 id 原样喂给 `sessionNameFor(id)` 去派生 tmux 会话名，而 v3 的
 * 会话名由**槽** id 派生（一个终端挂 N 个槽 = N 个 tmux 会话）。所以
 * `poll()` 的入参只能是槽 id —— 传条目 id 的后果是「同一终端下只有第 1 个
 * 槽恰好对上，第 2 个起的会话永远没有运行图标」，静默、无报错。
 * 下面的常量名刻意带上 slot/终端归属，让这条约束在测试里也看得见。
 */
const SLOT_A1 = 'a1'; // 终端 ENT 的第 1 个槽
const SLOT_B1 = 'b1'; // 另一个终端的第 1 个槽
const SLOT_ENT2 = 'ent2'; // 终端 ENT 的第 2 个槽

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
  it('无存活条目时不调用 paneSample，也不触发变化通知', async () => {
    let calls = 0;
    const tmux: PaneSampleReader = {
      async paneSample() { calls++; return { foreground: '', title: '' }; },
    };
    const tracker = new ActivityTracker(tmux);
    let fired = 0;
    tracker.onDidChange(() => fired++);
    await tracker.poll([]);
    assert.strictEqual(calls, 0);
    assert.strictEqual(fired, 0, '状态表本来就是空的，这一轮什么都没变');
  });

  it('首次轮询：运行中的会话状态为 running，任务名解析正确', async () => {
    const tmux = fakeTmux({ 'tmuxterm-a1': '⠐ 编译内核' });
    const tracker = new ActivityTracker(tmux);
    await tracker.poll([SLOT_A1]);
    assert.deepStrictEqual(tracker.activityFor(SLOT_A1), { state: 'running', taskName: '编译内核' });
  });

  it('首次轮询：空闲会话状态为 idle（不能是 done-unseen）', async () => {
    const tmux = fakeTmux({ 'tmuxterm-a1': '✳ Claude Code' });
    const tracker = new ActivityTracker(tmux);
    await tracker.poll([SLOT_A1]);
    assert.deepStrictEqual(tracker.activityFor(SLOT_A1), { state: 'idle', taskName: '' });
  });

  it('运行中 → 停止运行：下一次 poll 后变成 done-unseen', async () => {
    const titles: Record<string, string> = { 'tmuxterm-a1': '⠐ 编译内核' };
    const tmux = fakeTmux(titles);
    const tracker = new ActivityTracker(tmux);
    await tracker.poll([SLOT_A1]);
    titles['tmuxterm-a1'] = '✳ 编译内核';
    await tracker.poll([SLOT_A1]);
    assert.deepStrictEqual(tracker.activityFor(SLOT_A1), { state: 'done-unseen', taskName: '编译内核' });
  });

  it('会话消失后状态被清空；重新出现按首次观测处理（不是 done-unseen）', async () => {
    const titles: Record<string, string> = { 'tmuxterm-a1': '⠐ 编译内核' };
    const tmux = fakeTmux(titles);
    const tracker = new ActivityTracker(tmux);
    await tracker.poll([SLOT_A1]);
    await tracker.poll([]); // 会话消失
    assert.strictEqual(tracker.activityFor(SLOT_A1), undefined);
    titles['tmuxterm-a1'] = '✳ 编译内核';
    await tracker.poll([SLOT_A1]); // 重新出现，且此刻已是空闲
    assert.deepStrictEqual(tracker.activityFor(SLOT_A1), { state: 'idle', taskName: '编译内核' });
  });

  it('首次 poll 触发通知；状态与任务名都没变时不再触发', async () => {
    const tmux = fakeTmux({ 'tmuxterm-a1': '✳ Claude Code' });
    const tracker = new ActivityTracker(tmux);
    let fired = 0;
    tracker.onDidChange(() => fired++);
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(fired, 1, '首次观测到条目的 current 状态，算一次变化');
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(fired, 1, '两轮采样值完全相同，`state`/`taskName` 都没变');
  });

  it('同一批 id 连 poll 多轮、采样值不变：只在第一轮通知一次', async () => {
    const tmux = fakeTmux({ 'tmuxterm-a1': '⠐ 编译内核', 'tmuxterm-b1': '✳ Claude Code' });
    const tracker = new ActivityTracker(tmux);
    let fired = 0;
    tracker.onDidChange(() => fired++);
    await tracker.poll([SLOT_A1, SLOT_B1]);
    await tracker.poll([SLOT_A1, SLOT_B1]);
    await tracker.poll([SLOT_A1, SLOT_B1]);
    assert.strictEqual(fired, 1, '后两轮 a1 仍是 running、b1 仍是 idle，零变化');
  });

  it('state 不变但 taskName 变了 → 恰好通知一次', async () => {
    const titles: Record<string, string> = { 'tmuxterm-a1': '✳ Claude Code' };
    const tmux = fakeTmux(titles);
    const tracker = new ActivityTracker(tmux);
    await tracker.poll([SLOT_A1]);
    assert.deepStrictEqual(tracker.activityFor(SLOT_A1), { state: 'idle', taskName: '' });

    let fired = 0;
    tracker.onDidChange(() => fired++);
    titles['tmuxterm-a1'] = '✳ 编译内核'; // 仍是空闲（✳ 不是运行指示符），但任务名不同
    await tracker.poll([SLOT_A1]);
    assert.deepStrictEqual(tracker.activityFor(SLOT_A1), { state: 'idle', taskName: '编译内核' });
    assert.strictEqual(fired, 1, 'state 没变、taskName 变了，也是一次变化');

    await tracker.poll([SLOT_A1]);
    assert.strictEqual(fired, 1, '再轮一轮完全没变，不该再通知');
  });

  it('条目从存活变为不存活：移出状态表时通知一次，其后不再通知', async () => {
    const tmux = fakeTmux({ 'tmuxterm-a1': '⠐ 编译内核', 'tmuxterm-b1': '⠐ 编译内核' });
    const tracker = new ActivityTracker(tmux);
    await tracker.poll([SLOT_A1, SLOT_B1]);

    let fired = 0;
    tracker.onDidChange(() => fired++);
    await tracker.poll([SLOT_B1]); // a1 不再存活 → 从状态表里删掉
    assert.strictEqual(tracker.activityFor(SLOT_A1), undefined);
    assert.strictEqual(fired, 1, '删掉一个条目算一次变化');

    await tracker.poll([SLOT_B1]); // b1 的状态与任务名都没变
    assert.strictEqual(fired, 1, '这一轮什么都没变，不该通知');
  });

  it('★ 同一个终端下的两个槽各自独立采样、各自独立的状态与任务名', async () => {
    // 这是多会话（v3）最核心的一条：一个终端挂 2 个槽 = 2 个 tmux 会话，
    // 它们的状态必须分开记。若采样层用**条目 id** 当键（键相同），第二个槽
    // 会把第一个槽的状态覆盖掉 —— 表现是树上两个会话行显示同一个图标，
    // 而其中一个真的在跑、另一个早停了，且没有任何报错。
    const titles: Record<string, string> = {
      'tmuxterm-a1': '⠐ 跑第一个任务',
      'tmuxterm-ent2': '✳ 第二个任务已停下',
    };
    const tmux = fakeTmux(titles);
    const tracker = new ActivityTracker(tmux);
    await tracker.poll([SLOT_A1, SLOT_ENT2]);

    assert.deepStrictEqual(tracker.activityFor(SLOT_A1),
      { state: 'running', taskName: '跑第一个任务' });
    assert.deepStrictEqual(tracker.activityFor(SLOT_ENT2),
      { state: 'idle', taskName: '第二个任务已停下' });

    // 第一个槽停止运行 → 只有它变成 done-unseen，第二个槽纹丝不动
    titles['tmuxterm-a1'] = '✳ 第一个任务';
    await tracker.poll([SLOT_A1, SLOT_ENT2]);
    assert.deepStrictEqual(tracker.activityFor(SLOT_A1),
      { state: 'done-unseen', taskName: '第一个任务' },
      '第一个槽停止运行 → done-unseen');
    assert.deepStrictEqual(tracker.activityFor(SLOT_ENT2),
      { state: 'idle', taskName: '第二个任务已停下' },
      '第二个槽没有重新开始运行，不该跟着变');

    // 只杀第一个槽：它的状态被清掉，第二个槽保留
    await tracker.poll([SLOT_ENT2]);
    assert.strictEqual(tracker.activityFor(SLOT_A1), undefined);
    assert.deepStrictEqual(tracker.activityFor(SLOT_ENT2),
      { state: 'idle', taskName: '第二个任务已停下' });
  });

  it('★ 同终端的两个槽各自独立 markSeen（一个点开不影响另一个）', async () => {
    const titles: Record<string, string> = {
      'tmuxterm-a1': '⠐ 甲',
      'tmuxterm-ent2': '⠐ 乙',
    };
    const tmux = fakeTmux(titles);
    const tracker = new ActivityTracker(tmux);
    await tracker.poll([SLOT_A1, SLOT_ENT2]);
    titles['tmuxterm-a1'] = '✳ 甲';
    titles['tmuxterm-ent2'] = '✳ 乙';
    await tracker.poll([SLOT_A1, SLOT_ENT2]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'done-unseen');
    assert.strictEqual(tracker.activityFor(SLOT_ENT2)?.state, 'done-unseen');

    tracker.markSeen(SLOT_A1);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle');
    assert.strictEqual(tracker.activityFor(SLOT_ENT2)?.state, 'done-unseen',
      '点开第一个槽不该把第二个槽的「刚完成」标记也清掉');
  });
});

describe('ActivityTracker.markSeen', () => {
  it('done-unseen → idle，并触发一次变化通知', async () => {
    const titles: Record<string, string> = { 'tmuxterm-a1': '⠐ 任务' };
    const tmux = fakeTmux(titles);
    const tracker = new ActivityTracker(tmux);
    await tracker.poll([SLOT_A1]);
    titles['tmuxterm-a1'] = '✳ 任务';
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'done-unseen');

    let fired = 0;
    tracker.onDidChange(() => fired++);
    tracker.markSeen(SLOT_A1);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle');
    assert.strictEqual(fired, 1);
  });
  it('非 done-unseen 状态调用 markSeen 是 no-op，不触发通知', async () => {
    const tmux = fakeTmux({ 'tmuxterm-a1': '⠐ 任务' });
    const tracker = new ActivityTracker(tmux);
    await tracker.poll([SLOT_A1]);
    let fired = 0;
    tracker.onDidChange(() => fired++);
    tracker.markSeen(SLOT_A1);
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
      'tmuxterm-a1': { foreground: 'bash', title: 'qiansenwei@H:~/workspace' },
    }));
    await tracker.poll([SLOT_A1]);
    assert.deepStrictEqual(tracker.activityFor(SLOT_A1), { state: 'idle', taskName: '' });
  });

  it('★ 非 claude 前台的取值不止 bash：-bash / sh / nvim 同样不采信', async () => {
    const tracker = new ActivityTracker(fakeSampler({
      'tmuxterm-a1': { foreground: '-bash', title: 'qiansenwei@H:~/workspace' },
      'tmuxterm-b1': { foreground: 'sh', title: 'qiansenwei@H:~/workspace' },
      'tmuxterm-c1': { foreground: 'nvim', title: 'qiansenwei@H:~/workspace' },
    }));
    await tracker.poll(['a1', 'b1', 'c1']);
    for (const id of ['a1', 'b1', 'c1']) {
      assert.strictEqual(tracker.activityFor(id)?.taskName, '', `会话槽 ${id} 不该有任务名`);
    }
  });

  it('前台是 claude 时照旧采信标题（含剥掉 ⠐ 指示符）', async () => {
    const tracker = new ActivityTracker(fakeSampler({
      'tmuxterm-a1': { foreground: 'claude', title: '⠐ 创建多引擎版 /ask 命令并统一' },
    }));
    await tracker.poll([SLOT_A1]);
    assert.deepStrictEqual(tracker.activityFor(SLOT_A1),
      { state: 'running', taskName: '创建多引擎版 /ask 命令并统一' });
  });

  it('未知前台（空串）即便标题像任务名也不采信', async () => {
    const tracker = new ActivityTracker(fakeSampler({
      'tmuxterm-a1': { foreground: '', title: '创建多引擎版 /ask 命令并统一' },
    }));
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.taskName, '');
  });

  it('★ 每个槽每轮只采样一次（采样循环每 ≈900ms 跑一轮，翻倍是成倍开销）', async () => {
    let calls = 0;
    const reader: PaneSampleReader = {
      async paneSample() {
        calls++;
        return { foreground: 'claude', title: '⠐ 任务' };
      },
    };
    const tracker = new ActivityTracker(reader);
    await tracker.poll(['a1', 'b1', 'c1']);
    assert.strictEqual(calls, 3, '3 个存活会话槽应正好 3 次采样调用');
    calls = 0;
    await tracker.poll(['a1', 'b1', 'c1']);
    assert.strictEqual(calls, 3);
  });
});
