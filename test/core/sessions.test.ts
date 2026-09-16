import * as assert from 'assert';
import { nextSessionOrder, sessionLabel, sortSessions } from '../../src/core/sessions';
import { SessionSlot } from '../../src/core/types';

const s = (id: string, order: number, extra: Partial<SessionSlot> = {}): SessionSlot => ({
  id, order, ...extra,
});

describe('sortSessions', () => {
  it('按 order 升序', () => {
    const out = sortSessions([s('c', 2), s('a', 0), s('b', 1)]);
    assert.deepStrictEqual(out.map((x) => x.id), ['a', 'b', 'c']);
  });

  it('order 相同时保持原下标顺序（稳定排序，不能靠 sort 的默认行为）', () => {
    // V8 的 sort 现在稳定，但「依赖默认实现恰好稳定」是没写进契约的运气：
    // 这里显式用原下标做次级键。写错的表现是列表顺序在两次渲染间抖动。
    const out = sortSessions([s('first', 0), s('second', 0), s('third', 0), s('fourth', 0)]);
    assert.deepStrictEqual(out.map((x) => x.id), ['first', 'second', 'third', 'fourth']);
  });

  it('order 相同的一组内部保持原顺序，且不与被排序的其它槽交错错位', () => {
    const out = sortSessions([s('a1', 1), s('b', 0), s('a2', 1), s('c', 0)]);
    assert.deepStrictEqual(out.map((x) => x.id), ['b', 'c', 'a1', 'a2']);
  });

  it('负数 order 钳到 0，且不改变相对顺序', () => {
    // 与 load() 对条目 order 的处理同源：一个 -1 会永远排最前，而写入又会
    // 重编号，状态自相矛盾。钳零是修掉矛盾的唯一办法。
    const out = sortSessions([s('a', -5), s('b', -3), s('c', 0)]);
    assert.deepStrictEqual(out.map((x) => x.order), [0, 0, 0]);
    assert.deepStrictEqual(out.map((x) => x.id), ['a', 'b', 'c']);
  });

  it('空数组返回空数组', () => {
    assert.deepStrictEqual(sortSessions([]), []);
  });

  it('★ 纯函数：不改动入参（返回的是新数组、新对象）', () => {
    const input = [s('b', 1), s('a', -2)];
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = sortSessions(input);
    assert.deepStrictEqual(input, snapshot, '入参必须一个字节都没变');
    assert.notStrictEqual(out, input, '不能把入参原样返回');
    assert.notStrictEqual(out[0], input[1], '钳过 order 的槽必须是新对象');
  });

  it('钳零后的滑块与未钳的槽用同一套稳定性判据（负数排在同 order 的后面）', () => {
    const out = sortSessions([s('neg', -1), s('zero', 0)]);
    assert.deepStrictEqual(out.map((x) => x.id), ['neg', 'zero']);
  });
});

describe('nextSessionOrder', () => {
  it('空数组 → 0', () => {
    assert.strictEqual(nextSessionOrder([]), 0);
  });

  it('[0,1,2] → 3', () => {
    assert.strictEqual(nextSessionOrder([s('a', 0), s('b', 1), s('c', 2)]), 3);
  });

  it('不连续（[0,5]）→ 6（max + 1，不是 length）', () => {
    // 用 length 会在「删过中间槽」之后与现存槽撞号，两个槽的 order 相同 →
    // 顺序变成未定义。必须取 max + 1。
    assert.strictEqual(nextSessionOrder([s('a', 0), s('b', 5)]), 6);
  });

  it('乱序输入仍取 max + 1', () => {
    assert.strictEqual(nextSessionOrder([s('a', 5), s('b', 0), s('c', 2)]), 6);
  });

  it('负数被当 0 看待，空槽的下一个仍是 0', () => {
    assert.strictEqual(nextSessionOrder([s('a', -9)]), 1);
  });
});

describe('sessionLabel', () => {
  it('非空任务名原样返回', () => {
    assert.strictEqual(sessionLabel('修复登录超时'), '修复登录超时');
  });

  it('空串回落「无会话」', () => {
    assert.strictEqual(sessionLabel(''), '无会话');
  });

  it('★ 只按长度判空：空白串不是「空」（回落会把一个真实的空白标题吃掉）', () => {
    // 判据必须与调用方一致 —— 三级恒生成，标题的回落点只有这一处。
    // 若这里顺手 trim 一遍，采样层好不容易采到的标题就会被换成「无会话」，
    // 而没有任何报错。
    assert.strictEqual(sessionLabel(' '), ' ');
  });

  it('单字符任务名照样算有名字', () => {
    assert.strictEqual(sessionLabel('A'), 'A');
  });
});
