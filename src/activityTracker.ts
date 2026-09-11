import { isRunningTitle, sessionNameFor, taskNameFromTitle } from './core/tmux';
import { EntryActivity, markSeen, nextActivity } from './core/activity';

/** ActivityTracker 需要的最小 tmux 能力——按条目 id 派生出的 session 名读 pane title。 */
export interface PaneTitleReader {
  paneTitle(session: string): Promise<string>;
}

/**
 * 轮询一批「存活条目」的 tmux pane title，推进每个条目的活动状态机
 * （见 core/activity.ts）。
 *
 * 刻意不依赖 vscode：只依赖一个「读 pane title」的最小接口（结构类型，
 * TmuxClient 天然满足），方便直接用 mocha 单测。
 */
export class ActivityTracker {
  private listeners: Array<() => void> = [];
  private state = new Map<string, EntryActivity>();

  constructor(private readonly tmux: PaneTitleReader) {}

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

  activityFor(entryId: string): EntryActivity | undefined {
    return this.state.get(entryId);
  }

  /** 用户点开条目查看：done-unseen → idle。状态确实变了才触发一次通知。 */
  markSeen(entryId: string): void {
    const cur = this.state.get(entryId);
    if (cur === undefined) return;
    const next = markSeen(cur);
    if (next !== cur) {
      this.state.set(entryId, next);
      this.fire();
    }
  }

  /**
   * 轮询一批存活条目的 id（是否存活由调用方判定，这里不重复判断，
   * 只管在给定的这批 id 上读 pane title）。
   *
   * 已死亡（不在 aliveEntryIds 里）的条目直接从状态表里删掉——下次它
   * 再出现按「首次观测」处理，不会凭空冒出一次「刚运行完」
   * （见 core/activity.ts 顶部注释里的不变量）。
   *
   * 无论有没有存活条目，每次调用结束都触发一次变化通知，让订阅方
   * （UI 刷新）能看到状态表里的最新结果。
   */
  async poll(aliveEntryIds: readonly string[]): Promise<void> {
    const aliveSet = new Set(aliveEntryIds);
    for (const id of [...this.state.keys()]) {
      if (!aliveSet.has(id)) this.state.delete(id);
    }

    if (aliveEntryIds.length > 0) {
      const titles = await Promise.all(
        aliveEntryIds.map((id) => this.tmux.paneTitle(sessionNameFor(id))),
      );
      aliveEntryIds.forEach((id, i) => {
        const title = titles[i];
        const sample = { running: isRunningTitle(title), taskName: taskNameFromTitle(title) };
        this.state.set(id, nextActivity(this.state.get(id), sample));
      });
    }

    this.fire();
  }
}
