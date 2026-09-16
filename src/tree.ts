import * as vscode from 'vscode';
import { commandFor } from './core/command';
import { EntryActivity } from './core/activity';
import { groupByCwd } from './core/grouping';
import { reorderWithinGroup } from './core/reorder';
import { sessionLabel } from './core/sessions';
import { sessionNameFor } from './core/tmux';
import { SessionSlot, TerminalEntry } from './core/types';

/** 二级行首那条竖线可接受的三种形态（自绘 SVG / 主题自适应对 / 退化图标）。 */
export type EntryIconPath =
  | vscode.Uri
  | { light: vscode.Uri; dark: vscode.Uri }
  | vscode.ThemeIcon;

/**
 * profile 的**纯文本**表示，显示在二级标题后面。
 *
 * ⚠ **这里刻意不是 codicon**：需求原文要的是「标题后面一个 codicon」，查证后
 * 否决了（spec §6.2 / §13）。原因是 `TreeItem.description` **不支持 codicon 渲染**
 * —— 它是纯右对齐文本，写 `'$(plug)'` 会**原样显示**这四个字符。要在标签里渲染
 * codicon 只能用 `MarkdownString` 作 `label`，那是 **VS Code 1.106+** 的 API，
 * 而本扩展的 `engines.vscode` 是 `^1.85.0`；用它就必须抬高下限，老版本用户会
 * **完全装不上**（比「图标退化成文字」严重得多）。
 *
 * 信息一字不少：tooltip 里本来就写着同样的含义（见下面的 tooltip 构造）。
 * 要改回图标是一处 3 行的改动（label 换 `MarkdownString({ supportThemeIcons: true })`
 * + `engines` 抬到 `^1.106`），留给用户拍板。
 */
function profileText(entry: TerminalEntry): string {
  return entry.profile === 'direct' ? '直连' : '中转';
}

/**
 * tooltip 里的「对话」一行。
 *
 * **入参是会话槽而不是条目**：绑定是会话级的属性，一个二级条目下可以有 N 个
 * 会话、各有各的绑定，条目本身没有唯一的「当前对话」可读 —— 读条目只会得到
 * 一个 undefined（那个字段已经从 TerminalEntry 上删掉了，是编译器把我们带到
 * 这里来的）。
 *
 * 槽可以是 undefined（`sessions: []` 是 v3 的合法状态）：那种条目一行会话都
 * 没有，如实说「没有任何会话」，不要拿条目 id 去凑一个占位说法。
 *
 * 显示短 id 而不是首条用户消息：要拿到它得读会话文件（哪怕只读头部窗口），
 * 而 tooltip 是同步渲染的 —— 为了一个提示去同步读盘不值得。想认内容就用
 * 「选择要接回的对话…」命令，那里显示首条用户消息的原文。
 */
function conversationLabel(slot: SessionSlot | undefined): string {
  if (slot === undefined) return '（该终端下没有任何会话）';
  const id = slot.conversationId;
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
 * 二级节点：一个终端条目（一份配置 + N 个会话槽）。
 *
 * **它不再承载任何「打开终端」的动作**：点击二级 = 展开/折叠，打开下移到三级
 * （三级才是会话，见 spec §3.3 第 1 条）。所以这里**没有 `command`** ——
 * 留着它就会出现「点一下既展开又起了个 claude」这种二义行为；而二级上「打开
 * 哪一个会话」本来就没有唯一答案，硬选一个（比如第一个槽）会在用户毫不知情的
 * 情况下接错对话。
 *
 * 行首图标只承载**颜色**（用户挑的那条竖线），profile 只由标题后面的纯文本
 * 表达 —— 同一个信息不该在两个地方用两种编码各说一遍（spec §6.3）。
 */
export class EntryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: TerminalEntry,
    /** 颜色竖线。由 `ColorIconCache.iconFor(entry.color)` 算好传进来。 */
    iconPath: EntryIconPath,
  ) {
    super(
      entry.name,
      // 与 `sessions.length > 0` **严格一致**：绝不出现「看起来能展开、展开后
      // 却是空的」（沿用 tree-hierarchy spec §8 不变量 1，见 spec §11.9）。
      // 会话数为 0 时必须是 None，否则用户点开一个空箭头，只会以为扩展坏了。
      entry.sessions.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    // 加 `entry:` 前缀：迁移合成的槽 id 恒等于原条目 id（spec §5.1），
    // 三级用 `session:<槽 id>`、二级若直接用 `entry.id`，两者会**撞 id** ——
    // VS Code 的展开状态与选中态随即错位到别的行上，且不报任何错。
    this.id = `entry:${entry.id}`;
    this.contextValue = 'terminal';
    this.description = profileText(entry);
    this.tooltip = new vscode.MarkdownString(
      [
        `**${entry.name}**`,
        '',
        `- 目录：\`${entry.cwd}\``,
        // profile 的文字含义必须写在 tooltip 里：标题后面那两个词（直连/中转）
        // 不带颜色也没有图标，只靠那两个字认不出「官方直连」还是「本地中转」。
        `- profile：${entry.profile === 'direct' ? 'direct（官方直连）' : 'ccr（本地中转）'}`,
        `- 模型：${entry.model && entry.model.length > 0 ? `\`${entry.model}\`` : '（profile 默认）'}`,
        `- 颜色：${entry.color !== undefined ? `\`${entry.color}\`` : '（未设，中性竖线）'}`,
        `- 会话：${entry.sessions.length} 个`,
        `- 基础命令：\`${commandFor(entry)}\``,
        `- 参与全部恢复：${entry.autoRestore ? '是' : '否'}`,
        // 刻意**没有**「对话」一行：对话是会话级的，二级没有唯一答案 ——
        // 写第一个槽的绑定会把「这一行代表的东西」表达错。那一行在三级的
        // tooltip 里（每个槽各有各的绑定）。
      ].join('\n'),
    );
    this.iconPath = iconPath;
  }
}

/**
 * 三级节点：一个会话槽。**恒生成**（每个槽一行），不再有「有任务名才生成」
 * 这回事 —— 那一行是「接回这个会话」的唯一入口，关掉会话之后它必须还在
 * （标题回落「无会话」，槽与绑定一字未动，见 spec §7.3 / §8.2）。
 *
 * **同时暴露 `entry` 与 `slot`**：条目级的菜单项（profile / 模型 / 颜色 /
 * 参与恢复 / 复制）要从三级转发到所属条目，而打开/关闭/删除会话要的是槽。
 * 少暴露一个，`extension.ts` 就得回头去 store 里重查一遍。
 *
 * 图标按「存活 + 活动状态」四分支，**用中性色而不是 profile 色**：profile
 * 已经由二级的纯文本表达（spec §6.3），同一个信息不该在两级各说一遍。
 */
export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: TerminalEntry,
    public readonly slot: SessionSlot,
    /** 该槽的 tmux 会话是否存活（由 setAlive 推来的会话名集合判定）。 */
    public readonly alive: boolean,
    /** 可能是 undefined —— 回退来的名字没有对应的本次采样状态。 */
    public readonly activity: EntryActivity | undefined,
    /** `label` 用它；空串回落「无会话」（见 core/sessions.ts 的 sessionLabel）。 */
    public readonly taskName: string,
    /** 任务名是哪来的，只用于 tooltip —— 三个来源的含义完全不同。 */
    public readonly titleSource: 'pane' | 'fallback' | 'none',
  ) {
    super(sessionLabel(taskName), vscode.TreeItemCollapsibleState.None);
    this.id = `session:${slot.id}`;
    this.contextValue = alive ? 'sessionAlive' : 'sessionDead';
    this.iconPath = !alive
      ? // 会话不存在（进程没了 / 从未起来）：空心，中性色。
        new vscode.ThemeIcon('circle-outline')
      : activity?.state === 'running'
        ? // 存活且 claude 正在干活：原生转圈动画。
          new vscode.ThemeIcon('loading~spin')
        : activity?.state === 'done-unseen'
          ? // 存活、刚干完、用户还没看：实心绿点，直到用户点开这一行
            // （ActivityTracker.markSeen 会清掉它）。
            new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'))
          : // 存活 + idle，**或 activity 为 undefined**（回退名字 / 这次没采到
            // 样）—— 后者一并落进 idle 分支，**不新增状态**：有名字但当前空闲
            // 是正常状态，taskName 不随 state 变化而清空（core/activity.ts）。
            new vscode.ThemeIcon('circle-filled');
    this.tooltip = new vscode.MarkdownString(
      [
        `**${entry.name}**`,
        '',
        `- 目录：\`${entry.cwd}\``,
        `- profile：${entry.profile === 'direct' ? 'direct（官方直连）' : 'ccr（本地中转）'}`,
        `- 模型：${entry.model && entry.model.length > 0 ? `\`${entry.model}\`` : '（profile 默认）'}`,
        `- 对话：${conversationLabel(slot)}`,
        `- 状态：${alive ? '🟢 会话存活，点击接回原进程' : '⚪ 无会话，点击重建并接回该对话'}`,
        `- 任务名：${taskName.length > 0 ? taskName : '（无）'} · ${activityLabel(activity)}`,
        `- 任务名的来源：${TITLE_SOURCE_TEXT[titleSource]}`,
      ].join('\n'),
    );
    this.command = {
      command: 'tmuxTerminals.open',
      title: '打开终端',
      arguments: [this],
    };
  }
}

/**
 * 任务名三个来源的说明文字。
 *
 * 写出来不是为了好看：**「为什么这一行显示的是这个名字」在界面上无法自证** ——
 * pane title 是实时的（claude 换个任务就变），而绑定对话的 aiTitle 是**落盘
 * 那一刻**的标题，可能已经很旧。不说清楚，用户会觉得「任务名怎么不更新了」。
 */
const TITLE_SOURCE_TEXT: Record<'pane' | 'fallback' | 'none', string> = {
  pane: 'claude 进程当前的 pane 标题（实时）',
  fallback: '绑定对话里落盘的标题（进程没在跑时的回退，可能已过时）',
  none: '（还没有名字）',
};

/** 清单为空时显示的一行，点击即新建。 */
export class EmptyTreeItem extends vscode.TreeItem {
  constructor() {
    super('点击 + 添加一个终端条目', vscode.TreeItemCollapsibleState.None);
    this.command = { command: 'tmuxTerminals.add', title: '新建终端条目' };
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'empty';
  }
}

export type TreeNode = FolderTreeItem | EntryTreeItem | SessionTreeItem | EmptyTreeItem;

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
     * 轮询细节（与上面 store 参数同样的处理方式）。省略时所有会话的
     * activity 都是 undefined（二级图标退回默认逻辑），不影响既有调用方
     * （比如批量面板用的是另一个 Provider，不受影响）。
     *
     * ⚠ **入参是槽 id，不是条目 id**：采样层内部就是 `sessionNameFor(id)`，
     * 喂条目 id 会让「同一终端下只有槽 id 恰好等于条目 id 的那一个」采到样，
     * 其余会话的运行图标永远不转 —— 静默、且极难定位（spec §6.5）。
     */
    private readonly activity?: {
      activityFor(sessionId: string): EntryActivity | undefined;
    },
    /**
     * 任务名回退源：**同步读内存缓存，不发 IO、不触发观测**（观测统一由
     * extension.ts 驱动，provider 不持有 reconciler）。
     * 省略 = 无回退（只剩 pane title 一个来源）。
     *
     * 除 `peek` 外还有一个**可选**的订阅入口：缓存后台真的写入一条新标题时
     * 会通知一次，provider 据此重刷整棵树 —— 标题是异步落地的，而这里是同步
     * peek，两者之间没有它就没有任何交集：读到了名字树也不会重算，三级会一直
     * 停在「无会话」上。声明成可选成员：没有订阅能力的实现（比如单测里的假
     * cache）照常可用。
     */
    private readonly titleFallback?: {
      peek(conversationId: string | undefined): string | undefined;
      onDidChangeTitle?(listener: () => void): { dispose(): void };
    },
    /**
     * 新增：二级行的颜色竖线。省略时退化为 `ThemeIcon('circle-outline')`
     * —— 安全侧：图标虽然丢了颜色，但不会去碰一个不存在的文件路径。
     */
    private readonly colorIcons?: {
      iconFor(color?: string): vscode.Uri | { light: vscode.Uri; dark: vscode.Uri };
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
   * 不是条目显示名 —— 会话名由**槽** id 派生，见 core/tmux.ts 的 sessionNameFor。
   * v3 下槽 id 与条目 id 不再恒等（只有迁移合成出来的槽才相等），所以这里
   * 认得的是槽的会话名，二级只是按「其下有存活槽吗」间接体现。
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
   * 某个槽的显示用任务名：pane title（live，权威）→ 绑定对话的 aiTitle（回退）
   * → ''（渲染层回落成「无会话」）。
   *
   * **全都无从得知时返回空串** —— 不加灰色占位、不退化成
   * `~/.claude/sessions` 的 derived slug、不用首条用户消息：把「不知道」
   * 伪装成「知道」是误导（spec §8 不变量 6）。回落成「无会话」那一步在
   * `sessionLabel`（渲染层）里做，本方法只回答「有没有名字」。
   *
   * 同时返回**名字的来源**（只给 tooltip 用）：pane title 是实时的，而绑定
   * 对话的 aiTitle 是**落盘那一刻**的标题、可能已经很旧 —— 不说清楚，用户会
   * 以为「任务名怎么不更新了」。两种来源合在一个方法里算，是因为它们的优先级
   * 关系就是这一段 if/else，拆成两处迟早会各说各话。
   *
   * 纯读：`peek` 同步、不发 IO、不触发观测（观测统一由 extension.ts 驱动）。
   * 缓存**后来**才写入一条标题时，构造函数里那个订阅会 fire 一次 ——
   * `getChildren` 重跑、本方法被重新求值，三级标题随之从「无会话」变成真名。
   */
  private taskNameFor(
    slot: SessionSlot,
  ): { name: string; source: 'pane' | 'fallback' | 'none' } {
    const fromPane = this.activity?.activityFor(slot.id)?.taskName ?? '';
    if (fromPane.length > 0) return { name: fromPane, source: 'pane' };
    // 回退源取**该槽**的绑定：v3 的对话绑定在槽上，条目上已经没有这个字段了。
    // 未绑定的槽（conversationId 为空）没有可 peek 的东西，回退源自然是空串。
    const fromTitle = this.titleFallback?.peek(slot.conversationId) ?? '';
    return fromTitle.length > 0
      ? { name: fromTitle, source: 'fallback' }
      : { name: '', source: 'none' };
  }

  /** 二级行首的图标：有 ColorIconCache 就用它的（竖线），否则退化主题图标。 */
  private entryIcon(entry: TerminalEntry): EntryIconPath {
    return this.colorIcons === undefined
      ? new vscode.ThemeIcon('circle-outline')
      : this.colorIcons.iconFor(entry.color);
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
      return element.entries.map((e) => new EntryTreeItem(e, this.entryIcon(e)));
    }
    if (element instanceof EntryTreeItem) {
      // 三级**恒生成**（每个槽一行）：它是「接回这个会话」的唯一入口。
      // 存活判据落在**槽**上：tmux 会话名由槽 id 派生（v3），而条目 id 只在
      // v1/v2 迁移出来的槽上与槽 id 恰好相等 —— 拿条目 id 去凑一个会话名，
      // 会在「槽 id 与条目 id 不同」的条目上查到一个毫不相干的 tmux 会话。
      return element.entry.sessions.map((slot) => {
        const title = this.taskNameFor(slot);
        return new SessionTreeItem(
          element.entry,
          slot,
          this.alive.has(sessionNameFor(slot.id)),
          this.activity?.activityFor(slot.id),
          title.name,
          title.source,
        );
      });
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
