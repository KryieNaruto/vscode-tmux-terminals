/**
 * 端到端驱动脚本（非 mocha 测试，手动跑）。
 *
 * 目的：VS Code 接线层一直被认为是「只能手动冒烟」，但那只是因为
 * `vscode` 模块需要运行时注入。这里用一个 stub 顶上，把真正的
 * TerminalManager.openEntry 对着**真 tmux** 驱动起来，从而自动验证
 * 几条最核心的不变量：
 *
 *   1. 会话不存在 → 新建，并发送 profile 派生的启动命令
 *   2. 会话已存在 → 接回，**绝不发送任何命令**（本项目最重要的一条）
 *   3. 重复点击 → 复用已有终端，不新开
 *   4. 前缀相近的会话互不干扰
 *   5. 陈旧面板（宿主重启前留下的）不得被当成「已恢复」：会话已死要重建、
 *      0 附着要 attach；面板状态不明或有命令在跑时绝不往里打字
 *
 * 只使用 `tmuxterm-e2e*` 前缀的会话，跑完必清，绝不碰用户已有会话。
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
const calls = { terminals: [], messages: [], warns: [], errors: [], literals: [], newSessions: [] };

// 让某一节可以控制下一个 modal 弹窗的应答；默认 undefined（= 用户取消）。
let modalAnswer;

class TreeItem {
  constructor(label) { this.label = label; }
}
class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (cb) => { this.listeners.push(cb); return { dispose() {} }; };
  }
  fire(e) { for (const cb of [...this.listeners]) cb(e); }
  dispose() { this.listeners.length = 0; }
}

// shell integration 的「有命令开始/结束」事件。真实 VS Code（1.93+，本机
// 已开启 shell integration）靠它回答「某个面板里在跑什么」——这是
// TerminalManager 判断「能否安全复用这个面板」的唯一依据，必须能驱动。
const shellExecutionStart = new EventEmitter();
const shellExecutionEnd = new EventEmitter();
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
    // openEntry 的「按名复用守卫」会读 window.terminals。它是可变数组：
    // 某一节可往里塞「存活面板」再清空（见第 6 节）。默认空 —— 这样 1–4 节
    // 模拟的「扩展宿主重启后 Map 已空、面板也没存活」场景里，守卫查不到
    // 已存面板，继续走「重新 attach」路径并断言安全闸门。
    terminals: [],
    createTerminal(opts) {
      const t = {
        name: opts && opts.name,
        cwd: opts && opts.cwd,
        sent: [],
        shown: 0,
        disposed: 0,
        // 真实 VS Code 面板（shell integration 开启）在 shell 就绪后
        // 即有此对象；它是「可证明面板空闲」的前提。
        shellIntegration: {},
        show() { this.shown++; },
        sendText(text, addNewline) { this.sent.push({ text, addNewline }); },
        dispose() { this.disposed++; },
      };
      calls.terminals.push(t);
      return t;
    },
    onDidCloseTerminal() { return { dispose() {} }; },
    onDidStartTerminalShellExecution: (cb) => shellExecutionStart.event(cb),
    onDidEndTerminalShellExecution: (cb) => shellExecutionEnd.event(cb),
    showWarningMessage(m) { calls.warns.push(m); return Promise.resolve(modalAnswer); },
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

// ---- 造「真的附着在会话上的客户端」 ----
// `tmux attach` 需要 pty；借另一个 tmux 会话的 pane 提供 pty（`unset TMUX`
// 才允许嵌套）。杀那个 helper 会话即可精确摘掉客户端，不留游离进程。
const ATTACH_HELPER = 'tmuxterm-e2e-attach';

async function attachRealClient(session) {
  try { await run('tmux', ['kill-session', '-t', `=${ATTACH_HELPER}`]); } catch {}
  await run('tmux', ['new-session', '-d', '-s', ATTACH_HELPER,
    `unset TMUX; exec tmux attach -t =${session}`]);
  await sleep(900);
}

async function detachRealClient() {
  try { await run('tmux', ['kill-session', '-t', `=${ATTACH_HELPER}`]); } catch {}
  await sleep(300);
}

/**
 * 「陈旧面板」替身：扩展宿主重启前留下、名字与条目相同的终端。
 * `shellIntegration` 只有在真实 VS Code 里 shell 就绪后才会挂上 —— 不传
 * 就等价于「无法判定它是否空闲」，TerminalManager 必须因此新建面板。
 */
function makeSurvivor(name, opts) {
  const t = {
    name,
    sent: [],
    shown: 0,
    disposed: 0,
    show() { this.shown++; },
    sendText(text, addNewline) { this.sent.push({ text, addNewline }); },
    dispose() { this.disposed++; },
  };
  if (opts && opts.shellIntegration) t.shellIntegration = opts.shellIntegration;
  return t;
}

const attachedTo = (term) =>
  !!term && term.sent.some((s) => String(s.text).includes('tmux attach'));

// ccr profile 派生的启动命令（见 src/core/command.ts 的 commandFor）
const CCR_COMMAND = 'claude --dangerously-skip-permissions';

(async () => {
  const ID_A = 'e2e0000a';
  const ID_B = 'e2e0000ab';      // 与 A 互为前缀，验证互不干扰
  const ID_KILL = 'e2ekill0001';
  const ID_REFUSE = 'e2erefus01';
  const ALL = [ID_A, ID_B, ID_KILL, ID_REFUSE];
  const store = {
    entries: [],
    async load() { return this.entries; },
    async save(e) { this.entries = e; },
    async add(e) { this.entries.push(e); },
    async append(e) { this.entries.push({ ...e, order: this.entries.length }); },
    async update() {}, async remove() {}, async findByName() {}, async reorder() {},
  };
  const { TmuxClient } = require(path.join(ROOT, 'out/src/tmuxClient.js'));
  const tmux = new TmuxClient('tmux');

  // 记录「真正把命令送进 pane」的调用：openEntry 走 tmux.sendLiteral，
  // 不走 terminal.sendText（后者只发 `tmux attach`）。这里包一层以断言
  // 命令有没有被发送、发到了哪个会话。
  const origSendLiteral = tmux.sendLiteral.bind(tmux);
  tmux.sendLiteral = async (name, text) => {
    calls.literals.push({ name, text });
    return origSendLiteral(name, text);
  };
  const origNewSession = tmux.newSession.bind(tmux);
  tmux.newSession = async (name, cwd) => {
    calls.newSessions.push({ name, cwd });
    return origNewSession(name, cwd);
  };

  const mgr = new TerminalManager(store, tmux);

  await killAll(ALL);

  const entryA = { id: ID_A, name: 'A', cwd: '/tmp', profile: 'ccr', autoRestore: true, order: 0 };
  const entryB = { id: ID_B, name: 'B', cwd: '/tmp', profile: 'ccr', autoRestore: true, order: 0 };

  console.log('=== 1. 会话不存在 → 新建并发送 profile 派生的命令 ===');
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
  chk('create 发送了 profile 派生的命令到 A 会话',
    calls.literals.some((l) => l.name === S(ID_A) && l.text === CCR_COMMAND),
    JSON.stringify(calls.literals));

  console.log('\n=== 2. 会话已存在 → 接回，绝不发送任何命令（核心不变量） ===');
  // 换一个 manager 模拟「SSH 断线重连后」的新会话
  const mgr2 = new TerminalManager(store, tmux);
  calls.terminals.length = 0;
  calls.literals.length = 0;
  calls.newSessions.length = 0;
  await mgr2.openEntry(entryA);
  await sleep(1200);
  const t2 = calls.terminals[0];
  chk('接回的是已有会话', t2.sent.some((s) => s.text.includes('tmux attach')));
  chk('★ 接回时未发送任何命令（安全闸门）', calls.literals.length === 0,
    '命令污染了用户正在运行的进程 stdin！' + JSON.stringify(calls.literals));
  chk('接回未重建会话', calls.newSessions.length === 0,
    JSON.stringify(calls.newSessions));

  console.log('\n=== 3. 已恢复的会话：重复点击只 show，不新建也不重复 attach ===');
  calls.terminals.length = 0;
  const mgr3 = new TerminalManager(store, tmux);
  await mgr3.openEntry(entryA);
  const countAfterFirst = calls.terminals.length;
  const firstTerm = calls.terminals[0];

  // 第一次点击后，面板里的 `tmux attach` 在真实机器上确实会附着上去。
  // 用真客户端把这一步补上 —— 「已经有人在看这个会话」才是重复点击
  // 该走 show-only 的前提（判据是 #{session_attached}，不是内存 Map）。
  await attachRealClient(S(ID_A));
  const attachedNow = await tmux.attachedClients(S(ID_A));
  chk('会话已有客户端附着（判据就绪）', attachedNow !== null && attachedNow >= 1,
    `实际 attached=${attachedNow}`);
  const sentBefore = firstTerm.sent.length;

  await mgr3.openEntry(entryA);
  chk('第二次点击未新建终端', calls.terminals.length === countAfterFirst,
    `第一次 ${countAfterFirst} 个，第二次后 ${calls.terminals.length} 个`);
  chk('第二次点击执行了 show()', firstTerm.shown >= 2, `实际 show ${firstTerm.shown} 次`);
  chk('已恢复的会话不再重复 attach（不往面板重复打字）',
    firstTerm.sent.length === sentBefore,
    JSON.stringify(firstTerm.sent.slice(sentBefore)));

  await detachRealClient();

  console.log('\n=== 4. 前缀相近的会话互不干扰 ===');
  calls.literals.length = 0;
  calls.newSessions.length = 0;
  const mgr4 = new TerminalManager(store, tmux);
  await mgr4.openEntry(entryB);
  await sleep(2500);
  chk('B 的会话已建立', await tmux.hasSession(S(ID_B)));
  chk('A 的会话仍在（未被 B 影响）', await tmux.hasSession(S(ID_A)));
  chk('B 执行了自己的命令', calls.literals.some((l) => l.name === S(ID_B)),
    JSON.stringify(calls.literals));
  chk('B 的创建没有把命令送进 A 会话', !calls.literals.some((l) => l.name === S(ID_A)),
    JSON.stringify(calls.literals));

  console.log('\n=== 5. 杀会话编排：detach→kill→dispose→Map 清理 ===');
  {
    const entryKill = { id: ID_KILL, name: 'KILL', cwd: '/tmp', profile: 'ccr', autoRestore: true, order: 0 };
    const s = S(ID_KILL);

    calls.terminals.length = 0;
    await tmux.newSession(s, '/tmp');   // 先建真会话，openEntry 只 attach、不派发命令
    await mgr.openEntry(entryKill);      // 把面板塞进 mgr 的内部 Map
    const killTerm = calls.terminals[calls.terminals.length - 1];
    chk('openEntry 建出了代表该会话的终端', !!killTerm && killTerm.name === 'KILL');

    // 记录 detach/kill 的真实调用顺序：先 push 名字，再委派给真实现。
    // 这是「先摘客户端再杀」的关键判别断言——颠倒或漏掉 detach 都会失败。
    const order = [];
    const origDetach = tmux.detachClients.bind(tmux);
    const origKill = tmux.killSession.bind(tmux);
    tmux.detachClients = async (name) => { order.push('detachClients'); return origDetach(name); };
    tmux.killSession = async (name) => { order.push('killSession'); return origKill(name); };

    modalAnswer = '杀掉';
    await mgr.killSession(entryKill);
    modalAnswer = undefined;

    chk('顺序为 detach→kill（不可颠倒）',
      JSON.stringify(order) === JSON.stringify(['detachClients', 'killSession']),
      `实际顺序 ${JSON.stringify(order)}`);
    chk('会话确实已被杀掉', (await tmux.hasSession(s)) === false);
    chk('代表该会话的终端被 dispose', killTerm.disposed === 1, `实际 dispose ${killTerm.disposed} 次`);

    // 行为式断言 Map 已清理：再点一次应新建终端，而不是复用旧 Map 里的面板。
    calls.terminals.length = 0;
    await mgr.openEntry(entryKill);
    chk('Map 已清理：再次 openEntry 新建了终端', calls.terminals.length === 1,
      `实际新终端数 ${calls.terminals.length}`);
  }

  console.log('\n=== 6. 陈旧面板不得被当成「已恢复」（2026-09-10 订正） ===');
  {
    // 旧实现：Map 空、但 window.terminals 里有同名面板 → 直接 show() 并
    // return。它既不验证会话是否还在，也不验证有没有客户端附着。真实后果
    // 就是用户描述的「批量恢复没用，只能恢复到 cd 那一层，不会调用 claude」：
    // 面板当初是以 {cwd} 建的，tmux 客户端一退出就退回该目录下的裸 shell。
    // 下面四种组合逐一钉死新行为。
    const staleIds = ['e2estale01', 'e2estale02', 'e2estale03', 'e2estale04'];
    await killAll(staleIds);   // 上一次跑残留的，先清

    const mkEntry = (id, name) => ({ id, name, cwd: '/tmp', profile: 'ccr', autoRestore: true, order: 0 });

    // ---- 6a. 会话已死 + 同名陈旧面板（旧实现：完全 no-op）----
    {
      const entry = mkEntry(staleIds[0], 'STALEDEAD');
      const mgrStale = new TerminalManager(store, tmux);
      calls.terminals.length = 0;
      calls.literals.length = 0;
      calls.newSessions.length = 0;

      const stale = makeSurvivor('STALEDEAD');   // 无 shellIntegration → 判不出空闲
      vscodeStub.window.terminals.push(stale);

      await mgrStale.openEntry(entry);
      await sleep(1200);

      chk('6a 会话已死 + 陈旧面板：会话被重新建出来',
        await tmux.hasSession(S(staleIds[0])), '旧实现完全 no-op，什么都不做');
      const fresh = calls.terminals[calls.terminals.length - 1];
      chk('6a ★ 确实发了 tmux attach（不再停在 cd 那一层的裸 shell）', attachedTo(fresh),
        JSON.stringify(calls.terminals.map((t) => t.sent)));
      chk('6a 未把 attach 打进状态不明的陈旧面板（安全闸门）', stale.sent.length === 0,
        JSON.stringify(stale.sent));

      vscodeStub.window.terminals.length = 0;
    }

    // ---- 6b. 会话存活但 0 附着 + 同名陈旧面板（旧实现：只 show）----
    {
      const entry = mkEntry(staleIds[1], 'STALEALIVE');
      await tmux.newSession(S(staleIds[1]), '/tmp');   // 存活，但没有任何客户端附着
      const mgrStale = new TerminalManager(store, tmux);
      calls.terminals.length = 0;
      calls.literals.length = 0;
      calls.newSessions.length = 0;

      const stale = makeSurvivor('STALEALIVE');
      vscodeStub.window.terminals.push(stale);

      await mgrStale.openEntry(entry);
      await sleep(1200);

      chk('6b 会话仍存在（未误重建）', await tmux.hasSession(S(staleIds[1])));
      chk('6b 未新建 tmux 会话', calls.newSessions.length === 0, JSON.stringify(calls.newSessions));
      chk('6b ★ 0 附着 → 必须 attach（旧实现只 show()，claude 在后台跑着却看不见）',
        calls.terminals.some(attachedTo), JSON.stringify(calls.terminals.map((t) => t.sent)));
      chk('6b 未把 attach 打进状态不明的陈旧面板', stale.sent.length === 0, JSON.stringify(stale.sent));

      vscodeStub.window.terminals.length = 0;
    }

    // ---- 6c. 会话存活 + 0 附着 + 可证明空闲的同名面板 → 复用该面板 ----
    {
      const entry = mkEntry(staleIds[2], 'STALEIDLE');
      await tmux.newSession(S(staleIds[2]), '/tmp');
      const mgrStale = new TerminalManager(store, tmux);
      calls.terminals.length = 0;

      // shellIntegration 在场 + 没有命令在跑 = 已证明空闲停在提示符上
      const idleSurvivor = makeSurvivor('STALEIDLE', { shellIntegration: {} });
      vscodeStub.window.terminals.push(idleSurvivor);

      await mgrStale.openEntry(entry);
      await sleep(1200);

      chk('6c ★ 证明空闲的面板被复用（不再多开一个）', calls.terminals.length === 0,
        `实际新终端数 ${calls.terminals.length}`);
      chk('6c 向复用的面板发了 tmux attach', attachedTo(idleSurvivor),
        JSON.stringify(idleSurvivor.sent));
      chk('6c 对复用的面板执行了 show()', idleSurvivor.shown === 1,
        `实际 show ${idleSurvivor.shown} 次`);

      vscodeStub.window.terminals.length = 0;
    }

    // ---- 6d. 面板里正在跑命令（shell integration 报忙）→ 绝不往里打字 ----
    {
      const entry = mkEntry(staleIds[3], 'BUSYPANEL');
      await tmux.newSession(S(staleIds[3]), '/tmp');
      const mgrStale = new TerminalManager(store, tmux);
      calls.terminals.length = 0;

      const busySurvivor = makeSurvivor('BUSYPANEL', { shellIntegration: {} });
      vscodeStub.window.terminals.push(busySurvivor);
      // 模拟用户在面板里跑着编译：shell integration 报「命令开始」
      shellExecutionStart.fire({ terminal: busySurvivor });

      await mgrStale.openEntry(entry);
      await sleep(1200);

      chk('6d ★ 面板里有命令在跑 → 不往里打字（宁可多开一个面板）',
        busySurvivor.sent.length === 0,
        '把 tmux attach 塞进了用户正在跑的进程 stdin！' + JSON.stringify(busySurvivor.sent));
      chk('6d 改为新建面板并 attach', calls.terminals.length === 1 && attachedTo(calls.terminals[0]),
        `新终端 ${calls.terminals.length} 个，sent=${JSON.stringify(calls.terminals.map((t) => t.sent))}`);

      shellExecutionEnd.fire({ terminal: busySurvivor });   // 收尾，别把忙态留给后面
      vscodeStub.window.terminals.length = 0;
    }

    await killAll(staleIds);
  }

  console.log('\n=== 7. applyModel 拒绝路径：前台不是 claude → 不发序列、不改配置 ===');
  {
    const s = S(ID_REFUSE);
    const { EntryStore } = require(path.join(ROOT, 'out/src/core/store.js'));
    const refuseFile = `/tmp/vscode-tmux-terminals-e2e-refuse-${process.pid}.json`;
    await fs.promises.rm(refuseFile, { force: true }).catch(() => {});
    const refuseStore = new EntryStore(refuseFile);
    await refuseStore.append({ id: ID_REFUSE, name: 'REFUSE', cwd: '/tmp', profile: 'ccr', autoRestore: true });
    const entryRefuse = (await refuseStore.load()).find((e) => e.id === ID_REFUSE);

    // 前台进程是 sleep（非 claude），模拟用户正在跑的非 claude 程序。
    // 此时发 /model 会把字符打进 sleep 的 stdin —— 必须被守卫拦下。
    await run('tmux', ['new-session', '-d', '-s', s, 'sleep 600']);

    calls.literals.length = 0;
    calls.errors.length = 0;

    const mgrRefuse = new TerminalManager(refuseStore, tmux);
    await mgrRefuse.applyModel(entryRefuse, 'some-model');

    const after = (await refuseStore.load()).find((e) => e.id === ID_REFUSE);
    chk('★ 拒绝时未发送任何控制序列（/model 未打进 sleep 进程）',
      calls.literals.length === 0,
      JSON.stringify(calls.literals));
    chk('★ 拒绝时未写配置（model 保持未设）',
      after.model === undefined,
      `实际 model=${JSON.stringify(after.model)}`);
    chk('拒绝已向用户呈现（error message 记录）',
      calls.errors.some((m) => String(m).includes('不是 claude')),
      JSON.stringify(calls.errors));

    await fs.promises.rm(refuseFile, { force: true }).catch(() => {});
  }

  console.log('\n=== 8. 清理 ===');
  await detachRealClient();          // 摘掉 3 节借来造附着客户端的 helper 会话
  await killAll(ALL);
  const left = (await tmux.listSessions()).filter((s) => s.startsWith('tmuxterm-e2e'));
  chk('无残留测试会话', left.length === 0, left.join(', '));

  console.log(`\n${fail === 0 ? '端到端全部通过 ✓' : `${fail} 项失败`}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('harness 异常:', e);
  process.exit(1);
});
