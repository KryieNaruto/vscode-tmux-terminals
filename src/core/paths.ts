/** 路径与条目名校验的纯函数。不依赖 vscode。 */

/**
 * 展开开头的 `~`。
 *
 * 必须自己做：`vscode.window.createTerminal({ cwd })` 不认 `~/xxx`。
 * 只处理 `~` 和 `~/`，不从 `~user/` 里解析别人的 home —— tmux/系统
 * 会自己报错，扩展不该猜。
 */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return home + p.slice(1);
  return p;
}

/**
 * 校验条目名。返回错误消息，或 null 表示通过。
 *
 * 名字同时用作 tmux 会话名，所以限制来自 tmux：
 * - `:` 和 `.` 是 tmux 目标的层级分隔符（session:window.pane），会造成歧义
 * - 纯数字与 tmux 的会话索引（0、1、2…）冲突
 */
export function validateName(name: string, existingNames: string[]): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '名称不能为空';
  if (trimmed.includes(':')) return '名称不能包含冒号（与 tmux 目标语法冲突）';
  if (trimmed.includes('.')) return '名称不能包含点号（与 tmux 目标语法冲突）';
  if (/^\d+$/.test(trimmed)) return '名称不能是纯数字（与 tmux 会话索引冲突）';
  if (existingNames.includes(trimmed)) return `名称「${trimmed}」已存在`;
  return null;
}
