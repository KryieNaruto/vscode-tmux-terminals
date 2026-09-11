import * as vscode from 'vscode';
import { commandFor } from './core/command';
import { EntryActivity } from './core/activity';
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
 * 清单里的一行。
 *
 * `contextValue` 决定右键菜单显隐：`killSession` 只在存活时出现，
 * 见 package.json 里 `viewItem == aliveSession` 的 when 条件。
 *
 * 存活与否用**图标形状**表示，profile 用**颜色**表示 —— 两个维度互不覆盖。
 * 运行状态（activity）在此基础上**临时覆盖**图标：运行中换成原生转圈动画
 * （`loading~spin`，颜色仍用 profile 色，不丢失 profile 信息）；刚运行完
 * 且未查看时图标变实心绿点，直到用户点开该条目（ActivityTracker.markSeen）
 * 才恢复成 profile 色。
 *
 * 任务名徽章：activity.taskName 非空时拼在名称后面，用
 * `TreeItemLabel.highlights` 渲染成一个带背景色的小块（VS Code 没有开放
 * 任意自定义背景色的徽章控件，高亮色由主题决定，这是能拿到的最接近效果）。
 * blinkOn 为 false 时不给 highlights 区间，靠外部轮询在 true/false 间来回
 * 切换制造闪烁——只有 running 态才会被这样驱动，其余状态 blinkOn 恒为
 * true（徽章常驻显示，不闪）。
 */
export class EntryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: TerminalEntry,
    public readonly alive: boolean,
    /** 由 shortLabels() 算好的短路径，冲突时带父目录 */
    public readonly shortPath: string,
    /** 由 ActivityTracker 轮询得来的当前活动状态；未轮询到时为 undefined */
    public readonly activity: EntryActivity | undefined,
    /** 徽章此刻该不该显示为「亮」的一相；只有 running 态下才会真的来回切换 */
    blinkOn: boolean,
  ) {
    const taskName = activity?.taskName ?? '';
    const label: string | vscode.TreeItemLabel = taskName.length > 0
      ? {
          label: `${entry.name}  ${taskName}`,
          highlights: blinkOn
            ? [[entry.name.length + 2, entry.name.length + 2 + taskName.length]]
            : [],
        }
      : entry.name;
    super(label, vscode.TreeItemCollapsibleState.None);
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
        `- 基础命令：\`${commandFor(entry)}\``,
        `- 对话：${conversationLabel(entry)}`,
        `- 状态：${alive ? '🟢 会话存活，点击接回原进程' : '⚪ 无会话，点击重建并接回该对话'}`,
        `- 任务：${taskName.length > 0 ? taskName : '（无）'} · ${activityLabel(activity)}`,
        `- 参与全部恢复：${entry.autoRestore ? '是' : '否'}`,
      ].join('\n'),
    );
    this.iconPath = !alive
      ? new vscode.ThemeIcon('circle-outline', profileColor(entry))
      : activity?.state === 'running'
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

export type TreeNode = EntryTreeItem | EmptyTreeItem;

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
     * activity 都是 undefined（不挂徽章，图标退回默认逻辑），不影响
     * 既有调用方（比如批量面板用的是另一个 Provider，不受影响）。
     */
    private readonly activity?: {
      activityFor(entryId: string): EntryActivity | undefined;
      blinkOn(entryId: string): boolean;
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
    if (element) return [];
    this.entries = await this.store.load();
    if (this.entries.length === 0) return [new EmptyTreeItem()];
    const labels = shortLabels(this.entries.map((e) => e.cwd));
    return this.entries.map(
      (e, i) => new EntryTreeItem(
        e,
        this.alive.has(sessionNameFor(e.id)),
        labels[i],
        this.activity?.activityFor(e.id),
        this.activity?.blinkOn(e.id) ?? true,
      ),
    );
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

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
    data.set(this.dragMimeTypes[0], new vscode.DataTransferItem(ids));
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

    // 拖到自身（或所选集合内任一条）上是 no-op。被拖的 id 会先从 ids 里
    // 滤掉，于是 indexOf 目标返回 -1，若不拦就会落到「追加到末尾」——
    // 把条目无端挪到队尾（模拟：[a,b,c,d] 把 a 拖到 a 会变成 [b,c,d,a]）。
    const targetId = target instanceof EntryTreeItem ? target.entry.id : undefined;
    if (targetId !== undefined && draggedIds.includes(targetId)) return;

    const all = await this.store.load();
    const ids = all.map((e) => e.id).filter((id) => !draggedIds.includes(id));

    // 目标未定义 = 拖到空白处 → 追加到末尾
    const at = targetId === undefined ? ids.length : ids.indexOf(targetId);
    const insertAt = at === -1 ? ids.length : at;

    ids.splice(insertAt, 0, ...draggedIds);
    await this.store.reorder(ids); // 内部经 enqueue 串行化，防并发丢更新
    this.emitter.fire();
  }
}
