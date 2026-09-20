import * as assert from 'assert';
import { panelNameFor } from '../../src/core/panels';
import { SessionSlot, TerminalEntry } from '../../src/core/types';

// 构造辅助：只填这个纯函数会读的字段（name / sessions[].id），其余给占位值。
// 与 sessions.test.ts 里那个 `s()` 同一风格 —— 签名一眼能看出「喂了什么」。
const slot = (id: string): SessionSlot => ({ id, order: 0 });

const entry = (name: string, slots: SessionSlot[]): TerminalEntry => ({
  id: 'entry-id',
  name,
  cwd: '/tmp',
  profile: 'ccr',
  sessions: slots,
  autoRestore: false,
  order: 0,
});

describe('panelNameFor', () => {
  it('单槽条目 → 恰好等于 entry.name（字符级相等，不许有后缀/空白）', () => {
    // 单槽是多数情形，名字必须一个字符都不变 —— 多一个空格都会让
    // 面板名与用户认知里的终端名对不上，而扩展重载后我们只能靠它找面板。
    const e = entry('专家模式', [slot('251c0000aaaa')]);
    assert.strictEqual(panelNameFor(e, e.sessions[0]), '专家模式');
  });

  it('0 槽条目 → 也是 entry.name（点不到、不建面板，但不能抛）', () => {
    const e = entry('空条目', []);
    // 这里没有槽可传，借一个不属于它的槽验证「按条目槽数分支」而非「按槽」
    assert.strictEqual(panelNameFor(e, slot('dead')), '空条目');
  });

  it('双槽条目 → 两个槽的名字不相等，且都以 entry.name 开头', () => {
    const e = entry('新点子落地', [slot('251c0000aaaa'), slot('9f3b0000bbbb')]);
    const [a, b] = e.sessions.map((s) => panelNameFor(e, s));
    assert.notStrictEqual(a, b, '同一个条目下两个槽撞名 = 第二条点不动');
    assert.ok(a.startsWith('新点子落地'));
    assert.ok(b.startsWith('新点子落地'));
  });

  it('5 个槽 → 5 个名字两两不同（Set 判长度）', () => {
    const e = entry('新点子落地', [
      slot('251c0000aaaa'),
      slot('9f3b0000bbbb'),
      slot('0a1b0000cccc'),
      slot('77dd0000dddd'),
      slot('c0ffee0000ee'),
    ]);
    const names = e.sessions.map((s) => panelNameFor(e, s));
    assert.strictEqual(new Set(names).size, 5);
  });

  it('同一个槽反复调用 → 结果稳定（纯函数，可用于跨宿主重载后比对）', () => {
    const e = entry('新点子落地', [slot('251c0000aaaa'), slot('9f3b0000bbbb')]);
    const s = e.sessions[1];
    assert.strictEqual(panelNameFor(e, s), panelNameFor(e, s));
  });

  it('槽 id 不同但条目相同 → 名字不同', () => {
    const e1 = entry('专家模式', [slot('aaaa'), slot('bbbb')]);
    const e2 = entry('专家模式', [slot('cccc'), slot('dddd')]);
    assert.notStrictEqual(panelNameFor(e1, e1.sessions[0]), panelNameFor(e2, e2.sessions[0]));
  });

  it('★ 跨条目不撞：不同条目名 + 不同槽 id 一定不同', () => {
    const a = entry('A', [slot('1111'), slot('2222')]);
    const b = entry('B', [slot('3333'), slot('4444')]);
    assert.notStrictEqual(panelNameFor(a, a.sessions[0]), panelNameFor(b, b.sessions[0]));
  });
});
