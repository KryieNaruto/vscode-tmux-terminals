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
const GEOM = { width: 231, height: 72 };

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
 * 只给 pane **内容**的假 reader：title 恒为空。
 *
 * 专门考「内容差分」这条新判据 —— 新版本 claude 的 pane title 首字符恒为 ✳
 * （Braille 零命中，见 core/tmux.ts 的 isRunningTitle），title 什么都说明不了，
 * 所以这里把它钉成空串，让 running 只能由内容变化推出来。
 */
function contentReader(contents: Record<string, string>): PaneSampleReader {
  return {
    async paneSample(): Promise<PaneSample> {
      return { foreground: 'claude', title: '', ...GEOM };
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
    // `qiansenwei@H:~/workspace`：改前 taskNameFromTitle 原样保留它，
    // 于是三级显示提示符、aiTitle 回退永远轮不到；闸门把它压成空串，
    // 回退链（tree.ts 的 taskNameFor）才能接手。
    const tracker = new ActivityTracker(fakeSampler({
      'tmuxterm-a1': { foreground: 'bash', title: 'qiansenwei@H:~/workspace', ...GEOM },
    }));
    await tracker.poll([SLOT_A1]);
    assert.deepStrictEqual(tracker.activityFor(SLOT_A1), { state: 'idle', taskName: '' });
  });

  it('★ 非 claude 前台的取值不止 bash：-bash / sh / nvim 同样不采信', async () => {
    const tracker = new ActivityTracker(fakeSampler({
      'tmuxterm-a1': { foreground: '-bash', title: 'qiansenwei@H:~/workspace', ...GEOM },
      'tmuxterm-b1': { foreground: 'sh', title: 'qiansenwei@H:~/workspace', ...GEOM },
      'tmuxterm-c1': { foreground: 'nvim', title: 'qiansenwei@H:~/workspace', ...GEOM },
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
        return { foreground: 'claude', title: '', ...(geom[session] ?? GEOM) };
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
});
