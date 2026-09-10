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

/**
 * 启动哪一条对话。
 *
 * **为什么必须显式指定：** 不带参数的裸 `claude` 会开一条**全新**对话。
 * 会话死掉后重建时这么做，等于把原来的对话顶掉 —— 用户看到「会话全部
 * 清空」，只能手动 `/resume` 去翻列表，而多个条目共用同一个 cwd 时根本
 * 分不清哪个终端对应哪条对话（实测 4 条条目同 cwd、15 条候选）。
 */
export type LaunchSpec =
  /** 首次启动：开一条全新对话并把它**永久绑定**到条目 */
  | { kind: 'new'; conversationId: string }
  /** 接回该条目已绑定的那条对话 */
  | { kind: 'resume'; conversationId: string }
  /** 未绑定时的退路：接该 cwd 下最近的一条（用户明确放弃绑定时才用） */
  | { kind: 'continue' };

/**
 * 由 LaunchSpec 派生出完整的启动命令行。
 *
 * 带 `--resume` / `--session-id` 后**必须在条目自己的 cwd 里执行** ——
 * `--resume` 是按 cwd 作用域的（见 core/conversation.ts 顶部注释）。
 * 扩展建会话时本来就传 `-c cwd`，天然满足，不要在别处另起 cwd。
 *
 * 对话 id 一律经 shellQuote：它可能来自被手改的清单文件，命令行字符串
 * 是要塞进 shell 执行的。
 */
export function conversationCommand(entry: TerminalEntry, spec: LaunchSpec): string {
  const base = commandFor(entry);
  switch (spec.kind) {
    case 'new':
      return `${base} --session-id ${shellQuote(spec.conversationId)}`;
    case 'resume':
      return `${base} --resume ${shellQuote(spec.conversationId)}`;
    case 'continue':
      return `${base} --continue`;
  }
}
