import * as vscode from 'vscode';
import { Society, SocietyLevel, SocietyRole, levelLabel } from './core/society';
import { TerminalEntry } from './core/types';
import { SocietyStore } from './societyStore';
import {
  readName,
  parseMessages,
  terminalIdFor,
  lastOutbound,
  roleStatus,
  resolveToName,
  SocietyMessage,
} from './societyObserve';

/**
 * 层级展示顺序：固定「产品经理 → 架构师 → 开发组组长 → 开发者」，不按 roles 数组里的出现顺序。
 * 组内顺序保持 roles 原序（持久化文件里的序就是用户/创建逻辑给的序）。
 */
const LEVEL_ORDER: SocietyLevel[] = ['product', 'architect', 'lead', 'dev'];

/** 一级节点：一个 society。tooltip 放根目录 —— name 之外唯一需要先知道的信息。 */
export class SocietyTreeItem extends vscode.TreeItem {
  constructor(public readonly society: Society) {
    super(society.name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `society:${society.id}`;
    this.contextValue = 'society';
    this.tooltip = society.rootDir;
    this.iconPath = new vscode.ThemeIcon('organization');
  }
}

/**
 * 二级节点：society 下的一个层级。
 *
 * `id` 带上 society.id：不同 society 会有同名的 product/test/dev 组，
 * 若只用 `level:${level}` 作 id，VS Code 记的展开状态会串到别的 society 上。
 *
 * roles 直接挂在节点上（而不是 getChildren 时回头去 store 里查）：这棵树的
 * 数据全部来自一次 `load()`，节点自带自己那一组角色，展开时不必重新读盘。
 */
export class LevelTreeItem extends vscode.TreeItem {
  constructor(
    public readonly society: Society,
    public readonly level: SocietyLevel,
    public readonly roles: SocietyRole[],
  ) {
    super(levelLabel(level), vscode.TreeItemCollapsibleState.Expanded);
    this.id = `societyLevel:${society.id}:${level}`;
    this.contextValue = 'societyLevel';
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

/**
 * 三级节点：一个角色。
 *
 * 名字可能还是空串（AI 尚未起名）——此时先读 memory.md 看 AI 是否已自起名，
 * 仍没有才回落成「未命名·<层级>」，**不留空行**：空 label 在树里表现为
 * 一行没有文字的缩进，看起来像渲染坏了。
 *
 * description 放「层级 · 忙/空闲」；职责挪到 tooltip（三段信息挤不进一行）。
 * 有发过消息时节点可展开，唯一子节点是它发出的最后一条消息。
 */
export class RoleTreeItem extends vscode.TreeItem {
  /** 该角色发出的最后一条消息节点；没发过消息时没有子节点。 */
  public readonly messageChild?: MessageTreeItem;

  constructor(
    public readonly society: Society,
    public readonly role: SocietyRole,
    entries: TerminalEntry[],
    messages: SocietyMessage[],
    allRoles: SocietyRole[],
  ) {
    const name = role.name || readName(role);
    const status = roleStatus(role, entries, messages, Date.now(), 5 * 60 * 1000);
    const last = lastOutbound(role, entries, messages);
    super(
      name.length > 0 ? name : `未命名·${levelLabel(role.level)}`,
      last ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.id = `societyRole:${role.id}`;
    this.contextValue = 'societyRole';
    this.description = `${levelLabel(role.level)} · ${status}`;
    this.tooltip = role.duty;
    this.iconPath = new vscode.ThemeIcon('person');
    this.command = {
      command: 'tmuxTerminals.societyOpenRole',
      title: '打开角色终端',
      arguments: [this],
    };
    this.messageChild = last ? new MessageTreeItem(last, allRoles, entries) : undefined;
  }
}

/**
 * 四级节点：角色发出的最后一条消息。
 *
 * label 一眼能看出「发给谁、说了什么」，全文留在 tooltip —— 消息体可多行，
 * 塞进单行 label 会被截断成一串看不出要点的字。
 */
export class MessageTreeItem extends vscode.TreeItem {
  constructor(message: SocietyMessage, allRoles: SocietyRole[], entries: TerminalEntry[]) {
    const to = resolveToName(message.to, allRoles, entries);
    const one = message.body.replace(/\s+/g, ' ').trim();
    const summary = one.length > 40 ? one.slice(0, 40) + '…' : one;
    super(`→ ${to}：${summary}`, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('comment');
    this.tooltip = message.body;
    this.contextValue = 'societyMessage';
  }
}

/**
 * 空清单提示行。
 *
 * 与 tree.ts 的 EmptyTreeItem 不同，这里**不带 command**：创建 society 的命令
 * 属于下一步，现在挂一个不存在的 command id 只会点出一句「command not found」。
 */
export class EmptyTreeItem extends vscode.TreeItem {
  constructor() {
    super('还没有 society', vscode.TreeItemCollapsibleState.None);
    this.id = 'societyEmpty';
    this.contextValue = 'societyEmpty';
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

export type SocietyTreeNode =
  | SocietyTreeItem
  | LevelTreeItem
  | RoleTreeItem
  | MessageTreeItem
  | EmptyTreeItem;

/**
 * society 视图的 TreeDataProvider。
 *
 * **本步只做结构，不做存活检测**：角色对应的终端是否还活着，属于下一步接的
 * 逻辑（与 tree.ts 的 setAlive 对应）。因此这里不缓存 `alive`，也没有 dispose
 * 需要释放的订阅 —— 唯一的资源是 emitter，随 provider 一起活到扩展退出。
 */
export class SocietyTreeProvider implements vscode.TreeDataProvider<SocietyTreeNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** 终端条目快照，用于把角色映射到终端 ID（忙碌判定/收件人显示都靠它）。 */
  private entries: TerminalEntry[] = [];

  constructor(private readonly societyStore: SocietyStore) {}

  refresh(): void {
    this.emitter.fire();
  }

  /** 由 extension.ts 的轮询注入最新条目快照；不主动 fire（轮询随后会 refresh）。 */
  updateEntries(entries: TerminalEntry[]): void {
    this.entries = entries;
  }

  /** 同步读盘（SocietyStore 本身是同步接口），因此这里不必是 async。 */
  getChildren(element?: SocietyTreeNode): SocietyTreeNode[] {
    if (element === undefined) {
      const all = this.societyStore.load();
      if (all.length === 0) return [new EmptyTreeItem()];
      return all.map((s) => new SocietyTreeItem(s));
    }
    if (element instanceof SocietyTreeItem) {
      // 只出现有角色的层级：一个空组点开后什么都没有，只会让用户以为丢数据了。
      const groups: LevelTreeItem[] = [];
      for (const level of LEVEL_ORDER) {
        const roles = element.society.roles.filter((r) => r.level === level);
        if (roles.length > 0) {
          groups.push(new LevelTreeItem(element.society, level, roles));
        }
      }
      return groups;
    }
    if (element instanceof LevelTreeItem) {
      const messages = parseMessages(element.society.rootDir);
      return element.roles.map(
        (r) => new RoleTreeItem(element.society, r, this.entries, messages, element.society.roles),
      );
    }
    if (element instanceof RoleTreeItem) {
      return element.messageChild ? [element.messageChild] : [];
    }
    return [];
  }

  getTreeItem(element: SocietyTreeNode): vscode.TreeItem {
    return element;
  }
}
