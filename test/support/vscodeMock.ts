/**
 * `vscode` 模块在纯 mocha 单测里不可 `require`（不在 extension host 里跑）。
 *
 * `src/terminalManager.ts` 是本仓库唯一一个、在 applyModel/applyProfile 的
 * 被测路径上会 `import * as vscode from 'vscode'` 的文件——它的其余依赖
 * （core/*、claudeConfig、conversationFiles、liveSessions、tmuxClient、
 * core/store）全都不碰 vscode（已逐个确认）。所以这里只需要提供
 * terminalManager.ts 实际执行到的那几个 API：
 * `window.show*Message` / `createTerminal` / `terminals` /
 * `onDidCloseTerminal` / `onDidStartTerminalShellExecution` /
 * `onDidEndTerminalShellExecution`。
 *
 * 通过 `register.ts` 里的 `Module._resolveFilename` 钩子接管
 * `require('vscode')`，不需要在 node_modules 里放一个假包（那样会在
 * `npm install` 后被冲掉，不可靠）。
 */

export type MessageKind = 'error' | 'info' | 'warning';

export interface RecordedMessage {
  kind: MessageKind;
  text: string;
}

/** 本次进程里、经由该 mock 弹出的所有消息，按调用顺序追加。 */
export const messages: RecordedMessage[] = [];

/** 每个 it() 之前调用，避免上一条用例的消息串到下一条。 */
export function resetVscodeMock(): void {
  messages.length = 0;
}

function recorder(kind: MessageKind) {
  return (text: string, ..._rest: unknown[]): Promise<string | undefined> => {
    messages.push({ kind, text });
    return Promise.resolve(undefined);
  };
}

class FakeEventEmitter<T> {
  private readonly listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
}

export const window = {
  terminals: [] as unknown[],
  showErrorMessage: recorder('error'),
  showInformationMessage: recorder('info'),
  showWarningMessage: recorder('warning'),
  showInputBox: async (): Promise<string | undefined> => undefined,
  showQuickPick: async (): Promise<unknown> => undefined,
  createTerminal: (): unknown => ({ name: '', dispose: () => undefined }),
  onDidCloseTerminal: new FakeEventEmitter<unknown>().event,
  onDidStartTerminalShellExecution: new FakeEventEmitter<unknown>().event,
  onDidEndTerminalShellExecution: new FakeEventEmitter<unknown>().event,
};
