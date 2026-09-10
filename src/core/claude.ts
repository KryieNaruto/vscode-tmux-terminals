/**
 * 判断 pane 当前前台进程是否是 claude。
 *
 * **这是安全判据，必须严格。** 扩展的「切模型 / 切 profile」会向会话发送
 * `/model ...`、`/exit` 这类控制序列。若目标不是 claude，这些字符就成了
 * 键盘输入，打进用户正在跑的进程 —— 一条 `/exit` 能毁掉一次编译。
 *
 * 判据：取路径最后一段，**以 `claude` 开头**。覆盖 `claude`、`claude.exe`、
 * `claude-direct`。
 *
 * **严禁放宽到 `node`。** claude 是 node 程序，但用户的 build、测试、
 * dev server 也大量是 node —— 把 node 纳入等于守卫失效。
 */
export function isClaudeCommand(currentCommand: string): boolean {
  const cmd = currentCommand.trim();
  if (cmd.length === 0) return false;
  const base = cmd.split('/').pop() ?? cmd;
  return base.startsWith('claude');
}
