/**
 * 端到端驱动脚本（非 mocha 测试，手动跑）。
 *
 * 目的：VS Code 接线层一直被认为是「只能手动冒烟」，但那只是因为
 * `vscode` 模块需要运行时注入。这里用一个 stub 顶上，把真正的
 * TerminalManager.openEntry 对着**真 tmux** 驱动起来，从而自动验证
 * 几条最核心的不变量：
 *
 *   1. 会话不存在 → 新建，并执行预设命令
 *   2. 会话已存在 → 接回，**绝不执行预设命令**（本项目最重要的一条）
 *   3. 重复点击 → 复用已有终端，不新开
 *   4. 前缀相近的会话互不干扰
 *
 * 用法：node test/e2e-harness.js
 */
'use strict';

const Module = require('module');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

// ---- 1. 注入 vscode stub ----
const calls = { terminals: [], messages: [], warns: [], errors: [] };

class TreeItem {
  constructor(label) { this.label = label; }
}
class EventEmitter {
  constructor() { this.event = () => ({ dispose() {} }); }
  fire() {}
  dispose() {}
}
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class ThemeColor { constructor(id) { this.id = id; } }
class MarkdownString { constructor(v) { this.value = v; } }

const vscodeStub = {
  TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter,
  ThemeIcon,
  ThemeColor,
  MarkdownString,
  window: {
    createTerminal(opts) {
      const t = {
        name: opts && opts.name,
        cwd: opts && opts.cwd,
        sent: [],
        shown: 0,
        show() { this.shown++; },
        sendText(text, addNewline) { this.sent.push({ text, addNewline }); },
        dispose() {},
      };
      calls.terminals.push(t);
      return t;
    },
    onDidCloseTerminal() { return { dispose() {} }; },
    showWarningMessage(m) { calls.warns.push(m); return Promise.resolve(undefined); },
    showErrorMessage(m) { calls.errors.push(m); return Promise.resolve(undefined); },
    showInformationMessage(m) { calls.messages.push(m); return Promise.resolve(undefined); },
    showInputBox() { return Promise.resolve(undefined); },
    showQuickPick() { return Promise.resolve(undefined); },
  },
  workspace: {
    getConfiguration() { return { get: (_k, d) => d }; },
    onDidChangeConfiguration() { return { dispose() {} }; },
  },
  commands: { registerCommand() { return { dispose() {} }; } },
  Disposable: class { constructor(fn) { this.fn = fn; } dispose() { this.fn && this.fn(); } },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode-stub';
  return origResolve.call(this, request, ...rest);
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: vscodeStub };

// ---- 2. 加载被测代码 ----
const ROOT = path.resolve(__dirname, '..');
const { TerminalManager } = require(path.join(ROOT, 'out/src/terminalManager.js'));

// ---- 3. 断言辅助 ----
let fail = 0;
const chk = (label, ok, extra) => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `\n    ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (id) => `tmuxterm-${id}`;

async function killAll(ids) {
  for (const id of ids) {
    try { await run('tmux', ['kill-session', '-t', `=${S(id)}`]); } catch {}
  }
}
async function paneText(id) {
  try {
    const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', `=${S(id)}:`]);
    return stdout;
  } catch { return ''; }
}

(async () => {
  const ID_A = 'e2e0000a';
  const ID_B = 'e2e0000ab';      // 与 A 互为前缀，验证互不干扰
  const ALL = [ID_A, ID_B];
  const store = {
    entries: [],
    async load() { return this.entries; },
    async save(e) { this.entries = e; },
    async add(e) { this.entries.push(e); },
    async update() {}, async remove() {}, async findByName() {},
  };
  const { TmuxClient } = require(path.join(ROOT, 'out/src/tmuxClient.js'));
  const tmux = new TmuxClient('tmux');
  const mgr = new TerminalManager(store, tmux);

  await killAll(ALL);

  const entryA = { id: ID_A, name: 'A', cwd: '/tmp', commands: ['echo MARKER_A'], autoRestore: true };
  const entryB = { id: ID_B, name: 'B', cwd: '/tmp', commands: ['echo MARKER_B'], autoRestore: true };

  console.log('=== 1. 会话不存在 → 新建并执行预设命令 ===');
  await mgr.openEntry(entryA);
  await sleep(2500);
  const t1 = calls.terminals[calls.terminals.length - 1];
  chk('创建了终端', calls.terminals.length === 1);
  chk('终端名为显示名', t1.name === 'A', `实际 ${t1.name}`);
  chk('cwd 为展开后的目录', t1.cwd === '/tmp', `实际 ${t1.cwd}`);
  chk('发送的是 tmux attach（会话已由扩展 detached 建好）',
    t1.sent.some((s) => s.text.includes('tmux attach') && s.text.includes(S(ID_A))),
    JSON.stringify(t1.sent.map((s) => s.text)));
  chk('会话已建立', await tmux.hasSession(S(ID_A)));
  const pane1 = await paneText(ID_A);
  chk('预设命令 MARKER_A 已执行', pane1.includes('MARKER_A'), pane1.split('\n').slice(-4).join('|'));

  console.log('\n=== 2. 会话已存在 → 接回，绝不执行预设命令（核心不变量） ===');
  // 换一个 manager 模拟「SSH 断线重连后」的新会话
  const mgr2 = new TerminalManager(store, tmux);
  calls.terminals.length = 0;
  await mgr2.openEntry({ ...entryA, commands: ['echo SHOULD_NOT_RUN'] });
  await sleep(1200);
  const t2 = calls.terminals[0];
  chk('接回的是已有会话', t2.sent.some((s) => s.text.includes('tmux attach')));
  const pane2 = await paneText(ID_A);
  chk('★ 预设命令未被送入会话', !pane2.includes('SHOULD_NOT_RUN'),
    '命令污染了用户正在运行的进程 stdin！');
  chk('原会话内容仍在（接回非重建）', pane2.includes('MARKER_A'));

  console.log('\n=== 3. 重复点击 → 复用终端，不新开 ===');
  calls.terminals.length = 0;
  const mgr3 = new TerminalManager(store, tmux);
  await mgr3.openEntry(entryA);
  const countAfterFirst = calls.terminals.length;
  await mgr3.openEntry(entryA);
  chk('第二次点击未新建终端', calls.terminals.length === countAfterFirst,
    `第一次 ${countAfterFirst} 个，第二次后 ${calls.terminals.length} 个`);
  chk('第二次点击执行了 show()', calls.terminals[0].shown >= 2);

  console.log('\n=== 4. 前缀相近的会话互不干扰 ===');
  const mgr4 = new TerminalManager(store, tmux);
  await mgr4.openEntry(entryB);
  await sleep(2500);
  chk('B 的会话已建立', await tmux.hasSession(S(ID_B)));
  chk('A 的会话仍在（未被 B 影响）', await tmux.hasSession(S(ID_A)));
  const paneB = await paneText(ID_B);
  chk('B 执行了自己的命令 MARKER_B', paneB.includes('MARKER_B'));
  chk('B 的会话里没有 A 的命令', !paneB.includes('MARKER_A'));

  console.log('\n=== 5. 清理 ===');
  await killAll(ALL);
  const left = (await tmux.listSessions()).filter((s) => s.startsWith('tmuxterm-e2e'));
  chk('无残留测试会话', left.length === 0, left.join(', '));

  console.log(`\n${fail === 0 ? '端到端全部通过 ✓' : `${fail} 项失败`}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('harness 异常:', e);
  process.exit(1);
});
