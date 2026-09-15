/**
 * 端到端驱动脚本（非 mocha 测试，手动跑）。
 *
 * 目的：VS Code 接线层一直被认为是「只能手动冒烟」，但那只是因为
 * `vscode` 模块需要运行时注入。这里用一个 stub 顶上，把真正的
 * TerminalManager.openEntry 对着**真 tmux** 驱动起来，从而自动验证
 * 几条最核心的不变量：
 *
 *   1. 会话不存在 → 新建，并启动与该条目**绑定**的那条对话
 *   2. 会话已存在且 claude 还在跑 → 只接回，**绝不发送任何命令**
 *   3. 已死 / claude 已退出 → 接回**它自己那条**对话（--resume），
 *      绝不新开一条把它顶掉
 *   4. 老条目（无绑定）由用户当场决定；取消 = **什么都不启动**
 *   5. 陈旧面板不得被当成「已恢复」；状态不明的面板绝不往里打字
 *
 * 隔离（两条都不可省）：
 * - **假的 HOME**：对话枚举读 `$HOME/.claude/projects/**`，用假 HOME 才能
 *   不读也不写用户真实的 ~/.claude（实测那儿有 292 个会话、404 MB）。
 * - **假的 claude**：本机 `/usr/bin/claude` 真实存在。测试会话里若让启动
 *   命令找到它，它会真的跑起来并把对话写进用户真实的 ~/.claude/projects。
 *   因此凡是「启动 claude」的命令，发送前先把这个会话的 PATH 指向假桩
 *   （见 sendLiteral 的包装）。末尾还有一条断言：跑完整轮后用户真实的
 *   projects 目录集合必须一字不差。
 *
 * 会话只用 `tmuxterm-e2e*` 前缀，跑完必清，绝不碰用户已有的会话。
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
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
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
class DataTransferItem {
  constructor(value) { this.value = value; }
}
class DataTransfer {
  constructor() { this.map = new Map(); }
  set(mime, item) { this.map.set(mime, item); }
  get(mime) { return this.map.get(mime); }
}

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
  DataTransfer,
  DataTransferItem,
  window: {
    // openEntry 的候选面板守卫会读 window.terminals。它是可变数组：
    // 某一节可往里塞「陈旧面板」再清空（见第 11 节）。默认空。
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
    showWarningMessage(m) {
      calls.warns.push(m);
      // 与 showQuickPick 同样支持「函数式应答」，好让用例模拟「用户在慢慢看」
      return Promise.resolve(typeof modalAnswer === 'function' ? modalAnswer(m) : modalAnswer);
    },
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

/** 假的 HOME：对话枚举只读这里，绝不碰用户真实的 ~/.claude。 */
const HOME = '/tmp/tmuxterm-e2e-home';
/** 干净 cwd：没有任何历史对话。 */
const SCRATCH = '/tmp/tmuxterm-e2e-cwd';
/** 有历史对话的 cwd（老条目挑选用）。 */
const CONV_CWD = '/tmp/tmuxterm-e2e-convcwd';
/** 绑定类用例的 cwd（里面放与条目绑定的那些对话）。 */
const BOUND_CWD = '/tmp/tmuxterm-e2e-bound';

// 与条目绑定的对话 id。CONV_FRESH 那条始终不被创建（测「首次启动」）。
const CONV_FRESH = 'aaaaaaaa-0007-0000-0000-000000000000';
const CONV_DEAD = 'aaaaaaaa-0001-0000-0000-000000000000';
const CONV_SHELL = 'aaaaaaaa-0002-0000-0000-000000000000';
const CONV_ALIVE = 'aaaaaaaa-0003-0000-0000-000000000000';
const CONV_RESTART = 'aaaaaaaa-0004-0000-0000-000000000000';
const CONV_RESTART2 = 'aaaaaaaa-0008-0000-0000-000000000000';
const CONV_FAIL = 'aaaaaaaa-0005-0000-0000-000000000000';
const CONV_STALE = 'aaaaaaaa-0006-0000-0000-000000000000';
const PICKED_CONV = '99999999-8888-7777-6666-555555555555';
/** 并发用例专用：一开始没人绑，让第一个条目绑上、第二个必须看见它。 */
const RACE_CONV = '77777777-6666-5555-4444-333333333333';
const OTHER_CONV = '22222222-3333-4444-5555-666666666666';

/**
 * 假 claude 所在目录。
 * - `BIN_DIR` 里的是**按绝对路径**调用的假进程（cp 二进制，comm 就是文件名），
 *   用来造「pane 前台就是 claude」这种状态。
 * - `BIN_DIR/quiet` 与 `BIN_DIR/fail` 是**按 PATH 解析**的桩：任何「启动
 *   claude」的命令发送前，都会先把会话 PATH 指到其中之一，从而**绝不**
 *   拉起真实的 /usr/bin/claude（它会往用户真实的 ~/.claude 里写对话）。
 */
const BIN_DIR = '/tmp/tmuxterm-e2e-bin';
const FAKE_CLAUDE = path.join(BIN_DIR, 'claude');
const FAKE_CLAUDE_EXITING = path.join(BIN_DIR, 'claude-once');
const QUIET_BIN = path.join(BIN_DIR, 'quiet');
const FAIL_BIN = path.join(BIN_DIR, 'fail');
const FAIL_TEXT = 'No conversation found with session ID: 00000000-0000-0000-0000-000000000000';

/** 当前「启动 claude」命令该把 PATH 指向哪个桩目录（默认安静退出）。 */
let launchBin = QUIET_BIN;

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

/** 造一个「历史对话」文件。 */
async function writeConversation(uuid, cwd, summary, projectDir) {
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

/**
 * 假 claude 的 pid 落盘目录。
 * 每会话一个文件：桩脚本把自己的真实 pid 写进去，harness 读它 ——
 * 那个 pid 就是生产代码将要在 `ps` 里看到的后代 pid。
 */
const PID_DIR = '/tmp/tmuxterm-e2e-pids';
/**
 * 后台假 claude 的**桩脚本**：写 pid 后 exec sleep，作为 pane shell 的真实
 * 后代存活。脚本被 execve 后 tmux 看到的 command 是解释器 `sh`，但这不影响
 * 19a/19c —— 它们只要求「pane 里有这个后代进程」，不要求前台是 claude。
 */
const FIXTURE_BG = path.join(BIN_DIR, 'claude-fixture-bg');
/**
 * 前台假 claude：**真二进制的副本**（`cp /bin/head`），**不是 shebang 脚本**。
 *
 * 必须是真二进制。shebang 脚本被 execve 之后，tmux 的
 * `#{pane_current_command}` 取到的是**解释器**的 basename（本机 /bin/sh →
 * dash → `sh`），于是：
 *   - 19b 的前置断言（`front.startsWith('claude')`）直接红；
 *   - `restartClaude` → `canSendControl`（terminalManager.ts:569-571）→
 *     `isClaudeCommand`（core/claude.ts:14）判否 → `refuse()` 并
 *     `return false`，一条命令都不会发 → 19b 四条断言全红。
 * harness 既有惯例本就是真二进制的副本（`cp /bin/sleep /tmp/…/claude`，
 * `cp /bin/head …/claude-once`，既有断言 `front === 'claude'`），这里沿用。
 *
 * 选 `/bin/head` 而非 `/bin/cat`：19b 要求它在收到 `/exit` 后**退出**，
 * `restartClaude` 的 `waitForShell` 才过得去 —— `/bin/cat` 只在 stdin EOF
 * 时退出，会一直挂着把这条用例卡死。`head -n 1` 读到一行（就是 `/exit`）
 * 即退出，正好是原桩脚本 `read _line; exit 0` 的真二进制等价物。
 *
 * 名字以 `claude` 开头 → `isClaudeCommand` 认它；而它**不会**被 harness 的
 * PATH 桩正则 `/(^|\s|\/)claude(-direct)?(\s|$)/` 命中 —— 该正则要求 `claude`
 * 之后紧跟空白或行尾，而这里跟的是 `-fixture-fg`（已用 `node -e` 对该正则
 * 实测核对：`/tmp/tmuxterm-e2e-bin/claude-fixture-fg /tmp/…` 不匹配），
 * 故调用它不会被换成 PATH 桩，也不会触到真实的 /usr/bin/claude。
 */
const FIXTURE_FG = path.join(BIN_DIR, 'claude-fixture-fg');
/** 兜底 D 的专用 cwd（那里只放一个条目）。 */
const SOLE_CWD = '/tmp/tmuxterm-e2e-sole';

/**
 * 准备两个假 claude（都用**绝对路径**调用：不受 PATH 桩影响，名字以 claude
 * 开头以便 isClaudeCommand 认它）：
 * - `FIXTURE_BG` 是**桩脚本**（写 pid 后 exec sleep）：它自己就能把真实 pid
 *   写进命令行给它的落盘路径，19a/19c 用 `readFakePid` 读。
 * - `FIXTURE_FG` 是**真二进制的副本**（理由见常量注释）：它写不了 pid，19b
 *   的 pid 只能启动后从 pane 反查（`foregroundPid`）。
 */
async function writeFixtures() {
  await fs.promises.mkdir(BIN_DIR, { recursive: true });
  await fs.promises.mkdir(PID_DIR, { recursive: true });
  await fs.promises.writeFile(FIXTURE_BG, '#!/bin/sh\necho $$ > "$1"\nexec sleep 600\n', 'utf8');
  await fs.promises.chmod(FIXTURE_BG, 0o755);
  // 真二进制的副本：execve 之后 basename 即文件名本身 = claude-fixture-fg
  await fs.promises.copyFile('/bin/head', FIXTURE_FG);
  await fs.promises.chmod(FIXTURE_FG, 0o755);
}

/** 等桩脚本把 pid 写进 PID_DIR/<name>，返回它。超时返回 null。 */
async function readFakePid(name) {
  const file = path.join(PID_DIR, name);
  for (let i = 0; i < 40; i++) {
    try {
      const t = (await fs.promises.readFile(file, 'utf8')).trim();
      if (/^\d+$/.test(t)) return Number(t);
    } catch { /* 还没写出来 */ }
    await sleep(100);
  }
  return null;
}

/**
 * 反查 pane 前台那个**真二进制**假 claude（`FIXTURE_FG`）的真实 pid ——
 * 它自己写不了 pid 落盘文件。
 *
 * 路径：`#{pane_pid}`（外层 shell）→ 它的直接子进程即被 shell fork/exec 出来
 * 的假 claude。实测：
 *   `tmux display-message -p -t '=<session>:' '#{pane_pid}'` → shell 的 pid
 *   `pgrep -P <pane_pid>` → 假 claude 的 pid
 *
 * 只在恰好一个子进程时返回它（多个就说明 pane 里不止这一个前台进程，宁可不猜）。
 * 超时 / 查不到返回 null。
 */
async function foregroundPid(id) {
  for (let i = 0; i < 40; i++) {
    try {
      const { stdout } = await run('tmux', [
        'display-message', '-p', '-t', `=${S(id)}:`, '#{pane_pid}',
      ]);
      const panePid = Number(stdout.trim());
      if (Number.isInteger(panePid) && panePid > 0) {
        const kids = (await run('pgrep', ['-P', String(panePid)])).stdout.trim().split(/\s+/);
        const pid = Number(kids[0]);
        if (kids.length === 1 && Number.isInteger(pid) && pid > 0) return pid;
      }
    } catch { /* tmux / pgrep 还没就绪 */ }
    await sleep(100);
  }
  return null;
}

/** 写注册表文件 ~/.claude/sessions/<pid>.json（生产代码唯一的注入点：home）。 */
async function writeSessionRecord(pid, sessionId, cwd, startedAt) {
  const dir = path.join(HOME, '.claude', 'sessions');
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt, status: 'busy', name: 'e2e', nameSource: 'derived' }),
    'utf8',
  );
}

/**
 * 杀掉所有桩进程。
 * 后台任务可能不在 pane 的**前台**进程组里，杀 tmux 会话不保证把它带走。
 */
async function killFakePids() {
  for (const name of await fs.promises.readdir(PID_DIR).catch(() => [])) {
    try {
      const t = (await fs.promises.readFile(path.join(PID_DIR, name), 'utf8')).trim();
      if (/^\d+$/.test(t)) process.kill(Number(t), 'SIGKILL');
    } catch { /* 已经退出了 */ }
  }
}

/**
 * 造一个带 `aiTitle` 的 transcript（可选在 ai-title **之前**塞大量填充行，
 * 用来证明「标题在文件尾部也能读到」）。`aiTitle` 为 undefined 时不写该行。
 */
async function writeTranscript(uuid, cwd, projectDir, aiTitle, paddingLines) {
  const dir = path.join(HOME, '.claude', 'projects', projectDir);
  await fs.promises.mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'mode', sessionId: uuid }),
    JSON.stringify({ type: 'attachment', cwd }),
    JSON.stringify({
      type: 'user', userType: 'external', isSidechain: false, cwd,
      message: { role: 'user', content: '占位摘要' },
    }),
  ];
  for (let i = 0; i < paddingLines; i++) {
    lines.push(JSON.stringify({ type: 'attachment', cwd, attachment: { i, pad: 'x'.repeat(200) } }));
  }
  if (aiTitle !== undefined) {
    lines.push(JSON.stringify({ type: 'ai-title', sessionId: uuid, aiTitle }));
  }
  await fs.promises.writeFile(path.join(dir, `${uuid}.jsonl`), lines.join('\n'), 'utf8');
}

/**
 * 用户真实 ~/.claude/projects 的**文件级**快照（路径 → 体积/mtime）。
 *
 * 只比目录集合是不够的：真 claude 若跑在一个**已存在**的 project 目录下，
 * 只会往里加 `.jsonl` / 改已有文件，目录集合一字不变 —— 那样根本抓不到。
 */
async function projectSnapshot() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const out = new Map();
  for (const dir of await fs.promises.readdir(root).catch(() => [])) {
    const abs = path.join(root, dir);
    for (const f of await fs.promises.readdir(abs).catch(() => [])) {
      try {
        const st = await fs.promises.stat(path.join(abs, f));
        out.set(`${dir}/${f}`, { size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* 读不到就不记 */ }
    }
  }
  return out;
}

(async () => {
  const ID_NEW = 'e2enew0001';         // 老条目（无绑定）+ 无候选 → --session-id 并绑定
  const ID_FRESH = 'e2efresh001';      // 新建条目（已绑定，对话未创建）→ --session-id，且不问
  const ID_DEAD = 'e2edead0001';       // 已死 + 已绑定（对话存在）→ --resume
  const ID_ALIVE = 'e2ealive001';      // 存活 + claude 在跑 → 只 attach
  const ID_SHELL = 'e2eshell001';      // 存活 + claude 已退出 → --resume
  const ID_LEGACY = 'e2elegacy01';     // 老条目 + 有候选 → 选中 → 绑定 + --resume
  const ID_LEGACY_NEW = 'e2elegacyn1'; // 老条目 + 有候选 → 选「＋ 新建一条对话」
  const ID_LEGACY_ESC = 'e2elegacye1'; // 老条目 + 有候选 → Esc → 什么都不启动
  const ID_SHARE = 'e2eshare0001';     // 老条目，选中「已绑给别人」的对话 → 二次确认
  const ID_SHARE2 = 'e2eshare0002';    // 同上，但走显式命令「选择要接回的对话…」
  const ID_TOCTOU = 'e2etoctou001';    // 判据→弹选择框→发送 之间 pane 起了 build
  const ID_RACE_A = 'e2eracea001';     // 并发恢复：两个共用 cwd 的老条目
  const ID_RACE_B = 'e2eraceb001';
  const ID_RACEBRANCH = 'e2eracebrnch'; // 竞态：会话被别的窗口抢先创建
  const ID_RESTART = 'e2erestart1';    // 切 profile：有绑定 → --resume
  const ID_NOBIND = 'e2enobind01';     // 切 profile：无绑定 → 拒绝
  const ID_RESUMEFAIL = 'e2eresfail1'; // --resume 报 No conversation found → 必须看得见
  const ID_CONFLICT = 'e2econflict1';  // 绑定的对话不在本条目 cwd 下 → 拒绝并说明
  const ID_KILL = 'e2ekill0001';
  const ID_REFUSE = 'e2erefus01';
  const ID_B = 'e2e0000ab';            // 与 ID_PREFIX 互为前缀，验证互不干扰
  const ID_PREFIX = 'e2e0000a';
  const STALE_IDS = ['e2estale01', 'e2estale02', 'e2estale03', 'e2estale04'];
  const ALL = [ID_NEW, ID_FRESH, ID_DEAD, ID_ALIVE, ID_SHELL, ID_LEGACY, ID_LEGACY_NEW,
    ID_LEGACY_ESC, ID_SHARE, ID_SHARE2, ID_TOCTOU, ID_RACE_A, ID_RACE_B, ID_RACEBRANCH,
    ID_RESTART, ID_NOBIND, ID_RESUMEFAIL, ID_CONFLICT, ID_KILL, ID_REFUSE, ID_B, ID_PREFIX,
    ...STALE_IDS];

  const projectsBefore = await projectSnapshot();

  // 清场：上一次跑残留的会话、假 HOME、假 claude、scratch 目录
  await killAll(ALL);
  await detachRealClient();
  await fs.promises.rm(HOME, { recursive: true, force: true });
  await fs.promises.rm(BIN_DIR, { recursive: true, force: true });
  for (const d of [SCRATCH, CONV_CWD, BOUND_CWD]) {
    await fs.promises.rm(d, { recursive: true, force: true });
    await fs.promises.mkdir(d, { recursive: true });
  }
  await fs.promises.mkdir(QUIET_BIN, { recursive: true });
  await fs.promises.mkdir(FAIL_BIN, { recursive: true });
  // 按绝对路径调用的假进程：cp 二进制，comm 就是文件名
  await fs.promises.copyFile('/bin/sleep', FAKE_CLAUDE);
  await fs.promises.copyFile('/bin/head', FAKE_CLAUDE_EXITING);
  await fs.promises.chmod(FAKE_CLAUDE, 0o755);
  await fs.promises.chmod(FAKE_CLAUDE_EXITING, 0o755);
  // 按 PATH 解析的桩：claude 与 claude-direct 都要有，否则会落到真实的
  // /usr/local/bin/claude-direct 上去（那会写用户真实的 ~/.claude）
  for (const [dir, body] of [
    [QUIET_BIN, '#!/bin/sh\nexit 0\n'],
    [FAIL_BIN, `#!/bin/sh\necho "${FAIL_TEXT}" 1>&2\nexit 1\n`],
  ]) {
    for (const name of ['claude', 'claude-direct']) {
      const p = path.join(dir, name);
      await fs.promises.writeFile(p, body, 'utf8');
      await fs.promises.chmod(p, 0o755);
    }
  }

  // 与条目绑定的、确实存在的对话
  const PROJECT = '-tmp-tmuxterm-e2e-bound';
  await writeConversation(CONV_DEAD, BOUND_CWD, 'DEAD 这个终端的对话', PROJECT);
  await writeConversation(CONV_SHELL, BOUND_CWD, 'SHELL 这个终端的对话', PROJECT);
  await writeConversation(CONV_ALIVE, BOUND_CWD, 'ALIVE 这个终端的对话', PROJECT);
  await writeConversation(CONV_RESTART, BOUND_CWD, 'RESTART 这个终端的对话', PROJECT);
  await writeConversation(CONV_RESTART2, BOUND_CWD, 'RESTART2 这个终端的对话', PROJECT);
  await writeConversation(CONV_FAIL, BOUND_CWD, '接不回来的对话', PROJECT);
  await writeConversation(CONV_STALE, BOUND_CWD, '陈旧面板用例的对话', PROJECT);
  // 老条目要挑的两条历史对话
  await writeConversation(PICKED_CONV, CONV_CWD, '把那个 bug 修了', '-tmp-tmuxterm-e2e-convcwd');
  await writeConversation(OTHER_CONV, CONV_CWD, '另一个终端的历史', '-tmp-tmuxterm-e2e-convcwd');
  await writeConversation(RACE_CONV, CONV_CWD, '并发用例的对话', '-tmp-tmuxterm-e2e-convcwd');

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
    calls.errors.length = 0; calls.messages.length = 0;
  };

  const mk = (id, name, cwd, extra) => ({
    id, name, cwd, profile: 'ccr', autoRestore: true, order: 0, ...extra,
  });
  store.entries = [
    mk(ID_NEW, 'NEW', SCRATCH),                                   // 老条目：无 conversationId
    mk(ID_FRESH, 'FRESH', BOUND_CWD, { conversationId: CONV_FRESH }),
    mk(ID_DEAD, 'DEAD', BOUND_CWD, { conversationId: CONV_DEAD }),
    mk(ID_ALIVE, 'ALIVE', BOUND_CWD, { conversationId: CONV_ALIVE }),
    mk(ID_SHELL, 'SHELL', BOUND_CWD, { conversationId: CONV_SHELL }),
    mk(ID_LEGACY, 'LEGACY', CONV_CWD),                            // 老条目：无 conversationId
    mk(ID_LEGACY_NEW, 'LEGACYNEW', CONV_CWD),
    mk(ID_LEGACY_ESC, 'LEGACYESC', CONV_CWD),
    mk(ID_SHARE, 'SHARE', CONV_CWD),
    mk(ID_SHARE2, 'SHARE2', CONV_CWD),
    mk(ID_TOCTOU, 'TOCTOU', CONV_CWD),                 // 老条目：无 conversationId
    mk(ID_RACE_A, 'RACEA', CONV_CWD),                  // 老条目：无 conversationId
    mk(ID_RACE_B, 'RACEB', CONV_CWD),
    mk(ID_RACEBRANCH, 'RACEBRANCH', SCRATCH),
    mk(ID_RESTART, 'RESTART', BOUND_CWD, { conversationId: CONV_RESTART }),
    mk(ID_NOBIND, 'NOBIND', BOUND_CWD, { conversationId: CONV_RESTART2 }),
    mk(ID_RESUMEFAIL, 'RESUMEFAIL', BOUND_CWD, { conversationId: CONV_FAIL }),
    // 绑定的对话确实存在，但它的 cwd 是 CONV_CWD，不在本条目的 BOUND_CWD 下
    mk(ID_CONFLICT, 'CONFLICT', BOUND_CWD, { conversationId: OTHER_CONV }),
    mk(ID_KILL, 'KILL', SCRATCH),
    mk(ID_B, 'B', SCRATCH),
    mk(ID_PREFIX, 'A', SCRATCH),
    ...STALE_IDS.map((id, i) => mk(id, `STALE0${i + 1}`, BOUND_CWD, { conversationId: CONV_STALE })),
  ];

  const tmux = new TmuxClient('tmux');
  const origSendLiteral = tmux.sendLiteral.bind(tmux);
  tmux.sendLiteral = async (name, text) => {
    calls.literals.push({ name, text });
    // **绝不让真实 claude 在测试会话里跑起来。** 本机 /usr/bin/claude 真实
    // 存在，而它会把对话写进用户真实的 ~/.claude/projects。凡是启动 claude
    // 的命令，先把该会话的 PATH 指到假桩目录，再原样发送命令本身。
    // 两行先后进入同一个 pty，shell 必然按顺序执行，不存在竞态。
    if (/(^|\s|\/)claude(-direct)?(\s|$)/.test(text)) {
      await origSendLiteral(name, `export PATH=${launchBin}:$PATH`);
      await tmux.sendEnter(name);
    }
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

  /** 让会话的 pane 前台跑起假 claude（用绝对路径，不受 PATH 桩影响）。 */
  const newSessionWithClaude = async (id, binary, args) => {
    await tmux.newSession(S(id), SCRATCH);
    await sleep(500);
    await tmux.sendLiteral(S(id), `${binary} ${args}`);
    await tmux.sendEnter(S(id));
    await sleep(700);
  };

  console.log('=== 0. 前置检查：枚举只读真实数据，且本机确有真实 claude ===');
  {
    const all = await listConversations(os.homedir());
    chk('能读出用户真实的会话文件（只读）', all.length > 0, `实际 ${all.length} 条`);
    chk('cwd 取自文件内字段（能按 cwd 精确筛出候选）',
      all.some((c) => candidatesForCwd([c], c.cwd).length === 1));
    const real = await run('bash', ['-lc', 'command -v claude']).then(
      (r) => r.stdout.trim(), () => '');
    chk('本机 PATH 里确实有真实 claude —— 所以测试必须用 PATH 桩挡住它',
      real.length > 0, real);
  }

  console.log('\n=== 1. 老条目（无绑定）+ 无候选 → --session-id 新建并永久绑定 ===');
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
    chk('★ uuid 落到了条目上（从此条目 ↔ 对话永久绑定）', UUID_RE.test(bound(ID_NEW) || ''),
      `实际 ${JSON.stringify(bound(ID_NEW))}`);
    chk('发的 id 就是落盘的那个', (sent[0] || '').includes(bound(ID_NEW)));
  }

  console.log('\n=== 2. 新建条目（已绑定、对话尚未创建）→ --session-id，且不弹选择框 ===');
  {
    resetCalls();
    const mgr = newManager();
    await mgr.openEntry(fresh(ID_FRESH));
    await sleep(2500);

    chk('★ 全程没弹选择框（新建条目不该被问）', calls.quickPicks.length === 0,
      JSON.stringify(calls.quickPicks.map((q) => q.opts && q.opts.title)));
    const sent = literalsTo(S(ID_FRESH));
    chk('★ 用 --session-id 把绑定的那条建出来（它还不存在，不能用 --resume）',
      sent.length === 1 && sent[0].includes(`--session-id '${CONV_FRESH}'`), JSON.stringify(sent));
    chk('绑定的 id 没有被改掉', bound(ID_FRESH) === CONV_FRESH);
    chk('★ 出声了：提醒这条对话没有记录、本次新开一条（不再静默）',
      calls.messages.some((m) => String(m).includes('还没有记录') && String(m).includes('新开一条')),
      JSON.stringify(calls.messages));
  }

  console.log('\n=== 3. 会话已死 + 已绑定（对话存在）→ --resume 接回它自己那条（核心） ===');
  {
    resetCalls();
    const mgr = newManager();
    await mgr.openEntry(fresh(ID_DEAD));
    await sleep(2500);

    chk('会话被重建', await tmux.hasSession(S(ID_DEAD)));
    const sent = literalsTo(S(ID_DEAD));
    chk('★ 发的是 --resume 且用的就是绑定的那个 id',
      sent.some((t) => t.includes(`--resume '${CONV_DEAD}'`)), JSON.stringify(sent));
    chk('★ 绝不重开一条新对话顶替它（没有 --session-id）',
      !sent.some((t) => t.includes('--session-id')), JSON.stringify(sent));
    chk('会话原本已死 → 新建了 tmux 会话', calls.newSessions.length === 1);
  }

  console.log('\n=== 4. 会话存活且 claude 还在跑 → 只 attach，绝不发送（铁律） ===');
  {
    await newSessionWithClaude(ID_ALIVE, FAKE_CLAUDE, 300);
    const front = await tmux.currentCommand(S(ID_ALIVE));
    chk('前置条件：pane 前台就是 claude', front === 'claude', `实际 ${front}`);

    resetCalls();
    const mgr = newManager();
    await mgr.openEntry(fresh(ID_ALIVE));
    await sleep(1200);

    chk('接回了已有会话', calls.terminals.some(attachedTo));
    chk('★ claude 在跑时未发送任何命令（对话原样在跑，绝不能打扰）',
      calls.literals.length === 0,
      '命令污染了用户正在运行的进程 stdin！' + JSON.stringify(calls.literals));
    chk('未重建会话', calls.newSessions.length === 0);
  }

  console.log('\n=== 5. 会话存活但 claude 已退出（pane 回到 shell）→ 接回它自己的对话 ===');
  {
    await tmux.newSession(S(ID_SHELL), BOUND_CWD);
    chk('前置条件：pane 前台是登录 shell', (await tmux.currentCommand(S(ID_SHELL))) === 'bash');

    resetCalls();
    const mgr = newManager();
    await mgr.openEntry(fresh(ID_SHELL));
    await sleep(1500);

    const sent = literalsTo(S(ID_SHELL));
    chk('★ claude 已退出 → 发 --resume 接回它自己的对话',
      sent.some((t) => t.includes(`--resume '${CONV_SHELL}'`)), JSON.stringify(sent));
    chk('会话没被重建（原本就活着）', calls.newSessions.length === 0);
    chk('仍然 attach 了面板', calls.terminals.some(attachedTo));
  }

  console.log('\n=== 6. 老条目 + 有历史对话 → 问一次，选中即永久绑定 ===');
  {
    resetCalls();
    quickPickAnswer = (items) => items.find((i) => i.candidate && i.candidate.id === PICKED_CONV);
    const mgr = newManager();
    await mgr.openEntry(fresh(ID_LEGACY));
    await sleep(2500);
    quickPickAnswer = undefined;

    chk('弹了选择框', calls.quickPicks.length === 1, `实际 ${calls.quickPicks.length} 次`);
    const items = (calls.quickPicks[0] || {}).items || [];
    // 条数从假 HOME 实际算，避免以后加用例时写死
    const expected = candidatesForCwd(await listConversations(HOME), CONV_CWD).length;
    chk('候选若干条 + 末尾「＋ 新建一条对话」', items.length === expected + 1,
      `实际 ${items.length}，期望 ${expected + 1}`);
    chk('★ 末尾那项明确写着「新建一条对话」',
      /新建一条对话/.test((items[items.length - 1] || {}).label || ''),
      JSON.stringify(items.map((i) => i.label)));
    chk('对话候选显示 时间 · 摘要 · 体积',
      items.slice(0, -1).every((i) => /·/.test(i.label) && /KB|MB|B/.test(i.label)),
      JSON.stringify(items.map((i) => i.label)));
    chk('★ 选中的对话被永久绑定到条目', bound(ID_LEGACY) === PICKED_CONV,
      `实际 ${JSON.stringify(bound(ID_LEGACY))}`);
    chk('★ 用 --resume 接回选中的那条（不是新开）',
      literalsTo(S(ID_LEGACY)).some((t) => t.includes(`--resume '${PICKED_CONV}'`)),
      JSON.stringify(literalsTo(S(ID_LEGACY))));
  }

  console.log('\n=== 6b. 选中「已绑给别的条目」的对话 → 必须二次确认 ===');
  {
    const pickShared = (items) => items.find((i) => i.candidate && i.candidate.id === PICKED_CONV);

    // 先确认标签上写明了归属
    resetCalls();
    quickPickAnswer = (items) => { quickPickAnswer = undefined; return undefined; };  // 只看列表内容
    const mgrPeek = newManager();
    await mgrPeek.openEntry(fresh(ID_SHARE));
    await sleep(2500);
    // 注意：本用例里 CONV_CWD 下还有另一条已绑给 CONFLICT 的对话，
    // 所以必须按 id 取到 PICKED_CONV 那一项，而不是「第一个带归属的」。
    const shared = ((calls.quickPicks[0] || {}).items || [])
      .find((i) => i.candidate && i.candidate.id === PICKED_CONV);
    chk('★ 候选列表里标出了归属（「已绑给「LEGACY」」）',
      !!shared && shared.label.includes('已绑给「LEGACY」'), String(shared && shared.label));

    // 6b-1：用户取消确认 → 不绑定、什么都不启动
    resetCalls();
    quickPickAnswer = pickShared;
    modalAnswer = undefined;                       // 取消
    const mgr1 = newManager();
    await mgr1.openEntry(fresh(ID_SHARE));
    await sleep(2500);
    modalAnswer = undefined;
    chk('★ 拒绝确认后未绑定（绝不悄悄共写同一条对话）', bound(ID_SHARE) === undefined,
      `实际 ${JSON.stringify(bound(ID_SHARE))}`);
    chk('★ 拒绝确认后未启动任何东西', calls.literals.length === 0, JSON.stringify(calls.literals));
    chk('给了说明（该对话已绑给别人）',
      calls.messages.some((m) => String(m).includes('已绑给')), JSON.stringify(calls.messages));

    // 6b-2：用户确认 → 绑定 + --resume
    resetCalls();
    quickPickAnswer = pickShared;
    modalAnswer = '仍然接这条';
    const mgr2 = newManager();
    await mgr2.openEntry(fresh(ID_SHARE));
    await sleep(2500);
    modalAnswer = undefined;
    quickPickAnswer = undefined;
    chk('★ 确认后才绑定', bound(ID_SHARE) === PICKED_CONV, `实际 ${JSON.stringify(bound(ID_SHARE))}`);
    chk('★ 确认后接回这条', literalsTo(S(ID_SHARE)).some((t) => t.includes(`--resume '${PICKED_CONV}'`)),
      JSON.stringify(literalsTo(S(ID_SHARE))));
  }

  console.log('\n=== 6c. 显式命令「选择要接回的对话…」：绑到别人的对话上同样要确认 ===');
  {
    const pickShared = (items) => items.find((i) => i.candidate && i.candidate.id === PICKED_CONV);
    const mgr = newManager();

    // 6c-1：取消确认 → 绑定不变
    resetCalls();
    quickPickAnswer = pickShared;
    modalAnswer = undefined;
    await mgr.bindConversationInteractive(fresh(ID_SHARE2));
    await sleep(400);
    chk('★ 取消确认后绑定未被改动', bound(ID_SHARE2) === undefined,
      `实际 ${JSON.stringify(bound(ID_SHARE2))}`);
    chk('给了说明（未改绑定）',
      calls.messages.some((m) => String(m).includes('未改绑定')), JSON.stringify(calls.messages));

    // 6c-2：确认 → 绑定生效
    resetCalls();
    modalAnswer = '仍然接这条';
    await mgr.bindConversationInteractive(fresh(ID_SHARE2));
    await sleep(400);
    modalAnswer = undefined;
    quickPickAnswer = undefined;
    chk('★ 确认后绑定生效', bound(ID_SHARE2) === PICKED_CONV,
      `实际 ${JSON.stringify(bound(ID_SHARE2))}`);
  }

  console.log('\n=== 6d. 判据 → 弹选择框 → 发送 之间用户起了 build → 绝不能发 ===');
  {
    resetCalls();
    // PICKED_CONV 这时已被别的条目绑着，会先弹确认 —— 这里一路确认通过，
    // 保证唯一能挡住发送的就是「发送前重算判据」那道闸。
    modalAnswer = '仍然接这条';
    // 用户在「思考该选哪条对话」的这段时间里，在同一个 pane 里起了 build
    quickPickAnswer = async (items) => {
      await run('tmux', ['send-keys', '-l', '-t', `=${S(ID_TOCTOU)}:`, 'sleep 300']);
      await run('tmux', ['send-keys', '-t', `=${S(ID_TOCTOU)}:`, 'Enter']);
      await sleep(600);
      return items.find((i) => i.candidate && i.candidate.id === PICKED_CONV);
    };
    const mgr = newManager();
    await mgr.openEntry(fresh(ID_TOCTOU));
    await sleep(2000);
    quickPickAnswer = undefined;
    modalAnswer = undefined;

    chk('前置：确实走完了选择流程（绑定已写入）', bound(ID_TOCTOU) === PICKED_CONV,
      `实际 ${JSON.stringify(bound(ID_TOCTOU))}`);
    chk('★ 发送前重算判据：pane 已不是登录 shell → 一条启动命令都没发',
      calls.literals.length === 0,
      'TOCTOU：命令发进了用户刚起的 build！' + JSON.stringify(calls.literals));
    chk('★ 说清了原因', calls.warns.some((m) => String(m).includes('跳过')),
      JSON.stringify(calls.warns));
  }

  console.log('\n=== 6e. 并发恢复两个共用 cwd 的老条目：第二个必须看见第一个的绑定 ===');
  {
    resetCalls();
    // RACE_CONV 此时还没人绑：第一个条目会绑上它，第二个必须看见它已被绑
    quickPickAnswer = (items) => items.find((i) => i.candidate && i.candidate.id === RACE_CONV);
    modalAnswer = undefined;   // 第二个若被要求确认 → 取消
    // 真实的 store.update 是一次**文件写入**，有真实耗时。把它放慢，
    // 「读 owners 在 op 内、写绑定在 op 外」这个缺陷就一定会露马脚：
    // 第二个条目会在第一个的写入落盘之前读到「还没人绑」。
    const origUpdate = store.update.bind(store);
    store.update = async (id, patch) => { await sleep(300); return origUpdate(id, patch); };

    const mgr = newManager();
    // 并发发起（restoreAll 内部就是这么并发 openEntry 的）
    await Promise.all([mgr.openEntry(fresh(ID_RACE_A)), mgr.openEntry(fresh(ID_RACE_B))]);
    await sleep(2500);
    store.update = origUpdate;
    quickPickAnswer = undefined;
    modalAnswer = undefined;

    const boundTo = [ID_RACE_A, ID_RACE_B]
      .filter((id) => bound(id) === RACE_CONV);
    const resumes = [...literalsTo(S(ID_RACE_A)), ...literalsTo(S(ID_RACE_B))]
      .filter((t) => t.includes(`--resume '${RACE_CONV}'`));
    chk('★ 同一条对话只有一个条目绑上（第二个看见了第一个的绑定并要确认）',
      boundTo.length === 1, `实际绑上的：${JSON.stringify(boundTo.map((id) => [id, bound(id)]))}`);
    chk('★ 因此只有一条 --resume 打向它（不会两个 claude 写同一个 .jsonl）',
      resumes.length === 1, JSON.stringify(resumes));
  }

  console.log('\n=== 6f. 确认模态开着期间，不应有别的条目的选择框冒出来 ===');
  {
    resetCalls();
    // 两个条目都恢复成「未绑定」，这样它们都会经过选择框
    await store.update(ID_RACE_A, { conversationId: undefined });
    await store.update(ID_RACE_B, { conversationId: undefined });
    let modalCalls = 0;
    let picksDuringModal = -1;
    // 两个条目都选「已绑给 LEGACY」的 PICKED_CONV → 都会走确认模态
    quickPickAnswer = (items) => items.find((i) => i.candidate && i.candidate.id === PICKED_CONV);
    modalAnswer = async () => {
      modalCalls++;
      if (modalCalls === 1) {
        await sleep(400);                       // 用户在看这个确认框
        picksDuringModal = calls.quickPicks.length;
        return '仍然接这条';
      }
      return undefined;                          // 第二个取消
    };

    const mgr = newManager();
    await Promise.all([mgr.openEntry(fresh(ID_RACE_A)), mgr.openEntry(fresh(ID_RACE_B))]);
    await sleep(2500);
    quickPickAnswer = undefined;
    modalAnswer = undefined;

    chk('前置：两个条目各自弹过选择框，且确认模态出现过',
      calls.quickPicks.length === 2 && modalCalls >= 1,
      `pick=${calls.quickPicks.length} modal=${modalCalls}`);
    chk('★ 确认模态开着期间没有下一个条目的选择框并存（不会一摞对话框）',
      picksDuringModal === 1, `实际当时已有 ${picksDuringModal} 个选择框`);
  }

  console.log('\n=== 7. 老条目 + 用户主动选「＋ 新建一条对话」→ 开新对话并绑定 ===');
  {
    resetCalls();
    quickPickAnswer = (items) => items[items.length - 1];   // 末项 = 新建
    const mgr = newManager();
    await mgr.openEntry(fresh(ID_LEGACY_NEW));
    await sleep(2500);
    quickPickAnswer = undefined;

    const id = bound(ID_LEGACY_NEW);
    chk('★ 绑定了全新 uuid', UUID_RE.test(id || ''), `实际 ${JSON.stringify(id)}`);
    chk('未绑到任何历史对话', id !== PICKED_CONV && id !== OTHER_CONV);
    chk('★ 用 --session-id 开新对话（只有用户主动选才会走到这里）',
      literalsTo(S(ID_LEGACY_NEW)).some((t) => t.includes(`--session-id '${id}'`)),
      JSON.stringify(literalsTo(S(ID_LEGACY_NEW))));
  }

  console.log('\n=== 8. 老条目 + 用户按 Esc → 什么都不启动（绝不退回 --continue） ===');
  {
    resetCalls();
    quickPickAnswer = undefined;   // Esc
    const mgr = newManager();
    await mgr.openEntry(fresh(ID_LEGACY_ESC));
    await sleep(2500);

    chk('会话照常建好并 attach（面板可用）', await tmux.hasSession(S(ID_LEGACY_ESC))
      && calls.terminals.some(attachedTo));
    chk('★ 一条启动命令都没发（pane 停在登录 shell）', calls.literals.length === 0,
      JSON.stringify(calls.literals));
    chk('★ 没有 --continue（共用 cwd 下会一起接到同一条最新对话）',
      !calls.literals.some((l) => l.text.includes('--continue')));
    chk('未绑定（下次还会问）', bound(ID_LEGACY_ESC) === undefined);
    chk('给了可恢复的提示（指向右键命令）',
      calls.messages.some((m) => String(m).includes('选择要接回的对话')),
      JSON.stringify(calls.messages));
  }

  console.log('\n=== 9. 切 profile 重启 claude ===');
  {
    // 9a. 有绑定 → --resume
    await newSessionWithClaude(ID_RESTART, FAKE_CLAUDE_EXITING, '-n 1');
    const front = await tmux.currentCommand(S(ID_RESTART));
    chk('9a 前置条件：pane 前台是 claude', front.startsWith('claude'), `实际 ${front}`);

    resetCalls();
    const mgr = newManager();
    await mgr.applyProfile(fresh(ID_RESTART), 'direct');
    await sleep(1500);
    const sent = literalsTo(S(ID_RESTART));
    chk('9a ★ 用 --resume 接回绑定对话',
      sent.some((t) => t.includes(`--resume '${CONV_RESTART}'`)), JSON.stringify(sent));
    chk('9a ★ 而不是 --continue', !sent.some((t) => t.includes('--continue')), JSON.stringify(sent));
    chk('9a profile 已落盘为 direct', fresh(ID_RESTART).profile === 'direct');

    // 9b. 无绑定 → 拒绝，绝不自作主张接一条最新的
    // 会话必须活着，否则 applyProfile 根本不会走到 restartClaude
    await newSessionWithClaude(ID_NOBIND, FAKE_CLAUDE_EXITING, '-n 1');
    await store.update(ID_NOBIND, { conversationId: undefined });   // 模拟「还没绑定」
    resetCalls();
    const mgr2 = newManager();
    const before = fresh(ID_NOBIND).profile;
    await mgr2.applyProfile(fresh(ID_NOBIND), 'direct');
    await sleep(600);
    chk('9b ★ 无绑定时拒绝重启（先绑定再说）',
      calls.errors.some((m) => String(m).includes('还没有绑定对话')), JSON.stringify(calls.errors));
    chk('9b ★ 没发任何 --continue', !calls.literals.some((l) => l.text.includes('--continue')),
      JSON.stringify(calls.literals));
    chk('9b 配置未被改动', fresh(ID_NOBIND).profile === before);
  }

  console.log('\n=== 10. --resume 没接上时必须看得见 ===');
  {
    await tmux.newSession(S(ID_RESUMEFAIL), BOUND_CWD);
    resetCalls();
    launchBin = FAIL_BIN;             // 这个会话里的 claude 会报「找不到对话」
    const mgr = newManager();
    await mgr.openEntry(fresh(ID_RESUMEFAIL));
    await sleep(1500);
    launchBin = QUIET_BIN;

    chk('确实发了 --resume', literalsTo(S(ID_RESUMEFAIL)).some((t) => t.includes('--resume')),
      JSON.stringify(literalsTo(S(ID_RESUMEFAIL))));
    chk('★ 报错被看见，并指向可操作的补救',
      calls.errors.some((m) => String(m).includes('没能接回') && String(m).includes('选择要接回的对话')),
      JSON.stringify(calls.errors));
  }

  console.log('\n=== 10b. 绑定的对话不在本条目目录下 → 拒绝，且绝不另开一条顶替 ===');
  {
    await tmux.newSession(S(ID_CONFLICT), BOUND_CWD);
    resetCalls();
    const mgr = newManager();
    await mgr.openEntry(fresh(ID_CONFLICT));
    await sleep(1500);

    chk('★ 一条命令都没发（--resume 按 cwd 作用域，发出去也接不回）',
      calls.literals.length === 0, JSON.stringify(calls.literals));
    chk('★ 也绝不另开一条新对话顶替（没有 --session-id）',
      !calls.literals.some((l) => l.text.includes('--session-id')));
    chk('★ 说清了原因并指向可操作的补救',
      calls.errors.some((m) => String(m).includes('不在') && String(m).includes('选择要接回的对话')),
      JSON.stringify(calls.errors));
    chk('绑定未被悄悄改掉', bound(ID_CONFLICT) === OTHER_CONV);
    chk('面板照常接回（用户仍能手动处理）', calls.terminals.some(attachedTo));
  }

  console.log('\n=== 11. 陈旧面板不得被当成「已恢复」（2026-09-10 订正） ===');
  {
    const nm = (i) => `STALE0${i + 1}`;

    // ---- 11a. 会话已死 + 同名陈旧面板（旧实现：完全 no-op） ----
    {
      resetCalls();
      const mgr = newManager();
      const stale = makeSurvivor(nm(0));   // 无 shellIntegration → 判不出空闲
      vscodeStub.window.terminals.push(stale);

      await mgr.openEntry(fresh(STALE_IDS[0]));
      await sleep(2500);

      chk('11a 会话已死 + 陈旧面板：会话被重新建出来',
        await tmux.hasSession(S(STALE_IDS[0])), '旧实现完全 no-op，什么都不做');
      chk('11a ★ 确实发了启动命令（不再停在 cd 那一层的裸 shell）',
        literalsTo(S(STALE_IDS[0])).length === 1, JSON.stringify(calls.literals));
      chk('11a 未把 attach 打进状态不明的陈旧面板（安全闸门）', stale.sent.length === 0,
        JSON.stringify(stale.sent));
      vscodeStub.window.terminals.length = 0;
    }

    // ---- 11b. 会话存活但 0 附着 + 陈旧面板（旧实现：只 show）----
    {
      await tmux.newSession(S(STALE_IDS[1]), BOUND_CWD);
      resetCalls();
      const mgr = newManager();
      const stale = makeSurvivor(nm(1));
      vscodeStub.window.terminals.push(stale);

      await mgr.openEntry(fresh(STALE_IDS[1]));
      await sleep(1500);

      chk('11b 会话仍存在（未误重建）', await tmux.hasSession(S(STALE_IDS[1])));
      chk('11b 未新建 tmux 会话', calls.newSessions.length === 0, JSON.stringify(calls.newSessions));
      chk('11b ★ 0 附着 → 必须 attach（旧实现只 show()，claude 在后台跑着却看不见）',
        calls.terminals.some(attachedTo), JSON.stringify(calls.terminals.map((t) => t.sent)));
      chk('11b 未把 attach 打进状态不明的陈旧面板', stale.sent.length === 0, JSON.stringify(stale.sent));
      vscodeStub.window.terminals.length = 0;
    }

    // ---- 11c. 上一个宿主世代的面板：busy 状态未知 → **绝不**用来打字 ----
    // 宿主重载后 busy 是空集、而 shellIntegration 仍在，一个正在跑编译的面板
    // 会被误判空闲。未知必须与空闲区分开，一律按危险处理。
    {
      await tmux.newSession(S(STALE_IDS[2]), BOUND_CWD);
      resetCalls();
      const mgr = newManager();
      const foreignIdle = makeSurvivor(nm(2), { shellIntegration: {} });
      vscodeStub.window.terminals.push(foreignIdle);

      await mgr.openEntry(fresh(STALE_IDS[2]));
      await sleep(1500);

      chk('11c ★ 上一个世代的面板（即使看着空闲）也不往里打字',
        foreignIdle.sent.length === 0,
        'busy 状态未知的面板被打进了 tmux attach！' + JSON.stringify(foreignIdle.sent));
      chk('11c 改为新建面板并 attach',
        calls.terminals.length === 1 && attachedTo(calls.terminals[0]),
        `新终端 ${calls.terminals.length} 个`);
      vscodeStub.window.terminals.length = 0;
    }

    // ---- 11c2. 本宿主世代由我们亲手建的面板：busy 一直跟踪着 → 可以复用 ----
    {
      resetCalls();
      const mgr = newManager();
      await mgr.openEntry(fresh(STALE_IDS[2]));   // 建会话 + 建**我们自己的**面板
      await sleep(2000);
      const ourPanel = calls.terminals[calls.terminals.length - 1];
      chk('11c2 前置条件：建出了我们自己的面板', !!ourPanel && attachedTo(ourPanel));

      await run('tmux', ['kill-session', '-t', `=${S(STALE_IDS[2])}`]);   // 会话死掉
      resetCalls();
      await mgr.openEntry(fresh(STALE_IDS[2]));   // 会话已死 → 需要客户端
      await sleep(2000);

      chk('11c2 ★ 复用了我们自己建的面板（不再多开一个）', calls.terminals.length === 0,
        `实际新终端数 ${calls.terminals.length}`);
      chk('11c2 向复用的面板发了 tmux attach', attachedTo(ourPanel),
        JSON.stringify(ourPanel.sent));
      chk('11c2 对复用的面板执行了 show()', ourPanel.shown >= 1, `实际 show ${ourPanel.shown} 次`);
    }

    // ---- 11e. 上一个世代的面板 + 会话已附着 → 只 show（不打字，安全又整洁） ----
    {
      await tmux.newSession(S(STALE_IDS[2]), BOUND_CWD);
      await attachRealClient(S(STALE_IDS[2]));
      resetCalls();
      const mgr = newManager();
      const foreign = makeSurvivor(nm(2), { shellIntegration: {} });
      vscodeStub.window.terminals.push(foreign);

      await mgr.openEntry(fresh(STALE_IDS[2]));
      await sleep(1200);
      await detachRealClient();

      chk('11e ★ 会话已有人在看 → 只 show 那个面板，不新建也不打字',
        calls.terminals.length === 0 && foreign.sent.length === 0,
        `新终端 ${calls.terminals.length} 个，sent=${JSON.stringify(foreign.sent)}`);
      chk('11e 对面板执行了 show()', foreign.shown === 1, `实际 show ${foreign.shown} 次`);
      vscodeStub.window.terminals.length = 0;
    }

    // ---- 11d. 面板里正在跑命令（shell integration 报忙）→ 绝不往里打字 ----
    {
      await tmux.newSession(S(STALE_IDS[3]), BOUND_CWD);
      resetCalls();
      const mgr = newManager();
      const busySurvivor = makeSurvivor(nm(3), { shellIntegration: {} });
      vscodeStub.window.terminals.push(busySurvivor);
      shellExecutionStart.fire({ terminal: busySurvivor });   // 模拟用户正在跑编译

      await mgr.openEntry(fresh(STALE_IDS[3]));
      await sleep(1500);

      chk('11d ★ 面板里有命令在跑 → 不往里打字（宁可多开一个面板）',
        busySurvivor.sent.length === 0,
        '把 tmux attach 塞进了用户正在跑的进程 stdin！' + JSON.stringify(busySurvivor.sent));
      chk('11d 改为新建面板并 attach',
        calls.terminals.length === 1 && attachedTo(calls.terminals[0]),
        `新终端 ${calls.terminals.length} 个`);

      shellExecutionEnd.fire({ terminal: busySurvivor });
      vscodeStub.window.terminals.length = 0;
    }
  }

  console.log('\n=== 12. 前缀相近的会话互不干扰 ===');
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

  console.log('\n=== 13. 杀会话编排：detach→kill→dispose→Map 清理 ===');
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

    resetCalls();
    await mgr.openEntry(fresh(ID_KILL));
    await sleep(1500);
    chk('Map 已清理：再次 openEntry 新建了终端', calls.terminals.length === 1,
      `实际新终端数 ${calls.terminals.length}`);
  }

  console.log('\n=== 14. applyModel 拒绝路径：前台不是 claude → 不发序列、不改配置 ===');
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

  console.log('\n=== 16. duplicateEntry：复制品必须有自己的对话 id ===');
  {
    const src = fresh(ID_DEAD);
    resetCalls();
    const mgr = newManager();
    await mgr.duplicateEntry(src);
    const copy = store.entries[store.entries.length - 1];

    chk('复制出了新条目（新 id、新名字）',
      !!copy && copy.id !== src.id && copy.name !== src.name,
      `src=${src.id}/${src.name} copy=${copy && copy.id}/${copy && copy.name}`);
    chk('★ 复制品的 conversationId 已被重新生成（不是源条目那条）',
      copy.conversationId !== src.conversationId,
      `src=${src.conversationId} copy=${copy.conversationId}`);
    chk('★ 也不是 undefined（否则会被当成「老条目」而在恢复时弹选择框）',
      copy.conversationId !== undefined && UUID_RE.test(copy.conversationId),
      String(copy.conversationId));
  }

  console.log('\n=== 17. 竞态：会话在等待期间被别的窗口抢先创建 → 只接回、绝不发命令 ===');
  {
    resetCalls();
    const mgr = newManager();
    // 让 newSession 报告「不是我建的」，但会话其实已经存在 —— 这正是
    // 「等待期间被别的窗口建出来」的竞态
    const origNew = tmux.newSession;
    tmux.newSession = async (name, cwd) => {
      calls.newSessions.push({ name, cwd });
      await run('tmux', ['new-session', '-d', '-s', name, '-c', cwd]);
      return false;
    };
    await mgr.openEntry(fresh(ID_RACEBRANCH));
    await sleep(1500);
    tmux.newSession = origNew;

    chk('会话存在（别的窗口建的）', await tmux.hasSession(S(ID_RACEBRANCH)));
    chk('接回了面板', calls.terminals.some(attachedTo));
    chk('★ 一条启动命令都没发（§11 竞态铁律）', calls.literals.length === 0,
      '把命令发进了别人的会话！' + JSON.stringify(calls.literals));
    chk('提示了「刚被其他窗口创建」',
      calls.messages.some((m) => String(m).includes('其他窗口')), JSON.stringify(calls.messages));
  }

  console.log('\n=== 18. 三级树：getChildren 分层与拖拽范围收窄到同文件夹 ===');
  {
    const { EntryTreeProvider, FolderTreeItem, EntryTreeItem, TaskTreeItem } =
      require(path.join(ROOT, 'out/src/tree.js'));

    // 独立的一套假 store/activity，不复用外层那个巨大的 TerminalManager
    // 用例夹具——那份数据是为别的场景准备的，cwd 分布对本节没有意义。
    const treeStore = {
      entries: [
        mk('t-a1', 'A1', '/proj/a'),
        mk('t-a2', 'A2', '/proj/a'),
        mk('t-b1', 'B1', '/proj/b'),
      ],
      async load() { return this.entries.map((e) => ({ ...e })); },
      reorderCalls: [],
      async reorder(ids) { this.reorderCalls.push(ids); },
    };
    const activityByEntry = {
      't-a1': { state: 'running', taskName: '编译' },
      // t-a2、t-b1 没有 activity（undefined）——不应该生出三级节点
    };
    const treeActivity = {
      activityFor(id) { return activityByEntry[id]; },
    };
    const provider = new EntryTreeProvider(treeStore, treeActivity);

    // ---- 一级：按 cwd 分两个文件夹 ----
    const folders = await provider.getChildren(undefined);
    chk('一级节点数 = 2（按 cwd 精确分组）', folders.length === 2,
      JSON.stringify(folders.map((f) => f.cwd)));
    const folderA = folders.find((f) => f.cwd === '/proj/a');
    const folderB = folders.find((f) => f.cwd === '/proj/b');
    chk('文件夹 A 下有 2 条', !!folderA && folderA.entries.length === 2);
    chk('文件夹 B 下有 1 条', !!folderB && folderB.entries.length === 1);

    // ---- 二级：展开文件夹 A 拿到条目 ----
    const entriesInA = await provider.getChildren(folderA);
    chk('二级节点都是 EntryTreeItem', entriesInA.every((n) => n instanceof EntryTreeItem));
    const a1Node = entriesInA.find((n) => n.entry.id === 't-a1');
    const a2Node = entriesInA.find((n) => n.entry.id === 't-a2');
    chk('有任务名的条目 collapsibleState = Expanded (2)', a1Node.collapsibleState === 2,
      String(a1Node.collapsibleState));
    chk('没有任务名的条目 collapsibleState = None (0)', a2Node.collapsibleState === 0,
      String(a2Node.collapsibleState));

    // ---- 三级：只有 a1 应该展开出任务名节点 ----
    const a1Children = await provider.getChildren(a1Node);
    chk('有任务名的条目展开出 1 个 TaskTreeItem', a1Children.length === 1 &&
      a1Children[0] instanceof TaskTreeItem);
    chk('TaskTreeItem 标签就是 taskName', a1Children[0].label === '编译');
    const a2Children = await provider.getChildren(a2Node);
    chk('★ 没有任务名的条目绝不生成三级节点', a2Children.length === 0,
      JSON.stringify(a2Children));

    // ---- 拖拽：同文件夹内允许，跨文件夹整体 no-op ----
    const dragSame = new DataTransfer();
    await provider.handleDrag([a2Node], dragSame);
    await provider.handleDrop(a1Node, dragSame);
    chk('同文件夹内拖拽：store.reorder 被调用了一次',
      treeStore.reorderCalls.length === 1, JSON.stringify(treeStore.reorderCalls));
    chk('同文件夹内拖拽：a2 被插到了 a1 前面',
      treeStore.reorderCalls[0].indexOf('t-a2') < treeStore.reorderCalls[0].indexOf('t-a1'),
      JSON.stringify(treeStore.reorderCalls[0]));
    chk('组外 id（t-b1）相对顺序未变',
      treeStore.reorderCalls[0].indexOf('t-b1') === 2, JSON.stringify(treeStore.reorderCalls[0]));

    treeStore.reorderCalls.length = 0;
    const entriesInB = await provider.getChildren(folderB);
    const b1Node = entriesInB[0];
    const dragCross = new DataTransfer();
    await provider.handleDrag([a1Node], dragCross);
    await provider.handleDrop(b1Node, dragCross); // 跨文件夹：a1(/proj/a) 拖到 b1(/proj/b) 上
    chk('★ 跨文件夹拖拽是纯 no-op：store.reorder 完全没被调用',
      treeStore.reorderCalls.length === 0, JSON.stringify(treeStore.reorderCalls));

    // 拖到文件夹节点本身（而不是某个条目）：同文件夹允许
    treeStore.reorderCalls.length = 0;
    const dragToFolder = new DataTransfer();
    await provider.handleDrag([a2Node], dragToFolder);
    await provider.handleDrop(folderA, dragToFolder);
    chk('拖到同文件夹的文件夹节点本身：允许（落到该文件夹末尾）',
      treeStore.reorderCalls.length === 1, JSON.stringify(treeStore.reorderCalls));
  }

  console.log('\n=== 19. 会话身份：/new 后自动改绑 + 切 profile 前先 reconcile ===');
  {
    await fs.promises.rm(SOLE_CWD, { recursive: true, force: true });
    await fs.promises.mkdir(SOLE_CWD, { recursive: true });
    await writeFixtures();

    /** 起一个 pane，并在其中**后台**跑假 claude（前台仍是 shell，openEntry 才肯发命令）。 */
    const launchBackgroundClaude = async (id, cwd) => {
      await tmux.newSession(S(id), cwd);
      await sleep(500);
      await tmux.sendLiteral(S(id), `${FIXTURE_BG} ${path.join(PID_DIR, id)} &`);
      await tmux.sendEnter(S(id));
      return readFakePid(id);
    };

    // ---- 19a. /new 自愈：注册表记 sessionB、条目绑 sessionA ----
    {
      const id = 'e2eidentity1';
      const sessionA = 'bbbbbbbb-0001-0000-0000-000000000000';
      const sessionB = 'bbbbbbbb-0002-0000-0000-000000000000';
      ALL.push(id);
      // 只写 sessionB 的 .jsonl（不写 sessionA）：这样「没 reconcile」的旧行为
      // 会发 --session-id sessionA，两个断言都会红 —— 回归强度更高。
      await writeConversation(sessionB, BOUND_CWD, '/new 之后的新对话', PROJECT);
      store.entries.push(mk(id, 'IDENTITY', BOUND_CWD, { conversationId: sessionA }));

      const pid = await launchBackgroundClaude(id, BOUND_CWD);
      chk('19a 前置条件：假 claude 已作为 pane 的后代在跑', typeof pid === 'number' && pid > 0, String(pid));
      await writeSessionRecord(pid, sessionB, BOUND_CWD, 1789433265980);

      resetCalls();
      const mgr = newManager();
      await mgr.openEntry(fresh(id));
      await sleep(2500);

      chk('19a ★ 绑定被刷成注册表里的新会话（/new 自愈）', bound(id) === sessionB, `实际 ${bound(id)}`);
      chk('19a ★ liveSessionId 记为观测值', fresh(id).liveSessionId === sessionB, String(fresh(id).liveSessionId));
      const sent = literalsTo(S(id));
      chk('19a ★ 发出去的是 --resume 新会话，绝不是旧会话',
        sent.some((t) => t.includes(`--resume '${sessionB}'`)) &&
        !sent.some((t) => t.includes(`--resume '${sessionA}'`)) &&
        !sent.some((t) => t.includes(`--session-id '${sessionA}'`)), JSON.stringify(sent));
    }

    // ---- 19b. 切 profile 前先 reconcile（restartClaude 是第二条 --resume 路径）----
    {
      const id = 'e2eidentity2';
      const sessionA = 'bbbbbbbb-0003-0000-0000-000000000000';
      const sessionB = 'bbbbbbbb-0004-0000-0000-000000000000';
      ALL.push(id);
      await writeConversation(sessionB, BOUND_CWD, '切 profile 时该接回的新对话', PROJECT);
      store.entries.push(mk(id, 'IDENTITY2', BOUND_CWD, { conversationId: sessionA, model: 'deepseek-chat' }));

      // 前台假 claude：**真二进制副本**（head -n 1），读到一行（就是 restartClaude
      // 发来的 `/exit`）即退出 —— restartClaude 的 waitForShell 才过得去。
      await tmux.newSession(S(id), BOUND_CWD);
      await sleep(500);
      await tmux.sendLiteral(S(id), `${FIXTURE_FG} -n 1`);
      await tmux.sendEnter(S(id));
      chk('19b 前置条件：pane 前台就是假 claude',
        (await tmux.currentCommand(S(id))).startsWith('claude'), await tmux.currentCommand(S(id)));
      // 前台夹具是真二进制、不会写 pid 落盘文件 —— 从 pane 反查它的真实 pid：
      // `#{pane_pid}`（外层 shell）→ `pgrep -P` 给出被 exec 出来的假 claude。
      const pid = await foregroundPid(id);
      // 守卫不可省：foregroundPid 超时会返回 null，此时 writeSessionRecord 会写出
      // 一个 `null.json` 注册表文件（生产代码永远读不到），真实失败原因被掩盖成
      // 「绑定没刷成」，四条断言全红却指向错误的方向。
      chk('19b 前置条件：反查到了假 claude 的真实 pid', typeof pid === 'number' && pid > 0, String(pid));
      await writeSessionRecord(pid, sessionB, BOUND_CWD, 1789433265980);

      resetCalls();
      modalAnswer = '切换';
      const mgr = newManager();
      await mgr.setProfileInteractive(fresh(id));
      modalAnswer = undefined;
      await sleep(2500);

      const sent = literalsTo(S(id));
      chk('19b ★ 重启时接回的是注册表里的新会话（先 reconcile 再拼 --resume）',
        sent.some((t) => t.includes(`--resume '${sessionB}'`)) &&
        !sent.some((t) => t.includes(`--resume '${sessionA}'`)), JSON.stringify(sent));
      chk('19b profile 已切换为 direct', fresh(id).profile === 'direct', String(fresh(id).profile));
      chk('19b model 被清空', fresh(id).model === undefined, String(fresh(id).model));
      chk('19b 绑定也同步刷成新会话', bound(id) === sessionB, String(bound(id)));
    }

    // ---- 19c. 手动改绑不被下一次 reconcile 冲掉 ----
    {
      const id = 'e2eidentity3';
      const manual = 'bbbbbbbb-0005-0000-0000-000000000000';
      const observed = 'bbbbbbbb-0006-0000-0000-000000000000';
      ALL.push(id);
      await writeConversation(manual, BOUND_CWD, '用户手动选的对话', PROJECT);
      store.entries.push(mk(id, 'IDENTITY3', BOUND_CWD, { conversationId: manual, liveSessionId: observed }));

      const pid = await launchBackgroundClaude(id, BOUND_CWD);
      chk('19c 前置条件：假 claude 已作为 pane 的后代在跑', typeof pid === 'number' && pid > 0, String(pid));
      await writeSessionRecord(pid, observed, BOUND_CWD, 1789433265980);

      resetCalls();
      const mgr = newManager();
      await mgr.openEntry(fresh(id));
      await sleep(2500);

      chk('19c ★ 手动改绑的 conversationId 没有被冲回观测值',
        bound(id) === manual, `实际 ${bound(id)}`);
      chk('19c liveSessionId 保持为观测值', fresh(id).liveSessionId === observed, String(fresh(id).liveSessionId));
      chk('19c 接回的仍是用户手动选的那条',
        literalsTo(S(id)).some((t) => t.includes(`--resume '${manual}'`)), JSON.stringify(literalsTo(S(id))));
    }

    // ---- 19d. 观测不到就不动 ----
    {
      const id = 'e2eidentity4';
      const bound0 = 'bbbbbbbb-0007-0000-0000-000000000000';
      ALL.push(id);
      await writeConversation(bound0, BOUND_CWD, '没有假 claude 在跑时该原样保留', PROJECT);
      store.entries.push(mk(id, 'IDENTITY4', BOUND_CWD, { conversationId: bound0, liveSessionId: undefined }));

      // 只有 bash：没有后代 claude，注册表里也没有它
      await tmux.newSession(S(id), BOUND_CWD);
      await sleep(500);

      resetCalls();
      const mgr = newManager();
      await mgr.openEntry(fresh(id));
      await sleep(2500);

      chk('19d ★ 观测不到活跃会话 → 绑定一字未改（liveSessionId 仍是空）',
        bound(id) === bound0 && fresh(id).liveSessionId === undefined,
        `conv=${bound(id)} live=${fresh(id).liveSessionId}`);
    }

    // ---- 19e. 兜底 D 正面：单条目 + claude 已死 → 自动接回最新候选，不问 ----
    {
      const id = 'e2eidentity5';
      ALL.push(id);
      const older = 'bbbbbbbb-0008-0000-0000-000000000000';
      const newer = 'bbbbbbbb-0009-0000-0000-000000000000';
      await writeConversation(older, SOLE_CWD, '旧的', '-tmp-tmuxterm-e2e-sole');
      await writeConversation(newer, SOLE_CWD, '新的', '-tmp-tmuxterm-e2e-sole');
      // mtime 显式给定，排序才确定（同一毫秒内写两个文件时 mtime 可能相同）
      const dir = path.join(HOME, '.claude', 'projects', '-tmp-tmuxterm-e2e-sole');
      await fs.promises.utimes(path.join(dir, `${older}.jsonl`), 1_000_000, 1_000_000);
      await fs.promises.utimes(path.join(dir, `${newer}.jsonl`), 2_000_000, 2_000_000);

      const local = {
        entries: [mk(id, 'SOLE', SOLE_CWD)],
        async load() { return this.entries.map((e) => ({ ...e })); },
        async update(entryId, patch) {
          const i = this.entries.findIndex((e) => e.id === entryId);
          if (i >= 0) this.entries[i] = { ...this.entries[i], ...patch };
        },
      };
      await tmux.newSession(S(id), SOLE_CWD);   // 只有 bash：claude 已死
      await sleep(500);

      resetCalls();
      const mgr = new TerminalManager(local, tmux);
      mgr.home = () => HOME;
      await mgr.openEntry(local.entries[0]);
      await sleep(2500);

      chk('19e ★ 单条目 + claude 已死 → 自动接回同 cwd 下 mtime 最新的对话',
        literalsTo(S(id)).some((t) => t.includes(`--resume '${newer}'`)), JSON.stringify(literalsTo(S(id))));
      chk('19e ★ 没有弹选择框（收窄后的 D 正是为了不问）', calls.quickPicks.length === 0,
        JSON.stringify(calls.quickPicks.map((q) => q.opts && q.opts.title)));
      chk('19e 绑定被落下（推断值）', local.entries[0].conversationId === newer,
        String(local.entries[0].conversationId));
      chk('19e ★ 推断不冒充观测：liveSessionId 保持未设',
        local.entries[0].liveSessionId === undefined, String(local.entries[0].liveSessionId));
    }

    // ---- 19f. 兜底 D 反面：展开后同一个 cwd 的两个条目 → 不得启用 D ----
    {
      const idA = 'e2eidentity6';
      const idB = 'e2eidentity7';
      ALL.push(idA, idB);
      // `~/shared` 与 `<HOME>/shared` 原始串不同、展开后是同一个目录
      const realCwd = path.join(HOME, 'shared');
      await fs.promises.mkdir(realCwd, { recursive: true });
      const conv = 'bbbbbbbb-0010-0000-0000-000000000000';
      await writeConversation(conv, realCwd, '共用目录下的对话', '-tmp-tmuxterm-e2e-home-shared');

      const local = {
        entries: [mk(idA, 'SHARED-A', '~/shared'), mk(idB, 'SHARED-B', realCwd)],
        async load() { return this.entries.map((e) => ({ ...e })); },
        async update(entryId, patch) {
          const i = this.entries.findIndex((e) => e.id === entryId);
          if (i >= 0) this.entries[i] = { ...this.entries[i], ...patch };
        },
      };
      await tmux.newSession(S(idA), realCwd);
      await sleep(500);

      resetCalls();
      quickPickAnswer = undefined;              // 用户按 Esc = 什么都不启动
      const mgr = new TerminalManager(local, tmux);
      mgr.home = () => HOME;
      await mgr.openEntry(local.entries[0]);
      await sleep(1500);

      chk('19f ★ 展开后同 cwd 的两个条目 → D 不生效，退回弹选择框问用户',
        calls.quickPicks.length === 1, JSON.stringify(calls.quickPicks.length));
      chk('19f ★ 一条启动命令都没发', literalsTo(S(idA)).length === 0, JSON.stringify(literalsTo(S(idA))));
      chk('19f 绑定未被改动', local.entries[0].conversationId === undefined,
        String(local.entries[0].conversationId));
    }

    // ---- 19g. 复制条目：复制品不得继承 liveSessionId（不变量 3 在复制路径上的延伸）----
    {
      const id = 'e2eidentity8';
      const observed = 'bbbbbbbb-0013-0000-0000-000000000000';
      store.entries.push(mk(id, 'IDENTITY5', BOUND_CWD, { conversationId: observed, liveSessionId: observed }));

      const mgr = newManager();
      await mgr.duplicateEntry(fresh(id));
      const copy = store.entries[store.entries.length - 1];

      // 若 liveSessionId 随 ...rest 一起被复制：复制品一出生就带着源条目的
      // 「已观测会话」，reconcileBinding 第二分支（live === liveSessionId）
      // 会误判「没变化」而不改绑 —— 复制品永远跟着源条目那条会话走。
      chk('19g ★ 复制品不带 liveSessionId（否则 reconcile 第二分支会误判「没变化」而不改绑）',
        copy.liveSessionId === undefined, String(copy.liveSessionId));
      chk('19g 复制品另有自己的 conversationId（不照抄源条目的绑定）',
        typeof copy.conversationId === 'string' && copy.conversationId !== observed,
        String(copy.conversationId));
    }
  }

  console.log('\n=== 20. 任务名回退链：pane title → 绑定对话的 aiTitle → 不显示三级 ===');
  {
    const { EntryTreeProvider, TaskTreeItem } = require(path.join(ROOT, 'out/src/tree.js'));
    const { TaskTitleCache } = require(path.join(ROOT, 'out/src/taskTitles.js'));
    const { taskNameFromTitle } = require(path.join(ROOT, 'out/src/core/tmux.js'));

    // 本节的接缝在**渲染层**：activity 用假的（pane title → taskName 那条链的
    // 解析已被 test/core/tmux.test.ts 与 test/activityTracker.test.ts 覆盖，
    // 且这段代码本次未改），titleFallback 用**真的** TaskTitleCache +
    // **真的**磁盘 transcript —— 这才正好覆盖本次新增的 taskNameFor 回退逻辑。
    const storeFor = (entry) => ({
      entries: [entry],
      async load() { return this.entries.map((e) => ({ ...e })); },
      async reorder() {},
    });
    const noName = { activityFor: () => ({ state: 'idle', taskName: '' }) };

    /**
     * 记录 `peek` 收到的**全部实参**。
     *
     * 只断言 `peekIds.includes(<某个 id>)` 抓不到「用错键调用」——多传一个别的
     * id 也照样命中 includes（Task 10 review 的教训）。这里断言**观测到的键集合**
     * 本身：键必须从绑定的对话 id 派生，且绝不是条目 id / 会话名。
     */
    const watchPeek = (cache) => {
      const keys = [];
      const orig = cache.peek.bind(cache);
      cache.peek = (id) => { keys.push(id); return orig(id); };
      return keys;
    };
    /** 键集合的断言：每一个键都从 convId 派生，且没有一个等于条目 id / 会话名。 */
    const keysOk = (keys, convId, entryId, entryName) =>
      keys.length > 0 &&
      keys.every((k) => typeof k === 'string' && k.startsWith(convId)) &&
      !keys.some((k) => k === entryId || k === entryName || k === `tmuxterm-${entryId}`);

    // ---- 20a. 无 pane 任务名 → 回退到绑定对话的 aiTitle（且要读文件尾部）----
    const conv = 'bbbbbbbb-0011-0000-0000-000000000000';
    const aiTitle = '创建多引擎版 /ask 命令并统一';
    await writeTranscript(conv, BOUND_CWD, PROJECT, aiTitle, 2000);   // >64KB，标题只在尾部
    const titles = new TaskTitleCache(HOME);
    titles.prewarm(conv, BOUND_CWD);
    await sleep(300);
    chk('20a 前置条件：aiTitle 已从 transcript **尾部**取到（文件 >64KB）',
      titles.peek(conv) === aiTitle, JSON.stringify(titles.peek(conv)));

    const peekIds = watchPeek(titles);
    const p1 = new EntryTreeProvider(storeFor(mk('t-title1', 'T1', BOUND_CWD, { conversationId: conv })), noName, titles);
    const node1 = (await p1.getChildren((await p1.getChildren(undefined))[0]))[0];
    chk('20a ★ 三级回退到绑定对话的 aiTitle', node1.taskName === aiTitle, JSON.stringify(node1.taskName));
    chk('20a 二级 collapsibleState = Expanded (2)', node1.collapsibleState === 2, String(node1.collapsibleState));
    const third1 = await p1.getChildren(node1);
    chk('20a 三级节点标签就是 aiTitle',
      third1.length === 1 && third1[0] instanceof TaskTreeItem && third1[0].label === aiTitle,
      JSON.stringify(third1.map((t) => t.label)));
    chk('20a ★ peek 的键集合全部从绑定对话 id 派生（不是条目 id / 会话名 / 显示名）',
      keysOk(peekIds, conv, 't-title1', 'T1'), JSON.stringify(peekIds));

    // ---- 20b. transcript 里没有 aiTitle → 不生成三级 ----
    const convEmpty = 'bbbbbbbb-0012-0000-0000-000000000000';
    await writeTranscript(convEmpty, BOUND_CWD, PROJECT, undefined, 10);
    const titles2 = new TaskTitleCache(HOME);
    titles2.prewarm(convEmpty, BOUND_CWD);
    await sleep(300);
    const peekIds2 = watchPeek(titles2);
    const p2 = new EntryTreeProvider(storeFor(mk('t-title2', 'T2', BOUND_CWD, { conversationId: convEmpty })), noName, titles2);
    const node2 = (await p2.getChildren((await p2.getChildren(undefined))[0]))[0];
    chk('20b ★ 都无从得知时 taskName 为空串（不用灰色占位/derived slug 冒充）',
      node2.taskName === '', JSON.stringify(node2.taskName));
    chk('20b 二级 collapsibleState = None (0)', node2.collapsibleState === 0, String(node2.collapsibleState));
    chk('20b ★ 不生成三级节点', (await p2.getChildren(node2)).length === 0);
    chk('20b ★ 负例下 peek 的键集合同样从绑定对话 id 派生',
      keysOk(peekIds2, convEmpty, 't-title2', 'T2'), JSON.stringify(peekIds2));

    // ---- 20c. 首字符回归：shell 自己设的标题不得被削 ----
    const shellTitle = 'qiansenwei@H:~/workspace';
    const parsed = taskNameFromTitle(shellTitle);
    chk('20c 前置条件：shell 标题解析后原样保留', parsed === shellTitle, JSON.stringify(parsed));
    const p3 = new EntryTreeProvider(
      storeFor(mk('t-title3', 'T3', BOUND_CWD, { conversationId: conv })),
      { activityFor: () => ({ state: 'idle', taskName: parsed }) },
      titles,
    );
    const node3 = (await p3.getChildren((await p3.getChildren(undefined))[0]))[0];
    chk('20c ★ pane title 优先，三级显示原文', node3.taskName === shellTitle, JSON.stringify(node3.taskName));
    const third3 = await p3.getChildren(node3);
    chk('20c 三级节点标签是原文',
      third3.length === 1 && third3[0].label === shellTitle, JSON.stringify(third3.map((t) => t.label)));
  }

  console.log('\n=== 15. 清理 + 用户环境未被触碰 ===');
  await detachRealClient();
  await killAll(ALL);
  await killFakePids();     // 后台桩可能不在 pane 前台进程组里，杀会话不保证带走
  await sleep(500);         // 给 init 一点时间回收僵尸
  const stragglers = [];
  for (const name of await fs.promises.readdir(PID_DIR).catch(() => [])) {
    try {
      const t = Number((await fs.promises.readFile(path.join(PID_DIR, name), 'utf8')).trim());
      process.kill(t, 0);   // 不抛 = 还活着
      stragglers.push(t);
    } catch { /* 已退出 */ }
  }
  chk('★ 假 claude 桩进程没有残留', stragglers.length === 0, stragglers.join(','));
  const left = (await tmux.listSessions()).filter((s) => s.startsWith('tmuxterm-e2e'));
  chk('无残留测试会话', left.length === 0, left.join(', '));

  // ★ 最要紧的一条：整轮跑完，用户真实的 ~/.claude/projects 必须逐文件一致
  const projectsAfter = await projectSnapshot();
  const added = [...projectsAfter.keys()].filter((k) => !projectsBefore.has(k));
  const removed = [...projectsBefore.keys()].filter((k) => !projectsAfter.has(k));
  chk('★ 用户真实的 ~/.claude/projects 没有新增/删除任何文件',
    added.length === 0 && removed.length === 0,
    `新增=${added.join(',')} 删除=${removed.join(',')}`);

  // 用户自己的 claude 会话此刻仍在写盘（它们不是本测试的痕迹）。
  // 关键是：**本测试不能留下任何痕迹** —— 测试会话的 cwd 全部以
  // tmuxterm-e2e 打头，真 claude 若被拉起来就会在对应 project 下留文件。
  const liveChanged = [...projectsAfter]
    .filter(([k, v]) => projectsBefore.has(k) && projectsBefore.get(k).mtimeMs !== v.mtimeMs)
    .map(([k]) => k);
  chk('★ 本轮没有任何测试会话的痕迹落进用户真实的库',
    !liveChanged.some((k) => k.includes('tmuxterm-e2e')),
    liveChanged.filter((k) => k.includes('tmuxterm-e2e')).join(','));
  console.log(`    （本轮期间用户在活动的会话文件 ${liveChanged.length} 个 —— 那是他自己的进程，不计入）`);

  const fakeHomeBefore = fs.existsSync(HOME);
  await fs.promises.rm(HOME, { recursive: true, force: true });
  await fs.promises.rm(BIN_DIR, { recursive: true, force: true });
  for (const d of [SCRATCH, CONV_CWD, BOUND_CWD, SOLE_CWD, PID_DIR]) {
    await fs.promises.rm(d, { recursive: true, force: true });
  }
  chk('假 HOME / 假 claude / scratch 目录已清理',
    fakeHomeBefore && !fs.existsSync(HOME) && !fs.existsSync(BIN_DIR) && !fs.existsSync(SCRATCH));

  console.log(`\n${fail === 0 ? '端到端全部通过 ✓' : `${fail} 项失败`}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('harness 异常:', e);
  process.exit(1);
});
