import * as fs from 'fs/promises';
import * as os from 'os';
import * as vscode from 'vscode';
import {
  discoverCandidates,
  displayPath,
  expandHome,
  rankCandidates,
  scanRoots,
  validateName,
} from './core/paths';
import { decideOpen } from './core/restore';
import { isShellReady, sessionNameFor, shellQuote } from './core/tmux';
import { Profile, SessionSlot, TerminalEntry } from './core/types';
import { LaunchSpec, conversationCommand } from './core/command';
import {
  ConversationCandidate,
  NEW_CONVERSATION_LABEL,
  belongsToCwd,
  candidatesForCwd,
  formatCandidateWithOwner,
  ownersOf,
} from './core/conversation';
import { isClaudeCommand, resumeFailed } from './core/claude';
import { PRESET_COLORS, colorChoices, normalizeHexColor } from './core/colors';
import { readProfileConfig } from './claudeConfig';
import { findConversations, listConversations } from './conversationFiles';
import { LivenessSnapshot, liveSessionIn, readLiveness } from './liveSessions';
import { reconcileBinding } from './core/reconcile';
import { EntryStore, newConversationId, newId } from './core/store';
import { TmuxClient } from './tmuxClient';

const SHELL_READY_TIMEOUT_MS = 3000;

/**
 * 发完 `--resume` 后盯 pane 的时长与间隔。claude 接不上时会立刻打印
 * `No conversation found` 并退出，2.5 s 足够；成功时下一次轮询就会看到
 * 前台进程变成 claude，提前退出，不会白等。
 */
const RESUME_CHECK_TIMEOUT_MS = 2500;
const RESUME_CHECK_INTERVAL_MS = 250;

/**
 * 选择框里的一项：QuickPick 的显示字段 + 我们自己的负载。
 *
 * 显式声明而不是让 TS 从数组字面量推断：末尾那项「＋ 新建一条对话」没有
 * candidate/owner，推断出的是个联合类型，取 pick.owner 会报「该属性不存在」。
 */
interface ConversationPickItem extends vscode.QuickPickItem {
  candidate?: ConversationCandidate;
  owner?: string;
}

/**
 * 调色板 QuickPick 需要的**色块图标**能力。
 *
 * 声明成最小接口、而不是直接要 `ColorIconCache` 这个具体类：与本文件里
 * `store` / `titles` 的处理方式一致 —— 本模块不该知道图标缓存在哪、
 * 怎么落盘。省略 = 调色板不出色块（只剩 hex 文本，功能不残）。
 */
export interface ColorSwatchSource {
  /** 只拼路径、不读盘。非法/空串 → undefined（没有图标，而不是一个错的图标）。 */
  swatchFor(color: string): vscode.Uri | undefined;
  /** 把一批颜色的图标落到磁盘（幂等）。**必须在弹框之前 await**。 */
  ensure(colors: readonly string[]): Promise<void>;
}

export class TerminalManager {
  /**
   * tmux 会话名 → 终端。**只用来挑「用哪个面板」**，绝不用来断定会话已
   * 恢复（v2 首发的 bug 就出在这里，见 core/restore.ts）。同理，
   * 凭 `window.terminals` 的同名面板也不足以断定恢复。
   */
  private readonly terminals = new Map<string, vscode.Terminal>();

  /**
   * 已知「有命令正在跑」的面板，由 shell integration 事件维护。
   *
   * 面板里可能正跑着用户的编译／REPL，往它 stdin 里塞 `tmux attach` 能
   * 毁掉一次构建。只有 shell integration 能回答「面板里在跑什么」，
   * 因此这是「能否安全复用面板」的唯一依据。
   */
  private readonly busy = new Set<vscode.Terminal>();

  /**
   * **本宿主世代由我们亲手创建**的面板。
   *
   * 只有它们才谈得上「busy 状态一直被跟踪着」。上一个宿主世代留下的面板
   * （扩展重载后仍在 `window.terminals` 里）我们从未见过它开始跑什么 ——
   * 重载后 `busy` 是空集、而 `shellIntegration` 依然在场，一个**正在跑编译**
   * 的面板会被误判成空闲，然后被塞进 `tmux attach`。
   * **「未知」必须与「空闲」区分开，未知一律按危险处理。**
   */
  private readonly ownPanels = new Set<vscode.Terminal>();

  constructor(
    private readonly store: EntryStore,
    private readonly tmux: TmuxClient,
    /**
     * 任务名回退源（只读内存缓存）。reconcile 时对**当前绑定**调一次
     * prewarm 预热，渲染层才能同步 peek 到「绑定对话的 aiTitle」。
     * 用最小接口而不是具体类型，与 tree.ts 的 store/activity 同一处理方式。
     * 省略 = 不预热（既有调用方不受影响）。
     */
    private readonly titles?: {
      prewarm(conversationId: string | undefined, cwd: string): void;
      /**
       * 轮询节拍上的低频重试（可选，见 retryTitles）。prewarm 只在 reconcile
       * 时被调，而 /new 之后的**新**对话要过几个来回才生成 aiTitle ——
       * 第一次读不到之后就再没有触发点重读了，第三级会永久消失。
       * 省略（或实现没提供）= 不重试，退化成改动前的行为。
       */
      retryMissing?(sources: readonly { conversationId?: string; cwd: string }[]): void;
    },
    /**
     * 「刚刚回写了绑定」的回调。绑定一变，树上的两处显示（三级任务名、
     * tooltip 里的「对话」行）就都过期了，必须重算。
     *
     * **为什么放在 manager 而不是各调用点**：回写绑定的出口有 **7 个**
     * —— reconcileAll 自己那一次（整批循环跑完按 `wrote` 一次性通知），
     * 加上 6 个走 `writeBinding` 的单点：reconcileOne 1 处、resolveLaunchSpec
     * 4 处（兜底 D、`total === 0`、startNew、选中历史对话）、
     * bindConversationInteractive 2 处（选中、startNew）。**回写点比入口还
     * 多**，而调用它们的入口有好几个（点击条目、⟳、激活、面板可见、
     * 展开节点、10 秒存活轮询、restoreAll）—— 在一堆入口上逐个补 refresh
     * 是漏一个就静默失效的写法；集中在这里，新增入口、新增回写点都自动
     * 覆盖。
     *
     * 省略 = 不通知（单测与 e2e harness 直接 new 出 manager 时不受影响）。
     */
    private readonly onBindingsChanged?: () => void,
    /**
     * 调色板 QuickPick 的色块图标来源（`ColorIconCache` 结构上满足它）。
     *
     * 放在**最后**且可选：前面 4 个参数有多个调用方**按位置**传，插在中间
     * 会让那些调用点静默错位。省略 = 调色板只有 hex 文本，选颜色照常可用。
     */
    private readonly colorSwatches?: ColorSwatchSource,
  ) {
    vscode.window.onDidCloseTerminal((t) => {
      this.busy.delete(t);
      this.ownPanels.delete(t);
      for (const [session, term] of this.terminals) {
        if (term === t) this.terminals.delete(session);
      }
    });

    // 版本 <1.93 没有这两个 API；缺失时整条「可否安全复用面板」的判据
    // 降级为「一律判不出来」→ 总是新建面板（安全侧）。attach 照常发生，
    // 用户仍能看见 claude，只是可能多一个面板。
    vscode.window.onDidStartTerminalShellExecution?.((e) => {
      this.busy.add(e.terminal);
    });
    vscode.window.onDidEndTerminalShellExecution?.((e) => {
      this.busy.delete(e.terminal);
    });
  }

  /**
   * 挑一个代表该会话的面板：先查内存 Map（同宿主内更精确），再按显示名
   * 在 `window.terminals` 里找（扩展宿主重启后 Map 会清空，面板仍在）。
   *
   * **只用于挑面板。** 命中不等于会话已恢复 —— 会话可能已死、也可能没有
   * 任何客户端附着。判据在 core/restore.ts。
   */
  private candidatePanel(session: string, name: string): vscode.Terminal | undefined {
    return this.terminals.get(session) ?? vscode.window.terminals.find((t) => t.name === name);
  }

  /**
   * 能否证明该面板空闲停在 shell 提示符上（即往里打字不会打断任何东西）。
   *
   * 三个条件缺一不可：**面板是本宿主世代我们亲手建的**（否则 busy 状态未知）、
   * shell integration 在场（否则无从得知面板里跑着什么）、且没记录到有命令在跑。
   * 判不出来一律 false —— 宁可多开一个面板，也不能把 `tmux attach` 打进用户
   * 正在跑的进程。代价是扩展重载后可能需要多一个新面板，这个代价接受。
   */
  private isIdlePanel(t: vscode.Terminal): boolean {
    // 不是本世代我们建的 → busy 状态未知（扩展重载前它可能就在跑 build 了）
    if (!this.ownPanels.has(t)) return false;
    if (t.shellIntegration === undefined) return false;
    return !this.busy.has(t);
  }

  /**
   * 建一个**由本宿主世代跟踪**的面板（见 isIdlePanel）。
   * 所有创建面板的地方都必须走这里，否则它会被当成「状态未知」而永不复用。
   */
  private createOwnPanel(name: string, cwd?: string): vscode.Terminal {
    const t = cwd === undefined
      ? vscode.window.createTerminal({ name })
      : vscode.window.createTerminal({ name, cwd });
    this.ownPanels.add(t);
    return t;
  }

  /** 远端家目录。公开供扩展层复用，避免各处各算一份。 */
  home(): string {
    // 扩展跑在远端，os.homedir() 即远端家目录
    return os.homedir();
  }

  // ---- 条目 ↔ claude 对话的绑定 ----

  /**
   * 选择交互的串行队列。
   *
   * 「全部恢复」会并行开 N 条条目。若各自弹一个 QuickPick，用户会同时看到
   * 一摞对话框、分不清哪个属于哪个终端（实测用户 8 条条目里有 7 条没绑定，
   * 首次恢复会一次弹 7 个）。这里串行化：一次只弹一个，其余排队；每次的
   * 标题都带条目名，用户始终知道在给哪个终端选对话。
   */
  private pickChain: Promise<unknown> = Promise.resolve();

  private enqueuePick<T>(op: () => Promise<T>): Promise<T> {
    const next = this.pickChain.then(op, op);
    this.pickChain = next.catch(() => {});
    return next;
  }

  /**
   * 让用户为该**会话槽**挑一条对话。
   *
   * `slot` 只用于「谁在问」：cwd 仍由条目决定，但归属判据（谁占着哪条对话）
   * 必须按**槽**摊平 —— 见下面摊平那段的说明。
   *
   * 候选 = `~/.claude/projects` 下**文件里记录的 cwd 精确等于该条目 cwd** 的
   * 对话，按 mtime 倒序。绝不靠目录名反推归属（转义规则不可靠）。
   *
   * 列表**末尾固定跟一项「＋ 新建一条对话」**：新对话只能由用户主动选出来，
   * 绝不由「取消」隐式产生（见 resolveLaunchSpec）。
   *
   * 每项的显示：`时间 · 首条用户消息**原文** · 体积`，**只有这一行**。
   * 实测用户有十几条同 cwd 的对话，光靠「时间 + 体积」认不出「上次在聊的那个」，
   * 所以要有一段能认出内容的文字 —— 取的是首条用户消息的原文（只压平空白，
   * 不压缩语义、由 VS Code 按行宽自己截断）。
   *
   * **没有第二行**：不再显示「最后问」，也不再显示「最后回答」。后者原本挂在
   * `QuickPickItem.tooltip` 上，而那是 proposed API（`quickPickItemTooltip`），
   * 正常安装的扩展一用就让 `showQuickPick` 抛错、整个选择框弹不出来；而 detail
   * 那行在 VS Code 里是钉死 44px、overflow:hidden 的固定行高，长篇回答本来也
   * 放不下。要看会话内容，接回终端即可。
   *
   * **调用方必须已经处在 `pickChain` 的一个 op 内**（本方法自己不再入队）。
   * 读 owners 必须与写绑定处在同一个 op 里，否则两个共用 cwd 的老条目会
   * 各自读到「还没人绑」的快照，双双接到同一条对话上。
   */
  private async pickConversation(
    entry: TerminalEntry,
    /**
     * 正在为哪个槽挑对话。**必须传**：归属判据与「跳过自己」都按它的 id 走
     *（见下面摊平那段）—— 少了它就会退回「按条目判」，而那条路在多会话下
     * 会静默失效。
     */
    slot: SessionSlot,
    title: string,
  ): Promise<{ total: number; picked?: ConversationCandidate; owner?: string; startNew: boolean }> {
    const cwd = this.cwdFor(entry);
    // 按 cwd 过滤在**内存里**做（candidatesForCwd），不再有「过滤完再去读
    // 每条的尾部」那一步 —— 那是给「最后一问一答」服务的，而它已经不显示了。
    // 于是每次弹框少读 N × 64KB，且这一步与别处取候选走的是同一条路。
    const candidates = candidatesForCwd(await listConversations(this.home()), cwd);
    if (candidates.length === 0) {
      // 没有任何可接回的 → 没有列表可弹，调用方直接开一条新的
      return { total: 0, startNew: false, picked: undefined };
    }

    // 已被别人绑走的对话要标注出来：实测用户 4 条条目共用同一个 cwd，
    // 选重了会让两条会话接进同一条对话，两边同时写同一个 .jsonl。
    // 抢占者**不止别的条目**：同一个终端下的两个槽也能争同一条（用户手动选、
    // 或手改清单文件都能做到），而后果一模一样。
    //
    // v3 的绑定在**会话槽**上，而 ownersOf 只认「一份绑定一份视角」的形状 ——
    // 故先把清单摊平成「一条槽一份视角」再喂给它。写成直接把 entries 传进去
    // **不会报错**（conversationId 是可选字段，TerminalEntry 结构上仍满足
    // BindingView），但每个条目的 conversationId 都会读到 undefined，于是
    // 「已绑给「X」」这个标记与二次确认永远不出现 —— 静默退回选重不告警。
    //
    // 摊平与「跳过自己」**都按槽 id**，一处按条目 id 都不行：ownersOf 的
    // 「跳过自己」只按传进去的那个 id 生效。若照「按条目 id 摊平 + 按条目 id
    // 跳过自己」写，同一个终端的槽会**彼此全被跳过** —— 不报错，只是兄弟槽
    // 正在写的对话在列表里看起来无主、选中也不弹确认，用户于是能把第二个槽
    // 绑上去：两个 claude 同写一条 .jsonl。`name` 仍是**终端名** ——
    // 「已绑给「X」」要显示的是哪个终端占着它。
    const owners = ownersOf(
      (await this.store.load()).flatMap((e) =>
        e.sessions.map((s) => ({ id: s.id, name: e.name, conversationId: s.conversationId })),
      ),
      slot.id,
    );

    // 末尾固定跟一项「＋ 新建一条对话」：新对话只能由用户主动选出来。
    // 它**不参与**候选那套渲染 —— 它没有 conversationId，也不该
    // 长得像一条历史对话。
    const newItem: ConversationPickItem = { label: NEW_CONVERSATION_LABEL };
    const convoItems: ConversationPickItem[] = candidates.map((c) => {
      const owner = owners.get(c.id);
      // 刻意**不用展开**（`...({ label, candidate })`）拼这个对象：TypeScript 对
      // 展开进来的属性不做过量属性检查，往 VS Code 的 API 对象上塞一个它不认识
      // 的字段（比如 proposed API）时 tsc 一声不吭 —— 这个 bug 正是这么溜过类型
      // 检查、直到运行时 showQuickPick 抛错才暴露的。改成逐字段赋值，多写一行
      // 换来 tsc 能拦住下一个。
      const item: ConversationPickItem = {
        label: formatCandidateWithOwner(c, owner),
        candidate: c,
      };
      if (owner !== undefined) item.owner = owner;
      return item;
    });
    const pick = await vscode.window.showQuickPick<ConversationPickItem>(
      [...convoItems, newItem],
      {
        title,
        placeHolder: `${cwd} 下有 ${candidates.length} 条可接回的对话`,
      },
    );
    return {
      total: candidates.length,
      startNew: pick === newItem,
      ...(pick && pick.candidate
        ? { picked: pick.candidate, ...(pick.owner !== undefined ? { owner: pick.owner } : {}) }
        : {}),
    };
  }

  /**
   * 选中的对话**已经被别的条目绑走**时，弹一次模态确认。
   *
   * 标签上的「已绑给「X」」不够：实测这个用户有 4 条条目共用同一个 cwd，
   * 列表里十几条候选长得都很像，手滑选中别人的是很现实的事 —— 而后果是
   * 两个 claude 进程同时写同一个 `.jsonl`，与「取消→`--continue`」是同一类
   * 数据损坏。所以**必须显式确认**才继续。
   *
   * 返回 true = 用户确认，继续；false = 放弃（与按 Esc 同侧：什么都不启动）。
   */
  private async confirmSharedConversation(
    entry: TerminalEntry,
    owner: string | undefined,
  ): Promise<boolean> {
    if (owner === undefined) return true;
    const pick = await vscode.window.showWarningMessage(
      `该对话已绑给「${owner}」。\n` +
      `两个终端同时写入同一条对话记录可能损坏它。\n` +
      `确定让「${entry.name}」也接这条吗？`,
      { modal: true },
      '仍然接这条',
    );
    return pick === '仍然接这条';
  }

  /**
   * 决定「该给这个**会话槽**发哪条启动命令」。返回 undefined = **什么都不启动**
   * （会话照常建/照常 attach，pane 停在登录 shell，等用户主动处理）。
   *
   * 顺序即优先级：
   *
   *  1. 已绑定 → 那条对话**是否已经存在**决定走哪一支：还不存在（首启，或
   *     记录被外部删了）→ `fresh`，即裸 `claude`、**不带任何会话标识**；
   *     存在且在本条目 cwd 下 → `--resume` 接回。用 `+` 新建的条目一出生就
   *     带 id，但那条对话还没被创建过，走的正是前者。
   *     对话存在、却不在本条目的 cwd 下 → `--resume` 按 cwd 作用域必然失败，
   *     而**绝不替用户另开一条**，故返回 undefined 并说明原委。
   *  2. 未绑定（只可能是本功能上线前的老条目迁移出来的槽）+ 该 cwd 下有候选 →
   *     问用户挑一次，挑中即永久绑定；列表末尾可选「＋ 新建一条对话」。
   *  3. 未绑定 + 无候选 → 用 `--session-id` 开一条新的并立刻绑定。
   *  4. 用户按 Esc 取消 → 返回 undefined，**什么都不启动**，并按提示可随时
   *     右键重来。
   */
  private async resolveLaunchSpec(
    entry: TerminalEntry,
    /**
     * 要启动的会话槽。**绑定取自它**（v3 的绑定在槽上；条目上已经没有这个
     * 字段了 —— 是编译器把这里的每一处读点都列出来的）。
     */
    slot: SessionSlot,
    /**
     * 本次 reconcileOne 观测到的活跃会话 id；undefined = 观测不到。
     * 空串在这里不会出现 —— parseSessionRecord 已把空/纯空白判为 undefined，
     * 故下面只需判 `undefined`；万一出现空串也只会落进「不启用 D」的保守侧。
     */
    live: string | undefined,
  ): Promise<LaunchSpec | undefined> {
    const cwd = this.cwdFor(entry);
    const bound = slot.conversationId;
    if (bound !== undefined && bound.length > 0) {
      const cwds = await findConversations(this.home(), bound);
      if (cwds.length === 0) {
        // 那条 .jsonl 不存在。两种来源在「文件」这一层不可区分，用
        // slot.liveSessionId（上一次**已确认观测到**的活跃会话）分开
        //（v3 起它与绑定一样落在槽上）：
        //  - undefined = 从未观测到它跑起来过 → 「+」/复制新建的条目
        //    **首次启动**，完全正常，**一声不吭**（旧代码在这里弹提示，
        //    正是用户抱怨的那条：条目一出生就带个没人认识的会话 id）；
        //  - 有值 = 曾经跑起来过、对话本该存在 → 那条 .jsonl 被**外部删掉**了
        //    （手动 rm、清理工具）。这时沉默才是坏事：用户只会觉得「我的
        //    对话又没了」，必须出声。
        // 这是个**启发式**：理论上「条目跑起来过、对话文件却从未落盘」会被
        // 误判成后者，多弹一条提示 —— 那属于更罕见的组合，代价可接受；
        // 反过来漏报，才是真的让用户丢掉唯一线索。
        //
        // 两支都返回 `fresh`（裸 claude，不带任何会话标识）：没有可顶掉的
        // 对话，当场开一条新的即可，绑定会由 reconcile 观测到那条新会话后
        // 自动回写（见 core/reconcile.ts 第三分支）。文案里**不能**再写
        // 「绑定保持不变」—— 绑定马上就会被改写到新对话上。
        if (slot.liveSessionId !== undefined) {
          void vscode.window.showInformationMessage(
            `「${entry.name}」绑定的对话记录似乎已被删除，本次新开一条，` +
            `绑定会跟着这条新对话走。若这条对话本应存在，请检查它的记录是否被外部清理。`,
          );
        }
        return { kind: 'fresh' };
      }
      if (cwds.some((c) => belongsToCwd(c, cwd))) {
        return { kind: 'resume', conversationId: bound };
      }
      // 存在，但不在这个目录下 —— `--resume` 是按 cwd 作用域的，必然失败。
      // 此时**绝不**换一条新对话把它顶掉，交给用户处理。
      void vscode.window.showErrorMessage(
        `「${entry.name}」绑定的对话不在 ${cwd} 下，无法接回（claude 的 --resume 只在原目录有效）。` +
        `右键该条目选「选择要接回的对话…」可改绑本目录下的对话。`,
      );
      return undefined;
    }

    // ---- 兜底 D（**收窄 + 占用判据**）：mtime 启发式 ----
    // A 观测不到活跃会话（claude 已死）—— 那就不存在「这个终端在用哪条会话」
    // 的权威答案；此时**只有**在「该 cwd 下只有这一个条目」时才敢退回 mtime：
    //   - 单条目 → 不可能与别的条目争同一条 .jsonl，猜错也只是接回自己目录下
    //     最近用过的那条，代价可控；
    //   - 多条目共用 cwd → 猜错就是两条会话共写一条记录（数据损坏级），
    //     宁可弹框问。
    //
    // 唯一性判据必须按 **cwdFor() 展开后的路径**比较，而不是原始串：
    // cwd 支持 `~`（同一批条目里 `~/x` 与 `/home/u/x` 原始串不相等、展开后
    // 是同一个目录）。按原始串判会让两个条目**各自**满足「只有我一个」，
    // 双双走 D 并接到同一条 .jsonl 上 —— 恰好击穿 D 自己要防的数据损坏。
    // 展开路径也正是真正启动时用的那个目录（cwdFor 同时喂给 newSession）。
    //
    // 判据 (a)「该 cwd 下只有这一个条目」**不够**（SPEC §11.16）：它的正当性
    // 论证是「单条目 → 不可能有别人来争这条 .jsonl」，而**多会话让竞争者可以
    // 出自同一个条目**。可达路径：条目 E 有一个未绑定的老槽 s1，用户点「+」
    // 加了预分配 conversationId 的 s2 并点开（s2 正在写对话 C）—— 此时点 s1，
    // 条目数仍是 1，(a) 成立，而候选里 mtime 最新的那条**恰恰就是 C** →
    // s1 也 `--resume C`，两个 claude 同写一条 .jsonl（数据损坏级）。
    // 故补判据 (b)：候选必须**无主**，且取**第一个**无主的；一个无主的都没有就
    // **不启用 D**，退回弹框让用户自己决定 —— 与「手动改绑别人的对话要二次
    // 确认」同一侧。两条判据挡的是不同的东西：(a) 挡多个条目争抢，(b) 挡同一个
    // 条目内部自己跟自己抢，缺一不可。
    //
    // 摊平必须用**槽 id** 当视角的 id：ownersOf 的「跳过自己」只按传入的 id
    // 生效，而 (b) 要的正是「同一个条目下的兄弟槽算占用者」。若改成按条目 id
    // 摊平 + 按条目 id 跳过自己，会把同一个终端的槽**彼此都跳过** —— 不报错，
    // 只是 (b) 静默失效、退回今天的行为。（同一族，还有 pickConversation 的
    // 归属标记那处，见 SPEC §11.17。）
    const all = await this.store.load();
    const soleInCwd = all.filter((e) => this.cwdFor(e) === cwd).length === 1;
    if (live === undefined && soleInCwd) {
      const candidates = candidatesForCwd(await listConversations(this.home()), cwd);
      const owners = ownersOf(
        all.flatMap((e) =>
          e.sessions.map((s) => ({ id: s.id, name: e.name, conversationId: s.conversationId })),
        ),
        slot.id,
      );
      const free = candidates.find((c) => !owners.has(c.id));
      if (free !== undefined) {
        // 与「手动改绑」同一侧：**只写 conversationId，不动 liveSessionId**
        //（这是推断，不是观测，不该冒充观测值）。
        await this.writeBinding(entry.id, slot.id, { conversationId: free.id });
        return { kind: 'resume', conversationId: free.id };
      }
    }

    // **整段**放进 pickChain 的同一个 op：读 owners → 弹选择框 → 弹确认模态
    // → 写绑定，中间不能插进别的条目的选择流程。
    // 否则「读 owners」与「写绑定」之间有一个窗口，两个共用 cwd 的老条目会
    // 各自看到「还没人绑」，双双接到同一条对话上 —— 两个 claude 进程同时写
    // 同一个 .jsonl。顺带也避免了确认模态与下一个条目的选择框并存。
    return this.enqueuePick(async (): Promise<LaunchSpec | undefined> => {
      // 标题带上**终端名 + 是哪个会话**：一个终端可以挂 N 个槽，而
      // restoreAll 会并行恢复它们 —— 只说终端名，用户看到两个一模一样的
      // 选择框时分不清正在给哪一个选（实测恢复 8 条时就会连弹）。
      const { total, picked, owner, startNew } = await this.pickConversation(
        entry, slot, `「${entry.name}」的${this.slotLabel(entry, slot)}接回哪条对话？`,
      );
      if (total === 0) {
        const conversationId = newConversationId();
        await this.writeBinding(entry.id, slot.id, { conversationId });
        return { kind: 'new', conversationId };
      }
      if (startNew) {
        const conversationId = newConversationId();
        await this.writeBinding(entry.id, slot.id, { conversationId });
        return { kind: 'new', conversationId };
      }
      if (picked === undefined) {
        // 用户按 Esc：什么都不启动。绝不退回 `--continue` —— 条目共用 cwd 时
        // 那会让几个终端一起接到同一条最新对话上去，两边同时写同一个 .jsonl。
        void vscode.window.showInformationMessage(
          `「${entry.name}」未接回对话。右键该条目选「选择要接回的对话…」可随时接回。`,
        );
        return undefined;
      }
      // 选中的是**别人已经绑着**的对话 → 必须显式确认，否则两个 claude 会
      // 同时写同一条 .jsonl。取消与 Esc 同侧：什么都不启动。
      if (!(await this.confirmSharedConversation(entry, owner))) {
        void vscode.window.showInformationMessage(
          `「${entry.name}」未接回对话（该对话已绑给「${owner}」）。` +
          `右键该条目选「选择要接回的对话…」可另选一条。`,
        );
        return undefined;
      }

      await this.writeBinding(entry.id, slot.id, { conversationId: picked.id });
      return { kind: 'resume', conversationId: picked.id };
    });
  }

  /**
   * 显式命令：为**指定的会话槽**选择要接回的对话（随时可重新绑定）。
   *
   * 只影响**下一次在这个槽里启动 claude**。会话还活着时那条对话本来就是
   * 对的，不必也不该去打断正在跑的 claude。
   */
  async bindConversationInteractive(
    entry: TerminalEntry,
    /**
     * 作用在哪个槽上。**由调用方给出**，绝不在这里猜「第一个」：绑定是槽级的
     *（v3），而判归属、写绑定都要知道是哪一条槽 —— 猜错了就会在兄弟槽争同一条
     * 对话时失去「已绑给「X」」标记与二次确认（见 pickConversation）。
     */
    slot: SessionSlot | undefined,
  ): Promise<void> {
    // 命令当前仍挂在二级条目上（`extension.ts` 传第一个槽），三级节点接好线之后
    // 改为传那一个槽自己。
    // 空槽的条目**什么都不做**：没有槽就没有 id，写不回任何地方；现场编一个槽
    // 等于凭空造一个会话。迁移保证老条目都有槽，所以这条守卫只在手改坏了文件时
    // 命中。类型上 `sessions[0]` 声称非空，故只能用 `undefined` 显式表达。
    if (slot === undefined) return;
    // 与 resolveLaunchSpec 同侧：读 owners → 选择框 → 确认 → 写绑定 全在一个
    // op 内，避免与并发的恢复流程互相看不到对方的绑定。
    await this.enqueuePick(async (): Promise<void> => {
      const { total, picked, owner, startNew } = await this.pickConversation(
        entry, slot, `为「${entry.name}」选择要接回的对话`,
      );

      if (picked !== undefined) {
        // 绑到别人的对话上同样会造成两个 claude 写同一条记录 —— 显式命令也
        // 不能例外，一样要确认。
        if (!(await this.confirmSharedConversation(entry, owner))) {
          void vscode.window.showInformationMessage(
            `「${entry.name}」未改绑定（该对话已绑给「${owner}」）。`,
          );
          return;
        }
        await this.writeBinding(entry.id, slot.id, { conversationId: picked.id });
        void vscode.window.showInformationMessage(
          `「${entry.name}」已绑定对话 ${picked.id.slice(0, 8)}…，下次启动 claude 时会接回它。`,
        );
        return;
      }
      if (startNew) {
        const conversationId = newConversationId();
        await this.writeBinding(entry.id, slot.id, { conversationId });
        void vscode.window.showInformationMessage(
          `「${entry.name}」将开一条新对话 ${conversationId.slice(0, 8)}…，下次启动 claude 时使用。`,
        );
        return;
      }
      if (total === 0) {
        // 这个目录下压根没有可接回的。**不替用户生成一条新对话** ——
        // 这条命令的语义是「挑一条历史接回」，没有历史就说没有。
        void vscode.window.showInformationMessage(
          `在 ${this.cwdFor(entry)} 下没有找到可接回的 claude 对话。`,
        );
      }
      // 其余情况 = 用户按 Esc 取消，什么都不改
    });
  }

  // ---- 会话身份：跟随终端最后用过的会话（reconcile，只读观测 + 回写绑定） ----

  /**
   * 从一份快照里解析某个**会话槽** pane 下「最后用过的会话」。
   * 取不到（pane 查不到、没有后代 claude、注册表里没有它）→ undefined。
   */
  private async liveFor(snap: LivenessSnapshot, slot: SessionSlot): Promise<string | undefined> {
    const panePid = await this.tmux.panePid(sessionNameFor(slot.id));
    if (panePid === null) return undefined;
    return liveSessionIn(snap, panePid)?.sessionId;
  }

  /**
   * 观测一批条目的活跃会话并回写绑定。返回 true = 至少写了一条。
   *
   * - 循环是**条目 × 槽**，只处理「tmux 会话存活」的**槽**（判据从「条目的会话
   *   存活」收缩到「该槽的会话存活」）：会话都没了就没有活着的 claude 可观测，
   *   此时**绝不**去改绑定（那会让 D 兜底之外的地方凭空「猜」）。没有任何槽的
   *   条目一并跳过 —— 它没有会话名可查。
   * - 整批共用一份 LivenessSnapshot：`ps` 只 spawn 一次。
   * - 每条只在 reconcileBinding 返回非 undefined 时写一次 store.updateSession。
   * - 顺带预热任务名缓存：渲染层才能同步 peek 到「绑定对话的 aiTitle」。
   *   预热的是**回写之后**的 conversationId（那才是渲染层要看的键），
   *   没有回写时就是原值。
   *
   * **本方法绝不 reject；每个条目都被尝试过。** store.updateSession 是这里唯一
   * 可能抛的一环（store.load / listSessions / readLiveness / panePid 全都在
   * 内部各自吞掉异常），所以单条的写回失败必须**在循环里**捕获：否则一次
   * `保存` 失败会让 restoreAll 的整批恢复停在半路 —— 后面的条目一条都不再
   * reconcile，连 `openSession` 循环都进不去，而 reject 会掉进
   * `void (async …)()` 里无声消失（同 applyToMany 的「一条失败不影响其余」）。
   *
   * `snap` 传入则复用该快照（restoreAll 走这条：它要拿同一份再逐条喂给
   * openSession → reconcileOne），不传才自己读一份。
   */
  async reconcileAll(
    entries: readonly TerminalEntry[],
    /** 整批共用的一份快照（可选）。传入则复用；不传则自己 `readLiveness` 一份。 */
    snap?: LivenessSnapshot,
  ): Promise<boolean> {
    const alive = new Set(await this.tmux.listSessions());
    const snapshot = snap ?? (await readLiveness(this.home()));
    let wrote = false;
    for (const entry of entries) {
      // v3：观测、绑定、回写都落在**槽**上（tmux 会话名由槽 id 派生），
      // 因此这里要遍历该条目下的**每一个**槽 —— 只取 sessions[0] 的话，同一个
      // 终端下第 2 个起的会话永远不会被观测，它们的绑定会永久停在原值上。
      // 注意：整批仍然只读**一份** snapshot（上面那一份），循环套在它外面。
      // 没有槽的条目自然什么都不做：没有槽就没有会话名可查，硬凑一个等于去
      // 观测一个跟它毫无关系的会话，然后把结果写进别人的槽。
      for (const slot of entry.sessions) {
        if (!alive.has(sessionNameFor(slot.id))) continue; // 该槽的会话不在了 → 不观测
        try {
          const live = await this.liveFor(snapshot, slot);
          // reconcileBinding 一个字符都没改：它本来只认
          // {conversationId, liveSessionId} 这个形状，SessionSlot 结构上正是它。
          const patch = reconcileBinding(slot, live);
          this.titles?.prewarm(patch?.conversationId ?? slot.conversationId, this.cwdFor(entry));
          if (patch === undefined) continue;
          // 必须走槽级原语（锁内读-改-写）：在锁外「读出数组→改一个槽→写回」会
          // 让同一终端下两个槽的改动互相盖掉（lost update），表现为「改绑偶尔
          // 不生效」。**同一轮里两个槽各算一次补丁**，正是这条约束最容易破的
          // 场景（同条目、同一次 reconcile）。
          await this.store.updateSession(entry.id, slot.id, patch);
          wrote = true;
        } catch {
          // 单条写回失败不该中断整批（见本方法注释与 restoreAll 的契约）。
          // 这条绑定没刷成，但其余槽照常观测、照常回写。
        }
      }
    }
    // 每批最多通知一次（不放进循环里逐条回调）：树重算是整棵的，
    // 批量回写 10 条没有理由刷 10 次。返回值语义不变，调用方仍在用。
    if (wrote) this.onBindingsChanged?.();
    return wrote;
  }

  /**
   * 轮询节拍上的低频重试：把**当前所有条目的全部会话槽**的绑定对话交给标题
   * 缓存，由缓存对「已绑定但还没缓存到标题」的那些按冷却重新发起预取。
   *
   * 与 reconcileAll / reconcileOne 里那两次 prewarm 是**互补**关系，不是替代：
   * 那两处覆盖「用户动作 → 当场观测一次」，这里覆盖「期间没有任何用户动作，
   * 但标题是**后来才生成**的」—— /new 之后的新对话正是后者。
   *
   * **为什么转换放在 manager 而不是 extension.ts**：cwd 要经 `cwdFor` 展开
   * `~`（与上面两处 prewarm 同源，写错就定位不到 transcript），槽 →
   * 「绑定 + cwd」的形状转换也只该有一处。
   *
   * 不查缓存、不做去重，全交给缓存内部（成本只是每拍几次 Map 查询）。
   * `titles` 省略或实现没提供 retryMissing 时是 no-op。
   */
  retryTitles(entries: readonly TerminalEntry[]): void {
    this.titles?.retryMissing?.(
      entries.flatMap((e) =>
        e.sessions.map((s) => ({ conversationId: s.conversationId, cwd: this.cwdFor(e) })),
      ),
    );
  }

  /**
   * 单条版本；三处触发用 —— openSession 的点击、restartClaude 的切 profile、
   * 以及 restoreAll 批量恢复时逐条复用同一份快照。
   * 返回回写后的**槽**（无变化时原样返回）**与本次观测到的活跃会话 id** ——
   * 后者供 resolveLaunchSpec 的兜底 D 判断「claude 是不是真的不在了」，
   * 免得为同一个判断再观测一次（多 spawn 一个 `ps`，还可能得出不一致的结论）。
   *
   * **槽由调用方传进来，不在这里取 `sessions[0]`**：调用方（openSession /
   * restartClaude）已经挡过「空槽」这一路，内部再取一次只会把那个状态悄悄
   * 吞成 undefined —— 返回一个不是入参的槽，调用方却以为观测过了。
   *
   * **`snap` 传入则复用、不传才自己读一份。** 这是 spec §4.3/§8「整批条目
   * 共用一份快照，`ps` 只 spawn 一次」在单条入口上的落点：restoreAll 先读
   * **一份**、跑一次 reconcileAll，再把同一份逐条透传进来 —— 否则 N 个条目
   * 会各 spawn 一次 `ps`，恰好在**最常用的批量动作**上违背该约束。
   *
   * tmux 会话不存在时不做任何观测，返回 { 原槽, undefined }。
   * 刻意**不**经 reconcileAll 的 in-flight 合并：这几处都是低频动作，
   * 且用户就在等结果（见 spec §5.1 / §5.4）。
   */
  private async reconcileOne(
    entry: TerminalEntry,
    slot: SessionSlot,
    /**
     * 整批共用的一份快照（可选）。传入则复用；不传则自己 `readLiveness` 一份。
     */
    snap?: LivenessSnapshot,
  ): Promise<{ slot: SessionSlot; live: string | undefined }> {
    const session = sessionNameFor(slot.id);
    if (!(await this.tmux.hasSession(session))) return { slot, live: undefined };

    const snapshot = snap ?? (await readLiveness(this.home()));
    const live = await this.liveFor(snapshot, slot);
    const patch = reconcileBinding(slot, live);
    this.titles?.prewarm(patch?.conversationId ?? slot.conversationId, this.cwdFor(entry));
    if (patch === undefined) return { slot, live };

    await this.writeBinding(entry.id, slot.id, patch);
    return { slot: { ...slot, ...patch }, live };
  }

  /**
   * 写**槽**的绑定并通知树。**所有**回写绑定的地方都走这里 —— 少一处通知，
   * 树上那两处显示（三级任务名、tooltip 的「对话」行）就会静默停在旧值。
   *
   * 落点是 `store.updateSession` 而不是 `store.update`：patch 是在**锁外**由
   * reconcile / 用户选择算出来的，必须让 store 在锁内读-改-写那个槽。走 update
   * 就得先拼出整个 `sessions` 数组，同一终端下两个槽并发改动时后写者盖先写者。
   *
   * 与 `reconcileAll` 的分工：那里是整批共用一份快照、循环跑完按 `wrote`
   * **一次性**通知（见该方法末尾），所以它**不**走这个出口，否则一批 N 条
   * 会刷 N 次树。单条写入（reconcileOne、resolveLaunchSpec 各分支、
   * bindConversationInteractive）一律走这里。
   */
  private async writeBinding(
    entryId: string,
    sessionId: string,
    patch: Partial<SessionSlot>,
  ): Promise<void> {
    await this.store.updateSession(entryId, sessionId, patch);
    this.onBindingsChanged?.();
  }

  private cwdFor(entry: TerminalEntry): string {
    return expandHome(entry.cwd, this.home());
  }

  /**
   * 该终端下**此刻存活**的槽（tmux 会话在）。
   *
   * 条目级动作（切 profile / 切模型）作用在整个终端上，但能**立刻**生效的只有
   * 存活的那些会话：死掉的槽不用去打扰，它下次启动时由 commandFor 带上新配置，
   * 本来就会是新的。所以这里返回的是「需要现在动手」的那批，而不是「全部」。
   */
  private async aliveSlots(entry: TerminalEntry): Promise<SessionSlot[]> {
    const out: SessionSlot[] = [];
    for (const slot of entry.sessions) {
      if (await this.tmux.hasSession(sessionNameFor(slot.id))) out.push(slot);
    }
    return out;
  }

  /**
   * 在模态确认框里点名「作用在哪一个会话槽上」。
   *
   * 只写终端名是不够的：一个终端可以挂 N 个会话，而三级菜单里的条目级动作
   * （profile / 模型 / 颜色 / 复制）作用范围是**整个终端** —— 不点名，用户在
   * 一个会话行上点「切换直连」会以为只切了这一个（spec §7.3、§7.5）。
   *
   * 用**显示序号**（1 起，load 已按 order 排好）而不是槽 id：id 是随机十六进制
   * 串，在对话框里认不出来；序号与树上第几行一一对应。找不到（调用方手里的
   * 条目副本已过期）时退回中性说法，绝不编一个序号出来。
   */
  private slotLabel(entry: TerminalEntry, slot: SessionSlot): string {
    const i = entry.sessions.findIndex((s) => s.id === slot.id);
    return i < 0 ? '该会话' : `第 ${i + 1} 个会话`;
  }

  /**
   * 打开（接回或重建）一个**会话**。
   *
   * 对一个会话必须保证：**会话存在 + 至少一个客户端附着 + 有一个面板在
   * 显示它**。判据见 core/restore.ts —— 内存 Map 与「终端同名」只用来挑
   * 面板，绝不用于断定「已经恢复好了」（那是 v2 首发的 bug：会话已死或
   * 0 附着时提前 return，用户只看到退回 cd 目录的裸 shell）。
   *
   * 不变量一：竞态兜底**只能把命令降级为不发，永远不能凭空加出命令**。
   * 任何「会话可能已属于别人」的迹象都必须导致 `allowLaunch = false`。
   *
   * 不变量二：**只有 pane 前台确实是登录 shell 时才允许往会话里发送启动
   * 命令**（见 core/tmux.ts 的 isShellReady）。claude 还在跑 → attach 上去
   * 就对了，绝不打扰；别的进程在跑（编译、REPL）→ 宁可不做，绝不盲发。
   *
   * `slot` 是**运行期可能为 undefined** 的（见下），所以它没有直接用
   * `sessions[0]` 那种写法：那是「编译器看不见这种可能」的写法。
   */
  async openSession(
    entry: TerminalEntry,
    /**
     * 要打开的会话槽。**运行期可能是 undefined** —— v3 允许 `sessions: []`
     * （用户把会话都删了），而 tsconfig 没开 noUncheckedIndexedAccess，
     * `entry.sessions[0]` 在类型层看不出这一点。
     */
    slot: SessionSlot | undefined,
    /**
     * 批量恢复（restoreAll）传入的**共享快照**：透传给 reconcileOne，
     * 让整批只 spawn 一次 `ps`（spec §4.3/§8）。
     * 单条触发（点击会话行、⟳ 刷新、切 profile）省略它，由 reconcileOne
     * 自己读一份。
     */
    opts?: { snap?: LivenessSnapshot },
  ): Promise<void> {
    // 空槽的条目**什么都不做**：没有槽就没有 id，tmux 会话名无从派生 ——
    // 现场编一个等于凭空造一个会话（用户点一下，后台就多一个 claude 在跑，
    // 而他从没要求过）。不打开、不观测、不回写，静默返回。
    // 树上这种条目本就不可展开、点不到，所以这条守卫正常永远走不到。
    if (slot === undefined) return;

    // tmux 会话名由**槽** id 派生（v3），与显示名解耦（显示名可随意改名）。
    // cwd 仍取自条目 —— 名称与目录都是条目级的配置。
    const session = sessionNameFor(slot.id);
    const cwd = this.cwdFor(entry);

    // 点击会话行 = reconcile 的触发点之一（不引入定时器，见 spec §4.3）。
    // 必须在算 --resume 之前：/new 之后「这个槽在用哪条会话」已经变了，
    // 正确答案得重新观测。返回改绑后的新槽（后续一律用它）与本次观测到
    // 的活跃会话 id（兜底 D 要用它判断 claude 是不是真的不在了）。
    // opts?.snap 由 restoreAll 批量透传 —— 单条触发时为 undefined，
    // reconcileOne 自己读一份。
    const { slot: current, live } = await this.reconcileOne(entry, slot, opts?.snap);

    // ---- 权威事实：会话是否存在、有几个客户端附着 ----
    const sessionExists = await this.tmux.hasSession(session);
    // 会话不存在时不必（也无法）问附着数；已知 0 与「未知」都走同一条
    // 「必须 attach」的分支（decideOpen 里 null 也按保守处理）。
    const attached = sessionExists ? await this.tmux.attachedClients(session) : 0;
    // pane 前台进程 —— 决定「允许不允许往这个会话里发送启动命令」。
    // 空串（display-message 静默失败）必须判为「不是登录 shell」，
    // isShellReady('') 恰好为 false，方向是对的。
    const paneCommand = sessionExists ? await this.tmux.currentCommand(session) : '';

    const candidate = this.candidatePanel(session, entry.name);
    const action = decideOpen(
      { exists: sessionExists, attached },
      {
        present: candidate !== undefined,
        idle: candidate !== undefined && this.isIdlePanel(candidate),
      },
    );

    // 已恢复：会话在、有人在看、面板也在手。show 一下就行，不重复 attach。
    if (action === 'show' && candidate !== undefined) {
      this.terminals.set(session, candidate);
      candidate.show();
      return;
    }

    // 会话不存在时由扩展 detached 建出来，拿到确定的成功/失败信号。
    // allowLaunch：竞态闸门。只有「这个会话确实该由我们启动 claude」才为真。
    let allowLaunch = false;
    let shellReady = false;
    if (!sessionExists) {
      if (await this.tmux.newSession(session, cwd)) {
        allowLaunch = true;
        // 新建的会话 pane 必然是登录 shell，但是否已就绪要等（放在 attach
        // 之后等，别让面板晚出现）
      } else if (await this.tmux.hasSession(session)) {
        // 竞态：等待期间被别的窗口建出来了 → 转为接回，绝不发命令
        vscode.window.showInformationMessage(
          `会话「${entry.name}」刚被其他窗口创建，改为接回，不执行预设命令。`,
        );
      } else {
        // 真的建不出来（tmux 不可用、cwd 不存在等）
        const t = this.createOwnPanel(entry.name);
        this.terminals.set(session, t);
        t.show();
        vscode.window.showErrorMessage(
          `无法创建 tmux 会话「${entry.name}」。已打开普通终端，请检查 tmux 是否可用、目录是否存在：${cwd}`,
        );
        return;
      }
    } else {
      // 会话原本就存活。**claude 是否还在跑，决定我们能不能碰它**：
      // 前台是登录 shell 说明 claude 已退出（这次要接回它的对话）；
      // 前台是 claude 说明对话原样在跑 —— attach 上去就对了，绝不打扰。
      allowLaunch = true;
      shellReady = isShellReady(paneCommand);
    }

    // 复用只在 decideOpen 判定「已证明空闲」时才走到（action === 'reuse-attach'），
    // 因此这里往里打字不会打断面板里可能跑着的进程。
    let terminal: vscode.Terminal;
    if (action === 'reuse-attach' && candidate !== undefined) {
      terminal = candidate;
    } else {
      try {
        terminal = this.createOwnPanel(entry.name, cwd);
      } catch {
        vscode.window.showWarningMessage(`目录不存在，已在主目录打开：${cwd}`);
        terminal = this.createOwnPanel(entry.name);
      }
    }
    this.terminals.set(session, terminal);
    terminal.show();

    // 此刻会话必定存在（原本存活、刚建成功、或被抢先建出），一律 attach。
    // 命令行字符串要塞进 shell 执行，故此处需要 shell 引用。
    terminal.sendText(`tmux attach -t ${shellQuote('=' + session)}`, true);

    if (!allowLaunch) return;

    // 新建出来的会话要等 shell 就绪；存活会话已在开头看过前台进程。
    if (!sessionExists) {
      shellReady = await this.tmux.waitForShell(session, SHELL_READY_TIMEOUT_MS);
      if (!shellReady) {
        vscode.window.showWarningMessage(
          `tmux 会话「${entry.name}」未在 ${SHELL_READY_TIMEOUT_MS / 1000}s 内就绪，已跳过启动 claude。`,
        );
        return;
      }
    }
    if (!shellReady) return;

    // 在条目自己的 cwd 里启动 —— `--resume` 是按 cwd 作用域的，
    // 而会话本就是 `-c cwd` 建的，pane 的 cwd 与之一致。
    // resolveLaunchSpec 可能弹一次 QuickPick（老条目没有绑定时），也可能
    // 返回 undefined 表示「这次什么都不启动」（用户取消 / 绑定与本目录冲突）。
    // 用**回写之后**的槽：它带着本次观测到的最新绑定，--resume 接哪一条由它决定。
    const spec = await this.resolveLaunchSpec(entry, current, live);
    if (spec === undefined) return;

    // 判据必须在**发送前**重算。resolveLaunchSpec 中间可能弹一次 QuickPick
    // 并等用户思考很久（老条目首次恢复必弹），这期间用户完全可能在同一个
    // pane 里起了 build —— 一开始算出来的 shellReady 那时早已不作数。
    // 窗口从「用户思考时长」压到一次 display-message（毫秒级）。
    if (!isShellReady(await this.tmux.currentCommand(session))) {
      void vscode.window.showWarningMessage(
        `「${entry.name}」的终端里已经有别的程序在跑，已跳过启动 claude（绝不打断它）。` +
        `等它结束后再点一次该条目即可。`,
      );
      return;
    }

    // 命令由**条目**派生（profile / model 是条目级的），接哪条对话由 spec 带着。
    await this.tmux.sendLiteral(session, conversationCommand(entry, spec));
    await this.tmux.sendEnter(session);

    // 只有 `resume` 需要盯 pane：它是**唯一**可能因「对话不在这个目录下」
    // 而失败的一支（claude 会打印 `No conversation found` 就退出）。`new` /
    // `fresh` 都是当场开一条新对话，没有「接不上」这回事。
    if (spec.kind === 'resume') await this.warnIfResumeFailed(session, entry);
  }

  /**
   * 发完 `--resume` 后盯一眼 pane：claude 找不到那条对话时会打印
   * `No conversation found` 然后退出，pane 退回裸 shell。不主动看的话，
   * 用户只会觉得「又没接上」，无从知道原因，也无从知道该怎么办。
   *
   * **只读**，只看 pane 可视区域的末尾几行（见 core/claude.ts#resumeFailed），
   * 绝不往 pane 里写任何东西。成功时会在下一次轮询就发现前台变成了 claude，
   * 提前退出，不白等。
   */
  private async warnIfResumeFailed(session: string, entry: TerminalEntry): Promise<void> {
    const deadline = Date.now() + RESUME_CHECK_TIMEOUT_MS;
    for (;;) {
      if (isClaudeCommand(await this.tmux.currentCommand(session))) return; // 起来了
      if (resumeFailed(await this.tmux.capturePane(session))) {
        void vscode.window.showErrorMessage(
          `「${entry.name}」的对话没能接回（原对话不在该目录下）。` +
          `右键该条目选「选择要接回的对话…」可手动指定。`,
        );
        return;
      }
      if (Date.now() >= deadline) return;
      await new Promise((r) => setTimeout(r, RESUME_CHECK_INTERVAL_MS));
    }
  }

  /**
   * 恢复所有标记了 autoRestore 的条目 —— 恢复的是它们的**每一个会话槽**。
   *
   * autoRestore 是**条目**的属性（「这个终端要不要参与一键恢复」），所以它对其下
   * 所有会话生效：一个挂着 3 个会话的终端被标为参与恢复，就是恢复 3 个会话。
   * 这与「profile / 模型只存在二级一份、三级共享」是同一个模式的延伸。
   *
   * 终端并行打开，**不 await openSession**：它会等 `waitForShell`
   * （上限 3s）并逐个派发预设命令。若串行 await，N 个槽在某个会话迟迟不就绪时
   * 最坏要等 N×3s 才全部开完 —— 而用户要的正是「一次点开整组工作区」。并行则
   * 各终端的命令派发互不阻塞。
   *
   * 错误必须逐个捕获：openSession 内部已自行把失败呈现给用户，这里
   * 只防止一个槽的异常中断整批恢复。
   */
  restoreAll(): void {
    void (async () => {
      const entries = (await this.store.load()).filter((e) => e.autoRestore);
      // 判据按**条目**（与今天一致），不看槽数：否则「有 3 个条目但都是 0 槽」
      // 会静默什么都不做，用户以为按钮坏了。
      if (entries.length === 0) {
        vscode.window.showInformationMessage('没有标记为「参与全部恢复」的条目。');
        return;
      }
      // 整批共用**一份** LivenessSnapshot：先跑一次 reconcileAll 回写绑定，
      // 再把同一份快照逐条透传给 openSession → reconcileOne，全程只 spawn 一次
      // `ps`。spec §4.3/§8 的「共享快照」约束必须在**最常用的批量路径**上
      // 成立 —— 否则 N 个槽各 spawn 一次 `ps`。
      const snap = await readLiveness(this.home());
      await this.reconcileAll(entries, snap);
      for (const e of entries) {
        // flatten 到**槽**：一个条目要开的终端数与它的会话数一样多。
        // 槽数为 0 的条目在这里**不产生任何恢复动作**（它没有会话可恢复），
        // 但也不算失败 —— 循环体一次都不进。
        for (const slot of e.sessions) {
          void this.openSession(e, slot, { snap }).catch(() => {
            // openSession 已经把可预期的失败呈现给用户了；这里只兜住意外异常，
            // 避免一个会话炸掉整批恢复
          });
          // 轻微错开，避免 N 个终端在同一瞬间争抢创建
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    })();
  }

  // ---- 切模型 / 切 profile（运行中立即生效） ----

  /**
   * 判断能否向该会话发送控制序列（`/model ...`、`/exit`）。
   *
   * **安全闸门。** 目标不是 claude 时，这些字符会变成键盘输入打进用户正在
   * 跑的进程 —— 一条 `/exit` 能毁掉一次编译。判据见 core/claude.ts：严格
   * 要求基名以 claude 开头，绝不把 node 当作 claude。
   */
  private async canSendControl(session: string): Promise<boolean> {
    return isClaudeCommand(await this.tmux.currentCommand(session));
  }

  /** 拒绝执行并说明原因。绝不静默跳过、绝不盲发。 */
  private refuse(entry: TerminalEntry, what: string): void {
    void vscode.window.showErrorMessage(
      `「${entry.name}」当前前台进程不是 claude，已拒绝${what}。` +
      `请先在该终端里退出正在运行的程序（或直接杀掉会话），再试。`,
    );
  }

  /**
   * 退出当前 claude 并按 `launch` 的配置重新启动，**接回原来那条对话**
   * （两个 profile 共用 ~/.claude/projects/，实测）。
   *
   * 接回方式：**必须** `--resume <绑定的那条>`。没有绑定就**拒绝**，
   * 提示用户先绑定 —— 绝不退回 `--continue`：实测用户 4 个条目共用同一个
   * cwd，`--continue` 接的是「该 cwd 下最近的一条」，几个条目会一起接到
   * 同一条对话上去，两边的 claude 同时写同一个 .jsonl，是数据损坏级的
   * 问题。宁可这次不重启，也不能接到错的对话上去。
   *
   * `launch` 与 `entry` 分开传：调用方常需要「改某个字段后再启动」
   * （如清掉 model 以回落到 profile 默认），而提示语仍要用原条目的名字。
   *
   * 返回 false 表示被安全守卫拒绝。
   */
  private async restartClaude(
    entry: TerminalEntry,
    /**
     * 要重启的**槽**。只由 applyProfile 传进来，且只传它挑出的**存活**槽 ——
     * 因此这里不再有「空槽」那一路：一个槽都没有时 applyProfile 根本不会走到
     * 重启（没有会话可重启，直接落配置）。绑定取自这个槽。
     */
    slot: SessionSlot,
    launch: TerminalEntry,
  ): Promise<boolean> {
    const session = sessionNameFor(slot.id);

    // 切 profile 也是 reconcile 的触发点（spec §4.3）。必须 `--resume` 之前做：
    // 用户刚在 pane 里 /new 过，静态 conversationId 已经不是终端在用的那条。
    // 只观测这个**槽**（会话归属由槽 id 派生），launch 的 profile/model 覆盖
    // 不受影响。
    const { slot: current } = await this.reconcileOne(entry, slot);
    const bound = current.conversationId;
    if (bound === undefined || bound.length === 0) {
      void vscode.window.showErrorMessage(
        `「${entry.name}」的${this.slotLabel(entry, slot)}还没有绑定对话，已拒绝重启 —— ` +
        `无法确定该接回哪一条。请先用右键菜单「选择要接回的对话…」绑定，再切 profile。`,
      );
      return false;
    }
    if (!(await this.canSendControl(session))) {
      this.refuse(entry, '重启 claude');
      return false;
    }

    await this.tmux.sendLiteral(session, '/exit');
    await this.tmux.sendEnter(session);

    // 等回到 shell —— 用既有轮询而非固定 sleep
    if (!(await this.tmux.waitForShell(session, SHELL_READY_TIMEOUT_MS))) {
      void vscode.window.showWarningMessage(
        `「${entry.name}」未在 ${SHELL_READY_TIMEOUT_MS / 1000}s 内回到 shell。` +
        `claude 可能已经退出，配置未改动 —— 请在该终端里重开（或杀掉会话）。`,
      );
      return false;
    }

    // 改的是**绑定**，不是 profile/model：launch 是调用方构造的覆盖层
    // （applyProfile 传 `{ ...entry, profile, model: undefined }`），profile/model
    // 原样保留。v3 的绑定在**槽**上，不再需要把它合并回条目 —— 它由 bound 单独
    // 带着，写进 LaunchSpec 就够了。
    await this.tmux.sendLiteral(session, conversationCommand(launch, { kind: 'resume', conversationId: bound }));
    await this.tmux.sendEnter(session);
    await this.warnIfResumeFailed(session, entry);
    return true;
  }

  /**
   * 把模型设置应用到**一个终端**（model 只存在条目上，其下所有会话共享）。
   *
   * 未运行的会话：只改配置。下次 openEntry 由 commandFor 带出 `--model`
   * （实测 `--model` 启动参数**不**污染全局默认）。
   *
   * 运行中的会话：发 `/model <目标>` 立即生效。这是**唯一**能改掉一个活
   * 对话当前模型的机制（实测 bare `claude --continue` 会保留原对话的模型，
   * 命令行 `--model` 也盖不过 resumed 会话），代价是 `/model` 会顺带改写
   * `~/.claude/settings.json` 的全局默认 —— 这是用户显式接受的取舍。
   *
   * **每个存活的槽都要发一次**：一个终端挂 3 个 claude，只给第一个发等于
   * 另外两个默默跑在旧模型上 —— 而用户看到「设置成功」的提示，无从察觉。
   *
   * 清空（model 未给）时回落到该 profile 的默认模型；读不到默认则只落
   * 配置、提示下次启动生效。
   */
  /**
   * 返回 false 表示被安全守卫拒绝，未改动配置；true 表示已成功应用。
   * 注意「目标模型无法确定」（清空且读不到 profile 默认）**不是**失败：
   * 它照常落配置、返回 true，只是推迟到下次启动生效。
   * 与 restartClaude 一样用布尔回报结果，供批量套用据此统计
   * 「成功/失败」，而非把拒绝当成功。
   */
  async applyModel(entry: TerminalEntry, model: string | undefined): Promise<boolean> {
    // 能立刻生效的是「其下所有**存活**的槽」。一个都没有（`sessions: []`，
    // 或全是死会话）与「会话没在跑」同侧：只落配置，下次启动时生效。
    const alive = await this.aliveSlots(entry);
    const normalized = model && model.length > 0 ? model : undefined;

    if (alive.length === 0) {
      await this.store.update(entry.id, { model: normalized });
      return true;
    }

    // 目标模型：显式给出就用它；清空则回落到该 profile 的默认模型。
    const cfg = await readProfileConfig(entry.profile, this.home());
    const target = normalized ?? cfg.defaultModel;

    if (target === undefined) {
      // 清空且读不到默认（无 models / 无 model 键）→ 无法发 /model，
      // 只落配置，下次启动时生效。
      await this.store.update(entry.id, { model: normalized });
      void vscode.window.showInformationMessage(
        `「${entry.name}」未读到 ${entry.profile} 的默认模型，已保存为「下次启动生效」。`,
      );
      return true;
    }

    // 安全闸门对**每一个**存活槽都过一遍，且**都在发送之前**：只切一半会让
    // 用户以为切好了，而实际上还有会话跑在旧模型上 —— 那种不一致比整体拒绝
    // 更难排查。任一个不合格就整体拒绝、不改配置（与从前单会话时的语义一致）。
    for (const slot of alive) {
      if (!(await this.canSendControl(sessionNameFor(slot.id)))) {
        this.refuse(entry, '切模型');
        return false;
      }
    }
    // 控制字符会把一行 `/model x` 拆成两条输入：`sendLiteral` 不解释 `\n`，
    // 但终端把它当回车 —— 第二行会作为新的键盘输入打进活着的会话。模型名
    // 来自 settings.json，手改就可能带上换行。宁可拒绝，绝不盲发。
    if (/[\r\n]/.test(target)) {
      void vscode.window.showErrorMessage(
        `「${entry.name}」的目标模型名含换行符，已拒绝发送 /model（疑似 settings.json 被改坏）。`,
      );
      return false;
    }
    for (const slot of alive) {
      const session = sessionNameFor(slot.id);
      await this.tmux.sendLiteral(session, `/model ${target}`);
      await this.tmux.sendEnter(session);
    }
    await this.store.update(entry.id, { model: normalized });
    return true;
  }

  /**
   * 切换 profile（ccr ↔ direct），即换鉴权来源与端点。
   *
   * 重启 CLI 并用 `--resume <该条目绑定的对话>` 接回原对话 —— 两个 profile
   * 共用 `~/.claude/projects/`（实测 direct.json 不覆盖该目录）。
   * 没有绑定则拒绝重启（见 restartClaude）：绝不退回复 `--continue`。
   *
   * model 一并清空：两个 profile 的模型命名空间不同（deepseek-* vs
   * claude-*），沿用旧值几乎必然无效，回落到新 profile 的默认才正确。
   *
   * **其下每个存活的槽都要重启**，而且各自 `--resume` **自己**那条对话
   * （绑定在槽上，不在条目上）：一个终端挂 3 个 claude，只重启第一个等于
   * 另外两个还在用旧 profile 的端点与鉴权。
   */
  /**
   * 返回 false 表示被安全守卫拒绝（或重启失败），未改动配置；true 表示
   * 已切换成功。profile 未变时返回 true（无事可做，不算失败）。
   */
  async applyProfile(entry: TerminalEntry, profile: Profile): Promise<boolean> {
    if (entry.profile === profile) return true;
    // 只有存活的槽需要重启；一个都没有就直接落配置。
    const alive = await this.aliveSlots(entry);

    for (const slot of alive) {
      const ok = await this.restartClaude(entry, slot, { ...entry, profile, model: undefined });
      // 被拒绝时不动配置。**中途失败也整体不落配置**：已经重启过的槽接回的是
      // 各自的对话、配置没变，还是旧 profile —— 与「什么都没发生」自洽；
      // 若这时落配置，树显示新 profile 而部分会话仍跑旧端点，反而对不上。
      if (!ok) return false;
    }
    // model 必须一并落盘：store.update **合并**补丁，只写 profile 会让旧的
    // model（ccr 命名空间，如 deepseek-*）残留 —— 启动命令会带着无效的
    // --model，冷启动随即失败。清空才与新 profile 的命名空间一致。
    await this.store.update(entry.id, { profile, model: undefined });
    return true;
  }

  /**
   * 批量套用。逐条独立捕获异常，沿用 restoreAll 的写法：一条失败不影响
   * 其余，结束后汇报「成功 N / 失败 M」。
   */
  private async applyToMany(
    entries: TerminalEntry[],
    label: string,
    one: (e: TerminalEntry) => Promise<boolean>,
  ): Promise<void> {
    if (entries.length === 0) {
      void vscode.window.showInformationMessage('没有选中任何条目。');
      return;
    }
    let ok = 0;
    const failed: string[] = [];
    for (const e of entries) {
      try {
        // 成败由 one 的返回值裁决：守卫拒绝返回 false，不能算成功。
        if (await one(e)) ok++;
        else failed.push(e.name);
      } catch {
        // 只兜意外异常；守卫拒绝不是异常，上面的 false 分支已经处理
        failed.push(e.name);
      }
      // 轻微错开，避免同时重启多个 claude 争抢资源
      await new Promise((r) => setTimeout(r, 50));
    }
    const msg = failed.length === 0
      ? `${label}：成功 ${ok} 条。`
      : `${label}：成功 ${ok} 条，失败 ${failed.length} 条（${failed.join('、')}）。`;
    void vscode.window.showInformationMessage(msg);
  }

  async applyModelToMany(entries: TerminalEntry[], model: string | undefined): Promise<void> {
    await this.applyToMany(entries, '批量设置模型', (e) => this.applyModel(e, model));
  }

  async applyProfileToMany(entries: TerminalEntry[], profile: Profile): Promise<void> {
    await this.applyToMany(entries, '批量切换直连/中转', (e) => this.applyProfile(e, profile));
  }

  /** 单条：选一个模型。清单来自 profile 的 settings；读不到则允许手输。 */
  async setModelInteractive(entry: TerminalEntry): Promise<void> {
    const { models } = await readProfileConfig(entry.profile, this.home());
    const MANUAL = '$(pencil) 手动输入…';
    const pick = await vscode.window.showQuickPick([...models, MANUAL], {
      title: `为「${entry.name}」设置模型（${entry.profile}）`,
      placeHolder: entry.model ?? '（当前用 profile 默认）',
    });
    if (pick === undefined) return;

    let model: string | undefined = pick === MANUAL ? undefined : pick;
    if (pick === MANUAL) {
      const typed = await vscode.window.showInputBox({
        title: '模型名',
        prompt: '留空 = 用 profile 默认模型',
        value: entry.model ?? '',
      });
      if (typed === undefined) return;
      model = typed.trim().length > 0 ? typed.trim() : undefined;
    }
    await this.applyModel(entry, model);
  }

  /** 单条：在 ccr / direct 之间切换。 */
  async setProfileInteractive(entry: TerminalEntry): Promise<void> {
    const target: Profile = entry.profile === 'direct' ? 'ccr' : 'direct';
    const label = target === 'direct' ? '🟠 direct（官方直连）' : '🔵 ccr（本地中转）';
    const pick = await vscode.window.showWarningMessage(
      `把「${entry.name}」切到 ${label}？运行中的 claude 会重启，并接回该条目绑定的对话。`,
      { modal: true },
      '切换',
    );
    if (pick !== '切换') return;
    await this.applyProfile(entry, target);
  }

  // ---- 交互式增删改 ----

  /**
   * 新建一个终端条目，**会问目录**。标题栏那个 `+` 用它。
   *
   * `defaultCwd` 只作为 `askCwd` 的预填**占位值**，用户照样可以改 —— 这条路
   * 上没有「已经写在界面上的答案」，目录必须问。
   *
   * 一级（文件夹）行上的 `+` **不走这里**：那一行本身就是那个 cwd，见
   * `addEntryInFolderInteractive`。
   */
  async addEntryInteractive(defaultCwd?: string): Promise<void> {
    const all = await this.store.load();
    const name = await this.askName('', all.map((e) => e.name));
    // 必须用 undefined 判断取消，不能用 `!name`：validateName 已禁止空名，
    // 所以空串只可能来自「用户按 Esc」→ askName 返回 undefined。写成
    // `!name` 恰好也拦住了取消，语义却是错的，日后放开空名就会变成
    // 「取消后仍继续往下问目录」。
    if (name === undefined) return;
    const cwd = await this.askCwd(defaultCwd);
    if (cwd === undefined) return;
    const autoRestore = await this.askAutoRestore(true);
    if (autoRestore === undefined) return;
    await this.appendEntry(name, cwd, autoRestore);
  }

  /**
   * 在某个**一级（文件夹）行**下新建终端：问名字 → 问是否参与恢复，
   * **绝不问目录**。
   *
   * 那一行**本身就是那个 cwd**（`groupByCwd` 按 cwd 分组出来的虚拟节点）。
   * 再弹一次目录框，等于让用户回答一个界面上已经写着、而且他就是冲着它点的
   * 问题 —— 用户明确反馈过「点 + 还在问工作路径」。这条 `+` 的语义就是
   * 「在这个目录下建一个终端」，目录不是可选项，是前提。
   *
   * 继承方式是**原样采用** `cwd`：不归一化、不展开 `~`。`cwd` 来自
   * `FolderTreeItem`，本来就是清单里的原值 —— 归一化会让这一行分出来的条目
   * 与清单里同目录的其它条目长出两种写法，`groupByCwd` 随后把它们分成两组。
   */
  async addEntryInFolderInteractive(cwd: string): Promise<void> {
    const all = await this.store.load();
    const name = await this.askName('', all.map((e) => e.name));
    if (name === undefined) return;
    const autoRestore = await this.askAutoRestore(true);
    if (autoRestore === undefined) return;
    await this.appendEntry(name, cwd, autoRestore);
  }

  /**
   * 两个新建入口的**唯一落盘出口**（标题栏的 `+` 与一级行上的 `+`）。
   *
   * 抽出来是因为下面这段「槽必须怎么造」的规则一条都不能漏，而它有两个入口
   * —— 复制一遍就会有一份先腐坏，症状（两个 claude 同写一条 .jsonl）与真正的
   * 并发 bug 长得一样。
   */
  private async appendEntry(name: string, cwd: string, autoRestore: boolean): Promise<void> {
    // 新建条目**必须带 1 个空会话槽**，不是 0 个：0 槽的条目会显示成不可展开
    // 的一行、点了也没反应，比今天差 ——「建完点开就能用」与今天的体验必须一致。
    //
    // 槽 id 用**新 id**，不再借用条目 id：那条「槽 id = 条目 id」的规则只属于
    // v1/v2 迁移（迁移面对的是「别人已经拿旧 id 建好了 tmux 会话」的局面，
    // 见 core/migrate.ts）。新条目没有这个包袱，两种来源的 id 也不会撞。
    //
    // 槽里预分配 conversationId：这样「无 conversationId」此后**只**表示
    // 「本功能上线前的老条目」，新建的条目永远不会被弹选择框。
    // 注意这个 id 此刻**还没有对应任何对话** —— 首次启动走的是 `fresh`
    // （裸 claude，一个会话参数都不带），这条 id 只是占住「已绑定、别弹
    // 选择框」的位；真正在用的那条对话由 reconcile 观测到之后回写
    // （见 resolveLaunchSpec 与 core/reconcile.ts）。
    await this.store.append({
      id: newId(), name, cwd, profile: 'ccr', autoRestore,
      sessions: [{ id: newId(), conversationId: newConversationId(), order: 0 }],
    });
  }

  /**
   * 在某个终端下加一个会话槽（二级行上的 `+`）。
   *
   * **零弹框**：问名字、问目录在这里都没有意义（名字与目录是二级的配置，
   * 新会话全继承）。
   *
   * **槽一出生就必须带一个 conversationId**（SPEC §7.4）：它与「零弹框」是
   * 同一件事的两面，留空则会静默接到别人的对话上。留空的槽在
   * `resolveLaunchSpec` 眼里与「本功能上线前的老条目」完全同形（都是「没有
   * conversationId」），于是「+ 然后点开」会落进**未绑定路径 → 兜底 D**：
   * 该 cwd 下只有一个条目时，它会静默 `--resume` 该目录下 mtime 最新的对话；
   * 而多会话之后那条最新对话**很可能正是同一终端里另一个槽正在写的** ——
   * 两个 claude 同写一条 `.jsonl`，数据损坏级。预分配一个「还没有对应
   * .jsonl」的 id 则走已绑定分支的 `fresh`（裸 claude，开一条全新的），且因为
   * liveSessionId 也是空的，连「记录似乎已被删除」那句提示都不会弹。
   * 这与 `addEntryInteractive` 是同一条路径：两个新建入口不能一个分配、一个留空。
   *
   * **不自动打开终端**：「+」是「加一个会话位」，不是「立刻起一个 claude」，
   * 因此它没有任何副作用，也就没有「点错了要收拾」的问题。打开是紧接着点
   * 那一行的事（spec §13 的取舍：代价是新建会话变成两步）。
   */
  async addSessionInteractive(entry: TerminalEntry): Promise<void> {
    await this.store.addSession(entry.id, {
      id: newId(),
      conversationId: newConversationId(),
    });
  }

  async editEntryInteractive(entry: TerminalEntry): Promise<void> {
    const all = await this.store.load();
    const others = all.filter((e) => e.id !== entry.id).map((e) => e.name);

    const name = await this.askName(entry.name, others);
    if (name === undefined) return;
    const cwd = await this.askCwd(entry.cwd);
    if (cwd === undefined) return;

    await this.store.update(entry.id, { name, cwd });
  }

  async duplicateEntry(entry: TerminalEntry): Promise<void> {
    const all = await this.store.load();
    const base = `${entry.name}-copy`;
    let name = base;
    let n = 2;
    while (all.some((e) => e.name === name)) {
      name = `${base}${n++}`;
    }
    // 用 append 而非 add：order 必须在 store 的锁内分配。
    // 直接复制 entry.order 会与源条目相同，排序随即不确定。
    //
    // 逐**槽**重造（v3 的绑定与新会话名都在槽上），两条规则一个槽都不能漏：
    //  - conversationId **必须重新生成**（不是照抄、也不是留空）：复制品是
    //    另一个终端，该有自己的对话。照抄会让两条会话接进同一条对话，两边
    //    同时写同一个 .jsonl；留空则会被当成「老条目」而在下次恢复时弹选择框。
    //  - liveSessionId **必须剥掉**：它是「上一次**已确认观测到**的活跃会话」，
    //    属于**源条目**的那个槽。照抄过来，复制品就会带着源条目的已观测值
    //    出生，reconcileBinding 第二分支（live === liveSessionId）随即误判
    //    「没变化」而不改绑 —— 复制品从此永远跟着源条目那条会话走。
    //  与 conversationId 一样：复制品是另一个终端，一切都该从「未观测」开始。
    // 槽的**数量与 order 原样保留**：复制一个有 3 个会话的终端 = 复制出一个
    // 有 3 个空槽的终端（槽的 id 每个都是新的，所以也不会与原终端的 tmux
    // 会话名撞车）。
    const { order: _dropOrder, sessions, ...rest } = entry;
    await this.store.append({
      ...rest, id: newId(), name,
      sessions: sessions.map((s) => ({
        id: newId(),
        conversationId: newConversationId(),
        order: s.order,
      })),
    });
  }

  /**
   * 杀掉一个 tmux 会话并收掉它的面板。**三步顺序不可换。**
   *
   * 这是三处「关闭 / 删除」共用的唯一出口：抽出来是为了让「顺序反了会让面板
   * 停在 tmux 界面」这条知识只有一份 —— 复制三遍就会有一份先腐坏，而症状
   * （UI 与实际不符、下次点击以为「杀不掉」）跟真正的 bug 长得一样。
   */
  private async killSlot(session: string): Promise<void> {
    // 顺序不能变：先摘客户端，再杀会话。否则「终端里的 attach」与「kill」
    // 之间的时序窗口会让面板停在 tmux 界面，造成 UI 与实际不符。
    await this.tmux.detachClients(session);
    await this.tmux.killSession(session);

    // 关掉面板并从 Map 清掉 —— 否则 Map 与 UI 不一致，下次点击会以为
    // 「没有终端」而重新 attach，看起来就像「杀不掉」。
    const term = this.terminals.get(session);
    if (term) {
      this.terminals.delete(session);
      term.dispose();
    }
  }

  /**
   * 关闭一个会话（三级行上的 `X`）：杀 tmux 进程，**槽与绑定原样保留**。
   *
   * **这里是「三级是接回会话的」能成立的前提**：`conversationId` 一字不动，
   * 所以再点那一行时 `resolveLaunchSpec` 自然会 `--resume` 回**同一条**对话。
   * 顺手清掉绑定（哪怕是「反正进程都没了」这种看起来无害的清法）会让这个
   * 特性彻底失效 —— 再点就变成开一条新对话，而用户以为接回了原来那条。
   */
  async closeSession(entry: TerminalEntry, slot: SessionSlot): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      `关闭「${entry.name}」的${this.slotLabel(entry, slot)}？\n` +
      `其中正在运行的进程会一并终止，对应终端也会关闭。\n` +
      `该会话与它绑定的对话会保留 —— 再点那一行即可接回同一条对话。`,
      { modal: true },
      '关闭',
    );
    if (pick !== '关闭') return;
    await this.killSlot(sessionNameFor(slot.id));
  }

  /**
   * 删除一个会话（三级行右键）：杀 tmux 进程 **+ 把这个槽从清单里去掉**。
   *
   * 与 `closeSession` 的分界就是「槽在不在」：X 是关掉但留着（随时能接回），
   * 这个是连同绑定一起删掉。三级行上同时挂着这两条是刻意的 —— 在一个会话行
   * 上误删**整个终端**（连同其下所有会话与对话绑定）的破坏性太大，所以三级
   * 的「删除」只能是删会话，删条目留在二级。
   */
  async deleteSession(entry: TerminalEntry, slot: SessionSlot): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      `删除「${entry.name}」的${this.slotLabel(entry, slot)}？\n` +
      `其中正在运行的进程会一并终止，该会话与它的对话绑定会一起从清单里移除` +
      `（对话记录文件本身不动，但扩展不再认得它）。`,
      { modal: true },
      '删除',
    );
    if (pick !== '删除') return;
    await this.killSlot(sessionNameFor(slot.id));
    await this.store.removeSession(entry.id, slot.id);
  }

  /**
   * 删除整个终端条目：**递归杀掉其下每一个会话**，然后移除条目。
   *
   * 「远端 tmux 会话不受影响」是 0.1.8 的行为，本轮**反过来了** —— 删了条目
   * 却留着一堆后台 claude 在跑，用户既看不见也管不着（清单里已经没有它们了）。
   * 确认框文案必须跟着改，否则用户按旧文案的预期去点，损失的是在途工作。
   *
   * 槽数为 0 的条目照常可删（没有会话可杀，循环一次都不进）。
   */
  async deleteEntry(entry: TerminalEntry): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      `删除终端「${entry.name}」？\n` +
      `它下面的 ${entry.sessions.length} 个会话都会被一并杀掉（正在跑的 claude 会终止），` +
      `条目与全部会话绑定一起从清单里移除。`,
      { modal: true },
      '删除',
    );
    if (pick !== '删除') return;
    for (const slot of entry.sessions) {
      await this.killSlot(sessionNameFor(slot.id));
    }
    await this.store.remove(entry.id);
  }

  /**
   * 关闭该终端下的**全部**会话（二级行右键），**条目与槽都保留**。
   *
   * 命令 ID 与名字沿用 `killSession`（spec §3.3 第 4 条：不删任何既有命令 ID，
   * 以免打坏用户已有的 keybinding），只是语义从「杀掉该条目的那个会话」收窄成
   * 「关掉这个终端下所有会话」—— 在 v3 里「条目的那个会话」已经没有唯一答案了。
   */
  async killSession(entry: TerminalEntry): Promise<void> {
    // 没有任何槽就没什么可杀：先挡在确认框之前 —— 弹一个「确定要杀吗」然后
    // 什么都不做，比不弹更糟。
    if (entry.sessions.length === 0) return;
    const pick = await vscode.window.showWarningMessage(
      `关闭「${entry.name}」下的全部 ${entry.sessions.length} 个会话？` +
      `其中正在运行的进程会一并终止，对应终端也会关闭。条目与会话槽保留。`,
      { modal: true },
      '关闭',
    );
    if (pick !== '关闭') return;

    for (const slot of entry.sessions) {
      await this.killSlot(sessionNameFor(slot.id));
    }
    vscode.window.showInformationMessage(`已关闭「${entry.name}」下的全部会话。`);
  }

  /**
   * 设置二级行首那条竖线的颜色。
   *
   * 调色板 = `colorChoices` 给出的色项（8 个预设，当前色是自定义 hex 时它
   * 插在首位）+ 末项「自定义…」，末项才走输入框。每一项带一个 `iconPath`
   * 色块：8 个 `#rrggbb` 文本挨在一起时，人不比颜色本身快多少 —— 选颜色这
   * 一步的价值就在「一眼比出几个颜色」，没有色块等于把这活推回给用户。
   *
   * **两道闸**：`validateInput` 当场把非法值挡回去（用户能立刻改），返回后再
   * `normalizeHexColor` 一次 —— 输入框那一关是给用户看的，这一关是给清单看
   * 的：**非法值绝不写进清单**，否则同一个颜色会有两种写法、图标还会落成两个
   * 文件，而且 `colorBarSvg` 拿到的就是脏数据。
   *
   * 本 Task 只做到「写 store」为止；把 SVG 落到 `<globalStorage>/colors/`
   * 并刷新图标是渲染侧的事（`src/colorIcons.ts`）—— 除了下面那次 `ensure`：
   * 色块必须在**弹框之前**就躺在盘上，见那里的注释。
   */
  async setColorInteractive(entry: TerminalEntry): Promise<void> {
    const CUSTOM = '$(pencil) 自定义…';

    // **先落盘再弹框**，顺序反过来色块就全是空的：
    //  - `swatchFor` 只拼路径、不同步读盘（弹框这条路径不能有 IO，同
    //    `iconFor` 的纪律），文件没到位时 VS Code 只是不渲染那个图标 ——
    //    不报错，看起来就是「这个功能没做」；
    //  - 预设色**也必须** ensure：用户可能从没给任何条目设过颜色，那 8 个
    //    色块一次都没被落过盘（`activate()` 只补清单里已存在的颜色）。
    // 落盘失败不阻断（ensure 内部自己吞），最坏结果是这一项没色块。
    const wanted = [...PRESET_COLORS, ...(entry.color === undefined ? [] : [entry.color])];
    await this.colorSwatches?.ensure(wanted);

    const customItem: vscode.QuickPickItem = { label: CUSTOM };
    const items: vscode.QuickPickItem[] = colorChoices(entry.color).map((c) => {
      // 刻意**不用展开**（`...({ label, iconPath, picked })`）拼这个对象：
      // TypeScript 对展开进来的属性不做过量属性检查，往 VS Code 的 API 对象上
      // 塞一个它不认识的字段（比如 proposed API）时 tsc 一声不吭 —— 本仓库
      // 有过 `quickPickItemTooltip` 因此炸掉整个选择框的实测事故（见
      // pickConversation 里同款注释）。逐字段赋值，多写一行换来 tsc 能拦住下一个。
      const item: vscode.QuickPickItem = { label: c.hex };
      const swatch = this.colorSwatches?.swatchFor(c.hex);
      if (swatch !== undefined) item.iconPath = swatch;
      if (c.current) {
        item.description = '当前';
        item.picked = true;
      }
      return item;
    });

    const pick = await vscode.window.showQuickPick([...items, customItem], {
      title: `为「${entry.name}」设置颜色`,
      placeHolder: entry.color ?? '（未设，中性竖线）',
    });
    if (pick === undefined) return;

    let color: string | undefined;
    if (pick !== customItem) {
      // label 就是归一化后的 hex（`colorChoices` 的契约），故这里取 label 再
      // 过一次闸即与从前等价，不必也不该去反解析图标路径。
      color = normalizeHexColor(pick.label);
      // 预设色本身就是归一化过的（colors.test.ts 钉着），走到这里为 undefined
      // 只可能是 PRESET_COLORS 被改坏了 —— 那时宁可什么都不做，也不写脏值。
      if (color === undefined) return;
    } else {
      const typed = await vscode.window.showInputBox({
        title: '颜色',
        prompt: '十六进制颜色，例如 #4e9a51；留空 = 清除颜色（回到中性竖线）',
        value: entry.color ?? '',
        validateInput: (v) =>
          (v.trim().length === 0 || normalizeHexColor(v) !== undefined
            ? null
            : '需要一个十六进制颜色，例如 #4e9a51'),
      });
      if (typed === undefined) return;
      const trimmed = typed.trim();
      if (trimmed.length === 0) {
        // 清空 → 回到中性竖线。写 undefined 而不是空串：`entry.color` 的
        // 契约是「未设 = 中性」，空串会变成第三种状态，图标层还得再兜一次。
        await this.store.update(entry.id, { color: undefined });
        return;
      }
      color = normalizeHexColor(trimmed);
      // validateInput 只是 UI 层的第一道闸，这里才是真正把关的那一道：
      // 对不合法输入**放弃**（不写清单、不猜近似色）。用户在框里看到过
      // 「需要一个十六进制颜色」的提示，知道该重来一次。
      if (color === undefined) return;
    }
    await this.store.update(entry.id, { color });
  }

  async toggleAutoRestore(entry: TerminalEntry): Promise<void> {
    await this.store.update(entry.id, { autoRestore: !entry.autoRestore });
  }

  // ---- 输入辅助 ----

  private async askName(
    current: string,
    existingNames: string[],
  ): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
      title: '终端名称',
      prompt: '仅用于显示，可随意改名（tmux 会话名由条目 id 派生，改名不影响会话）',
      value: current,
      validateInput: (v) => validateName(v, existingNames),
    });
    return value === undefined ? undefined : value.trim();
  }

  /**
   * 选目录。候选 = 已用过的目录 + 它们自身与父目录各一层 + 家目录一层。
   *
   * 只扫一层：深扫会卡，而深层目录用户手输更快。
   *
   * 扫描根取自「已经用过的目录」，**不硬编码 `~/workspace`**：那个
   * 猜测在本机就是错的（home 在 /home/…，工作树在 /ssd/…），会把
   * 用户从不使用的目录塞满列表，而真正在用的树一条都不出现。
   */
  private async askCwd(current?: string): Promise<string | undefined> {
    const MANUAL = '$(pencil) 手动输入…';
    const all = await this.store.load();
    const home = this.home();

    const used = all.map((e) => displayPath(e.cwd.trim(), home));
    const roots = scanRoots(all.map((e) => e.cwd), home);
    const discovered = await discoverCandidates(roots, home, async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((d) => d.isDirectory()).map((d) => d.name);
    });

    const { items, truncated } = rankCandidates(used, discovered);
    const title = truncated > 0
      ? `远程目录（候选过多，仅显示前 ${items.length} 条，可手动输入其他）`
      : '远程目录';

    const pick = await vscode.window.showQuickPick([MANUAL, ...items], {
      title,
      placeHolder: current ?? '选择或手动输入',
    });
    if (pick === undefined) return undefined;
    if (pick === MANUAL) {
      return vscode.window.showInputBox({
        title: '远程目录',
        prompt: '支持 ~ 开头，例如 ~/mine/paint-pc',
        value: current ?? '',
        validateInput: (v) => (v.trim().length === 0 ? '目录不能为空' : null),
      });
    }
    return pick;
  }

  private async askAutoRestore(def: boolean): Promise<boolean | undefined> {
    const pick = await vscode.window.showQuickPick(
      ['是', '否'],
      { title: '是否参与「全部恢复」？', placeHolder: def ? '是' : '否' },
    );
    if (pick === undefined) return undefined;
    return pick === '是';
  }
}
