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
import { Log } from './log';

let pollTimer: NodeJS.Timeout | undefined;
let activityTimer: NodeJS.Timeout | undefined;

/** 活动轮询节奏——比会话存活轮询（默认 10s，见 pollInterval 配置）快得多，
 * 因为它驱动的是"运行中徽章闪烁"这种需要看起来鲜活的 UI 效果，不是配置项，
 * 用户不需要也不应该去调它。 */
const ACTIVITY_POLL_INTERVAL_MS = 900;

/**
 * 到点就 reject；原 promise 继续跑，只是不再被等。
 *
 * **为什么要有它**：轮询的闸门（`inFlight`）只在 promise settle 时才释放，
 * 一次卡住的 tmux 调用会让闸门永久停在 true、轮询从此静默停摆 —— 表面看
 * 「面板还活着但什么都不动」。加了这层超时，闸门最多被占住 `ms` 毫秒，
 * 之后无论原调用是否回来都会照常释放。
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}超时：${ms}ms 内未返回`)),
      ms,
    );
  });
  // 正常返回（或原 promise 先 reject）时要把这个定时器清掉，否则每拍都留下
  // 一个悬着的定时器，白白吊住事件循环。
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 把一个命令实参压成可读的「形状」。
 *
 * **为什么值得单独记**：`item(arg)` / `sessionItem(arg)` 用的是 `instanceof`，
 * 判错时命令会**静默什么都不做**。只有把实参形状打出来，才分得出是
 * 「命令压根没进来」还是「进来了但守卫没命中」。
 */
function describeArg(a: unknown): string {
  if (a === undefined) return 'undefined';
  if (typeof a === 'string') return 'string';
  const name = (a as { constructor?: { name?: string } } | null)?.constructor?.name;
  return name ?? 'object';
}

/**
 * 真正的激活逻辑。**由文件末尾的 `activate()` 用 try/catch 包一层后调用**。
 *
 * 为什么要包这一层：`activate` 一旦抛异常，**所有命令都不会注册**，而树视图
 * 已经建好了 —— 表现出来正是「面板看得见、点什么都没反应」，且完全静默。
 * 包一层之后，异常会被记进日志并弹给用户，不再是无声失败。
 */
function activateInner(context: vscode.ExtensionContext, log: Log): void {
  const activateStarted = Date.now();
  const cfg = () => vscode.workspace.getConfiguration('tmuxTerminals');

  const storageFile = (): string => {
    const override = cfg().get<string>('storagePath', '').trim();
    return override.length > 0
      ? override
      : path.join(context.globalStorageUri.fsPath, 'terminals.json');
  };

  const tmux = new TmuxClient(cfg().get<string>('tmuxPath', 'tmux'));
  // 先把**实际生效的配置**记下来：配置写错（典型是 tmuxPath 指错）时现在的
  // 表现是「静默什么都没有」—— 没有任何一处会报错，只有把这几项打出来，
  // 才分得清是「配置没读到」还是「读到了但命令全失败」。
  log.info(
    `生效配置：tmuxPath=${cfg().get<string>('tmuxPath', 'tmux')}` +
    `，pollInterval=${cfg().get<number>('pollInterval', 10000)}` +
    `，storageFile=${storageFile()}`,
  );
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
  // 第三个参数启用落盘：宿主重建后标题缓存清零会让三级行全回落「无会话」，
  // 落一份盘、启动时 restore() 把这条回填时间线缩到零。
  const titles = new TaskTitleCache(
    os.homedir(),
    undefined,
    path.join(context.globalStorageUri.fsPath, 'task-titles.json'),
  );
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

  // 宿主每次重建都会清空内存里的标题缓存，而回填要等轮询 + `view.visible`
  // 两道闸 —— 攒不起来时三级行就长期全是「无会话」。restore() 把上次落盘的
  // 标题立刻读回来，这条时间线缩到零。**必须放在 provider 之后**：恢复完要
  // 刷新一次树。restore() 自己吞异常，这里的 catch 只是兜底。
  void titles
    .restore()
    .then(() => {
      provider.refresh();
      log.info('标题缓存已从磁盘恢复');
    })
    .catch(() => {
      // 忽略：restore() 内部已吞掉一切失败，这里只是兜底未处理 rejection。
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
  // 成功路径只记**一行**（会话数/条目数/耗时），所以把这两个计数留在函数体
  // 外面给外层用；计数本身不参与任何逻辑。
  let lastPollSessions = 0;
  let lastPollEntries = 0;

  // 原轮询函数体**原样搬进来**：setAlive / store.load / reconcileAll /
  // retryTitles 的调用顺序与参数都不变，只是外面套了一层超时与闸门管理。
  const runPollBody = async () => {
    const sessionList = await tmux.listSessions();
    lastPollSessions = sessionList.length;
    provider.setAlive(new Set(sessionList));
    const entries = await store.load();
    lastPollEntries = entries.length;
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
  };

  const poll = async () => {
    if (inFlight) return; // 上一轮还没回来就跳过，避免请求堆积
    inFlight = true;
    const started = Date.now();
    try {
      // 超时值 15s：存活轮询默认 10s 一拍，要给正常一拍留足余量，同时必须
      // **小于会让人以为是「卡死」的那个时长**。超时后 finally 仍会释放闸门，
      // 不会像从前那样让一次卡住的调用把 inFlight 永久停在 true。
      await withTimeout(runPollBody(), 15_000, '存活轮询');
      log.info(
        `存活轮询完成：会话 ${lastPollSessions} 个、条目 ${lastPollEntries} 条，` +
        `耗时 ${Date.now() - started}ms`,
      );
    } catch (err) {
      log.error(`存活轮询失败，耗时 ${Date.now() - started}ms`, err);
    } finally {
      inFlight = false; // 一定释放：无论成功、失败还是超时
    }
  };

  const restartPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    const interval = cfg().get<number>('pollInterval', 10000);
    if (interval > 0 && view.visible) {
      pollTimer = setInterval(() => void poll(), interval);
      log.info(`存活轮询已启动：间隔 ${interval}ms`);
    } else {
      // **关键诊断**：`view.visible` 若长期为 false，两个定时器都不会装，
      // 采样永远攒不起来 —— 外表看就是「一直无会话」。
      log.info(
        `存活轮询未启动：pollInterval=${interval}（<=0 = 关闭）` +
        `，view.visible=${view.visible}`,
      );
    }
    void poll();
  };

  // ---- 活动状态轮询（运行中/刚完成的徽章与图标，见 activityTracker.ts）----
  // 独立于上面的存活轮询：节奏快得多（900ms vs 默认 10s），且只在面板
  // 可见时跑——这是纯视觉效果，不可见时没有意义轮询，白白多发 tmux 命令。
  let activityInFlight = false;
  let lastActivitySessions = 0;
  let lastActivitySlots = 0;

  /**
   * 活动轮询成功日志的节流状态。
   *
   * **为什么不能每拍都写**：这一拍是 900ms 一拍（ACTIVITY_POLL_INTERVAL_MS），
   * 一小时 ≈ 4000 拍 —— 每拍一行会把 Output 面板冲成废纸，真出问题时要找的
   * 那几行正好被淹没。存活轮询是 10s 一拍，每拍一行没问题，那条路径保持不动。
   *
   * `activityTick` 每拍自增；`prevActivitySessions` / `prevActivitySlots` 是
   * **上一拍**的计数快照 —— `lastActivitySessions` / `lastActivitySlots` 每拍
   * 都被 runActivityPollBody 就地覆盖，不留快照就永远比不出「变了」。
   */
  let activityLoggedOnce = false;
  let activityTick = 0;
  let prevActivitySessions = 0;
  let prevActivitySlots = 0;

  /** 心跳间隔：900ms × 60 ≈ 54 秒一条，用来回答「轮询还活着吗」。 */
  const ACTIVITY_LOG_HEARTBEAT_TICKS = 60;

  /**
   * 这一拍成功要不要写日志。三种情况之一才写：
   *   1. 本拍计数与上一拍不同 —— 有变化才值得记；
   *   2. 这是第一拍成功 —— 冷启动时要看得到它确实跑起来了；
   *   3. 距离上次成功日志已过 60 拍（≈54 秒）—— 一条心跳。
   * 都不满足就静默：900ms × 4000 行/小时会把面板冲爆。
   */
  const shouldLogActivity = (): boolean => {
    activityTick += 1;
    const first = !activityLoggedOnce;
    const changed =
      lastActivitySessions !== prevActivitySessions ||
      lastActivitySlots !== prevActivitySlots;
    const heartbeat = activityTick >= ACTIVITY_LOG_HEARTBEAT_TICKS;
    // 先快照本拍计数，供下一拍比较。
    prevActivitySessions = lastActivitySessions;
    prevActivitySlots = lastActivitySlots;
    if (!first && !changed && !heartbeat) return false;
    // 写过一条就把心跳计时清零：心跳的语义是「距离上次成功日志」。
    activityLoggedOnce = true;
    activityTick = 0;
    return true;
  };

  // 同上：原函数体原样搬进内部函数，只在外层补超时与闸门管理。
  const runActivityPollBody = async () => {
    // 闸门必须来自**权威的 tmux 查询**，不能用 provider.isAlive：后者由
    // 10s 的存活轮询填充，而 poll() 有 inFlight 守卫 —— 激活时两个
    // restart* 并发启动，pollActivity 刚跑时第一次 listSessions 还没回来，
    // 于是第一轮 aliveIds 恒为空、一个条目都不采（实测症状）。
    const sessionList = await tmux.listSessions();
    lastActivitySessions = sessionList.length;
    const sessions = new Set(sessionList);
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
    lastActivitySlots = aliveIds.length;
    await tracker.poll(aliveIds);
  };

  const pollActivity = async () => {
    if (activityInFlight) return;
    activityInFlight = true;
    const started = Date.now();
    try {
      // 超时值 8s：活动轮询节奏是 900ms，正常一拍远快于此，给足余量；而它
      // 又必须**小于会让人以为是「卡死」的那个时长**。超时即跳过本拍，
      // finally 释放闸门，下一拍照常跑。
      await withTimeout(runActivityPollBody(), 8_000, '活动轮询');
      // 成功路径按 shouldLogActivity() 节流：900ms 一拍、每拍一行会把面板冲爆。
      if (shouldLogActivity()) {
        log.info(
          `活动轮询完成：会话 ${lastActivitySessions} 个、采样槽 ${lastActivitySlots} 个，` +
          `耗时 ${Date.now() - started}ms`,
        );
      }
    } catch (err) {
      log.warn(
        `活动轮询失败/超时，跳过本拍，耗时 ${Date.now() - started}ms：` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      activityInFlight = false; // 一定释放：无论成功、失败还是超时
    }
  };

  const restartActivityPolling = () => {
    if (activityTimer) clearInterval(activityTimer);
    activityTimer = undefined;
    if (view.visible) {
      activityTimer = setInterval(() => void pollActivity(), ACTIVITY_POLL_INTERVAL_MS);
      log.info(`活动轮询已启动：间隔 ${ACTIVITY_POLL_INTERVAL_MS}ms`);
    } else {
      // 关键诊断：与 restartPolling 同理，visible=false 时这拍根本不装。
      log.info(`活动轮询未启动：view.visible=${view.visible}`);
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
      // 可见性是两个定时器启停的唯一开关，记下来才能对上「为什么没采样」。
      log.info(`面板可见性变化：visible=${e.visible}`);
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
      // 两个轮询都要重启：只重启存活轮询的话，活动轮询会继续按旧节奏跑，
      // 且面板可见性若因此变化也接不上 —— 视觉徽章会停在旧状态。
      if (e.affectsConfiguration('tmuxTerminals')) {
        restartPolling();
        restartActivityPolling();
      }
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

  // 已注册命令条数：激活收尾要汇总，用来核对「注册⇒声明」清单是否齐全 ——
  // 若 activate 在注册之前抛了，这个数就是 0，正好对上「点什么都没反应」。
  let commandCount = 0;

  const reg = (id: string, fn: (...a: any[]) => any): void => {
    commandCount += 1;
    // 每个命令都包一层观测：进入时记 id + **实参形状**，正常返回记耗时，
    // 抛异常记 id + 耗时 + 异常并提示用户去哪看日志，然后原样 rethrow。
    //
    // 实参形状是这条日志的全部价值：`item(arg)` / `sessionItem(arg)` 用的是
    // `instanceof`，判错时命令会**静默什么都不做** —— 只有把实参形状记下来，
    // 才分辨得出「命令压根没进来」还是「进来了但守卫没命中」。
    const wrapped = async (...a: any[]): Promise<any> => {
      const started = Date.now();
      log.info(`命令 ${id} 进入，实参形状=[${a.map(describeArg).join(', ')}]`);
      try {
        const result = await fn(...a);
        log.info(`命令 ${id} 完成，耗时 ${Date.now() - started}ms`);
        return result;
      } catch (err) {
        log.error(`命令 ${id} 失败，耗时 ${Date.now() - started}ms`, err);
        void vscode.window.showErrorMessage(
          `命令 ${id} 执行失败。详见「输出 → TMUX 终端」。`,
        );
        throw err;
      }
    };
    // 返回值刻意丢弃（调用点都没有用）：reg 返回 void。
    context.subscriptions.push(vscode.commands.registerCommand(id, wrapped));
  };

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

  // 激活收尾汇总。**放在真正的最末尾**（而不是三行轮询启动之后）：命令是
  // 在这之后才逐个注册的，只有到这里 commandCount 才是完整值 —— 它正是
  // 「面板看得见但点不动」的核心判据（0 条 = activate 在注册前就抛了）。
  // 配合 view.visible（决定两个定时器是否真装上）与总耗时，这一行足够判断
  // 失效到底卡在注册、可见性还是耗时上。
  log.info(
    `激活完成：已注册命令 ${commandCount} 条` +
    `，view.visible=${view.visible}` +
    `，总耗时 ${Date.now() - activateStarted}ms`,
  );
}

/**
 * 扩展入口。**只负责把 activateInner 包进 try/catch** —— 见 activateInner
 * 上方注释：它一旦抛异常，所有命令都不会注册，而树视图已经建好了，用户
 * 看到的就是「面板看得见、点什么都没反应」且完全静默。这里把那种静默
 * 变成一条日志 + 一个可见的错误提示，再原样抛出（让 VS Code 也记录一次）。
 */
export function activate(context: vscode.ExtensionContext): void {
  const log = new Log();
  context.subscriptions.push(log);
  log.info('扩展激活开始');
  try {
    activateInner(context, log);
  } catch (err) {
    log.error('激活失败：所有命令都不会注册 —— 面板会「看得见但点不动」，就是这里', err);
    void vscode.window.showErrorMessage(
      '终端插件激活失败，所有按钮都会失效。详见「输出 → TMUX 终端」。',
    );
    throw err;
  }
}

export function deactivate(): void {
  if (pollTimer) clearInterval(pollTimer);
  if (activityTimer) clearInterval(activityTimer);
}
