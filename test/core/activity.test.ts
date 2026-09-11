import * as assert from 'assert';
import { nextActivity, markSeen, EntryActivity } from '../../src/core/activity';

describe('nextActivity', () => {
  it('首次观测：运行中 → running', () => {
    const next = nextActivity(undefined, { running: true, taskName: 'A' });
    assert.deepStrictEqual(next, { state: 'running', taskName: 'A' });
  });
  it('首次观测：空闲 → idle（不能判为 done-unseen）', () => {
    const next = nextActivity(undefined, { running: false, taskName: '' });
    assert.deepStrictEqual(next, { state: 'idle', taskName: '' });
  });
  it('running → running：继续运行，taskName 更新', () => {
    const prev: EntryActivity = { state: 'running', taskName: '旧任务' };
    const next = nextActivity(prev, { running: true, taskName: '新任务' });
    assert.deepStrictEqual(next, { state: 'running', taskName: '新任务' });
  });
  it('running → 不再运行：变成 done-unseen（这就是"刚完成"信号）', () => {
    const prev: EntryActivity = { state: 'running', taskName: 'A' };
    const next = nextActivity(prev, { running: false, taskName: 'A' });
    assert.deepStrictEqual(next, { state: 'done-unseen', taskName: 'A' });
  });
  it('done-unseen → 仍不运行：维持 done-unseen（还没被看过）', () => {
    const prev: EntryActivity = { state: 'done-unseen', taskName: 'A' };
    const next = nextActivity(prev, { running: false, taskName: 'A' });
    assert.deepStrictEqual(next, { state: 'done-unseen', taskName: 'A' });
  });
  it('done-unseen → 又开始运行：直接变 running（新一轮任务盖过旧的"未读完成"）', () => {
    const prev: EntryActivity = { state: 'done-unseen', taskName: 'A' };
    const next = nextActivity(prev, { running: true, taskName: 'B' });
    assert.deepStrictEqual(next, { state: 'running', taskName: 'B' });
  });
  it('idle → running：开始运行', () => {
    const prev: EntryActivity = { state: 'idle', taskName: '' };
    const next = nextActivity(prev, { running: true, taskName: 'A' });
    assert.deepStrictEqual(next, { state: 'running', taskName: 'A' });
  });
  it('idle → 仍空闲：维持 idle', () => {
    const prev: EntryActivity = { state: 'idle', taskName: 'A' };
    const next = nextActivity(prev, { running: false, taskName: 'A' });
    assert.deepStrictEqual(next, { state: 'idle', taskName: 'A' });
  });
});

describe('markSeen', () => {
  it('done-unseen → idle', () => {
    const prev: EntryActivity = { state: 'done-unseen', taskName: 'A' };
    assert.deepStrictEqual(markSeen(prev), { state: 'idle', taskName: 'A' });
  });
  it('running 不受影响，原样返回同一个对象引用', () => {
    const prev: EntryActivity = { state: 'running', taskName: 'A' };
    assert.strictEqual(markSeen(prev), prev);
  });
  it('idle 不受影响，原样返回同一个对象引用', () => {
    const prev: EntryActivity = { state: 'idle', taskName: '' };
    assert.strictEqual(markSeen(prev), prev);
  });
});
