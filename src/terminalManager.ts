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
import { planRestore } from './core/plan';
import { decideOpen } from './core/restore';
import { sessionNameFor, shellQuote } from './core/tmux';
import { Profile, TerminalEntry } from './core/types';
import { commandFor } from './core/command';
import { isClaudeCommand } from './core/claude';
import { readProfileConfig } from './claudeConfig';
import { EntryStore, newId } from './core/store';
import { TmuxClient } from './tmuxClient';

const SHELL_READY_TIMEOUT_MS = 3000;

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

  constructor(
    private readonly store: EntryStore,
    private readonly tmux: TmuxClient,
  ) {
    vscode.window.onDidCloseTerminal((t) => {
      this.busy.delete(t);
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
   * 两个条件缺一不可：shell integration 在场（否则无从得知面板里跑着什么），
   * 且没记录到有命令在跑。判不出来一律 false —— 宁可多开一个面板，
   * 也不能把 `tmux attach` 打进用户正在跑的进程。
   */
  private isIdlePanel(t: vscode.Terminal): boolean {
    if (t.shellIntegration === undefined) return false;
    return !this.busy.has(t);
  }

  /** 远端家目录。公开供扩展层复用，避免各处各算一份。 */
  home(): string {
    // 扩展跑在远端，os.homedir() 即远端家目录
    return os.homedir();
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
   * 不变量：竞态兜底**只能把命令降级为空，永远不能凭空加出命令**。
   * 任何「会话可能已属于别人」的迹象都必须导致 `runCommands = false`。
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
    let runCommands = false;
    if (!sessionExists) {
      if (await this.tmux.newSession(session, cwd)) {
        runCommands = true;
      } else if (await this.tmux.hasSession(session)) {
        // 竞态：等待期间被别的窗口建出来了 → 转为接回，绝不发命令
        vscode.window.showInformationMessage(
          `会话「${entry.name}」刚被其他窗口创建，改为接回，不执行预设命令。`,
        );
      } else {
        // 真的建不出来（tmux 不可用、cwd 不存在等）
        const t = vscode.window.createTerminal({ name: entry.name });
        this.terminals.set(session, t);
        t.show();
        vscode.window.showErrorMessage(
          `无法创建 tmux 会话「${entry.name}」。已打开普通终端，请检查 tmux 是否可用、目录是否存在：${cwd}`,
        );
        return;
      }
    }

    // planRestore 仍是命令清单的唯一来源；runCommands 只能把它清空
    const plan = planRestore(entry, sessionExists);
    const commands = runCommands ? plan.commands : [];

    // 复用只在 decideOpen 判定「已证明空闲」时才走到（action === 'reuse-attach'），
    // 因此这里往里打字不会打断面板里可能跑着的进程。
    let terminal: vscode.Terminal;
    if (action === 'reuse-attach' && candidate !== undefined) {
      terminal = candidate;
    } else {
      try {
        terminal = vscode.window.createTerminal({ name: entry.name, cwd });
      } catch {
        vscode.window.showWarningMessage(`目录不存在，已在主目录打开：${cwd}`);
        terminal = vscode.window.createTerminal({ name: entry.name });
      }
    }
    this.terminals.set(session, terminal);
    terminal.show();

    // 此刻会话必定存在（原本存活、刚建成功、或被抢先建出），一律 attach。
    // 命令行字符串要塞进 shell 执行，故此处需要 shell 引用。
    terminal.sendText(`tmux attach -t ${shellQuote('=' + session)}`, true);

    if (commands.length === 0) return;

    const ready = await this.tmux.waitForShell(session, SHELL_READY_TIMEOUT_MS);
    if (!ready) {
      vscode.window.showWarningMessage(
        `tmux 会话「${entry.name}」未在 ${SHELL_READY_TIMEOUT_MS / 1000}s 内就绪，已跳过 ${commands.length} 条预设命令。`,
      );
      return;
    }
    for (const c of commands) {
      await this.tmux.sendLiteral(session, c);
      await this.tmux.sendEnter(session);
      await new Promise((r) => setTimeout(r, 150));
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
   * 退出当前 claude 并按 `launch` 的配置重新启动，**始终 `--continue`**
   * 接回原对话（两个 profile 共用 ~/.claude/projects/，实测）—— 这是唯一
   * 调用方（applyProfile）的需要，故不再保留 resume 开关。
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

    // --continue 接回原对话：两个 profile 共用 ~/.claude/projects/（实测）
    const cmd = `${commandFor(launch)} --continue`;
    await this.tmux.sendLiteral(session, cmd);
    await this.tmux.sendEnter(session);
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
   * 重启 CLI 并用 `--continue` 接回原对话 —— 两个 profile 共用
   * `~/.claude/projects/`（实测 direct.json 不覆盖该目录）。
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
      `把「${entry.name}」切到 ${label}？运行中的 claude 会重启（用 --continue 接回原对话）。`,
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

    await this.store.append({ id: newId(), name, cwd, profile: 'ccr', autoRestore });
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
    const { order: _drop, ...rest } = entry;
    await this.store.append({ ...rest, id: newId(), name });
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
