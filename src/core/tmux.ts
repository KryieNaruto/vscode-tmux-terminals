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
