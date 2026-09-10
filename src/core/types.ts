/** 侧边栏的一个终端条目。name 同时是 tmux 会话名，二者一一对应。 */
export interface TerminalEntry {
  /** 短随机串，重命名时保持不变 */
  id: string;
  /** 显示名 + tmux 会话名 */
  name: string;
  /** 远端路径，支持 ~ */
  cwd: string;
  /** 仅在「新建会话」时执行 */
  commands: string[];
  /** 是否参与「全部恢复」 */
  autoRestore: boolean;
}
