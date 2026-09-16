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
 * 显示短 id 而不是首条用户消息：要拿到它得读会话文件（哪怕只读头部窗口），
 * 而 tooltip 是同步渲染的 —— 为了一个提示去同步读盘不值得。想认内容就用
 * 「选择要接回的对话…」命令，那里显示首条用户消息的原文。
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
 * 三级节点：任务名。只在 `taskName` 非空时才会被创建
 * （由 `EntryTreeProvider.getChildren` 保证，见下）。
 *
 * **判据是 `taskName`，不是 `activity.taskName`。** 名字有两个来源：本次
 * 采样的 pane title，以及没有采样时从绑定对话的 aiTitle 回退来的名字。回退
 * 来的名字**没有**对应的本次采样状态，所以 `activity` 可以是 undefined ——
 * 这正是构造参数类型写成 `EntryActivity | undefined` 的原因。拿 activity
 * 判空，会让「有回退名字但这次没被采样」的条目凭空少一级。
 *
 * 图标按活动状态**四输入三出口**：running → 原生转圈动画；done-unseen →
 * 实心绿点（直到用户点开该节点，见 ActivityTracker.markSeen）；idle **与
 * activity 为 undefined**（回退名字 / 该条目这次没被采样）→ 实心 profile
 * 色点 —— 后两者一并落进 idle 分支，不新增状态（有任务名但当前空闲是正常
 * 状态，见 core/activity.ts 的说明——taskName 不随 state 变化而清空）。
 */
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

  /** 标题缓存的变化订阅句柄（titleFallback 没给订阅入口时为 undefined），见 dispose()。 */
  private titleSubscription: { dispose(): void } | undefined;

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
     *
     * 除 `peek` 外还有一个**可选**的订阅入口：缓存后台真的写入一条新标题时
     * 会通知一次，provider 据此重刷整棵树 —— 标题是异步落地的，而这里是同步
     * peek，两者之间没有它就没有任何交集：读到了名字树也不会重算，二级的
     * `collapsibleState` 停在 `None`，第三级永远不出现。
     * 声明成可选成员：没有订阅能力的实现（比如单测里的假 cache）照常可用。
     */
    private readonly titleFallback?: {
      peek(conversationId: string | undefined): string | undefined;
      onDidChangeTitle?(listener: () => void): { dispose(): void };
    },
  ) {
    // 订阅只能在构造函数体里做：字段初始化器跑在参数属性赋值**之前**，
    // 那时 this.titleFallback 还是 undefined。
    this.titleSubscription = this.titleFallback?.onDidChangeTitle?.(() =>
      this.emitter.fire(),
    );
  }

  /**
   * 解除标题缓存的订阅。
   *
   * **为什么不会泄漏**：provider 与 cache 都是 `activate()` 里建的扩展生命期
   * 单例，谁都不会比谁先死，所以即使不解除也不会留下「已死对象的引用」。
   * 提供 dispose 是为了把「谁订阅谁负责解除」写清楚，并让 provider 能进
   * `context.subscriptions`（TreeDataProvider 接口本身没有 dispose，
   * 框架不替我们调）。
   */
  dispose(): void {
    this.titleSubscription?.dispose();
    this.titleSubscription = undefined;
  }

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

  /**
   * 显示用的任务名：pane title（live，权威）→ 绑定对话的 aiTitle（回退）
   * → ''（不显示第三级）。
   *
   * **全都无从得知时返回空串** —— 不加灰色占位、不退化成
   * `~/.claude/sessions` 的 derived slug、不用首条用户消息：把「不知道」
   * 伪装成「知道」是误导（spec §8 不变量 6）。
   *
   * 纯读：`peek` 同步、不发 IO、不触发观测（观测统一由 extension.ts 驱动）。
   * 缓存**后来**才写入一条标题时，构造函数里那个订阅会 fire 一次 ——
   * `getChildren` 重跑、本方法被重新求值，二级的 collapsibleState 随之从
   * `None` 变成 `Expanded`，第三级自动出现。
   */
  private taskNameFor(entry: TerminalEntry): string {
    const fromPane = this.activity?.activityFor(entry.id)?.taskName ?? '';
    return fromPane.length > 0
      ? fromPane
      : this.titleFallback?.peek(entry.conversationId) ?? '';
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
