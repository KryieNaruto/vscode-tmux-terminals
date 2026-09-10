# Tmux Terminals v2 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 vscode-tmux-terminals 增加条目拖拽排序、目录输入提示与短路径显示、profile/模型单选与批量切换、以及杀掉会话后关闭终端面板的修复。

**Architecture:** 延续 v1 的分层：`src/core/` 放零 vscode 依赖的纯函数（本项目所有危险逻辑都在这里，可用普通 mocha 直接测），`src/*.ts` 放 vscode 接线。命令不再是用户数据，而是由 `profile` 派生；所有会写用户文件的操作（迁移、排序）都走 `EntryStore.enqueue` 串行化。

**Tech Stack:** TypeScript（strict）、VS Code Extension API（`^1.85.0`）、mocha（无断言库，用 node `assert`）、`@vscode/vsce` 打包。**不新增任何依赖。**

**Spec:** `docs/superpowers/specs/2026-09-10-tmux-terminals-v2-design.md`

## Global Constraints

- **`src/core/` 下任何文件不得 `import 'vscode'`。** 这是让纯逻辑可测的前提，也是本项目的结构约定。
- **不新增 npm 依赖。** 测试用 mocha + node 内置 `assert`。
- **写入用户文件必须原子**：写临时文件（唯一名）→ `rename`。已存在于 `EntryStore.save`，复用它，不要另写一套。
- **所有「读-改-写」必须经 `EntryStore.enqueue`。** v1 实测两次并发 `add` 只留下 1 条。
- **tmux 目标一律经 `sessionTarget()` / `paneTarget()` 生成。** `=` 是精确匹配（防前缀误伤），pane 级目标**必须带冒号**（`=name:`），漏掉冒号会静默失败（exit 0 + 空输出）。
- **控制序列只在「会话存活」且「前端确认是 claude」时发送。** 判据是 pane 当前进程基名**以 `claude` 开头**；**严禁放宽到 `node`**（用户的 build/test/dev server 大量是 node）。识别不出必须拒绝并说明。
- **竞态兜底只能把命令降级为空，永远不能凭空加出命令。**
- 每个守卫都要做**变异测试**：故意破坏守卫，确认对应测试真的失败。
- 提交信息用中文，结尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 单文件测试：`npm run compile && npx mocha "out/test/core/xxx.test.js"`。全量：`npm test`。

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/core/types.ts` | 条目类型 | 改：`commands[]` → `profile` + `model?` + `order` |
| `src/core/command.ts` | 由 profile 派生命令行 | 建 |
| `src/core/migrate.ts` | v1→v2 迁移纯函数 | 建 |
| `src/core/labels.ts` | 路径短名与消歧 | 建 |
| `src/core/claude.ts` | 识别 claude 进程（安全判据） | 建 |
| `src/core/models.ts` | 解析 settings 里的模型清单 | 建 |
| `src/core/plan.ts` | 安全闸门 | 改：命令来源改为 `commandFor` |
| `src/core/store.ts` | 持久化 | 改：迁移、备份、排序、append |
| `src/core/paths.ts` | 路径工具 | 改：加 `rankCandidates` |
| `src/tmuxClient.ts` | tmux 封装 | 改：加 `detachClients` |
| `src/claudeConfig.ts` | 读 settings.json / direct.json | 建 |
| `src/terminalManager.ts` | 核心接线 | 改：复用守卫、kill 修复、切模型/profile、目录提示 |
| `src/tree.ts` | 清单 view | 改：短路径、profile 徽标、拖拽 |
| `src/batchTree.ts` | 批量操作 view | 建 |
| `src/extension.ts` | 注册 | 改：第二 view、新命令 |
| `package.json` | 清单 | 改：第二 view、命令与菜单 |
| `README.md` / `docs/smoke-test.md` | 文档 | 改 |

---

### Task 1: v2 数据模型完整切换（类型 + 命令派生 + 迁移 + 存储）

**Files:**
- Modify: `src/core/types.ts`
- Create: `src/core/command.ts`
- Create: `src/core/migrate.ts`
- Modify: `src/core/plan.ts`
- Modify: `src/core/store.ts`
- Modify: `src/terminalManager.ts`（`addEntryInteractive` / `duplicateEntry` 改用 `append`）
- Test: `test/core/command.test.ts`, `test/core/migrate.test.ts`, `test/core/store.test.ts`, `test/core/plan.test.ts`

**Interfaces:**
- Consumes: `shellQuote` from `src/core/tmux.ts`（已存在）
- Produces:
  - `type Profile = 'ccr' | 'direct'`
  - `interface TerminalEntry { id: string; name: string; cwd: string; profile: Profile; model?: string; autoRestore: boolean; order: number }`
  - `commandFor(entry: TerminalEntry): string`
  - `planRestore(entry: TerminalEntry, alive: boolean): RestorePlan`
  - `isV1Shape(v: unknown): boolean` / `migrateEntry(raw: unknown, index: number): TerminalEntry | undefined`
  - `EntryStore.load(): Promise<TerminalEntry[]>`（已迁移、按 order 升序）
  - `EntryStore.append(entry: Omit<TerminalEntry, 'order'>): Promise<void>`
  - `EntryStore.reorder(idsInNewOrder: string[]): Promise<void>`
  - `EntryStore.migrateAndBackup(): Promise<boolean>`

> **为什么这一整个是单个任务：** 类型一改，`store.ts` 里 `isEntry` 就不再接受 `commands` 字段。若迁移不同时落地，用户已有的 **6 条真实条目会被静默丢弃**。审查者无法"批准类型改动、拒绝迁移" —— 二者拆开就是一个不可发布的数据丢失中间态。因此它们同属一个交付物。

- [ ] **Step 1: 写失败测试** — `test/core/command.test.ts`

```ts
import * as assert from 'assert';
import { commandFor } from '../../src/core/command';
import { TerminalEntry } from '../../src/core/types';

function e(patch: Partial<TerminalEntry> = {}): TerminalEntry {
  return {
    id: 'abc123', name: 'n', cwd: '/tmp',
    profile: 'ccr', autoRestore: true, order: 0, ...patch,
  };
}

describe('commandFor', () => {
  it('ccr profile 用 claude', () => {
    assert.strictEqual(commandFor(e({ profile: 'ccr' })), 'claude --dangerously-skip-permissions');
  });

  it('direct profile 用 claude-direct', () => {
    assert.strictEqual(commandFor(e({ profile: 'direct' })), 'claude-direct --dangerously-skip-permissions');
  });

  it('指定模型时带 --model', () => {
    assert.strictEqual(
      commandFor(e({ profile: 'direct', model: 'claude-sonnet-5[1m]' })),
      'claude-direct --dangerously-skip-permissions --model \'claude-sonnet-5[1m]\'',
    );
  });

  it('模型名含空格与引号时仍安全（必须经 shell 引用）', () => {
    const out = commandFor(e({ model: "a b'c" }));
    assert.ok(out.includes(`'a b'\\''c'`), `实际：${out}`);
  });

  it('空字符串模型视为未指定', () => {
    assert.strictEqual(commandFor(e({ model: '' })), 'claude --dangerously-skip-permissions');
  });
});
```

- [ ] **Step 2: 写失败测试** — `test/core/migrate.test.ts`

```ts
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
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm run compile && npx mocha "out/test/core/migrate.test.js"`
Expected: 编译失败 —— 找不到 `../../src/core/migrate` 与 `../../src/core/command`

- [ ] **Step 4: 改 `src/core/types.ts`**

```ts
/** 启动 claude 的两种入口。差别在鉴权来源与模型，见 spec §2。 */
export type Profile = 'ccr' | 'direct';

/** 侧边栏的一个终端条目。name 仅用于显示；tmux 会话名由 id 派生。 */
export interface TerminalEntry {
  /** 短随机串，重命名时保持不变 */
  id: string;
  /** 显示名，可随意改 */
  name: string;
  /** 远端路径，支持 ~ */
  cwd: string;
  /** 决定启动命令与鉴权来源 */
  profile: Profile;
  /** 空/未设 = 用该 profile 的默认模型 */
  model?: string;
  /** 是否参与「全部恢复」 */
  autoRestore: boolean;
  /** 拖拽排序序号，从 0 递增，不保证连续 */
  order: number;
}
```

- [ ] **Step 5: 写 `src/core/command.ts`**

```ts
import { shellQuote } from './tmux';
import { TerminalEntry } from './types';

/**
 * 由 profile 派生启动命令。
 *
 * v1 把命令作为用户数据（commands: string[]），但实测 6 个条目 100% 是
 * 同一句 —— 这份灵活性是假的，代价却是每次新建都要手敲一遍。改成派生后
 * 启动方式只有这一处定义。
 *
 * 命令行字符串要塞进 shell 执行，所以模型名必须经 shellQuote。
 */
export function commandFor(entry: TerminalEntry): string {
  const exe = entry.profile === 'direct' ? 'claude-direct' : 'claude';
  const model = entry.model && entry.model.length > 0
    ? ` --model ${shellQuote(entry.model)}`
    : '';
  return `${exe} --dangerously-skip-permissions${model}`;
}
```

- [ ] **Step 6: 写 `src/core/migrate.ts`**

```ts
import { Profile, TerminalEntry } from './types';

/**
 * v1 → v2 条目迁移。
 *
 * v1 形态：{ id, name, cwd, commands: string[], autoRestore }
 * v2 形态：{ id, name, cwd, profile, model?, autoRestore, order }
 *
 * **为什么必须存在：** EntryStore.load() 会用 isEntry 过滤条目，而 v2 的
 * isEntry 不再接受 commands 字段。若不先迁移就过滤，用户已有的条目会被
 * **静默丢弃**（远端实测 6 条）。
 *
 * 迁移是幂等的：已是 v2 形态的条目原样返回。
 */

export function isV1Shape(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.commands);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * 迁移单条。返回 undefined 表示该条无法迁移（缺必需字段），
 * 调用方应丢弃它而不是让整个清单读取失败。
 */
export function migrateEntry(raw: unknown, index: number): TerminalEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;

  const id = str(o.id);
  const name = str(o.name);
  const cwd = str(o.cwd);
  if (id === undefined || name === undefined || cwd === undefined) return undefined;

  // 已是 v2：原样返回，保证幂等
  if (!isV1Shape(o)) {
    const profile: Profile = o.profile === 'direct' ? 'direct' : 'ccr';
    const model = str(o.model);
    return {
      id, name, cwd, profile,
      ...(model !== undefined && model.length > 0 ? { model } : {}),
      autoRestore: o.autoRestore === true,
      order: typeof o.order === 'number' ? o.order : index,
    };
  }

  // v1 → v2
  const commands = o.commands as unknown[];
  if (!commands.every((c) => typeof c === 'string')) return undefined;

  // 只要有一条命令用了 claude-direct 就判为 direct —— 用户的直接意图
  const joined = (commands as string[]).join('\n');
  const profile: Profile = /(^|\s|\/)claude-direct(\s|$)/.test(joined) ? 'direct' : 'ccr';

  return {
    id, name, cwd, profile,
    autoRestore: o.autoRestore === true,
    order: index,
  };
}
```

- [ ] **Step 7: 改 `src/core/plan.ts`**

只改命令来源，闸门语义**一字不动**：

```ts
import { commandFor } from './command';
import { TerminalEntry } from './types';

export type RestoreMode = 'attach' | 'create';

export interface RestorePlan {
  mode: RestoreMode;
  commands: string[];
}

/**
 * 决定点击条目时该 attach 还是 create。
 *
 * **这是本项目的安全闸门。** 会话存活时必须 attach 且命令为空：
 * 若在存活会话上执行预设命令，那些命令会作为键盘输入进入用户正在
 * 运行的进程的 stdin（例如往一个跑着的 claude、编译或 REPL 里塞一
 * 行 `source env.sh`），后果不可预料。
 *
 * 因此不要用 `tmux new -A -s name` 一把梭 —— `-A` 在会话已存在时会
 * attach，调用方无从得知，接着就会误发命令。
 */
export function planRestore(entry: TerminalEntry, alive: boolean): RestorePlan {
  if (alive) {
    return { mode: 'attach', commands: [] };
  }
  return { mode: 'create', commands: [commandFor(entry)] };
}
```

- [ ] **Step 8: 改 `test/core/plan.test.ts`**

```ts
import * as assert from 'assert';
import { planRestore } from '../../src/core/plan';
import { TerminalEntry } from '../../src/core/types';

function e(model?: string): TerminalEntry {
  return {
    id: 'x', name: 'n', cwd: '/tmp', profile: 'ccr', model,
    autoRestore: true, order: 0,
  };
}

describe('planRestore', () => {
  it('会话存活 → attach 且命令必须为空（安全闸门）', () => {
    const p = planRestore(e('qwen3.7-max'), true);
    assert.strictEqual(p.mode, 'attach');
    assert.deepStrictEqual(p.commands, []);
  });

  it('会话不存在 → create 且命令来自 profile 派生', () => {
    const p = planRestore(e(), false);
    assert.strictEqual(p.mode, 'create');
    assert.deepStrictEqual(p.commands, ['claude --dangerously-skip-permissions']);
  });
});
```

- [ ] **Step 9: 改 `src/core/store.ts`**

替换 `load`，加 `readRaw` / `migrateAndBackup` / `reorder` / `append`，改 `isEntry`：

```ts
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { isV1Shape, migrateEntry } from './migrate';
import { TerminalEntry } from './types';

/** 生成条目 id。用 crypto 而非 Math.random，避免同一毫秒内碰撞。 */
export function newId(): string {
  return crypto.randomBytes(6).toString('hex');
}

export class EntryStore {
  constructor(private readonly filePath: string) {}

  /** 读原始 JSON，宽容失败。返回 undefined 表示文件不存在或不是数组。 */
  private async readRaw(): Promise<unknown[] | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 载入条目。
   *
   * **顺序至关重要：先迁移，再过滤。** v2 的 isEntry 不再接受 commands
   * 字段，若先过滤，v1 的条目会被全部静默丢弃（远端实测 6 条）。
   *
   * 读取不改写文件 —— 迁移结果只存在于内存，等用户下次真实改动时才落盘。
   * 「打开个扩展就改了用户文件」是不可接受的副作用。
   */
  async load(): Promise<TerminalEntry[]> {
    const raw = await this.readRaw();
    if (raw === undefined) return [];
    const migrated: TerminalEntry[] = [];
    raw.forEach((item, i) => {
      const m = migrateEntry(item, i);
      if (m !== undefined) migrated.push(m);
    });
    // 按 order 升序；order 相同时保持原下标顺序（稳定排序）
    return migrated
      .map((e, i) => ({ e, i }))
      .sort((a, b) => (a.e.order - b.e.order) || (a.i - b.i))
      .map((x) => x.e);
  }

  /**
   * 若文件是 v1 形态，备份为 `<file>.bak` 并返回 true。
   *
   * 只在真的要迁移时备份，且**已存在的备份不覆盖** —— 第一次的备份才是
   * 用户的原始数据，后续覆盖会让它失去意义。
   */
  async migrateAndBackup(): Promise<boolean> {
    const raw = await this.readRaw();
    if (raw === undefined) return false;
    if (!raw.some(isV1Shape)) return false;
    const bak = `${this.filePath}.bak`;
    try {
      await fs.access(bak);
      return false; // 已有备份，不覆盖
    } catch {
      // 不存在 → 建它
    }
    const text = await fs.readFile(this.filePath, 'utf8');
    await fs.writeFile(bak, text, 'utf8');
    return true;
  }

  async save(entries: TerminalEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // 临时名必须每次唯一。曾用固定的 `filePath + '.tmp'`，两次 save 交错时
    // 先完成者把 .tmp rename 走，后完成者 rename 时源已不存在 → ENOENT。
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8');
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * 串行化「读-改-写」。
   *
   * `add` / `append` / `update` / `remove` / `reorder` 都是 load→修改→save
   * 的复合操作。并发调用时两次 load 会读到同一份旧数据，后写的覆盖先写的，
   * 造成丢更新（实测两次并发 add 只留下 1 条）。所有写操作在此排队。
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(op, op);
    this.writeChain = next.catch(() => {});
    return next;
  }

  async add(entry: TerminalEntry): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.load();
      all.push(entry);
      await this.save(all);
    });
  }

  /**
   * 追加一条新条目，**order 在锁内分配**。
   *
   * 不能在调用方算 order：`load` 与 `append` 之间没有锁，两次并发新增会
   * 算出同一个 order，排序随即变得不确定。也不能让调用方传 0 —— 那样每条
   * 新条目的 order 都相同。
   */
  async append(entry: Omit<TerminalEntry, 'order'>): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.load();
      const next = all.reduce((m, e) => Math.max(m, e.order), -1) + 1;
      all.push({ ...entry, order: next });
      await this.save(all);
    });
  }

  async update(id: string, patch: Partial<TerminalEntry>): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.load();
      const idx = all.findIndex((e) => e.id === id);
      if (idx === -1) return;
      all[idx] = { ...all[idx], ...patch, id: all[idx].id };
      await this.save(all);
    });
  }

  async remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.load();
      await this.save(all.filter((e) => e.id !== id));
    });
  }

  /**
   * 按给定 id 顺序重排，并把 order 重编号为 0..n-1。
   *
   * 重编号而非累加：连续拖拽会让 order 无限增长，且容易出现相等值。
   * 未出现在 ids 里的条目追加在末尾（防御：调用方的列表可能已过期）。
   */
  async reorder(idsInNewOrder: string[]): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.load();
      const byId = new Map(all.map((e) => [e.id, e]));
      const reordered: TerminalEntry[] = [];
      for (const id of idsInNewOrder) {
        const e = byId.get(id);
        if (e !== undefined) {
          reordered.push(e);
          byId.delete(id);
        }
      }
      reordered.push(...byId.values());
      await this.save(reordered.map((e, i) => ({ ...e, order: i })));
    });
  }

  async findByName(name: string): Promise<TerminalEntry | undefined> {
    const all = await this.load();
    return all.find((e) => e.name === name);
  }
}

/** v2 形态校验。注意不再接受 commands 字段。 */
function isEntry(v: unknown): v is TerminalEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.cwd === 'string' &&
    (o.profile === 'ccr' || o.profile === 'direct') &&
    (o.model === undefined || typeof o.model === 'string') &&
    typeof o.autoRestore === 'boolean' &&
    typeof o.order === 'number'
  );
}
```

- [ ] **Step 10: 改 `test/core/store.test.ts`**

原有用例构造条目时用了 `commands`，现在编译不过。把构造器统一换成 v2 形态（`profile: 'ccr', autoRestore: true, order: 0`），然后追加迁移与排序用例：

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxstore-')), 'terminals.json');
}

/** v2 条目构造器。append 不收 order（由 store 在锁内分配），故这里也不含 order。 */
function v2(patch: Record<string, unknown> = {}) {
  return {
    id: 'a', name: 'a', cwd: '/w', profile: 'ccr' as const,
    autoRestore: true, ...patch,
  };
}

describe('EntryStore v1 迁移', () => {
  it('v1 文件能读出 v2 条目且一条不丢（回归：曾会被 isEntry 静默过滤）', async () => {
    const f = tmpFile();
    fs.writeFileSync(f, JSON.stringify([
      { id: '9b96d6ac7a3f', name: '统筹者', cwd: '/w', commands: ['claude --dangerously-skip-permissions'], autoRestore: true },
      { id: 'dab74caad49b', name: '咨询', cwd: '/w', commands: ['claude --dangerously-skip-permissions'], autoRestore: true },
      { id: '1942d99d7238', name: 'UI', cwd: '/w/t', commands: ['claude-direct --dangerously-skip-permissions'], autoRestore: true },
    ], null, 2));
    const all = await new EntryStore(f).load();
    assert.strictEqual(all.length, 3, '三条都必须保留');
    assert.deepStrictEqual(all.map((e) => e.profile), ['ccr', 'ccr', 'direct']);
    assert.deepStrictEqual(all.map((e) => e.order), [0, 1, 2]);
  });

  it('load() 不改写用户文件（不能只是打开扩展就动用户数据）', async () => {
    const f = tmpFile();
    const original = JSON.stringify([{ id: 'a', name: 'n', cwd: '/w', commands: [], autoRestore: true }]);
    fs.writeFileSync(f, original);
    await new EntryStore(f).load();
    assert.strictEqual(fs.readFileSync(f, 'utf8'), original, '文件必须原样');
  });

  it('migrateAndBackup 备份一次，且重复调用不覆盖已有备份', async () => {
    const f = tmpFile();
    fs.writeFileSync(f, JSON.stringify([{ id: 'a', name: 'n', cwd: '/w', commands: [], autoRestore: true }]));
    const s = new EntryStore(f);
    assert.strictEqual(await s.migrateAndBackup(), true);
    const bak1 = fs.readFileSync(f + '.bak', 'utf8');
    assert.ok(bak1.includes('"commands"'), '备份必须是 v1 原文');
    assert.strictEqual(await s.migrateAndBackup(), false);
    assert.strictEqual(fs.readFileSync(f + '.bak', 'utf8'), bak1, '备份不能被覆盖');
  });
});

describe('EntryStore.append', () => {
  it('order 依次递增，不重复', async () => {
    const f = tmpFile();
    const s = new EntryStore(f);
    // append 收 Omit<TerminalEntry,'order'> —— order 由 store 在锁内分配
    await s.append({ id: 'a', name: 'a', cwd: '/w', profile: 'ccr', autoRestore: true });
    await s.append({ id: 'b', name: 'b', cwd: '/w', profile: 'ccr', autoRestore: true });
    const all = await s.load();
    assert.deepStrictEqual(all.map((e) => e.order), [0, 1]);
  });

  it('并发 append 不产生相同 order（回归：order 必须在锁内分配）', async () => {
    const f = tmpFile();
    const s = new EntryStore(f);
    await Promise.all([
      s.append({ id: 'a', name: 'a', cwd: '/w', profile: 'ccr', autoRestore: true }),
      s.append({ id: 'b', name: 'b', cwd: '/w', profile: 'ccr', autoRestore: true }),
    ]);
    const all = await s.load();
    assert.strictEqual(all.length, 2);
    assert.deepStrictEqual(all.map((e) => e.order).sort(), [0, 1], 'order 不能相同');
  });
});

describe('EntryStore.reorder', () => {
  it('按给定顺序重编号 order', async () => {
    const f = tmpFile();
    const s = new EntryStore(f);
    for (const id of ['a', 'b', 'c']) await s.append({ id, name: id, cwd: '/w', profile: 'ccr', autoRestore: true });
    await s.reorder(['c', 'a', 'b']);
    const all = await s.load();
    assert.deepStrictEqual(all.map((e) => e.id), ['c', 'a', 'b']);
    assert.deepStrictEqual(all.map((e) => e.order), [0, 1, 2]);
  });

  it('并发 reorder 不丢更新（回归：v1 曾因并发 load→save 丢数据）', async () => {
    const f = tmpFile();
    const s = new EntryStore(f);
    for (const id of ['a', 'b', 'c']) await s.append({ id, name: id, cwd: '/w', profile: 'ccr', autoRestore: true });
    await Promise.all([s.reorder(['b', 'c', 'a']), s.reorder(['c', 'b', 'a'])]);
    const all = await s.load();
    assert.strictEqual(all.length, 3, '不能丢条目');
    assert.deepStrictEqual(all.map((e) => e.order).sort(), [0, 1, 2], 'order 必须连续不重复');
  });
});
```

- [ ] **Step 11: 跑测试确认通过**

Run: `npm run compile && npx mocha "out/test/core/store.test.js" "out/test/core/migrate.test.js" "out/test/core/command.test.js" "out/test/core/plan.test.js"`
Expected: PASS

- [ ] **Step 12: 变异测试（两条，都必须做）**

1. 把 `load()` 里的顺序颠倒（先 `isEntry` 过滤再迁移）→ 重跑，**必须**看到 `三条都必须保留` 失败（实际 0 条）。这条变异直接复现了本任务要防的数据丢失。改回。
2. 把 `append` 的 order 分配改成固定 `0` → 重跑，**必须**看到 `并发 append 不产生相同 order` 失败。改回。

- [ ] **Step 13: 改 `src/terminalManager.ts` 的新增/复制走 `append`**

`addEntryInteractive` 末尾：

```ts
    await this.store.append({ id: newId(), name, cwd, profile: 'ccr', autoRestore });
```

（`profile` 默认 `'ccr'`；用户随后可在右键菜单里切 direct。`askCommands` 调用同时删除，见 Step 14。）

`duplicateEntry`：

```ts
  async duplicateEntry(entry: TerminalEntry): Promise<void> {
    const all = await this.store.load();
    const base = `${entry.name}-copy`;
    let name = base;
    let n = 2;
    while (all.some((e) => e.name === name)) {
      name = `${base}${n++}`;
    }
    // 用 append 而非 add：order 必须在 store 的锁内分配。
    // 直接复制 entry.order 会与源条目相同，排序随即不确定。
    const { order: _drop, ...rest } = entry;
    await this.store.append({ ...rest, id: newId(), name });
  }
```

- [ ] **Step 14: 删除 `askCommands` 及其调用**

`commands` 已不是数据。删掉 `askCommands` 方法，并移除 `addEntryInteractive` / `editEntryInteractive` 里对它的调用与相关早退分支。`editEntryInteractive` 保留 name / cwd 两项编辑。

- [ ] **Step 15: 全量测试**

Run: `npm test`
Expected: 全绿

- [ ] **Step 16: 提交**

```bash
git add src/core/types.ts src/core/command.ts src/core/migrate.ts src/core/plan.ts src/core/store.ts src/terminalManager.ts test/core/
git commit -m "feat(core)!: 条目模型换成 profile+model+order，含 v1 迁移与排序

命令不再作为用户数据（实测 6/6 条目是同一句），改由 profile 派生。
载入时先迁移再过滤 —— 顺序颠倒会静默丢弃已有条目。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 路径短名与消歧（纯函数）

**Files:**
- Create: `src/core/labels.ts`
- Test: `test/core/labels.test.ts`

**Interfaces:**
- Produces: `shortLabels(cwds: string[]): string[]` — 与输入等长、同序

**背景：** 用户现有 3 组重名（`workspace`×3、`strip-qt-ui`×3），单纯 basename 会让人分不清。

- [ ] **Step 1: 写失败测试** — `test/core/labels.test.ts`

```ts
import * as assert from 'assert';
import { shortLabels } from '../../src/core/labels';

describe('shortLabels', () => {
  it('无冲突时用 basename', () => {
    assert.deepStrictEqual(shortLabels(['/a/b/one', '/a/b/two']), ['one', 'two']);
  });

  it('basename 冲突时补一层父目录', () => {
    assert.deepStrictEqual(
      shortLabels(['/ssd/q/w/workspace', '/home/x/workspace']),
      ['q/w/workspace', 'x/workspace'],
    );
  });

  it('补一层仍冲突时继续往上补', () => {
    assert.deepStrictEqual(shortLabels(['/a/x/w', '/b/x/w']), ['a/x/w', 'b/x/w']);
  });

  it('末尾斜杠正常处理', () => {
    assert.deepStrictEqual(shortLabels(['~/mine/paint-pc/']), ['paint-pc']);
  });

  it('等长同序，空数组返回空数组', () => {
    assert.deepStrictEqual(shortLabels([]), []);
    assert.strictEqual(shortLabels(['/a', '/b']).length, 2);
  });

  it('绝对路径到根仍冲突时返回完整路径，不死循环', () => {
    const out = shortLabels(['/', '/']);
    assert.strictEqual(out.length, 2);
    assert.ok(out.every((s) => typeof s === 'string' && s.length > 0));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run compile && npx mocha "out/test/core/labels.test.js"`
Expected: 编译失败 —— 找不到 `../../src/core/labels`

- [ ] **Step 3: 写 `src/core/labels.ts`**

```ts
/**
 * 为每个 cwd 生成尽量短、且彼此可区分的显示名。
 *
 * 规则：从 basename 起，若与他人冲突就往上多带一层父目录，直到唯一。
 * 已经到根仍冲突则退回完整路径 —— 必须终止，不能死循环。
 *
 * 只做展示用途，不参与任何路径解析，所以不做权威的路径规范化；
 * 仅去掉末尾斜杠，避免 `/a/b/` 与 `/a/b` 被误判为不同名。
 */

function segments(p: string): string[] {
  return p.replace(/\/+$/, '').split('/').filter((s) => s.length > 0);
}

export function shortLabels(cwds: string[]): string[] {
  const parts = cwds.map(segments);
  return parts.map((seg, i) => {
    // 逐层加长，直到该长度在所有人里唯一
    for (let take = 1; take <= seg.length; take++) {
      const candidate = seg.slice(seg.length - take).join('/');
      const clash = parts.some((other, j) => {
        if (i === j) return false;
        const otherCand = other.slice(Math.max(0, other.length - take)).join('/');
        return otherCand === candidate;
      });
      if (!clash) return candidate;
    }
    // 到根仍冲突（例如两条都是 "/"）→ 退回完整路径
    const full = cwds[i];
    return full.length > 0 ? full : '/';
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run compile && npx mocha "out/test/core/labels.test.js"`
Expected: PASS

- [ ] **Step 5: 变异测试**

把 `if (i === j) return false;` 删掉 → 重跑，**必须**看到 `basename 冲突时补一层父目录` 失败（每条都和自己冲突 → 全变完整路径）。改回。

- [ ] **Step 6: 提交**

```bash
git add src/core/labels.ts test/core/labels.test.ts
git commit -m "feat(core): 路径短名与重名消歧

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: claude 进程识别（安全判据）与模型清单解析

**Files:**
- Create: `src/core/claude.ts`
- Create: `src/core/models.ts`
- Test: `test/core/claude.test.ts`, `test/core/models.test.ts`

**Interfaces:**
- Produces:
  - `isClaudeCommand(currentCommand: string): boolean`
  - `parseAvailableModels(raw: string): string[]`
  - `parseDefaultModel(raw: string): string | undefined`

- [ ] **Step 1: 写失败测试** — `test/core/claude.test.ts`

```ts
import * as assert from 'assert';
import { isClaudeCommand } from '../../src/core/claude';

describe('isClaudeCommand', () => {
  it('识别 claude 与 claude.exe', () => {
    assert.strictEqual(isClaudeCommand('claude'), true);
    assert.strictEqual(isClaudeCommand('claude.exe'), true);
  });

  it('识别带路径的形式', () => {
    assert.strictEqual(isClaudeCommand('/usr/bin/claude'), true);
    assert.strictEqual(isClaudeCommand('/usr/local/bin/claude-direct'), true);
  });

  it('允许前后空白（tmux 输出常带）', () => {
    assert.strictEqual(isClaudeCommand('  claude \n'), true);
  });

  it('★ 绝不把 node 当作 claude：用户的 build/test/dev server 大量是 node', () => {
    assert.strictEqual(isClaudeCommand('node'), false);
    assert.strictEqual(isClaudeCommand('/usr/bin/node'), false);
  });

  it('shell 与常见进程不算 claude', () => {
    for (const c of ['bash', 'zsh', 'sh', 'sleep', 'python3', 'vim', '']) {
      assert.strictEqual(isClaudeCommand(c), false, `${c} 不应判为 claude`);
    }
  });

  it('不因名字里含 claude 就误判（必须是最后一段以 claude 开头）', () => {
    assert.strictEqual(isClaudeCommand('/opt/myclaude-helper'), false);
    assert.strictEqual(isClaudeCommand('notclaude'), false);
  });
});
```

- [ ] **Step 2: 写失败测试** — `test/core/models.test.ts`

```ts
import * as assert from 'assert';
import { parseAvailableModels, parseDefaultModel } from '../../src/core/models';

const real = JSON.stringify({
  env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3460' },
  model: 'deepseek-v4-flash',
  availableModels: ['claude-opus-4-8[1m]', 'deepseek-v4-pro', 'qwen3.7-max'],
});

describe('parseAvailableModels', () => {
  it('读出清单', () => {
    assert.deepStrictEqual(parseAvailableModels(real), ['claude-opus-4-8[1m]', 'deepseek-v4-pro', 'qwen3.7-max']);
  });

  it('没有该字段 → 空数组', () => {
    assert.deepStrictEqual(parseAvailableModels('{}'), []);
  });

  it('坏 JSON / 非字符串项 → 宽容处理，不抛', () => {
    assert.deepStrictEqual(parseAvailableModels('{oops'), []);
    assert.deepStrictEqual(parseAvailableModels('{"availableModels":[1,"a",null]}'), ['a']);
  });
});

describe('parseDefaultModel', () => {
  it('读出默认模型', () => {
    assert.strictEqual(parseDefaultModel(real), 'deepseek-v4-flash');
  });

  it('缺失或非字符串 → undefined', () => {
    assert.strictEqual(parseDefaultModel('{}'), undefined);
    assert.strictEqual(parseDefaultModel('{"model":42}'), undefined);
    assert.strictEqual(parseDefaultModel('{oops'), undefined);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm run compile && npx mocha "out/test/core/claude.test.js" "out/test/core/models.test.js"`
Expected: 编译失败 —— 模块不存在

- [ ] **Step 4: 写 `src/core/claude.ts`**

```ts
/**
 * 判断 pane 当前前台进程是否是 claude。
 *
 * **这是安全判据，必须严格。** 扩展的「切模型 / 切 profile」会向会话发送
 * `/model ...`、`/exit` 这类控制序列。若目标不是 claude，这些字符就成了
 * 键盘输入，打进用户正在跑的进程 —— 一条 `/exit` 能毁掉一次编译。
 *
 * 判据：取路径最后一段，**以 `claude` 开头**。覆盖 `claude`、`claude.exe`、
 * `claude-direct`。
 *
 * **严禁放宽到 `node`。** claude 是 node 程序，但用户的 build、测试、
 * dev server 也大量是 node —— 把 node 纳入等于守卫失效。
 */
export function isClaudeCommand(currentCommand: string): boolean {
  const cmd = currentCommand.trim();
  if (cmd.length === 0) return false;
  const base = cmd.split('/').pop() ?? cmd;
  return base.startsWith('claude');
}
```

- [ ] **Step 5: 写 `src/core/models.ts`**

```ts
/**
 * 解析 claude settings JSON 里的模型清单。
 *
 * 复用用户已维护的 `availableModels`（全局 settings 里已有 13 个），
 * 而不是让扩展自带一份 —— 两处维护必然不同步。
 *
 * 一律宽容：settings 损坏不该让扩展功能不可用。
 */

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
    return v as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function parseAvailableModels(raw: string): string[] {
  const o = parseObject(raw);
  if (o === undefined) return [];
  const list = o.availableModels;
  if (!Array.isArray(list)) return [];
  return list.filter((m): m is string => typeof m === 'string' && m.length > 0);
}

export function parseDefaultModel(raw: string): string | undefined {
  const o = parseObject(raw);
  if (o === undefined) return undefined;
  const m = o.model;
  return typeof m === 'string' && m.length > 0 ? m : undefined;
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npm run compile && npx mocha "out/test/core/claude.test.js" "out/test/core/models.test.js"`
Expected: PASS

- [ ] **Step 7: 变异测试（本任务最重要的一步）**

把 `isClaudeCommand` 改成 `return base.startsWith('claude') || base === 'node';` → 重跑，**必须**看到 `★ 绝不把 node 当作 claude` 失败。改回。这一步证明该守卫的反向测试真的有效。

- [ ] **Step 8: 提交**

```bash
git add src/core/claude.ts src/core/models.ts test/core/claude.test.ts test/core/models.test.ts
git commit -m "feat(core): claude 进程识别（安全判据）与模型清单解析

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: tmux detach 封装与 profile 配置读取

**Files:**
- Modify: `src/tmuxClient.ts`
- Create: `src/claudeConfig.ts`

**Interfaces:**
- Consumes: `parseAvailableModels`, `parseDefaultModel`（Task 3）
- Produces:
  - `TmuxClient.detachClients(name: string): Promise<void>`
  - `readProfileConfig(profile: Profile, home: string): Promise<{ models: string[]; defaultModel?: string }>`

- [ ] **Step 1: 给 `src/tmuxClient.ts` 加方法**

在 `killSession` 之后插入：

```ts
  /**
   * 摘掉附着在该会话上的所有客户端。
   *
   * 杀会话前先 detach：否则「终端里的 attach 客户端」与「kill」之间存在
   * 时序窗口，用户会看到面板停在 tmux 界面 / 状态与 UI 不符（实测问题）。
   * 会话本就不存在时 tmux 报错，视为已达成目标。
   */
  async detachClients(name: string): Promise<void> {
    try {
      await run(this.tmuxPath, ['detach-client', '-s', sessionTarget(name)]);
    } catch {
      // 没有客户端附着 —— 目标状态已达成
    }
  }
```

- [ ] **Step 2: 写 `src/claudeConfig.ts`**

```ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseAvailableModels, parseDefaultModel } from './core/models';
import { Profile } from './core/types';

/**
 * 读取某个 profile 的模型配置。
 *
 * ccr    → ~/.claude/settings.json
 * direct → /etc/claude/direct.json（claude-direct 包装脚本里写死的路径）
 *
 * 读不到就返回空清单，调用方据此退化为手输 —— 绝不编造候选项。
 */
export async function readProfileConfig(
  profile: Profile,
  home: string,
): Promise<{ models: string[]; defaultModel?: string }> {
  const file = profile === 'direct'
    ? '/etc/claude/direct.json'
    : path.join(home, '.claude', 'settings.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return { models: [] };
  }
  return {
    models: parseAvailableModels(raw),
    defaultModel: parseDefaultModel(raw),
  };
}
```

- [ ] **Step 3: 编译**

Run: `npm run compile`
Expected: 无输出

- [ ] **Step 4: 核对真实文件能读出模型**

Run:
```bash
node -e "
const {readProfileConfig}=require('./out/src/claudeConfig');
const os=require('os');
readProfileConfig('ccr', os.homedir()).then(r=>console.log('ccr:', r.models.length, '个模型, 默认=', r.defaultModel));
readProfileConfig('direct', os.homedir()).then(r=>console.log('direct:', r.models.length, '个模型, 默认=', r.defaultModel));
"
```
Expected: `ccr: 13 个模型, 默认= deepseek-v4-flash`；`direct: 0 个模型, 默认= claude-sonnet-5[1m]`（direct.json 无 `availableModels`，切模型时会退化为手输 —— 符合预期）

- [ ] **Step 5: 提交**

```bash
git add src/tmuxClient.ts src/claudeConfig.ts
git commit -m "feat: tmux detach-client 封装与 profile 配置读取

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 清单显示改造（短路径 + profile 徽标）

**Files:**
- Modify: `src/tree.ts`

**Interfaces:**
- Consumes: `shortLabels`（Task 2）、`commandFor`（Task 1）
- Produces: `EntryTreeItem(entry, alive, shortPath)`

**背景：** 徽标颜色用 `ThemeIcon` + `ThemeColor`。v1 曾在**活动栏图标**上用 `currentColor` 导致图标不可见，那是活动栏独有的 CSS mask 渲染路径；树内 `ThemeIcon` 颜色是另一条路径，v1 的存活绿点（`terminal.ansiGreen`）已在用且正常。此处有先例，风险已排除。

- [ ] **Step 1: 改 `EntryTreeItem`**

```ts
import * as vscode from 'vscode';
import { commandFor } from './core/command';
import { shortLabels } from './core/labels';
import { sessionNameFor } from './core/tmux';
import { TerminalEntry } from './core/types';

/** profile 对应的徽标颜色。ccr=蓝（本地中转），direct=橙（官方直连）。 */
function profileColor(entry: TerminalEntry): vscode.ThemeColor {
  return new vscode.ThemeColor(
    entry.profile === 'direct' ? 'charts.orange' : 'charts.blue',
  );
}

/**
 * 清单里的一行。
 *
 * `contextValue` 决定右键菜单显隐：`killSession` 只在存活时出现，
 * 见 package.json 里 `viewItem == aliveSession` 的 when 条件。
 *
 * 存活与否用**图标形状**表示，profile 用**颜色**表示 —— 两个维度互不覆盖。
 */
export class EntryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: TerminalEntry,
    public readonly alive: boolean,
    /** 由 shortLabels() 算好的短路径，冲突时带父目录 */
    public readonly shortPath: string,
  ) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.id = entry.id;
    this.contextValue = alive ? 'aliveSession' : 'deadSession';
    this.description = alive ? shortPath : `${shortPath}（无会话）`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${entry.name}**`,
        '',
        `- 目录：\`${entry.cwd}\``,
        `- profile：${entry.profile === 'direct' ? '🟠 direct（官方直连）' : '🔵 ccr（本地中转）'}`,
        `- 模型：${entry.model && entry.model.length > 0 ? `\`${entry.model}\`` : '（profile 默认）'}`,
        `- 启动命令：\`${commandFor(entry)}\``,
        `- 状态：${alive ? '🟢 会话存活，点击接回原进程' : '⚪ 无会话，点击新建并启动'}`,
        `- 参与全部恢复：${entry.autoRestore ? '是' : '否'}`,
      ].join('\n'),
    );
    this.iconPath = new vscode.ThemeIcon(
      alive ? 'circle-filled' : 'circle-outline',
      profileColor(entry),
    );
    this.command = {
      command: 'tmuxTerminals.open',
      title: '打开终端',
      arguments: [this],
    };
  }
}
```

- [ ] **Step 2: 改 `getChildren`**

```ts
  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element) return [];
    this.entries = await this.store.load();
    if (this.entries.length === 0) return [new EmptyTreeItem()];
    const labels = shortLabels(this.entries.map((e) => e.cwd));
    return this.entries.map(
      (e, i) => new EntryTreeItem(e, this.alive.has(sessionNameFor(e.id)), labels[i]),
    );
  }
```

- [ ] **Step 3: 编译并跑全量测试**

Run: `npm run compile && npm test`
Expected: 全绿

- [ ] **Step 4: 提交**

```bash
git add src/tree.ts
git commit -m "feat(tree): 短路径显示与 profile 颜色徽标

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 拖拽排序

**Files:**
- Modify: `src/tree.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: `EntryStore.reorder`（Task 1）
- Produces: `EntryTreeProvider implements vscode.TreeDragAndDropController<TreeNode>`

- [ ] **Step 1: 在 `src/tree.ts` 实现拖拽**

类声明改为：

```ts
export class EntryTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode>
{
```

类内新增：

```ts
  // ---- 拖拽排序 ----
  // 拖拽是独立 API，不是 TreeItem 自带的能力。
  readonly dragMimeTypes = ['application/vnd.code.tree.tmuxterminals.list'];
  readonly dropMimeTypes = ['application/vnd.code.tree.tmuxterminals.list'];

  async handleDrag(
    source: readonly TreeNode[],
    data: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const ids = source
      .filter((n): n is EntryTreeItem => n instanceof EntryTreeItem)
      .map((n) => n.entry.id);
    data.set(this.dragMimeTypes[0], ids);
  }

  /**
   * 落点语义：拖到目标行 = **插到该行之前**。
   *
   * 不用「上/下半区分别表示前/后」：那需要落点位置信息，而 handleDrop 在
   * 部分场景并不提供，语义会随 VS Code 版本漂移。统一为「之前」后，拖到
   * 列表末尾即可实现「放到最后」。
   *
   * 只改本地顺序，**绝不触发任何 tmux 操作**。
   */
  async handleDrop(
    target: TreeNode | undefined,
    sources: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const item = sources.get(this.dragMimeTypes[0]);
    if (!item) return;
    const draggedIds = item.value as string[];
    if (!Array.isArray(draggedIds) || draggedIds.length === 0) return;

    const all = await this.store.load();
    const ids = all.map((e) => e.id).filter((id) => !draggedIds.includes(id));

    // 目标未定义 = 拖到空白处 → 追加到末尾
    const targetId = target instanceof EntryTreeItem ? target.entry.id : undefined;
    const at = targetId === undefined ? ids.length : ids.indexOf(targetId);
    const insertAt = at === -1 ? ids.length : at;

    ids.splice(insertAt, 0, ...draggedIds);
    await this.store.reorder(ids); // 内部经 enqueue 串行化，防并发丢更新
    this.emitter.fire();
  }
```

- [ ] **Step 2: 在 `src/extension.ts` 注册拖拽**

```ts
  const view = vscode.window.createTreeView('tmuxTerminals.list', {
    treeDataProvider: provider,
    dragAndDropController: provider,
  });
```

- [ ] **Step 3: 编译**

Run: `npm run compile`
Expected: 无输出

- [ ] **Step 4: 手动验证（拖拽无法单测，必须手工做）**

打包安装后（Task 11），在侧边栏拖动条目，确认：
1. 顺序改变并持久（重载窗口后仍是新顺序）
2. 打开 `~/.vscode-server-insiders/data/User/globalStorage/kryienaruto.vscode-tmux-terminals/terminals.json`，`order` 是 `0..n-1` 连续
3. **不触发任何 tmux 操作**：拖拽前后 `tmux ls` 输出完全一致

- [ ] **Step 5: 提交**

```bash
git add src/tree.ts src/extension.ts
git commit -m "feat(tree): 条目拖拽排序，落点统一为「插到目标之前」

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 杀会话修复 + openEntry 复用守卫

**Files:**
- Modify: `src/terminalManager.ts`
- Modify: `test/e2e-harness.js`

**Interfaces:**
- Consumes: `TmuxClient.detachClients`（Task 4）
- Produces: `killSession` 会 dispose 对应终端；`openEntry` 先按名复用已有终端

**背景：** 用户实测「杀掉 tmux 后，右侧终端面板没有关闭，导致留在面板里，又连接上了」。可自洽的机制：面板未关但终端进程已退出 → VS Code 触发 close → `terminals` Map 被清空 → 再点条目 Map 未命中 → 走完整 `openEntry`（建会话 + attach）→ 表现为「又连上了」。本任务把每个入口都堵上。

- [ ] **Step 1: 加按名复用守卫**

在 `openEntry` 里，`Map` 未命中之后、`hasSession` 之前插入：

```ts
    // Map 是内存态，扩展宿主重启后会清空，而终端面板仍在。没有这道守卫
    // 就会出现「两个面板连着同一个会话」，并再次制造 UI 与实际不符。
    const reused = vscode.window.terminals.find((t) => t.name === entry.name);
    if (reused) {
      this.terminals.set(session, reused);
      reused.show();
      return;
    }
```

- [ ] **Step 2: 改 `killSession`**

```ts
  async killSession(entry: TerminalEntry): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      `杀掉远端 tmux 会话「${entry.name}」？其中正在运行的进程会一并终止，对应终端也会关闭。`,
      { modal: true },
      '杀掉',
    );
    if (pick !== '杀掉') return;

    const session = sessionNameFor(entry.id);

    // 顺序不能变：先摘客户端，再杀会话。否则「终端里的 attach」与「kill」
    // 之间的时序窗口会让面板停在 tmux 界面，造成 UI 与实际不符。
    await this.tmux.detachClients(session);
    await this.tmux.killSession(session);

    // 关掉面板并从 Map 清掉 —— 否则 Map 与 UI 不一致，下次点击会以为
    // 「没有终端」而重新 attach，看起来就像「杀不掉」。
    const term = this.terminals.get(session);
    if (term) {
      this.terminals.delete(session);
      term.dispose();
    }

    vscode.window.showInformationMessage(`已杀掉会话「${entry.name}」。`);
  }
```

- [ ] **Step 3: 编译**

Run: `npm run compile`
Expected: 无输出

- [ ] **Step 4: 先读 `test/e2e-harness.js`，摸清它现有的输出与断言写法**

Run: `sed -n '1,40p' test/e2e-harness.js`

该文件已通过 `Module._resolveFilename` 注入 `vscode` 桩，并直接 require 编译产物。**沿用文件里已有的 section 输出函数与断言风格**，不要新造名字。

- [ ] **Step 5: 追加一节：杀会话后不留客户端**

```js
// ---- 杀会话：会话销毁且无残留客户端 ----
{
  const { spawn } = require('child_process');
  const s = sessionNameFor('e2ekill0001');
  await tmux.newSession(s, os.tmpdir());

  // 起一个真实 pty 客户端附着，模拟 VS Code 终端里的 tmux attach
  const client = spawn('script', ['-qec', `tmux attach -t =${s}`, '/dev/null'], {
    stdio: 'ignore', detached: true,
  });
  await new Promise((r) => setTimeout(r, 1500));

  await tmux.detachClients(s);
  await tmux.killSession(s);
  await new Promise((r) => setTimeout(r, 800));

  assert.strictEqual(await tmux.hasSession(s), false, '会话必须已被杀掉');
  const { stdout: clients } = await run('tmux', ['list-clients', '-F', '#{client_session}']);
  assert.ok(!clients.includes(s), `不应残留指向 ${s} 的客户端，实际：${clients}`);

  try { process.kill(-client.pid); } catch {}
}
```

- [ ] **Step 6: 跑 e2e**

Run: `npm run e2e`
Expected: 全部 section 通过，含新增的杀会话一节

- [ ] **Step 7: 提交**

```bash
git add src/terminalManager.ts test/e2e-harness.js
git commit -m "fix: 杀会话改为 detach→kill→关闭面板，并加终端按名复用守卫

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: 单条切模型 / 切 profile（运行中立即生效）

**Files:**
- Modify: `src/terminalManager.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `test/manifest.test.ts`

**Interfaces:**
- Consumes: `isClaudeCommand`（Task 3）、`readProfileConfig`（Task 4）、`commandFor`（Task 1）
- Produces:
  - `TerminalManager.applyModel(entry, model?)`
  - `TerminalManager.applyProfile(entry, profile)`
  - `TerminalManager.setModelInteractive(entry)` / `setProfileInteractive(entry)`
  - `TerminalManager.restartClaude(entry, launch, resume)`

**核心不变量：** 只在「会话存活」且「`isClaudeCommand(pane 当前进程)`」时发控制序列，否则拒绝并说明。

- [ ] **Step 1: 加 import 与守卫**

顶部：

```ts
import { commandFor } from './core/command';
import { isClaudeCommand } from './core/claude';
import { readProfileConfig } from './claudeConfig';
import { Profile } from './core/types';
```

类内：

```ts
  /**
   * 判断能否向该会话发送控制序列（`/model ...`、`/exit`）。
   *
   * **安全闸门。** 目标不是 claude 时，这些字符会变成键盘输入打进用户正在
   * 跑的进程 —— 一条 `/exit` 能毁掉一次编译。判据见 core/claude.ts：严格
   * 要求基名以 claude 开头，绝不把 node 当作 claude。
   */
  private async canSendControl(session: string): Promise<boolean> {
    return isClaudeCommand(await this.tmux.currentCommand(session));
  }

  /** 拒绝执行并说明原因。绝不静默跳过、绝不盲发。 */
  private refuse(entry: TerminalEntry, what: string): void {
    void vscode.window.showErrorMessage(
      `「${entry.name}」当前前台进程不是 claude，已拒绝${what}。` +
      `请先在该终端里退出正在运行的程序（或直接杀掉会话），再试。`,
    );
  }
```

- [ ] **Step 2: 加 `restartClaude`**

**签名要点：** 启动用哪个配置由 `launch` 单独给出，不能复用 `entry`。否则「目标 = profile 默认模型」这条路径会带着**旧的** `--model` 重启，完全违背该分支的存在意义。

```ts
  /**
   * 退出当前 claude 并按 `launch` 的配置重新启动。
   *
   * `launch` 与 `entry` 分开传：调用方常需要「改某个字段后再启动」
   * （如清掉 model 以回落到 profile 默认），而提示语仍要用原条目的名字。
   *
   * 返回 false 表示被安全守卫拒绝。
   */
  private async restartClaude(
    entry: TerminalEntry,
    launch: TerminalEntry,
    resume: boolean,
  ): Promise<boolean> {
    const session = sessionNameFor(entry.id);
    if (!(await this.canSendControl(session))) {
      this.refuse(entry, '重启 claude');
      return false;
    }

    await this.tmux.sendLiteral(session, '/exit');
    await this.tmux.sendEnter(session);

    // 等回到 shell —— 用既有轮询而非固定 sleep
    if (!(await this.tmux.waitForShell(session, SHELL_READY_TIMEOUT_MS))) {
      void vscode.window.showWarningMessage(
        `「${entry.name}」未在 ${SHELL_READY_TIMEOUT_MS / 1000}s 内回到 shell，已中止切换。`,
      );
      return false;
    }

    const base = commandFor(launch);
    // --continue 接回原对话：两个 profile 共用 ~/.claude/projects/（实测）
    const cmd = resume ? `${base} --continue` : base;
    await this.tmux.sendLiteral(session, cmd);
    await this.tmux.sendEnter(session);
    return true;
  }
```

- [ ] **Step 3: 加 `applyModel` / `applyProfile`**

```ts
  /**
   * 把模型设置应用到一条条目。
   *
   * 未运行的会话：只改配置。下次 openEntry 由 commandFor 带出 `--model`
   * （实测 `--model` 启动参数**不**污染全局默认）。
   *
   * 运行中的会话：发 `/model <名称>` 立即生效。但实测 `/model` 会**顺带改写
   * `~/.claude/settings.json` 的全局默认**。所以当目标恰好是该 profile 的
   * 默认模型（含「清空」）时，改走「重启且不带 --model」：行为等价
   * （都回到默认），但没有副作用。
   */
  async applyModel(entry: TerminalEntry, model: string | undefined): Promise<void> {
    const session = sessionNameFor(entry.id);
    const normalized = model && model.length > 0 ? model : undefined;
    const alive = await this.tmux.hasSession(session);

    if (!alive) {
      await this.store.update(entry.id, { model: normalized });
      return;
    }

    const cfg = await readProfileConfig(entry.profile, this.home());
    const isProfileDefault = normalized !== undefined && normalized === cfg.defaultModel;

    if (normalized !== undefined && !isProfileDefault) {
      if (!(await this.canSendControl(session))) {
        this.refuse(entry, '切模型');
        return;
      }
      await this.tmux.sendLiteral(session, `/model ${normalized}`);
      await this.tmux.sendEnter(session);
    } else {
      // 目标就是 profile 默认（含清空）：重启且不带 --model，避免写全局默认
      const ok = await this.restartClaude(entry, { ...entry, model: undefined }, false);
      if (!ok) return; // 被拒绝时不动配置，避免配置与实际不一致
    }
    await this.store.update(entry.id, { model: normalized });
  }

  /**
   * 切换 profile（ccr ↔ direct），即换鉴权来源与端点。
   *
   * 重启 CLI 并用 `--continue` 接回原对话 —— 两个 profile 共用
   * `~/.claude/projects/`（实测 direct.json 不覆盖该目录）。
   *
   * model 一并清空：两个 profile 的模型命名空间不同（deepseek-* vs
   * claude-*），沿用旧值几乎必然无效，回落到新 profile 的默认才正确。
   */
  async applyProfile(entry: TerminalEntry, profile: Profile): Promise<void> {
    if (entry.profile === profile) return;
    const session = sessionNameFor(entry.id);

    if (await this.tmux.hasSession(session)) {
      const ok = await this.restartClaude(
        entry,
        { ...entry, profile, model: undefined },
        true,
      );
      if (!ok) return; // 被拒绝时不动配置
    }
    await this.store.update(entry.id, { profile });
  }
```

- [ ] **Step 4: 加交互式入口**

```ts
  /** 单条：选一个模型。清单来自 profile 的 settings；读不到则允许手输。 */
  async setModelInteractive(entry: TerminalEntry): Promise<void> {
    const { models } = await readProfileConfig(entry.profile, this.home());
    const MANUAL = '$(pencil) 手动输入…';
    const pick = await vscode.window.showQuickPick([...models, MANUAL], {
      title: `为「${entry.name}」设置模型（${entry.profile}）`,
      placeHolder: entry.model ?? '（当前用 profile 默认）',
    });
    if (pick === undefined) return;

    let model: string | undefined = pick === MANUAL ? undefined : pick;
    if (pick === MANUAL) {
      const typed = await vscode.window.showInputBox({
        title: '模型名',
        prompt: '留空 = 用 profile 默认模型',
        value: entry.model ?? '',
      });
      if (typed === undefined) return;
      model = typed.trim().length > 0 ? typed.trim() : undefined;
    }
    await this.applyModel(entry, model);
  }

  /** 单条：在 ccr / direct 之间切换。 */
  async setProfileInteractive(entry: TerminalEntry): Promise<void> {
    const target: Profile = entry.profile === 'direct' ? 'ccr' : 'direct';
    const label = target === 'direct' ? '🟠 direct（官方直连）' : '🔵 ccr（本地中转）';
    const pick = await vscode.window.showWarningMessage(
      `把「${entry.name}」切到 ${label}？运行中的 claude 会重启（用 --continue 接回原对话）。`,
      { modal: true },
      '切换',
    );
    if (pick !== '切换') return;
    await this.applyProfile(entry, target);
  }
```

- [ ] **Step 5: 在 `src/extension.ts` 注册**

```ts
  reg('tmuxTerminals.setModel', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.setModelInteractive(it.entry);
    provider.refresh();
  });

  reg('tmuxTerminals.setProfile', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.setProfileInteractive(it.entry);
    await poll();
    provider.refresh();
  });
```

- [ ] **Step 6: 在 `package.json` 声明命令与菜单**

`contributes.commands` 追加：

```json
{ "command": "tmuxTerminals.setModel", "title": "设置模型…", "icon": "$(chip)" },
{ "command": "tmuxTerminals.setProfile", "title": "切换直连/中转", "icon": "$(plug)" },
```

`contributes.menus["view/item/context"]` 追加（放在编辑组最前）：

```json
{ "command": "tmuxTerminals.setModel", "when": "view == tmuxTerminals.list", "group": "2_edit@0" },
{ "command": "tmuxTerminals.setProfile", "when": "view == tmuxTerminals.list", "group": "2_edit@1" }
```

- [ ] **Step 7: 给 `test/manifest.test.ts` 加断言**

```ts
  it('每条声明过的命令都在 extension.ts 里注册（防「声明了但没注册」）', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'src/extension.ts'), 'utf8');
    for (const c of contributes.commands ?? []) {
      const id: string = c.command;
      // 两种引号都认 —— 注册处可能用单引号也可能用双引号
      const registered = src.includes(`'${id}'`) || src.includes(`"${id}"`);
      assert.ok(registered, `package.json 声明了 ${id}，但 extension.ts 里找不到`);
    }
  });
```

- [ ] **Step 8: 跑全量测试**

Run: `npm test`
Expected: 全绿

- [ ] **Step 9: 提交**

```bash
git add src/terminalManager.ts src/extension.ts package.json test/manifest.test.ts
git commit -m "feat: 单条切换模型与 profile，运行中会话立即生效

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: 批量操作面板（第二个 view）

**Files:**
- Create: `src/batchTree.ts`
- Modify: `src/extension.ts`
- Modify: `src/terminalManager.ts`
- Modify: `package.json`
- Modify: `test/manifest.test.ts`

**Interfaces:**
- Consumes: `applyModel` / `applyProfile`（Task 8）、`shortLabels`（Task 2）、`readProfileConfig`（Task 4）
- Produces:
  - `BatchTreeItem`、`BatchTreeProvider`（`refresh` / `selectedIds` / `toggle` / `clear` / `prune` / `entriesFor`）
  - `TerminalManager.applyModelToMany(entries, model?)` / `applyProfileToMany(entries, profile)`

- [ ] **Step 1: 写 `src/batchTree.ts`**

```ts
import * as vscode from 'vscode';
import { shortLabels } from './core/labels';
import { TerminalEntry } from './core/types';

/**
 * 批量操作面板里的一行。
 *
 * **选中态由图标承载，不用 VS Code 的原生高亮。** 原因：原生高亮跟随
 * **焦点**，用方向键浏览时高亮会移动；把高亮当"已选"会造成误操作
 * （以为选中 3 条，实际只有 1 条）。所以已选 = 实心蓝勾，未选 = 空心圈。
 */
export class BatchTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: TerminalEntry,
    public readonly selected: boolean,
    shortPath: string,
  ) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.id = entry.id;
    this.contextValue = 'batchItem';
    this.description = shortPath;
    this.tooltip = `${entry.name}｜${entry.cwd}｜${entry.profile}${
      entry.model ? `｜${entry.model}` : ''
    }`;
    this.iconPath = new vscode.ThemeIcon(
      selected ? 'check' : 'circle-large-outline',
      selected ? new vscode.ThemeColor('charts.blue') : undefined,
    );
    // 点击 = 切换选中态，绝不打开终端
    this.command = {
      command: 'tmuxTerminals.batchToggle',
      title: '切换选中',
      arguments: [entry.id],
    };
  }
}

/** 选中集合只存内存 —— 它是临时操作态，扩展重载后清空是合理的。 */
export class BatchTreeProvider implements vscode.TreeDataProvider<BatchTreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private entries: TerminalEntry[] = [];
  private readonly selected = new Set<string>();

  constructor(private readonly store: { load(): Promise<TerminalEntry[]> }) {}

  refresh(): void {
    this.emitter.fire();
  }

  selectedIds(): string[] {
    return [...this.selected];
  }

  /** 返回切换后的选中态。 */
  toggle(id: string): boolean {
    const now = !this.selected.has(id);
    if (now) this.selected.add(id);
    else this.selected.delete(id);
    this.emitter.fire();
    return now;
  }

  clear(): void {
    this.selected.clear();
    this.emitter.fire();
  }

  /** 条目被删除后必须从选中集合剔除，否则会对已删条目执行操作。 */
  private prune(existingIds: string[]): void {
    const keep = new Set(existingIds);
    let changed = false;
    for (const id of [...this.selected]) {
      if (!keep.has(id)) {
        this.selected.delete(id);
        changed = true;
      }
    }
    if (changed) this.emitter.fire();
  }

  async getChildren(element?: BatchTreeItem): Promise<BatchTreeItem[]> {
    if (element) return [];
    this.entries = await this.store.load();
    this.prune(this.entries.map((e) => e.id));
    const labels = shortLabels(this.entries.map((e) => e.cwd));
    return this.entries.map(
      (e, i) => new BatchTreeItem(e, this.selected.has(e.id), labels[i]),
    );
  }

  getTreeItem(element: BatchTreeItem): vscode.TreeItem {
    return element;
  }

  /** 供批量命令取回完整条目（选中集合只存 id）。 */
  entriesFor(ids: string[]): TerminalEntry[] {
    const want = new Set(ids);
    return this.entries.filter((e) => want.has(e.id));
  }
}
```

- [ ] **Step 2: 在 `src/terminalManager.ts` 加批量执行**

```ts
  /**
   * 批量套用。逐条独立捕获异常，沿用 restoreAll 的写法：一条失败不影响
   * 其余，结束后汇报「成功 N / 失败 M」。
   */
  private async applyToMany(
    entries: TerminalEntry[],
    label: string,
    one: (e: TerminalEntry) => Promise<void>,
  ): Promise<void> {
    if (entries.length === 0) {
      void vscode.window.showInformationMessage('没有选中任何条目。');
      return;
    }
    let ok = 0;
    const failed: string[] = [];
    for (const e of entries) {
      try {
        await one(e);
        ok++;
      } catch {
        failed.push(e.name);
      }
      // 轻微错开，避免同时重启多个 claude 争抢资源
      await new Promise((r) => setTimeout(r, 50));
    }
    const msg = failed.length === 0
      ? `${label}：成功 ${ok} 条。`
      : `${label}：成功 ${ok} 条，失败 ${failed.length} 条（${failed.join('、')}）。`;
    void vscode.window.showInformationMessage(msg);
  }

  async applyModelToMany(entries: TerminalEntry[], model: string | undefined): Promise<void> {
    await this.applyToMany(entries, '批量设置模型', (e) => this.applyModel(e, model));
  }

  async applyProfileToMany(entries: TerminalEntry[], profile: Profile): Promise<void> {
    await this.applyToMany(entries, '批量切换直连/中转', (e) => this.applyProfile(e, profile));
  }
```

- [ ] **Step 3: 在 `src/extension.ts` 注册第二个 view 与批量命令**

```ts
  const batchProvider = new BatchTreeProvider(store);
  const batchView = vscode.window.createTreeView('tmuxTerminals.batch', {
    treeDataProvider: batchProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(batchView);
```

命令：

```ts
  // 内部命令：只由批量面板的 TreeItem.command 调用，故不在 package.json 里
  // 声明 —— 声明了就会出现在命令面板，徒增噪音。
  reg('tmuxTerminals.batchToggle', (id: unknown) => {
    if (typeof id === 'string') batchProvider.toggle(id);
  });

  reg('tmuxTerminals.batchClear', () => batchProvider.clear());

  reg('tmuxTerminals.batchSetDirect', async () => {
    await manager.applyProfileToMany(
      batchProvider.entriesFor(batchProvider.selectedIds()), 'direct',
    );
    batchProvider.clear();
    await poll();
    provider.refresh();
  });

  reg('tmuxTerminals.batchSetCcr', async () => {
    await manager.applyProfileToMany(
      batchProvider.entriesFor(batchProvider.selectedIds()), 'ccr',
    );
    batchProvider.clear();
    await poll();
    provider.refresh();
  });

  reg('tmuxTerminals.batchSetModel', async () => {
    const targets = batchProvider.entriesFor(batchProvider.selectedIds());
    if (targets.length === 0) {
      void vscode.window.showInformationMessage('请先在「批量操作」里选中条目。');
      return;
    }
    // 候选取第一条的 profile：批量场景下用户的心智是「这批统一成某个模型」
    const { models } = await readProfileConfig(targets[0].profile, os.homedir());
    const CLEAR = '（清空，用 profile 默认）';
    const pick = await vscode.window.showQuickPick([...models, CLEAR], {
      title: `批量设置模型（${targets.length} 条）`,
    });
    if (pick === undefined) return;
    await manager.applyModelToMany(targets, pick === CLEAR ? undefined : pick);
    batchProvider.clear();
    await poll();
    provider.refresh();
  });
```

顶部补 import：

```ts
import * as os from 'os';
import { BatchTreeProvider } from './batchTree';
import { readProfileConfig } from './claudeConfig';
```

- [ ] **Step 4: 在 `package.json` 声明第二个 view、命令与标题栏菜单**

`contributes.views.tmuxTerminals` 追加：

```json
{ "id": "tmuxTerminals.batch", "name": "批量操作" }
```

`contributes.commands` 追加（**不含 `batchToggle`**，理由见 Step 3 的注释）：

```json
{ "command": "tmuxTerminals.batchSetCcr", "title": "设为中转", "icon": "$(cloud)" },
{ "command": "tmuxTerminals.batchSetDirect", "title": "设为直连", "icon": "$(plug)" },
{ "command": "tmuxTerminals.batchSetModel", "title": "批量设置模型…", "icon": "$(chip)" },
{ "command": "tmuxTerminals.batchClear", "title": "清空选择", "icon": "$(clear-all)" }
```

`contributes.menus["view/title"]` 追加：

```json
{ "command": "tmuxTerminals.batchSetCcr", "when": "view == tmuxTerminals.batch", "group": "navigation@1" },
{ "command": "tmuxTerminals.batchSetDirect", "when": "view == tmuxTerminals.batch", "group": "navigation@2" },
{ "command": "tmuxTerminals.batchSetModel", "when": "view == tmuxTerminals.batch", "group": "navigation@3" },
{ "command": "tmuxTerminals.batchClear", "when": "view == tmuxTerminals.batch", "group": "navigation@4" }
```

- [ ] **Step 5: 给 `test/manifest.test.ts` 加断言**

```ts
  it('两个 view 同属 tmuxTerminals 容器', () => {
    const containerIds = (contributes.viewsContainers?.activitybar ?? []).map((c: any) => c.id);
    assert.ok(containerIds.includes('tmuxTerminals'));
    const views = contributes.views?.tmuxTerminals ?? [];
    for (const viewId of ['tmuxTerminals.list', 'tmuxTerminals.batch']) {
      assert.ok(views.some((v: any) => v.id === viewId), `缺少 view ${viewId}`);
    }
  });
```

- [ ] **Step 6: 跑全量测试**

Run: `npm test`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add src/batchTree.ts src/extension.ts src/terminalManager.ts package.json test/manifest.test.ts
git commit -m "feat: 批量操作面板（第二个 view），支持批量切模型与直连

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: 目录输入提示

**Files:**
- Modify: `src/core/paths.ts`
- Modify: `src/terminalManager.ts`
- Test: `test/core/paths.test.ts`

**Interfaces:**
- Produces: `rankCandidates(used, discovered, limit?): { items: string[]; truncated: number }`

- [ ] **Step 1: 写失败测试** — 追加到 `test/core/paths.test.ts`

```ts
describe('rankCandidates', () => {
  it('已用过的排在最前，且去重', () => {
    const r = rankCandidates(['/used'], ['/new', '/used']);
    assert.deepStrictEqual(r.items, ['/used', '/new']);
  });

  it('截断时报告数量（不能静默丢弃）', () => {
    const r = rankCandidates([], ['/a', '/b', '/c'], 2);
    assert.deepStrictEqual(r.items, ['/a', '/b']);
    assert.strictEqual(r.truncated, 1);
  });

  it('空串与纯空白被剔除', () => {
    assert.deepStrictEqual(rankCandidates(['', '  '], []).items, []);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run compile && npx mocha "out/test/core/paths.test.js"`
Expected: 编译失败 —— `rankCandidates` 不存在

- [ ] **Step 3: 在 `src/core/paths.ts` 追加**

```ts
/**
 * 把候选项去重、排序、截断。
 *
 * 排序规则：条目里**已用过的目录最优先**（对高频目录最有用），其余按给定顺序。
 * 截断数量必须回报 —— 静默丢弃会让用户以为没有那个目录。
 */
export function rankCandidates(
  used: string[],
  discovered: string[],
  limit = 50,
): { items: string[]; truncated: number } {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...used, ...discovered]) {
    const t = p.trim();
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return { items: out.slice(0, limit), truncated: Math.max(0, out.length - limit) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run compile && npx mocha "out/test/core/paths.test.js"`
Expected: PASS

- [ ] **Step 5: 改 `askCwd`**

```ts
  /**
   * 选目录。候选 = 已有条目用过的目录 + `~` 一层 + `~/workspace` 一层。
   *
   * 只扫一层：深扫会卡，而深层目录用户手输更快。
   */
  private async askCwd(current?: string): Promise<string | undefined> {
    const MANUAL = '$(pencil) 手动输入…';
    const all = await this.store.load();
    const used = all.map((e) => e.cwd);

    const home = this.home();
    const discovered: string[] = [];
    for (const base of ['~', '~/workspace']) {
      try {
        const dir = expandHome(base, home);
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const d of entries) {
          if (!d.isDirectory() || d.name.startsWith('.')) continue;
          discovered.push(base === '~' ? `~/${d.name}` : `${base}/${d.name}`);
        }
      } catch {
        // 目录不存在 —— 跳过，不打扰用户
      }
    }

    const { items, truncated } = rankCandidates(used, discovered);
    const title = truncated > 0
      ? `远程目录（候选过多，仅显示前 ${items.length} 条，可手动输入其他）`
      : '远程目录';

    const pick = await vscode.window.showQuickPick([MANUAL, ...items], {
      title,
      placeHolder: current ?? '选择或手动输入',
    });
    if (pick === undefined) return undefined;
    if (pick === MANUAL) {
      return vscode.window.showInputBox({
        title: '远程目录',
        prompt: '支持 ~ 开头，例如 ~/mine/paint-pc',
        value: current ?? '',
        validateInput: (v) => (v.trim().length === 0 ? '目录不能为空' : null),
      });
    }
    return pick;
  }
```

顶部补 import：

```ts
import * as fs from 'fs/promises';
import { expandHome, rankCandidates, validateName } from './core/paths';
```

- [ ] **Step 6: 编译并跑全量测试**

Run: `npm test`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add src/terminalManager.ts src/core/paths.ts test/core/paths.test.ts
git commit -m "feat: 目录选择改为候选提示（已用目录优先），深扫只做一层

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: 端到端验证、文档、打包安装推送

**Files:**
- Modify: `src/extension.ts`
- Modify: `test/e2e-harness.js`
- Modify: `README.md`
- Modify: `docs/smoke-test.md`

- [ ] **Step 1: 激活时备份 v1 文件**

在 `activate` 里、`restartPolling()` 之前插入：

```ts
  // v1→v2 迁移前先备份一次用户数据。只在真的要迁移时备份，且不覆盖已有备份。
  void store.migrateAndBackup().then((did) => {
    if (did) {
      void vscode.window.showInformationMessage(
        '终端清单已升级到新格式，原文件已备份为 terminals.json.bak。',
      );
    }
  });
```

- [ ] **Step 2: e2e 加「非 claude 会话不被误判」的反向测试**

这是本项目最重要的一类测试 —— 守卫的反向验证。

```js
// ---- 安全守卫：非 claude 会话绝不被误判 ----
{
  const s = sessionNameFor('e2eguard001');
  await tmux.newSession(s, os.tmpdir());
  await tmux.sendLiteral(s, 'sleep 600');
  await tmux.sendEnter(s);
  await new Promise((r) => setTimeout(r, 800));

  const cmd = await tmux.currentCommand(s);
  assert.strictEqual(
    isClaudeCommand(cmd), false,
    `sleep 进程绝不能被判为 claude（实际 "${cmd}"）—— 否则 /exit 会毁掉用户的编译`,
  );

  await tmux.killSession(s);
}
```

顶部补 import：`const { isClaudeCommand } = require('../out/src/core/claude');`

- [ ] **Step 3: 跑 e2e**

Run: `npm run e2e`
Expected: 全部 section 通过

- [ ] **Step 4: 更新 README**

增补：profile 对照表（ccr/direct）、拖拽排序、批量面板用法、短路径消歧规则、以及**已知副作用**：运行中 `/model` 会改全局默认，扩展在「目标 = profile 默认」时改走重启以规避。

- [ ] **Step 5: 更新 `docs/smoke-test.md`**

增补手工验证项：
1. 拖拽后顺序持久，且 `tmux ls` 输出不变
2. 杀掉会话 → 面板关闭、UI 显示「无会话」、**再点一次是新建而非「又连上」**
3. 运行中的 claude 上切模型 → 状态栏 `🤖` 变化
4. 运行中的**非 claude**（如 `sleep 600`）上切模型 → 必须弹「已拒绝」错误
5. 批量面板选中 2 条 → 设为直连 → 徽标变橙

- [ ] **Step 6: 打包**

```bash
npm run compile && npm test && npm run e2e && npx vsce package
```

- [ ] **Step 7: 安装到远端**

```bash
rm -rf ~/.vscode-server-insiders/extensions/kryienaruto.vscode-tmux-terminals-0.1.0
~/.vscode-server-insiders/bin/*/remote-cli/code-insiders \
  --install-extension "$(ls -t vscode-tmux-terminals-*.vsix | head -1)" --force
ls -d ~/.vscode-server-insiders/extensions/kryienaruto.vscode-tmux-terminals-*
```

Expected: 目录存在

- [ ] **Step 8: 确认用户数据未丢（关键检查，别跳过）**

**不要只看文件内容** —— 清单只会在用户下次真实改动时才以 v2 落盘，此刻文件很可能仍是 v1。要验证的是「迁移后 `load()` 能读出全部条目」，所以直接跑编译产物对着**真实文件**读一次：

```bash
F=~/.vscode-server-insiders/data/User/globalStorage/kryienaruto.vscode-tmux-terminals/terminals.json
node -e "
const {EntryStore}=require('./out/src/core/store');
new EntryStore(process.argv[1]).load().then(all=>{
  const names=['统筹者','咨询','UI_Worker-01','UI_Worker-02','UI_Worker-03','Krita编译'];
  console.log('读出的条目数:', all.length);
  all.forEach(e=>console.log(' -', e.name, '|', e.profile, '| order', e.order, '|', e.cwd));
  const missing=names.filter(n=>!all.some(e=>e.name===n));
  console.log(missing.length===0 ? 'OK：6 条一条不丢' : '丢失: '+missing.join(','));
});
" "$F"
ls -la "$(dirname $F)/"
```

Expected:
- `读出的条目数: 6` 且 `OK：6 条一条不丢`
- 每条都有 `profile`（`claude-direct` 那条为 `direct`）与 `order`
- 同目录下存在 `terminals.json.bak`（内容含 `commands` 原文）

- [ ] **Step 9: 提交并推送**

```bash
git add -A
git commit -m "feat: v2 完成——排序、批量面板、profile/模型切换、杀会话修复

Co-Authored-By: Claude <noreply@anthropic.com>"
export GH_TOKEN=<由用户提供>
git -c credential.helper='!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f' push origin main
```

> **不要**用 `git config credential.helper store` —— 那会把 token 明文写进 `~/.git-credentials`。推送后用 `wc -l < ~/.git-credentials` 核对行数未增加。

---

## 完成标准

- [ ] `npm test` 全绿；四条变异测试都做过并记录（Task 1×2、Task 2、Task 3）
- [ ] `npm run e2e` 全绿，含「杀会话无残留客户端」与「非 claude 不被误判」两节
- [ ] 用户 6 条条目迁移后**一条不丢**，`terminals.json.bak` 存在
- [ ] 拖拽排序持久，且不触发任何 tmux 操作
- [ ] 运行中 claude 切模型 → 状态栏变化；运行中**非** claude 切模型 → 弹「已拒绝」
- [ ] 杀会话后面板关闭，再点条目是**新建**而非「又连上」
- [ ] 批量面板能选中多条并批量切直连/模型
- [ ] 已推送到 GitHub，已安装到远端 VS Code Insiders
