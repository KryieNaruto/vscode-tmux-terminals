import { execFile } from 'child_process';
import { promisify } from 'util';
import { paneTarget, parseSessionList, sessionTarget, isShellReady } from './core/tmux';

const run = promisify(execFile);

/**
 * tmux 的薄封装。
 *
 * 所有目标都经 sessionTarget()/paneTarget() 生成，见 core/tmux.ts 里
 * 关于前缀匹配与 pane 目标的说明 —— 那是本项目踩过的两个坑。
 *
 * execFile 传 argv 数组，不经过 shell，所以这里的参数不需要 shell
 * 引用。shellQuote() 只用于「要塞进终端执行的命令行字符串」。
 */
export class TmuxClient {
  constructor(private readonly tmuxPath: string = 'tmux') {}

  /** 列出所有会话名。tmux 无会话时退出码非 0，属正常，返回空数组。 */
  async listSessions(): Promise<string[]> {
    try {
      const { stdout } = await run(this.tmuxPath, ['ls', '-F', '#{session_name}']);
      return parseSessionList(stdout);
    } catch {
      return [];
    }
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await run(this.tmuxPath, ['has-session', '-t', sessionTarget(name)]);
      return true;
    } catch {
      return false;
    }
  }

  async killSession(name: string): Promise<void> {
    try {
      await run(this.tmuxPath, ['kill-session', '-t', sessionTarget(name)]);
    } catch {
      // 会话本就不存在 —— 目标状态已达成，不算失败
    }
  }

  /**
   * 以 detached 方式建会话，返回是否真的由本次调用创建。
   *
   * **为什么不直接在终端里 `tmux new -s name`：** 那样无法区分
   * 「我建成功了」和「别人抢先建了」。若被别人抢先，`tmux new` 会
   * 失败（exit 1），但随后 waitForShell 会看到「会话存在且是 shell」
   * 而判定就绪 —— 于是预设命令被发进**别人的**会话，污染对方 stdin。
   *
   * 从 execFile 建则能拿到确定的 exit code：已存在时 tmux 报
   * "duplicate session" 并以非 0 退出，据此返回 false，调用方转为
   * attach 模式且不执行任何命令。
   *
   * detached 创建后，终端只负责 `tmux attach`，规避了整个竞态。
   */
  async newSession(name: string, cwd: string): Promise<boolean> {
    try {
      await run(this.tmuxPath, ['new-session', '-d', '-s', name, '-c', cwd]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 取 pane 的前台进程名。
   *
   * 注意 pane 目标必须带冒号；写错时 tmux 返回 exit 0 + 空串，
   * 不报错，所以这里把空串原样返回，由 isShellReady() 判为未就绪。
   */
  async currentCommand(name: string): Promise<string> {
    try {
      const { stdout } = await run(this.tmuxPath, [
        'display-message', '-p', '-t', paneTarget(name), '#{pane_current_command}',
      ]);
      return stdout.trim();
    } catch {
      return '';
    }
  }

  /** 以字面量模式发送文本（不解释键名，也不做 shell 引用）。 */
  async sendLiteral(name: string, text: string): Promise<void> {
    await run(this.tmuxPath, ['send-keys', '-l', '-t', paneTarget(name), text]);
  }

  async sendEnter(name: string): Promise<void> {
    await run(this.tmuxPath, ['send-keys', '-t', paneTarget(name), 'Enter']);
  }

  /**
   * 等会话的 shell 就绪（可以安全 send-keys）。
   *
   * 用轮询而非固定 sleep：固定延时不保证正确，慢机器上必然偶发失败。
   * 超时返回 false，调用方据此跳过预设命令 —— 宁可少做，也不能把
   * 命令塞进一个还没就绪或已被别的程序占用的 pane。
   */
  async waitForShell(name: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (isShellReady(await this.currentCommand(name))) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
