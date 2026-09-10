import * as os from 'os';
import * as vscode from 'vscode';
import { expandHome, validateName } from './core/paths';
import { planRestore } from './core/plan';
import { sessionNameFor, shellQuote } from './core/tmux';
import { Profile, TerminalEntry } from './core/types';
import { commandFor } from './core/command';
import { isClaudeCommand } from './core/claude';
import { readProfileConfig } from './claudeConfig';
import { EntryStore, newId } from './core/store';
import { TmuxClient } from './tmuxClient';

const SHELL_READY_TIMEOUT_MS = 3000;

export class TerminalManager {
  /** tmux 会话名 → 终端，用于去重：重复点击复用已有终端而不是新开。 */
  private readonly terminals = new Map<string, vscode.Terminal>();

  constructor(
    private readonly store: EntryStore,
    private readonly tmux: TmuxClient,
  ) {
    vscode.window.onDidCloseTerminal((t) => {
      for (const [session, term] of this.terminals) {
        if (term === t) this.terminals.delete(session);
      }
    });
  }

  private home(): string {
    // 扩展跑在远端，os.homedir() 即远端家目录
    return os.homedir();
  }

  private cwdFor(entry: TerminalEntry): string {
    return expandHome(entry.cwd, this.home());
  }

  /**
   * 打开（接回或重建）一个条目。
   *
   * 不变量：竞态兜底**只能把命令降级为空，永远不能凭空加出命令**。
   * 任何「会话可能已属于别人」的迹象都必须导致 `runCommands = false`。
   */
  async openEntry(entry: TerminalEntry): Promise<void> {
    // tmux 会话名由条目 id 派生，与显示名解耦（显示名可随意改名）。
    const session = sessionNameFor(entry.id);

    const existing = this.terminals.get(session);
    if (existing) {
      existing.show();
      return;
    }

    // Map 是内存态，扩展宿主重启后会清空，而终端面板仍在。没有这道守卫
    // 就会出现「两个面板连着同一个会话」，并再次制造 UI 与实际不符。
    const reused = vscode.window.terminals.find((t) => t.name === entry.name);
    if (reused) {
      this.terminals.set(session, reused);
      reused.show();
      return;
    }

    const cwd = this.cwdFor(entry);
    const wasAlive = await this.tmux.hasSession(session);

    // 会话不存在时由扩展 detached 建出来，拿到确定的成功/失败信号。
    let runCommands = false;
    if (!wasAlive) {
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
    const plan = planRestore(entry, wasAlive);
    const commands = runCommands ? plan.commands : [];

    let terminal: vscode.Terminal;
    try {
      terminal = vscode.window.createTerminal({ name: entry.name, cwd });
    } catch {
      vscode.window.showWarningMessage(`目录不存在，已在主目录打开：${cwd}`);
      terminal = vscode.window.createTerminal({ name: entry.name });
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
   * 退出当前 claude 并按 `launch` 的配置重新启动。
   *
   * `launch` 与 `entry` 分开传：调用方常需要「改某个字段后再启动」
   * （如清掉 model 以回落到 profile 默认），而提示语仍要用原条目的名字。
   *
   * 返回 false 表示被安全守卫拒绝。
   */
  private async restartClaude(
    entry: TerminalEntry,
    launch: TerminalEntry,
    resume: boolean,
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

    const base = commandFor(launch);
    // --continue 接回原对话：两个 profile 共用 ~/.claude/projects/（实测）
    const cmd = resume ? `${base} --continue` : base;
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
  async applyModel(entry: TerminalEntry, model: string | undefined): Promise<void> {
    const session = sessionNameFor(entry.id);
    const normalized = model && model.length > 0 ? model : undefined;
    const alive = await this.tmux.hasSession(session);

    if (!alive) {
      await this.store.update(entry.id, { model: normalized });
      return;
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
      return;
    }

    if (!(await this.canSendControl(session))) {
      this.refuse(entry, '切模型');
      return;
    }
    await this.tmux.sendLiteral(session, `/model ${target}`);
    await this.tmux.sendEnter(session);
    await this.store.update(entry.id, { model: normalized });
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
  async applyProfile(entry: TerminalEntry, profile: Profile): Promise<void> {
    if (entry.profile === profile) return;
    const session = sessionNameFor(entry.id);

    if (await this.tmux.hasSession(session)) {
      const ok = await this.restartClaude(
        entry,
        { ...entry, profile, model: undefined },
        true,
      );
      if (!ok) return; // 被拒绝时不动配置
    }
    await this.store.update(entry.id, { profile });
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

  private async askCwd(current?: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: '远程目录',
      prompt: '支持 ~ 开头，例如 ~/mine/paint-pc',
      value: current ?? '',
      validateInput: (v) => (v.trim().length === 0 ? '目录不能为空' : null),
    });
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
