import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { findConversationFile, findConversations, listConversations, readTail } from '../src/conversationFiles';
import { parseAiTitle } from '../src/core/conversation';

/**
 * 枚举 `~/.claude/projects/**` 下可接回的对话。
 *
 * 用临时 home 驱动，**绝不碰用户真实的 ~/.claude**：这些文件动辄几 MB，
 * 而且读错归属会让用户在 QuickPick 里挑到别人的对话。
 */
const UUID = '7af4c86a-ea5d-4f25-9d9c-8ba7e620a5a0';

const line = (o: object) => JSON.stringify(o);
const userLine = (text: string, cwd: string) =>
  line({ type: 'user', userType: 'external', isSidechain: false, cwd, message: { role: 'user', content: text } });

async function makeHome(files: Record<string, string>): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxterm-conv-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(home, '.claude', 'projects', rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, text, 'utf8');
  }
  return home;
}

describe('listConversations', () => {
  const homes: string[] = [];
  const mk = async (files: Record<string, string>) => {
    const h = await makeHome(files);
    homes.push(h);
    return h;
  };
  after(async () => {
    for (const h of homes) await fs.rm(h, { recursive: true, force: true });
  });

  it('枚举出 id / cwd / 摘要 / 体积', async () => {
    const home = await mk({
      [`-ssd-foo/${UUID}.jsonl`]: [
        line({ type: 'mode', sessionId: UUID }),
        line({ type: 'attachment', cwd: '/ssd/foo' }),
        userLine('把那个 bug 修了', '/ssd/foo'),
      ].join('\n'),
    });
    const list = await listConversations(home);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, UUID);
    assert.strictEqual(list[0].cwd, '/ssd/foo');
    assert.strictEqual(list[0].summary, '把那个 bug 修了');
    assert.ok(list[0].bytes > 0);
    assert.ok(list[0].mtimeMs > 0);
  });

  it('cwd 不靠目录名反推：目录名与真实 cwd 不一致时以文件内字段为准', async () => {
    const home = await mk({
      ['-totally-wrong-name/x.jsonl']: [
        line({ type: 'attachment', cwd: '/a/b_c.d/e' }),
        userLine('hi', '/a/b_c.d/e'),
      ].join('\n'),
    });
    assert.strictEqual((await listConversations(home))[0].cwd, '/a/b_c.d/e');
  });

  it('读不出 cwd 的文件被跳过（绝不猜归属）', async () => {
    const home = await mk({
      ['-x/good.jsonl']: [line({ type: 'attachment', cwd: '/a/b' }), userLine('hi', '/a/b')].join('\n'),
      ['-x/bad.jsonl']: line({ type: 'mode', sessionId: 'y' }),
    });
    const list = await listConversations(home);
    assert.deepStrictEqual(list.map((c) => c.cwd), ['/a/b']);
  });

  it('忽略非 .jsonl 文件（目录里还可能有别的元数据）', async () => {
    const home = await mk({
      ['-x/a.jsonl']: line({ type: 'attachment', cwd: '/a/b' }),
      ['-x/notes.txt']: 'not a conversation',
    });
    assert.strictEqual((await listConversations(home)).length, 1);
  });

  it('projects 目录不存在 → 返回空数组，不抛', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxterm-conv-empty-'));
    homes.push(home);
    assert.deepStrictEqual(await listConversations(home), []);
  });

  it('★ 只读文件头部：摘要取不到也不报错，cwd 仍要拿到（文件动辄几 MB）', async () => {
    const padding = Array.from({ length: 2000 }, (_, i) =>
      line({ type: 'attachment', cwd: '/a/b', attachment: { i, pad: 'x'.repeat(200) } }));
    const home = await mk({
      ['-a/b.jsonl']: [line({ type: 'attachment', cwd: '/a/b' }), ...padding, userLine('很靠后的一条消息', '/a/b')].join('\n'),
    });
    const list = await listConversations(home);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].cwd, '/a/b', 'cwd 在文件开头，必须被读到');
    assert.strictEqual(list[0].summary, '', '首条用户消息超出头部读取上限时摘要为空，但不得报错');
  });
});

describe('findConversations —— 按 id 直查（判断该用 --session-id 还是 --resume）', () => {
  const homes: string[] = [];
  const mk = async (files: Record<string, string>) => {
    const h = await makeHome(files);
    homes.push(h);
    return h;
  };
  after(async () => {
    for (const h of homes) await fs.rm(h, { recursive: true, force: true });
  });

  it('命中时返回它记录的 cwd', async () => {
    const home = await mk({
      [`-ssd-foo/${UUID}.jsonl`]: [line({ type: 'attachment', cwd: '/ssd/foo' }), userLine('hi', '/ssd/foo')].join('\n'),
    });
    assert.deepStrictEqual(await findConversations(home, UUID), ['/ssd/foo']);
  });

  it('这条对话还没被创建过 → 空数组（调用方据此用 --session-id 建出来）', async () => {
    const home = await mk({});
    assert.deepStrictEqual(await findConversations(home, UUID), []);
  });

  it('★ 同一个 id 出现在多个 cwd 下时全部返回（调用方要判断有没有落在本条目 cwd 下的）', async () => {
    const home = await mk({
      [`-a/${UUID}.jsonl`]: line({ type: 'attachment', cwd: '/a' }),
      [`-b/${UUID}.jsonl`]: line({ type: 'attachment', cwd: '/b' }),
    });
    assert.deepStrictEqual((await findConversations(home, UUID)).sort(), ['/a', '/b']);
  });

  it('只认 .jsonl，且 projects 目录不存在时不抛', async () => {
    const home = await mk({ [`-a/${UUID}.txt`]: line({ type: 'attachment', cwd: '/a' }) });
    assert.deepStrictEqual(await findConversations(home, UUID), []);

    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxterm-conv-none-'));
    homes.push(empty);
    assert.deepStrictEqual(await findConversations(empty, UUID), []);
  });
});

describe('findConversationFile —— 按 id + cwd 精确定位文件（供尾部读取）', () => {
  const homes: string[] = [];
  const mk = async (files: Record<string, string>) => {
    const h = await makeHome(files);
    homes.push(h);
    return h;
  };
  after(async () => {
    for (const h of homes) await fs.rm(h, { recursive: true, force: true });
  });

  it('命中时返回文件的绝对路径', async () => {
    const home = await mk({
      [`-ssd-foo/${UUID}.jsonl`]: [line({ type: 'attachment', cwd: '/ssd/foo' }), userLine('hi', '/ssd/foo')].join('\n'),
    });
    assert.strictEqual(
      await findConversationFile(home, UUID, '/ssd/foo'),
      path.join(home, '.claude', 'projects', '-ssd-foo', `${UUID}.jsonl`),
    );
  });

  it('id 存在但 cwd 不符 → undefined（归属以文件内字段为准）', async () => {
    const home = await mk({ [`-a/${UUID}.jsonl`]: line({ type: 'attachment', cwd: '/a' }) });
    assert.strictEqual(await findConversationFile(home, UUID, '/b'), undefined);
  });

  it('id 不存在 / projects 目录不存在 → undefined，不抛', async () => {
    const home = await mk({});
    assert.strictEqual(await findConversationFile(home, UUID, '/a'), undefined);

    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxterm-conv-none-'));
    homes.push(empty);
    assert.strictEqual(await findConversationFile(empty, UUID, '/a'), undefined);
  });

  it('★ 标题落在文件尾部时也能读出来（头部 >64 KB、ai-title 只在末尾）', async () => {
    const padding = Array.from({ length: 2000 }, (_, i) =>
      line({ type: 'attachment', cwd: '/a/b', attachment: { i, pad: 'x'.repeat(200) } }));
    const home = await mk({
      [`-a-b/${UUID}.jsonl`]: [
        line({ type: 'attachment', cwd: '/a/b' }),
        ...padding,
        line({ type: 'ai-title', sessionId: UUID, aiTitle: '尾部才有的标题' }),
      ].join('\n'),
    });
    const file = await findConversationFile(home, UUID, '/a/b');
    assert.ok(file !== undefined, '必须按 id + cwd 命中');
    const tail = await readTail(file!, 64 * 1024);
    assert.strictEqual(parseAiTitle(tail), '尾部才有的标题');
  });

  it('文件比窗口短时 readTail 返回全部内容', async () => {
    const home = await mk({ [`-a-b/${UUID}.jsonl`]: line({ type: 'attachment', cwd: '/a/b' }) });
    const file = await findConversationFile(home, UUID, '/a/b');
    const tail = await readTail(file!, 64 * 1024);
    assert.strictEqual(tail, line({ type: 'attachment', cwd: '/a/b' }));
  });
});
