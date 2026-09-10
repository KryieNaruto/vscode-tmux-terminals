import * as assert from 'assert';
import { isV1Shape, migrateEntry } from '../../src/core/migrate';

const v1 = (p: Record<string, unknown> = {}) => ({
  id: '9b96d6ac7a3f', name: '统筹者', cwd: '/ssd/qiansenwei/workspace',
  commands: ['claude --dangerously-skip-permissions'], autoRestore: true, ...p,
});

describe('isV1Shape', () => {
  it('有 commands 数组即 v1', () => {
    assert.strictEqual(isV1Shape(v1()), true);
  });

  it('v2 形态不是 v1', () => {
    assert.strictEqual(isV1Shape({ id: 'a', name: 'n', cwd: '/t', profile: 'ccr', autoRestore: true, order: 0 }), false);
  });

  it('垃圾输入不是 v1', () => {
    assert.strictEqual(isV1Shape(null), false);
    assert.strictEqual(isV1Shape(42), false);
  });
});

describe('migrateEntry', () => {
  it('commands 含 claude-direct → direct', () => {
    const m = migrateEntry(v1({ commands: ['claude-direct --dangerously-skip-permissions'] }), 0);
    assert.strictEqual(m?.profile, 'direct');
  });

  it('普通 claude → ccr', () => {
    assert.strictEqual(migrateEntry(v1(), 0)?.profile, 'ccr');
  });

  it('保留 id/name/cwd/autoRestore，order 取下标，model 留空', () => {
    const m = migrateEntry(v1(), 3)!;
    assert.strictEqual(m.id, '9b96d6ac7a3f');
    assert.strictEqual(m.name, '统筹者');
    assert.strictEqual(m.cwd, '/ssd/qiansenwei/workspace');
    assert.strictEqual(m.autoRestore, true);
    assert.strictEqual(m.order, 3);
    assert.strictEqual(m.model, undefined);
  });

  it('空 commands 数组 → ccr（不猜）', () => {
    assert.strictEqual(migrateEntry(v1({ commands: [] }), 0)?.profile, 'ccr');
  });

  it('commands 非字符串数组 → 判为不可迁移', () => {
    assert.strictEqual(migrateEntry(v1({ commands: [1, 2] }), 0), undefined);
  });

  it('缺 id 或 name → 判为不可迁移', () => {
    assert.strictEqual(migrateEntry({ name: 'n', cwd: '/t', commands: [] }, 0), undefined);
    assert.strictEqual(migrateEntry({ id: 'a', cwd: '/t', commands: [] }, 0), undefined);
  });

  it('已是 v2 形态 → 原样返回（幂等，不能重复迁移）', () => {
    const v2 = { id: 'a', name: 'n', cwd: '/t', profile: 'direct', model: 'm', autoRestore: false, order: 7 };
    assert.deepStrictEqual(migrateEntry(v2, 0), v2);
  });
});
