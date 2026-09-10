import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { EntryStore } from './core/store';
import { TmuxClient } from './tmuxClient';
import { EntryTreeItem, EntryTreeProvider } from './tree';
import { BatchTreeProvider } from './batchTree';
import { readProfileConfig } from './claudeConfig';
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

  const batchProvider = new BatchTreeProvider(store);
  const batchView = vscode.window.createTreeView('tmuxTerminals.batch', {
    treeDataProvider: batchProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(batchView);

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
    // 批量面板的 prune 只在 getChildren 里跑，这里主动触发一次刷新，
    // 让被删条目的 id 从选中集合里立即剔除，避免对已删条目执行批量操作。
    batchProvider.refresh();
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

  // setModel 不 poll：改模型不改变会话存活状态，无需刷新存活标记
  //（setProfile 会重启会话，故需要 poll 刷新存活）。
  reg('tmuxTerminals.setModel', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.setModelInteractive(it.entry);
    provider.refresh();
  });

  reg('tmuxTerminals.setProfile', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.setProfileInteractive(it.entry);
    await poll();
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

  // 内部命令：只由批量面板的 TreeItem.command 调用，故不在 package.json 里
  // 声明 —— 声明了就会出现在命令面板，徒增噪音。
  reg('tmuxTerminals.batchToggle', (id: unknown) => {
    if (typeof id === 'string') batchProvider.toggle(id);
  });

  reg('tmuxTerminals.batchClear', () => batchProvider.clear());

  reg('tmuxTerminals.batchSetDirect', async () => {
    await manager.applyProfileToMany(
      batchProvider.entriesFor(batchProvider.selectedIds()), 'direct',
    );
    batchProvider.clear();
    await poll();
    provider.refresh();
  });

  reg('tmuxTerminals.batchSetCcr', async () => {
    await manager.applyProfileToMany(
      batchProvider.entriesFor(batchProvider.selectedIds()), 'ccr',
    );
    batchProvider.clear();
    await poll();
    provider.refresh();
  });

  reg('tmuxTerminals.batchSetModel', async () => {
    const targets = batchProvider.entriesFor(batchProvider.selectedIds());
    if (targets.length === 0) {
      void vscode.window.showInformationMessage('请先在「批量操作」里选中条目。');
      return;
    }
    // 候选取第一条的 profile：批量场景下用户的心智是「这批统一成某个模型」
    const { models } = await readProfileConfig(targets[0].profile, os.homedir());
    const CLEAR = '（清空，用 profile 默认）';
    const pick = await vscode.window.showQuickPick([...models, CLEAR], {
      title: `批量设置模型（${targets.length} 条）`,
    });
    if (pick === undefined) return;
    await manager.applyModelToMany(targets, pick === CLEAR ? undefined : pick);
    batchProvider.clear();
    await poll();
    provider.refresh();
  });
}

export function deactivate(): void {
  if (pollTimer) clearInterval(pollTimer);
}
