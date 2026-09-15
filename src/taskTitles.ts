import { TAIL_BYTES, findConversationFile, readTail } from './conversationFiles';
import { parseAiTitle } from './core/conversation';

/** 缓存条目上限（超出按最久未访问逐出）—— 只为防条目数异常增长时无界占内存。 */
const MAX_ENTRIES = 256;

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
 * **去空白在缓存边界做。** `parseAiTitle` 的判空用 `trim()`、赋的却是原值，
 * 于是 `"  Foo  "` 会原样穿到这里；渲染层不该关心这种脏数据，缓存存的
 * 一律是 trim 过的值（顺带修掉「全空白」被当成有效标题缓存住的情况）。
 */
export class TaskTitleCache {
  private readonly cache = new Map<string, string>();
  /** 已在读、但还没落地的 key —— 防止同一拍内重复读盘。 */
  private readonly pending = new Set<string>();

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
    void this.load(conversationId, cwd);
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
