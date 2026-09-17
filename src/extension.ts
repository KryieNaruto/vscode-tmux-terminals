import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { EntryStore } from './core/store';
import { TmuxClient } from './tmuxClient';
import { EntryTreeItem, EntryTreeProvider, FolderTreeItem, SessionTreeItem } from './tree';
import { ColorIconCache } from './colorIcons';
import { BatchTreeProvider } from './batchTree';
import { readProfileConfig } from './claudeConfig';
import { TerminalManager } from './terminalManager';
import { ActivityTracker } from './activityTracker';
import { TaskTitleCache } from './taskTitles';
import { sessionNameFor } from './core/tmux';

let pollTimer: NodeJS.Timeout | undefined;
let activityTimer: NodeJS.Timeout | undefined;

/** 活动轮询节奏——比会话存活轮询（默认 10s，见 pollInterval 配置）快得多，
 * 因为它驱动的是"运行中徽章闪烁"这种需要看起来鲜活的 UI 效果，不是配置项，
 * 用户不需要也不应该去调它。 */
const ACTIVITY_POLL_INTERVAL_MS = 900;

export function activate(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration('tmuxTerminals');

  const storageFile = (): string => {
    const override = cfg().get<string>('storagePath', '').trim();
    return override.length > 0
      ? override
      : path.join(context.globalStorageUri.fsPath, 'terminals.json');
  };

  const tmux = new TmuxClient(cfg().get<string>('tmuxPath', 'tmux'));
  // 清单文件被覆盖前若发现它已损坏/不可解析，store 会先把原文另存为
  // `<file>.corrupt`。这里只负责把这件事告诉用户 —— 否则数据被抢救了
  // 却无人知晓，用户会以为条目"自己没了"。
  const store = new EntryStore(storageFile(), (corruptPath) => {
    void vscode.window.showWarningMessage(
      `终端清单文件无法解析，原始内容已保留为 ${corruptPath}。` +
      `清单已按空列表继续，可从中手动恢复条目。`,
    );
  });
  // 任务名回退源：**只有一个实例**，同时注入 provider（渲染时 peek）
  // 与 manager（reconcile 时 prewarm）。home 与 manager.home() 同源
  // （扩展进程里 os.homedir() 就是它）。
  const titles = new TaskTitleCache(os.homedir());
  // TmuxClient 已经有 paneSample(name) 方法（一次 display-message 同时取回
  // 前台进程名与 pane title），结构上满足 ActivityTracker 需要的最小接口，
  // 不需要额外适配。
  const tracker = new ActivityTracker(tmux);
  // 二级行首那条颜色竖线。**自绘 SVG 必须落在可写的目录里** —— 扩展安装目录
  // （vsix 解出来的地方）可能是只读的，往那儿写会在「用户第一次设颜色」时
  // 抛 EROFS，而报错时机离原因很远。globalStorage 是扩展自己的可写地盘。
  //
  // 中性竖线（未设颜色时用的两个）反过来：它们是**随包发布**的静态资源，
  // 从 extensionUri 下取，不需要也不应该被复制到 storage 里。
  const colorIcons = new ColorIconCache(
    path.join(context.globalStorageUri.fsPath, 'colors'),
    context.extensionUri,
  );
  const provider = new EntryTreeProvider(store, tracker, titles, colorIcons);   // 渲染：peek
  // 绑定回写 → 树上的三级任务名与 tooltip 的「对话」行都过期了，必须重算。
  // 从前靠 ActivityTracker 每 900ms 的无条件整树重建兜着，那个兜底已经去掉了
  // （改成只有真变化才通知），不接这一根就会停在旧值上。
  // 第 5 个参数是「设置颜色…」调色板的色块来源（同一个 colorIcons：色块与
  // 二级行首那条竖线是同一批颜色、同一个目录下的两批文件）。
  const manager = new TerminalManager(store, tmux, titles, () => provider.refresh(), colorIcons);

  // 把清单里已有的颜色**先落盘再渲染**：`iconFor` 只拼路径、不同步读盘
  // （渲染路径不能有 IO），文件不到位时那一行的竖线会短暂空着 —— 不报错，
  // 只是看起来「颜色丢了」。这里在第一次 getChildren 之前把这一批补上，
  // 落完再刷一次树，覆盖「补的过程本身花了时间」的那一小段。
  // 失败只静默：最坏结果是竖线回落中性（与颜色非法同侧），不该阻断激活。
  void store
    .load()
    .then((entries) =>
      colorIcons.ensure(
        entries.map((e) => e.color).filter((c): c is string => c !== undefined),
      ),
    )
    .then(() => provider.refresh())
    .catch(() => {
      // 忽略：见上，图标退化成中性即可。
    });

  const view = vscode.window.createTreeView('tmuxTerminals.list', {
    treeDataProvider: provider,
    dragAndDropController: provider,
  });
  // provider 一并进订阅表：它订阅了标题缓存（标题异步落地 → fire 刷新树），
  // 要在 dispose 时解除。VS Code 只管视图的生命期，不会替我们调 provider。
  context.subscriptions.push(view, provider);

  const batchProvider = new BatchTreeProvider(store);
  const batchView = vscode.window.createTreeView('tmuxTerminals.batch', {
    treeDataProvider: batchProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(batchView);

  // v1→v2 迁移前先备份一次用户数据。只在文件真的是 v1 形态时备份，且
  // 已有 .bak 不覆盖 —— 第一次的备份才是原始数据。备份失败只静默：读文件
  // 已成功，这里只兜 .bak 写不进去的情况，绝不让一次备份失败阻断扩展启动
  // 或抛出未处理的 rejection。
  // 提示里报**实际的 basename**，不写死 `terminals.json`：`storagePath` 是可
  // 配置的（见 storageFile()），配了路径时写死就是在指着一个不存在的地方让
  // 用户去找备份。
  void store
    .migrateAndBackup()
    .then((did) => {
      if (did) {
        void vscode.window.showInformationMessage(
          `终端清单已升级到新格式，原文件已备份为 ${path.basename(storageFile())}.bak。`,
        );
      }
    })
    .catch(() => {
      // 忽略：备份只是防御手段，失败不影响正常使用。
    });

  // v2 形态的迁移（多会话模型）同理，但**备份名必须带版本号**。理由在
  // store.ts 那个入口的注释里说死了：不带版本号的话，这一处会撞上 v1 那次
  // 留下的「.bak 已存在 → 不覆盖」判断而被静默跳过 —— 结果是更晚、更接近
  // 现状的那份状态反而没被保住。两个入口因此并列、互不覆盖：v1 文件只出
  // `.bak`，v2 文件只出 `.v2.bak`。
  //
  // **少了这一处调用，`.v2.bak` 永远不会生成，而且是纯静默的**：备份函数
  // 自己不报错，迁移也照常（load() 在内存里升到 v3，条目与绑定都在），只是
  // 清单会在用户第一次真实改动时被直接改写成 v3 —— 那份「升级前的原文」
  // 就此永远拿不到，而它正是引入带版本号备份的全部意义。
  // 失败同样只静默，理由与上面一处相同。
  void store
    .migrateAndBackupV2()
    .then((did) => {
      if (did) {
        void vscode.window.showInformationMessage(
          `终端清单已升级到新格式，原文件已备份为 ${path.basename(storageFile())}.v2.bak。`,
        );
      }
    })
    .catch(() => {
      // 忽略：备份只是防御手段，失败不影响正常使用。
    });

  // ---- 存活状态轮询 ----
  let inFlight = false;
  const poll = async () => {
    if (inFlight) return; // 上一轮还没回来就跳过，避免请求堆积
    inFlight = true;
    try {
      provider.setAlive(new Set(await tmux.listSessions()));
      const entries = await store.load();
      // 这一拍**还要观测并改绑**。`fresh` 首启（0.1.6）把「绑定天然可信」
      // 这个前提推翻了：新建条目在出生时就预分配了一个 conversationId，可
      // 裸 `claude` 实际开出来的是**另一条**会话 —— 预分配的那个成了幽灵。
      // 绑定不再是写一次即定的事实，只能靠**周期性观测**（pane → 注册表）
      // 纠回来。而原有的 reconcile 触发点全是用户动作，用户"新建完就一直
      // 待在终端里提问、不碰侧边栏"是完全正常的用法，那时一个都不发 ——
      // 绑定会永远停在幽灵 id 上，三级任务名也就永远出不来。
      await manager.reconcileAll(entries); // 观测并改绑
      // 顺序不能反：先 reconcileAll 把绑定改对，retryTitles 才有**正确的
      // id** 可重试（否则它每 25 秒去重读一个永远不存在的文件）。
      //
      // 任务名缓存的低频重试就挂在这一拍上。
      // **刻意不挂 900ms 的活动采样**：那一拍只关心 pane 前台状态，而这里
      // 每次都要 tail-read 一个可能上 MB 的 transcript，跟着 900ms 跑是灾难。
      // 挂在 poll 上也意味着它天然受同一个 `view.visible` 开关约束：面板
      // 隐藏时这拍根本不跑 —— 没人看的时候不必重读。
      //
      // 读盘节奏按条目分成两种：**已存活但还没缓存到标题**的条目，光靠
      // 这一拍里 reconcileAll 的 prewarm 就会重读 —— prewarm 只做
      // `cache.has` / `pending.has` 两个早返回，**不查 RETRY_COOLDOWN_MS
      // 那张冷却表**，所以对它们是实打实的**每 10 秒一次**，不是 25 秒。
      // retryMissing 的 25 秒冷却仍然有效，但主要落在**会话已死**的条目上：
      // reconcileAll 跳过不存活的条目，那条路径上没人替它刷新冷却表。
      //
      // 多出来的读盘代价可接受：重读走的是 `readTail`，只读 transcript 的
      // **尾部窗口**（`TAIL_BYTES`，64 KB），不是整份文件；而**已经有标题
      // 缓存**的条目会命中 prewarm 的第一个早返回，根本不读盘 —— 稳态下
      // 没有任何额外读盘。
      //
      // 这一拍多跑的 reconcile 成本可接受：整批条目共用一份 `readLiveness`
      // 快照（一次 `ps` + 一次注册表 readdir），不是按条目各查一遍；绑定已
      // 收敛时 `reconcileBinding` 返回 `undefined`，`reconcileAll` 会
      // `continue` —— **稳态下不写盘**。
      manager.retryTitles(entries); // 补晚到的 aiTitle
    } finally {
      inFlight = false;
    }
  };

  const restartPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    const interval = cfg().get<number>('pollInterval', 10000);
    if (interval > 0 && view.visible) {
      pollTimer = setInterval(() => void poll(), interval);
    }
    void poll();
  };

  // ---- 活动状态轮询（运行中/刚完成的徽章与图标，见 activityTracker.ts）----
  // 独立于上面的存活轮询：节奏快得多（900ms vs 默认 10s），且只在面板
  // 可见时跑——这是纯视觉效果，不可见时没有意义轮询，白白多发 tmux 命令。
  let activityInFlight = false;
  const pollActivity = async () => {
    if (activityInFlight) return;
    activityInFlight = true;
    try {
      // 闸门必须来自**权威的 tmux 查询**，不能用 provider.isAlive：后者由
      // 10s 的存活轮询填充，而 poll() 有 inFlight 守卫 —— 激活时两个
      // restart* 并发启动，pollActivity 刚跑时第一次 listSessions 还没回来，
      // 于是第一轮 aliveIds 恒为空、一个条目都不采（实测症状）。
      const sessions = new Set(await tmux.listSessions());
      provider.setAlive(sessions); // 顺带把树的存活标记推到最新（setAlive 只在变化时 fire）
      const entries = await store.load();
      // 键必须是**槽 id**：采样层内部就是 `sessionNameFor(id)`，而 v3 的 tmux
      // 会话名由**槽** id 派生（一个终端挂 N 个槽 = N 个 tmux 会话）。
      // 喂条目 id 的后果是：同一终端下只有「槽 id 恰好等于条目 id」的那一个
      // （迁移出来的、或本 Task 之前新建的）能对上，第 2 个起的会话**永远**
      // 采不到样 ⇒ 那一行的运行图标永远不转，且不报任何错 —— 静默、无测试能抓。
      const aliveIds = entries
        .flatMap((e) => e.sessions)
        .filter((s) => sessions.has(sessionNameFor(s.id)))
        .map((s) => s.id);
      await tracker.poll(aliveIds);
    } finally {
      activityInFlight = false;
    }
  };

  const restartActivityPolling = () => {
    if (activityTimer) clearInterval(activityTimer);
    activityTimer = undefined;
    if (view.visible) {
      activityTimer = setInterval(() => void pollActivity(), ACTIVITY_POLL_INTERVAL_MS);
    }
    void pollActivity();
  };

  // ---- 会话身份：reconcile 的触发点（见 spec §4.3 及其偏差记录）----
  // **六个**触发点：激活（本文件的末尾）、⟳ 刷新（下面的 refresh 命令）、
  // 点击条目（TerminalManager.openEntry）、切 profile
  // （TerminalManager.restartClaude）、展开树 / 面板变为可见（下面的订阅），
  // 以及**上面的 10 秒存活轮询**。
  // 最后一个推翻了 spec §4.3 的「不引入定时器」（该文件已记入偏差记录）：
  // `fresh` 首启（0.1.6）让「绑定」不再是权威事实 —— 条目预分配的 id 与
  // claude 实际开出来的 id 可能根本不是同一个，只能靠周期性观测把绑定纠回
  // 来；而原有五个触发点全是**用户动作**，用户"新建完就一直待在终端里、不碰
  // 侧边栏"时一个都不发。故挂在本来就存在的存活轮询上（它天然同受
  // `view.visible` 约束）。代价见上面 poll() 的说明。
  // 观测的驱动者只有这一处：provider 不持有 reconciler。
  let reconcileInFlight: Promise<boolean> | undefined;
  const reconcileNow = (): Promise<boolean> => {
    if (reconcileInFlight === undefined) {
      reconcileInFlight = (async () => {
        try {
          return await manager.reconcileAll(await store.load());
        } finally {
          reconcileInFlight = undefined; // 本轮结束才允许下一轮
        }
      })();
    }
    return reconcileInFlight;
  };

  context.subscriptions.push(
    view.onDidChangeVisibility((e) => {
      restartPolling();
      restartActivityPolling();
      // 面板变为可见 = reconcile 的触发点之一。onDidExpandElement 单独用
      // 不够：它的语义是「**由用户**展开时」，而 FolderTreeItem 默认就是
      // Expanded，默认展开的文件夹节点不会发那个事件 —— 这里兜底。
      // ★ 必须判 `e.visible`：这个事件在**隐藏**时也发一次，而一次 reconcile
      //   要跑 `tmux ls` + 每个活条目一次 display-message + 一次 prewarm。
      //   隐藏不需要新观测（面板都看不见），那是纯浪费。
      if (e.visible) void reconcileNow();
    }),
    // 用户展开节点（折叠后再展开 / 展开一个默认折叠的文件夹）= 触发点之一。
    // 刻意挂在事件上而不是 getChildren：900ms 的活动轮询会让根 getChildren
    // 每秒跑一次，挂在那里等于引入一个隐式定时器。
    view.onDidExpandElement(() => void reconcileNow()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tmuxTerminals')) restartPolling();
    }),
    tracker.onDidChange(() => provider.refresh()),
    new vscode.Disposable(() => {
      if (pollTimer) clearInterval(pollTimer);
      if (activityTimer) clearInterval(activityTimer);
    }),
  );
  restartPolling();
  restartActivityPolling();
  void reconcileNow(); // 触发点之一：扩展激活

  // ---- 命令注册 ----
  // 两种节点都可能进命令：二级（条目级操作）与三级（会话级操作）。**两者都
  // 暴露 `entry`**，所以「条目级设置」那几项（profile / 模型 / 颜色 / 参与恢复
  // / 复制 / 删除条目）不必分情况，统一取 `it.entry` 即可 —— 三级上的这些项
  // 转发到所属条目，正是 spec §7.5 要的语义。
  const item = (arg: unknown): EntryTreeItem | SessionTreeItem | undefined =>
    arg instanceof EntryTreeItem || arg instanceof SessionTreeItem ? arg : undefined;

  /** 会话级命令的守卫：只有三级才带槽，二级收到就什么都不做。 */
  const sessionItem = (arg: unknown): SessionTreeItem | undefined =>
    arg instanceof SessionTreeItem ? arg : undefined;

  const reg = (id: string, fn: (...a: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('tmuxTerminals.open', async (arg: unknown) => {
    const it = sessionItem(arg);
    if (it) {
      // 先清"刚完成待查看"标记再真正打开：用户点开就是"看到了"，
      // 图标应该立刻恢复，不用等下一轮 tmux 轮询。
      // 键是**槽 id**：活动采样层内部就是 `sessionNameFor(id)`，喂条目 id 会
      // 让这一行的绿点永远清不掉（且不报错）。
      tracker.markSeen(it.slot.id);
      await manager.openSession(it.entry, it.slot);
    }
  });

  reg('tmuxTerminals.add', async () => {
    await manager.addEntryInteractive();
    provider.refresh();
    batchProvider.refresh();
  });

  // 一级行尾的「+」：这一行**本身就是那个 cwd**（文件夹是 groupByCwd 按 cwd
  // 分出来的**虚拟**节点），所以它的语义是「在这个目录下建一个终端」—— 目录在
  // 这里不是待选项而是前提，**不再问**（从前的「预填但允许改」已经废弃：用户
  // 反馈过「点 + 还在问工作路径」）。
  // 拿不到 FolderTreeItem 时退回完整流程：这时没有任何文件夹可继承，只能问
  // 目录 —— 而这条命令的语义仍是「在这个目录下建」，只是那个目录无从得知。
  reg('tmuxTerminals.addInFolder', async (arg: unknown) => {
    if (arg instanceof FolderTreeItem) {
      await manager.addEntryInFolderInteractive(arg.cwd);
    } else {
      await manager.addEntryInteractive();
    }
    provider.refresh();
    batchProvider.refresh();
  });

  // 二级行尾的「+」：**零弹框**，只往该条目追加一个会话位（spec §7.4）。
  // 刻意不自动打开终端：「+」是「加一个会话位」，不是「立刻起一个 claude」——
  // 打开是紧接着点那一行的事，这样「+」没有任何副作用。
  reg('tmuxTerminals.addSession', async (arg: unknown) => {
    const it = arg instanceof EntryTreeItem ? arg : undefined;
    if (it) await manager.addSessionInteractive(it.entry);
    provider.refresh();
    batchProvider.refresh();
  });

  // 三级行尾的「X」：只杀 tmux 进程，**槽与对话绑定原样保留**（不变量 7）。
  // 这是「三级是接回会话的」能成立的前提：再点那一行就是 --resume 回同一条对话。
  reg('tmuxTerminals.closeSession', async (arg: unknown) => {
    const it = sessionItem(arg);
    if (it) await manager.closeSession(it.entry, it.slot);
    await poll();   // 会话没了 ⇒ 存活标记与图标必须跟着变
  });

  // 三级右键的「删除会话」：杀进程**并且**把槽连同绑定一起移除（判断 A）。
  // 与 X 的差别只有这一处 —— 用户在上面误删整个终端条目的代价太大，所以三级
  // 的破坏性动作只作用于这一个会话。
  reg('tmuxTerminals.deleteSession', async (arg: unknown) => {
    const it = sessionItem(arg);
    if (it) await manager.deleteSession(it.entry, it.slot);
    provider.refresh();
    batchProvider.refresh();
  });

  // 颜色是**条目级**属性（二级行首那条竖线），三级上点它同样转发到所属条目。
  reg('tmuxTerminals.setColor', async (arg: unknown) => {
    const it = item(arg);
    if (!it) return;
    await manager.setColorInteractive(it.entry);
    // 新颜色的 SVG 必须先落盘再刷新：图标路径是从 color 拼出来的、`iconFor`
    // 刻意不读盘，文件还没写就刷新只会画出一个空图标，且不报任何错。
    // 颜色值重新从 store 读，而不是用 `it.entry.color` —— 那个对象是渲染时的
    // 快照，`setColorInteractive` 写盘之后它并没有被就地更新。
    const fresh = (await store.load()).find((e) => e.id === it.entry.id);
    if (fresh?.color !== undefined) await colorIcons.ensure([fresh.color]);
    provider.refresh();
    batchProvider.refresh();
  });

  // ---- 以下都是**条目级**命令 ----
  // 三级菜单里也有其中几项（profile / 模型 / 颜色 / 参与恢复 / 复制），
  // 语义是「转发到所属终端、其下所有会话一起变」（spec §7.5 / 不变量 6）。
  // 统一取 `it.entry` 就自动满足了这一点：三级节点同时持有 slot 与 entry。
  // 三级上**没有** edit —— 三级这一行显示的是任务名，不给它改名。
  reg('tmuxTerminals.edit', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.editEntryInteractive(it.entry);
    provider.refresh();
    batchProvider.refresh();
  });

  reg('tmuxTerminals.duplicate', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.duplicateEntry(it.entry);
    provider.refresh();
    batchProvider.refresh();
  });

  reg('tmuxTerminals.delete', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.deleteEntry(it.entry);
    provider.refresh();
    // 批量面板的 prune 只在 getChildren 里跑，这里主动触发一次刷新，
    // 让被删条目的 id 从选中集合里立即剔除，避免对已删条目执行批量操作。
    batchProvider.refresh();
  });

  reg('tmuxTerminals.killSession', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.killSession(it.entry);
    await poll();
  });

  // 批量面板缓存自己的 entries 快照（entriesFor 读它），单条改动后不同步
  // 刷新，批量操作就会基于过期数据：batchSetModel 按旧 profile 取模型清单，
  // applyProfile 又会对「其实没切过」的条目提前返回。三者都需一并刷新。
  reg('tmuxTerminals.toggleAutoRestore', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.toggleAutoRestore(it.entry);
    provider.refresh();
    batchProvider.refresh();
  });

  // setModel 不 poll：改模型不改变会话存活状态，无需刷新存活标记
  //（setProfile 会重启会话，故需要 poll 刷新存活）。
  // 只改绑定，不动正在跑的会话 —— 因此不 poll、只是刷新 tooltip
  reg('tmuxTerminals.bindConversation', async (arg: unknown) => {
    // 绑定的主体是**会话槽**（v3），所以这条命令只挂在三级上。二级收不到它
    // （菜单矩阵里已经没有二级），真收到了也什么都不做：绑定是会话级的属性，
    // 二级上没有唯一答案，随便取第一个槽会改错对象。
    const it = sessionItem(arg);
    if (it) await manager.bindConversationInteractive(it.entry, it.slot);
    provider.refresh();
    batchProvider.refresh();
  });

  reg('tmuxTerminals.setModel', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.setModelInteractive(it.entry);
    provider.refresh();
    batchProvider.refresh();
  });

  reg('tmuxTerminals.setProfile', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.setProfileInteractive(it.entry);
    await poll();
    provider.refresh();
    batchProvider.refresh();
  });

  reg('tmuxTerminals.restoreAll', async () => {
    await manager.restoreAll();
    await poll();
  });

  reg('tmuxTerminals.refresh', async () => {
    await reconcileNow(); // 触发点之一：用户按 ⟳「只重查存活状态」
    await poll();
    provider.refresh();
  });

  // 内部命令：只由批量面板的 TreeItem.command 调用。已在 package.json 声明
  // （让「注册⇒声明」的清单校验覆盖它），但用 commandPalette 的 when:false
  // 从命令面板隐藏 —— 避免徒增噪音。
  reg('tmuxTerminals.batchToggle', (id: unknown) => {
    if (typeof id === 'string') batchProvider.toggle(id);
  });

  // 一级（`contextValue === 'batchFolder'`）的标题点击：一次切一整组。参数是
  // **渲染时算好的子 id 数组**，不是 cwd —— 让命令自己去 load 会开出一个时间窗：
  // 用户点了「全选」，补进来的却是这一瞬间刚被别处删掉的条目（SPEC §9.2）。
  // 因此 `batchFolder` 这一级不需要（也不该）有菜单项：它唯一的动作就是点击。
  reg('tmuxTerminals.batchToggleFolder', (ids: unknown) => {
    if (Array.isArray(ids) && ids.every((v) => typeof v === 'string')) {
      batchProvider.toggleFolder(ids as string[]);
    }
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
    const { models } = await readProfileConfig(targets[0].profile, manager.home());
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
}

export function deactivate(): void {
  if (pollTimer) clearInterval(pollTimer);
  if (activityTimer) clearInterval(activityTimer);
}
