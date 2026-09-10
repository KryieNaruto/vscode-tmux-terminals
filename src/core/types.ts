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
  /**
   * 该条目**永久绑定**的那条 claude 对话（UUID，= 会话文件名）。
   *
   * 未设 = 从未启动过 claude（首次启动会用 `--session-id` 开一条并绑定），
   * 或者是从未绑定过的老条目（恢复时会弹一次选择）。
   *
   * **为什么必须由扩展自己记：** 实测 `claude --resume <uuid>` 是按 cwd
   * 作用域的，且 claude 进程不长期持有 .jsonl 的 fd，无法从
   * `/proc/<pid>/fd` 反查运行中会话的 id。用户又有多个条目共用同一个 cwd
   * （实测 4 条在 /ssd/qiansenwei/workspace、3 条在同一 strip-qt-ui 目录），
   * 靠 `/resume` 翻列表根本分不清哪个终端对应哪条对话。
   */
  conversationId?: string;
  /** 是否参与「全部恢复」 */
  autoRestore: boolean;
  /** 拖拽排序序号，从 0 递增，不保证连续 */
  order: number;
}
