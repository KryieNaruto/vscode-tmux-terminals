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
import { Profile, TerminalEntry } from './core/types';
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
import { readProfileConfig } from './claudeConfig';
import { findConversations, listConversations } from './conversationFiles';
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
   * 让用户为该条目挑一条对话。
   *
   * 候选 = `~/.claude/projects` 下**文件里记录的 cwd 精确等于该条目 cwd** 的
   * 对话，按 mtime 倒序。绝不靠目录名反推归属（转义规则不可靠）。
   *
   * 列表**末尾固定跟一项「＋ 新建一条对话」**：新对话只能由用户主动选出来，
   * 绝不由「取消」隐式产生（见 resolveLaunchSpec）。
   *
   * **调用方必须已经处在 `pickChain` 的一个 op 内**（本方法自己不再入队）。
   * 读 owners 必须与写绑定处在同一个 op 里，否则两个共用 cwd 的老条目会
   * 各自读到「还没人绑」的快照，双双接到同一条对话上。
   */
  private async pickConversation(
    entry: TerminalEntry,
    title: string,
  ): Promise<{ total: number; picked?: ConversationCandidate; owner?: string; startNew: boolean }> {
    const cwd = this.cwdFor(entry);
    const candidates = candidatesForCwd(await listConversations(this.home()), cwd);
    if (candidates.length === 0) {
      // 没有任何可接回的 → 没有列表可弹，调用方直接开一条新的
      return { total: 0, startNew: false, picked: undefined };
    }

    // 已被其它条目绑走的对话要标注出来：实测用户 4 条条目共用同一个 cwd，
    // 选重了会让两条会话接进同一条对话，两边同时写同一个 .jsonl。
    const owners = ownersOf(await this.store.load(), entry.id);

    // 末尾固定跟一项「＋ 新建一条对话」：新对话只能由用户主动选出来
    const newItem = { label: NEW_CONVERSATION_LABEL, candidate: undefined };
    const convoItems = candidates.map((c) => {
      const owner = owners.get(c.id);
      return {
        label: formatCandidateWithOwner(c, owner),
        candidate: c,
        ...(owner !== undefined ? { owner } : {}),
      };
    });
    const pick = await vscode.window.showQuickPick([...convoItems, newItem], {
      title,
      placeHolder: `${cwd} 下有 ${candidates.length} 条可接回的对话`,
    });
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
   * 决定「该给这条条目发哪条启动命令」。返回 undefined = **什么都不启动**
   * （会话照常建/照常 attach，pane 停在登录 shell，等用户主动处理）。
   *
   * 顺序即优先级：
   *
   *  1. 已绑定 → 该用 `--resume` 还是 `--session-id`，取决于那条对话**是否
   *     已经存在**（`--session-id` 建出来 vs `--resume` 接回）。用 `+` 新建的
   *     条目一出生就带 id，但那条对话还没被创建过，必须走前者。
   *     对话存在、却不在本条目的 cwd 下 → `--resume` 按 cwd 作用域必然失败，
   *     而**绝不替用户另开一条**，故返回 undefined 并说明原委。
   *  2. 未绑定（只可能是本功能上线前的老条目）+ 该 cwd 下有候选 → 问用户挑
   *     一次，挑中即永久绑定；列表末尾可选「＋ 新建一条对话」。
   *  3. 未绑定 + 无候选 → 用 `--session-id` 开一条新的并立刻绑定。
   *  4. 用户按 Esc 取消 → 返回 undefined，**什么都不启动**，并按提示可随时
   *     右键重来。
   */
  private async resolveLaunchSpec(entry: TerminalEntry): Promise<LaunchSpec | undefined> {
    const cwd = this.cwdFor(entry);
    const bound = entry.conversationId;
    if (bound !== undefined && bound.length > 0) {
      const cwds = await findConversations(this.home(), bound);
      if (cwds.length === 0) {
        // 还没被创建过 → 把它建出来。两种来源都走这里：
        //  - 用 `+`/复制新建的条目第一次启动（正常）；
        //  - 那条 .jsonl 被**外部删掉**了（手动 rm、清理工具）。
        // 两者在数据上不可区分，但**必须出声**：后者如果静默，用户只会觉得
        // 「我的对话又没了」。文案对两种情况都要成立。
        void vscode.window.showInformationMessage(
          `「${entry.name}」绑定的对话还没有记录，本次新开一条（绑定保持不变）。` +
          `首次启动时这属正常；若这条对话本应存在，说明它的记录已被删除。`,
        );
        return { kind: 'new', conversationId: bound };
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

    // **整段**放进 pickChain 的同一个 op：读 owners → 弹选择框 → 弹确认模态
    // → 写绑定，中间不能插进别的条目的选择流程。
    // 否则「读 owners」与「写绑定」之间有一个窗口，两个共用 cwd 的老条目会
    // 各自看到「还没人绑」，双双接到同一条对话上 —— 两个 claude 进程同时写
    // 同一个 .jsonl。顺带也避免了确认模态与下一个条目的选择框并存。
    return this.enqueuePick(async (): Promise<LaunchSpec | undefined> => {
      const { total, picked, owner, startNew } = await this.pickConversation(
        entry, `「${entry.name}」接回哪条对话？`,
      );
      if (total === 0) {
        const conversationId = newConversationId();
        await this.store.update(entry.id, { conversationId });
        return { kind: 'new', conversationId };
      }
      if (startNew) {
        const conversationId = newConversationId();
        await this.store.update(entry.id, { conversationId });
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

      await this.store.update(entry.id, { conversationId: picked.id });
      return { kind: 'resume', conversationId: picked.id };
    });
  }

  /**
   * 显式命令：为条目选择要接回的对话（随时可重新绑定）。
   *
   * 只影响**下一次在该条目里启动 claude**。会话还活着时那条对话本来就是
   * 对的，不必也不该去打断正在跑的 claude。
   */
  async bindConversationInteractive(entry: TerminalEntry): Promise<void> {
    // 与 resolveLaunchSpec 同侧：读 owners → 选择框 → 确认 → 写绑定 全在一个
    // op 内，避免与并发的恢复流程互相看不到对方的绑定。
    await this.enqueuePick(async (): Promise<void> => {
      const { total, picked, owner, startNew } = await this.pickConversation(
        entry, `为「${entry.name}」选择要接回的对话`,
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
        await this.store.update(entry.id, { conversationId: picked.id });
        void vscode.window.showInformationMessage(
          `「${entry.name}」已绑定对话 ${picked.id.slice(0, 8)}…，下次启动 claude 时会接回它。`,
        );
        return;
      }
      if (startNew) {
        const conversationId = newConversationId();
        await this.store.update(entry.id, { conversationId });
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

  private cwdFor(entry: TerminalEntry): string {
    return expandHome(entry.cwd, this.home());
  }

  /**
   * 打开（接回或重建）一个条目。
   *
   * 对每条条目必须保证：**会话存在 + 至少一个客户端附着 + 有一个面板在
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
   */
  async openEntry(entry: TerminalEntry): Promise<void> {
    // tmux 会话名由条目 id 派生，与显示名解耦（显示名可随意改名）。
    const session = sessionNameFor(entry.id);
    const cwd = this.cwdFor(entry);

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
    const spec = await this.resolveLaunchSpec(entry);
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

    await this.tmux.sendLiteral(session, conversationCommand(entry, spec));
    await this.tmux.sendEnter(session);

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
   * 恢复所有标记了 autoRestore 的条目。
   *
   * 终端并行打开，**不 await openEntry**：它会等 `waitForShell`
   * （上限 3s）并逐条派发预设命令。若串行 await，N 个条目在某个
   * 会话迟迟不就绪时最坏要等 N×3s 才全部开完 —— 而用户要的正是
   * 「一次点开整组工作区」。并行则各终端的命令派发互不阻塞。
   *
   * 错误必须逐个捕获：openEntry 内部已自行把失败呈现给用户，这里
   * 只防止一个条目的异常中断整批恢复。
   */
  restoreAll(): void {
    void (async () => {
      const entries = (await this.store.load()).filter((e) => e.autoRestore);
      if (entries.length === 0) {
        vscode.window.showInformationMessage('没有标记为「参与全部恢复」的条目。');
        return;
      }
      for (const e of entries) {
        void this.openEntry(e).catch(() => {
          // openEntry 已经把可预期的失败呈现给用户了；这里只兜住意外异常，
          // 避免一个条目炸掉整批恢复
        });
        // 轻微错开，避免 N 个终端在同一瞬间争抢创建
        await new Promise((r) => setTimeout(r, 50));
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
    launch: TerminalEntry,
  ): Promise<boolean> {
    const session = sessionNameFor(entry.id);
    const bound = launch.conversationId;
    if (bound === undefined || bound.length === 0) {
      void vscode.window.showErrorMessage(
        `「${entry.name}」还没有绑定对话，已拒绝重启 —— 无法确定该接回哪一条。` +
        `请先用右键菜单「选择要接回的对话…」绑定，再切 profile。`,
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

    await this.tmux.sendLiteral(session, conversationCommand(launch, { kind: 'resume', conversationId: bound }));
    await this.tmux.sendEnter(session);
    await this.warnIfResumeFailed(session, entry);
    return true;
  }

  /**
   * 把模型设置应用到一条条目。
   *
   * 未运行的会话：只改配置。下次 openEntry 由 commandFor 带出 `--model`
   * （实测 `--model` 启动参数**不**污染全局默认）。
   *
   * 运行中的会话：发 `/model <目标>` 立即生效。这是**唯一**能改掉一个活
   * 对话当前模型的机制（实测 bare `claude --continue` 会保留原对话的模型，
   * 命令行 `--model` 也盖不过 resumed 会话），代价是 `/model` 会顺带改写
   * `~/.claude/settings.json` 的全局默认 —— 这是用户显式接受的取舍。
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
    const session = sessionNameFor(entry.id);
    const normalized = model && model.length > 0 ? model : undefined;
    const alive = await this.tmux.hasSession(session);

    if (!alive) {
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

    if (!(await this.canSendControl(session))) {
      this.refuse(entry, '切模型');
      return false;
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
    await this.tmux.sendLiteral(session, `/model ${target}`);
    await this.tmux.sendEnter(session);
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
   */
  /**
   * 返回 false 表示被安全守卫拒绝（或重启失败），未改动配置；true 表示
   * 已切换成功。profile 未变时返回 true（无事可做，不算失败）。
   */
  async applyProfile(entry: TerminalEntry, profile: Profile): Promise<boolean> {
    if (entry.profile === profile) return true;
    const session = sessionNameFor(entry.id);

    if (await this.tmux.hasSession(session)) {
      const ok = await this.restartClaude(entry, { ...entry, profile, model: undefined });
      if (!ok) return false; // 被拒绝时不动配置
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

  async addEntryInteractive(): Promise<void> {
    const all = await this.store.load();
    const name = await this.askName('', all.map((e) => e.name));
    // 必须用 undefined 判断取消，不能用 `!name`：validateName 已禁止空名，
    // 所以空串只可能来自「用户按 Esc」→ askName 返回 undefined。写成
    // `!name` 恰好也拦住了取消，语义却是错的，日后放开空名就会变成
    // 「取消后仍继续往下问目录」。
    if (name === undefined) return;
    const cwd = await this.askCwd();
    if (cwd === undefined) return;
    const autoRestore = await this.askAutoRestore(true);
    if (autoRestore === undefined) return;

    // 一出生就分配 conversationId：这样「无 conversationId」此后**只**表示
    // 「本功能上线前的老条目」，新建的条目永远不会被弹选择框。
    // 首次启动用 `--session-id <它>` 把这条对话建出来（见 resolveLaunchSpec）。
    await this.store.append({
      id: newId(), name, cwd, profile: 'ccr', autoRestore,
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
    // conversationId **必须重新生成**（不是照抄、也不是留空）：复制品是
    // 另一个终端，该有自己的对话。照抄会让两条会话接进同一条对话，两边
    // 同时写同一个 .jsonl；留空则会被当成「老条目」而在下次恢复时弹选择框。
    const { order: _dropOrder, conversationId: _dropConv, ...rest } = entry;
    await this.store.append({
      ...rest, id: newId(), name, conversationId: newConversationId(),
    });
  }

  async deleteEntry(entry: TerminalEntry): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      `删除条目「${entry.name}」？远端 tmux 会话不受影响。`,
      { modal: true },
      '删除',
    );
    if (pick !== '删除') return;
    await this.store.remove(entry.id);
  }

  async killSession(entry: TerminalEntry): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      `杀掉远端 tmux 会话「${entry.name}」？其中正在运行的进程会一并终止，对应终端也会关闭。`,
      { modal: true },
      '杀掉',
    );
    if (pick !== '杀掉') return;

    const session = sessionNameFor(entry.id);

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

    vscode.window.showInformationMessage(`已杀掉会话「${entry.name}」。`);
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
