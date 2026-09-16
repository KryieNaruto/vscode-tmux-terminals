import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TaskTitleCache } from '../src/taskTitles';

/** prewarm 是 fire-and-forget（返回 void），测试里等几拍让它落地。 */
const settle = () => new Promise((r) => setTimeout(r, 10));

describe('TaskTitleCache —— 异步预取 + 同步 peek', () => {
  it('prewarm 之后 peek 命中', async () => {
    const titles = new TaskTitleCache('/nonexistent', async () => '任务名');
    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(titles.peek('c1'), '任务名');
  });

  it('未 prewarm → undefined（peek 绝不阻塞读盘）', () => {
    const titles = new TaskTitleCache('/nonexistent', async () => '任务名');
    assert.strictEqual(titles.peek('c1'), undefined);
  });

  it('peek(undefined) / peek(空串) → undefined', () => {
    const titles = new TaskTitleCache('/nonexistent', async () => '任务名');
    assert.strictEqual(titles.peek(undefined), undefined);
    assert.strictEqual(titles.peek(''), undefined);
  });

  it('prewarm(undefined, cwd) 不发起读', async () => {
    let calls = 0;
    const titles = new TaskTitleCache('/nonexistent', async () => { calls++; return 'x'; });
    titles.prewarm(undefined, '/x');
    titles.prewarm('', '/x');
    await settle();
    assert.strictEqual(calls, 0);
  });

  it('换绑（不同 conversationId）→ 各自独立', async () => {
    const titles = new TaskTitleCache('/nonexistent', async (id) => `标题-${id}`);
    titles.prewarm('c1', '/x');
    titles.prewarm('c2', '/y');
    await settle();
    assert.strictEqual(titles.peek('c1'), '标题-c1');
    assert.strictEqual(titles.peek('c2'), '标题-c2');
  });

  it('★ 读不到不缓存：下一次 prewarm 会重试（/new 后新对话还没生成标题）', async () => {
    let calls = 0;
    let answer: string | undefined;
    const titles = new TaskTitleCache('/nonexistent', async () => { calls++; return answer; });

    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(calls, 1);
    assert.strictEqual(titles.peek('c1'), undefined, '读不到 → 不进缓存');

    answer = '后来才有的标题';
    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(calls, 2, '第二次 prewarm 必须重试');
    assert.strictEqual(titles.peek('c1'), '后来才有的标题');
  });

  it('已缓存则不重复读盘', async () => {
    let calls = 0;
    const titles = new TaskTitleCache('/nonexistent', async () => { calls++; return '名'; });
    titles.prewarm('c1', '/x');
    await settle();
    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(calls, 1);
  });

  it('cwd 会传给 reader（findConversationFile 要按 id + cwd 定位）', async () => {
    const seen: string[] = [];
    const titles = new TaskTitleCache('/nonexistent', async (_id, cwd) => { seen.push(cwd); return '名'; });
    titles.prewarm('c1', '/some/cwd');
    await settle();
    assert.deepStrictEqual(seen, ['/some/cwd']);
  });
});

/**
 * 以下用例**超出 brief 逐字给出的 8 项**，补的是并发模型与容量这两条
 * 「写出来才对、写错也照样过 brief」的路径 —— brief 的 8 项全部注入假
 * reader，因此默认 reader 链路、异常路径、去重与逐出都没被覆盖。
 */
describe('TaskTitleCache —— 并发模型与容量（补充覆盖）', () => {
  it('同一拍内两次 prewarm 只读一次盘（pending 去重）', async () => {
    let calls = 0;
    let release: (v: string) => void = () => {};
    const gate = new Promise<string>((r) => { release = r; });
    const titles = new TaskTitleCache('/nonexistent', async () => { calls++; return gate; });

    titles.prewarm('c1', '/x');
    titles.prewarm('c1', '/x'); // 与上一行同一拍：读盘还没落地
    release('名');
    await settle();
    assert.strictEqual(calls, 1, '去重靠 pending，同一拍不得重复读盘');
    assert.strictEqual(titles.peek('c1'), '名');
  });

  it('reader 抛异常 → 当作读不到（不缓存、下次重试），且不产生未处理 rejection', async () => {
    let calls = 0;
    const titles = new TaskTitleCache('/nonexistent', async () => { calls++; throw new Error('boom'); });
    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(titles.peek('c1'), undefined, '读盘失败 → 安全侧：不显示第三级');
    assert.strictEqual(calls, 1);

    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(calls, 2, '失败也不缓存 —— 下次 prewarm 必须重试');
  });

  it('超过条数上限时按最久未访问逐出，且被 peek 命中的会续命', async () => {
    const MAX_ENTRIES = 256; // 与 src/taskTitles.ts 的常量对齐
    const titles = new TaskTitleCache('/nonexistent', async (id) => `标题-${id}`);
    for (let i = 0; i < MAX_ENTRIES; i++) titles.prewarm(`c${i}`, '/x');
    await settle();
    assert.strictEqual(titles.peek('c0'), '标题-c0', 'c0 此刻还在，这次命中同时把它续命到队尾');

    titles.prewarm('extra', '/x'); // 溢出 1 条
    await settle();
    assert.strictEqual(titles.peek('extra'), '标题-extra');
    assert.strictEqual(titles.peek('c0'), '标题-c0', 'c0 刚被 peek 过，不该被逐出');
    assert.strictEqual(titles.peek('c1'), undefined, '最久未访问的是 c1（不是 c0）');
  });

  it('边界去空白：reader 给 "  Foo  " → peek 返回 "Foo"', async () => {
    const titles = new TaskTitleCache('/nonexistent', async () => '  Foo  ');
    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(titles.peek('c1'), 'Foo');
  });

  it('全空白视同读不到 → 不缓存，下次 prewarm 重试', async () => {
    let calls = 0;
    const titles = new TaskTitleCache('/nonexistent', async () => { calls++; return '   '; });
    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(titles.peek('c1'), undefined);
    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(calls, 2);
  });
});

/**
 * 默认 reader 链路（findConversationFile → readTail → parseAiTitle）。
 *
 * brief 的 8 项全部注入假 reader，因而「默认链路接错」（比如读头部而不是
 * 尾部、漏了 undefined 守卫、忘了 await）能全身而退。这里用临时 home 驱动
 * —— **绝不碰用户真实的 ~/.claude**。
 */
describe('TaskTitleCache —— 默认 reader 链路', () => {
  const UUID = '7af4c86a-ea5d-4f25-9d9c-8ba7e620a5a0';
  const homes: string[] = [];
  const mk = async (files: Record<string, string>): Promise<string> => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxterm-titles-'));
    for (const [rel, text] of Object.entries(files)) {
      const p = path.join(home, '.claude', 'projects', rel);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, text, 'utf8');
    }
    homes.push(home);
    return home;
  };
  after(async () => {
    for (const h of homes) await fs.rm(h, { recursive: true, force: true });
  });

  /** 真实 IO 下不要写死 sleep：轮询到命中为止。 */
  const waitHit = async (titles: TaskTitleCache, id: string, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = titles.peek(id);
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) return undefined;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('从 transcript 尾部读出 aiTitle', async () => {
    const home = await mk({
      [`-work-proj/${UUID}.jsonl`]: [
        JSON.stringify({ type: 'user', cwd: '/work/proj', message: { role: 'user', content: 'hi' } }),
        JSON.stringify({ type: 'ai-title', sessionId: UUID, aiTitle: '真标题' }),
      ].join('\n'),
    });
    const titles = new TaskTitleCache(home);
    titles.prewarm(UUID, '/work/proj');
    assert.strictEqual(await waitHit(titles, UUID), '真标题');
  });

  it('★ 对话不存在 → undefined 而非抛出（readTail 对缺失文件会抛）', async () => {
    const home = await mk({});
    const titles = new TaskTitleCache(home);
    titles.prewarm('no-such-conversation', '/work/proj');
    await settle();
    assert.strictEqual(titles.peek('no-such-conversation'), undefined);
  });

  it('id 在但 cwd 不符 → undefined（不靠目录名反推归属）', async () => {
    const home = await mk({
      [`-a/${UUID}.jsonl`]: JSON.stringify({ type: 'user', cwd: '/a', message: { role: 'user', content: 'hi' } }),
    });
    const titles = new TaskTitleCache(home);
    titles.prewarm(UUID, '/b');
    await settle();
    assert.strictEqual(titles.peek(UUID), undefined);
  });

  it('transcript 里没有 ai-title 记录 → undefined', async () => {
    const home = await mk({
      [`-work-proj/${UUID}.jsonl`]: JSON.stringify({
        type: 'user', cwd: '/work/proj', message: { role: 'user', content: 'hi' },
      }),
    });
    const titles = new TaskTitleCache(home);
    titles.prewarm(UUID, '/work/proj');
    await settle();
    assert.strictEqual(titles.peek(UUID), undefined);
  });
});

/**
 * 低频重试（`retryMissing`）。
 *
 * 这一层补的是「时间」这个触发维度：prewarm 的调用点全是用户动作，而 /new
 * 之后那条新对话在第一次读的时候还没有 aiTitle —— 没有它，那次 miss 之后
 * 再没有任何东西会重读，第三级永久消失。
 *
 * 冷却常量是 25 s 量级，测试不能真等，所以这里直接钉住 `Date.now`（冷却
 * 判据只用到它，没有别的时序依赖；settle 用的 setTimeout 不受影响）。
 */
describe('TaskTitleCache —— 轮询节拍上的低频重试（retryMissing）', () => {
  const RETRY_COOLDOWN_MS = 25_000; // 与 src/taskTitles.ts 的常量对齐
  const realNow = Date.now;
  let now = 1_000_000;

  beforeEach(() => {
    now = 1_000_000;
    Date.now = () => now;
  });
  afterEach(() => {
    Date.now = realNow;
  });

  it('★ 读不到 → 冷却期内不重读；冷却过后重试并写入', async () => {
    let calls = 0;
    let answer: string | undefined;
    const titles = new TaskTitleCache('/nonexistent', async () => { calls++; return answer; });

    titles.retryMissing([{ conversationId: 'c1', cwd: '/x' }]);
    await settle();
    assert.strictEqual(calls, 1, '首次重试必须真的发起读盘');
    assert.strictEqual(titles.peek('c1'), undefined, '读不到 → 仍然不进缓存');

    // 冷却期内被轮询反复调用（10s 一拍）也不许重读：那条 transcript 可能
    // 上 MB，而「永远不生成标题」的会话会被无限读下去。
    now += RETRY_COOLDOWN_MS - 1;
    titles.retryMissing([{ conversationId: 'c1', cwd: '/x' }]);
    titles.retryMissing([{ conversationId: 'c1', cwd: '/x' }]);
    await settle();
    assert.strictEqual(calls, 1, '冷却期内不得重读');

    answer = '后来才生成的标题';
    now += 1; // 刚好越过冷却
    titles.retryMissing([{ conversationId: 'c1', cwd: '/x' }]);
    await settle();
    assert.strictEqual(calls, 2, '冷却过后必须重试');
    assert.strictEqual(titles.peek('c1'), '后来才生成的标题');
  });

  it('冷却按 conversationId 独立：A 冷却中不影响 B 立即重试', async () => {
    const seen: string[] = [];
    const titles = new TaskTitleCache('/nonexistent', async (id) => { seen.push(id); return undefined; });

    titles.retryMissing([{ conversationId: 'A', cwd: '/x' }]);
    await settle();
    assert.deepStrictEqual(seen, ['A']);

    // 同一次调用里 A 还在冷却、B 是新的（刚 /new 出来的那条）
    titles.retryMissing([
      { conversationId: 'A', cwd: '/x' },
      { conversationId: 'B', cwd: '/y' },
    ]);
    await settle();
    assert.deepStrictEqual(seen, ['A', 'B'], 'A 被冷却挡下，B 必须立刻重试');
  });

  it('reconcile 的 prewarm 与轮询重试共用一份尝试记录（冷却不可被绕过）', async () => {
    let calls = 0;
    const titles = new TaskTitleCache('/nonexistent', async () => { calls++; return undefined; });

    titles.prewarm('c1', '/x'); // 用户动作（点击 / 展开 / ⟳）触发的读
    await settle();
    titles.retryMissing([{ conversationId: 'c1', cwd: '/x' }]); // 紧接着的轮询节拍
    await settle();
    assert.strictEqual(calls, 1, '刚 prewarm 过，轮询不该在冷却期内再读一次');
  });

  it('已缓存到的条目即使过了冷却也不再读盘', async () => {
    let calls = 0;
    const titles = new TaskTitleCache('/nonexistent', async () => { calls++; return '名'; });
    titles.prewarm('c1', '/x');
    await settle();

    now += RETRY_COOLDOWN_MS * 2;
    titles.retryMissing([{ conversationId: 'c1', cwd: '/x' }]);
    await settle();
    assert.strictEqual(calls, 1, 'cache.has 守卫在 retryMissing 里同样生效');
  });

  it('未绑定 / 空 conversationId 的条目不发起读', async () => {
    let calls = 0;
    const titles = new TaskTitleCache('/nonexistent', async () => { calls++; return 'x'; });
    titles.retryMissing([{ cwd: '/x' }, { conversationId: '', cwd: '/x' }]);
    await settle();
    assert.strictEqual(calls, 0);
  });

  it('同一拍内两次重试只读一次盘（pending 去重仍然生效）', async () => {
    let calls = 0;
    let release: (v: string) => void = () => {};
    const gate = new Promise<string>((r) => { release = r; });
    const titles = new TaskTitleCache('/nonexistent', async () => { calls++; return gate; });

    titles.retryMissing([{ conversationId: 'c1', cwd: '/x' }]);
    now += RETRY_COOLDOWN_MS * 2; // 冷却不是这里的守卫，pending 才是
    titles.retryMissing([{ conversationId: 'c1', cwd: '/x' }]);
    release('名');
    await settle();
    assert.strictEqual(calls, 1);
    assert.strictEqual(titles.peek('c1'), '名');
  });
});

/**
 * 变化通知。**只在真的写入一条新标题时**触发 —— 通知的代价是渲染层重建
 * 整棵树，多触发一次就是一次纯浪费，漏触发则是「标题到了树上却不出现」。
 */
describe('TaskTitleCache —— 变化通知（onDidChangeTitle）', () => {
  /** 计一次通知次数；记得在用例末尾 dispose。 */
  const spyOn = (titles: TaskTitleCache) => {
    let count = 0;
    const sub = titles.onDidChangeTitle(() => { count++; });
    return { count: () => count, sub };
  };

  it('★ 成功写入一条标题 → 恰好触发一次', async () => {
    const titles = new TaskTitleCache('/nonexistent', async () => '名');
    const spy = spyOn(titles);
    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(titles.peek('c1'), '名');
    assert.strictEqual(spy.count(), 1, '多一次 = 多一次整树重建');
    spy.sub.dispose();
  });

  it('通知触发时缓存里已经有值（provider 重算时 peek 必须能命中）', async () => {
    const titles = new TaskTitleCache('/nonexistent', async () => '名');
    let seen: string | undefined = '尚未触发';
    const sub = titles.onDidChangeTitle(() => { seen = titles.peek('c1'); });
    titles.prewarm('c1', '/x');
    await settle();
    // 顺序反了（先通知后 set）的话，树上那个三级节点会以空名字重算一次，
    // 用户看到的是「刷新了但还是没有」。
    assert.strictEqual(seen, '名');
    sub.dispose();
  });

  it('读不到 → 不触发', async () => {
    const titles = new TaskTitleCache('/nonexistent', async () => undefined);
    const spy = spyOn(titles);
    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(titles.peek('c1'), undefined);
    assert.strictEqual(spy.count(), 0);
    spy.sub.dispose();
  });

  it('读盘抛错 → 不触发', async () => {
    const titles = new TaskTitleCache('/nonexistent', async () => { throw new Error('boom'); });
    const spy = spyOn(titles);
    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(spy.count(), 0);
    spy.sub.dispose();
  });

  it('缓存命中 → 不触发（重新 prewarm 一个已缓存的条目连读盘都不发起）', async () => {
    let calls = 0;
    const titles = new TaskTitleCache('/nonexistent', async () => { calls++; return '名'; });
    const spy = spyOn(titles);
    titles.prewarm('c1', '/x');
    await settle();
    titles.prewarm('c1', '/x'); // 命中：cache.has 守卫直接返回
    titles.retryMissing([{ conversationId: 'c1', cwd: '/x' }]);
    await settle();
    assert.strictEqual(calls, 1);
    assert.strictEqual(spy.count(), 1, '命中不触发 —— 否则每次渲染/轮询都会刷树');
    spy.sub.dispose();
  });

  it('★ coalesce：同一拍内三条标题落地 → 只触发一次', async () => {
    const titles = new TaskTitleCache('/nonexistent', async (id) => `标题-${id}`);
    const spy = spyOn(titles);
    titles.retryMissing([
      { conversationId: 'a', cwd: '/x' },
      { conversationId: 'b', cwd: '/x' },
      { conversationId: 'c', cwd: '/x' },
    ]);
    await settle();
    assert.strictEqual(titles.peek('a'), '标题-a');
    assert.strictEqual(titles.peek('c'), '标题-c');
    // 一次通知 = 一次整树重建，没有理由为 3 条标题重建 3 次。
    assert.strictEqual(spy.count(), 1);
    spy.sub.dispose();
  });

  it('dispose 之后不再收到通知', async () => {
    const titles = new TaskTitleCache('/nonexistent', async () => '名');
    const spy = spyOn(titles);
    spy.sub.dispose();
    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(titles.peek('c1'), '名');
    assert.strictEqual(spy.count(), 0);
  });

  it('多个订阅者都收到通知', async () => {
    const titles = new TaskTitleCache('/nonexistent', async () => '名');
    const a = spyOn(titles);
    const b = spyOn(titles);
    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(a.count(), 1);
    assert.strictEqual(b.count(), 1);
    a.sub.dispose();
    b.sub.dispose();
  });
});
