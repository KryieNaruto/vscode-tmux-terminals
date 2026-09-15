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
