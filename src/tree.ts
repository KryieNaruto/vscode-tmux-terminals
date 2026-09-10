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

export class EntryTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private entries: TerminalEntry[] = [];
  private alive = new Set<string>();

  constructor(
    private readonly store: { load(): Promise<TerminalEntry[]> },
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
}
