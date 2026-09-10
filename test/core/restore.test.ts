import * as assert from 'assert';
import { decideOpen, SessionFacts, PanelFacts } from '../../src/core/restore';

/**
 * 这些用例锁定 2026-09-10 订正的判据：
 *
 * **权威事实只有两个** —— 会话是否存在、有几个客户端附着。
 * 内存 Map / 「window.terminals 里有同名面板」只能用来挑「用哪个面板」，
 * 绝不能用来说明「已经恢复好了」。
 *
 * 旧实现（v2 首发，已复现 bug）：Map 命中或同名命中的面板直接 show() 并
 * return，于是
 *   - 会话已死 + 陈旧面板 → 完全 no-op（用户看到退回 cd 目录的裸 shell）
 *   - 会话存活但 0 附着 + 陈旧面板 → 只 show()，claude 在后台跑着却看不见
 * 每个 "旧实现会走错" 的分支都在下面标了 ★。
 */
describe('decideOpen —— 恢复一条条目时对面板的动作', () => {
  const session = (exists: boolean, attached: number | null): SessionFacts => ({ exists, attached });
  const noPanel: PanelFacts = { present: false, idle: false };
  const idlePanel: PanelFacts = { present: true, idle: true };
  const busyPanel: PanelFacts = { present: true, idle: false };

  describe('会话不存在（必须建会话 + attach）', () => {
    it('无面板 → 新建面板并 attach', () => {
      assert.strictEqual(decideOpen(session(false, 0), noPanel), 'new-attach');
    });
    it('★ 陈旧面板且能证明空闲 → 复用面板并 attach（旧实现完全 no-op）', () => {
      assert.strictEqual(decideOpen(session(false, 0), idlePanel), 'reuse-attach');
    });
    it('陈旧面板但空闲与否未知 → 新建面板（绝不往状态不明的面板里打字）', () => {
      assert.strictEqual(decideOpen(session(false, 0), busyPanel), 'new-attach');
    });
  });

  describe('会话存活但没有任何客户端附着（旧实现只 show 的场景）', () => {
    it('★ Map/同名面板空闲 → 复用面板并 attach（旧实现只 show() 不 attach）', () => {
      assert.strictEqual(decideOpen(session(true, 0), idlePanel), 'reuse-attach');
    });
    it('面板非空闲 → 新建面板并 attach', () => {
      assert.strictEqual(decideOpen(session(true, 0), busyPanel), 'new-attach');
    });
    it('无面板 → 新建面板并 attach', () => {
      assert.strictEqual(decideOpen(session(true, 0), noPanel), 'new-attach');
    });
  });

  describe('会话存活且已有客户端附着', () => {
    it('有面板 → 只 show（已恢复，不重复 attach）', () => {
      assert.strictEqual(decideOpen(session(true, 1), idlePanel), 'show');
    });
    it('多个客户端附着时同样只 show', () => {
      assert.strictEqual(decideOpen(session(true, 3), busyPanel), 'show');
    });
    it('没有任何面板代表它 → 新建面板并 attach', () => {
      assert.strictEqual(decideOpen(session(true, 1), noPanel), 'new-attach');
    });
  });

  describe('附着数读不出来（display-message 目标写错时是 exit 0 + 空输出）', () => {
    it('★ 未知附着数 + 面板 → 绝不 show；空闲才复用', () => {
      assert.strictEqual(decideOpen(session(true, null), idlePanel), 'reuse-attach');
    });
    it('未知附着数 + 非空闲面板 → 新建面板', () => {
      assert.strictEqual(decideOpen(session(true, null), busyPanel), 'new-attach');
    });
  });

  describe('安全不变量：只有 idle === true 才允许往已有面板里打字', () => {
    it('任何「非空闲面板」组合都不产生 reuse-attach', () => {
      for (const exists of [true, false]) {
        for (const attached of [null, 0, 1, 5]) {
          const action = decideOpen(session(exists, attached), busyPanel);
          assert.notStrictEqual(action, 'reuse-attach',
            `exists=${exists} attached=${attached} 时不该复用非空闲面板`);
        }
      }
    });
    it('只有当会话已存在且有附着时才可能 show', () => {
      // show 的前提：会话在 + 至少一个客户端附着 + 有面板
      assert.notStrictEqual(decideOpen(session(false, 5), idlePanel), 'show');
      assert.notStrictEqual(decideOpen(session(true, 0), idlePanel), 'show');
      assert.notStrictEqual(decideOpen(session(true, 1), noPanel), 'show');
    });
  });
});
