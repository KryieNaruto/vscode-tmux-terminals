# 多会话：一个终端条目挂 N 个会话（v0.2.0）

日期：2026-09-16
状态：待用户评审
关联：`2026-09-10-tree-hierarchy-design.md`（三级树的由来）、
`2026-09-14-session-identity-design.md`（条目 ↔ 对话绑定、reconcile、任务名回退链）。
本文件不改动它们的正文；术语沿用 `README.md`（条目 / 存活 / 接回 / profile /
任务名 / 三级树），并新增下面 §2 里的三个词。**与本文件冲突处以本文件为准**
（那两份 spec 描述的是「一条目 = 一会话」的旧模型）。

## 1. 背景

当前数据模型是严格的 **1 条目 ↔ 1 个 tmux 会话 ↔ 1 条对话绑定**：

- `TerminalEntry.conversationId` 是**单值**（`src/core/types.ts:33`）；
- tmux 会话名由**条目 id** 派生：`sessionNameFor(entry.id)` →
  `tmuxterm-<id>`（`src/core/tmux.ts:43`）；
- 树是「文件夹（一级）→ 终端条目（二级）→ 任务名（三级）」，
  三级**只在任务名非空时才生成**（`src/tree.ts:289-295`）。

用户要在一个工作目录下同时开多个 claude（不同任务并行），现在只能建多个
条目；而条目各自带一份 profile/model/颜色配置，改一次要改 N 遍。本次把
**「会话」升格成二级条目下的一个从属实体**：一个终端条目 = 一份配置
（名称/目录/profile/模型/颜色）+ N 个会话槽，每个槽有自己的 tmux 进程和
自己的对话绑定。

**这是破坏性的大版本**：类型层、树渲染、批量面板、命令菜单、清单文件格式
（v2 → v3）全部要动。版本号按用户要求定为 **0.2.0**。

## 2. 术语（本文件新增，README 同步）

| 词 | 含义 | 树中的位置 |
|---|---|---|
| **终端**（terminal） | 一份配置：名称、目录（cwd）、profile、模型、颜色、是否参与全部恢复。**没有自己的 tmux 进程** | 二级 |
| **会话**（session）/ **会话槽**（slot） | 一个 tmux 会话 + 它永久绑定的那条对话。三级一行的全部内容 | 三级 |
| **文件夹**（folder） | 按 cwd 精确分组的**虚拟**节点，没有独立实体（既有的 `groupByCwd`） | 一级 |

「**无会话**」在本文件里只有一个含义：**三级行的标题占位符**（该会话拿不到
任务名时显示它）。与「会话槽」这个数据结构无关，不要混。

## 3. 需求 → 落点对照

| # | 需求原文要点 | 落点 | 章节 |
|---|---|---|---|
| 1 | 三级才是真正的 session；二级是自定义名；二级下可有多个会话；原二级的「会话功能」挪到三级；三级标题=任务名，无任务名显示「无会话」；二级末尾加「+」 | 数据模型 `sessions[]`（§4）；`SessionTreeItem` 恒生成（§6.3）；`addSession` 命令（§7） | §4 §6 §7 |
| 2 | 三级「+」不再选目录，全继承一级/二级 | `addSessionInteractive(entry)` **零弹框**（§7.2） | §7.2 |
| 3 | 二级功能：设置名称、删除条目（递归删三级 + 杀掉所有子会话）、设置颜色、切换直连、切换模型 | `edit` / `delete` / `setColor` / `setProfile` / `setModel`（§7） | §7 |
| 4 | 三级含二级所有功能（除设置名字）；三级末尾加「X」关闭当前会话（不删条目）；这一级是接回会话的 | 三级菜单 = 二级菜单 − `edit` + `bindConversation`，`delete` → `deleteSession`；inline `closeSession`（§7.1、§7.3）；点击三级 = `openSession`（§8） | §7 §8 |
| 5 | 一级加「+」，快速建二级 | `addInFolder` 命令，inline 挂 `folder` 行（§7.4） | §7.4 |
| 6 | 二级的点点不要了，改成小竖线显示颜色 | `EntryTreeItem.iconPath` = 竖线 SVG，颜色取自 `entry.color`（§6.2） | §6.2 |
| 7 | 批量面板仍操作二级、不显示三级；改为按文件夹分组、一级=文件夹路径、点一级全选其下二级 | `BatchTreeProvider` 变两层；新增 `core/selection.ts` 三态（§9） | §9 |

### 3.1 用户已拍板、不得改动的设计决策（原样执行）

1. 一条目挂 **N 个会话**（本文件 §4）。
2. **profile / model 只存在二级一份**，三级共享。三级菜单里的「切换直连」
   「切换模型」= 改它所属的二级条目，其下所有会话一起变。**不给三级做
   独立的 profile/model 存储。**（落点见 §7.5）
3. 「X」= **只杀掉该会话的 tmux 进程，节点保留**，标题回落「无会话」；
   再点该节点 = 重新启动并接回**同一条对话**。会话槽（对话绑定）持久、
   tmux 进程易失。（落点见 §7.3 与 §8.2）
4. 二级行首小竖线显示用户设的**颜色**；profile **不再用颜色表示**，改为
   **标题后面一个不带颜色的小图标**（直连/中转各一个 codicon），tooltip
   写清楚。（落点见 §6.2）
5. 调色板：8 个预设色 + 末项「自定义…」可输任意 hex；任意 hex 用自绘 SVG
   （`ThemeIcon` 只能用主题色）。（落点见 §6.4）

### 3.2 ⚠ 用户没明说、由本设计代为判断的两条（**请复核**）

> 这两条是需求里没有的不变量，设计者替用户做了判断。**它们在实现里被当作
> 硬约束**，若与用户本意不符需要返工。SPEC_OPEN 会一并回报。

**判断 A：三级上的「删除条目」= 删除**这一个会话槽**（连同它的对话绑定），
**不是**删掉整个二级条目。菜单项因此改名叫「**删除会话**」。**

- 理由：在一个会话行上误删整个终端条目是破坏性极强的意外（连同其下所有
  会话与对话绑定一起没），而「关掉但保留」已经由 X 承担。两者语义必须分开，
  否则三级同时挂着「关闭（X）」与「删除整个终端」两条极不对称的破坏性动作。
- 连带：二级的「删除条目」保持递归语义（删条目 → 杀掉其下所有会话的 tmux
  进程 → 移除条目），**这也是一处行为变更** —— 见 §3.3 第 3 条。

**判断 B：一级（文件夹）没有独立实体**（由 `groupByCwd` 按 cwd 自动生成），
所以一级的「+」= **在该文件夹的 cwd 下新建一个二级条目，cwd 预填、允许改**。

- 理由：文件夹不是实体，无法「在它下面」存任何东西；能做的只有把它的 cwd
  当成新建条目的默认值。
- 实现上它与标题栏的 `add` 走**同一个** `addEntryInteractive(cwd?)`，只是
  多传一个默认 cwd（§7.4）。

### 3.3 本批次顺带产生的行为变更（都需在 README/冒烟清单里改）

1. **二级不再能「打开终端」**。二级点击 = 展开/折叠；打开动作下移到三级
   （三级才是会话）。二级行不再有 inline 打开按钮。
2. **「选择要接回的对话…」从二级移到三级** —— 绑定是会话级的属性，
   挂在二级上无法回答「改的是哪个会话的绑定」。
3. **「删除条目」现在会杀掉该终端下所有会话的 tmux 进程**。原实现是
   「远端 tmux 会话不受影响」（`terminalManager.ts:1161-1169`），与本次
   需求「递归删除三级子条目，同时杀掉所有子条目会话」相反。确认框文案必须
   跟着改（不能再写「远端 tmux 会话不受影响」）。
4. **`killSession` 保留但收窄到二级**，语义从「杀掉该条目的会话」变成
   「关掉该终端下的**全部**会话（条目保留）」，标题改为「关闭该终端下全部会话」。
   三级上的 X（`closeSession`）是它的单会话版本。**不删除任何既有命令 ID**，
   以免打坏用户已有的 keybinding。
5. **批量面板的「短路径消歧」消失**（扁平列表没了，`shortLabels` 在生产
   代码里不再被调用）。见 §11 已知取舍。

## 4. 数据模型 v3

### 4.1 `SessionSlot`（新增）

```ts
// src/core/types.ts
/**
 * 一个会话槽：一个 tmux 会话 + 它永久绑定的那条对话。
 *
 * **tmux 会话名由本槽自己的 id 派生**（sessionNameFor(slot.id) →
 * `tmuxterm-<slotId>`），与条目 id 共用同一个 newId() 命名空间。
 *
 * **v2 → v3 迁移时，槽 id 一律等于原条目 id**（§5.2）。这是刻意的，不是
 * 偷懒：v2 的 tmux 会话名就是 `tmuxterm-<entryId>`，沿用同一个 id 才能让
 * 升级后仍然**认得出用户此刻正在跑的那个旧会话**。若另发一个新 id，扩展会
 * 把它当成「不存在」→ 新建一个意图相同的会话 → 旧 claude 变成孤儿进程，
 * 两个进程同写一条 .jsonl（数据损坏级，与 core/command.ts 顶部注释里
 * 删掉 `--continue` 是同一个理由）。
 */
export interface SessionSlot {
  id: string;
  /** 该槽永久绑定的对话；undefined = 从未绑定（首次启动走 `fresh`，见 core/command.ts）。 */
  conversationId?: string;
  /** 语义与 v2 的同名字段完全一致，只是从条目收缩到槽上。 */
  liveSessionId?: string;
  /** 同一终端内的排序序号，从 0 递增，不保证连续。 */
  order: number;
}
```

### 4.2 `TerminalEntry`（改）

```ts
export interface TerminalEntry {
  id: string;
  name: string;
  cwd: string;
  profile: Profile;
  model?: string;
  /**
   * 二级行首竖线的颜色（`#rrggbb`，小写）。未设 = 中性竖线（§6.2）。
   * 只由 setColorInteractive 写入，且**必过 normalizeHexColor**（§6.4）。
   */
  color?: string;
  /**
   * 该终端下的全部会话槽，**可以为空数组**（= 这个终端还没建过会话）。
   * 已按 order 升序排好 —— 归一化在 EntryStore.load() 里做（§5.3）。
   */
  sessions: SessionSlot[];
  autoRestore: boolean;
  order: number;
}
```

**`sessions` 是必需字段（不是 `sessions?`）**：`migrateEntry` 保证任何进入
内存的条目都有它，声明成必需能让「忘了给新条目建会话」在**编译期**就报错。
`Partial<TerminalEntry>` 补丁不受影响。

**`conversationId` / `liveSessionId` 从 `TerminalEntry` 上彻底删除**（不是
留着不用）。理由：留着就是两个真相来源，而「哪个才是当前对话」的歧义会
一路渗进 `tree.ts` 的 tooltip、`conversation.ts` 的 `ownersOf`、
`taskTitles` 的 prewarm —— 每一处都要重新裁决一次「读条目还是读槽」。
删掉它，编译器会把所有需要裁决的地方一次性列出来。

### 4.3 新增纯函数模块 `src/core/sessions.ts`

```ts
/** 按 order 升序**稳定**排序，并把负数 order 钳到 0（与 load() 对条目 order 的处理同源）。 */
export function sortSessions(slots: readonly SessionSlot[]): SessionSlot[];
/** 下一个可用 order（max + 1；空数组 → 0）。在 store 的锁内调用。 */
export function nextSessionOrder(slots: readonly SessionSlot[]): number;
```

**为什么钳负数**：`store.load()` 对条目 order 已有这条规则
（`src/core/store.ts:119-122`，理由写在注释里：一个 -1 会永远排最前，而写入
又会重编号，状态自相矛盾）。会话 order 走同一条路，用同一个理由。

## 5. 迁移 v2 → v3

### 5.1 `migrateEntry` 的三种形态

`migrateEntry` 仍是 `EntryStore.load()` 的**唯一守门人**（`store.ts:96-107`
的注释）。它现在要认三种输入：

| 输入形态 | 判据 | 动作 |
|---|---|---|
| **v1** | `Array.isArray(o.commands)` | 现有逻辑（`claude-direct` → direct 的判定、`order: index`）**不变**；另外合成**恰好一个**槽：`{ id: o.id, order: 0 }` |
| **v2** | 有 string `id`/`name`/`cwd`，**无** `commands`、**无** `sessions` | 合成**恰好一个**槽：`{ id: o.id, conversationId?, liveSessionId?, order: 0 }` |
| **v3** | 有 string `id`/`name`/`cwd`，`Array.isArray(o.sessions)` | 逐槽校验后原样带过（§5.2） |

**v1 与 v2 合成出的那个槽，`id` 都必须取 `o.id`（原条目 id）**，理由见 §4.1
的类型注释。这是整个迁移里**唯一**不能写错的一行 —— 写错不会报错，只会让
用户升级后看见「本在运行的会话变成了『无会话』」，而真正的 claude 还在后台跑。

**v1 也必须有槽，不能给 `sessions: []`**：v1 的 tmux 会话名同样是
`tmuxterm-<entryId>`（会话名由条目 id 派生这条规则从 v1 起就没变过）。给它
空槽的后果是：老用户升级后，那个正在跑的 claude **在树上没有任何一行可以点**，
条目还是个不可展开的哑节点 —— 既接不回也杀不掉，只能去命令行 `tmux attach`。
v1 与 v2 的差别只在**槽里有没有对话绑定**（v1 没有对话概念，故槽不带
`conversationId`/`liveSessionId`），槽本身两边都要有。

v2 分支还必须在**同一个对象**里带上 `color?`（本轮新增的可选字段，v2/v1 都
没有它 → `undefined`，语义正确）。

### 5.2 v3 形态的逐槽校验

```ts
// 逐槽：
//  - id 不是非空 string → **丢弃该槽**（它没有地址，tmux 名无从派生）
//  - conversationId / liveSessionId：非 string 或空串 → 视为未设（绝不编造）
//  - order：number 则取之，否则用该槽的下标
```

**丢槽是本次唯一的丢弃路径**，只有手改坏了文件才会命中，且不影响其它槽。
判据刻意保持**确定性**：`load()` 每次读都会跑 `migrateEntry`，而迁移结果只
在下次真实写入时才落盘 —— 若这里给缺 id 的槽现场编一个随机 id，同一份文件
两次读会得到**不同的 tmux 名**，树在写入发生前一直抖。故丢，不编。

**`sessions` 存在但为空数组（`[]`）时，绝不回头去读顶层 `conversationId` 复活
一个槽。** `[]` 是 v3 的合法状态（用户把会话都删了），复活它等于凭空造一个
会话。**只有 `sessions` 字段整体缺失**（v2）才合成槽。

### 5.3 归一化与排序的位置

`EntryStore.load()` 在排序条目之外，对每条条目再跑一次
`sortSessions(e.sessions)`，于是**所有**消费方（tree / batchTree /
terminalManager）拿到的 `sessions` 都已按 order 升序、无负数 order。
与条目排序一样，**load 不改写文件**（`store.ts:105-107` 的既有约定）。

### 5.4 备份文件名：`<file>.v2.bak`

`store.ts:130-134` 的注释已经把这件事写死了，照它执行：

> 注意备份名 `<file>.bak` **不带版本号**：将来若出现 v3 迁移，它必须改用
> 带版本的后缀（如 `.v2.bak`），否则 v3 的迁移会撞上这里「备份已存在」的
> 判断而静默跳过。

新增第二个备份入口，与既有的**并列、互不覆盖**：

```ts
// src/core/store.ts —— 既有方法一字不改
/** 含 v1 条目 → 备份为 `<file>.bak`。 */
async migrateAndBackup(): Promise<boolean>;

/** 含 v2 条目 → 备份为 `<file>.v2.bak`。 */
async migrateAndBackupV2(): Promise<boolean>;
```

- `.v2.bak` **只在文件里真的存在 v2 形态的条目时才写**，且已存在则不覆盖
  （与 `.bak` 同两条规则）。
- 判据 `isV2Shape(o)`（`core/migrate.ts` 导出）：有 string `id`/`name`/`cwd`，
  且既无 `commands` 数组（v1）也无 `sessions` 数组（v3）。
- 三种输入因此各得其所：v1 文件只写 `.bak`（v1 内容）；v2 文件只写
  `.v2.bak`（v2 内容）；v3 文件一个都不写。**两个备份名各自都是诚实的**
  —— 不会出现「叫 `.v2.bak` 里面却是 v1」。
- `extension.ts` 两处都调，各自弹一条提示（沿用既有文案风格）。

## 6. 树：文件夹 → 终端 → 会话

### 6.1 节点类型与 `contextValue`

| 节点 | 类 | id | contextValue | 子节点 |
|---|---|---|---|---|
| 一级 文件夹 | `FolderTreeItem`（既有，加 inline `+`） | `folder:${cwd}` | `folder` | 二级 |
| 二级 终端 | `EntryTreeItem`（改） | `entry:${entry.id}` | `terminal` | 三级 |
| 三级 会话 | `SessionTreeItem`（**新增**，取代 `TaskTreeItem`） | `session:${slot.id}` | `alive ? 'sessionAlive' : 'sessionDead'` | 无 |
| 空清单占位 | `EmptyTreeItem`（既有，文案不变） | — | `empty` | 无 |

`TaskTreeItem` **删除**（它的「只在有任务名时生成」正是本次要推翻的前提）。

> **`EntryTreeItem.id` 从 `entry.id` 改成 `entry:${entry.id}`**，与三级
> `session:${slot.id}` 命名空间分开：迁移后槽 id 恒等于原条目 id（§5.1），
> 不加前缀两级会**撞 id**，VS Code 的展开状态与选中态随即错位。

### 6.2 二级行的渲染

```
[竖线图标]  <名称>  $(plug)
```

- **`iconPath` = 小竖线**，颜色 = `entry.color`：
  - 有颜色 → 该色的自绘 SVG（§6.4）
  - 未设 → **主题自适应的中性竖线**（`{light, dark}` 两个随扩展打包的 SVG）。
    **不用 `ThemeIcon`**：`ThemeIcon` 的颜色只能是**主题色**，表达不了任意
    hex；而竖线的语义就是「用户挑的那个颜色」，用主题色会撒谎。
- **`description` = profile 的 codicon**（标题**后面**）：direct → `$(plug)`，
  ccr → `$(cloud)`。**不带颜色**（`ThemeIcon` 那套颜色语义在本轮被彻底摘掉）。
- **`tooltip`** 必须写清楚 profile 的**文字含义**（`direct（官方直连）` /
  `ccr（本地中转）`）—— 因为图标本身不带颜色、不写文字，只看图标认不出来。
  tooltip 其余内容：名称、目录、模型、**颜色（hex 或「未设」）**、会话数、
  基础命令、是否参与全部恢复。**tooltip 里不再有「对话」一行**
  （对话是会话级的，二级没有唯一答案）。
- **`collapsibleState`** = `sessions.length > 0 ? Expanded : None`。
  这条是 `tree-hierarchy` spec §8 不变量 1 的延续：**绝不出现「看起来能展开、
  展开后却是空的」**。会话数为 0 时必须是 `None`。
- **没有 `command`**：点击二级 = 展开/折叠（§3.3 第 1 条）。
- `profileColor()` 辅助函数**删除**（不再有按 profile 着色这回事）。

### 6.3 三级行的渲染

- **label** = `taskName.length > 0 ? taskName : '无会话'`。任务名的来源链
  **完全不变**：pane title（采样层已闸「前台不是 claude 就不采信」）→
  绑定对话的 `aiTitle`（`TaskTitleCache.peek(slot.conversationId)`）→ 空。
  只是「空」不再意味着**不生成节点**，而是标题回落成「无会话」。
- **`iconPath` 四分支**（存活/死亡 + 活动状态，取代原来「按 profile 上色」）：

  | 条件 | 图标 |
  |---|---|
  | 会话不存在 | `circle-outline`（空心，中性色） |
  | 存活 + `running` | `loading~spin` |
  | 存活 + `done-unseen` | `circle-filled` + `charts.green` |
  | 存活 + `idle` / activity 为 undefined | `circle-filled`（中性色） |

  用中性色而不是 profile 色，是因为 profile 已经改由二级的 codicon 表达
  （§3.1 第 4 条）——同一个信息不该在两个地方用两种编码各说一遍。
- **`command`** = `tmuxTerminals.open`，`arguments: [this]`（点击 = 接回/重建
  该会话，见 §8）。**`markSeen` 用槽 id**。
- **tooltip**：终端名、目录、profile、模型、对话（该槽的
  `conversationId`）、状态（存活/无进程）、任务是哪来的。
- 三级**恒生成**（每个槽一行），不再有「有任务名才生成」这回事。

### 6.4 颜色：调色板、校验、图标生成

**纯函数**（`src/core/colors.ts`，零 vscode、零 IO，可直接单测）：

```ts
/** 预设色（8 个）+ 末项「自定义…」由调用方追加，不在本模块里。 */
export const PRESET_COLORS: readonly string[];   // 8 个 #rrggbb，小写

/**
 * 归一化用户输入的颜色。
 * 接受：`#rgb` / `#rrggbb` / 不带 `#` 的同样两种 / 大小写混写。
 *   `#abc` → `#aabbcc`（三位简写逐位展开）
 * 输出：小写 `#rrggbb`。
 * 其余一律 undefined（**绝不**把非法值写进清单，也绝不猜一个近似色）。
 */
export function normalizeHexColor(input: string): string | undefined;

/**
 * 竖线图标（16×16）的 SVG 文本。**必须写死显式 fill**（颜色就是它的全部
 * 意义）；**绝不用 `fill="currentColor"`** —— 仓库里已有一次实测教训：
 * manifest.test.ts 里记着「VS Code 把图标当 CSS mask 渲染，currentColor
 * 解析失败导致整个图标透明」。
 */
export function colorBarSvg(color: string): string;
```

竖线几何：`<rect x="7" y="2" width="2" height="12" rx="1" fill="<hex>"/>`，
`viewBox="0 0 16 16"`。细、居中、上下留白 —— 与行高对齐后看起来是一条
「小竖线」而不是一个色块。

**IO 适配**（`src/colorIcons.ts`，非 core，可用 vscode + fs）：

```ts
export class ColorIconCache {
  constructor(private readonly storageDir: string, private readonly extensionUri: vscode.Uri) {}

  /** 未设颜色时的中性竖线（随扩展打包的两个 SVG，主题自适应）。 */
  neutral(): { light: vscode.Uri; dark: vscode.Uri };

  /** 同步解析出可用的 iconPath。color 非法/未设 → neutral()。 */
  iconFor(color?: string): vscode.Uri | { light: vscode.Uri; dark: vscode.Uri };

  /** 把一批颜色对应的 SVG 落到 storageDir（幂等，已存在则跳过）。 */
  async ensure(colors: readonly string[]): Promise<void>;
}
```

- 生成文件落 `<globalStorage>/colors/<hex>.svg`（`hex` 含 `#`，需去 `#` 做
  文件名）。**写扩展安装目录不行**（vsix 目录可能只读）。
- `iconFor` 只拼路径、**不同步读盘**（渲染路径不能有 IO）：文件没就位时会
  短暂空图标，故 `activate()` 里先 `await ensure(清单里所有颜色)` 再渲染，
  `setColorInteractive` 写完颜色后也 `await ensure([color])` 再 refresh。
- 随扩展打包 `resources/colors/bar-light.svg`（显式灰 `#6e6e6e`）与
  `resources/colors/bar-dark.svg`（显式灰 `#c5c5c5`）。`resources/` 不在
  `.vscodeignore` 里，会进 vsix。

### 6.5 activity 与标题回退的键：条目 id → 槽 id

**形状不变，语义变。** `ActivityTracker`（`src/activityTracker.ts`）的
`poll(aliveEntryIds)` / `activityFor(id)` / `markSeen(id)` **签名一个字都不
改**，但传进去的 id 从「条目 id」变成「**槽 id**」：

- `extension.ts` 的 `pollActivity`：`aliveIds` 改成
  「`sessions` 里含 `sessionNameFor(slot.id)` 的那些**槽**的 id」——
  即 `entries.flatMap((e) => e.sessions)` 过滤存活。
- `ActivityTracker` 内部本来就用同一个 id 去 `sessionNameFor(id)` 采样
  （`core/tmux.ts`），所以**实现层零改动**，改的只是喂进来的 id 的来历。
- `tree.ts` 里 `activityFor(...)` 与 `markSeen(...)` 一律传 `slot.id`。

**参数名要跟着改**（`aliveEntryIds` → `aliveSessionIds`）：名字是唯一能让下
一个读者知道「这里不是条目 id」的线索，留着旧名会让后来者把一个条目 id 传
进去，症状是「某个会话的运行图标永远不转」——静默、且极难定位。

`EntryTreeProvider` 的构造参数同步调整（都用最小结构化接口，与既有
`store` / `activity` / `titleFallback` 同一处理方式）：

```ts
constructor(
  store: { load(): Promise<TerminalEntry[]>; reorder(ids: string[]): Promise<void> },
  activity?: { activityFor(sessionId: string): EntryActivity | undefined },
  /** 回退源。peek 的入参从「条目的 conversationId」变成「槽的 conversationId」——
      类型不变（string | undefined），只是取值的来源变了。 */
  titleFallback?: {
    peek(conversationId: string | undefined): string | undefined;
    onDidChangeTitle?(listener: () => void): { dispose(): void };
  },
  /** 新增：二级行的颜色竖线。省略时退化为 ThemeIcon('circle-outline')（安全侧）。 */
  colorIcons?: {
    iconFor(color?: string): vscode.Uri | { light: vscode.Uri; dark: vscode.Uri };
  },
) {}
```

## 7. 命令与菜单

### 7.1 命令矩阵

| 命令 ID | 标题 | 状态 | 语义 |
|---|---|---|---|
| `tmuxTerminals.open` | 打开终端 | 改 | 参数从「二级」改为「三级」→ `openSession(entry, slot)`（§8） |
| `tmuxTerminals.add` | 新建终端条目 | 不变 | 标题栏 `+`；`addEntryInteractive()` |
| `tmuxTerminals.addInFolder` | 在此目录新建终端 | **新增** | 一级 inline `+`；`addEntryInteractive(folderCwd)` |
| `tmuxTerminals.addSession` | 新建会话 | **新增** | 二级 inline `+`；`addSessionInteractive(entry)`（零弹框） |
| `tmuxTerminals.closeSession` | 关闭会话 | **新增** | 三级 inline `X`；`closeSession(entry, slot)` |
| `tmuxTerminals.deleteSession` | 删除会话 | **新增** | 三级右键；`deleteSession(entry, slot)` |
| `tmuxTerminals.delete` | 删除条目 | 改语义 | 二级右键；现在**递归杀全部会话**（§3.3 第 3 条） |
| `tmuxTerminals.edit` | 编辑 | 不变 | 二级右键（三级**没有**它 —— 三级用任务名，不给改名） |
| `tmuxTerminals.duplicate` | 复制 | 改语义 | 每个槽都要新 id + 新 conversationId（§7.6） |
| `tmuxTerminals.setColor` | 设置颜色… | **新增** | 二级 + 三级右键；`setColorInteractive(entry)` |
| `tmuxTerminals.setModel` | 设置模型… | 不变 | 二级 + 三级；作用于**二级**（§7.5） |
| `tmuxTerminals.setProfile` | 切换直连/中转 | 不变 | 二级 + 三级；作用于**二级**（§7.5） |
| `tmuxTerminals.bindConversation` | 选择要接回的对话… | 改 | 从二级**移到三级**（§3.3 第 2 条） |
| `tmuxTerminals.toggleAutoRestore` | 切换「参与全部恢复」 | 不变 | 二级 + 三级（作用于二级） |
| `tmuxTerminals.killSession` | 关闭该终端下全部会话 | 改语义 | 二级右键（§3.3 第 4 条） |
| `tmuxTerminals.restoreAll` / `refresh` | — | 不变 | 标题栏 |
| `tmuxTerminals.batchToggle` / `batchClear` / `batchSetCcr` / `batchSetDirect` / `batchSetModel` | — | 不变 | 批量面板 |
| `tmuxTerminals.batchToggleFolder` | 切换文件夹选中（内部） | **新增** | 批量面板一级行点击；`commandPalette: when:false` |

**新增的 5 个命令都必须在 `extension.ts` 里用 `reg(...)` 注册**：
`test/manifest.test.ts` 有两条双向断言（声明的都注册了、注册的都声明了），
漏一边就红。

### 7.2 菜单矩阵（`view/item/context`）

| 命令 | `when` | group |
|---|---|---|
| `open` | `view == tmuxTerminals.list && (viewItem == sessionAlive \|\| viewItem == sessionDead)` | `inline@1` |
| `closeSession` | `... && viewItem == sessionAlive` | `inline@2` |
| `addInFolder` | `... && viewItem == folder` | `inline@1` |
| `addSession` | `... && viewItem == terminal` | `inline@1` |
| `edit` | `... && viewItem == terminal` | `2_edit@0` |
| `setColor` | `... && (viewItem == terminal \|\| viewItem == sessionAlive \|\| viewItem == sessionDead)` | `2_edit@1` |
| `setModel` | 同上（三个 viewItem） | `2_edit@2` |
| `setProfile` | 同上 | `2_edit@3` |
| `bindConversation` | `... && (viewItem == sessionAlive \|\| viewItem == sessionDead)` | `2_edit@4` |
| `duplicate` | `... && (viewItem == terminal \|\| sessionAlive \|\| sessionDead)` | `2_edit@5` |
| `toggleAutoRestore` | 同上 | `2_edit@6` |
| `killSession` | `... && viewItem == terminal` | `1_close@1` |
| `deleteSession` | `... && (viewItem == sessionAlive \|\| viewItem == sessionDead)` | `3_danger@1` |
| `delete` | `... && viewItem == terminal` | `3_danger@2` |

**每个 inline 行最多 2 个按钮**（一级 1 个、二级 1 个、三级 2 个）——
inline 区在行尾，再多会挤掉文件名。

> ⚠ **`test/manifest.test.ts` 的隐藏陷阱**：那条「菜单引用了代码从不设置的
> `contextValue`」的用例，正则是
> `/contextValue\s*=\s*[^;]*?'(\w+)'\s*:\s*'(\w+)'/g` —— 它**只认三元表达式**
> 形态（`alive ? 'a' : 'b'`）。本轮 `tree.ts` 里 `folder` 与 `terminal` 都是
> **普通赋值**（`this.contextValue = 'terminal'`），照现状写会让该用例报
> 「`terminal`/`folder` 永不出现」。**必须把正则改成同时认两种形态**
> （三元**或**直接赋值），**两个方向的原断言一字不动**：
>
> ```ts
> const setValues = [...treeSrc.matchAll(
>   /contextValue\s*=\s*(?:[^;]*?'(\w+)'\s*:\s*'(\w+)'|'(\w+)')/g,
> )].flatMap((m) => [m[1] ?? m[3], m[2] ?? m[3]]).filter((v) => v !== undefined);
> ```
>
> 这是**加强**测试（覆盖了原来漏掉的一种写法），不是为了让测试变绿而放宽断言。

### 7.3 三个「关闭 / 删除」的语义（**最易写错的一处**）

| 动作 | 入口 | 杀 tmux？ | 删槽？ | 删条目？ | 确认框 |
|---|---|---|---|---|---|
| **关闭会话** | 三级 inline `X` | **是**（detach + kill + dispose 面板） | **否**（槽保留，`conversationId` 保留） | 否 | 模态，**要** |
| **删除会话** | 三级右键 | 是（同上） | **是**（连同 `conversationId` 一起没） | 否 | 模态，**要** |
| **删除条目** | 二级右键 | 是（**其下每个槽都杀**） | — | 是 | 模态，**要** |
| **关闭该终端下全部会话** | 二级右键 `killSession` | 是（每个槽） | 否 | 否 | 模态，**要** |

- **X 之后节点保留、标题回落「无会话」**：不是 UI 特判 —— 槽还在，而
  tmux 进程没了 ⇒ 采样不到任务名 ⇒ 标题按 §6.3 回落成「无会话」。
  这同时保证了 §3.1 第 3 条「再点它 = 重新启动并接回**同一条对话**」：
  槽的 `conversationId` 从未被清，§8 的启动路径自然 `--resume` 回它。
- 「杀 tmux」沿用 `killSession` 现有实现的三步**顺序不可换**：先
  `detachClients` 再 `killSession`，最后 dispose 面板并从 `terminals` Map
  里删（`terminalManager.ts:1181-1192` 的注释：顺序反了会让面板停在 tmux
  界面，UI 与实际不符）。
- 每个确认框都必须**点名作用对象**（终端名 + 任务名/槽），因为三级菜单里
  的条目级动作作用范围是**整个终端**，不点名用户会以为只影响这一行。

### 7.4 新建（一级 `+`、标题栏 `+`、二级 `+`）

```ts
// 一级 inline + 与标题栏 + 共用一个入口
async addEntryInteractive(defaultCwd?: string): Promise<void>
```

1. 问名称（沿用 `askName`，校验重名）——**取消则整条中止**（用 `undefined`
   判断，不能用 `!name`，理由见 `terminalManager.ts:1097-1100`）。
2. 问目录（沿用 `askCwd`，`placeHolder` = `defaultCwd`）。**一级 `+` 的
   cwd 预填是可改的**，不是只读（判断 B）。
3. 问是否参与全部恢复（沿用 `askAutoRestore(true)`）。
4. `store.append({ ..., color: undefined, sessions: [新建一个空槽] })`。

**新建条目必须带 1 个空会话槽**，不是 0 个：这是为了让「建完点开就能用」
与今天的体验一致（今天建条目后点开即起 claude）。0 槽的条目会显示成
不可展开的一行、点了也没反应，比今天差。

`addSessionInteractive(entry)` —— **零弹框**（需求 2）：

```ts
// 只做一件事：在锁内追加一个空槽
await this.store.addSession(entry.id, { id: newId() });
```

新槽无 `conversationId`（首次启动走 `fresh`，与今天新建条目同一条路径）、
无 `liveSessionId`、`order` 在锁内分配（`nextSessionOrder`）。
**不自动打开终端** —— 「+」是「加一个会话位」，不是「立刻起一个 claude」；
打开是紧接着点那一行的事（§8）。这样「+」也就不会有任何副作用。

### 7.5 条目级设置（profile / 模型 / 颜色 / 参与恢复）作用于整个终端

三级菜单里的这几项**直接转发到所属的二级条目**（§3.1 第 2 条）：

| 三级菜单项 | 落点 | 为什么 |
|---|---|---|
| 切换直连/中转 | `setProfileInteractive(entry)` | 需求明写「等同于改它所属的二级条目，其下所有会话一起变」 |
| 设置模型… | `setModelInteractive(entry)` | 同上 |
| 设置颜色… | `setColorInteractive(entry)` | 颜色是二级的属性 |
| 切换「参与全部恢复」 | `toggleAutoRestore(entry)` | 同上 |
| 复制 | `duplicateEntry(entry)` | 复制的是整个终端 |

**这些确认框的文案必须写明「影响该终端下全部 N 个会话」**，否则用户在
三级行上点「切换直连」会以为只切这一个会话。

### 7.6 `duplicateEntry`：每个槽都要重造

v2 的 `duplicateEntry`（`terminalManager.ts:1131-1159`）逐字注释解释了
为什么 `conversationId` 必须重新生成、`liveSessionId` 必须剥掉。本轮
**这两条规则逐槽适用，一个槽都不能漏**：

```ts
const sessions = entry.sessions.map((s) => ({
  id: newId(),                    // 新槽 id → 新的 tmux 会话名（绝不与原终端的会话重名）
  conversationId: newConversationId(),  // 新对话：照抄会让两个 claude 同写一条 .jsonl
  order: s.order,                 // 槽的顺序原样保留
  // liveSessionId 刻意不带：它是「源终端亲眼观测到的会话」，带过去会让
  // reconcileBinding 第二分支误判「没变化」而永远不改绑（v2 注释原话）
}));
```

槽的**数量**保留（复制一个有 3 个会话的终端 = 一个有 3 个空槽的终端）。

## 8. 打开 / 接回一个会话

`openEntry(entry)` → **`openSession(entry, slot, opts?)`**。除下面三点外，
`terminalManager.ts:639-779` 的**全部**逻辑与不变量**逐字保留**（会话存在
性 / 附着数 / pane 前台是不是 shell / `decideOpen` / `allowLaunch` 竞态闸门 /
`reuse-attach` 只在证明空闲时 / 发送前重算 `isShellReady`）：

1. **tmux 会话名**从 `sessionNameFor(entry.id)` 换成
   `sessionNameFor(slot.id)`；`cwd` 仍取 `this.cwdFor(entry)`。
2. **reconcile 的作用域收缩到槽**（§8.1）。
3. **`resolveLaunchSpec` 的绑定来源从 `entry.conversationId` 换成
   `slot.conversationId`**；其余判据（`.jsonl` 不存在 → `fresh`，
   在别的目录 → 报错不接，兜底 D 收窄到「该 cwd 下只有这一个**条目**」，
   未绑定 → 弹一次选择框）全部照旧。

### 8.1 reconcile 按槽进行

- `liveFor(snap, slot)`：`panePid(sessionNameFor(slot.id))` → `liveSessionIn`。
- `reconcileAll(entries, snap?)` 循环**条目 × 槽**，只处理 **tmux 会话存活**
  的槽（判据从「entry 的会话存活」变成「该槽的会话存活」）；整批仍**共用
  一份** `LivenessSnapshot`（一次 `ps` + 一次注册表 readdir），这条约束不变。
- `reconcileOne(entry, slot, snap?)` 返回 `{ slot, live }`。
- `reconcileBinding`（`core/reconcile.ts`）**一个字符都不用改** —— 它本来
  就只认 `{conversationId, liveSessionId}` 这个形状，现在喂给它的是槽。
  手动改绑保护（第二分支）、空串守卫（第一分支）随之**逐槽**生效。
- **回写必须走锁内的槽级原语**（§10），不能「读出来改一改整个 sessions
  数组再 update」：同一终端的两个槽在同一轮 reconcile 里各自算出新数组时，
  后写者会盖掉先写者（lost update），表现为「改绑偶尔不生效」。

### 8.2 「接回会话」为什么成立

§3.1 第 3 条要的语义由两件事合起来保证，缺一不可：

1. **绑定存在槽上**，X 只杀 tmux 进程、不动槽 ⇒ `conversationId` 还在；
2. **打开路径永远读槽的绑定**（§8 第 3 点）⇒ 下次点是 `--resume <那条>`。

`fresh` 只可能在「槽从未绑定过」时出现（新建的空槽）：因为
`resolveLaunchSpec` 的已绑定分支在 `.jsonl` 不存在时会返回 `fresh`，而那
正是「绑定的是幽灵 id」的情形 —— 与今天的行为一致（v2 的 `fresh` 首启），
不是新引入的。

### 8.3 「全部恢复」恢复每个条目的**每一个**槽

`restoreAll()`（`terminalManager.ts:805-843`）目前是「过滤 `autoRestore` 的
条目 → 跑一次 `reconcileAll` → 逐条 `openEntry`」。本轮改成：

```
过滤 autoRestore 的条目
  → flatten 出它们的全部槽（条目 × 槽）
  → 跑一次 reconcileAll（整批共用一份快照，§8.1）
  → 逐**槽** openSession（仍然并行、不 await，仍保留 50ms 错开）
```

**判断（用户没明说，本设计定的，请一并复核）**：`autoRestore` 是**二级条目**
的属性（它是「这个终端要不要参与一键恢复」），所以它对其下**所有**会话生效
—— 一个挂了 3 个会话的终端被标为参与恢复，就是恢复 3 个会话。这与
§3.1 第 2 条「profile/模型只存在二级一份、三级共享」是同一个模式的延伸。

- 槽数为 0 的条目**不产生任何恢复动作**（它没有会话可恢复），但不算失败。
- 「没有标记为参与全部恢复的条目」的那条提示按**条目**判断（与今天一致），
  避免「有 3 个条目但都是 0 槽」时静默什么都不做。

## 9. 批量操作面板

### 9.1 结构：两层

```
📁 /ssd/qiansenwei/workspace/mine        ← 一级：文件夹路径，点击 = 全选/全不选
   ✅ mine-a   ccr
   ⭕ mine-b   direct
📁 ~/work/proj
   ✅ proj-x   ccr
```

- 一级 = cwd 分组（复用 `groupByCwd`），label = **完整 cwd**（与主树的一级
  一致），`contextValue = 'batchFolder'`，`collapsibleState = Expanded`，
  `id = folder:<cwd>`。
- 二级 = 终端条目，`contextValue = 'batchItem'`，**只显示二级、不显示三级**
  （需求 7）。行 label 仍是 `entry.name`，`description` = profile（+ 模型，
  若有），tooltip 保留完整信息。
- **选中态仍由图标承载**（实心勾/空心圈），不用原生高亮 ——
  `batchTree.ts:5-11` 的注释解释了原因（原生高亮跟随焦点，用方向键浏览时
  会移动，把高亮当「已选」会造成误操作），该理由本轮**一字不变**。

### 9.2 文件夹选中：三态

`src/core/selection.ts`（纯函数，零 vscode）：

```ts
/**
 * 一个分组的选中态。
 * - 'none'    ：组内没有任何一条被选中
 * - 'all'     ：组内全部被选中（空数组按 'none' 处理 —— 空组不该显示成已选）
 * - 'partial' ：部分选中
 */
export function folderSelectionState(
  childIds: readonly string[],
  selected: ReadonlySet<string>,
): 'all' | 'none' | 'partial';

/**
 * 点击文件夹标题后的**新选中集合**。
 * 'all' → 全不选（再点一次取消）；其余（none/partial）→ 全选。
 * 这是列表类界面的通行语义：部分选中时点一下的意图是「补齐」。
 */
export function toggleFolderSelection(
  childIds: readonly string[],
  selected: ReadonlySet<string>,
): Set<string>;
```

- 文件夹行的图标按三态：`all` → `check`（蓝）、`partial` → `dash`、
  `none` → `circle-large-outline`。
- 文件夹行的 `command` = `tmuxTerminals.batchToggleFolder`，参数是**该组的
  全部子 id**（在渲染时算好塞进 `arguments`）—— 而不是把 cwd 传进去让命令
  自己去 load：那会在「面板显示的内容」与「点击时读到的内容」之间开一个
  时间窗，用户点了「全选」却选到了刚被别处删掉的条目。
- **`prune` 必须同时覆盖**：「选中集合里已不存在的 id」与「已删除条目」——
  既有的 `prune` 逻辑（`batchTree.ts:71-81`）保留不变。

### 9.3 批量命令的作用对象

仍是**二级条目**（需求 7）。`entriesFor(ids)` 与三个批量命令
（`batchSetCcr` / `batchSetDirect` / `batchSetModel`）**签名不变**。
`applyModelToMany` / `applyProfileToMany` 作用到条目上时，**其下所有会话
一起变**（因为 profile/model 本来就存在条目上）—— 这正是需求要的。

## 10. `EntryStore`：新增槽级写入原语

三个新方法，全部走既有的 `enqueue` 写链（`store.ts:178-184`），
**读-改-写整个在锁内完成**：

```ts
/** 在锁内定位槽并合并补丁。槽/条目不存在则什么都不做。 */
async updateSession(entryId: string, sessionId: string, patch: Partial<SessionSlot>): Promise<void>;

/** 在锁内追加一个槽，`order` 在锁内分配（理由同 append）。 */
async addSession(entryId: string, slot: Omit<SessionSlot, 'order'>): Promise<void>;

/** 在锁内移除一个槽。 */
async removeSession(entryId: string, sessionId: string): Promise<void>;
```

**为什么必须新增而不是复用 `update`**：`update(id, patch)` 的 patch 是
调用方在锁外算好的（`store.ts:210-218`）。槽级改动在锁外算，就会
「load 出旧数组 → 改一个槽 → 写回」——两个槽并发改动时后写者盖掉先写者。
这与 `append` 注释里「order 不能在调用方算」是**同一类**错误，用同一种
办法（把复合操作收进锁内）解决。

`updateSession` **把 `id` 钉死在原值**（照 `update` 对 `entry.id` 的做法），
防止补丁里混进 `id` 把槽的 tmux 会话名改掉。

## 11. 不变量清单

1. **v2 → v3 迁移合成的槽，`id` 必须等于原条目 id。** 写错不报错，只会让
   正在跑的会话在树上变成「无会话」，用户一点就新建一个同名意图的会话，
   旧的 claude 成孤儿、两个进程同写一条 `.jsonl`。（§4.1、§5.1）
2. **`sessions` 缺失（v2）才合成槽；`sessions: []`（v3）绝不回头读顶层
   `conversationId` 复活槽。**（§5.2）
3. **备份名必须区分版本**：v1 → `.bak`，v2 → `.v2.bak`，各自只在对应形态
   真的存在时写、已存在不覆盖。（§5.4）
4. **`EntryStore.load()` 仍是唯一守门人，且不改写文件**：迁移与归一化
   （含槽排序、负数钳零）只存在于内存，等下次真实写入才落盘。（§5.3）
5. **绝不给槽级改动做「锁外读-改-写」**：一律走 `updateSession` /
   `addSession` / `removeSession`。（§10）
6. **profile / model / color / autoRestore 只存在二级条目上**，三级没有任何
   独立存储；三级菜单里这些项**转发到所属条目**，且确认框点名作用范围。
   （§3.1 第 2 条、§7.5）
7. **X（关闭会话）只杀 tmux 进程，绝不动槽、绝不清 `conversationId`。**
   这是「三级是接回会话的」能成立的前提。（§7.3、§8.2）
8. **删除条目必须递归杀掉其下全部会话**，确认框文案不得再说「远端 tmux
   会话不受影响」。（§3.3 第 3 条）
9. **二级行绝不出现「能展开但展开为空」**：`collapsibleState` 必须与
   `sessions.length > 0` 一致。（§6.2，沿用 tree-hierarchy spec §8.1）
10. **二级行首图标只承载颜色、不承载 profile**；profile 只由标题后的
    codicon 表达，且 tooltip 必须写明文字含义。（§3.1 第 4 条、§6.2）
11. **任意 hex 只能用自绘 SVG 表达**（`ThemeIcon` 只能取主题色）；
    SVG **必须显式 fill，绝不 `currentColor`**。（§6.4）
12. **渲染路径零 IO**：`iconFor` 只拼路径；SVG 落盘在 `activate()` 与
    `setColorInteractive` 里预先完成。（§6.4）
13. **拖拽排序语义不变**：仍只允许同 cwd 内的**条目**重排，跨文件夹整体
    no-op（`tree.ts` 的 `handleDrag`/`handleDrop` 逻辑与注释一字不改）。
    本轮**不给会话做拖拽排序**（未在需求内）。
14. **`core/*.ts` 保持零 vscode 依赖、零 IO**（既有约定）：新增的
    `core/sessions.ts`、`core/colors.ts`、`core/selection.ts` 必须能脱离
    编辑器单测；vscode/fs 相关的一律放 `src/colorIcons.ts` 这类非 core 文件。
15. **`reconcileBinding` 与 `core/reconcile.ts` 不改**：三分支（观测不到 →
    不动 / `live === liveSessionId` → 不动 / 否则两者都写）逐槽生效，
    手动改绑保护与空串守卫生效范围不变。（§8.1）
16. **`resolveLaunchSpec` 的兜底 D 仍收窄到「该 cwd 下只有这一个条目」**，
    判据仍按 `cwdFor()` **展开后**的路径比较（`~/x` 与 `/home/u/x` 算同一
    目录）。判的是**条目**数，不是**会话**数 —— 一个终端挂 3 个会话仍然
    「只有一个条目」，D 照常可用；这与 D 要防的「两条会话同写一条 .jsonl」
    并不冲突（同条目下的 3 个槽各有自己的 `conversationId`，只有**未绑定**
    的槽才走 D，而它挑的候选是 cwd 内 mtime 最新的一条）。（§8 第 3 点）

## 12. 测试计划

**总原则：现有 24 个测试文件是资产。** 因数据模型变化而必须改的，**改得
有判别力**（改个变量名就挂的断言不算数）；**绝不为了让测试变绿而删断言或
`|| true`**。新增行为（多会话、颜色、X 语义、批量全选）必须有对应测试。

### 12.1 新增纯函数单测

| 文件 | 用例 |
|---|---|
| `test/core/sessions.test.ts`（新增） | `sortSessions`：按 order 升序、**order 相同保持原下标顺序**（稳定）、负数 order 钳到 0 且不改变相对顺序、空数组、不改动入参（纯函数）；`nextSessionOrder`：空 → 0、`[0,1,2]` → 3、`[0,5]` → 6、乱序取 max+1 |
| `test/core/colors.test.ts`（新增） | `normalizeHexColor`：`#abc` → `#aabbcc`、`#AABBCC` → `#aabbcc`、`aabbcc`（无 #）→ `#aabbcc`、三位无 #、首尾空白、空串 → undefined、`#abcd` → undefined、`#gggggg` → undefined、`red` → undefined、`#12345` → undefined；`colorBarSvg`：含该 hex 的显式 `fill`、**不含 `currentColor`**、含 `viewBox`、对同一颜色确定（两次调用逐字节相同）；`PRESET_COLORS`：8 个、每个都能通过 `normalizeHexColor` 且归一化后等于自身 |
| `test/core/selection.test.ts`（新增） | `folderSelectionState`：空数组 → `'none'`（**空组绝不显示成已选**）、全选 → `'all'`、部分 → `'partial'`、一个都没 → `'none'`、集合里混有组外 id 不影响判定；`toggleFolderSelection`：`'all'` → 全不选、`'none'` → 全选、`'partial'` → 全选（**补齐**）、不改变组外 id 的选中态、返回**新集合**（不改动入参） |

### 12.2 扩展既有单测

| 文件 | 用例 |
|---|---|
| `test/core/migrate.test.ts`（大改） | **`★ v1/v2 → v3 合成出的槽，id 必须等于原条目 id`**（本次最关键的一条，两条形态各一个用例）；v2 的 `conversationId` / `liveSessionId` 原样落到那个唯一的槽上、`order: 0`；v2 无 `conversationId` → **槽存在**但 `conversationId` 为 undefined（**不编造**）；**v1 → 槽存在且 id = 条目 id、`conversationId` 为 undefined**（不是 `sessions: []`）；v1 的 `claude-direct` → direct 判定回归不变；v3 幂等（原样带过，槽顺序与字段不动）；`sessions: []` 的 v3 条目不复活顶层 `conversationId`；v3 槽 `id` 非 string/空串 → **该槽被丢弃**（其余槽保留）；v3 槽 `order` 非 number → 用下标；v3 槽 `conversationId: 42` / `''` → 视为未设；v2 条目带 `color`（手改加的）→ 原样带过；`isV2Shape`：v1 → false、v3 → false、v2 → true、非对象/缺 id → false |
| `test/core/store.test.ts`（扩展） | `load` 对 sessions 的归一化（负数 order 钳 0、按 order 排序、稳定）；**`updateSession` 并发不丢更新**（同一条目的两个槽各改一次，两个改动都必须在）；`updateSession` 的补丁里带 `id` **不得改写槽 id**；`addSession` 的 order 在锁内分配（连续两次 add 得到不同 order）；`removeSession` 只删指定槽、其余不动；对不存在的 entryId / sessionId 是安全的 no-op；`migrateAndBackupV2`：v2 文件 → 写 `.v2.bak` 且内容等于原文、**已有 `.v2.bak` 不覆盖**、v1 文件 → 不写、v3 文件 → 不写；`.bak`（v1）行为**回归不变** |
| `test/core/reconcile.test.ts` | **不改**（`reconcileBinding` 一行未动）—— 若实现动了它，这条就是要红的信号 |
| `test/core/command.test.ts` | 基本不改（`commandFor` / `conversationCommand` 只吃 `profile`/`model`/`conversationId`，形状未变）；若签名因类型收紧而报错，只改**类型层**，断言不动 |
| `test/core/grouping.test.ts` / `reorder.test.ts` / `restore.test.ts` / `activity.test.ts` / `tmux.test.ts` / `paths.test.ts` / `liveSession.test.ts` / `processTree.test.ts` / `conversation.test.ts` / `models.test.ts` / `claude.test.ts` / `labels.test.ts` | 预期**不改**；若因 `TerminalEntry` 类型收紧（`sessions` 必需、`conversationId` 移除）而需要给测试夹具补 `sessions: []`，只补夹具，**断言一字不动** |
| `test/activityTracker.test.ts` | 键从条目 id 变成**槽 id**：断言里的 id 换成槽 id，**「每条目每轮只采样一次」「状态按值比较才通知」等断言全部保留**。新增一条：两个槽同属一个终端时，各自独立采样、各自独立的状态 |
| `test/taskTitles.test.ts` | 不改（缓存键一直是 `conversationId`，与槽无关） |
| `test/manifest.test.ts` | `viewItem` 那条正则按 §7.2 的注记**加强**（同时认三元与直接赋值），**扫描范围扩到 `src/tree.ts` + `src/batchTree.ts` 两个文件**（`batchFolder` / `batchItem` 在后者里），两个方向的原断言一字不动；其余用例不动。新增两条：① 新增的 5 个命令都在 `contributes.commands` 里且都被 `reg(...)` 注册（既有的双向断言自动覆盖，这里只需确认没漏）；② `contributes.menus` 里出现的 `viewItem == X` 集合**恰好等于** `{folder, terminal, sessionAlive, sessionDead}` —— 多一个（引用了永不出现的值）或少一个（某级节点没有任何菜单项）都是 bug，这条断言把两个方向都钉住 |

### 12.3 新增：树渲染的可测部分

树渲染本身没有单测（现状如此，`tree.ts` 靠 e2e 覆盖），但本轮把它**能纯化的
部分**抽出来单测，避免「只能靠肉眼」：

- 三级标题回落：`sessionLabel(taskName)` → 非空返回任务名，空返回 `'无会话'`
  （放 `src/core/labels.ts` 或 `core/sessions.ts`，纯函数 + 单测）。
- 二级可折叠性：`sessions.length > 0` 的判据（可直接断言纯函数
  `hasSessions(entry)`，或断言 `sessions` 长度与 `collapsibleState` 的映射）。

### 12.4 e2e harness（`test/e2e-harness.js`，现 1700+ 行）

**必须适配的两处机械改动**（否则整份 harness 直接崩）：

1. **`mk(id, name, cwd, extra)` 把 `conversationId`/`liveSessionId` 转发进
   唯一的槽**，且**槽 id 取 `id`**（与 §5.1 的迁移规则同构）：

   ```js
   // 改造后：多会话是「额外」的，既有 39 处 conversationId 引用一行都不用改
   const mk = (id, name, cwd, extra = {}) => {
     // conversationId / liveSessionId 是**会话级**的，必须只进槽、不进顶层：
     // 照抄到顶层会让清单里出现两个不该有的字段，而 harness 是 JS，
     // TS 的类型检查管不到这里 —— 只能靠这一行显式剥掉。
     const { conversationId, liveSessionId, ...entryLevel } = extra;
     return {
       id, name, cwd, profile: 'ccr', autoRestore: false,
       sessions: [{ id, conversationId, liveSessionId, order: 0 }],
       ...entryLevel,               // model 等条目级字段照常并到顶层
     };
   };
   ```
   槽的 `order` 固定 0：既有用例全是「一条目一会话」，都不需要别的顺序。
   **多会话的新用例自己构造 `sessions` 数组**（两个槽、各自的 order），
   不复用 `mk` —— 这样一个 helper 不会为了两种形状变得两头不讨好。
2. **`vscode` stub 要补 `Uri`**（`tree.ts` 的 `iconPath` 现在用它）：
   `class Uri { constructor(p){this.fsPath=p} static file(p){return new Uri(p)} static joinPath(b,...s){...} static parse(s){...} }`。
   `ColorIconCache` 在 e2e 里可传一个不落盘的实现，或直接指向临时目录。

**新增用例**（每条都对应一条不变量）：

- **多会话各自独立打开**：一个终端挂 2 个槽，两个槽各有自己的
  `conversationId` → 分别 `openSession` → 断言两次送进 pane 的命令是
  `--resume <各自的 id>`，且两个 tmux 会话名 = `tmuxterm-<各自的槽 id>`。
- **X 语义（不变量 7）**：一个存活槽 → `closeSession` → 断言 tmux 会话没了、
  **槽仍在**（`conversationId` 一字未变）；再 `openSession` → 断言送进 pane
  的是 `--resume <原 conversationId>`（**接回同一条对话**）。
- **删除会话 vs 删除条目（判断 A、不变量 8）**：`deleteSession` 只让该槽消失、
  同终端其余槽与条目都在；`deleteEntry` 让条目消失**且其下每个槽的 tmux
  会话都被杀**（`tmux ls` 里逐个确认不存在）。
- **新建：一级 `+` 预填 cwd（判断 B）**：`addEntryInteractive(folderCwd)` 时
  `askCwd` 收到的 `placeHolder` 是 `folderCwd`；新建条目**带 1 个空槽**。
- **新建会话零弹框**：`addSessionInteractive` 期间断言
  `calls.quickPicks.length === 0 && calls.messages.length === 0`、槽数 +1。
- **profile/model 属于二级（不变量 6）**：3 个槽的终端，改 profile → 断言
  `entry.profile` 变了、**`sessions` 里没有任何 profile/model 字段**、
  3 个存活槽都被重启并 `--resume` 各自的对话。
- **复制（§7.6）**：复制一个 2 槽的终端 → 断言复制品有 2 个槽、**每个槽的
  id 与 conversationId 都与源不同**、`liveSessionId` 全部为 undefined。
- **迁移端到端（不变量 1）**：写一份 **v2 形态**的清单文件 → 让 store 读它
  → 断言条目有 1 个槽、**槽 id === 原条目 id**、`conversationId` 原样；
  并断言 `.v2.bak` 已生成且内容等于原文。
- **二级不再打开**：点击二级节点不产生任何 tmux 操作（`openEntry` 不被调到）。
- **颜色**：`setColorInteractive` 后断言 `entry.color` 是归一化的小写 hex，
  且 `<storage>/colors/<hex>.svg` 文件存在、内容含该 hex。

**变异测试**（本项目惯例，见 `tmux-terminal-v2-design.md` §12）：至少四处，
确认对应断言真的变红 ——
① 迁移里把槽 id 写成 `newId()`；② `closeSession` 顺手把 `conversationId`
清掉；③ `deleteEntry` 改成不杀 tmux；④ `folderSelectionState` 里把空数组
判成 `'all'`。

### 12.5 文档

- `README.md`：`## 三个概念`（增「会话」）、`## 使用`、
  `## 条目 ↔ 对话绑定`（绑定是**会话级**的）、
  `## 侧边栏的层级：第三级「任务名」` → 改写为
  `## 侧边栏的层级：文件夹 → 终端 → 会话`（含 `+`/`X`/颜色/profile 图标）、
  `## 排序与批量操作`（批量改为按文件夹分组 + 一级全选；
  **删掉「短路径消歧」一节**，见 §3.3 第 5 条）、`## 安装` 里的 vsix 文件名
  改 0.2.0。
- `docs/smoke-test.md`：改掉与新模型冲突的几条（「描述显示目录 + 无会话」、
  「删除条目但 tmux 会话仍在」、「同目录短标签」），补上三级会话、`+`、
  `X`、颜色、批量一级全选的手动步骤。**手动项必须保留**：自动测试覆盖不到
  「颜色竖线真的画出来了」这类渲染结果。
- `.gitignore` 现有规则**不动**（`*.vsix` 仍被忽略 —— 本仓库的既有习惯是
  vsix 只在本地产出、不进版控）。

## 13. 已知取舍

| 项 | 取舍 |
|---|---|
| **二级不再能一键打开终端** | 打开下移到三级（会话）。代价是「想开一个新的终端」现在要点两次（二级 `+` → 点会话行），换来的是「一个终端多会话」这个核心能力。 |
| 「无会话」这个标题同时表示「进程已死」与「活着但还没起任务名」 | 需求原话就是「无任务标题就叫『无会话』」，两种情形都拿不到任务名，故同一个标题。区分靠三级的图标（空心 = 无进程，实心 = 有进程）与 tooltip。若用户希望活着但没任务名时显示别的字样，改一处 `sessionLabel` 即可。 |
| **三级菜单比二级还长** | 需求 4 要求「三级包含二级所有功能」，于是一个会话行右键会出现 7 项，其中 4 项（profile/模型/颜色/参与恢复/复制）作用范围是**整个终端**。已用「确认框点名作用范围」缓解；若实际用起来嫌吵，删掉三级上的 `duplicate` / `toggleAutoRestore` 即可（这两项最不像会话级操作）。 |
| `shortLabels`（短路径消歧）在生产代码里不再被调用 | 扁平列表没了，消歧失去了存在的场景。**函数与 `test/core/labels.test.ts` 保留不动** —— 它是通用工具，且不删测试是本次的硬约束。README 里对应的一节删掉（功能确实没了）。 |
| 三级不做拖拽排序 | 未在需求内。会话按 `order` 升序显示，新建的追加在末尾；要调顺序目前只能手改清单文件。留作后续。 |
| 「+」不自动打开终端 | 「+」是「加一个会话位」，不产生任何副作用；打开是紧接着点那一行。代价是新建会话是两步操作。 |
| 每个会话的 tmux 名 = `tmuxterm-<槽 id>` | 与 v2 的 `tmuxterm-<条目 id>` 是同一个格式（`escapeSessionName` 的正则一个字都不用改），迁移后旧会话名天然被认出来（§4.1）。 |
| 关闭/删除会话都要一次模态确认 | 与既有的 `killSession` 一致（它会杀掉正在跑的 claude，丢失在途工作）。用户要的 X 是「随手关」，但本仓库一贯的安全姿态是「绝不静默破坏」，故保留确认。若嫌烦，可改成只在「会话存活」时确认（已是现状：X 只对存活的会话显示）。 |
| 批量面板一级显示完整 cwd 而不是短路径 | 与主树一致（主树一级就是完整 cwd），代价是窄侧边栏里长路径被省略号截断，靠 hover 看全文。 |
| `entry.color` 允许手改清单文件写入非法值 | `normalizeHexColor` 只在**写入路径**（`setColorInteractive`）把关。手改文件写进的 `#zzz` 会被 `colorBarSvg` 直接嵌进 SVG —— 后果是图标画不出来（VS Code 忽略非法 fill），**不会**执行任何注入（SVG 里只有这一个属性值，且 `colorBarSvg` 只接受 `normalizeHexColor` 的产物）。故 `iconFor` 对非法值**回落到中性竖线**，而不是信任输入。 |
| **profile 的 codicon 挂在 `description` 上，此路有渲染风险** | VS Code 的 `TreeItem` 只有 `label`（文本）与 `iconPath`（行首图标）两个位置，**标题后面**唯一可用的槽位就是 `description`。把 codicon 写进 `description`（`'$(plug)'`）依赖 VS Code 对 `description` 做 codicon 替换；**若实测不生效**，用户会看到字面量 `$(plug)`。实施时必须**在 e2e/手动冒烟里实际看一眼**（`docs/smoke-test.md` 里加一条）。回退方案（按优先级）：① `description` 改用纯文字 `直连` / `中转`（不满足「小图标」但信息不丢，且与 tooltip 一致）；② 把 profile 塞进 `iconPath` 的 `{light,dark}` 组合、颜色竖线改为 `description` 里的 codicon（把风险换个位置，不解决）。**首选 ①**。 |
| 发布杂务 | `package.json` 0.1.8 → **0.2.0**，`package-lock.json` 的两处 `version` 同步订正（此前几批漏过，见 v0.1.5 的提交）。tag 只打 `v0.2.0`（0.1.6/0.1.7/0.1.8 没打，不回头补）。 |

## 14. 实施后修订

（本节在实施完成后回填，记录与设计不符之处，沿用 v1 / v2 / tree-hierarchy /
session-identity 的做法。）
