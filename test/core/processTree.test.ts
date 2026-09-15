import * as assert from 'assert';
import { descendantsOf, parseProcTable } from '../../src/core/processTree';

describe('parseProcTable —— 解析 `ps -eo pid=,ppid=` 的输出', () => {
  it('解析 pid/ppid 两列（ps 带前导空白）', () => {
    assert.deepStrictEqual(parseProcTable('  1     0\n  2     1\n'), [
      { pid: 1, ppid: 0 },
      { pid: 2, ppid: 1 },
    ]);
  });

  it('空串 → []', () => {
    assert.deepStrictEqual(parseProcTable(''), []);
  });

  it('首尾空白、多空格、空行都能容忍', () => {
    assert.deepStrictEqual(parseProcTable('\n   287661    1234   \n\n'), [
      { pid: 287661, ppid: 1234 },
    ]);
  });

  it('缺列 / 非数字的行一律跳过，绝不抛错', () => {
    assert.deepStrictEqual(parseProcTable('1 2\nonlypid\nx y\n3 4\n'), [
      { pid: 1, ppid: 2 },
      { pid: 3, ppid: 4 },
    ]);
  });

  it('pid <= 0 的行跳过（0 = 内核调度器，不是真实进程）', () => {
    assert.deepStrictEqual(parseProcTable('-1 0\n0 0\n5 0\n'), [{ pid: 5, ppid: 0 }]);
  });
});

describe('descendantsOf —— rootPid 的全部后代（含各层，不含自身）', () => {
  const t = (rows: Array<[number, number]>) => rows.map(([pid, ppid]) => ({ pid, ppid }));

  it('直接子进程（pane_pid → claude）', () => {
    assert.deepStrictEqual(descendantsOf(t([[100, 1], [200, 100]]), 100), [200]);
  });

  it('多层（pane_pid → shell → 更深的 claude）', () => {
    assert.deepStrictEqual(descendantsOf(t([[100, 1], [150, 100], [200, 150]]), 100), [150, 200]);
  });

  it('同一 root 下多个后代全部返回（一个 pane 下不止一个 claude）', () => {
    assert.deepStrictEqual(descendantsOf(t([[100, 1], [200, 100], [201, 100]]), 100).sort((a, b) => a - b), [200, 201]);
  });

  it('结果不含 root 自身', () => {
    assert.strictEqual(descendantsOf(t([[100, 1], [200, 100]]), 100).includes(100), false);
  });

  it('root 不在表里 → []', () => {
    assert.deepStrictEqual(descendantsOf(t([[1, 0], [2, 1]]), 999), []);
  });

  it('★ 表里有环也必须安全终止（100 ← 300 ← 200 ← 100）', () => {
    const cyclic = t([[100, 1], [200, 100], [300, 200], [100, 300]]);
    assert.deepStrictEqual(descendantsOf(cyclic, 100).sort((a, b) => a - b), [200, 300]);
  });

  it('pid 重复出现也只返回一次', () => {
    assert.deepStrictEqual(descendantsOf(t([[100, 1], [200, 100], [200, 100]]), 100), [200]);
  });
});
