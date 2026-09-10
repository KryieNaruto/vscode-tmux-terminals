/** 启动 claude 的两种入口。差别在鉴权来源与模型，见 spec §2。 */
export type Profile = 'ccr' | 'direct';

/** 侧边栏的一个终端条目。name 仅用于显示；tmux 会话名由 id 派生。 */
export interface TerminalEntry {
  /** 短随机串，重命名时保持不变 */
  id: string;
  /** 显示名，可随意改 */
  name: string;
  /** 远端路径，支持 ~ */
  cwd: string;
  /** 决定启动命令与鉴权来源 */
  profile: Profile;
  /** 空/未设 = 用该 profile 的默认模型 */
  model?: string;
  /** 是否参与「全部恢复」 */
  autoRestore: boolean;
  /** 拖拽排序序号，从 0 递增，不保证连续 */
  order: number;
}
