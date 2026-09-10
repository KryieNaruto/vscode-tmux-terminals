import { commandFor } from './command';
import { TerminalEntry } from './types';

export type RestoreMode = 'attach' | 'create';

export interface RestorePlan {
  mode: RestoreMode;
  commands: string[];
}

/**
 * 决定点击条目时该 attach 还是 create。
 *
 * **这是本项目的安全闸门。** 会话存活时必须 attach 且命令为空：
 * 若在存活会话上执行预设命令，那些命令会作为键盘输入进入用户正在
 * 运行的进程的 stdin（例如往一个跑着的 claude、编译或 REPL 里塞一
 * 行 `source env.sh`），后果不可预料。
 *
 * 因此不要用 `tmux new -A -s name` 一把梭 —— `-A` 在会话已存在时会
 * attach，调用方无从得知，接着就会误发命令。
 */
export function planRestore(entry: TerminalEntry, alive: boolean): RestorePlan {
  if (alive) {
    return { mode: 'attach', commands: [] };
  }
  return { mode: 'create', commands: [commandFor(entry)] };
}
