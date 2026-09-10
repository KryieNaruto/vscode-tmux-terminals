import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EntryStore, newId } from '../../src/core/store';
import { TerminalEntry } from '../../src/core/types';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxterm-')), 'terminals.json');
}

const entry = (over: Partial<TerminalEntry> = {}): TerminalEntry => ({
  id: newId(),
  name: 'paint-pc',
  cwd: '~/mine/paint-pc',
  commands: ['source env.sh'],
  autoRestore: true,
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
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxterm-')), 'a', 'b', 'terminals.json');
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
});
