/**
 * tmux 相关的纯函数。
 *
 * 本文件刻意不依赖 vscode，以便脱离编辑器直接单测。
 *
 * 背景（实测结论，勿改）：
 * - tmux 的目标名默认做「前缀匹配」。若存在会话 `build-android`，
 *   则 `-t build` 会命中它。这会导致 attach 到错误会话、甚至
 *   `kill-session` 误杀用户正在跑的东西。因此所有目标都必须加 `=`
 *   前缀强制精确匹配。
 * - session 级命令（has-session / kill-session）用 `=name`。
 * - pane 级命令（send-keys / capture-pane / display-message）必须写
 *   `=name:`，缺冒号会失败 —— 且 display-message 失败方式是
 *   **exit 0 + 空输出**，静默无声，极难排查。
 */

import { isClaudeCommand } from './claude';

/** session 级目标，用于 has-session / kill-session */
export function sessionTarget(name: string): string {
  return `=${name}`;
}

/** pane 级目标，用于 send-keys / capture-pane / display-message */
export function paneTarget(name: string): string {
  return `=${name}:`;
}

/** 扩展自己创建的 tmux 会话的前缀。用于区分用户手工建的会话。 */
export const SESSION_PREFIX = 'tmuxterm-';

/**
 * 由条目 id 派生 tmux 会话名。
 *
 * **为什么不直接用条目的显示名当会话名：** 显示名是用户自由输入的，
 * 而 tmux 允许会话名包含换行符（实测确认）。一旦含换行，
 * `tmux ls -F '#{session_name}'` 的输出里一个会话会占据两行，
 * parseSessionList 就会解析出一个**不存在的幽灵会话**——若它恰好等于
 * 某个条目名，那个条目会错误显示为「存活」。
 *
 * 由 id 派生则从根上排除这类字符：id 是 newId() 生成的十六进制串。
 */
export function sessionNameFor(id: string): string {
  return SESSION_PREFIX + id;
}

/**
 * 格式守卫：确认一个会话名确实是由 sessionNameFor 生成的形态。
 *
 * 派生名之外的一切（尤其含 `:`、`.`、换行、纯数字）一律拒绝，
 * 作为纵深防御——万一将来有人把用户输入直接接进来，这里会拦住。
 */
export function escapeSessionName(session: string): boolean {
  return /^tmuxterm-[0-9a-f]+$/.test(session);
}

/** 解析 `tmux ls -F '#{session_name}'` 的输出 */
export function parseSessionList(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * POSIX 单引号 shell 引用。
 * 单引号内一切字符都是字面量，唯一需要处理的是单引号本身：
 * 先关引号、插入一个转义单引号、再开引号。
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * `display-message` 数值输出的公共解析：整串必须是纯十进制数字。
 *
 * 不导出 —— 各调用方（parseAttachedCount / parsePid）语义不同、JSDoc 与
 * 契约各自独立，仅解析形状一致，故只共享这一层实现。
 */
function parseNumericOrNull(stdout: string): number | null {
  const s = stdout.trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

/**
 * 解析 `#{session_attached}` 的输出。
 *
 * **空输出/非数字必须返回 null（未知），不能当成 0。** 与 isShellReady
 * 同一个坑：`display-message` 的 pane 目标漏了冒号时 tmux 是
 * **exit 0 + 空输出**，静默失败。把未知当成 0 会让「会话已附着」被误判为
 * 「没人附着」；反过来当成 1 会让「其实没人附着」被漏判 —— 后者正是本次
 * 要修的 bug（用户看到 claude 在后台跑着却看不见）。故未知单独成一个值，
 * 由调用方按保守方向处理。
 */
export function parseAttachedCount(stdout: string): number | null {
  return parseNumericOrNull(stdout);
}

/**
 * 解析 `#{pane_pid}`。
 *
 * **空输出/非数字必须返回 null（未知）** —— 与 parseAttachedCount 同一个坑：
 * pane 目标漏冒号时 `display-message` 是 **exit 0 + 空输出**，静默失败。
 * 「未知」单独成一个值，由调用方按保守方向处理；绝不能当成 0 或某个 pid。
 */
export function parsePid(stdout: string): number | null {
  return parseNumericOrNull(stdout);
}

const LOGIN_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish', 'ksh', 'tcsh', 'csh']);

/**
 * 判断 tmux pane 的前台进程是否是登录 shell —— 即「会话已就绪，
 * 可以安全 send-keys」。
 *
 * 空串必须判为未就绪：那是 display-message 目标写错时的返回值，
 * 若当成就绪会一路静默跳过所有预设命令。
 */
export function isShellReady(currentCommand: string): boolean {
  const cmd = currentCommand.trim();
  if (cmd.length === 0) return false;
  const base = cmd.split('/').pop() ?? cmd;
  return LOGIN_SHELLS.has(base.replace(/^-/, ''));
}

/** claude 还没给对话起具体任务名时的占位符 —— 视为「没有任务名」，调用方不应据此显示徽章。 */
export const DEFAULT_TASK_TITLE = 'Claude Code';

/**
 * pane title 前导字符是否是 claude 用来表示「正在运行」的旋转指示符。
 *
 * **这只是老版本 claude 的兼容判据 —— 新版本 claude 的 title 不再轮转。**
 * 2026-10-12 实测：22 个 `tmuxterm-*` 会话、30 秒内 13059 轮采样 / 287298 次
 * 读取，pane title 首字符**恒为 `✳`(U+2733)，Braille 分区命中 0 次**；其中
 * 确实在执行的（正在跑 subagent 的）也一样是 `✳`。所以本函数对新版本**永不
 * 返回 true**，真正的「在运行」判据是 `activityTracker.ts` 里的 **pane 内容
 * 差分**（窗口见那边导出的 ACTIVITY_WINDOW_MS）。
 *
 * 保留本函数与它的调用（`ActivityTracker.poll` 里作为 `running` 的 OR 一项）是
 * 零成本的老版本兜底：旧版 claude 把 pane title 设成 `<指示符> <文字>`，运行中
 * 前导字符在 Braille 点阵字符（U+2800–U+28FF）之间轮转（实测抓到 ⠐/⠂ 约每
 * 1.5s 切换一次）；空闲时固定为 ✳ 之类的普通符号，不在这个 Unicode 分区。
 * 只认分区、不锁定具体字符，避免字符集变化就失效。
 */
export function isRunningTitle(title: string): boolean {
  const trimmed = title.trim();
  if (trimmed.length === 0) return false;
  const code = trimmed.codePointAt(0);
  return code !== undefined && code >= 0x2800 && code <= 0x28ff;
}

/**
 * 从 pane title 里取任务名。
 *
 * claude 把 title 设成 `<指示符> <文字>`（指示符见 isRunningTitle），此时剥掉
 * 指示符。**判据除了「首码点不是字母/数字」，还要求它后面跟空白（或本身就是
 * 串尾）** —— 否则任何标点开头的标题都会掉一个字符：`-bash` → `bash`、
 * `~/proj` → `/proj`、`/home/user` → `home/user`（与「首码点是字母」是同一类
 * bug，只是更窄）。shell 自己设的标题（claude 退出后 bash 会把它设成
 * `user@host:cwd`）原实现无条件 `chars.slice(1)` 削成 `iansenwei@H:~/workspace`；
 * 连 `bash` 都被削成 `ash`（实测）。
 *
 * 占位符 DEFAULT_TASK_TITLE（还没起具体任务名）与空串一律返回空串 ——
 * 调用方据此判断「没有任务名可显示」，转而走 aiTitle 回退。
 */
export function taskNameFromTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) return '';
  const chars = [...trimmed];
  const first = chars[0];
  const isIndicator = !/[\p{L}\p{N}]/u.test(first);
  const followedByBreak = chars.length === 1 || /\s/.test(chars[1]);
  const name = (isIndicator && followedByBreak ? chars.slice(1).join('') : trimmed).trim();
  return name.length === 0 || name === DEFAULT_TASK_TITLE ? '' : name;
}

/**
 * 一次 `display-message` 里五个字段之间的分隔符。
 *
 * **为什么不用控制字符（U+001F）—— 实测踩到的坑，勿改回去：** tmux 3.4 的
 * `display-message -p` 会把格式串里出现的控制字符**转义成八进制字面量**再输出：
 * 格式串里放一个真实的 0x1F，拿回来的却是四个可打印字符 `\037`（与直接在格式串
 * 里写 `\037` 的输出逐字节相同）。于是「拿不可打印字符当分隔符」这条常规做法在
 * 这里失效 —— 那个字节根本不会以它自己的身份出现在输出里。
 *
 * **可打印的定串 token 反而安全**，靠两层保证：
 * 1. 它是 23 个字符的固定串，`pane_current_command`（进程 basename）不可能正好
 *    含它 —— 而它是**唯一**可能自带该 token 的字段：另三个字段（宽/高/光标行）都是
 *    纯数字、不可能含它，标题是尾字段。parsePaneSample 按**前四个**分隔符切，所以即便
 *    命令字段被截短，也只是让 `isClaudeCommand` 判否 —— 方向是「不显示任务名」，
 *    安全侧；标题自带 token 也只伤到它自己那一段。
 * 2. 实测 tmux 对可打印文本逐字节透传（中文、`|`、反斜杠都不动）。唯一会变的
 *    是 `#{…}` 形态的元字符（会被再展开一次、整段消失）—— 那是**改前就有**的行为
 *    （原 paneTitle 走同一条 display-message），与本次闸门无关。
 */
export const PANE_SAMPLE_SEPARATOR = '__tmuxterm_field_sep__';

/** 一次采样拆出的五个字段（见 TmuxClient.paneSample）。 */
export interface PaneSample {
  /** 前台进程名 `#{pane_current_command}`；'' 表示未知。 */
  foreground: string;
  /** pane 标题 `#{pane_title}`；'' 表示未知。 */
  title: string;
  /** pane 宽度 `#{pane_width}`；0 表示未知。用于识别「内容变化其实是 resize 重排」。 */
  width: number;
  /** pane 高度 `#{pane_height}`；0 表示未知。用于识别「内容变化其实是 resize 重排」。 */
  height: number;
  /** 光标所在行（0 基，相对 pane 可视区顶部）；-1 表示未知。 */
  cursorY: number;
}

/** 采样读不出任何东西时的值：五个字段都是「未知」。 */
export const UNKNOWN_PANE_SAMPLE: PaneSample = { foreground: '', title: '', width: 0, height: 0, cursorY: -1 };

/** 解析 pane 宽/高的一个字段：纯数字才取值，空串/非数字一律 0（未知），绝不给 NaN。 */
function parseDimension(raw: string): number {
  return /^\d+$/.test(raw) ? Number(raw) : 0;
}

/**
 * 解析 `#{cursor_y}`：纯数字才取值，空串/非数字一律 **-1**（未知）。
 *
 * **为什么未知不能用 0：** 0 是合法的真实光标行号（光标停在 pane 可视区最上面那
 * 一行）。若拿 0 当「未知」，下游——activityTracker 的「打字不算活动」判定，它用
 * `cursorY >= 0` 判「光标行已知」——就会把「读不到光标行」当成「光标在第 0 行」，
 * 于是对第 0 行内容的变化误判成「用户在打字」而漏掉一次真活动。故未知/非法单独用
 * -1 表达，与任何真实行号都不重叠。与 parseDimension 的「0 = 未知」约定刻意不同，
 * 那种形状（宽/高）里 0 不是合法值，这里 0 是。
 */
function parseCursorY(raw: string): number {
  return /^\d+$/.test(raw) ? Number(raw) : -1;
}

/**
 * 解析
 * `#{pane_current_command}<SEP>#{pane_width}<SEP>#{pane_height}<SEP>#{cursor_y}<SEP>#{pane_title}`。
 *
 * 一次 display-message 同时取回五个字段，是为了**不额外多起一个 tmux 进程**：
 * 采样循环每 ≈900 ms 对每个条目跑一次（extension.ts 的
 * ACTIVITY_POLL_INTERVAL_MS），拆开是这一层实打实的开销；何况五个字段本就来自
 * 同一个 pane 的同一瞬间，分开取还多一个「字段之间不同步」的窗口。尺寸也要一起
 * 取，是因为 resize 会让 capture-pane 的输出**整体变化**，尺寸是识别「这轮内容
 * 变化其实是重排、不是应用在跑」的唯一低成本信号。
 *
 * **字段顺序把 `title` 放最后、宽/高与光标行夹在中间。** 唯一的理由见
 * PANE_SAMPLE_SEPARATOR 注释：title 是唯一可能自带该 token 的字段，放尾段才伤不到
 * 前四个字段的切分；命令与宽/高/光标行（纯数字）都不可能含 token。
 *
 * **只按前四个分隔符切。** 万一标题自带同一个 token，按前四个切时它留在标题
 * 那一段里、五个字段仍各归各位；命令字段被截短只会让 `isClaudeCommand` 判否
 * —— 方向是「不显示任务名」，安全侧。
 *
 * **宽/高的 0 = 未知、光标行的 -1 = 未知。** 空串/非数字的宽/高一律给 0（不给
 * NaN），交给调用方判「几何不可信、跳过 resize 判定」；光标行同理但用 -1，因为 0
 * 是合法行号（见 parseCursorY 注释）。
 *
 * **畸形响应（缺任一分隔符、空输出）返回五个字段全未知**，不抛错、也不把整串当
 * 标题：空输出正是 display-message 的 pane 目标写错时的形态（exit 0 + 空，见本文件
 * 顶部注释），此时「未知」必须显式表达，由调用方按安全侧处理。
 */
export function parsePaneSample(stdout: string): PaneSample {
  const text = stdout.trim();
  const sepLen = PANE_SAMPLE_SEPARATOR.length;
  const i1 = text.indexOf(PANE_SAMPLE_SEPARATOR);
  if (i1 < 0) return { ...UNKNOWN_PANE_SAMPLE };
  const i2 = text.indexOf(PANE_SAMPLE_SEPARATOR, i1 + sepLen);
  if (i2 < 0) return { ...UNKNOWN_PANE_SAMPLE };
  const i3 = text.indexOf(PANE_SAMPLE_SEPARATOR, i2 + sepLen);
  if (i3 < 0) return { ...UNKNOWN_PANE_SAMPLE };
  const i4 = text.indexOf(PANE_SAMPLE_SEPARATOR, i3 + sepLen);
  if (i4 < 0) return { ...UNKNOWN_PANE_SAMPLE };
  return {
    foreground: text.slice(0, i1).trim(),
    width: parseDimension(text.slice(i1 + sepLen, i2).trim()),
    height: parseDimension(text.slice(i2 + sepLen, i3).trim()),
    cursorY: parseCursorY(text.slice(i3 + sepLen, i4).trim()),
    title: text.slice(i4 + sepLen).trim(),
  };
}

/**
 * 输入框的上下边框。两种形态共用这一条：
 * - 纯连字符：`──────────────`
 * - 带任务标题（claude 2.1.x 实测）：`────…──── <任务标题> ─`，标题夹在连字符之间。
 *   **0.2.15 修 bug 的依据**：槽 `tmuxterm-e1558e3e6065` 的上边框是 231 列、
 *   前 207 个 `─` + ` expose-vulkan-objects ` + 末尾 1 个 `─`。旧正则（整行只有连字符）
 *   不匹配它，导致两件事：`liveStatusRegion` 定位失败 → 退回全屏搜 → 正文里残留的
 *   `✻ Waiting for 1 background agent to finish` 把已结束的槽永久钉成 running；
 *   以及这行不参与 strip → 任务结束后标题异步落地时把这行改掉 → 已完成的槽又变绿。
 * 标题里只会出现 ASCII 连字符（`-`），不会出现 U+2500，所以 `[^─]*` 足够。
 */
const PANE_BORDER_RE = /^\s*─{5,}(?:\s+\S[^─]*─*)?\s*$/;

/** claude 的输入行（`❯`，钉在底部）。`VOLATILE_CHROME` 与底部结构定位共用这一条。 */
const PANE_INPUT_RE = /^\s*❯/;

/**
 * 匹配「自己会跳动的装饰行 / 界面行」—— 差分前必须剔掉。
 *
 * 认七类 claude TUI 底部/输入框附近的界面行，它们的**真实形态**（原样取自实测
 * 抓下的 pane 内容）：
 * - 上下文提示行：`90% context used` / `91% context used`
 * - 状态行：`🤖 Opus 5 │ 🌿 main │ 🧠 162.2k/200.0k 81.1% │ 💰 $33.34 / 剩$241.71`
 * - 输入框的上下边框：`────────────────────`
 * - 输入行：`❯ 你` / `❯ 改成浮层居中，组合区放到行中间 30%`
 * - 模式行：`  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent`
 * - `/clear` 提示行：`       new task? /clear to save 411.9k tokens`（会在有/无之间闪）
 * - 菜单提示行：`Enter to select · Tab/Arrow keys to navigate · Esc to cancel` —— 实测至少
 *   三种拼法（后缀 `· ctrl+g to edit in Vim`、`· ↑/↓ to navigate · n to add notes ·
 *   Tab to switch questions` 都会变），所以只认共同前缀 `Enter to select · `
 *
 * **为什么必须剔：** 2026-10-13 实测（22 个 `tmuxterm-*` pane × 45 拍 × 2 秒）
 * 发现「已经看过的终端白点会莫名其妙变绿」。根因就是这些行 —— 只要有后台
 * agent / subagent 在烧 token，它们就会自己跳动，被内容差分误判成「对话区有
 * 新内容」，于是判 running、5 秒后落成绿色的「刚完成，等待查看」。最硬的一条
 * 证据：那 22 个 pane 里 19 个 54 秒内容**逐字节没变**、从不误报；唯一反复误报的
 * `tmuxterm-010db8e2f02c` 全程**只有第 67 行和第 71 行在变**，而这两行正是上面
 * 这些装饰行，对话区一个字都没动。
 *
 * **为什么按内容特征匹配、不按行号切：** 行号随 pane 高度变（`pane_height`
 * 会因窗口 resize 而变，TUI 底部这些行的绝对行号跟着整体上移/下移），拿行号
 * 当锚点必然飘；而这些行的内容特征（`💰` / `🧠` / `context used|left` / `❯` /
 * `⏵⏵` / 纯边框）与对话区文本几乎不可能撞车，稳定且与布局无关。
 *
 * **为什么现在要剔最后一行 `⏵⏵ bypass permissions on … · ← 1 agent`（旧版刻意保留）：**
 * 实测发现整段后缀 `· ← 1 agent` 会自己**在有 / 无之间来回闪**（同一个空闲会话
 * 反复切换），只认前缀 `⏵⏵` 会把「有 agent」和「无 agent」两态误当成内容变化。
 * 而「后台 agent 在跑」这个真信号其实由**输入框下方**的 agent 进度行
 * （`◯ deepseek-coder  …`）承担，那行不在本剔除范围内 —— 剔掉模式行不丢这个判据。
 *
 * **新增证据（2026-10-13，修残余假绿）：** 长跑抓到唯一一次残余假绿，发生在当时只有装饰行在变的
 * 会话 `tmuxterm-010db8e2f02c` 的 19:02:11，只有两行在来回切换（原文，未截断）：
 * ```
 * sL68  "❯ 改成浮层居中，组合区放到行中间 30%"  ->  "❯ 你"
 * sL70  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent"  ->  "  ⏵⏵ bypass permissions on (shift+tab to cycle)"
 * ```
 * （下一拍又切回去。）两行都不匹配旧正则，于是被判成「对话区有新内容」→ running。
 * 480 对变化快照回放验证新规则：当时只有装饰行在变的 `010db8e2f02c` 从 2 次误判降到 **0**；
 * 三个真在跑的会话（`9c7f8dec316f` 171 次、`7e7059180e5c` 171 次、
 * `e1558e3e6065` 136→123 次）**一个真信号都没丢** —— 它们仍在变的行是忙碌转轮行
 * `✻ Bunning… (2m 38s · ↓ 25.1k tokens · thinking)` 和子 agent 进度行
 * `◯ deepseek-coder  改矩阵用例到新插入语义`，都是真在干活。
 *
 * **两类已知代价（刻意的取舍，不省略）：**
 * - 输入行 `/^\s*❯/` 是**按内容**匹配的，对话区里 claude 回显用户提问也可能以
 *   `❯` 开头（实测 `9c7f8dec316f` 第 39 行就是），这类行会被一并剔掉。代价可接受：
 *   真实输出是多行块，且 TUI 每次重绘都改输入行、它远比对话行频繁；反过来的风险
 *   （漏一次活动信号）远小于假绿的危害。
 * - 边框 `/^\s*─{5,}\s*$/` 要求整行只有连字符；实测有的瞬间只认得出上下边框之一
 *   （`e1558e3e6065` 只匹配到一条），所以**不能依赖边框定位**，六个正则各自独立
 *   生效，输入行 / 模式行这两条才是修本次 bug 的关键。
 */
const VOLATILE_CHROME: readonly RegExp[] = [
  /💰|🧠|context (used|left)/, // 状态行 + 上下文提示行
  PANE_BORDER_RE, // 输入框的上下边框
  PANE_INPUT_RE, // 输入行
  /⏵⏵|shift\+tab to cycle/, // 模式行
  /new task\? .*\/clear to save/, // 输入框下方的 /clear 提示行
  /Enter to select · /, // 菜单提示行（实测三种拼法共用此前缀）
];

/**
 * 右下角「状态提示行」——自己出现、几秒后又自己变回空行的一类装饰。
 *
 * **为什么这一族不能走 VOLATILE_CHROME 的删行路线：** 它的另一态是**同一行上的
 * 空行**，删掉提示行会让内容少一行、基线里那行空行还在，差异依然存在。
 * 实测（3 对真实快照）：删行 **0/64** 有效，清空成空串 **4/64** 有效。
 * 所以这一族一律「清空成空行」—— 行数不变，闪烁前后完全相等。
 *
 * **为什么只有这三条（2026-10-13，7711 对变化快照全量回放）：** 统计「整对变化
 * 完全只由提示行构成」（= 纯粹假绿，无任何真活动混入）的形态，只有
 * `Auto-updating…`(6/6)、`✔ Update installed · Restart to apply`(24 次里 2 次)、
 * `● high · /effort`(6 次里 1 次) 命中。而 `10% until auto-compact`(391 次)、
 * `Notes: press n to add notes`(47 次) **从不单独变化**，永远伴随真活动 ——
 * **不要**把它们加进来，剔了会丢真信号。
 *
 * 行首 `\s{4,}` 是为了只认「右对齐的提示行」，避免误伤正文里引用这些字样
 * 的左对齐行（实测快照里就有 claude 正文回显这些词的情况）。
 */
const VOLATILE_HINTS = /^\s{4,}(?:Auto-updating…|✔ Update installed · Restart to apply|● high · \/effort)\s*$/;

/**
 * 剔除 pane 内容里的「自己会跳动的装饰行」，供内容差分使用。
 *
 * 差分前必须先过这道闸门，把基线（lastContent）与当轮内容放在**同一口径**上比，
 * 否则装饰行的自行跳动会被当成对话区变化。剔除分两步，其余行的顺序与内容原样
 * 保留 —— 空行、普通对话行、含 `%` 但非装饰形状的行（如 `100% done`）都不受影响。
 *
 * - 第一步**清空**（不删）右下角状态提示行（`VOLATILE_HINTS`）：这一族的另一态是
 *   同一位置的空行，删行会让行数错位、差分依然不等，只能清成空串（见 VOLATILE_HINTS
 *   注释）。
 * - 第二步才是原有的**删掉**匹配 `VOLATILE_CHROME` 的装饰行。六个正则各自独立
 *   生效，任一行命中任一正则即被删。
 *
 * 两步顺序不可调换：清空在前，否则被删掉的行根本没机会被清空。
 */
export function stripVolatileChrome(content: string): string {
  return content
    .split('\n')
    // 先「清空」状态提示行（不能删 —— 见 VOLATILE_HINTS 注释），
    // 再走原有的「删丢」装饰行。两步顺序不要调换：清空在前，
    // 否则被删掉的行根本没机会被清空。
    .map((line) => (VOLATILE_HINTS.test(line) ? '' : line))
    .filter((line) => !VOLATILE_CHROME.some((re) => re.test(line)))
    .join('\n');
}

/**
 * 把 tmux 的**原始屏幕行号**（`#{cursor_y}`，即 `s.cursorY`）映射成
 * `stripVolatileChrome` **之后**那份内容里的行号；映射不了就返回 -1。
 *
 * **为什么必须有它（实测，2026-10-13）：** `stripVolatileChrome` 会**删掉**
 * `VOLATILE_CHROME` 命中的行，行号随之上移；而 `s.cursorY` 是删之前的原始行号。
 * 直接拿原始行号去比 strip 之后的变化行号，是**两套坐标系硬比**，实测两头都会打偏：
 * - 正例（该触发却永远不触发）：用户正在打中文时，pane `tmuxterm-1fa95c7b6d96`
 *   连续 15 拍同一形状 —— `cursor_y=68`、原始改动行 `[68]`、strip 改动行 `[64]`，
 *   光标之上恰有 4 行被删（68-4=64）。原始行号 `68` 永远不等于 strip 行 `64`，
 *   于是「打字不算活动」这条判据在**它要修的那个场景上恒不生效**。
 * - 反例（会误伤真活动）：pane `tmuxterm-5179df5692a1`、`cursor_y=65`，而原始第
 *   65 行正是**被删掉的输入行 `❯ `**；那 12 拍里唯一变化的 strip 行 index=65 其实是
 *   原始第 72 行（底部每秒重绘的子 agent 进度行 `◯ general-purpose …`）。`65===66-1`
 *   只是数值巧合，直接硬比会把一个**后台 agent 正在跑**的槽的活信号压掉。
 *
 * 算法：数出「光标之上有几行会被删」，从原始行号里减掉它。判定「会不会被删」必须与
 * `stripVolatileChrome` **完全同口径** —— 先按 `VOLATILE_HINTS` 清空、再测
 * `VOLATILE_CHROME`。⚠ `VOLATILE_HINTS` 那一族是**清空、不删行**（清成空串后也不匹配
 * 任何 `VOLATILE_CHROME`），**绝不能**计入移位，算了就会多减。
 *
 * 返回 -1（未知）的三种情形，调用方据此**不抑制**活动（宁可多判，不可漏判）：
 * - `cursorY < 0`（tmux 没给）或非整数；
 * - `cursorY >= 行数`（越界，例如 tmux 与 capture-pane 之间尺寸变了）；
 * - 光标行**自身**命中删除规则（例如空的 `❯ ` 输入行）—— 这一拍的变化不可能归因到
 *   它（它根本不在 strip 后的内容里），与其猜一个相邻行号，不如判未知。
 */
export function cursorRowAfterStrip(content: string, cursorY: number): number {
  const lines = content.split('\n');
  if (!Number.isInteger(cursorY) || cursorY < 0 || cursorY >= lines.length) return -1;
  // 与 stripVolatileChrome 同口径：先清空提示行，再测装饰行。
  const isDeleted = (line: string): boolean =>
    VOLATILE_CHROME.some((re) => re.test(VOLATILE_HINTS.test(line) ? '' : line));
  if (isDeleted(lines[cursorY])) return -1;
  let shift = 0;
  for (let i = 0; i < cursorY; i++) {
    if (isDeleted(lines[i])) shift++;
  }
  return cursorY - shift;
}

/**
 * 「还有未完成的后台工作」的全屏匹配式（单一来源）。
 *
 * 认整行形态：行首可选一个转轮字符（`✻`/`✽`/`✢`）+ 空格，再跟
 * `Waiting for <数字> background agent(s) to finish`。**复数 agents 也要认**
 * （实测 `1 background agent` 与 `2 background agents` 都出现过）。
 * 形态保持不变 —— 它同时被「只测活状态行」的新口径与「找不到结构时搜全屏」的
 * 兜底口径复用。
 */
const PENDING_ANYWHERE_RE = /^\s*(?:\S\s+)?Waiting for \d+ background agents? to finish\b/m;

/**
 * 返回 claude TUI 输入框上方那条「当前状态行」所在的候选区；定位不出结构时返回 null。
 *
 * claude TUI 的底部固定结构（`n` = capture-pane 的总行数，末尾有一个空行）：
 * ```
 * n-8        : "✻ <当前状态>"        ← 活状态行（距底部 7~10 行，实测全落在此区间）
 * n-7        : 全空格填充行
 * n-6        : ────────             ← 输入框上边框
 * n-5        : ❯ （输入行）
 * n-4        : ────────             ← 输入框下边框
 * ```
 * 所以从底部往上先找输入行（`❯`，永远钉在底部），再找它之上最近的边框行，
 * 取边框之上最近的**至多 2 条非空行**作为候选区（跳过纯空白填充行）。
 *
 * **为什么是「至多 2 条」而不是 1 条：** 实测底部固定还有一族提示行
 * （`Auto-updating…`、`✔ Update installed · Restart to apply`、`● high · /effort`）
 * 会出现在状态行与边框之间；取 2 条才能同时覆盖「状态行」和「夹在中间的那条提示行」。
 * **不要加大到 3：** 真实故障里「残留等待行 → ● Agent finished → 活状态行」这个最危险
 * 的排布下，残留行正好是第 3 条非空行，取 3 会把它重新捞回来。
 */
function liveStatusRegion(content: string): string[] | null {
  const lines = content.split('\n');
  // 输入行 = 从底部往上第一条 ❯ 行（claude 的输入框永远钉在底部）
  let iIn = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (PANE_INPUT_RE.test(lines[i])) { iIn = i; break; }
  if (iIn < 0) return null;
  // 输入框上边框 = 它之上最近的一条边框行（纯连字符或带标题的形态）
  let iTop = -1;
  for (let i = iIn - 1; i >= 0; i--) if (PANE_BORDER_RE.test(lines[i])) { iTop = i; break; }
  if (iTop < 0) return null;
  // 活状态区 = 边框之上最近的**至多 2 条非空行**（跳过纯空白行）
  const out: string[] = [];
  for (let i = iTop - 1; i >= 0 && out.length < 2; i--) {
    if (lines[i].trim() !== '') out.push(lines[i]);
  }
  return out.length > 0 ? out : null;
}

/**
 * pane 里是否还有「未完成的后台工作」——有则必须判为 running，不能判「已完成」。
 *
 * 实测的忙碌行原文（claude TUI 的活状态行之一）：
 * ```
 * ✻ Waiting for 1 background agent to finish
 * ```
 * 这种状态下 claude 这一轮**还没结束**（在等自己发起的后台 agent），但 pane 内容
 * **完全静止**（不重绘）。activityTracker 的唯一判据是「最近 5 秒内内容变过」，
 * 静止 ⇒ 5 秒后判成「刚跑完」⇒ 老终端莫名其妙变绿。
 *
 * **不能直接删掉这条判据：** 真正在等后台 agent 时 pane 是静止的，只靠「5 秒内变过」
 * 会判成「刚跑完」→ 空闲老终端变绿 —— 这正是这条判据当初存在的原因。
 *
 * **为什么旧口径（搜全屏）会永久假转圈 —— 2026-10-13 实测（本次修复的依据）：**
 * 槽 `tmuxterm-7e54badec0d4`（标题「按钮3D质感与栅格圆角调整」）在**没有任务执行**
 * 的情况下一直转圈。诊断证据：前后两拍（间隔 1.3s）`capture-pane -p` 的内容**逐字节
 * 相同**（pane 完全静止），但它第 37 行留着这么一句 —— claude 结束等待时把这句话
 * **原样印进了正文**，永久留在屏上：
 * ```
 * ✻ Waiting for 1 background agent to finish
 * ```
 * 紧接着第 39 行就是 `● Agent "提交推送朝向根因订正" finished · 26s`（已经完成了），
 * 而**当前真实状态行**在第 65 行 `✻ Brewed for 2m 24s`（空闲）。
 * 旧口径在整个可见屏里搜这句话，命中的是**历史正文里的残留副本** ⇒ 永久 running、
 * 转圈不停、也永远不会落绿（`cat` 一份快照/日志的 pane 同理）。
 * 注意「锚定行首」挡不住这份副本：claude 把等待行**整行**印进正文时，行首锚定照样命中。
 *
 * **量化（本次修复的依据）：** 活状态行距底部 **7~10 行**（20 个真实 pane 的分布：
 * 9 个 7、10 个 8、1 个 10）；那条残留的假等待行距底部 **36 行**。
 *
 * **为什么不用「只看底部 K 行」（`slice(-K)`）这种更省事的写法：** 最危险的排布是
 * 「残留等待行 / ● Agent finished / 活状态行」三行相邻 —— 真实故障里残留行只距底部
 * **3 条非空行**，任何 K ≥ 12 的窗口都会把它重新捞进来。所以必须按**输入框边框**
 * 定位，不能按行数截断。
 *
 * 实现：先按底部固定结构定位出「活状态区」（见 `liveStatusRegion`），只在这里搜；
 * 定位不出结构时退回「搜全屏」的旧口径 —— 安全侧：宁可多判 running，不会漏判活信号。
 *
 * `ponytail:` 上限：活状态区只取 2 条非空行。若将来 claude 的底部活区变得更高，
 * 真正在等的 pane 可能被漏判成空闲（→ 多亮一次绿），届时把 2 调大；
 * 但要同时给「残留行不得重新捞回」补一条用例（见 test/core/tmux.test.ts）。
 */
export function hasPendingBackgroundWork(content: string): boolean {
  const region = liveStatusRegion(content);
  if (region === null) return PENDING_ANYWHERE_RE.test(content); // 定位不出结构 ⇒ 退回旧口径（安全侧）
  return region.some((line) => PENDING_ANYWHERE_RE.test(line));
}

/**
 * 一次采样 → 任务名：**pane 前台不是 claude 就不采信 pane title。**
 *
 * 没有这道闸门时，claude 一退出、pane 前台变回 shell，title 就成了
 * `user@host:~/path` 这类提示符 —— `taskNameFromTitle` 按「pane title 权威」
 * 原样保留它（那正是修首字符误剥时想要的行为），于是三级显示的是提示符，而
 * **恰恰在此时最有用的** aiTitle 回退永远轮不到（spec §10 的取舍）。闸门把
 * 「前台不是 claude」时的任务名压成空串，回退链（tree.ts 的 taskNameFor）
 * 自然接手。
 *
 * 判据复用 `isClaudeCommand`（core/claude.ts）—— 「切模型/切 profile 会不会
 * 把控制序列打进用户进程」用的就是它，问的是同一个问题，不另立第二套
 * 「像不像 claude」的判定。
 *
 * **只闸任务名，不闸 running。** running 来自 `isRunningTitle` 对 Braille 分区
 * （U+2800–U+28FF）的判断，claude 退出后 title 变回提示符，首字符不在那个分区，
 * 本来就判否；把 running 也闸上等于改 done-unseen 状态机（core/activity.ts）
 * 的输入，超出本次范围。
 */
export function taskNameFromSample(sample: PaneSample): string {
  return isClaudeCommand(sample.foreground) ? taskNameFromTitle(sample.title) : '';
}
