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
   * 未设 = **只**表示「本功能上线前就存在的老条目」。新建条目（含复制）在
   * 创建时就分配一个 id，因此它们永远不会被弹选择框。
   *
   * **首次启动不预先钉这个 id**：新建条目第一次启动就是裸 `claude`
   * （LaunchSpec 的 `fresh`，见 core/command.ts），claude 自己开出来的那条
   * 会话由 reconcile 观测到之后回写到这里（core/reconcile.ts）—— 否则用户
   * 会先看到一个从没用过的预设 uuid。此后每次恢复才是 `--resume <id>` 接回它。
   *
   * **为什么必须由扩展自己记：** 实测 `claude --resume <uuid>` 是按 cwd
   * 作用域的，且 claude 进程不长期持有 .jsonl 的 fd，无法从
   * `/proc/<pid>/fd` 反查运行中会话的 id。用户又有多个条目共用同一个 cwd
   * （实测 4 条在 /ssd/qiansenwei/workspace、3 条在同一 strip-qt-ui 目录），
   * 靠 `/resume` 翻列表根本分不清哪个终端对应哪条对话。
   */
  conversationId?: string;
  /**
   * 上一次**已确认观测到**的活跃会话 id。
   *
   * 与 `conversationId` 的区别是语义：`conversationId` 是「下次启动要接回
   * 哪条」，可能来自自动观测、也可能来自用户手动改绑；本字段只记录「我们
   * 亲眼看到这个终端在跑哪条会话」。
   *
   * 它存在的**唯一理由**是保护手动改绑：用户趁 claude 活着把绑定改成 X 时，
   * 下一次 reconcile 会看到 live 仍是 Y —— 若只看 live，就会把 X 冲回 Y。
   * 有了它，`live === liveSessionId` 即判为「没变化」，X 得以保留。
   *
   * 未设 = 从未观测过（老条目，或本功能上线后还没触发过一次 reconcile）。
   * 只在观测到 live 变成**另一个**会话时才回写。
   */
  liveSessionId?: string;
  /** 是否参与「全部恢复」 */
  autoRestore: boolean;
  /** 拖拽排序序号，从 0 递增，不保证连续 */
  order: number;
}
