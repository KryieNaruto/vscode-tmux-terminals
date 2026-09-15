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
