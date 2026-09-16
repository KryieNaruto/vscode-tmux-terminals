import * as vscode from 'vscode';
import { groupByCwd } from './core/grouping';
import { folderSelectionState, toggleFolderSelection } from './core/selection';
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
  ) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.id = entry.id;
    this.contextValue = 'batchItem';
    // 描述从「短路径消歧」换成 profile：扁平列表没了之后，同一组的条目 cwd
    // **完全相同**，短路径既区分不了谁、又和一级标题重复一遍（spec §3.3 第 5 条）。
    // 模型跟在后面 —— 批量场景下「这批是不是同一个模型」正是用户要扫的东西。
    this.description = entry.model ? `${entry.profile}｜${entry.model}` : entry.profile;
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

/**
 * 一级：一个 cwd 分组，点击 = 整组一起选 / 取消（不是展开折叠 —— 展开是
 * 点前面那个箭头）。
 *
 * **子 id 在渲染时就算好、塞进 `arguments`**，而不是把 cwd 传进去让命令自己
 * 去 load：那会在「面板显示的内容」与「点击时读到的内容」之间开一个时间窗
 * —— 用户点了「全选」，补进来的却是这一瞬间刚被别处删掉的条目（spec §9.2）。
 */
export class BatchFolderItem extends vscode.TreeItem {
  constructor(
    public readonly cwd: string,
    /** 该组全部子 id，渲染这一刻的快照 —— 只服务于点击时传给命令的参数。 */
    public readonly childIds: string[],
    state: 'all' | 'none' | 'partial',
  ) {
    super(cwd, vscode.TreeItemCollapsibleState.Expanded);
    // **确定性纯函数**：`folder:` 前缀 + 完整 cwd（与主树一级同一套 id 方案）。
    // 绝不能用下标 —— 下标会随条目增删整体平移，而 VS Code 按 id 记住展开态，
    // 平移的后果是「展开出来的是另一个文件夹」，且不报任何错。
    this.id = `folder:${cwd}`;
    this.contextValue = 'batchFolder';
    this.iconPath = new vscode.ThemeIcon(
      state === 'all' ? 'check' : state === 'partial' ? 'dash' : 'circle-large-outline',
      state === 'all' ? new vscode.ThemeColor('charts.blue') : undefined,
    );
    this.command = {
      command: 'tmuxTerminals.batchToggleFolder',
      title: '切换文件夹选中',
      arguments: [childIds],
    };
  }
}

/** 面板的一行：一级文件夹，或二级条目（**没有三级**，需求 7）。 */
export type BatchNode = BatchFolderItem | BatchTreeItem;

/** 选中集合只存内存 —— 它是临时操作态，扩展重载后清空是合理的。 */
export class BatchTreeProvider implements vscode.TreeDataProvider<BatchNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private entries: TerminalEntry[] = [];
  // 不是 readonly：`toggleFolderSelection` 的约定是**返回新集合**，这里整个换掉
  // 而不是原地增删 —— 省一次拷贝换来的是「判定用的集合」与「渲染时的集合」永远
  // 是同一个对象，两次刷新之间看不出变化，勾会停在旧状态（spec §9.2）。
  private selected = new Set<string>();

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

  /**
   * 一级标题点击：**整组一起切**。
   *
   * 全选 → 全不选；未选 / **部分选中 → 补齐全选**。最后这条是列表类界面的通行
   * 语义（部分选中时点一下的意图是「补齐」），写成「一律清空」用户就得为了补全
   * 一个大部分已选的组多点一次 —— 而那些已选的会被清掉，等于误伤。
   *
   * 三态判定与算法全在 `core/selection.ts`（纯函数、能脱离编辑器单测），这里
   * 只负责换掉集合与刷新；组外的 id 由 `toggleFolderSelection` 原样带过。
   */
  toggleFolder(ids: string[]): void {
    this.selected = toggleFolderSelection(ids, this.selected);
    this.emitter.fire();
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

  async getChildren(element?: BatchNode): Promise<BatchNode[]> {
    // 每次都重读清单：面板「显示的内容」与「点击时读到的内容」必须是同一份，
    // 否则一级标题上那个子 id 快照会指向早已不存在的条目（spec §9.2）。
    this.entries = await this.store.load();
    this.prune(this.entries.map((e) => e.id));

    if (element instanceof BatchFolderItem) {
      // 按 **cwd 重新取组**，不用 `element.childIds`（那是渲染时的快照，可能已经
      // 过期）。childIds 只服务于点击时传给命令的参数。
      return this.entries
        .filter((e) => e.cwd === element.cwd)
        .map((e) => new BatchTreeItem(e, this.selected.has(e.id)));
    }
    if (element) return [];

    return groupByCwd(this.entries).map(([cwd, group]) => {
      const ids = group.map((e) => e.id);
      return new BatchFolderItem(cwd, ids, folderSelectionState(ids, this.selected));
    });
  }

  getTreeItem(element: BatchNode): vscode.TreeItem {
    return element;
  }

  /** 供批量命令取回完整条目（选中集合只存 id）。 */
  entriesFor(ids: string[]): TerminalEntry[] {
    const want = new Set(ids);
    return this.entries.filter((e) => want.has(e.id));
  }
}
