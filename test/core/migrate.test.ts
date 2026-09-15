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

describe('conversationId 迁移 —— 保留已有绑定，绝不编造', () => {
  it('v2 条目带 conversationId → 原样保留（不能被迁移吞掉）', () => {
    const id = '7af4c86a-ea5d-4f25-9d9c-8ba7e620a5a0';
    const v2 = { id: 'a', name: 'n', cwd: '/t', profile: 'ccr', autoRestore: true, order: 1, conversationId: id };
    assert.strictEqual(migrateEntry(v2, 0)?.conversationId, id);
  });

  it('★ v2 条目没有 conversationId → 保持 undefined（不猜、不编造）', () => {
    const v2 = { id: 'a', name: 'n', cwd: '/t', profile: 'ccr', autoRestore: true, order: 1 };
    assert.strictEqual(migrateEntry(v2, 0)?.conversationId, undefined);
  });

  it('v1 条目（本来就没有这个概念）→ undefined', () => {
    assert.strictEqual(migrateEntry(v1({ commands: [] }), 0)?.conversationId, undefined);
  });

  it('非字符串 / 空串的 conversationId 视为未绑定（手改坏了不至于崩）', () => {
    const base = { id: 'a', name: 'n', cwd: '/t', profile: 'ccr', autoRestore: true, order: 1 };
    assert.strictEqual(migrateEntry({ ...base, conversationId: 42 }, 0)?.conversationId, undefined);
    assert.strictEqual(migrateEntry({ ...base, conversationId: '' }, 0)?.conversationId, undefined);
  });
});

describe('liveSessionId 迁移 —— 只记录观测值，绝不编造', () => {
  it('v2 条目带 liveSessionId → 原样保留（不能被迁移吞掉）', () => {
    const id = '7af4c86a-ea5d-4f25-9d9c-8ba7e620a5a0';
    const v2 = {
      id: 'a', name: 'n', cwd: '/t', profile: 'ccr', autoRestore: true, order: 1,
      conversationId: id, liveSessionId: id,
    };
    assert.strictEqual(migrateEntry(v2, 0)?.liveSessionId, id);
  });

  it('★ v2 条目没有 liveSessionId → 保持 undefined（语义正是「从未观测过」）', () => {
    const v2 = { id: 'a', name: 'n', cwd: '/t', profile: 'ccr', autoRestore: true, order: 1 };
    assert.strictEqual(migrateEntry(v2, 0)?.liveSessionId, undefined);
  });

  it('v1 条目（本来就没有这个概念）→ undefined', () => {
    assert.strictEqual(migrateEntry(v1({ commands: [] }), 0)?.liveSessionId, undefined);
  });

  it('非字符串 / 空串的 liveSessionId 视为「从未观测过」（手改坏了不至于崩）', () => {
    const base = { id: 'a', name: 'n', cwd: '/t', profile: 'ccr', autoRestore: true, order: 1 };
    assert.strictEqual(migrateEntry({ ...base, liveSessionId: 42 }, 0)?.liveSessionId, undefined);
    assert.strictEqual(migrateEntry({ ...base, liveSessionId: '' }, 0)?.liveSessionId, undefined);
  });

  it('liveSessionId 与 conversationId 各自独立带过（不互相覆盖）', () => {
    const v2 = {
      id: 'a', name: 'n', cwd: '/t', profile: 'ccr', autoRestore: true, order: 1,
      conversationId: '手动选的', liveSessionId: '亲眼看到的',
    };
    const m = migrateEntry(v2, 0)!;
    assert.strictEqual(m.conversationId, '手动选的');
    assert.strictEqual(m.liveSessionId, '亲眼看到的');
  });
});
