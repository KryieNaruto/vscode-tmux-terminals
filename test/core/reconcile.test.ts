import * as assert from 'assert';
import { reconcileBinding } from '../../src/core/reconcile';

describe('reconcileBinding —— 由「当前绑定」与「本次观测」算新绑定', () => {
  it('观测不到（undefined）→ 什么都不动', () => {
    assert.strictEqual(reconcileBinding({ conversationId: 'X' }, undefined), undefined);
  });

  it('★ 观测到空串 / 纯空白 → 什么都不动（守卫不可省）', () => {
    // 写成 `live === undefined` 而漏了空串，空串会落到第三分支，把绑定
    // **清空**成 ''。所以这里必须一视同仁。
    assert.strictEqual(reconcileBinding({ conversationId: 'X' }, ''), undefined);
    assert.strictEqual(reconcileBinding({ conversationId: 'X' }, '   '), undefined);
  });

  it('live 与上次观测值相同 → 不动', () => {
    assert.strictEqual(reconcileBinding({ conversationId: 'X', liveSessionId: 'Y' }, 'Y'), undefined);
  });

  it('★ 手动改绑专项：conversationId=X、liveSessionId=Y、live=Y → X 不被冲掉', () => {
    // 第二分支是「手动改绑保护」的全部实现，漏掉它手动改绑会被下一次
    // reconcile 冲掉。
    assert.strictEqual(reconcileBinding({ conversationId: 'X', liveSessionId: 'Y' }, 'Y'), undefined);
  });

  it('live 变成另一个会话 → 两者都改成它（/new 的情形）', () => {
    assert.deepStrictEqual(reconcileBinding({ conversationId: 'X', liveSessionId: 'Y' }, 'Z'), {
      conversationId: 'Z',
      liveSessionId: 'Z',
    });
  });

  it('首次观测（liveSessionId 未设）→ 回写两者（未绑定的条目就此自动绑上）', () => {
    assert.deepStrictEqual(reconcileBinding({}, 'Z'), { conversationId: 'Z', liveSessionId: 'Z' });
  });

  it('未绑定 + 观测不到 → undefined（绝不写空串）', () => {
    assert.strictEqual(reconcileBinding({}, undefined), undefined);
    assert.strictEqual(reconcileBinding({}, ''), undefined);
  });
});
