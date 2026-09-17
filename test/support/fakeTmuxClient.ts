import { TmuxClient } from '../../src/tmuxClient';

/**
 * `TmuxClient` 的测试替身：不 spawn 真 tmux 进程，行为完全由测试摆布。
 *
 * 继承真类而不是手写一个满足接口的对象字面量——`TmuxClient` 有私有字段
 * （`tmuxPath`），对象字面量在结构类型检查下通不过；继承则天然是一个
 * `TmuxClient`，只需要覆写用到的几个方法。
 */
export class FakeTmuxClient extends TmuxClient {
  /** 记录发送过的 `/model x` 等字面量文本，按 (session, text) 顺序追加。 */
  readonly sentLiterals: Array<{ session: string; text: string }> = [];
  /** 记录发送过回车的会话名，按顺序追加。 */
  readonly sentEnters: string[] = [];

  private readonly existingSessions = new Set<string>();
  private readonly foreground = new Map<string, string>();

  constructor() {
    super('tmux');
  }

  /** 登记一个会话存在，前台命令默认 'claude'（大多数测试场景的默认状态）。 */
  addSession(session: string, foreground: string = 'claude'): void {
    this.existingSessions.add(session);
    this.foreground.set(session, foreground);
  }

  /** 单独改一个已登记会话的前台命令（例如模拟它退回 bash）。 */
  setForeground(session: string, cmd: string): void {
    this.foreground.set(session, cmd);
  }

  override async hasSession(name: string): Promise<boolean> {
    return this.existingSessions.has(name);
  }

  override async currentCommand(name: string): Promise<string> {
    return this.foreground.get(name) ?? '';
  }

  override async attachedClients(_name: string): Promise<number | null> {
    return 1;
  }

  /**
   * 恒返回 null：让 `liveFor`（reconcileOne 内部）短路判定「观测不到」，
   * 不去匹配真实进程表——测试不依赖、也不应该依赖这台机器上真实跑着什么。
   */
  override async panePid(_name: string): Promise<number | null> {
    return null;
  }

  override async sendLiteral(session: string, text: string): Promise<void> {
    this.sentLiterals.push({ session, text });
  }

  override async sendEnter(session: string): Promise<void> {
    this.sentEnters.push(session);
  }

  /** 恒真：测试不需要真的等待轮询间隔。 */
  override async waitForShell(_name: string, _timeoutMs: number): Promise<boolean> {
    return true;
  }

  override async capturePane(_name: string): Promise<string> {
    return '';
  }
}
