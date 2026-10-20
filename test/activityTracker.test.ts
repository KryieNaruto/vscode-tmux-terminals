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
 * 采样里的 pane 尺寸。绝大多数用例尺寸恒定不变（不触发 resize 静默期），
 * 语义与加尺寸字段之前完全一致；resize 用例自己另给尺寸。
 */
const GEOM = { width: 231, height: 72, cursorY: 5 };

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
      return { foreground: 'claude', title: titles[session] ?? '', ...GEOM };
    },
    // 标题用例不关心内容：恒定空串 ⇒ 内容差分恒判「没变」，running 只由 title 决定。
    async capturePane(): Promise<string> {
      return '';
    },
  };
}

/** 显式给前台/标题的假 reader（闸门用例用）；尺寸恒定 GEOM。 */
function fakeSampler(samples: Record<string, PaneSample>): PaneSampleReader {
  return {
    async paneSample(session: string): Promise<PaneSample> {
      return samples[session] ?? { foreground: '', title: '', ...GEOM };
    },
    // 同上：内容恒定，差分不参与这些用例。
    async capturePane(): Promise<string> {
      return '';
    },
  };
}

/**
 * 只给 pane **内容**的假 reader：默认 foreground=claude、title 恒为空、尺寸/光标取 GEOM。
 *
 * 专门考「内容差分」这条新判据 —— 新版本 claude 的 pane title 首字符恒为 ✳
 * （Braille 零命中，见 core/tmux.ts 的 isRunningTitle），title 什么都说明不了，
 * 所以这里把它钉成空串，让 running 只能由内容变化推出来。
 *
 * `sample` 可选覆盖整个采样（缺省即 claude + GEOM 的等价形态）：「打字不算活动」
 * 那组用例要单独控制 cursorY / foreground，直接传一个自定义 sample 即可。
 */
function contentReader(
  contents: Record<string, string>,
  sample: PaneSample = { foreground: 'claude', title: '', ...GEOM },
): PaneSampleReader {
  return {
    async paneSample(): Promise<PaneSample> {
      return sample;
    },
    async capturePane(session: string): Promise<string> {
      return contents[session] ?? '';
    },
  };
}

describe('ActivityTracker.poll', () => {
  it('无存活条目时不调用 paneSample，也不触发变化通知', async () => {
    let calls = 0;
    const tmux: PaneSampleReader = {
      async paneSample() { calls++; return { foreground: '', title: '', ...GEOM }; },
      async capturePane() { calls++; return ''; },
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
    // `<username>@H:~/workspace`：改前 taskNameFromTitle 原样保留它，
    // 于是三级显示提示符、aiTitle 回退永远轮不到；闸门把它压成空串，
    // 回退链（tree.ts 的 taskNameFor）才能接手。
    const tracker = new ActivityTracker(fakeSampler({
      'tmuxterm-a1': { foreground: 'bash', title: '<username>@H:~/workspace', ...GEOM },
    }));
    await tracker.poll([SLOT_A1]);
    assert.deepStrictEqual(tracker.activityFor(SLOT_A1), { state: 'idle', taskName: '' });
  });

  it('★ 非 claude 前台的取值不止 bash：-bash / sh / nvim 同样不采信', async () => {
    const tracker = new ActivityTracker(fakeSampler({
      'tmuxterm-a1': { foreground: '-bash', title: '<username>@H:~/workspace', ...GEOM },
      'tmuxterm-b1': { foreground: 'sh', title: '<username>@H:~/workspace', ...GEOM },
      'tmuxterm-c1': { foreground: 'nvim', title: '<username>@H:~/workspace', ...GEOM },
    }));
    await tracker.poll(['a1', 'b1', 'c1']);
    for (const id of ['a1', 'b1', 'c1']) {
      assert.strictEqual(tracker.activityFor(id)?.taskName, '', `会话槽 ${id} 不该有任务名`);
    }
  });

  it('前台是 claude 时照旧采信标题（含剥掉 ⠐ 指示符）', async () => {
    const tracker = new ActivityTracker(fakeSampler({
      'tmuxterm-a1': { foreground: 'claude', title: '⠐ 创建多引擎版 /ask 命令并统一', ...GEOM },
    }));
    await tracker.poll([SLOT_A1]);
    assert.deepStrictEqual(tracker.activityFor(SLOT_A1),
      { state: 'running', taskName: '创建多引擎版 /ask 命令并统一' });
  });

  it('未知前台（空串）即便标题像任务名也不采信', async () => {
    const tracker = new ActivityTracker(fakeSampler({
      'tmuxterm-a1': { foreground: '', title: '创建多引擎版 /ask 命令并统一', ...GEOM },
    }));
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.taskName, '');
  });

  it('★ 每个槽每轮只采样一次（采样循环每 ≈900ms 跑一轮，翻倍是成倍开销）', async () => {
    let calls = 0;
    const reader: PaneSampleReader = {
      async paneSample() {
        calls++;
        return { foreground: 'claude', title: '⠐ 任务', ...GEOM };
      },
      async capturePane() {
        calls++;
        return '';
      },
    };
    const tracker = new ActivityTracker(reader);
    await tracker.poll(['a1', 'b1', 'c1']);
    assert.strictEqual(calls, 6, '3 个存活会话槽 × (采样 + 抓内容) = 6 次调用');
    calls = 0;
    await tracker.poll(['a1', 'b1', 'c1']);
    assert.strictEqual(calls, 6);
  });
});

describe('ActivityTracker.poll：pane 内容差分（新版本 claude 的 title 不再轮转）', () => {
  it('内容从 A 变到 B → running', async () => {
    const contents: Record<string, string> = { 'tmuxterm-a1': 'A' };
    const tracker = new ActivityTracker(contentReader(contents));
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle',
      '首次观测不算「变过」，不判运行');

    contents['tmuxterm-a1'] = 'B';
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running');
  });

  it('★ 内容变过之后连着不变，仍在窗口内 → 仍判 running（防抖动）', async () => {
    // 本轮的核心不变量：轮询间隔 ≈900 ms，而执行中的 pane 内容不是每秒都变
    //（实测有的状态行 4–6 秒才变一次）。若按「这一轮没变 ⇒ 不运行」判，
    // 正在跑的槽会在两个采样点之间来回跳成 idle —— 用户看到绿点/转圈抖动。
    const contents: Record<string, string> = { 'tmuxterm-a1': 'A' };
    const tracker = new ActivityTracker(contentReader(contents));
    await tracker.poll([SLOT_A1]); // 首次观测 A → idle
    contents['tmuxterm-a1'] = 'B';
    await tracker.poll([SLOT_A1]); // 变 → running，记下 lastChangeAt
    await tracker.poll([SLOT_A1]); // 内容仍是 B、这一轮没变，但仍在窗口内
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running',
      '一次变化要能照亮一整个 activityWindowMs 窗口');
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running',
      '窗口内连续多轮不变也不该落回 idle');
  });

  it('窗口恒过期（0），内容不再变 → running 落回，状态机进 done-unseen', async () => {
    // 零宽窗口下「变化的那一轮判 running、下一轮落回」是可**确定复现**的，
    // 不需要真 sleep、也没有时间竞态：本轮变化由 justChanged 兜住，它独立于
    // 窗口；而窗口恒过期保证「没亲眼看到变化」的轮次一律判否。
    const contents: Record<string, string> = { 'tmuxterm-a1': 'A' };
    const tracker = new ActivityTracker(contentReader(contents), 0);
    await tracker.poll([SLOT_A1]); // 首次观测 A → idle
    contents['tmuxterm-a1'] = 'B';
    await tracker.poll([SLOT_A1]); // 本轮亲眼变过 → running（justChanged 不受窗口影响）
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running');

    await tracker.poll([SLOT_A1]); // 内容仍是 B、没变，且窗口恒过期
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'done-unseen');
  });

  it('★ 槽消失再回来：两个 Map 的键一起清，重建后首次观测不判运行', async () => {
    // 若 lastContent/lastChangeAt 残留旧值，槽重建后「旧内容 ≠ 新内容」会被
    // 当成「刚变过」，一上线就显示成运行中（凭空一个转圈）。
    const contents: Record<string, string> = { 'tmuxterm-a1': 'X' };
    const tracker = new ActivityTracker(contentReader(contents));
    await tracker.poll([SLOT_A1]);
    contents['tmuxterm-a1'] = 'Y';
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running');

    await tracker.poll([]); // 槽消失：state 与两个 Map 一起删键
    assert.strictEqual(tracker.activityFor(SLOT_A1), undefined);

    contents['tmuxterm-a1'] = 'Z'; // 再回来，内容与消失前不同
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle',
      '首次观测不算变过 → idle，不是 running，也不是 done-unseen');
  });
});

describe('ActivityTracker.poll：装饰行自跳不算活动（回归：绿点不能凭装饰行冒出）', () => {
  it('★ 内容只在装饰行上变化 ⇒ 不判 running、状态不变成 done-unseen', async () => {
    // 回归 2026-10-13 实测的误报：claude TUI 底部两类「自己会跳动的装饰行」
    // （`% context used` 与 `🧠 … │ 💰 …`）只要有后台 agent 烧 token 就会跳。
    // 若差分前不剔除它们，已经看过的白点会莫名其妙变绿。
    // 这里窗口传 0（零 sleep、可确定复现）：变化只能由「亲眼看到对话区变化」给出。
    const dialog = '对话区: 正在分析问题';
    const contents: Record<string, string> = {
      'tmuxterm-a1': [dialog, '🧠 1.0k/200.0k 1% │ 💰 $1.00', '10% context used'].join('\n'),
    };
    const tracker = new ActivityTracker(contentReader(contents), 0);
    await tracker.poll([SLOT_A1]); // 首次观测 → idle
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle');

    // 第二轮：对话区一字未动，只有两行装饰行自跳（这正是误报的触发条件）
    contents['tmuxterm-a1'] = [dialog, '🧠 2.0k/200.0k 2% │ 💰 $2.00', '11% context used'].join('\n');
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle',
      '只有装饰行变了：不判 running，也不该变成 done-unseen');

    // —— 反向对照（没有它，删掉修复这条测试也会绿）——
    // 第三轮：对话区**真的**多出/变了一行 → 这一次必须判 running。
    contents['tmuxterm-a1'] = ['对话区: 已得出结论', '🧠 2.0k/200.0k 2% │ 💰 $2.00', '11% context used'].join('\n');
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running',
      '对话区真的变了：必须判 running（证明剔除没有把真信号一起吞掉）');
  });

  it('★ 端到端复现：只有输入行 + 模式行在切，不判 running；对话区真变了才 running', async () => {
    // 回归 2026-10-13 残余假绿：空闲会话 tmuxterm-010db8e2f02c 的 19:02:11，
    // 只有输入行（sL68）和模式行（sL70）在来回切，两行都不匹配旧正则 →
    // 被当成对话区有新内容 → running → 5 秒后落成绿色「刚完成」。
    // 窗口传 0（零 sleep、可确定复现）：running 只能由「亲眼看到对话区变化」给出。
    const contents: Record<string, string> = {
      'tmuxterm-a1': [
        '对话区第一行',
        '❯ 改成浮层居中，组合区放到行中间 30%',
        '────────────────────',
        '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent',
        '对话区第二行',
      ].join('\n'),
    };
    const tracker = new ActivityTracker(contentReader(contents), 0);
    await tracker.poll([SLOT_A1]); // 首次观测 → idle
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle');

    // 第 2 拍：只把输入行 + 模式行切成 19:02:11 那对形态，其它字节全不变
    contents['tmuxterm-a1'] = [
      '对话区第一行',
      '❯ 你',
      '────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      '对话区第二行',
    ].join('\n');
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle',
      '只有输入行 / 模式行在切：不判 running，也不该变成 done-unseen');

    // —— 反向对照（没有它，删掉修复这条测试也会绿）——
    // 第 3 拍：改一行**真**对话内容 → 这一次必须判 running。
    contents['tmuxterm-a1'] = [
      '对话区第一行',
      '❯ 你',
      '────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      '对话区第二行，已得出结论',
    ].join('\n');
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running',
      '对话区真的变了：必须判 running（证明剔除没有把真信号一起吞掉）');
  });
});

describe('ActivityTracker.poll：右下角状态提示行自跳不算活动（回归：老终端不能凭它变绿）', () => {
  it('★ 提示行「出现 → 又变回空行」两拍都不判 running；只有改一行普通对话行才 running', async () => {
    // 实测形态（pane 第 24 行，右对齐、左侧一大片空白）：它自己出现、2 秒后又自己
    // 变回空行 ——   20:46:01 L24 "" → "                    Auto-updating…"
    //               20:46:03 L24 "…Auto-updating…" → ""
    // 5 秒静默后落成绿点，用户看到「已看过的老终端白点莫名其妙变绿」。
    // 这一行的另一态是**同一位置的空行**：删行治不了（错位），必须清空成空行。
    // 窗口传 0（零 sleep、可确定复现）：running 只能由「本轮亲眼看到内容变化」给出。
    const hint = '                    Auto-updating…'; // 右对齐提示行
    const contents: Record<string, string> = {
      'tmuxterm-a1': ['对话区第一行', '', '对话区第二行'].join('\n'), // 起手是空行那一态
    };
    const tracker = new ActivityTracker(contentReader(contents), 0);
    await tracker.poll([SLOT_A1]); // 首次观测 → idle
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle');

    // 第 2 拍：提示行出现（其余行一字不动）⇒ 清空后与上一拍逐字节相等 ⇒ 不判 running。
    // 去掉清空那一步，这一拍内容真的变了 ⇒ running ⇒ 本断言红。
    contents['tmuxterm-a1'] = ['对话区第一行', hint, '对话区第二行'].join('\n');
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle',
      '提示行出现不算活动：不能被判 running、也不该变成 done-unseen');

    // 第 3 拍：提示行又变回空行 ⇒ 仍不判 running。
    contents['tmuxterm-a1'] = ['对话区第一行', '', '对话区第二行'].join('\n');
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle',
      '提示行变回空行也不算活动');

    // —— 反向对照（没有它，删掉修复这条测试也可能绿）——
    // 改一行**普通对话行** ⇒ 必须判 running（证明清空没有把真信号一起吞掉）。
    contents['tmuxterm-a1'] = ['对话区第一行', '对话区第三行', '对话区第二行'].join('\n');
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running',
      '真对话内容变了：必须判 running');
  });
});

describe('ActivityTracker.poll：pane resize 不是活动（回归）', () => {
  /**
   * 尺寸与内容都可在轮次之间改写（按 `tmuxterm-<id>` 键）。
   *
   * 前台钉成 claude、title 钉成空串，让 running 只能由「内容差分」或「resize 判定」
   * 推出来 —— 本 describe 考的正是这两者的分界。
   */
  function geomReader(
    geom: Record<string, { width: number; height: number }>,
    contents: Record<string, string>,
  ): PaneSampleReader {
    return {
      async paneSample(session: string): Promise<PaneSample> {
        // 先展 GEOM 补齐 cursorY（本 describe 只改宽/高），再用本槽的几何覆盖宽/高。
        return { foreground: 'claude', title: '', ...GEOM, ...(geom[session] ?? {}) };
      },
      async capturePane(session: string): Promise<string> {
        return contents[session] ?? '';
      },
    };
  }

  it('★ 核心回归：内容变了、尺寸也变了 → 不判运行（resize 重排，不是活动）', async () => {
    // 22 个 pane 尺寸相同时，一次窗口 resize 会让 tmux 把它们一起重排，
    // capture-pane 输出同一轮里全变 —— 只看内容差分会把每个槽判成「刚变过」。
    const geom: Record<string, { width: number; height: number }> = {
      'tmuxterm-a1': { width: 231, height: 72 },
    };
    const contents: Record<string, string> = { 'tmuxterm-a1': 'A' };
    const tracker = new ActivityTracker(geomReader(geom, contents));
    await tracker.poll([SLOT_A1]); // 首次观测：基线 A / 231x72 → idle
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle');

    contents['tmuxterm-a1'] = 'B'; // 重排后内容整体变了
    geom['tmuxterm-a1'] = { width: 200, height: 60 }; // ……因为窗口被 resize 了
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle',
      '尺寸变化那一轮内容也变了，但那是重排不是应用在跑，不能判 running');
  });

  it('★ 重排后的重绘也不误报：尺寸稳定后内容再变，静默期内仍不判运行', async () => {
    const geom: Record<string, { width: number; height: number }> = {
      'tmuxterm-a1': { width: 231, height: 72 },
    };
    const contents: Record<string, string> = { 'tmuxterm-a1': 'A' };
    const tracker = new ActivityTracker(geomReader(geom, contents));
    await tracker.poll([SLOT_A1]); // 基线 A / 231x72

    // 第一轮：尺寸变 → 进入静默期（同时内容也变，是重排）
    contents['tmuxterm-a1'] = 'B';
    geom['tmuxterm-a1'] = { width: 200, height: 60 };
    await tracker.poll([SLOT_A1]);

    // 第二轮：尺寸已稳定，但应用收到 SIGWINCH 又重绘一次 → 内容再次变化
    contents['tmuxterm-a1'] = 'C';
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle',
      '静默期内只刷新内容基线，重绘也不当活动');
  });

  it('★ 静默期会结束（防「把静默期做成永久静默」这个假修）', async () => {
    // resizeSettleMs = 0 的语义是「静默期恒过期」：尺寸变化那轮之后立刻恢复判定，
    // 无需 sleep 就能确定性地验证「静默只是延迟，不是永久屏蔽」。
    // activityWindowMs = 0：running 只由「亲眼看到变化」那一轮给出，杜绝窗口
    // 把上一轮的变化照亮到这一轮、让断言失真。
    const geom: Record<string, { width: number; height: number }> = {
      'tmuxterm-a1': { width: 231, height: 72 },
    };
    const contents: Record<string, string> = { 'tmuxterm-a1': 'A' };
    const tracker = new ActivityTracker(geomReader(geom, contents), 0, 0);
    await tracker.poll([SLOT_A1]); // 基线 A / 231x72 → idle

    // 尺寸变了但内容没变：settle=0 ⇒ 本轮已不算静默，但没内容变化 → 仍 idle
    geom['tmuxterm-a1'] = { width: 200, height: 60 };
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle');

    // 尺寸不再变、应用真的在动 → 立刻恢复正常判运行（静默期没有变成永久静默）
    contents['tmuxterm-a1'] = 'B';
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running',
      '出静默期后内容再变应正常判 running');
  });

  it('★ 拖拽顺延：每轮尺寸都在变，整个拖拽过程都不判运行', async () => {
    const geom: Record<string, { width: number; height: number }> = {
      'tmuxterm-a1': { width: 231, height: 72 },
    };
    const contents: Record<string, string> = { 'tmuxterm-a1': 'A' };
    const tracker = new ActivityTracker(geomReader(geom, contents)); // 默认静默期
    await tracker.poll([SLOT_A1]); // 基线 A / 231x72 → idle

    // 拖拽窗口：尺寸每个 tick 都在变，静默期被逐轮顺延
    contents['tmuxterm-a1'] = 'B';
    geom['tmuxterm-a1'] = { width: 200, height: 60 };
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle', '拖拽第 1 拍不判运行');

    contents['tmuxterm-a1'] = 'C';
    geom['tmuxterm-a1'] = { width: 180, height: 50 };
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle', '拖拽第 2 拍仍不判运行');
  });

  it('★ 重绘持续超过 resizeSettleMs：静默期自延长，整个重绘期间都不判 running', async () => {
    // 真实场景：点开一个已存在的终端，tmux 以 VS Code 面板尺寸 attach → pane 整体
    // 重排；claude TUI 收到 SIGWINCH 后重绘整个转录区，这个重绘**持续远超**
    // resizeSettleMs。若静默期不随内容变化自延长，重绘会在静默期结束后继续变内容
    // → 被判成 running → 5 秒后转成绿色「已完成未查看」（窗口重载时一片老终端集体变绿）。
    // 这里把静默期压到 50ms、上限放到 1000ms：每约 30ms 换一次内容（< 50ms 静默期），
    // 静默期被逐轮顺延，整个重绘过程都该判否。
    const geom: Record<string, { width: number; height: number }> = {
      'tmuxterm-a1': { width: 231, height: 72 },
    };
    const contents: Record<string, string> = { 'tmuxterm-a1': 'A' };
    const tracker = new ActivityTracker(geomReader(geom, contents), 0, 50, 1000);
    await tracker.poll([SLOT_A1]); // 基线 A / 231x72 → idle

    // 尺寸变 → 进入静默期（同时内容也变，是重排）
    contents['tmuxterm-a1'] = 'B';
    geom['tmuxterm-a1'] = { width: 200, height: 60 };
    await tracker.poll([SLOT_A1]);

    // 之后每隔约 30ms 换一次内容、连换 4 次：重绘仍在继续，静默期应被自延长
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 30));
      contents['tmuxterm-a1'] = `重绘帧 ${i}`;
      await tracker.poll([SLOT_A1]);
      assert.notStrictEqual(tracker.activityFor(SLOT_A1)?.state, 'running',
        `重绘第 ${i + 1} 帧仍在静默期内，不该判 running`);
    }
  });

  it('★ 静默期自延长会被上限截断（删掉 settleMaxMs 这条判据，本用例必须变红）', async () => {
    // 上限的意义：没有它，紧接一次重排启动的长任务会把静默期无限顺延下去，
    // 那个槽永远不判 running（表现为「该转圈的永远不转圈」）。
    // 这里**故意**让换内容的间隔（25ms）小于静默期（60ms）——静默期每轮都被顺延、
    // 自延长一直想续，唯一能让它结束的就是上限（140ms）。若上限被删掉，settling
    // 恒为真、running 永不出现，下面这个循环会空转到 20 轮耗尽而断言失败。
    const geom: Record<string, { width: number; height: number }> = {
      'tmuxterm-a1': { width: 231, height: 72 },
    };
    const contents: Record<string, string> = { 'tmuxterm-a1': 'A' };
    const tracker = new ActivityTracker(geomReader(geom, contents), 0, 60, 140);
    await tracker.poll([SLOT_A1]); // 基线 A / 231x72 → idle

    contents['tmuxterm-a1'] = 'B';
    geom['tmuxterm-a1'] = { width: 200, height: 60 };
    await tracker.poll([SLOT_A1]); // 尺寸变 → 进入静默期（settleStartAt = 此刻）

    // 重绘一直在继续：每 25ms 换一次内容，最多观测 20 轮（≈500ms，远超 140ms 上限）。
    // 上限一生效，这一轮的变化就该被判成 running。
    let firstRunningAt = -1;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 25));
      contents['tmuxterm-a1'] = `重绘帧 ${i}`;
      await tracker.poll([SLOT_A1]);
      if (tracker.activityFor(SLOT_A1)?.state === 'running') {
        firstRunningAt = i;
        break;
      }
    }
    assert.ok(
      firstRunningAt >= 0,
      '静默期自延长必须被 settleMaxMs 截断，否则该槽永远不判 running（该转圈的不转圈）',
    );
  });

  it('★ settleMaxMs 传 0 ⇒ 自延长被关掉（退回「静默期只在 resizeSettleMs 内有效」的旧行为）', async () => {
    // 这是 JSDoc 对 settleMaxMs=0 的承诺，也是「上限」这条判据的另一种反向压法：
    // 上限恒过期 ⇒ 静默期内不再顺延，间隔一旦超过 resizeSettleMs 就照常判 running。
    const geom: Record<string, { width: number; height: number }> = {
      'tmuxterm-a1': { width: 231, height: 72 },
    };
    const contents: Record<string, string> = { 'tmuxterm-a1': 'A' };
    const tracker = new ActivityTracker(geomReader(geom, contents), 0, 50, 0);
    await tracker.poll([SLOT_A1]); // 基线 A / 231x72 → idle

    contents['tmuxterm-a1'] = 'B';
    geom['tmuxterm-a1'] = { width: 200, height: 60 };
    await tracker.poll([SLOT_A1]); // 尺寸变 → 本应进入静默期，但上限为 0

    await new Promise((r) => setTimeout(r, 30)); // 静默期 50ms 还没过
    contents['tmuxterm-a1'] = 'C';
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(
      tracker.activityFor(SLOT_A1)?.state,
      'running',
      'settleMaxMs=0 时静默期不自延长，静默期内的变化照常判 running',
    );
  });

  it('★ 静默期外的内容变化照旧立即判 running（自延长没有把普通判定弄坏）', async () => {
    // 自延长只在静默期内生效；尺寸从头到尾不变、根本没进静默期的槽，内容一变
    // 就该立刻判 running —— 防止 `!settling` 用错位置、把普通判定一起判否。
    const geom: Record<string, { width: number; height: number }> = {
      'tmuxterm-a1': { width: 231, height: 72 },
    };
    const contents: Record<string, string> = { 'tmuxterm-a1': 'A' };
    const tracker = new ActivityTracker(geomReader(geom, contents), 0, 50, 1000);
    await tracker.poll([SLOT_A1]); // 基线 A / 231x72 → idle
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle');

    contents['tmuxterm-a1'] = 'B'; // 尺寸不变、没触发静默期
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running',
      '没进静默期的槽，内容一变就判 running');
  });
});

describe('还有未完成的后台工作时不算「已完成」', () => {
  it('★ 内容静止但仍有等待中的后台 agent ⇒ 一直 running，不落成 done-unseen', async () => {
    // 实测两个反复假绿的会话快照 100% 都带 `✻ Waiting for 1 background agent
    // to finish`：这一轮还没结束（在等后台 agent），但 pane 完全静止、不重绘。
    // 窗口传 0（零 sleep）：跑不跑只能由「等待行」给出，不靠窗口照亮。
    const content = [
      '对话区: 正在分析问题',
      '✻ Waiting for 1 background agent to finish',
    ].join('\n');
    const contents: Record<string, string> = { 'tmuxterm-a1': content };
    const tracker = new ActivityTracker(contentReader(contents), 0);

    await tracker.poll([SLOT_A1]); // 首次观测：等待行把这一轮点亮 → running
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running');

    // 再连续 poll 同一份**逐字节相同**的静止内容 3 次：没有等待行就会 5 秒(窗口=0
    // 即立即)落成 done-unseen —— 有等待行则必须一直 running。
    for (let i = 0; i < 3; i++) {
      await tracker.poll([SLOT_A1]);
      assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running',
        `第 ${i + 1} 轮静止内容仍带等待行，必须还是 running`);
    }
  });

  it('★ 反向对照：等待行消失后，同样的静止内容会落成 done-unseen', async () => {
    // 证明上一条真在测「等待行」这个变量，而不是「窗口为 0 就恒 running」。
    const contents: Record<string, string> = {
      'tmuxterm-a1': ['对话区: 正在分析问题', '✻ Waiting for 1 background agent to finish'].join('\n'),
    };
    const tracker = new ActivityTracker(contentReader(contents), 0);

    await tracker.poll([SLOT_A1]); // 含等待行 → running
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running');

    // 去掉等待行：内容变了 ⇒ 这一轮 justChanged → running
    contents['tmuxterm-a1'] = '对话区: 正在分析问题';
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running');

    // 原样重复这份去掉等待行的内容：没有变化、也没有等待行 ⇒ 落成 done-unseen
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'done-unseen',
      '等待行没了且内容静止 ⇒ 正常走窗口判定，落成 done-unseen');
  });

  it('等待行一直在、但对话区新增了一行 ⇒ 仍然 running', async () => {
    const contents: Record<string, string> = {
      'tmuxterm-a1': ['对话区第一行', '✻ Waiting for 1 background agent to finish'].join('\n'),
    };
    const tracker = new ActivityTracker(contentReader(contents), 0);
    await tracker.poll([SLOT_A1]);

    contents['tmuxterm-a1'] =
      ['对话区第一行', '对话区第二行', '✻ Waiting for 1 background agent to finish'].join('\n');
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running');
  });
});

describe('ActivityTracker.opened：点开终端那一下的重绘不算活动（回归）', () => {
  it('★ 点开一个正在跑的槽：静默期内不能落成绿点（任务仍在执行）', async () => {
    // 实测复现（2026-10-19）：槽已 running，用户点开它 → 静默期开始 →
    // 5 秒后（活动窗口过期）状态被落成 done-unseen，而 pane 里任务还在跑；
    // 要等 10 秒静默期上限到期才恢复 running。用户看到的就是「任务在执行，
    // 有时候不转圈了」。
    // activityWindowMs 传 0：排除「5 秒窗口」这条兜底，让断言只依赖状态机本身。
    const contents: Record<string, string> = { 'tmuxterm-a1': 'A' };
    const tracker = new ActivityTracker(contentReader(contents), 0);
    await tracker.poll([SLOT_A1]); // 首次观测 → idle
    contents['tmuxterm-a1'] = 'B';
    await tracker.poll([SLOT_A1]); // 内容真的在变 → running
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running');

    tracker.opened(SLOT_A1); // 用户点开这个正在跑的槽
    contents['tmuxterm-a1'] = 'C'; // 重绘 + 任务自身仍在输出
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running',
      '静默期只该挡住「重绘算活动」，不该把正在跑的槽判成刚完成（旧实现下这里是 done-unseen）');

    contents['tmuxterm-a1'] = 'D'; // 再来一拍，仍无「最近 5 秒变过」兜底
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running',
      '静默期内的连续输出也不能把它推成 done-unseen');
  });

  it('★ 点开后 pane 重绘（内容变、尺寸不变）⇒ 不判 running，5 秒后也不变绿', async () => {
    // 点开侧边栏里的终端会让 pty 收到 focus，claude TUI 随即重绘一次（实测一个
    // 三周前停下的旧终端，被点开那一刻 pane 内容前后各变 1 行、尺寸没变）。
    // 不静默的话这一下重绘会把槽判成 running，紧接着 5 秒后落成绿点 —— 用户刚
    // 看过的那一个反而变绿。opened() 把它按 resize 重排静默掉，性质相同不另造机制。
    // 窗口传 0：running 只能由「本轮亲眼看到变化」给出，否则窗口本身会把重绘
    // 照亮、让断言失真。
    const contents: Record<string, string> = { 'tmuxterm-a1': 'A' };
    const tracker = new ActivityTracker(contentReader(contents), 0);
    tracker.opened(SLOT_A1);
    await tracker.poll([SLOT_A1]); // 首次观测 A → idle
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle');

    contents['tmuxterm-a1'] = 'B'; // 点开触发的重绘：内容变了，尺寸没变
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle',
      '点开那一下的重绘不是活动，不能判 running');
  });

  it('★ 静默期会结束（防「把静默期做成永久静默」）：过 resizeSettleMs 后照常判 running', async () => {
    // 这一点是 opened() 承诺的代价的反面：它只让转圈**最多晚 settleMaxMs**（这里
    // 压到 resizeSettleMs=40），不是永久屏蔽。用真 sleep 越过静默期，静默期内
    // 的变化被吸收、出静默期后内容再变必须立刻判 running。
    const contents: Record<string, string> = { 'tmuxterm-a1': 'A' };
    const tracker = new ActivityTracker(contentReader(contents), 0, 40);
    tracker.opened(SLOT_A1);
    await tracker.poll([SLOT_A1]); // 首次观测 A → idle
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle');

    contents['tmuxterm-a1'] = 'B'; // 静默期内的变化：只刷基线，不算活动
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle',
      '静默期内的变化被吸收，不判 running');

    await new Promise((r) => setTimeout(r, 120)); // > resizeSettleMs(40)：静默期已过
    contents['tmuxterm-a1'] = 'C'; // 应用真的在动
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running',
      '静默只是延迟不是永久屏蔽 —— 出静默期后内容再变应判 running');
  });

  it('★ 静默期内连续变化都被吸收（重绘 + 自己回退），之后基线已对齐', async () => {
    // 点开触发的重绘不是一次性的：TUI 重绘整个转录区、随后自己回退到稳定形态，
    // 静默期内这些变化都只刷新基线、不产生活动判定；最后一次回退后的内容再采
    // 一拍一字不变，说明基线已对齐到最终内容，不会补报假变化、更不会变绿。
    const contents: Record<string, string> = { 'tmuxterm-a1': 'A' };
    const tracker = new ActivityTracker(contentReader(contents), 0); // 默认静默期
    tracker.opened(SLOT_A1);
    await tracker.poll([SLOT_A1]); // 首次观测 A → idle
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle');

    contents['tmuxterm-a1'] = 'B'; // 重绘
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle', '重绘那一拍不判 running');

    contents['tmuxterm-a1'] = 'A'; // 自己回退到重绘前
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle', '回退那一拍也不判 running');

    await tracker.poll([SLOT_A1]); // 回退后的内容再采一拍，一字不变
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle',
      '基线已对齐：不会补报假变化，也不会落成 done-unseen');
  });
});

describe('ActivityTracker.poll：用户在输入框里打字不算活动（回归：绿点不能被打字点亮）', () => {
  // 判别器（实测 2026-10-13）：claude 生成时每秒跳动的忙碌行**从不**落在光标行
  // （忙碌 81 次变化命中 0 次）；用户打字时变化的恰好就是光标行（空闲 32 次里 31 次）。
  // 所以「本轮变化的行**全部**落在光标行」判为「用户在打字」，不刷新活动时间戳。
  // 窗口传 0（零 sleep、可确定复现）：running 只能由「本轮亲眼看到非光标行变化」给出。
  //
  // 夹具内容与 GEOM.cursorY 对齐：行号 0 基，光标停在第 5 行。

  const CURSOR = 5; // = GEOM.cursorY
  const baseline = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6'].join('\n');
  const replaceRow = (content: string, row: number, text: string): string =>
    content.split('\n').map((l, i) => (i === row ? text : l)).join('\n');

  it('★ 只改光标行（模拟敲一个字符）⇒ 不判活动，状态保持 idle（不是绿点）', async () => {
    const contents: Record<string, string> = { 'tmuxterm-a1': baseline };
    const tracker = new ActivityTracker(contentReader(contents), 0);
    await tracker.poll([SLOT_A1]); // 基线 → idle
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle');

    // 第 2 轮：只在光标行（行 5）末尾多敲一个字符，行长变长
    contents['tmuxterm-a1'] = replaceRow(baseline, CURSOR, 'L5x');
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle',
      '只有光标行在变 ⇒ 用户在打字，不算活动，不能点亮绿点');
  });

  it('★ 反向对照：非光标行发生同样幅度的改动 ⇒ 判 running（真活动没被一起吞掉）', async () => {
    const contents: Record<string, string> = { 'tmuxterm-a1': baseline };
    const tracker = new ActivityTracker(contentReader(contents), 0);
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle');

    contents['tmuxterm-a1'] = replaceRow(baseline, 2, 'L2x'); // 改的是行 2（非光标行）
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running',
      '改的是非光标行 ⇒ 是应用在输出，必须判 running');
  });

  it('★ 光标未知（cursorY = -1）⇒ 不抑制，只改一行照样判 running（宁可多判不可漏判）', async () => {
    const contents: Record<string, string> = { 'tmuxterm-a1': baseline };
    const tracker = new ActivityTracker(
      contentReader(contents, { foreground: 'claude', title: '', width: 231, height: 72, cursorY: -1 }),
      0,
    );
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle');

    contents['tmuxterm-a1'] = replaceRow(baseline, CURSOR, 'L5x');
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running',
      '光标未知时不能把变化误判成打字 ⇒ 该判活动就判活动');
  });

  it('★ 前台不是 claude（bash）⇒ 闸门生效，只改光标行照样判 running', async () => {
    const contents: Record<string, string> = { 'tmuxterm-a1': baseline };
    const tracker = new ActivityTracker(
      contentReader(contents, { foreground: 'bash', title: '', width: 231, height: 72, cursorY: CURSOR }),
      0,
    );
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle');

    contents['tmuxterm-a1'] = replaceRow(baseline, CURSOR, 'L5x');
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'running',
      '纯 shell 的输出顺着光标行往下写，这条抑制只对 claude 前台生效');
  });

  it('★ 光标之上有被删行 ⇒ 映射后才比较（回归：拿原始行号硬比会恒不触发）', async () => {
    // 复现 2026-10-13 的正例形态：cursor_y=5、光标之上 2 行被 strip 删掉，
    // 光标行在 strip 后是 index 3。若拿原始行号 5 去比 strip 改动行 [3]，永远不等 ⇒
    // 打字被误判成活动（这正是上一版的错）。经 cursorRowAfterStrip 映射成 3 后 ==>
    // 3===3 ⇒ 不判活动。
    const rawContent = [
      'L0',                             // 0
      '🧠 1.0k/200.0k 1% │ 💰 $1.00',   // 1 状态行 → 删
      'L2',                             // 2
      '────────────────────',           // 3 边框 → 删
      'L4',                             // 4
      'L5',                             // 5 ← 光标（原始行号）
      'L6',                             // 6
    ].join('\n');
    const contents: Record<string, string> = { 'tmuxterm-a1': rawContent };
    const tracker = new ActivityTracker(contentReader(contents), 0);
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle');

    // 第 2 轮：只改原始第 5 行（光标行）；strip 后该变化落在 index 3
    contents['tmuxterm-a1'] = replaceRow(rawContent, CURSOR, 'L5x');
    await tracker.poll([SLOT_A1]);
    assert.strictEqual(tracker.activityFor(SLOT_A1)?.state, 'idle',
      '光标行变化经映射后应判为打字，不能被原始行号硬比掉');
  });
});
