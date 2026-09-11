/**
 * 「一个终端此刻在不在跑」的纯状态机：running / idle / done-unseen 三态。
 *
 * 本文件刻意不依赖 vscode，也不碰 tmux，只做状态迁移的纯逻辑，以便脱离
 * 编辑器直接单测。判断「是否在运行」的信号来源见 core/tmux.ts 的
 * isRunningTitle/taskNameFromTitle（读 tmux pane title）。
 *
 * 三态语义：
 * - idle：空闲，且此前没有「我方亲眼看到它从运行变空闲」这件事——
 *   要么从没运行过，要么运行完已经被用户看过了。
 * - running：正在运行。
 * - done-unseen：刚从 running 变空闲，但用户还没点开看过。这是驱动
 *   「运行完成，显示绿色，直到点击查看」这个 UI 效果的唯一依据。
 *
 * **关键不变量：done-unseen 只能由「我方观测到 running → 不再 running」
 * 这个迁移产生。** 首次观测到某条目就是空闲状态时，必须判为 idle 而不是
 * done-unseen——否则用户一打开 VS Code，所有本来就空闲的会话会集体
 * 「假装刚完成」，绿色泛滥且没有意义。
 */

export type ActivityState = 'idle' | 'running' | 'done-unseen';

/** 一次采样：这一刻的 pane title 解析结果。 */
export interface ActivitySample {
  running: boolean;
  /** 任务名，''表示没有（调用方已经过滤掉默认占位符，见 core/tmux.ts 的 taskNameFromTitle）。 */
  taskName: string;
}

/** 一个条目的活动状态快照。 */
export interface EntryActivity {
  state: ActivityState;
  taskName: string;
}

/**
 * 由上一次快照（undefined 表示这是第一次观测这个条目）和这一次采样，
 * 算出下一个快照。
 *
 * 迁移表（sample.running 为 true 时，不管上一态是什么，一律进 running；
 * 表格只列 sample.running 为 false 时的分支）：
 *
 * | prev        | sample.running=false → next |
 * |-------------|------------------------------|
 * | undefined   | idle（首次观测就是空闲，不算完成）|
 * | idle        | idle                          |
 * | running     | done-unseen（这就是"刚运行完"）|
 * | done-unseen | done-unseen（还没被看过，维持）|
 *
 * taskName 每次都用本次采样的值覆盖——它是「当前」信息，不需要跨态保留旧值。
 */
export function nextActivity(
  prev: EntryActivity | undefined,
  sample: ActivitySample,
): EntryActivity {
  if (sample.running) {
    return { state: 'running', taskName: sample.taskName };
  }
  if (prev === undefined) {
    return { state: 'idle', taskName: sample.taskName };
  }
  if (prev.state === 'running' || prev.state === 'done-unseen') {
    return { state: 'done-unseen', taskName: sample.taskName };
  }
  return { state: 'idle', taskName: sample.taskName };
}

/**
 * 用户点开条目查看后调用：done-unseen → idle。其余状态原样返回
 * （不是新对象，调用方可以用 `!==` 判断有没有发生变化，从而决定要不要
 * 触发一次 UI 刷新）。
 */
export function markSeen(activity: EntryActivity): EntryActivity {
  return activity.state === 'done-unseen'
    ? { state: 'idle', taskName: activity.taskName }
    : activity;
}
