# 三级树重构（文件夹 → 终端 → 任务名）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把侧边栏「终端清单」从完全扁平的列表，改造成三级树（一级=文件夹路径、二级=终端名称、三级=任务名字），并去掉 v0.1.3 的任务名闪烁效果，改用转圈/绿点图标挂在任务名节点上。

**Architecture:** `EntryTreeProvider` 的 `TreeNode` 联合类型从 `EntryTreeItem | EmptyTreeItem` 扩成 `FolderTreeItem | EntryTreeItem | TaskTreeItem | EmptyTreeItem`；`getChildren` 按层级分支返回子节点；两个新的纯函数（`core/grouping.ts#groupByCwd`、`core/reorder.ts#reorderWithinGroup`）承担"按 cwd 分组"与"组内拖拽重排"的核心算法，可独立单测；`ActivityTracker` 删除不再需要的闪烁相位（`blinkOn`/`phaseOn`）。

**Tech Stack:** TypeScript（strict）、VS Code Extension API（`vscode.TreeDataProvider`/`TreeDragAndDropController`）、mocha（纯函数单测）、本仓库自制的 vscode-stub e2e harness（`test/e2e-harness.js`，通过 hijack `require('vscode')` 实现，不依赖真实 VS Code）。

**Spec:** `docs/superpowers/specs/2026-09-10-tree-hierarchy-design.md`

## Global Constraints

- 一级分组键：按 `cwd` **精确**匹配；cwd 不同（哪怕只差一层）就是不同文件夹；单条目也独立成组。
- 拖拽排序范围：只允许**同一文件夹（同 cwd）内**重新排序；跨文件夹拖拽整体是 no-op，不产生任何中间态。
- 三级（任务名）节点默认展开；没有任务名的条目**不生成**三级节点，二级节点相应地 `collapsibleState = None`。
- 转圈（`loading~spin`）/绿点图标**只**出现在三级（任务名）节点上；二级（终端名）节点的图标回归"存活/死亡 + profile 颜色"的普通图标，不再体现运行状态。
- 不改动 `TerminalEntry` 的持久化数据结构、不新增命令、不涉及 tmux/bash 模式切换（该点已被用户明确撤回，不在本次范围内）。
- `core/*.ts` 新文件必须保持零 vscode 依赖（纯函数，可脱离编辑器直接 mocha 单测），这是本仓库既有约定。

---

### Task 1: `core/grouping.ts` — 按 cwd 分组的纯函数

**Files:**
- Create: `src/core/grouping.ts`
- Test: `test/core/grouping.test.ts`

**Interfaces:**
- Consumes: `TerminalEntry`（`src/core/types.ts`，字段 `id/name/cwd/profile/model?/conversationId?/autoRestore/order`）
- Produces: `groupByCwd(entries: TerminalEntry[]): Array<[string, TerminalEntry[]]>` —— Task 3（`tree.ts`）的 `getChildren` 会直接调用这个函数。

- [ ] **Step 1: 写失败测试**

创建 `test/core/grouping.test.ts`：

```ts
import * as assert from 'assert';
import { groupByCwd } from '../../src/core/grouping';
import { TerminalEntry } from '../../src/core/types';

const mk = (id: string, cwd: string): TerminalEntry => ({
  id, name: id, cwd, profile: 'ccr', autoRestore: true, order: 0,
});

describe('groupByCwd', () => {
  it('cwd 相同的条目分到同一组，组内保持输入顺序', () => {
    const a1 = mk('a1', '/x');
    const a2 = mk('a2', '/x');
    const b1 = mk('b1', '/y');
    const groups = groupByCwd([a1, b1, a2]);
    assert.deepStrictEqual(groups, [
      ['/x', [a1, a2]],
      ['/y', [b1]],
    ]);
  });

  it('单个条目也独立成组', () => {
    const a = mk('a', '/x');
    assert.deepStrictEqual(groupByCwd([a]), [['/x', [a]]]);
  });

  it('空输入返回空数组', () => {
    assert.deepStrictEqual(groupByCwd([]), []);
  });

  it('组的先后顺序按各组第一次出现的位置，不额外排序', () => {
    const b1 = mk('b1', '/y');
    const a1 = mk('a1', '/x');
    const b2 = mk('b2', '/y');
    const groups = groupByCwd([b1, a1, b2]);
    assert.deepStrictEqual(groups.map(([cwd]) => cwd), ['/y', '/x']);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run compile && npx mocha out/test/core/grouping.test.js`
Expected: FAIL（`src/core/grouping.ts` 不存在，`tsc` 编译报错 "Cannot find module '../../src/core/grouping'"）

- [ ] **Step 3: 写最小实现**

创建 `src/core/grouping.ts`：

```ts
import { TerminalEntry } from './types';

/**
 * 按 cwd 精确分组，用于三级树的一级「文件夹」节点。
 *
 * 分组顺序 = 各组第一个条目在输入数组中的出现顺序（不额外排序）；
 * 组内顺序原样保留输入顺序（调用方已按 order 排好序，这里不重排）。
 */
export function groupByCwd(
  entries: TerminalEntry[],
): Array<[string, TerminalEntry[]]> {
  const order: string[] = [];
  const groups = new Map<string, TerminalEntry[]>();
  for (const e of entries) {
    let g = groups.get(e.cwd);
    if (g === undefined) {
      g = [];
      groups.set(e.cwd, g);
      order.push(e.cwd);
    }
    g.push(e);
  }
  return order.map((cwd) => [cwd, groups.get(cwd)!]);
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm run compile && npx mocha out/test/core/grouping.test.js`
Expected: PASS（4 项全绿）

- [ ] **Step 5: 提交**

```bash
git add src/core/grouping.ts test/core/grouping.test.ts
git commit -m "feat: 新增 groupByCwd 纯函数，用于三级树一级分组"
```

---

### Task 2: `core/reorder.ts` — 组内拖拽重排的纯函数

**Files:**
- Create: `src/core/reorder.ts`
- Test: `test/core/reorder.test.ts`

**Interfaces:**
- Consumes: 无（只操作 `string[]`，不依赖任何项目类型）
- Produces: `reorderWithinGroup(allIds: readonly string[], groupIds: readonly string[], draggedIds: readonly string[], targetId: string | undefined): string[]` —— Task 3（`tree.ts`）的 `handleDrop` 会直接调用这个函数。

- [ ] **Step 1: 写失败测试**

创建 `test/core/reorder.test.ts`：

```ts
import * as assert from 'assert';
import { reorderWithinGroup } from '../../src/core/reorder';

describe('reorderWithinGroup', () => {
  it('组内插到中间，组外 id 原样保留在原位置', () => {
    const all = ['x1', 'a', 'x2', 'b', 'c', 'x3'];
    const group = ['a', 'b', 'c'];
    const result = reorderWithinGroup(all, group, ['c'], 'a');
    assert.deepStrictEqual(result, ['x1', 'c', 'x2', 'a', 'b', 'x3']);
  });

  it('落到组尾（targetId undefined = 拖到空白处）', () => {
    const all = ['a', 'b', 'c'];
    const result = reorderWithinGroup(all, all, ['a'], undefined);
    assert.deepStrictEqual(result, ['b', 'c', 'a']);
  });

  it('拖拽多个 id，保持它们之间的相对顺序', () => {
    const all = ['a', 'b', 'c', 'd'];
    const result = reorderWithinGroup(all, all, ['a', 'c'], 'b');
    assert.deepStrictEqual(result, ['a', 'c', 'b', 'd']);
  });

  it('组外 id 的相对顺序绝不改变（哪怕组内重排剧烈）', () => {
    const all = ['x1', 'a', 'x2', 'b', 'x3'];
    const group = ['a', 'b'];
    const before = all.filter((id) => !group.includes(id));
    const result = reorderWithinGroup(all, group, ['b'], 'a');
    const after = result.filter((id) => !group.includes(id));
    assert.deepStrictEqual(after, before);
  });

  it('targetId 恰好是被拖拽 id 之一时退化为「插到组尾」（调用方应已提前拦截，这里只保证纯函数自身不崩溃）', () => {
    const all = ['a', 'b', 'c'];
    const result = reorderWithinGroup(all, all, ['a'], 'a');
    assert.deepStrictEqual(result, ['b', 'c', 'a']);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm run compile && npx mocha out/test/core/reorder.test.js`
Expected: FAIL（`src/core/reorder.ts` 不存在）

- [ ] **Step 3: 写最小实现**

创建 `src/core/reorder.ts`：

```ts
/**
 * 三级树的拖拽排序限定在「同一文件夹（同 cwd）」内。这个纯函数负责把
 * 组内的新顺序「回填」进全局顺序数组——组外 id 的相对顺序绝不改变。
 * 见 docs/superpowers/specs/2026-09-10-tree-hierarchy-design.md §5。
 *
 * allIds：当前全局顺序（= store.reorder 需要的完整数组）。
 * groupIds：属于目标文件夹的那些 id（allIds 的子序列，顺序取自 allIds）。
 * draggedIds：本次拖拽的 id（groupIds 的子集）。
 * targetId：落点 id（groupIds 内某个未被拖拽的 id），undefined = 落到组尾。
 */
export function reorderWithinGroup(
  allIds: readonly string[],
  groupIds: readonly string[],
  draggedIds: readonly string[],
  targetId: string | undefined,
): string[] {
  const remaining = groupIds.filter((id) => !draggedIds.includes(id));
  const at = targetId === undefined ? remaining.length : remaining.indexOf(targetId);
  const insertAt = at === -1 ? remaining.length : at;
  const newGroupOrder = [...remaining];
  newGroupOrder.splice(insertAt, 0, ...draggedIds);

  const queue = [...newGroupOrder];
  const groupSet = new Set(groupIds);
  return allIds.map((id) => (groupSet.has(id) ? queue.shift()! : id));
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm run compile && npx mocha out/test/core/reorder.test.js`
Expected: PASS（5 项全绿）

- [ ] **Step 5: 提交**

```bash
git add src/core/reorder.ts test/core/reorder.test.ts
git commit -m "feat: 新增 reorderWithinGroup 纯函数，用于组内拖拽重排"
```

---

### Task 3: 重写 `src/tree.ts` —— 三级树节点与 `getChildren`/拖拽

**Files:**
- Modify: `src/tree.ts`（整份替换，见下方完整内容）

**Interfaces:**
- Consumes: `groupByCwd`（Task 1）、`reorderWithinGroup`（Task 2）、`EntryActivity`（`src/core/activity.ts`，字段 `state: 'idle'|'running'|'done-unseen'`、`taskName: string`）、`sessionNameFor`（`src/core/tmux.ts`）、`commandFor`（`src/core/command.ts`）、`TerminalEntry`（`src/core/types.ts`）
- Produces：
  - `export class FolderTreeItem extends vscode.TreeItem` —— 字段 `cwd: string`、`entries: TerminalEntry[]`
  - `export class EntryTreeItem extends vscode.TreeItem` —— 构造签名变为 `(entry: TerminalEntry, alive: boolean, activity: EntryActivity | undefined)`（**去掉了原来的 `shortPath`、`blinkOn` 两个参数**——Task 5（`extension.ts`）与 Task 7（e2e harness）都要按新签名调用）
  - `export class TaskTreeItem extends vscode.TreeItem` —— 字段 `entry: TerminalEntry`、`activity: EntryActivity`
  - `export type TreeNode = FolderTreeItem | EntryTreeItem | TaskTreeItem | EmptyTreeItem`
  - `EntryTreeProvider` 构造函数第二个参数（`activity`）的结构类型去掉了 `blinkOn(entryId): boolean`，只剩 `activityFor(entryId): EntryActivity | undefined`

这是一份 UI 接线代码（依赖 `vscode` 模块），无法用纯 mocha 单测验证，正确性由 Task 7 的 e2e harness 场景与 Task 8 的整体编译验证。

- [ ] **Step 1: 用下面的完整内容整份替换 `src/tree.ts`**

```ts
import * as vscode from 'vscode';
import { commandFor } from './core/command';
import { EntryActivity } from './core/activity';
import { groupByCwd } from './core/grouping';
import { reorderWithinGroup } from './core/reorder';
import { sessionNameFor } from './core/tmux';
import { TerminalEntry } from './core/types';

/** profile 对应的徽标颜色。ccr=蓝（本地中转），direct=橙（官方直连）。 */
function profileColor(entry: TerminalEntry): vscode.ThemeColor {
  return new vscode.ThemeColor(
    entry.profile === 'direct' ? 'charts.orange' : 'charts.blue',
  );
}

/**
 * tooltip 里的「对话」一行。
 *
 * 显示短 id 而不是首条消息摘要：摘要要读一个可能几 MB 的会话文件，而
 * tooltip 是同步渲染的 —— 为了一个提示去同步读盘不值得。想认内容就用
 * 「选择要接回的对话…」命令，那里有摘要。
 */
function conversationLabel(entry: TerminalEntry): string {
  const id = entry.conversationId;
  if (id === undefined || id.length === 0) {
    return '（未绑定 —— 下次启动 claude 时会让你选一条）';
  }
  return `\`${id.slice(0, 8)}…\`（启动时接回这条）`;
}

/** activity 状态对应的中文描述，用于 tooltip。 */
function activityLabel(activity: EntryActivity | undefined): string {
  if (activity === undefined) return '（未知，尚未轮询到）';
  if (activity.state === 'running') return '🔵 运行中';
  if (activity.state === 'done-unseen') return '🟢 刚完成，等待查看';
  return '⚪ 空闲';
}

/**
 * 一级节点：按 cwd 精确分组的「文件夹」。
 *
 * `id` 用 cwd 派生（而不是数组下标），保证增删其他文件夹的条目时，
 * VS Code 记住的展开/折叠状态不会因为下标漂移而错位。
 */
export class FolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly cwd: string,
    public readonly entries: TerminalEntry[],
  ) {
    super(cwd, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `folder:${cwd}`;
    this.contextValue = 'folder';
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

/**
 * 二级节点：一个终端条目。
 *
 * 图标只体现「存活/死亡 + profile 颜色」，不再体现运行状态——运行状态的
 * 转圈/绿点图标现在挂在三级的 `TaskTreeItem` 上。有任务名时
 * `collapsibleState = Expanded`，可以展开看到那一级；没有任务名时
 * `None`，不产生一个空的可展开箭头。
 */
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
    this.id = entry.id;
    this.contextValue = alive ? 'aliveSession' : 'deadSession';
    this.description = alive ? undefined : '（无会话）';
    this.tooltip = new vscode.MarkdownString(
      [
        `**${entry.name}**`,
        '',
        `- 目录：\`${entry.cwd}\``,
        `- profile：${entry.profile === 'direct' ? '🟠 direct（官方直连）' : '🔵 ccr（本地中转）'}`,
        `- 模型：${entry.model && entry.model.length > 0 ? `\`${entry.model}\`` : '（profile 默认）'}`,
        `- 基础命令：\`${commandFor(entry)}\``,
        `- 对话：${conversationLabel(entry)}`,
        `- 状态：${alive ? '🟢 会话存活，点击接回原进程' : '⚪ 无会话，点击重建并接回该对话'}`,
        `- 任务：${taskName.length > 0 ? taskName : '（无）'} · ${activityLabel(activity)}`,
        `- 参与全部恢复：${entry.autoRestore ? '是' : '否'}`,
      ].join('\n'),
    );
    this.iconPath = alive
      ? new vscode.ThemeIcon('circle-filled', profileColor(entry))
      : new vscode.ThemeIcon('circle-outline', profileColor(entry));
    this.command = {
      command: 'tmuxTerminals.open',
      title: '打开终端',
      arguments: [this],
    };
  }
}

/**
 * 三级节点：任务名。只在 `activity.taskName` 非空时才会被创建
 * （由 `EntryTreeProvider.getChildren` 保证，见下）。
 *
 * 图标按活动状态三态：running → 原生转圈动画；done-unseen → 实心绿点
 * （直到用户点开该节点，见 ActivityTracker.markSeen）；idle → 实心
 * profile 色点（有任务名但当前空闲是正常状态，见 core/activity.ts 的
 * 说明——taskName 不随 state 变化而清空）。
 */
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
    this.command = {
      command: 'tmuxTerminals.open',
      title: '打开终端',
      arguments: [this],
    };
  }
}

/** 清单为空时显示的一行，点击即新建。 */
export class EmptyTreeItem extends vscode.TreeItem {
  constructor() {
    super('点击 + 添加一个终端条目', vscode.TreeItemCollapsibleState.None);
    this.command = { command: 'tmuxTerminals.add', title: '新建终端条目' };
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'empty';
  }
}

export type TreeNode = FolderTreeItem | EntryTreeItem | TaskTreeItem | EmptyTreeItem;

export class EntryTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode>
{
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private entries: TerminalEntry[] = [];
  private alive = new Set<string>();

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

  refresh(): void {
    this.emitter.fire();
  }

  /**
   * 传入的是一批 **tmux 会话名**（来自 `tmux ls`，形如 `tmuxterm-<id>`），
   * 不是条目显示名 —— 会话名由条目 id 派生，见 core/tmux.ts 的 sessionNameFor。
   */
  setAlive(names: Set<string>): void {
    const changed =
      names.size !== this.alive.size || [...names].some((n) => !this.alive.has(n));
    this.alive = names;
    if (changed) this.emitter.fire();
  }

  isAlive(session: string): boolean {
    return this.alive.has(session);
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element === undefined) {
      this.entries = await this.store.load();
      if (this.entries.length === 0) return [new EmptyTreeItem()];
      return groupByCwd(this.entries).map(
        ([cwd, group]) => new FolderTreeItem(cwd, group),
      );
    }
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
    return [];
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  // ---- 拖拽排序 ----
  // 拖拽是独立 API，不是 TreeItem 自带的能力。三级树引入后，拖拽范围收窄到
  // 「同一文件夹（同 cwd）内」——跨文件夹拖拽整体是 no-op，不产生任何
  // 中间态；见 docs/superpowers/specs/2026-09-10-tree-hierarchy-design.md §5。
  readonly dragMimeTypes = ['application/vnd.code.tree.tmuxterminals.list'];
  readonly dropMimeTypes = ['application/vnd.code.tree.tmuxterminals.list'];

  async handleDrag(
    source: readonly TreeNode[],
    data: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const items = source.filter((n): n is EntryTreeItem => n instanceof EntryTreeItem);
    if (items.length === 0) return;
    const cwd = items[0].entry.cwd;
    // 多选跨文件夹：整体不产生 drag data，而不是只取同 cwd 的子集——
    // 后者会让用户以为「拖了 3 个，其实只挪了 1 个」，比完全不动更容易踩坑。
    if (!items.every((n) => n.entry.cwd === cwd)) return;
    data.set(this.dragMimeTypes[0], new vscode.DataTransferItem(items.map((n) => n.entry.id)));
  }

  /**
   * 落点语义：拖到目标行 = **插到该行之前**（沿用重构前的约定）。
   *
   * 落点必须与拖拽源同属一个 cwd，否则整体 no-op：落在别的文件夹的条目
   * 或文件夹节点本身上 → 不动；落在空白处（`target === undefined`）→
   * 按「落到自己文件夹末尾」处理。
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
    const draggedCwd = all.find((e) => e.id === draggedIds[0])?.cwd;
    if (draggedCwd === undefined) return;

    const targetCwd =
      target instanceof EntryTreeItem
        ? target.entry.cwd
        : target instanceof FolderTreeItem
          ? target.cwd
          : undefined;
    if (targetCwd !== undefined && targetCwd !== draggedCwd) return;

    // 拖到自身（或所选集合内任一条）上是 no-op，逻辑与重构前一致。
    const targetId = target instanceof EntryTreeItem ? target.entry.id : undefined;
    if (targetId !== undefined && draggedIds.includes(targetId)) return;

    const allIds = all.map((e) => e.id);
    const groupIds = all.filter((e) => e.cwd === draggedCwd).map((e) => e.id);
    const newIds = reorderWithinGroup(allIds, groupIds, draggedIds, targetId);

    await this.store.reorder(newIds); // 内部经 enqueue 串行化，防并发丢更新
    this.emitter.fire();
  }
}
```

- [ ] **Step 2: 编译，确认没有类型错误**

Run: `npm run compile`
Expected: 退出码 0。核实过：`extension.ts` 从不直接 `new EntryTreeItem(...)`（只在 `item()` 里用 `arg instanceof EntryTreeItem` 做类型收窄，与构造签名无关），`EntryTreeProvider` 的 `activity?` 参数是结构类型，`ActivityTracker` 实例此刻仍多出一个 `blinkOn` 方法也不影响结构匹配（多余方法不违反结构类型）。因此这一步应该是**干净通过、零错误**，不需要等 Task 4/5 才能编译通过；如果看到报错，说明改动有遗漏，需要先查清楚再继续，而不是当成"预期之内"跳过。

- [ ] **Step 3: 提交**

```bash
git add src/tree.ts
git commit -m "feat: tree.ts 改造成三级树（文件夹/终端/任务名），去掉闪烁徽章"
```

---

### Task 4: 精简 `ActivityTracker` —— 删除 `blinkOn`/`phaseOn`

**Files:**
- Modify: `src/activityTracker.ts`
- Modify: `test/activityTracker.test.ts`

**Interfaces:**
- Consumes: 无变化（`PaneTitleReader`、`core/activity.ts` 的 `nextActivity`/`markSeen` 不变）
- Produces: `ActivityTracker` 类不再有 `blinkOn(entryId): boolean` 方法；`activityFor`/`markSeen`/`poll`/`onDidChange` 签名不变。

- [ ] **Step 1: 用下面的完整内容整份替换 `src/activityTracker.ts`**

```ts
import { isRunningTitle, sessionNameFor, taskNameFromTitle } from './core/tmux';
import { EntryActivity, markSeen, nextActivity } from './core/activity';

/** ActivityTracker 需要的最小 tmux 能力——按条目 id 派生出的 session 名读 pane title。 */
export interface PaneTitleReader {
  paneTitle(session: string): Promise<string>;
}

/**
 * 轮询一批「存活条目」的 tmux pane title，推进每个条目的活动状态机
 * （见 core/activity.ts）。
 *
 * 刻意不依赖 vscode：只依赖一个「读 pane title」的最小接口（结构类型，
 * TmuxClient 天然满足），方便直接用 mocha 单测。
 */
export class ActivityTracker {
  private listeners: Array<() => void> = [];
  private state = new Map<string, EntryActivity>();

  constructor(private readonly tmux: PaneTitleReader) {}

  /** 注册变化监听；返回的对象用于取消订阅。 */
  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  }

  private fire(): void {
    for (const l of this.listeners) l();
  }

  activityFor(entryId: string): EntryActivity | undefined {
    return this.state.get(entryId);
  }

  /** 用户点开条目查看：done-unseen → idle。状态确实变了才触发一次通知。 */
  markSeen(entryId: string): void {
    const cur = this.state.get(entryId);
    if (cur === undefined) return;
    const next = markSeen(cur);
    if (next !== cur) {
      this.state.set(entryId, next);
      this.fire();
    }
  }

  /**
   * 轮询一批存活条目的 id（是否存活由调用方判定，这里不重复判断，
   * 只管在给定的这批 id 上读 pane title）。
   *
   * 已死亡（不在 aliveEntryIds 里）的条目直接从状态表里删掉——下次它
   * 再出现按「首次观测」处理，不会凭空冒出一次「刚运行完」
   * （见 core/activity.ts 顶部注释里的不变量）。
   *
   * 无论有没有存活条目，每次调用结束都触发一次变化通知，让订阅方
   * （UI 刷新）能看到状态表里的最新结果。
   */
  async poll(aliveEntryIds: readonly string[]): Promise<void> {
    const aliveSet = new Set(aliveEntryIds);
    for (const id of [...this.state.keys()]) {
      if (!aliveSet.has(id)) this.state.delete(id);
    }

    if (aliveEntryIds.length > 0) {
      const titles = await Promise.all(
        aliveEntryIds.map((id) => this.tmux.paneTitle(sessionNameFor(id))),
      );
      aliveEntryIds.forEach((id, i) => {
        const title = titles[i];
        const sample = { running: isRunningTitle(title), taskName: taskNameFromTitle(title) };
        this.state.set(id, nextActivity(this.state.get(id), sample));
      });
    }

    this.fire();
  }
}
```

- [ ] **Step 2: 从 `test/activityTracker.test.ts` 删除 `describe('ActivityTracker.blinkOn', ...)` 整块**

该文件现状第 71-93 行是：

```ts
describe('ActivityTracker.blinkOn', () => {
  it('running 态随每次 poll 在 true/false 之间切换', async () => {
    const tmux = fakeTmux({ 'tmuxterm-a': '⠐ 任务' });
    const tracker = new ActivityTracker(tmux);
    await tracker.poll(['a']);
    const first = tracker.blinkOn('a');
    await tracker.poll(['a']);
    const second = tracker.blinkOn('a');
    assert.notStrictEqual(first, second);
  });
  it('非 running 态恒为 true（不闪）', async () => {
    const tmux = fakeTmux({ 'tmuxterm-a': '✳ Claude Code' });
    const tracker = new ActivityTracker(tmux);
    await tracker.poll(['a']);
    assert.strictEqual(tracker.blinkOn('a'), true);
    await tracker.poll(['a']);
    assert.strictEqual(tracker.blinkOn('a'), true);
  });
  it('未知条目恒为 true', () => {
    const tracker = new ActivityTracker(fakeTmux({}));
    assert.strictEqual(tracker.blinkOn('unknown'), true);
  });
});
```

把这 23 行（含前后各一个空行中的一个，保持文件其余部分的空行风格）整块删除，`describe('ActivityTracker.poll', ...)` 与 `describe('ActivityTracker.markSeen', ...)` 两块原样保留、不改动。

- [ ] **Step 3: 编译并跑测试，确认通过**

Run: `npm run compile && npx mocha out/test/activityTracker.test.js`
Expected: PASS（原 12 项减去被删的 3 项，剩 9 项全绿；且不再有 `blinkOn` 相关的类型错误）

- [ ] **Step 4: 提交**

```bash
git add src/activityTracker.ts test/activityTracker.test.ts
git commit -m "refactor: 删除 ActivityTracker 的 blinkOn/phaseOn，闪烁效果已在 UI 层去掉"
```

---

### Task 5: `extension.ts` —— 放宽 `tmuxTerminals.open` 的类型守卫

**Files:**
- Modify: `src/extension.ts:5` （import 语句）
- Modify: `src/extension.ts:143-144` （`item` 辅助函数）

**Interfaces:**
- Consumes: `EntryTreeItem`/`TaskTreeItem`（Task 3 产出，均暴露 `entry: TerminalEntry` 字段）
- Produces: 无新增导出；`tmuxTerminals.open` 命令处理函数现在能正确响应点击 `TaskTreeItem` 产生的调用。

背景：`TaskTreeItem` 的 `this.command` 也指向 `tmuxTerminals.open`（见 Task 3），但现有的 `item()` 辅助函数只认 `EntryTreeItem`，点击任务名那一行会被静默拒绝、完全没反应。

- [ ] **Step 1: 修改 import**

把 `src/extension.ts:5`：

```ts
import { EntryTreeItem, EntryTreeProvider } from './tree';
```

改成：

```ts
import { EntryTreeItem, EntryTreeProvider, TaskTreeItem } from './tree';
```

- [ ] **Step 2: 放宽 `item()` 辅助函数**

把 `src/extension.ts:143-144`：

```ts
  const item = (arg: unknown): EntryTreeItem | undefined =>
    arg instanceof EntryTreeItem ? arg : undefined;
```

改成：

```ts
  const item = (arg: unknown): EntryTreeItem | TaskTreeItem | undefined =>
    arg instanceof EntryTreeItem || arg instanceof TaskTreeItem ? arg : undefined;
```

`item()` 的所有调用点（`tmuxTerminals.open`/`edit`/`duplicate`/`delete`/`killSession`/`toggleAutoRestore`/`bindConversation`/`setModel`/`setProfile`）都只读 `it.entry`，`EntryTreeItem`/`TaskTreeItem` 都有这个字段，签名放宽后不需要改动任何调用点。这些命令除 `open` 外实际只会收到 `EntryTreeItem`（因为 Task 6 会把它们的右键菜单收紧到只在 `aliveSession`/`deadSession` 上出现），放宽 `item()` 本身对它们无副作用。

- [ ] **Step 3: 编译，确认通过**

Run: `npm run compile`
Expected: 退出码 0，无类型错误。

- [ ] **Step 4: 提交**

```bash
git add src/extension.ts
git commit -m "fix: tmuxTerminals.open 的类型守卫放宽到接受 TaskTreeItem"
```

---

### Task 6: `package.json` —— 收紧右键菜单 `when` 条件、版本号 +1

**Files:**
- Modify: `package.json`

**Interfaces:** 无（纯配置文件，不涉及 TS 类型）

- [ ] **Step 1: 收紧 `view/item/context`**

把现有的：

```json
      "view/item/context": [
        {
          "command": "tmuxTerminals.open",
          "when": "view == tmuxTerminals.list",
          "group": "inline@1"
        },
        {
          "command": "tmuxTerminals.killSession",
          "when": "view == tmuxTerminals.list && viewItem == aliveSession",
          "group": "1_kill@1"
        },
        {
          "command": "tmuxTerminals.setModel",
          "when": "view == tmuxTerminals.list",
          "group": "2_edit@0"
        },
        {
          "command": "tmuxTerminals.setProfile",
          "when": "view == tmuxTerminals.list",
          "group": "2_edit@1"
        },
        {
          "command": "tmuxTerminals.edit",
          "when": "view == tmuxTerminals.list",
          "group": "2_edit@1"
        },
        {
          "command": "tmuxTerminals.duplicate",
          "when": "view == tmuxTerminals.list",
          "group": "2_edit@2"
        },
        {
          "command": "tmuxTerminals.toggleAutoRestore",
          "when": "view == tmuxTerminals.list",
          "group": "2_edit@3"
        },
        {
          "command": "tmuxTerminals.bindConversation",
          "when": "view == tmuxTerminals.list",
          "group": "2_edit@4"
        },
        {
          "command": "tmuxTerminals.delete",
          "when": "view == tmuxTerminals.list",
          "group": "3_danger@1"
        }
      ],
```

改成：

```json
      "view/item/context": [
        {
          "command": "tmuxTerminals.open",
          "when": "view == tmuxTerminals.list && viewItem != folder",
          "group": "inline@1"
        },
        {
          "command": "tmuxTerminals.killSession",
          "when": "view == tmuxTerminals.list && viewItem == aliveSession",
          "group": "1_kill@1"
        },
        {
          "command": "tmuxTerminals.setModel",
          "when": "view == tmuxTerminals.list && (viewItem == aliveSession || viewItem == deadSession)",
          "group": "2_edit@0"
        },
        {
          "command": "tmuxTerminals.setProfile",
          "when": "view == tmuxTerminals.list && (viewItem == aliveSession || viewItem == deadSession)",
          "group": "2_edit@1"
        },
        {
          "command": "tmuxTerminals.edit",
          "when": "view == tmuxTerminals.list && (viewItem == aliveSession || viewItem == deadSession)",
          "group": "2_edit@1"
        },
        {
          "command": "tmuxTerminals.duplicate",
          "when": "view == tmuxTerminals.list && (viewItem == aliveSession || viewItem == deadSession)",
          "group": "2_edit@2"
        },
        {
          "command": "tmuxTerminals.toggleAutoRestore",
          "when": "view == tmuxTerminals.list && (viewItem == aliveSession || viewItem == deadSession)",
          "group": "2_edit@3"
        },
        {
          "command": "tmuxTerminals.bindConversation",
          "when": "view == tmuxTerminals.list && (viewItem == aliveSession || viewItem == deadSession)",
          "group": "2_edit@4"
        },
        {
          "command": "tmuxTerminals.delete",
          "when": "view == tmuxTerminals.list && (viewItem == aliveSession || viewItem == deadSession)",
          "group": "3_danger@1"
        }
      ],
```

- [ ] **Step 2: 版本号 +1**

把 `package.json:5` 的 `"version": "0.1.3"` 改成 `"version": "0.1.4"`。

- [ ] **Step 3: 校验 JSON 合法**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"`
Expected: 无输出、退出码 0（JSON.parse 不抛异常）

- [ ] **Step 4: 提交**

```bash
git add package.json
git commit -m "chore: 收紧右键菜单 when 条件以适配三级树，发布 0.1.4"
```

---

### Task 7: e2e harness —— 三级 `getChildren` 与拖拽范围收窄的场景

**Files:**
- Modify: `test/e2e-harness.js:49-76`（`vscodeStub` 定义处，新增 `DataTransfer`/`DataTransferItem`）
- Modify: `test/e2e-harness.js`（在第 17 节与第 15 节清理节之间插入新的第 18 节，即现有第 1079 行 `}` 之后、第 1081 行 `console.log('\n=== 15. ...')` 之前）

**Interfaces:**
- Consumes: `EntryTreeProvider`/`FolderTreeItem`/`EntryTreeItem`/`TaskTreeItem`（Task 3 产出，编译后位于 `out/src/tree.js`）
- Produces: 无新增导出，纯新增测试场景。

背景（重要）：这个 harness 目前**完全没有**测试过 `tree.ts` 的任何逻辑（已核实：文件里不存在 `getChildren`/`handleDrag`/`handleDrop`/`EntryTreeProvider`/`DataTransfer` 等字样）。但 harness 顶部已经把 `require('vscode')` 全局劫持到 `vscodeStub`（见 `test/e2e-harness.js:124-129`），所以后面任何 `require(path.join(ROOT, 'out/src/tree.js'))` 都会自动拿到同一份 stub，不需要另起一个 harness 文件。

- [ ] **Step 1: 在 `vscodeStub` 里补上 `DataTransfer`/`DataTransferItem`**

现状 `test/e2e-harness.js:49-56`：

```js
class TreeItem {
  constructor(label) { this.label = label; }
}
class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (cb) => { this.listeners.push(cb); return { dispose() {} }; };
  }
  fire(e) { for (const cb of [...this.listeners]) cb(e); }
  dispose() { this.listeners.length = 0; }
}
```

在这段之后（`class ThemeIcon { ... }` 之前或之后均可，紧跟着加）插入两个新的最小 stub 类：

```js
class DataTransferItem {
  constructor(value) { this.value = value; }
}
class DataTransfer {
  constructor() { this.map = new Map(); }
  set(mime, item) { this.map.set(mime, item); }
  get(mime) { return this.map.get(mime); }
}
```

然后在下面 `const vscodeStub = { TreeItem, TreeItemCollapsibleState: {...}, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,` 这一行的字段列表里加上 `DataTransfer, DataTransferItem,`。

- [ ] **Step 2: 在第 17 节之后、第 15 节（清理）之前插入新的第 18 节**

定位现状 `test/e2e-harness.js:1079-1081`：

```js
    chk('提示了「刚被其他窗口创建」',
      calls.messages.some((m) => String(m).includes('其他窗口')), JSON.stringify(calls.messages));
  }

  console.log('\n=== 15. 清理 + 用户环境未被触碰 ===');
```

在第 1079 行的 `}` 之后、第 1081 行 `console.log('\n=== 15. ...')` 之前插入：

```js

  console.log('\n=== 18. 三级树：getChildren 分层与拖拽范围收窄到同文件夹 ===');
  {
    const { EntryTreeProvider, FolderTreeItem, EntryTreeItem, TaskTreeItem } =
      require(path.join(ROOT, 'out/src/tree.js'));

    // 独立的一套假 store/activity，不复用外层那个巨大的 TerminalManager
    // 用例夹具——那份数据是为别的场景准备的，cwd 分布对本节没有意义。
    const treeStore = {
      entries: [
        mk('t-a1', 'A1', '/proj/a'),
        mk('t-a2', 'A2', '/proj/a'),
        mk('t-b1', 'B1', '/proj/b'),
      ],
      async load() { return this.entries.map((e) => ({ ...e })); },
      reorderCalls: [],
      async reorder(ids) { this.reorderCalls.push(ids); },
    };
    const activityByEntry = {
      't-a1': { state: 'running', taskName: '编译' },
      // t-a2、t-b1 没有 activity（undefined）——不应该生出三级节点
    };
    const treeActivity = {
      activityFor(id) { return activityByEntry[id]; },
    };
    const provider = new EntryTreeProvider(treeStore, treeActivity);

    // ---- 一级：按 cwd 分两个文件夹 ----
    const folders = await provider.getChildren(undefined);
    chk('一级节点数 = 2（按 cwd 精确分组）', folders.length === 2,
      JSON.stringify(folders.map((f) => f.cwd)));
    const folderA = folders.find((f) => f.cwd === '/proj/a');
    const folderB = folders.find((f) => f.cwd === '/proj/b');
    chk('文件夹 A 下有 2 条', !!folderA && folderA.entries.length === 2);
    chk('文件夹 B 下有 1 条', !!folderB && folderB.entries.length === 1);

    // ---- 二级：展开文件夹 A 拿到条目 ----
    const entriesInA = await provider.getChildren(folderA);
    chk('二级节点都是 EntryTreeItem', entriesInA.every((n) => n instanceof EntryTreeItem));
    const a1Node = entriesInA.find((n) => n.entry.id === 't-a1');
    const a2Node = entriesInA.find((n) => n.entry.id === 't-a2');
    chk('有任务名的条目 collapsibleState = Expanded (2)', a1Node.collapsibleState === 2,
      String(a1Node.collapsibleState));
    chk('没有任务名的条目 collapsibleState = None (0)', a2Node.collapsibleState === 0,
      String(a2Node.collapsibleState));

    // ---- 三级：只有 a1 应该展开出任务名节点 ----
    const a1Children = await provider.getChildren(a1Node);
    chk('有任务名的条目展开出 1 个 TaskTreeItem', a1Children.length === 1 &&
      a1Children[0] instanceof TaskTreeItem);
    chk('TaskTreeItem 标签就是 taskName', a1Children[0].label === '编译');
    const a2Children = await provider.getChildren(a2Node);
    chk('★ 没有任务名的条目绝不生成三级节点', a2Children.length === 0,
      JSON.stringify(a2Children));

    // ---- 拖拽：同文件夹内允许，跨文件夹整体 no-op ----
    const dragSame = new DataTransfer();
    await provider.handleDrag([a2Node], dragSame);
    await provider.handleDrop(a1Node, dragSame);
    chk('同文件夹内拖拽：store.reorder 被调用了一次',
      treeStore.reorderCalls.length === 1, JSON.stringify(treeStore.reorderCalls));
    chk('同文件夹内拖拽：a2 被插到了 a1 前面',
      treeStore.reorderCalls[0].indexOf('t-a2') < treeStore.reorderCalls[0].indexOf('t-a1'),
      JSON.stringify(treeStore.reorderCalls[0]));
    chk('组外 id（t-b1）相对顺序未变',
      treeStore.reorderCalls[0].indexOf('t-b1') === 2, JSON.stringify(treeStore.reorderCalls[0]));

    treeStore.reorderCalls.length = 0;
    const entriesInB = await provider.getChildren(folderB);
    const b1Node = entriesInB[0];
    const dragCross = new DataTransfer();
    await provider.handleDrag([a1Node], dragCross);
    await provider.handleDrop(b1Node, dragCross); // 跨文件夹：a1(/proj/a) 拖到 b1(/proj/b) 上
    chk('★ 跨文件夹拖拽是纯 no-op：store.reorder 完全没被调用',
      treeStore.reorderCalls.length === 0, JSON.stringify(treeStore.reorderCalls));

    // 拖到文件夹节点本身（而不是某个条目）：同文件夹允许
    treeStore.reorderCalls.length = 0;
    const dragToFolder = new DataTransfer();
    await provider.handleDrag([a2Node], dragToFolder);
    await provider.handleDrop(folderA, dragToFolder);
    chk('拖到同文件夹的文件夹节点本身：允许（落到该文件夹末尾）',
      treeStore.reorderCalls.length === 1, JSON.stringify(treeStore.reorderCalls));
  }
```

注意：这一节用到的 `mk(...)` 辅助函数与外层第 368 行定义的 `const mk = (id, name, cwd, extra) => ({ id, name, cwd, profile: 'ccr', autoRestore: true, order: 0, ...extra })` 是同一个（该文件是一整个大 IIFE，块级作用域下 `mk` 在这里可以直接引用，不需要重新定义）。`path`、`ROOT`、`chk` 同理直接复用文件顶部已有的声明。

- [ ] **Step 3: 编译并运行 e2e harness，确认新场景全绿**

Run: `npm run compile && node test/e2e-harness.js`
Expected: 末尾打印 `端到端全部通过 ✓`，且看到第 18 节的所有 `✓` 行（若某一行是 `✗`，先检查是不是 Task 3 的 `handleDrop`/`getChildren` 实现细节没对上本节假设，而不是改测试去迁就实现）。

- [ ] **Step 4: 提交**

```bash
git add test/e2e-harness.js
git commit -m "test: e2e 覆盖三级树 getChildren 分层与拖拽范围收窄到同文件夹"
```

---

### Task 8: 整体验证与收尾

**Files:** 无新增/修改（纯验证）

- [ ] **Step 1: 全量编译**

Run: `rm -rf out && npm run compile`
Expected: 退出码 0

- [ ] **Step 2: 全量 mocha 单测**

Run: `npm test`
Expected: 全部 PASS（相对 Task 4 之前的基线，净变化 = +4(grouping) +5(reorder) -3(blinkOn) 项）

- [ ] **Step 3: 严格类型检查（不产生输出文件，仅检查）**

Run: `npx tsc -p ./ --noEmit`
Expected: 退出码 0，无输出

- [ ] **Step 4: e2e harness 全量跑一遍**

Run: `node test/e2e-harness.js`
Expected: 末尾 `端到端全部通过 ✓`

- [ ] **Step 5: 手工确认没有遗留的旧调用点**

Run: `grep -rn "blinkOn\|shortLabels" src/ | grep -v "core/labels.ts\|batchTree.ts"`
Expected: 无输出（`shortLabels` 只应在 `core/labels.ts`（定义处）和 `batchTree.ts`（唯一剩余调用方）里出现；`blinkOn` 不应在任何 `src/` 文件里出现）

- [ ] **Step 6: 补一条「实施后修订」占位说明（若实施中出现与设计不符之处）**

如果 Task 1-7 的实施过程中发现任何与 `docs/superpowers/specs/2026-09-10-tree-hierarchy-design.md` 不符的细节（例如某个不变量在真实 VS Code 行为下不成立），在该文档的 `## 11. 实施后修订` 一节按既有格式（症状/根因/修法/验证）补一条记录并提交；若一切与设计吻合，跳过本步骤。

- [ ] **Step 7: 最终提交（若前面步骤有遗留未提交的收尾改动）**

```bash
git status --short
# 若为空，本任务无需提交；若有残留改动（如 Step 6 的 spec 修订），单独提交：
git add docs/superpowers/specs/2026-09-10-tree-hierarchy-design.md
git commit -m "docs: 实施后修订记录"
```
