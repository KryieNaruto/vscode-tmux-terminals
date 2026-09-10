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
