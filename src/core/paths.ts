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
 * 校验条目显示名。返回错误消息，或 null 表示通过。
 *
 * **只校验显示用途**：名字不再用作 tmux 会话名（会话名由条目 id 派生，
 * 见 core/tmux.ts 的 sessionNameFor）。所以 `:`、`.`、纯数字都放行——
 * 用户想叫 "build.android" 或 "2024" 都合理。
 *
 * 只拦两类：空白名（没有意义）和含换行/回车的名字（会破坏 TreeView
 * 的单行展示）。重名也拦，因为会话名既然由 id 派生，重名就不再是
 * 技术冲突而纯粹是用户困惑，仍应避免。
 */
export function validateName(name: string, existingNames: string[]): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '名称不能为空';
  if (/[\r\n]/.test(name)) return '名称不能包含换行';
  if (existingNames.includes(trimmed)) return `名称「${trimmed}」已存在`;
  return null;
}
