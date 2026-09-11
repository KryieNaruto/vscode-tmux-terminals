import * as assert from 'assert';
import { reorderWithinGroup } from '../../src/core/reorder';

describe('reorderWithinGroup', () => {
  it('组内插到中间，组外 id 原样保留在原位置', () => {
    const all = ['x1', 'a', 'x2', 'b', 'c', 'x3'];
    const group = ['a', 'b', 'c'];
    const result = reorderWithinGroup(all, group, ['c'], 'a');
    assert.deepStrictEqual(result, ['x1', 'c', 'x2', 'a', 'b', 'x3']);
  });

  it('落到组尾（targetId undefined = 拖到空白处）', () => {
    const all = ['a', 'b', 'c'];
    const result = reorderWithinGroup(all, all, ['a'], undefined);
    assert.deepStrictEqual(result, ['b', 'c', 'a']);
  });

  it('拖拽多个 id，保持它们之间的相对顺序', () => {
    const all = ['a', 'b', 'c', 'd'];
    const result = reorderWithinGroup(all, all, ['a', 'c'], 'b');
    assert.deepStrictEqual(result, ['a', 'c', 'b', 'd']);
  });

  it('组外 id 的相对顺序绝不改变（哪怕组内重排剧烈）', () => {
    const all = ['x1', 'a', 'x2', 'b', 'x3'];
    const group = ['a', 'b'];
    const before = all.filter((id) => !group.includes(id));
    const result = reorderWithinGroup(all, group, ['b'], 'a');
    const after = result.filter((id) => !group.includes(id));
    assert.deepStrictEqual(after, before);
  });

  it('targetId 恰好是被拖拽 id 之一时退化为「插到组尾」（调用方应已提前拦截，这里只保证纯函数自身不崩溃）', () => {
    const all = ['a', 'b', 'c'];
    const result = reorderWithinGroup(all, all, ['a'], 'a');
    assert.deepStrictEqual(result, ['b', 'c', 'a']);
  });
});
