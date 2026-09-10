import * as assert from 'assert';
import { planRestore } from '../../src/core/plan';
import { TerminalEntry } from '../../src/core/types';

const entry: TerminalEntry = {
  id: 'a1',
  name: 'paint-pc',
  cwd: '~/mine/paint-pc',
  commands: ['source env.sh', 'ls'],
  autoRestore: true,
};

describe('planRestore', () => {
  it('会话存活 → attach，且命令必须为空', () => {
    const plan = planRestore(entry, true);
    assert.strictEqual(plan.mode, 'attach');
    assert.deepStrictEqual(plan.commands, []);
  });

  it('会话存活时绝不带命令（防止把命令塞进运行中进程的 stdin）', () => {
    const plan = planRestore({ ...entry, commands: ['rm -rf /tmp/x'] }, true);
    assert.strictEqual(plan.commands.length, 0);
  });

  it('会话不存在 → create，并带上全部预设命令', () => {
    const plan = planRestore(entry, false);
    assert.strictEqual(plan.mode, 'create');
    assert.deepStrictEqual(plan.commands, ['source env.sh', 'ls']);
  });

  it('create 时返回的是副本，改动不影响原条目', () => {
    const plan = planRestore(entry, false);
    plan.commands.push('mutated');
    assert.deepStrictEqual(entry.commands, ['source env.sh', 'ls']);
  });

  it('无预设命令时 create 返回空数组', () => {
    const plan = planRestore({ ...entry, commands: [] }, false);
    assert.strictEqual(plan.mode, 'create');
    assert.deepStrictEqual(plan.commands, []);
  });
});
