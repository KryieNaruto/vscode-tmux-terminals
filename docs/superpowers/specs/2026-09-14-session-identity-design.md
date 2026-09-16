# 会话身份：跟随终端最后用过的会话（`/new` 后自动改绑 + 任务名回退链）

日期：2026-09-14
状态：待用户评审
关联：`2026-09-10-tmux-terminals-v2-design.md`（§15 条目 ↔ 对话绑定）、
`2026-09-10-tree-hierarchy-design.md`（三级树）。本文件不改动其内容，
是独立的一批需求；术语沿用 `README.md`（条目 / 存活 / 接回 / profile / 任务名 /
三级树）。

## 1. 背景

用户在 claude 会话里输入 `/new`（= `/clear` 的别名）开新会话后，暴露两个 bug。
它们同源：**扩展把"终端此刻在用哪条对话"当成一次性写入的静态事实，从不重解析**。

**Bug 1 —— 绑定不同步。** `TerminalEntry.conversationId`（`src/core/types.ts:32`）
只在 4 个语义写入点被写：新建（`terminalManager.ts:822`）、复制（`:854`）、
老条目一次性选择框（`:286` / `:291` / `:312`）、右键「选择要接回的对话…」
（`:340` / `:348`）。而 `resolveLaunchSpec()`（`terminalManager.ts:246-315`）
只读这个静态字段，**不做任何重解析**，然后由 `conversationCommand()`
（`src/core/command.ts:50-62`，`--resume` 在 `:56`）拼出 `--resume <id>`。
于是 `/new` 之后，下次恢复接回的仍是**最初那条**旧对话。

**第二条 `--resume` 路径（同一症状，本次一并修）。** 除 `resolveLaunchSpec` 外，
`restartClaude()`（`terminalManager.ts:596-630`）也自己拼 `--resume`：它在 `:601`
读静态 `bound = launch.conversationId`，在 `:626` 发
`conversationCommand(launch, { kind: 'resume', conversationId: bound })`，
**完全绕过 `resolveLaunchSpec`**。唯一调用点是 `:715`（`applyProfile` ←
`setProfileInteractive`）。用户流程「pane 里 `/new` → 右键切 profile →
发 `/exit`」会接回旧对话，与 Bug 1 同症状；且切 profile **不经过 §4.3 五个
触发点中的任何一个**（这正是本次把它补成第五个触发点的原因）。修复见 §5.4。

**Bug 2 —— 任务名有时候显示不出。** 三级树的第三级（任务名）唯一来源是
**实时读 tmux pane title**（`src/tmuxClient.ts:135-144` → `src/core/tmux.ts:128-134`
`taskNameFromTitle()`），无回退源。`/new` 之后新对话还没生成标题，pane title
回落成占位符 `✳ Claude Code` / `⠐ Claude Code` → `taskNameFromTitle` 返回空串
→ 第三级整行消失。

顺带查出两个真 bug，一并纳入：

- **首字符误剥**：`taskNameFromTitle` 无条件吃掉第一个码点（`core/tmux.ts:132`
  的 `chars.slice(1)`）。claude 退出后 bash 把 title 设成 `qiansenwei@H:~/workspace`，
  三级会显示 `iansenwei@H:~/workspace`。用现有编译产物实测：

  ```
  node -e "console.log(require('./out/src/core/tmux.js').taskNameFromTitle('qiansenwei@H:~/workspace'))"
  → iansenwei@H:~/workspace          # 期望 qiansenwei@H:~/workspace
  node ... taskNameFromTitle('bash') → ash
  ```

- **采样闸门竞态**：`src/extension.ts:107-109` 的 `pollActivity` 以
  `provider.isAlive` 为闸门，而该集合由慢 10s 的存活轮询 `poll()`
  （`extension.ts:78-96`，间隔读自 `:91`）异步填充 —— 激活时 `restartPolling()`
  与 `restartActivityPolling()` 并发启动，第一轮 `pollActivity` 看到的
  `provider.isAlive` 必然为空，**一个条目都不采**。

### 1.1 实测证据（本机，2026-09-14；设计依据，勿重复实验）

| # | 事实 | 实测 |
|---|---|---|
| 1 | **会话注册表**存在且可用：`~/.claude/sessions/<pid>.json` = `{pid, sessionId, cwd, startedAt, status, name, nameSource, …}` | 9 个文件。字段另有 `updatedAt`/`procStart`/`version`/`kind`/`entrypoint`。`nameSource` 实测为 `derived`，`name` 形如 `workspace-65` |
| 2 | **sessionId 变化时 claude 原地重写该文件** | `/new` 前后同一 pid 的注册表只剩新 sessionId（每 pid 一个文件，不追加） |
| 3 | **链路 pane → 注册表可解析** | `pane_pid` → 后代 `claude` 进程 → 该注册表 → `sessionId`。**实测 8/8 全部命中** |
| 4 | **`pane_pid` 是外层 shell，claude 是其后代** | `tmuxterm-e1558e3e6065`：`pane_pid=287661`（`-bash`），claude `3777899` 的 `ppid` **就是** `287661`（**直接子进程**）；`287661` 的父才是 tmux server。**但仍须沿后代下探**：一个 pane 下的 claude 后代**可能不止一个**（见第 5 条），只看直接子进程会漏 |
| 5 | **一个 pane 下可能有多个 claude 同属一条会话（孤儿进程）** | 注册表里 pid `287756`（`startedAt` 1789279289648）与 `3776947`（1789433265980）**记同一条 sessionId `39ed59e2`** —— 取新取旧结果相同。该规则的作用是给"pane 下有多个持有注册表记录的 claude 后代"这一更一般情形一个确定性 tie-break（见 §8.4），不为此孤儿场景服务 |
| 6 | **进程 argv 不可作为 live 信号** | `tmuxterm-e1558e3e6065` 的 claude 进程 argv 至今是 `--resume f355e5ce-…`（启动时写死），而它当时所在的会话是 `e71afcd8`。argv 不随 `/new` 变 |
| 7 | **漂移实例（Bug 1）** | 条目 `tmuxterm-e1558e3e6065` 绑定 `f355e5ce`，其 pane 实跑会话 `e71afcd8`（标题 `创建多引擎版 /ask 命令并统一`，与 `…/e71afcd8-….jsonl` 里的 `aiTitle` 逐字相同）。8 条条目里 **5 条的绑定 ≠ live** |
| 8 | **占位符普遍（Bug 2）** | 同一时刻 8 条条目里 **5 条**的 pane title 是 `✳ Claude Code` / `⠐ Claude Code` / `⠂ Claude Code` —— 正是第三级整行消失的状态 |
| 9 | **transcript 内有 `aiTitle`，落盘后仍在** | `~/.claude/projects/*/*.jsonl` 共 301 个会话主记录，**184 个**含 `{"type":"ai-title","aiTitle":"…"}`；与 pane title 的文本逐字相同 |
| 10 | **`ai-title` 是"追加"记录，不是头部字段** | `e71afcd8` 一个文件里出现 **21 次**，偏移 38 KB → 966 KB；**首次**出现位置 ≥64 KB 的有 **82/184**；**最后一次**距 EOF 最远 **53887 B**（< 64 KB） |
| 11 | **两个 profile 共用一个注册表** | `/usr/local/bin/claude-direct` = `exec claude --settings /etc/claude/direct.json "$@"` —— 同一二进制、同一 `~/.claude/sessions/` |
| 12 | **`/new` 写出新文件、旧文件保留** | `f355e5ce-….jsonl`（626 KB）与 `e71afcd8-….jsonl`（1.0 MB）并存，后者 mtime 更新 |

第 6 条排除了"从 `/proc/<pid>/cmdline` 反查"这条路；第 1、3 条是主方案 A 的依据；
第 4、5 条决定了进程树下探与候选去重；第 9、10 条决定了 `aiTitle` 兜底**必须读文件尾部**
（现有 `parseConversationHead` 只读头部 64 KB，对 45% 的文件会读不到）。

## 2. 澄清阶段已确认的决策

以下选项均已向用户征询并确认，不再是开放问题：

| 决策点 | 结论 |
|---|---|
| 绑定语义 | **跟随终端最后用过的会话**。`/new` 后自动改绑到新会话，无需用户操作 |
| 主方案 | **A：直读会话注册表**（pane → 进程树 → `~/.claude/sessions/<pid>.json`）。精准，每终端独立，不受"多条目共用同一 cwd"干扰 |
| 兜底方案 | **D：mtime 启发式**，但**收窄**：仅当恢复时 claude 已死、且**该 cwd 下只有这一个条目**时，才敢取同 cwd 下 mtime 最新的对话 |
| 不做 | **C（装全局 hook 改 `~/.claude/settings.json`）—— 明确否决**，不欠这份全局债。B（`fs.watch` 事件驱动）留作后续优化，**本次不做** |
| 任务名回退链 | pane title（live，权威）→ 该条目**绑定对话的 `aiTitle`**（读 transcript）|
| 全都无从得知时 | **不显示第三级（维持现状）**。不加灰色占位、不退化成 `~/.claude/sessions` 的 derived slug（如 `workspace-65`）、不用首条用户消息摘要 —— 把"不知道"伪装成"知道"是误导 |
| 手动改绑保护 | 新增每条目字段记录"上一次已确认的活跃会话"（建议命名 `liveSessionId?: string`）。**只有观测到 live 变成另一个会话时才回写**；这样你在 claude 活着时手动选了 X，不会被下一次 reconcile 冲掉 |

## 3. 会话身份层：新增 liveSession 解析

### 3.1 数据来源与进程树下探

一个 pane 的"最后用过的会话"由三段拼出：

```
tmux display-message -p -t '=<会话>:' '#{pane_pid}'     # 外层 shell 的 pid
        ↓ descendantsOf()                                # 关键：必须下探 —— claude 后代可能不止一个（证据 4、5）
   {claude 的 pid …}
        ↓ 与注册表求交（按 pid 索引）
   ~/.claude/sessions/<pid>.json  →  SessionRecord { pid, sessionId, startedAt, cwd }
        ↓ pickLiveSession()
   同一 pane 下有多个 claude 时取 startedAt 最新（确定性 tie-break，见 §8.4）
```

**纯函数与 I/O 适配层的切分**（沿用 `core/conversation.ts` ↔
`conversationFiles.ts` 的既有分工，`core/*.ts` 保持零 vscode 依赖）：

```ts
// ---------- src/core/processTree.ts（新增，纯函数，零 IO） ----------
/** `ps -eo pid=,ppid=` 的一行解析结果。 */
export interface ProcNode {
  pid: number;
  ppid: number;
}

/** 解析进程表文本。无法解析的行一律跳过，绝不抛错。 */
export function parseProcTable(text: string): ProcNode[];

/**
 * rootPid 在 table 里的**全部后代** pid（含各层，不含 rootPid 自身）。
 * 表里查不到 rootPid 时返回 []。自身成环、pid 重复等畸形输入必须安全终止。
 */
export function descendantsOf(table: readonly ProcNode[], rootPid: number): number[];
```

```ts
// ---------- src/core/liveSession.ts（新增，纯函数，零 IO） ----------
/** 一条 `~/.claude/sessions/<pid>.json` 里我们需要的字段。 */
export interface SessionRecord {
  pid: number;
  sessionId: string;
  /** claude 进程自记的启动时刻（ms）。同一 pane 下有多个 claude 后代时用它做确定性 tie-break（§8.4）。 */
  startedAt: number;
  cwd: string;
}

/**
 * 解析注册表文件。缺 `pid`/`sessionId`、非对象、非 JSON、
 * **`sessionId` 为空串或纯空白**一律返回 undefined ——
 * 这是 claude 的内部实现，**绝不容错到编造一个 id**（见 §8 不变量 5）。
 * 空串判 undefined 是必须的：否则它会一路传到 `reconcileBinding` 把绑定写成 `''`（§4.2）。
 */
export function parseSessionRecord(text: string): SessionRecord | undefined;

/**
 * 从候选里挑"这个 pane 此刻真的在用的那条会话"。
 * - 空数组 / 全是停用项 → undefined
 * - 按 `startedAt` 取**最新**；并列时按 pid 大者 → 结果确定，不随 readdir 顺序抖动
 */
export function pickLiveSession(records: readonly SessionRecord[]): SessionRecord | undefined;
```

```ts
// ---------- src/liveSessions.ts（新增，IO + 进程树；非 core，故可有依赖但不是 vscode） ----------
import type { ProcNode, SessionRecord } from './core/…';

/**
 * 一次观测的全部输入。**整批条目共用一份** —— 一次 reconcile 只 spawn 一次
 * `ps`、只 readdir 一次注册表，绝不按条目各查一遍。
 */
export interface LivenessSnapshot {
  readonly procs: readonly ProcNode[];
  /** 注册表按 pid 索引（注册表只有个位数文件、每个 ~350 B，整体读入即可） */
  readonly sessions: ReadonlyMap<number, SessionRecord>;
}

/** 读一次快照。`ps` 失败 / 注册表目录不存在都返回空快照，绝不抛。 */
export async function readLiveness(home: string): Promise<LivenessSnapshot>;

/**
 * 从快照解析出某个 pane 下"最后用过的会话"。
 * 取不到（进程表查不到 pane、没有后代 claude、注册表里没有它）→ undefined。
 * **解析不出就是解析不出，不猜**（§8 不变量 5）。
 */
export function liveSessionIn(snap: LivenessSnapshot, panePid: number): SessionRecord | undefined;
```

`TmuxClient` 增加一个只读取值，并在 `core/tmux.ts` 加它配套的解析守卫：

```ts
// src/core/tmux.ts（新增）
/** 解析 `#{pane_pid}`。空串 / 非数字（display-message 静默失败）返回 null。 */
export function parsePid(stdout: string): number | null;

// src/tmuxClient.ts（新增）
/** pane 的 pid（外层 shell）。读不出返回 null —— 与 attachedClients 同一套"未知≠0"约定。 */
async panePid(name: string): Promise<number | null>;
```

## 4. 绑定回写：reconcile 规则与触发时机

### 4.1 新增字段 `liveSessionId`

`TerminalEntry` 新增一个**可选**字段（`src/core/types.ts`），紧随 `conversationId`：

```ts
  /**
   * 上一次**已确认观测到**的活跃会话 id。
   *
   * 与 `conversationId` 的区别是语义：`conversationId` 是"下次启动要接回哪条"，
   * 可能来自自动观测、也可能来自用户手动改绑；本字段只记录"我们亲眼看到这个
   * 终端在跑哪条会话"。
   *
   * 它存在的**唯一理由**是保护手动改绑：用户趁 claude 活着把绑定改成 X 时，
   * 下一次 reconcile 会看到 live 仍是 Y —— 若只看 live，就会把 X 冲回 Y。
   * 有了它，`live === liveSessionId` 即判为"没变化"，X 得以保留。
   *
   * 未设 = 从未观测过（老条目，或本功能上线后还没触发过一次 reconcile）。
   * 只在观测到 live 变成**另一个**会话时才回写。
   */
  liveSessionId?: string;
```

**迁移是向后兼容的**：它是纯新增的可选字段，老清单文件缺它即 `undefined`，
语义恰好正确（"从未观测过"）。但**必须在 `core/migrate.ts` 的 `migrateEntry`
里显式带过去**（照抄 `conversationId` 那段，`src/core/migrate.ts:47-51`）：

```ts
    const liveSessionId = str(o.liveSessionId);
    return {
      id, name, cwd, profile,
      …,
      ...(liveSessionId !== undefined && liveSessionId.length > 0 ? { liveSessionId } : {}),
    };
```

漏这一行不是"字段丢了"这么轻 —— `migrateEntry` 是 `EntryStore.load()` 的
**唯一守门人**（`core/store.ts:93-123`），漏掉它等于每次 load 都把该字段静默吞掉，
手动改绑保护随之失效，且没有任何报错。

### 4.2 reconcile 规则（纯函数）

```ts
// ---------- src/core/reconcile.ts（新增，纯函数） ----------
/**
 * 一条条目的绑定视角。
 *
 * **命名注意**：`src/core/conversation.ts:154` 已经导出了一个
 * `interface BindingView { id; name; conversationId? }`（供 `ownersOf` 用）。
 * 这里刻意**不叫 `BindingView`** —— 形状不同，且 `terminalManager.ts` 同时
 * 需要两者，同名会直接冲突。故本接口命名 `BindingState`。
 */
export interface BindingState {
  conversationId?: string;
  liveSessionId?: string;
}

/** 需要回写的两个新值；返回 undefined = 什么都不动。 */
export interface BindingPatch {
  conversationId: string;
  liveSessionId: string;
}

/**
 * 由「当前绑定」与「这次观测到的活跃会话」算出新绑定。
 *
 *   live == null || live.trim() === ''  → undefined（观测不到就不动）
 *   live === entry.liveSessionId        → undefined（含"手动改绑后 live 未变"的情形）
 *   否则                                 → { conversationId: live, liveSessionId: live }
 *
 * 注意第一分支**必须**把 `undefined` 与空串/纯空白一视同仁：`parseSessionRecord`
 * 已把空 `sessionId` 判为 `undefined`（§3.1），但这里仍要再挡一道 —— 守卫写
 * `live === undefined` 而 `live === ''` 落到第三分支会把绑定写成 `''`（= 清空绑定）。
 * 第三分支是"这个终端确实换了一条会话"（`/new`）—— 此时连手动改绑也要让位，
 * 因为用户的手动选择已经被终端自己的行为取代了。
 */
export function reconcileBinding(
  entry: BindingState,
  live: string | undefined,
): BindingPatch | undefined;
```

对应成表：

| 观测 | 动作 |
|---|---|
| `live == null` 或空串/纯空白（会话已死 / claude 不在了 / 解析不出） | 不动 |
| `live === entry.liveSessionId` | 不动（含"手动改绑后 live 未变"） |
| 其余（live 是另一个会话） | `conversationId = live`；`liveSessionId = live` |

**手动改绑（右键「选择要接回的对话…」）只改 `conversationId`，不动
`liveSessionId`** —— `bindConversationInteractive`（`terminalManager.ts:323-363`）
的写入点保持原样，不新增字段。这样"手动选了 X，live 仍是 Y"下一次 reconcile
落在第二分支，X 不被冲掉。

### 4.3 触发时机（不引入定时器）

reconcile 只在五个**事件**上跑：

| 触发点 | 落点 |
|---|---|
| 扩展激活 | `extension.ts` 的 `activate()` 末尾，`void reconcileNow()` |
| ⟳「只重查存活状态」 | `tmuxTerminals.refresh` 处理函数：`await reconcileNow()` 后再 `provider.refresh()` |
| 点击条目 | `TerminalManager.openEntry()` 开头（见 §5.1） |
| 切 profile | `TerminalManager.restartClaude()` 开头，`await this.reconcileOne(entry)`（见 §5.4） |
| 展开树 / 面板变为可见 | `view.onDidExpandElement(() => void reconcileNow())` **与** `view.onDidChangeVisibility(() => void reconcileNow())`，都在 `activate()` 里注册 |

展开树刻意用 **`onDidExpandElement` 事件**而不是 `getChildren`：
`tracker.onDidChange(() => provider.refresh())`（`extension.ts:133`）与
900 ms 的活动轮询（`extension.ts:120`）会让根 `getChildren` 每秒跑一次，
把 reconcile 挂在 `getChildren` 上等于引入了一个 900 ms 的隐式定时器，
与"不引入定时器"相悖。

**`onDidExpandElement` 单独用不够**：它的语义是"**由用户**展开时"触发，
而 `FolderTreeItem` 默认就是 `Expanded`（`tree.ts:50`），默认展开的文件夹
节点不会发这个事件。故追加 `view.onDidChangeVisibility`（面板变为可见时）
兜底 —— `activate()` 里已有同源的 `view.onDidChangeVisibility`（`extension.ts:126-129`，
现在调 `restartPolling()` / `restartActivityPolling()`），在那里顺带
`void reconcileNow()` 即可，不新增订阅。`onDidExpandElement` 仍然保留：
用户折叠后再展开、或展开一个默认折叠的文件夹时，它仍是有效的触发。

`reconcileNow()` 用一个 in-flight 变量把并发触发合并成一次观测（多个触发点
挨在一起时只 spawn 一个 `ps`）：

```ts
// extension.ts
let reconcileInFlight: Promise<boolean> | undefined;
const reconcileNow = (): Promise<boolean> => {
  if (reconcileInFlight === undefined) {
    reconcileInFlight = (async () => {
      try {
        return await manager.reconcileAll(await store.load());
      } finally {
        reconcileInFlight = undefined;   // 本轮结束才允许下一轮
      }
    })();
  }
  return reconcileInFlight;
};
```

批量入口放在 `TerminalManager`（它同时握有 `store` 与 `tmux`）：

```ts
// src/terminalManager.ts
/**
 * 观测一批条目的活跃会话并回写绑定。返回 true = 至少写了一条。
 *
 * - 只处理「tmux 会话存活」的条目：会话都没了就没有活着的 claude 可观测，
 *   此时**绝不**去改绑定（那会让 D 兜底之外的地方凭空"猜"）。
 * - 整批共用一份 `LivenessSnapshot`：`ps` 只 spawn 一次。
 * - 每条只在 `reconcileBinding` 返回非 undefined 时写一次 `store.update`。
 * - 顺带预热任务名缓存：对每条调用一次 `titles.prewarm(entry.conversationId,
 *   entry.cwd)`（见 §6.2）。`reconcileOne` 同样预热 —— 点击是用户唯一会盯着
 *   三级看的时刻，回退名字必须在那时就位。`titles` 是**可选**构造参数。
 */
async reconcileAll(entries: readonly TerminalEntry[]): Promise<boolean>;

/**
 * 单条版本；两处触发用 —— `openEntry` 的点击（§5.1）与 `restartClaude` 的
 * 切 profile（§5.4）。
 * 返回回写后的条目（无变化时原样返回）**与本次观测到的活跃会话 id** ——
 * 后者供 `resolveLaunchSpec` 的兜底 D（§5.3）判断"claude 是不是真的不在了"，
 * 避免为了同一个判断再观测一次（多 spawn 一个 `ps`，还可能得出不一致的结论）。
 */
private async reconcileOne(
  entry: TerminalEntry,
): Promise<{ entry: TerminalEntry; live: string | undefined }>;
```

**观测的驱动者只有一个：`extension.ts`。** `EntryTreeProvider` **不**持有任何
reconciler —— 上一版设计里给它加的 `reconciler` 构造参数没有任何调用者
（五个触发点全都在 `extension.ts` 里 `reconcileNow()`），故**删除**。
provider 只保留一个纯读的 `titleFallback`（`peek` 同步、不发 IO、不触发观测），
与既有的 `store` / `activity` 参数同一处理方式（见 `tree.ts:159-174` 的注释）：

```ts
// src/tree.ts
  constructor(
    private readonly store: { load(): Promise<TerminalEntry[]>; reorder(ids: string[]): Promise<void> },
    private readonly activity?: { activityFor(entryId: string): EntryActivity | undefined },
    /** 任务名回退源（同步读内存缓存，实例化与接线见 §6.4）。省略 = 无回退。 */
    private readonly titleFallback?: { peek(conversationId: string | undefined): string | undefined },
  ) {}
```

## 5. 恢复路径改造

### 5.1 `openEntry` 先 reconcile

`openEntry(entry)`（`terminalManager.ts:384-504`）在算出 `session`/`cwd` 之后、
`resolveLaunchSpec` 之前，先把绑定刷成"这个终端最后用过的会话"：

```ts
  async openEntry(entry: TerminalEntry): Promise<void> {
    const session = sessionNameFor(entry.id);
    const cwd = this.cwdFor(entry);

    // 点击条目 = reconcile 的触发点之一。必须在 resolveLaunchSpec **之前**：
    // 它决定 --resume 哪一条，而 /new 之后正确答案已经变了。
    // 返回的可能是改绑后的新快照（后续一律用它）与本次观测到的活跃会话 id。
    const { entry: current, live } = await this.reconcileOne(entry);
    …
    const spec = await this.resolveLaunchSpec(current, live);   // 原第 485 行
```

`reconcileOne` 的前提是 **tmux 会话存在**；会话不存在时它不做任何观测，
返回 `{ entry: 原条目, live: undefined }` —— 与 §4.3 "只处理存活条目"一致
（`live: undefined` 正是 §5.3 兜底 D 的启用条件之一）。
它**不**经 `reconcileAll` 的 in-flight 合并（点击是低频动作，且用户就在等结果）。

### 5.2 `resolveLaunchSpec` 的分支变化

`resolveLaunchSpec(entry)`（`terminalManager.ts:246-315`）**只多收一个
`live` 参数**（见 §5.3 的签名），**已绑定**分支（`:249-273`）逻辑一字不改：
仍是 `findConversations()` 按 id 直查 → 不存在则 `--session-id` 建出来
（并 info 出声）→ 在本 cwd 下则 `--resume` → 在别处则报错指向
「选择要接回的对话…」。变化全部来自它现在拿到的 `entry.conversationId`
**已经是 reconcile 后的值**。

自愈效果：`/new` 之后 claude 还活着 → 注册表给出新 id → 绑定被刷成新 id →
下次恢复 `--resume` 的就是新会话。

### 5.3 兜底 D：mtime 启发式（收窄）

**新增**分支，只在**未绑定**路径上生效（即 `conversationId` 为空 —— 实际只剩
"本功能上线前的老条目"，见 `core/types.ts:17-31` 的注释）：

```ts
// resolveLaunchSpec 的签名多收一个参数。唯一调用点仍是 §5.1 的 openEntry
// —— restartClaude 也拼 --resume，但它**不走这里**（它自己拼命令，见 §5.4）：
private async resolveLaunchSpec(
  entry: TerminalEntry,
  /**
   * 本次 reconcileOne 观测到的活跃会话 id；undefined = 观测不到。
   * 空串在这里不会出现 —— `parseSessionRecord` 已把空/纯空白判为 undefined
   * （§3.1），故下面只需判 `undefined`；万一出现空串也只会落进"不启用 D"
   * 的保守侧，不会猜。
   */
  live: string | undefined,
): Promise<LaunchSpec | undefined> {
  …
  // 已有的「已绑定」分支（:249-273）一字不改，走到这里即未绑定。
  // 兜底 D（**收窄**）：A 观测不到活跃会话（claude 已死）—— 那就不存在
  // "这个终端在用哪条会话"的权威答案；此时**只有**在「该 cwd 下只有这一个
  // 条目」时才敢退回 mtime 启发式：
  //   - 单条目 → 不可能与别的条目争同一条 .jsonl，猜错也只是接回自己
  //     目录下最近用过的那条，代价可控；
  //   - 多条目共用 cwd → 猜错就是两条会话共写一条记录（数据损坏级，
  //     正是 §15.4 删掉 `--continue` 的理由），宁可弹框问。
  //
  // 唯一性判据必须按 **cwdFor() 展开后的路径**比较，而不是原始串：
  // cwd 支持 `~`（types.ts:11 的注释、core/paths.ts 的 expandHome），
  // 同一批条目里 `~/x` 与 `/home/u/x` 原始串不相等、展开后是同一个目录 ——
  // 按原始串判会**各自**满足"只有我一个"，两个条目都走 D、都 --resume 到
  // 同一条 .jsonl，恰好击穿 D 自己要防的数据损坏。展开路径也正是真正启动时
  // 用的那个目录（`cwdFor` 同时喂给 newSession 与 belongsToCwd）。
  const soleInCwd = (await this.store.load()).filter((e) => this.cwdFor(e) === cwd).length === 1;
  if (live === undefined && soleInCwd) {
    const candidates = candidatesForCwd(await listConversations(this.home()), this.cwdFor(entry));
    if (candidates.length > 0) {
      // 与"手动改绑"同一侧：**只写 conversationId，不动 liveSessionId**
      //（这是推断，不是观测，不该冒充观测值，§8 不变量 3）
      await this.store.update(entry.id, { conversationId: candidates[0].id });
      return { kind: 'resume', conversationId: candidates[0].id };
    }
  }
  // 落到原有分支：enqueuePick 弹一次 QuickPick（:280-314），一字不改
```

> 注意"未绑定 + claude 还活着"根本到不了这里：`reconcileOne` 的**首观测**
> 规则（`liveSessionId` 为空、`live` 有值 → 回写两者）已经把它绑上了。
> 所以 D 分支面对的一定是"claude 真的不在了"这一种情况。

判据里"同一个 cwd"这里有**两种口径**，不能混：

- **分组键**（三级树一级）仍按**原始串** `groupByCwd`（`core/grouping.ts`），
  保持不变 —— 树怎么分组不属本次改动。
- **D 的"唯一性"判据**必须按 `cwdFor()` **展开后的路径**，如上面的代码块。
  理由见那里的注释：`~/x` 与 `/home/u/x` 原始串不同却指向同一目录，按原始串
  判会让两个条目各自"唯一"，双双走 D 并 `--resume` 到同一条 `.jsonl`。
  展开路径也正是条目真正启动时用的目录，两者同源才不会错位。

其余未绑定路径（`:280-314` 的 `enqueuePick` 整段：弹 QuickPick → 确认模态 →
写绑定）保持不变，仍是唯一需要问用户的场合。

### 5.4 `restartClaude` 先 reconcile（切 profile 路径）

`restartClaude(entry, launch)`（`terminalManager.ts:596-630`）是**第二条**
拼 `--resume` 的路径，绕过 `resolveLaunchSpec`（见 §1 的 Bug 1）。它在 `:601`
读静态 `bound = launch.conversationId`，若为空则拒绝重启（`:602-608`），
否则在 `:626` 发 `conversationCommand(launch, { kind: 'resume', conversationId: bound })`。

改法：**在发 `/exit` 与拼 `--resume` 之前**，先对**这一个条目**做一次 reconcile，
用 reconcile 后的绑定去拼命令（复用 §4.3 的单条目入口 `reconcileOne`，
它就是为"单条、低频、不经 in-flight 合并"设计的）：

```ts
  private async restartClaude(
    entry: TerminalEntry,
    launch: TerminalEntry,
  ): Promise<boolean> {
    const session = sessionNameFor(entry.id);

    // 切 profile 也是 reconcile 的触发点（§4.3）。必须 `--resume` 之前做：
    // 用户刚在 pane 里 /new 过，静态 conversationId 已经不是终端在用的那条。
    // 只观测 entry（会话归属由 id 派生），launch 的 profile/model 覆盖不受影响。
    const { entry: current } = await this.reconcileOne(entry);
    const bound = current.conversationId;
    if (bound === undefined || bound.length === 0) { /* 原拒绝分支，一字不改 */ }

    // …原 hasSession / canSendControl / sendLiteral('/exit') / waitForShell 不变…

    await this.tmux.sendLiteral(
      session,
      conversationCommand({ ...launch, conversationId: bound }, { kind: 'resume', conversationId: bound }),
    );
    await this.tmux.sendEnter(session);
    await this.warnIfResumeFailed(session, entry);
    return true;
  }
```

要点：

- **改的是绑定，不是 profile/model**：`launch` 是调用方构造的覆盖层
  （`applyProfile` 传 `{ ...entry, profile, model: undefined }`，`:715`）。
  reconcile 只用来更新 `conversationId`，再把 `current.conversationId` 合并回
  `launch`；`launch.profile` / `launch.model` 原样保留。
- **守卫用 reconcile 后的值**：`reconcileOne` 可能把原本未绑定的条目绑上
  （首观测规则），此时 `bound` 有值、守卫放行 —— 这正是"切 profile 时终端
  确实在用某条会话"的正确行为，比原来直接拒绝更准。观测不到（claude 已死 /
  会话不存在）时 `current.conversationId` 不变，未绑定仍按原逻辑拒绝。
- **`reconcileOne` 是只读观测**：它只发 `ps` / 读注册表，`send-keys` 是
  `restartClaude` 自己原有的职责，不违反 §8 不变量 9。
- 与 `openEntry`（§5.1）一样，这里**不**经 `reconcileAll` 的 in-flight 合并。

## 6. 任务名来源链

### 6.1 pane title 解析修正（首字符误剥）

`taskNameFromTitle`（`core/tmux.ts:128-134`）改为**只在首码点确实是指示符时才剥**：

```ts
/**
 * 从 pane title 里取任务名。
 *
 * claude 把 title 设成 `<指示符> <文字>`（指示符见 isRunningTitle），此时剥掉
 * 指示符。但**首码点是字母/数字时绝不能剥** —— 那是 shell 自己设的标题
 * （claude 退出后 bash 会把 title 设成 `user@host:cwd`），原实现无条件
 * `chars.slice(1)` 把它削成了 `iansenwei@H:~/workspace`；连 `bash` 都会被
 * 削成 `ash`（实测）。
 *
 * 占位符 DEFAULT_TASK_TITLE（还没起具体任务名）与空串一律返回空串 ——
 * 调用方据此判断"没有任务名可显示"，转而走 aiTitle 回退（§6.2）。
 */
export function taskNameFromTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) return '';
  const chars = [...trimmed];
  const first = chars[0];
  const isIndicator = !/[\p{L}\p{N}]/u.test(first);
  const name = (isIndicator ? chars.slice(1).join('') : trimmed).trim();
  return name.length === 0 || name === DEFAULT_TASK_TITLE ? '' : name;
}
```

回归用例（必须全部进入 `test/core/tmux.test.ts`）：

| 输入 | 期望 | 说明 |
|---|---|---|
| `⠐ 创建多引擎版 /ask 命令并统一` | `创建多引擎版 /ask 命令并统一` | 已有行为，不许回归 |
| `✳ Claude Code` | `''` | 占位符 |
| `⠐ Claude Code` | `''` | 占位符（运行中但还没起名） |
| `✳` | `''` | 只剩指示符 |
| `qiansenwei@H:~/workspace` | `qiansenwei@H:~/workspace` | **本次修复** |
| `bash` | `bash` | **本次修复**（原为 `ash`） |

`isRunningTitle`（`core/tmux.ts:114-119`）不改：它只认 Braille 分区
（U+2800–U+28FF），`qiansenwei@…` 的首字符 `q` 不在其中，判为空闲 —— 方向本来
就是对的。

### 6.2 aiTitle 兜底

**读取策略：读文件尾部，不是头部。** 证据 10 表明 `ai-title` 是**追加**记录，
首次出现位置有 82/184 落在 64 KB 之后，而**最后一次**距 EOF 最远 53887 B。
因此从**尾部**读一个 64 KB 的窗口即可全覆盖（184/184），并取**最后一条**
`aiTitle`（实测 7/184 个文件的标题真的变过，取最后一条才是当前标题）。

尾部窗口**单独起一个常量** `TAIL_BYTES`，**不复用 `HEAD_BYTES`**：名字里的
HEAD 是"读头部"的意思，拿它去做尾部读会让下一个读者以为这里还在读头部。
两者数值相同（`64 * 1024`）纯属巧合 —— 它们是两个独立的容量决定。

```ts
// ---------- src/core/conversation.ts（新增纯函数） ----------
/**
 * 从一段（通常是**尾部**）jsonl 文本里取**最后一条** ai-title 记录。
 * 一条都没有 / 解析不出 → undefined。
 *
 * 容错是契约。注意**截断位置在窗口的首行、不在末行** —— 尾部读是 seek 到
 * 文件中段开始的，第一条记录只有后半截；而末行一直写到 EOF，是完整的。
 * 故"跳过解析不出的行"这条规则同时覆盖两者，但别把它理解成"末行不可信"。
 */
export function parseAiTitle(text: string): string | undefined;
```

```ts
// ---------- src/conversationFiles.ts（新增 IO） ----------
/**
 * 尾部读取窗口。**不是** HEAD_BYTES 的别名 —— 语义不同（这里读文件尾），
 * 数值相同只是巧合，各自独立演进。
 */
const TAIL_BYTES = 64 * 1024;

/** 读文件**尾部** bytes 字节（文件更短时返回全部）。 */
async function readTail(file: string, bytes: number): Promise<string>;

/**
 * 按 id + cwd 精确定位会话文件（读头确认 cwd 归属，复用 parseConversationHead
 * 与 belongsToCwd）。找不到返回 undefined —— 绝不靠目录名转义规则反推。
 */
export async function findConversationFile(
  home: string,
  id: string,
  cwd: string,
): Promise<string | undefined>;
```

> **为什么与既有的 `findConversations(home, id)`（`conversationFiles.ts:82`）重复一部分？**
> **有意重复，不复用。** 两者都在 `~/.claude/projects/*/` 里 readdir + 读文件，
> 但 `findConversations` 的返回形状是**cwd 字符串数组**，不含文件路径 —— 而
> `findConversationFile` 必须拿到**文件路径**才能 seek 到尾部读。想复用它就得改
> 它的签名，牵动既有 3 个调用点；而它还要为此维护"路径 ↔ cwd"两套返回，得不偿失。
> 两者遵守同一套约定：**目录名只用来找文件，归属一律以文件内记录的 `cwd` 字段为准**
> （`conversationFiles.ts:15-17` 的文件头注释）。重复的量也很小（一层 readdir + 一次头部读）。

```ts
// ---------- src/taskTitles.ts（新增：内存缓存 + 读尾取 aiTitle） ----------
/**
 * 绑定对话的 aiTitle 只读一次，缓存在内存里。
 *
 * **为什么不每次 poll 都读**：活动轮询是 900 ms 一轮（`extension.ts:18`），
 * 每轮为每个条目 tail-read 一个可能上 MB 的 transcript 是不可接受的。
 * 缓存在 **reconcile 时**预热（那时本来就在查注册表），渲染路径只剩一次
 * Map 命中（`peek` 是同步的）。
 *
 * **模型：异步预取 + 同步 peek。** `prewarm` 只发起后台读、立即返回；
 * `peek` 是纯内存查表，命中即返回、未命中返回 `undefined`，**绝不阻塞读盘**。
 * 即渲染路径可能有一两拍拿不到回退名字，下一拍就有了 —— 这是刻意的：
 * 900 ms 的渲染节拍上，为一次可能的读盘卡住 UI 是不可接受的。
 */
export class TaskTitleCache {
  /**
   * @param home 定位 `~/.claude/projects`；与 `TerminalManager.home()` 同源。
   * @param readTitle 读一条 transcript 尾部并取 aiTitle。省略时用默认实现
   *   （`findConversationFile(home, id, cwd)` → `readTail(file, TAIL_BYTES)`
   *   → `parseAiTitle`）。以参数注入是为了：单测注入假 reader 断言
   *   "读不到不缓存、下次 prewarm 重试"，e2e 也不必真读盘。
   */
  constructor(
    private readonly home: string,
    private readonly readTitle?: (
      conversationId: string,
      cwd: string,
    ) => Promise<string | undefined>,
  ) {}

  /** 同步读缓存。未缓存 / 传 undefined → undefined。渲染路径上唯一被调用的方法。 */
  peek(conversationId: string | undefined): string | undefined;

  /**
   * 异步预取，**fire-and-forget**（返回 void，不是 Promise）。
   * 已缓存则直接返回；未缓存则在后台读盘，读回后写入缓存。
   * `cwd` 必需 —— `findConversationFile` 要按 id + cwd 精确定位
   * （同一 id 可能出现在多个 project 目录下）。
   */
  prewarm(conversationId: string | undefined, cwd: string): void;
}
```

**失效与容量策略：**

- **不缓存"读不到"**：`/new` 之后新对话要过几个来回才生成 `aiTitle`，把它当成
  "没有"缓存住会让第三级永远不出现。读不到即**不写缓存**，下次 `prewarm` 重试
  （数量小、只在五个事件上发生，见 §4.3）。
- **键 = conversationId**：条目改绑后 `conversationId` 变了，`peek` 自然落到新键
  上 miss 并触发一次新 `prewarm`；旧键的条目随容量逐出，不需要显式失效。
  同一进程内同一个 `conversationId` 的 `aiTitle` 在一轮 reconcile 内可能陈旧，
  但 reconcile 每次都会对当前绑定重新 `prewarm`，下一拍即刷新。
- **容量上限（LRU 逐出）**：条目数量是几十的量级（实测 8 条），缓存条目数上限
  取 256 即可，超出按最久未访问逐出 —— 只为防条目数异常增长时无界占用内存。
- **无持久化**：进程退出即清空。重启后第一次 reconcile 会重新预热。

### 6.3 渲染：第三级的名字从哪来

`tree.ts` 里"显示用的任务名"由两段拼成，`EntryTreeItem` / `TaskTreeItem`
显式收这个值（不再各自去读 `activity.taskName`，否则二级的 `collapsibleState`
会和三级是否真能展开不一致）。

**新增方法**（`EntryTreeProvider` 上的独立方法，**不是**嵌在 `getChildren` 里）：

```ts
// tree.ts —— EntryTreeProvider 的私有方法
private taskNameFor(entry: TerminalEntry): string {
  // pane title（live，权威）→ 绑定对话的 aiTitle（回退）→ ''（不显示第三级）
  const fromPane = this.activity?.activityFor(entry.id)?.taskName ?? '';
  return fromPane.length > 0
    ? fromPane
    : this.titleFallback?.peek(entry.conversationId) ?? '';
}
```

**`getChildren` 的改动**（调用上面的 `taskNameFor`，与新参数无关的逻辑不动）：

```ts
// tree.ts —— getChildren 里
    if (element instanceof FolderTreeItem) {
      return element.entries.map((e) => new EntryTreeItem(
        e,
        this.alive.has(sessionNameFor(e.id)),
        this.activity?.activityFor(e.id),
        this.taskNameFor(e),          // ← 新增参数
      ));
    }
    if (element instanceof EntryTreeItem) {
      const activity = this.activity?.activityFor(element.entry.id);
      // 有名字才生三级 —— 名字可能来自回退，所以判据是 taskName 而不是 activity
      return element.taskName.length > 0
        ? [new TaskTreeItem(element.entry, activity, element.taskName)]
        : [];
    }
```

两个节点的构造函数各加一个显式参数（`activity` 仍照传，图标要靠它的 `state`）：

```ts
// tree.ts
export class EntryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: TerminalEntry,
    public readonly alive: boolean,
    public readonly activity: EntryActivity | undefined,
    /** 显示用的任务名：pane title 优先，回退到绑定对话的 aiTitle；'' = 不显示三级。 */
    public readonly taskName: string,
  ) { /* collapsibleState 与 tooltip 的「任务：」都改用 taskName */ }
}

export class TaskTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: TerminalEntry,
    /** 可能是 undefined —— 回退来的名字没有对应的本次采样状态。 */
    public readonly activity: EntryActivity | undefined,
    /** `label`/`id` 用它；图标仍按 `activity?.state` 三态，undefined 走 idle 分支。 */
    public readonly taskName: string,
  ) { /* … */ }
}
```

`EntryTreeItem` 的 `collapsibleState` 与 tooltip 的「任务：」一行一并改用这个
`taskName`；`TaskTreeItem` 的 `label` 也用它。图标仍按 `activity.state` 三态
（`running` 转圈 / `done-unseen` 绿点 / `idle` profile 色点）—— 回退来的名字
通常伴随 `idle`（或 `activity` 干脆是 `undefined`：该条目没被采过样），
两者一并落到既有的 idle 分支，**不新增状态**。

**全都无从得知时**（pane title 是占位符、且绑定对话的 transcript 里没有
`aiTitle`）：`taskNameFor` 返回 `''` → 不生成 `TaskTreeItem`、`collapsibleState`
为 `None`。**不加灰色占位、不退化成 derived slug、不用首条用户消息摘要。**

### 6.4 实例化与接线（`extension.ts`）

`TaskTitleCache` 只有**一个实例**，在 `extension.ts` 里 new，
**同时**以可选构造参数注入 `TerminalManager`（供 reconcile 预热）与
`EntryTreeProvider`（供渲染时 `peek`，见 §6.3）：

```ts
// extension.ts —— 替换现有的 :42-44 三行
const tracker = new ActivityTracker(tmux);
const titles = new TaskTitleCache(os.homedir());   // 与 manager.home() 同源
const provider = new EntryTreeProvider(store, tracker, titles);   // 渲染：peek
const manager = new TerminalManager(store, tmux, titles);         // reconcile：prewarm
```

- `TerminalManager` 的构造函数增加**可选**第三参 `titles?: { prewarm(conversationId, cwd): void }`
  （用最小接口，与 tree.ts 的 `store` / `activity` 同一处理方式）。省略时
  `reconcileAll` / `reconcileOne` 跳过预热 —— 既有调用方不受影响。
- `EntryTreeProvider` 的 `titleFallback` 就是同一个实例（同样可选，见 §4.3）。
- **顺序无关紧要**：provider 与 manager 互不引用（观测统一由 `extension.ts`
  驱动，见 §4.3），这里先建 provider 只是保持与现文件一致的阅读顺序。
- **`home` 的同源性**：`os.homedir()` 在扩展进程里与 `manager.home()` 的默认实现
  相同。**e2e 例外** —— harness 把 `m.home` 覆盖成假 HOME（`test/e2e-harness.js:433`），
  它不经 `extension.ts`，故需自己 `new TaskTitleCache(假 HOME)` 并传给
  `new TerminalManager(store, tmux, titles)`（见 §9.3）。

## 7. 采样闸门竞态修复

把 `pollActivity`（`extension.ts:101-114`）的闸门从**非权威的内存缓存**
换成**权威的 tmux 查询**，并顺手让两处存活判断同源：

```ts
  const pollActivity = async () => {
    if (activityInFlight) return;
    activityInFlight = true;
    try {
      // 闸门必须来自权威的 tmux 查询，不能用 provider.isAlive：
      // 后者由 10s 的存活轮询填充，且 `poll()` 有 inFlight 守卫 —— 激活时
      // 两个 restart* 并发启动，pollActivity 刚跑时第一次 listSessions 还没
      // 回来，于是第一轮 aliveIds 恒为空、一个条目都不采（实测症状）。
      const sessions = new Set(await tmux.listSessions());
      provider.setAlive(sessions);        // 顺带把树的存活标记推到最新（setAlive 只在变化时 fire）
      const entries = await store.load();
      const aliveIds = entries
        .filter((e) => sessions.has(sessionNameFor(e.id)))
        .map((e) => e.id);
      await tracker.poll(aliveIds);
    } finally {
      activityInFlight = false;
    }
  };
```

代价是每 900 ms 多一次 `tmux ls`（原来只有 pane title 的 N 次
`display-message`），一次进程 spawn 的量级，接受（§10）。

**`ActivityTracker.poll` 的签名保持不变**，仍是
`poll(aliveIds: string[]): Promise<void>`（`activityTracker.ts:62`）。
本节**只改采样闸门这一件事**。不要给它加 `SampleTarget` 之类的扩展：
任务名的回退链在**渲染层**完成（`tree.ts` 的 `taskNameFor` 调
`titleFallback.peek`，见 §6.3），采样层不需要知道"这个条目绑定哪条对话" ——
`conversationId` 传进去没有一个真实用途，是死参数。

`core/activity.ts` 的三态状态机同样**完全不需要改**（`taskName` 是"当前"
信息，每次采样覆盖，见 `core/activity.ts:50`）：`poll` 仍只把 pane title 的
解析结果写进 `nextActivity`，回退值在 `tree.ts` 里合成。状态机保持纯粹，
"名字从哪来"是渲染层的事。

### 7.1 旧的 10 s 存活轮询 `poll()`：保留

`extension.ts:78-86` 的 `poll()`（`:82` 调 `provider.setAlive`）**保留**，
不移除，也不改其语义。理由与它与新 900 ms 路径的关系：

- **它仍是 `setAlive` 的第二写入者**：本次改动后 `pollActivity` 每 900 ms 也调
  `provider.setAlive`（见上面的代码块），两者写的是同一个集合、值同源
  （都来自 `tmux.listSessions()`），后写者覆盖前写者，**不冲突**。
  `setAlive` 只在集合真变化时 fire（`tree.ts:185-188`），故重复写入不造成多余刷新。
- **它仍是"显式刷新"的入口**：命令处理函数里 7 处直接 `await poll()`
  （`killSession` / `setProfile` / `restoreAll` / `refresh` / 批量三处），
  语义是"刚改完状态，立刻把存活标记推准"。移除它会牵动这些调用点与
  `pollInterval` 配置项，收益为零。
- **它的 `inFlight` 守卫不再是 bug**：原症状（激活时第一轮 `pollActivity`
  看到空的 `isAlive` → 一个条目都不采）的根因是 `pollActivity` **依赖** `poll`
  的异步结果。现在 `pollActivity` 自带权威查询，`poll()` 那一轮被 `inFlight`
  整轮跳过**不再影响采样**；它最多让树的存活标记晚 900 ms 更新一次。
- **两路都在 `view.visible` 时才跑**（`restartPolling` 的 `:92`、
  `restartActivityPolling` 的 `:119`），面板不可见时都不会发 tmux 命令。

## 8. 不变量清单

1. **reconcile 三分支不可合并、不可省略**：
   `live == null` **或空串/纯空白** → 不动；`live === entry.liveSessionId` → 不动；
   否则 `conversationId = live` 且 `liveSessionId = live`。
   第二分支是**手动改绑保护**的全部实现，漏掉它手动改绑会被下一次 reconcile 冲掉。
   第一分支的空串判定也不可省：`parseSessionRecord`（§3.1）已把空 `sessionId`
   判为 `undefined`，但 `reconcileBinding` 的守卫写 `live === undefined` 时
   空串会落到第三分支把绑定**清空**成 `''` —— 这是两处都要挡的双保险。
2. **手动改绑（`bindConversationInteractive`）只改 `conversationId`，
   不动 `liveSessionId`**；兜底 D 同理（推断值不冒充观测值）。
3. **`liveSessionId` 必须经 `core/migrate.ts#migrateEntry` 原样带过**，
   缺字段保持 `undefined`，**绝不编造**。`migrateEntry` 是 `load()` 的唯一
   守门人，漏一行即静默吞掉全量用户的该字段。
4. **候选去重按 `startedAt` 取最新**（并列时按 pid 大者定序）。这条规则的作用
   是：当 pane 下**存在多个持有注册表记录的 claude 后代**时，给"取哪一个"一个
   确定性 tie-break，结果不随 readdir / 进程表顺序抖动。**如实说明**：实测到的
   孤儿场景（证据 5，两个 pid 记同一条 sessionId）里取新取旧结果**相同**，
   故该规则在此场景下不改变结果 —— 它是为"多个 claude 各记不同 sessionId"
   这一更一般的情形兜底。
5. **观测不到就不动、就不猜。** 会话不存在 / claude 已退出 / 注册表读不出 /
   进程表查不到 —— 一律 `undefined`，此时既不改绑定，也不显示第三级。
   唯一的例外是 §5.3 那条**收窄到"该 cwd 下只有这一个条目"**的兜底 D。
6. **任务名回退链唯一**：pane title → 绑定对话的 `aiTitle` → 不显示。
   绝不引入第三种来源（灰色占位、derived slug、首条用户消息摘要）——
   把"不知道"伪装成"知道"是误导。
7. **`taskNameFromTitle` 只在首码点不是字母/数字时才剥它**（回归：
   `qiansenwei@H:~/workspace` 与 `bash` 都不得被削）。
8. **兜底 D 的启用前提是"claude 已死 + 该 cwd 下只有这一个条目"两条同时成立**；
   多条目共用 cwd 时一律退回弹框问用户，绝不猜（与 §15.4 删掉 `--continue`
   同一个理由：猜错就是两条会话共写一条 `.jsonl`）。"只有这一个条目"的判据
   **按 `cwdFor()` 展开后的路径**比较（§5.3）：`~/x` 与 `/home/u/x` 原始串不等、
   却指向同一目录，按原始串判会让两条目各自"唯一"、双双走 D 并接到同一条
   `.jsonl` 上 —— 恰好击穿 D 自己要防的数据损坏。
9. **整个会话身份层是只读的**：解析活跃会话只发 `display-message` / `ps` /
   读文件，**绝不** `send-keys` / `attach` / `kill`。它可以在任何时刻跑，
   包括 claude 正在跑的时候。（`restartClaude` 的 `/exit` + 启动命令是它自己
   原有的职责，见 §5.4；身份层只被它**顺带调用**做一次只读观测。）
10. **`src/core/*.ts` 保持零 vscode 依赖、零 IO**（现有约定，
    `core/conversation.ts` ↔ `conversationFiles.ts` 的分工照搬）：
    进程表解析、注册表解析、候选去重、reconcile 规则全部是可独立 mocha 单测的纯函数。
11. **reconcile 不引入定时器**，只在五个事件上跑（激活 / ⟳ / 点击 / 切 profile /
    展开或面板变为可见），并由 in-flight 变量把并发触发合并成一次观测。
    观测的驱动者只有 `extension.ts` 一处：`EntryTreeProvider` 不持有 reconciler
    （§4.3），provider 只提供同步、无 IO 的 `titleFallback.peek`。

## 9. 测试计划

### 9.1 新增纯函数单测（`test/core/`）

| 文件 | 用例 |
|---|---|
| `test/core/processTree.test.ts`（新增） | `parseProcTable`：正常行、首尾空白、缺列/非数字行跳过、空串 → `[]`；`descendantsOf`：**直接子进程（pane_pid → claude）**、多层（pane_pid → shell → 更深的 claude）、**同一 root 下多个后代**（对应"一个 pane 下不止一个 claude"）、含环的表必须终止、root 不在表里 → `[]`、**结果不含 root 自身** |
| `test/core/liveSession.test.ts`（新增） | `parseSessionRecord`：完整记录、缺 `sessionId` → `undefined`、缺 `startedAt` → `undefined`、非法 JSON / 非对象 / 空串 → `undefined`、`pid` 是字符串 → `undefined`、**`sessionId` 为空串 → `undefined`**、**`sessionId` 为纯空白 → `undefined`**；`pickLiveSession`：空数组 → `undefined`、取 `startedAt` 最新、`startedAt` 并列按 pid 大者、单元素、**同 sessionId 的多个候选（证据 5 的孤儿场景）取谁都是同一条** |
| `test/core/reconcile.test.ts`（新增） | `reconcileBinding` 三分支；**手动改绑专项**：`conversationId='X'`、`liveSessionId='Y'`、`live='Y'` → `undefined`（X 不被冲掉）；`live='Z'` → 两者都变 Z；`live=undefined` 且 `liveSessionId` 为空 → `undefined`；**`live=''` 与 `live='   '` → `undefined` 且 `conversationId` 不被写成空串**（第一分支的守卫） |
| `test/core/tmux.test.ts`（扩展） | §6.1 表格里 6 条 `taskNameFromTitle` 全部作为独立用例；`parsePid`：`'287661'` → `287661`、空串 / `'abc'` / 负号 → `null` |

### 9.2 新增 IO 层测试

| 文件 | 用例 |
|---|---|
| `test/liveSessions.test.ts`（新增） | 用**临时 home** 造 `~/.claude/sessions/<pid>.json`（照 `test/conversationFiles.test.ts` 的 `makeHome` 写法），**绝不碰用户真实的 `~/.claude`**；`readLiveness` 返回的 `sessions` 按 pid 索引正确；注册表目录不存在 → 空快照不抛；`liveSessionIn` 用**手写的 `LivenessSnapshot` 字面量**驱动（纯函数式，无需真实 `ps`）：命中、pane 无后代、后代与注册表无交集、**同一 pane 两个 claude 取 `startedAt` 最新** |
| `test/taskTitles.test.ts`（新增） | `prewarm` 后 `peek` 命中；未 prewarm → `undefined`；换绑（不同 conversationId）→ 各自独立；"读不到不缓存"→ 第二次 `prewarm` 会重试（用假 reader 断言调用次数）；`peek(undefined)` → `undefined`；`prewarm(undefined, cwd)` 不发起读 |
| `test/core/conversation.test.ts`（扩展） | `parseAiTitle`：单条、多条取**最后**一条、`aiTitle` 含转义引号、无记录 → `undefined`、**首行被截断（尾部窗口的起点落在一条记录中间）不抛且能取到后面的标题** |
| `test/conversationFiles.test.ts`（扩展） | `findConversationFile`：按 id+cwd 命中、id 存在但 cwd 不符 → `undefined`、**标题落在文件尾部时也能读到**（造一个头部 >64 KB、`ai-title` 只在末尾的文件） |

### 9.3 清单与 e2e

- `test/manifest.test.ts`：不需要改（不新增命令、不新增配置项；`version`
  本来就未被断言）。
- `test/e2e-harness.js`（扩展，现 1217 行、已到 §11e/§16/§17）：新增下列用例。
  **先写清接缝**——注册表路径可注入（`home`），进程表没有注入点，也不该有：

  ```
  接缝（沿用 harness 已有的「pane 内以绝对路径拉起假进程」惯例，
        test/e2e-harness.js:437-444 的 newSessionWithClaude）：

  1. 用 tmux.newSession 建会话，再 sendLiteral 一个**假 claude 二进制**并回车
     —— 绝对路径（harness 的 launchBin 桩目录），这样不会被 PATH 桩换掉，
     也不会触到 /usr/bin/claude。桩脚本的事：打印自己的 PID 后 `sleep` 挂住。
  2. 取它的**真实 pid**：让桩脚本把自己的 `$$` 写进 `$HOME/.e2e-fake-pid`，
     harness 读这个文件即可（备选：`tmux capture-pane -p` 抓桩打印的那行）。
     这个 pid 就是生产代码将要看到的后代 pid。
  3. 写 `HOME/.claude/sessions/<pid>.json` = `{ pid, sessionId, cwd, startedAt }`
     （目录不存在就先 mkdir -p）—— 这是**唯一**需要注入的东西，走 home。
  4. 断言时用同一个 pid；`startedAt` 由用例显式给，保证确定性。

  为什么不 mock `ps`：假 claude 是 pane shell 的**真实后代**，真实
  `ps -eo pid=,ppid=` 产生的就是生产代码要解析的那棵树。mock 掉 `ps` 等于把
  「descendantsOf 能在真实进程树里找到 claude」这条契约换成"能解析我编的字符串"，
  恰恰放过了唯一的集成风险（pid 复用、pane_pid 归属、等待时序）。
  与 `test/liveSessions.test.ts`（§9.2）的分工：那边用手写 LivenessSnapshot
  测纯函数；这边必须走真实进程表。
  ```

  - **`/new` 自愈**：按上面的接缝造一个 pane，其 pane_pid 的后代假 claude 在
    注册表里记 `sessionB`，而条目绑定 `sessionA` → `openEntry` 后断言绑定变成
    `sessionB`，且发到 pane 里的是 `--resume <sessionB>`。
  - **切 profile 前先 reconcile**（§5.4）：pane 里先落一个记 `sessionB` 的后代
    假 claude，条目绑定 `sessionA`、`liveSessionId` 为空 → 调 `setProfileInteractive`
    后断言：发进 pane 的是 `--resume <sessionB>`（不是 `sessionA`），
    且条目 `profile` 已切换、`model` 被清空。
  - **手动改绑不被冲掉**：`conversationId='X'`、`liveSessionId='Y'`，
    注册表仍是 `Y` → 一次 reconcile 后断言 `conversationId` 仍是 `X`。
  - **观测不到就不动**：pane 的后代里没有 claude（不拉假进程）→ 断言条目一字未改。
  - **兜底 D 的两侧**：同 cwd 单条目 + claude 已死 → 自动 `--resume` 最新候选、
    **不弹 QuickPick**；同 cwd 两条目 → 仍弹 QuickPick（反向测试）。
  - **兜底 D 的等价路径**（§5.3 / §8 不变量 8）：两个条目并存，一个 `cwd='~/x'`、
    一个 `cwd='/home/u/x'`（同一个真实目录）→ claude 已死时 D **不得**对任一方
    生效，必须弹 QuickPick。
  - **第三级回退**：pane title 是 `✳ Claude Code`、绑定对话的 transcript 末尾有
    `aiTitle` → 三级显示该 `aiTitle`；把 transcript 里的 `ai-title` 去掉 →
    三级**不出现**（且二级 `collapsibleState` 为 `None`）。
    该用例需按 §6.4 的 e2e 注记自己 `new TaskTitleCache(假 HOME)` 并传给
    `new TerminalManager(store, tmux, titles)`。
  - **首字符回归**：pane title 为 `qiansenwei@H:~/workspace` → 三级显示原文。
- **变异测试**（本项目惯例，见 `tmux-terminals-v2-design.md` §12）：至少五处 ——
  去掉 `liveSessionId` 的迁移行、把 reconcile 第二分支删掉、
  去掉 reconcile 第一分支的 `live.trim() === ''` 守卫（空串用例应变红）、
  `taskNameFromTitle` 退回无条件 `slice(1)`、
  兜底 D 的唯一性判据退回原始串比较（`~/x` vs `/home/u/x` 的用例应变红）——
  确认对应断言真的失败。
  注：**不要**再用"`startedAt` 改成取第一个候选"做变异点 —— 证据 5 的孤儿场景
  两个 pid 同 sessionId，改与不改结果相同，该变异不会让任何断言变红（§8.4）。

## 10. 已知取舍

| 项 | 取舍 |
|---|---|
| **窄窗口**：`/new` 之后、尚未被任何一次 reconcile 观测到，claude 就退出并断连 | 此时注册表已随进程消失，仍会退回旧值（下一次恢复接回旧对话）。挂 `fs.watch` 监听 `~/.claude/sessions/` 可把窗口压到接近 0，**本次不做**（决策 B 留作后续优化）。用户的补救手段是退出前点一次条目或按一次 ⟳ |
| 触发点只有五个事件、无定时器 | 漂移的可见时长取决于用户交互（点条目 / 切 profile / 展开或面板可见 / ⟳）。代价是"放着不管"时树上的绑定可能滞后；换来的是零后台开销、零轮询放大 |
| 「展开树」这个触发点本身很弱 | `onDidExpandElement` 语义是"**由用户**展开时"，而 `FolderTreeItem` 默认 `Expanded`（`tree.ts:50`）—— 默认展开的文件夹节点不会发该事件。故 **以 `view.onDidChangeVisibility`（面板变为可见）兜底**（§4.3）；`onDidExpandElement` 保留，覆盖"用户折叠后再展开"的情形。两者都不是"打开面板就一定触发"的强保证，真正的下限是「激活」与「点击条目」两个触发点 |
| 兜底 D 收窄到"单条目共用 cwd" | 多条目共用同一 cwd（实测 4 条同目录）时仍会弹一次选择框，没有变快。这是有意的：那正是"猜错就损坏数据"的场景。判据按 `cwdFor()` 展开路径（§5.3），故 `~/x` 与 `/home/u/x` 也算"共用 cwd"、一样弹框 |
| 10 s 的 `poll()` 与 900 ms 的 `pollActivity` 都写 `setAlive` | `pollActivity` 现在自带权威查询（§7），10 s 轮询已是冗余的**第二写入者**，但**保留**：同源同值、`setAlive` 只在变化时 fire，且命令处理函数里 7 处直接 `await poll()` 要靠它（§7.1）。代价是每 10 s 一次多余的 `tmux ls` |
| **pane title 权威**：claude 完全退出后，pane title 是 shell 自己的标题 | 三级会显示 `qiansenwei@H:~/workspace` 这类字符串，而**不会**回退到该对话的 `aiTitle`（回退只在 pane title 解析出**空串**时触发）。这是"pane title 权威"的直接后果，也正是本次要修的那个 bug 的另一面（用户要的是"别削它"，不是"别显示它"）。要改成"claude 不在跑就不采信 pane title"只需在 `taskNameFor` 前加一道 `isClaudeCommand(pane 前台)` 闸门，留作后续 |
| aiTitle 读尾部 64 KB | 实测覆盖 184/184、最远一条距 EOF 53887 B。更长的会话（单条实测已达 7.8 MB）里若 ai-title 的写入间隔变大，理论上可能落到 64 KB 之外；届时应改成"从尾部逐段回读直到命中或读完"。当前数据不支持这个复杂度 |
| `aiTitle` 是 claude 的内部记录格式 | 与 §15.2 第 4 条的判断一脉相承：扩展本来就在读 `~/.claude/projects/**`。它可能随 claude 版本变化，读到就失败降级为"不显示第三级"（安全侧），不会误报 |
| 会话注册表 `~/.claude/sessions/<pid>.json` 是 claude 的内部实现 | 主方案 A 的全部精度都押在它上面。解析不出即退化为"不观测"，不是"猜"。将来它若改名/改格式，症状是"绑定不再自动跟随"（退回本功能之前的行为），而不是绑错对话 |
| 不装全局 hook（决策 C 否决） | 代价是拿不到 claude 主动推送的"会话已切换"事件，只能靠轮询式观测（五个事件触发）。换来的是不动用户全局 `~/.claude/settings.json` —— 那份债不该由这个扩展来欠 |
| 活动轮询每 900 ms 多一次 `tmux ls` | 修复采样闸门竞态的代价（§7）。相对它每轮已有的 N 次 `display-message`，一次 `listSessions` 的量级可忽略 |
| **发布杂务**（与本批两个 bug 无关，仅随版本一并处理） | 升版本号到 **0.1.5**：`package.json` 当前是 `0.1.4`（已产出 `vscode-tmux-terminals-0.1.4.vsix`）。注意 `package-lock.json` 里仍写着 `0.1.2`（此前几批就漏了同步），本次一并订正 `package-lock.json` 的 `version` 与 `packages[""].version`。这三处版本号属于发布流程的例行订正，不是本设计的组成部分 |

## 11. 实施后修订

（本节在实施完成后回填，记录与设计不符之处，沿用 v1 / v2 / tree-hierarchy 的做法）

### 实施偏差（2026-09-14，Task 12 整体收尾时回填）

1. **`readTail` / `TAIL_BYTES` 必须导出（§3.1 与本实现不自洽）** —— §3.1 的
   代码块里两者都没写 `export`（本文件 `:605`、`:608`），但 §6.2（`:648`）
   又要求 `TaskTitleCache` 调 `readTail(file, TAIL_BYTES)`，两者互斥。
   实现以 §6.2 为准：`TAIL_BYTES` 与 `readTail` 都标为 `export`
   （`src/conversationFiles.ts:75` / `:84`）。
2. **e2e 桩脚本的 pid 落盘路径由命令参数传入，不再是 `$HOME/.e2e-fake-pid`**
   —— §9（`:928`）写的是让桩把自己的 `$$` 写进 `$HOME/.e2e-fake-pid`。但
   harness **从不覆写 `process.env.HOME`**（只把假 HOME 当参数传给被测代码），
   照此实现会把 pid 文件写进**用户真实的家目录**。实现改为把绝对路径当
   **参数**传给后台桩（`echo $$ > "$1"`），落点由调用方指定。
3. **前台假 claude 用真二进制副本，不是 shebang 脚本** —— 前台桩用
   `cp /bin/head` 得到的真二进制。shebang 脚本被 `execve` 之后，tmux 报告的
   `#{pane_current_command}` 是**解释器**的 basename（`sh`），`isClaudeCommand`
   会据此拒绝它，「前台是 claude」的用例根本立不起来。后台桩（只用来记
   pid、不参与 `pane_current_command` 判据）仍是 shebang 脚本，不受影响。
4. **`parseAiTitle` 的 `trim` 只用于判空、赋的仍是原值** —— 实现保持 §3.2 的
   形态：`if (typeof t === 'string' && t.trim().length > 0) title = t`
   （赋 `t` 而非 `t.trim()`），于是 `"  Foo  "` 会原样穿出。去空白改在**缓存
   边界**做（`TaskTitleCache.load` 存 `title?.trim()`），顺带修掉「全空白被
   当成有效标题缓存住」。`core/conversation.ts` 里的这条根因**有意不修**：
   它是纯函数，改它会牵动既有 `parseAiTitle` 单测的语义，由消费侧归一化更局部。
5. **三个方法的签名都多了一个可选的 `LivenessSnapshot` 参数** —— §4.3（`:349`）
   与 §5.1（`:358`、`:387`）写的是 `reconcileAll(entries)` /
   `reconcileOne(entry)` / `openEntry(entry)`，实现分别是
   `reconcileAll(entries, snap?)`（`src/terminalManager.ts:439`）、
   `reconcileOne(entry, snap?)`（`:483`）、
   `openEntry(entry, opts?: { snap?: LivenessSnapshot })`（`:525`）。
   理由：§4.3/§8 要求「整批条目共用一份快照，`ps` 只 spawn 一次」，而批量恢复
   （`restoreAll`）是最常用的批量路径 —— 它必须把**同一份**快照先喂给
   `reconcileAll`、再逐条透传给 `openEntry`，否则 N 个条目会各 spawn 一次
   `ps`，恰好在最常用的动作上违背该约束。参数是**可选**的：单条触发点
   （点击条目、切 profile、⟳）都不传，由 `reconcileOne` 自己读一份。

### 后续修订（2026-09-14，Task 13）：§10 推迟的 pane title 闸门**提前落地**

§10「**pane title 权威**」一行把「claude 不在跑就不采信 pane title」记成待办、
留作后续。用户随后要求本次一并做掉 —— 这是**推迟项的提前**，不是设计变更。
落地形态与 §10 设想的**位置不同**：

- **闸门在采样层，不在 `taskNameFor`。** §10 写的是「在 `taskNameFor` 前加一道
  `isClaudeCommand(pane 前台)` 闸门」，但 `taskNameFor`（`src/tree.ts:231`）是
  同步纯读、在渲染路径上每帧都调，不能在那里 shell out。实现改为在
  `ActivityTracker.poll`（`src/activityTracker.ts:69`，采样在 `:78`）采样时就判定：前台不是
  claude ⇒ `EntryActivity.taskName` 存**空串**。`tree.ts` 的回退链
  （`src/tree.ts:231-236`）**一行未改**，于是空串自然让它轮到 aiTitle。
- **仍是一次 tmux 调用。** 原 `TmuxClient.paneTitle` 被 `paneSample`
  （`src/tmuxClient.ts:171`）取代，格式串是
  `#{pane_current_command}<PANE_SAMPLE_SEPARATOR>#{pane_title}`，一次
  `display-message -p` 同时取回两个字段 —— 采样循环每 ≈900 ms 对每个条目跑一次
  （`extension.ts` 的 `ACTIVITY_POLL_INTERVAL_MS`），拆成两次等于让这一层的进程数
  翻倍。
- **分隔符实测结论（与常规做法相反）**：原打算用 ASCII US（U+001F）。实测
  tmux 3.4 的 `display-message -p` 会把**格式串里的控制字符转义成八进制字面量**再
  输出 —— 放一个真实 0x1F 进去，拿回来的是四个可打印字符 `\037`（与直接写 `\037`
  逐字节相同）。故改用可打印定串 `__tmuxterm_field_sep__`
  （`src/core/tmux.ts:186`），并**只按第一个分隔符切**（标题是尾字段，即便自带
  同一 token 也伤不到切分；能破坏切分的只有命令字段）。
- **判据复用 `isClaudeCommand`**（`src/core/claude.ts:14`），不另立第二套
  「像不像 claude」—— 它本就是「切模型/切 profile 会不会把控制序列打进用户进程」
  的安全判据，问的是同一个问题。
- **只闸任务名，不闸 `running`。** `running` 由 `isRunningTitle` 的 Braille 分区
  判据给出，claude 退出后 title 变回 `user@host:~/path`、首字符不在 U+2800–U+28FF，
  本来就判否；把 running 也闸上会改动 done-unseen 状态机（§8 的不变量）的输入，
  超出本次范围。
- **`paneSample` 多取了一个字段，语义没变**：`pane_current_command` 的读法与
  §3.1/§5 已用的 `panePid`/`currentCommand` 同源同门（`=name:` 目标、空输出即
  「未知」），故 8 个真实会话实测全部报 `claude`，闸门不会误伤在跑的 claude。
- 纯解析/闸门在 `src/core/tmux.ts`（`parsePaneSample` / `taskNameFromSample`），
  单测在 `test/core/tmux.test.ts`；IO 侧在 `test/tmuxClient.integration.test.ts`
  （含「前台换成 sleep 后采样真的反映出来」的端到端一条）；采样层的闸门与
  「每条目每轮只采样一次」在 `test/activityTracker.test.ts`。

### 偏差记录（2026-09-16）：§4.3 的「不引入定时器」被 `fresh` 首启推翻

本条推翻 §4.3（`:288`）与 §8 不变量 11（`:889`）的「reconcile 不引入定时器、
只在五个事件上跑」：**10 秒的存活轮询现在也调 `reconcileAll`，触发点从五个
变成六个**。§4.3 与 §8 的原文原地保留（它们是当时的决策依据），以本条为准。

- **为什么必须推翻**：0.1.6 把新建条目的首次启动改成了**裸 `claude`**（不带
  任何会话参数，见 `README.md`「条目 ↔ 对话 绑定」）。这直接否定了本设计的一个
  隐含前提 —— **「绑定天然可信」**。§4.3 敢只挂事件触发，是因为当时认为
  `conversationId` 是写一次即定的权威事实，事件触发够用户把它纠正过来；而
  `fresh` 之后，条目出生时**预分配**的那个 id 与 claude 实际开出来的 id
  **可能根本不是同一个**，绑定只能靠**周期性观测**（pane → 注册表）纠回来。
- **五个触发点全失效的场合是正常用法**：原有五个触发点（激活 / ⟳ / 点击条目 /
  切 profile / 展开或面板可见）**全是用户动作**。用户「新建完就一直待在终端里
  提问、不碰侧边栏」完全正常，此时一个都不发 —— 绑定永远停在幽灵 id 上，
  `TaskTitleCache.retryMissing` 每 25 秒重读一个永远不存在的文件，三级任务名
  因此永不出现。故把 reconcile 挂到**本来就存在**的 10 秒存活轮询
  （`src/extension.ts` 的 `poll()`，§7.1 保留的那条）上：它天然同受
  `view.visible` 约束，面板隐藏时同样不跑。
- **代价可控的依据**：① 整批条目**共用一份 `LivenessSnapshot`**
  （`readLiveness`：一次 `ps` + 一次注册表 readdir，§3.1），这一拍不是按条目各
  查一遍；② 绑定已收敛时 `reconcileBinding` 返回 `undefined`，`reconcileAll`
  会 `continue` —— **稳态下不写盘**，清单文件 mtime 不变。§10（`:978` 的
  「触发点只有五个事件、无定时器」）那条取舍里「放着不管时绑定可能滞后」的代价
  也随之消失；换来的是每 10 秒一次与既有轮询**同拍**的观测（不额外多一次
  `tmux ls`）。
- **顺序**：`poll()` 里先 `reconcileAll(entries)` 再
  `manager.retryTitles(entries)` —— 前者把绑定改对，后者才有正确的 id 可重试。
