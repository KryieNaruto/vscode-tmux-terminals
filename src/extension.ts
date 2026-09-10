import * as vscode from 'vscode';
import * as path from 'path';
import { EntryStore } from './core/store';
import { TmuxClient } from './tmuxClient';
import { EntryTreeItem, EntryTreeProvider } from './tree';
import { TerminalManager } from './terminalManager';

let pollTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration('tmuxTerminals');

  const storageFile = (): string => {
    const override = cfg().get<string>('storagePath', '').trim();
    return override.length > 0
      ? override
      : path.join(context.globalStorageUri.fsPath, 'terminals.json');
  };

  const tmux = new TmuxClient(cfg().get<string>('tmuxPath', 'tmux'));
  const store = new EntryStore(storageFile());
  const provider = new EntryTreeProvider(store);
  const manager = new TerminalManager(store, tmux);

  const view = vscode.window.createTreeView('tmuxTerminals.list', {
    treeDataProvider: provider,
    dragAndDropController: provider,
  });
  context.subscriptions.push(view);

  // ---- 存活状态轮询 ----
  let inFlight = false;
  const poll = async () => {
    if (inFlight) return; // 上一轮还没回来就跳过，避免请求堆积
    inFlight = true;
    try {
      provider.setAlive(new Set(await tmux.listSessions()));
    } finally {
      inFlight = false;
    }
  };

  const restartPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    const interval = cfg().get<number>('pollInterval', 10000);
    if (interval > 0 && view.visible) {
      pollTimer = setInterval(() => void poll(), interval);
    }
    void poll();
  };

  context.subscriptions.push(
    view.onDidChangeVisibility(() => restartPolling()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tmuxTerminals')) restartPolling();
    }),
    new vscode.Disposable(() => {
      if (pollTimer) clearInterval(pollTimer);
    }),
  );
  restartPolling();

  // ---- 命令注册 ----
  const item = (arg: unknown): EntryTreeItem | undefined =>
    arg instanceof EntryTreeItem ? arg : undefined;

  const reg = (id: string, fn: (...a: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('tmuxTerminals.open', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.openEntry(it.entry);
  });

  reg('tmuxTerminals.add', async () => {
    await manager.addEntryInteractive();
    provider.refresh();
  });

  reg('tmuxTerminals.edit', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.editEntryInteractive(it.entry);
    provider.refresh();
  });

  reg('tmuxTerminals.duplicate', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.duplicateEntry(it.entry);
    provider.refresh();
  });

  reg('tmuxTerminals.delete', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.deleteEntry(it.entry);
    provider.refresh();
  });

  reg('tmuxTerminals.killSession', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.killSession(it.entry);
    await poll();
  });

  reg('tmuxTerminals.toggleAutoRestore', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.toggleAutoRestore(it.entry);
    provider.refresh();
  });

  reg('tmuxTerminals.restoreAll', async () => {
    await manager.restoreAll();
    await poll();
  });

  reg('tmuxTerminals.refresh', async () => {
    await poll();
    provider.refresh();
  });
}

export function deactivate(): void {
  if (pollTimer) clearInterval(pollTimer);
}
