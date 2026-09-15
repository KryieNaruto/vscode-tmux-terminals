# 会话身份（`/new` 后自动改绑 + 任务名回退链）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉同源的两个 bug —— claude 里 `/new`（=`/clear`）换会话后，(1) 条目 `conversationId` 不回写、恢复时 `--resume` 仍接回旧对话；(2) 三级树第三级「任务名」的唯一来源是实时 pane title，`/new` 后回落成占位符导致整行消失。

**Architecture:** 新增一个**只读**的「会话身份层」：`pane_pid` → 进程树下探 → `~/.claude/sessions/<pid>.json` → `sessionId`，在五个**事件**（不引入定时器）上跑一次 reconcile，把观测到的活跃会话回写进条目（新增字段 `liveSessionId` 专门用来保护手动改绑）。任务名则改成两段链：pane title（live，权威）→ 该条目**绑定对话的 `aiTitle`**（读 transcript 尾部取最后一条，内存 LRU 缓存、异步预取 + 同步 `peek`）→ 都无则**不生成第三级**。

**Tech Stack:** TypeScript（strict）、VS Code Extension API、mocha（`core/*.ts` 纯函数单测）、本仓库自制的 vscode-stub e2e harness（`test/e2e-harness.js`，真 tmux + 真 `ps` + 假 HOME / 假 claude）。

**Spec:** `docs/superpowers/specs/2026-09-14-session-identity-design.md`

## Global Constraints

- `src/core/*.ts` 必须**零 vscode 依赖、零 IO**（纯函数，可脱离编辑器直接 mocha 单测）；IO 一律放同级的非 core 文件（沿用 `core/conversation.ts` ↔ `conversationFiles.ts` 的既有分工）。
- 不装全局 hook、不改 `~/.claude/settings.json`（方案 C 已否决）。
- 本次**不引入 `fs.watch`**（方案 B 留作后续优化）。
- **不引入定时器驱动的 reconcile**：只在五个事件上跑（激活 / ⟳ / 点击条目 / 切 profile / 展开树或面板变为可见），并由 in-flight 变量把并发触发合并成一次观测。
- 观测的驱动者只有 `extension.ts` 一处；`EntryTreeProvider` **不**持有 reconciler，只提供同步、无 IO 的 `titleFallback.peek`。
- **观测不到就不动、就不猜**：会话不存在 / claude 已退出 / 注册表读不出 / 进程表查不到 —— 一律 `undefined`。唯一例外是**收窄到「该 cwd 下只有这一个条目」**的兜底 D。
- 任务名回退链**唯一**：pane title → 绑定对话的 `aiTitle` → 不显示第三级。绝不引入第三种来源（灰色占位 / derived slug / 首条用户消息摘要）。
- 整个会话身份层是**只读**的：只发 `display-message` / `ps` / 读文件，绝不 `send-keys` / `attach` / `kill`。
- **手动改绑（`bindConversationInteractive`）只改 `conversationId`，不动 `liveSessionId`**；兜底 D 同理（推断值不冒充观测值）。
- 测试**不得读写真实 `~/.claude`**，一律用 `fs.mkdtemp` 造临时 home（e2e 用假 HOME `/tmp/tmuxterm-e2e-home`）。
- 版本号 **0.1.4 → 0.1.5**，并订正 `package-lock.json`（现为 `0.1.2`，`version` 与 `packages[""].version` 两处）。

---

### Task 1: 条目新增 `liveSessionId` 字段与向后兼容迁移

**Files:**
- Modify: `src/core/types.ts:32`（在 `conversationId` 之后新增可选字段）
- Modify: `src/core/migrate.ts:47-51`
- Test: `test/core/migrate.test.ts`（追加一个 describe）

**Interfaces:**
- Consumes: 无
- Produces: `TerminalEntry.liveSessionId?: string` —— Task 3（`BindingState`）、Task 8（`reconcileOne` / `reconcileAll`）、Task 10（`peek` 的入参来自 `entry.conversationId`）都要读它。

- [ ] **Step 1: 写失败测试**

在 `test/core/migrate.test.ts` 末尾追加：

```ts
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run compile && npx mocha out/test/core/migrate.test.js`
Expected: FAIL（`liveSessionId` 尚不存在于 `TerminalEntry`，`tsc` 报错 `Property 'liveSessionId' does not exist on type 'TerminalEntry'`）

- [ ] **Step 3: 写最小实现**

先改 `src/core/types.ts`：把 `conversationId?: string;`（现第 32 行）之后紧接着插入新字段：

```ts
  conversationId?: string;
  /**
   * 上一次**已确认观测到**的活跃会话 id。
   *
   * 与 `conversationId` 的区别是语义：`conversationId` 是「下次启动要接回
   * 哪条」，可能来自自动观测、也可能来自用户手动改绑；本字段只记录「我们
   * 亲眼看到这个终端在跑哪条会话」。
   *
   * 它存在的**唯一理由**是保护手动改绑：用户趁 claude 活着把绑定改成 X 时，
   * 下一次 reconcile 会看到 live 仍是 Y —— 若只看 live，就会把 X 冲回 Y。
   * 有了它，`live === liveSessionId` 即判为「没变化」，X 得以保留。
   *
   * 未设 = 从未观测过（老条目，或本功能上线后还没触发过一次 reconcile）。
   * 只在观测到 live 变成**另一个**会话时才回写。
   */
  liveSessionId?: string;
```

再改 `src/core/migrate.ts`：把 `:47-51` 的这段

```ts
    const conversationId = str(o.conversationId);
    return {
      id, name, cwd, profile,
      ...(model !== undefined && model.length > 0 ? { model } : {}),
      ...(conversationId !== undefined && conversationId.length > 0 ? { conversationId } : {}),
      autoRestore: o.autoRestore === true,
      order: typeof o.order === 'number' ? o.order : index,
    };
```

改成：

```ts
    const conversationId = str(o.conversationId);
    // 「上一次观测到的活跃会话」同样必须原样带过。漏这一行不是「字段丢了」
    // 这么轻 —— migrateEntry 是 EntryStore.load() 的**唯一守门人**，漏掉它
    // 等于每次 load 都把它静默吞掉，手动改绑保护随之失效，且没有任何报错。
    // 缺字段 / 空串 / 非字符串一律视为「从未观测过」：绝不编造一个 id。
    const liveSessionId = str(o.liveSessionId);
    return {
      id, name, cwd, profile,
      ...(model !== undefined && model.length > 0 ? { model } : {}),
      ...(conversationId !== undefined && conversationId.length > 0 ? { conversationId } : {}),
      ...(liveSessionId !== undefined && liveSessionId.length > 0 ? { liveSessionId } : {}),
      autoRestore: o.autoRestore === true,
      order: typeof o.order === 'number' ? o.order : index,
    };
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm run compile && npx mocha out/test/core/migrate.test.js`
Expected: PASS（原有 11 项 + 新增 5 项全绿；其中「已是 v2 形态 → 原样返回（幂等）」这条也仍绿 —— 它的 v2 字面量里没有 `liveSessionId`，迁移结果同样没有）

- [ ] **Step 5: 提交**

```bash
git add src/core/types.ts src/core/migrate.ts test/core/migrate.test.ts
git commit -m "feat: TerminalEntry 新增 liveSessionId 字段并纳入迁移（保护手动改绑）"
```

---

### Task 2: 会话身份解析纯函数（`core/processTree.ts` + `core/liveSession.ts`）

spec §3.1 把这两件事拆成两个文件（进程表解析 / 注册表解析），都保持零 IO、零 vscode，本 Task 一次交付这两个模块 + 各自的测试文件。

**Files:**
- Create: `src/core/processTree.ts`
- Create: `src/core/liveSession.ts`
- Test: `test/core/processTree.test.ts`
- Test: `test/core/liveSession.test.ts`

**Interfaces:**
- Consumes: 无（两个模块都只操作纯数据）
- Produces:
  - `interface ProcNode { pid: number; ppid: number }`
  - `parseProcTable(text: string): ProcNode[]`
  - `descendantsOf(table: readonly ProcNode[], rootPid: number): number[]`
  - `interface SessionRecord { pid: number; sessionId: string; startedAt: number; cwd: string }`
  - `parseSessionRecord(text: string): SessionRecord | undefined`
  - `pickLiveSession(records: readonly SessionRecord[]): SessionRecord | undefined`
  - Task 6（`liveSessions.ts`）直接用这 6 个符号。

- [ ] **Step 1: 写失败测试（进程表）**

创建 `test/core/processTree.test.ts`：

```ts
import * as assert from 'assert';
import { descendantsOf, parseProcTable } from '../../src/core/processTree';

describe('parseProcTable —— 解析 `ps -eo pid=,ppid=` 的输出', () => {
  it('解析 pid/ppid 两列（ps 带前导空白）', () => {
    assert.deepStrictEqual(parseProcTable('  1     0\n  2     1\n'), [
      { pid: 1, ppid: 0 },
      { pid: 2, ppid: 1 },
    ]);
  });

  it('空串 → []', () => {
    assert.deepStrictEqual(parseProcTable(''), []);
  });

  it('首尾空白、多空格、空行都能容忍', () => {
    assert.deepStrictEqual(parseProcTable('\n   287661    1234   \n\n'), [
      { pid: 287661, ppid: 1234 },
    ]);
  });

  it('缺列 / 非数字的行一律跳过，绝不抛错', () => {
    assert.deepStrictEqual(parseProcTable('1 2\nonlypid\nx y\n3 4\n'), [
      { pid: 1, ppid: 2 },
      { pid: 3, ppid: 4 },
    ]);
  });

  it('pid <= 0 的行跳过（0 = 内核调度器，不是真实进程）', () => {
    assert.deepStrictEqual(parseProcTable('-1 0\n0 0\n5 0\n'), [{ pid: 5, ppid: 0 }]);
  });
});

describe('descendantsOf —— rootPid 的全部后代（含各层，不含自身）', () => {
  const t = (rows: Array<[number, number]>) => rows.map(([pid, ppid]) => ({ pid, ppid }));

  it('直接子进程（pane_pid → claude）', () => {
    assert.deepStrictEqual(descendantsOf(t([[100, 1], [200, 100]]), 100), [200]);
  });

  it('多层（pane_pid → shell → 更深的 claude）', () => {
    assert.deepStrictEqual(descendantsOf(t([[100, 1], [150, 100], [200, 150]]), 100), [150, 200]);
  });

  it('同一 root 下多个后代全部返回（一个 pane 下不止一个 claude）', () => {
    assert.deepStrictEqual(descendantsOf(t([[100, 1], [200, 100], [201, 100]]), 100).sort((a, b) => a - b), [200, 201]);
  });

  it('结果不含 root 自身', () => {
    assert.strictEqual(descendantsOf(t([[100, 1], [200, 100]]), 100).includes(100), false);
  });

  it('root 不在表里 → []', () => {
    assert.deepStrictEqual(descendantsOf(t([[1, 0], [2, 1]]), 999), []);
  });

  it('★ 表里有环也必须安全终止（100 ← 300 ← 200 ← 100）', () => {
    const cyclic = t([[100, 1], [200, 100], [300, 200], [100, 300]]);
    assert.deepStrictEqual(descendantsOf(cyclic, 100).sort((a, b) => a - b), [200, 300]);
  });

  it('pid 重复出现也只返回一次', () => {
    assert.deepStrictEqual(descendantsOf(t([[100, 1], [200, 100], [200, 100]]), 100), [200]);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run compile && npx mocha out/test/core/processTree.test.js`
Expected: FAIL（`src/core/processTree.ts` 不存在，`tsc` 报 `Cannot find module '../../src/core/processTree'`）

- [ ] **Step 3: 写最小实现（进程表）**

创建 `src/core/processTree.ts`：

```ts
/**
 * 进程表解析与「后代集合」推导的纯函数。
 *
 * 本文件刻意不依赖 vscode、也不碰文件系统/进程（`ps` 的调用在
 * src/liveSessions.ts），以便脱离编辑器直接单测。
 *
 * 用途：tmux 的 `#{pane_pid}` 是**外层 shell** 的 pid，claude 是它的后代
 * （实测：某个 pane 的 pane_pid=287661 是 `-bash`，claude 3777899 的 ppid
 * 就是它）。但**不能只看直接子进程** —— 一个 pane 下 claude 后代可能不止
 * 一个（实测抓到过孤儿进程），必须沿后代下探。
 */

/**
 * `ps -eo pid=,ppid=` 的一行解析结果。
 */
export interface ProcNode {
  pid: number;
  ppid: number;
}

/**
 * 解析进程表文本。无法解析的行一律跳过，绝不抛错。
 *
 * `ps -eo pid=,ppid=` 的输出形如 `  287661    1234`（等号让 ps 省掉表头）。
 */
export function parseProcTable(text: string): ProcNode[] {
  const out: ProcNode[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (pid <= 0) continue; // 0 = 内核调度器，不是真实进程
    out.push({ pid, ppid });
  }
  return out;
}

/**
 * rootPid 在 table 里的**全部后代** pid（含各层，不含 rootPid 自身）。
 *
 * 表里查不到 rootPid 时返回 []。自身成环、pid 重复等畸形输入必须安全终止 ——
 * `seen` 集同时承担「防环」与「去重」两个职责。
 */
export function descendantsOf(table: readonly ProcNode[], rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const node of table) {
    const list = children.get(node.ppid);
    if (list === undefined) children.set(node.ppid, [node.pid]);
    else list.push(node.pid);
  }

  const out: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue; // 成环 / pid 重复 → 安全终止
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm run compile && npx mocha out/test/core/processTree.test.js`
Expected: PASS（5 + 7 = 12 项全绿）

- [ ] **Step 5: 写失败测试（会话注册表）**

创建 `test/core/liveSession.test.ts`：

```ts
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
```

- [ ] **Step 6: 运行测试，确认失败**

Run: `npm run compile && npx mocha out/test/core/liveSession.test.js`
Expected: FAIL（`src/core/liveSession.ts` 不存在）

- [ ] **Step 7: 写最小实现（会话注册表）**

创建 `src/core/liveSession.ts`：

```ts
/**
 * `~/.claude/sessions/<pid>.json`（会话注册表）的解析与候选去重。
 *
 * 本文件刻意不依赖 vscode、也不碰文件系统（IO 在 src/liveSessions.ts）。
 *
 * **这是 claude 的内部实现** —— 解析不出就返回 undefined（= 退化为「不观测」），
 * 绝不容错到编造一个 id。将来它改名/改格式，症状是「绑定不再自动跟随」
 * （退回本功能之前的行为），而**不是**绑错对话。
 */

/** 一条 `~/.claude/sessions/<pid>.json` 里我们需要的字段。 */
export interface SessionRecord {
  pid: number;
  sessionId: string;
  /** claude 进程自记的启动时刻（ms）。同一 pane 下有多个 claude 后代时用它做确定性 tie-break。 */
  startedAt: number;
  cwd: string;
}

/**
 * 解析注册表文件。缺 `pid`/`sessionId`/`startedAt`、非对象、非 JSON、
 * **`sessionId` 为空串或纯空白**一律返回 undefined。
 *
 * 空串判 undefined 是必须的：否则它会一路传到 reconcileBinding 把绑定写成
 * `''`（= 清空绑定）。
 *
 * `cwd` 缺失时取空串（「未知」），绝不编造一个路径；它只用于诊断，
 * 不参与任何判据 —— 归属一律以条目自己的 `cwdFor()` 为准。
 */
export function parseSessionRecord(text: string): SessionRecord | undefined {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof o !== 'object' || o === null) return undefined;
  const rec = o as Record<string, unknown>;

  const pid = rec.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;

  const sessionId = rec.sessionId;
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) return undefined;

  const startedAt = rec.startedAt;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined;

  const cwd = typeof rec.cwd === 'string' ? rec.cwd : '';
  return { pid, sessionId, startedAt, cwd };
}

/**
 * 从候选里挑「这个 pane 此刻真的在用的那条会话」。
 * - 空数组 → undefined
 * - 按 `startedAt` 取**最新**；并列时按 pid 大者 → 结果确定，不随
 *   readdir / 进程表顺序抖动
 *
 * 如实说明：实测到的孤儿场景（两个 pid 记同一条 sessionId）里取新取旧
 * 结果**相同**；这条规则是为「多个 claude 各记不同 sessionId」这一更一般
 * 的情形兜底，不是为孤儿场景服务的。
 */
export function pickLiveSession(records: readonly SessionRecord[]): SessionRecord | undefined {
  let best: SessionRecord | undefined;
  for (const rec of records) {
    if (
      best === undefined ||
      rec.startedAt > best.startedAt ||
      (rec.startedAt === best.startedAt && rec.pid > best.pid)
    ) {
      best = rec;
    }
  }
  return best;
}
```

- [ ] **Step 8: 运行测试，确认通过**

Run: `npm run compile && npx mocha out/test/core/liveSession.test.js`
Expected: PASS（7 + 5 = 12 项全绿）

- [ ] **Step 9: 提交**

```bash
git add src/core/processTree.ts src/core/liveSession.ts \
  test/core/processTree.test.ts test/core/liveSession.test.ts
git commit -m "feat: 新增进程表与 claude 会话注册表的纯函数解析层"
```

---

### Task 3: 绑定回写规则（`core/reconcile.ts`）

**Files:**
- Create: `src/core/reconcile.ts`
- Test: `test/core/reconcile.test.ts`

**Interfaces:**
- Consumes: 无（只操作两个可选字符串）
- Produces:
  - `interface BindingState { conversationId?: string; liveSessionId?: string }`
  - `interface BindingPatch { conversationId: string; liveSessionId: string }`
  - `reconcileBinding(entry: BindingState, live: string | undefined): BindingPatch | undefined`
  - Task 8（`TerminalManager.reconcileOne` / `reconcileAll`）用它算补丁。

**命名注意：** `src/core/conversation.ts:154` 已导出一个 `interface BindingView { id; name; conversationId? }`（供 `ownersOf` 用）。这里**刻意不叫 `BindingView`** —— 形状不同，且 `terminalManager.ts` 同时需要两者，同名会直接冲突。

- [ ] **Step 1: 写失败测试**

创建 `test/core/reconcile.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run compile && npx mocha out/test/core/reconcile.test.js`
Expected: FAIL（`src/core/reconcile.ts` 不存在）

- [ ] **Step 3: 写最小实现**

创建 `src/core/reconcile.ts`：

```ts
/**
 * 「条目绑定 ↔ 本次观测到的活跃会话」的纯回写规则。
 *
 * 本文件刻意不依赖 vscode、不碰文件系统，以便脱离编辑器直接单测。
 *
 * **命名**：`src/core/conversation.ts` 已有一个 `BindingView`（供 ownersOf
 * 用，形状不同），故本接口命名 `BindingState` —— terminalManager.ts 同时
 * 需要两者，同名会直接冲突。
 */

/** 一条条目的绑定视角。 */
export interface BindingState {
  conversationId?: string;
  liveSessionId?: string;
}

/** 需要回写的两个新值；返回 undefined = 什么都不动。 */
export interface BindingPatch {
  conversationId: string;
  liveSessionId: string;
}

/**
 * 由「当前绑定」与「这次观测到的活跃会话」算出新绑定。
 *
 *   live == null 或空串/纯空白  → undefined（观测不到就不动）
 *   live === entry.liveSessionId → undefined（含「手动改绑后 live 未变」）
 *   否则                          → { conversationId: live, liveSessionId: live }
 *
 * 第一分支**必须**把 `undefined` 与空串/纯空白一视同仁：`parseSessionRecord`
 * 已把空 `sessionId` 判为 `undefined`，但这里仍要再挡一道 —— 守卫只写
 * `live === undefined` 时，空串会落到第三分支把绑定写成 `''`（= 清空绑定）。
 *
 * 第三分支是「这个终端确实换了一条会话」（`/new`）：此时连手动改绑也要让位，
 * 因为用户的手动选择已经被终端自己的行为取代了。
 *
 * 手动改绑（右键「选择要接回的对话…」）只改 `conversationId`、不动
 * `liveSessionId` —— 于是「手动选了 X，live 仍是 Y」落在第二分支，X 不被冲掉。
 */
export function reconcileBinding(
  entry: BindingState,
  live: string | undefined,
): BindingPatch | undefined {
  if (live === undefined || live.trim().length === 0) return undefined;
  if (live === entry.liveSessionId) return undefined;
  return { conversationId: live, liveSessionId: live };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm run compile && npx mocha out/test/core/reconcile.test.js`
Expected: PASS（7 项全绿）

- [ ] **Step 5: 提交**

```bash
git add src/core/reconcile.ts test/core/reconcile.test.ts
git commit -m "feat: 新增 reconcileBinding 纯函数（三分支：不动/手动改绑保护/改绑）"
```

---

### Task 4: pane title 修正与 `parsePid`（`core/tmux.ts`）

**Files:**
- Modify: `src/core/tmux.ts:128-134`（`taskNameFromTitle`）
- Modify: `src/core/tmux.ts`（新增 `parsePid`，放在 `parseAttachedCount` 之后）
- Test: `test/core/tmux.test.ts`（扩展两个 describe）

**Interfaces:**
- Consumes: 既有 `DEFAULT_TASK_TITLE`
- Produces:
  - `taskNameFromTitle(title: string): string`（签名不变，行为修正）
  - `parsePid(stdout: string): number | null`
  - Task 6（`TmuxClient.panePid`）用 `parsePid`。

**`isRunningTitle` 不改**：它只认 Braille 分区（U+2800–U+28FF），`qiansenwei@…` 的首字符 `q` 不在其中，判为空闲 —— 方向本来就是对的。

- [ ] **Step 1: 写失败测试**

在 `test/core/tmux.test.ts` 里：把 `parsePid` 加进顶部 import 列表（与 `parseAttachedCount` 放一起）；把现有的 `describe('taskNameFromTitle', ...)`（现第 175-193 行）**整块替换**成下面第一个 describe（新块是它的超集，同时补上「首码点是字母时不得剥」这条本次修复的核心用例）；再在文件末尾追加第二个 describe：

```ts
describe('taskNameFromTitle —— 只在首码点确实是指示符时才剥', () => {
  it('Braille / ✳ 指示符后被剥掉，取出具体任务名', () => {
    assert.strictEqual(taskNameFromTitle('⠐ 创建多引擎版 /ask 命令并统一'), '创建多引擎版 /ask 命令并统一');
    assert.strictEqual(taskNameFromTitle('✳ 继续 Krita MSVC 编译工程'), '继续 Krita MSVC 编译工程');
    assert.strictEqual(taskNameFromTitle('⠐ VSCode 终端会话管理插件'), 'VSCode 终端会话管理插件');
  });

  it('占位符「Claude Code」返回空串（无论运行中还是空闲）', () => {
    assert.strictEqual(taskNameFromTitle('✳ Claude Code'), '');
    assert.strictEqual(taskNameFromTitle('⠐ Claude Code'), '');
  });

  it('只有指示符没有文字时返回空串', () => {
    assert.strictEqual(taskNameFromTitle('✳'), '');
    assert.strictEqual(taskNameFromTitle('✳ '), '');
  });

  it('★ 首码点是字母/数字时绝不剥 —— shell 自己设的标题必须原样保留', () => {
    // 回归：claude 退出后 bash 把 title 设成 user@host:cwd，原实现无条件
    // slice(1) 把它削成了 `iansenwei@H:~/workspace`
    assert.strictEqual(taskNameFromTitle('qiansenwei@H:~/workspace'), 'qiansenwei@H:~/workspace');
    // 连 `bash` 都会被削成 `ash`
    assert.strictEqual(taskNameFromTitle('bash'), 'bash');
  });

  it('空串 / 纯空白返回空串', () => {
    assert.strictEqual(taskNameFromTitle(''), '');
    assert.strictEqual(taskNameFromTitle('   '), '');
  });
});

describe('parsePid —— 解析 `#{pane_pid}`', () => {
  it('解析出数字 pid', () => {
    assert.strictEqual(parsePid('287661'), 287661);
    assert.strictEqual(parsePid('  287661  \n'), 287661);
  });

  it('★ 空串 → null（display-message 目标写错时是 exit 0 + 空输出，静默失败）', () => {
    assert.strictEqual(parsePid(''), null);
    assert.strictEqual(parsePid('\n'), null);
    assert.strictEqual(parsePid('   '), null);
  });

  it('非数字 / 负数一律 null（读取失败或格式被改）', () => {
    assert.strictEqual(parsePid('abc'), null);
    assert.strictEqual(parsePid('-1'), null);
    assert.strictEqual(parsePid('1.5'), null);
    assert.strictEqual(parsePid('1 2'), null);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run compile && npx mocha out/test/core/tmux.test.js`
Expected: FAIL（`parsePid` 未导出 → 编译报错；且 `taskNameFromTitle('qiansenwei@H:~/workspace')` 实际返回 `iansenwei@H:~/workspace`）

- [ ] **Step 3: 写最小实现**

把 `src/core/tmux.ts:121-134` 的

```ts
/**
 * 从 pane title 里取任务名（去掉前导指示符及其后的空白）。
 *
 * 占位符 DEFAULT_TASK_TITLE（还没起具体任务名）与空串一律返回空串——
 * 调用方据此判断「没有任务名可显示」，不挂徽章。绝不把占位符原样
 * 当作任务名显示出去，那对用户没有任何信息量。
 */
export function taskNameFromTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) return '';
  const chars = [...trimmed];
  const rest = chars.slice(1).join('').trimStart();
  return rest === DEFAULT_TASK_TITLE ? '' : rest;
}
```

整段替换成：

```ts
/**
 * 从 pane title 里取任务名。
 *
 * claude 把 title 设成 `<指示符> <文字>`（指示符见 isRunningTitle），此时剥掉
 * 指示符。但**首码点是字母/数字时绝不能剥** —— 那是 shell 自己设的标题
 * （claude 退出后 bash 会把 title 设成 `user@host:cwd`），原实现无条件
 * `chars.slice(1)` 把它削成了 `iansenwei@H:~/workspace`；连 `bash` 都会被
 * 削成 `ash`（实测）。
 *
 * 占位符 DEFAULT_TASK_TITLE（还没起具体任务名）与空串一律返回空串 ——
 * 调用方据此判断「没有任务名可显示」，转而走 aiTitle 回退。
 */
export function taskNameFromTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) return '';
  const chars = [...trimmed];
  const first = chars[0];
  const isIndicator = !/[\p{L}\p{N}]/u.test(first);
  const name = (isIndicator ? chars.slice(1).join('') : trimmed).trim();
  return name.length === 0 || name === DEFAULT_TASK_TITLE ? '' : name;
}
```

再在 `parseAttachedCount`（现第 82-85 行）之后插入：

```ts
/**
 * 解析 `#{pane_pid}`。
 *
 * **空输出/非数字必须返回 null（未知）** —— 与 parseAttachedCount 同一个坑：
 * pane 目标漏冒号时 `display-message` 是 **exit 0 + 空输出**，静默失败。
 * 「未知」单独成一个值，由调用方按保守方向处理；绝不能当成 0 或某个 pid。
 */
export function parsePid(stdout: string): number | null {
  const s = stdout.trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm run compile && npx mocha out/test/core/tmux.test.js`
Expected: PASS（`taskNameFromTitle` 由 4 项替换为 5 项（净 +1），`parsePid` 新增 3 项；原有其他 describe 一字未改、全绿）

- [ ] **Step 5: 提交**

```bash
git add src/core/tmux.ts test/core/tmux.test.ts
git commit -m "fix: taskNameFromTitle 只在首码点是指示符时才剥；新增 parsePid"
```

---

### Task 5: `parseAiTitle` 与 `findConversationFile`（读取文件尾部）

**Files:**
- Modify: `src/core/conversation.ts`（新增 `parseAiTitle`）
- Modify: `src/conversationFiles.ts`（新增 `TAIL_BYTES`、`readTail`、`findConversationFile`）
- Test: `test/core/conversation.test.ts`（追加一个 describe）
- Test: `test/conversationFiles.test.ts`（追加一个 describe）

**Interfaces:**
- Consumes: 既有 `parseConversationHead`、`belongsToCwd`
- Produces:
  - `parseAiTitle(text: string): string | undefined`
  - `const TAIL_BYTES = 64 * 1024`（**导出**，见下）
  - `readTail(file: string, bytes: number): Promise<string>`（**导出**）
  - `findConversationFile(home: string, id: string, cwd: string): Promise<string | undefined>`
  - Task 7（`TaskTitleCache`）用这三个读 IO 的符号做默认实现。

> **与 spec §3.1 的一处差异（必要）：** spec 把 `readTail` 写在 `conversationFiles.ts` 里但未标 `export`，而 §6.2 又要求 `TaskTitleCache` 的默认实现走 `findConversationFile → readTail(file, TAIL_BYTES) → parseAiTitle`。两者不可能同时成立，故这里把 `readTail` 与 `TAIL_BYTES` 导出。函数名、模块位置、语义都与 spec 一致。

> **为什么不复用既有的 `findConversations(home, id)`：** 它的返回形状是 **cwd 字符串数组**，不含文件路径 —— 而尾部读取必须先拿到路径才能 seek。想复用它就得改签名并牵动既有 3 个调用点；两者遵守同一套约定：**目录名只用来找文件，归属一律以文件内记录的 `cwd` 字段为准**。

- [ ] **Step 1: 写失败测试（`parseAiTitle`）**

在 `test/core/conversation.test.ts` 的 import 列表里加上 `parseAiTitle`，并在文件末尾追加：

```ts
describe('parseAiTitle —— 从 transcript 尾部取最后一条 ai-title', () => {
  const ai = (title: string) => line({ type: 'ai-title', sessionId: 'x', aiTitle: title });

  it('单条 ai-title', () => {
    assert.strictEqual(parseAiTitle([USER_LINE('hi'), ai('继续 Krita 编译')].join('\n')), '继续 Krita 编译');
  });

  it('★ 多条时取**最后**一条（标题会变，最后一条才是当前标题）', () => {
    const text = [ai('旧标题'), USER_LINE('hi'), ai('中间标题'), ai('当前标题')].join('\n');
    assert.strictEqual(parseAiTitle(text), '当前标题');
  });

  it('aiTitle 里含被 JSON 转义的引号时原样取出', () => {
    assert.strictEqual(parseAiTitle(ai('他说"改一下"')), '他说"改一下"');
  });

  it('一条都没有 / 空串 → undefined', () => {
    assert.strictEqual(parseAiTitle([USER_LINE('hi')].join('\n')), undefined);
    assert.strictEqual(parseAiTitle(''), undefined);
  });

  it('aiTitle 是空串 / 非字符串 → 跳过（不当作标题）', () => {
    assert.strictEqual(parseAiTitle([line({ type: 'ai-title', aiTitle: '' }), ai('真标题')].join('\n')), '真标题');
    assert.strictEqual(parseAiTitle(line({ type: 'ai-title', aiTitle: 42 })), undefined);
  });

  it('★ 首行被截断（尾部窗口的起点落在一条记录中间）不抛且仍能取到后面的标题', () => {
    const broken = '{"type":"mode","sessionId":"x","cwd":"/a/b_c';
    assert.strictEqual(parseAiTitle([broken, ai('窗口内的标题')].join('\n')), '窗口内的标题');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run compile && npx mocha out/test/core/conversation.test.js`
Expected: FAIL（`parseAiTitle` 未导出）

- [ ] **Step 3: 写最小实现（`core/conversation.ts`）**

在 `src/core/conversation.ts` 的 `parseConversationHead`（现第 92 行 `}` 之后的空行处）后面插入：

```ts
/**
 * 从一段（通常是**尾部**）jsonl 文本里取**最后一条** ai-title 记录。
 * 一条都没有 / 解析不出 → undefined。
 *
 * 为什么读尾部而不是头部：实测 `ai-title` 是**追加**记录，不是头部字段 ——
 * 一个文件里最多出现 21 次，首次出现位置有 82/184 落在 64 KB 之后，而
 * **最后一次**距 EOF 最远 53887 B。所以从尾部读一个 64 KB 的窗口即可全覆盖。
 *
 * 为什么取最后一条：实测 7/184 个文件的标题真的变过，取最后一条才是当前标题。
 *
 * 容错是契约。注意**截断位置在窗口的首行、不在末行** —— 尾部读是 seek 到
 * 文件中段开始的，第一条记录只有后半截；而末行一直写到 EOF，是完整的。
 * 故「跳过解析不出的行」这条规则同时覆盖两者，别把它理解成「末行不可信」。
 */
export function parseAiTitle(text: string): string | undefined {
  let title: string | undefined;
  for (const raw of text.split('\n')) {
    if (raw.length === 0) continue;
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      continue; // 窗口起点处被截断的那一行 / 不认识的行
    }
    if (typeof o !== 'object' || o === null) continue;
    const rec = o as Record<string, unknown>;
    if (rec.type !== 'ai-title') continue;
    const t = rec.aiTitle;
    if (typeof t === 'string' && t.trim().length > 0) title = t;
  }
  return title;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm run compile && npx mocha out/test/core/conversation.test.js`
Expected: PASS（原有全绿 + 新增 6 项）

- [ ] **Step 5: 写失败测试（`findConversationFile` + 尾部读）**

在 `test/conversationFiles.test.ts` 里把 import 改成：

```ts
import { findConversationFile, findConversations, listConversations } from '../src/conversationFiles';
```

并在文件末尾追加：

```ts
describe('findConversationFile —— 按 id + cwd 精确定位文件（供尾部读取）', () => {
  const homes: string[] = [];
  const mk = async (files: Record<string, string>) => {
    const h = await makeHome(files);
    homes.push(h);
    return h;
  };
  after(async () => {
    for (const h of homes) await fs.rm(h, { recursive: true, force: true });
  });

  it('命中时返回文件的绝对路径', async () => {
    const home = await mk({
      [`-ssd-foo/${UUID}.jsonl`]: [line({ type: 'attachment', cwd: '/ssd/foo' }), userLine('hi', '/ssd/foo')].join('\n'),
    });
    assert.strictEqual(
      await findConversationFile(home, UUID, '/ssd/foo'),
      path.join(home, '.claude', 'projects', '-ssd-foo', `${UUID}.jsonl`),
    );
  });

  it('id 存在但 cwd 不符 → undefined（归属以文件内字段为准）', async () => {
    const home = await mk({ [`-a/${UUID}.jsonl`]: line({ type: 'attachment', cwd: '/a' }) });
    assert.strictEqual(await findConversationFile(home, UUID, '/b'), undefined);
  });

  it('id 不存在 / projects 目录不存在 → undefined，不抛', async () => {
    const home = await mk({});
    assert.strictEqual(await findConversationFile(home, UUID, '/a'), undefined);

    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxterm-conv-none-'));
    homes.push(empty);
    assert.strictEqual(await findConversationFile(empty, UUID, '/a'), undefined);
  });

  it('★ 标题落在文件尾部时也能读出来（头部 >64 KB、ai-title 只在末尾）', async () => {
    const padding = Array.from({ length: 2000 }, (_, i) =>
      line({ type: 'attachment', cwd: '/a/b', attachment: { i, pad: 'x'.repeat(200) } }));
    const home = await mk({
      [`-a/b/${UUID}.jsonl`]: [
        line({ type: 'attachment', cwd: '/a/b' }),
        ...padding,
        line({ type: 'ai-title', sessionId: UUID, aiTitle: '尾部才有的标题' }),
      ].join('\n'),
    });
    const file = await findConversationFile(home, UUID, '/a/b');
    assert.ok(file !== undefined, '必须按 id + cwd 命中');
    const tail = await readTail(file!, 64 * 1024);
    assert.strictEqual(parseAiTitle(tail), '尾部才有的标题');
  });

  it('文件比窗口短时 readTail 返回全部内容', async () => {
    const home = await mk({ [`-a/b/${UUID}.jsonl`]: line({ type: 'attachment', cwd: '/a/b' }) });
    const file = await findConversationFile(home, UUID, '/a/b');
    const tail = await readTail(file!, 64 * 1024);
    assert.strictEqual(tail, line({ type: 'attachment', cwd: '/a/b' }));
  });
});
```

同时把该文件顶部的 import 再补上 `readTail` 与 `parseAiTitle`：

```ts
import { findConversationFile, findConversations, listConversations, readTail } from '../src/conversationFiles';
import { parseAiTitle } from '../src/core/conversation';
```

- [ ] **Step 6: 运行测试，确认失败**

Run: `npm run compile && npx mocha out/test/conversationFiles.test.js`
Expected: FAIL（`findConversationFile` / `readTail` 未导出）

- [ ] **Step 7: 写最小实现（`conversationFiles.ts`）**

在 `src/conversationFiles.ts` 的 import 补上 `belongsToCwd`：

```ts
import { ConversationCandidate, belongsToCwd, parseConversationHead } from './core/conversation';
```

在 `readHead`（现第 60-69 行）之后插入：

```ts
/**
 * 尾部读取窗口。**不是** HEAD_BYTES 的别名 —— 语义不同（这里读文件尾），
 * 数值相同只是巧合，两者各自独立演进。
 */
export const TAIL_BYTES = 64 * 1024;

/**
 * 读文件**尾部** bytes 字节（文件更短时返回全部）。
 *
 * 为什么必须能读尾部：`ai-title` 是**追加**记录不是头部字段，实测首次出现
 * 位置有 82/184 落在 64 KB 之后，而最后一次距 EOF 最远 53887 B ——
 * 只读头部会读不到 45% 的文件的标题。
 */
export async function readTail(file: string, bytes: number): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/**
 * 按 id + cwd 精确定位会话文件，返回它的**绝对路径**。
 *
 * 与 findConversations 有意重复一部分（都在 projects 下 readdir + 读头部）：
 * 那个函数的返回形状是 cwd 字符串数组、不含文件路径，而尾部读取必须先拿到
 * 路径才能 seek；想复用它就得改签名并牵动既有 3 个调用点，得不偿失。
 * 两者遵守同一套约定：目录名只用来找文件，归属一律以文件内记录的 cwd 为准。
 *
 * 找不到返回 undefined —— 绝不靠目录名转义规则反推。
 */
export async function findConversationFile(
  home: string,
  id: string,
  cwd: string,
): Promise<string | undefined> {
  const root = path.join(home, '.claude', 'projects');
  let dirs: string[];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    dirs = entries.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return undefined; // 没有 ~/.claude/projects —— 正常情况
  }

  const file = `${id}.jsonl`;
  const hits = await mapLimited(dirs, CONCURRENCY, async (dir) => {
    const full = path.join(root, dir, file);
    try {
      const head = await readHead(full, HEAD_BYTES); // 不存在会抛，跳过
      const parsed = parseConversationHead(head);
      return parsed.cwd !== undefined && belongsToCwd(parsed.cwd, cwd) ? full : undefined;
    } catch {
      return undefined;
    }
  });
  return hits.find((f): f is string => f !== undefined);
}
```

- [ ] **Step 8: 运行测试，确认通过**

Run: `npm run compile && npx mocha out/test/conversationFiles.test.js`
Expected: PASS（原有全绿 + 新增 5 项）

- [ ] **Step 9: 提交**

```bash
git add src/core/conversation.ts src/conversationFiles.ts \
  test/core/conversation.test.ts test/conversationFiles.test.ts
git commit -m "feat: 新增 parseAiTitle 与 findConversationFile/readTail（读 transcript 尾部）"
```

---

### Task 6: IO 层：`liveSessions.ts` 与 `TmuxClient.panePid`

**Files:**
- Create: `src/liveSessions.ts`
- Modify: `src/tmuxClient.ts`（新增 `panePid`，放在 `attachedClients` 之后）
- Test: `test/liveSessions.test.ts`

**Interfaces:**
- Consumes: `ProcNode` / `parseProcTable` / `descendantsOf`（Task 2）、`SessionRecord` / `parseSessionRecord` / `pickLiveSession`（Task 2）、`parsePid`（Task 4）
- Produces:
  - `interface LivenessSnapshot { readonly procs: readonly ProcNode[]; readonly sessions: ReadonlyMap<number, SessionRecord> }`
  - `readLiveness(home: string): Promise<LivenessSnapshot>`
  - `liveSessionIn(snap: LivenessSnapshot, panePid: number): SessionRecord | undefined`
  - `TmuxClient.panePid(name: string): Promise<number | null>`
  - Task 8（`TerminalManager`）用全部三个。

**为什么不用 mock `ps`：** 真正的集成风险在「`descendantsOf` 能不能在**真实**进程树里按 `pane_pid` 找到 claude」（pid 复用、pane_pid 归属、等待时序）。mock 掉 `ps` 等于把这条契约换成「能解析我编的字符串」，恰好放过了唯一的集成风险。纯逻辑（8.1/8.3 的用例）用手写快照测，集成在 e2e 里走真进程表（Task 11）。

- [ ] **Step 1: 写失败测试**

创建 `test/liveSessions.test.ts`：

```ts
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { LivenessSnapshot, liveSessionIn, readLiveness } from '../src/liveSessions';

/**
 * 用**临时 home** 造 `~/.claude/sessions/<pid>.json`，**绝不碰用户真实的
 * ~/.claude**（照 test/conversationFiles.test.ts 的 makeHome 写法）。
 */
async function makeHome(files: Record<string, string>): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxterm-live-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(home, '.claude', 'sessions', rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, text, 'utf8');
  }
  return home;
}

const rec = (pid: number, sessionId: string, startedAt: number, cwd = '/a') =>
  JSON.stringify({ pid, sessionId, startedAt, cwd, status: 'busy', name: 'x', nameSource: 'derived' });

describe('readLiveness', () => {
  const homes: string[] = [];
  const mk = async (files: Record<string, string>) => {
    const h = await makeHome(files);
    homes.push(h);
    return h;
  };
  after(async () => {
    for (const h of homes) await fs.rm(h, { recursive: true, force: true });
  });

  it('注册表按 pid 索引', async () => {
    const home = await mk({ '111.json': rec(111, 's1', 10), '222.json': rec(222, 's2', 20) });
    const snap = await readLiveness(home);
    assert.strictEqual(snap.sessions.size, 2);
    assert.strictEqual(snap.sessions.get(111)?.sessionId, 's1');
    assert.strictEqual(snap.sessions.get(222)?.sessionId, 's2');
  });

  it('注册表目录不存在 → 空 sessions，不抛', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxterm-live-none-'));
    homes.push(home);
    const snap = await readLiveness(home);
    assert.strictEqual(snap.sessions.size, 0);
  });

  it('损坏 / 不合规的文件被跳过，其余照常读到', async () => {
    const home = await mk({
      '111.json': rec(111, 's1', 10),
      '222.json': '{oooo',
      '333.json': rec(333, '   ', 10),
    });
    const snap = await readLiveness(home);
    assert.deepStrictEqual([...snap.sessions.keys()], [111]);
  });

  it('走的是真实 `ps`：进程表里至少解析得出本进程', async () => {
    const home = await mk({});
    const snap = await readLiveness(home);
    assert.ok(snap.procs.some((n) => n.pid === process.pid), '进程表里应有本进程');
    assert.ok(snap.procs.length > 0);
  });
});

describe('liveSessionIn —— 从快照解析某个 pane 下「最后用过的会话」', () => {
  const snap = (
    procs: Array<[number, number]>,
    sessions: Array<[number, string, number]>,
  ): LivenessSnapshot => ({
    procs: procs.map(([pid, ppid]) => ({ pid, ppid })),
    sessions: new Map(
      sessions.map(([pid, sessionId, startedAt]) => [pid, { pid, sessionId, startedAt, cwd: '/a' }]),
    ),
  });

  it('命中：pane_pid 的直接子进程在注册表里', () => {
    assert.strictEqual(liveSessionIn(snap([[100, 1], [200, 100]], [[200, 'sess', 10]]), 100)?.sessionId, 'sess');
  });

  it('多层后代也命中（pane_pid → shell → 更深的 claude）', () => {
    const s = snap([[100, 1], [150, 100], [200, 150]], [[200, 'sess', 10]]);
    assert.strictEqual(liveSessionIn(s, 100)?.sessionId, 'sess');
  });

  it('★ 同一 pane 下两个 claude → 取 startedAt 最新', () => {
    const s = snap([[100, 1], [200, 100], [201, 100]], [[200, '旧', 10], [201, '新', 20]]);
    assert.strictEqual(liveSessionIn(s, 100)?.sessionId, '新');
  });

  it('pane 无后代 → undefined', () => {
    assert.strictEqual(liveSessionIn(snap([[100, 1]], [[200, 'sess', 10]]), 100), undefined);
  });

  it('后代与注册表无交集 → undefined（解析不出就是解析不出，不猜）', () => {
    assert.strictEqual(liveSessionIn(snap([[100, 1], [200, 100]], [[999, 'sess', 10]]), 100), undefined);
  });

  it('pane_pid 不在进程表里 → undefined', () => {
    assert.strictEqual(liveSessionIn(snap([[200, 100]], [[200, 'sess', 10]]), 999), undefined);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run compile && npx mocha out/test/liveSessions.test.js`
Expected: FAIL（`src/liveSessions.ts` 不存在）

- [ ] **Step 3: 写最小实现（`liveSessions.ts`）**

创建 `src/liveSessions.ts`：

```ts
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { SessionRecord, parseSessionRecord, pickLiveSession } from './core/liveSession';
import { ProcNode, descendantsOf, parseProcTable } from './core/processTree';

const run = promisify(execFile);

/**
 * 「这一刻系统里有哪些进程、claude 的会话注册表里都记着谁」的一次性快照。
 *
 * **整批条目共用一份** —— 一次 reconcile 只 spawn 一次 `ps`、只 readdir 一次
 * 注册表，绝不按条目各查一遍。
 */
export interface LivenessSnapshot {
  readonly procs: readonly ProcNode[];
  /** 注册表按 pid 索引（注册表只有个位数文件、每个 ~350 B，整体读入即可） */
  readonly sessions: ReadonlyMap<number, SessionRecord>;
}

/** 读一次快照。`ps` 失败 / 注册表目录不存在都返回空快照，绝不抛。 */
export async function readLiveness(home: string): Promise<LivenessSnapshot> {
  return { procs: await readProcTable(), sessions: await readSessions(home) };
}

/** `ps -eo pid=,ppid=`：等号让 ps 省掉表头，输出即 `  pid  ppid` 两列。 */
async function readProcTable(): Promise<ProcNode[]> {
  try {
    const { stdout } = await run('ps', ['-eo', 'pid=,ppid=']);
    return parseProcTable(stdout);
  } catch {
    return []; // ps 不可用 → 空进程表（= 观测不到，不是猜）
  }
}

async function readSessions(home: string): Promise<Map<number, SessionRecord>> {
  const dir = path.join(home, '.claude', 'sessions');
  const out = new Map<number, SessionRecord>();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return out; // 没有 ~/.claude/sessions —— 正常情况（从没用过 claude）
  }
  // 注册表只有个位数文件、每个几百字节，串行读完即可，不值得引入并发。
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = parseSessionRecord(await fs.readFile(path.join(dir, name), 'utf8'));
      if (record !== undefined) out.set(record.pid, record);
    } catch {
      // 单个文件读不动 / 内容不合规 → 跳过，不影响其余
    }
  }
  return out;
}

/**
 * 从快照解析出某个 pane 下「最后用过的会话」。
 * 取不到（进程表查不到 pane、没有后代 claude、注册表里没有它）→ undefined。
 * **解析不出就是解析不出，不猜。**
 */
export function liveSessionIn(snap: LivenessSnapshot, panePid: number): SessionRecord | undefined {
  const hits: SessionRecord[] = [];
  for (const pid of descendantsOf(snap.procs, panePid)) {
    const record = snap.sessions.get(pid);
    if (record !== undefined) hits.push(record);
  }
  return pickLiveSession(hits);
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm run compile && npx mocha out/test/liveSessions.test.js`
Expected: PASS（4 + 6 = 10 项全绿）

- [ ] **Step 5: 给 `TmuxClient` 加 `panePid`**

把 `src/tmuxClient.ts` 顶部 import 的 `parseAttachedCount` 一行改成同时引入 `parsePid`：

```ts
import {
  isShellReady,
  paneTarget,
  parseAttachedCount,
  parsePid,
  parseSessionList,
  sessionTarget,
} from './core/tmux';
```

并在 `attachedClients`（现第 54-63 行）之后插入：

```ts
  /**
   * 取 pane 的 pid（外层 shell）。读不出返回 null —— 与 attachedClients
   * 同一套「未知 ≠ 0」约定。
   *
   * 这是「这个终端此刻在用哪条 claude 会话」这条链的起点：pane_pid →
   * 后代 claude 进程 → `~/.claude/sessions/<pid>.json` → sessionId。
   * 目标同样必须走 paneTarget（`=名字:`），漏冒号时 tmux 是 exit 0 + 空输出。
   */
  async panePid(name: string): Promise<number | null> {
    try {
      const { stdout } = await run(this.tmuxPath, [
        'display-message', '-p', '-t', paneTarget(name), '#{pane_pid}',
      ]);
      return parsePid(stdout);
    } catch {
      return null;
    }
  }
```

- [ ] **Step 6: 编译，确认通过**

Run: `npm run compile`
Expected: 退出码 0，无类型错误。

- [ ] **Step 7: 提交**

```bash
git add src/liveSessions.ts src/tmuxClient.ts test/liveSessions.test.ts
git commit -m "feat: 新增 liveSessions IO 层（ps + 会话注册表）与 TmuxClient.panePid"
```

---

### Task 7: `TaskTitleCache` + `extension.ts` 接线

本 Task 落地任务名缓存的**全部逻辑**，并把它作为**可选**构造参数注入 `TerminalManager` 与 `EntryTreeProvider`（参数在这里声明，Task 8 / Task 10 才真正使用它们 —— 参数是可选且未被读，`strict` 下不报错）。

**Files:**
- Create: `src/taskTitles.ts`
- Modify: `src/terminalManager.ts:68-71`（构造函数加第三个可选参数）
- Modify: `src/tree.ts:159-174`（构造函数加第三个可选参数）
- Modify: `src/extension.ts:42-44`（实例化并注入）
- Test: `test/taskTitles.test.ts`

**Interfaces:**
- Consumes: `findConversationFile` / `readTail` / `TAIL_BYTES`（Task 5）、`parseAiTitle`（Task 5）
- Produces:
  - `class TaskTitleCache` with `constructor(home: string, readTitle?: (conversationId: string, cwd: string) => Promise<string | undefined>)`、`peek(conversationId: string | undefined): string | undefined`、`prewarm(conversationId: string | undefined, cwd: string): void`
  - `TerminalManager` 多一个**可选**第三参 `titles?: { prewarm(conversationId: string | undefined, cwd: string): void }`（Task 8 用它预热）
  - `EntryTreeProvider` 多一个**可选**第三参 `titleFallback?: { peek(conversationId: string | undefined): string | undefined }`（Task 10 用它取回退名）

**模型：异步预取 + 同步 peek。** `prewarm` 只发起后台读、立即返回；`peek` 是纯内存查表，命中即返回、未命中返回 `undefined`，**绝不阻塞读盘**。即渲染路径可能有一两拍拿不到回退名字，下一拍就有了 —— 这是刻意的：900 ms 的渲染节拍上，为一次可能的读盘卡住 UI 是不可接受的。

- [ ] **Step 1: 写失败测试**

创建 `test/taskTitles.test.ts`：

```ts
import * as assert from 'assert';
import { TaskTitleCache } from '../src/taskTitles';

/** prewarm 是 fire-and-forget（返回 void），测试里等几拍让它落地。 */
const settle = () => new Promise((r) => setTimeout(r, 10));

describe('TaskTitleCache —— 异步预取 + 同步 peek', () => {
  it('prewarm 之后 peek 命中', async () => {
    const titles = new TaskTitleCache('/nonexistent', async () => '任务名');
    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(titles.peek('c1'), '任务名');
  });

  it('未 prewarm → undefined（peek 绝不阻塞读盘）', () => {
    const titles = new TaskTitleCache('/nonexistent', async () => '任务名');
    assert.strictEqual(titles.peek('c1'), undefined);
  });

  it('peek(undefined) / peek(空串) → undefined', () => {
    const titles = new TaskTitleCache('/nonexistent', async () => '任务名');
    assert.strictEqual(titles.peek(undefined), undefined);
    assert.strictEqual(titles.peek(''), undefined);
  });

  it('prewarm(undefined, cwd) 不发起读', async () => {
    let calls = 0;
    const titles = new TaskTitleCache('/nonexistent', async () => { calls++; return 'x'; });
    titles.prewarm(undefined, '/x');
    titles.prewarm('', '/x');
    await settle();
    assert.strictEqual(calls, 0);
  });

  it('换绑（不同 conversationId）→ 各自独立', async () => {
    const titles = new TaskTitleCache('/nonexistent', async (id) => `标题-${id}`);
    titles.prewarm('c1', '/x');
    titles.prewarm('c2', '/y');
    await settle();
    assert.strictEqual(titles.peek('c1'), '标题-c1');
    assert.strictEqual(titles.peek('c2'), '标题-c2');
  });

  it('★ 读不到不缓存：下一次 prewarm 会重试（/new 后新对话还没生成标题）', async () => {
    let calls = 0;
    let answer: string | undefined;
    const titles = new TaskTitleCache('/nonexistent', async () => { calls++; return answer; });

    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(calls, 1);
    assert.strictEqual(titles.peek('c1'), undefined, '读不到 → 不进缓存');

    answer = '后来才有的标题';
    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(calls, 2, '第二次 prewarm 必须重试');
    assert.strictEqual(titles.peek('c1'), '后来才有的标题');
  });

  it('已缓存则不重复读盘', async () => {
    let calls = 0;
    const titles = new TaskTitleCache('/nonexistent', async () => { calls++; return '名'; });
    titles.prewarm('c1', '/x');
    await settle();
    titles.prewarm('c1', '/x');
    await settle();
    assert.strictEqual(calls, 1);
  });

  it('cwd 会传给 reader（findConversationFile 要按 id + cwd 定位）', async () => {
    const seen: string[] = [];
    const titles = new TaskTitleCache('/nonexistent', async (_id, cwd) => { seen.push(cwd); return '名'; });
    titles.prewarm('c1', '/some/cwd');
    await settle();
    assert.deepStrictEqual(seen, ['/some/cwd']);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run compile && npx mocha out/test/taskTitles.test.js`
Expected: FAIL（`src/taskTitles.ts` 不存在）

- [ ] **Step 3: 写最小实现**

创建 `src/taskTitles.ts`：

```ts
import { TAIL_BYTES, findConversationFile, readTail } from './conversationFiles';
import { parseAiTitle } from './core/conversation';

/** 缓存条目上限（超出按最久未访问逐出）—— 只为防条目数异常增长时无界占内存。 */
const MAX_ENTRIES = 256;

/**
 * 绑定对话的 aiTitle 只读一次，缓存在内存里。
 *
 * **为什么不每次 poll 都读**：活动轮询是 900 ms 一轮，每轮为每个条目
 * tail-read 一个可能上 MB 的 transcript 是不可接受的。缓存在 **reconcile
 * 时**预热（那时本来就在查注册表），渲染路径只剩一次 Map 命中。
 *
 * **模型：异步预取 + 同步 peek。** `prewarm` 只发起后台读、立即返回；
 * `peek` 是纯内存查表，命中即返回、未命中返回 `undefined`，绝不阻塞读盘。
 *
 * **失效与容量**：
 * - 读不到**不写缓存** —— /new 之后新对话要过几个来回才生成 aiTitle，
 *   把它当成「没有」缓存住会让第三级永远不出现；下次 prewarm 重试。
 * - 键 = conversationId：条目改绑后 peek 自然落到新键上 miss 并触发一次
 *   新 prewarm，旧键随容量逐出，不需要显式失效。
 * - 无持久化：进程退出即清空。
 */
export class TaskTitleCache {
  private readonly cache = new Map<string, string>();
  /** 已在读、但还没落地的 key —— 防止同一拍内重复读盘。 */
  private readonly pending = new Set<string>();

  /**
   * @param home 定位 `~/.claude/projects`；与 `TerminalManager.home()` 同源。
   * @param readTitle 读一条 transcript 尾部并取 aiTitle。省略时用默认实现
   *   （findConversationFile → readTail → parseAiTitle）。以参数注入是为了：
   *   单测注入假 reader 断言「读不到不缓存、下次 prewarm 重试」。
   */
  constructor(
    private readonly home: string,
    private readonly readTitle?: (conversationId: string, cwd: string) => Promise<string | undefined>,
  ) {}

  /** 同步读缓存。未缓存 / 传 undefined → undefined。渲染路径上唯一被调用的方法。 */
  peek(conversationId: string | undefined): string | undefined {
    if (conversationId === undefined || conversationId.length === 0) return undefined;
    const hit = this.cache.get(conversationId);
    if (hit === undefined) return undefined;
    // LRU：命中即移到队尾（最久未访问的排在最前，逐出时取第一个）
    this.cache.delete(conversationId);
    this.cache.set(conversationId, hit);
    return hit;
  }

  /**
   * 异步预取，**fire-and-forget**（返回 void，不是 Promise）。
   * 已缓存 / 已在读则直接返回；否则在后台读盘，读回后写入缓存。
   * `cwd` 必需 —— findConversationFile 要按 id + cwd 精确定位
   * （同一 id 可能出现在多个 project 目录下）。
   */
  prewarm(conversationId: string | undefined, cwd: string): void {
    if (conversationId === undefined || conversationId.length === 0) return;
    if (this.cache.has(conversationId) || this.pending.has(conversationId)) return;
    this.pending.add(conversationId);
    void this.load(conversationId, cwd);
  }

  private async load(conversationId: string, cwd: string): Promise<void> {
    try {
      const title = await this.read(conversationId, cwd);
      if (title !== undefined && title.length > 0) {
        this.cache.set(conversationId, title);
        while (this.cache.size > MAX_ENTRIES) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cache.delete(oldest);
        }
      }
      // 读不到 → 什么都不写，下次 prewarm 会重试
    } catch {
      // 读盘失败 → 当作读不到（安全侧：不显示第三级），下次重试
    } finally {
      this.pending.delete(conversationId);
    }
  }

  private async read(conversationId: string, cwd: string): Promise<string | undefined> {
    if (this.readTitle !== undefined) return this.readTitle(conversationId, cwd);
    const file = await findConversationFile(this.home, conversationId, cwd);
    if (file === undefined) return undefined;
    return parseAiTitle(await readTail(file, TAIL_BYTES));
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm run compile && npx mocha out/test/taskTitles.test.js`
Expected: PASS（8 项全绿）

- [ ] **Step 5: 给 `TerminalManager` 加可选注入参数**

把 `src/terminalManager.ts:68-71` 的

```ts
  constructor(
    private readonly store: EntryStore,
    private readonly tmux: TmuxClient,
  ) {
```

改成：

```ts
  constructor(
    private readonly store: EntryStore,
    private readonly tmux: TmuxClient,
    /**
     * 任务名回退源（只读内存缓存）。reconcile 时对**当前绑定**调一次
     * prewarm 预热，渲染层才能同步 peek 到「绑定对话的 aiTitle」。
     * 用最小接口而不是具体类型，与 tree.ts 的 store/activity 同一处理方式。
     * 省略 = 不预热（既有调用方不受影响）。
     */
    private readonly titles?: { prewarm(conversationId: string | undefined, cwd: string): void },
  ) {
```

- [ ] **Step 6: 给 `EntryTreeProvider` 加可选注入参数**

把 `src/tree.ts:159-174` 的构造函数整段

```ts
  constructor(
    private readonly store: {
      load(): Promise<TerminalEntry[]>;
      reorder(ids: string[]): Promise<void>;
    },
    /**
     * 活动状态的只读查询接口，由 extension.ts 传入真正的 ActivityTracker。
     * 用最小接口而不是具体类型，让 tree.ts 不必知道 ActivityTracker 的
     * 轮询细节（与上面 store 参数同样的处理方式）。省略时所有条目的
     * activity 都是 undefined（不生成三级节点，二级图标退回默认逻辑），
     * 不影响既有调用方（比如批量面板用的是另一个 Provider，不受影响）。
     */
    private readonly activity?: {
      activityFor(entryId: string): EntryActivity | undefined;
    },
  ) {}
```

改成（只在末尾**追加**一个参数，前两个一字未改）：

```ts
  constructor(
    private readonly store: {
      load(): Promise<TerminalEntry[]>;
      reorder(ids: string[]): Promise<void>;
    },
    /**
     * 活动状态的只读查询接口，由 extension.ts 传入真正的 ActivityTracker。
     * 用最小接口而不是具体类型，让 tree.ts 不必知道 ActivityTracker 的
     * 轮询细节（与上面 store 参数同样的处理方式）。省略时所有条目的
     * activity 都是 undefined（不生成三级节点，二级图标退回默认逻辑），
     * 不影响既有调用方（比如批量面板用的是另一个 Provider，不受影响）。
     */
    private readonly activity?: {
      activityFor(entryId: string): EntryActivity | undefined;
    },
    /**
     * 任务名回退源：**同步读内存缓存，不发 IO、不触发观测**（观测统一由
     * extension.ts 驱动，provider 不持有 reconciler）。
     * 省略 = 无回退（只剩 pane title 一个来源）。
     */
    private readonly titleFallback?: {
      peek(conversationId: string | undefined): string | undefined;
    },
  ) {}
```

- [ ] **Step 7: 在 `extension.ts` 里实例化并注入同一个实例**

把 `src/extension.ts:42-44` 的

```ts
  const tracker = new ActivityTracker(tmux);
  const provider = new EntryTreeProvider(store, tracker);
  const manager = new TerminalManager(store, tmux);
```

改成：

```ts
  // 任务名回退源：**只有一个实例**，同时注入 provider（渲染时 peek）
  // 与 manager（reconcile 时 prewarm）。home 与 manager.home() 同源
  // （扩展进程里 os.homedir() 就是它）。
  const titles = new TaskTitleCache(os.homedir());
  const tracker = new ActivityTracker(tmux);
  const provider = new EntryTreeProvider(store, tracker, titles);   // 渲染：peek
  const manager = new TerminalManager(store, tmux, titles);         // reconcile：prewarm
```

并在 `src/extension.ts` 顶部的 import 区加两行：

```ts
import * as os from 'os';
import { TaskTitleCache } from './taskTitles';
```

（`import * as path from 'path';` 现第 2 行之后加 `os`，第 9 行 `import { ActivityTracker } from './activityTracker';` 之后加 `TaskTitleCache`。）

- [ ] **Step 8: 编译，确认通过**

Run: `npm run compile`
Expected: 退出码 0，无类型错误。（`titles` / `titleFallback` 此刻只是被存下、还没被读 —— `strict` 不含 `noUnusedParameters`，不报错。）

- [ ] **Step 9: 跑全量单测，确认既有调用方不受影响**

Run: `npm test`
Expected: 全绿（`EntryTreeProvider` / `TerminalManager` 的既有调用点都只传前两个参数，结构类型 + 可选参数保证不受影响）

- [ ] **Step 10: 提交**

```bash
git add src/taskTitles.ts src/terminalManager.ts src/tree.ts src/extension.ts test/taskTitles.test.ts
git commit -m "feat: 新增 TaskTitleCache（异步预取 + 同步 peek）并接入 provider 与 manager"
```

---

### Task 8: `TerminalManager` —— reconcile 与恢复路径改造

**Files:**
- Modify: `src/terminalManager.ts:246`（`resolveLaunchSpec` 签名与兜底 D）
- Modify: `src/terminalManager.ts:384-504`（`openEntry` 先 reconcile）
- Modify: `src/terminalManager.ts:596-630`（`restartClaude` 先 reconcile）
- Modify: `src/terminalManager.ts`（新增 `reconcileAll` / `reconcileOne` / `liveFor`）
- Modify: `src/terminalManager.ts:1-28`（import）

**Interfaces:**
- Consumes: `reconcileBinding`（Task 3）、`readLiveness` / `liveSessionIn` / `LivenessSnapshot`（Task 6）、`TaskTitleCache.prewarm`（Task 7）、`candidatesForCwd` / `listConversations` / `cwdFor` / `store`（既有）
- Produces:
  - `async reconcileAll(entries: readonly TerminalEntry[]): Promise<boolean>` —— Task 9（`extension.ts` 的 `reconcileNow`）调用
  - `private async reconcileOne(entry): Promise<{ entry: TerminalEntry; live: string | undefined }>`
  - `private async resolveLaunchSpec(entry: TerminalEntry, live: string | undefined): Promise<LaunchSpec | undefined>`（签名多一个参数）

**测试说明（重要）：** 本 Task 改的全是 `vscode` 依赖的类内部逻辑，无法用纯 mocha 单测（`core/*` 那部分规则已在 Task 3 单测过）。正确性由 **Task 11 的 e2e harness**（真 tmux + 真 `ps` + 假 HOME）覆盖 —— 其中「`/new` 自愈」「切 profile 先 reconcile」「手动改绑不被冲掉」「观测不到就不动」「兜底 D 两侧与等价路径」全部对应本 Task 的改动。本 Task 的验证闸门是**严格类型检查**。

- [ ] **Step 1: 补 import**

把 `src/terminalManager.ts:26` 的

```ts
import { findConversations, listConversations } from './conversationFiles';
```

改成（下一行接着加两个新 import）：

```ts
import { findConversations, listConversations } from './conversationFiles';
import { LivenessSnapshot, liveSessionIn, readLiveness } from './liveSessions';
import { reconcileBinding } from './core/reconcile';
```

- [ ] **Step 2: 新增 reconcile 三个私有/公开方法**

在 `bindConversationInteractive`（现第 363 行 `}` 之后）、`cwdFor`（现第 365 行）**之前**插入：

```ts
  // ---- 会话身份：跟随终端最后用过的会话（reconcile，只读观测 + 回写绑定） ----

  /**
   * 从一份快照里解析某条目 pane 下「最后用过的会话」。
   * 取不到（pane 查不到、没有后代 claude、注册表里没有它）→ undefined。
   */
  private async liveFor(snap: LivenessSnapshot, entry: TerminalEntry): Promise<string | undefined> {
    const panePid = await this.tmux.panePid(sessionNameFor(entry.id));
    if (panePid === null) return undefined;
    return liveSessionIn(snap, panePid)?.sessionId;
  }

  /**
   * 观测一批条目的活跃会话并回写绑定。返回 true = 至少写了一条。
   *
   * - 只处理「tmux 会话存活」的条目：会话都没了就没有活着的 claude 可观测，
   *   此时**绝不**去改绑定（那会让 D 兜底之外的地方凭空「猜」）。
   * - 整批共用一份 LivenessSnapshot：`ps` 只 spawn 一次。
   * - 每条只在 reconcileBinding 返回非 undefined 时写一次 store.update。
   * - 顺带预热任务名缓存：渲染层才能同步 peek 到「绑定对话的 aiTitle」。
   *   预热的是**回写之后**的 conversationId（那才是渲染层要看的键），
   *   没有回写时就是原值。
   */
  async reconcileAll(entries: readonly TerminalEntry[]): Promise<boolean> {
    const alive = new Set(await this.tmux.listSessions());
    const snap = await readLiveness(this.home());
    let wrote = false;
    for (const entry of entries) {
      if (!alive.has(sessionNameFor(entry.id))) continue; // 会话都不在了 → 不观测
      const live = await this.liveFor(snap, entry);
      const patch = reconcileBinding(
        { conversationId: entry.conversationId, liveSessionId: entry.liveSessionId },
        live,
      );
      this.titles?.prewarm(patch?.conversationId ?? entry.conversationId, this.cwdFor(entry));
      if (patch === undefined) continue;
      await this.store.update(entry.id, patch);
      wrote = true;
    }
    return wrote;
  }

  /**
   * 单条版本；两处触发用 —— openEntry 的点击 与 restartClaude 的切 profile。
   * 返回回写后的条目（无变化时原样返回）**与本次观测到的活跃会话 id** ——
   * 后者供 resolveLaunchSpec 的兜底 D 判断「claude 是不是真的不在了」，
   * 免得为同一个判断再观测一次（多 spawn 一个 `ps`，还可能得出不一致的结论）。
   *
   * tmux 会话不存在时不做任何观测，返回 { 原条目, undefined }。
   * 刻意**不**经 reconcileAll 的 in-flight 合并：这两处都是低频动作，
   * 且用户就在等结果（见 spec §5.1 / §5.4）。
   */
  private async reconcileOne(
    entry: TerminalEntry,
  ): Promise<{ entry: TerminalEntry; live: string | undefined }> {
    const session = sessionNameFor(entry.id);
    if (!(await this.tmux.hasSession(session))) return { entry, live: undefined };

    const snap = await readLiveness(this.home());
    const live = await this.liveFor(snap, entry);
    const patch = reconcileBinding(
      { conversationId: entry.conversationId, liveSessionId: entry.liveSessionId },
      live,
    );
    this.titles?.prewarm(patch?.conversationId ?? entry.conversationId, this.cwdFor(entry));
    if (patch === undefined) return { entry, live };

    await this.store.update(entry.id, patch);
    return { entry: { ...entry, ...patch }, live };
  }
```

- [ ] **Step 3: 改 `resolveLaunchSpec`（签名 + 兜底 D）**

把 `src/terminalManager.ts:246` 的签名行

```ts
  private async resolveLaunchSpec(entry: TerminalEntry): Promise<LaunchSpec | undefined> {
    const cwd = this.cwdFor(entry);
    const bound = entry.conversationId;
```

改成：

```ts
  private async resolveLaunchSpec(
    entry: TerminalEntry,
    /**
     * 本次 reconcileOne 观测到的活跃会话 id；undefined = 观测不到。
     * 空串在这里不会出现 —— parseSessionRecord 已把空/纯空白判为 undefined，
     * 故下面只需判 `undefined`；万一出现空串也只会落进「不启用 D」的保守侧。
     */
    live: string | undefined,
  ): Promise<LaunchSpec | undefined> {
    const cwd = this.cwdFor(entry);
    const bound = entry.conversationId;
```

再在「未绑定」分支的 `// **整段**放进 pickChain 的同一个 op` 注释**之前**（即现第 273 行 `}` 与第 275 行注释之间）插入兜底 D：

```ts
    // ---- 兜底 D（**收窄**）：mtime 启发式 ----
    // A 观测不到活跃会话（claude 已死）—— 那就不存在「这个终端在用哪条会话」
    // 的权威答案；此时**只有**在「该 cwd 下只有这一个条目」时才敢退回 mtime：
    //   - 单条目 → 不可能与别的条目争同一条 .jsonl，猜错也只是接回自己目录下
    //     最近用过的那条，代价可控；
    //   - 多条目共用 cwd → 猜错就是两条会话共写一条记录（数据损坏级），
    //     宁可弹框问。
    //
    // 唯一性判据必须按 **cwdFor() 展开后的路径**比较，而不是原始串：
    // cwd 支持 `~`（同一批条目里 `~/x` 与 `/home/u/x` 原始串不相等、展开后
    // 是同一个目录）。按原始串判会让两个条目**各自**满足「只有我一个」，
    // 双双走 D 并接到同一条 .jsonl 上 —— 恰好击穿 D 自己要防的数据损坏。
    // 展开路径也正是真正启动时用的那个目录（cwdFor 同时喂给 newSession）。
    const soleInCwd = (await this.store.load()).filter((e) => this.cwdFor(e) === cwd).length === 1;
    if (live === undefined && soleInCwd) {
      const candidates = candidatesForCwd(await listConversations(this.home()), cwd);
      if (candidates.length > 0) {
        // 与「手动改绑」同一侧：**只写 conversationId，不动 liveSessionId**
        //（这是推断，不是观测，不该冒充观测值）。
        await this.store.update(entry.id, { conversationId: candidates[0].id });
        return { kind: 'resume', conversationId: candidates[0].id };
      }
    }
```

（注意「未绑定 + claude 还活着」根本到不了这里：`reconcileOne` 的**首观测**规则 —— `liveSessionId` 为空、`live` 有值 → 回写两者 —— 已经把它绑上了。所以 D 分支面对的一定是「claude 真的不在了」这一种情况。）

- [ ] **Step 4: 改 `openEntry`（先 reconcile，后续一律用改绑后的快照）**

把 `src/terminalManager.ts:386-388` 的

```ts
    // tmux 会话名由条目 id 派生，与显示名解耦（显示名可随意改名）。
    const session = sessionNameFor(entry.id);
    const cwd = this.cwdFor(entry);
```

改成：

```ts
    // tmux 会话名由条目 id 派生，与显示名解耦（显示名可随意改名）。
    const session = sessionNameFor(entry.id);
    const cwd = this.cwdFor(entry);

    // 点击条目 = reconcile 的触发点之一（不引入定时器，见 spec §4.3）。
    // 必须在算 --resume 之前：/new 之后「这个终端在用哪条会话」已经变了，
    // 正确答案得重新观测。返回改绑后的新快照（后续一律用它）与本次观测到
    // 的活跃会话 id（兜底 D 要用它判断 claude 是不是真的不在了）。
    const { entry: current, live } = await this.reconcileOne(entry);
```

再把 `:485` 的

```ts
    const spec = await this.resolveLaunchSpec(entry);
```

改成：

```ts
    const spec = await this.resolveLaunchSpec(current, live);
```

把 `:500` 的

```ts
    await this.tmux.sendLiteral(session, conversationCommand(entry, spec));
```

改成：

```ts
    await this.tmux.sendLiteral(session, conversationCommand(current, spec));
```

把 `:503` 的

```ts
    if (spec.kind === 'resume') await this.warnIfResumeFailed(session, entry);
```

改成：

```ts
    if (spec.kind === 'resume') await this.warnIfResumeFailed(session, current);
```

- [ ] **Step 5: 改 `restartClaude`（切 profile 也是触发点）**

把 `src/terminalManager.ts:600-601` 的

```ts
    const session = sessionNameFor(entry.id);
    const bound = launch.conversationId;
```

改成：

```ts
    const session = sessionNameFor(entry.id);

    // 切 profile 也是 reconcile 的触发点（spec §4.3）。必须 `--resume` 之前做：
    // 用户刚在 pane 里 /new 过，静态 conversationId 已经不是终端在用的那条。
    // 只观测 entry（会话归属由 id 派生），launch 的 profile/model 覆盖不受影响。
    const { entry: current } = await this.reconcileOne(entry);
    const bound = current.conversationId;
```

再把 `:626` 的

```ts
    await this.tmux.sendLiteral(session, conversationCommand(launch, { kind: 'resume', conversationId: bound }));
```

改成：

```ts
    // 改的是**绑定**，不是 profile/model：launch 是调用方构造的覆盖层
    // （applyProfile 传 `{ ...entry, profile, model: undefined }`），
    // 把 reconcile 后的 conversationId 合并回去，profile/model 原样保留。
    const merged = { ...launch, conversationId: bound };
    await this.tmux.sendLiteral(session, conversationCommand(merged, { kind: 'resume', conversationId: bound }));
```

（原「没有绑定就拒绝」的守卫整段一字不改 —— 它现在用 reconcile **之后**的 `bound` 判断：`reconcileOne` 可能把原本未绑定的条目绑上（首观测规则），此时守卫放行，这正是「切 profile 时终端确实在用某条会话」的正确行为；观测不到时 `current.conversationId` 不变，未绑定仍按原逻辑拒绝。）

- [ ] **Step 6: 严格类型检查**

Run: `npx tsc -p ./ --noEmit`
Expected: 退出码 0，无输出。（若报 `resolveLaunchSpec` 参数数量不符，说明 `openEntry` 那处调用点没改；若报 `panePid` / `readLiveness` 不存在，说明 Task 6 没做完。）

- [ ] **Step 7: 提交**

```bash
git add src/terminalManager.ts
git commit -m "feat: TerminalManager 新增 reconcileAll/reconcileOne，恢复与切 profile 先 reconcile"
```

---

### Task 9: `extension.ts` —— 采样闸门竞态修复 + reconcile 触发点

**Files:**
- Modify: `src/extension.ts:78-96`（采样闸门，`pollActivity`）
- Modify: `src/extension.ts:123-140`（`reconcileNow` + 触发点注册）
- Modify: `src/extension.ts:234-237`（`tmuxTerminals.refresh`）

**Interfaces:**
- Consumes: `TerminalManager.reconcileAll`（Task 8）、`store.load` / `tmux.listSessions` / `provider.setAlive` / `tracker.poll`（既有）
- Produces: 无新增导出。触发点：激活 / ⟳ / 展开树 / 面板变为可见（另外两个在 Task 8 的 `openEntry` 与 `restartClaude` 里）。

**测试说明：** 同样改的是 `vscode` 接线层，无法单元测试；验证闸门是严格类型检查 + Task 11 的 e2e（e2e 不经 `extension.ts`，故这里主要靠编译与人工核对触发点齐全）。

- [ ] **Step 1: 修采样闸门竞态**

把 `src/extension.ts:102-114` 的

```ts
  let activityInFlight = false;
  const pollActivity = async () => {
    if (activityInFlight) return;
    activityInFlight = true;
    try {
      const entries = await store.load();
      const aliveIds = entries
        .filter((e) => provider.isAlive(sessionNameFor(e.id)))
        .map((e) => e.id);
      await tracker.poll(aliveIds);
    } finally {
      activityInFlight = false;
    }
  };
```

改成：

```ts
  let activityInFlight = false;
  const pollActivity = async () => {
    if (activityInFlight) return;
    activityInFlight = true;
    try {
      // 闸门必须来自**权威的 tmux 查询**，不能用 provider.isAlive：后者由
      // 10s 的存活轮询填充，而 poll() 有 inFlight 守卫 —— 激活时两个
      // restart* 并发启动，pollActivity 刚跑时第一次 listSessions 还没回来，
      // 于是第一轮 aliveIds 恒为空、一个条目都不采（实测症状）。
      const sessions = new Set(await tmux.listSessions());
      provider.setAlive(sessions); // 顺带把树的存活标记推到最新（setAlive 只在变化时 fire）
      const entries = await store.load();
      const aliveIds = entries
        .filter((e) => sessions.has(sessionNameFor(e.id)))
        .map((e) => e.id);
      await tracker.poll(aliveIds);
    } finally {
      activityInFlight = false;
    }
  };
```

（`ActivityTracker.poll` 的签名**保持不变**，仍是 `poll(aliveIds: string[])`；`core/activity.ts` 的三态状态机完全不需要改。代价是每 900 ms 多一次 `tmux ls`，一次进程 spawn 的量级，接受。`provider.isAlive` 这个方法保留不动 —— 删除它不在本次范围。）

- [ ] **Step 2: 加 `reconcileNow`（in-flight 合并）**

在 `restartActivityPolling`（现第 123 行 `}` 之后）、`context.subscriptions.push(`（现第 125 行）**之前**插入：

```ts
  // ---- 会话身份：reconcile 的触发点（不引入定时器，见 spec §4.3）----
  // 五个触发点：激活（本文件的末尾）、⟳ 刷新（下面的 refresh 命令）、
  // 点击条目（TerminalManager.openEntry）、切 profile
  // （TerminalManager.restartClaude）、展开树 / 面板变为可见（下面的订阅）。
  // 观测的驱动者只有这一处：provider 不持有 reconciler。
  let reconcileInFlight: Promise<boolean> | undefined;
  const reconcileNow = (): Promise<boolean> => {
    if (reconcileInFlight === undefined) {
      reconcileInFlight = (async () => {
        try {
          return await manager.reconcileAll(await store.load());
        } finally {
          reconcileInFlight = undefined; // 本轮结束才允许下一轮
        }
      })();
    }
    return reconcileInFlight;
  };
```

- [ ] **Step 3: 注册「展开树 / 面板变为可见」两个触发点**

把 `src/extension.ts:125-129` 的

```ts
  context.subscriptions.push(
    view.onDidChangeVisibility(() => {
      restartPolling();
      restartActivityPolling();
    }),
```

改成：

```ts
  context.subscriptions.push(
    view.onDidChangeVisibility(() => {
      restartPolling();
      restartActivityPolling();
      // 面板变为可见 = reconcile 的触发点之一。onDidExpandElement 单独用
      // 不够：它的语义是「**由用户**展开时」，而 FolderTreeItem 默认就是
      // Expanded，默认展开的文件夹节点不会发那个事件 —— 这里兜底。
      void reconcileNow();
    }),
    // 用户展开节点（折叠后再展开 / 展开一个默认折叠的文件夹）= 触发点之一。
    // 刻意挂在事件上而不是 getChildren：900ms 的活动轮询会让根 getChildren
    // 每秒跑一次，挂在那里等于引入一个隐式定时器。
    view.onDidExpandElement(() => void reconcileNow()),
```

- [ ] **Step 4: 激活时跑一次**

把 `src/extension.ts:139-140` 的

```ts
  restartPolling();
  restartActivityPolling();
```

改成：

```ts
  restartPolling();
  restartActivityPolling();
  void reconcileNow(); // 触发点之一：扩展激活
```

- [ ] **Step 5: ⟳ 刷新命令先 reconcile**

把 `src/extension.ts:234-237` 的

```ts
  reg('tmuxTerminals.refresh', async () => {
    await poll();
    provider.refresh();
  });
```

改成：

```ts
  reg('tmuxTerminals.refresh', async () => {
    await reconcileNow(); // 触发点之一：用户按 ⟳「只重查存活状态」
    await poll();
    provider.refresh();
  });
```

- [ ] **Step 6: 严格类型检查**

Run: `npx tsc -p ./ --noEmit`
Expected: 退出码 0，无输出。

- [ ] **Step 7: 提交**

```bash
git add src/extension.ts
git commit -m "fix: 活动采样闸门改用权威 tmux 查询；reconcile 挂上激活/⟳/展开/可见四个触发点"
```

---

### Task 10: `tree.ts` —— 三级任务名走 `taskNameFor`

**Files:**
- Modify: `src/tree.ts:65-105`（`EntryTreeItem` 构造函数）
- Modify: `src/tree.ts:116-136`（`TaskTreeItem` 构造函数）
- Modify: `src/tree.ts:195-219`（`getChildren`）
- Modify: `src/tree.ts`（新增 `taskNameFor`）

**Interfaces:**
- Consumes: `EntryTreeProvider` 的 `titleFallback` 参数（Task 7 已声明，本 Task 开始使用）、`activity`（既有）
- Produces: 无新增导出；但 `EntryTreeItem` / `TaskTreeItem` 的**构造签名各多一个参数** —— `extension.ts` 从不直接 `new` 它们（只在 `item()` 里做 `instanceof` 收窄），Task 11 的 e2e 会按新签名读 `.taskName`。

**测试说明：** 同样是 `vscode` 依赖的渲染层，无法单元测试；验证闸门是严格类型检查 + Task 11 的 e2e（「第三级回退」「都不显示时三级不出现」「首字符回归」三组用例）。

- [ ] **Step 1: `EntryTreeItem` 收显式 `taskName`**

把 `src/tree.ts:65-80` 的

```ts
export class EntryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: TerminalEntry,
    public readonly alive: boolean,
    /** 由 ActivityTracker 轮询得来的当前活动状态；未轮询到时为 undefined */
    public readonly activity: EntryActivity | undefined,
  ) {
    const taskName = activity?.taskName ?? '';
    super(
      entry.name,
      taskName.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
```

改成：

```ts
export class EntryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: TerminalEntry,
    public readonly alive: boolean,
    /** 由 ActivityTracker 轮询得来的当前活动状态；未轮询到时为 undefined */
    public readonly activity: EntryActivity | undefined,
    /**
     * 显示用的任务名：pane title 优先，回退到绑定对话的 aiTitle；'' = 不显示三级。
     * 由 `EntryTreeProvider.taskNameFor` 算好传进来（不再各自去读
     * activity.taskName —— 否则二级的 collapsibleState 会和三级是否真能
     * 展开不一致）。
     */
    public readonly taskName: string,
  ) {
    super(
      entry.name,
      taskName.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
```

（该构造函数里 tooltip 的 `- 任务：${taskName.length > 0 ? taskName : '（无）'}` 一行**一字不改** —— 它读的 `taskName` 现在来自参数而不是局部常量，语义正好是我们要的。）

- [ ] **Step 2: `TaskTreeItem` 收显式 `taskName`**

把 `src/tree.ts:116-136` 的

```ts
export class TaskTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: TerminalEntry,
    public readonly activity: EntryActivity,
  ) {
    super(activity.taskName, vscode.TreeItemCollapsibleState.None);
    this.id = `task:${entry.id}`;
    this.contextValue = 'task';
    this.iconPath =
      activity.state === 'running'
        ? new vscode.ThemeIcon('loading~spin', profileColor(entry))
        : activity.state === 'done-unseen'
          ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'))
          : new vscode.ThemeIcon('circle-filled', profileColor(entry));
```

改成：

```ts
export class TaskTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: TerminalEntry,
    /** 可能是 undefined —— 回退来的名字没有对应的本次采样状态。 */
    public readonly activity: EntryActivity | undefined,
    /** `label`/`id` 用它；图标仍按 `activity?.state` 三态，undefined 走 idle 分支。 */
    public readonly taskName: string,
  ) {
    super(taskName, vscode.TreeItemCollapsibleState.None);
    this.id = `task:${entry.id}`;
    this.contextValue = 'task';
    // 图标仍按活动状态三态。回退来的名字通常伴随 idle（或 activity 干脆是
    // undefined：该条目没被采过样），两者一并落到 idle 分支，**不新增状态**。
    this.iconPath =
      activity?.state === 'running'
        ? new vscode.ThemeIcon('loading~spin', profileColor(entry))
        : activity?.state === 'done-unseen'
          ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'))
          : new vscode.ThemeIcon('circle-filled', profileColor(entry));
```

- [ ] **Step 3: 加 `taskNameFor` 并改 `getChildren`**

在 `EntryTreeProvider` 的 `isAlive`（现第 191-193 行）之后插入：

```ts
  /**
   * 显示用的任务名：pane title（live，权威）→ 绑定对话的 aiTitle（回退）
   * → ''（不显示第三级）。
   *
   * **全都无从得知时返回空串** —— 不加灰色占位、不退化成
   * `~/.claude/sessions` 的 derived slug、不用首条用户消息摘要：把「不知道」
   * 伪装成「知道」是误导（spec §8 不变量 6）。
   *
   * 纯读：`peek` 同步、不发 IO、不触发观测（观测统一由 extension.ts 驱动）。
   */
  private taskNameFor(entry: TerminalEntry): string {
    const fromPane = this.activity?.activityFor(entry.id)?.taskName ?? '';
    return fromPane.length > 0
      ? fromPane
      : this.titleFallback?.peek(entry.conversationId) ?? '';
  }
```

再把 `getChildren` 里的两段（现第 203-218 行）

```ts
    if (element instanceof FolderTreeItem) {
      return element.entries.map(
        (e) => new EntryTreeItem(
          e,
          this.alive.has(sessionNameFor(e.id)),
          this.activity?.activityFor(e.id),
        ),
      );
    }
    if (element instanceof EntryTreeItem) {
      const activity = this.activity?.activityFor(element.entry.id);
      return activity !== undefined && activity.taskName.length > 0
        ? [new TaskTreeItem(element.entry, activity)]
        : [];
    }
```

改成：

```ts
    if (element instanceof FolderTreeItem) {
      return element.entries.map(
        (e) => new EntryTreeItem(
          e,
          this.alive.has(sessionNameFor(e.id)),
          this.activity?.activityFor(e.id),
          this.taskNameFor(e), // ← 新增参数
        ),
      );
    }
    if (element instanceof EntryTreeItem) {
      const activity = this.activity?.activityFor(element.entry.id);
      // 有名字才生三级 —— 名字可能来自回退，所以判据是 taskName 而不是 activity
      return element.taskName.length > 0
        ? [new TaskTreeItem(element.entry, activity, element.taskName)]
        : [];
    }
```

- [ ] **Step 4: 严格类型检查**

Run: `npx tsc -p ./ --noEmit`
Expected: 退出码 0，无输出。

- [ ] **Step 5: 跑全量单测（确认 manifest 交叉校验仍绿）**

Run: `npm test`
Expected: 全绿（`test/manifest.test.ts` 的 `contextValue` 交叉校验不受影响：两个节点的 `contextValue` 值 `'aliveSession'/'deadSession'/'task'` 一字未改）

- [ ] **Step 6: 提交**

```bash
git add src/tree.ts
git commit -m "feat: 三级任务名走 pane title → 绑定对话 aiTitle 的回退链"
```

---

### Task 11: e2e harness —— 会话身份与任务名回退链场景

**Files:**
- Modify: `test/e2e-harness.js:192-200` 附近（新增模块级常量与辅助函数）
- Modify: `test/e2e-harness.js:1176`（在第 18 节之后、第 15 节清理之前插入新的第 19、20 节）
- Modify: `test/e2e-harness.js:1178-1210`（清理节：杀掉桩进程 + 清掉新目录）

**Interfaces:**
- Consumes: `TerminalManager` / `EntryTreeProvider` / `TaskTitleCache`（编译产物 `out/src/*.js`）、真 `tmux`、真 `ps`
- Produces: 无新增导出，纯新增场景。

**接缝（沿用 harness 已有的「pane 内以绝对路径拉起假进程」惯例）：**

1. `tmux.newSession` 建会话，再 `sendLiteral` 一个**绝对路径**的假 claude 桩并回车 —— 这样不会被 PATH 桩换掉，也不会触到 `/usr/bin/claude`。
2. 桩脚本把自己的 `$$` 写进**命令行给它的绝对路径**（`PID_DIR/<id>`），harness 读这个文件即拿到真实 pid。**这个 pid 就是生产代码将要看到的后代 pid。**
3. 写 `HOME/.claude/sessions/<pid>.json` = `{ pid, sessionId, cwd, startedAt }`（目录不存在就先 mkdir -p）—— 这是**唯一**需要注入的东西，走 `home`。
4. 断言时用同一个 pid；`startedAt` 由用例显式给，保证确定性。

**为什么不 mock `ps`：** 假 claude 是 pane shell 的**真实后代**，真实 `ps -eo pid=,ppid=` 产生的就是生产代码要解析的那棵树。mock 掉 `ps` 等于把「`descendantsOf` 能在真实进程树里找到 claude」这条契约换成「能解析我编的字符串」，恰恰放过了唯一的集成风险。与 `test/liveSessions.test.ts` 的分工：那边用手写 `LivenessSnapshot` 测纯函数；这边走真实进程表。

**一处对 spec §9.3 的细化：** spec 说桩脚本把 `$$` 写进 `$HOME/.e2e-fake-pid`。测试 pane 的 `$HOME` 是**用户真实家目录**（harness 只覆盖了 `manager.home()`，没有改 `process.env.HOME`），往那儿写会污染用户环境且多会话互相覆盖。故改成**把落盘路径作为参数传给桩**（`PID_DIR/<id>`，绝对路径、每会话一个文件）。机制等价、隔离更干净。

- [ ] **Step 1: 加模块级常量与辅助函数**

在 `test/e2e-harness.js` 的 `writeConversation`（现第 263 行 `}` 之后）后面插入：

```js
/**
 * 假 claude 的 pid 落盘目录。
 * 每会话一个文件：桩脚本把自己的真实 pid 写进去，harness 读它 ——
 * 那个 pid 就是生产代码将要在 `ps` 里看到的后代 pid。
 */
const PID_DIR = '/tmp/tmuxterm-e2e-pids';
/** 后台挂住的假 claude：写 pid 后 exec sleep，作为 pane shell 的真实后代存活。 */
const FIXTURE_BG = path.join(BIN_DIR, 'claude-fixture-bg');
/** 前台假 claude：写 pid 后等一行输入，收到 /exit 即退出（供切 profile 用例）。 */
const FIXTURE_FG = path.join(BIN_DIR, 'claude-fixture-fg');
/** 兜底 D 的专用 cwd（那里只放一个条目）。 */
const SOLE_CWD = '/tmp/tmuxterm-e2e-sole';

/** 写桩脚本（绝对路径调用：不受 PATH 桩影响；名字以 claude 开头以便 isClaudeCommand 认它）。 */
async function writeFixtures() {
  await fs.promises.mkdir(BIN_DIR, { recursive: true });
  await fs.promises.mkdir(PID_DIR, { recursive: true });
  await fs.promises.writeFile(FIXTURE_BG, '#!/bin/sh\necho $$ > "$1"\nexec sleep 600\n', 'utf8');
  await fs.promises.writeFile(FIXTURE_FG, '#!/bin/sh\necho $$ > "$1"\nread _line\nexit 0\n', 'utf8');
  await fs.promises.chmod(FIXTURE_BG, 0o755);
  await fs.promises.chmod(FIXTURE_FG, 0o755);
}

/** 等桩脚本把 pid 写进 PID_DIR/<name>，返回它。超时返回 null。 */
async function readFakePid(name) {
  const file = path.join(PID_DIR, name);
  for (let i = 0; i < 40; i++) {
    try {
      const t = (await fs.promises.readFile(file, 'utf8')).trim();
      if (/^\d+$/.test(t)) return Number(t);
    } catch { /* 还没写出来 */ }
    await sleep(100);
  }
  return null;
}

/** 写注册表文件 ~/.claude/sessions/<pid>.json（生产代码唯一的注入点：home）。 */
async function writeSessionRecord(pid, sessionId, cwd, startedAt) {
  const dir = path.join(HOME, '.claude', 'sessions');
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt, status: 'busy', name: 'e2e', nameSource: 'derived' }),
    'utf8',
  );
}

/**
 * 杀掉所有桩进程。
 * 后台任务可能不在 pane 的**前台**进程组里，杀 tmux 会话不保证把它带走。
 */
async function killFakePids() {
  for (const name of await fs.promises.readdir(PID_DIR).catch(() => [])) {
    try {
      const t = (await fs.promises.readFile(path.join(PID_DIR, name), 'utf8')).trim();
      if (/^\d+$/.test(t)) process.kill(Number(t), 'SIGKILL');
    } catch { /* 已经退出了 */ }
  }
}

/**
 * 造一个带 `aiTitle` 的 transcript（可选在 ai-title **之前**塞大量填充行，
 * 用来证明「标题在文件尾部也能读到」）。`aiTitle` 为 undefined 时不写该行。
 */
async function writeTranscript(uuid, cwd, projectDir, aiTitle, paddingLines) {
  const dir = path.join(HOME, '.claude', 'projects', projectDir);
  await fs.promises.mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'mode', sessionId: uuid }),
    JSON.stringify({ type: 'attachment', cwd }),
    JSON.stringify({
      type: 'user', userType: 'external', isSidechain: false, cwd,
      message: { role: 'user', content: '占位摘要' },
    }),
  ];
  for (let i = 0; i < paddingLines; i++) {
    lines.push(JSON.stringify({ type: 'attachment', cwd, attachment: { i, pad: 'x'.repeat(200) } }));
  }
  if (aiTitle !== undefined) {
    lines.push(JSON.stringify({ type: 'ai-title', sessionId: uuid, aiTitle }));
  }
  await fs.promises.writeFile(path.join(dir, `${uuid}.jsonl`), lines.join('\n'), 'utf8');
}
```

- [ ] **Step 2: 插入第 19 节（会话身份 / 绑定同步）**

在第 18 节的结尾（现第 1176 行 `}`）之后、`console.log('\n=== 15. 清理 + 用户环境未被触碰 ===');`（现第 1178 行）之前插入：

```js

  console.log('\n=== 19. 会话身份：/new 后自动改绑 + 切 profile 前先 reconcile ===');
  {
    await fs.promises.rm(SOLE_CWD, { recursive: true, force: true });
    await fs.promises.mkdir(SOLE_CWD, { recursive: true });
    await writeFixtures();

    /** 起一个 pane，并在其中**后台**跑假 claude（前台仍是 shell，openEntry 才肯发命令）。 */
    const launchBackgroundClaude = async (id, cwd) => {
      await tmux.newSession(S(id), cwd);
      await sleep(500);
      await tmux.sendLiteral(S(id), `${FIXTURE_BG} ${path.join(PID_DIR, id)} &`);
      await tmux.sendEnter(S(id));
      return readFakePid(id);
    };

    // ---- 19a. /new 自愈：注册表记 sessionB、条目绑 sessionA ----
    {
      const id = 'e2eidentity1';
      const sessionA = 'bbbbbbbb-0001-0000-0000-000000000000';
      const sessionB = 'bbbbbbbb-0002-0000-0000-000000000000';
      ALL.push(id);
      // 只写 sessionB 的 .jsonl（不写 sessionA）：这样「没 reconcile」的旧行为
      // 会发 --session-id sessionA，两个断言都会红 —— 回归强度更高。
      await writeConversation(sessionB, BOUND_CWD, '/new 之后的新对话', PROJECT);
      store.entries.push(mk(id, 'IDENTITY', BOUND_CWD, { conversationId: sessionA }));

      const pid = await launchBackgroundClaude(id, BOUND_CWD);
      chk('19a 前置条件：假 claude 已作为 pane 的后代在跑', typeof pid === 'number' && pid > 0, String(pid));
      await writeSessionRecord(pid, sessionB, BOUND_CWD, 1789433265980);

      resetCalls();
      const mgr = newManager();
      await mgr.openEntry(fresh(id));
      await sleep(2500);

      chk('19a ★ 绑定被刷成注册表里的新会话（/new 自愈）', bound(id) === sessionB, `实际 ${bound(id)}`);
      chk('19a ★ liveSessionId 记为观测值', fresh(id).liveSessionId === sessionB, String(fresh(id).liveSessionId));
      const sent = literalsTo(S(id));
      chk('19a ★ 发出去的是 --resume 新会话，绝不是旧会话',
        sent.some((t) => t.includes(`--resume '${sessionB}'`)) &&
        !sent.some((t) => t.includes(`--resume '${sessionA}'`)) &&
        !sent.some((t) => t.includes(`--session-id '${sessionA}'`)), JSON.stringify(sent));
    }

    // ---- 19b. 切 profile 前先 reconcile（restartClaude 是第二条 --resume 路径）----
    {
      const id = 'e2eidentity2';
      const sessionA = 'bbbbbbbb-0003-0000-0000-000000000000';
      const sessionB = 'bbbbbbbb-0004-0000-0000-000000000000';
      ALL.push(id);
      await writeConversation(sessionB, BOUND_CWD, '切 profile 时该接回的新对话', PROJECT);
      store.entries.push(mk(id, 'IDENTITY2', BOUND_CWD, { conversationId: sessionA, model: 'deepseek-chat' }));

      // 前台假 claude：收到 /exit 即退出，restartClaude 的 waitForShell 才过得去
      await tmux.newSession(S(id), BOUND_CWD);
      await sleep(500);
      await tmux.sendLiteral(S(id), `${FIXTURE_FG} ${path.join(PID_DIR, id)}`);
      await tmux.sendEnter(S(id));
      const pid = await readFakePid(id);
      chk('19b 前置条件：pane 前台就是假 claude',
        (await tmux.currentCommand(S(id))).startsWith('claude'), await tmux.currentCommand(S(id)));
      await writeSessionRecord(pid, sessionB, BOUND_CWD, 1789433265980);

      resetCalls();
      modalAnswer = '切换';
      const mgr = newManager();
      await mgr.setProfileInteractive(fresh(id));
      modalAnswer = undefined;
      await sleep(2500);

      const sent = literalsTo(S(id));
      chk('19b ★ 重启时接回的是注册表里的新会话（先 reconcile 再拼 --resume）',
        sent.some((t) => t.includes(`--resume '${sessionB}'`)) &&
        !sent.some((t) => t.includes(`--resume '${sessionA}'`)), JSON.stringify(sent));
      chk('19b profile 已切换为 direct', fresh(id).profile === 'direct', String(fresh(id).profile));
      chk('19b model 被清空', fresh(id).model === undefined, String(fresh(id).model));
      chk('19b 绑定也同步刷成新会话', bound(id) === sessionB, String(bound(id)));
    }

    // ---- 19c. 手动改绑不被下一次 reconcile 冲掉 ----
    {
      const id = 'e2eidentity3';
      const manual = 'bbbbbbbb-0005-0000-0000-000000000000';
      const observed = 'bbbbbbbb-0006-0000-0000-000000000000';
      ALL.push(id);
      await writeConversation(manual, BOUND_CWD, '用户手动选的对话', PROJECT);
      store.entries.push(mk(id, 'IDENTITY3', BOUND_CWD, { conversationId: manual, liveSessionId: observed }));

      const pid = await launchBackgroundClaude(id, BOUND_CWD);
      chk('19c 前置条件：假 claude 已作为 pane 的后代在跑', typeof pid === 'number' && pid > 0, String(pid));
      await writeSessionRecord(pid, observed, BOUND_CWD, 1789433265980);

      resetCalls();
      const mgr = newManager();
      await mgr.openEntry(fresh(id));
      await sleep(2500);

      chk('19c ★ 手动改绑的 conversationId 没有被冲回观测值',
        bound(id) === manual, `实际 ${bound(id)}`);
      chk('19c liveSessionId 保持为观测值', fresh(id).liveSessionId === observed, String(fresh(id).liveSessionId));
      chk('19c 接回的仍是用户手动选的那条',
        literalsTo(S(id)).some((t) => t.includes(`--resume '${manual}'`)), JSON.stringify(literalsTo(S(id))));
    }

    // ---- 19d. 观测不到就不动 ----
    {
      const id = 'e2eidentity4';
      const bound0 = 'bbbbbbbb-0007-0000-0000-000000000000';
      ALL.push(id);
      await writeConversation(bound0, BOUND_CWD, '没有假 claude 在跑时该原样保留', PROJECT);
      store.entries.push(mk(id, 'IDENTITY4', BOUND_CWD, { conversationId: bound0, liveSessionId: undefined }));

      // 只有 bash：没有后代 claude，注册表里也没有它
      await tmux.newSession(S(id), BOUND_CWD);
      await sleep(500);

      resetCalls();
      const mgr = newManager();
      await mgr.openEntry(fresh(id));
      await sleep(2500);

      chk('19d ★ 观测不到活跃会话 → 绑定一字未改（liveSessionId 仍是空）',
        bound(id) === bound0 && fresh(id).liveSessionId === undefined,
        `conv=${bound(id)} live=${fresh(id).liveSessionId}`);
    }

    // ---- 19e. 兜底 D 正面：单条目 + claude 已死 → 自动接回最新候选，不问 ----
    {
      const id = 'e2eidentity5';
      ALL.push(id);
      const older = 'bbbbbbbb-0008-0000-0000-000000000000';
      const newer = 'bbbbbbbb-0009-0000-0000-000000000000';
      await writeConversation(older, SOLE_CWD, '旧的', '-tmp-tmuxterm-e2e-sole');
      await writeConversation(newer, SOLE_CWD, '新的', '-tmp-tmuxterm-e2e-sole');
      // mtime 显式给定，排序才确定（同一毫秒内写两个文件时 mtime 可能相同）
      const dir = path.join(HOME, '.claude', 'projects', '-tmp-tmuxterm-e2e-sole');
      await fs.promises.utimes(path.join(dir, `${older}.jsonl`), 1_000_000, 1_000_000);
      await fs.promises.utimes(path.join(dir, `${newer}.jsonl`), 2_000_000, 2_000_000);

      const local = {
        entries: [mk(id, 'SOLE', SOLE_CWD)],
        async load() { return this.entries.map((e) => ({ ...e })); },
        async update(entryId, patch) {
          const i = this.entries.findIndex((e) => e.id === entryId);
          if (i >= 0) this.entries[i] = { ...this.entries[i], ...patch };
        },
      };
      await tmux.newSession(S(id), SOLE_CWD);   // 只有 bash：claude 已死
      await sleep(500);

      resetCalls();
      const mgr = new TerminalManager(local, tmux);
      mgr.home = () => HOME;
      await mgr.openEntry(local.entries[0]);
      await sleep(2500);

      chk('19e ★ 单条目 + claude 已死 → 自动接回同 cwd 下 mtime 最新的对话',
        literalsTo(S(id)).some((t) => t.includes(`--resume '${newer}'`)), JSON.stringify(literalsTo(S(id))));
      chk('19e ★ 没有弹选择框（收窄后的 D 正是为了不问）', calls.quickPicks.length === 0,
        JSON.stringify(calls.quickPicks.map((q) => q.opts && q.opts.title)));
      chk('19e 绑定被落下（推断值）', local.entries[0].conversationId === newer,
        String(local.entries[0].conversationId));
      chk('19e ★ 推断不冒充观测：liveSessionId 保持未设',
        local.entries[0].liveSessionId === undefined, String(local.entries[0].liveSessionId));
    }

    // ---- 19f. 兜底 D 反面：展开后同一个 cwd 的两个条目 → 不得启用 D ----
    {
      const idA = 'e2eidentity6';
      const idB = 'e2eidentity7';
      ALL.push(idA, idB);
      // `~/shared` 与 `<HOME>/shared` 原始串不同、展开后是同一个目录
      const realCwd = path.join(HOME, 'shared');
      await fs.promises.mkdir(realCwd, { recursive: true });
      const conv = 'bbbbbbbb-0010-0000-0000-000000000000';
      await writeConversation(conv, realCwd, '共用目录下的对话', '-tmp-tmuxterm-e2e-home-shared');

      const local = {
        entries: [mk(idA, 'SHARED-A', '~/shared'), mk(idB, 'SHARED-B', realCwd)],
        async load() { return this.entries.map((e) => ({ ...e })); },
        async update(entryId, patch) {
          const i = this.entries.findIndex((e) => e.id === entryId);
          if (i >= 0) this.entries[i] = { ...this.entries[i], ...patch };
        },
      };
      await tmux.newSession(S(idA), realCwd);
      await sleep(500);

      resetCalls();
      quickPickAnswer = undefined;              // 用户按 Esc = 什么都不启动
      const mgr = new TerminalManager(local, tmux);
      mgr.home = () => HOME;
      await mgr.openEntry(local.entries[0]);
      await sleep(1500);

      chk('19f ★ 展开后同 cwd 的两个条目 → D 不生效，退回弹选择框问用户',
        calls.quickPicks.length === 1, JSON.stringify(calls.quickPicks.length));
      chk('19f ★ 一条启动命令都没发', literalsTo(S(idA)).length === 0, JSON.stringify(literalsTo(S(idA))));
      chk('19f 绑定未被改动', local.entries[0].conversationId === undefined,
        String(local.entries[0].conversationId));
    }
  }
```

- [ ] **Step 3: 插入第 20 节（任务名回退链）**

紧接第 19 节的 `}` 之后（仍在第 15 节清理之前）插入：

```js

  console.log('\n=== 20. 任务名回退链：pane title → 绑定对话的 aiTitle → 不显示三级 ===');
  {
    const { EntryTreeProvider, TaskTreeItem } = require(path.join(ROOT, 'out/src/tree.js'));
    const { TaskTitleCache } = require(path.join(ROOT, 'out/src/taskTitles.js'));
    const { taskNameFromTitle } = require(path.join(ROOT, 'out/src/core/tmux.js'));

    // 本节的接缝在**渲染层**：activity 用假的（pane title → taskName 那条链的
    // 解析已被 test/core/tmux.test.ts 与 test/activityTracker.test.ts 覆盖，
    // 且这段代码本次未改），titleFallback 用**真的** TaskTitleCache +
    // **真的**磁盘 transcript —— 这才正好覆盖本次新增的 taskNameFor 回退逻辑。
    const storeFor = (entry) => ({
      entries: [entry],
      async load() { return this.entries.map((e) => ({ ...e })); },
      async reorder() {},
    });
    const noName = { activityFor: () => ({ state: 'idle', taskName: '' }) };

    // ---- 20a. 无 pane 任务名 → 回退到绑定对话的 aiTitle（且要读文件尾部）----
    const conv = 'bbbbbbbb-0011-0000-0000-000000000000';
    const aiTitle = '创建多引擎版 /ask 命令并统一';
    await writeTranscript(conv, BOUND_CWD, PROJECT, aiTitle, 2000);   // >64KB，标题只在尾部
    const titles = new TaskTitleCache(HOME);
    titles.prewarm(conv, BOUND_CWD);
    await sleep(300);
    chk('20a 前置条件：aiTitle 已从 transcript **尾部**取到（文件 >64KB）',
      titles.peek(conv) === aiTitle, JSON.stringify(titles.peek(conv)));

    const p1 = new EntryTreeProvider(storeFor(mk('t-title1', 'T1', BOUND_CWD, { conversationId: conv })), noName, titles);
    const node1 = (await p1.getChildren((await p1.getChildren(undefined))[0]))[0];
    chk('20a ★ 三级回退到绑定对话的 aiTitle', node1.taskName === aiTitle, JSON.stringify(node1.taskName));
    chk('20a 二级 collapsibleState = Expanded (2)', node1.collapsibleState === 2, String(node1.collapsibleState));
    const third1 = await p1.getChildren(node1);
    chk('20a 三级节点标签就是 aiTitle',
      third1.length === 1 && third1[0] instanceof TaskTreeItem && third1[0].label === aiTitle,
      JSON.stringify(third1.map((t) => t.label)));

    // ---- 20b. transcript 里没有 aiTitle → 不生成三级 ----
    const convEmpty = 'bbbbbbbb-0012-0000-0000-000000000000';
    await writeTranscript(convEmpty, BOUND_CWD, PROJECT, undefined, 10);
    const titles2 = new TaskTitleCache(HOME);
    titles2.prewarm(convEmpty, BOUND_CWD);
    await sleep(300);
    const p2 = new EntryTreeProvider(storeFor(mk('t-title2', 'T2', BOUND_CWD, { conversationId: convEmpty })), noName, titles2);
    const node2 = (await p2.getChildren((await p2.getChildren(undefined))[0]))[0];
    chk('20b ★ 都无从得知时 taskName 为空串（不用灰色占位/derived slug 冒充）',
      node2.taskName === '', JSON.stringify(node2.taskName));
    chk('20b 二级 collapsibleState = None (0)', node2.collapsibleState === 0, String(node2.collapsibleState));
    chk('20b ★ 不生成三级节点', (await p2.getChildren(node2)).length === 0);

    // ---- 20c. 首字符回归：shell 自己设的标题不得被削 ----
    const shellTitle = 'qiansenwei@H:~/workspace';
    const parsed = taskNameFromTitle(shellTitle);
    chk('20c 前置条件：shell 标题解析后原样保留', parsed === shellTitle, JSON.stringify(parsed));
    const p3 = new EntryTreeProvider(
      storeFor(mk('t-title3', 'T3', BOUND_CWD, { conversationId: conv })),
      { activityFor: () => ({ state: 'idle', taskName: parsed }) },
      titles,
    );
    const node3 = (await p3.getChildren((await p3.getChildren(undefined))[0]))[0];
    chk('20c ★ pane title 优先，三级显示原文', node3.taskName === shellTitle, JSON.stringify(node3.taskName));
    const third3 = await p3.getChildren(node3);
    chk('20c 三级节点标签是原文',
      third3.length === 1 && third3[0].label === shellTitle, JSON.stringify(third3.map((t) => t.label)));
  }
```

- [ ] **Step 4: 清理节补上桩进程与新目录**

把 `test/e2e-harness.js:1178-1183` 的

```js
  console.log('\n=== 15. 清理 + 用户环境未被触碰 ===');
  await detachRealClient();
  await killAll(ALL);
  const left = (await tmux.listSessions()).filter((s) => s.startsWith('tmuxterm-e2e'));
  chk('无残留测试会话', left.length === 0, left.join(', '));
```

改成：

```js
  console.log('\n=== 15. 清理 + 用户环境未被触碰 ===');
  await detachRealClient();
  await killAll(ALL);
  await killFakePids();     // 后台桩可能不在 pane 前台进程组里，杀会话不保证带走
  await sleep(500);         // 给 init 一点时间回收僵尸
  const stragglers = [];
  for (const name of await fs.promises.readdir(PID_DIR).catch(() => [])) {
    try {
      const t = Number((await fs.promises.readFile(path.join(PID_DIR, name), 'utf8')).trim());
      process.kill(t, 0);   // 不抛 = 还活着
      stragglers.push(t);
    } catch { /* 已退出 */ }
  }
  chk('★ 假 claude 桩进程没有残留', stragglers.length === 0, stragglers.join(','));
  const left = (await tmux.listSessions()).filter((s) => s.startsWith('tmuxterm-e2e'));
  chk('无残留测试会话', left.length === 0, left.join(', '));
```

再把清理节末尾的

```js
  for (const d of [SCRATCH, CONV_CWD, BOUND_CWD]) {
    await fs.promises.rm(d, { recursive: true, force: true });
  }
```

改成：

```js
  for (const d of [SCRATCH, CONV_CWD, BOUND_CWD, SOLE_CWD, PID_DIR]) {
    await fs.promises.rm(d, { recursive: true, force: true });
  }
```

- [ ] **Step 5: 编译并运行 e2e，确认新场景全绿**

Run: `npm run compile && node test/e2e-harness.js`
Expected: 末尾打印 `端到端全部通过 ✓`，且第 19、20 节所有 `✓` 都在。若某一行是 `✗`，先核对是不是 Task 6/8/10 的实现细节没对上本节假设，而不是改测试去迁就实现。

- [ ] **Step 6: 提交**

```bash
git add test/e2e-harness.js
git commit -m "test: e2e 覆盖 /new 自动改绑、切 profile 先 reconcile、兜底 D 两侧与任务名回退链"
```

---

### Task 12: 整体验证与收尾

**Files:**
- Modify: `package.json:5`
- Modify: `package-lock.json:3` 与 `:9`

- [ ] **Step 1: 全量编译**

Run: `rm -rf out && npm run compile`
Expected: 退出码 0

- [ ] **Step 2: 全量 mocha 单测**

Run: `npm test`
Expected: 全部 PASS。相对本次改动前，净变化 = **+69 项**：migrate +5、processTree +12、liveSession +12、reconcile +7、tmux +4（`taskNameFromTitle` 由 4 项替换为 5 项 = +1，新增 `parsePid` +3）、conversation +6、conversationFiles +5、liveSessions +10、taskTitles +8

- [ ] **Step 3: 严格类型检查**

Run: `npx tsc -p ./ --noEmit`
Expected: 退出码 0，无输出

- [ ] **Step 4: e2e harness 全量跑一遍**

Run: `node test/e2e-harness.js`
Expected: 末尾 `端到端全部通过 ✓`

- [ ] **Step 5: 变异测试（本项目惯例）**

逐条改一处、跑对应测试、确认**断言真的变红**，然后改回：

1. 去掉 `core/migrate.ts` 里 `liveSessionId` 那一行 → `test/core/migrate.test.js` 的 `liveSessionId 保留`应红。
2. 把 `core/reconcile.ts` 的第二分支（`live === entry.liveSessionId`）删掉 → `test/core/reconcile.test.js` 的「手动改绑专项」应红。
3. 去掉第一分支的 `live.trim() === ''` 守卫（只留 `live === undefined`）→ 空串用例应红。
4. 把 `taskNameFromTitle` 退回无条件 `chain.slice(1)` 的写法 → `qiansenwei@H:~/workspace` 与 `bash` 两个用例应红。
5. 把兜底 D 的唯一性判据退回**原始串**比较（`e.cwd === entry.cwd`）→ e2e 第 19f 节应红。

注：**不要**再用「`startedAt` 改成取第一个候选」做变异点 —— 实测的孤儿场景两个 pid 同 sessionId，改与不改结果相同，该变异不会让任何断言变红。

- [ ] **Step 6: 版本号 0.1.5**

`package.json:5` 改成：

```json
  "version": "0.1.5",
```

`package-lock.json:3` 与 `:9` 两处（`version` 与 `packages[""].version`）都改成：

```json
  "version": "0.1.5",
```

- [ ] **Step 7: 校验 JSON 合法**

Run: `node -e "const fs=require('fs');JSON.parse(fs.readFileSync('package.json','utf8'));JSON.parse(fs.readFileSync('package-lock.json','utf8'))"`
Expected: 无输出、退出码 0

- [ ] **Step 8: 确认没有遗留的旧调用点**

Run: `grep -rn "taskNameFromTitle\|liveSessionIn\|reconcileBinding\|panePid" src/ | grep -v "core/tmux.ts\|core/reconcile.ts\|core/liveSession.ts\|liveSessions.ts\|tmuxClient.ts\|terminalManager.ts\|tree.ts\|activityTracker.ts"`
Expected: 无输出

- [ ] **Step 9: 最终提交**

```bash
git add package.json package-lock.json
git commit -m "chore: 发布 0.1.5，并订正 package-lock.json 里滞留的 0.1.2"
```

---

## 附：实施后修订

（本节在实施完成后回填，记录与 `docs/superpowers/specs/2026-09-14-session-identity-design.md` 不符之处，沿用 v1 / v2 / tree-hierarchy 的做法。已知会被记一笔的有两处：`readTail` / `TAIL_BYTES` 必须导出；e2e 桩脚本的 pid 落盘路径由 `$HOME/.e2e-fake-pid` 改成命令行传入的绝对路径。）
