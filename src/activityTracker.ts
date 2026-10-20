import { PaneSample, isRunningTitle, sessionNameFor, stripVolatileChrome, cursorRowAfterStrip, hasPendingBackgroundWork, taskNameFromSample } from './core/tmux';
import { EntryActivity, markSeen, nextActivity } from './core/activity';
import { isClaudeCommand } from './core/claude';

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
 *
 * **为什么 5 秒够：真在跑的 pane 本来就每秒重绘一次。** 2026-10-13 实测 claude TUI 的
 * 忙碌状态行**自带每秒跳动的计时**（`· Generating… (10m 0s · ↓ 61.6k tokens)` →
 * `✻ Generating… (10m 10s · ↓ 61.6k tokens · thinking)`，相隔 1 秒就有新帧），
 * 所以「在跑」意味着每轮都有帧、本窗口不会过期。同一时刻全量扫 22 个 pane 的反向
 * 对照：空闲 pane 里这类计时行**命中 0 次**，只有正在变的两个会话命中。因此
 * **「静默超过本窗口」实测下来等价于「这一轮结束了」**（实测两次静默变绿分别是一次
 * 转 AskUserQuestion 菜单、一次输出收尾），不是「在思考」——不要据此给这里加
 * 「忙碌状态行」之类的电平判据，那是在给不存在的问题写代码。
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
 * 静默期**自延长**的上限（毫秒）。
 *
 * 见下面 poll() 里的自延长逻辑：静默期内只要内容仍在变，就把静默期顺延到
 * 「最后一次变化之后 RESIZE_SETTLE_MS」，但一整段静默期的总时长不超过本值。
 * 上限不能省 —— 没有它，紧接一次重排启动的长任务会把静默期无限顺延下去，
 * 那个槽永远不会被判成 running（表现为「该转圈的永远不转圈」）。
 */
export const SETTLE_MAX_MS = 10000;

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
   * **槽消失时，state 连同下面五个基线 Map（lastContent / lastChangeAt /
   * lastGeometry / lastResizeAt / settleStartAt）必须一起删键 —— 共六个。** 任何一个残留都会让
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
  /** 每个槽**当前这段静默期的起点**（Date.now()）；上限判据用它。 */
  private settleStartAt = new Map<string, number>();

  /**
   * @param tmux 采样能力（结构类型，TmuxClient 天然满足）。
   * @param activityWindowMs 「最近这么久内内容变过 ⇒ 在运行」的窗口；默认
   *   ACTIVITY_WINDOW_MS。传 0 表示窗口恒过期，即**只有本轮观测到内容变化的
   *   那一次**判运行 —— 本轮变化由 `justChanged` 兜住、不受窗口影响（单测据此
   *   零 sleep 地复现「变化那轮 running、下一轮落回」）。
   * @param resizeSettleMs 尺寸变化后的静默期（毫秒）；默认 RESIZE_SETTLE_MS。
   *   传 0 表示静默期恒过期，即**尺寸变化那一轮之后立刻恢复判定** —— 单测据此
   *   零 sleep 地验证「静默期会结束」（不是把静默期做成永久静默）。
   * @param settleMaxMs 静默期**自延长**的上限（毫秒）；默认 SETTLE_MAX_MS。
   *   传 0 表示上限恒过期（`now - settleStart < 0` 恒假），即**静默期不自延长** ——
   *   自延长被关掉、退回旧行为，单测据此零 sleep 地隔离出「上限封顶」这一条。
   */
  constructor(
    private readonly tmux: PaneSampleReader,
    private readonly activityWindowMs: number = ACTIVITY_WINDOW_MS,
    private readonly resizeSettleMs: number = RESIZE_SETTLE_MS,
    private readonly settleMaxMs: number = SETTLE_MAX_MS,
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
   * 「用户点开了这个终端」这个**边沿**信号（只有这一下，不是每一拍）。调用点只有
   * `extension.ts` 的 `tmuxTerminals.open` 命令 —— 侧边栏点击那一下。
   *
   * **为什么不能顺手并进 markSeen：** markSeen 每一拍都对「窗口有焦点 + 该终端是
   * 活动终端」的槽调用，在那里顺手静默等于把这些槽**永久**按在静默期里 ——
   * 表现是正在跑的那个槽永远不转圈（正是 SETTLE_MAX_MS 注释里防的那种错）。
   * 点开是个边沿，必须单独一个入口。
   *
   * **为什么点开要静默：** 点开时 pty 收到 focus，claude TUI 随即重绘一次（实测
   * 一个三周前就停下的旧终端，被点开那一刻 pane 内容前后各变 1 行、尺寸没变），
   * 这不是应用在跑、是宿主侧重绘，性质跟 resize 重排一样 —— 所以直接复用它，
   * 不另造机制。不静默的话这一下重绘会把槽判成 running，5 秒后落成绿点，用户
   * 刚看过的那一个反而变绿。
   *
   * **代价：** 点开一个**真在跑**的槽，转圈最多晚 `settleMaxMs`（10 秒）回来；
   * 静默期的自延长上限（见 SETTLE_MAX_MS）照旧生效，不会被永久静默。
   * 注意：静默期内状态机是**冻结**的（见 poll 里 `next` 那一行），冻结不是
   * 「把 running 判成 done-unseen」—— 0.2.15 之前正是后者，导致正在跑的槽被点开后
   * 变绿（实测）。
   */
  opened(sessionId: string): void {
    const now = Date.now();
    this.lastResizeAt.set(sessionId, now);
    this.settleStartAt.set(sessionId, now);
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
   * `running` 的判据是「**最近 activityWindowMs 内 pane 内容变过**」、或
   * **pane 里还有未完成的后台工作**（`hasPendingBackgroundWork`，这种状态内容静止、
   * 窗口判据会误判成已完成），或 `isRunningTitle(title)` 命中 —— 老版本 claude 的
   * 兼容项，零成本保留。
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
        // 六个 Map 必须一起清：残留的内容基线会把槽重建后的首次观测当成
        // 「刚变过」、残留的 lastResizeAt 会凭空触发静默期 —— 都表现为
        // 刚点开一个新槽就显示不对（运行中转圈 / 该转的不转）。
        this.lastContent.delete(id);
        this.lastChangeAt.delete(id);
        this.lastGeometry.delete(id);
        this.lastResizeAt.delete(id);
        this.settleStartAt.delete(id);
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
        // 差分前先剔掉「自己会跳动的装饰行」（见 core/tmux.ts 的 stripVolatileChrome）：
        // 基线 lastContent 存的是**剔除后**的内容，前后两轮口径一致；空串仍是
        // 「读不到」的语义不变（剔除只删行，不会把非空内容变成空串）。
        const content = stripVolatileChrome(contents[i]);

        // —— 几何判定（resize）——
        // 只有宽高都已知（>0）才参与：display-message 静默失败时宽高是 0，
        // 「未知」不能当坐标用。完全跳过 —— 既不比对、也不写回、也不设静默期，
        // 退化成纯内容差分。尤其别写回一个假的 0x0：下一轮真几何回来会把
        // 「0x0 → 真尺寸」误判成一次 resize。
        if (s.width > 0 && s.height > 0) {
          const prevGeom = this.lastGeometry.get(id);
          if (prevGeom !== undefined && (prevGeom.width !== s.width || prevGeom.height !== s.height)) {
            // 尺寸变了 ⇒ 本轮很可能是 resize 重排，不是应用在跑。进入静默期。
            // 起点一并重置：这是一段**新**的静默期，自延长的上限从这一刻重新计。
            this.lastResizeAt.set(id, now);
            this.settleStartAt.set(id, now);
          }
          // 首次观测（prevGeom 不存在）不算 resize：否则刚新建的槽会被无谓静默。
          this.lastGeometry.set(id, { width: s.width, height: s.height });
        }
        const resizeAt = this.lastResizeAt.get(id);
        const settleStart = this.settleStartAt.get(id);
        const settling =
          resizeAt !== undefined &&
          now - resizeAt < this.resizeSettleMs &&
          (settleStart === undefined || now - settleStart < this.settleMaxMs);

        // —— 内容差分 ——
        const prevContent = this.lastContent.get(id);
        // 空串是「读不到」，不是「内容变成了空」——不能用它判变化，也不能拿它冲掉
        // 基线（否则一次读取失败，下轮真内容回来会被误判成「刚变过」）。
        const contentKnown = content.length > 0;
        const rawChanged = contentKnown && prevContent !== undefined && prevContent !== content;

        // —— 「用户在打字」不算活动 ——
        /**
         * 现象：用户在输入框里敲字会把槽「点亮成绿点」。敲一个字 ⇒ pane 内容变 ⇒ 判
         * 「在运行」⇒ 停手 5 秒后落成绿色「已完成未查看」；而 `done-unseen` 是吸收态
         * （只有 markSeen 能清），于是绿点挂在用户**从没跑过任务**的槽上，直到他再
         * 点开一次才消。
         *
         * **判据（实测，2026-10-13；这是判别器，不是猜测）：** 同时采样「忙碌的 claude
         * pane」与「用户正在打字的空闲 claude pane」，按**原始屏幕行号**统计「本轮变化
         * 的行里是否包含光标所在行」：
         *   忙碌 81 次变化 → 含光标行的比例 **0.0%**
         *   空闲（打字）32 次变化 → 含光标行的比例 **96.9%**（31/32）
         * 即 claude 正在生成时，其每秒跳动的忙碌行**从来不落在光标行上**（0/81）；用户
         * 打字时，变化的恰好就是光标行。所以「本轮变化的行**全部**集中在光标行」可以判为
         * 「用户在打字，不是应用在输出」，不刷新活动时间戳。
         *
         * **★ 必须比 strip 之后的行号，不能比原始行号（实测踩过，2026-10-13 23:12–23:13）：**
         * 上面那组数字是**原始坐标**下测的，结论没错；但这里 `changedLines` 来自
         * `lastContent` 基线（= stripVolatileChrome 的结果）与本轮 strip 后的内容，是
         * **strip 坐标**，而 `s.cursorY` 是原始行号 —— 直接硬比会两头打偏：
         * - 正例（该触发却永不触发）：用户正在打中文，pane `tmuxterm-1fa95c7b6d96` 连续
         *   15 拍同一形状：`cursor_y=68`、原始改动行 `[68]`、strip 改动行 `[64]`，光标
         *   之上恰有 4 行被删（68-4=64）。原始行号永远不等于 strip 行 ⇒ 判据在**它要修的
         *   那个场景上恒不生效**。
         * - 反例（会误伤真活动）：pane `tmuxterm-5179df5692a1`、`cursor_y=65`，而原始第
         *   65 行正是**被删掉的输入行 `❯ `**；那 12 拍唯一变化的 strip 行 index=65 其实是
         *   原始第 72 行（底部每秒重绘的子 agent 进度行 `◯ general-purpose …`）。`65` 与
         *   `66-1` 只是数值巧合，硬比会把一个**后台 agent 正在跑**的槽的活信号压掉。
         * 故先经 `cursorRowAfterStrip(contents[i], s.cursorY)` 把原始光标行映射到 strip
         * 行号（同一口径、`VOLATILE_HINTS` 的清空不算移位）；映射不出（-1）时不抑制。
         *
         * **为什么不是「忙碌状态行的电平判据」：** 本文件 ACTIVITY_WINDOW_MS 的 JSDoc
         * 明确警告过不要加那种判据（那是在给不存在的问题写代码）。这里判的是「本轮变化
         * 是否只落在用户输入的那一行」——是**变化落点**，不是「某行是不是忙碌行」，两者
         * 互不相干；0/81 这条实测正说明忙碌行不落在光标行上。
         *
         * ponytail: 已知上限两条 ——
         * (1) 只对 claude 前台生效：纯 shell pane 里命令输出是**顺着光标行往下写**的
         *     （shell 的光标就停在输入处），会把真活动误吞，故用 isClaudeCommand 闸掉
         *     非 claude。
         * (2) 打字跨过软换行边界的那一拍会同时改 2 行 ⇒ `every` 不成立 ⇒ **不抑制**，
         *     方向是**多报活动**（安全侧）：顶多多亮一次，不会漏掉后续活动。
         */
        const changedLines =
          rawChanged && prevContent !== undefined ? changedLineIndices(prevContent, content) : [];
        // 原始屏幕行号 → strip 后行号（与本轮 changedLines 同一坐标系）；映射不出 = -1。
        const cursorStripped = cursorRowAfterStrip(contents[i], s.cursorY);
        const cursorOnly =
          cursorStripped >= 0 && // -1 = 未知 ⇒ 不抑制（宁可多判活动，不可漏判）
          isClaudeCommand(s.foreground) && // 只对 claude TUI 生效（纯 shell 输出会顺着光标行写）
          changedLines.length > 0 &&
          changedLines.every((idx) => idx === cursorStripped);

        // 静默期内仍在变 ⇒ 重绘还没结束，把静默期顺延到「最后一次变化之后
        // resizeSettleMs」（总长仍受 settleMaxMs 封顶，见 SETTLE_MAX_MS）。
        if (rawChanged && settling) {
          this.lastResizeAt.set(id, now);
        }
        // 只有**静默期之外**、且**不是「用户在打字」**的变化才算活动。
        const justChanged = rawChanged && !settling && !cursorOnly;
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
          running:
            justChanged ||
            recentlyChanged ||
            // 「还有未完成的后台工作」时必须算 running：这种状态 pane 完全静止
            // （见 core/tmux.ts 的 hasPendingBackgroundWork），光靠窗口判据会把它
            // 误判成「刚跑完」→ 空闲的老终端莫名其妙变绿。
            hasPendingBackgroundWork(contents[i]) ||
            isRunningTitle(s.title),
          // 闸门在 taskNameFromSample 里：前台不是 claude ⇒ ''（走 aiTitle 回退）。
          // running 不走闸门，理由见 core/tmux.ts 该函数注释。
          taskName: taskNameFromSample(s),
        };
        const prev = this.state.get(id);
        // 静默期内**不推进状态机**：静默期要挡的是「宿主侧重绘被当成活动」，
        // 不是「把正在跑的槽判成刚完成」——只冻结在上一拍的状态即可。
        // 实测（2026-10-19，用户报「任务在执行却不转圈」）：`opened()` 之后 5 秒，
        // running 会落成 done-unseen（绿），任务其实还在跑；10 秒静默期到期才恢复。
        // 冻结后：running 保持 running（`opened()` JSDoc 承诺的「转圈最多晚
        // settleMaxMs」才真的成立），idle/done-unseen 也各自保持原状。
        const next = settling && prev !== undefined ? prev : nextActivity(prev, sample);
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

/**
 * 逐行比两版内容，返回**行号**（0 基，与 `content.split('\n')` 的下标一致）不相等的
 * 那些行；行数不等时，多出来的那几行也算变化（一侧越界为 `undefined`，`undefined !==
 * '…'` 天然成立）。
 *
 * 只在 ActivityTracker 内用、不导出 —— 它专服务于 poll() 里「本轮变化的行是否**全部**
 * 落在光标行」这一个判定（见那段 JSDoc）。两版内容都是**剔除装饰行之后**的形态
 * （poll 传进来的是 lastContent 基线与 stripVolatileChrome 结果），前后口径一致，所以
 * 拿它比的行号也是 strip 坐标 —— 光标行必须先经 cursorRowAfterStrip 映射过来。
 */
function changedLineIndices(prev: string, next: string): number[] {
  const before = prev.split('\n');
  const after = next.split('\n');
  const len = Math.max(before.length, after.length);
  const changed: number[] = [];
  for (let i = 0; i < len; i++) {
    if (before[i] !== after[i]) changed.push(i);
  }
  return changed;
}
