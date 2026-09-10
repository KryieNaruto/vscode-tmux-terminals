import { shellQuote } from './tmux';
import { TerminalEntry } from './types';

/**
 * 由 profile 派生启动命令。
 *
 * v1 把命令作为用户数据（commands: string[]），但实测 6 个条目 100% 是
 * 同一句 —— 这份灵活性是假的，代价却是每次新建都要手敲一遍。改成派生后
 * 启动方式只有这一处定义。
 *
 * 命令行字符串要塞进 shell 执行，所以模型名必须经 shellQuote。
 */
export function commandFor(entry: TerminalEntry): string {
  const exe = entry.profile === 'direct' ? 'claude-direct' : 'claude';
  const model = entry.model && entry.model.length > 0
    ? ` --model ${shellQuote(entry.model)}`
    : '';
  return `${exe} --dangerously-skip-permissions${model}`;
}
