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
 * 实测：claude 把 pane title 设成 `<指示符> <文字>`。运行中前导字符在
 * Braille 点阵字符（U+2800–U+28FF）之间轮转（实测抓到 ⠐/⠂ 约每 1.5s
 * 切换一次）；空闲时固定为 ✳ 之类的普通符号，不在这个 Unicode 分区。
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
 * 一次 `display-message` 里两个字段之间的分隔符。
 *
 * **为什么不用控制字符（U+001F）—— 实测踩到的坑，勿改回去：** tmux 3.4 的
 * `display-message -p` 会把格式串里出现的控制字符**转义成八进制字面量**再输出：
 * 格式串里放一个真实的 0x1F，拿回来的却是四个可打印字符 `\037`（与直接在格式串
 * 里写 `\037` 的输出逐字节相同）。于是「拿不可打印字符当分隔符」这条常规做法在
 * 这里失效 —— 那个字节根本不会以它自己的身份出现在输出里。
 *
 * **可打印的定串 token 反而安全**，靠两层保证：
 * 1. 它是 23 个字符的固定串，`pane_current_command`（进程 basename）不可能正好
 *    含它 —— 而它是**唯一**能破坏切分的字段：parsePaneSample 只按**第一个**分隔符
 *    切，标题是尾字段，即便自带同一个 token 也只伤到它自己那一段。
 * 2. 实测 tmux 对可打印文本逐字节透传（中文、`|`、反斜杠都不动）。唯一会变的
 *    是 `#{…}` 形态的元字符（会被再展开一次、整段消失）—— 那是**改前就有**的行为
 *    （原 paneTitle 走同一条 display-message），与本次闸门无关。
 */
export const PANE_SAMPLE_SEPARATOR = '__tmuxterm_field_sep__';

/** 一次采样拆出的两个字段（见 TmuxClient.paneSample）。 */
export interface PaneSample {
  /** 前台进程名 `#{pane_current_command}`；'' 表示未知。 */
  foreground: string;
  /** pane 标题 `#{pane_title}`；'' 表示未知。 */
  title: string;
}

/** 采样读不出任何东西时的值：两个字段都是「未知」。 */
export const UNKNOWN_PANE_SAMPLE: PaneSample = { foreground: '', title: '' };

/**
 * 解析 `#{pane_current_command}<PANE_SAMPLE_SEPARATOR>#{pane_title}` 的输出。
 *
 * 一次 display-message 同时取回两个字段，是为了**不额外多起一个 tmux 进程**：
 * 采样循环每 ≈900 ms 对每个条目跑一次（extension.ts 的
 * ACTIVITY_POLL_INTERVAL_MS），翻倍是这一层实打实的开销；何况两个字段本就来自
 * 同一个 pane 的同一瞬间，分开取还多一个「命令与标题不同步」的窗口。
 *
 * **只按第一个分隔符切。** 万一标题自带同一个 token，按第一个切时它留在标题
 * 那一段里、两个字段仍各归各位；命令字段被截短只会让 `isClaudeCommand` 判否
 * —— 方向是「不显示任务名」，安全侧。
 *
 * **畸形响应（没有分隔符、空输出）返回两个空串**，不抛错、也不把整串当标题：
 * 空输出正是 display-message 的 pane 目标写错时的形态（exit 0 + 空，见本文件
 * 顶部注释），此时「未知」必须显式表达，由调用方按安全侧处理。
 */
export function parsePaneSample(stdout: string): PaneSample {
  const text = stdout.trim();
  const at = text.indexOf(PANE_SAMPLE_SEPARATOR);
  if (at < 0) return { ...UNKNOWN_PANE_SAMPLE };
  return {
    foreground: text.slice(0, at).trim(),
    title: text.slice(at + PANE_SAMPLE_SEPARATOR.length).trim(),
  };
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
