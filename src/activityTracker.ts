import { PaneSample, isRunningTitle, sessionNameFor, taskNameFromSample } from './core/tmux';
import { EntryActivity, markSeen, nextActivity } from './core/activity';

/**
 * ActivityTracker 需要的最小 tmux 能力——按**会话槽 id** 派生出的 session 名，
 * **一次**读回前台进程名、pane title 与 pane 尺寸三个信息（尺寸含宽高两个字段），
 * 另外单独读回 pane 的**可视内容**（用来判「这一轮内容有没有变」，见下面的
 * ACTIVITY_WINDOW_MS）。
 *
 * `capturePane` 与 `paneSample` 是两次独立调用：前者拿内容做差分，后者拿 title
 * 走老版本的兼容判据与任务名闸门、拿尺寸识别 resize 重排，两者语义不同、不能合并。
 */
export interface PaneSampleReader {
  paneSample(session: string): Promise<PaneSample>;
  /** 抓取该 pane 可视区域的文本（TmuxClient 已有同名同签名方法，结构化类型自动满足）。 */
  capturePane(session: string): Promise<string>;
}

/**
 * 「内容在变 ⇒ 在运行」这个判据的时间窗（毫秒）。
 *
 * **为什么不能只看「这一轮内容没变就判空闲」：** 轮询间隔是 ≈900 ms，而执行中的
 * pane 内容变化**不是每秒都有**（实测有的状态行约 4–6 秒才变一次）。若直接把
 * 「本轮没变」当成「不运行」，正在跑的槽会在两个采样点之间来回跳成 idle —— 用户
 * 看到的就是绿点/转圈反复抖动。所以判据是「**最近 activityWindowMs 内变过**」，
 * 一次变化能把这个槽「照亮」一整个窗口。
 */
export const ACTIVITY_WINDOW_MS = 5000;

/**
 * pane 尺寸变化后的「静默期」（毫秒）。
 *
 * 光看「尺寸变了 ⇒ 这一轮不算活动」不够：client resize 之后 tmux 先重排，
 * 应用（claude 的 TUI）收到 SIGWINCH 还会**再重绘一次**，这一轮尺寸已经稳定、
 * 但内容仍在变 —— 照旧会把它判成「在运行」，5 秒后转成绿色的
 * 「已完成未查看」。所以尺寸一变就进入静默期：期内**只刷新内容基线、
 * 不产生活动判定**，出静默期后基线已对齐重绘后的内容，不会再有假信号。
 *
 * 拖拽窗口时尺寸每个 tick 都在变，静默期会被逐轮顺延，整个拖拽过程都不误报。
 */
export const RESIZE_SETTLE_MS = 2000;

/**
 * 轮询一批「存活**会话槽**」的 tmux pane 采样（前台进程名 + pane title + pane
 * 内容），推进每个槽的活动状态机（见 core/activity.ts）。
 *
 * **「在不在运行」的主判据是 pane 内容差分，不是 pane title。** 2026-10-12 实测：
 * 22 个 `tmuxterm-*` 会话、30 秒内 13059 轮采样 / 287298 次读取，pane title 首字符
 * **恒为 `✳`(U+2733)，Braille 分区命中 0 次** —— 新版本 claude 的 title 不再轮转
 * （`isRunningTitle` 只能作为老版本的兼容判据保留，见 core/tmux.ts）。可用的信号
 * 是 pane **可见内容是否在变**：8 秒窗口里真在执行的 pane 内容有变化，空闲的
 * 变化行数恒为 0，区分度干净。内容差分的窗口语义见 ACTIVITY_WINDOW_MS。
 *
 * **窗口 resize 不是活动，单独识别。** 22 个 pane 尺寸相同时，一次窗口 resize 会让
 * tmux 把它们**一起重排**，`capture-pane` 的输出**同一轮里全变**——照内容差分会被
 * 判成 22 个会话同时「在跑」。所以尺寸（PaneSample.width/height）走**独立**的一条
 * 判定：尺寸一变就进入 RESIZE_SETTLE_MS 静默期，**不经过内容差分**。
 *
 * **采样层就地把闸门做掉：前台不是 claude ⇒ 任务名为空串。** 这一层是唯一能
 * shell out 的地方（tree.ts 的 taskNameFor 是同步纯读、在渲染路径上），
 * 见 core/tmux.ts 的 taskNameFromSample 与 spec §10/§11。
 *
 * 刻意不依赖 vscode：只依赖一个「读一次采样」的最小接口（结构类型，
 * TmuxClient 天然满足），方便直接用 mocha 单测。
 */
export class ActivityTracker {
  private listeners: Array<() => void> = [];
  private state = new Map<string, EntryActivity>();

  /**
   * 上一轮每个槽的 pane 内容（差分基线）。
   *
   * **槽消失时，state 连同下面四个基线 Map（lastContent / lastChangeAt /
   * lastGeometry / lastResizeAt）必须一起删键 —— 共五个。** 任何一个残留都会让
   * 槽重建后的首次观测被当成「刚变过」或「刚 resize 过」：残留内容基线 ⇒ 凭空
   * 判成运行中；残留 lastResizeAt ⇒ 凭空进入静默期。表现都是刚点开一个新槽就
   * 显示不对。
   */
  private lastContent = new Map<string, string>();
  /** 每个槽**最后一次观测到内容变化**的时刻（Date.now()）；窗口判据用它。 */
  private lastChangeAt = new Map<string, number>();
  /** 每个槽上一轮观测到的 pane 尺寸；用于识别「内容变化其实是 resize 重排」。 */
  private lastGeometry = new Map<string, { width: number; height: number }>();
  /** 每个槽**最后一次观测到尺寸变化**的时刻（Date.now()）；静默期判据用它。 */
  private lastResizeAt = new Map<string, number>();

  /**
   * @param tmux 采样能力（结构类型，TmuxClient 天然满足）。
   * @param activityWindowMs 「最近这么久内内容变过 ⇒ 在运行」的窗口；默认
   *   ACTIVITY_WINDOW_MS。传 0 表示窗口恒过期，即**只有本轮观测到内容变化的
   *   那一次**判运行 —— 本轮变化由 `justChanged` 兜住、不受窗口影响（单测据此
   *   零 sleep 地复现「变化那轮 running、下一轮落回」）。
   * @param resizeSettleMs 尺寸变化后的静默期（毫秒）；默认 RESIZE_SETTLE_MS。
   *   传 0 表示静默期恒过期，即**尺寸变化那一轮之后立刻恢复判定** —— 单测据此
   *   零 sleep 地验证「静默期会结束」（不是把静默期做成永久静默）。
   */
  constructor(
    private readonly tmux: PaneSampleReader,
    private readonly activityWindowMs: number = ACTIVITY_WINDOW_MS,
    private readonly resizeSettleMs: number = RESIZE_SETTLE_MS,
  ) {}

  /** 注册变化监听；返回的对象用于取消订阅。 */
  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  }

  private fire(): void {
    for (const l of this.listeners) l();
  }

  activityFor(sessionId: string): EntryActivity | undefined {
    return this.state.get(sessionId);
  }

  /** 用户点开会话查看：done-unseen → idle。状态确实变了才触发一次通知。 */
  markSeen(sessionId: string): void {
    const cur = this.state.get(sessionId);
    if (cur === undefined) return;
    const next = markSeen(cur);
    if (next !== cur) {
      this.state.set(sessionId, next);
      this.fire();
    }
  }

  /**
   * 轮询一批存活**会话槽**的 id（是否存活由调用方判定，这里不重复判断，
   * 只管在给定的这批 id 上各读一次采样）。
   *
   * **入参必须是槽 id，不是条目 id**：下面就是拿它直接 `sessionNameFor(id)`
   * 去采样的，而 v3 的 tmux 会话名由槽 id 派生。传条目 id 的后果是「同一
   * 终端下只有槽 id 恰好等于条目 id 的那一个能对上，其余永远采不到样」——
   * 表现只是那一行的运行图标永远不转，静默、无报错。参数名从
   * `aliveEntryIds` 改成 `aliveSessionIds` 就是为了让下一个读者看得出来。
   *
   * 已死亡（不在 aliveSessionIds 里）的槽直接从状态表里删掉——下次它
   * 再出现按「首次观测」处理，不会凭空冒出一次「刚运行完」
   * （见 core/activity.ts 顶部注释里的不变量）。
   *
   * **只有这一轮真的改变了状态表才触发变化通知**（删掉了槽，或某个
   * 槽的 state / taskName 与旧值不同）；什么都没变就不通知。订阅方
   * （extension.ts 里接的是整树重建）只关心变化——从前无条件通知，采样
   * 循环每 ≈900 ms 跑一轮，就退化成每 ≈900 ms 一次零变化的整树重建，
   * 表现为侧边栏标题栏上永不消失的进度条。
   *
   * 判断必须**按值**比较 state / taskName 两个字段：nextActivity 每次
   * 都返回**新对象**，`prev !== next` 恒为真（见 core/activity.ts 该函数
   * 注释），照那样写会退化成"每轮无条件通知"。
   *
   * `running` 的判据是「**最近 activityWindowMs 内 pane 内容变过**」（或
   * `isRunningTitle(title)` 命中 —— 老版本 claude 的兼容项，零成本保留）。
   * 首次观测（`lastContent` 里没有这个槽）**不算变过**，不判运行 —— 否则刚
   * 点开一个新槽就会显示成「运行中」。
   *
   * **本轮亲眼观测到的变化（`justChanged`）单独取出来、不经过时间窗。** 窗口
   * 是用来把**一次变化照亮后面若干轮**的（见 ACTIVITY_WINDOW_MS），不该反过来
   * 把「刚刚亲眼看到变化」的那一轮判否。加上 `justChanged` 之后
   * `activityWindowMs = 0` 的语义才自洽 —— 表示「只有亲眼看到变化的那一轮算
   * 运行」，而不是「永远不运行」。
   */
  async poll(aliveSessionIds: readonly string[]): Promise<void> {
    let changed = false;
    const now = Date.now();

    const aliveSet = new Set(aliveSessionIds);
    for (const id of [...this.state.keys()]) {
      if (!aliveSet.has(id)) {
        this.state.delete(id);
        // 五个 Map 必须一起清：残留的内容基线会把槽重建后的首次观测当成
        // 「刚变过」、残留的 lastResizeAt 会凭空触发静默期 —— 都表现为
        // 刚点开一个新槽就显示不对（运行中转圈 / 该转的不转）。
        this.lastContent.delete(id);
        this.lastChangeAt.delete(id);
        this.lastGeometry.delete(id);
        this.lastResizeAt.delete(id);
        changed = true; // 槽消失也是变化
      }
    }

    if (aliveSessionIds.length > 0) {
      // 两个字段各一次并发调用（每个槽共 2 次 tmux 调用）。内容差分需要 pane
      // 的可视内容，title 仍要拿（任务名闸门 + 老版本兼容判据），二者不能合并。
      // 用 Promise.all 并发：采样循环每 ≈900 ms 跑一轮，串行会让这一层的
      // 耗时随槽数线性叠加。
      const samples = await Promise.all(
        aliveSessionIds.map((id) => this.tmux.paneSample(sessionNameFor(id))),
      );
      const contents = await Promise.all(
        aliveSessionIds.map((id) => this.tmux.capturePane(sessionNameFor(id))),
      );
      aliveSessionIds.forEach((id, i) => {
        const s = samples[i];
        const content = contents[i];

        // —— 几何判定（resize）——
        // 只有宽高都已知（>0）才参与：display-message 静默失败时宽高是 0，
        // 「未知」不能当坐标用。完全跳过 —— 既不比对、也不写回、也不设静默期，
        // 退化成纯内容差分。尤其别写回一个假的 0x0：下一轮真几何回来会把
        // 「0x0 → 真尺寸」误判成一次 resize。
        if (s.width > 0 && s.height > 0) {
          const prevGeom = this.lastGeometry.get(id);
          if (prevGeom !== undefined && (prevGeom.width !== s.width || prevGeom.height !== s.height)) {
            // 尺寸变了 ⇒ 本轮很可能是 resize 重排，不是应用在跑。进入静默期。
            this.lastResizeAt.set(id, now);
          }
          // 首次观测（prevGeom 不存在）不算 resize：否则刚新建的槽会被无谓静默。
          this.lastGeometry.set(id, { width: s.width, height: s.height });
        }
        const resizeAt = this.lastResizeAt.get(id);
        const settling = resizeAt !== undefined && now - resizeAt < this.resizeSettleMs;

        // —— 内容差分 ——
        const prevContent = this.lastContent.get(id);
        // 空串是「读不到」，不是「内容变成了空」——不能用它判变化，也不能拿它冲掉
        // 基线（否则一次读取失败，下轮真内容回来会被误判成「刚变过」）。
        const contentKnown = content.length > 0;
        const justChanged =
          !settling && contentKnown && prevContent !== undefined && prevContent !== content;
        if (justChanged) {
          this.lastChangeAt.set(id, now);
        }
        // 基线刷新：静默期内也照常刷（这正是「基线对齐到重绘后的内容」——
        // 出静默期后既不会补报一次假变化，也不会漏掉出静默后真正的变化）。
        if (contentKnown) {
          this.lastContent.set(id, content);
        }

        const recentlyChanged =
          now - (this.lastChangeAt.get(id) ?? -Infinity) < this.activityWindowMs;
        const sample = {
          running: justChanged || recentlyChanged || isRunningTitle(s.title),
          // 闸门在 taskNameFromSample 里：前台不是 claude ⇒ ''（走 aiTitle 回退）。
          // running 不走闸门，理由见 core/tmux.ts 该函数注释。
          taskName: taskNameFromSample(s),
        };
        const prev = this.state.get(id);
        const next = nextActivity(prev, sample);
        this.state.set(id, next);
        // 按值比较，不能用 `prev !== next`（nextActivity 恒返回新对象）。
        if (prev === undefined || prev.state !== next.state || prev.taskName !== next.taskName) {
          changed = true;
        }
      });
    }

    if (changed) this.fire();
  }
}
