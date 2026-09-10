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

/** claude 找不到那条对话时的报错（实测原文）。 */
const NO_CONVERSATION = /no conversation found/i;

/**
 * 判断 `--resume` 是不是没接上。
 *
 * 会话文件不在该 cwd 下时，claude 会打印
 * `No conversation found with session ID: ...` 然后**直接退出**，pane 退回
 * 裸 shell。不主动看一眼的话，用户只会觉得「又没接上」，无从知道原因。
 *
 * **只匹配末尾几行**（默认 5 行）。pane 里可能有更早的输出 —— 上一轮失败
 * 留下的同一句、用户自己 grep 过的日志 —— 全都可能命中这个词。只看底部
 * 才能不误报。空 pane（capture-pane 读不到）一律判为「没失败」：宁可漏报，
 * 也不要因为读不到就弹错误框。
 */
export function resumeFailed(paneText: string, tailLines = 5): boolean {
  const lines = paneText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  return NO_CONVERSATION.test(lines.slice(-tailLines).join('\n'));
}
