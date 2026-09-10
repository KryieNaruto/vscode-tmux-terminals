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
        `- 基础命令：\`${commandFor(entry)}\``,
        `- 对话：${conversationLabel(entry)}`,
        `- 状态：${alive ? '🟢 会话存活，点击接回原进程' : '⚪ 无会话，点击重建并接回该对话'}`,
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
      (e, i) => new EntryTreeItem(e, this.alive.has(sessionNameFor(e.id)), labels[i]),
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
