import { TAIL_BYTES, findConversationFile, readTail } from './conversationFiles';
import { parseAiTitle } from './core/conversation';

/** 缓存条目上限（超出按最久未访问逐出）—— 只为防条目数异常增长时无界占内存。 */
const MAX_ENTRIES = 256;

/**
 * 同一个 conversationId 两次「发起读盘」之间的最短间隔，`retryMissing` 用。
 *
 * **为什么必须有冷却**：`retryMissing` 挂在 10 s 一轮的存活轮询上。若每拍
 * 都重读，「一直不会生成 aiTitle 的会话」（比如用户开完就丢在那儿的 /new
 * 新对话）会被**无限**重读，而每次都是一个可能上 MB 的 transcript 尾部。
 * 25 s 让「新对话从建立到生成 aiTitle」的那几十秒窗口内最多重试几次
 * —— 足够覆盖，又不会把盘读爆。
 */
const RETRY_COOLDOWN_MS = 25_000;

/** 标题落地的通知回调。刻意不用 vscode.EventEmitter —— 本文件零 vscode 依赖。 */
export type TitleChangeListener = () => void;

/**
 * 订阅句柄。结构与 `vscode.Disposable` 兼容（调用方可以直接塞进
 * `context.subscriptions`），但本文件不 import vscode。
 */
export interface TitleSubscription {
  dispose(): void;
}

/**
 * `retryMissing` 的入参形状：只要「绑定对话 + cwd」两项。
 * 刻意**不**用 TerminalEntry：这个文件是纯逻辑（无 vscode、无 store），
 * 没必要为了一个重试入口把它耦合到条目结构上。
 */
export interface TitleSource {
  conversationId?: string;
  cwd: string;
}

/**
 * 绑定对话的 aiTitle 只读一次，缓存在内存里。
 *
 * **为什么不每次 poll 都读**：活动轮询是 900 ms 一轮，每轮为每个条目
 * tail-read 一个可能上 MB 的 transcript 是不可接受的。缓存在 **reconcile
 * 时**预热（那时本来就在查注册表），渲染路径只剩一次 Map 命中。
 *
 * **模型：异步预取 + 同步 peek。** `prewarm` 只发起后台读、立即返回；
 * `peek` 是纯内存查表，命中即返回、未命中返回 `undefined`，绝不阻塞读盘。
 *
 * **失效与容量**：
 * - 读不到**不写缓存** —— /new 之后新对话要过几个来回才生成 aiTitle，
 *   把它当成「没有」缓存住会让第三级永远不出现；下次 prewarm 重试。
 * - 键 = conversationId：条目改绑后 peek 自然落到新键上 miss 并触发一次
 *   新 prewarm，旧键随容量逐出，不需要显式失效。
 * - 无持久化：进程退出即清空。
 *
 * **「下次 prewarm」由 `retryMissing` 保证。** prewarm 的调用点全在
 * reconcile（点击 / ⟳ / 切 profile / 恢复 / 激活 / 展开 / 可见），清一色是
 * **用户动作** —— 没有新观测时 reconcile 什么都不做。于是「/new 之后那条新
 * 对话在第一次 prewarm 时还没有 aiTitle」就再也没人重读了，第三级永久消失。
 * `retryMissing` 补上「时间」这个触发维度（见其注释）。
 *
 * **写入会通知订阅者**（`onDidChangeTitle`）：标题是异步落地的，而渲染层
 * 是同步 peek —— 没有通知，即使后来读到了名字，树也不会重算
 * （二级的 `collapsibleState` 停在 `None`，第三级不会自动出现）。
 *
 * **去空白在缓存边界做。** `parseAiTitle` 的判空用 `trim()`、赋的却是原值，
 * 于是 `"  Foo  "` 会原样穿到这里；渲染层不该关心这种脏数据，缓存存的
 * 一律是 trim 过的值（顺带修掉「全空白」被当成有效标题缓存住的情况）。
 */
export class TaskTitleCache {
  private readonly cache = new Map<string, string>();
  /** 已在读、但还没落地的 key —— 防止同一拍内重复读盘。 */
  private readonly pending = new Set<string>();
  /**
   * 读盘尝试时间表：conversationId → 上次发起读的 `Date.now()`。
   * `retryMissing` 的冷却依据，prewarm 与 retryMissing **共用这一份记录**
   * （两条路径都算「刚刚读过」，否则用户点一下条目就能绕过冷却重复读）。
   */
  private readonly lastAttempt = new Map<string, number>();
  /** 已订阅的监听者。本文件不依赖 vscode，所以自己维护回调数组。 */
  private readonly listeners: TitleChangeListener[] = [];
  /** 本拍是否已经排了一次通知 —— coalesce 用，见 scheduleNotify。 */
  private notifyScheduled = false;

  /**
   * @param home 定位 `~/.claude/projects`；与 `TerminalManager.home()` 同源。
   * @param readTitle 读一条 transcript 尾部并取 aiTitle。省略时用默认实现
   *   （findConversationFile → readTail → parseAiTitle）。以参数注入是为了：
   *   单测注入假 reader 断言「读不到不缓存、下次 prewarm 重试」。
   */
  constructor(
    private readonly home: string,
    private readonly readTitle?: (conversationId: string, cwd: string) => Promise<string | undefined>,
  ) {}

  /** 同步读缓存。未缓存 / 传 undefined → undefined。渲染路径上唯一被调用的方法。 */
  peek(conversationId: string | undefined): string | undefined {
    if (conversationId === undefined || conversationId.length === 0) return undefined;
    const hit = this.cache.get(conversationId);
    if (hit === undefined) return undefined;
    // LRU：命中即移到队尾（最久未访问的排在最前，逐出时取第一个）
    this.cache.delete(conversationId);
    this.cache.set(conversationId, hit);
    return hit;
  }

  /**
   * 异步预取，**fire-and-forget**（返回 void，不是 Promise）。
   * 已缓存 / 已在读则直接返回；否则在后台读盘，读回后写入缓存。
   * `cwd` 必需 —— findConversationFile 要按 id + cwd 精确定位
   * （同一 id 可能出现在多个 project 目录下）。
   */
  prewarm(conversationId: string | undefined, cwd: string): void {
    if (conversationId === undefined || conversationId.length === 0) return;
    if (this.cache.has(conversationId) || this.pending.has(conversationId)) return;
    this.pending.add(conversationId);
    this.noteAttempt(conversationId);
    void this.load(conversationId, cwd);
  }

  /**
   * 轮询节拍上的**低频重试**：对「已绑定但还没缓存到标题」的对话重新发起
   * 预取。`prewarm` 覆盖不到的那条时间线由它兜底 —— 第一次读的时机太早
   * （transcript 里还没有 aiTitle），之后不会再有用户动作来触发重读。
   *
   * 仍守既有两条语义：读不到不写缓存（`load` 保证）、同一拍内不重复读
   * （`pending` 保证）。
   *
   * 冷却按 conversationId **独立**：一个还在冷却不影响另一个立刻重试
   * —— 每个新对话各有各的生成窗口，不能互相拖累。
   *
   * 调用方不必自己去重/查缓存，全在这里面（传全量条目即可，成本只是几次
   * Map 查询）。
   */
  retryMissing(sources: readonly TitleSource[]): void {
    const now = Date.now();
    for (const source of sources) {
      const id = source.conversationId;
      if (id === undefined || id.length === 0) continue;
      const last = this.lastAttempt.get(id);
      if (last !== undefined && now - last < RETRY_COOLDOWN_MS) continue;
      this.prewarm(id, source.cwd);
    }
  }

  /**
   * 订阅「一条新标题落地」。返回句柄结构上兼容 `vscode.Disposable`，但本
   * 文件不 import vscode（渲染层负责把它接到刷新上，见 tree.ts）。
   */
  onDidChangeTitle(listener: TitleChangeListener): TitleSubscription {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
      },
    };
  }

  /**
   * 记一次「读盘尝试」。prewarm 与 retryMissing 共用这一处记录 —— 无论触发
   * 源是用户动作还是轮询重试，都算「刚刚读过」，冷却表因此天然一致。
   *
   * 容量沿用 cache 的 LRU + MAX_ENTRIES 思路，防条目数异常增长。被逐出的
   * 只是冷却记录：该 id 下次重试会立即发起一次读（安全侧，只是多读一次，
   * 不会漏掉任何标题）。
   */
  private noteAttempt(conversationId: string): void {
    this.lastAttempt.delete(conversationId); // 重新置到队尾（LRU）
    this.lastAttempt.set(conversationId, Date.now());
    while (this.lastAttempt.size > MAX_ENTRIES) {
      const oldest = this.lastAttempt.keys().next().value;
      if (oldest === undefined) break;
      this.lastAttempt.delete(oldest);
    }
  }

  /**
   * 合并同一拍内的多次写入，**一拍最多通知一次**。
   *
   * 一次通知 = 渲染层重建整棵树（`getChildren` 全量重跑）。10 条标题在同一
   * 拍里先后落地时逐个通知就是 10 次整树重建 —— 纯浪费，所以用 microtask
   * 把它们并成一次。
   *
   * 用 microtask 而不是 `setTimeout(0)`：读盘落地本来就在微任务链上，
   * microtask 天然排在「本拍所有已落地的写入」之后，既不引入新的宏任务
   * 时序，单测里 `await` 一次也就能稳定观察到（不必碰假定时器）。
   */
  private scheduleNotify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      // 快照一份再遍历：监听者若在回调里退订，不该影响本次遍历
      for (const listener of [...this.listeners]) listener();
    });
  }

  private async load(conversationId: string, cwd: string): Promise<void> {
    try {
      const title = await this.read(conversationId, cwd);
      const trimmed = title?.trim();
      if (trimmed !== undefined && trimmed.length > 0) {
        this.cache.set(conversationId, trimmed);
        while (this.cache.size > MAX_ENTRIES) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cache.delete(oldest);
        }
        // ★ 变化通知的**唯一**触发点：读不到 / 读盘失败 / peek 命中都不发
        //   （后两者不写缓存），否则每次渲染或轮询都会刷一次树。
        //   刻意不做「值是否真的变了」的比对：能走到这里必然是一次 cache
        //   miss 上的成功读盘（prewarm 有 cache.has 守卫），此刻这个键在缓存
        //   里**没有**值，写入即用户可见的变化。真正「同一个键重复写入同一个
        //   值」只可能出现在「先被容量逐出、再读回」，属罕见路径，不值得为
        //   它维护一份能扛逐出的历史值表 —— 那次多出来的一次整树重建无害。
        this.scheduleNotify();
      }
      // 读不到 → 什么都不写，下次 prewarm 会重试
    } catch {
      // 读盘失败 → 当作读不到（安全侧：不显示第三级），下次重试
    } finally {
      this.pending.delete(conversationId);
    }
  }

  private async read(conversationId: string, cwd: string): Promise<string | undefined> {
    if (this.readTitle !== undefined) return this.readTitle(conversationId, cwd);
    const file = await findConversationFile(this.home, conversationId, cwd);
    if (file === undefined) return undefined;
    return parseAiTitle(await readTail(file, TAIL_BYTES));
  }
}
