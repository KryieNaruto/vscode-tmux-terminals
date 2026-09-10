/**
 * 「恢复一条条目」的判据。纯函数，零 vscode 依赖，便于脱离编辑器单测。
 *
 * 背景（2026-09-10 订正，v2 首发后实测）：
 * v2 起初把两个**非权威信号**当成「已经恢复好了」的证据，命中即
 * `show()` 并 return：
 *   1. 内存 `terminals` Map 命中；
 *   2. `window.terminals` 里存在同名终端。
 * 两者都不验证 tmux 会话是否还在、也不验证有没有客户端附着。真实后果：
 *
 *   - **会话已死 + 同名面板 → 完全 no-op。** 面板当初是以 `{cwd}` 建的，
 *     tmux 客户端一退出它就退回该目录下的裸 shell —— 用户看到的正是
 *     「只能恢复到 cd 那一层，不会调用 claude」。
 *   - **会话存活但 `#{session_attached}` 为 0 + 同名面板 → 只 show()。**
 *     claude 其实在后台跑着，用户却看不见，表现同样是「不会调用 claude」。
 *     （实测用户 7 个会话全部存活、pane 前台就是 claude，其中 6 个附着数为 0。）
 *
 * **权威事实只有两个**：`tmux has-session` 的结果、该会话的
 * `#{session_attached}`。内存 Map 与「终端同名」只能用来回答
 * 「用哪个面板」，绝不能用来说明「已经恢复好了」。
 *
 * 安全不变量（改错就是更严重的 bug）：
 *  - 会话原本就存活时，绝不发送 `commandFor(entry)` 派生的启动命令；
 *  - **只有能证明面板空闲停在 shell 提示符上（`idle === true`）才允许
 *    往里打字。** 面板里可能正跑着用户的编译，把 `tmux attach` 塞进它的
 *    stdin 能毁掉一次构建。宁可多开一个面板。
 */

/** tmux 侧的权威事实。 */
export interface SessionFacts {
  /** `tmux has-session` 的结果 */
  exists: boolean;
  /** `#{session_attached}`；null = 读不出数字，按「未知」保守处理 */
  attached: number | null;
}

/** 候选面板（仅用于挑「用哪个面板」）。 */
export interface PanelFacts {
  /** 是否存在候选面板（Map 命中，或 `window.terminals` 里同名） */
  present: boolean;
  /** 能否证明它空闲停在 shell 提示符上（shell integration 在场且无命令在跑） */
  idle: boolean;
}

export type OpenAction =
  /** 已有客户端附着且面板在手 → 只 `show()`，不重复 attach */
  | 'show'
  /** 复用该面板并往里发 `tmux attach`（它已被证明空闲） */
  | 'reuse-attach'
  /** 新建面板并往里发 `tmux attach` */
  | 'new-attach';

/**
 * 决定对一条条目该做什么。
 *
 * 顺序即优先级：
 *  1. 会话存在 + 至少一个客户端附着 + 有面板 → 已在显示，`show` 即可；
 *  2. 否则一律必须把会话真正接上：面板证明空闲才复用，否则新建。
 *
 * `attached === null`（未知）**不**满足第 1 条 —— 宁可重复 attach 一次
 * （tmux 允许多客户端），也不能漏掉一次真正的恢复。
 */
export function decideOpen(session: SessionFacts, panel: PanelFacts): OpenAction {
  const attached = session.attached ?? 0;
  if (session.exists && attached >= 1 && panel.present) return 'show';
  return panel.present && panel.idle ? 'reuse-attach' : 'new-attach';
}
