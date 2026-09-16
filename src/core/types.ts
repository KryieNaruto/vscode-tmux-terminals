/** 启动 claude 的两种入口。差别在鉴权来源与模型，见 spec §2。 */
export type Profile = 'ccr' | 'direct';

/**
 * 一个会话槽：一个 tmux 会话 + 它永久绑定的那条对话。
 *
 * **tmux 会话名由本槽自己的 id 派生**（sessionNameFor(slot.id) →
 * `tmuxterm-<slotId>`），与条目 id 共用同一个 newId() 命名空间。
 *
 * **v1/v2 → v3 迁移时，槽 id 一律等于原条目 id**（见 core/migrate.ts）。
 * 这是刻意的，不是偷懒：v1/v2 的 tmux 会话名就是 `tmuxterm-<entryId>`，沿用
 * 同一个 id 才能让升级后仍然**认得出用户此刻正在跑的那个旧会话**。若另发一个
 * 新 id，扩展会把它当成「不存在」→ 新建一个意图相同的会话 → 旧 claude 变成
 * 孤儿进程，两个进程同写一条 .jsonl（数据损坏级，与 core/command.ts 顶部注释
 * 里删掉 `--continue` 是同一个理由）。
 *
 * 反过来**不成立**：新建条目 / 复制品给自己的槽发一个新 id（不同于条目 id）
 * 完全合法 —— 那条「必须相等」的规则只属于迁移，因为只有迁移面对的是「别人
 * 已经拿旧 id 建好了 tmux 会话」的局面。新条目没有这个包袱，两种来源也不会撞。
 */
export interface SessionSlot {
  /** 短随机串，派生 tmux 会话名；一经创建永不改变 */
  id: string;
  /**
   * 该槽**永久绑定**的那条 claude 对话（UUID，= 会话文件名）。
   *
   * 未设 = 从未绑定过：v1 老条目迁移出来的槽（v1 没有对话这个概念），或用户
   * 手工把绑定清掉之后。新建的槽在创建时就会分配一个 id，因此它们永远不会被
   * 弹选择框。
   *
   * **首次启动不预先钉这个 id**：新建条目第一次启动就是裸 `claude`
   * （LaunchSpec 的 `fresh`，见 core/command.ts），claude 自己开出来的那条
   * 会话由 reconcile 观测到之后回写到这里（core/reconcile.ts）—— 否则用户
   * 会先看到一个从没用过的预设 uuid。此后每次恢复才是 `--resume <id>` 接回它。
   *
   * **为什么必须由扩展自己记：** 实测 `claude --resume <uuid>` 是按 cwd
   * 作用域的，且 claude 进程不长期持有 .jsonl 的 fd，无法从
   * `/proc/<pid>/fd` 反查运行中会话的 id。用户又有多个槽共用同一个 cwd
   * （实测 4 条条目在 /ssd/qiansenwei/workspace、3 条在同一 strip-qt-ui 目录），
   * 靠 `/resume` 翻列表根本分不清哪个槽对应哪条对话。
   */
  conversationId?: string;
  /**
   * 上一次**已确认观测到**的活跃会话 id。
   *
   * 与 `conversationId` 的区别是语义：`conversationId` 是「下次启动要接回
   * 哪条」，可能来自自动观测、也可能来自用户手动改绑；本字段只记录「我们
   * 亲眼看到这个槽在跑哪条会话」。
   *
   * 它存在的**唯一理由**是保护手动改绑：用户趁 claude 活着把绑定改成 X 时，
   * 下一次 reconcile 会看到 live 仍是 Y —— 若只看 live，就会把 X 冲回 Y。
   * 有了它，`live === liveSessionId` 即判为「没变化」，X 得以保留。
   *
   * 未设 = 从未观测过（迁移出来的老槽，或本功能上线后还没触发过一次
   * reconcile）。只在观测到 live 变成**另一个**会话时才回写。
   */
  liveSessionId?: string;
  /** 同一终端内的排序序号，从 0 递增，不保证连续 */
  order: number;
}

/**
 * 侧边栏的一个终端条目：一份配置（名称/目录/profile/模型/颜色）+ N 个会话槽。
 * name 仅用于显示；tmux 会话名由**槽**的 id 派生（见 SessionSlot）。
 *
 * v2 的 `conversationId` / `liveSessionId` 已**彻底下移到槽上、从本接口删除**
 * （不是留着不用）。留着就是两个真相来源，而「哪个才是当前对话」的歧义会一路
 * 渗进 tree.ts 的 tooltip、conversation.ts 的 ownersOf、taskTitles 的 prewarm
 * ——每一处都要重新裁决一次「读条目还是读槽」。删掉它，编译器会把所有需要
 * 裁决的地方一次性列出来。
 */
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
   * 二级行首竖线的颜色（`#rrggbb`，小写）。未设 = 中性竖线。
   * 只由 setColorInteractive 写入，且**必过 normalizeHexColor** —— 否则
   * 同一个颜色会在清单里出现两种写法、图标也会落成两个文件。
   */
  color?: string;
  /**
   * 该终端下的全部会话槽，**可以是空数组**（= 这个终端还没建过会话，例如用户
   * 把会话都删了之后）。已按 order 升序排好 —— 归一化在 EntryStore.load() 里做，
   * 所以 tree / batchTree / terminalManager 拿到的都已经是排好序、无负数 order 的。
   *
   * **声明成必需字段（不是 `sessions?`）**：`migrateEntry` 保证任何进入内存的
   * 条目都有它，声明成必需能让「忘了给新条目建会话」在**编译期**就报错。
   * `Partial<TerminalEntry>` 补丁不受影响，所以槽级写入（updateSession）照常。
   */
  sessions: SessionSlot[];
  /** 是否参与「全部恢复」 */
  autoRestore: boolean;
  /** 拖拽排序序号，从 0 递增，不保证连续 */
  order: number;
}
