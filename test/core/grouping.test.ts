import * as assert from 'assert';
import { groupByCwd } from '../../src/core/grouping';
import { TerminalEntry } from '../../src/core/types';

const mk = (id: string, cwd: string): TerminalEntry => ({
  id, name: id, cwd, profile: 'ccr', autoRestore: true, order: 0,
  // 夹具补 `sessions`（v3 的必需字段）：本文件验的是**按 cwd 分组**，与槽无关。
  // 断言一个字没动。
  sessions: [],
});

describe('groupByCwd', () => {
  it('cwd 相同的条目分到同一组，组内保持输入顺序', () => {
    const a1 = mk('a1', '/x');
    const a2 = mk('a2', '/x');
    const b1 = mk('b1', '/y');
    const groups = groupByCwd([a1, b1, a2]);
    assert.deepStrictEqual(groups, [
      ['/x', [a1, a2]],
      ['/y', [b1]],
    ]);
  });

  it('单个条目也独立成组', () => {
    const a = mk('a', '/x');
    assert.deepStrictEqual(groupByCwd([a]), [['/x', [a]]]);
  });

  it('空输入返回空数组', () => {
    assert.deepStrictEqual(groupByCwd([]), []);
  });

  it('组的先后顺序按各组第一次出现的位置，不额外排序', () => {
    const b1 = mk('b1', '/y');
    const a1 = mk('a1', '/x');
    const b2 = mk('b2', '/y');
    const groups = groupByCwd([b1, a1, b2]);
    assert.deepStrictEqual(groups.map(([cwd]) => cwd), ['/y', '/x']);
  });
});
