import * as os from 'os';
import * as vscode from 'vscode';
import { expandHome, validateName } from './core/paths';
import { planRestore } from './core/plan';
import { sessionNameFor, shellQuote } from './core/tmux';
import { TerminalEntry } from './core/types';
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
      `杀掉远端 tmux 会话「${entry.name}」？其中正在运行的进程会一并终止。`,
      { modal: true },
      '杀掉',
    );
    if (pick !== '杀掉') return;
    await this.tmux.killSession(sessionNameFor(entry.id));
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
