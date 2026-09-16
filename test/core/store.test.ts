import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EntryStore, newId } from '../../src/core/store';
import { TerminalEntry } from '../../src/core/types';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxstore-')), 'terminals.json');
}

/** 原有用例的条目构造器（id 用 newId 保证唯一，供 add/remove/update 用）。 */
const entry = (over: Partial<TerminalEntry> = {}): TerminalEntry => ({
  id: newId(),
  name: 'paint-pc',
  cwd: '~/mine/paint-pc',
  profile: 'ccr',
  autoRestore: true,
  order: 0,
  // v3 起 `sessions` 是必需字段。本 describe 里的断言都只关心条目级的写入契约
  // （order / id / 原子性），故给一个合法的**空**槽列表 —— 不编造一个不存在的
  // 会话。断言一个字没动。
  sessions: [],
  ...over,
});

describe('EntryStore', () => {
  it('文件不存在时返回空数组，不抛错', async () => {
    const store = new EntryStore(tmpFile());
    assert.deepStrictEqual(await store.load(), []);
  });

  it('保存后再读取内容一致', async () => {
    const store = new EntryStore(tmpFile());
    const e = entry();
    await store.save([e]);
    assert.deepStrictEqual(await store.load(), [e]);
  });

  it('写入是原子的：不留下 .tmp 残留', async () => {
    const file = tmpFile();
    const store = new EntryStore(file);
    await store.save([entry()]);
    assert.strictEqual(fs.existsSync(file + '.tmp'), false);
  });

  it('损坏的 JSON 不抛错，返回空数组', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{ this is not json');
    const store = new EntryStore(file);
    assert.deepStrictEqual(await store.load(), []);
  });

  it('内容不是数组时返回空数组', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{"a":1}');
    const store = new EntryStore(file);
    assert.deepStrictEqual(await store.load(), []);
  });

  // 回归：损坏的存储文件曾被一次 append 直接覆盖，用户条目尽失，且没有
  // 任何 .bak 可恢复（.bak 只在 v1 迁移时生成）。现在写路径必须在覆盖
  // 之前把原文抢救到 <file>.corrupt。
  it('不可解析的文件在写入前被另存为 .corrupt（不丢用户数据）', async () => {
    const file = tmpFile();
    const original = '{oooo';
    fs.writeFileSync(file, original);
    const store = new EntryStore(file);

    await store.append({ id: 'a', name: 'a', cwd: '/w', profile: 'ccr', autoRestore: true, sessions: [] });

    assert.strictEqual(fs.readFileSync(file + '.corrupt', 'utf8'), original,
      '.corrupt 必须原样保存损坏前的字节');
    assert.deepStrictEqual((await store.load()).map((e) => e.name), ['a'],
      '写入仍应正常进行（load 的宽容契约不变）');
  });

  it('.corrupt 已存在时不覆盖（第一份才是原始数据）', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{first-broken');
    fs.writeFileSync(file + '.corrupt', 'PRIOR');
    const store = new EntryStore(file);
    await store.append({ id: 'a', name: 'a', cwd: '/w', profile: 'ccr', autoRestore: true, sessions: [] });
    assert.strictEqual(fs.readFileSync(file + '.corrupt', 'utf8'), 'PRIOR');
  });

  it('文件不存在时不写 .corrupt（正常的空启动）', async () => {
    const file = tmpFile();
    const store = new EntryStore(file);
    await store.append({ id: 'a', name: 'a', cwd: '/w', profile: 'ccr', autoRestore: true, sessions: [] });
    assert.strictEqual(fs.existsSync(file + '.corrupt'), false);
  });

  it('损坏时回调一次，携带 .corrupt 路径（供宿主提示用户）', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{oooo');
    const seen: string[] = [];
    const store = new EntryStore(file, (p) => seen.push(p));
    await store.append({ id: 'a', name: 'a', cwd: '/w', profile: 'ccr', autoRestore: true, sessions: [] });
    assert.deepStrictEqual(seen, [file + '.corrupt']);
  });

  it('负数 order 被钳到 0（手改文件也不能破坏排序契约）', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify([
      { id: 'a', name: 'a', cwd: '/w', profile: 'ccr', autoRestore: true, order: -5 },
      { id: 'b', name: 'b', cwd: '/w', profile: 'ccr', autoRestore: true, order: 1 },
    ]));
    const all = await new EntryStore(file).load();
    assert.deepStrictEqual(all.map((e) => e.order), [0, 1]);
    assert.deepStrictEqual(all.map((e) => e.name), ['a', 'b']);
  });

  it('自动创建父目录', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxstore-')), 'a', 'b', 'terminals.json');
    const store = new EntryStore(file);
    await store.save([entry()]);
    assert.strictEqual(fs.existsSync(file), true);
  });

  it('add 追加条目', async () => {
    const store = new EntryStore(tmpFile());
    await store.add(entry({ name: 'one' }));
    await store.add(entry({ name: 'two' }));
    const all = await store.load();
    assert.deepStrictEqual(all.map((e) => e.name), ['one', 'two']);
  });

  it('update 只改指定字段', async () => {
    const store = new EntryStore(tmpFile());
    const e = entry();
    await store.add(e);
    await store.update(e.id, { cwd: '/new/path' });
    const [got] = await store.load();
    assert.strictEqual(got.cwd, '/new/path');
    assert.strictEqual(got.name, 'paint-pc');
    assert.strictEqual(got.id, e.id);
  });

  it('remove 按 id 删除', async () => {
    const store = new EntryStore(tmpFile());
    const a = entry({ name: 'a' });
    const b = entry({ name: 'b' });
    await store.add(a);
    await store.add(b);
    await store.remove(a.id);
    const all = await store.load();
    assert.deepStrictEqual(all.map((e) => e.name), ['b']);
  });

  it('findByName 找得到也找得空', async () => {
    const store = new EntryStore(tmpFile());
    await store.add(entry({ name: 'target' }));
    assert.strictEqual((await store.findByName('target'))?.name, 'target');
    assert.strictEqual(await store.findByName('nope'), undefined);
  });

  it('newId 生成不重复的 id', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId()));
    assert.strictEqual(ids.size, 500);
  });

  // 以下两条是并发写入的回归测试。
  // 曾用固定的 `filePath + '.tmp'` 做临时名：两次 save 交错时先完成者把
  // .tmp rename 走，后完成者 rename 时源已不存在 → ENOENT 抛出。
  // 且 add 是 load→改→save，并发 add 会互相覆盖，丢更新。
  it('并发 add 不抛错，且两条都保住（不丢更新）', async () => {
    const store = new EntryStore(tmpFile());
    await Promise.all([
      store.add(entry({ name: 'a' })),
      store.add(entry({ name: 'b' })),
      store.add(entry({ name: 'c' })),
      store.add(entry({ name: 'd' })),
      store.add(entry({ name: 'e' })),
    ]);
    const names = (await store.load()).map((e) => e.name).sort();
    assert.deepStrictEqual(names, ['a', 'b', 'c', 'd', 'e']);
  });

  it('并发混合增删改不抛错，最终状态一致', async () => {
    const store = new EntryStore(tmpFile());
    const keep = entry({ name: 'keep' });
    await store.add(keep);
    await Promise.all([
      store.add(entry({ name: 'x' })),
      store.update(keep.id, { cwd: '/changed' }),
      store.add(entry({ name: 'y' })),
    ]);
    const all = await store.load();
    assert.strictEqual(all.length, 3);
    assert.strictEqual(all.find((e) => e.id === keep.id)?.cwd, '/changed');
  });

  it('并发写不留下 .tmp 残留', async () => {
    const file = tmpFile();
    const store = new EntryStore(file);
    await Promise.all([store.add(entry({ name: 'a' })), store.add(entry({ name: 'b' }))]);
    const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp'));
    assert.deepStrictEqual(leftovers, []);
  });
});

describe('EntryStore v1 迁移', () => {
  it('v1 文件能读出 v2 条目且一条不丢（回归：曾会被静默过滤）', async () => {
    const f = tmpFile();
    fs.writeFileSync(f, JSON.stringify([
      { id: '9b96d6ac7a3f', name: '统筹者', cwd: '/w', commands: ['claude --dangerously-skip-permissions'], autoRestore: true },
      { id: 'dab74caad49b', name: '咨询', cwd: '/w', commands: ['claude --dangerously-skip-permissions'], autoRestore: true },
      { id: '1942d99d7238', name: 'UI', cwd: '/w/t', commands: ['claude-direct --dangerously-skip-permissions'], autoRestore: true },
    ], null, 2));
    const all = await new EntryStore(f).load();
    assert.strictEqual(all.length, 3, '三条都必须保留');
    assert.deepStrictEqual(all.map((e) => e.profile), ['ccr', 'ccr', 'direct']);
    assert.deepStrictEqual(all.map((e) => e.order), [0, 1, 2]);
  });

  it('load() 不改写用户文件（不能只是打开扩展就动用户数据）', async () => {
    const f = tmpFile();
    const original = JSON.stringify([{ id: 'a', name: 'n', cwd: '/w', commands: [], autoRestore: true }]);
    fs.writeFileSync(f, original);
    await new EntryStore(f).load();
    assert.strictEqual(fs.readFileSync(f, 'utf8'), original, '文件必须原样');
  });

  it('migrateAndBackup 备份一次，且重复调用不覆盖已有备份', async () => {
    const f = tmpFile();
    fs.writeFileSync(f, JSON.stringify([{ id: 'a', name: 'n', cwd: '/w', commands: [], autoRestore: true }]));
    const s = new EntryStore(f);
    assert.strictEqual(await s.migrateAndBackup(), true);
    const bak1 = fs.readFileSync(f + '.bak', 'utf8');
    assert.ok(bak1.includes('"commands"'), '备份必须是 v1 原文');
    assert.strictEqual(await s.migrateAndBackup(), false);
    assert.strictEqual(fs.readFileSync(f + '.bak', 'utf8'), bak1, '备份不能被覆盖');
  });
});

describe('EntryStore.load 对会话槽的归一化', () => {
  /** 写一份 v3 清单（条目级字段给足，槽由调用方指定）。 */
  const writeV3 = (file: string, sessions: unknown[]): void => {
    fs.writeFileSync(file, JSON.stringify([
      { id: 'e1', name: 'n', cwd: '/w', profile: 'ccr', autoRestore: true, order: 0, sessions },
    ]));
  };

  it('★ 负数 order 钳到 0（与条目 order 同一条契约）', async () => {
    const f = tmpFile();
    writeV3(f, [{ id: 's1', order: -9 }, { id: 's2', order: 3 }]);
    const [e] = await new EntryStore(f).load();
    assert.deepStrictEqual(e.sessions.map((s) => s.order), [0, 3]);
    assert.deepStrictEqual(e.sessions.map((s) => s.id), ['s1', 's2']);
  });

  it('★ 按 order 升序，order 相同保持原下标顺序（稳定）', async () => {
    const f = tmpFile();
    writeV3(f, [
      { id: 'c', order: 2 }, { id: 'a', order: 0 }, { id: 'b1', order: 1 }, { id: 'b2', order: 1 },
    ]);
    const [e] = await new EntryStore(f).load();
    assert.deepStrictEqual(e.sessions.map((s) => s.id), ['a', 'b1', 'b2', 'c']);
  });

  it('load 不改写文件（归一化只在内存里）', async () => {
    const f = tmpFile();
    writeV3(f, [{ id: 's1', order: -9 }]);
    const original = fs.readFileSync(f, 'utf8');
    await new EntryStore(f).load();
    assert.strictEqual(fs.readFileSync(f, 'utf8'), original, '文件必须原样');
  });
});

describe('EntryStore.updateSession', () => {
  const fileWith = (sessions: unknown[]): { f: string; s: EntryStore } => {
    const f = tmpFile();
    fs.writeFileSync(f, JSON.stringify([
      { id: 'e1', name: 'n', cwd: '/w', profile: 'ccr', autoRestore: true, order: 0, sessions },
    ]));
    return { f, s: new EntryStore(f) };
  };
  const slots = async (s: EntryStore) => (await s.load())[0].sessions;

  it('只改指定槽的字段，其余槽与条目字段不动', async () => {
    const { s } = fileWith([{ id: 's1', order: 0 }, { id: 's2', order: 1 }]);
    await s.updateSession('e1', 's2', { conversationId: 'conv-2' });
    const all = await slots(s);
    assert.strictEqual(all[1].conversationId, 'conv-2');
    assert.strictEqual(all[0].conversationId, undefined, '别的槽不能被顺带改到');
    assert.strictEqual(all[1].order, 1);
    assert.strictEqual((await s.load())[0].name, 'n');
  });

  it('★ 并发改同一终端的两个槽，两个改动都必须在（不丢更新）', async () => {
    // 回归：槽级改动若在锁外「load → 改数组 → update」，后写者会拿着同一份
    // 旧快照把先写者盖掉，表现为「改绑偶尔不生效」。
    const { s } = fileWith([{ id: 's1', order: 0 }, { id: 's2', order: 1 }]);
    await Promise.all([
      s.updateSession('e1', 's1', { conversationId: 'conv-1', liveSessionId: 'conv-1' }),
      s.updateSession('e1', 's2', { conversationId: 'conv-2', liveSessionId: 'conv-2' }),
    ]);
    const all = await slots(s);
    assert.deepStrictEqual(
      all.map((x) => [x.id, x.conversationId]),
      [['s1', 'conv-1'], ['s2', 'conv-2']],
      '两次改动都必须落盘',
    );
  });

  it('★ 补丁里带 id 不得改写槽 id（那等于换一个 tmux 会话）', async () => {
    const { s } = fileWith([{ id: 's1', order: 0 }]);
    await s.updateSession('e1', 's1', { id: 'HACKED', conversationId: 'c' } as never);
    const all = await slots(s);
    assert.strictEqual(all[0].id, 's1');
    assert.strictEqual(all[0].conversationId, 'c', '其余字段照常合并');
  });

  it('条目不存在 / 槽不存在 → 安全 no-op，不抛错也不写盘', async () => {
    const { f, s } = fileWith([{ id: 's1', order: 0 }]);
    const before = fs.readFileSync(f, 'utf8');
    await s.updateSession('nope', 's1', { conversationId: 'c' });
    await s.updateSession('e1', 'nope', { conversationId: 'c' });
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before);
  });
});

describe('EntryStore.addSession', () => {
  const fileWith = (sessions: unknown[]): { f: string; s: EntryStore } => {
    const f = tmpFile();
    fs.writeFileSync(f, JSON.stringify([
      { id: 'e1', name: 'n', cwd: '/w', profile: 'ccr', autoRestore: true, order: 0, sessions },
    ]));
    return { f, s: new EntryStore(f) };
  };

  it('order 在锁内分配：连续两次 add 得到不同的 order', async () => {
    const { s } = fileWith([{ id: 's1', order: 0 }]);
    await s.addSession('e1', { id: 's2' });
    await s.addSession('e1', { id: 's3' });
    const sessions = (await s.load())[0].sessions;
    assert.deepStrictEqual(sessions.map((x) => x.id), ['s1', 's2', 's3']);
    assert.strictEqual(new Set(sessions.map((x) => x.order)).size, 3, 'order 不能撞号');
  });

  it('★ 并发 add 不产生相同 order（回归：order 不能在调用方算）', async () => {
    const { s } = fileWith([{ id: 's1', order: 0 }]);
    await Promise.all([s.addSession('e1', { id: 's2' }), s.addSession('e1', { id: 's3' })]);
    const sessions = (await s.load())[0].sessions;
    assert.strictEqual(sessions.length, 3, '两个槽都必须留下');
    assert.strictEqual(new Set(sessions.map((x) => x.order)).size, 3);
  });

  it('order 取 max + 1（不是 length）：删过中间槽也不会撞号', async () => {
    const { s } = fileWith([{ id: 's1', order: 0 }, { id: 's2', order: 7 }]);
    await s.addSession('e1', { id: 's3' });
    const sessions = (await s.load())[0].sessions;
    assert.strictEqual(sessions.find((x) => x.id === 's3')?.order, 8);
  });

  it('条目不存在 → 安全 no-op', async () => {
    const { f, s } = fileWith([{ id: 's1', order: 0 }]);
    const before = fs.readFileSync(f, 'utf8');
    await s.addSession('nope', { id: 'sx' });
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before);
  });

  it('★ 调用方预分配的 conversationId 原样落盘（「+」新建的槽一出生就带着它）', async () => {
    const { s } = fileWith([{ id: 's1', order: 0 }]);
    await s.addSession('e1', { id: 's2', conversationId: 'conv-new' });
    const added = (await s.load())[0].sessions.find((x) => x.id === 's2');
    assert.strictEqual(added?.conversationId, 'conv-new');
  });

  it('新槽上没有 liveSessionId —— 预分配的是「还没有 .jsonl」的 id，不是已观测值', async () => {
    const { s } = fileWith([{ id: 's1', order: 0, liveSessionId: 'conv-observed' }]);
    await s.addSession('e1', { id: 's2', conversationId: 'conv-new' });
    const loaded = (await s.load())[0].sessions;
    assert.strictEqual(loaded.find((x) => x.id === 's2')?.liveSessionId, undefined);
    assert.strictEqual(loaded.find((x) => x.id === 's1')?.liveSessionId, 'conv-observed',
      '既有槽的观测值不受影响');
  });
});

describe('EntryStore.removeSession', () => {
  const fileWith = (sessions: unknown[]): { f: string; s: EntryStore } => {
    const f = tmpFile();
    fs.writeFileSync(f, JSON.stringify([
      { id: 'e1', name: 'n', cwd: '/w', profile: 'ccr', autoRestore: true, order: 0, sessions },
    ]));
    return { f, s: new EntryStore(f) };
  };

  it('只删指定槽，其余槽与条目原样保留', async () => {
    const { s } = fileWith([
      { id: 's1', order: 0, conversationId: 'c1' },
      { id: 's2', order: 1, conversationId: 'c2' },
    ]);
    await s.removeSession('e1', 's1');
    const all = await s.load();
    assert.strictEqual(all.length, 1, '条目必须留下');
    assert.deepStrictEqual(all[0].sessions.map((x) => x.id), ['s2']);
    assert.strictEqual(all[0].sessions[0].conversationId, 'c2');
  });

  it('可以删到空数组（`sessions: []` 是 v3 的合法状态）', async () => {
    const { s } = fileWith([{ id: 's1', order: 0 }]);
    await s.removeSession('e1', 's1');
    assert.deepStrictEqual((await s.load())[0].sessions, []);
  });

  it('条目不存在 / 槽不存在 → 安全 no-op（幂等，删两次不炸）', async () => {
    const { f, s } = fileWith([{ id: 's1', order: 0 }]);
    await s.removeSession('nope', 's1');
    await s.removeSession('e1', 'nope');
    assert.strictEqual((await s.load())[0].sessions.length, 1);
    await s.removeSession('e1', 's1');
    const after = fs.readFileSync(f, 'utf8');
    await s.removeSession('e1', 's1'); // 再删一次
    assert.strictEqual(fs.readFileSync(f, 'utf8'), after);
  });
});

describe('EntryStore v2 迁移备份（<file>.v2.bak）', () => {
  const V1 = JSON.stringify([{ id: 'a', name: 'n', cwd: '/w', commands: [], autoRestore: true }]);
  const V2 = JSON.stringify([
    { id: 'a', name: 'n', cwd: '/w', profile: 'ccr', autoRestore: true, order: 0, conversationId: 'c' },
  ]);
  const V3 = JSON.stringify([
    { id: 'a', name: 'n', cwd: '/w', profile: 'ccr', autoRestore: true, order: 0, sessions: [{ id: 'a', order: 0 }] },
  ]);

  it('v2 文件 → 写 .v2.bak，内容等于原文', async () => {
    const f = tmpFile();
    fs.writeFileSync(f, V2);
    const s = new EntryStore(f);
    assert.strictEqual(await s.migrateAndBackupV2(), true);
    assert.strictEqual(fs.readFileSync(f + '.v2.bak', 'utf8'), V2);
  });

  it('已有 .v2.bak 不覆盖（第一份才是原始数据）', async () => {
    const f = tmpFile();
    fs.writeFileSync(f, V2);
    fs.writeFileSync(f + '.v2.bak', 'PRIOR');
    assert.strictEqual(await new EntryStore(f).migrateAndBackupV2(), false);
    assert.strictEqual(fs.readFileSync(f + '.v2.bak', 'utf8'), 'PRIOR');
  });

  it('★ v1 文件不写 .v2.bak（备份名必须诚实：那份是 v1，归 .bak）', async () => {
    const f = tmpFile();
    fs.writeFileSync(f, V1);
    assert.strictEqual(await new EntryStore(f).migrateAndBackupV2(), false);
    assert.strictEqual(fs.existsSync(f + '.v2.bak'), false);
  });

  it('★ v3 文件一个备份都不写', async () => {
    const f = tmpFile();
    fs.writeFileSync(f, V3);
    const s = new EntryStore(f);
    assert.strictEqual(await s.migrateAndBackupV2(), false);
    assert.strictEqual(await s.migrateAndBackup(), false);
    assert.strictEqual(fs.existsSync(f + '.v2.bak'), false);
    assert.strictEqual(fs.existsSync(f + '.bak'), false);
  });

  it('文件不存在 → false，不抛错', async () => {
    assert.strictEqual(await new EntryStore(tmpFile()).migrateAndBackupV2(), false);
  });
});

describe('EntryStore.append', () => {
  it('order 依次递增，不重复', async () => {
    const f = tmpFile();
    const s = new EntryStore(f);
    // append 收 Omit<TerminalEntry,'order'> —— order 由 store 在锁内分配
    await s.append({ id: 'a', name: 'a', cwd: '/w', profile: 'ccr', autoRestore: true, sessions: [] });
    await s.append({ id: 'b', name: 'b', cwd: '/w', profile: 'ccr', autoRestore: true, sessions: [] });
    const all = await s.load();
    assert.deepStrictEqual(all.map((e) => e.order), [0, 1]);
  });

  it('并发 append 不产生相同 order（回归：order 必须在锁内分配）', async () => {
    const f = tmpFile();
    const s = new EntryStore(f);
    await Promise.all([
      s.append({ id: 'a', name: 'a', cwd: '/w', profile: 'ccr', autoRestore: true, sessions: [] }),
      s.append({ id: 'b', name: 'b', cwd: '/w', profile: 'ccr', autoRestore: true, sessions: [] }),
    ]);
    const all = await s.load();
    assert.strictEqual(all.length, 2);
    assert.deepStrictEqual(all.map((e) => e.order).sort(), [0, 1], 'order 不能相同');
  });
});

describe('EntryStore.reorder', () => {
  it('按给定顺序重编号 order', async () => {
    const f = tmpFile();
    const s = new EntryStore(f);
    for (const id of ['a', 'b', 'c']) await s.append({ id, name: id, cwd: '/w', profile: 'ccr', autoRestore: true, sessions: [] });
    await s.reorder(['c', 'a', 'b']);
    const all = await s.load();
    assert.deepStrictEqual(all.map((e) => e.id), ['c', 'a', 'b']);
    assert.deepStrictEqual(all.map((e) => e.order), [0, 1, 2]);
  });

  it('并发 reorder 不丢更新（回归：v1 曾因并发 load→save 丢数据）', async () => {
    const f = tmpFile();
    const s = new EntryStore(f);
    for (const id of ['a', 'b', 'c']) await s.append({ id, name: id, cwd: '/w', profile: 'ccr', autoRestore: true, sessions: [] });
    await Promise.all([s.reorder(['b', 'c', 'a']), s.reorder(['c', 'b', 'a'])]);
    const all = await s.load();
    assert.strictEqual(all.length, 3, '不能丢条目');
    assert.deepStrictEqual(all.map((e) => e.order).sort(), [0, 1, 2], 'order 必须连续不重复');
  });
});
