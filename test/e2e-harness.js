/**
 * 端到端驱动脚本（非 mocha 测试，手动跑）。
 *
 * 目的：VS Code 接线层一直被认为是「只能手动冒烟」，但那只是因为
 * `vscode` 模块需要运行时注入。这里用一个 stub 顶上，把真正的
 * TerminalManager.openEntry 对着**真 tmux** 驱动起来，从而自动验证
 * 几条最核心的不变量：
 *
 *   1. 绑定的对话**不存在** → 不传任何会话参数地新开一条（裸 claude，既不
 *      `--session-id` 也不 `--resume`）。分两种：条目**从未跑起来过**（「+」/
 *      复制新建的首启）一声不吭；**曾观测到跑起来过**、记录却被删了则出声提醒
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
  quickPickShapeViolations: [], inputBoxes: [],
};

// 让某一节可以控制下一个 modal / QuickPick / InputBox 弹窗的应答；
// 三者默认都是 undefined（= 用户取消 / 没输入）。
let modalAnswer;
let quickPickAnswer;
let inputBoxAnswer;

// VS Code 稳定 API 里 QuickPickItem 允许出现的字段（对照 @types/vscode 的
// index.d.ts 抄的）。任何不在这个集合、也不在 EXTRA_QUICKPICK_KEYS 里的键，
// 都可能是 proposed API —— 而对装成 vsix 的正常扩展来说，用 proposed API 的
// 后果是 showQuickPick 直接抛错、整个选择框弹不出来（0.1.7 的
// quickPickItemTooltip 事故就是这么炸的）。所以在进 stub 的那一刻拦住。
const STABLE_QUICKPICK_KEYS = new Set([
  'label', 'kind', 'iconPath', 'description', 'detail',
  'resourceUri', 'picked', 'alwaysShow',
]);

// 本扩展自己挂在候选项上的负载字段（见 src/terminalManager.ts 的
// ConversationPickItem）。它们不是 VS Code API 的一部分，VS Code 会忽略。
const EXTRA_QUICKPICK_KEYS = new Set(['candidate', 'owner']);

/** 返回 items 上所有「VS Code 不认识、我们也没打算让它忽略」的字段名。 */
function quickPickShapeViolations(items) {
  const bad = new Set();
  for (const it of items) {
    // 纯字符串项（模型清单那种）没有字段可查，跳过
    if (it === null || typeof it !== 'object') continue;
    for (const k of Object.keys(it)) {
      if (!STABLE_QUICKPICK_KEYS.has(k) && !EXTRA_QUICKPICK_KEYS.has(k)) bad.add(k);
    }
  }
  return [...bad];
}

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
    // 支持「函数式应答」，与 showQuickPick / showWarningMessage 一致：多数用例
    // 只需要一个固定值，但「先输非法 hex 再输合法 hex」这类要按调用次序给不同值，
    // 那时就用函数。
    showInputBox(opts) {
      calls.inputBoxes.push(opts || {});
      return Promise.resolve(
        typeof inputBoxAnswer === 'function' ? inputBoxAnswer(opts || {}) : inputBoxAnswer,
      );
    },
    showQuickPick(items, opts) {
      calls.quickPicks.push({ items, opts });
      // 进 stub 的每一项都查一遍字段：见 quickPickShapeViolations 的说明。
      // **在这里当场判失败**，而不是攒起来等某个用例去读 —— 攒着就需要每个
      // 走选择框的用例各写一条断言，漏一个就又是个缺口。这里是所有选择框
      // 调用的必经之路，挂在它上面才没有死角。
      const violations = quickPickShapeViolations(items);
      if (violations.length > 0) {
        calls.quickPickShapeViolations.push(...violations);
        chk(
          `QuickPick 项字段必须全在稳定 API 内（发现：${violations.join('、')}）`,
          false,
          JSON.stringify(items.map((i) => (i !== null && typeof i === 'object' ? Object.keys(i) : typeof i))),
        );
      }
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
// 与 CONV_FRESH 一样**始终不被创建**，但绑定它的那个槽 liveSessionId 有值 ——
// 用它区分「首启（从未跑起来过）」与「记录被外部删了（曾观测到跑起来过）」。
const CONV_LOST = 'aaaaaaaa-0009-0000-0000-000000000000';
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
async function writeConversation(uuid, cwd, firstMessage, projectDir) {
  const dir = path.join(HOME, '.claude', 'projects', projectDir);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, `${uuid}.jsonl`),
    [
      JSON.stringify({ type: 'mode', sessionId: uuid }),
      JSON.stringify({ type: 'attachment', cwd }),
      JSON.stringify({
        type: 'user', userType: 'external', isSidechain: false, cwd,
        message: { role: 'user', content: firstMessage },
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
 *
 * `FIXTURE_BG` 必须带上 `TMUXTERM_E2E_FIXTURE=$$` 的环境标记：`exec sleep`
 * 之后 argv 只剩 `sleep 600`，从命令行**认不出这是我们的桩**；而环境块会随
 * exec 保留下来，`isOurs()` 才能在被杀之前验明正身（见那里的注释：pid 会被
 * OS 回收，误杀的是别人的进程）。`$$` 就是写进 pid 文件的那个 pid。
 */
async function writeFixtures() {
  await fs.promises.mkdir(BIN_DIR, { recursive: true });
  await fs.promises.mkdir(PID_DIR, { recursive: true });
  await fs.promises.writeFile(
    FIXTURE_BG,
    '#!/bin/sh\necho $$ > "$1"\nexport TMUXTERM_E2E_FIXTURE=$$\nexec sleep 600\n',
    'utf8',
  );
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
 * `/proc/<pid>` 里此刻真的是**本 harness 的**桩进程吗？
 *
 * **为什么非验不可：pid 会被 OS 回收。** pid 文件是桩启动时写下的，到
 * `killFakePids` 之间隔着整轮测试（`killAll` 之后还有 500ms）；桩若已经退出，
 * 这个 pid 完全可能被**无关进程**复用，此时一发 SIGKILL 就打到别人身上 ——
 * 而本 harness 的契约是「用户环境必须不被触碰」（这台机器上有 8 条活的
 * 用户 tmux 会话，还有用户自己的 claude）。
 *
 * 判据（任一成立即可，都指向本 harness 自己的夹具）：
 * - argv 里含夹具的绝对路径（桩 `exec` 之前，以及 `FIXTURE_FG` 这类真二进制
 *   副本 —— 它们按绝对路径调用，argv[0] 就是那个路径）；
 * - 环境里含 `TMUXTERM_E2E_FIXTURE=<pid>`（桩 `exec sleep` 之后 argv 只剩
 *   `sleep 600`，只有环境块跨 exec 保留下来 —— 见 writeFixtures）。
 *
 * **读不到 / 对不上就返回 false（不发信号）**：宁可漏杀（下一次清场还会扫
 * PID_DIR、tmux 会话也已 killAll），绝不误杀一个陌生进程。
 */
function isOurs(pid) {
  try {
    if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(`${BIN_DIR}/claude-fixture`)) {
      return true;
    }
    const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    return env.includes(`TMUXTERM_E2E_FIXTURE=${pid}`);
  } catch {
    // 已退出（/proc/<pid> 不在）/ 非本用户（environ 不可读）→ 认不出来就不动它
    return false;
  }
}

/**
 * 杀掉所有桩进程。
 * 后台任务可能不在 pane 的**前台**进程组里，杀 tmux 会话不保证把它带走。
 *
 * **发信号前必须过 `isOurs`** —— 见那里的注释：pid 回收窗口里 SIGKILL 会
 * 打到无关进程上。
 */
async function killFakePids() {
  for (const name of await fs.promises.readdir(PID_DIR).catch(() => [])) {
    try {
      const t = (await fs.promises.readFile(path.join(PID_DIR, name), 'utf8')).trim();
      if (!/^\d+$/.test(t)) continue;
      const pid = Number(t);
      if (!isOurs(pid)) continue; // pid 已被回收 / 桩早已退出 → 绝不发信号
      process.kill(pid, 'SIGKILL');
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
  const ID_FRESH = 'e2efresh001';      // 新建条目（已绑定，对话未创建）→ 裸 claude，且不问
  const ID_LOST = 'e2elost0001';       // 曾观测到跑起来过 + 记录被外部删除 → 出声 + 裸 claude
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
  const ALL = [ID_NEW, ID_FRESH, ID_LOST, ID_DEAD, ID_ALIVE, ID_SHELL, ID_LEGACY, ID_LEGACY_NEW,
    ID_LEGACY_ESC, ID_SHARE, ID_SHARE2, ID_TOCTOU, ID_RACE_A, ID_RACE_B, ID_RACEBRANCH,
    ID_RESTART, ID_NOBIND, ID_RESUMEFAIL, ID_CONFLICT, ID_KILL, ID_REFUSE, ID_B, ID_PREFIX,
    ...STALE_IDS];

  const projectsBefore = await projectSnapshot();

  // 清场：上一次跑残留的会话、假 HOME、假 claude、scratch 目录、假 claude 的 pid 文件
  await killAll(ALL);
  await detachRealClient();
  await fs.promises.rm(HOME, { recursive: true, force: true });
  await fs.promises.rm(BIN_DIR, { recursive: true, force: true });
  for (const d of [SCRATCH, CONV_CWD, BOUND_CWD]) {
    await fs.promises.rm(d, { recursive: true, force: true });
    await fs.promises.mkdir(d, { recursive: true });
  }
  // ★ pid 目录必须清空，且**不能**只在读取端兜底：`readFakePid` 是在发桩
  // 之后**立刻**读的（早于新桩写盘），所以上一轮遗留的文件会先被读到。
  // 后果有两条，第二条不可接受：
  //   1. 陈旧 pid 交给 writeSessionRecord → 生产代码在真实进程表里找不到该
  //      后代 → 19a/19c 以「绑定没刷成」的形式失败，报错指向 reconcile 而
  //      不是夹具，排查方向被带偏；
  //   2. killFakePids 会对**此刻占用该 pid 的任意进程**发 SIGKILL —— 本
  //      harness 的契约是「用户环境必须不被触碰」（用户有活的 tmux 会话）。
  // 异常退出（Ctrl-C 足够，末尾的 .catch 会跳过全部清理）正是残留的来源。
  await fs.promises.rm(PID_DIR, { recursive: true, force: true });
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
    // v3：绑定回写走槽级原语（生产代码的 writeBinding → store.updateSession）。
    // 假 store 也必须实现它，否则 openSession 一进到写绑定那一行就抛
    // 「updateSession is not a function」，而症状看起来是「绑定没刷成」。
    async updateSession(entryId, sessionId, patch) {
      const i = this.entries.findIndex((e) => e.id === entryId);
      if (i < 0) return;
      const sessions = this.entries[i].sessions || [];
      const j = sessions.findIndex((s) => s.id === sessionId);
      if (j < 0) return;
      const next = sessions.slice();
      next[j] = { ...next[j], ...patch, id: next[j].id };
      this.entries[i] = { ...this.entries[i], sessions: next };
    },
    // v3：新增会话走槽级原语（生产代码的 addSessionInteractive →
    // store.addSession），order 在「锁内」分配 —— 假 store 没有锁，但必须把
    // 「order 由这里补齐、调用方不传」这条契约照搬，否则 addSessionInteractive
    // 一进到那一行就抛「addSession is not a function」。
    async addSession(entryId, slot) {
      const i = this.entries.findIndex((e) => e.id === entryId);
      if (i < 0) return;
      const sessions = this.entries[i].sessions || [];
      const next = sessions.reduce((m, s) => Math.max(m, Math.max(0, s.order || 0)), -1) + 1;
      this.entries[i] = { ...this.entries[i], sessions: [...sessions, { ...slot, order: next }] };
    },
    async removeSession(entryId, sessionId) {
      const i = this.entries.findIndex((e) => e.id === entryId);
      if (i < 0) return;
      const sessions = this.entries[i].sessions || [];
      this.entries[i] = { ...this.entries[i], sessions: sessions.filter((s) => s.id !== sessionId) };
    },
    // 真删。从前这里是空实现 —— 那时没有任何用例走到 deleteEntry，所以看不出
    // 差别；多会话之后「删除条目必须递归杀掉其下每个会话」只能靠「条目真没了 +
    // tmux 会话真没了」两条一起断言，空实现会让前一条永远为假（fresh() 仍找得到）。
    async remove(id) { this.entries = this.entries.filter((e) => e.id !== id); },
    async findByName() {}, async reorder() {},
  };
  const fresh = (id) => store.entries.find((e) => e.id === id);
  /** 绑定是**会话级**的（v3）：断言读的是该条目第一个槽上的绑定。 */
  const bound = (id) => fresh(id) && fresh(id).sessions[0] && fresh(id).sessions[0].conversationId;
  /** 该条目第一个槽的便捷读取（多会话的用例不用它，自己构造 sessions）。 */
  const slot0 = (e) => e.sessions[0];
  const literalsTo = (session) =>
    calls.literals.filter((l) => l.name === session).map((l) => l.text);
  const resetCalls = () => {
    calls.terminals.length = 0; calls.literals.length = 0;
    calls.newSessions.length = 0; calls.quickPicks.length = 0;
    calls.errors.length = 0; calls.messages.length = 0;
    calls.warns.length = 0;
    calls.quickPickShapeViolations.length = 0; calls.inputBoxes.length = 0;
  };

  // v3：一条目 = 一个**会话槽数组**。既有用例全是「一条目一会话」，故这里把
  // conversationId / liveSessionId 转发进唯一的那个槽，槽 id 取条目 id
  // （与 v1/v2 迁移的合成规则同构：tmux 会话名由槽 id 派生，沿用条目 id 才能
  // 认得出迁移前就在跑的会话）。
  //
  // **只进槽、不进顶层**：照抄到顶层会让清单里长出两个不该有的字段，而 harness
  // 是 JS，TS 的类型检查管不到这里 —— 只能靠这一行显式剥掉。
  //
  // 槽的 order 固定 0：既有用例都是单槽，不需要别的顺序。**多会话的新用例自己
  // 构造 sessions 数组**（两个槽、各自的 order），不复用 mk —— 一个 helper 不
  // 该为了两种形状变得两头不讨好。
  const mk = (id, name, cwd, extra = {}) => {
    const { conversationId, liveSessionId, ...entryLevel } = extra;
    return {
      id, name, cwd, profile: 'ccr', autoRestore: false,
      sessions: [{ id, conversationId, liveSessionId, order: 0 }],
      ...entryLevel,
    };
  };
  store.entries = [
    mk(ID_NEW, 'NEW', SCRATCH),                                   // 老条目：无 conversationId
    mk(ID_FRESH, 'FRESH', BOUND_CWD, { conversationId: CONV_FRESH }),
    // 绑定的 .jsonl 不存在 + liveSessionId 有值 = 「曾观测到跑起来过，记录却被
    // 外部删了」。与 ID_FRESH 的唯一差别就是这个 liveSessionId。
    mk(ID_LOST, 'LOST', BOUND_CWD, { conversationId: CONV_LOST, liveSessionId: CONV_LOST }),
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

    // 这道闸必须真的会红：喂一个带 proposed API 字段的项进去，它得报出来。
    {
      const bad = quickPickShapeViolations([
        { label: 'a' },
        { label: 'b', tooltip: 'x' },
        { label: 'c', candidate: {}, owner: 'o' },
      ]);
      chk('字段白名单：能抓出 proposed API 字段 tooltip（这道闸不是空转）',
        bad.length === 1 && bad[0] === 'tooltip', JSON.stringify(bad));
    }
  }

  console.log('\n=== 1. 老条目（无绑定）+ 无候选 → --session-id 新建并永久绑定 ===');
  {
    resetCalls();
    const mgr = newManager();
    await mgr.openSession(fresh(ID_NEW), fresh(ID_NEW).sessions[0]);
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

  console.log('\n=== 2. 新建条目（已绑定、对话尚未创建）→ 裸 claude，且不弹选择框、不出声 ===');
  {
    resetCalls();
    const mgr = newManager();
    await mgr.openSession(fresh(ID_FRESH), fresh(ID_FRESH).sessions[0]);
    await sleep(2500);

    chk('★ 全程没弹选择框（新建条目不该被问）', calls.quickPicks.length === 0,
      JSON.stringify(calls.quickPicks.map((q) => q.opts && q.opts.title)));
    const sent = literalsTo(S(ID_FRESH));
    // 「+」/复制新建的条目一出生就带 id，但那条对话还没被创建过 —— 此时没有
    // 可接回的对话，首启就是一条**裸 claude**（LaunchSpec 的 fresh）。绝不预先
    // 钉一个用户没见过的 uuid：claude 当场开出来的那条才是真正在用的，reconcile
    // 观测到之后会把绑定回写到它身上，不需要靠 --session-id 提前造。
    chk('★ 裸 claude：一个会话参数都不带（既不 --session-id 也不 --resume）',
      sent.length === 1 && !sent[0].includes('--session-id') && !sent[0].includes('--resume'),
      JSON.stringify(sent));
    chk('绑定的 id 没有被改掉', bound(ID_FRESH) === CONV_FRESH);
    chk('★ 一声不吭：首启是正常路径，不是异常（没有任何提示）',
      calls.messages.length === 0, JSON.stringify(calls.messages));
  }

  console.log('\n=== 2b. 绑定的记录被外部删除（曾观测到跑起来过）→ 出声，启动仍是裸 claude ===');
  {
    // 只覆盖「记录被外部删了要出声」这条路径：单测里有，e2e 原先完全没有。
    resetCalls();
    const mgr = newManager();
    await mgr.openSession(fresh(ID_LOST), fresh(ID_LOST).sessions[0]);
    await sleep(2500);

    // 与第 2 组的**唯一**差别是槽的 liveSessionId 有值（= 上一次已确认观测到
    // 这个终端在跑哪条会话）。对话文件在「文件」这一层两件事不可区分，全靠它
    // 分开：没有它 = 从未跑起来过（第 2 组，静默）；有它 = 那条 .jsonl 被外部
    // 删了（手动 rm、清理工具），这时沉默会让用户以为「对话又没了」，必须出声。
    chk('★ 出声了：提醒这条对话的记录已被删除、本次新开一条',
      calls.messages.some((m) => String(m).includes('似乎已被删除') && String(m).includes('新开一条')),
      JSON.stringify(calls.messages));
    const sent = literalsTo(S(ID_LOST));
    // 没有可接回的对话 → 仍是裸 claude；绑定会由 reconcile 观测到新会话后回写。
    chk('★ 启动命令仍是裸 claude（没有可接回的对话，也不预钉 uuid）',
      sent.length === 1 && !sent[0].includes('--session-id') && !sent[0].includes('--resume'),
      JSON.stringify(sent));
    chk('不弹选择框（条目已绑定，没什么可挑）', calls.quickPicks.length === 0,
      JSON.stringify(calls.quickPicks.map((q) => q.opts && q.opts.title)));
  }

  console.log('\n=== 3. 会话已死 + 已绑定（对话存在）→ --resume 接回它自己那条（核心） ===');
  {
    resetCalls();
    const mgr = newManager();
    await mgr.openSession(fresh(ID_DEAD), fresh(ID_DEAD).sessions[0]);
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
    await mgr.openSession(fresh(ID_ALIVE), fresh(ID_ALIVE).sessions[0]);
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
    await mgr.openSession(fresh(ID_SHELL), fresh(ID_SHELL).sessions[0]);
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
    await mgr.openSession(fresh(ID_LEGACY), fresh(ID_LEGACY).sessions[0]);
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
    chk('对话候选显示 时间 · 首条消息原文 · 体积',
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
    await mgrPeek.openSession(fresh(ID_SHARE), fresh(ID_SHARE).sessions[0]);
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
    await mgr1.openSession(fresh(ID_SHARE), fresh(ID_SHARE).sessions[0]);
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
    await mgr2.openSession(fresh(ID_SHARE), fresh(ID_SHARE).sessions[0]);
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
    await mgr.openSession(fresh(ID_TOCTOU), fresh(ID_TOCTOU).sessions[0]);
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
    // 真实的 store.updateSession 是一次**文件写入**，有真实耗时。把它放慢，
    // 「读 owners 在 op 内、写绑定在 op 外」这个缺陷就一定会露马脚：
    // 第二个条目会在第一个的写入落盘之前读到「还没人绑」。
    // 注意放慢的是 **updateSession**（v3 的绑定回写出口），不是 update ——
    // 挂错方法等于这一节什么都没验。
    const origUpdate = store.updateSession.bind(store);
    store.updateSession = async (id, sid, patch) => { await sleep(300); return origUpdate(id, sid, patch); };

    const mgr = newManager();
    // 并发发起（restoreAll 内部就是这么并发 openSession 的）
    await Promise.all([
      mgr.openSession(fresh(ID_RACE_A), fresh(ID_RACE_A).sessions[0]),
      mgr.openSession(fresh(ID_RACE_B), fresh(ID_RACE_B).sessions[0]),
    ]);
    await sleep(2500);
    store.updateSession = origUpdate;
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
    await store.updateSession(ID_RACE_A, ID_RACE_A, { conversationId: undefined });
    await store.updateSession(ID_RACE_B, ID_RACE_B, { conversationId: undefined });
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
    await Promise.all([
      mgr.openSession(fresh(ID_RACE_A), fresh(ID_RACE_A).sessions[0]),
      mgr.openSession(fresh(ID_RACE_B), fresh(ID_RACE_B).sessions[0]),
    ]);
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
    await mgr.openSession(fresh(ID_LEGACY_NEW), fresh(ID_LEGACY_NEW).sessions[0]);
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
    await mgr.openSession(fresh(ID_LEGACY_ESC), fresh(ID_LEGACY_ESC).sessions[0]);
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
    // 模拟「还没绑定」：绑定在槽上，故清的是该条目唯一那个槽的绑定。
    await store.updateSession(ID_NOBIND, ID_NOBIND, { conversationId: undefined });
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
    await mgr.openSession(fresh(ID_RESUMEFAIL), fresh(ID_RESUMEFAIL).sessions[0]);
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
    await mgr.openSession(fresh(ID_CONFLICT), fresh(ID_CONFLICT).sessions[0]);
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

      await mgr.openSession(fresh(STALE_IDS[0]), fresh(STALE_IDS[0]).sessions[0]);
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

      await mgr.openSession(fresh(STALE_IDS[1]), fresh(STALE_IDS[1]).sessions[0]);
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

      await mgr.openSession(fresh(STALE_IDS[2]), fresh(STALE_IDS[2]).sessions[0]);
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
      await mgr.openSession(fresh(STALE_IDS[2]), fresh(STALE_IDS[2]).sessions[0]);   // 建会话 + 建**我们自己的**面板
      await sleep(2000);
      const ourPanel = calls.terminals[calls.terminals.length - 1];
      chk('11c2 前置条件：建出了我们自己的面板', !!ourPanel && attachedTo(ourPanel));

      await run('tmux', ['kill-session', '-t', `=${S(STALE_IDS[2])}`]);   // 会话死掉
      resetCalls();
      await mgr.openSession(fresh(STALE_IDS[2]), fresh(STALE_IDS[2]).sessions[0]);   // 会话已死 → 需要客户端
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

      await mgr.openSession(fresh(STALE_IDS[2]), fresh(STALE_IDS[2]).sessions[0]);
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

      await mgr.openSession(fresh(STALE_IDS[3]), fresh(STALE_IDS[3]).sessions[0]);
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
    await mgr.openSession(fresh(ID_B), fresh(ID_B).sessions[0]);
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
    await mgr.openSession(fresh(ID_KILL), fresh(ID_KILL).sessions[0]);
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
    await mgr.openSession(fresh(ID_KILL), fresh(ID_KILL).sessions[0]);
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
      copy.sessions[0].conversationId !== src.sessions[0].conversationId,
      `src=${src.sessions[0].conversationId} copy=${copy.sessions[0].conversationId}`);
    chk('★ 也不是 undefined（否则会被当成「老条目」而在恢复时弹选择框）',
      copy.sessions[0].conversationId !== undefined && UUID_RE.test(copy.sessions[0].conversationId),
      String(copy.sessions[0].conversationId));
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
    await mgr.openSession(fresh(ID_RACEBRANCH), fresh(ID_RACEBRANCH).sessions[0]);
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
      // 先删同名文件：读发生在**发桩之后、新桩写盘之前**，不删就会把上一轮
      // 遗留的 pid 当成这次的（进而绑到无关进程上、并被 killFakePids 误杀）。
      // 跑前清场已清空整个 PID_DIR，这是同一隐患的第二道闸门。
      await fs.promises.rm(path.join(PID_DIR, id), { force: true });
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
      await mgr.openSession(fresh(id), fresh(id).sessions[0]);
      await sleep(2500);

      chk('19a ★ 绑定被刷成注册表里的新会话（/new 自愈）', bound(id) === sessionB, `实际 ${bound(id)}`);
      chk('19a ★ liveSessionId 记为观测值',
        fresh(id).sessions[0].liveSessionId === sessionB, String(fresh(id).sessions[0].liveSessionId));
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
      await mgr.openSession(fresh(id), fresh(id).sessions[0]);
      await sleep(2500);

      chk('19c ★ 手动改绑的 conversationId 没有被冲回观测值',
        bound(id) === manual, `实际 ${bound(id)}`);
      chk('19c liveSessionId 保持为观测值',
        fresh(id).sessions[0].liveSessionId === observed, String(fresh(id).sessions[0].liveSessionId));
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
      await mgr.openSession(fresh(id), fresh(id).sessions[0]);
      await sleep(2500);

      chk('19d ★ 观测不到活跃会话 → 绑定一字未改（liveSessionId 仍是空）',
        bound(id) === bound0 && fresh(id).sessions[0].liveSessionId === undefined,
        `conv=${bound(id)} live=${fresh(id).sessions[0].liveSessionId}`);
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
        // v3 的绑定回写走槽级原语，假 store 也必须实现它。
        async updateSession(entryId, sessionId, patch) {
          const i = this.entries.findIndex((e) => e.id === entryId);
          if (i < 0) return;
          const sessions = this.entries[i].sessions || [];
          const j = sessions.findIndex((s) => s.id === sessionId);
          if (j < 0) return;
          const next = sessions.slice();
          next[j] = { ...next[j], ...patch, id: next[j].id };
          this.entries[i] = { ...this.entries[i], sessions: next };
        },
      };
      await tmux.newSession(S(id), SOLE_CWD);   // 只有 bash：claude 已死
      await sleep(500);

      resetCalls();
      const mgr = new TerminalManager(local, tmux);
      mgr.home = () => HOME;
      await mgr.openSession(local.entries[0], local.entries[0].sessions[0]);
      await sleep(2500);

      chk('19e ★ 单条目 + claude 已死 → 自动接回同 cwd 下 mtime 最新的对话',
        literalsTo(S(id)).some((t) => t.includes(`--resume '${newer}'`)), JSON.stringify(literalsTo(S(id))));
      chk('19e ★ 没有弹选择框（收窄后的 D 正是为了不问）', calls.quickPicks.length === 0,
        JSON.stringify(calls.quickPicks.map((q) => q.opts && q.opts.title)));
      chk('19e 绑定被落下（推断值）', local.entries[0].sessions[0].conversationId === newer,
        String(local.entries[0].sessions[0].conversationId));
      chk('19e ★ 推断不冒充观测：liveSessionId 保持未设',
        local.entries[0].sessions[0].liveSessionId === undefined,
        String(local.entries[0].sessions[0].liveSessionId));
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
        // v3 的绑定回写走槽级原语，假 store 也必须实现它。
        async updateSession(entryId, sessionId, patch) {
          const i = this.entries.findIndex((e) => e.id === entryId);
          if (i < 0) return;
          const sessions = this.entries[i].sessions || [];
          const j = sessions.findIndex((s) => s.id === sessionId);
          if (j < 0) return;
          const next = sessions.slice();
          next[j] = { ...next[j], ...patch, id: next[j].id };
          this.entries[i] = { ...this.entries[i], sessions: next };
        },
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
      await mgr.openSession(local.entries[0], local.entries[0].sessions[0]);
      await sleep(1500);

      chk('19f ★ 展开后同 cwd 的两个条目 → D 不生效，退回弹选择框问用户',
        calls.quickPicks.length === 1, JSON.stringify(calls.quickPicks.length));
      chk('19f ★ 一条启动命令都没发', literalsTo(S(idA)).length === 0, JSON.stringify(literalsTo(S(idA))));
      chk('19f 绑定未被改动', local.entries[0].sessions[0].conversationId === undefined,
        String(local.entries[0].sessions[0].conversationId));
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
        copy.sessions[0].liveSessionId === undefined, String(copy.sessions[0].liveSessionId));
      chk('19g 复制品另有自己的 conversationId（不照抄源条目的绑定）',
        typeof copy.sessions[0].conversationId === 'string' && copy.sessions[0].conversationId !== observed,
        String(copy.sessions[0].conversationId));
    }
  }

  console.log('\n=== 20. 任务名回退链：pane title → 绑定对话的 aiTitle → 不显示三级 ===');
  {
    const { EntryTreeProvider, TaskTreeItem } = require(path.join(ROOT, 'out/src/tree.js'));
    const { TaskTitleCache } = require(path.join(ROOT, 'out/src/taskTitles.js'));
    const { taskNameFromTitle } = require(path.join(ROOT, 'out/src/core/tmux.js'));

    // 本节的接缝在**渲染层**：activity 用假的（pane title → taskName 那条链的
    // 解析与采样层的闸门已被 test/core/tmux.test.ts 与 test/activityTracker.test.ts
    // 覆盖 —— 含 Task 13 新增的「前台不是 claude ⇒ 空串」，故 20c 里那段
    // shell 标题只可能在渲染层出现，真实链路上采样层早已把它压成空串），
    // titleFallback 用**真的** TaskTitleCache + **真的**磁盘 transcript ——
    // 这才正好覆盖本次新增的 taskNameFor 回退逻辑。
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

  // ==========================================================================
  // 多会话（v3）：一个终端挂 N 个会话。以下每一节都对应一条不变量。
  // 新用例**自己构造 sessions 数组**，不复用 mk —— 那个 helper 是给「一条目
  // 一会话」的既有用例用的（槽 id 取条目 id），两种形状混在一个 helper 里
  // 只会两头不讨好。
  // ==========================================================================

  console.log('\n=== 21. 多会话：一个终端挂 2 个会话，各自独立打开 ===');
  {
    const id = 'e2emulti001';
    const SLOT_A = 'e2emultia01';
    const SLOT_B = 'e2emultib01';
    const CONV_A = 'cccccccc-0001-0000-0000-000000000000';
    const CONV_B = 'cccccccc-0002-0000-0000-000000000000';
    ALL.push(id, SLOT_A, SLOT_B);
    await writeConversation(CONV_A, BOUND_CWD, '多会话里的第一条', PROJECT);
    await writeConversation(CONV_B, BOUND_CWD, '多会话里的第二条', PROJECT);
    store.entries.push({
      id, name: 'MULTI', cwd: BOUND_CWD, profile: 'ccr', autoRestore: false,
      sessions: [
        { id: SLOT_A, conversationId: CONV_A, order: 0 },
        { id: SLOT_B, conversationId: CONV_B, order: 1 },
      ],
    });

    resetCalls();
    const mgr = newManager();
    await mgr.openSession(fresh(id), fresh(id).sessions[0]);
    await sleep(1800);
    await mgr.openSession(fresh(id), fresh(id).sessions[1]);
    await sleep(1800);

    chk('21a ★ tmux 会话名由**槽** id 派生（不是条目 id）',
      (await tmux.hasSession(S(SLOT_A))) && (await tmux.hasSession(S(SLOT_B))),
      `A=${await tmux.hasSession(S(SLOT_A))} B=${await tmux.hasSession(S(SLOT_B))}`);

    const sentA = literalsTo(S(SLOT_A));
    const sentB = literalsTo(S(SLOT_B));
    chk('21b ★ 第一个槽 --resume 的是它自己的对话',
      sentA.some((t) => t.includes(`--resume '${CONV_A}'`)) &&
      !sentA.some((t) => t.includes(CONV_B)), JSON.stringify(sentA));
    chk('21c ★ 第二个槽 --resume 的是它自己的对话（绝不串到第一条）',
      sentB.some((t) => t.includes(`--resume '${CONV_B}'`)) &&
      !sentB.some((t) => t.includes(CONV_A)), JSON.stringify(sentB));

    const multi = fresh(id);
    chk('21d 两个绑定各自留在自己的槽上，一字未动',
      multi.sessions[0].conversationId === CONV_A && multi.sessions[1].conversationId === CONV_B,
      JSON.stringify(multi.sessions.map((s) => s.conversationId)));
    chk('21e 两个面板都建出来了（各槽一个）', calls.terminals.length === 2,
      `实际 ${calls.terminals.length}`);
  }

  console.log('\n=== 22. X（关闭会话）：只杀 tmux 进程，槽与绑定一字未动 ===');
  {
    const id = 'e2eclose001';
    const SLOT = 'e2eclosea01';
    const CONV = 'cccccccc-0003-0000-0000-000000000000';
    ALL.push(id, SLOT);
    await writeConversation(CONV, BOUND_CWD, 'X 之后要接回的那条', PROJECT);
    store.entries.push({
      id, name: 'CLOSE', cwd: BOUND_CWD, profile: 'ccr', autoRestore: false,
      sessions: [{ id: SLOT, conversationId: CONV, order: 0 }],
    });

    resetCalls();
    const mgr = newManager();
    await mgr.openSession(fresh(id), fresh(id).sessions[0]);
    await sleep(1500);
    chk('22a 前置条件：会话已建出来', await tmux.hasSession(S(SLOT)));

    modalAnswer = '关闭';
    await mgr.closeSession(fresh(id), fresh(id).sessions[0]);
    modalAnswer = undefined;

    chk('22b ★ tmux 会话确实被杀掉', (await tmux.hasSession(S(SLOT))) === false);
    const closed = fresh(id);
    chk('22c ★ 条目仍在、槽仍在（X 不是删除）',
      !!closed && closed.sessions.length === 1 && closed.sessions[0].id === SLOT,
      JSON.stringify(closed && closed.sessions));
    chk('22d ★ 绑定一字未变 —— 这是「三级是接回会话的」能成立的前提',
      closed.sessions[0].conversationId === CONV, String(closed.sessions[0].conversationId));

    resetCalls();
    await mgr.openSession(fresh(id), fresh(id).sessions[0]);
    await sleep(1800);
    const back = literalsTo(S(SLOT));
    chk('22e ★ 再点那一行 = --resume 回同一条对话',
      back.some((t) => t.includes(`--resume '${CONV}'`)), JSON.stringify(back));
    chk('22f ★ 而不是开一条新对话（没有 --session-id、没有裸 claude）',
      !back.some((t) => t.includes('--session-id')), JSON.stringify(back));
  }

  console.log('\n=== 23. 删除会话 vs 删除条目（判断 A / 不变量 8） ===');
  {
    const id = 'e2edel0001';
    const S1 = 'e2edelslot1';
    const S2 = 'e2edelslot2';
    ALL.push(id, S1, S2);
    store.entries.push({
      id, name: 'DEL', cwd: SCRATCH, profile: 'ccr', autoRestore: false,
      sessions: [
        { id: S1, conversationId: 'cccccccc-0004-0000-0000-000000000000', order: 0 },
        { id: S2, conversationId: 'cccccccc-0005-0000-0000-000000000000', order: 1 },
      ],
    });
    const mgr = newManager();

    // 直接把两个 tmux 会话建出来（不走 openSession，省一轮 3s 的等待）
    await tmux.newSession(S(S1), SCRATCH);
    await tmux.newSession(S(S2), SCRATCH);
    resetCalls();
    modalAnswer = '删除';
    await mgr.deleteSession(fresh(id), fresh(id).sessions[0]);
    modalAnswer = undefined;

    const afterDel = fresh(id);
    chk('23a ★ 删除会话只让**该槽**消失',
      !!afterDel && afterDel.sessions.length === 1 && afterDel.sessions[0].id === S2,
      JSON.stringify(afterDel && afterDel.sessions.map((s) => s.id)));
    chk('23b ★ 该槽的 tmux 会话被杀', (await tmux.hasSession(S(S1))) === false);
    chk('23c ★ 同终端其余槽的 tmux 会话**不受影响**', await tmux.hasSession(S(S2)));
    chk('23d 条目本身还在', !!afterDel);

    // 删除条目：其下**每个**槽都要被杀（旧文案「远端 tmux 会话不受影响」已作废）。
    // 刻意另起一个**双槽**条目来做这一步：上面那个已经被删掉一个槽了，拿它验
    // 「每个槽都杀」只能覆盖到一个槽 —— 那样这条断言就退化成了「杀死存在的那个」，
    // 漏杀别的槽（例如只杀 sessions[0]）照样能过。
    const id2 = 'e2edel0002';
    const S3 = 'e2edelslot3';
    const S4 = 'e2edelslot4';
    ALL.push(id2, S3, S4);
    store.entries.push({
      id: id2, name: 'DEL2', cwd: SCRATCH, profile: 'ccr', autoRestore: false,
      sessions: [
        { id: S3, conversationId: 'cccccccc-0006-0000-0000-000000000000', order: 0 },
        { id: S4, conversationId: 'cccccccc-0007-0000-0000-000000000000', order: 1 },
      ],
    });
    await tmux.newSession(S(S3), SCRATCH);
    await tmux.newSession(S(S4), SCRATCH);

    resetCalls();
    modalAnswer = '删除';
    await mgr.deleteEntry(fresh(id2));
    modalAnswer = undefined;

    chk('23e ★ 条目消失', fresh(id2) === undefined);
    chk('23f ★ 其下**每个**槽的 tmux 会话都被杀掉',
      (await tmux.hasSession(S(S3))) === false && (await tmux.hasSession(S(S4))) === false,
      `S3=${await tmux.hasSession(S(S3))} S4=${await tmux.hasSession(S(S4))}`);
    chk('23g ★ 确认框点名了作用对象与会话数，且不再说「远端 tmux 会话不受影响」',
      calls.warns.some((m) => String(m).includes('DEL2') && String(m).includes('2 个会话')) &&
      !calls.warns.some((m) => String(m).includes('不受影响')),
      JSON.stringify(calls.warns));
  }

  console.log('\n=== 24. 新建会话（二级 +）：零弹框，只加一个会话位，不自动打开 ===');
  {
    const id = 'e2eadd0001';
    ALL.push(id);
    store.entries.push(mk(id, 'ADDSESS', SCRATCH));
    const before = fresh(id).sessions.length;

    resetCalls();
    const mgr = newManager();
    await mgr.addSessionInteractive(fresh(id));

    chk('24a ★ 零弹框：选择框 / 输入框 / 提示框一个都没弹',
      calls.quickPicks.length === 0 && calls.messages.length === 0 &&
      calls.warns.length === 0 && calls.inputBoxes.length === 0,
      JSON.stringify({ q: calls.quickPicks.length, m: calls.messages.length,
        w: calls.warns.length, i: calls.inputBoxes.length }));

    const after = fresh(id);
    chk('24b 槽数 +1', after.sessions.length === before + 1,
      `${before} → ${after.sessions.length}`);
    const added = after.sessions[after.sessions.length - 1];
    chk('24c ★ 新槽用的是 newId()，**不 borrow 条目 id**（那只是迁移的规则）',
      added.id !== id && added.id.length > 0 && added.id !== after.sessions[0].id,
      `条目 ${id} 新槽 ${added.id}`);

    chk('24d ★ 不自动打开终端（「+」是加一个会话位，不产生任何副作用）',
      calls.terminals.length === 0 && calls.newSessions.length === 0 && calls.literals.length === 0,
      JSON.stringify({ t: calls.terminals.length, n: calls.newSessions.length,
        l: calls.literals.length }));
  }

  console.log('\n=== 25. 新建条目：带 1 个会话槽；一级 + 的 cwd 预填且可改（判断 B） ===');
  {
    const CWD = '/tmp/tmuxterm-e2e-folder';
    store.entries.push(mk('e2ekeep0001', 'KEEP', SCRATCH));
    ALL.push('e2ekeep0001');

    resetCalls();
    const mgr = newManager();
    inputBoxAnswer = (opts) => (opts.title === '终端名称' ? 'ADDED' : CWD);
    quickPickAnswer = (items, opts) => {
      // 用 startsWith 而不是全等：候选过多时标题会变成
      // 「远程目录（候选过多，仅显示前 50 条，可手动输入其他）」，而扫到 /tmp
      // 这一层时**一定**会超过 50 条（每个测试目录都在里面）。按全等匹配会让
      // askCwd 拿到 undefined、整条新建流程中止，症状却是「新建条目没生效」。
      if (String(opts.title).startsWith('远程目录')) return '$(pencil) 手动输入…';
      if (String(opts.title).includes('全部恢复')) return '否';
      return undefined;
    };
    await mgr.addEntryInteractive(CWD);
    inputBoxAnswer = undefined;
    quickPickAnswer = undefined;

    const cwdPick = calls.quickPicks.find((q) => String(q.opts.title).startsWith('远程目录'));
    chk('25a ★ 一级 + 把该文件夹的 cwd 当作**可改的**预填（placeHolder）',
      !!cwdPick && cwdPick.opts.placeHolder === CWD,
      JSON.stringify(calls.quickPicks.map((q) => [q.opts.title, q.opts.placeHolder])));

    const added = store.entries[store.entries.length - 1];
    chk('25b ★ 新建条目带 1 个会话槽（不是 0 个 —— 0 槽的条目点了没反应）',
      added.name === 'ADDED' && added.sessions.length === 1,
      JSON.stringify({ name: added.name, sessions: added.sessions }));
    chk('25c ★ 槽 id 是新 id，不等于条目 id', added.sessions[0].id !== added.id,
      `条目 ${added.id} 槽 ${added.sessions[0].id}`);
    chk('25d 槽预分配了 conversationId（首次启动才不会弹选择框）',
      UUID_RE.test(String(added.sessions[0].conversationId)),
      String(added.sessions[0].conversationId));
    chk('25e 目录取自用户输入的那一份', added.cwd === CWD, String(added.cwd));
  }

  console.log('\n=== 26. profile / 模型属于二级：改一次，其下全部存活会话一起变（不变量 6） ===');
  {
    const id = 'e2eprof0001';
    const SLOTS = ['e2eprofslt1', 'e2eprofslt2', 'e2eprofslt3'];
    const CONVS = [
      'cccccccc-0006-0000-0000-000000000000',
      'cccccccc-0007-0000-0000-000000000000',
      'cccccccc-0008-0000-0000-000000000000',
    ];
    ALL.push(id, ...SLOTS);
    for (let i = 0; i < 3; i++) {
      await writeConversation(CONVS[i], BOUND_CWD, `第 ${i + 1} 个会话的对话`, PROJECT);
    }
    store.entries.push({
      id, name: 'PROF', cwd: BOUND_CWD, profile: 'ccr', autoRestore: false, model: 'deepseek-chat',
      sessions: SLOTS.map((s, i) => ({ id: s, conversationId: CONVS[i], order: i })),
    });
    // 三个槽各起一个真 pane，前台跑假 claude（`head -n 1`：收到 `/exit` 即退出，
    // restartClaude 的 waitForShell 才过得去）
    for (const s of SLOTS) {
      await tmux.newSession(S(s), BOUND_CWD);
      await sleep(400);
      await tmux.sendLiteral(S(s), `${FAKE_CLAUDE_EXITING} -n 1`);
      await tmux.sendEnter(S(s));
      await sleep(500);
    }
    chk('26 前置条件：三个槽的 pane 前台都是 claude',
      (await Promise.all(SLOTS.map(async (s) => (await tmux.currentCommand(S(s))).startsWith('claude'))))
        .every(Boolean));

    resetCalls();
    const mgr = newManager();
    await mgr.applyProfile(fresh(id), 'direct');
    await sleep(600);

    const after = fresh(id);
    chk('26a profile 落在**条目**上（三级没有独立存储）', after.profile === 'direct', after.profile);
    chk('26b ★ 槽里没有任何 profile / model 字段',
      after.sessions.every((s) => !('profile' in s) && !('model' in s)),
      JSON.stringify(after.sessions));
    chk('26c model 被一并清空（profile 命名空间不同）', after.model === undefined, String(after.model));

    const sent = SLOTS.map((s) => literalsTo(S(s)));
    chk('26d ★ 3 个存活槽全部被重启（每个都收到 /exit）',
      sent.every((l) => l.includes('/exit')), JSON.stringify(sent));
    chk('26e ★ 每个槽 --resume 的是**自己**那条对话',
      CONVS.every((c, i) => sent[i].some((t) => t.includes(`--resume '${c}'`))),
      JSON.stringify(sent));
  }

  console.log('\n=== 27. 复制：逐槽重造 id 与绑定，剥掉 liveSessionId（§7.6） ===');
  {
    const id = 'e2edup0001';
    const CONVS = [
      'cccccccc-0009-0000-0000-000000000000',
      'cccccccc-0010-0000-0000-000000000000',
    ];
    ALL.push(id);
    store.entries.push({
      id, name: 'DUP', cwd: BOUND_CWD, profile: 'ccr', autoRestore: false, model: 'm1',
      sessions: [
        { id: 'e2edupslt01', conversationId: CONVS[0], liveSessionId: CONVS[0], order: 0 },
        { id: 'e2edupslt02', conversationId: CONVS[1], liveSessionId: CONVS[1], order: 5 },
      ],
    });

    resetCalls();
    const mgr = newManager();
    await mgr.duplicateEntry(fresh(id));
    const copy = store.entries[store.entries.length - 1];

    chk('27a 复制品有 2 个槽（数量保留）', copy.sessions.length === 2, String(copy.sessions.length));
    chk('27b ★ 每个槽都换了新 id，且互不相同',
      copy.sessions.every((s) => s.id !== 'e2edupslt01' && s.id !== 'e2edupslt02') &&
      copy.sessions[0].id !== copy.sessions[1].id,
      JSON.stringify(copy.sessions.map((s) => s.id)));
    chk('27c ★ 每个槽的 conversationId 都重新生成（照抄会让两个 claude 同写一条 .jsonl）',
      copy.sessions[0].conversationId !== CONVS[0] &&
      copy.sessions[1].conversationId !== CONVS[1] &&
      UUID_RE.test(String(copy.sessions[0].conversationId)) &&
      UUID_RE.test(String(copy.sessions[1].conversationId)),
      JSON.stringify(copy.sessions.map((s) => s.conversationId)));
    chk('27d ★ liveSessionId 全部剥掉（带着它 reconcile 会误判「没变化」而永不改绑）',
      copy.sessions.every((s) => s.liveSessionId === undefined),
      JSON.stringify(copy.sessions));
    chk('27e 槽的 order 原样保留',
      copy.sessions[0].order === 0 && copy.sessions[1].order === 5,
      JSON.stringify(copy.sessions.map((s) => s.order)));
  }

  console.log('\n=== 28. 迁移端到端：v2 文件 → 槽 id === 原条目 id，且生成 .v2.bak（不变量 1） ===');
  {
    const { EntryStore } = require(path.join(ROOT, 'out/src/core/store.js'));
    const v2File = `/tmp/vscode-tmux-terminals-e2e-v2-${process.pid}.json`;
    const V2_CONV = 'dddddddd-0001-0000-0000-000000000000';
    const V2_LIVE = 'dddddddd-0002-0000-0000-000000000000';
    const v2Text = JSON.stringify([
      {
        id: 'v2entry001', name: 'V2', cwd: '/tmp/tmuxterm-e2e-v2', profile: 'ccr',
        conversationId: V2_CONV, liveSessionId: V2_LIVE, autoRestore: true, order: 0,
      },
    ], null, 2);
    await fs.promises.rm(v2File, { force: true });
    await fs.promises.rm(`${v2File}.v2.bak`, { force: true });
    await fs.promises.writeFile(v2File, v2Text, 'utf8');

    const v2Store = new EntryStore(v2File);
    const migrated = await v2Store.migrateAndBackupV2();
    const loaded = await v2Store.load();

    chk('28a 迁移真的发生了', migrated === true);
    chk('28b 合成出恰好 1 个槽', loaded[0].sessions.length === 1,
      JSON.stringify(loaded[0].sessions));
    chk('28c ★★ 槽 id === 原条目 id（写错不报错，只会让正在跑的会话变成「无会话」）',
      loaded[0].sessions[0].id === 'v2entry001', String(loaded[0].sessions[0].id));
    chk('28d v2 的绑定原样落到槽上（不是编造的、也不是丢掉的）',
      loaded[0].sessions[0].conversationId === V2_CONV &&
      loaded[0].sessions[0].liveSessionId === V2_LIVE,
      JSON.stringify(loaded[0].sessions[0]));
    chk('28e 顶层不再有 conversationId / liveSessionId（绑定是会话级的）',
      loaded[0].conversationId === undefined && loaded[0].liveSessionId === undefined,
      JSON.stringify(loaded[0]));

    const bak = await fs.promises.readFile(`${v2File}.v2.bak`, 'utf8');
    chk('28f ★ .v2.bak 已生成，且内容**逐字节**等于原文',
      bak === v2Text, `备份 ${bak.length} 字节 / 原文 ${v2Text.length} 字节`);
    chk('28g 已有 .v2.bak 时不覆盖（第一次的备份才是原始数据）',
      (await v2Store.migrateAndBackupV2()) === false);

    await fs.promises.rm(v2File, { force: true });
    await fs.promises.rm(`${v2File}.v2.bak`, { force: true });
  }

  console.log('\n=== 29. 设置颜色：调色板取预设色 + 自定义输入必过 normalizeHexColor ===');
  {
    const id = 'e2ecolor001';
    ALL.push(id);
    store.entries.push(mk(id, 'COLOR', SCRATCH));

    resetCalls();
    const mgr = newManager();
    // 大写预设色：写进清单的必须是归一化后的小写
    quickPickAnswer = '#46A758';
    await mgr.setColorInteractive(fresh(id));
    quickPickAnswer = undefined;
    chk('29a ★ 预设色以归一化的小写 hex 落盘', fresh(id).color === '#46a758',
      String(fresh(id).color));

    // 自定义：末项才是「自定义…」
    resetCalls();
    quickPickAnswer = (items) => items[items.length - 1];
    const boxes = [];
    inputBoxAnswer = (opts) => {
      boxes.push(opts);
      return '#gggggg';   // 非法 hex
    };
    await mgr.setColorInteractive(fresh(id));
    quickPickAnswer = undefined;
    inputBoxAnswer = undefined;

    chk('29b ★ 非法 hex 被 validateInput 拦下（`#gggggg` 拒、合法值放行）',
      boxes.length === 1 && boxes[0].validateInput('#gggggg') !== null &&
      boxes[0].validateInput('#abc') === null,
      JSON.stringify(boxes.map((b) => b.validateInput && b.validateInput('#gggggg'))));
    chk('29c ★★ 非法值**绝不写进清单**（颜色保持上一次那个）',
      fresh(id).color === '#46a758', String(fresh(id).color));

    // 合法但带大小写的三位简写 → 展开成小写六位
    resetCalls();
    const mgr2 = newManager();
    quickPickAnswer = (items) => items[items.length - 1];
    inputBoxAnswer = () => '#AbC';
    await mgr2.setColorInteractive(fresh(id));
    quickPickAnswer = undefined;
    inputBoxAnswer = undefined;
    chk('29d ★ 三位简写展开成小写六位后落盘', fresh(id).color === '#aabbcc',
      String(fresh(id).color));
  }

  console.log('\n=== 15. 清理 + 用户环境未被触碰 ===');
  await detachRealClient();
  await killAll(ALL);
  await killFakePids();     // 后台桩可能不在 pane 前台进程组里，杀会话不保证带走
  await sleep(500);         // 给 init 一点时间回收僵尸
  const stragglers = [];
  for (const name of await fs.promises.readdir(PID_DIR).catch(() => [])) {
    try {
      const t = (await fs.promises.readFile(path.join(PID_DIR, name), 'utf8')).trim();
      // 与 killFakePids 用同一个守卫：空文件 / 截断文件会得到
      // `Number('') === 0`，而 `process.kill(0, 0)` 是「探测调用者自己的
      // 进程组」且**不抛错** —— 于是 0 会被当成真泄漏塞进 stragglers，
      // 让这条断言无故变红。
      if (!/^\d+$/.test(t)) continue;
      const pid = Number(t);
      // ★ 同一把尺子：pid 若已被回收，占着它的是**无关进程** —— 报成
      //   「桩残留」是假警报，而且正是在这条断言最容易变红的时候。
      if (!isOurs(pid)) continue;
      process.kill(pid, 0);   // 不抛 = 还活着
      stragglers.push(pid);
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
