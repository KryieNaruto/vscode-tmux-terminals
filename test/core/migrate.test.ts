import * as assert from 'assert';
import { isV1Shape, isV2Shape, migrateEntry } from '../../src/core/migrate';

const v1 = (p: Record<string, unknown> = {}) => ({
  id: '9b96d6ac7a3f', name: '统筹者', cwd: '/ssd/qiansenwei/workspace',
  commands: ['claude --dangerously-skip-permissions'], autoRestore: true, ...p,
});

/** v2 形态（无 commands、无 sessions）。 */
const v2 = (p: Record<string, unknown> = {}) => ({
  id: 'a', name: 'n', cwd: '/t', profile: 'ccr', autoRestore: true, order: 1, ...p,
});

describe('isV1Shape', () => {
  it('有 commands 数组即 v1', () => {
    assert.strictEqual(isV1Shape(v1()), true);
  });

  it('v2 形态不是 v1', () => {
    assert.strictEqual(isV1Shape(v2()), false);
  });

  it('垃圾输入不是 v1', () => {
    assert.strictEqual(isV1Shape(null), false);
    assert.strictEqual(isV1Shape(42), false);
  });
});

describe('isV2Shape —— 备份名的判据，必须诚实', () => {
  it('v2 形态 → true', () => {
    assert.strictEqual(isV2Shape(v2()), true);
  });

  it('★ v1 → false（有 commands 数组；它的备份归 .bak）', () => {
    assert.strictEqual(isV2Shape(v1()), false);
  });

  it('★ v3 → false（有 sessions 数组；v3 一个备份都不写）', () => {
    assert.strictEqual(isV2Shape(v2({ sessions: [] })), false);
  });

  it('非对象 / 缺 id / 缺 name / 缺 cwd → false', () => {
    assert.strictEqual(isV2Shape(null), false);
    assert.strictEqual(isV2Shape(42), false);
    assert.strictEqual(isV2Shape('x'), false);
    assert.strictEqual(isV2Shape({ name: 'n', cwd: '/t' }), false);
    assert.strictEqual(isV2Shape({ id: 'a', cwd: '/t' }), false);
    assert.strictEqual(isV2Shape({ id: 'a', name: 'n' }), false);
  });
});

describe('migrateEntry —— v1 → v3', () => {
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

  it('★ v1 必须合成出槽（不是 sessions: []），且槽 id = 原条目 id', () => {
    // 给空槽的后果：老用户升级后那个正在跑的 claude **在树上没有任何一行可以
    // 点** —— v1 的 tmux 会话名同样是 `tmuxterm-<entryId>`，条目还是个不可展开
    // 的哑节点，既接不回也杀不掉。
    const m = migrateEntry(v1(), 0)!;
    assert.strictEqual(m.sessions.length, 1);
    assert.strictEqual(m.sessions[0].id, '9b96d6ac7a3f');
  });

  it('★ v1 合成出的槽没有对话绑定（v1 没有对话这个概念，不编造）', () => {
    const m = migrateEntry(v1(), 0)!;
    assert.strictEqual(m.sessions[0].conversationId, undefined);
    assert.strictEqual(m.sessions[0].liveSessionId, undefined);
    assert.strictEqual(m.sessions[0].order, 0);
  });
});

describe('migrateEntry —— v2 → v3 合成槽', () => {
  it('已是 v2 形态 → 整条形状（合成恰好一个槽）', () => {
    const src = { id: 'a', name: 'n', cwd: '/t', profile: 'direct', model: 'm', autoRestore: false, order: 7 };
    assert.deepStrictEqual(migrateEntry(src, 0), {
      id: 'a', name: 'n', cwd: '/t', profile: 'direct', model: 'm',
      sessions: [{ id: 'a', order: 0 }],
      autoRestore: false, order: 7,
    });
  });

  it('★ v2 合成出的槽 id 必须等于原条目 id（写错让在跑的会话变「无会话」）', () => {
    // 这是整个迁移里唯一不能写错的一行：v2 的 tmux 会话名就是
    // `tmuxterm-<entryId>`，换成新 id 会让扩展把它当成「不存在」→ 新建一个
    // 意图相同的会话 → 旧 claude 成孤儿、两个进程同写一条 .jsonl。
    const m = migrateEntry(v2({ id: 'f00dcafe1234' }), 0)!;
    assert.strictEqual(m.sessions.length, 1);
    assert.strictEqual(m.sessions[0].id, 'f00dcafe1234');
  });

  it('★ conversationId / liveSessionId 原样落到那个唯一的槽上，order: 0', () => {
    const id = '7af4c86a-ea5d-4f25-9d9c-8ba7e620a5a0';
    const live = '1b2c3d4e-0000-0000-0000-000000000000';
    const m = migrateEntry(v2({ conversationId: id, liveSessionId: live }), 0)!;
    assert.strictEqual(m.sessions[0].conversationId, id);
    assert.strictEqual(m.sessions[0].liveSessionId, live);
    assert.strictEqual(m.sessions[0].order, 0);
  });

  it('★ v2 条目没有 conversationId → 槽存在但未绑定（不猜、不编造）', () => {
    const m = migrateEntry(v2(), 0)!;
    assert.strictEqual(m.sessions.length, 1, '槽本身必须有');
    assert.strictEqual(m.sessions[0].conversationId, undefined);
  });

  it('v2 没有 liveSessionId → 保持 undefined（语义正是「从未观测过」）', () => {
    assert.strictEqual(migrateEntry(v2(), 0)!.sessions[0].liveSessionId, undefined);
  });

  it('非字符串 / 空串的绑定视为未设（手改坏了不至于崩）', () => {
    assert.strictEqual(migrateEntry(v2({ conversationId: 42 }), 0)!.sessions[0].conversationId, undefined);
    assert.strictEqual(migrateEntry(v2({ conversationId: '' }), 0)!.sessions[0].conversationId, undefined);
    assert.strictEqual(migrateEntry(v2({ liveSessionId: 42 }), 0)!.sessions[0].liveSessionId, undefined);
    assert.strictEqual(migrateEntry(v2({ liveSessionId: '' }), 0)!.sessions[0].liveSessionId, undefined);
  });

  it('conversationId 与 liveSessionId 各自独立带过（不互相覆盖）', () => {
    const m = migrateEntry(v2({ conversationId: '手动选的', liveSessionId: '亲眼看到的' }), 0)!;
    assert.strictEqual(m.sessions[0].conversationId, '手动选的');
    assert.strictEqual(m.sessions[0].liveSessionId, '亲眼看到的');
  });

  it('v2 条目带 color（手改加的）→ 原样带过', () => {
    // color 是本轮新增的可选字段，v2 正常没有它；但已有人手改加过时不能吞掉。
    const m = migrateEntry(v2({ color: '#aabbcc' }), 0)!;
    assert.strictEqual(m.color, '#aabbcc');
  });

  it('v2 不带 color → 整个键不出现（= 未设，不是 null）', () => {
    assert.strictEqual('color' in migrateEntry(v2(), 0)!, false);
  });

  it('order 缺失时取下标（与 v1 同一条退路）', () => {
    const src = { id: 'a', name: 'n', cwd: '/t', profile: 'ccr', autoRestore: true };
    assert.strictEqual(migrateEntry(src, 5)!.order, 5);
  });
});

describe('migrateEntry —— v3 幂等与逐槽校验', () => {
  const v3 = (sessions: unknown[], extra: Record<string, unknown> = {}) => ({
    id: 'a', name: 'n', cwd: '/t', profile: 'ccr', autoRestore: true, order: 1,
    sessions, ...extra,
  });

  it('★ 已是 v3 形态 → 原样返回（幂等：槽顺序与字段都不动）', () => {
    const src = v3([
      { id: 's2', conversationId: 'c2', liveSessionId: 'l2', order: 3 },
      { id: 's1', conversationId: 'c1', order: 0 },
    ], { model: 'm', color: '#aabbcc' });
    assert.deepStrictEqual(migrateEntry(src, 0), src);
  });

  it('★ 槽 id 非 string / 空串 → 该槽被丢弃，其余槽保留', () => {
    // 判据刻意保持确定性：load() 每次都跑迁移，若给缺 id 的槽现场编一个随机
    // id，同一份文件两次读会得到**不同的 tmux 名**，树在写入发生前一直抖。
    const m = migrateEntry(v3([
      { order: 0 }, { id: '' }, { id: 42 }, { id: 'keep', order: 7 }, null,
    ]), 0)!;
    assert.deepStrictEqual(m.sessions, [{ id: 'keep', order: 7 }]);
  });

  it('槽 order 非 number → 用该槽的下标', () => {
    const m = migrateEntry(v3([{ id: 'a', order: 'x' }, { id: 'b', order: 5 }, { id: 'c' }]), 0)!;
    assert.deepStrictEqual(m.sessions.map((x) => x.order), [0, 5, 2]);
  });

  it('槽 conversationId 非字符串 / 空串 → 视为未设', () => {
    const m = migrateEntry(v3([
      { id: 'a', conversationId: 42, order: 0 },
      { id: 'b', conversationId: '', order: 1 },
    ]), 0)!;
    assert.strictEqual(m.sessions[0].conversationId, undefined);
    assert.strictEqual(m.sessions[1].conversationId, undefined);
  });

  it('★ sessions: [] → 保持空，绝不回头读顶层 conversationId 复活一个槽', () => {
    // `[]` 是 v3 的合法状态（用户把会话都删了）。复活它 = 凭空造一个会话。
    const src = v3([], { conversationId: 'ghost', liveSessionId: 'ghost' });
    const m = migrateEntry(src, 0)!;
    assert.deepStrictEqual(m.sessions, []);
  });

  it('v3 条目缺 order → 取下标', () => {
    const src = { id: 'a', name: 'n', cwd: '/t', profile: 'ccr', autoRestore: true, sessions: [] };
    assert.strictEqual(migrateEntry(src, 4)!.order, 4);
  });

  it('v3 的 profile 只认 direct，其余一律 ccr', () => {
    assert.strictEqual(migrateEntry(v3([], { profile: 'direct' }), 0)!.profile, 'direct');
    assert.strictEqual(migrateEntry(v3([], { profile: 'whatever' }), 0)!.profile, 'ccr');
  });
});
