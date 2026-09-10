/**
 * 端到端驱动脚本（非 mocha 测试，手动跑）。
 *
 * 目的：VS Code 接线层一直被认为是「只能手动冒烟」，但那只是因为
 * `vscode` 模块需要运行时注入。这里用一个 stub 顶上，把真正的
 * TerminalManager.openEntry 对着**真 tmux** 驱动起来，从而自动验证
 * 几条最核心的不变量：
 *
 *   1. 会话不存在 → 新建，并发送与该条目**绑定**的那条对话的启动命令
 *   2. 会话已存在且 claude 还在跑 → 只接回，**绝不发送任何命令**
 *   3. 会话已死 / claude 已退出 → 接回**它自己那条**对话（--resume），
 *      绝不新开一条把它顶掉
 *   4. 陈旧面板不得被当成「已恢复」；状态不明的面板绝不往里打字
 *   5. 前缀相近的会话互不干扰
 *
 * 隔离：**用假的 HOME**（/tmp/tmuxterm-e2e-home）驱动对话枚举，因此
 * 全程不读也不写用户真实的 ~/.claude。会话只用 `tmuxterm-e2e*` 前缀，
 * 跑完必清，绝不碰用户已有的会话。
 *
 * 用法：node test/e2e-harness.js
 */
'use strict';

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

// ---- 1. 注入 vscode stub ----
const calls = {
  terminals: [], messages: [], warns: [], errors: [], literals: [], newSessions: [], quickPicks: [],
};

// 让某一节可以控制下一个 modal / QuickPick 弹窗的应答；
// 两者默认都是 undefined（= 用户取消）。
let modalAnswer;
let quickPickAnswer;

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
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class ThemeColor { constructor(id) { this.id = id; } }
class MarkdownString { constructor(v) { this.value = v; } }

// shell integration 的「有命令开始/结束」事件。真实 VS Code（1.93+，本机
// 已开启 shell integration）靠它回答「某个面板里在跑什么」——这是
// TerminalManager 判断「能否安全复用这个面板」的唯一依据，必须能驱动。
const shellExecutionStart = new EventEmitter();
const shellExecutionEnd = new EventEmitter();

const vscodeStub = {
  TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter,
  ThemeIcon,
  ThemeColor,
  MarkdownString,
  window: {
    // openEntry 的候选面板守卫会读 window.terminals。它是可变数组：
    // 某一节可往里塞「陈旧面板」再清空（见第 10 节）。默认空。
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
    showQuickPick(items, opts) {
      calls.quickPicks.push({ items, opts });
      return Promise.resolve(
        typeof quickPickAnswer === 'function' ? quickPickAnswer(items, opts) : quickPickAnswer,
      );
    },
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
const { TmuxClient } = require(path.join(ROOT, 'out/src/tmuxClient.js'));
const { listConversations } = require(path.join(ROOT, 'out/src/conversationFiles.js'));
const { candidatesForCwd } = require(path.join(ROOT, 'out/src/core/conversation.js'));

// ---- 3. 断言辅助 ----
let fail = 0;
const chk = (label, ok, extra) => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `\n    ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (id) => `tmuxterm-${id}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 假的 HOME。对话枚举读 `$HOME/.claude/projects/**`，用假 HOME 才能做到
 * 「测试完全不碰用户真实的会话文件」—— 实测用户那儿有 292 个会话、404 MB。
 */
const HOME = '/tmp/tmuxterm-e2e-home';
/** 干净 cwd：没有任何历史对话 —— 用来验证「无候选 → 开新对话并绑定」。 */
const SCRATCH = '/tmp/tmuxterm-e2e-cwd';
/** 有历史对话的 cwd —— 用来验证老条目的「选择要接回的对话」。 */
const CONV_CWD = '/tmp/tmuxterm-e2e-convcwd';
const EXISTING_CONV = '11111111-2222-3333-4444-555555555555';
const PICKED_CONV = '99999999-8888-7777-6666-555555555555';

/** 名为 claude 的假进程：pane 前台进程名就是 claude（cp 二进制，comm=文件名）。 */
const BIN_DIR = '/tmp/tmuxterm-e2e-bin';
const FAKE_CLAUDE = path.join(BIN_DIR, 'claude');
/** 收到一行输入就退出的假 claude —— 用来驱动「切 profile 会重启 claude」。 */
const FAKE_CLAUDE_EXITING = path.join(BIN_DIR, 'claude-once');

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

/**
 * 建一个 pane 前台是「claude」的会话（模拟 claude 还在跑）。
 *
 * **必须先起 shell、再在 shell 里敲 claude。** 不能把 claude 直接当成
 * session 的启动命令：那样 claude 一退出，整个 tmux 会话就跟着没了 ——
 * 而真实情况是 claude 退出后回到 shell，那正是「接回对话」要处理的场景。
 */
async function newSessionWithClaude(id, binary, args) {
  const target = `=${S(id)}:`;
  await run('tmux', ['new-session', '-d', '-s', S(id), '-c', SCRATCH]);
  await sleep(500);
  await run('tmux', ['send-keys', '-l', '-t', target, `${binary} ${args}`]);
  await run('tmux', ['send-keys', '-t', target, 'Enter']);
  await sleep(700);
}

/** 造一个「历史对话」文件，让某个 cwd 下出现候选。 */
async function writeConversation(projectDir, uuid, cwd, summary) {
  const dir = path.join(HOME, '.claude', 'projects', projectDir);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, `${uuid}.jsonl`),
    [
      JSON.stringify({ type: 'mode', sessionId: uuid }),
      JSON.stringify({ type: 'attachment', cwd }),
      JSON.stringify({
        type: 'user', userType: 'external', isSidechain: false, cwd,
        message: { role: 'user', content: summary },
      }),
    ].join('\n'),
    'utf8',
  );
}

(async () => {
  const ID_NEW = 'e2enew0001';       // 无绑定 + 无候选 → --session-id 新建并绑定
  const ID_RESUME = 'e2eresume01';   // 存活（claude 已退出）+ 已绑定 → --resume
  const ID_ALIVE = 'e2ealive001';    // 存活 + claude 在跑 → 只 attach
  const ID_SHELL = 'e2eshell001';    // 存活 + claude 已退出 → --resume
  const ID_LEGACY = 'e2elegacy01';   // 老条目无绑定 + 有候选 → 询问
  const ID_LEGACY2 = 'e2elegacy02';  // 同上，但用户取消 → --continue
  const ID_KILL = 'e2ekill0001';
  const ID_REFUSE = 'e2erefus01';
  const ID_B = 'e2e0000ab';          // 与 ID_PREFIX 互为前缀，验证互不干扰
  const ID_PREFIX = 'e2e0000a';
  const ALL = [ID_NEW, ID_RESUME, ID_ALIVE, ID_SHELL, ID_LEGACY, ID_LEGACY2,
    ID_KILL, ID_REFUSE, ID_B, ID_PREFIX];

  // 清场：上一次跑残留的会话、假 HOME、假 claude、scratch 目录
  await killAll(ALL);
  await detachRealClient();
  await fs.promises.rm(HOME, { recursive: true, force: true });
  await fs.promises.rm(BIN_DIR, { recursive: true, force: true });
  for (const d of [SCRATCH, CONV_CWD]) {
    await fs.promises.rm(d, { recursive: true, force: true });
    await fs.promises.mkdir(d, { recursive: true });
  }
  await fs.promises.mkdir(BIN_DIR, { recursive: true });
  // 用 cp 出来的二进制当假 claude：comm 就是文件名，pane 前台进程名即 claude
  await fs.promises.copyFile('/bin/sleep', FAKE_CLAUDE);
  await fs.promises.copyFile('/bin/head', FAKE_CLAUDE_EXITING);
  await fs.promises.chmod(FAKE_CLAUDE, 0o755);
  await fs.promises.chmod(FAKE_CLAUDE_EXITING, 0o755);

  // 老条目要挑的那两条历史对话
  await writeConversation('-tmp-tmuxterm-e2e-convcwd', PICKED_CONV, CONV_CWD, '把那个 bug 修了');
  await writeConversation('-tmp-tmuxterm-e2e-convcwd', EXISTING_CONV, CONV_CWD, '另一个终端的历史');

  const store = {
    entries: [],
    async load() { return this.entries.map((e) => ({ ...e })); },
    async save(e) { this.entries = e.map((x) => ({ ...x })); },
    async append(e) { this.entries.push({ ...e, order: this.entries.length }); },
    async update(id, patch) {
      const i = this.entries.findIndex((e) => e.id === id);
      if (i >= 0) this.entries[i] = { ...this.entries[i], ...patch };
    },
    async remove() {}, async findByName() {}, async reorder() {},
  };
  const fresh = (id) => store.entries.find((e) => e.id === id);
  const bound = (id) => fresh(id) && fresh(id).conversationId;
  const literalsTo = (session) =>
    calls.literals.filter((l) => l.name === session).map((l) => l.text);
  const resetCalls = () => {
    calls.terminals.length = 0; calls.literals.length = 0;
    calls.newSessions.length = 0; calls.quickPicks.length = 0;
  };

  const mk = (id, name, cwd, extra) => ({
    id, name, cwd, profile: 'ccr', autoRestore: true, order: 0, ...extra,
  });
  store.entries = [
    mk(ID_NEW, 'NEW', SCRATCH),
    mk(ID_RESUME, 'RESUME', SCRATCH),
    mk(ID_ALIVE, 'ALIVE', SCRATCH),
    mk(ID_SHELL, 'SHELL', SCRATCH),
    mk(ID_LEGACY, 'LEGACY', CONV_CWD),
    mk(ID_LEGACY2, 'LEGACY2', CONV_CWD),
    mk(ID_KILL, 'KILL', SCRATCH),
    mk(ID_B, 'B', SCRATCH),
    mk(ID_PREFIX, 'A', SCRATCH),
  ];

  const tmux = new TmuxClient('tmux');
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

  /** 每个用例用全新的 manager（内部 Map 空），并把 HOME 指向假目录。 */
  const newManager = () => {
    const m = new TerminalManager(store, tmux);
    m.home = () => HOME;   // 隔离：对话枚举只读假 HOME
    return m;
  };

  console.log('=== 0. 对话枚举确实能读出用户真实的会话（只读，不写） ===');
  {
    const all = await listConversations(os.homedir());
    chk('读到了用户真实的会话文件', all.length > 0, `实际 ${all.length} 条`);
    chk('cwd 取自文件内字段（能按 cwd 精确筛出候选）',
      all.some((c) => candidatesForCwd([c], c.cwd).length === 1));
  }

  console.log('\n=== 1. 会话不存在 + 未绑定 → --session-id 新建并永久绑定 ===');
  {
    resetCalls();
    const mgr = newManager();
    await mgr.openEntry(fresh(ID_NEW));
    await sleep(2500);

    const t1 = calls.terminals[calls.terminals.length - 1];
    chk('创建了终端并 attach', attachedTo(t1));
    chk('会话已建立', await tmux.hasSession(S(ID_NEW)));
    const sent = literalsTo(S(ID_NEW));
    chk('发了一条 --session-id 启动命令',
      sent.length === 1 && sent[0].includes('--session-id'), JSON.stringify(sent));
    chk('★ 没有用裸 claude 开新对话顶掉什么（显式指定了 id）',
      !/--resume|--continue/.test(sent[0] || ''), JSON.stringify(sent));
    chk('★ uuid 落到了条目上（从此条目 ↔ 对话永久绑定）', UUID_RE.test(bound(ID_NEW) || ''),
      `实际 ${JSON.stringify(bound(ID_NEW))}`);
    chk('发的 id 就是落盘的那个', (sent[0] || '').includes(bound(ID_NEW)));
  }

  console.log('\n=== 2. 会话已死 + 已绑定 → --resume 接回它自己那条对话（核心） ===');
  {
    const boundId = bound(ID_NEW);
    await run('tmux', ['kill-session', '-t', `=${S(ID_NEW)}`]);   // 模拟会话消失
    resetCalls();
    const mgr = newManager();
    await mgr.openEntry(fresh(ID_NEW));
    await sleep(2500);

    chk('会话被重建', await tmux.hasSession(S(ID_NEW)));
    const sent = literalsTo(S(ID_NEW));
    chk('★ 发的是 --resume 且用的就是绑定的那个 id',
      sent.some((t) => t.includes(`--resume '${boundId}'`)), JSON.stringify(sent));
    chk('★ 绝不重开一条新对话顶替它（没有 --session-id）',
      !sent.some((t) => t.includes('--session-id')), JSON.stringify(sent));
    chk('会话原本已死 → 新建了 tmux 会话', calls.newSessions.length === 1);
  }

  console.log('\n=== 3. 会话存活且 claude 还在跑 → 只 attach，绝不发送（铁律） ===');
  {
    await newSessionWithClaude(ID_ALIVE, FAKE_CLAUDE, 300);
    const front = await tmux.currentCommand(S(ID_ALIVE));
    chk('前置条件：pane 前台就是 claude', front === 'claude', `实际 ${front}`);

    resetCalls();
    const mgr = newManager();
    await mgr.openEntry({ ...fresh(ID_ALIVE), conversationId: EXISTING_CONV });
    await sleep(1200);

    chk('接回了已有会话', calls.terminals.some(attachedTo));
    chk('★ claude 在跑时未发送任何命令（对话原样在跑，绝不能打扰）',
      calls.literals.length === 0,
      '命令污染了用户正在运行的进程 stdin！' + JSON.stringify(calls.literals));
    chk('未重建会话', calls.newSessions.length === 0);
  }

  console.log('\n=== 4. 会话存活但 claude 已退出（pane 回到 shell）→ 接回它自己的对话 ===');
  {
    await tmux.newSession(S(ID_SHELL), SCRATCH);   // pane 就是登录 shell
    chk('前置条件：pane 前台是登录 shell', (await tmux.currentCommand(S(ID_SHELL))) === 'bash');

    resetCalls();
    const mgr = newManager();
    await mgr.openEntry({ ...fresh(ID_SHELL), conversationId: EXISTING_CONV });
    await sleep(1500);

    const sent = literalsTo(S(ID_SHELL));
    chk('★ claude 已退出 → 发 --resume 接回它自己的对话',
      sent.some((t) => t.includes(`--resume '${EXISTING_CONV}'`)), JSON.stringify(sent));
    chk('会话没被重建（原本就活着）', calls.newSessions.length === 0);
    chk('仍然 attach 了面板', calls.terminals.some(attachedTo));
  }

  console.log('\n=== 5. 老条目（无绑定）+ 有历史对话 → 问用户挑一次，挑中即永久绑定 ===');
  {
    resetCalls();
    quickPickAnswer = (items) => items.find((i) => i.candidate.id === PICKED_CONV);
    const mgr = newManager();
    await mgr.openEntry(fresh(ID_LEGACY));
    await sleep(2500);
    quickPickAnswer = undefined;

    chk('弹了选择框', calls.quickPicks.length === 1, `实际 ${calls.quickPicks.length} 次`);
    const items = (calls.quickPicks[0] || {}).items || [];
    chk('候选只含该 cwd 的对话（2 条）', items.length === 2, `实际 ${items.length}`);
    chk('每项显示 时间 · 摘要 · 体积',
      items.every((i) => /·/.test(i.label) && /KB|MB|B/.test(i.label)),
      JSON.stringify(items.map((i) => i.label)));
    chk('★ 选中的对话被永久绑定到条目', bound(ID_LEGACY) === PICKED_CONV,
      `实际 ${JSON.stringify(bound(ID_LEGACY))}`);
    chk('★ 用 --resume 接回选中的那条（不是新开）',
      literalsTo(S(ID_LEGACY)).some((t) => t.includes(`--resume '${PICKED_CONV}'`)),
      JSON.stringify(literalsTo(S(ID_LEGACY))));
  }

  console.log('\n=== 6. 老条目 + 用户取消选择 → 退回 --continue，且不绑定（下次还会问） ===');
  {
    resetCalls();
    quickPickAnswer = undefined;   // 取消
    const mgr = newManager();
    await mgr.openEntry(fresh(ID_LEGACY2));
    await sleep(2500);

    chk('未绑定（绝不替用户猜一条）', bound(ID_LEGACY2) === undefined,
      `实际 ${JSON.stringify(bound(ID_LEGACY2))}`);
    const sent = literalsTo(S(ID_LEGACY2));
    chk('退回 --continue', sent.some((t) => t.includes('--continue')), JSON.stringify(sent));
    chk('没有开一条新对话顶掉（没有 --session-id）',
      !sent.some((t) => t.includes('--session-id')), JSON.stringify(sent));
  }

  console.log('\n=== 7. 切 profile 重启 claude：有绑定必须 --resume（不能一律 --continue） ===');
  {
    // 假 claude 收到一行输入就退出 → 模拟 /exit 后回到 shell，让 restartClaude 走完
    await newSessionWithClaude(ID_RESUME, FAKE_CLAUDE_EXITING, '-n 1');
    const front = await tmux.currentCommand(S(ID_RESUME));
    chk('前置条件：pane 前台是 claude', front.startsWith('claude'), `实际 ${front}`);

    resetCalls();
    const mgr = newManager();
    await mgr.applyProfile({ ...fresh(ID_RESUME), conversationId: EXISTING_CONV }, 'direct');
    await sleep(1500);

    const sent = literalsTo(S(ID_RESUME));
    chk('★ 重启时用 --resume 接回绑定对话',
      sent.some((t) => t.includes(`--resume '${EXISTING_CONV}'`)), JSON.stringify(sent));
    chk('★ 而不是 --continue（共用 cwd 的条目会全部接到同一条对话上去）',
      !sent.some((t) => t.includes('--continue')), JSON.stringify(sent));
    chk('profile 已落盘为 direct', fresh(ID_RESUME).profile === 'direct');
  }

  console.log('\n=== 8. 前缀相近的会话互不干扰 ===');
  {
    // A 的会话名是 B 的前缀，先让 A 存在，再看 B 的整套动作会不会碰到 A
    await tmux.newSession(S(ID_PREFIX), SCRATCH);
    resetCalls();
    const mgr = newManager();
    await mgr.openEntry(fresh(ID_B));
    await sleep(2500);
    chk('B 的会话已建立', await tmux.hasSession(S(ID_B)));
    chk('B 执行了自己的启动命令', literalsTo(S(ID_B)).length === 1, JSON.stringify(calls.literals));
    chk('A 的会话未被 B 影响', await tmux.hasSession(S(ID_PREFIX)));
    chk('B 的启动没有把命令送进 A 会话', literalsTo(S(ID_PREFIX)).length === 0,
      JSON.stringify(calls.literals));
  }

  console.log('\n=== 9. 杀会话编排：detach→kill→dispose→Map 清理 ===');
  {
    const s = S(ID_KILL);
    resetCalls();
    await tmux.newSession(s, SCRATCH);   // 先建真会话
    const mgr = newManager();
    await mgr.openEntry(fresh(ID_KILL));
    await sleep(1500);
    const killTerm = calls.terminals[calls.terminals.length - 1];
    chk('openEntry 建出了代表该会话的终端', !!killTerm && killTerm.name === 'KILL');

    const order = [];
    const origDetach = tmux.detachClients.bind(tmux);
    const origKill = tmux.killSession.bind(tmux);
    tmux.detachClients = async (name) => { order.push('detachClients'); return origDetach(name); };
    tmux.killSession = async (name) => { order.push('killSession'); return origKill(name); };

    modalAnswer = '杀掉';
    await mgr.killSession(fresh(ID_KILL));
    modalAnswer = undefined;

    chk('顺序为 detach→kill（不可颠倒）',
      JSON.stringify(order) === JSON.stringify(['detachClients', 'killSession']),
      `实际顺序 ${JSON.stringify(order)}`);
    chk('会话确实已被杀掉', (await tmux.hasSession(s)) === false);
    chk('代表该会话的终端被 dispose', killTerm.disposed === 1, `实际 dispose ${killTerm.disposed} 次`);

    // 行为式断言 Map 已清理：再点一次应新建终端，而不是复用旧 Map 里的面板。
    resetCalls();
    await mgr.openEntry(fresh(ID_KILL));
    await sleep(1500);
    chk('Map 已清理：再次 openEntry 新建了终端', calls.terminals.length === 1,
      `实际新终端数 ${calls.terminals.length}`);
  }

  console.log('\n=== 10. 陈旧面板不得被当成「已恢复」（2026-09-10 订正） ===');
  {
    // 旧实现：Map 空、但 window.terminals 里有同名面板 → 直接 show() 并
    // return。它既不验证会话是否还在，也不验证有没有客户端附着。
    const staleIds = ['e2estale01', 'e2estale02', 'e2estale03', 'e2estale04'];
    await killAll(staleIds);
    for (const id of staleIds) store.entries.push(mk(id, `STALE${id.slice(-2)}`, SCRATCH));
    const nm = (i) => `STALE${staleIds[i].slice(-2)}`;

    // ---- 10a. 会话已死 + 同名陈旧面板（旧实现：完全 no-op）----
    {
      resetCalls();
      const mgr = newManager();
      const stale = makeSurvivor(nm(0));   // 无 shellIntegration → 判不出空闲
      vscodeStub.window.terminals.push(stale);

      await mgr.openEntry(fresh(staleIds[0]));
      await sleep(2500);

      chk('10a 会话已死 + 陈旧面板：会话被重新建出来',
        await tmux.hasSession(S(staleIds[0])), '旧实现完全 no-op，什么都不做');
      chk('10a ★ 确实发了启动命令（不再停在 cd 那一层的裸 shell）',
        literalsTo(S(staleIds[0])).length === 1, JSON.stringify(calls.literals));
      chk('10a 未把 attach 打进状态不明的陈旧面板（安全闸门）', stale.sent.length === 0,
        JSON.stringify(stale.sent));
      vscodeStub.window.terminals.length = 0;
    }

    // ---- 10b. 会话存活但 0 附着 + 陈旧面板（旧实现：只 show）----
    {
      await tmux.newSession(S(staleIds[1]), SCRATCH);
      resetCalls();
      const mgr = newManager();
      const stale = makeSurvivor(nm(1));
      vscodeStub.window.terminals.push(stale);

      await mgr.openEntry({ ...fresh(staleIds[1]), conversationId: EXISTING_CONV });
      await sleep(1500);

      chk('10b 会话仍存在（未误重建）', await tmux.hasSession(S(staleIds[1])));
      chk('10b 未新建 tmux 会话', calls.newSessions.length === 0, JSON.stringify(calls.newSessions));
      chk('10b ★ 0 附着 → 必须 attach（旧实现只 show()，claude 在后台跑着却看不见）',
        calls.terminals.some(attachedTo), JSON.stringify(calls.terminals.map((t) => t.sent)));
      chk('10b 未把 attach 打进状态不明的陈旧面板', stale.sent.length === 0, JSON.stringify(stale.sent));
      vscodeStub.window.terminals.length = 0;
    }

    // ---- 10c. 存活 + 0 附着 + 可证明空闲的同名面板 → 复用该面板 ----
    {
      await tmux.newSession(S(staleIds[2]), SCRATCH);
      resetCalls();
      const mgr = newManager();
      const idleSurvivor = makeSurvivor(nm(2), { shellIntegration: {} });
      vscodeStub.window.terminals.push(idleSurvivor);

      await mgr.openEntry({ ...fresh(staleIds[2]), conversationId: EXISTING_CONV });
      await sleep(1500);

      chk('10c ★ 证明空闲的面板被复用（不再多开一个）', calls.terminals.length === 0,
        `实际新终端数 ${calls.terminals.length}`);
      chk('10c 向复用的面板发了 tmux attach', attachedTo(idleSurvivor),
        JSON.stringify(idleSurvivor.sent));
      chk('10c 对复用的面板执行了 show()', idleSurvivor.shown === 1,
        `实际 show ${idleSurvivor.shown} 次`);
      vscodeStub.window.terminals.length = 0;
    }

    // ---- 10d. 面板里正在跑命令（shell integration 报忙）→ 绝不往里打字 ----
    {
      await tmux.newSession(S(staleIds[3]), SCRATCH);
      resetCalls();
      const mgr = newManager();
      const busySurvivor = makeSurvivor(nm(3), { shellIntegration: {} });
      vscodeStub.window.terminals.push(busySurvivor);
      shellExecutionStart.fire({ terminal: busySurvivor });   // 模拟用户正在跑编译

      await mgr.openEntry({ ...fresh(staleIds[3]), conversationId: EXISTING_CONV });
      await sleep(1500);

      chk('10d ★ 面板里有命令在跑 → 不往里打字（宁可多开一个面板）',
        busySurvivor.sent.length === 0,
        '把 tmux attach 塞进了用户正在跑的进程 stdin！' + JSON.stringify(busySurvivor.sent));
      chk('10d 改为新建面板并 attach',
        calls.terminals.length === 1 && attachedTo(calls.terminals[0]),
        `新终端 ${calls.terminals.length} 个`);

      shellExecutionEnd.fire({ terminal: busySurvivor });
      vscodeStub.window.terminals.length = 0;
    }

    await killAll(staleIds);
  }

  console.log('\n=== 11. applyModel 拒绝路径：前台不是 claude → 不发序列、不改配置 ===');
  {
    const s = S(ID_REFUSE);
    const { EntryStore } = require(path.join(ROOT, 'out/src/core/store.js'));
    const refuseFile = `/tmp/vscode-tmux-terminals-e2e-refuse-${process.pid}.json`;
    await fs.promises.rm(refuseFile, { force: true }).catch(() => {});
    const refuseStore = new EntryStore(refuseFile);
    await refuseStore.append({
      id: ID_REFUSE, name: 'REFUSE', cwd: SCRATCH, profile: 'ccr', autoRestore: true,
    });
    const entryRefuse = (await refuseStore.load()).find((e) => e.id === ID_REFUSE);

    // 前台进程是 sleep（非 claude），模拟用户正在跑的非 claude 程序。
    await run('tmux', ['new-session', '-d', '-s', s, 'sleep 600']);
    resetCalls();

    const mgr = new TerminalManager(refuseStore, tmux);
    mgr.home = () => HOME;
    await mgr.applyModel(entryRefuse, 'some-model');

    const after = (await refuseStore.load()).find((e) => e.id === ID_REFUSE);
    chk('★ 拒绝时未发送任何控制序列（/model 未打进 sleep 进程）',
      calls.literals.length === 0, JSON.stringify(calls.literals));
    chk('★ 拒绝时未写配置（model 保持未设）', after.model === undefined,
      `实际 model=${JSON.stringify(after.model)}`);
    chk('拒绝已向用户呈现（error message 记录）',
      calls.errors.some((m) => String(m).includes('不是 claude')), JSON.stringify(calls.errors));

    await fs.promises.rm(refuseFile, { force: true }).catch(() => {});
  }

  console.log('\n=== 12. 清理 ===');
  await detachRealClient();
  await killAll(ALL);
  await killAll(['e2estale01', 'e2estale02', 'e2estale03', 'e2estale04']);
  const left = (await tmux.listSessions()).filter((s) => s.startsWith('tmuxterm-e2e'));
  chk('无残留测试会话', left.length === 0, left.join(', '));
  const fakeHomeBefore = fs.existsSync(HOME);
  await fs.promises.rm(HOME, { recursive: true, force: true });
  await fs.promises.rm(BIN_DIR, { recursive: true, force: true });
  for (const d of [SCRATCH, CONV_CWD]) await fs.promises.rm(d, { recursive: true, force: true });
  chk('假 HOME / 假 claude / scratch 目录已清理',
    fakeHomeBefore && !fs.existsSync(HOME) && !fs.existsSync(BIN_DIR) && !fs.existsSync(SCRATCH));

  console.log(`\n${fail === 0 ? '端到端全部通过 ✓' : `${fail} 项失败`}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('harness 异常:', e);
  process.exit(1);
});
