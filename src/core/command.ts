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
 * 分不清哪个终端对应哪条对话（实测 4 条条目同 cwd、15 条候选）。所以
 * **只要这条条目已经有过对话**，就必须用 `new` / `resume` 把 id 交代清楚。
 *
 * **`fresh` 是这条规则的唯一例外，且例外范围卡得很死**：只有「条目绑定的
 * 那条对话**还没有任何记录**」时才用它（见 terminalManager.resolveLaunchSpec）。
 * 此时没有被顶掉的对话，条目也还没有过任何真实会话。给这种首启钉一个预设
 * uuid（`new` 的行为）只会往用户眼前塞一个他没见过的会话 id —— 那条预设
 * 对话根本不会被用起来，用户抱怨的正是它。裸 `claude` 当场开出的那条才是
 * 真正在用的，reconcile 一旦观测到活跃会话就会把它回写成 `conversationId`
 * （见 core/reconcile.ts 第三分支），绑定**不需要**靠 `--session-id` 预先钉。
 *
 * **刻意没有 `continue` 分支。** `claude --continue` 接的是「该 cwd 下最近
 * 的一条对话」—— 条目共用 cwd 时（实测 4 条同目录），若都走它就会一起接到
 * 同一条对话上去，两个 claude 进程同时写同一个 `.jsonl`，是数据损坏级的
 * 问题。所以「接哪条」要么由绑定决定，要么由用户当场指定，绝不含糊。
 */
export type LaunchSpec =
  /**
   * 开一条全新对话，且**不向 claude 传递任何会话标识**（就是裸命令）。
   * 只用于「这条条目还没有过任何真实会话」的首启，绑定交给 reconcile 观测
   * 回写。与 `new` 的分界就在这：`new` 是**有意**钉一个已知 id。
   */
  | { kind: 'fresh' }
  /** 开一条全新对话，并当场钉成指定 id（用户在选择框里主动选了「新建一条对话」） */
  | { kind: 'new'; conversationId: string }
  /** 接回指定的一条对话（条目绑定的，或用户当场选中的） */
  | { kind: 'resume'; conversationId: string };

/**
 * 由 LaunchSpec 派生出完整的启动命令行。
 *
 * 带 `--resume` / `--session-id` 后**必须在条目自己的 cwd 里执行** ——
 * `--resume` 是按 cwd 作用域的（见 core/conversation.ts 顶部注释）。
 * 扩展建会话时本来就传 `-c cwd`，天然满足，不要在别处另起 cwd。
 *
 * `fresh` 同样**必须**在条目自己的 cwd 里跑，理由和 `--resume` 一样（虽然
 * 它自己没有会话参数）：它当场开出的那条对话，下次就是靠 `--resume` 按
 * cwd 接回来的。换个目录开，等于每次首启都造一条谁都接不回的孤儿对话。
 *
 * 对话 id 一律经 shellQuote：它可能来自被手改的清单文件，命令行字符串
 * 是要塞进 shell 执行的。
 */
export function conversationCommand(entry: TerminalEntry, spec: LaunchSpec): string {
  const base = commandFor(entry);
  switch (spec.kind) {
    case 'fresh':
      // 裸 claude：**一个会话参数都不加**。这里是「不传任何标识」的唯一
      // 出口，别顺手补个 --continue —— 那会接到该 cwd 下最近的一条对话上。
      return base;
    case 'new':
      return `${base} --session-id ${shellQuote(spec.conversationId)}`;
    case 'resume':
      return `${base} --resume ${shellQuote(spec.conversationId)}`;
    default:
      // 运行时兜底：LaunchSpec 来自手写分支，一旦有人把 `--continue`
      // （或别的含糊退路）加回来，宁可炸也不要静默接错对话。
      throw new Error(`未知的 LaunchSpec：${JSON.stringify(spec)}`);
  }
}
