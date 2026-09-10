import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EntryStore, newId } from '../../src/core/store';
import { TerminalEntry } from '../../src/core/types';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxstore-')), 'terminals.json');
}

/** 原有用例的 v2 条目构造器（id 用 newId 保证唯一，供 add/remove/update 用）。 */
const entry = (over: Partial<TerminalEntry> = {}): TerminalEntry => ({
  id: newId(),
  name: 'paint-pc',
  cwd: '~/mine/paint-pc',
  profile: 'ccr',
  autoRestore: true,
  order: 0,
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

describe('EntryStore.append', () => {
  it('order 依次递增，不重复', async () => {
    const f = tmpFile();
    const s = new EntryStore(f);
    // append 收 Omit<TerminalEntry,'order'> —— order 由 store 在锁内分配
    await s.append({ id: 'a', name: 'a', cwd: '/w', profile: 'ccr', autoRestore: true });
    await s.append({ id: 'b', name: 'b', cwd: '/w', profile: 'ccr', autoRestore: true });
    const all = await s.load();
    assert.deepStrictEqual(all.map((e) => e.order), [0, 1]);
  });

  it('并发 append 不产生相同 order（回归：order 必须在锁内分配）', async () => {
    const f = tmpFile();
    const s = new EntryStore(f);
    await Promise.all([
      s.append({ id: 'a', name: 'a', cwd: '/w', profile: 'ccr', autoRestore: true }),
      s.append({ id: 'b', name: 'b', cwd: '/w', profile: 'ccr', autoRestore: true }),
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
    for (const id of ['a', 'b', 'c']) await s.append({ id, name: id, cwd: '/w', profile: 'ccr', autoRestore: true });
    await s.reorder(['c', 'a', 'b']);
    const all = await s.load();
    assert.deepStrictEqual(all.map((e) => e.id), ['c', 'a', 'b']);
    assert.deepStrictEqual(all.map((e) => e.order), [0, 1, 2]);
  });

  it('并发 reorder 不丢更新（回归：v1 曾因并发 load→save 丢数据）', async () => {
    const f = tmpFile();
    const s = new EntryStore(f);
    for (const id of ['a', 'b', 'c']) await s.append({ id, name: id, cwd: '/w', profile: 'ccr', autoRestore: true });
    await Promise.all([s.reorder(['b', 'c', 'a']), s.reorder(['c', 'b', 'a'])]);
    const all = await s.load();
    assert.strictEqual(all.length, 3, '不能丢条目');
    assert.deepStrictEqual(all.map((e) => e.order).sort(), [0, 1, 2], 'order 必须连续不重复');
  });
});
