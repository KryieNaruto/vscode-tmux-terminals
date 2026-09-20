import * as vscode from 'vscode';

/** 两位/三位补零。自己拼时间戳是为了不引入依赖，也避免 date-fns 之类的东西
 * 挡住"扩展启动即打日志"这条最短路径。 */
function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** `HH:MM:SS.mmm`。用本地时间：看日志的人就在这台机器上对表，
 * 换算 UTC 只会多一层心智负担。 */
function stamp(): string {
  const d = new Date();
  return (
    `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}` +
    `.${pad(d.getMilliseconds(), 3)}`
  );
}

/**
 * Output 面板里的一条极简日志通道。
 *
 * 存在的理由有两个，都很具体：
 *
 * 1）**这个窗口的扩展宿主会被反复重建**。Remote-SSH 抖动、扩展重载、窗口重连，
 *    都会换一个新进程来跑这份代码；结果是同一个面板里堆着好几代的日志，而
 *    "屏幕上的这条消息到底出自哪一次运行"光看内容根本分不出来。所以每条日志
 *    都钉上进程启动 pid —— 它是这个问题的唯一判据。
 * 2）**出问题时常常是一片死寂**（点了命令没反应、任务名加载不出来）。
 *    有了这条通道，至少有三种沉默可以被区分开：日志停在激活那几行（宿主没了）、
 *    激活之后什么都没有（命令压根没被调用到）、有轮询日志但不再增长（轮询停摆）。
 *    没有日志时，这三种在用户眼里长得一模一样。
 *
 * channel 是惰性的：构造只建通道、不 `show()`，把"什么时候把面板推到用户面前"
 * 的决定权留给调用方 —— 扩展激活时抢焦点是很讨厌的行为。
 *
 * 本类所有方法都不允许往外抛：日志是旁路，output channel 被 dispose、
 * 消息里混进一个 toString 会炸的对象，都不该把正在跑的终端操作带崩。
 */
export class Log {
  private channel: vscode.OutputChannel | undefined;

  /** 每条日志行前缀里那段不变的 ` pid=<n>`：pid 在进程生命周期内恒定，
   * 所以只算一次。**它必须出现在每一行上** —— 宿主被反复重建时，
   * 唯一的世代标识就是它。 */
  private readonly boot: string;

  constructor(name: string = 'TMUX 终端') {
    this.boot = ` pid=${process.pid}`;
    try {
      this.channel = vscode.window.createOutputChannel(name);
    } catch {
      // 拿不到通道就整体退化成 no-op：没日志能忍，激活失败不能忍。
      this.channel = undefined;
    }
  }

  info(msg: string): void {
    this.write('INFO ', msg);
  }

  warn(msg: string): void {
    this.write('WARN ', msg);
  }

  /** `err` 存在时把它的栈（没有栈就退回 message）追加在 msg 之后。
   * msg 允许为空 —— 有时候手上只有异常没有话可说。 */
  error(msg: string, err?: unknown): void {
    if (err === undefined) {
      this.write('ERROR', msg);
      return;
    }
    this.write('ERROR', `${msg}\n${describe(err)}`);
  }

  /** `true` = 不抢焦点：用户可能正在别的输入框里打字，
   * 我们要的是"日志就绪"，不是"把光标抢过来"。 */
  show(): void {
    try {
      this.channel?.show(true);
    } catch {
      // 通道已被 dispose —— 见类注释：旁路失败一律静默。
    }
  }

  dispose(): void {
    const channel = this.channel;
    this.channel = undefined;
    try {
      channel?.dispose();
    } catch {
      // 重复 dispose 等场景，忽略。
    }
  }

  /**
   * 级别名补空格到等宽（`INFO ` / `WARN ` / `ERROR`），这样消息列能对齐，
   * 扫日志时不用逐字读级别名。
   *
   * 多行消息（典型是栈）的续行也补上同一条前缀：栈一旦被拆开或粘贴出去，
   * 没有前缀的那几行就再也认不回来是哪个世代的宿主写的了。
   */
  private write(level: string, msg: string): void {
    try {
      const channel = this.channel;
      if (channel === undefined) {
        return;
      }
      const prefix = `[${stamp()}${this.boot}] ${level} `;
      const lines = String(msg).split('\n');
      for (const line of lines) {
        channel.appendLine(prefix + line);
      }
    } catch {
      // 静默：绝不让日志把主流程带崩。
    }
  }
}

/** 归一化未知错误。`instanceof Error` 而不是鸭子类型判断，是为了不被
 * `{ stack: undefined, message: undefined }` 这类形状骗到。 */
function describe(err: unknown): string {
  try {
    return err instanceof Error ? err.stack ?? err.message : String(err);
  } catch {
    // String() 会触发 toString / Symbol.toPrimitive，那也可能抛。
    return '<无法序列化的错误>';
  }
}
