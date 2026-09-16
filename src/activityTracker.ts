import { PaneSample, isRunningTitle, sessionNameFor, taskNameFromSample } from './core/tmux';
import { EntryActivity, markSeen, nextActivity } from './core/activity';

/**
 * ActivityTracker 需要的最小 tmux 能力——按条目 id 派生出的 session 名，
 * **一次**读回前台进程名与 pane title 两个字段。
 */
export interface PaneSampleReader {
  paneSample(session: string): Promise<PaneSample>;
}

/**
 * 轮询一批「存活条目」的 tmux pane 采样（前台进程名 + pane title），推进每个
 * 条目的活动状态机（见 core/activity.ts）。
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

  constructor(private readonly tmux: PaneSampleReader) {}

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
   * 只管在给定的这批 id 上各读一次采样）。
   *
   * 已死亡（不在 aliveEntryIds 里）的条目直接从状态表里删掉——下次它
   * 再出现按「首次观测」处理，不会凭空冒出一次「刚运行完」
   * （见 core/activity.ts 顶部注释里的不变量）。
   *
   * **只有这一轮真的改变了状态表才触发变化通知**（删掉了条目，或某个
   * 条目的 state / taskName 与旧值不同）；什么都没变就不通知。订阅方
   * （extension.ts 里接的是整树重建）只关心变化——从前无条件通知，采样
   * 循环每 ≈900 ms 跑一轮，就退化成每 ≈900 ms 一次零变化的整树重建，
   * 表现为侧边栏标题栏上永不消失的进度条。
   *
   * 判断必须**按值**比较 state / taskName 两个字段：nextActivity 每次
   * 都返回**新对象**，`prev !== next` 恒为真（见 core/activity.ts 该函数
   * 注释），照那样写会退化成"每轮无条件通知"。
   */
  async poll(aliveEntryIds: readonly string[]): Promise<void> {
    let changed = false;

    const aliveSet = new Set(aliveEntryIds);
    for (const id of [...this.state.keys()]) {
      if (!aliveSet.has(id)) {
        this.state.delete(id);
        changed = true; // 条目消失也是变化
      }
    }

    if (aliveEntryIds.length > 0) {
      // 每个条目**一次** tmux 调用（不是两次）—— 采样循环每 ≈900 ms 跑一轮，
      // 这里的进程数直接乘在轮询频率上。
      const samples = await Promise.all(
        aliveEntryIds.map((id) => this.tmux.paneSample(sessionNameFor(id))),
      );
      aliveEntryIds.forEach((id, i) => {
        const s = samples[i];
        const sample = {
          running: isRunningTitle(s.title),
          // 闸门在 taskNameFromSample 里：前台不是 claude ⇒ ''（走 aiTitle 回退）。
          // running 不走闸门，理由见 core/tmux.ts 该函数注释。
          taskName: taskNameFromSample(s),
        };
        const prev = this.state.get(id);
        const next = nextActivity(prev, sample);
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
