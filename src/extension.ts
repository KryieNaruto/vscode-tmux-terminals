import * as vscode from 'vscode';
import * as path from 'path';
import { EntryStore } from './core/store';
import { TmuxClient } from './tmuxClient';
import { EntryTreeItem, EntryTreeProvider, TaskTreeItem } from './tree';
import { BatchTreeProvider } from './batchTree';
import { readProfileConfig } from './claudeConfig';
import { TerminalManager } from './terminalManager';
import { ActivityTracker } from './activityTracker';
import { sessionNameFor } from './core/tmux';

let pollTimer: NodeJS.Timeout | undefined;
let activityTimer: NodeJS.Timeout | undefined;

/** 活动轮询节奏——比会话存活轮询（默认 10s，见 pollInterval 配置）快得多，
 * 因为它驱动的是"运行中徽章闪烁"这种需要看起来鲜活的 UI 效果，不是配置项，
 * 用户不需要也不应该去调它。 */
const ACTIVITY_POLL_INTERVAL_MS = 900;

export function activate(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration('tmuxTerminals');

  const storageFile = (): string => {
    const override = cfg().get<string>('storagePath', '').trim();
    return override.length > 0
      ? override
      : path.join(context.globalStorageUri.fsPath, 'terminals.json');
  };

  const tmux = new TmuxClient(cfg().get<string>('tmuxPath', 'tmux'));
  // 清单文件被覆盖前若发现它已损坏/不可解析，store 会先把原文另存为
  // `<file>.corrupt`。这里只负责把这件事告诉用户 —— 否则数据被抢救了
  // 却无人知晓，用户会以为条目"自己没了"。
  const store = new EntryStore(storageFile(), (corruptPath) => {
    void vscode.window.showWarningMessage(
      `终端清单文件无法解析，原始内容已保留为 ${corruptPath}。` +
      `清单已按空列表继续，可从中手动恢复条目。`,
    );
  });
  // TmuxClient 已经有 paneTitle(name) 方法，结构上满足 ActivityTracker
  // 需要的最小接口，不需要额外适配。
  const tracker = new ActivityTracker(tmux);
  const provider = new EntryTreeProvider(store, tracker);
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

  // v1→v2 迁移前先备份一次用户数据。只在文件真的是 v1 形态时备份，且
  // 已有 .bak 不覆盖 —— 第一次的备份才是原始数据。备份失败只静默：读文件
  // 已成功，这里只兜 .bak 写不进去的情况，绝不让一次备份失败阻断扩展启动
  // 或抛出未处理的 rejection。
  void store
    .migrateAndBackup()
    .then((did) => {
      if (did) {
        void vscode.window.showInformationMessage(
          '终端清单已升级到新格式，原文件已备份为 terminals.json.bak。',
        );
      }
    })
    .catch(() => {
      // 忽略：备份只是防御手段，失败不影响正常使用。
    });

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

  // ---- 活动状态轮询（运行中/刚完成的徽章与图标，见 activityTracker.ts）----
  // 独立于上面的存活轮询：节奏快得多（900ms vs 默认 10s），且只在面板
  // 可见时跑——这是纯视觉效果，不可见时没有意义轮询，白白多发 tmux 命令。
  let activityInFlight = false;
  const pollActivity = async () => {
    if (activityInFlight) return;
    activityInFlight = true;
    try {
      const entries = await store.load();
      const aliveIds = entries
        .filter((e) => provider.isAlive(sessionNameFor(e.id)))
        .map((e) => e.id);
      await tracker.poll(aliveIds);
    } finally {
      activityInFlight = false;
    }
  };

  const restartActivityPolling = () => {
    if (activityTimer) clearInterval(activityTimer);
    activityTimer = undefined;
    if (view.visible) {
      activityTimer = setInterval(() => void pollActivity(), ACTIVITY_POLL_INTERVAL_MS);
    }
    void pollActivity();
  };

  context.subscriptions.push(
    view.onDidChangeVisibility(() => {
      restartPolling();
      restartActivityPolling();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tmuxTerminals')) restartPolling();
    }),
    tracker.onDidChange(() => provider.refresh()),
    new vscode.Disposable(() => {
      if (pollTimer) clearInterval(pollTimer);
      if (activityTimer) clearInterval(activityTimer);
    }),
  );
  restartPolling();
  restartActivityPolling();

  // ---- 命令注册 ----
  const item = (arg: unknown): EntryTreeItem | TaskTreeItem | undefined =>
    arg instanceof EntryTreeItem || arg instanceof TaskTreeItem ? arg : undefined;

  const reg = (id: string, fn: (...a: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('tmuxTerminals.open', async (arg: unknown) => {
    const it = item(arg);
    if (it) {
      // 先清"刚完成待查看"标记再真正打开：用户点开就是"看到了"，
      // 图标应该立刻恢复，不用等下一轮 tmux 轮询。
      tracker.markSeen(it.entry.id);
      await manager.openEntry(it.entry);
    }
  });

  reg('tmuxTerminals.add', async () => {
    await manager.addEntryInteractive();
    provider.refresh();
    batchProvider.refresh();
  });

  reg('tmuxTerminals.edit', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.editEntryInteractive(it.entry);
    provider.refresh();
    batchProvider.refresh();
  });

  reg('tmuxTerminals.duplicate', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.duplicateEntry(it.entry);
    provider.refresh();
    batchProvider.refresh();
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

  // 批量面板缓存自己的 entries 快照（entriesFor 读它），单条改动后不同步
  // 刷新，批量操作就会基于过期数据：batchSetModel 按旧 profile 取模型清单，
  // applyProfile 又会对「其实没切过」的条目提前返回。三者都需一并刷新。
  reg('tmuxTerminals.toggleAutoRestore', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.toggleAutoRestore(it.entry);
    provider.refresh();
    batchProvider.refresh();
  });

  // setModel 不 poll：改模型不改变会话存活状态，无需刷新存活标记
  //（setProfile 会重启会话，故需要 poll 刷新存活）。
  // 只改绑定，不动正在跑的会话 —— 因此不 poll、只是刷新 tooltip
  reg('tmuxTerminals.bindConversation', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.bindConversationInteractive(it.entry);
    provider.refresh();
    batchProvider.refresh();
  });

  reg('tmuxTerminals.setModel', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.setModelInteractive(it.entry);
    provider.refresh();
    batchProvider.refresh();
  });

  reg('tmuxTerminals.setProfile', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.setProfileInteractive(it.entry);
    await poll();
    provider.refresh();
    batchProvider.refresh();
  });

  reg('tmuxTerminals.restoreAll', async () => {
    await manager.restoreAll();
    await poll();
  });

  reg('tmuxTerminals.refresh', async () => {
    await poll();
    provider.refresh();
  });

  // 内部命令：只由批量面板的 TreeItem.command 调用。已在 package.json 声明
  // （让「注册⇒声明」的清单校验覆盖它），但用 commandPalette 的 when:false
  // 从命令面板隐藏 —— 避免徒增噪音。
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
    const { models } = await readProfileConfig(targets[0].profile, manager.home());
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
  if (activityTimer) clearInterval(activityTimer);
}
