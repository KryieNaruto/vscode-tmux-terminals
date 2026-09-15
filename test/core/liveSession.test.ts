import * as assert from 'assert';
import { SessionRecord, parseSessionRecord, pickLiveSession } from '../../src/core/liveSession';

/** 实测的注册表字段（~/.claude/sessions/<pid>.json），只挑我们要用的几个。 */
const full = {
  pid: 3777899,
  sessionId: 'e71afcd8-1a2b-4c3d-9e8f-000000000000',
  cwd: '/ssd/qiansenwei/workspace',
  startedAt: 1789433265980,
  status: 'busy',
  name: 'workspace-65',
  nameSource: 'derived',
};

const text = (o: unknown) => JSON.stringify(o);

describe('parseSessionRecord', () => {
  it('完整记录：取出我们需要的四个字段', () => {
    assert.deepStrictEqual(parseSessionRecord(text(full)), {
      pid: 3777899,
      sessionId: full.sessionId,
      cwd: '/ssd/qiansenwei/workspace',
      startedAt: 1789433265980,
    });
  });

  it('缺 sessionId → undefined（绝不编造一个 id）', () => {
    const { sessionId: _drop, ...rest } = full;
    assert.strictEqual(parseSessionRecord(text(rest)), undefined);
  });

  it('缺 startedAt → undefined（没有它就没有确定性 tie-break）', () => {
    const { startedAt: _drop, ...rest } = full;
    assert.strictEqual(parseSessionRecord(text(rest)), undefined);
  });

  it('pid 是字符串 → undefined', () => {
    assert.strictEqual(parseSessionRecord(text({ ...full, pid: '3777899' })), undefined);
  });

  it('★ sessionId 为空串 → undefined（否则会一路把绑定写成空串）', () => {
    assert.strictEqual(parseSessionRecord(text({ ...full, sessionId: '' })), undefined);
  });

  it('★ sessionId 为纯空白 → undefined', () => {
    assert.strictEqual(parseSessionRecord(text({ ...full, sessionId: '   ' })), undefined);
  });

  it('非法 JSON / 非对象 / 空串 → undefined，绝不抛', () => {
    assert.strictEqual(parseSessionRecord('{oooo'), undefined);
    assert.strictEqual(parseSessionRecord('42'), undefined);
    assert.strictEqual(parseSessionRecord('null'), undefined);
    assert.strictEqual(parseSessionRecord(''), undefined);
  });
});

describe('pickLiveSession', () => {
  const r = (pid: number, sessionId: string, startedAt: number): SessionRecord =>
    ({ pid, sessionId, cwd: '/a', startedAt });

  it('空数组 → undefined', () => {
    assert.strictEqual(pickLiveSession([]), undefined);
  });

  it('取 startedAt 最新，且与输入顺序无关', () => {
    assert.strictEqual(pickLiveSession([r(1, 'old', 10), r(2, 'new', 20)])?.sessionId, 'new');
    assert.strictEqual(pickLiveSession([r(2, 'new', 20), r(1, 'old', 10)])?.sessionId, 'new');
  });

  it('startedAt 并列时按 pid 大者（结果确定，不随 readdir/进程表顺序抖动）', () => {
    assert.strictEqual(pickLiveSession([r(9, 'a', 10), r(10, 'b', 10)])?.pid, 10);
    assert.strictEqual(pickLiveSession([r(10, 'b', 10), r(9, 'a', 10)])?.pid, 10);
  });

  it('单元素直接返回它', () => {
    assert.strictEqual(pickLiveSession([r(1, 'x', 10)])?.sessionId, 'x');
  });

  it('★ 同 sessionId 的多个候选（实测的孤儿场景）取谁都是同一条', () => {
    const got = pickLiveSession([r(287756, 'same', 1789279289648), r(3776947, 'same', 1789433265980)]);
    assert.strictEqual(got?.sessionId, 'same');
  });
});
