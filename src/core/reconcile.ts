/**
 * 「条目绑定 ↔ 本次观测到的活跃会话」的纯回写规则。
 *
 * 本文件刻意不依赖 vscode、不碰文件系统，以便脱离编辑器直接单测。
 *
 * **命名**：`src/core/conversation.ts` 已有一个 `BindingView`（供 ownersOf
 * 用，形状不同），故本接口命名 `BindingState` —— terminalManager.ts 同时
 * 需要两者，同名会直接冲突。
 */

/** 一条条目的绑定视角。 */
export interface BindingState {
  conversationId?: string;
  liveSessionId?: string;
}

/** 需要回写的两个新值；返回 undefined = 什么都不动。 */
export interface BindingPatch {
  conversationId: string;
  liveSessionId: string;
}

/**
 * 由「当前绑定」与「这次观测到的活跃会话」算出新绑定。
 *
 *   live == null 或空串/纯空白  → undefined（观测不到就不动）
 *   live === entry.liveSessionId → undefined（含「手动改绑后 live 未变」）
 *   否则                          → { conversationId: live, liveSessionId: live }
 *
 * 第一分支**必须**把 `undefined` 与空串/纯空白一视同仁：`parseSessionRecord`
 * 已把空 `sessionId` 判为 `undefined`，但这里仍要再挡一道 —— 守卫只写
 * `live === undefined` 时，空串会落到第三分支把绑定写成 `''`（= 清空绑定）。
 *
 * 第三分支是「这个终端确实换了一条会话」（`/new`）：此时连手动改绑也要让位，
 * 因为用户的手动选择已经被终端自己的行为取代了。
 *
 * 手动改绑（右键「选择要接回的对话…」）只改 `conversationId`、不动
 * `liveSessionId` —— 于是「手动选了 X，live 仍是 Y」落在第二分支，X 不被冲掉。
 */
export function reconcileBinding(
  entry: BindingState,
  live: string | undefined,
): BindingPatch | undefined {
  if (live === undefined || live.trim().length === 0) return undefined;
  if (live === entry.liveSessionId) return undefined;
  return { conversationId: live, liveSessionId: live };
}
